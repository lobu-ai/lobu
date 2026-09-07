/**
 * Tool: search_memory
 *
 * Search existing entities and saved memory in the database.
 * Searches all entity types when entity_type not specified.
 * For new entities, write a TS script for `run_sdk` that calls
 * `client.entities.create(...)` then `client.connections.create(...)`.
 */

import { type Static, Type } from '@sinclair/typebox';
import {
  hasRequiredMcpScope,
  resolveSdkMaxAccessLevel,
  type ToolAccessLevel,
} from '../auth/tool-access';
import {
  type GrantedMemberWorkspace,
  listLiveGrantedMemberWorkspaces,
  resolveGrantedWorkspaceTarget,
} from '../auth/oauth/workspace-grants';
import { isInProcessSystemCall } from './access-control';
import { AUDIT_SEMANTIC_TYPE } from './constants';
import { evaluateEntityMutation, resolveActingPrincipal } from '../authz/entity-policy';
import { type AuthzScope, authzScopeFromToolContext } from '../authz/scope';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { getDb } from '../db/client';
import type { Env } from '../index';
import type { ContentItem } from '@lobu/connector-sdk';
import {
  connectionLinkedEntityIdsSql,
  connectionLinkedToBusinessEntitySql,
} from '../authz/channel-about';
import { entityLinkMatchSql, searchContentByText } from '../utils/content-search';
import { resolveBoundChannelRows, stripPlatformPrefix } from '../gateway/channels/bound-channels';
import { filterChannelsForRequester } from '../authz/channel-visibility';
import { redactConnectionRows } from '../utils/connection-config-redaction';
import { toVectorLiteral } from '../utils/entity-management';
import { generateEmbeddings } from '../utils/embeddings';
import { ToolUserError } from '../utils/errors';
import logger from '../utils/logger';
import { expandSearchQueries } from '../utils/query-expansion';
import { buildEntityUrl, getPublicWebUrl } from '../utils/url-builder';
import { getWorkspaceProvider } from '../workspace';
import { getContent } from './get_content';
import type { ToolContext } from './registry';
import { markAcceptedInternalFields, withValidatedArgs } from './validate-args';
import { getErrorMessage } from '@lobu/core';
import {
  PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS,
  type SearchArgs,
  SearchSchema,
} from '@lobu/core/contracts/tools/search-memory';

// ============================================
// Typebox Schema
// ============================================
//
// `SearchSchema` lives in `@lobu/core/contracts/tools/search-memory` so the
// connector SDK can derive its published input type from the SAME declaration
// this handler enforces. Re-exported below because `registry.ts` imports it
// from this module.
//
// Inside the server, always import these from here rather than reaching for
// the core contract directly: the `markAcceptedInternalFields` stamp runs on
// THIS module's load, so a caller that bypasses it can validate against a
// schema that has not been stamped yet.

// Keeps `query_embedding` / `agent_id` VALID for the argument validator while
// omitting them from its "valid arguments are: …" error text — otherwise a
// mistyped arg teaches an agent that they exist. Which fields those are is
// contract data and lives with the schema; stamping them on is the
// validator's job and stays here.
markAcceptedInternalFields(SearchSchema, PUBLIC_SEARCH_SCHEMA_INTERNAL_FIELDS);

export {
  PublicSearchSchema,
  type PublicSearchArgs,
  SearchSchema,
} from '@lobu/core/contracts/tools/search-memory';

export function resolveEntityLimit(args: SearchArgs): number {
  const defaultLimit = args.query_embedding?.length ? 20 : (args.fuzzy ?? true) ? 5 : 1;
  return Math.min(args.limit ?? defaultLimit, 100);
}

// ============================================
// Type Definitions
// ============================================

// Unified entity with all fields (nulls where not applicable)
export const EntitySchema = Type.Object({
  id: Type.Integer(),
  type: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  parent_id: Type.Union([Type.Integer(), Type.Null()]),
  parent_name: Type.Union([Type.String(), Type.Null()]),
  parent_slug: Type.Union([Type.String(), Type.Null()]),
  parent_entity_type: Type.Union([Type.String(), Type.Null()]),
  organization_slug: Type.Union([Type.String(), Type.Null()]),
  workspace_slug: Type.Union([Type.String(), Type.Null()]),
  stats: Type.Object({
    content_count: Type.Integer(),
    connection_count: Type.Integer(),
    active_connection_count: Type.Integer(),
    children_count: Type.Integer(), // child count for root entities
    automation_count: Type.Integer(),
  }),
  match_score: Type.Number(),
  match_reason: Type.String(),
});
export type Entity = Static<typeof EntitySchema>;

const ConnectionInfoSchema = Type.Object({
  connection_id: Type.Integer(),
  connector_key: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  config: Type.Record(Type.String(), Type.Unknown()),
  entity_names: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.String(),
  updated_at: Type.Union([Type.String(), Type.Null()]),
  content_count: Type.Integer(),
  entity_id: Type.Integer(),
  workspace_slug: Type.String(),
});
type ConnectionInfo = Static<typeof ConnectionInfoSchema>;

interface EntityQueryRow {
  id: number;
  organization_id: string;
  name: string;
  entity_type: string;
  slug: string;
  metadata: Record<string, unknown> | null;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  content_count: number;
  connection_count: number;
  active_connection_count: number;
  children_count: number;
  automation_count: number;
  match_score?: number;
  match_reason?: string;
  organization_slug?: string | null;
  vector_similarity?: number;
}

interface ChildEntityRow {
  id: number;
  name: string;
  entity_type: string;
  market: string | null;
  content_count: number;
}

const ContentSnippetSchema = Type.Object({
  id: Type.Integer(),
  title: Type.Union([Type.String(), Type.Null()]),
  text_content: Type.String(),
  author_name: Type.Union([Type.String(), Type.Null()]),
  source_url: Type.Union([Type.String(), Type.Null()]),
  platform: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
  similarity: Type.Optional(Type.Number()),
  entity_ids: Type.Array(Type.Integer()),
  workspace_slug: Type.String(),
  /** Every granted workspace through which this stable event was visible. */
  workspace_slugs: Type.Array(Type.String()),
});
type ContentSnippet = Static<typeof ContentSnippetSchema>;

// A keyword/recency hit from the chat transcript (`channel_messages`). Distinct
// from ContentSnippet on purpose: these are NOT `events`, so their stable
// `message_id` is labeled explicitly (never pass it to get_content) and they
// carry no embedding similarity. They let search_memory surface past channel
// conversation without a separate get_channel_history tool.
const ConversationSnippetSchema = Type.Object({
  message_id: Type.Integer(),
  platform: Type.String(),
  channel_id: Type.String(),
  thread_id: Type.Union([Type.String(), Type.Null()]),
  author_name: Type.Union([Type.String(), Type.Null()]),
  /** The sender's resolved person/$member entity id (store-only attribution),
   * or null when unattributed (bot post / no team / unresolved). */
  author_entity_id: Type.Union([Type.Integer(), Type.Null()]),
  text: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
  workspace_slug: Type.String(),
});
type ConversationSnippet = Static<typeof ConversationSnippetSchema>;

const SourceFeedCoverageSchema = Type.Object({
  feed_id: Type.Integer(),
  feed_key: Type.String(),
  connection_slug: Type.String(),
  connector_key: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  status: Type.Literal('not_queried'),
  workspace_slug: Type.String(),
});

const WorkspaceCoverageSchema = Type.Object({
  workspace_slug: Type.String(),
  status: Type.Union([
    Type.Literal('complete'),
    Type.Literal('partial'),
    Type.Literal('unavailable'),
  ]),
  local_sources: Type.Array(
    Type.Union([Type.Literal('events'), Type.Literal('channel_messages')])
  ),
  source_queried: Type.Literal(false),
  source_feed_discovery: Type.Union([Type.Literal('complete'), Type.Literal('unavailable')]),
  source_feeds: Type.Array(SourceFeedCoverageSchema),
  more_source_feeds: Type.Boolean(),
});
type WorkspaceCoverage = Static<typeof WorkspaceCoverageSchema>;

const SearchCoverageSchema = Type.Object({
  scope: Type.Union([
    Type.Literal('current_workspace'),
    Type.Literal('selected_workspace'),
    Type.Literal('all_granted'),
  ]),
  status: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
  workspace_slug: Type.Optional(Type.String()),
  local_sources: Type.Array(
    Type.Union([Type.Literal('events'), Type.Literal('channel_messages')])
  ),
  source_queried: Type.Literal(false),
  source_feed_discovery: Type.Union([Type.Literal('complete'), Type.Literal('unavailable')]),
  source_feeds: Type.Array(SourceFeedCoverageSchema),
  more_source_feeds: Type.Boolean(),
  workspaces: Type.Optional(Type.Array(WorkspaceCoverageSchema)),
});
type SearchCoverage = Static<typeof SearchCoverageSchema>;

/**
 * Result of `search_memory`. TypeBox-first and the SINGLE source of truth:
 * `UnifiedSearchResult` is `Static<>`-derived from this schema, which is also
 * the tool's `outputSchema`. Every nested type (Entity, ConnectionInfo,
 * ContentSnippet, ConversationSnippet) is itself
 * schema-derived, so there is no hand-written interface that can drift.
 */
export const UnifiedSearchResultSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description: "The caller-supplied human-friendly heading for this result, echoed back for the UI.",
      maxLength: 200,
    })
  ),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity: Type.Union([EntitySchema, Type.Null()]),
  matches: Type.Array(EntitySchema),
  connections: Type.Optional(Type.Array(ConnectionInfoSchema)),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Integer(),
        name: Type.String(),
        type: Type.String(),
        market: Type.Union([Type.String(), Type.Null()]),
        content_count: Type.Integer(),
        parent_entity_id: Type.Integer(),
        workspace_slug: Type.String(),
      })
    )
  ),
  content: Type.Optional(Type.Array(ContentSnippetSchema)),
  /** Past chat-channel messages matching the query, scoped to the agent's own
   * bound channels. Replaces the get_channel_history tool — read past convos
   * through the same search call. */
  conversation_messages: Type.Optional(Type.Array(ConversationSnippetSchema)),
  /** Honest search boundary: local stores searched and visible source feeds that
   * were deliberately not queried. Use `feeds.readMany` for source access. */
  coverage: Type.Optional(SearchCoverageSchema),
  discovery_status: Type.Optional(
    Type.Union([Type.Literal('not_found'), Type.Literal('complete'), Type.Literal('discovering')])
  ),
  suggestion: Type.Optional(Type.String()),
  view_url: Type.Optional(Type.String()),
  metadata: Type.Object({
    total_matches: Type.Integer(),
    page_size: Type.Integer(),
  }),
});
export type UnifiedSearchResult = Static<typeof UnifiedSearchResultSchema>;

// ============================================
// Result Helpers
// ============================================

function emptyResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    entity_type: null,
    entity: null,
    matches: [],
    discovery_status: 'not_found',
    metadata: { total_matches: 0, page_size: 0 },
    ...overrides,
  };
}

function withRecall<T extends UnifiedSearchResult>(
  result: T,
  recall: Partial<UnifiedSearchResult>
): T {
  // Each recall source already omits its facet when empty, so a plain merge is
  // enough — no per-facet guards, no type-switch.
  return Object.assign(result, recall);
}

type SearchToolContext = ToolContext & {
  /** Immutable consent snapshot. Null/absent is legacy anchor-only. */
  grantedOrganizationIds?: readonly string[] | null;
  /** True only for a direct tool call on an unscoped OAuth MCP connection. */
  directSearchFederation?: boolean;
};

interface WorkspaceSearchExecution {
  workspaceSlug: string;
  recallQueryEmbedding?: number[];
  /** The federation layer already attempted embedding generation once. */
  preventShardEmbeddingGeneration?: boolean;
  /** Public-catalog entity resolved once and formatted on the first shard. */
  preResolvedEntity?: EntityQueryRow;
  /** Entity authorization shared with content-only shards. */
  authorizedEntityId?: number;
  coverageScope?: SearchCoverage['scope'];
}

function applyCoverageScope(
  result: UnifiedSearchResult,
  execution: WorkspaceSearchExecution
): UnifiedSearchResult {
  if (result.coverage) {
    result.coverage.scope = execution.coverageScope ?? 'current_workspace';
  }
  return result;
}

const FEDERATED_SEARCH_CONCURRENCY = 4;
const MAX_CHILDREN = 20;

function workspaceUnavailable(): ToolUserError {
  // Deliberately identical for unknown, ungranted, and no-longer-member
  // targets. Do not turn the optional workspace selector into an org oracle.
  return new ToolUserError('Workspace is not available for this connection.', 403);
}

async function currentWorkspaceSlug(organizationId: string): Promise<string | null> {
  return getWorkspaceProvider().getOrgSlug(organizationId);
}

async function resolveSingleWorkspace(
  args: SearchArgs,
  ctx: SearchToolContext
): Promise<{ workspaceSlug: string; scope: SearchCoverage['scope'] }> {
  const workspaceSlug = await currentWorkspaceSlug(ctx.organizationId);
  if (!workspaceSlug) throw workspaceUnavailable();
  const requested = args.workspace?.trim();
  if (requested && requested !== workspaceSlug && requested !== ctx.organizationId) {
    throw workspaceUnavailable();
  }
  return {
    workspaceSlug,
    scope: requested ? 'selected_workspace' : 'current_workspace',
  };
}

async function resolveFederatedTargets(
  args: SearchArgs,
  ctx: SearchToolContext
): Promise<GrantedMemberWorkspace[]> {
  if (!ctx.userId) return [];
  const grantedOrganizationIds = ctx.grantedOrganizationIds ?? [];
  if (args.workspace?.trim()) {
    const target = await resolveGrantedWorkspaceTarget({
      userId: ctx.userId,
      grantedOrganizationIds,
      slugOrId: args.workspace,
    });
    if (!target) throw workspaceUnavailable();
    return [target];
  }
  return listLiveGrantedMemberWorkspaces({
    userId: ctx.userId,
    grantedOrganizationIds,
  });
}

async function sharedRecallEmbedding(
  args: SearchArgs,
  env: Env
): Promise<{ embedding?: number[]; attempted: boolean }> {
  if (
    args.query_embedding?.length ||
    !(args.include_content ?? true) ||
    !args.query?.trim() ||
    parseExactContentId(args.query) !== null ||
    !env.EMBEDDINGS_SERVICE_URL
  ) {
    return {
      ...(args.query_embedding?.length ? { embedding: args.query_embedding } : {}),
      attempted: false,
    };
  }
  try {
    const embeddings = await generateEmbeddings([args.query.trim()], env);
    return { ...(embeddings[0] ? { embedding: embeddings[0] } : {}), attempted: true };
  } catch (err) {
    logger.warn(
      { err: getErrorMessage(err) },
      '[search] shared embedding failed; federated recall will use text only'
    );
    return { attempted: true };
  }
}

async function settleWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(values[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker())
  );
  return results;
}

function deduplicateBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const stableKey = key(value);
    if (seen.has(stableKey)) continue;
    seen.add(stableKey);
    unique.push(value);
  }
  return unique;
}

function mergeContentProvenance(values: readonly ContentSnippet[]): ContentSnippet[] {
  const byId = new Map<number, ContentSnippet>();
  for (const value of values) {
    const existing = byId.get(value.id);
    if (!existing) {
      byId.set(value.id, {
        ...value,
        workspace_slugs: Array.from(
          new Set([value.workspace_slug, ...(value.workspace_slugs ?? [])])
        ).sort(),
      });
      continue;
    }
    existing.workspace_slugs = Array.from(
      new Set([
        ...existing.workspace_slugs,
        existing.workspace_slug,
        value.workspace_slug,
        ...(value.workspace_slugs ?? []),
      ])
    ).sort();
  }
  return [...byId.values()];
}

function asWorkspaceCoverage(
  workspace: GrantedMemberWorkspace,
  result: UnifiedSearchResult
): WorkspaceCoverage {
  const coverage = result.coverage;
  return {
    workspace_slug: workspace.slug,
    status: coverage?.status ?? 'complete',
    local_sources: coverage?.local_sources ?? [],
    source_queried: false,
    source_feed_discovery: coverage?.source_feed_discovery ?? 'complete',
    source_feeds: coverage?.source_feeds ?? [],
    more_source_feeds: coverage?.more_source_feeds ?? false,
  };
}

function unavailableWorkspaceCoverage(workspace: GrantedMemberWorkspace): WorkspaceCoverage {
  return {
    workspace_slug: workspace.slug,
    status: 'unavailable',
    local_sources: [],
    source_queried: false,
    source_feed_discovery: 'unavailable',
    source_feeds: [],
    more_source_feeds: false,
  };
}

/**
 * Access tier the empty-result guidance should speak to.
 *
 * In-process system callers (automation reactions) carry no user identity, so
 * `resolveSdkMaxAccessLevel` floors them at 'read' — but `save_content` and the
 * entity-write path bypass their gates for exactly those contexts, so read-only
 * copy would state a falsehood to a caller that CAN persist. Treat them as
 * write: they get the persist block, without the admin-only type-creation hop.
 */
function guidanceAccessTier(
  ctx: ToolContext,
  memberRole: string | null = ctx.memberRole ?? null
): ToolAccessLevel {
  if (isInProcessSystemCall(ctx)) return 'write';
  return resolveSdkMaxAccessLevel(memberRole, ctx.scopes);
}

/**
 * Best role the caller actually holds across the workspaces a federated merge
 * covers. The outer context carries no role on a bare cross-workspace grant, so
 * scoring it directly would floor every federated caller at read; coercing it to
 * 'owner' — as this did first — went the other way and offered admin-only type
 * creation to a caller who is merely a member everywhere. The real roles are on
 * the shard targets, so use the strongest one: if any workspace makes them an
 * admin, `entitySchema.createType` is reachable in at least one place.
 */
export function highestGrantedRole(
  targets: readonly GrantedMemberWorkspace[]
): string | null {
  let best: string | null = null;
  for (const target of targets) {
    if (target.role === 'owner') return 'owner';
    if (target.role === 'admin') best = 'admin';
    else if (target.role && best === null) best = target.role;
  }
  return best;
}

function buildEmptySearchSuggestion(
  query: string | null,
  args: SearchArgs,
  coverage?: SearchCoverage,
  callerMax?: ToolAccessLevel
): string {
  const isFederated = coverage?.scope === 'all_granted';
  const queryLabel = !isFederated && query ? ` for "${query}"` : '';
  const scopeLabel = isFederated
    ? 'in the currently accessible workspaces granted to this connection'
    : 'in saved workspace memory';

  const lines: string[] = [`No matches found${queryLabel} ${scopeLabel}.`];

  lines.push('');
  lines.push('**Additional steps to read relevant data:**');

  const sourceFeeds = coverage?.source_feeds ?? [];
  if (sourceFeeds.length > 0) {
    const feedSamples = sourceFeeds
      .slice(0, 3)
      .map((f) => `\`${f.connection_slug}/${f.feed_key}\``)
      .join(', ');
    const moreSuffix = sourceFeeds.length > 3 ? ` and ${sourceFeeds.length - 3} more` : '';
    lines.push(
      `1. **Check unqueried source feeds:** Connected feeds are not queried automatically. Inspect \`coverage.source_feeds\` (${feedSamples}${moreSuffix}) and pass each entry's \`feed_id\` to \`client.feeds.readMany({ reads: [{ feed_id }] })\` via \`query_sdk\` to read external source data directly.`
    );
  } else {
    lines.push(
      '1. **Check connected source feeds:** Connected feeds are not queried automatically. List them with `client.feeds.list()` and read them with `client.feeds.readMany({ reads: [...] })` via `query_sdk`.'
    );
  }

  // The literals come from the shared constant so the SQL and the filter we
  // hand the agent cannot drift from the value audit events are written with.
  lines.push(
    `2. **Check activity and audit records:** tool invocations and other operational events are written to \`events\` with no body text and no embedding, so semantic recall cannot rank them and only their titles are searchable. Read them explicitly with \`query_sql\` (e.g. \`SELECT id, title, semantic_type, occurred_at FROM events WHERE semantic_type = '${AUDIT_SEMANTIC_TYPE}' ORDER BY occurred_at DESC LIMIT 50\`) or with \`client.knowledge.read({ semantic_type: '${AUDIT_SEMANTIC_TYPE}' })\` through \`query_sdk\`.`
  );

  const filterRelaxations: string[] = [];
  if (args.entity_type) {
    filterRelaxations.push(`remove entity_type='${args.entity_type}'`);
  }
  if (args.workspace) {
    filterRelaxations.push(
      `omit workspace='${args.workspace}' to search every workspace this connection can reach`
    );
  }
  filterRelaxations.push('lower min_similarity (default 0.3)');
  filterRelaxations.push('try alternate keywords or synonyms');
  lines.push(
    `3. **Broaden the search:** retry with one of these relaxations: ${filterRelaxations.join('; ')}.`
  );

  lines.push('');
  // Every line below is write-tier: `save_memory` is a member-write action and
  // `run_sdk` — the only route to `entities.create` — requires write access
  // too, so a read-tier caller would be denied on both. Name the boundary
  // instead of handing it two calls that cannot run. An absent tier (the
  // exported merge helper called without one) keeps the write-tier text.
  if (callerMax === 'read') {
    lines.push(
      '**If this is new knowledge to persist:** this caller has read-only access to the workspace, so `save_memory` and entity creation would be denied. Reconnect with write access, or ask a workspace member to persist it.'
    );
    return lines.join('\n');
  }

  lines.push('**If this is new knowledge to persist:**');
  lines.push('- To save facts or notes: call `save_memory` with content and semantic_type.');
  // Only a single-workspace text search names one entity worth pre-filling:
  // federated results span workspaces, and an embedding-only call has no query
  // text at all. Both fall back to a placeholder in the SAME angle-bracket
  // shape as `<slug>` below — a bare `...` reads as copyable literal.
  const newEntityName = !isFederated && query ? query : '<entity_name>';
  // `entitySchema.createType` is admin-tier while `entities.create` is write.
  // Telling a member to create the type sends them at a call that will deny,
  // so below admin we name the reachable half and say who can do the rest.
  const canCreateEntityType = callerMax === 'admin';
  lines.push(
    canCreateEntityType
      ? `- To create a new entity: its type must exist first (\`client.entitySchema.listTypes()\` to check, \`client.entitySchema.createType(...)\` for a type new to this workspace), then call \`run_sdk\` with \`await client.entities.create({ entity_type: '<slug>', name: '${newEntityName}' })\`.`
      : `- To create a new entity: pick a type that already exists (\`client.entitySchema.listTypes()\`), then call \`run_sdk\` with \`await client.entities.create({ entity_type: '<slug>', name: '${newEntityName}' })\`. Creating a brand-new entity type needs admin access, so ask a workspace admin if none of the existing types fit.`
  );

  return lines.join('\n');
}

export function mergeFederatedSearchResults(
  args: SearchArgs,
  targets: readonly GrantedMemberWorkspace[],
  settled: readonly PromiseSettledResult<UnifiedSearchResult>[],
  callerMax?: ToolAccessLevel
): UnifiedSearchResult {
  const fulfilled = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
  if (fulfilled.length === 0) {
    throw new ToolUserError('Search is temporarily unavailable for this connection.', 503);
  }

  const entityLimit = resolveEntityLimit(args);
  const contentLimit = Math.min(args.content_limit ?? 5, 50);
  const allMatches = deduplicateBy(
    fulfilled.flatMap((result) => result.matches),
    (entity) => String(entity.id)
  ).sort((a, b) => b.match_score - a.match_score);
  const top = allMatches[0] ?? null;
  const topNameMatches = top
    ? allMatches.filter(
        (match) => match.name.trim().toLocaleLowerCase() === top.name.trim().toLocaleLowerCase()
      )
    : [];
  const ambiguousTop =
    top !== null &&
    new Set(
      topNameMatches
        .map((match) => match.workspace_slug)
        .filter((slug): slug is string => Boolean(slug))
    ).size > 1;
  // Treat cross-workspace exact-name ambiguity like LIMIT ... WITH TIES. The
  // ordinary global limit still bounds unrelated results, but it must not hide
  // the candidates the caller needs in order to choose a workspace safely.
  const matches = ambiguousTop
    ? deduplicateBy(
        [...allMatches.slice(0, entityLimit), ...topNameMatches],
        (match) => String(match.id)
      ).slice(0, 50)
    : allMatches.slice(0, entityLimit);
  const content = mergeContentProvenance(fulfilled.flatMap((result) => result.content ?? []))
    .sort((a, b) => {
      const score = Number(b.similarity ?? 0) - Number(a.similarity ?? 0);
      if (score !== 0) return score;
      return String(b.occurred_at ?? '').localeCompare(String(a.occurred_at ?? ''));
    })
    .slice(0, contentLimit);
  const conversationMessages = deduplicateBy(
    fulfilled.flatMap((result) => result.conversation_messages ?? []),
    (item) => `${item.workspace_slug}:${item.message_id}`
  )
    .sort((a, b) => {
      const occurred = String(b.occurred_at ?? '').localeCompare(String(a.occurred_at ?? ''));
      return occurred !== 0 ? occurred : b.message_id - a.message_id;
    })
    .slice(0, contentLimit);
  const connections = deduplicateBy(
    fulfilled.flatMap((result) => result.connections ?? []),
    (item) => String(item.connection_id)
  ).slice(0, 20);
  const children = deduplicateBy(
    fulfilled.flatMap((result) => result.children ?? []),
    (item) => String(item.id)
  ).slice(0, MAX_CHILDREN);

  const entity = ambiguousTop ? null : top;
  const selectedResult = entity
    ? fulfilled.find((result) => result.entity?.id === entity.id)
    : undefined;

  const workspaceCoverage = settled.map((item, index) =>
    item.status === 'fulfilled'
      ? asWorkspaceCoverage(targets[index], item.value)
      : unavailableWorkspaceCoverage(targets[index])
  );
  const status = workspaceCoverage.some((entry) => entry.status !== 'complete')
    ? 'partial'
    : 'complete';
  const localSources = Array.from(
    new Set(workspaceCoverage.flatMap((entry) => entry.local_sources))
  ) as SearchCoverage['local_sources'];
  const sourceFeeds = deduplicateBy(
    workspaceCoverage.flatMap((entry) => entry.source_feeds),
    (feed) => String(feed.feed_id)
  ).slice(0, MAX_SOURCE_FEEDS_IN_COVERAGE);
  const coverage: SearchCoverage = {
    scope: args.workspace ? 'selected_workspace' : 'all_granted',
    status,
    local_sources: localSources,
    source_queried: false,
    source_feed_discovery: workspaceCoverage.every(
      (entry) => entry.source_feed_discovery === 'complete'
    )
      ? 'complete'
      : 'unavailable',
    source_feeds: sourceFeeds,
    more_source_feeds:
      workspaceCoverage.some((entry) => entry.more_source_feeds) ||
      workspaceCoverage.reduce((count, entry) => count + entry.source_feeds.length, 0) >
        sourceFeeds.length,
    workspaces: workspaceCoverage,
  };

  const hasAnyRecall = content.length > 0 || conversationMessages.length > 0;
  const hasAnyResult = matches.length > 0 || hasAnyRecall;
  const title = args.title?.trim() || undefined;
  const result: UnifiedSearchResult = {
    ...(title ? { title } : {}),
    entity_type:
      entity?.type ??
      args.entity_type ??
      (matches.length > 0 && matches.every((match) => match.type === matches[0].type)
        ? matches[0].type
        : null),
    entity,
    matches,
    ...(connections.length > 0 ? { connections } : {}),
    ...(children.length > 0 ? { children } : {}),
    ...((args.include_content ?? true) ? { content } : {}),
    ...(conversationMessages.length > 0 ? { conversation_messages: conversationMessages } : {}),
    coverage,
    // A failed shard means absence is not established. Keep the result
    // non-final so callers cannot turn a partial read into create/write
    // coaching for an entity that may exist in the unavailable workspace.
    discovery_status: hasAnyResult ? 'complete' : status === 'partial' ? 'discovering' : 'not_found',
    suggestion: ambiguousTop
      ? `Found "${top?.name}" in more than one workspace. Pass workspace to narrow before acting.`
      : status === 'partial'
        ? 'Search returned partial results; one or more granted workspaces was temporarily unavailable.'
        : matches.length === 0 && !hasAnyRecall
          ? buildEmptySearchSuggestion(args.query ?? null, args, coverage, callerMax)
          : selectedResult?.suggestion,
    ...(entity && selectedResult?.view_url ? { view_url: selectedResult.view_url } : {}),
    metadata: {
      total_matches: allMatches.length,
      page_size: matches.length,
    },
  };
  return result;
}

function parseExactContentId(query: string | undefined): number | null {
  if (!query) return null;
  const trimmed = query.trim();
  // Exact-id mode must consume the WHOLE query. A phrase such as "compare
  // event 123 with Acme" is semantic search, not permission to discard the
  // rest of the user's words and open one record directly.
  const match = trimmed.match(
    /^(?:#?(\d+)|(?:memory|content(?:\s+id)?|event(?:\s+id)?)\s*(?:#|:)?\s*(\d+))$/i
  );
  if (!match) return null;
  const id = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toExactContentSnippet(item: ContentItem, workspaceSlug: string): ContentSnippet | null {
  const id = Number(item.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    title: typeof item.title === 'string' ? item.title : null,
    text_content:
      typeof item.text_content === 'string'
        ? item.text_content
        : typeof item.payload_text === 'string'
          ? item.payload_text
          : '',
    author_name: typeof item.author_name === 'string' ? item.author_name : null,
    source_url: typeof item.source_url === 'string' ? item.source_url : null,
    platform:
      typeof item.platform === 'string' && item.platform.length > 0 ? item.platform : 'lobu',
    occurred_at: typeof item.occurred_at === 'string' ? item.occurred_at : null,
    similarity: 1,
    entity_ids: Array.isArray(item.entity_ids)
      ? item.entity_ids.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
      : [],
    workspace_slug: workspaceSlug,
    workspace_slugs: [workspaceSlug],
  };
}

async function recallExactContentId(
  contentId: number,
  env: Env,
  ctx: ToolContext,
  workspaceSlug: string
): Promise<UnifiedSearchResult | null> {
  const exact = await getContent({ content_ids: [contentId], limit: 50 }, env, ctx);
  const exactItems = (Array.isArray(exact.content) ? exact.content : []) as ContentItem[];
  const content = exactItems
    .filter((item) => Number(item.id) === contentId)
    .map((item) => toExactContentSnippet(item, workspaceSlug))
    .filter((item): item is ContentSnippet => item !== null);
  if (content.length === 0) return null;

  return emptyResult({
    content,
    discovery_status: 'complete',
    metadata: { total_matches: content.length, page_size: content.length },
  });
}

// ============================================
// Main Function
// ============================================

async function fetchContentSnippets(
  gate: AuthzScope,
  workspaceSlug: string,
  query: string | null,
  contentLimit: number,
  env?: Env,
  queryEmbedding?: number[],
  agentId?: string,
  minSimilarity?: number,
  excludeWorkspaceAudit?: boolean,
  entityId?: number
): Promise<ContentSnippet[]> {
  const result = await searchContentByText(
    query,
    {
      organization_id: gate.organizationId,
      ...(entityId != null && {
        entity_id: entityId,
        strict_organization_scope: true,
      }),
      ...(excludeWorkspaceAudit && { exclude_workspace_audit: true }),
      // Enforce the org/private-connection visibility boundary on the recall
      // path, exactly as get_content does. Without visibility_scope the
      // connection-visibility clause is skipped entirely, so search_memory
      // (publicly readable) would expose another member's private-connection
      // content. See get-content-visibility / search-cross-org tests.
      visibility_scope: {
        organizationId: gate.organizationId,
        userId: gate.principal,
      },
      limit: contentLimit,
      // The caller's `min_similarity` is the advertised recall floor (schema:
      // 0.0-1.0, default 0.3). It used to be hardcoded to 0.4 here, so the knob
      // was completely inert: sweeping 0 → 1.0 never changed the result set, and
      // the documented default was silently overridden. Pass `undefined` through
      // rather than defaulting here — `search-path.ts` already applies the SAME
      // documented 0.3 (and clamps it to [0,1]); a second copy of the constant
      // could silently drift from the one that actually reaches the SQL.
      min_similarity: minSimilarity,
      query_embedding: queryEmbedding,
      agent_id: agentId,
      // Recall wants the most *relevant* matching content, not the most recent.
      // This also opts into the bounded recall-only candidate path (the implicit
      // default is a chronological date feed).
      sort_by: 'score',
      approximate_candidate_search: true,
    },
    env
  );

  return result.content.map((c) => {
    // payload_text is `string | null` (a content row can have no text body).
    // Coalesce to '' — both to avoid `.length`/`.slice` throwing on null and to
    // keep the (non-nullable) `text_content` schema field honest: "" is the
    // correct representation of no text, so structuredContent stays valid.
    const text = c.payload_text ?? '';
    return {
      id: c.id,
      title: c.title,
      text_content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
      author_name: c.author_name,
      source_url: c.source_url,
      platform: c.platform,
      occurred_at: c.occurred_at,
      similarity: c.similarity,
      entity_ids: Array.isArray(c.entity_ids) ? c.entity_ids.map(Number) : [],
      workspace_slug: workspaceSlug,
      workspace_slugs: [workspaceSlug],
    };
  });
}

// Generic "what did we talk about" recall words carry no signal against a
// transcript — if a prompt is ONLY these, keyword matching would return nothing,
// so we fall back to recency (the "catch me up" case get_channel_history served).
const RECALL_STOPWORDS = new Set([
  'the',
  'and',
  'you',
  'our',
  'what',
  'did',
  'was',
  'were',
  'are',
  'has',
  'had',
  'about',
  'talk',
  'talked',
  'talking',
  'discuss',
  'discussed',
  'discussion',
  'earlier',
  'previous',
  'prev',
  'past',
  'before',
  'recent',
  'recently',
  'lately',
  'message',
  'messages',
  'thread',
  'threads',
  'conversation',
  'conversations',
  'history',
  'said',
  'say',
  'tell',
  'told',
  'catch',
  'again',
  'this',
  'that',
  'they',
  'them',
  'here',
  'there',
  'with',
  'from',
  'your',
  'mine',
  'last',
  'into',
]);

/**
 * Keyword/recency hits from the chat transcript (`channel_messages`) — no
 * embeddings. Scoped HARD to the channels the calling agent is bound to
 * (`resolveBoundChannelRows`), which IS the per-agent tenant fence:
 * channel_messages has no agent_id/user_id of its own, so an agent may only
 * recall its own conversations, exactly like read_conversation. channel_messages
 * carries only the recency index, so the scan is bounded to those channels.
 *
 * The bound-channel set is then INTERSECTED with what the requesting USER may
 * read (`filterChannelsForRequester`): for a connection whose channel-ACL graph
 * is materialized + fresh, a channel survives only if the user is `member_of`
 * it, so an agent acting for a user never surfaces a channel the user isn't in.
 * Connections without a fresh ACL graph pass through on the per-agent fence
 * alone (no runtime change). See authz/channel-visibility.
 *
 * Distinctive terms are AND-matched (ILIKE). A prompt with NO distinctive term
 * ("what did we talk about earlier") falls back to the most recent messages in
 * the agent's channels rather than returning nothing.
 */
async function fetchConversationSnippets(
  gate: AuthzScope,
  workspaceSlug: string,
  query: string,
  limit: number
): Promise<ConversationSnippet[]> {
  const sql = getDb();
  // The calling agent (the transcript tenant fence) MUST be present — the
  // conversation reader guards on it before calling, and we defend here too.
  if (!gate.agentId) return [];
  const boundChannels = await resolveBoundChannelRows(sql, {
    organizationId: gate.organizationId,
    agentId: gate.agentId,
  });
  if (boundChannels.length === 0) return [];
  // Per-user ACL gate: drop channels the requester isn't a member of, for
  // connections that have a fresh channel-ACL graph. Non-enforced connections
  // are returned unchanged, so this is a no-op until a workspace is graphed.
  const channels = await filterChannelsForRequester(sql, {
    organizationId: gate.organizationId,
    userId: gate.principal,
    rows: boundChannels,
  });
  if (channels.length === 0) return [];

  // Distinctive >2-char terms (generic recall words dropped). Tokenize on word
  // characters, NOT whitespace — otherwise trailing punctuation ("earlier?",
  // "revenue?") survives as an unmatchable term that both defeats the stopword
  // filter and makes the ILIKE miss. Tokens are alphanumeric, so no LIKE
  // metacharacter (`%` `_` `\`) can appear and no escaping is needed.
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 2 && !RECALL_STOPWORDS.has(t))
    .slice(0, 8);

  // (connection_id, channel_id) pairs the agent can see. A binding's channel_id
  // may be platform-prefixed (`slack:C…`); channel_messages stores the bare id.
  let pairFilter = sql``;
  channels.forEach((c, i) => {
    const channelId = stripPlatformPrefix(c.platform, c.channel_id);
    const clause = sql`(cm.connection_id = ${c.id} AND cm.channel_id = ${channelId})`;
    pairFilter = i === 0 ? clause : sql`${pairFilter} OR ${clause}`;
  });

  // No distinctive term → recency fallback (all channels), else AND of ILIKEs.
  let termFilter = sql`TRUE`;
  terms.forEach((t, i) => {
    const clause = sql`cm.text ILIKE ${`%${t}%`}`;
    termFilter = i === 0 ? clause : sql`${termFilter} AND ${clause}`;
  });

  const rows = (await sql`
    SELECT cm.id, cm.platform, cm.channel_id, cm.thread_id, cm.author_name,
           cm.author_entity_id, cm.text, cm.occurred_at
    FROM channel_messages cm
    WHERE cm.organization_id = ${gate.organizationId}
      AND (${pairFilter})
      AND (${termFilter})
    ORDER BY cm.occurred_at DESC
    LIMIT ${limit}
  `) as Array<{
    id: number | string;
    platform: string;
    channel_id: string;
    thread_id: string | null;
    author_name: string | null;
    author_entity_id: number | string | null;
    text: string;
    occurred_at: Date | null;
  }>;

  return rows.map((r) => ({
    message_id: Number(r.id),
    platform: r.platform,
    channel_id: r.channel_id,
    thread_id: r.thread_id,
    author_name: r.author_name,
    author_entity_id: r.author_entity_id == null ? null : Number(r.author_entity_id),
    text: r.text.length > 500 ? `${r.text.slice(0, 500)}...` : r.text,
    occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    workspace_slug: workspaceSlug,
  }));
}

export interface RecallContext {
  query: string | null;
  /** Memory-scope filter for events content — the caller-supplied agent_id arg.
   * This is a CONTENT filter (which agent's memory), NOT a gate field; the
   * tenant/principal/calling-agent identity travels on the {@link AuthzScope}. */
  contentAgentId: string | undefined;
  contentLimit: number;
  env?: Env;
  queryEmbedding?: number[];
  /** Caller-supplied similarity floor for recalled content (schema 0.0-1.0,
   * default 0.3). Undefined means "use the documented default". */
  minSimilarity?: number;
  /** Exclude workspace-identity audit events (metadata.category='workspace')
   * for non-member readers of public workspaces. */
  excludeWorkspaceAudit?: boolean;
  /** Conjunctive entity scope for `{ entity_id, query }` recall. */
  entityId?: number;
  /** Workspace provenance attached to every returned local row. */
  workspaceSlug: string;
}

const MAX_SOURCE_FEEDS_IN_COVERAGE = 10;

async function discoverSourceFeeds(gate: AuthzScope, workspaceSlug: string) {
  const sql = getDb();
  const vis = compileConnectionRowVisibility(gate, 'c');
  const rows = (await sql.unsafe(
    `SELECT f.id AS feed_id, f.feed_key, f.display_name,
            c.slug AS connection_slug, c.connector_key
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     WHERE f.organization_id = $1
       AND f.deleted_at IS NULL
       AND f.status = 'active'
       AND c.deleted_at IS NULL
       AND c.status = 'active'
       AND COALESCE((
         SELECT definition.feeds_schema -> f.feed_key -> 'operations'
         FROM connector_definitions definition
         WHERE definition.key = c.connector_key
           AND definition.organization_id = f.organization_id
           -- Same definition selection as readSourceFeed: a pinned artifact may
           -- have no matching definition row after a device-manifest upgrade, so
           -- the active definition for the key remains capability truth.
           AND (
             (f.pinned_version IS NULL AND definition.status = 'active')
             OR (
               f.pinned_version IS NOT NULL
               AND (definition.version = f.pinned_version OR definition.status = 'active')
             )
           )
         ORDER BY (definition.version = f.pinned_version) DESC,
                  (definition.status = 'active') DESC,
                  definition.updated_at DESC,
                  definition.id DESC
         LIMIT 1
       ), '[]'::jsonb) @> '["read"]'::jsonb
       ${vis}
     ORDER BY f.id
     LIMIT ${MAX_SOURCE_FEEDS_IN_COVERAGE + 1}`,
    [gate.organizationId]
  )) as unknown as Array<{
    feed_id: number;
    feed_key: string;
    display_name: string | null;
    connection_slug: string;
    connector_key: string;
  }>;
  return {
    feeds: rows.slice(0, MAX_SOURCE_FEEDS_IN_COVERAGE).map((row) => ({
      ...row,
      feed_id: Number(row.feed_id),
      status: 'not_queried' as const,
      workspace_slug: workspaceSlug,
    })),
    more: rows.length > MAX_SOURCE_FEEDS_IN_COVERAGE,
  };
}

/**
 * Assemble the coverage facet. `discovered` is the settled result of
 * {@link discoverSourceFeeds}: a rejection degrades discovery to `unavailable`
 * rather than failing the search, since coverage is metadata about the answer,
 * not the answer.
 */
function buildCoverage(
  workspaceSlug: string,
  local_sources: SearchCoverage['local_sources'],
  discovered: PromiseSettledResult<Awaited<ReturnType<typeof discoverSourceFeeds>>>,
  localRecallFailed = false,
  scope: SearchCoverage['scope'] = 'current_workspace'
): SearchCoverage {
  if (discovered.status === 'rejected') {
    logger.warn(
      `[search] source feed coverage lookup failed: ${getErrorMessage(discovered.reason)}`
    );
    return {
      scope,
      status: 'partial',
      workspace_slug: workspaceSlug,
      local_sources,
      source_queried: false,
      source_feed_discovery: 'unavailable',
      source_feeds: [],
      more_source_feeds: false,
    };
  }
  return {
    scope,
    status: localRecallFailed ? 'partial' : 'complete',
    workspace_slug: workspaceSlug,
    local_sources,
    source_queried: false,
    source_feed_discovery: 'complete',
    source_feeds: discovered.value.feeds,
    more_source_feeds: discovered.value.more,
  };
}

async function coverageForLocalSources(
  gate: AuthzScope,
  workspaceSlug: string,
  local_sources: SearchCoverage['local_sources']
): Promise<SearchCoverage> {
  const [discovered] = await Promise.allSettled([discoverSourceFeeds(gate, workspaceSlug)]);
  return buildCoverage(workspaceSlug, local_sources, discovered);
}

/** Search local stores only. Source-backed feeds are enumerated in coverage but
 * never queried implicitly; each local store fails independently. */
export async function gatherLocalRecall(
  gate: AuthzScope,
  ctx: RecallContext
): Promise<Partial<UnifiedSearchResult>> {
  // Transcript rows have no entity_ids, so an entity-scoped query cannot
  // truthfully include them. Treat `{ entity_id, query }` as conjunctive.
  const shouldSearchConversation = Boolean(ctx.query && gate.agentId && ctx.entityId == null);
  const contentPromise = fetchContentSnippets(
    gate,
    ctx.workspaceSlug,
    ctx.query,
    ctx.contentLimit,
    ctx.env,
    ctx.queryEmbedding,
    ctx.contentAgentId,
    ctx.minSimilarity,
    ctx.excludeWorkspaceAudit,
    ctx.entityId
  );
  const conversationPromise = shouldSearchConversation
    ? fetchConversationSnippets(gate, ctx.workspaceSlug, ctx.query as string, ctx.contentLimit)
    : Promise.resolve(null);
  const coveragePromise = discoverSourceFeeds(gate, ctx.workspaceSlug);
  const [contentResult, conversationResult, sourceFeedsResult] = await Promise.allSettled([
    contentPromise,
    conversationPromise,
    coveragePromise,
  ]);

  const result: Partial<UnifiedSearchResult> = {};
  const local_sources: SearchCoverage['local_sources'] = [];
  let localRecallFailed = false;
  if (contentResult.status === 'fulfilled') {
    result.content = contentResult.value;
    local_sources.push('events');
  } else {
    localRecallFailed = true;
    logger.warn(`[search] local events recall failed: ${getErrorMessage(contentResult.reason)}`);
  }
  if (shouldSearchConversation && conversationResult.status === 'fulfilled') {
    local_sources.push('channel_messages');
    if (conversationResult.value && conversationResult.value.length > 0) {
      result.conversation_messages = conversationResult.value;
    }
  } else if (conversationResult.status === 'rejected') {
    localRecallFailed = true;
    logger.warn(
      `[search] local conversation recall failed: ${getErrorMessage(conversationResult.reason)}`
    );
  }

  result.coverage = buildCoverage(
    ctx.workspaceSlug,
    local_sources,
    sourceFeedsResult,
    localRecallFailed
  );
  return result;
}

export const search = withValidatedArgs('search_memory', SearchSchema, searchImpl);

async function searchImpl(
  args: SearchArgs,
  env: Env,
  rawCtx: ToolContext
): Promise<UnifiedSearchResult> {
  const ctx = rawCtx as SearchToolContext;
  if (!ctx.organizationId) {
    return emptyResult({
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      suggestion: 'No accessible entities found in this workspace scope',
    });
  }

  // Federation is deliberately narrower than "OAuth can address another
  // org". Only a DIRECT search call on bare `/mcp` receives this bit from the
  // request boundary; scoped endpoints, PAT/session calls, agent/Automation
  // runs, and nested SDK calls stay on their existing single-workspace path.
  if (
    !ctx.directSearchFederation ||
    ctx.agentId ||
    ctx.actingAutomationId ||
    ctx.headlessResult
  ) {
    const target = await resolveSingleWorkspace(args, ctx);
    return searchWorkspaceImpl(args, env, ctx, {
      workspaceSlug: target.workspaceSlug,
      coverageScope: target.scope,
    });
  }

  const targets = await resolveFederatedTargets(args, ctx);
  if (targets.length === 0) {
    return emptyResult({
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      suggestion: 'No accessible workspaces are granted to this connection.',
    });
  }
  const sharedEmbedding = await sharedRecallEmbedding(args, env);

  // A narrowed direct search is still routed through the grant resolver, but
  // does not need aggregation. This preserves the mature single-workspace
  // response while labeling its coverage as explicitly selected.
  if (targets.length === 1 && args.workspace) {
    const target = targets[0];
    return searchWorkspaceImpl(
      args,
      env,
      {
        ...ctx,
        organizationId: target.id,
        memberRole: target.role,
        allowCrossOrg: false,
        directSearchFederation: false,
      },
      {
        workspaceSlug: target.slug,
        recallQueryEmbedding: sharedEmbedding.embedding,
        preventShardEmbeddingGeneration: sharedEmbedding.attempted,
        coverageScope: 'selected_workspace',
      }
    );
  }

  // An explicit public entity is global reference data, so resolve it once.
  // Every granted workspace may then search only its own/bridged events for
  // that already-authorized id without repeatedly querying the public catalog.
  const publicEntity =
    args.entity_id && (args.include_public_catalogs ?? true)
      ? await fetchPublicEntityById(
          args.entity_id,
          authzScopeFromToolContext({
            organizationId: targets[0].id,
            userId: ctx.userId,
          })
        )
      : null;

  const settled = await settleWithConcurrency(
    targets,
    FEDERATED_SEARCH_CONCURRENCY,
    async (target, index) =>
      searchWorkspaceImpl(
        {
          ...args,
          // Public catalogs are global reference data. Query them on exactly
          // one shard, then stable-id dedupe with the workspace-local results.
          include_public_catalogs: args.entity_id
            ? false
            : index === 0
              ? (args.include_public_catalogs ?? true)
              : false,
        },
        env,
        {
          ...ctx,
          organizationId: target.id,
          memberRole: target.role,
          allowCrossOrg: false,
          directSearchFederation: false,
        },
        {
          workspaceSlug: target.slug,
          recallQueryEmbedding: sharedEmbedding.embedding,
          preventShardEmbeddingGeneration: sharedEmbedding.attempted,
          ...(index === 0 && publicEntity ? { preResolvedEntity: publicEntity } : {}),
          ...(publicEntity ? { authorizedEntityId: args.entity_id } : {}),
          coverageScope: 'all_granted',
        }
      )
  );

  for (const item of settled) {
    if (item.status === 'rejected') {
      // The response exposes only a sanitized availability state. Full errors
      // remain server-side, where they are actionable without becoming a
      // cross-workspace data side channel.
      logger.warn({ err: getErrorMessage(item.reason) }, '[search] workspace shard failed');
    }
  }
  return mergeFederatedSearchResults(
    args,
    targets,
    settled,
    guidanceAccessTier(ctx, highestGrantedRole(targets))
  );
}

/**
 * Drop entity hits the acting agent/automation is not allowed to read. Humans skip.
 * Default entity read is auto (unrestricted); a type-scoped deny removes those
 * results so search can't leak around manage_entity get/list.
 */
async function filterEntitiesByReadPolicy<T extends { entity_type: string }>(
  ctx: ToolContext,
  entities: T[]
): Promise<T[]> {
  if (entities.length === 0 || !ctx.organizationId) return entities;
  // Human-driven tools (no agent/automation) keep full org entity search.
  if (!ctx.agentId && !ctx.actingAutomationId) return entities;
  const actor = await resolveActingPrincipal(getDb(), {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    explicitAutomationId: null,
    sessionAutomationId: ctx.actingAutomationId ?? null,
  });
  if (actor.kind === 'user') return entities;
  const typeCache = new Map<string, boolean>();
  const out: T[] = [];
  for (const entity of entities) {
    const slug = entity.entity_type;
    let ok = typeCache.get(slug);
    if (ok === undefined) {
      const decision = await evaluateEntityMutation({
        organizationId: ctx.organizationId,
        principalKind: actor.kind,
        principalId: actor.id,
        ownerAgentId: actor.ownerAgentId,
        ownerResolved: actor.ownerResolved,
        action: 'read',
        entityTypeSlug: slug,
        sql: getDb(),
      });
      ok = decision === 'allow';
      typeCache.set(slug, ok);
    }
    if (ok) out.push(entity);
  }
  return out;
}

async function searchWorkspaceImpl(
  args: SearchArgs,
  env: Env,
  ctx: SearchToolContext,
  execution: WorkspaceSearchExecution
): Promise<UnifiedSearchResult> {
  // SDK delegates (`client.knowledge.search`) skip `checkToolAccess`, so
  // re-enforce the mcp:read scope here — but only for MCP token callers
  // (oauth/pat). Session/anonymous/system callers carry no MCP scope dimension
  // (they're gated by member role + public-readability at the query level), which
  // mirrors how extractAuthContext assigns scopes: real scopes for oauth/pat, a
  // not-applicable sentinel otherwise.
  const isMcpTokenCaller = ctx.tokenType === 'oauth' || ctx.tokenType === 'pat';
  if (isMcpTokenCaller && !hasRequiredMcpScope('read', ctx.scopes)) {
    throw new ToolUserError('search_memory requires an MCP session with read access.', 403);
  }

  const title = args.title?.trim() || undefined;
  const workspaceSlug = execution.workspaceSlug;

  const includeContent = args.include_content ?? true;
  const contentLimit = Math.min(args.content_limit ?? 5, 50);

  if (!ctx.organizationId) {
    return emptyResult({
      ...(title ? { title } : {}),
      suggestion: 'No accessible entities found in this workspace scope',
    });
  }

  // Validate: must have either query, ID, or embedding
  if (!args.query && !args.entity_id && !args.query_embedding?.length) {
    throw new ToolUserError('Must provide either query, entity_id, or query_embedding', 400);
  }

  // Type-scoped search: fail closed before querying when the agent can't read that type.
  if (args.entity_type) {
    const probe = await filterEntitiesByReadPolicy(ctx, [{ entity_type: args.entity_type }]);
    if (probe.length === 0) {
      throw new ToolUserError(
        `Policy denies reading entities of type '${args.entity_type}' for this principal.`,
        403
      );
    }
  }

  const connectionScope: AuthzScope = authzScopeFromToolContext({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentId: ctx.agentId,
  });

  // Preserve compatibility with reviewer prompts and user language such as
  // "open memory 1234". The public schema already accepts a query string,
  // so this server-side exact-read fast path fixes existing clients without a
  // metadata rescan. The canonical knowledge reader enforces tenant, connector,
  // entity-policy, and supersede-chain visibility before anything is returned.
  const exactContentId = includeContent && !args.entity_id ? parseExactContentId(args.query) : null;
  const exactContent =
    exactContentId === null
      ? null
      : await recallExactContentId(exactContentId, env, ctx, workspaceSlug);
  if (exactContent) {
    const result = title && !exactContent.title ? { ...exactContent, title } : exactContent;
    const withCoverage = withRecall(result, {
      coverage: await coverageForLocalSources(connectionScope, workspaceSlug, ['events']),
    });
    if (withCoverage.coverage) {
      withCoverage.coverage.scope = execution.coverageScope ?? 'current_workspace';
    }
    return withCoverage;
  }
  if (exactContentId !== null) {
    // Exact syntax is an exact read, even when the row is missing or outside
    // this workspace's visibility boundary. Never reinterpret `event 123` as
    // semantic text and accidentally return unrelated recall. The outward
    // shape deliberately does not distinguish missing from inaccessible.
    const result = emptyResult({
      ...(title ? { title } : {}),
      suggestion:
        `No readable memory record matches id ${exactContentId} in this workspace. ` +
        'To run a text search instead, add words around the number.',
    });
    return applyCoverageScope(
      withRecall(result, {
        coverage: await coverageForLocalSources(connectionScope, workspaceSlug, ['events']),
      }),
      execution
    );
  }

  // Helper to run content search in parallel. Runs when we have either a text
  // query or a pre-computed embedding — forwarding the embedding lets the
  // content layer skip regenerating it from text.
  const hasContentSignal = Boolean(args.query || args.query_embedding?.length);
  // The caller's bound agent (from auth context) scopes recall by default; an
  // explicit `agent_id` arg is still honored for server-internal cross-agent
  // recall, but is no longer advertised to clients (see PublicSearchSchema).
  // NOTE: deliberately NOT reading `metadata_filter.agent_id` — `metadata_filter`
  // is on the public schema, so honoring it would re-expose the very footgun
  // `PublicSearchSchema` hides.
  const agentIdScope = args.agent_id ?? ctx.agentId ?? undefined;
  // Channel recall is fenced to the CALLING agent's own bindings (ctx.agentId),
  // never a caller-supplied filter — that's the tenant boundary for transcript
  // rows, which have no agent_id of their own. Local stores fail independently.
  const recallFor = (entityId?: number): Promise<Partial<UnifiedSearchResult>> =>
    includeContent && hasContentSignal
      ? gatherLocalRecall(connectionScope, {
          query: args.query ?? null,
          contentAgentId: agentIdScope,
          contentLimit,
          // Federation owns the single embedding attempt. When it already ran
          // (successfully or not), omit the service env so content-search does
          // not retry independently on every shard after a shared failure.
          env: execution.preventShardEmbeddingGeneration ? undefined : env,
          // Explicit caller vectors retain their entity-ranking semantics;
          // federation's shared vector is recall-only so enabling federation
          // cannot silently change fuzzy entity ranking/default limits.
          queryEmbedding: args.query_embedding ?? execution.recallQueryEmbedding,
          minSimilarity: args.min_similarity,
          entityId,
          workspaceSlug,
          // Workspace-identity audit events record member/invitation
          // lifecycle; only owners/admins and in-process system contexts may
          // recall them (ordinary members do not see another member's
          // invitation lifecycle — the $member read policy reserves that for
          // owner/admin).
          excludeWorkspaceAudit:
            ctx.memberRole !== 'owner' &&
            ctx.memberRole !== 'admin' &&
            !isInProcessSystemCall(ctx),
        })
      : Promise.resolve({});
  // ========================================
  // ID-BASED LOOKUP (highest priority)
  // ========================================

  if (args.entity_id) {
    // Resolve and authorize the entity BEFORE starting recall. Starting an
    // org-wide recall in parallel here used to return unrelated content even
    // when the requested entity was absent/inaccessible.
    const entity =
      (await fetchEntityById(
        args.entity_id,
        env,
        connectionScope,
        args.include_public_catalogs ?? true
      )) ?? execution.preResolvedEntity ?? null;
    if (entity) {
      const readable = await filterEntitiesByReadPolicy(ctx, [entity]);
      if (readable.length === 0) {
        return emptyResult({
          ...(title ? { title } : {}),
          entity_type: entity.entity_type,
          suggestion: `Entity with ID ${args.entity_id} is not readable under this agent's entity read policy`,
        });
      }
      const recall = await recallFor(args.entity_id);
      return applyCoverageScope(
        withRecall(await formatEntityResult(readable, args, ctx, connectionScope), recall),
        execution
      );
    }
    if (execution.authorizedEntityId === args.entity_id) {
      // The public entity was authorized once above. This shard contributes
      // only strictly workspace-scoped recall; it does not re-query or format
      // the public catalog entity.
      return applyCoverageScope(
        withRecall(
          emptyResult({
            ...(title ? { title } : {}),
            entity_type: args.entity_type || null,
          }),
          await recallFor(args.entity_id)
        ),
        execution
      );
    }
    return emptyResult({
      ...(title ? { title } : {}),
      entity_type: args.entity_type || null,
      suggestion: `Entity with ID ${args.entity_id} not found`,
    });
  }

  // ========================================
  // TIER 1 CACHE: Name-based search
  // ========================================

  // Truncate query for search — long texts break websearch_to_tsquery and don't improve results
  const query = args.query ? args.query.slice(0, 200).trim() || null : null;
  if (!query && !args.query_embedding?.length) {
    throw new ToolUserError('Must provide a query or query_embedding', 400);
  }

  logger.info(
    `[search] Querying entities for "${query ?? '(vector)'}" (entity_type=${args.entity_type}, fuzzy=${args.fuzzy}, market=${args.market}, has_embedding=${!!args.query_embedding})`
  );

  let [results, recall] = await Promise.all([
    queryEntities(query, args, env, connectionScope),
    recallFor(),
  ]);

  if (results.length === 0 && query && !args.query_embedding?.length) {
    const fallbackQueries = expandSearchQueries(query, {
      maxVariants: 8,
    }).slice(1);
    for (const fallbackQuery of fallbackQueries) {
      results = await queryEntities(
        fallbackQuery.slice(0, 200).trim() || null,
        args,
        env,
        connectionScope
      );
      if (results.length > 0) {
        logger.info(
          `[search] Recovered entity matches for "${query}" via fallback variant "${fallbackQuery}"`
        );
        break;
      }
    }
  }

  if (results.length > 0) {
    const readable = await filterEntitiesByReadPolicy(ctx, [...results]);
    if (readable.length > 0) {
      return applyCoverageScope(
        withRecall(await formatEntityResult(readable, args, ctx, connectionScope), recall),
        execution
      );
    }
  }

  // ========================================
  // NOT FOUND (or recall-only hit)
  // ========================================
  const hasRecallHits =
    (recall.content != null && recall.content.length > 0) ||
    (recall.conversation_messages != null && recall.conversation_messages.length > 0);

  if (hasRecallHits) {
    logger.info(`[search] Recalled memory hits for "${query}" with no entity match`);
  } else {
    logger.info(`[search] No matches found for "${query}" in existing database`);
  }

  const suggestionText = hasRecallHits
    ? 'No matching entities found, but related memory content was recalled below.'
    : buildEmptySearchSuggestion(query, args, recall.coverage, guidanceAccessTier(ctx));

  const result = withRecall(
    emptyResult({
      ...(title ? { title } : {}),
      discovery_status: hasRecallHits ? 'complete' : 'not_found',
      suggestion: suggestionText,
    }),
    recall
  );
  return applyCoverageScope(result, execution);
}

// ============================================
// Query Helper Functions
// ============================================

// Build the entity SELECT projection. The count subqueries (events,
// connections, automations, children) are tenant-private operational data:
// running them globally for a public-catalog entity would leak other
// tenants' activity volumes through aggregate counts. Each count is
// gated on `e.organization_id = $callerOrg` so we return zeros for
// cross-org rows. Connection counts additionally apply per-user visibility.
function entitySelectColumns(callerOrgParamIdx: number, scope: AuthzScope): string {
  const ownOrg = `e.organization_id = $${callerOrgParamIdx}`;
  const connectionVisibility = compileConnectionRowVisibility(scope, 'cn');
  return `
  e.id, e.organization_id, e.name, et.slug AS entity_type, e.slug, e.metadata, e.parent_id,
  pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(*) FROM current_event_records ev
      WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}
        AND ev.organization_id = e.organization_id
    ), 0)
  ELSE 0 END as content_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(DISTINCT cn.connector_key)
      FROM feeds f
      JOIN connections cn ON cn.id = f.connection_id
      WHERE e.id = ANY(f.entity_ids)
        AND f.organization_id = e.organization_id
        AND cn.organization_id = e.organization_id
        AND f.deleted_at IS NULL
        AND cn.deleted_at IS NULL
        ${connectionVisibility}
    ), 0)
  ELSE 0 END as connection_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((
      SELECT COUNT(DISTINCT cn.connector_key)
      FROM feeds f
      JOIN connections cn ON cn.id = f.connection_id
      WHERE e.id = ANY(f.entity_ids)
        AND f.organization_id = e.organization_id
        AND cn.organization_id = e.organization_id
        AND f.deleted_at IS NULL
        AND cn.deleted_at IS NULL
        ${connectionVisibility}
        AND cn.status = 'active'
    ), 0)
  ELSE 0 END as active_connection_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((SELECT COUNT(*) FROM entities c WHERE c.parent_id = e.id AND c.organization_id = e.organization_id), 0)
  ELSE 0 END as children_count,
  CASE WHEN ${ownOrg} THEN
    COALESCE((SELECT COUNT(*) FROM automations i WHERE e.id = ANY(i.entity_ids) AND i.organization_id = e.organization_id), 0)
  ELSE 0 END as automation_count`;
}

const ENTITY_JOINS = `
  FROM entities e
  JOIN entity_types et ON et.id = e.entity_type_id
  LEFT JOIN entities pe ON e.parent_id = pe.id
  LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id`;

/**
 * Query entities by name with optional filters
 * - entity_type: filter by specific type
 * - parent_id: filter by specific parent
 * - category, market: additional filters
 * - query_embedding: vector similarity search
 * - metadata_filter: key-value metadata conditions
 * - scope: organization and connection-visibility principal
 */
async function queryEntities(
  query: string | null,
  args: SearchArgs,
  _env: Env,
  scope: AuthzScope
) {
  const sql = getDb();
  const fuzzyEnabled = args.fuzzy ?? true;
  const embedding = args.query_embedding;
  const hasEmbedding = !!embedding?.length;
  const limit = resolveEntityLimit(args);

  // Build dynamic WHERE conditions
  const conditions: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  let paramIdx = 1;

  const addParam = (value: unknown): number => {
    params.push(value);
    return paramIdx++;
  };

  // Query text param — only push when we have a text query
  const queryParamIdx = query ? addParam(query) : null;

  // Embedding param — only push when we have an embedding (avoids null::vector type error)
  const embeddingParamIdx = embedding?.length ? addParam(toVectorLiteral(embedding)) : null;

  // Query match condition: text match OR vector match
  if (query) {
    if (fuzzyEnabled) {
      // `min_similarity` is the caller-facing knob whose schema declares it
      // applies to BOTH fuzzy entity-name matching and recalled content. This
      // predicate is the entity-name half, so it must read the caller's value
      // rather than a hardcoded constant. Clamped to [0,1] (an out-of-range
      // value would make the arm always-true / always-false) and defaulted to
      // the SAME 0.3 the schema advertises, so an omitted value keeps today's
      // query contract exactly.
      //
      // Bound as a param with an explicit `::numeric` cast, mirroring
      // content-search/search-path.ts: `packages/server` runs `fetch_types:
      // false`, so an uncast placeholder leaves postgres.js without a type to
      // infer. `similarity()` returns `real`; `real > numeric` resolves fine.
      // No index is lost by parameterizing: the only trigram index in the
      // schema is `idx_events_raw_content_trgm` on `events.payload_text`, and
      // the sole index on this column, `idx_entities_name`, is a BTREE over
      // `lower(name)` — a btree can never serve `similarity()` at any
      // threshold, literal or bound. It still serves the `LOWER(e.name) =
      // LOWER($n)` arm of this same OR, which is untouched.
      const rawMinSimilarity = Number(args.min_similarity ?? 0.3);
      const nameSimFloor = Number.isFinite(rawMinSimilarity)
        ? Math.max(0, Math.min(1, rawMinSimilarity))
        : 0.3;
      const minSimParamIdx = addParam(nameSimFloor);
      const textCondition = `(LOWER(e.name) LIKE '%' || LOWER($${queryParamIdx}) || '%' OR LOWER(e.name) = LOWER($${queryParamIdx}) OR similarity(LOWER(e.name), LOWER($${queryParamIdx})) > $${minSimParamIdx}::numeric OR e.content_tsv @@ websearch_to_tsquery('english', $${queryParamIdx}))`;
      conditions.push(
        hasEmbedding ? `(${textCondition} OR e.embedding IS NOT NULL)` : textCondition
      );
    } else {
      conditions.push(`LOWER(e.name) = LOWER($${queryParamIdx})`);
    }
  } else if (hasEmbedding) {
    conditions.push('e.embedding IS NOT NULL');
  }

  // Organization filter — caller's org always; public-catalog orgs when the
  // flag is on (default), so an agent looking up "Apple" finds tenant-local
  // and canonical hits in one call. The result row carries the org_id so the
  // agent can tell which is which. The same param index is reused by the
  // count subqueries in entitySelectColumns(orgParamIdx, scope), which gate
  // operational counts (events, connections, automations) on caller-org rows
  // so cross-org public results don't leak other tenants' activity.
  const includePublic = args.include_public_catalogs ?? true;
  const orgParamIdx = addParam(scope.organizationId);
  if (includePublic) {
    conditions.push(
      `(e.organization_id = $${orgParamIdx} OR EXISTS (SELECT 1 FROM organization o WHERE o.id = e.organization_id AND o.visibility = 'public'))`
    );
  } else {
    conditions.push(`e.organization_id = $${orgParamIdx}`);
  }

  if (args.entity_type) conditions.push(`et.slug = $${addParam(args.entity_type)}`);
  if (args.parent_id) conditions.push(`e.parent_id = $${addParam(args.parent_id)}`);
  if (args.category)
    conditions.push(`e.metadata::jsonb->>'category' = $${addParam(args.category)}`);
  if (args.market) {
    const idx = addParam(args.market);
    conditions.push(
      `(e.metadata::jsonb->>'main_market' = $${idx} OR e.metadata::jsonb->>'market' = $${idx})`
    );
  }

  // Metadata filter: arbitrary key-value conditions
  if (args.metadata_filter) {
    for (const [key, value] of Object.entries(args.metadata_filter)) {
      conditions.push(`e.metadata->>'${key.replace(/'/g, "''")}' = $${addParam(value)}`);
    }
  }

  // NOTE: `agent_id` is deliberately NOT an entity filter. It is a MEMORY-SCOPE
  // axis over `events.metadata->>'agent_id'` (which agent WROTE a memory) — see
  // RecallContext.contentAgentId, where it is applied. Entities are workspace
  // nouns with no writing agent, so almost none carry `metadata.agent_id`;
  // applying it here matched ~nothing and made an exact-name lookup for an
  // entity that DOES exist return `not_found` plus "call client.entities.create()"
  // coaching — turning a read-scope filter into DUPLICATE WRITES.
  // Do NOT honor `metadata_filter.agent_id` here either: `metadata_filter` is on
  // the public schema, so honoring it would re-expose the cross-agent footgun.

  const whereClause = conditions.join(' AND ');

  // Build scoring expression
  let scoreExpr: string;
  let matchReason: string;
  let vectorSimExpr: string;

  if (hasEmbedding) {
    // Blended scoring: 0.6 vector + 0.3 text + 0.1 name
    vectorSimExpr = `CASE WHEN e.embedding IS NOT NULL THEN 1 - (e.embedding <=> $${embeddingParamIdx}::vector) ELSE 0 END`;
    const textRankExpr =
      queryParamIdx !== null
        ? `COALESCE(ts_rank_cd(e.content_tsv, websearch_to_tsquery('english', $${queryParamIdx})), 0)`
        : '0';
    const nameSimExpr =
      queryParamIdx !== null ? `similarity(LOWER(e.name), LOWER($${queryParamIdx}))` : '0';
    scoreExpr = `(${vectorSimExpr}) * 0.6 + (${textRankExpr}) * 0.3 + (${nameSimExpr}) * 0.1`;
    matchReason = 'vector_blend';
  } else if (fuzzyEnabled && queryParamIdx !== null) {
    vectorSimExpr = 'NULL';
    scoreExpr = `CASE WHEN LOWER(e.name) = LOWER($${queryParamIdx}) THEN 1.0 ELSE similarity(LOWER(e.name), LOWER($${queryParamIdx})) END`;
    matchReason = 'fuzzy_match';
  } else {
    vectorSimExpr = 'NULL';
    scoreExpr = '1.0';
    matchReason = 'exact_name';
  }

  const rows = await sql.unsafe<EntityQueryRow>(
    `SELECT ${entitySelectColumns(orgParamIdx, scope)},
      ${scoreExpr} as match_score,
      '${matchReason}' as match_reason,
      ${vectorSimExpr} as vector_similarity
    ${ENTITY_JOINS}
    WHERE ${whereClause}
    ORDER BY (e.organization_id = $${orgParamIdx}) DESC, match_score DESC
    LIMIT ${limit}`,
    params
  );

  await attachOrganizationSlugs(rows);

  return rows;
}

async function fetchEntityById(
  entityId: number,
  _env: Env,
  scope: AuthzScope,
  includePublic: boolean
) {
  const sql = getDb();

  // Caller's org or any visibility=public catalog. Lets entity_id lookup find
  // canonical entities (HMRC, banks) the agent has discovered via search.
  // Operational counts are gated on caller org; connection counts also use
  // the caller's row-visibility predicate.
  const result = await sql.unsafe<EntityQueryRow>(
    `SELECT ${entitySelectColumns(2, scope)}
    ${ENTITY_JOINS}
    LEFT JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = $1
      AND (e.organization_id = $2 OR ($3::boolean AND eo.visibility = 'public'))
      AND e.deleted_at IS NULL`,
    [entityId, scope.organizationId, includePublic]
  );

  if (result.length === 0) return null;

  await attachOrganizationSlugs(result);
  return result[0];
}

async function fetchPublicEntityById(
  entityId: number,
  scope: AuthzScope
): Promise<EntityQueryRow | null> {
  const result = await getDb().unsafe<EntityQueryRow>(
    `SELECT ${entitySelectColumns(1, scope)}
    ${ENTITY_JOINS}
    JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = $2
      AND eo.visibility = 'public'
      AND e.deleted_at IS NULL`,
    [scope.organizationId, entityId]
  );
  if (result.length === 0) return null;
  await attachOrganizationSlugs(result);
  return result[0];
}

// ============================================
// Formatting Helper Functions
// ============================================

async function formatEntityResult(
  entityRows: EntityQueryRow[],
  args: SearchArgs,
  ctx: ToolContext,
  connectionScope: AuthzScope
): Promise<UnifiedSearchResult> {
  const title = args.title?.trim() || undefined;
  // Map rows to unified Entity format (all fields, nulls where not applicable)
  const matches: Entity[] = entityRows.map((row) => ({
    id: Number(row.id),
    type: row.entity_type,
    name: row.name,
    slug: row.slug,
    metadata: row.metadata ?? {},
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    parent_name: row.parent_name ?? null,
    parent_slug: row.parent_slug ?? null,
    parent_entity_type: row.parent_entity_type ?? null,
    organization_slug: row.organization_slug ?? null,
    workspace_slug: row.organization_slug ?? null,
    stats: {
      content_count: Number(row.content_count) || 0,
      connection_count: Number(row.connection_count) || 0,
      active_connection_count: Number(row.active_connection_count) || 0,
      children_count: Number(row.children_count) || 0,
      automation_count: Number(row.automation_count) || 0,
    },
    match_score: Number(row.match_score) || 1.0,
    match_reason: row.match_reason || 'exact_name',
  }));

  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const primaryEntity = matches[0];
  const primaryRow = entityRows[0];
  const entityType = primaryEntity.type;
  const isRootEntity = !primaryEntity.parent_id;

  // Fetch connections if requested (default: true). Public-catalog entities
  // are referenced by many tenants; running fetchConnectionsForEntity on
  // them would surface other tenants' private connection metadata
  // (display_name, config, feed entity names). Connections are per-tenant
  // operational data, never canonical, so skip them entirely for cross-org
  // public results.
  let connections: ConnectionInfo[] | undefined;
  const primaryIsCallerOrg = String(primaryRow.organization_id) === ctx.organizationId;
  if ((args.include_connections ?? true) && primaryIsCallerOrg) {
    connections = await fetchConnectionsForEntity(
      primaryEntity.id,
      primaryEntity.workspace_slug ?? primaryEntity.organization_slug ?? '',
      connectionScope
    );
  }

  // Fetch children for root entities (no parent). Children are scoped to
  // the primary's own org — preserves the parent-org boundary and stops
  // tenant-private "child of HMRC"-style rows from leaking when the primary
  // is a cross-org public entity. content_count is zeroed for cross-org
  // primaries to match the same invariant the parent's stats follow.
  let children: UnifiedSearchResult['children'];
  if (isRootEntity) {
    const childRows = await getDb()<ChildEntityRow>`
      SELECT
        e.id,
        e.name,
        et.slug AS entity_type,
        e.metadata::jsonb->>'market' as market,
        CASE WHEN ${primaryIsCallerOrg} THEN
          COALESCE(
            (SELECT COUNT(*) FROM current_event_records ev
              WHERE e.id = ANY(ev.entity_ids)
                AND ev.organization_id = e.organization_id),
            0
          )
        ELSE 0 END as content_count
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.parent_id = ${primaryEntity.id}
        AND e.organization_id = ${primaryRow.organization_id}
      ORDER BY e.created_at DESC
      LIMIT ${MAX_CHILDREN}
    `;
    children = childRows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      type: row.entity_type,
      market: row.market,
      content_count: Number(row.content_count),
      parent_entity_id: primaryEntity.id,
      workspace_slug:
        primaryEntity.workspace_slug ?? primaryEntity.organization_slug ?? '',
    }));
  }

  // Generate helpful suggestion based on connection status
  let suggestion: string;
  if (matches.length === 1) {
    const activeConnections =
      connections?.filter((c) => c.status === 'active').length ||
      primaryEntity.stats.active_connection_count;
    const pausedConnections = connections?.filter((c) => c.status === 'paused').length || 0;

    if (activeConnections === 0 && pausedConnections === 0) {
      suggestion = `Entity "${primaryEntity.name}" found with no connections. Use search_sdk to choose a connector and feed, then run_sdk with client.connections.connect({ connector_key: '<connector_key>' }), client.feeds.create({ connection_id: <connection_id>, feed_key: '<feed_key>', entity_ids: [${primaryEntity.id}], config: {} }) to target this entity, and client.feeds.trigger({ feed_id: <feed_id> }) to collect now.`;
    } else if (activeConnections === 0 && pausedConnections > 0) {
      suggestion = `Entity "${primaryEntity.name}" has ${pausedConnections} paused connection(s). Reactivate a connection to resume collection.`;
    } else {
      suggestion = `Entity "${primaryEntity.name}" found with ${activeConnections} active connection(s).`;
    }
  } else {
    suggestion = `Found ${matches.length} matching entities.`;
  }

  // Build view URL for the primary entity
  let viewUrl: string | undefined;
  if (primaryEntity.organization_slug) {
    viewUrl = buildEntityUrl(
      {
        ownerSlug: primaryEntity.organization_slug,
        entityType: entityType,
        slug: primaryEntity.slug,
        parentType: primaryEntity.parent_entity_type ?? null,
        parentSlug: primaryEntity.parent_slug ?? null,
      },
      baseUrl
    );
  }

  return {
    ...(title ? { title } : {}),
    entity_type: entityType,
    entity: primaryEntity,
    matches,
    connections,
    children,
    discovery_status: 'complete',
    suggestion,
    view_url: viewUrl,
    metadata: {
      total_matches: matches.length,
      page_size: matches.length,
    },
  };
}

/**
 * `c.config` here is the same verbatim jsonb the manage_connections read paths
 * serve, so it can carry connector secrets such as bot tokens and connection
 * strings. Redacted on the way out; the field stays present so callers can
 * still see which options are configured.
 */
async function fetchConnectionsForEntity(
  entityId: number,
  workspaceSlug: string,
  scope: AuthzScope
): Promise<ConnectionInfo[]> {
  const sql = getDb();
  const result = await sql`
    SELECT
      c.id as connection_id,
      c.connector_key,
      c.display_name,
      c.status,
      c.config,
      (
        SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
        FROM entities ent
        WHERE ent.deleted_at IS NULL
          AND ent.id IN ${sql.unsafe(connectionLinkedEntityIdsSql('c'))}
      ) as entity_names,
      c.created_at,
      c.updated_at,
      COALESCE(COUNT(f.id), 0) as content_count
    FROM connections c
    LEFT JOIN current_event_records f ON f.connection_id = c.id
    WHERE ${sql.unsafe(connectionLinkedToBusinessEntitySql(String(entityId), 'c', 'c.organization_id'))}
      AND c.organization_id = ${scope.organizationId}
      AND c.deleted_at IS NULL
      ${sql.unsafe(compileConnectionRowVisibility(scope, 'c'))}
    GROUP BY c.id, c.connector_key, c.display_name, c.status, c.config, c.created_at, c.updated_at
    ORDER BY
      CASE c.status
        WHEN 'active' THEN 1
        WHEN 'paused' THEN 2
        ELSE 4
      END,
      c.created_at DESC
    LIMIT 20
  `;

  const redacted = (await redactConnectionRows(
    scope.organizationId,
    result as unknown as Array<Record<string, unknown>>
  )) as unknown as Array<Omit<ConnectionInfo, 'entity_id' | 'workspace_slug'>>;
  return redacted.map((row) => ({
    ...row,
    config: row.config ?? {},
    created_at: new Date(row.created_at).toISOString(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    entity_id: entityId,
    workspace_slug: workspaceSlug,
  }));
}

async function attachOrganizationSlugs(rows: EntityQueryRow[]): Promise<void> {
  if (rows.length === 0) return;

  const orgIds = Array.from(new Set(rows.map((row) => row.organization_id))).filter(Boolean);
  if (orgIds.length === 0) return;

  const slugById = await getWorkspaceProvider().getOrgSlugs(orgIds);

  for (const row of rows) {
    row.organization_slug = slugById.get(row.organization_id) ?? null;
  }
}
