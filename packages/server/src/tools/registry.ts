/**
 * MCP Tool Registry
 *
 * This file defines all MCP tools and imports their Typebox schemas from the tool
 * file that owns each one, or from `@lobu/core/contracts/tools/*` for the schemas
 * shared with the connector SDK.
 * Typebox provides compile-time type safety and runtime JSON schema generation.
 *
 * Glossary — "namespace" in tool descriptions below means three different things,
 * none of which is a memory-scope axis:
 *   1. A namespace passed in `search_sdk`'s `query` param — a ClientSDK property name
 *      (`automations`, `entities`, `knowledge`, ...).
 *   2. `resolve_path`'s "namespace-based URL path" — the first URL segment
 *      (an organization slug or `@user` handle).
 *   3. `entity_identities.namespace` (deep in SQL) — the identifier type
 *      (`email`, `phone`, `wa_jid`); see `identity-normalize.ts`.
 *
 * Memory scoping uses `events.metadata.agent_id` (filtered via
 * `search_memory`'s top-level `agent_id` arg) — not any of the above.
 */

import { SaveContentSchema } from '@lobu/core/contracts/tools/save-memory';
import { type Static, Type } from '@sinclair/typebox';
import { getMcpConnectionScopes } from '../auth/oauth/scopes';
import { getPublicReadableActions, getRequiredAccessLevel } from '../auth/tool-access';
import type { CaptureIdentity } from '../gateway/routes/internal/capture-mode';
import type { Env } from '../index';
import { LOBU_INTERACTION_RESOURCE_URI } from '../mcp-app-resource-uris';
import { ADMIN_TOOLS } from './admin';
import { ListMetricsSchema, listMetrics } from './admin/list_metrics';
import { MetricSeriesSchema, metricSeries } from './admin/metric_series';
import { QueryMetricSchema, queryMetric } from './admin/query_metric';
import { QuerySqlResultSchema, QuerySqlSchema, querySql } from './admin/query_sql';
import {
  GetApprovalSchema,
  LobuViewSchema,
  ResolveApprovalSchema,
  getApproval,
  resolveApproval,
} from './mcp_app';
import { listOrganizations, ListOrganizationsSchema } from './organizations';
import {
  InvokeEventActionResultSchema,
  InvokeEventActionSchema,
  invokeEventAction,
} from './invoke_event_action';
import { ResolvePathResultSchema, ResolvePathSchema, resolvePath } from './resolve_path';
import { SaveContentResultSchema, saveContent } from './save_content';
import {
  QuerySchema,
  querySdkScript,
  RunSchema,
  runSdkScript,
  SdkScriptResultSchema,
} from './sdk_run';
import { SdkSearchResultSchema, SdkSearchSchema, sdkSearch } from './sdk_search';
import { PublicSearchSchema, SearchSchema, search, UnifiedSearchResultSchema } from './search';
import { withValidatedArgs } from './validate-args';

// ============================================
// Tool Definitions
// ============================================

/**
 * MCP Tool Annotations
 * @see https://developers.openai.com/apps-sdk/reference#annotations
 */
export interface ToolAnnotations {
  /** Signal that the tool only retrieves or computes information without creating data outside the conversation. */
  readOnlyHint?: boolean;
  /** Declare that the tool may delete or overwrite user data. */
  destructiveHint?: boolean;
  /** Declare that the tool may change public internet state or an external third-party system. */
  openWorldHint?: boolean;
  /** Declare that calling the tool repeatedly with the same arguments has no additional effect. */
  idempotentHint?: boolean;
  /** Short human-readable label shown in tool pickers */
  title?: string;
}

export type TokenType = 'oauth' | 'session' | 'pat' | 'anonymous';

export interface ToolSourceContext {
  platform?: string;
  conversationId?: string;
  channelId?: string;
  teamId?: string;
  connectionId?: string;
  userId?: string;
  source?: string;
}

/**
 * Tool execution context from authentication
 * Passed to all tool handlers for organization scoping
 */
export interface ToolContext {
  /** User's organization ID - REQUIRED for all operations */
  organizationId: string;
  /** Host-provided conversation correlation id, when the MCP client exposes one. */
  mcpConversationId?: string | null;
  /** User ID from OAuth token, PAT, or session (null for anonymous public reads) */
  userId: string | null;
  /** Caller's role in the organization (null for non-members reading a public workspace). */
  memberRole: string | null;
  /** Durable Lobu/Lobu agent identity bound to this MCP session, when provided. */
  agentId?: string | null;
  /**
   * The automation whose reaction script is driving these tool calls, when the
   * session IS an automation reaction (set by the reaction executor). Every gated
   * write then resolves this automation's owning agent and evaluates autonomously,
   * WITHOUT the script having to pass `automation_source` — so a reaction can never
   * escape its agent's envelope by simply omitting the attribution. Null for all
   * non-reaction sessions.
   */
  actingAutomationId?: number | null;
  /** Durable automation run driving this reaction and its child work. */
  actingRunId?: number | null;
  /** Verified source conversation for worker-originated tool calls, when any. */
  sourceContext?: ToolSourceContext | null;
  /** `x-lobu-apply-id` when this call belongs to a `lobu apply` run (REST proxy only). */
  applyId?: string | null;
  /** Server-only seed shared by browser operations within one SDK invocation. */
  sdkBrowserInvocation?: { nonce: string; title: string };
  /** Persistent MCP session id driving this call; null off the MCP transport. */
  mcpSessionId?: string | null;
  /** True only for an MCP session that negotiated the standard Apps UI extension. */
  mcpAppsSupported?: boolean | null;
  /**
   * True when this call is a nested SDK method rather than the directly
   * advertised tool call, so its result mounts no card of its own.
   *
   * Deliberately NOT `mcpAppsSupported`: a host can render a card without
   * negotiating the Apps extension (claude.ai does), so negotiation cannot
   * stand in for "this result is displayed". What decides whether to echo the
   * saved payload is whether anything will render it, and a nested
   * `client.knowledge.save` inside `run_sdk` never does.
   */
  headlessResult?: boolean | null;
  /** Host-only encrypted token supplied by the Lobu MCP App for one approval click. */
  mcpAppApprovalCapability?: string | null;
  /** Host-only encrypted token proving an event action came from a rendered MCP App result. */
  mcpAppEventActionCapability?: string | null;
  /**
   * Server-derived side-effect mode for the run driving these tool calls,
   * carried as a signed worker-token claim. `capture` marks an eval replay:
   * `run_sdk` then routes every non-read SDK method through the sandbox's
   * existing capture path, recording the attempted call and its arguments
   * instead of dispatching it, and `complete_window` records the extraction on
   * the run's `dry_run_preview` rather than committing the result — that lane does
   * NOT go through the sandbox, so it honours this flag itself.
   * Null/absent means live.
   */
  executionMode?: 'live' | 'capture' | null;
  /** Verified capture owner; never taken from tool arguments. */
  captureIdentity?: CaptureIdentity | null;
  /** Whether request was authenticated */
  isAuthenticated: boolean;
  /** OAuth client ID that created this request (null for session/anonymous) */
  clientId?: string | null;
  /** OAuth scopes granted to this MCP/tool session, when applicable. */
  scopes?: string[] | null;
  tokenType: TokenType;
  /** True when the MCP URL pinned an org slug (e.g. `/mcp/acme`). */
  scopedToOrg: boolean;
  /**
   * Whether `client.org(slug)` is allowed inside the sandbox. True only for a
   * bare `/mcp` OAuth context with an explicit effective grant and no bound identity.
   */
  allowCrossOrg: boolean;
  /** Explicit OAuth workspace snapshot; null for PAT/session/internal contexts. */
  grantedOrganizationIds: string[] | null;
  /** Whether an unqualified direct search should fan out over live grants. */
  directSearchFederation: boolean;
  /**
   * Set by the sandbox when the script's wall-clock budget runs out. Handlers
   * that opt in (today: `query_sql` and `client.query`) race their work
   * against this signal so the awaiting caller unblocks immediately. The
   * underlying postgres connection isn't cancelled — `statement_timeout` is
   * the actual server-side cap.
   */
  abortSignal?: AbortSignal;
  /** Original request URL, used to derive public-facing origin for URL generation */
  requestUrl?: string;
  /** PUBLIC_GATEWAY_URL env var fallback for URL generation when requestUrl is unreliable */
  baseUrl?: string;
}

/** Account dispatch may have no execution workspace; leaf handlers remain workspace-bound. */
export type AccountToolContext = Omit<ToolContext, 'organizationId'> & { organizationId: string | null };

interface ToolDefinitionMetadata {
  name: string;
  description: string;
  inputSchema: any; // JSON Schema
  /** Explicit workspace selector shared by discovery and dispatch. */
  workspaceTarget?: string;
  /**
   * Narrower schema advertised on `tools/list` when the tool accepts fields
   * that are server-internal (e.g. pre-computed embeddings, identity-bound
   * filters the server populates from auth context). Validation still runs
   * against the full `inputSchema`, so internal callers and tests keep working;
   * only the client-facing listing is narrowed. Falls back to `inputSchema`.
   */
  publicInputSchema?: any; // JSON Schema
  annotations?: ToolAnnotations;
  /**
   * Internal access classification. This is deliberately separate from the
   * public `readOnlyHint`: OAuth and PAT invocations append an audit/activity
   * record, while these operations still require only `mcp:read`.
   */
  authorizationReadOnly?: boolean;
  /**
   * JSON Schema describing the tool's structured result. When present, the
   * `tools/call` response carries matching `structuredContent` alongside the
   * text `content` (MCP spec: declaring `outputSchema` implies the result is
   * structured). TypeBox schemas carry their JSON Schema at runtime, so a tool
   * that derives its result type via `Static<typeof ResultSchema>` can hand the
   * same schema object here — one source of truth, no drift.
   */
  outputSchema?: any; // JSON Schema
  /** OAuth scopes advertised to MCP hosts for this tool. */
  securityScopes?: string[];
  /** MCP extension metadata, such as an Apps UI resource linkage. */
  mcpMeta?: Record<string, unknown>;
}

export type ToolDefinition<T = any> = ToolDefinitionMetadata & (
  | { scope: 'account'; handler: (args: T, env: Env, ctx: AccountToolContext) => Promise<any> }
  | { scope?: 'workspace'; handler: (args: T, env: Env, ctx: ToolContext) => Promise<any> }
);

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

// OpenAI Apps submission semantics reserve `openWorldHint` for tools that can
// CHANGE public internet or third-party state. Live reads from a user's private
// connectors remain closed-world even though they contact an external service.
//
// These operations retrieve data, but every OAuth and PAT invocation appends an
// audit/activity record, and `readOnlyHint` asserts the tool "does not modify
// its environment" — that append does, so the hint cannot be claimed. Access
// enforcement stays separate through `authorizationReadOnly`, so a read grant
// still invokes these tools while the SDK keeps rejecting data writes.
const AUDITED_READ = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
} as const;

const WRITE_WITHOUT_CONFIRM: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};

const LOBU_VIEW_MCP_META = {
  ui: {
    resourceUri: LOBU_INTERACTION_RESOURCE_URI,
    visibility: ['model', 'app'],
  },
  'openai/outputTemplate': LOBU_INTERACTION_RESOURCE_URI,
  'openai/widgetAccessible': true,
  'openai/toolInvocation/invoking': 'Loading Lobu',
  'openai/toolInvocation/invoked': 'Lobu ready',
} as const;

const SaveMemorySchema = Type.Object({
  ...SaveContentSchema.properties,
  org_slug: Type.Optional(Type.String({ minLength: 1, description: 'Target workspace for a bare OAuth call. Required when the connection has no workspace binding.' })),
});

/**
 * Tools advertised on MCP `tools/list` and external OpenAPI.
 *
 * The data and action tools here (search_memory, search_sdk, query_sdk,
 * query_sql, run_sdk) deliberately have no Apps UI resource: agents can chain
 * reads and general SDK actions without mounting an iframe for every
 * intermediate result. save_memory is the one exception among them — its single
 * durable write is itself the final result a person inspects, so it mounts one
 * card for the event it just created. Approval review is the other explicit UI
 * surface: get_approval returns the canonical durable approval and its
 * app-only resolver performs the human's decision.
 */
const AGENT_TOOLS: ToolDefinition[] = [
  // ─── Memory hot path — read ───────────────────────────────────────────────
  {
    name: 'search_memory',
    scope: 'account',
    description:
      'Search local saved workspace memory: entities, facts, decisions, preferences, observations, notes, and authorized channel transcripts. To open a known memory, event, or content ID, pass query: "memory 1234" and include_content: true. entity_id is only for entity records, never memory IDs. Source-backed feeds are never queried implicitly; `coverage` reports local stores searched and visible source feeds with status `not_queried`, which agents can read explicitly through query_sdk client.feeds.readMany. Pair writes with `save_memory`. The search does not change workspace content or external systems. OAuth and PAT calls append a private audit/activity record.',
    inputSchema: SearchSchema,
    // Advertise the narrower public schema: query_embedding (server pre-compute
    // optimization) and agent_id (auth-bound) are server-internal, not client
    // affordances. See search.ts → PublicSearchSchema.
    publicInputSchema: PublicSearchSchema,
    outputSchema: UnifiedSearchResultSchema,
    annotations: { ...AUDITED_READ, title: 'Search memory' },
    authorizationReadOnly: true,
    securityScopes: ['mcp:read'],
    handler: search,
  },
  {
    name: 'save_memory',
    workspaceTarget: 'org_slug',
    description:
      'Save user-shared facts, preferences, decisions, observations, and notes to workspace memory. The returned id is immediately readable with `client.knowledge.read`; the result also echoes the bounded saved payload for inline display. Semantic search indexing is asynchronous and reported as `indexing_status`. Storage is append-only — pass `supersedes_event_id` to replace an existing fact (the old event is hidden from future searches without losing history). Use a stable `idempotency_key` when a write may be retried. Optionally attach to entities via `entity_ids`. Always search first to avoid duplicates.',
    inputSchema: SaveMemorySchema,
    outputSchema: SaveContentResultSchema,
    annotations: { ...WRITE_WITHOUT_CONFIRM, title: 'Save memory' },
    securityScopes: ['mcp:write'],
    mcpMeta: LOBU_VIEW_MCP_META,
    handler: withValidatedArgs('save_memory', SaveMemorySchema, (args: Static<typeof SaveMemorySchema>, env: Env, ctx: ToolContext) => {
      const { org_slug: _target, ...content } = args;
      return saveContent(content, env, ctx);
    }),
  },
  {
    name: 'search_sdk',
    scope: 'account',
    description:
      'Discover available SDK methods and runtime helpers. Search by method name, namespace (e.g. "entities", "connections", "automations"), or keyword. Returns documentation, signatures, and access requirements for each method. (Then call methods via query_sdk for reads or run_sdk for writes. Pass mode="read" to show only query_sdk-safe methods.) The search does not change workspace content or external systems. OAuth and PAT calls append a private audit/activity record.',
    inputSchema: SdkSearchSchema,
    outputSchema: SdkSearchResultSchema,
    annotations: { ...AUDITED_READ, title: 'Search SDK docs' },
    authorizationReadOnly: true,
    securityScopes: ['mcp:read'],
    handler: sdkSearch,
  },
  // ─── Power tools — TS scripting + raw SQL ─────────────────────────────────
  {
    name: 'query_sdk',
    scope: 'account',
    description:
      'Run capability-scoped, read-only TypeScript through the Lobu SDK. On bare OAuth /mcp, select a workspace with await client.org(target) before workspace methods. Query entities, relationships, feeds, operations, metrics, and authorized connected-source data; write, administrative, and external-action methods are rejected by the sandbox. Use `run_sdk` for mutations, `search_sdk` to discover methods, and `await ctx.sleep(ms)` for bounded polling. Lobu appends a private audit/activity record for the invocation.',
    inputSchema: QuerySchema,
    outputSchema: SdkScriptResultSchema,
    // Private connector reads do not mutate an external/public system.
    annotations: { ...AUDITED_READ, title: 'Query SDK (read-only)' },
    authorizationReadOnly: true,
    securityScopes: ['mcp:read'],
    handler: querySdkScript,
  },
  {
    name: 'query_sql',
    workspaceTarget: 'org_slug',
    description:
      'Run a paginated, sortable, searchable read-only SQL query (member-safe). Table references auto-scope to the bound org, or pass `connection` to push read-only SQL fully into an external database connector. Source-backed feeds are queried explicitly with query_sdk client.feeds.readMany. Prefer client.metrics.query for declared measures; use client.query in query_sdk for simple one-shot SQL. Do NOT use positional parameters ($1, $2, …). `org_slug` selects a granted workspace on bare OAuth /mcp and is required when the connection has no workspace binding. The query does not change workspace content or external systems, but Lobu appends a private audit/activity record for the invocation.',
    inputSchema: QuerySqlSchema,
    outputSchema: QuerySqlResultSchema,
    annotations: { ...AUDITED_READ, title: 'Query SQL' },
    authorizationReadOnly: true,
    securityScopes: ['mcp:read'],
    handler: querySql,
  },
  {
    name: 'run_sdk',
    scope: 'account',
    description:
      'Execute a capability-scoped Lobu SDK script. On bare OAuth /mcp, select workspace operations with await client.org(target); account discovery and conversation titles require no target. The script can create, update, or delete Lobu data and invoke connector, agent, or device operations only through documented `client` methods; workspace permissions, operation policies, human approvals, and audit remain enforced. Use `query_sdk` for reads, `search_sdk` to discover methods, and `dry_run=true` to preview write, administrative, or external calls without executing them. For connector setup, do the authorized SDK work first using connections.connect or connections.reauthenticate. When human input is required, use only exact URLs returned by tools, explain which account/app and permissions the user is authorizing, and follow the returned resume_call/completion_check. Never invent setup URLs or ask for OAuth client secrets in chat; use the returned browser setup form. Resume the requested work after verifying authorization completed.',
    inputSchema: RunSchema,
    mcpMeta: { 'openai/fileParams': ['files'] },
    outputSchema: SdkScriptResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
      title: 'Run SDK',
    },
    securityScopes: ['mcp:write'],
    handler: runSdkScript,
  },
];

/**
 * Presentation tools listed only on MCP `tools/list`. They stay executable by
 * name for MCP dispatch, but are absent from `AGENT_TOOL_NAMES`,
 * `getAllTools`, `getRawDispatchTools`, and `REST_DISPATCH_TOOL_NAMES`, keeping
 * them out of REST, OpenAPI, and the ClientSDK.
 */
const MCP_APP_TOOLS: ToolDefinition[] = [
  {
    name: 'get_approval',
    workspaceTarget: 'organization',
    scope: 'account',
    description:
      'Get the server-authored review card for one approval run returned by a pending action. On an unscoped OAuth session, pass organization with the target workspace slug or id. The card reads the canonical durable approval, exposes in-card controls only when this OAuth app context can resolve it, and always includes a review link while pending. Reading does not change workspace content or external systems. OAuth and PAT calls append a private audit/activity record.',
    inputSchema: GetApprovalSchema,
    outputSchema: LobuViewSchema,
    annotations: { ...AUDITED_READ, title: 'Get approval' },
    authorizationReadOnly: true,
    securityScopes: ['mcp:read'],
    mcpMeta: LOBU_VIEW_MCP_META,
    handler: getApproval,
  },
  {
    name: 'resolve_approval',
    scope: 'account',
    description:
      'Resolve the exact pending approval represented by this Lobu MCP App. This tool is app-only and requires the hidden, host-bound capability delivered with the review card.',
    inputSchema: ResolveApprovalSchema,
    outputSchema: LobuViewSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
      title: 'Resolve approval',
    },
    securityScopes: ['mcp:write'],
    mcpMeta: {
      ui: {
        visibility: ['app'],
      },
    },
    handler: resolveApproval,
  },
  {
    name: 'invoke_event_action',
    scope: 'account',
    description:
      'Append the declared event for a JSON-template interaction using the signed-in MCP App user as the actor. The server revalidates the source event, rendered action/value, and event-kind registry.',
    inputSchema: InvokeEventActionSchema,
    outputSchema: InvokeEventActionResultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
      title: 'Invoke event action',
    },
    securityScopes: ['mcp:write'],
    mcpMeta: {
      ui: {
        visibility: ['app'],
      },
    },
    handler: invokeEventAction,
  },
];

/**
 * Admin + first-party REST dispatch tools. Callable via `POST /api/:org/:toolName`
 * and MCP `tools/call` by name, but omitted from MCP `tools/list` — agents use
 * `search_sdk` → `query_sdk` / `run_sdk` instead.
 */
const INTERNAL_DISPATCH_TOOLS: ToolDefinition[] = [
  ...ADMIN_TOOLS,
  {
    name: 'list_organizations',
    scope: 'account',
    description:
      'List organizations the authenticated user belongs to, plus any public workspaces the session can read. Managed connector providers include structured managed_auth onboarding metadata. SDK alternative: client.organizations.list via `query_sdk` / `run_sdk`.',
    inputSchema: ListOrganizationsSchema,
    annotations: { ...READ_ONLY, title: 'List organizations' },
    handler: (args, env, ctx) => {
      if (!ctx.userId) throw new Error('User context required.');
      return listOrganizations(args, env, {
        userId: ctx.userId,
        currentOrganizationId: ctx.organizationId,
        grantedOrganizationIds: ctx.grantedOrganizationIds,
      });
    },
  },
  {
    name: 'list_metrics',
    description:
      'List governed declared and SQL-derived metrics per entity type, including business KPIs such as spend and net worth. SDK alternative: client.metrics.list.',
    inputSchema: ListMetricsSchema,
    annotations: { ...READ_ONLY, title: 'List metrics' },
    handler: listMetrics,
  },
  {
    name: 'query_metric',
    description:
      'Run a governed declared or SQL-derived measure, such as spend or net worth. SDK alternative: client.metrics.query.',
    inputSchema: QueryMetricSchema,
    annotations: { ...READ_ONLY, title: 'Query metric' },
    handler: queryMetric,
  },
  {
    name: 'metric_series',
    description:
      'Read-only time-series SQL for dashboard sparklines. SDK alternative: client.metrics.series.',
    inputSchema: MetricSeriesSchema,
    annotations: { ...READ_ONLY, title: 'Metric series' },
    handler: metricSeries,
  },
  {
    name: 'resolve_path',
    scope: 'account',
    description:
      'Resolve a namespace-based URL path like /acme/entity-type/entity-slug into namespace and entity details. Returns template_data with executed data source query results when templates define data_sources.',
    inputSchema: ResolvePathSchema,
    outputSchema: ResolvePathResultSchema,
    annotations: { ...READ_ONLY, title: 'Resolve path' },
    handler: resolvePath,
  },
];

const ALL_MCP_TOOLS: ToolDefinition[] = [...AGENT_TOOLS, ...MCP_APP_TOOLS];
const ALL_DISPATCH_TOOLS: ToolDefinition[] = [...AGENT_TOOLS, ...INTERNAL_DISPATCH_TOOLS];
const ALL_EXECUTABLE_TOOLS: ToolDefinition[] = [...ALL_DISPATCH_TOOLS, ...MCP_APP_TOOLS];

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOLS.map((tool) => tool.name));

const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(
  INTERNAL_DISPATCH_TOOLS.map((tool) => tool.name)
);
const REST_DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set(
  ALL_DISPATCH_TOOLS.map((tool) => tool.name)
);

// ============================================
// Helper Functions
// ============================================

const DISPATCH_BY_NAME: Map<string, ToolDefinition> = new Map(
  ALL_EXECUTABLE_TOOLS.map((tool) => [tool.name, tool])
);

/**
 * Get tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return DISPATCH_BY_NAME.get(name);
}

export function isInternalDispatchTool(name: string): boolean {
  return INTERNAL_TOOL_NAMES.has(name);
}

export function isRestDispatchTool(name: string): boolean {
  return REST_DISPATCH_TOOL_NAMES.has(name);
}

/**
 * Flatten a TypeBox Union (anyOf) schema into a single object schema.
 * Each variant must be an object with an `action` literal discriminator.
 * Result: single object with `action` as a string enum (description
 * generated from the variants — see `buildActionEnumDescription`), all
 * other properties merged (first occurrence wins; only `action` is
 * required on the wire, per-action required fields surface in prose).
 */
function flattenUnionSchema(schema: any): any {
  const variants: any[] = schema.anyOf || schema.oneOf;
  const actionValues: string[] = [];
  const actionDescriptions = new Map<string, string>();
  const actionRequired = new Map<string, string[]>();
  const mergedProperties: Record<string, any> = {};

  for (const variant of variants) {
    if (variant.type !== 'object' || !variant.properties) continue;
    const actionProp = variant.properties.action;
    const actionName = actionProp?.const;
    if (typeof actionName !== 'string') continue;
    actionValues.push(actionName);
    if (typeof actionProp?.description === 'string') {
      actionDescriptions.set(actionName, actionProp.description);
    }
    // Variant's `required` array carries non-Optional prop names — the
    // basis for the per-action "Required: ..." line in the enum description.
    const requiredFields = (variant.required ?? []).filter((k: string) => k !== 'action');
    if (requiredFields.length > 0) {
      actionRequired.set(actionName, requiredFields);
    }
    for (const [key, prop] of Object.entries<any>(variant.properties)) {
      if (key === 'action') continue;
      // First occurrence wins (keeps description from the first variant that defines it)
      if (!mergedProperties[key]) {
        mergedProperties[key] = prop;
      }
    }
  }

  return {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: actionValues,
        description: buildActionEnumDescription(actionValues, actionDescriptions, actionRequired),
      },
      ...mergedProperties,
    },
    required: ['action'],
  };
}

/**
 * Build a multi-line description for the flattened `action` enum. Each line
 * names one action and its purpose, followed by its required fields when the
 * variant declared any (beyond `action`). The purpose text is sourced from
 * each variant's `action: Type.Literal(name, { description })` — colocated
 * with the handler, so it can't drift from the schema. Falls back to a bare
 * `- name` line when no description is declared for an action.
 */
function buildActionEnumDescription(
  actionValues: string[],
  actionDescriptions: Map<string, string>,
  actionRequired: Map<string, string[]>
): string {
  const lines: string[] = ['Action to perform.'];
  for (const name of actionValues) {
    const purpose = actionDescriptions.get(name);
    const head = purpose ? `- ${name}: ${purpose}` : `- ${name}`;
    const required = actionRequired.get(name);
    lines.push(
      required && required.length > 0 ? `${head} Required: ${required.join(', ')}.` : head
    );
  }
  return lines.join('\n');
}

/**
 * Ensure an outputSchema is advertised as an OBJECT schema, as the MCP spec
 * requires. TypeBox serializes `Type.Union([Type.Object(...), ...])` to a bare
 * `{ anyOf: [...] }` with no top-level `type`; a validating host rejects that
 * (or the paired structuredContent). Unlike inputSchema we do NOT flatten the
 * union into a single merged object — the discriminated variants are the
 * correct description of a result — we only add the missing `type: "object"`.
 * A schema that is already an object (or otherwise typed) is returned as-is.
 */
function normalizeOutputSchema(schema: any): any {
  if (schema && (schema.anyOf || schema.oneOf) && schema.type === undefined) {
    return { type: 'object' as const, ...schema };
  }
  return schema;
}

function filterSchemaForPublicActions(toolName: string, schema: any): any | null {
  const allowedActions = getPublicReadableActions(toolName);
  if (allowedActions === undefined) return null;
  if (allowedActions === null) return schema;

  const variants: any[] = schema?.anyOf || schema?.oneOf;
  if (!Array.isArray(variants)) return schema;

  const filteredVariants = variants.filter((variant) => {
    const actionConst = variant?.properties?.action?.const;
    return typeof actionConst === 'string' && allowedActions.has(actionConst);
  });

  if (filteredVariants.length === 0) return null;
  return {
    ...schema,
    ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
    ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
  };
}

function accessLevelRank(level: 'read' | 'write' | 'admin'): number {
  if (level === 'read') return 1;
  if (level === 'write') return 2;
  return 3;
}

export function isAuthorizationReadOnly(tool: ToolDefinition | undefined): boolean {
  return tool?.authorizationReadOnly ?? (tool?.annotations?.readOnlyHint === true);
}

function filterSchemaForAccessLevel(
  toolName: string,
  schema: any,
  readOnlyHint: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin'
): any | null {
  const toolAccess = getRequiredAccessLevel(toolName, {}, readOnlyHint);
  if (accessLevelRank(toolAccess) <= accessLevelRank(maxAccessLevel)) {
    const variants: any[] = schema?.anyOf || schema?.oneOf;
    if (!Array.isArray(variants)) return schema;

    const filteredVariants = variants.filter((variant) => {
      const actionConst = variant?.properties?.action?.const;
      if (typeof actionConst !== 'string') return false;
      return (
        accessLevelRank(getRequiredAccessLevel(toolName, { action: actionConst }, readOnlyHint)) <=
        accessLevelRank(maxAccessLevel)
      );
    });

    if (filteredVariants.length === 0) return null;
    return {
      ...schema,
      ...(schema.anyOf ? { anyOf: filteredVariants } : {}),
      ...(schema.oneOf ? { oneOf: filteredVariants } : {}),
    };
  }

  return null;
}

// Memoize listed tool shapes per (surface × filter tuple).
const listedToolsCache = new Map<string, ReturnType<typeof computeListedTools>>();

type ListedToolOptions = {
  /** Bare account MCP has no implicit target. */
  requireWorkspaceTarget?: boolean;
  publicOnly?: boolean;
  maxAccessLevel?: 'read' | 'write' | 'admin';
  /**
   * Advertise the progressive `mcp:admin` elevation on `run_sdk` only when
   * the authenticated organization role can actually receive that scope.
   * Regular members keep the existing write-only contract.
   */
  adminScopeEligible?: boolean;
};

/**
 * Agent-facing tools for MCP `tools/list` and external OpenAPI.
 */
export function getMcpTools(options?: ListedToolOptions) {
  const tools = getListedTools(ALL_MCP_TOOLS, options);
  if (!options?.requireWorkspaceTarget) return tools;
  // Never mutate cached schemas: a bound connection may list immediately after
  // an account connection in the same process.
  return tools.map((tool) => {
    const field = getTool(tool.name)?.workspaceTarget;
    if (!field) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        required: [...new Set([...(tool.inputSchema.required ?? []), field])],
      },
    };
  });
}

/**
 * All dispatch tools for REST `GET /api/:org/tools` (admin entries carry
 * `internal: true` for CLI filtering). Execution uses `getTool` across both sets.
 */
export function getAllTools(options?: ListedToolOptions) {
  const listed = getListedTools(ALL_DISPATCH_TOOLS, options);
  return listed.map((tool) =>
    INTERNAL_TOOL_NAMES.has(tool.name) ? { ...tool, internal: true as const } : tool
  );
}

export interface RawDispatchTool {
  name: string;
  description: string;
  /** Original TypeBox input schema — discriminated union preserved (NOT flattened). */
  inputSchema: any;
  /** Original TypeBox output schema when the tool declares one. */
  outputSchema?: any;
  annotations?: ToolAnnotations;
  /** True for admin/first-party dispatch tools hidden from MCP `tools/list`. */
  internal: boolean;
}

/**
 * Every dispatch tool with its RAW TypeBox input/output schemas, unflattened.
 *
 * `getAllTools`/`getMcpTools` return the MCP-listing projection: discriminated
 * unions are collapsed by `flattenUnionSchema` (Claude/ChatGPT reject top-level
 * `anyOf`) and per-action required fields are demoted to prose. The typed REST
 * client has no such constraint — hey-api turns an `anyOf` of action variants
 * into a precise discriminated-union type — so the strict OpenAPI document is
 * built from these raw definitions to keep full per-action fidelity. One
 * TypeBox source, two projections: flattened for MCP, faithful for the client.
 */
export function getRawDispatchTools(): RawDispatchTool[] {
  return ALL_DISPATCH_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Prefer the narrower public schema (same choice as the MCP listing): it
    // drops server-internal fields a client must never send (e.g. search_memory's
    // pre-computed `query_embedding` and auth-bound `agent_id`). Unflattened,
    // unlike the MCP projection.
    inputSchema: tool.publicInputSchema ?? tool.inputSchema,
    ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
    ...(tool.annotations && { annotations: tool.annotations }),
    internal: INTERNAL_TOOL_NAMES.has(tool.name),
  }));
}

function getListedTools(source: ToolDefinition[], options?: ListedToolOptions) {
  const publicOnly = options?.publicOnly ?? false;
  const maxAccessLevel = options?.maxAccessLevel ?? 'admin';
  const adminScopeEligible = options?.adminScopeEligible ?? false;
  const sourceKey = source === ALL_MCP_TOOLS ? 'mcp' : 'all';
  const cacheKey = `${sourceKey}:${publicOnly ? 1 : 0}:${maxAccessLevel}:${adminScopeEligible ? 1 : 0}`;
  let cached = listedToolsCache.get(cacheKey);
  if (!cached) {
    cached = computeListedTools(source, publicOnly, maxAccessLevel, adminScopeEligible);
    listedToolsCache.set(cacheKey, cached);
  }
  return cached;
}

function computeListedTools(
  source: ToolDefinition[],
  publicOnly: boolean,
  maxAccessLevel: 'read' | 'write' | 'admin',
  adminScopeEligible: boolean
) {
  return source
    .filter((tool) => !publicOnly || getPublicReadableActions(tool.name) !== undefined)
    .map((tool) => {
      // Advertise the narrower `publicInputSchema` when a tool declares one;
      // validation still runs against the full `inputSchema` so internal
      // server-supplied fields (e.g. embeddings, auth-bound filters) are
      // accepted at the handler boundary but never advertised to clients.
      let inputSchema = tool.publicInputSchema ?? tool.inputSchema;
      const authorizationReadOnly = isAuthorizationReadOnly(tool);

      if (publicOnly) {
        inputSchema = filterSchemaForPublicActions(tool.name, inputSchema);
      }
      if (!inputSchema) return null;

      // Each scheme is an alternative; scopes within a scheme are all required.
      // Keep ordinary writes callable at write tier, while declaring optional
      // elevation for nested admin methods only when the user's role allows it.
      // The SDK dispatch still enforces each method's scope and membership role.
      const securitySchemes = tool.securityScopes
        ? [
            { type: 'oauth2' as const, scopes: getMcpConnectionScopes(tool.securityScopes) },
            ...(tool.name === 'run_sdk' && adminScopeEligible
              ? [
                  {
                    type: 'oauth2' as const,
                    scopes: getMcpConnectionScopes([...tool.securityScopes, 'mcp:admin']),
                  },
                ]
              : []),
          ]
        : undefined;

      inputSchema = filterSchemaForAccessLevel(
        tool.name,
        inputSchema,
        authorizationReadOnly,
        maxAccessLevel
      );
      if (!inputSchema) return null;

      // Claude API rejects anyOf/oneOf/allOf at the top level of input_schema.
      // Flatten discriminated Union schemas into a single object.
      if (inputSchema.anyOf || inputSchema.oneOf) {
        inputSchema = flattenUnionSchema(inputSchema);
      } else if (inputSchema.type !== 'object') {
        inputSchema = { type: 'object' as const, ...inputSchema };
      }

      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        ...(tool.annotations && { annotations: tool.annotations }),
        ...(securitySchemes && { securitySchemes }),
        ...(tool.mcpMeta && { _meta: tool.mcpMeta }),
        // outputSchema keeps its discriminated variants (no flattening, no
        // access-level filtering — those are input concerns) but the MCP spec
        // requires a tool's outputSchema to be an OBJECT schema. TypeBox
        // serializes a `Type.Union` of object variants to a bare `{ anyOf: [...] }`
        // with no top-level `type`, which a validating host rejects. Stamp
        // `type: "object"` on top so the union is advertised as a valid object
        // schema while the `anyOf` still tells the client which variant applied.
        ...(tool.outputSchema && {
          outputSchema: normalizeOutputSchema(tool.outputSchema),
        }),
      };
    })
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
}
