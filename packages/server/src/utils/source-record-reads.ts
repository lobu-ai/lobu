/**
 * Live Activity and Relationships for a source-backed record.
 *
 * A source-backed entity type (`entity_types.backing_sql`) has no stored rows,
 * so its records have no `entities.id` for events or edges to point at.
 * Instead, every read feed whose event kinds attribute to the type is asked
 * for that record's events through `FeedReadContext.match`, on the
 * attribution's own identity `eventPath`. Relationships are the event-kind
 * `relationships` declared over those attributions, read the same way.
 * Nothing is written.
 */

import type { EventAttributionRule } from '@lobu/connector-sdk';
import { getErrorMessage } from '@lobu/core';
import type { AuthzScope } from '../authz/scope';
import { compileConnectionRowVisibility } from '../authz/connection-visibility';
import { getDb } from '../db/client';
import { readSourceFeedPage } from '../lib/source-feed-page';
import { ToolUserError } from './errors';
import { getValueAtPath } from './object-path';

const READ_TIMEOUT_MS = 20_000;

type EventKinds = Record<
  string,
  {
    attributions?: EventAttributionRule[];
    relationships?: Array<{ type: string; from: string; to: string }>;
  }
>;

interface SourceFeed {
  feedId: number;
  connectorKey: string;
  matchPaths: string[];
  eventKinds: EventKinds;
}

/** A record of a source-backed type: its type slug plus the source key. */
export interface SourceRecordRef {
  type: string;
  key: string;
}

export interface SourceReadFailure {
  feed_id: number;
  error: string;
}

/** The attribution's first identity path the feed can filter on. */
function matchablePath(rule: EventAttributionRule, matchPaths: string[]): string | null {
  return rule.target.identities?.find((identity) => matchPaths.includes(identity.eventPath))?.eventPath ?? null;
}

async function loadSourceFeeds(scope: AuthzScope, type: string): Promise<SourceFeed[]> {
  const sql = getDb();
  const typeRows = await sql<{ backing_sql: string | null }>`
    SELECT backing_sql FROM entity_types
    WHERE organization_id = ${scope.organizationId} AND slug = ${type} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (typeRows.length === 0) throw new ToolUserError(`Entity type '${type}' not found`, 404);
  if (!typeRows[0].backing_sql) {
    throw new ToolUserError(`Entity type '${type}' is not source-backed; read its records by entity_id.`, 400);
  }
  // Bounded config tables only. The same visibility compiler as every other
  // source read, so a caller never sees a feed of a connection they cannot see.
  const rows = (await sql.unsafe(
    `SELECT f.id AS feed_id, c.connector_key, cd.feed_schema
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     JOIN LATERAL (
       SELECT cd0.feeds_schema -> f.feed_key AS feed_schema
       FROM connector_definitions cd0
       WHERE cd0.key = c.connector_key AND cd0.organization_id = $1 AND cd0.status = 'active'
       ORDER BY cd0.updated_at DESC, cd0.id DESC
       LIMIT 1
     ) cd ON TRUE
     WHERE f.organization_id = $1
       AND f.deleted_at IS NULL AND f.status = 'active'
       AND c.deleted_at IS NULL AND c.status = 'active'
       AND cd.feed_schema -> 'operations' ? 'read'
       AND jsonb_array_length(COALESCE(cd.feed_schema -> 'matchPaths', '[]'::jsonb)) > 0
       ${compileConnectionRowVisibility(scope, 'c')}
     ORDER BY f.id`,
    [scope.organizationId],
  )) as unknown as Array<{
    feed_id: number;
    connector_key: string;
    feed_schema: { matchPaths?: string[]; eventKinds?: EventKinds };
  }>;
  return rows
    .map((row) => ({
      feedId: Number(row.feed_id),
      connectorKey: row.connector_key,
      matchPaths: row.feed_schema.matchPaths ?? [],
      eventKinds: row.feed_schema.eventKinds ?? {},
    }))
    .filter((feed) =>
      Object.values(feed.eventKinds).some((kind) =>
        (kind.attributions ?? []).some(
          (rule) => rule.target.entityType === type && matchablePath(rule, feed.matchPaths),
        ),
      ),
    );
}

function decodeCursor(cursor: string | undefined): Record<string, string> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {}
  throw new ToolUserError('Invalid record activity cursor', 400);
}

function occurredAt(row: Record<string, unknown>): string {
  const value = row.occurred_at;
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * One page of a record's events across every attributing read feed, newest
 * first. The cursor carries each feed's own continuation, so a page never
 * skips a row; a failing feed is reported, never shown as "no activity".
 */
export async function readSourceRecordActivity(
  scope: AuthzScope,
  record: SourceRecordRef,
  options: { limit: number; cursor?: string; signal?: AbortSignal },
) {
  const feeds = await loadSourceFeeds(scope, record.type);
  const resume = decodeCursor(options.cursor);
  const reads = feeds
    .map((feed) => {
      const paths = new Set<string>();
      for (const kind of Object.values(feed.eventKinds)) {
        for (const rule of kind.attributions ?? []) {
          const path = rule.target.entityType === record.type ? matchablePath(rule, feed.matchPaths) : null;
          if (path) paths.add(path);
        }
      }
      return [...paths].map((path) => ({ feed, path, stream: `${feed.feedId}:${path}` }));
    })
    .flat()
    .filter((read) => !resume || resume[read.stream] !== undefined);

  const failures: SourceReadFailure[] = [];
  const next: Record<string, string> = {};
  const events: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  await Promise.all(
    reads.map(async ({ feed, path, stream }) => {
      try {
        const page = await readSourceFeedPage(
          {
            feed_id: feed.feedId,
            match: { path, values: [record.key] },
            limit: options.limit,
            cursor: resume?.[stream],
          },
          READ_TIMEOUT_MS,
          scope,
          options.signal,
        );
        if (page.next_cursor) next[stream] = page.next_cursor;
        for (const row of page.rows) {
          const originId = String(row.origin_id ?? '');
          const dedupe = `${feed.feedId}:${originId}`;
          if (originId && seen.has(dedupe)) continue;
          seen.add(dedupe);
          events.push({
            feed_id: feed.feedId,
            platform: feed.connectorKey,
            origin_id: originId,
            origin_type: row.origin_type ?? null,
            title: row.title ?? null,
            payload_text: row.payload_text ?? null,
            author_name: row.author_name ?? null,
            source_url: row.source_url ?? null,
            occurred_at: occurredAt(row),
            metadata: row.metadata ?? {},
          });
        }
      } catch (error) {
        failures.push({ feed_id: feed.feedId, error: getErrorMessage(error) });
      }
    }),
  );
  events.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  return {
    events,
    failures,
    next_cursor: Object.keys(next).length
      ? Buffer.from(JSON.stringify(next), 'utf8').toString('base64url')
      : undefined,
  };
}

export interface SourceRecordLink {
  relationship_type: string;
  direction: 'outgoing' | 'incoming';
  entity_type: string;
  key: string;
  name: string;
  occurred_at: string;
  source_url: string | null;
}

/**
 * A record's relationships, read live from events whose kinds declare
 * `relationships` over attributions to this type. Each pair is reported once,
 * from its newest event.
 */
export async function readSourceRecordLinks(
  scope: AuthzScope,
  record: SourceRecordRef,
  options: { limit: number; signal?: AbortSignal },
) {
  const feeds = await loadSourceFeeds(scope, record.type);
  const reads: Array<{ feed: SourceFeed; kind: string; path: string; type: string; direction: 'outgoing' | 'incoming'; other: EventAttributionRule }> = [];
  for (const feed of feeds) {
    for (const [kind, spec] of Object.entries(feed.eventKinds)) {
      const byName = new Map((spec.attributions ?? []).filter((rule) => rule.name).map((rule) => [rule.name!, rule]));
      for (const relationship of spec.relationships ?? []) {
        const from = byName.get(relationship.from);
        const to = byName.get(relationship.to);
        if (!from || !to) continue;
        for (const [self, other, direction] of [[from, to, 'outgoing'], [to, from, 'incoming']] as const) {
          const path = self.target.entityType === record.type ? matchablePath(self, feed.matchPaths) : null;
          if (path) reads.push({ feed, kind, path, type: relationship.type, direction, other });
        }
      }
    }
  }

  const failures: SourceReadFailure[] = [];
  const links = new Map<string, SourceRecordLink>();
  await Promise.all(
    reads.map(async (read) => {
      try {
        const page = await readSourceFeedPage(
          { feed_id: read.feed.feedId, match: { path: read.path, values: [record.key] }, limit: options.limit },
          READ_TIMEOUT_MS,
          scope,
          options.signal,
        );
        for (const row of page.rows) {
          if (row.origin_type != null && row.origin_type !== read.kind) continue;
          const otherKey = (read.other.target.identities ?? [])
            .map((identity) => getValueAtPath(row, identity.eventPath))
            .find((value) => value != null && String(value).trim() !== '');
          if (otherKey == null || !read.other.target.entityType) continue;
          const key = String(otherKey).trim();
          const name = read.other.target.titlePath ? getValueAtPath(row, read.other.target.titlePath) : null;
          const link: SourceRecordLink = {
            relationship_type: read.type,
            direction: read.direction,
            entity_type: read.other.target.entityType,
            key,
            name: name == null || String(name).trim() === '' ? key : String(name),
            occurred_at: occurredAt(row),
            source_url: row.source_url == null ? null : String(row.source_url),
          };
          const id = `${link.relationship_type}:${link.direction}:${link.entity_type}:${key}`;
          const existing = links.get(id);
          if (!existing || existing.occurred_at < link.occurred_at) links.set(id, link);
        }
      } catch (error) {
        failures.push({ feed_id: read.feed.feedId, error: getErrorMessage(error) });
      }
    }),
  );
  return {
    links: [...links.values()].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
    failures,
  };
}
