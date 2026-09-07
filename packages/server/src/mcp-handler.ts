/**
 * Streamable HTTP MCP transport handler.
 *
 * Uses the official MCP SDK's low-level Server + WebStandardStreamableHTTPServerTransport
 * so that Codex CLI (rmcp) and other 2025-03-26 clients can connect.
 *
 * We use the low-level Server (not McpServer) because our tools use TypeBox
 * JSON Schemas, while McpServer.registerTool expects Zod schemas.
 *
 * Sessions are kept in-memory for active transports and persisted in PostgreSQL
 * so authenticated sessions can recover across restarts and replica hops.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { OAuthClientsStore } from './auth/oauth/clients';
import { buildMcpBearerChallenge, publicMcpRequestUrl } from './auth/oauth/resource-indicator';
import {
  getRequiredAccessLevel,
  hasRequiredMcpScope,
  isPublicReadable,
  resolveMaxAccessLevel,
} from './auth/tool-access';
import { createDbClientFromEnv } from './db/client';
import { type AbortableStream, bindRequestAbortToStream } from './events/sse-abort-bridge';
import { formatToolResult } from './formatting/markdown-formatter';
import type { Env } from './index';
import { TEMPLATE_ACTION_CAPABILITY_META_KEY } from './interactions/template-action-capability';
import {
  agentExistsInOrganization,
  isValidAgentId,
  touchAgentLastUsed,
} from './lobu/stores/postgres-stores';
import {
  isLobuInteractionResourceUri,
  LOBU_INTERACTION_RESOURCE_URI,
} from './mcp-app-resource-uris';
import {
  clearInMemoryMcpSessionsForTests as clearInMemoryMcpSessionsForTestsShared,
  mcpSessionMap,
} from './mcp-session-state';
import { McpSessionStore, type PersistedMcpSession } from './mcp-session-store';
import { LOBU_SKILL_MARKDOWN } from './skills/lobu-skill.generated';
import { readMcpAttachmentResource } from './mcp-media-resources';
import { isAdminOrOwnerRole } from './tools/access-control';
import {
  type AuthContext,
  executeTool,
  extractAuthContext,
  isSoftErrorResult,
} from './tools/execute';
import { getMcpResultContent } from './tools/mcp-result-content';
import { getMcpResultMeta } from './tools/mcp-result-meta';
import { MCP_APP_CAPABILITY_MAX_LENGTH } from './tools/mcp-app-capability';
import { getMcpTools, getTool, isAuthorizationReadOnly } from './tools/registry';
import { toMcpPublicSdkScriptResult } from './tools/sdk_run';
import { validateToolResult } from './tools/validate-args';
import { renderMcpAppTemplate } from './utils/mcp-app-bundle';
import { resolvePublicOrigin } from './utils/public-origin';
import { buildWorkspaceInstructions } from './utils/workspace-instructions';
import { listLiveGrantedMemberWorkspaces } from './auth/oauth/workspace-grants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const APPROVAL_CAPABILITY_META_KEY = 'lobu/approval-capability';
// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  authCtx: AuthContext;
  lastAccessedAt: number;
}

// Typed view over the shared raw Map in `./mcp-session-state` so the test
// cleanup path can clear it without loading the rest of this module.
const sessions = mcpSessionMap as Map<string, SessionEntry>;
const mcpSessionStore = new McpSessionStore();

type SessionAuthContext = AuthContext & {
  instructions?: string;
  supportsMcpApps?: boolean;
  supportsAppSandboxDomain?: boolean;
};

export function hostConversationIdFromMeta(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>)['openai/session'];
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : null;
}

function capabilityFromMeta(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const token = (value as Record<string, unknown>)[key];
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  return trimmed && trimmed.length <= MCP_APP_CAPABILITY_MAX_LENGTH ? trimmed : null;
}

/**
 * ChatGPT's legacy `window.openai.callTool` shim treats a request-level `_meta`
 * as tool arguments, so the capability arrives nested inside the arguments bag.
 * Read it from there; the caller strips it before schema validation, which
 * rejects unknown argument keys.
 */
function capabilityFromCompatArgs(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const compatMeta = (value as Record<string, unknown>)._meta;
  return capabilityFromMeta(compatMeta, key);
}

function stripCapabilityCompatMeta(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!value) return value;
  const clean = { ...value };
  delete clean._meta;
  return clean;
}

// Periodic cleanup of stale IN-MEMORY sessions. This must stay as a per-pod
// setInterval — each pod owns its own `sessions` Map of live MCP transports
// and only it can call `entry.transport.close?.()`. The DB-side cleanup
// (mcpSessionStore.deleteExpiredSessions) is registered as a cross-pod
// scheduler task in scheduled/jobs.ts so it runs once per cluster per tick.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccessedAt > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
      entry.transport.close?.();
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

/** DB-side cleanup of expired MCP sessions. Wired by `registerMaintenanceTasks`. */
export async function cleanupExpiredMcpSessions(): Promise<void> {
  await mcpSessionStore.deleteExpiredSessions();
}

// Re-export the test-only clearer; the actual implementation lives in
// `./mcp-session-state` so callers can clear sessions without statically
// loading this file (and its `@lobu/connector-sdk`-dependent tool registry).
export const clearInMemoryMcpSessionsForTests = clearInMemoryMcpSessionsForTestsShared;

/**
 * `userId` narrows the sweep to one person's sessions on this client — the
 * same scoping `revokeClientForOrganization` applies to tokens. A shared
 * registration can hold sessions for several people; without this, revoking
 * for one of them closes everyone else's live transport too.
 */
export async function revokeInMemoryMcpSessionsForClient(
  clientId: string,
  organizationId: string,
  userId?: string | null
): Promise<string[]> {
  const revokedSessionIds: string[] = [];

  for (const [sessionId, entry] of sessions.entries()) {
    const appliesToWorkspace =
      entry.authCtx.organizationId === organizationId ||
      (entry.authCtx.grantedOrganizationIds ?? []).includes(organizationId);
    if (entry.authCtx.clientId !== clientId || !appliesToWorkspace) {
      continue;
    }
    if (userId && entry.authCtx.userId !== userId) {
      continue;
    }

    revokedSessionIds.push(sessionId);
    sessions.delete(sessionId);
    await deletePersistedSession(sessionId);
    entry.transport.close?.();
  }

  return revokedSessionIds;
}

// ---------------------------------------------------------------------------
// Build a low-level Server wired to our tool registry + auth context
// ---------------------------------------------------------------------------

/** Request-local response formatting; concurrent MCP sessions must never race. */
const mcpRequestFormat = new AsyncLocalStorage<{ rawJson: boolean }>();

/**
 * MCP Apps UI resources (interactive iframe payloads a host renders in a
 * sandboxed iframe). Keyed by `ui://` uri → the built bundle's app dir under
 * owletto's `dist-mcp-apps/`. Served over `resources/read` + the asset route;
 * a tool that declares the resource (`get_approval`, `save_memory`) supplies a
 * server-authored LobuViewV1 in `structuredContent`. Adding an app = one entry
 * plus its owletto `src/mcp-apps/<dir>` build — no gateway change.
 */
const MCP_APP_RESOURCES: Record<
  string,
  {
    name: string;
    /**
     * Surfaced as the resource's typed `description` on `resources/list`, where
     * clients show it in resource browsers, and as `openai/widgetDescription`
     * on both the listed and the read template, where ChatGPT gives it to the
     * model when the component loads instead of narrating the card itself.
     */
    description: string;
    appDir: string;
    /**
     * Domains the host should allow the rendered iframe to reach, in the MCP
     * Apps `_meta.ui.csp` shape. The host owns the resulting policy; we only
     * declare what the bundle needs. Empty lists mean "nothing beyond the
     * bundle's own origin".
     */
    csp: {
      connectDomains: string[];
      resourceDomains: string[];
      frameDomains: string[];
    };
    prefersBorder: boolean;
  }
> = {
  [LOBU_INTERACTION_RESOURCE_URI]: {
    name: 'Interaction',
    description:
      'Interactive Lobu cards rendered in a sandboxed iframe; actions use standard MCP tool calls or host-mediated external links.',
    appDir: 'interaction',
    csp: {
      connectDomains: [],
      resourceDomains: ['https://t2.gstatic.com'],
      frameDomains: [],
    },
    prefersBorder: true,
  },
};

/**
 * Built MCP App dirs, derived from the registry above. The asset route
 * (`/mcp-apps/:app/index.html`) validates its path param against this set so it
 * only ever serves a registered bundle — an untrusted `:app` can't be used to
 * probe the filesystem.
 */
export const MCP_APP_DIRS: ReadonlySet<string> = new Set(
  Object.values(MCP_APP_RESOURCES).map((r) => r.appDir)
);

/**
 * Skill resources served over `resources/list` + `resources/read` as plain
 * markdown reference material (NOT interactive `ui://` bundles). Slackbot and
 * other MCP clients can read these to learn how to work with Lobu. The content
 * is embedded at build time (see scripts/gen-skill-resource.ts) so it ships
 * identically in prod and local dev — `skills/` is not copied into the server
 * image, so a runtime file read would 404 in prod.
 */
const MCP_SKILL_RESOURCES: Record<
  string,
  {
    name: string;
    description: string;
    text: string;
  }
> = {
  'skill://lobu': {
    name: 'Lobu',
    description:
      'How to work with a Lobu project and Lobu memory: run/validate/evaluate/connect, MCP client setup, knowledge search/save, Automations, and connectors.',
    text: LOBU_SKILL_MARKDOWN,
  },
};

function supportsMcpApps(capabilities: Record<string, unknown> | null | undefined): boolean {
  const extensions = capabilities?.extensions;
  if (!extensions || typeof extensions !== 'object') return false;
  const uiExtension = (extensions as Record<string, unknown>)[MCP_APP_EXTENSION_ID];
  if (!uiExtension || typeof uiExtension !== 'object') return false;
  const mimeTypes = (uiExtension as Record<string, unknown>).mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE);
}

function supportsAppSandboxDomain(
  capabilities: Record<string, unknown> | null | undefined
): boolean {
  if (!supportsMcpApps(capabilities)) return false;
  const experimental = capabilities?.experimental;
  if (!experimental || typeof experimental !== 'object') return false;
  const visibility = (experimental as Record<string, unknown>)['openai/visibility'];
  return (
    !!visibility &&
    typeof visibility === 'object' &&
    (visibility as Record<string, unknown>).enabled === true
  );
}

function mcpAppUiMeta(
  authCtx: SessionAuthContext,
  app: (typeof MCP_APP_RESOURCES)[string]
): {
  domain?: string;
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
  };
  permissions: { clipboardWrite: Record<string, never> };
  prefersBorder: boolean;
} {
  const publicOrigin = resolvePublicOrigin(authCtx.requestUrl);
  return {
    // `_meta.ui.domain` is the view's dedicated sandbox origin, and it is not a
    // request to serve the view from ours: the host derives its own sandbox
    // hostname from it (ChatGPT renders at
    // `<domain>.web-sandbox.oaiusercontent.com`) and owns the resulting
    // document. ChatGPT requires the field for submission, and the derived
    // subdomain is what its fullscreen punch-out needs. The value must be
    // unique per app, so it is the one origin that already identifies this
    // deployment.
    //
    // Some hosts negotiate the MCP Apps UI extension without advertising the
    // OpenAI visibility capability. Such hosts can treat this field as an
    // unusable iframe origin and leave the card on a spinner. Omitted, the view
    // lands on the host's default per-conversation origin. Keying on the
    // negotiated capability avoids a user-agent or client-name allowlist.
    ...(authCtx.supportsAppSandboxDomain ? { domain: publicOrigin } : {}),
    csp: {
      ...app.csp,
      resourceDomains: [...new Set([...app.csp.resourceDomains, publicOrigin])],
    },
    permissions: { clipboardWrite: {} },
    prefersBorder: app.prefersBorder,
  };
}

/**
 * Root `_meta` for an MCP App resource. `openai/widgetDescription` sits beside
 * the nested `ui` block rather than inside it: it is an OpenAI-namespaced key,
 * and ChatGPT hands it to the model when the component loads so the model stops
 * re-describing the rendered card in prose. Like `ui.domain`, it has to ride the
 * listed template as well as the read one because a host captures that copy at
 * connect time.
 */
function mcpAppResourceMeta(
  authCtx: SessionAuthContext,
  app: (typeof MCP_APP_RESOURCES)[string]
) {
  return {
    ui: mcpAppUiMeta(authCtx, app),
    'openai/widgetDescription': app.description,
  };
}

function createServerForContext(
  env: Env,
  authCtx: SessionAuthContext,
  mcpAppsSupported: boolean
): Server {
  const server = new Server(
    { name: 'lobu-mcp', version: '0.2.0' },
    {
      capabilities: { tools: {}, resources: {} },
      ...(authCtx.instructions && { instructions: authCtx.instructions }),
    }
  );

  // tools/list — agent-facing surface only (memory + SDK scripting + SQL/metrics).
  // Admin flat tools stay dispatchable via tools/call and REST but are omitted
  // here so agents compose through query_sdk / run_sdk instead.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // An account OAuth session advertises the scope-bounded SDK surface;
    // client.org(target) resolves membership again and every leaf method gates
    // against that target role.
    const effectiveCrossOrg =
      authCtx.allowCrossOrg && !authCtx.agentId && !authCtx.actingAutomationId;
    const publicOnly = !!authCtx.organizationId && !effectiveCrossOrg && !authCtx.memberRole;
    const maxAccessLevel = resolveMaxAccessLevel(authCtx.memberRole, authCtx.scopes, effectiveCrossOrg);
    const allTools = getMcpTools({
      publicOnly,
      maxAccessLevel,
      adminScopeEligible: effectiveCrossOrg || isAdminOrOwnerRole(authCtx.memberRole),
    })
      .filter((t) => {
        const visibility = (t._meta?.ui as { visibility?: unknown } | undefined)?.visibility;
        return mcpAppsSupported || !(
          Array.isArray(visibility) && visibility.length === 1 && visibility[0] === 'app'
        );
      })
      .map((t) => {
        const securitySchemes = t.securitySchemes
          ? publicOnly
            ? [{ type: 'noauth' as const }, ...t.securitySchemes]
            : t.securitySchemes
          : undefined;
        // The app binding ships to every client, negotiated or not:
        // `resources/list` already advertises the app unconditionally, and some
        // hosts (claude.ai) render apps without declaring the extension, so
        // gating the binding on the declared capability left them an app they
        // could see but never bind — no iframe mounted at all. `_meta` is inert
        // to a client that does not understand it, so text-only callers are
        // unaffected. What stays gated is the visibility filter above: app-only
        // tools remain hidden from clients that did not negotiate (hidden, not
        // disabled — `tools/call` still dispatches them, so a rendered card can
        // drive its own resolver).
        return {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations && { annotations: t.annotations }),
          ...(t.outputSchema && { outputSchema: t.outputSchema }),
          ...(securitySchemes && { securitySchemes }),
          ...(t._meta || securitySchemes
            ? {
                _meta: {
                  ...(t._meta ?? {}),
                  // MCP Apps 2025-11-25 retains `_meta.securitySchemes` as the
                  // compatibility mirror for hosts that predate the top-level field.
                  ...(securitySchemes && { securitySchemes }),
                },
              }
            : {}),
        };
      });

    return { tools: allTools };
  });

  // resources/list — advertise the MCP App UI resources (interactive iframe
  // surfaces a host renders in place of flat text; see MCP Apps).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...Object.entries(MCP_APP_RESOURCES).map(([uri, meta]) => ({
        uri,
        name: meta.name,
        description: meta.description,
        mimeType: MCP_APP_MIME_TYPE,
        _meta: mcpAppResourceMeta(authCtx, meta),
      })),
      ...Object.entries(MCP_SKILL_RESOURCES).map(([uri, meta]) => ({
        uri,
        name: meta.name,
        description: meta.description,
        mimeType: 'text/markdown',
      })),
    ],
  }));

  // resources/read — return the built bundle HTML for a `ui://` app resource.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const mediaResource = await readMcpAttachmentResource(uri, env, authCtx);
    if (mediaResource) return mediaResource;
    const skill = MCP_SKILL_RESOURCES[uri];
    if (skill) {
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: skill.text }],
      };
    }
    // A host reads the id it captured from `resources/list` at connect time,
    // not the one in the tool result it just received, so a superseded version
    // still arrives here for the life of that connection. Resolve any of them
    // to the one interaction shell we serve, and echo back the id that was
    // asked for — that is what the host keys its cache on.
    const app =
      MCP_APP_RESOURCES[uri] ??
      (isLobuInteractionResourceUri(uri)
        ? MCP_APP_RESOURCES[LOBU_INTERACTION_RESOURCE_URI]
        : undefined);
    if (!app) throw new Error(`Unknown resource: ${uri}`);
    const html = await renderMcpAppTemplate(
      app.appDir,
      resolvePublicOrigin(authCtx.requestUrl)
    );
    if (html == null) {
      throw new Error(`MCP App bundle not built for ${uri} (run owletto build:mcp-apps)`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_MIME_TYPE,
          text: html,
          _meta: mcpAppResourceMeta(authCtx, app),
        },
      ],
    };
  });

  // tools/call — access control + execution + formatting
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const compatApprovalCapability =
      name === 'resolve_approval'
        ? capabilityFromCompatArgs(args, APPROVAL_CAPABILITY_META_KEY)
        : null;
    const compatEventActionCapability =
      name === 'invoke_event_action'
        ? capabilityFromCompatArgs(args, TEMPLATE_ACTION_CAPABILITY_META_KEY)
        : null;
    const callArgs =
      compatApprovalCapability || compatEventActionCapability
        ? stripCapabilityCompatMeta(args)
        : args;
    const callAuthCtx = {
      ...authCtx,
      mcpAppsSupported,
      mcpConversationId: hostConversationIdFromMeta(request.params._meta),
      mcpAppApprovalCapability:
        capabilityFromMeta(request.params._meta, APPROVAL_CAPABILITY_META_KEY) ??
        compatApprovalCapability,
      mcpAppEventActionCapability:
        capabilityFromMeta(request.params._meta, TEMPLATE_ACTION_CAPABILITY_META_KEY) ??
        compatEventActionCapability,
    };
    const tool = getTool(name);
    // Every App-facing result carries the viewer's org role because the app
    // gates its Debug (raw JSON) disclosure on owner/admin. Data and action
    // tools are deliberately headless; the role therefore rides only on the
    // tools that declare UI metadata (save_memory and the approval pair).
    //
    // The key must be PRESENT on every such result, carrying an explicit null
    // for a non-member reading a public workspace: the app falls back to the
    // alternate `call_tool_result` envelope only when the key is ABSENT, and
    // that envelope can carry a stale role. The annotation keeps that
    // guarantee typechecked — an `undefined` role would serialize the key
    // away, so widening `memberRole` to optional must fail the build rather
    // than silently drop the downgrade. `memberRole` is resolved server-side
    // from the membership row and returned only to the caller it describes,
    // so it can be neither forged nor read cross-tenant. Computed once here,
    // outside the try, so a thrown error carries the same viewer role as a
    // successful result and the app can never hold onto a stale role after a
    // downgrade.
    const uiMemberRoleMeta: { 'lobu/member-role': string | null } | undefined = tool?.mcpMeta?.ui
      ? { 'lobu/member-role': callAuthCtx.memberRole }
      : undefined;
    // Regular tool execution
    try {
      const result = await executeTool(name, callArgs ?? {}, env, callAuthCtx);

      if (authCtx.agentId && authCtx.organizationId) {
        await touchAgentLastUsed(authCtx.organizationId, authCtx.agentId);
      }

      const attachedContent = getMcpResultContent(result) ?? [];

      // executeTool has already passed the rich SDK result through the internal
      // audit seam. Do not expose logs, stacks, org traversal, or call traces to
      // MCP clients.
      const publicResult =
        name === 'run_sdk' || name === 'query_sdk'
          ? toMcpPublicSdkScriptResult(result)
          : result;
      const text = mcpRequestFormat.getStore()?.rawJson
        ? JSON.stringify(publicResult)
        : formatToolResult(name, publicResult, { includeRawJson: false });
      // When the tool declares an `outputSchema`, also return the result as
      // `structuredContent` (MCP spec: declaring outputSchema implies the result
      // is structured — and a spec-compliant client validates it against the
      // declared schema). Tools without one stay text-only — the schema is
      // coupled to emission, never declared alone.
      //
      // Validate + coerce the result against the schema before emitting: result
      // types are hand-authored TypeBox schemas but the values are assembled from
      // raw SQL rows (Dates where the schema says String, counts as bigint, a
      // NULL where the schema says non-null). `validateToolResult` coerces the
      // fixable drift and, on an unfixable mismatch, returns null so we fall back
      // to text-only rather than shipping structuredContent the client rejects —
      // a successful tool call must never surface as a validation error.
      //
      // A resolved failure is still a failed MCP tool call and must carry
      // `isError`; otherwise the client treats it as a normal result. query_sql
      // also renders the error explicitly because its formatter would otherwise
      // turn `{ rows: [], error }` into a clean empty CSV result.
      const attachedMeta = getMcpResultMeta(result);
      // OAuth challenges are MCP tool errors even when the underlying power tool
      // intentionally preserves a structured failure payload (for example
      // run_sdk's nested admin-scope denial). Hosts only perform progressive
      // authorization reliably when the challenge is carried on an error result.
      const attachedAuthChallenge =
        Array.isArray(attachedMeta?.['mcp/www_authenticate']) &&
        attachedMeta['mcp/www_authenticate'].length > 0;
      const softError = isSoftErrorResult(publicResult) || attachedAuthChallenge;
      const uiResourceUri = (
        tool?.mcpMeta?.ui as { resourceUri?: unknown } | undefined
      )?.resourceUri;
      // The standard MCP Apps linkage lives on the tool descriptor. ChatGPT's
      // compatibility path also reads openai/outputTemplate from the concrete
      // successful tool result before it fetches and mounts the resource. Keep
      // the URI server-authored and send it to every client, for the same
      // reason the descriptor carries it unconditionally: a host that ignores
      // `_meta` keeps its text-only result path, while a host that renders
      // apps without declaring the extension can still bind the result to the
      // resource we advertised.
      const appResultMeta =
        typeof uiResourceUri === 'string'
          ? { 'openai/outputTemplate': uiResourceUri }
          : undefined;
      const resultMeta =
        appResultMeta || uiMemberRoleMeta
          ? {
              ...appResultMeta,
              ...uiMemberRoleMeta,
              // A target-aware app handler may author a more specific role
              // than the session default. This metadata is server-only and
              // cannot be supplied through tool arguments.
              ...attachedMeta,
            }
          : attachedMeta;
      if (tool?.outputSchema && result && typeof result === 'object') {
        const structured = validateToolResult(tool.outputSchema, publicResult);
        if (structured !== null) {
          return {
            content: [{ type: 'text' as const, text }, ...attachedContent],
            structuredContent: structured as Record<string, unknown>,
            _meta: resultMeta,
            ...(softError ? { isError: true } : {}),
          };
        }
      }
      return {
        content: [{ type: 'text' as const, text }, ...attachedContent],
        _meta: resultMeta,
        ...(softError ? { isError: true } : {}),
      };
    } catch (error: any) {
      const requiredAccess = tool
        ? getRequiredAccessLevel(name, args ?? {}, isAuthorizationReadOnly(tool))
        : null;
      const requiredScope =
        requiredAccess === 'read'
          ? 'mcp:read'
          : requiredAccess === 'write'
            ? 'mcp:write'
            : requiredAccess === 'admin'
              ? 'mcp:admin'
              : null;
      const scopeChallenge =
        requiredAccess &&
        requiredScope &&
        (authCtx.tokenType === 'oauth' || authCtx.tokenType === 'pat') &&
        !hasRequiredMcpScope(requiredAccess, authCtx.scopes)
          ? buildMcpBearerChallenge(authCtx.requestUrl, {
              error: 'insufficient_scope',
              errorDescription: error?.message ?? 'The token lacks the required MCP scope.',
              scope: requiredScope,
            })
          : null;
      // Surface the structured taxonomy (lobu#2051 Item 2) when the thrown error
      // carries a code, so the client/agent gets a stable code + retryability +
      // per-call correlation id alongside the human message.
      const code = error?.code as string | undefined;
      const structuredError =
        typeof code === 'string' && typeof error?.retryable === 'boolean'
          ? {
              code,
              retryable: error.retryable as boolean,
              ...(error.callId ? { call_id: error.callId as string } : {}),
            }
          : undefined;
      const errorMeta = scopeChallenge
        ? { 'mcp/www_authenticate': [scopeChallenge] }
        : undefined;
      return {
        content: [
          {
            type: 'text' as const,
            text: error.message ?? 'Tool execution failed',
          },
        ],
        isError: true,
        ...(structuredError ? { structuredContent: { error: structuredError } } : {}),
        ...(uiMemberRoleMeta || errorMeta
          ? { _meta: { ...(errorMeta ?? {}), ...(uiMemberRoleMeta ?? {}) } }
          : {}),
      };
    }
  });

  return server;
}

function buildUnauthorizedResponse(req: Request, description: string): Response {
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      error_description: description,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': buildMcpBearerChallenge(publicMcpRequestUrl(req)),
      },
    }
  );
}

async function readToolCall(
  req: Request
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const toolCall = messages.find((m: any) => m?.method === 'tools/call');
    if (!toolCall || typeof toolCall?.params?.name !== 'string') return null;
    return {
      name: toolCall.params.name,
      args:
        toolCall.params.arguments && typeof toolCall.params.arguments === 'object'
          ? toolCall.params.arguments
          : {},
    };
  } catch {
    return null;
  }
}

async function readInitializeRequest(req: Request): Promise<{
  id: string | number | null;
  requestedAgentId: string | null;
  clientInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
} | null> {
  const headerAgentId = req.headers.get('x-lobu-agent-id')?.trim() || null;
  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const initialize = messages.find((m: any) => m?.method === 'initialize');
    if (!initialize) {
      return headerAgentId
        ? {
            id: null,
            requestedAgentId: headerAgentId,
            clientInfo: null,
            capabilities: null,
          }
        : null;
    }

    const clientInfo =
      initialize?.params?.clientInfo && typeof initialize.params.clientInfo === 'object'
        ? initialize.params.clientInfo
        : null;
    const capabilities =
      initialize?.params?.capabilities && typeof initialize.params.capabilities === 'object'
        ? initialize.params.capabilities
        : null;
    const bodyAgentId =
      (typeof clientInfo?.agentId === 'string' && clientInfo.agentId.trim()) ||
      (typeof clientInfo?.metadata?.agentId === 'string' && clientInfo.metadata.agentId.trim()) ||
      null;

    return {
      id: initialize.id ?? null,
      requestedAgentId: headerAgentId ?? bodyAgentId,
      clientInfo,
      capabilities,
    };
  } catch {
    return headerAgentId
      ? {
          id: null,
          requestedAgentId: headerAgentId,
          clientInfo: null,
          capabilities: null,
        }
      : null;
  }
}

async function readServerDiscoverRequestId(
  req: Request
): Promise<string | number | null | undefined> {
  try {
    const body = await req.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    const discover = messages.find((m: any) => m?.method === 'server/discover');
    if (!discover) return undefined;
    return typeof discover.id === 'string' || typeof discover.id === 'number'
      ? discover.id
      : null;
  } catch {
    return undefined;
  }
}

function buildPersistedSession(
  sessionId: string,
  authCtx: SessionAuthContext,
  lastAccessedAt: number = Date.now()
): PersistedMcpSession {
  return {
    sessionId,
    userId: authCtx.userId,
    // `mcp_sessions.client_id` references oauth_clients(id). PAT sessions are
    // authenticated, but their synthetic `pat_<id>` client id has no oauth row.
    clientId: authCtx.tokenType === 'oauth' ? authCtx.clientId : null,
    organizationId: authCtx.organizationId,
    memberRole: authCtx.memberRole,
    requestedAgentId: authCtx.requestedAgentId,
    isAuthenticated: authCtx.isAuthenticated,
    scopedToOrg: authCtx.scopedToOrg,
    supportsMcpApps: authCtx.supportsMcpApps ?? false,
    supportsAppSandboxDomain: authCtx.supportsAppSandboxDomain ?? false,
    lastAccessedAt,
    expiresAt: lastAccessedAt + SESSION_MAX_AGE_MS,
  };
}

async function persistSessionState(
  sessionId: string | null | undefined,
  authCtx: SessionAuthContext,
  lastAccessedAt: number = Date.now()
): Promise<void> {
  if (!sessionId) return;
  await mcpSessionStore.upsertSession(buildPersistedSession(sessionId, authCtx, lastAccessedAt));
}

/**
 * Refresh an already-established session's row, update-only.
 *
 * Returns false when the row is gone — i.e. another replica revoked the client
 * — so the caller can tear the local transport down. Distinct from
 * `persistSessionState`, which may CREATE the row and would otherwise
 * resurrect a session a concurrent revoke just deleted.
 */
async function refreshSessionState(
  sessionId: string | null | undefined,
  authCtx: SessionAuthContext,
  lastAccessedAt: number = Date.now()
): Promise<boolean> {
  if (!sessionId) return true;
  return mcpSessionStore.refreshSession(buildPersistedSession(sessionId, authCtx, lastAccessedAt));
}

async function deletePersistedSession(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  await mcpSessionStore.deleteSession(sessionId);
}

async function resolveMembershipRole(
  env: Env,
  organizationId: string | null,
  userId: string | null
): Promise<string | null> {
  if (!organizationId || !userId) return null;
  const sql = createDbClientFromEnv(env);
  const rows = await sql`
    SELECT role
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND "userId" = ${userId}
    LIMIT 1
  `;
  return rows.length > 0 ? ((rows[0].role as string) ?? null) : null;
}

async function buildSessionInstructions(authCtx: AuthContext): Promise<string | undefined> {
  // Only verified worker-originated requests carry sourceContext. A client may
  // request an agent binding in initialize metadata, but that must not grant it
  // the tenant-authored agent instructions intended for Lobu-managed workers.
  const audience =
    authCtx.sourceContext != null || authCtx.actingAutomationId != null
      ? 'managed-agent'
      : 'direct-mcp';
  const base = authCtx.organizationId
    ? ((await buildWorkspaceInstructions(authCtx.organizationId, { audience })) ?? '')
    : '';
  if (
    authCtx.tokenType !== 'oauth' ||
    !authCtx.userId ||
    authCtx.grantedOrganizationIds === null
  ) {
    return base || undefined;
  }
  const grantedOrganizationIds =
    authCtx.agentId || authCtx.actingAutomationId
      ? authCtx.organizationId
        ? [authCtx.organizationId]
        : []
      : authCtx.grantedOrganizationIds;
  const workspaces = await listLiveGrantedMemberWorkspaces({
    userId: authCtx.userId,
    grantedOrganizationIds,
  });
  if (workspaces.length === 0) return base || undefined;
  const labels = workspaces.map((workspace) => {
    const qualifiers = [
      workspace.personal ? 'personal' : null,
    ].filter((value): value is string => value !== null);
    return qualifiers.length > 0
      ? `${workspace.slug} (${qualifiers.join(', ')})`
      : workspace.slug;
  });
  const grantLine =
    `Granted workspaces: ${labels.join(', ')}. ` +
    (authCtx.directSearchFederation
      ? 'Unqualified search searches all granted workspaces. Select each SDK target with await client.org(workspace); direct writes and SQL require an explicit target.'
      : 'This connection operates in its explicitly bound workspace.');
  return [base, grantLine].filter(Boolean).join('\n\n');
}

/** Agent/Automation policy is workspace-bound; it must never inherit a user's
 * broader bare-MCP navigation/search grant. Keep the raw token array intact so
 * per-request token refresh can still detect grant changes, and project the
 * effective singleton at instruction/tool-context boundaries. */
function restrictBoundIdentityWorkspaceAccess(authCtx: AuthContext): void {
  if (!authCtx.agentId && !authCtx.actingAutomationId) return;
  authCtx.allowCrossOrg = false;
  authCtx.directSearchFederation = false;
}

/**
 * Populate `memberRole` for an authenticated SCOPED (`/mcp/{slug}`) session.
 *
 * `extractAuthContext` derives the org from the URL slug and the user from the
 * token, but never looks up the caller's membership row — so a scoped session's
 * `memberRole` is null even for a real owner/admin. The UNSCOPED path already
 * resolves it via `resolveMembershipRole`; the scoped path historically skipped
 * that, which made every role-gated action (e.g. `manage_catalog.list_installed`,
 * which requires admin) wrongly deny legitimate members over `/mcp/{slug}`.
 *
 * Anonymous public-workspace browse (no userId) keeps a null role by design —
 * `resolveMembershipRole` returns null for a null user, so this is a no-op there.
 */
async function hydrateScopedMemberRole(env: Env, authCtx: AuthContext): Promise<void> {
  if (!authCtx.scopedToOrg || !authCtx.isAuthenticated) return;
  if (!authCtx.organizationId || !authCtx.userId) return;
  authCtx.memberRole = await resolveMembershipRole(env, authCtx.organizationId, authCtx.userId);
}

const RECOVERY_OAUTH_BEARER_REQUIRED = Symbol('recovery-oauth-bearer-required');

async function recoverSessionAuthContext(
  c: Context<{ Bindings: Env }>,
  sessionId: string
): Promise<SessionAuthContext | typeof RECOVERY_OAUTH_BEARER_REQUIRED | null> {
  const persisted = await mcpSessionStore.getSession(sessionId);
  if (!persisted) return null;

  const authCtx = await resolveAuthWithInstructions(c);

  // OAuth sessions are identifiable by their persisted client FK. A missing
  // (or non-OAuth) bearer is an authentication failure, not evidence that the
  // server-issued session id is invalid. Preserve the row so an unauthenticated
  // request cannot terminate a victim's cross-replica session and a bearer
  // retry can recover it normally.
  if (persisted.isAuthenticated && persisted.clientId && authCtx.tokenType !== 'oauth') {
    return RECOVERY_OAUTH_BEARER_REQUIRED;
  }

  if (persisted.isAuthenticated) {
    if (!authCtx.isAuthenticated) return null;
    if (persisted.userId && persisted.userId !== authCtx.userId) return null;
    if (persisted.clientId && persisted.clientId !== authCtx.clientId) return null;
  }

  if (persisted.scopedToOrg !== authCtx.scopedToOrg) {
    return null;
  }

  if (
    authCtx.tokenType === 'oauth' &&
    // Scoped routes were already authorized by the current request's
    // multi-tenant middleware. This exception preserves public read-only
    // sessions whose workspace intentionally is not an OAuth member grant.
    !persisted.scopedToOrg &&
    persisted.organizationId &&
    !(authCtx.grantedOrganizationIds ?? []).includes(persisted.organizationId)
  ) {
    return null;
  }

  if (persisted.scopedToOrg) {
    if (authCtx.organizationId !== persisted.organizationId) {
      return null;
    }
    // Scoped sessions must resolve the caller's membership role too — otherwise
    // role-gated actions deny a legitimate owner/admin over `/mcp/{slug}`.
    await hydrateScopedMemberRole(c.env, authCtx);
  } else {
    if (authCtx.organizationId !== persisted.organizationId) return null;
    authCtx.memberRole = await resolveMembershipRole(
      c.env,
      persisted.organizationId,
      authCtx.userId
    );

    if (persisted.isAuthenticated && persisted.organizationId && !authCtx.memberRole) {
      return null;
    }
  }

  // A recovered session cannot move between agents. When the persisted row is
  // unbound, verified request auth may supply one; conflicting bindings fail.
  if (
    authCtx.requestedAgentId &&
    persisted.requestedAgentId &&
    authCtx.requestedAgentId !== persisted.requestedAgentId
  ) {
    return null;
  }
  authCtx.requestedAgentId = persisted.requestedAgentId ?? authCtx.requestedAgentId;
  authCtx.supportsMcpApps = persisted.supportsMcpApps;
  authCtx.supportsAppSandboxDomain = persisted.supportsAppSandboxDomain;
  const bindingError = await syncAgentBinding(authCtx);
  if (bindingError) {
    return null;
  }
  restrictBoundIdentityWorkspaceAccess(authCtx);
  authCtx.instructions = await buildSessionInstructions(authCtx);

  return authCtx;
}

async function recordMcpClientActivity(
  env: Env,
  authCtx: AuthContext,
  req: Request,
  initialize?: {
    clientInfo: Record<string, unknown> | null;
    capabilities: Record<string, unknown> | null;
  } | null
): Promise<void> {
  if (!authCtx.clientId || authCtx.tokenType !== 'oauth') return;

  const sql = createDbClientFromEnv(env);
  const clientsStore = new OAuthClientsStore(sql);

  await clientsStore.touchClientActivity({
    clientId: authCtx.clientId,
    organizationId: authCtx.organizationId,
    userId: authCtx.userId,
    userAgent: req.headers.get('user-agent'),
    clientInfo: initialize?.clientInfo ?? null,
    capabilities: initialize?.capabilities ?? null,
  });
}

function buildJsonRpcErrorResponse(
  message: string,
  id: string | number | null,
  status: number = 400
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id,
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// Accept header handling
// ---------------------------------------------------------------------------

const FULL_MCP_ACCEPT = 'application/json, text/event-stream';

// The SDK transport requires both application/json and text/event-stream in
// Accept. Normalize so clients that omit SSE aren't rejected with 406.
function normalizeAcceptHeader(req: Request): Request {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream') && accept.includes('application/json')) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set('accept', FULL_MCP_ACCEPT);
  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    duplex: 'half',
  });
}

// -----------------------------------------------------------------------------
// SSE heartbeat - keeps the GET stream alive through proxies/load balancers
// that would otherwise close idle connections (e.g. Traefik default 5 s).
// -----------------------------------------------------------------------------
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export function withSSEHeartbeat(response: Response, signal?: AbortSignal): Response {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    return response;
  }
  if (signal?.aborted) {
    response.body.cancel().catch(() => undefined);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      { status: response.status, headers: response.headers }
    );
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const heartbeat = new TextEncoder().encode(': ping\n\n');

  // The heartbeat, the pipe, the source close handler, the pipe error
  // handler, AND the per-request AbortSignal can all race to terminate the
  // writer. Once it transitions closed/aborted any further close()/abort()
  // throws "Invalid state" (Sentry: LOBU-30). Latch on the first terminal
  // call.
  let terminated = false;
  let intervalId: NodeJS.Timeout | undefined;
  const closeWriter = () => {
    if (terminated) return;
    terminated = true;
    if (intervalId) clearInterval(intervalId);
    writer.close().catch(() => undefined);
  };
  const abortWriter = (reason: unknown) => {
    if (terminated) return;
    terminated = true;
    if (intervalId) clearInterval(intervalId);
    writer.abort(reason).catch(() => undefined);
  };

  // Bridge the per-request AbortSignal so abnormal disconnects (LB idle
  // timeout, proxy kill, client hard-close) actually clear the heartbeat
  // interval. The pre-existing close/error path on the source pipe only
  // catches normal pipe-through closure — same root cause as #833/#845.
  // Reuse the central abort-bridge so the pattern doesn't drift.
  const adapter: AbortableStream = {
    get aborted() {
      return terminated;
    },
    get closed() {
      return terminated;
    },
    abort() {
      abortWriter(new Error('Request aborted'));
    },
  };
  // Create the interval BEFORE binding the abort signal so that a pre-aborted
  // signal triggers abortWriter() → clearInterval(intervalId) instead of
  // leaving the timer running forever (codex audit, follow-up to #864).
  intervalId = setInterval(() => {
    writer.write(heartbeat).catch(() => abortWriter(new Error('SSE heartbeat write failed')));
  }, SSE_HEARTBEAT_INTERVAL_MS);

  const detachAbortBridge = bindRequestAbortToStream(signal, adapter);

  response.body
    .pipeTo(
      new WritableStream({
        write(chunk) {
          return writer.write(chunk);
        },
        close() {
          detachAbortBridge();
          closeWriter();
        },
        abort(reason) {
          detachAbortBridge();
          abortWriter(reason);
        },
      })
    )
    .catch(() => {
      detachAbortBridge();
      abortWriter(new Error('Source SSE stream error'));
    });

  return new Response(readable, {
    status: response.status,
    headers: response.headers,
  });
}

// Wrap transport.handleRequest. POST responses are always JSON (the transport
// is built with `enableJsonResponse: true`); only the standalone GET
// notification stream is SSE, and that is what the heartbeat below keeps alive.
async function handleTransportRequest(
  transport: WebStandardStreamableHTTPServerTransport,
  req: Request
): Promise<Response> {
  const rawJson = req.headers.get('x-mcp-format')?.toLowerCase() === 'json';
  const response = await mcpRequestFormat.run({ rawJson }, () => transport.handleRequest(req));
  // Inject SSE heartbeat pings to keep the stream alive through proxies.
  // Thread the inbound request's AbortSignal so abnormal disconnects clear
  // the interval (same root cause as PR #833/#845).
  return withSSEHeartbeat(response, req.signal);
}

// ---------------------------------------------------------------------------
// Session bootstrapping helpers
// ---------------------------------------------------------------------------

async function resolveAuthWithInstructions(
  c: Context<{ Bindings: Env }>,
  req?: Request
): Promise<SessionAuthContext> {
  const authCtx: SessionAuthContext = extractAuthContext(c);
  const request = req ?? c.req.raw;
  // `baseUrl` stays as extractAuthContext set it: empty means "no configured
  // public origin", which is what makes `getPublicWebUrl` fall back to the
  // hosted UI for backend-only self-hosters. Forcing the request origin here
  // would point every MCP link at a host that serves no frontend.
  authCtx.requestUrl = publicMcpRequestUrl(request);
  if (req) {
    const initialize = await readInitializeRequest(req);
    // Verified worker auth already supplies an agent. Only fall back to the
    // initialize metadata used by ordinary MCP clients when auth has none.
    authCtx.requestedAgentId = authCtx.requestedAgentId ?? initialize?.requestedAgentId ?? null;
  }
  authCtx.instructions = await buildSessionInstructions(authCtx);
  return authCtx;
}

async function syncAgentBinding(authCtx: SessionAuthContext): Promise<string | null> {
  const requestedAgentId = authCtx.requestedAgentId?.trim() || null;
  authCtx.agentId = null;

  if (!requestedAgentId) return null;
  if (!isValidAgentId(requestedAgentId)) {
    return 'agentId must be 3-60 lowercase alphanumeric chars with hyphens, starting with a letter';
  }
  if (!authCtx.isAuthenticated) {
    return 'Authentication required to bind MCP sessions to an agent.';
  }
  if (!authCtx.organizationId) {
    return null;
  }

  const exists = await agentExistsInOrganization(authCtx.organizationId, requestedAgentId);
  if (!exists) {
    return `Agent '${requestedAgentId}' was not found in the current organization.`;
  }

  authCtx.agentId = requestedAgentId;
  await touchAgentLastUsed(authCtx.organizationId, requestedAgentId);
  return null;
}

function createSessionTransport(
  env: Env,
  authCtx: SessionAuthContext,
  sessionIdGenerator: () => string
): { transport: WebStandardStreamableHTTPServerTransport; server: Server } {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator,
    // Keep request/response traffic in-band. Inspector and other clients keep
    // one standalone GET SSE stream open for server notifications; finite
    // POST-SSE responses can strand a tools/call until the client timeout when
    // that stream reconnects through a proxy and hits the SDK's one-GET-stream
    // session guard. JSON responses avoid that split delivery path while the
    // standalone GET stream remains available for notifications.
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      // The per-session authCtx object is shared by every request on this
      // session, so stamping once here threads the session id into each
      // tool call's ToolContext (audit rows group client activity by it).
      authCtx.mcpSessionId = id;
      sessions.set(id, {
        transport,
        server,
        authCtx,
        lastAccessedAt: Date.now(),
      });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
      void deletePersistedSession(transport.sessionId);
    }
  };
  const server = createServerForContext(env, authCtx, authCtx.supportsMcpApps ?? false);
  return { transport, server };
}

async function initializeRecoveredSession(
  transport: WebStandardStreamableHTTPServerTransport,
  sessionId: string,
  url: string
): Promise<void> {
  const initReq = new Request(url, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      accept: FULL_MCP_ACCEPT,
    }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'session-recovery', version: '1.0' },
      },
      id: '__recovery_init__',
    }),
  });
  await transport.handleRequest(initReq);

  const notifyReq = new Request(url, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      accept: FULL_MCP_ACCEPT,
      'mcp-session-id': sessionId,
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });
  await transport.handleRequest(notifyReq);
}

// ---------------------------------------------------------------------------
// Hono route handler – delegates to the SDK transport
// ---------------------------------------------------------------------------

export async function handleMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  const req = normalizeAcceptHeader(c.req.raw);
  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  const requestAuth = extractAuthContext(c);
  if (requestAuth.tokenType === 'oauth' && !requestAuth.scopedToOrg &&
      requestAuth.tokenOrganizationId && !requestAuth.scopes?.includes('device_worker:run')) {
    return buildUnauthorizedResponse(req, 'This OAuth authorization uses a retired default workspace. Reauthorize the client to select workspace grants without a default target.');
  }

  if (req.method === 'POST' && !sessionId) {
    const discoverId = await readServerDiscoverRequestId(req);
    if (discoverId !== undefined) {
      // `server/discover` belongs to the sessionless 2026-07-28 protocol era.
      // This server still implements the stateful 2025-11-25 era, so answer
      // with the spec-defined legacy signal instead of feeding the probe into
      // a transport that has not been initialized (which returns -32000 and
      // prevents modern clients such as ChatGPT from falling back).
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'Method not found' },
          id: discoverId,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Existing session → reuse
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastAccessedAt = Date.now();

    // The transport session is routing state, not an OAuth credential. Require
    // a freshly verified OAuth bearer on every request so token revocation and
    // live membership changes cannot be bypassed with only mcp-session-id.
    // Keep the live session intact on a missing header: a compliant retry with
    // the same bearer can continue without an unnecessary re-initialize.
    const freshRequestAuthCtx = c.var.mcpIsAuthenticated ? extractAuthContext(c) : null;
    if (session.authCtx.tokenType === 'oauth' && freshRequestAuthCtx?.tokenType !== 'oauth') {
      return buildUnauthorizedResponse(
        req,
        'A valid OAuth bearer token is required on every authenticated MCP request.'
      );
    }

    // The persisted row is the cross-replica revocation signal: revoking on any
    // pod DELETEs it. Refresh update-only and treat "no row" as revoked, so a
    // live transport on another pod cannot keep serving a revoked client. This
    // is deliberately a single atomic UPDATE rather than a check followed by an
    // upsert — a revoke committing between those two would be undone by the
    // write that follows it.
    if (!(await refreshSessionState(sessionId, session.authCtx, session.lastAccessedAt))) {
      sessions.delete(sessionId);
      session.transport.close?.();
      return buildJsonRpcErrorResponse(
        'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
        null,
        404
      );
    }

    const clearSession = () => {
      sessions.delete(sessionId);
      void deletePersistedSession(sessionId);
    };

    // Refresh authenticated session context on every request so role changes,
    // scope changes, and auth upgrades are reflected immediately.
    if (freshRequestAuthCtx) {
      const freshCtx = freshRequestAuthCtx;

      if (session.authCtx.isAuthenticated) {
        if (session.authCtx.userId && freshCtx.userId !== session.authCtx.userId) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Session authentication changed. Re-initialize.',
            null,
            400
          );
        }
        if (session.authCtx.clientId && freshCtx.clientId !== session.authCtx.clientId) {
          clearSession();
          return buildJsonRpcErrorResponse('Session client changed. Re-initialize.', null, 400);
        }
        // Grant stability only applies to an already-authenticated session; an
        // anonymous session upgrading in place legitimately gains its first
        // workspace snapshot below.
        const oldGrantIds = session.authCtx.grantedOrganizationIds ?? [];
        const freshGrantIds = freshCtx.grantedOrganizationIds ?? [];
        if (
          oldGrantIds.length !== freshGrantIds.length ||
          oldGrantIds.some((id, index) => id !== freshGrantIds[index])
        ) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Session workspace access changed. Re-initialize.',
            null,
            400
          );
        }
      }

      session.authCtx.isAuthenticated = true;
      session.authCtx.userId = freshCtx.userId;
      session.authCtx.clientId = freshCtx.clientId;
      session.authCtx.tokenType = freshCtx.tokenType;
      // `extractAuthContext` always yields a concrete scope array (real scopes
      // for token callers, the not-applicable sentinel for session/anonymous).
      // Assign it straight through — `hasRequiredMcpScope` fails closed on
      // null, so coercing to null would wrongly deny a valid refreshed session.
      session.authCtx.scopes = freshCtx.scopes;
      session.authCtx.grantedOrganizationIds = freshCtx.grantedOrganizationIds;
      session.authCtx.directSearchFederation = freshCtx.directSearchFederation;
      session.authCtx.allowCrossOrg = freshCtx.allowCrossOrg;
      session.authCtx.tokenOrganizationId = freshCtx.tokenOrganizationId;
      // Identity belongs to the MCP session, but worker-originated source
      // conversation is per request. The gateway may reuse the same upstream
      // MCP session across turns for the same user/agent, so keep the mutable
      // auth context current before tools read ToolContext.sourceContext.
      session.authCtx.sourceContext = freshCtx.sourceContext ?? null;
      session.authCtx.adminTools = freshCtx.adminTools ?? null;

      if (freshCtx.agentId && freshCtx.agentId !== session.authCtx.agentId) {
        clearSession();
        return buildJsonRpcErrorResponse('Session agent changed. Re-initialize.', null, 400);
      }

      if (!session.authCtx.scopedToOrg && freshCtx.organizationId !== session.authCtx.organizationId) {
        clearSession();
        return buildJsonRpcErrorResponse('Session workspace binding changed. Re-initialize.', null, 400);
      }
      restrictBoundIdentityWorkspaceAccess(session.authCtx);

      if (session.authCtx.scopedToOrg) {
        if (freshCtx.organizationId !== session.authCtx.organizationId) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Session organization changed. Re-initialize.',
            null,
            400
          );
        }
        // `freshCtx` (scoped) carries a null memberRole — extractAuthContext
        // never looks up membership — so resolve it before it reaches the
        // role-gated tools, mirroring the unscoped branch below.
        await hydrateScopedMemberRole(c.env, freshCtx);
        session.authCtx.memberRole = freshCtx.memberRole;
      } else if (session.authCtx.organizationId && freshCtx.userId) {
        session.authCtx.memberRole = await resolveMembershipRole(
          c.env,
          session.authCtx.organizationId,
          freshCtx.userId
        );
        if (!session.authCtx.memberRole) {
          clearSession();
          return buildJsonRpcErrorResponse(
            'Your organization access changed. Re-initialize the session.',
            null,
            400
          );
        }
      }
      session.authCtx.instructions = await buildSessionInstructions(session.authCtx);
    }

    await recordMcpClientActivity(c.env, session.authCtx, req);

    // `session.authCtx` may have been UPGRADED above (anonymous → authenticated,
    // or a fresh org/role), so the row written by the refresh at the top of this
    // branch is now stale — another replica recovering this session would use
    // the old binding. Persist the upgrade, but update-only: an upsert here
    // would re-INSERT a row deleted by a revoke that committed mid-request,
    // resurrecting exactly the session the refresh exists to catch.
    if (!(await refreshSessionState(sessionId, session.authCtx, session.lastAccessedAt))) {
      clearSession();
      return buildJsonRpcErrorResponse(
        'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
        null,
        404
      );
    }

    // Anonymous root /mcp session: any follow-up GET or tool call must upgrade to auth.
    if (!session.authCtx.organizationId && !session.authCtx.isAuthenticated) {
      const toolCall = req.method === 'POST' ? await readToolCall(req) : null;
      if (req.method === 'GET' || toolCall) {
        clearSession();
        return buildUnauthorizedResponse(
          req,
          req.method === 'GET'
            ? 'Authentication required for MCP stream access.'
            : 'Authentication required for tool calls.'
        );
      }
    }

    // Anonymous public-org session: public reads are allowed, non-public calls must upgrade.
    if (
      session.authCtx.organizationId &&
      !session.authCtx.isAuthenticated &&
      !session.authCtx.memberRole &&
      req.method === 'POST'
    ) {
      const toolCall = await readToolCall(req);
      if (toolCall && !isPublicReadable(toolCall.name, toolCall.args)) {
        clearSession();
        return buildUnauthorizedResponse(req, 'Authentication required for this tool.');
      }
    }

    return handleTransportRequest(session.transport, req);
  }

  // Stale session ID with non-initialize request → require a fresh initialize.
  if (sessionId && !sessions.has(sessionId) && req.method === 'POST') {
    try {
      const body = await req.clone().json();
      const messages = Array.isArray(body) ? body : [body];
      const isInitialize = messages.some((m: any) => m.method === 'initialize');
      if (!isInitialize) {
        // Recover ONLY from a persisted, server-issued session row — e.g. a
        // cross-replica hop or pod restart within the TTL, where `getSession`
        // proves the id was genuinely issued and is still valid. We deliberately
        // do NOT re-mint a session from request auth alone for an id with no
        // persisted record: that would accept (and persist a row under) any
        // caller-supplied session id. Per the MCP Streamable HTTP spec, an
        // unknown/expired session must instead yield 404 so the client starts a
        // fresh session via `initialize` with a new server-generated id.
        const recoveredAuthCtx = await recoverSessionAuthContext(c, sessionId);
        if (recoveredAuthCtx === RECOVERY_OAUTH_BEARER_REQUIRED) {
          return buildUnauthorizedResponse(
            req,
            'A valid OAuth bearer token is required on every authenticated MCP request.'
          );
        }
        if (recoveredAuthCtx) {
          const { transport, server } = createSessionTransport(
            c.env,
            recoveredAuthCtx,
            () => sessionId
          );
          await server.connect(transport);
          await initializeRecoveredSession(transport, sessionId, req.url);
          // Recovery may only refresh the row that authorized it. A revoke can
          // delete that row after recoverSessionAuthContext reads it; an upsert
          // here would resurrect the revoked session.
          if (!(await refreshSessionState(sessionId, recoveredAuthCtx))) {
            sessions.delete(sessionId);
            transport.close?.();
            return buildJsonRpcErrorResponse(
              'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
              null,
              404
            );
          }
          await recordMcpClientActivity(c.env, recoveredAuthCtx, req);
          return handleTransportRequest(transport, req);
        }

        await deletePersistedSession(sessionId);
        return buildJsonRpcErrorResponse(
          'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
          null,
          404
        );
      }
    } catch {
      // Body parse failure — fall through to create new session
    }
  }

  // New session (initialize request)
  if (req.method === 'POST') {
    const initialize = await readInitializeRequest(req);
    const authCtx = await resolveAuthWithInstructions(c, req);

    // Anonymous on the unscoped `/mcp` endpoint has no workspace context —
    // there's nothing meaningful to serve. Return 401 + WWW-Authenticate so
    // standards-compliant MCP clients (Claude Desktop, etc.) discover the
    // OAuth metadata at /.well-known/oauth-protected-resource and trigger the
    // auth flow. Public workspace browse remains available on /mcp/{slug}.
    if (!authCtx.isAuthenticated && !authCtx.scopedToOrg) {
      return buildUnauthorizedResponse(
        req,
        'Authentication required for the unscoped /mcp endpoint. OAuth via the resource metadata advertised in WWW-Authenticate, or connect to /mcp/{workspace-slug} for public workspace browse.'
      );
    }

    if (
      authCtx.isAuthenticated &&
      authCtx.userId &&
      authCtx.tokenType === 'pat' &&
      !authCtx.tokenOrganizationId
    ) {
      const reauthOrigin = resolvePublicOrigin(req.url);
      const remediation = `Reissue this PAT bound to a workspace with \`lobu token create --org <workspace>\` against ${reauthOrigin}.`;
      return buildJsonRpcErrorResponse(
        `This token has no organization binding and cannot connect to /mcp. ${remediation}`,
        initialize?.id ?? null,
        400
      );
    }

    const bindingError = await syncAgentBinding(authCtx);
    if (bindingError) {
      return buildJsonRpcErrorResponse(bindingError, initialize?.id ?? null, 400);
    }
    restrictBoundIdentityWorkspaceAccess(authCtx);
    // Resolve the caller's membership role for scoped `/mcp/{slug}` sessions
    // before the session is created/persisted — extractAuthContext leaves it
    // null, which would deny role-gated actions to a real owner/admin.
    await hydrateScopedMemberRole(c.env, authCtx);
    authCtx.instructions = await buildSessionInstructions(authCtx);
    await recordMcpClientActivity(c.env, authCtx, req, initialize);
    authCtx.supportsMcpApps = supportsMcpApps(initialize?.capabilities);
    authCtx.supportsAppSandboxDomain = supportsAppSandboxDomain(initialize?.capabilities);
    const { transport, server } = createSessionTransport(
      c.env,
      authCtx,
      () => randomUUID()
    );
    await server.connect(transport);
    const response = await handleTransportRequest(transport, req);
    await persistSessionState(transport.sessionId, authCtx);
    return response;
  }

  // GET without a live session (e.g. an SSE reconnect after the session aged
  // out). Mirror the POST stale-session path: 404 + the same actionable message
  // so spec-compliant clients re-initialize rather than treating it as fatal.
  // We don't delete any persisted row here — a within-TTL row stays recoverable
  // by a subsequent POST.
  if (req.method === 'GET') {
    return buildJsonRpcErrorResponse(
      'MCP session expired or not recognized. Start a new session by sending an initialize request — spec-compliant clients re-initialize automatically on 404.',
      null,
      404
    );
  }

  return new Response('Method not allowed', { status: 405 });
}
