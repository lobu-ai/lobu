import { randomUUID } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type AgentConfigStore,
  createLogger,
  createRootSpan,
  type DeviceExecutionTarget,
  generateWorkerToken,
  type NetworkConfig,
  normalizeDomainPatterns,
  parseBangBashCommand,
  verifyWorkerToken,
} from "@lobu/core";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bindRequestAbortToStream } from "../../../events/sse-abort-bridge.js";
import { isAdminOrOwnerRole } from "../../../tools/access-control.js";
import {
  defineRoute,
  getValidated,
  type RouteSpec,
} from "../shared/define-route.js";
import { getDb, parsePgTextArray } from "../../../db/client.js";
import {
  getMembershipRole,
  getOrgBySlug,
} from "../../../workspace/multi-tenant.js";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import { listPendingToolsForConversation } from "../../auth/mcp/pending-tool-store.js";
import { getRevokedTokenStore } from "../../auth/revoked-token-store.js";
import { AUTOMATION_RUN_SOURCE } from "../../automation-run-session.js";
import {
  createApiAuthMiddleware,
  TOKEN_EXPIRATION_MS,
} from "../../auth/api-auth-middleware.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import type { AgentSettingsStore } from "../../auth/settings/agent-settings-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import {
  buildAttachmentTranscriptText,
  ingestInboundAttachments,
} from "../../connections/message-handler-bridge.js";
import type { ArtifactStore } from "../../files/artifact-store.js";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer.js";
import type { PlatformRegistry } from "../../platform.js";
import {
  parseAutomationRunConversationId,
  verifyAutomationRunIntent,
} from "../../permissions/automation-run-intent.js";
import { buildApiConversationId } from "../../services/api-conversation-id.js";
import { buildAutomationRunWorkerAccess } from "../../services/run-worker-access.js";
import { resolveAgentOptions } from "../../services/platform-helpers.js";
import type { SseManager } from "../../services/sse-manager.js";
import { readSnapshotJsonl } from "../../services/transcript-snapshot.js";
import type { ISessionManager, ThreadSession } from "../../session.js";
import {
  resolveSettingsLookupUserId,
  verifyOwnedAgentAccess,
} from "../shared/agent-ownership.js";
import {
  authorizeOrgAgentMemberInProvenOrg,
  isRestrictedOrgAgentMember,
} from "../shared/org-agent-access.js";
import { errorResponse } from "../shared/helpers.js";
import { errorResponses } from "../shared/openapi-responses.js";
import { verifySettingsSessionOrToken } from "./settings-auth.js";
import {
  formatActivityAttentionBlock,
  listOrgActivity,
} from "../../../tools/admin/manage_operations/activity-feed.js";

const logger = createLogger("agent-api");

/**
 * What one request is allowed to do with one agent.
 *
 * `organizationId` is the tenant the agent was authorized under (resolved from
 * `agent_users` for an owner, from the request's workspace scope for a
 * member) — never the caller's ambient default org.
 *
 * `kind` is the authorization route, and it gates what the grant may reach:
 * `"membership"` is a cookie-only human authorized through the proven
 * workspace rather than agent ownership (token callers never enter that
 * branch), and a member without org oversight is confined to conversations
 * they created themselves — see `isRestrictedOrgAgentMember`.
 */
type AgentAccessGrant =
  | {
      kind: "ownership";
      organizationId?: string;
      callerUserId?: string;
    }
  | {
      kind: "membership";
      organizationId: string;
      callerUserId: string;
      memberRole: string;
    };

// =============================================================================
// Constants
// =============================================================================

const MAX_CONNECTIONS_PER_AGENT = 5;
const MAX_TOTAL_CONNECTIONS = 1000;

// =============================================================================
// TypeBox Schemas
// =============================================================================

const NetworkConfigSchema = Type.Object({
  allowedDomains: Type.Optional(Type.Array(Type.String())),
  deniedDomains: Type.Optional(Type.Array(Type.String())),
});

const NixConfigSchema = Type.Object({
  flakeUrl: Type.Optional(Type.String()),
  packages: Type.Optional(Type.Array(Type.String())),
});

const AutomationRunIntentSchema = Type.Object({
  kind: Type.Literal("automation_run"),
  runId: Type.Integer({ minimum: 1 }),
  automationId: Type.Integer({ minimum: 1 }),
});

const DeviceExecutionTargetSchema = Type.Object(
  {
    kind: Type.Literal("device"),
    deviceWorkerId: Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    }),
    agentKind: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
const SNAPSHOT_HEADER_CHARS = 8192;

function executionTargetFromSnapshot(
  snapshot: string | null,
): DeviceExecutionTarget | undefined {
  // Placement is in the leading session record. The caller only fetches this
  // prefix, so parsing never materializes the whole transcript.
  const header = snapshot?.split("\n").find((line) => line.trim());
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(header) as { executionTarget?: unknown };
    return Value.Check(DeviceExecutionTargetSchema, parsed.executionTarget)
      ? parsed.executionTarget
      : undefined;
  } catch {
    return undefined;
  }
}

const CreateAgentRequestSchema = Type.Object({
  provider: Type.Optional(Type.Literal("claude", { default: "claude" })),
  model: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String({ minLength: 1 })),
  userId: Type.Optional(Type.String({ minLength: 1 })),
  thread: Type.Optional(Type.String()),
  forceNew: Type.Optional(Type.Boolean()),
  dryRun: Type.Optional(Type.Boolean()),
  intent: Type.Optional(AutomationRunIntentSchema),
  executionTarget: Type.Optional(DeviceExecutionTargetSchema),
  networkConfig: Type.Optional(NetworkConfigSchema),
  nix: Type.Optional(NixConfigSchema),
});

const CreateAgentResponseSchema = Type.Object({
  success: Type.Boolean(),
  agentId: Type.String(),
  token: Type.String(),
  expiresAt: Type.Number(),
  sseUrl: Type.String(),
  messagesUrl: Type.String(),
  executionTarget: Type.Optional(DeviceExecutionTargetSchema),
});

const SlackRoutingInfoSchema = Type.Object({
  channel: Type.String({ description: "Slack channel ID" }),
  thread: Type.Optional(
    Type.String({ description: "Thread timestamp for replies" }),
  ),
  team: Type.Optional(Type.String({ description: "Slack team ID" })),
});

// `.passthrough()` → additionalProperties: true (senders attach extra routing
// fields the handler forwards untouched).
const SendMessageRequestSchema = Type.Object(
  {
    content: Type.Optional(Type.String({ description: "Message content" })),
    message: Type.Optional(
      Type.String({ description: "Message content (alias for content)" }),
    ),
    messageId: Type.Optional(Type.String()),
    model: Type.Optional(
      Type.String({
        description:
          'Optional per-message model override (a `provider/model` ref or "auto"). ' +
          "Wins over the agent/org default. Used by Automation dispatch.",
      }),
    ),
    platform: Type.Optional(
      Type.String({ description: "Target platform (api, slack, telegram)" }),
    ),
    slack: Type.Optional(
      Type.Composite([SlackRoutingInfoSchema], {
        description:
          "Slack-specific routing info (required when platform=slack)",
      }),
    ),
  },
  { additionalProperties: true },
);

const SendMessageResponseSchema = Type.Object({
  success: Type.Boolean(),
  messageId: Type.String(),
  agentId: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
  eventsUrl: Type.Optional(Type.String()),
  queued: Type.Boolean(),
  traceparent: Type.Optional(Type.String()),
});

const AgentStatusResponseSchema = Type.Object({
  success: Type.Boolean(),
  agent: Type.Object({
    agentId: Type.String(),
    userId: Type.String(),
    status: Type.String(),
    createdAt: Type.Number(),
    lastActivity: Type.Number(),
    hasActiveConnection: Type.Boolean(),
  }),
});

const ErrorResponseSchema = Type.Object({
  success: Type.Boolean(),
  error: Type.String(),
  details: Type.Optional(Type.String()),
});

const SuccessResponseSchema = Type.Object({
  success: Type.Boolean(),
  message: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
});

// Path parameters
const AgentIdParamSchema = Type.Object({
  agentId: Type.String(),
});

// =============================================================================
// Validation Helpers
// =============================================================================

// Validators below short-circuit on the first failure and the public API
// surfaces only that message as the flat `error` string — so each returns
// `string | null` (message, or null when the value is valid).

function validateDomainPattern(pattern: string): string | null {
  if (!pattern || typeof pattern !== "string") {
    return "Domain pattern must be a non-empty string";
  }
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed === "*") {
    return "Bare wildcard '*' is not allowed";
  }
  if (trimmed.includes("://")) {
    return `Domain pattern cannot contain protocol: ${pattern}`;
  }
  if (trimmed.includes("/")) {
    return `Domain pattern cannot contain path: ${pattern}`;
  }
  if (trimmed.includes(":") && !trimmed.includes("[")) {
    return `Domain pattern cannot contain port: ${pattern}`;
  }
  if (trimmed.startsWith("*.") || trimmed.startsWith(".")) {
    const domain = trimmed.startsWith("*.")
      ? trimmed.substring(2)
      : trimmed.substring(1);
    if (!domain.includes(".")) {
      return `Wildcard pattern too broad: ${pattern}`;
    }
  } else if (!trimmed.includes(".")) {
    return `Invalid domain pattern: ${pattern}`;
  }
  return null;
}

function validateNetworkConfig(config: NetworkConfig): string | null {
  for (const domains of [config.allowedDomains, config.deniedDomains]) {
    if (!domains) continue;
    for (const domain of domains) {
      const error = validateDomainPattern(domain!);
      if (error) return error;
    }
  }
  return null;
}

function normalizeNetworkConfig(config: NetworkConfig): NetworkConfig {
  return {
    allowedDomains: normalizeDomainPatterns(config.allowedDomains),
    deniedDomains: normalizeDomainPatterns(config.deniedDomains),
  };
}

// =============================================================================
// OpenAPI Route Definitions
// =============================================================================

const createAgentRoute: RouteSpec = {
  method: "post",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "Create a new agent",
  bearerAuth: true,
  description:
    "Creates a new agent session and returns authentication credentials",
  request: { body: CreateAgentRequestSchema },
  responses: {
    201: { description: "Agent created", schema: CreateAgentResponseSchema },
    ...errorResponses(ErrorResponseSchema, {
      400: "Invalid request",
      401: "Unauthorized",
      // Unverified `automation_run` intent, and the cross-tenant session-resume
      // refusal further down.
      403: "Forbidden",
    }),
  },
};

const getAgentRoute: RouteSpec = {
  method: "get",
  path: "/api/v1/agents/{agentId}",
  tags: ["Agents"],
  summary: "Get agent status",
  bearerAuth: true,
  request: { params: AgentIdParamSchema },
  responses: {
    200: { description: "Agent status", schema: AgentStatusResponseSchema },
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      404: "Not found",
    }),
  },
};

const deleteAgentRoute: RouteSpec = {
  method: "delete",
  path: "/api/v1/agents/{agentId}",
  tags: ["Agents"],
  // Deletes the SESSION only (the path param is a sessionKey); the agent row
  // itself persists — it's owned by the org or the user's personal org.
  summary: "Delete an agent session",
  bearerAuth: true,
  request: { params: AgentIdParamSchema },
  responses: {
    200: { description: "Agent session deleted", schema: SuccessResponseSchema },
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      404: "Not found",
    }),
  },
};

const getAgentEventsRoute: RouteSpec = {
  method: "get",
  path: "/api/v1/agents/{agentId}/events",
  tags: ["Messages"],
  summary: "Subscribe to agent events (SSE)",
  description: "Server-Sent Events stream for real-time agent updates",
  bearerAuth: true,
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "SSE stream",
      schema: Type.String(),
      mediaType: "text/event-stream",
    },
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      429: "Too many connections",
    }),
  },
};

const sendMessageRoute: RouteSpec = {
  method: "post",
  path: "/api/v1/agents/{agentId}/messages",
  tags: ["Messages"],
  summary: "Send a message to the agent",
  description:
    "Send a message to an agent. Supports JSON body or multipart form data for file uploads. " +
    "When platform is specified, the message is routed through the platform adapter.",
  bearerAuth: true,
  request: {
    params: AgentIdParamSchema,
    body: SendMessageRequestSchema,
  },
  // The handler accepts multipart form-data OR JSON and branches on
  // Content-Type, so it parses+validates the body itself (see the flag doc).
  skipBodyValidation: true,
  responses: {
    200: { description: "Message queued", schema: SendMessageResponseSchema },
    ...errorResponses(ErrorResponseSchema, {
      400: "Invalid request",
      401: "Unauthorized",
      403: "Forbidden - worker tokens cannot route to platforms",
      404: "Agent not found",
    }),
  },
};

// =============================================================================
// Create OpenAPI Hono App
// =============================================================================

interface AgentApiConfig {
  queueProducer: QueueProducer;
  sessionManager: ISessionManager;
  sseManager: SseManager;
  publicGatewayUrl: string;
  artifactStore: ArtifactStore;
  externalAuthClient?: ExternalAuthClient;
  agentSettingsStore?: AgentSettingsStore;
  agentConfigStore?: Pick<
    AgentConfigStore,
    "getSettings" | "listAgents" | "getMetadata"
  >;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentMetadataStore, "getMetadata">;
  platformRegistry?: PlatformRegistry;
  approveToolCall?: (
    requestId: string,
    decision: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export function createAgentApi(config: AgentApiConfig): Hono {
  const {
    queueProducer,
    externalAuthClient,
    agentSettingsStore,
    agentConfigStore,
    userAgentsStore,
    agentMetadataStore,
    platformRegistry,
  } = config;
  const sessMgr = config.sessionManager;
  const sseManager = config.sseManager;
  const pubUrl = config.publicGatewayUrl;
  const artifactStore = config.artifactStore;
  const app = new Hono();

  // Unified auth middleware for all agent API routes
  app.use(
    "/api/v1/agents/*",
    createApiAuthMiddleware({
      externalAuthClient,
      allowSettingsSession: true,
      // The embedded panel opens the SSE stream with EventSource (no
      // Authorization header), authenticating via a short-lived ?token= ticket.
      // Scope that query-token path to the SSE route only; other GETs under the
      // agent API still require the normal cookie/header auth path.
      allowSettingsQueryToken: (c) =>
        /^\/api\/v1\/agents\/[^/]+\/events$/.test(c.req.path),
    })
  );

  // =============================================================================
  // Ownership Verification
  // =============================================================================

  // Accept either an AgentMetadataStore or an AgentConfigStore exposing
  // getMetadata for ownership resolution. When both are provided, try the
  // metadata store first (in-memory layer) and fall through to the config
  // store (Postgres, authoritative) — needed in embedded mode where agent
  // rows live in Postgres but the in-memory layer is not hydrated.
  const ownershipMetadataStore:
    | { getMetadata: AgentMetadataStore["getMetadata"] }
    | undefined =
    agentMetadataStore && agentConfigStore
      ? {
          async getMetadata(agentId) {
            const fromCache = await agentMetadataStore.getMetadata(agentId);
            if (fromCache) return fromCache;
            return agentConfigStore.getMetadata(agentId);
          },
        }
      : (agentMetadataStore ?? agentConfigStore);

  const ownershipAccessConfig = {
    userAgentsStore,
    agentMetadataStore: ownershipMetadataStore,
  } as const;

  function tokenFromHeader(c: Context): string | null {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7);
    return token.length > 0 ? token : null;
  }

  /**
   * Authorize access to an agent: per-user ownership first, then org
   * membership for a human web-session caller (`use`, not `manage`). Workers
   * (a worker IS its own agent) always take the ownership path. Returns a
   * denial Response, or the resolved `AgentAccessGrant`.
   */
  async function authorizeAgentAccess(
    c: Context,
    agentId: string,
    sessionForTenantCheck?: {
      organizationId?: string;
      /**
       * Present only when the value IS an existing session row (every
       * ThreadSession has one). The create route passes a bare
       * `{ organizationId }` workspace scope instead, and must not be read as
       * a session — there is no session to be a member of yet.
       */
      conversationId?: string;
      createdByUserId?: string;
    } | null
  ): Promise<Response | AgentAccessGrant> {
    const owned = await resolveAgentAccess(c, agentId, sessionForTenantCheck);
    if (owned instanceof Response) return owned;

    // Own-conversation restriction for the member path. A member authorized by
    // org membership may USE the agent, which does not extend to reading
    // another member's conversation: these routes take a sessionKey, so
    // without this any member could attach to a colleague's SSE stream, send
    // messages into their thread or delete their session. Org owner/admins keep
    // oversight, and the ownership path is untouched. `createdByUserId` is
    // stamped at create time for every human caller; a session without one
    // predates that (owner-created, since members could not create any before
    // this change) and stays member-inaccessible.
    if (
      owned.kind === "membership" &&
      isRestrictedOrgAgentMember(owned.memberRole) &&
      sessionForTenantCheck?.conversationId
    ) {
      if (sessionForTenantCheck.createdByUserId !== owned.callerUserId) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
    }
    return owned;
  }

  /**
   * Verify that the caller is authorized to act on `resolvedAgentId`.
   *
   * The agent API middleware accepts three auth methods (worker token,
   * external OAuth, settings session). Each needs its own ownership rule:
   *
   *   - worker token         → scoped to its own agentId
   *   - settings session     → verifyOwnedAgentAccess (handles admin bypass,
   *                            agent-scoped sessions, and UserAgentsStore
   *                            / AgentMetadataStore lookups), then
   *                            org membership in the proven workspace
   *   - external OAuth       → treated as an external-platform identity and
   *                            run through verifyOwnedAgentAccess
   *
   * Returns a Response when the caller is not authorized (the handler should
   * early-return it). On success returns the `AgentAccessGrant` naming the org
   * the agent was authorized under — from `agent_users` on the ownership path,
   * from the proven workspace on the membership path, NEVER the caller's
   * ambient org-context — so the handler can stamp the worker token and session
   * with the agent's real tenant. On the ownership path `organizationId` may be
   * undefined for auth methods that resolve none (worker token / admin).
   */
  async function resolveAgentAccess(
    c: Context,
    resolvedAgentId: string,
    sessionForTenantCheck?: { organizationId?: string } | null
  ): Promise<Response | AgentAccessGrant> {
    const deny = () =>
      c.json({ success: false, error: "Forbidden" }, 403) as Response;

    const bearer = tokenFromHeader(c);

    // The caller's AUTHORITATIVE org, if the auth method bound one:
    //   - `authContext.organizationId` is set only by token auth (worker
    //     token payload / external-OAuth userinfo).
    //   - For PAT auth, `createLobuAuthBridge` sets `c.get("organizationId")`
    //     from the PAT's pinned org (or a membership-verified `x-lobu-org`),
    //     and a PAT always carries a Bearer token — so gate the ambient read
    //     on `bearer` to exclude the cookie path, whose `c.get("organizationId")`
    //     is just the user's DEFAULT org (NOT authoritative for this agent).
    // Undefined for the settings-session COOKIE path (no bearer, no authContext
    // org), which correctly falls through to ownership resolution below.
    const authoritativeCallerOrgId =
      c.get("authContext")?.organizationId ??
      (bearer ? (c.get("organizationId") as string | undefined) : undefined);

    // Tenant guard: agent-id-string ownership is per (platform, userId,
    // agentId) — but the agentId string can repeat across tenants (two orgs
    // that happen to share an id). If a session belongs to org A and the caller's auth context
    // says org B, deny BEFORE any ownership check — otherwise org B would
    // pass ownership against its own agent-X and reach org A's session
    // routed by the same agent-X. Returning the same `Forbidden` shape as
    // ownership keeps the response uniform (no enumeration oracle on which
    // check failed). Routes that load a session before calling this MUST
    // pass it in; createAgent has no pre-existing session and passes null.
    //
    // The org we compare against MUST be an AUTHORITATIVE auth-method-bound
    // org, NOT the request's ambient org-context:
    //   - `authContext.organizationId` is set only by token auth (worker
    //     token payload / external-OAuth userinfo) — authoritative.
    //   - For PAT auth, `createLobuAuthBridge` sets `c.get("organizationId")`
    //     from the PAT's pinned org (or a membership-verified `x-lobu-org`) —
    //     authoritative, and a PAT always carries a Bearer token.
    //   - For the SETTINGS-SESSION COOKIE path (the owletto SPA), there is NO
    //     Bearer token; `createLobuOrgContextMiddleware` sets
    //     `c.get("organizationId")` to the user's DEFAULT org, which need NOT
    //     match the agent's org (e.g. owning `crm` in `org_lobucrm` while the
    //     default org is personal). Using that ambient default here produced a
    //     spurious 403 on every follow-up SPA request (GET / SSE / messages)
    //     even though POST succeeded. So skip the ambient `organizationId`
    //     guard for the cookie path and let `authorizeOwnership` below enforce
    //     tenant isolation via the agent's REAL org resolved from
    //     `agent_users` vs the session (the same authoritative resolution the
    //     create path uses). Tenant isolation is preserved: a cookie caller
    //     can only authorize against agent_users rows naming their own
    //     (platform, userId), never another tenant's agent.
    if (sessionForTenantCheck?.organizationId) {
      if (
        authoritativeCallerOrgId &&
        sessionForTenantCheck.organizationId !== authoritativeCallerOrgId
      ) {
        return deny();
      }
    }

    // Defense-in-depth for the tenant guard above. That guard only fires when
    // the auth method populated an org (PAT bridge / worker token / external
    // OAuth all set one). The settings-session COOKIE path authenticates a
    // userId but carries NO org, so the guard above is a no-op for it — yet
    // `verifyOwnedAgentAccess` authorizes on (platform, userId, agentId) and
    // returns the CALLER's org, never the session's. Without this, a cookie
    // session for org B could read org A's session via a shared agentId.
    // So compare the org ownership actually resolved
    // to against the session's, and deny on a definite mismatch. An undefined
    // on either side falls through unchanged — this never denies a legitimate
    // same-org caller, it only closes the cross-org case the guard above misses.
    const authorizeOwnership = (access: {
      authorized: boolean;
      organizationId?: string;
    }): Response | Extract<AgentAccessGrant, { kind: "ownership" }> => {
      if (!access.authorized) return deny();

      // Cross-tenant guard #1: a caller with an AUTHORITATIVE org (token/PAT)
      // must not act on an agent that resolves to a DIFFERENT org. createAgent
      // passes no `sessionForTenantCheck` (there's no pre-existing session), so
      // the early guard above can't catch this — without this check a PAT
      // pinned to orgA whose user ALSO owns the same agentId in orgB would mint
      // a session stamped orgB (cross-tenant escalation). The cookie path has
      // no authoritative org → `authoritativeCallerOrgId` is undefined → this
      // never fires for it (its isolation rides guard #2 below).
      if (
        authoritativeCallerOrgId &&
        access.organizationId &&
        access.organizationId !== authoritativeCallerOrgId
      ) {
        return deny();
      }

      // Cross-tenant guard #2: when a pre-existing session is supplied, the
      // agent's resolved org must match the session's org. This is the
      // authoritative isolation check for the settings-session COOKIE path
      // (which has no `authoritativeCallerOrgId`): e.g. a cookie user reaching
      // another org's session via a shared agentId resolves to their own org,
      // which differs from the session's → deny.
      const tenantOrg = sessionForTenantCheck?.organizationId;
      if (
        tenantOrg &&
        access.organizationId &&
        access.organizationId !== tenantOrg
      ) {
        return deny();
      }
      return { kind: "ownership", organizationId: access.organizationId };
    };

    // 1. Settings session cookie (or injected auth provider for embedded mode),
    //    or a short-lived `?token=` ticket — the embedded panel's SSE stream
    //    uses EventSource, which can't send Authorization, so it authenticates
    //    via a ticket from /api/sse-ticket. verifySettingsToken decrypts it to
    //    the same SettingsSession shape the cookie path yields.
    const settingsSession = await verifySettingsSessionOrToken(c, "token");
    if (settingsSession) {
      const access = await verifyOwnedAgentAccess(
        settingsSession,
        resolvedAgentId,
        ownershipAccessConfig
      );
      const callerUserId = resolveSettingsLookupUserId(settingsSession);
      const owned = authorizeOwnership(access);
      if (!(owned instanceof Response)) {
        return { ...owned, callerUserId: callerUserId || undefined };
      }

      // Not an owner — fall back to the org-membership USE path, scoped to a
      // PROVEN org: the workspace the request named (`x-lobu-org`, resolved by
      // the create route) or the existing session's org, never the caller's
      // ambient default org.
      //
      // Two callers are excluded even though they carry a settings session:
      //   - a Bearer request keeps its PAT/OAuth/worker rules even when a
      //     cookie is also present — a token is not a person acting in the web
      //     app, and its own tier (`mcp:*` scopes) is enforced elsewhere;
      //   - an agent-scoped session (worker/self) is bound to its own agent and
      //     must not borrow its human's org membership.
      const candidateOrgId =
        sessionForTenantCheck?.organizationId ?? authoritativeCallerOrgId;
      const member =
        !bearer && !settingsSession.agentId && candidateOrgId && callerUserId
          ? await authorizeOrgAgentMemberInProvenOrg({
              organizationId: candidateOrgId,
              agentId: resolvedAgentId,
              userId: callerUserId,
            })
          : null;
      if (!member) return owned;
      return {
        kind: "membership",
        organizationId: member.organizationId,
        callerUserId: member.userId,
        memberRole: member.role,
      };
    }

    if (!bearer) return deny();

    // 2. Worker token — must target its own agent.
    const workerData = verifyWorkerToken(bearer);
    if (workerData) {
      const tokenAge = Date.now() - workerData.timestamp;
      if (tokenAge > TOKEN_EXPIRATION_MS) return deny();
      if (
        workerData.jti &&
        (await getRevokedTokenStore().isRevoked(workerData.jti))
      ) {
        return deny();
      }
      const workerAgentId = workerData.agentId || workerData.userId;
      return workerAgentId && workerAgentId === resolvedAgentId
        ? { kind: "ownership", organizationId: workerData.organizationId }
        : deny();
    }

    // 3. External OAuth (Lobu / memory-url userinfo).
    if (externalAuthClient) {
      try {
        const userInfo = (await externalAuthClient.fetchUserInfo(bearer)) as {
          sub?: string;
          email?: string;
          name?: string;
        };
        if (userInfo?.sub) {
          const synthesized: SettingsTokenPayload = {
            userId: userInfo.sub,
            platform: "external",
            oauthUserId: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name,
            exp: Date.now() + TOKEN_EXPIRATION_MS,
          };
          const access = await verifyOwnedAgentAccess(
            synthesized,
            resolvedAgentId,
            ownershipAccessConfig
          );
          return authorizeOwnership(access);
        }
      } catch {
        // fall through to deny
      }
    }

    return deny();
  }

  // =============================================================================
  // Route Handlers
  // =============================================================================

  // POST /api/v1/agents - Create agent
  defineRoute(app, createAgentRoute, async (c): Promise<Response> => {
    const body = getValidated<Static<typeof CreateAgentRequestSchema>>(c).json;
    const {
      provider = "claude",
      model,
      agentId: requestedAgentId,
      userId: requestedUserId,
      thread,
      forceNew,
      dryRun,
      intent,
      executionTarget,
      networkConfig,
      nix: nixConfig,
    } = body;

    const normalizedNetworkConfig = networkConfig
      ? normalizeNetworkConfig(networkConfig as NetworkConfig)
      : undefined;

    // Validate network config
    if (normalizedNetworkConfig) {
      const error = validateNetworkConfig(normalizedNetworkConfig);
      if (error) {
        return c.json({ success: false, error }, 400);
      }
    }

    // Resolve the target agent: the caller must pin an agentId. Agents are
    // not auto-provisioned and there is no default routing — create an agent
    // (`lobu apply` / web console) and pass its id.
    const agentId = requestedAgentId?.trim();
    if (!agentId) {
      return c.json(
        {
          success: false,
          error:
            "No agent specified. Run lobu apply or create an agent first, then pass its id.",
        },
        400
      );
    }

    // When the SPA drives a chat from a specific workspace (especially a
    // non-default org), it sends `x-lobu-org: <slug>`. Resolve it so
    // authorization scopes to THAT org rather than the caller's ambient
    // default org. Membership is verified by `authorizeAgentAccess`'
    // ownership checks against this org (a non-member is denied).
    const workspaceOrgSlug = c.req.header("x-lobu-org");
    const workspaceScopedOrgId = workspaceOrgSlug
      ? (await getOrgBySlug(workspaceOrgSlug))?.id
      : undefined;

    // Authorize via the shared helper (per-user ownership + auth-method
    // enforcement).
    const access = await authorizeAgentAccess(
      c,
      agentId,
      workspaceScopedOrgId ? { organizationId: workspaceScopedOrgId } : undefined
    );
    if (access instanceof Response) return access;
    const ownership: { organizationId?: string } = {
      organizationId: access.organizationId,
    };

    // Stamp the worker token with the agent's owning org so the egress
    // proxy's per-tenant gates (grant/deny, judge cache, judge policy) can
    // scope decisions by org. Prefer the org the ownership check resolved
    // from `agent_users` — that's the agent's REAL tenant, even when the
    // caller's ambient org-context is their (different) default org, which
    // is exactly the SPA-chat case for an agent in a non-default org. Fall
    // back to the ALS-scoped metadata lookup and then the caller's
    // auth-context org for paths that don't resolve one (worker token).
    const metadataOrgId = ownershipMetadataStore
      ? (await ownershipMetadataStore.getMetadata(agentId))?.organizationId
      : undefined;
    const tokenOrganizationId =
      ownership.organizationId ??
      metadataOrgId ??
      (c.get("organizationId") as string | undefined) ??
      c.get("authContext")?.organizationId;

    // A `automation_run` intent decides this session's userId/thread, and hence
    // the `_automation_<id>_run_<id>` conversation suffix that downstream gates
    // read an Automation's identity out of. Verify both the dispatcher claim and
    // its short-lived internal token HERE — the one place the intent enters
    // the system — so downstream code can trust the packed correlation.
    const automationIntent = intent?.kind === "automation_run" ? intent : null;
    // Non-null only for a verified Automation session. 'capture' means the run is
    // an eval replay: it is derived from the run row here, travels as a signed
    // worker-token claim, and is what stops the agent touching the outside
    // world. See packages/server/src/runs/run-types.ts.
    const automationExecutionMode = automationIntent
      ? await verifyAutomationRunIntent({
          intent: automationIntent,
          organizationId: tokenOrganizationId,
          accessToken: tokenFromHeader(c),
        })
      : null;
    if (automationIntent && !automationExecutionMode) {
      logger.warn(
        {
          runId: automationIntent.runId,
          automationId: automationIntent.automationId,
          organizationId: tokenOrganizationId,
        },
        "Rejected an Automation-run session: intent does not name a dispatched run",
      );
      return c.json(
        { success: false, error: "Unknown or undispatched Automation run" },
        403,
      );
    }
    // userId backs `conversationId = ${agentId}_${userId}[_${thread}]`, which
    // is the session-store key. agentId is a per-org row id, so the userId must
    // be unique-per-caller to keep conversationIds unique and prevent
    // cross-caller session resume. Prefer the request body, then the
    // authenticated caller's userId (per-org-unique via the auth bridge),
    // then fall back to agentId.
    const authUserId = c.get("authContext")?.userId;
    const userId = automationIntent
      ? // Internal correlation key: the `..._automation_<id>_run_<id>` conversationId
        // shape is prod-proven and drives worker dispatch + SSE owner-routing
        // (see the conversationId comment below). Keep the internal `automation_`
        // wire prefix even though the public intent field is `automationId`.
        `automation_${automationIntent.automationId}`
      : requestedUserId || authUserId || agentId;
    const effectiveThread = automationIntent
      ? `run_${automationIntent.runId}`
      : thread;
    const effectiveForceNew = automationIntent ? true : forceNew;
    const effectiveDryRun = automationIntent ? false : dryRun || false;

    // Build composite conversationId for user-specific sessions.
    // Uses _ separator (colons not allowed in BullMQ custom IDs). Automation
    // automation gets one deterministic one-shot session per run and never
    // resumes human/API sessions such as marketing_marketing.
    //
    // Tenant-scope: include tokenOrganizationId so sessions for shared agent
    // ids (two orgs can share the same id string) never collide across
    // tenants in the in-memory session
    // store. The resume guard below catches in-flight collisions; the org
    // suffix prevents `forceNew` from silently overwriting another tenant's
    // session at setSession time.
    //
    // Automation sessions are EXEMPT: their conversationId is already globally
    // unique via the DB-serial automationId + runId, and downstream correlation
    // relies on the exact `..._automation_<id>_run_<id>` shape — the worker
    // session key AND the API/SSE owner-routing key (unified-thread-consumer)
    // both derive from this conversationId. Injecting `_<org>_` mid-id splits
    // `automation_<id>` from `run_<id>`, breaking automation→worker dispatch (caught
    // by the sdk-e2e gate). Keep the prod-proven shape for the automation path.
    const conversationId = buildApiConversationId({
      agentId,
      userId,
      organizationId: automationIntent ? undefined : tokenOrganizationId,
      threadId: effectiveThread || undefined,
    });
    // Validate the packed id, not individual request fields: a caller can place
    // `_automation_<id>_run_<id>` across userId/thread boundaries or entirely
    // inside either field. Only the verified internal intent may create the
    // suffix consumed by the unattended-tool policy.
    if (
      !automationIntent &&
      parseAutomationRunConversationId(conversationId) !== null
    ) {
      logger.warn(
        { conversationId, organizationId: tokenOrganizationId },
        "Rejected a session using the reserved Automation conversation suffix",
      );
      return c.json(
        { success: false, error: "Reserved Automation conversation suffix" },
        400,
      );
    }
    const channelId = `api_${userId}`;
    const deploymentName = `api-${agentId.slice(0, 8)}`;

    // Automation sessions mint through buildAutomationRunWorkerAccess so the
    // token identity matches the canonical `..._automation_<id>_run_<id>`
    // correlation AND the advertised expiry matches the worker token's real
    // verification TTL (WORKER_TOKEN_TTL_MS, default 2h) — the generic
    // TOKEN_EXPIRATION_MS (24h) overstated it. Non-automation sessions keep the
    // generic mint unchanged.
    const mintSessionToken = (): { token: string; expiresAt: number } => {
      const automationAccess =
        automationIntent && tokenOrganizationId
          ? buildAutomationRunWorkerAccess({
              agentId,
              automationId: automationIntent.automationId,
              runId: automationIntent.runId,
              organizationId: tokenOrganizationId,
              conversationId,
            })
          : null;
      return {
        token:
          automationAccess?.token ??
          generateWorkerToken(agentId, conversationId, deploymentName, {
            channelId,
            agentId,
            organizationId: tokenOrganizationId,
            platform: "api",
            sessionKey: userId,
          }),
        expiresAt:
          automationAccess?.expiresAt ?? Date.now() + TOKEN_EXPIRATION_MS,
      };
    };

    // Read the session this request would resume or overwrite once, then run
    // both guards over it.
    const existing = await sessMgr.getSession(conversationId);
    const callerMembershipRole =
      access.kind === "membership"
        ? access.memberRole
        : access.callerUserId && tokenOrganizationId
          ? await getMembershipRole(
              tokenOrganizationId,
              access.callerUserId,
            )
          : undefined;
    const hasOrgOversight = isAdminOrOwnerRole(callerMembershipRole);

    // A human may only resume — or overwrite with `forceNew` — a session they
    // created themselves. Org members can now USE an agent they do not own, and
    // the `userId` half of the conversationId is caller-supplied (request body),
    // so without this a member could name a colleague's userId to resume their
    // thread (receiving a worker token scoped to it) or clobber it outright.
    // Bearer/automation callers have no `callerUserId` and are unaffected.
    //
    // A session with NO `createdByUserId` predates that stamp, so it can only
    // be the owner's (members could not create one before this change). It
    // stays closed to a member without oversight, who would otherwise resume
    // or `forceNew`-clobber it on the strength of an absent field.
    if (access.callerUserId && existing) {
      const creatorMismatch =
        existing.createdByUserId !== undefined &&
        existing.createdByUserId !== access.callerUserId;
      const unstampedAndNotOursToTake =
        existing.createdByUserId === undefined &&
        access.kind === "membership" &&
        !hasOrgOversight;
      if ((creatorMismatch && !hasOrgOversight) || unstampedAndNotOursToTake) {
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
    }

    // Session state has a TTL; the transcript is the durable conversation
    // substrate. Recover the last completed turn's device placement from its
    // session header so the thread cannot silently fall back to managed runtime.
    let candidateExecutionTarget: DeviceExecutionTarget | undefined =
      executionTarget;
    let recoveredExecutionTarget = false;
    if (!candidateExecutionTarget && effectiveForceNew) {
      candidateExecutionTarget = existing?.executionTarget;
    }
    if (
      !candidateExecutionTarget &&
      !existing &&
      !automationIntent &&
      tokenOrganizationId
    ) {
      candidateExecutionTarget = executionTargetFromSnapshot(
        await readSnapshotJsonl({
          agentId,
          organizationId: tokenOrganizationId,
          conversationId,
          prefixChars: SNAPSHOT_HEADER_CHARS,
        }),
      );
      recoveredExecutionTarget = candidateExecutionTarget !== undefined;
    }

    let verifiedExecutionTarget: DeviceExecutionTarget | undefined;
    if (candidateExecutionTarget) {
      if (intent || !access.callerUserId || !tokenOrganizationId) {
        return c.json(
          {
            success: false,
            error: "Device chat requires a workspace user session",
          },
          403,
        );
      }
      // `capabilities` is a jsonb array of capability names, so test
      // membership with the jsonb `?` operator used by worker dispatch.
      // An org owner/admin may resume a member's existing conversation and
      // therefore verify its already-pinned device. Ordinary callers remain
      // confined to devices they own.
      const targetDeviceOwnerId =
        hasOrgOversight && (existing != null || recoveredExecutionTarget)
        ? (existing?.createdByUserId ?? userId)
        : access.callerUserId;
      const devices = await getDb()<{
        id: string;
        agent_kinds: string[] | string | null;
        can_execute: boolean;
      }>`
        SELECT id, agent_kinds, capabilities ? 'automations.execute' AS can_execute
        FROM device_workers
        WHERE id = ${candidateExecutionTarget.deviceWorkerId}::uuid
          AND user_id = ${targetDeviceOwnerId}
          AND organization_id = ${tokenOrganizationId}
        LIMIT 1
      `;
      const device = devices[0];
      const advertisedKinds =
        device?.agent_kinds == null ? [] : parsePgTextArray(device.agent_kinds);
      if (
        !device ||
        !device.can_execute ||
        !advertisedKinds.includes(candidateExecutionTarget.agentKind)
      ) {
        return c.json(
          {
            success: false,
            error: "That device cannot run the selected agent",
          },
          400,
        );
      }
      verifiedExecutionTarget = candidateExecutionTarget;
    }

    // Resume (unless forceNew). Refuse cross-tenant resume defensively: even
    // though the userId fallback above is per-org-unique for the default-agent
    // path, a future caller that bypasses the auth bridge or passes a colliding
    // requestedUserId would otherwise resume another tenant's session and leak
    // its worker token.
    if (!effectiveForceNew) {
      if (
        existing &&
        existing.organizationId &&
        tokenOrganizationId &&
        existing.organizationId !== tokenOrganizationId
      ) {
        logger.warn(
          `Refusing to resume session ${conversationId} for org ${tokenOrganizationId}: belongs to org ${existing.organizationId}`
        );
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
      if (existing) {
        const existingTarget = existing.executionTarget;
        if (
          verifiedExecutionTarget &&
          (verifiedExecutionTarget.deviceWorkerId !==
            existingTarget?.deviceWorkerId ||
            verifiedExecutionTarget.agentKind !== existingTarget?.agentKind)
        ) {
          return c.json(
            {
              success: false,
              error: "Conversation execution target cannot change",
            },
            409,
          );
        }
        // Reuse the existing session — touch lastActivity and hand back a
        // freshly minted token for it (tokens are stateless, never stored).
        await sessMgr.touchSession(conversationId);

        const { token, expiresAt } = mintSessionToken();
        const baseUrl = pubUrl || "http://localhost:8080";

        logger.info(
          `Resumed API session: ${conversationId} (agent=${agentId})`
        );

        return c.json(
          {
            success: true,
            agentId: conversationId,
            token,
            expiresAt,
            sseUrl: `${baseUrl}/api/v1/agents/${conversationId}/events`,
            messagesUrl: `${baseUrl}/api/v1/agents/${conversationId}/messages`,
            ...(existing.executionTarget
              ? { executionTarget: existing.executionTarget }
              : {}),
          },
          201
        );
      }
    }

    const { token, expiresAt } = mintSessionToken();

    const session: ThreadSession = {
      conversationId,
      channelId,
      userId,
      threadCreator: userId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      status: "created",
      provider,
      model,
      ...(verifiedExecutionTarget
        ? { executionTarget: verifiedExecutionTarget }
        : {}),
      networkConfig: normalizedNetworkConfig,
      nixConfig,
      agentId,
      ...(tokenOrganizationId ? { organizationId: tokenOrganizationId } : {}),
      ...(access.callerUserId
        ? { createdByUserId: access.callerUserId }
        : {}),
      dryRun: effectiveDryRun,
      intent: automationIntent ?? undefined,
      ...(automationExecutionMode
        ? { executionMode: automationExecutionMode }
        : {}),
    };
    await sessMgr.setSession(session);

    logger.info(`Created API agent: ${conversationId} (agent=${agentId})`);

    const baseUrl = pubUrl || "http://localhost:8080";
    return c.json(
      {
        success: true,
        agentId: conversationId,
        token,
        expiresAt,
        sseUrl: `${baseUrl}/api/v1/agents/${conversationId}/events`,
        messagesUrl: `${baseUrl}/api/v1/agents/${conversationId}/messages`,
        ...(session.executionTarget
          ? { executionTarget: session.executionTarget }
          : {}),
      },
      201
    );
  });

  // GET /api/v1/agents/:agentId - Get status
  defineRoute(app, getAgentRoute, async (c): Promise<Response> => {
    const { agentId: sessionKey } =
      getValidated<never, Static<typeof AgentIdParamSchema>>(c).param;

    const session = await sessMgr.getSession(sessionKey);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const denial = await authorizeAgentAccess(
      c,
      session.agentId || sessionKey,
      session
    );
    if (denial instanceof Response) return denial;

    const hasActiveConnection = sseManager.hasActiveConnection(sessionKey);

    return c.json({
      success: true,
      agent: {
        agentId: session.conversationId,
        userId: session.userId,
        status: session.status || "active",
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        hasActiveConnection,
      },
    });
  });

  // DELETE /api/v1/agents/:agentId
  defineRoute(app, deleteAgentRoute, async (c): Promise<Response> => {
    const { agentId: sessionKey } =
      getValidated<never, Static<typeof AgentIdParamSchema>>(c).param;

    // Resolve the real agentId BEFORE any mutation so ownership can be
    // checked against the actual agent (the path param is a sessionKey).
    const existingSession = await sessMgr.getSession(sessionKey);
    const denial = await authorizeAgentAccess(
      c,
      existingSession?.agentId || sessionKey,
      existingSession
    );
    if (denial instanceof Response) return denial;

    // Close connections + drop backlog so a later connection with the same
    // key (rare, but possible with deterministic conversationIds) can't
    // replay stale completion events from this deleted session.
    sseManager.closeAgent(sessionKey, "agent_deleted");

    // Delete the session only. Agent rows persist — they're owned by the
    // org (declared agents) or the user's personal org (the default agent).
    // The phantom-ephemeral-agent cleanup that used to run here is gone:
    // there are no phantom rows to clean up under the default-agent flow.
    await sessMgr.deleteSession(sessionKey);
    logger.info(`Deleted agent session ${sessionKey}`);

    return c.json({
      success: true,
      message: "Agent session deleted",
      agentId: sessionKey,
    });
  });

  // GET /api/v1/agents/:agentId/events - SSE stream
  defineRoute(app, getAgentEventsRoute, async (c): Promise<Response> => {
    const { agentId: sessionKey } =
      getValidated<never, Static<typeof AgentIdParamSchema>>(c).param;

    const session = await sessMgr.getSession(sessionKey);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    // Gate BEFORE opening the stream or replaying the backlog — otherwise a
    // cross-tenant caller would receive another agent's buffered events.
    const denial = await authorizeAgentAccess(
      c,
      session.agentId || sessionKey,
      session
    );
    if (denial instanceof Response) return denial;

    // Check connection limits
    if (sseManager.totalConnections() >= MAX_TOTAL_CONNECTIONS) {
      return c.json(
        { success: false, error: "Server connection limit reached" },
        429
      );
    }

    // Use conversationId as the SSE connection key (matches broadcast calls)
    const sseKey = session.conversationId;
    if (sseManager.connectionCount(sseKey) >= MAX_CONNECTIONS_PER_AGENT) {
      return c.json(
        {
          success: false,
          error: `Maximum ${MAX_CONNECTIONS_PER_AGENT} connections`,
        },
        429
      );
    }

    // Return SSE stream.
    //
    // Hono's `streamSSE` only fires `stream.onAbort()` when the underlying
    // `ReadableStream.cancel()` runs — which doesn't happen on abnormal
    // disconnects (LB idle timeout, intermediate proxy kill, client hard
    // close). On Node + current Bun, `signal.abort` is the only reliable
    // trigger. Without it the heartbeat interval keeps firing, the
    // `sseManager` retains the dead connection, and the `while !aborted`
    // loop never exits — the same retain pattern fixed for the invalidation
    // streams in #833. Refs #782.
    const requestSignal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      // If the client already aborted between handler invocation and stream
      // body execution, bail out before registering anything.
      if (requestSignal?.aborted) {
        return;
      }

      // Idempotent cleanup latch wired up FIRST so an abort during the
      // initial writeSSE / backlog-replay window below routes through the
      // same teardown path. Without this, an abort between
      // `sseManager.addConnection` and `stream.onAbort(cleanup)` would leak
      // the registration in the manager.
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      let connectionAdded = false;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (connectionAdded) {
          sseManager.removeConnection(sseKey, stream);
        }
        logger.info(`SSE connection closed for session ${sseKey}`);
      };

      stream.onAbort(cleanup);
      const detachAbortBridge = bindRequestAbortToStream(requestSignal, stream);

      // Snapshot the backlog BEFORE registering, with no await in between so the
      // two run atomically on the single-threaded event loop. Otherwise a
      // broadcast landing during the `connected` write below would be delivered
      // live AND still be in the backlog we replay — duplicating it (and
      // possibly reordering it after later live events) for the client.
      // Bounded to THIS session's lifetime. `conversationId` is deterministic
      // (agent + user + org + thread), so `forceNew` mints a fresh session at
      // the key the old one used — while the backlog ring, keyed on that same
      // string, still holds the previous turn for its 2-minute TTL. Replaying
      // the whole ring therefore answered `lobu chat --new` with the PREVIOUS
      // turn's output, before the new message had even been dispatched.
      //
      // `createdAt` is the exact boundary: a resumed session keeps its
      // original value and still gets its own events back, while a replacement
      // session starts after everything the old one emitted.
      const backlog = sseManager.getRecentEvents(sseKey, session.createdAt);
      sseManager.addConnection(sseKey, stream);
      connectionAdded = true;

      try {
        await stream.writeSSE({
          event: "connected",
          data: JSON.stringify({
            agentId: session.agentId || sessionKey,
            timestamp: Date.now(),
          }),
        });

        for (const entry of backlog) {
          await stream.writeSSE({
            event: entry.event,
            data: JSON.stringify(entry.data),
          });
        }

        heartbeatInterval = setInterval(async () => {
          try {
            await stream.writeSSE({
              event: "ping",
              data: JSON.stringify({ timestamp: Date.now() }),
            });
          } catch {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
          }
        }, 30000);

        while (!stream.aborted && !stream.closed) {
          await stream.sleep(1000);
        }
      } finally {
        detachAbortBridge();
        cleanup();
      }
    });
  });

  // POST /api/v1/agents/:agentId/messages - Send message
  // Supports two paths:
  //   1. Direct API (no platform field): requires pre-created session, enqueues directly
  //   2. Platform-routed (platform field present): delegates to platform adapter
  defineRoute(app, sendMessageRoute, async (c): Promise<Response> => {
    const { agentId } =
      getValidated<never, Static<typeof AgentIdParamSchema>>(c).param;

    // Gate ownership BEFORE parsing body / uploading files. The path param is
    // usually a sessionKey (conversationId); resolve to the real agentId when
    // a session exists.
    const preSession = await sessMgr.getSession(agentId);
    const resolvedAgentId = preSession?.agentId || agentId;

    const msgAccess = await authorizeAgentAccess(c, resolvedAgentId, preSession);
    if (msgAccess instanceof Response) return msgAccess;
    if (!msgAccess.organizationId) {
      return c.json(
        { success: false, error: "Organization scope required" },
        403,
      );
    }

    const messageOrganizationId = msgAccess.organizationId;

    // Parse body — multipart for file uploads, JSON otherwise
    const contentType = c.req.header("content-type") || "";
    let body: Record<string, any>;
    let files:
      | Array<{ buffer: Buffer; filename: string; mimeType: string }>
      | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      body = {
        content: formData.get("content") as string | null,
        message: formData.get("message") as string | null,
        messageId: formData.get("messageId") as string | null,
        model: formData.get("model") as string | null,
        platform: formData.get("platform") as string | null,
      };

      // Extract nested platform routing from form fields
      const slackChannel = formData.get("slack.channel") as string;
      if (slackChannel) {
        body.slack = {
          channel: slackChannel,
          thread: formData.get("slack.thread") as string | undefined,
          team: formData.get("slack.team") as string | undefined,
        };
      }
      const whatsappChat = formData.get("whatsapp.chat") as string;
      if (whatsappChat) {
        body.whatsapp = { chat: whatsappChat };
      }
      const telegramChatId = formData.get("telegram.chatId") as string;
      if (telegramChatId) {
        body.telegram = { chatId: telegramChatId };
      }

      // Extract files with size validation
      const MAX_FILE_SIZE = 50 * 1024 * 1024;
      const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
      const MAX_FILE_COUNT = 10;
      const fileEntries = formData.getAll("files");
      if (fileEntries.length > MAX_FILE_COUNT) {
        return c.json(
          {
            success: false,
            error: `Too many files: ${fileEntries.length} (max ${MAX_FILE_COUNT})`,
          },
          400
        );
      }
      if (fileEntries.length > 0) {
        const fileResults: Array<{
          buffer: Buffer;
          filename: string;
          mimeType: string;
        }> = [];
        let totalSize = 0;
        for (const entry of fileEntries) {
          if (entry instanceof File) {
            if (entry.size > MAX_FILE_SIZE) {
              return c.json(
                {
                  success: false,
                  error: `File "${entry.name}" exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
                },
                400
              );
            }
            totalSize += entry.size;
            if (totalSize > MAX_TOTAL_SIZE) {
              return c.json(
                {
                  success: false,
                  error: `Total upload size exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB`,
                },
                400
              );
            }
            const arrayBuffer = await entry.arrayBuffer();
            fileResults.push({
              buffer: Buffer.from(arrayBuffer),
              filename: entry.name,
              mimeType: entry.type || "application/octet-stream",
            });
          }
        }
        if (fileResults.length > 0) files = fileResults;
      }
    } else {
      // `skipBodyValidation` is set on the route (multipart branch above), so
      // validate the JSON body here against the same schema. `passthrough`
      // (additionalProperties) keeps extra routing fields the handler forwards.
      let rawBody: unknown;
      try {
        // Missing/empty body → {} (parity with the defineRoute middleware and
        // the previous zod-openapi validator); non-empty must parse.
        const text = await c.req.text();
        rawBody = text.trim() === "" ? {} : JSON.parse(text);
      } catch {
        return c.json({ success: false, error: "Invalid JSON body" }, 400);
      }
      // Strict Check — JSON carries real types, so no Value.Convert here:
      // coercion would silently accept e.g. `{content: 123}` as "123".
      if (!Value.Check(SendMessageRequestSchema, rawBody)) {
        const first = Value.Errors(SendMessageRequestSchema, rawBody).First();
        return c.json(
          {
            success: false,
            error: first
              ? `${first.path || "(root)"} ${first.message}`.trim()
              : "Invalid request body",
          },
          400,
        );
      }
      body = rawBody as Record<string, any>;
    }

    const rawMessageContent = body.content || body.message;
    const messageId = body.messageId || randomUUID();
    const rawEphemeralContext =
      typeof body.ephemeralContext === "string" ? body.ephemeralContext.trim() : "";

    if (rawMessageContent != null && typeof rawMessageContent !== "string") {
      return c.json({ success: false, error: "content must be a string" }, 400);
    }
    // A file-only message (attachment with an empty caption) is valid — the web
    // composer permits it. Require *some* payload: text or at least one file.
    const messageContent =
      typeof rawMessageContent === "string" ? rawMessageContent : "";
    const hasInboundFiles = Array.isArray(files) && files.length > 0;
    if (!messageContent && !hasInboundFiles) {
      return c.json({ success: false, error: "content or files required" }, 400);
    }

    if (preSession?.executionTarget && hasInboundFiles) {
      return c.json(
        { success: false, error: "Device chat does not support attachments yet" },
        400,
      );
    }

    const platform = body.platform as string | undefined;

    // ── Platform-routed path ──────────────────────────────────────────────────
    // When platform is specified, delegate to the platform adapter which handles
    // session creation, routing, and file delivery.
    if (platform) {
      // Worker tokens cannot route to user-facing platform connections
      const authHeader = c.req.header("Authorization");
      const rawToken = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : "";
      if (verifyWorkerToken(rawToken)) {
        return c.json(
          { success: false, error: "Worker tokens cannot route to platforms" },
          403
        );
      }

      if (!platformRegistry) {
        return c.json(
          { success: false, error: "Platform routing not available" },
          501
        );
      }

      const adapter = platformRegistry.get(platform);
      if (!adapter) {
        return c.json(
          {
            success: false,
            error: `Platform "${platform}" not found`,
            details: `Available: ${platformRegistry.getAvailablePlatforms().join(", ")}`,
          },
          404
        );
      }

      if (!adapter.sendMessage) {
        return c.json(
          {
            success: false,
            error: `Platform "${platform}" does not support sendMessage`,
          },
          501
        );
      }

      // Extract platform-specific routing info
      let channelId = agentId;
      let conversationId: string | undefined =
        platform === "api" ? agentId : undefined;
      let teamId = "api";

      if (adapter.extractRoutingInfo) {
        const routingInfo = adapter.extractRoutingInfo(
          body as Record<string, unknown>
        );
        if (routingInfo) {
          channelId = routingInfo.channelId;
          conversationId = routingInfo.conversationId || conversationId;
          teamId = routingInfo.teamId || "api";
        } else if (platform !== "api") {
          return c.json(
            {
              success: false,
              error: `Platform-specific routing info required for ${platform}`,
            },
            400
          );
        }
      }

      logger.info(
        `Sending message via ${platform}: agentId=${agentId}, channelId=${channelId}${files?.length ? `, files=${files.length}` : ""}`
      );

      try {
        const result = await adapter.sendMessage(rawToken, messageContent, {
          agentId,
          organizationId: messageOrganizationId,
          channelId,
          conversationId,
          teamId,
          files,
        });

        return c.json({
          success: true,
          agentId,
          messageId: result.messageId,
          eventsUrl: result.eventsUrl,
          queued: result.queued || false,
        });
      } catch (error) {
        logger.error("Failed to send platform message", { error });
        return c.json({ success: false, error: "Internal server error" }, 500);
      }
    }

    // ── Direct API path ───────────────────────────────────────────────────────
    // No platform field: use existing session-based direct enqueue
    const session = preSession;
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    await sessMgr.touchSession(agentId);

    const realAgentId = session.agentId || agentId;

    const { span: rootSpan, traceparent } = createRootSpan("message_received", {
      "lobu.agent_id": realAgentId,
      "lobu.message_id": messageId,
    });

    try {
      const channelId = session.channelId || `api_${session.userId}`;

      // A per-message model override (including Automation dispatch)
      // wins over the session's model; otherwise the session model (already the
      // agent/org resolution) carries through. resolveAgentOptions then applies
      // the layered fallback for the empty case.
      const automationModel =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : undefined;
      const baseOptions: Record<string, any> = {
        provider: session.provider || "claude",
        model: automationModel ?? session.model,
        nixConfig: session.nixConfig,
      };
      const agentOptions = await resolveAgentOptions(
        realAgentId,
        baseOptions,
        agentSettingsStore,
        messageOrganizationId
      );

      const {
        networkConfig: settingsNetwork,
        guardrailsInline: settingsGuardrailsInline,
        nixConfig: resolvedNixConfig,
        preApprovedTools,
        ...remainingOptions
      } = agentOptions;

      // First turn only: client ephemeralContext wins; otherwise auto-inject a
      // short workspace attention digest (same cards as manage_operations.list_activity).
      let ephemeralForTurn = rawEphemeralContext;
      if (
        (session.turnCount ?? 0) === 0 &&
        !ephemeralForTurn &&
        session.intent?.kind !== "automation_run" &&
        messageOrganizationId
      ) {
        try {
          // Notifications are per-recipient, so scope the read to the
          // AUTHENTICATED principal, never `session.userId`, which is
          // client-supplied via CreateAgentRequestSchema.userId (an agent owner
          // could stamp a session with another member's id and siphon their
          // notifications). Fall back to null (org runs only, no notifications)
          // when no trusted human principal is present (e.g. worker token).
          const attentionUserId =
            (c.get("authContext")?.userId as string | undefined) ??
            (await verifySettingsSessionOrToken(c))?.userId ??
            null;
          const orgRow = (await getDb()`
            SELECT slug FROM organization WHERE id = ${messageOrganizationId} LIMIT 1
          `) as unknown as Array<{ slug: string }>;
          const ownerSlug = orgRow[0]?.slug ?? messageOrganizationId;
          const { items } = await listOrgActivity({
            organizationId: messageOrganizationId,
            userId: attentionUserId,
            ownerSlug,
            limit: 12,
            aggregate: true,
          });
          ephemeralForTurn = formatActivityAttentionBlock(items);
        } catch {
          // Attention is best-effort — never block chat on feed failure.
        }
      }
      const applyEphemeralContext =
        ephemeralForTurn.length > 0 && (session.turnCount ?? 0) === 0;

      // Inbound attachments: publish each uploaded file as a signed gateway
      // artifact and forward the worker-facing `files` array in
      // platformMetadata — the same multi-replica-safe path used by the
      // platform adapters (`ingestInboundAttachments`). The worker downloads
      // these into its `input/` dir and embeds images for visual analysis.
      // Local-disk staging would break under N>1 replicas (the worker pod is
      // routinely not the pod that received the upload).
      const ingestedFiles = files
        ? (
            await ingestInboundAttachments(
              files.map((f) => ({
                data: f.buffer,
                name: f.filename,
                mimeType: f.mimeType,
              })),
              artifactStore,
              pubUrl
            )
          ).files
        : [];

      // Persist non-image attachments as tokenless artifact-route references in
      // the user's message text so they survive in the (text+image-only) pi-ai
      // transcript and the web can lift them into chips on reload. The history
      // read path re-signs them with a fresh download token. See
      // `buildAttachmentTranscriptText`.
      const messageTextForTranscript = buildAttachmentTranscriptText(
        messageContent,
        ingestedFiles
      );

      // `!`-bash from web/direct-API chat (the primary `!` surface — ChatGPT-UI
      // style clients driving the conversation's sandbox without the LLM). Gated
      // to genuine user chat: an automation_run's injected text must stay ordinary
      // text, never a deterministic shell trigger. The Chat SDK bridge does the
      // same for platform inbound.
      const bangBash =
        session.intent?.kind === "automation_run"
          ? null
          : parseBangBashCommand(messageContent);

      const jobId = await queueProducer.enqueueMessage({
        userId: session.userId,
        conversationId: session.conversationId || agentId,
        messageId,
        channelId,
        teamId: "api",
        agentId: realAgentId,
        organizationId: messageOrganizationId,
        botId: "lobu-api",
        platform: "api",
        messageText: messageTextForTranscript,
        ...(session.executionTarget
          ? { executionTarget: session.executionTarget }
          : {}),
        ...(applyEphemeralContext
          ? { ephemeralContext: ephemeralForTurn.slice(0, 2048) }
          : {}),
        platformMetadata: {
          agentId: realAgentId,
          // Echoed back on every response row so output-guardrail audit events
          // remain scoped to the authoritative organization.
          organizationId: messageOrganizationId,
          source:
            session.intent?.kind === "automation_run"
              ? AUTOMATION_RUN_SOURCE
              : "direct-api",
          traceparent: traceparent || undefined,
          dryRun: session.dryRun || false,
          intent: session.intent,
          ...(session.executionMode
            ? { executionMode: session.executionMode }
            : {}),
          ...(ingestedFiles.length > 0 ? { files: ingestedFiles } : {}),
          ...(bangBash ? { bangBash } : {}),
        },
        agentOptions: remainingOptions,
        networkConfig: session.networkConfig || settingsNetwork,
        guardrailsInline: settingsGuardrailsInline,
        nixConfig: resolvedNixConfig,
        preApprovedTools,
      });

      rootSpan?.end();

      return c.json({
        success: true,
        messageId,
        jobId,
        queued: true,
        traceparent: traceparent || undefined,
      });
    } catch (error) {
      rootSpan?.end();
      throw error;
    }
  });

  // POST /api/v1/agents/approve - Approve a pending tool call (CLI/web)
  if (config.approveToolCall) {
    const approveHandler = config.approveToolCall;
    app.post("/api/v1/agents/approve", async (c) => {
      const { requestId, decision } = await c.req.json();
      if (!requestId || !decision) {
        return errorResponse(c, "Missing requestId or decision", 400);
      }
      const validDecisions = ["1h", "24h", "always", "deny"];
      if (!validDecisions.includes(decision)) {
        return errorResponse(
          c,
          `Invalid decision. Must be one of: ${validDecisions.join(", ")}`,
          400
        );
      }
      const result = await approveHandler(requestId, decision);
      if (!result.success) {
        return errorResponse(c, result.error || "Approval failed", 400);
      }
      return c.json({ success: true });
    });
  }

  // GET /api/v1/agents/{agentId}/pending-approvals - Replay open tool approvals
  // for a conversation so the web SPA can re-render approval cards on reload
  // (the live `tool-approval` SSE card is one-shot). The path param IS the
  // conversationId (messagesUrl is /api/v1/agents/{conversationId}/messages),
  // which is what pending tools are keyed by.
  app.get("/api/v1/agents/:agentId/pending-approvals", async (c) => {
    const conversationId = c.req.param("agentId");
    // The path param is the conversationId (sessionKey). Resolve the session to
    // the real agentId + org and AUTHORIZE the caller BEFORE returning anything:
    // these rows carry tool requestIds + arguments, so an
    // unauthorized-for-this-conversation read is an IDOR. Mirror the messages
    // route's pre-gate exactly.
    const preSession = await sessMgr.getSession(conversationId);
    const resolvedAgentId = preSession?.agentId || conversationId;
    const access = await authorizeAgentAccess(c, resolvedAgentId, preSession);
    if (access instanceof Response) return access;
    // The read MUST be org-scoped. authorizeAgentAccess resolves the org for
    // every legitimate caller; refuse rather than issue an unscoped read if it
    // somehow didn't.
    if (!access.organizationId) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    const pending = await listPendingToolsForConversation(
      conversationId,
      access.organizationId
    );
    return c.json({
      approvals: pending.map((p) => ({
        requestId: p.requestId,
        mcpId: p.mcpId,
        toolName: p.toolName,
        args: p.args,
      })),
    });
  });

  logger.debug("Hono Agent API routes registered");

  return app;
}
