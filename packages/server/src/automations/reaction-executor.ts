/**
 * Automation Script Executor
 *
 * Executes compiled Automation reaction and executor scripts inside the shared
 * `runScript` isolate runner over the typed `ClientSDK`. Stored scripts MUST
 * export `default async (ctx, client, params?) => ...`.
 *
 * Scripts run with `userId: null` + `isAuthenticated: true` so handler-level
 * access checks treat them as system calls.
 */

import type { ReactionContext, AutomationScriptContext } from '@lobu/connector-sdk';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../auth/tool-access';
import type { Env } from '../index';
import { buildClientSDK } from '../sandbox/client-sdk';
import { runScript } from '../sandbox/run-script';
import { compileSource } from '../utils/compiler-core';
import logger from '../utils/logger';

const REACTION_TIMEOUT_MS = 60_000;

interface ExecuteAutomationScriptOptions {
  compiledScript: string;
  context: ReactionContext | AutomationScriptContext;
  env: Record<string, string | undefined>;
  /** Optional params object captured at script definition time. */
  params?: Record<string, unknown>;
  timeoutMs?: number;
  executionKind?: 'reaction' | 'executor';
}

/**
 * Execute a compiled reaction script. Delegates to `runScript`, which compiles
 * the source via esbuild and runs it in an `isolated-vm` V8 isolate.
 */
export async function executeReaction(options: ExecuteAutomationScriptOptions): Promise<{
  success: boolean;
  error?: string;
}> {
  const result = await executeAutomationScript({ ...options, executionKind: 'reaction' });
  return result.success ? { success: true } : { success: false, error: result.error };
}

export async function executeAutomationScript(options: ExecuteAutomationScriptOptions): Promise<{
  success: boolean;
  error?: string;
  returnValue?: unknown;
  didReturnValue?: boolean;
}> {
  const {
    compiledScript,
    context,
    env,
    params,
    timeoutMs = REACTION_TIMEOUT_MS,
    executionKind = 'executor',
  } = options;

  // Scripts are scoped to the Automation's own workspace — they have no user
  // identity to validate cross-org membership against, so `client.org(...)`
  // is intentionally disabled. The builder form lets the sandbox forward its
  // wall-clock signal into `ctx.abortSignal` so SQL via `client.query` can
  // cancel upstream when the script times out.
  const scriptCtx = {
    organizationId: context.organization_id,
    userId: null,
    memberRole: null,
    isAuthenticated: true,
    tokenType: 'session' as const,
    // System-tier script (no user identity): scope dimension does not apply.
    // It already qualifies as a system context, but pass the sentinel
    // explicitly so the scope guards never fail closed here.
    scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
    scopedToOrg: true,
    allowCrossOrg: false,
    grantedOrganizationIds: null,
    directSearchFederation: false,
    // The script IS this Automation acting autonomously. Stamping the Automation id
    // here makes EVERY gated write it performs (connector ops, entity mutations,
    // automation edits) resolve the automation's owning agent and evaluate in
    // autonomous mode — the script cannot dodge its agent's envelope by omitting
    // an explicit `automation_source`. `source: 'automation-run'` marks the turn
    // autonomous even for surfaces that read only sourceContext.
    actingAutomationId: context.window.automation_id,
    actingRunId: context.window.run_id,
    sourceContext: { source: 'automation-run' as const },
  };

  const result = await runScript({
    source: compiledScript,
    sdk: (abortSignal) =>
      buildClientSDK(scriptCtx, env as Env, { allowCrossOrg: false, abortSignal }),
    allowCrossOrg: false,
    context: context as unknown as Record<string, unknown>,
    extraArgs: params ? [params] : [],
    limits: { timeoutMs },
  });

  if (result.success && result.returnTruncated && !('extracted_data' in context)) {
    return { success: false, error: 'OutputSizeExceeded: Automation script return value exceeds the sandbox output limit.' };
  }
  if (result.success) {
    logger.info(
      {
        automation_id: context.window.automation_id,
        run_id: context.window.run_id,
        sdk_calls: result.sdkCalls,
        duration_ms: result.durationMs,
      },
      executionKind === 'reaction'
        ? 'Reaction script executed successfully'
        : 'Automation script executed successfully'
    );
    return {
      success: true,
      returnValue: result.returnValue,
      didReturnValue: result.didReturnValue,
    };
  }

  const errorMessage = result.error
    ? `${result.error.name}: ${result.error.message}`
    : executionKind === 'reaction'
      ? 'Unknown reaction error'
      : 'Unknown Automation script error';

  logger.error(
    {
      automation_id: context.window.automation_id,
      run_id: context.window.run_id,
      error: errorMessage,
    },
    executionKind === 'reaction'
      ? 'Reaction script execution failed'
      : 'Automation script execution failed'
  );
  return { success: false, error: errorMessage };
}

/**
 * Extract a reaction's exported `input` schema (a TypeBox schema, i.e. plain
 * JSON Schema) by loading the compiled module in the isolate WITHOUT invoking
 * its handler. This is how the automation's extraction contract is derived from
 * the reaction. The worker combines it with declared durable outputs; matching
 * properties refine the output via JSON Schema `allOf`, while reaction-only
 * properties remain part of the same extraction contract.
 *
 * Returns null when the reaction declares no `input` export (legacy/free-form
 * reactions) or the load fails — callers then fall back to `{ summary }`.
 */
export async function extractReactionInputSchema(
  source: string
): Promise<Record<string, unknown> | null> {
  // Pass RAW TS — runScript compiles it once (external:[], bundling the SDK).
  // Pre-compiling here would double-compile and mangle the named export.
  // Extract mode never invokes the handler, so the guest never touches the SDK
  // — a stub keeps this DB/env-free. The reaction's top-level only constructs
  // its `input` schema.
  const result = await runScript({
    source,
    sdk: {} as unknown as Parameters<typeof runScript>[0]['sdk'],
    allowCrossOrg: false,
    context: {},
    extractExport: 'input',
    limits: { timeoutMs: 5_000 },
  });
  if (!result.success) return null;
  const v = result.returnValue;
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Compile a TypeScript reaction script to JavaScript using esbuild.
 *
 * Stays exported because `manage_automations` create and set_reaction_script call
 * it at save time to surface compile errors back to the agent. Run-time compile
 * also happens inside `runScript` itself; this is a fast-path for
 * pre-validation.
 */
export async function compileReactionScript(source: string): Promise<string> {
  // Match `runScript`'s execute-time esbuild config exactly so save-time and
  // runtime accept the same set of imports. Drift here used to externalize
  // `@lobu/reactions`, which the runtime recompile would then fail to
  // resolve.
  const result = await compileSource(source, {
    tmpPrefix: '.reaction-compile-',
    label: 'ReactionCompiler',
    buildOptions: {
      format: 'cjs',
      target: 'esnext',
      platform: 'node',
      external: [],
    },
  });
  return result.compiledCode;
}

/**
 * Validate that a compiled reaction module exposes a default handler.
 *
 * `compileReactionScript` only checks syntax; a script with named exports
 * but no default export would pass compilation but fail at runtime inside
 * `runScript`. This runs the compiled code in an isolate with extract mode
 * to verify the default export exists without invoking the handler.
 */
export async function validateReactionDefaultExport(
  compiledScript: string,
): Promise<void> {
  const result = await runScript({
    source: compiledScript,
    sdk: {} as unknown as Parameters<typeof runScript>[0]['sdk'],
    allowCrossOrg: false,
    context: {},
    // Extract the default export without invoking it.
    extractExport: 'default',
    limits: { timeoutMs: 5_000 },
  });
  // runScript returns success=true with returnValue=null when the default
  // export is absent or not a function, so check both conditions.
  if (!result.success || !result.returnValue) {
    throw new Error(
      'Reaction script must export a default async function. ' +
        (result.error?.message ?? 'No default export found.'),
    );
  }
}
