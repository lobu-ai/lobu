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

import { createHash } from "node:crypto";
import type { EventAttributionRule } from "@lobu/connector-sdk";
import { getErrorMessage } from "@lobu/core";
import type { GetContentArgs } from "@lobu/core/contracts/tools/read-knowledge";
import type { AuthzScope } from "../authz/scope";
import { compileConnectionRowVisibility } from "../authz/connection-visibility";
import { getDb } from "../db/client";
import { readSourceFeedPage } from "../lib/source-feed-page";
import { ToolUserError } from "./errors";
import { getValueAtPath } from "./object-path";

const READ_TIMEOUT_MS = 20_000;
/** Source pages a relationship read follows per stream before reporting it incomplete. */
const MAX_LINK_PAGES = 10;
const LINK_PAGE_SIZE = 200;

type EventKinds = Record<
  string,
  {
    attributions?: EventAttributionRule[];
    relationships?: Array<{ type: string; from: string; to: string }>;
  }
>;

interface SourceFeed {
  feedId: number;
  connectionId: number;
  connectorKey: string;
  matchPaths: string[];
  eventKinds: EventKinds;
}

/** A record of a source-backed type: its type slug plus the source key. */
interface SourceRecordRef {
  type: string;
  key: string;
}

interface SourceReadFailure {
  feed_id: number;
  error: string;
}

/** The attribution's first identity path the feed can filter on. */
function matchablePath(
  rule: EventAttributionRule,
  matchPaths: string[]
): string | null {
  return (
    rule.target.identities?.find((identity) =>
      matchPaths.includes(identity.eventPath)
    )?.eventPath ?? null
  );
}

async function loadSourceFeeds(
  scope: AuthzScope,
  type: string
): Promise<SourceFeed[]> {
  const sql = getDb();
  const typeRows = await sql<{ backing_sql: string | null }>`
    SELECT backing_sql FROM entity_types
    WHERE organization_id = ${scope.organizationId} AND slug = ${type} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (typeRows.length === 0)
    throw new ToolUserError(`Entity type '${type}' not found`, 404);
  if (!typeRows[0].backing_sql) {
    throw new ToolUserError(
      `Entity type '${type}' is not source-backed; read its records by entity_id.`,
      400
    );
  }
  // Bounded config tables only. The same visibility compiler as every other
  // source read, so a caller never sees a feed of a connection they cannot see.
  const rows = (await sql.unsafe(
    `SELECT f.id AS feed_id, c.id AS connection_id, c.connector_key, cd.feed_schema
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     JOIN LATERAL (
       SELECT cd0.feeds_schema -> f.feed_key AS feed_schema
       FROM connector_definitions cd0
       WHERE cd0.key = c.connector_key AND cd0.organization_id = $1
         AND (
           (f.pinned_version IS NULL AND cd0.status = 'active')
           OR (f.pinned_version IS NOT NULL
               AND (cd0.version = f.pinned_version OR cd0.status = 'active'))
         )
       -- The same definition precedence as readSourceFeed, so discovery and
       -- the read agree on a pinned feed's matchPaths and event kinds.
       ORDER BY (cd0.version = f.pinned_version) DESC,
                (cd0.status = 'active') DESC,
                cd0.updated_at DESC,
                cd0.id DESC
       LIMIT 1
     ) cd ON TRUE
     WHERE f.organization_id = $1
       AND f.deleted_at IS NULL AND f.status = 'active'
       AND c.deleted_at IS NULL AND c.status = 'active'
       AND cd.feed_schema -> 'operations' ? 'read'
       AND jsonb_array_length(COALESCE(cd.feed_schema -> 'matchPaths', '[]'::jsonb)) > 0
       ${compileConnectionRowVisibility(scope, "c")}
     ORDER BY f.id`,
    [scope.organizationId]
  )) as unknown as Array<{
    feed_id: number;
    connection_id: number;
    connector_key: string;
    feed_schema: { matchPaths?: string[]; eventKinds?: EventKinds };
  }>;
  return rows
    .map((row) => ({
      feedId: Number(row.feed_id),
      connectionId: Number(row.connection_id),
      connectorKey: row.connector_key,
      matchPaths: row.feed_schema.matchPaths ?? [],
      eventKinds: row.feed_schema.eventKinds ?? {},
    }))
    .filter((feed) =>
      Object.values(feed.eventKinds).some((kind) =>
        (kind.attributions ?? []).some(
          (rule) =>
            rule.target.entityType === type &&
            matchablePath(rule, feed.matchPaths)
        )
      )
    );
}

/**
 * The shared envelope of a stream cursor: base64url JSON whose `streams` is a
 * non-empty object of valid positions. Null when malformed; the caller checks
 * its own request binding and version.
 */
function parseStreamCursor<T>(
  cursor: string,
  isPosition: (value: unknown) => value is T
): { request?: unknown; version?: unknown; streams: Record<string, T> } | null {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const streams = parsed?.streams;
  if (
    !streams ||
    typeof streams !== "object" ||
    Array.isArray(streams) ||
    Object.keys(streams).length === 0 ||
    !Object.values(streams).every(isPosition)
  ) {
    return null;
  }
  return parsed;
}

/** One exact source cursor per stream, bound to its record and source selection. */
function decodeCursor(
  cursor: string | undefined,
  request: string
): Record<string, string | null> | null {
  if (!cursor) return null;
  const parsed = parseStreamCursor(
    cursor,
    (value): value is string | null =>
      value === null || (typeof value === "string" && value.length > 0)
  );
  if (typeof parsed?.request !== "string") {
    throw new ToolUserError("Invalid record activity cursor", 400);
  }
  if (parsed.request !== request) {
    throw new ToolUserError("Record activity cursor does not match this record or filters. Restart from the first page.", 400);
  }
  return parsed.streams;
}

function occurredAt(row: Record<string, unknown>): string {
  const value = row.occurred_at;
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** The read streams of a record: one per feed and matchable identity path. */
function activityStreams(feeds: SourceFeed[], type: string) {
  return feeds.flatMap((feed) => {
    const paths = new Set<string>();
    for (const kind of Object.values(feed.eventKinds)) {
      for (const rule of kind.attributions ?? []) {
        const path =
          rule.target.entityType === type
            ? matchablePath(rule, feed.matchPaths)
            : null;
        if (path) paths.add(path);
      }
    }
    return [...paths].map((path) => ({
      feed,
      path,
      stream: `${feed.feedId}:${path}`,
    }));
  });
}

/**
 * One page of a record's events across every attributing read feed, newest
 * first and at most `limit` long. Streams are merged by occurred_at; the
 * cursor resumes each stream after its last consumed row, so unconsumed rows
 * stay at the source. A failing feed is reported, never shown as "no activity", and resumes where it stopped.
 */
export async function readSourceRecordActivity(
  scope: AuthzScope,
  record: SourceRecordRef,
  options: { limit: number; cursor?: string; signal?: AbortSignal; automationId?: number | null } &
    Pick<GetContentArgs, "platforms" | "connection_ids" | "feed_ids">
) {
  const platforms = [...new Set(options.platforms?.map((value) => value.trim()).filter(Boolean))].sort();
  const connections = [...new Set(options.connection_ids)].sort((a, b) => a - b);
  const selectedFeeds = [...new Set(options.feed_ids)].sort((a, b) => a - b);
  const request = JSON.stringify([scope.organizationId, record.type, record.key, platforms, connections, selectedFeeds]);
  const resume = decodeCursor(options.cursor, request);
  // Discovery already enforces connection visibility. Selection only narrows
  // that bounded config set and never starts a read for an excluded feed.
  const feeds = (await loadSourceFeeds(scope, record.type)).filter((feed) =>
    (!platforms.length || platforms.includes(feed.connectorKey)) &&
    (!connections.length || connections.includes(feed.connectionId)) &&
    (!selectedFeeds.length || selectedFeeds.includes(feed.feedId))
  );
  const reads = activityStreams(feeds, record.type).flatMap((read) => {
    const cursor = resume ? resume[read.stream] : null;
    return cursor !== undefined ? [{ ...read, cursor }] : [];
  });

  const failures: SourceReadFailure[] = [];
  const next: Record<string, string | null> = {};
  const pages = (
    await Promise.all(
      reads.map(async ({ feed, path, stream, cursor }) => {
        try {
          const page = await readSourceFeedPage(
            {
              feed_id: feed.feedId,
              match: { path, values: [record.key] },
              limit: options.limit,
              cursor: cursor ?? undefined,
            },
            READ_TIMEOUT_MS,
            scope,
            options.signal,
            options.automationId
          );
          if (page.rows.length > 0 && !page.row_cursors) {
            throw new Error("This feed cannot resume after individual rows; merged record activity requires exact row cursors.");
          }
          return [{ feed, path, stream, cursor, page, taken: 0 }];
        } catch (error) {
          failures.push({
            feed_id: feed.feedId,
            error: getErrorMessage(error),
          });
          next[stream] = cursor;
          return [];
        }
      })
    )
  ).flat();

  // A row belongs to the first of its kind's paths that holds this record's
  // key. An event reachable through two paths is then returned by one stream
  // only, so it appears once across all pages.
  const keeps = (
    feed: SourceFeed,
    path: string,
    row: Record<string, unknown>
  ) => {
    const paths = (
      feed.eventKinds[String(row.origin_type ?? "")]?.attributions ?? []
    )
      .map((rule) =>
        rule.target.entityType === record.type
          ? matchablePath(rule, feed.matchPaths)
          : null
      )
      .filter((candidate): candidate is string => candidate !== null);
    if (!paths.includes(path)) return false;
    const owner = paths.find(
      (candidate) =>
        String(getValueAtPath(row, candidate) ?? "").trim() === record.key
    );
    return (owner ?? path) === path;
  };

  // k-way merge over each stream's rows in source order. It stops once a
  // stream with more pages runs out of read rows: its next row could be
  // newer than anything left in the others.
  const events: Array<Record<string, unknown>> = [];
  while (events.length < options.limit) {
    let best: (typeof pages)[number] | null = null;
    let blocked = false;
    for (const stream of pages) {
      while (
        stream.taken < stream.page.rows.length &&
        !keeps(stream.feed, stream.path, stream.page.rows[stream.taken])
      ) {
        stream.taken += 1;
      }
      if (stream.taken >= stream.page.rows.length) {
        if (stream.page.next_cursor) blocked = true;
        continue;
      }
      if (
        !best ||
        occurredAt(stream.page.rows[stream.taken]) >
          occurredAt(best.page.rows[best.taken])
      ) {
        best = stream;
      }
    }
    if (!best || blocked) break;
    const row = best.page.rows[best.taken];
    best.taken += 1;
    const originId = String(row.origin_id ?? "");
    events.push({
      feed_id: best.feed.feedId,
      platform: best.feed.connectorKey,
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

  for (const { stream, cursor, page, taken } of pages) {
    if (taken < page.rows.length) {
      next[stream] = taken > 0 ? page.row_cursors![taken - 1] : cursor;
    } else if (page.next_cursor) {
      // Provider page tokens may use offsets even when exact row checkpoints exist.
      next[stream] = taken > 0 ? page.row_cursors![taken - 1] : page.next_cursor;
    }
  }
  return {
    events,
    failures,
    next_cursor: Object.keys(next).length
      ? Buffer.from(JSON.stringify({ request, streams: next }), "utf8").toString("base64url")
      : undefined,
  };
}

interface SourceRecordLink {
  relationship_type: string;
  direction: "outgoing" | "incoming";
  entity_type: string;
  key: string;
  name: string;
  occurred_at: string;
  source_url: string | null;
}

interface LinkRead {
  feed: SourceFeed;
  kind: string;
  path: string;
  type: string;
  direction: "outgoing" | "incoming";
  other: EventAttributionRule;
}

interface LinkPosition {
  after: string | null;
  /** A partially consumed source row may declare several relationships. */
  event: string | null;
  skip: number;
}

function isLinkPosition(value: unknown): value is LinkPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { after, event, skip } = value as LinkPosition;
  return (
    (after === null || (typeof after === "string" && after.length > 0)) &&
    (event === null || (typeof event === "string" && event.length > 0)) &&
    Number.isSafeInteger(skip) &&
    skip >= 0 &&
    // Links can only be skipped within a named, partially consumed row.
    (skip === 0 || event !== null)
  );
}

function decodeLinkCursor(
  cursor: string,
  request: string
): Record<string, LinkPosition> {
  const parsed = parseStreamCursor(cursor, isLinkPosition);
  if (parsed?.version !== 1 || parsed.request !== request) {
    throw new ToolUserError("Invalid relationship cursor, or its caller, record, filters or sources changed. Restart from the first page.", 400);
  }
  return parsed.streams;
}

/** Dedupe key of a relationship within one page. */
function linkKey(link: SourceRecordLink): string {
  return JSON.stringify([
    link.relationship_type,
    link.direction,
    link.entity_type,
    link.key,
  ]);
}

/** Bounded reads with source-owned checkpoints; never retain history in a cursor.
 * Links are unique within a page. The same pair can have evidence on later pages,
 * so consumers merge pages by (relationship_type, direction, entity_type, key),
 * keeping the newest occurred_at. This also handles a recovering source safely. */
async function readLinkPage(
  scope: AuthzScope,
  record: SourceRecordRef,
  reads: LinkRead[],
  request: string,
  options: { limit: number; cursor: string | null; signal?: AbortSignal; automationId?: number | null }
) {
  const resume = options.cursor === null ? null : decodeLinkCursor(options.cursor, request);
  const grouped = new Map<string, LinkRead[]>();
  for (const read of reads) {
    const key = `${read.feed.feedId}:${read.path}`;
    const group = grouped.get(key) ?? [];
    group.push(read);
    grouped.set(key, group);
  }
  // The binding hash is not a signature. Validate the client-supplied stream
  // keys too, so a malformed cursor cannot silently look like exhaustion.
  if (resume && Object.keys(resume).some(key => !grouped.has(key))) {
    throw new ToolUserError("Invalid relationship cursor streams. Restart from the first page.", 400);
  }
  const failures: SourceReadFailure[] = [];
  const next: Record<string, LinkPosition> = {};
  // Each stream's partial-row state: `taken` rows of its page are fully
  // consumed, and `skip` links of row `taken` were already returned.
  const pages = (
    await Promise.all(
      [...grouped].map(async ([key, group]) => {
        const position = resume
          ? resume[key]
          : { after: null, event: null, skip: 0 };
        if (!position) return [];
        const { feed, path } = group[0];
        try {
          if (position.skip > group.length) {
            throw new Error("Invalid relationship cursor row position");
          }
          const page = await readSourceFeedPage(
            {
              feed_id: feed.feedId,
              match: { path, values: [record.key] },
              limit: options.limit,
              cursor: position.after ?? undefined,
            },
            READ_TIMEOUT_MS,
            scope,
            options.signal,
            options.automationId
          );
          if (
            page.rows.some(
              (row) => typeof row.origin_id !== "string" || !row.origin_id
            )
          ) {
            throw new Error("Relationship pagination requires stable source row identities.");
          }
          const rowCursorsAdvance =
            page.row_cursors?.length === page.rows.length &&
            page.row_cursors.every(
              (cursor) =>
                typeof cursor === "string" && cursor !== "" && cursor !== position.after
            );
          if (page.rows.length > 0 && !rowCursorsAdvance) {
            throw new Error("Relationship pagination requires advancing per-row source cursors.");
          }
          if (page.next_cursor && page.next_cursor === position.after) {
            throw new Error("The source cursor did not advance.");
          }
          // If the partially consumed row was deleted, its successor starts at zero.
          const resumesPartialRow =
            String(page.rows[0]?.origin_id ?? "") === position.event;
          return [
            {
              key,
              group,
              position,
              page,
              taken: 0,
              skip: resumesPartialRow ? position.skip : 0,
            },
          ];
        } catch (error) {
          failures.push({ feed_id: feed.feedId, error: getErrorMessage(error) });
          next[key] = position;
          return [];
        }
      })
    )
  ).flat();

  /** The distinct links of a stream's current row, in declaration order. */
  const rowLinks = (stream: (typeof pages)[number]): SourceRecordLink[] => {
    const row = stream.page.rows[stream.taken];
    if (!row) return [];
    const links = new Map<string, SourceRecordLink>();
    for (const read of stream.group) {
      if (
        row.origin_type !== read.kind ||
        String(getValueAtPath(row, read.path) ?? "").trim() !== record.key
      ) {
        continue;
      }
      const otherKey = (read.other.target.identities ?? [])
        .map((identity) => getValueAtPath(row, identity.eventPath))
        .find((value) => value != null && String(value).trim() !== "");
      if (otherKey == null || !read.other.target.entityType) continue;
      const key = String(otherKey).trim();
      const name = read.other.target.titlePath
        ? getValueAtPath(row, read.other.target.titlePath)
        : null;
      const link: SourceRecordLink = {
        relationship_type: read.type,
        direction: read.direction,
        entity_type: read.other.target.entityType,
        key,
        name: name == null || String(name).trim() === "" ? key : String(name),
        occurred_at: occurredAt(row),
        source_url: row.source_url == null ? null : String(row.source_url),
      };
      links.set(linkKey(link), link);
    }
    return [...links.values()];
  };

  const links = new Map<string, SourceRecordLink>();
  while (links.size < options.limit) {
    let best: (typeof pages)[number] | undefined;
    let candidate: SourceRecordLink | undefined;
    let blocked = false;
    for (const stream of pages) {
      let available = rowLinks(stream);
      while (stream.taken < stream.page.rows.length && stream.skip >= available.length) {
        stream.taken += 1;
        stream.skip = 0;
        available = rowLinks(stream);
      }
      if (stream.taken >= stream.page.rows.length) {
        if (stream.page.next_cursor) blocked = true;
        continue;
      }
      if (!candidate || available[stream.skip].occurred_at > candidate.occurred_at) {
        best = stream;
        candidate = available[stream.skip];
      }
    }
    if (!best || !candidate || blocked) break;
    const key = linkKey(candidate);
    if (!links.has(key)) links.set(key, candidate);
    best.skip += 1;
  }
  for (const stream of pages) {
    // Complete a fully consumed row even if it filled the page exactly.
    if (stream.taken < stream.page.rows.length && stream.skip >= rowLinks(stream).length) {
      stream.taken += 1;
      stream.skip = 0;
    }
    const { key, position, page, taken, skip } = stream;
    const after = taken > 0 ? page.row_cursors![taken - 1] : position.after;
    if (taken < page.rows.length) {
      next[key] = { after, event: skip ? String(page.rows[taken].origin_id) : null, skip };
    } else if (page.next_cursor) {
      next[key] = { after: taken ? after : page.next_cursor, event: null, skip: 0 };
    }
  }
  return {
    links: [...links.values()], failures,
    next_cursor: Object.keys(next).length
      ? Buffer.from(JSON.stringify({ version: 1, request, streams: next }), "utf8").toString("base64url")
      : null,
  };
}

/**
 * A record's relationships, read live from events whose kinds declare
 * `relationships` over attributions to this type. Without a cursor each pair
 * is reported once, from its newest event; with one, see readLinkPage.
 */
export async function readSourceRecordLinks(
  scope: AuthzScope,
  record: SourceRecordRef,
  options: {
    limit: number;
    cursor?: string | null;
    relationshipType?: string;
    direction?: "outgoing" | "incoming";
    signal?: AbortSignal;
    automationId?: number | null;
  }
) {
  const feeds = await loadSourceFeeds(scope, record.type);
  const reads: LinkRead[] = [];
  for (const feed of feeds) {
    for (const [kind, spec] of Object.entries(feed.eventKinds)) {
      const byName = new Map(
        (spec.attributions ?? [])
          .filter((rule) => rule.name)
          .map((rule) => [rule.name!, rule])
      );
      for (const relationship of spec.relationships ?? []) {
        if (
          options.relationshipType &&
          relationship.type !== options.relationshipType
        )
          continue;
        const from = byName.get(relationship.from);
        const to = byName.get(relationship.to);
        if (!from || !to) continue;
        for (const [self, other, direction] of [
          [from, to, "outgoing"],
          [to, from, "incoming"],
        ] as const) {
          const path =
            self.target.entityType === record.type
              ? matchablePath(self, feed.matchPaths)
              : null;
          if (path && (!options.direction || options.direction === direction))
            reads.push({
              feed,
              kind,
              path,
              type: relationship.type,
              direction,
              other,
            });
        }
      }
    }
  }

  if (options.cursor !== undefined) {
    const request = createHash("sha256").update(JSON.stringify([
      scope.organizationId, scope.principal, scope.agentId ?? null,
      record.type, record.key, options.relationshipType ?? null, options.direction ?? null,
      feeds.map(feed => [feed.feedId, feed.connectionId, feed.matchPaths, feed.eventKinds]),
    ])).digest("hex");
    return readLinkPage(scope, record, reads, request, { ...options, cursor: options.cursor });
  }

  const failures: SourceReadFailure[] = [];
  // Relationships sharing a feed and path read its source pages once, and a
  // failing stream is reported once.
  const streams = new Map<string, Promise<Array<Record<string, unknown>> | null>>();
  const readStream = async (feed: SourceFeed, path: string) => {
    try {
      const rows: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber === MAX_LINK_PAGES) {
          throw new Error(
            `more than ${MAX_LINK_PAGES} source pages; relationships beyond them were not read`
          );
        }
        const page = await readSourceFeedPage(
          {
            feed_id: feed.feedId,
            match: { path, values: [record.key] },
            limit: LINK_PAGE_SIZE,
            cursor,
          },
          READ_TIMEOUT_MS,
          scope,
          options.signal,
          options.automationId
        );
        rows.push(...page.rows);
        cursor = page.next_cursor;
        if (!cursor) return rows;
      }
    } catch (error) {
      failures.push({ feed_id: feed.feedId, error: getErrorMessage(error) });
      return null;
    }
  };
  const links = new Map<string, SourceRecordLink>();
  await Promise.all(
    reads.map(async (read) => {
      const stream = `${read.feed.feedId}:${read.path}`;
      if (!streams.has(stream)) streams.set(stream, readStream(read.feed, read.path));
      const rows = await streams.get(stream)!;
      for (const row of rows ?? []) {
        if (row.origin_type !== read.kind) continue;
        const otherKey = (read.other.target.identities ?? [])
          .map((identity) => getValueAtPath(row, identity.eventPath))
          .find((value) => value != null && String(value).trim() !== "");
        if (otherKey == null || !read.other.target.entityType) continue;
        const key = String(otherKey).trim();
        const name = read.other.target.titlePath
          ? getValueAtPath(row, read.other.target.titlePath)
          : null;
        const link: SourceRecordLink = {
          relationship_type: read.type,
          direction: read.direction,
          entity_type: read.other.target.entityType,
          key,
          name:
            name == null || String(name).trim() === "" ? key : String(name),
          occurred_at: occurredAt(row),
          source_url: row.source_url == null ? null : String(row.source_url),
        };
        const id = `${link.relationship_type}:${link.direction}:${link.entity_type}:${key}`;
        const existing = links.get(id);
        if (!existing || existing.occurred_at < link.occurred_at)
          links.set(id, link);
      }
    })
  );
  return {
    links: [...links.values()]
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .slice(0, options.limit),
    failures,
  };
}
