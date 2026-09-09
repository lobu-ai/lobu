/**
 * Shared tool execution with access control.
 *
 * Used by both the MCP Streamable HTTP handler and the REST API proxy.
 */

import { randomUUID } from 'node:crypto';
import { CrossOrgAccessDenied, resolveCrossOrgToolContext } from '../sandbox/client-sdk';
import { verifiedAutomationSource } from '../automations/automation-source';
import { runWithActingAutomation } from '../utils/acting-automation-context';
import type { Context } from 'hono';
import { isToolError, retryWithBackoff, ToolError } from '@lobu/core';
import {
  getRequiredAccessLevel,
  hasRequiredMcpScope,
  isPublicReadable,
  SCOPE_CHECK_NOT_APPLICABLE,
  type ToolAccessLevel,
} from '../auth/tool-access';
import type { Env } from '../index';
import { recordMcpConversationActivity } from '../lobu/stores/mcp-client-conversations';
import { trackMCPToolCall } from '../sentry';
import { parseApplyId } from '../utils/apply-context';
import { assertDeploymentsNotPaused } from '../utils/deployment-pause';
import { ToolNotRegisteredError, ToolUserError } from '../utils/errors';
import { getConfiguredPublicOrigin } from '../utils/public-origin';
import { enforceRoleScopeAccess, requireWorkspaceContext } from './access-control';
import { recordToolInvocationAudit } from './audit';
import { getAccountContent } from './get_content';
import {
  getTool,
  isAuthorizationReadOnly,
  type AccountToolContext,
  type TokenType,
  type ToolContext,
  type ToolSourceContext,
} from './registry';

export interface AuthContext {
  organizationId: string | null;
  /**
   * Explicit `organization_id` from the OAuth/PAT record (null for ordinary
   * account OAuth and session/anonymous callers). Distinct from `organizationId`, which is the
   * *resolved* org for the request and may come from a URL slug on
   * `/mcp/{slug}` even when the token has no claim of its own.
   */
  tokenOrganizationId: string | null;
  userId: string | null;
  memberRole: string | null;
  agentId: string | null;
  /** Trusted internal reaction provenance. Never populated from request input. */
  actingAutomationId?: number | null;
  /** Trusted internal reaction run. Never populated from request input. */
  actingRunId?: number | null;
  requestedAgentId: string | null;
  sourceContext?: ToolSourceContext | null;
  isAuthenticated: boolean;
  clientId: string | null;
  scopes?: string[] | null;
  tokenType: TokenType;
  requestUrl: string;
  baseUrl: string;
  scopedToOrg: boolean;
  allowCrossOrg: boolean;
  /** Explicit OAuth workspace snapshot; null for non-OAuth identities. */
  grantedOrganizationIds: string[] | null;
  /** Bare OAuth MCP search uses its granted workspace set without an anchor. */
  directSearchFederation: boolean;
  /**
   * Persistent MCP session id (`mcp-session-id` header) when the call arrived
   * through an MCP transport session; null for REST-proxy and internal calls.
   * Audit rows carry it so a client's activity can be grouped per session.
   */
  mcpSessionId?: string | null;
  /** Whether this MCP session negotiated the standard Apps UI extension. */
  mcpAppsSupported?: boolean | null;
  /** Host-only capability from an MCP App `tools/call` request. Never persisted. */
  mcpAppApprovalCapability?: string | null;
  /** Host-only event-action capability from an MCP App `tools/call` request. */
  mcpAppEventActionCapability?: string | null;
  /** Host conversation correlation, separate from the transport session. */
  mcpConversationId?: string | null;
  instructions?: string;
  /** `x-lobu-apply-id` when the call belongs to a `lobu apply` run. */
  applyId?: string | null;
  /**
   * `x-lobu-rollback-of` when the run is a `lobu rollback` restoring the named
   * deployment. Lets a rollback proceed while promotions are paused — rolling
   * back further is the main thing an operator does while paused. Claimed by
   * the client, VERIFIED server-side against a real deployment in this org
   * (see `assertDeploymentsNotPaused`); never trusted on shape alone.
   */
  rollbackOf?: string | null;
  /**
   * Per-turn LIMIT on which tools may execute admin-tier actions. Carried on
   * the worker token (see
   * WorkerTokenData.adminTools); empty/null for everyone else (no limit —
   * role × scope decide). Non-admin-tier actions are unaffected.
   */
  adminTools?: string[] | null;
  /**
   * Signed side-effect mode for this run; 'capture' is an eval replay. Read
   * by sdk_run to force the SDK's per-method capture path.
   */
  executionMode?: 'live' | 'capture' | null;
}

/**
 * A resolved TOOL-level failure — the tool could not do its job — which is not
 * thrown, so the MCP boundary must mark it with `isError`. These carry a
 * top-level `error` STRING (query_sql's `{ rows: [], error }`, an action tool's
 * `{ error }`).
 *
 * Deliberately NOT a script failure. `run_sdk` / `query_sdk` execute arbitrary
 * caller code and report the outcome as DATA: `SdkScriptResultSchema` makes
 * `success` a required field and documents `error` as concise script-failure
 * information (name/message/code/retryable). When a script throws, the tool
 * itself ran perfectly — it executed the code and returned a faithful report.
 * Marking that `isError` conflates "the sandbox failed to run your code" with
 * "your code ran and threw", which callers must distinguish: `mcpToolsCall`
 * throws on `isError`, so it would stop tests/agents from ever reading the
 * documented `success: false` payload, and `interaction-bridge` would relabel a
 * legitimate script throw as "Tool error:" in agent-visible output.
 */
export function isSoftErrorResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as { error?: unknown };
  return typeof candidate.error === 'string' && candidate.error.length > 0;
}

/** REST route that reads the caller's own MCP audit rows without a workspace. */
const ACCOUNT_CONTENT_PATH = '/api/me/read_knowledge';

export function extractAuthContext(c: Context<{ Bindings: Env }>): AuthContext {
  const mcpAuthInfo = c.var.mcpAuthInfo ?? null;
  const tokenType: TokenType =
    mcpAuthInfo?.tokenType === 'pat' ? 'pat'
    : mcpAuthInfo?.tokenType === 'access_token' ? 'oauth'
    : c.var.session?.userId ? 'session'
    : 'anonymous';
  const scopedToOrg = !!(c.req.param('orgSlug') || c.var.subdomainOrg);
  const requestPath = new URL(c.req.url).pathname;
  const tokenOrganizationId = mcpAuthInfo?.organizationId ?? null;
  const grantedOrganizationIds =
    tokenType === 'oauth'
      ? (mcpAuthInfo?.grantedOrganizationIds ?? [])
      : null;

  return {
    organizationId: requestPath === ACCOUNT_CONTENT_PATH ? null : c.var.organizationId,
    tokenOrganizationId,
    userId: mcpAuthInfo?.userId || c.var.session?.userId || null,
    memberRole: c.var.memberRole,
    agentId: mcpAuthInfo?.agentId ?? null,
    requestedAgentId: mcpAuthInfo?.agentId ?? null,
    sourceContext: mcpAuthInfo?.sourceContext ?? null,
    isAuthenticated: c.var.mcpIsAuthenticated || false,
    clientId: mcpAuthInfo?.clientId ?? null,
    // Token callers (oauth/pat) carry real MCP scopes — pass them straight
    // through so `hasRequiredMcpScope` gates on the actual grant. Session and
    // anonymous callers have no scope dimension (they're gated by member role
    // + public-readability upstream), so pass the explicit not-applicable
    // sentinel rather than `null`/`undefined`, which now FAILS CLOSED in
    // `hasRequiredMcpScope`. A token minted without scopes presents `[]`,
    // which still denies — only the sentinel bypasses the scope check.
    scopes:
      mcpAuthInfo != null
        ? (mcpAuthInfo.scopes ?? [])
        : [...SCOPE_CHECK_NOT_APPLICABLE],
    tokenType,
    requestUrl: c.req.url,
    baseUrl: getConfiguredPublicOrigin() ?? '',
    scopedToOrg,
    allowCrossOrg:
      tokenType === 'oauth' &&
      requestPath === '/mcp' && !scopedToOrg && !mcpAuthInfo?.scopes?.includes('device_worker:run'),
    grantedOrganizationIds,
    directSearchFederation:
      tokenType === 'oauth' && requestPath === '/mcp' && !scopedToOrg && !mcpAuthInfo?.scopes?.includes('device_worker:run'),
    applyId: parseApplyId(c.req.header('x-lobu-apply-id')),
    rollbackOf: parseApplyId(c.req.header('x-lobu-rollback-of')),
    // Admin-tool LIMIT: only the verified worker token's per-turn allowlist
    // (an admin-tools run) carries this. External
    // `mcp:admin` callers need no grant — every tool is reachable uniformly
    // and role × scope decide, so the old two-tool external allowlist is gone.
    adminTools: mcpAuthInfo?.adminTools ?? null,
    executionMode: mcpAuthInfo?.executionMode ?? null,
  };
}

/**
 * Check access control for a tool call. Throws on denial.
 */
function isAccountContentRead(toolName: string, authCtx: AuthContext): boolean {
  return toolName === 'read_knowledge' && new URL(authCtx.requestUrl).pathname === ACCOUNT_CONTENT_PATH;
}

export function checkToolAccess(
  toolName: string,
  args: unknown,
  authCtx: AuthContext
): ToolAccessLevel {
  const tool = getTool(toolName);
  if (!tool) throw new ToolNotRegisteredError(toolName);
  const accountScope = tool.scope === 'account' || isAccountContentRead(toolName, authCtx);
  if (!accountScope && !authCtx.organizationId) {
    throw new ToolUserError(
      'This connection has no workspace binding. Pass the tool’s explicit workspace target (for example org_slug), or run it through await client.org(target) in query_sdk/run_sdk.',
      400,
      'VALIDATION'
    );
  }
  if (accountScope && !authCtx.organizationId && (!authCtx.isAuthenticated || !authCtx.userId)) {
    throw new Error('Authentication required.');
  }

  const isReadOnly = isAuthorizationReadOnly(tool);
  const role = authCtx.memberRole;
  const requiredAccess = getRequiredAccessLevel(toolName, args, isReadOnly);

  // Admin-tools run: the per-turn allowlist is a LIMIT on which
  // tools may exercise ADMIN-tier actions. Read/write-tier actions follow the
  // uniform role × scope model like every other caller.
  const adminAllowlist = authCtx.adminTools;
  if (
    requiredAccess === 'admin' &&
    adminAllowlist &&
    adminAllowlist.length > 0 &&
    !adminAllowlist.includes(toolName)
  ) {
    throw new Error(
      `This agent run may not perform admin actions with ${toolName}. Allowed admin tools: ${adminAllowlist.join(', ')}.`
    );
  }

  if (accountScope && (authCtx.allowCrossOrg || !authCtx.organizationId || toolName === 'list_organizations')) {
    if (!authCtx.isAuthenticated || !authCtx.userId) throw new Error('Authentication required.');
    if (!hasRequiredMcpScope(requiredAccess, authCtx.scopes)) {
      throw new Error(`This MCP session does not include ${requiredAccess} access. Reconnect with the required scope.`);
    }
    return requiredAccess;
  }

  if (!role && !isPublicReadable(toolName, args)) {
    if (authCtx.userId) {
      throw new Error(
        'This public workspace is read-only for your account. Join the workspace to unlock write access.'
      );
    }
    throw new Error(
      'This public workspace is read-only for anonymous access. Sign in with an OAuth client that has write access.'
    );
  }

  // No `writeRole` message: missing-membership writes are already rejected by
  // the public-readability branch above, matching the historical semantics.
  enforceRoleScopeAccess(requiredAccess, role, authCtx.scopes, {
    adminRole:
      'This action requires admin or owner access. Ask an organization owner to grant elevated access.',
    readScope:
      'This MCP session does not include read access. Reconnect with read access for this workspace.',
    writeScope:
      'This MCP session is read-only. Reconnect with write-scoped OAuth, or ask an owner to add you.',
    adminScope:
      'This MCP session does not include admin access. Reconnect with admin access after an owner grants the role.',
  });
  return requiredAccess;
}

/**
 * Execute a tool by name with access control and Sentry tracking.
 * Returns the raw tool result (caller decides formatting).
 *
 * Arg validation does NOT live here: every registered handler is wrapped
 * with `withValidatedArgs` at its definition (`tools/validate-args.ts`), so
 * direct REST calls and the sandbox SDK namespaces get the same coerce +
 * validate automation as this path (lobu#1137).
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  authCtx: AuthContext
): Promise<unknown> {
  const startTime = Date.now();

  // Per-invocation correlation id (lobu#2051 Item 2). Distinct from the
  // background-run `run_id` (a bigint on the runs table) — this identifies a
  // single tool call so a failure can be traced across logs/audit/response.
  const callId = randomUUID();

  // Snapshot the caller's own context BEFORE any requested target is resolved,
  // so a rejected invocation is audited against the workspace this connection
  // was already bound to (null on bare account MCP) and never against the
  // requested target, which may be unauthorized or nonexistent.
  let toolContext: AccountToolContext = toAccountToolContext(authCtx);
  try {
    const field = getTool(toolName)?.workspaceTarget;
    const target = field ? args[field] : undefined;
    if (target !== undefined) {
      if (typeof target !== 'string' || !target.trim()) {
        throw new ToolUserError(
          `${field} must be a workspace slug or id.`,
          400,
          'VALIDATION'
        );
      }
      const workspace = await resolveCrossOrgToolContext(
        target,
        toAccountToolContext(authCtx)
      ).catch((error: unknown) => {
        // Denial arrives as the SDK's typed error, which only the sandbox
        // translates; at this plain tool boundary it would surface as an
        // uncoded 400. Re-raise so REST and MCP agree on 403 plus a correlated
        // code — the same translation `mcp_app.ts` documents for its own
        // approval-workspace resolution.
        if (error instanceof CrossOrgAccessDenied) {
          throw new ToolUserError(error.message, 403, 'PERMISSION');
        }
        throw error;
      });
      authCtx = { ...authCtx, organizationId: workspace.organizationId, memberRole: workspace.memberRole };
    }
    const requiredAccess = checkToolAccess(toolName, args, authCtx);
    toolContext = toAccountToolContext(authCtx);

    // Promotions pause, enforced where config is actually mutated. `lobu apply`
    // writes through these tools, so this is the chokepoint that binds every
    // caller — including a CI job posting straight at the API with a PAT, which
    // the CLI-side check never could. Read-tier calls and non-apply traffic pass
    // through untouched, which also covers the org-agnostic tools below (they
    // are read-tier by construction); see `assertDeploymentsNotPaused`.
    await assertDeploymentsNotPaused({
      organizationId: authCtx.organizationId,
      applyId: authCtx.applyId ?? null,
      rollbackOf: authCtx.rollbackOf ?? null,
      isReadOnly: requiredAccess === 'read',
    });

    const tool = getTool(toolName)!;

    // Attribute every audit row this handler writes to the Automation driving the
    // call. Resolution mirrors the one gated writes already use
    // (`manage_entity.ts`): the server-set reaction identity first, then the
    // caller-declared `automation_source` for an agent or device running a
    // window. Setting it once here rather than at each audit writer is what keeps
    // provenance from drifting as writers are added.
    // A declared source is caller input. Verify it against this org before it can
    // reach `events.automation_id` — an unowned id would misattribute the audit
    // row (and inherit that Automation's causal chain), and a nonexistent one
    // would fail the FK and DROP the audit row entirely, since audit writes are
    // fire-and-forget. Same rule `notify.ts` already applies to this field.
    // Skipped whenever a trusted reaction identity is present, and skipped
    // entirely when nothing was declared, so ordinary tool calls pay nothing.
    const declaredSource =
      toolContext.actingAutomationId != null || !toolContext.organizationId
        ? null
        : await verifiedAutomationSource(
            declaredAutomationSource(args),
            toolContext.organizationId
          );
    const runHandler = () =>
      runWithActingAutomation(
        {
          automationId:
            toolContext.actingAutomationId ?? declaredSource?.automationId,
          // The run is the causal identity for both trusted reaction sessions and
          // verified declarations from agent/device lanes.
          runId: toolContext.actingRunId ?? declaredSource?.runId ?? null,
        },
        () =>
          trackMCPToolCall(toolName, args, () =>
            isAccountContentRead(toolName, authCtx)
              ? getAccountContent(args, env, authCtx)
              : tool.scope === 'account'
              ? tool.handler(args, env, toolContext)
              : tool.handler(args, env, requireWorkspaceContext(toolContext))
          )
      );
    // Auto-retry (lobu#2051 Item 2): only transient thrown ToolErrors, and only
    // for read/test tools on the allowlist. Mutations and run_sdk are never
    // retried here — re-running them could double-write. Resolved failures from
    // query_sql and query_sdk never throw, so their retryability metadata is
    // advisory for the agent.
    const result = RETRYABLE_TOOLS.has(toolName)
      ? await retryWithBackoff(runHandler, {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 4000,
          jitter: 'full',
          shouldRetry: (err) => isRetryableToolError(err),
        })
      : await runHandler();
    await recordToolInvocationAudit({
      toolName,
      args,
      result,
      durationMs: Date.now() - startTime,
      ctx: toolContext,
    });
    await recordMcpConversationActivity({
      ctx: toolContext,
      toolName,
      failed: isSoftErrorResult(result),
    });
    return result;
  } catch (error) {
    // Stamp the correlation id onto typed errors so the response boundaries can
    // surface `call_id` alongside the structured `code`/`retryable`.
    if (error instanceof ToolError || error instanceof ToolUserError) {
      error.callId = callId;
    }
    await recordToolInvocationAudit({
      toolName,
      args,
      error,
      durationMs: Date.now() - startTime,
      ctx: toolContext,
    });
    await recordMcpConversationActivity({
      ctx: toolContext,
      toolName,
      failed: true,
    });
    throw error;
  }
}

/**
 * Tools safe to auto-retry on a transient failure (lobu#2051 Item 2): read-only,
 * with no side effects. Mutations and `run_sdk` (arbitrary user script) are
 * excluded — retrying them risks a double-write.
 *
 * `manage_connections.test` is deliberately NOT here: it's a *sub-action* of a
 * tool that also mutates, and putting the whole tool on the allowlist would
 * auto-retry those mutations too. `handleTest` never throws (it returns a soft
 * `{status,message,error_code}` result), so it gains nothing from auto-retry
 * anyway — its `retryable` flag is advisory for the agent.
 */
const RETRYABLE_TOOLS = new Set(['query_sql', 'query_sdk']);

/**
 * The `automation_source` an agent declared on this call.
 *
 * Self-declared and therefore advisory — an agent that omits it is attributed
 * to nothing, exactly as today. The reaction identity checked first is
 * server-set and cannot be forged, so the non-forgeable source always wins.
 *
 * The run travels with the Automation id because it carries causal ancestry.
 */
function declaredAutomationSource(
  args: Record<string, unknown>
): { automationId: number; runId: number } | null {
  const source = args.automation_source;
  if (!source || typeof source !== 'object') return null;
  const positiveInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  const automationId = positiveInteger(
    (source as { automation_id?: unknown }).automation_id
  );
  if (automationId == null) return null;
  const runId = positiveInteger((source as { run_id?: unknown }).run_id);
  if (runId == null) return null;
  return {
    automationId,
    runId,
  };
}

/** True when a thrown value is a retryable typed error. */
function isRetryableToolError(err: Error): boolean {
  if (isToolError(err)) return err.retryable;
  if (err instanceof ToolUserError) return err.retryable;
  return false;
}

/**
 * Build a ToolContext from an AuthContext. Requires organizationId to be set.
 */
export function toToolContext(authCtx: AuthContext): ToolContext {
  return requireWorkspaceContext(toAccountToolContext(authCtx));
}

export function toAccountToolContext(authCtx: AuthContext): AccountToolContext {
  const identityBound = Boolean(authCtx.agentId || authCtx.actingAutomationId);
  return {
    organizationId: authCtx.organizationId,
    userId: authCtx.userId,
    memberRole: authCtx.memberRole,
    agentId: authCtx.agentId,
    actingAutomationId: authCtx.actingAutomationId ?? null,
    actingRunId: authCtx.actingRunId ?? null,
    sourceContext: authCtx.sourceContext ?? null,
    isAuthenticated: authCtx.isAuthenticated,
    clientId: authCtx.clientId,
    scopes: authCtx.scopes,
    tokenType: authCtx.tokenType,
    scopedToOrg: authCtx.scopedToOrg,
    allowCrossOrg: identityBound ? false : authCtx.allowCrossOrg,
    grantedOrganizationIds: identityBound
      ? authCtx.organizationId ? [authCtx.organizationId] : []
      : authCtx.grantedOrganizationIds,
    directSearchFederation: identityBound ? false : authCtx.directSearchFederation,
    requestUrl: authCtx.requestUrl,
    baseUrl: authCtx.baseUrl,
    applyId: authCtx.applyId ?? null,
    mcpSessionId: authCtx.mcpSessionId ?? null,
    mcpAppsSupported: authCtx.mcpAppsSupported ?? false,
    mcpAppApprovalCapability: authCtx.mcpAppApprovalCapability ?? null,
    mcpAppEventActionCapability: authCtx.mcpAppEventActionCapability ?? null,
    mcpConversationId: authCtx.mcpConversationId ?? null,
    executionMode: authCtx.executionMode ?? null,
  };
}
