import { randomUUID } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import {
  isRetryable,
  toToolErrorCode,
  type ToolErrorCode,
} from "@lobu/core";
import { resolveSdkMaxAccessLevel } from "../auth/tool-access";
import { captureEffect } from "../gateway/routes/internal/capture-mode";
import { buildMcpBearerChallenge } from "../auth/oauth/resource-indicator";
import { DISCOVERY_SCOPES } from "../auth/oauth/scopes";
import { isAdminOrOwnerRole } from "./access-control";
import type { Env } from "../index";
import { buildClientSDK, type SDKMode } from "../sandbox/client-sdk";
import {
  boundScriptErrorText,
  MAX_SCRIPT_ERROR_MESSAGE_BYTES,
  MAX_SCRIPT_ERROR_NAME_BYTES,
  MAX_SCRIPT_TIMEOUT_MS,
  runScript,
} from "../sandbox/run-script";
import type { AccountToolContext } from "./registry";
import { withValidatedArgs } from "./validate-args";
import { mcpResourceLinksForSdkReturnValue } from "../mcp-media-resources";
import { attachMcpResultContent } from "./mcp-result-content";
import { attachMcpResultMeta } from "./mcp-result-meta";
import { ingestMcpFiles, McpHostFilesSchema, StoredInputFileSchema } from "../mcp-file-inputs";
import { ToolUserError } from "../utils/errors";

const SCRIPT_FIELDS = {
  script: Type.String({
    description:
      "TypeScript source. Must `export default async (ctx, client) => { ... }` — `ctx` is `{ organization_id, user_id, mode, files, sleep(ms) }`, where `await ctx.sleep(ms)` provides a bounded, abort-aware 0–30000ms polling delay; unrestricted timer globals are unavailable. `client` is the ClientSDK. Bare OAuth has organization_id=null: first select const workspace = await client.org(target) for workspace methods; account discovery and conversation titles work on the root client. The script's return value comes back as `return_value`; return it only for computed results and bounded samples. For bulk data prefer `client.query` / `query_sql` or paginated SDK reads — a return over the output cap is replaced by a `return_value_preview` head and a `return_truncated` report instead of shipping the full set to the model. Use `search_sdk` to discover SDK methods and `ctx.sleep`.",
    minLength: 1,
    maxLength: 100_000,
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Wall-clock budget. Default 60000 (max 180000 — a device-bound operation waits up to 60s to be claimed, then up to the action's declared timeout plus 30s grace, all bounded by this budget).",
      minimum: 100,
      maximum: MAX_SCRIPT_TIMEOUT_MS,
    }),
  ),
  title: Type.Optional(
    Type.String({
      description:
        'Human-friendly heading for this result (e.g. "Companies missing a domain"). In run_sdk, it also labels browser tab groups opened by the script. The UI renders it above the execution status; without it the result card has no subject line. Set it whenever a person will read the result.',
      maxLength: 200,
    }),
  ),
};

export const RunSchema = Type.Object({
  ...SCRIPT_FIELDS,
  files: Type.Optional(McpHostFilesSchema),
  file_organization: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 255,
    description: "Workspace slug or ID that will own attached files. Required with files on an account-scoped MCP connection. Files become ctx.files; pass a file directly to a connector field declaring x-lobu-file. Existing references need no re-upload.",
  })),
  dry_run: Type.Optional(
    Type.Boolean({
      description:
        "Preview mode. Read SDK calls still execute, but write/admin/external SDK calls are canonicalized and validated, then skipped and returned in side_effect_preview without executing their handlers.",
    }),
  ),
});
export const QuerySchema = Type.Object(SCRIPT_FIELDS);
type RunArgs = Static<typeof RunSchema>;
type QueryArgs = Static<typeof QuerySchema>;

const PublicSideEffectPreviewEntrySchema = Type.Object({
  path: Type.String({ description: "Dotted SDK method path for the proposed action." }),
  access: Type.Union(
    [
      Type.Literal("write"),
      Type.Literal("external"),
      Type.Literal("admin"),
      Type.Literal("unknown"),
    ],
    { description: "Access class of the proposed action." },
  ),
  args: Type.Array(Type.Unknown(), {
    description: "Redacted, bounded arguments for the proposed action.",
  }),
  required_access: Type.Union(
    [
      Type.Literal("read"),
      Type.Literal("write"),
      Type.Literal("admin"),
    ],
    { description: "Access tier required by the proposed SDK method." },
  ),
  authorization_status: Type.Literal("not_evaluated", {
    description:
      "Dry-run validates arguments but does not execute live authorization or approval policy.",
  }),
});

/**
 * One change-capable method path dispatched before a live script died, with how
 * many times it ran. Deliberately narrower than the internal trace: a path, its
 * access class, and a count — never arguments, which is where credentials and
 * cross-org traversal would leak.
 */
const StartedSideEffectSchema = Type.Object({
  path: Type.String({ description: "Dotted SDK method path that was dispatched." }),
  access: Type.Union([
    Type.Literal("write"),
    Type.Literal("external"),
    Type.Literal("admin"),
  ], { description: "Access class of the dispatched call." }),
  count: Type.Integer({
    minimum: 1,
    description: "How many times this path was dispatched before the failure.",
  }),
});

/**
 * Public MCP result for `run_sdk` / `query_sdk`.
 *
 * The sandbox internally captures logs, timings, stack traces, org traversal,
 * and a bounded SDK-call trace. The execution and audit pipeline consumes that
 * richer result before the MCP boundary. ChatGPT receives only the requested
 * return value, a concise script error, and (for dry-run) the actions the user
 * is being asked to review.
 */
export const SdkScriptResultSchema = Type.Object({
  files: Type.Optional(Type.Array(StoredInputFileSchema)),
  title: Type.Optional(
    Type.String({
      description: "The caller-supplied human-friendly heading for this result, echoed back for the UI.",
      maxLength: 200,
    }),
  ),
  success: Type.Boolean({ description: "Whether the script ran to completion." }),
  return_value: Type.Optional(
    Type.Unknown({
      description:
        "The script's default-export return value. Omitted when it exceeded the output cap.",
    }),
  ),
  return_value_preview: Type.Optional(
    Type.String({
      description:
        "UTF-8-safe head of an oversized serialized return value. Rerun with filtering or pagination for the rest.",
    }),
  ),
  return_truncated: Type.Optional(
    Type.Object(
      {
        total_bytes: Type.Integer(),
        kept_bytes: Type.Integer(),
      },
      { description: "Present when return_value_preview is only a partial result." },
    ),
  ),
  error: Type.Optional(
    Type.Object(
      {
        name: Type.String({ maxLength: MAX_SCRIPT_ERROR_NAME_BYTES }),
        message: Type.String({ maxLength: MAX_SCRIPT_ERROR_MESSAGE_BYTES }),
        code: Type.Optional(Type.String()),
        retryable: Type.Optional(Type.Boolean()),
      },
      { description: "Concise script failure information, without stack traces or internal diagnostics." },
    ),
  ),
  skipped_calls: Type.Integer({
    description: "Number of write/admin/external calls skipped by dry-run.",
  }),
  side_effect_preview: Type.Array(PublicSideEffectPreviewEntrySchema, {
    description: "Proposed write/admin/external calls skipped because dry_run=true.",
  }),
  side_effect_preview_truncated: Type.Optional(
    Type.Object({
      dropped_entries: Type.Integer({ minimum: 1 }),
    }),
  ),
  started_side_effects: Type.Optional(
    Type.Array(StartedSideEffectSchema, {
      description:
        "Change-capable calls dispatched before a live script failed, grouped by method path. Present only when success=false and dry_run=false. Dispatch is not confirmation — a call listed here may or may not have completed.",
    }),
  ),
  dry_run: Type.Boolean(),
});

type PublicSideEffectPreviewEntry = Static<typeof PublicSideEffectPreviewEntrySchema>;

function asPublicPreviewEntry(value: unknown): PublicSideEffectPreviewEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string" || !Array.isArray(row.args)) return null;
  const access =
    row.access === "write" ||
    row.access === "external" ||
    row.access === "admin" ||
    row.access === "unknown"
      ? row.access
      : "unknown";
  const requiredAccess =
    row.required_access === "read" ||
    row.required_access === "write" ||
    row.required_access === "admin"
      ? row.required_access
      : null;
  if (!requiredAccess || row.authorization_status !== "not_evaluated") {
    return null;
  }
  return {
    path: row.path,
    access,
    args: row.args,
    required_access: requiredAccess,
    authorization_status: row.authorization_status,
  };
}

type StartedSideEffect = Static<typeof StartedSideEffectSchema>;

/**
 * Normalize the sandbox's dispatch tally into the bounded public summary: which
 * change-capable paths ran before a failed live run, and how often.
 *
 * Returns null unless the run actually failed outside dry-run with at least one
 * such call — a successful run has nothing to warn about, and under dry-run the
 * sandbox skipped the writes.
 */
function summarizeStartedSideEffects(
  row: Record<string, unknown>,
): StartedSideEffect[] | null {
  if (row.success !== false) return null;
  if (row.dry_run === true) return null;
  // The sandbox tallies these at dispatch time. Deriving them from
  // `sdk_call_trace` instead would lose exactly the runs that matter: the trace
  // is a byte-capped ring evicting OLDEST entries, so a long run's early writes
  // vanish and the surviving tail can be all reads — suppressing the warning on
  // precisely the runs most likely to have timed out mid-write.
  if (!Array.isArray(row.started_side_effects)) return null;

  const entries: StartedSideEffect[] = [];
  for (const entry of row.started_side_effects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const call = entry as Record<string, unknown>;
    if (typeof call.path !== "string") continue;
    if (call.access !== "write" && call.access !== "external" && call.access !== "admin") {
      continue;
    }
    const count =
      typeof call.count === "number" && Number.isSafeInteger(call.count) ? call.count : 0;
    if (count < 1) continue;
    entries.push({ path: call.path, access: call.access, count });
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  // No hedge: the sandbox counts every dispatch, so this is exact regardless of
  // how much of the diagnostic trace was evicted.
  return entries;
}

/**
 * Minimize a rich internal SDK result for the MCP/model boundary. The raw
 * object remains available to executeTool's audit seam before this function is
 * called, so removing diagnostics here does not weaken Lobu's audit trail.
 */
export function toMcpPublicSdkScriptResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const row = result as Record<string, unknown>;
  const preview = Array.isArray(row.side_effect_preview)
    ? row.side_effect_preview
        .map(asPublicPreviewEntry)
        .filter((entry): entry is PublicSideEffectPreviewEntry => entry !== null)
    : [];
  const skippedCalls =
    typeof row.skipped_calls === "number" && Number.isSafeInteger(row.skipped_calls)
      ? Math.max(0, row.skipped_calls)
      : preview.length;

  const out: Record<string, unknown> = {
    success: row.success === true,
    skipped_calls: skippedCalls,
    side_effect_preview: preview,
    dry_run: row.dry_run === true,
  };

  // Preserve the caller-supplied heading in the public structured result. It is
  // documented on both the input schema and SdkScriptResultSchema, so dropping
  // it here breaks that contract.
  if (typeof row.title === "string" && row.title.trim()) {
    out.title = row.title.trim();
  }

  if (Array.isArray(row.files)) out.files = row.files;

  if (Object.hasOwn(row, "return_value") && row.return_value !== undefined) {
    out.return_value = row.return_value;
  }
  if (typeof row.return_value_preview === "string") {
    out.return_value_preview = row.return_value_preview;
  }
  if (row.return_truncated && typeof row.return_truncated === "object") {
    const truncated = row.return_truncated as Record<string, unknown>;
    if (
      typeof truncated.total_bytes === "number" &&
      typeof truncated.kept_bytes === "number"
    ) {
      out.return_truncated = {
        total_bytes: truncated.total_bytes,
        kept_bytes: truncated.kept_bytes,
      };
    }
  }

  if (row.error && typeof row.error === "object" && !Array.isArray(row.error)) {
    const error = row.error as Record<string, unknown>;
    if (typeof error.message === "string") {
      out.error = {
        name: boundScriptErrorText(
          typeof error.name === "string" ? error.name : "Error",
          MAX_SCRIPT_ERROR_NAME_BYTES,
        ),
        message: boundScriptErrorText(
          error.message,
          MAX_SCRIPT_ERROR_MESSAGE_BYTES,
        ),
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      };
    }
  }

  if (skippedCalls > preview.length) {
    out.side_effect_preview_truncated = { dropped_entries: skippedCalls - preview.length };
  }

  // A live script killed mid-run (timeout, quota) leaves already-dispatched
  // writes behind. "Failed" alone reads as "nothing happened", so the caller
  // re-runs and repeats them. Summarize what was dispatched — paths and counts
  // only — so the result card can warn without the diagnostic trace crossing
  // the boundary. Skipped calls never ran, and reads change nothing.
  const started = summarizeStartedSideEffects(row);
  if (started) out.started_side_effects = started;
  return out;
}

/**
 * Whether the sandbox runs in its skip-and-record path for this call.
 *
 * An eval replay captures whether the agent asks to or not: the sandbox
 * already skips every non-read method under `dryRun` and records it with its
 * arguments (sandbox/run-script.ts), and capture mode is that same path forced
 * by the server from the signed `executionMode` token claim.
 *
 * Capture is OR'd with the agent's own opt-in and never overridden by it — a
 * capture run cannot be talked back into executing by passing
 * `dry_run: false`. Exported so that property is pinned by a test against the
 * real expression rather than a copy of it.
 */
export function resolveSandboxDryRun(args: {
  executionMode?: "live" | "capture" | null;
  sdkMode: SDKMode;
  agentDryRun: boolean;
}): boolean {
  const captureSideEffects = args.executionMode === "capture";
  return captureSideEffects || (args.sdkMode === "full" && args.agentDryRun);
}

export function classifySdkScriptError(error: {
  name: string;
  message: string;
  code?: unknown;
}): { code: ToolErrorCode; retryable: boolean } {
  const structuredCode = toToolErrorCode(error.code);
  if (structuredCode) {
    return { code: structuredCode, retryable: isRetryable(structuredCode) };
  }

  let code: ToolErrorCode;
  if (error.name === "ValidationError") {
    code = "VALIDATION";
  } else if (error.name === "McpScopeRequiredError") {
    code = "PERMISSION";
  } else {
    code = "INTERNAL";
  }
  return { code, retryable: isRetryable(code) };
}

/**
 * SDK paths an EVAL capture run still dispatches, because the handler behind
 * them enforces capture itself (see `RunScriptOptions.dryRunDispatchPaths`).
 * A native shadow capture has no window to finalize, so it skips them like
 * any other write.
 *
 * `automations.completeWindow` is the finalize step the dispatch prompt asks for
 * (automations/automation.ts). Skipping it would leave every eval replay with no
 * window — which the finalize-nudge reads as "the agent never called run_sdk",
 * costing a second full replay before failing the run with a misleading error.
 * `handleCompleteWindow` reads the same `executionMode` and records the
 * extraction on `runs.dry_run_preview` instead of committing the result.
 *
 * Empty for an agent-requested `dry_run` — there, skipping IS the answer.
 */
export const CAPTURE_DISPATCH_PATHS: readonly string[] = [
  "automations.completeWindow",
];

async function runSandbox(
  mode: SDKMode,
  args: RunArgs | QueryArgs,
  env: Env,
  ctx: AccountToolContext,
): Promise<unknown> {
  const allowCrossOrg = ctx.allowCrossOrg;
  const agentDryRun = "dry_run" in args ? args.dry_run === true : false;
  const dryRun = resolveSandboxDryRun({
    executionMode: ctx.executionMode,
    sdkMode: mode,
    agentDryRun,
  });
  const startedAt = Date.now();
  const timeoutMs = args.timeout_ms ?? 60_000;
  const hostFiles = "files" in args ? args.files : undefined;
  if (hostFiles?.length && dryRun) {
    throw new ToolUserError('File uploads cannot run in preview mode. Upload once, then reuse the returned file references in dry-run scripts.', 400);
  }
  const files = hostFiles?.length
    ? await ingestMcpFiles(hostFiles, "file_organization" in args ? args.file_organization : undefined, {
        ...ctx,
        abortSignal: ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
    : [];
  const sdkContext = {
    ...ctx,
    sdkBrowserInvocation: { nonce: randomUUID(), title: args.title ?? "" },
  };
  const result = await runScript({
    source: args.script,
    sdk: (abortSignal) => buildClientSDK(sdkContext, env, { mode, allowCrossOrg, abortSignal }),
    sdkMode: mode,
    allowCrossOrg,
    // Account scripts are scope-bounded; selected SDK clients enforce the
    // current target membership at each leaf call.
    maxAccessLevel: resolveSdkMaxAccessLevel(
      ctx.memberRole,
      ctx.scopes,
      ctx.allowCrossOrg,
    ),
    dryRun,
    dryRunDispatchPaths:
      ctx.executionMode === "capture" && ctx.captureIdentity?.automationRunId !== undefined
        ? CAPTURE_DISPATCH_PATHS : undefined,
    context: {
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      mode: mode === "read" ? "query_sdk" : "run_sdk",
      files,
    },
    limits: { timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)) },
  });
  if (ctx.executionMode === "capture" && result.skippedCalls > 0) {
    await captureEffect(ctx.captureIdentity, "sdk.run", {
      skipped_calls: result.skippedCalls,
      side_effect_preview: result.sideEffectPreview,
    });
  }
  // Attach a structured code/retryable to a script error so the agent can tell a
  // transient upstream failure (worth re-running) from a permanent script fault.
  // run_sdk is never auto-retried by the wrapper (arbitrary side effects), so this
  // is purely advisory.
  const error = result.error
    ? (() => {
        const classification = classifySdkScriptError(result.error);
        return { ...result.error, ...classification };
      })()
    : result.error;
  const title = args.title?.trim() || undefined;
  const output = {
    ...(files.length > 0 ? { files } : {}),
    ...(title ? { title } : {}),
    success: result.success,
    return_value: result.returnValue,
    return_value_preview: result.returnValuePreview,
    return_truncated: result.returnTruncated,
    logs: result.logs,
    error,
    duration_ms: result.durationMs,
    sdk_calls: result.sdkCalls,
    skipped_calls: result.skippedCalls,
    sdk_call_trace: result.sdkCallTrace,
    started_side_effects: result.startedSideEffects,
    side_effect_preview: result.sideEffectPreview,
    sdk_call_trace_truncated:
      result.traceDropped > 0 ? { dropped_entries: result.traceDropped } : undefined,
    // Effective sandbox dry-run, including capture-mode enforcement. Must match
    // the dryRun flag passed to runScript so skipped_calls / side_effect_preview
    // never appear under dry_run:false.
    dry_run: dryRun,
  };
  const resourceLinks = mcpResourceLinksForSdkReturnValue(result.returnValue);
  const mcpOutput = attachMcpResultContent(output, resourceLinks);
  const challengeRequestUrl = ctx.requestUrl ?? ctx.baseUrl;
  // Only a failed run carries the challenge: the MCP handler flips any result
  // holding one to isError, and a script that caught the denial and still
  // succeeded must not be reported as an error.
  if (
    !result.success &&
    result.requiredMcpScopes.includes("mcp:admin") &&
    (ctx.allowCrossOrg || isAdminOrOwnerRole(ctx.memberRole)) &&
    (ctx.tokenType === "oauth" || ctx.tokenType === "pat") &&
    challengeRequestUrl
  ) {
    // Scope on a progressive OAuth challenge is the complete replacement
    // grant the client should request, not merely the missing delta. Sending
    // only `mcp:admin` can discard read/write on clients that replace rather
    // than merge grants. Restrict the carried-forward set to public auth-code
    // scopes so first-party device/PAT grants never leak into a third-party
    // authorization request.
    const upgradeScopes = Array.from(
      new Set([
        ...(ctx.scopes ?? []).filter((scope) => DISCOVERY_SCOPES.includes(scope)),
        "mcp:admin",
      ]),
    );
    return attachMcpResultMeta(mcpOutput, {
      "mcp/www_authenticate": [
        buildMcpBearerChallenge(challengeRequestUrl, {
          error: "insufficient_scope",
          errorDescription:
            result.error?.message ?? "The token lacks the required MCP admin scope.",
          scope: upgradeScopes.join(" "),
        }),
      ],
    });
  }
  return mcpOutput;
}

export const runSdkScript = withValidatedArgs(
  "run_sdk",
  RunSchema,
  (args: RunArgs, env: Env, ctx: AccountToolContext) => runSandbox("full", args, env, ctx),
);

export const querySdkScript = withValidatedArgs(
  "query_sdk",
  QuerySchema,
  (args: QueryArgs, env: Env, ctx: AccountToolContext) => runSandbox("read", args, env, ctx),
);
