import type { DbClient } from '../db/client';
import { slugToRuntimeConnectionId } from '../lobu/stores/connections-projection';
import type { AutomationSource } from '../types/automations';
import { executeDataSources } from '../utils/execute-data-sources';
import {
  boundedAttachmentsSql,
  boundedJsonSql,
  boundedPayloadTextSql,
} from '../utils/content-read-bounds';

/**
 * Validate a custom-SQL Automation source at save time. Runs the SAME scoped
 * query the reader uses, wrapped in `SELECT ... LIMIT 0` so Postgres plans and
 * type-checks it (undefined column → 42703, syntax error, admin-table access)
 * without materializing any rows, and throws on failure. A structurally valid
 * query that merely matches 0 rows passes.
 *
 * `entityIds` mirrors what the runtime reader supplies (the Automation's own
 * entity_ids). It is passed through so `{{entityId}}` substitutes exactly as it
 * will at run time: an entity-bound Automation validates its `{{entityId}}` source
 * cleanly, while an ORG-SCOPED Automation (no entity_ids) leaves `{{entityId}}`
 * unresolved and is rejected here — the same source would fail on every runtime
 * read, so catching it at save is the point. `validateEntitySlugs` also rejects
 * typoed table names that would otherwise compile as empty entity-type CTEs.
 */
async function validateCustomSqlSource(
  sql: DbClient,
  organizationId: string,
  entityIds: number[],
  source: AutomationSource
): Promise<void> {
  await executeDataSources(
    { [source.name]: { query: source.query } },
    {
      organizationId,
      // Only supply entity ids the Automation actually has, so {{entityId}} on an
      // org-scoped Automation stays unresolved and fails validation (matching the
      // runtime). {{query.*}} substitutes to NULL with an empty query map.
      entityIds: entityIds.length > 0 ? entityIds : undefined,
      query: {},
    },
    sql,
    {
      throwOnError: true,
      validateEntitySlugs: true,
      wrapQuery: (scopedSql) => `SELECT * FROM (${scopedSql}) AS _validate LIMIT 0`,
    }
  );
}

// 'channel' is a chat-transcript source (channel feed → channel_messages). It
// is prompt CONTEXT, not events: its rows must never be signed as event
// content_ids (channel_messages.id is not an events.id — complete_window links
// content_ids into automation_run_events.event_id, an FK to events).
export type AutomationSourceKind = 'event' | 'entity' | 'metric' | 'channel' | 'feed';

export type AutomationSourceRef =
  | { type: 'feed'; value: string }
  | { type: 'connection'; value: string }
  | { type: 'connector'; value: string }
  | { type: 'channel'; value: string }
  | { type: 'entity'; value: string }
  | { type: 'metric'; entityType: string; measure: string };

export interface NormalizedAutomationSource extends AutomationSource {
  kind: AutomationSourceKind;
  ref?: AutomationSourceRef;
  feedId?: number;
  /**
   * This ref-backed source has the canonical event projection and can be
   * bounded in SQL after paging.
   */
  controlledEventProjection?: boolean;
  /** The default SELECT * source keeps every selected event column and is bounded in JS. */
  dynamicEventProjection?: boolean;
}

const REF_RE = /^@([a-z_][a-z0-9_-]*):(.+)$/i;
const SAFE_REF_VALUE_RE = /^[#@a-zA-Z0-9._:/-]+$/;
const SAFE_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SAFE_CONNECTOR_RE = /^[a-zA-Z0-9._-]+$/;

function assertSafeRefValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} reference is empty`);
  if (!SAFE_REF_VALUE_RE.test(trimmed)) {
    throw new Error(`${label} reference contains unsupported characters`);
  }
  return trimmed;
}

function assertSafeSlug(label: string, value: string): string {
  const trimmed = assertSafeRefValue(label, value);
  if (!SAFE_SLUG_RE.test(trimmed)) {
    throw new Error(`${label} reference must be a plain slug`);
  }
  return trimmed;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Default all-events source for an Automation authored with no sources.
 *
 * Excludes the server's bookkeeping rows — `change` (config/lifecycle/entity
 * audit trails) and `audit` (tool-invocation log). Historically these were
 * invisible to Automation windows by accident (they were inserted with
 * occurred_at NULL, which no window matched); once insertEvent started
 * stamping occurred_at, an Automation's own creation bookkeeping would land in
 * its first window and defeat `skip_if_unchanged`, and every config edit
 * would read as new workspace content. Explicitly authored sources are
 * untouched — a source that wants the audit trail can still select it.
 */
export const DEFAULT_AUTOMATION_SOURCE_QUERY =
  "SELECT * FROM events WHERE semantic_type NOT IN ('change', 'audit') ORDER BY occurred_at DESC";

const AUTOMATION_EVENT_COLUMNS =
  'id, organization_id, entity_ids, origin_id, title, payload_type, payload_text, ' +
  'content_length, payload_data, payload_template, attachments, author_name, source_url, ' +
  'occurred_at, score, metadata, created_at, origin_parent_id, origin_type, connector_key, ' +
  'connection_id, feed_key, feed_id, semantic_type';

/** Raw canonical event source. Agent reads bound it only after cursor/limit selection. */
function buildAutomationEventSelect(where: string): string {
  return `SELECT ${AUTOMATION_EVENT_COLUMNS} FROM events WHERE ${where} ORDER BY occurred_at DESC`;
}

/** Final SQL projection over an already cursor-filtered and limited event page. */
export function buildBoundedAutomationEventPageSelect(pageSql: string): string {
  const a = 'event_page';
  return `SELECT ${a}.id, ${a}.organization_id, ${a}.entity_ids, ${a}.origin_id, ${a}.title,
    ${a}.payload_type, ${boundedPayloadTextSql(a)}, ${boundedJsonSql(a, 'payload_data')},
    ${boundedJsonSql(a, 'payload_template')}, ${boundedAttachmentsSql(a)}, ${a}.author_name,
    ${a}.source_url, ${a}.occurred_at, ${a}.score, ${boundedJsonSql(a, 'metadata')},
    ${a}.created_at, ${a}.origin_parent_id, ${a}.origin_type, ${a}.connector_key,
    ${a}.connection_id, ${a}.feed_key, ${a}.feed_id, ${a}.semantic_type
    FROM (${pageSql}) AS ${a}
    ORDER BY ${a}.occurred_at DESC NULLS LAST, ${a}.id DESC`;
}

export function parseAutomationSourceRef(query: string): AutomationSourceRef | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith('@')) return null;

  const match = REF_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      'source refs must use @feed:, @connection:, @connector:, @channel:, @entity:, or @metric:'
    );
  }

  const type = match[1].toLowerCase();
  const rawValue = match[2].trim();
  switch (type) {
    case 'feed':
      return { type: 'feed', value: assertSafeRefValue('@feed', rawValue) };
    case 'connection':
      return { type: 'connection', value: assertSafeRefValue('@connection', rawValue) };
    case 'connector':
      return { type: 'connector', value: assertSafeRefValue('@connector', rawValue) };
    case 'channel':
      return { type: 'channel', value: assertSafeRefValue('@channel', rawValue) };
    case 'entity':
      return { type: 'entity', value: assertSafeSlug('@entity', rawValue) };
    case 'metric': {
      const value = assertSafeRefValue('@metric', rawValue);
      const dot = value.indexOf('.');
      if (dot <= 0 || dot === value.length - 1) {
        throw new Error('@metric refs must be shaped like @metric:<entity_type>.<measure>');
      }
      const entityType = value.slice(0, dot);
      const measure = value.slice(dot + 1);
      if (!SAFE_SLUG_RE.test(entityType) || !SAFE_SLUG_RE.test(measure)) {
        throw new Error('@metric entity type and measure must be plain identifiers');
      }
      return { type: 'metric', entityType, measure };
    }
    default:
      throw new Error(`unsupported source ref @${type}:`);
  }
}

// ── Prompt-token extraction ────────────────────────────────────────────────
// The owletto composer serializes a picked reference into the automation prompt as
// an inline token `@[kind:id:label](path)`. The backend — not the frontend —
// derives the automation's `sources[]` from these tokens, so the UI just sends the
// raw prompt and there is no client/server gap.
//
// The grammar itself lives in `@lobu/core/refs`, which both sides import — do
// not re-derive the token regex here. Re-exported so this module stays the
// server's single entry point for automation source concerns.

export {
  automationSourcesFromPrompt,
  mergePromptSources,
  skillNamesFromPrompt,
} from '@lobu/core/refs';

export function automationSourceKindForRef(ref: AutomationSourceRef | null): AutomationSourceKind {
  if (!ref) return 'event';
  if (ref.type === 'entity') return 'entity';
  if (ref.type === 'metric') return 'metric';
  return 'event';
}

export function validateAutomationSourceRef(name: string, query: string): AutomationSourceKind | null {
  try {
    const ref = parseAutomationSourceRef(query);
    return ref ? automationSourceKindForRef(ref) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`source "${name}": ${message}`);
  }
}

function numericRef(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface ResolvedFeed {
  id: number;
  store: 'events' | 'channel_messages';
  /** `connections.slug` of the feed's connection (for the channel-messages path). */
  connectionSlug: string;
  feedKey: string;
  /** Declared feed capabilities; empty when no definition resolved. */
  operations: string[];
  readWindowAxis?: string;
}

async function resolveFeeds(
  sql: DbClient,
  organizationId: string,
  value: string
): Promise<ResolvedFeed[]> {
  const id = numericRef(value);
  const rows = await sql<{
    id: number | string;
    store: string | null;
    feed_key: string;
    connection_slug: string;
    operations: unknown;
    read_window_axis: string | null;
  }>`
    SELECT f.id, f.config ->> 'store' AS store, f.feed_key, c.slug AS connection_slug,
           COALESCE(cd.feed_operations, '[]'::jsonb) AS operations, cd.read_window_axis
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    LEFT JOIN LATERAL (
      SELECT connector_definitions.feeds_schema -> f.feed_key -> 'operations'
        AS feed_operations,
        connector_definitions.feeds_schema -> f.feed_key ->> 'readWindowAxis' AS read_window_axis
      FROM connector_definitions
      WHERE connector_definitions.key = c.connector_key
        AND connector_definitions.organization_id = f.organization_id
        AND (
          (f.pinned_version IS NULL AND connector_definitions.status = 'active')
          OR (
            f.pinned_version IS NOT NULL
            AND (
              connector_definitions.version = f.pinned_version
              OR connector_definitions.status = 'active'
            )
          )
        )
      ORDER BY (connector_definitions.version = f.pinned_version) DESC,
               (connector_definitions.status = 'active') DESC,
               connector_definitions.updated_at DESC,
               connector_definitions.id DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE f.organization_id = ${organizationId}
      AND f.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND (
        ${id}::bigint IS NOT NULL AND f.id = ${id}::bigint
        OR f.feed_key = ${value}
        OR f.display_name = ${value}
      )
    ORDER BY f.id
    LIMIT 100
  `;
  return rows
    .map((r) => ({
      id: Number(r.id),
      store: (r.store === 'channel_messages' ? 'channel_messages' : 'events') as ResolvedFeed['store'],
      connectionSlug: String(r.connection_slug),
      feedKey: String(r.feed_key),
      operations: Array.isArray(r.operations) ? r.operations.map(String) : [],
      readWindowAxis: r.read_window_axis ?? undefined,
    }))
    .filter((r) => Number.isSafeInteger(r.id) && r.id > 0);
}

/** Strip a `platform:` prefix off a channel feed_key to the bare channel id
 *  that `channel_messages.channel_id` stores (mirror of read_feed). */
function bareChannelId(feedKey: string): string {
  return feedKey.includes(':') ? feedKey.slice(feedKey.indexOf(':') + 1) : feedKey;
}

/** Compile a set of channel feeds to a read over
 *  `channel_messages`. The rows are membership-gated by the channel_messages CTE
 *  in execute-data-sources — a headless automation run reads only non-enforced
 *  channels, so enforced-channel content never reaches the shared recap. */
function channelMessagesSelect(feeds: ResolvedFeed[]): string {
  const tuples = feeds
    .map(
      (f) =>
        `(${sqlString(slugToRuntimeConnectionId(f.connectionSlug))}, ${sqlString(
          bareChannelId(f.feedKey)
        )})`
    )
    .join(', ');
  return (
    'SELECT id, organization_id, connection_id, platform, channel_id, thread_id, ' +
    'platform_message_id, author_id, author_name, author_entity_id, is_bot, text, ' +
    'occurred_at, created_at ' +
    `FROM channel_messages WHERE (connection_id, channel_id) IN (${tuples}) ` +
    'ORDER BY occurred_at DESC'
  );
}

async function resolveConnectionId(
  sql: DbClient,
  organizationId: string,
  value: string
): Promise<number> {
  const id = numericRef(value);
  const rows = await sql<{ id: number | string }>`
    SELECT id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND deleted_at IS NULL
      AND (
        ${id}::bigint IS NOT NULL AND id = ${id}::bigint
        OR slug = ${value}
        OR display_name = ${value}
      )
    ORDER BY id
    LIMIT 2
  `;
  if (rows.length === 0) throw new Error(`@connection:${value} did not match any connection`);
  if (rows.length > 1) throw new Error(`@connection:${value} matched more than one connection`);
  return Number(rows[0].id);
}

async function compileRefToQuery(
  sql: DbClient,
  organizationId: string,
  ref: AutomationSourceRef
): Promise<{
  query: string | null;
  kind: AutomationSourceKind;
  feedId?: number;
  controlledEventProjection?: boolean;
}> {
  switch (ref.type) {
    case 'feed': {
      const feeds = await resolveFeeds(sql, organizationId, ref.value);
      if (feeds.length === 0) throw new Error(`@feed:${ref.value} did not match any feed`);
      const eventFeeds = feeds.filter((f) => f.store === 'events');
      const channelFeeds = feeds.filter((f) => f.store === 'channel_messages');
      if (eventFeeds.some((f) => f.operations.includes('read') && (f.readWindowAxis || !f.operations.includes('sync')))) {
        if (feeds.length !== 1) {
          throw new Error(`@feed:${ref.value} matches multiple feeds; reference one feed for a live source.`);
        }
        return { query: null, kind: 'feed', feedId: feeds[0].id };
      }
      // Don't mix storage planes in one source: a single SELECT cannot span
      // both `events` and `channel_messages`.
      if (eventFeeds.length > 0 && channelFeeds.length > 0) {
        throw new Error(
          `@feed:${ref.value} matched both event and channel-message stores; reference one feed`
        );
      }
      if (channelFeeds.length > 0) {
        // 'channel' kind → prompt context only, NOT event-id-signed (see the type).
        return { query: channelMessagesSelect(channelFeeds), kind: 'channel' };
      }
      return {
        query: buildAutomationEventSelect(
          `feed_id IN (${eventFeeds.map((f) => f.id).join(',')})`
        ),
        kind: 'event',
        controlledEventProjection: true,
      };
    }
    case 'connection': {
      const id = await resolveConnectionId(sql, organizationId, ref.value);
      return {
        query: buildAutomationEventSelect(`connection_id = ${id}`),
        kind: 'event',
        controlledEventProjection: true,
      };
    }
    case 'connector': {
      if (!SAFE_CONNECTOR_RE.test(ref.value)) {
        throw new Error('@connector refs must be plain connector keys');
      }
      return {
        query: buildAutomationEventSelect(`connector_key = ${sqlString(ref.value)}`),
        kind: 'event',
        controlledEventProjection: true,
      };
    }
    case 'channel': {
      const raw = ref.value.startsWith('#') ? ref.value.slice(1) : ref.value;
      const channel = sqlString(raw);
      const hashChannel = sqlString(`#${raw}`);
      return {
        query: buildAutomationEventSelect(
          [
            `metadata->>'channel' IN (${channel}, ${hashChannel})`,
            `metadata->>'channel_name' IN (${channel}, ${hashChannel})`,
            `metadata->>'channel_id' = ${raw ? channel : "''"}`,
            `payload_data->>'channel' IN (${channel}, ${hashChannel})`,
            `payload_data->>'channel_name' IN (${channel}, ${hashChannel})`,
            `payload_data->>'channel_id' = ${raw ? channel : "''"}`,
          ].join(' OR ')
        ),
        kind: 'event',
        controlledEventProjection: true,
      };
    }
    case 'entity':
      return {
        query:
          'SELECT id, entity_type, entity_type_id, parent_id, name, slug, metadata, created_at, updated_at ' +
          `FROM entities WHERE entity_type = ${sqlString(ref.value)} AND deleted_at IS NULL ` +
          'ORDER BY updated_at DESC',
        kind: 'entity',
      };
    case 'metric':
      return { query: null, kind: 'metric' };
  }
}

/**
 * Save-time resolution: every @ref must resolve in the org NOW, so a typo fails
 * at create/create_version/update (loud, 422) instead of at read_knowledge
 * (silent empty rows, or a swallowed metric error). This is the operational-
 * confidence counterpart to the syntax-only {@link validateAutomationSourceRef}:
 * it walks the same compile path the reader uses, plus existence checks for
 * @entity (type) and @metric (type + declared measure) that the reader otherwise
 * discovers by returning empty. @feed / @connection misses throw via
 * {@link normalizeAutomationSources}; @connector checks a connection uses that key;
 * @channel is free-form (no static registry) and left unchecked.
 */
export async function resolveAutomationSourcesForSave(
  sql: DbClient,
  organizationId: string,
  sources: AutomationSource[],
  // The Automation's own entity_ids (empty for an org-scoped Automation). Threaded
  // into custom-SQL validation so {{entityId}} resolves exactly as at run time.
  entityIds: number[] = []
): Promise<void> {
  for (const source of sources) {
    const ref = parseAutomationSourceRef(source.query);
    if (!ref) {
      // Custom SQL — validate it (see validateCustomSqlSource for the mechanism
      // and its limits) so a typo'd source fails here instead of silently
      // returning 0 rows forever at read time.
      await validateCustomSqlSource(sql, organizationId, entityIds, source);
      continue;
    }

    if (ref.type === 'entity') {
      const exists = await sql<{ id: number }>`
        SELECT id FROM entity_types
        WHERE slug = ${ref.value}
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (exists.length === 0) {
        throw new Error(
          `source "${source.name}": @entity:${ref.value} is not an entity type in this organization`
        );
      }
      continue;
    }

    if (ref.type === 'metric') {
      const rows = await sql<{ id: number; metrics_config: unknown }>`
        SELECT id, metrics_config FROM entity_types
        WHERE slug = ${ref.entityType}
          AND organization_id = ${organizationId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (rows.length === 0) {
        throw new Error(
          `source "${source.name}": @metric:${ref.entityType}.${ref.measure} — entity type "${ref.entityType}" not found in this organization`
        );
      }
      const measures = (
        (rows[0].metrics_config as { measures?: Record<string, unknown> } | null) ?? {}
      ).measures ?? {};
      if (!(ref.measure in measures)) {
        throw new Error(
          `source "${source.name}": @metric:${ref.entityType}.${ref.measure} — measure "${ref.measure}" is not declared on entity type "${ref.entityType}"`
        );
      }
      continue;
    }

    if (ref.type === 'connector') {
      const exists = await sql<{ id: number }>`
        SELECT id FROM connections
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND connector_key = ${ref.value}
        LIMIT 1
      `;
      if (exists.length === 0) {
        throw new Error(
          `source "${source.name}": @connector:${ref.value} — no connection in this organization uses connector key "${ref.value}"`
        );
      }
    }
  }

  // Resolve feed/connection refs (throws on miss with the same message the
  // reader produces) so the full set is validated, not just the structured ones.
  await normalizeAutomationSources(sql, organizationId, sources);
}

export async function normalizeAutomationSources(
  sql: DbClient,
  organizationId: string,
  sources: AutomationSource[]
): Promise<NormalizedAutomationSource[]> {
  const seenNames = new Set<string>();
  for (const source of sources) {
    if (seenNames.has(source.name)) {
      throw new Error(`Automation source name "${source.name}" is duplicated; source names must be unique`);
    }
    seenNames.add(source.name);
  }

  const normalized: NormalizedAutomationSource[] = [];
  for (const source of sources) {
    const ref = parseAutomationSourceRef(source.query);
    if (!ref) {
      // A `context: true` SQL source is entity context, not event content: its
      // rows reach the agent but are never linked into automation_run_events
      // (so its `id` may be an entity id, sidestepping the events FK). A plain
      // SQL source stays event content and its `id` must be an `events.id`.
      normalized.push({
        ...source,
        kind: source.context ? 'entity' : 'event',
        // Custom event SQL owns its projection, so preserve that projection and
        // bound its selected page at the shared dynamic-row chokepoint. Context
        // SQL is not event content and keeps its authored values unchanged.
        dynamicEventProjection: !source.context,
      });
      continue;
    }
    const { query, kind, controlledEventProjection, feedId } = await compileRefToQuery(
      sql,
      organizationId,
      ref
    );
    normalized.push({
      name: source.name,
      query: query ?? source.query,
      kind,
      ref,
      controlledEventProjection,
      feedId,
    });
  }
  return normalized;
}
