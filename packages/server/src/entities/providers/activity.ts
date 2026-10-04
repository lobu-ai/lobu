/**
 * Activity of a remote record: its source stream (the type's activity SQL,
 * exact-matched on `key`) merged with its Lobu stream (events saved with the
 * record's ref in `entity_refs`), newest first.
 *
 * Paging is exact across both streams. Each page fetches one row more than it
 * can emit from each stream and merges the two heads, so what a page emits from
 * a stream is always a prefix of that stream. The cursor records that prefix:
 * `src_offset` counts source rows EMITTED (not fetched), `lobu_before` is the
 * keyset of the last EMITTED Lobu event. For an unchanged source, nothing is
 * skipped or repeated, even when timestamps tie across streams.
 */

import type { ContentItem } from '@lobu/connector-sdk';
import { isRetryable, type ToolErrorCode } from '@lobu/core';
import { getDb, pgBigintArray } from '../../db/client';
import { buildContentQuery } from '../../tools/get_content/query';
import { buildContentItems } from '../../tools/get_content/render';
import type { ContentRow } from '../../tools/get_content/types';
import type { ToolContext } from '../../tools/registry';
import { buildConnectionVisibilityClause } from '../../utils/content-search';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import { getOrganizationSlug } from '../../utils/url-builder';
import { readRemoteByKey, type ResolvedRemoteRef } from './index';

const CURSOR_VERSION = 1;

interface ActivityCursor {
  v: typeof CURSOR_VERSION;
  ref: string;
  src_offset: number;
  lobu_before: { at: string; id: number } | null;
}

interface ActivityStreamStatus {
  stream: 'source' | 'lobu';
  ok: boolean;
  error?: string;
  error_code?: string;
  retryable?: boolean;
}

interface RemoteActivityPage {
  items: Array<Record<string, unknown>>;
  streams: ActivityStreamStatus[];
  next_cursor?: string;
}

/** Columns with a defined meaning; every other projected column is metadata. */
const SOURCE_COLUMNS = new Set([
  'key',
  'origin_id',
  'occurred_at',
  'title',
  'sort_key',
  'url',
  'kind',
  'summary',
  'actor',
]);

function encodeActivityCursor(cursor: Omit<ActivityCursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...cursor })).toString('base64url');
}

/** Decode and bind a cursor to `ref`. A malformed cursor or another ref's is a 400. */
function decodeActivityCursor(value: string, ref: string): ActivityCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new ToolUserError('cursor is not a valid activity cursor', 400);
  }
  const c = parsed as Partial<ActivityCursor> | null;
  const before = c?.lobu_before;
  const valid =
    c !== null &&
    typeof c === 'object' &&
    c.v === CURSOR_VERSION &&
    typeof c.ref === 'string' &&
    Number.isInteger(c.src_offset) &&
    (c.src_offset as number) >= 0 &&
    (before === null ||
      (typeof before === 'object' &&
        typeof before.at === 'string' &&
        Number.isFinite(Date.parse(before.at)) &&
        Number.isInteger(before.id)));
  if (!valid) throw new ToolUserError('cursor is not a valid activity cursor', 400);
  if (c.ref !== ref) {
    throw new ToolUserError('cursor belongs to a different entity; restart without cursor', 400);
  }
  return c as ActivityCursor;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string' || typeof value === 'number') {
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' ? null : s;
}

/** Shape a source activity row like a read-only event. It has no Lobu id. */
function sourceItem(row: Record<string, unknown>, ref: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!SOURCE_COLUMNS.has(k)) metadata[k] = v;
  const occurredAt = toIso(row.occurred_at);
  return {
    stream: 'source',
    id: null,
    ref,
    origin_id: text(row.origin_id) ?? '',
    title: text(row.title),
    occurred_at: occurredAt,
    created_at: occurredAt,
    source_url: text(row.url),
    semantic_type: text(row.kind) ?? 'activity',
    payload_type: 'text',
    payload_text: text(row.summary),
    author_name: text(row.actor),
    entity_ids: [],
    entity_refs: [ref],
    metadata,
    classifications: {},
    score: 0,
  };
}

interface LobuRow extends ContentRow {
  sort_at: string;
}

async function readLobuStream(
  resolved: ResolvedRemoteRef,
  before: ActivityCursor['lobu_before'],
  limit: number,
  ctx: ToolContext,
  excludeWorkspaceAudit: boolean
): Promise<LobuRow[]> {
  const sql = getDb();
  const params: Array<string | number | null> = [ctx.organizationId, resolved.ref];
  const conditions = [
    'e.organization_id = $1',
    'e.entity_refs @> ARRAY[$2::text]',
    'e.superseded_by IS NULL',
  ];
  if (before) {
    params.push(before.at, before.id);
    conditions.push(
      `(COALESCE(e.occurred_at, e.created_at), e.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`
    );
  }
  if (excludeWorkspaceAudit) conditions.push(`NOT (e.metadata ? '_lobu_workspace_audit')`);
  const visibility = buildConnectionVisibilityClause(
    { organizationId: ctx.organizationId, userId: ctx.userId, baseParamIndex: params.length + 1 },
    'e'
  );
  params.push(...visibility.params);
  // Page by keyset over the GIN-indexed ref first, then render only that page.
  // The text timestamp keeps microseconds, so the keyset never collapses ties.
  const page = await sql.unsafe<{ id: number; sort_at: string }>(
    `SELECT e.id, COALESCE(e.occurred_at, e.created_at)::text AS sort_at
     FROM events e
     LEFT JOIN connections c ON c.id = e.connection_id
     WHERE ${conditions.join(' AND ')} ${visibility.sql}
     ORDER BY COALESCE(e.occurred_at, e.created_at) DESC, e.id DESC
     LIMIT ${limit}`,
    params
  );
  if (page.length === 0) return [];
  const ids = page.map((r) => Number(r.id));
  const rows = (await sql.unsafe(
    buildContentQuery({
      table: 'events',
      alias: 'e',
      where: 'e.id = ANY($1::bigint[])',
      orderBy: 'COALESCE(e.occurred_at, e.created_at) DESC, e.id DESC',
      limit,
      offset: 0,
    }),
    [pgBigintArray(ids)]
  )) as unknown as ContentRow[];
  const sortAt = new Map(page.map((r) => [Number(r.id), r.sort_at]));
  return rows.map((row) => ({ ...row, sort_at: sortAt.get(Number(row.id)) as string }));
}

/**
 * One page of a remote record's activity. `limit` items at most, merged newest
 * first; a failed stream is reported in `streams` and contributes no rows.
 */
export async function remoteActivity(
  resolved: ResolvedRemoteRef,
  options: { cursor?: string; limit: number; excludeWorkspaceAudit: boolean; baseUrl?: string },
  ctx: ToolContext
): Promise<RemoteActivityPage> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  const cursor = options.cursor
    ? decodeActivityCursor(options.cursor, resolved.ref)
    : { v: CURSOR_VERSION, ref: resolved.ref, src_offset: 0, lobu_before: null };
  const { type, parsed } = resolved;
  const streams: ActivityStreamStatus[] = [];

  const [source, lobu] = await Promise.all([
    type.backing_activity_sql && type.backing_source
      ? readRemoteByKey(
          {
            sql: type.backing_activity_sql,
            connection: type.backing_source,
            keyColumn: 'key',
            key: parsed.key,
            limit: limit + 1,
            offset: cursor.src_offset,
            sort: { column: 'sort_key', order: 'desc' },
          },
          ctx
        )
      : null,
    readLobuStream(resolved, cursor.lobu_before, limit + 1, ctx, options.excludeWorkspaceAudit).then(
      (rows) => ({ ok: true as const, rows }),
      (err: unknown) => {
        logger.warn({ err, ref: resolved.ref }, 'remote activity: Lobu stream failed');
        const code: ToolErrorCode = 'INTERNAL';
        return {
          ok: false as const,
          error: 'Lobu activity could not be read',
          error_code: code,
          retryable: isRetryable(code),
        };
      }
    ),
  ]);

  const sourceRows = source?.ok ? source.rows : [];
  if (source) {
    streams.push(
      source.ok
        ? { stream: 'source', ok: true }
        : {
            stream: 'source',
            ok: false,
            error: source.error,
            error_code: source.error_code,
            retryable: source.retryable,
          }
    );
  }
  const lobuRows = lobu.ok ? lobu.rows : [];
  streams.push(
    lobu.ok
      ? { stream: 'lobu', ok: true }
      : { stream: 'lobu', ok: false, error: lobu.error, error_code: lobu.error_code, retryable: lobu.retryable }
  );

  // Two-head merge: never reorders within a stream, so each stream's emitted
  // rows are a prefix of it and the cursor can resume both exactly.
  const sourceTime = (row: Record<string, unknown>) => Date.parse(toIso(row.occurred_at) ?? '') || 0;
  const lobuTime = (row: LobuRow) => Date.parse(row.sort_at) || 0;
  const emitted: Array<{ from: 'source'; row: Record<string, unknown> } | { from: 'lobu'; row: LobuRow }> = [];
  let si = 0;
  let li = 0;
  while (emitted.length < limit && (si < sourceRows.length || li < lobuRows.length)) {
    const takeSource =
      li >= lobuRows.length ||
      (si < sourceRows.length && sourceTime(sourceRows[si]) >= lobuTime(lobuRows[li]));
    if (takeSource) emitted.push({ from: 'source', row: sourceRows[si++] });
    else emitted.push({ from: 'lobu', row: lobuRows[li++] });
  }
  const hasMore = si < sourceRows.length || li < lobuRows.length;

  const lobuEmitted = emitted.flatMap((e) => (e.from === 'lobu' ? [e.row] : []));
  const ownerSlug = lobuEmitted.length > 0 ? await getOrganizationSlug(ctx.organizationId) : null;
  const rendered: ContentItem[] =
    lobuEmitted.length > 0
      ? await buildContentItems({
          sql: getDb(),
          rawContent: lobuEmitted,
          organizationId: ctx.organizationId,
          ownerSlug,
          baseUrl: options.baseUrl,
          includePrivateAttribution: ctx.memberRole != null,
        })
      : [];
  const renderedById = new Map(rendered.map((item) => [Number(item.id), item]));
  const items = emitted.map((e) =>
    e.from === 'source'
      ? sourceItem(e.row, resolved.ref)
      : { ...(renderedById.get(Number(e.row.id)) ?? e.row), stream: 'lobu' }
  );

  const lastLobu = lobuEmitted.at(-1);
  const next: Omit<ActivityCursor, 'v'> = {
    ref: resolved.ref,
    src_offset: cursor.src_offset + si,
    lobu_before: lastLobu ? { at: lastLobu.sort_at, id: Number(lastLobu.id) } : cursor.lobu_before,
  };
  return {
    items: items as Array<Record<string, unknown>>,
    streams,
    ...(hasMore ? { next_cursor: encodeActivityCursor(next) } : {}),
  };
}
