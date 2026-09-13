/**
 * Centralized event insertion.
 *
 * Every row in the `events` table should go through this module so we have
 * a single place for validation, defaults, and future hooks (e.g. embeddings).
 */

import { retryWithBackoff } from '@lobu/core';
import { type DbClient, getDb } from '../db/client';
import { stripIdentityScopeProjectionMetadata } from '../identity/scope-projection';
import { getActingAutomationScope } from './acting-automation-context';
import {
  enqueueWorkspaceEventActivations,
  findSubscribedWorkspaceEventTypes,
  loadRunEventCausality,
} from '../automations/workspace-event-enqueue';
import { WorkspaceEventCausalityLimitError } from '../automations/workspace-event-contract';
import {
  AUDIT_EVENT_TYPE_METADATA_KEY,
  type AuditEventType,
  formatAuditEventType,
} from './audit-event-type';
import type {
  AuditLifecycleSubject,
  EdgeOp,
} from '../automations/platform-event-catalog';
import {
  type AuditResourceKind,
  type ConfigResourceKind,
  redactConfigState,
  type WorkspaceAuditResourceKind,
} from './config-redaction';
import {
  lookupGeoEnrichment,
  mergeEnrichedMetadata,
} from './geo-enrichment';
import logger from './logger';
import { isUniqueViolation } from './pg-errors';
import { stripNul, stripNulDeep } from './strip-nul';
import {
  isBrowserConnectorKey,
  sanitizeBrowserIngestionFields,
  sanitizeBrowserText,
} from './browser-ingestion-sanitizer';

/**
 * Single bounded retry for the fire-and-forget audit writers below
 * (recordChangeEvent / recordLifecycleEvent). One retry after a short delay
 * rides out transient DB blips (pool checkout timeout, failover) without
 * turning the audit path into a queue; a persistent failure is surfaced at
 * error level instead of being silently dropped.
 */
const AUDIT_EVENT_RETRY = { maxRetries: 1, baseDelay: 500 } as const;

// Namespace for pg_advisory_xact_lock(key1, key2) used to serialize the
// dedup-on-(connection_id, origin_id) read-then-insert path below. Kept in the
// signed int32 range required by PostgreSQL's two-key advisory lock overload.
// "evdd" = events-dedup.
const EVENT_DEDUP_LOCK_NAMESPACE = 0x65766464;

/**
 * Stable 32-bit FNV-1a hash of `connection_id:origin_id`, used as the second
 * key for pg_advisory_xact_lock. Concurrent ingests of the SAME item
 * (same connection + origin) serialize on this key; different items never
 * contend. Collisions only cost a little extra serialization, never
 * correctness.
 */
export function eventDedupLockKey(connectionId: number, originId: string): number {
  let hash = 0x811c9dc5;
  const s = `${connectionId}:${originId}`;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** Serialize writes for one connection-scoped source identity in a transaction. */
export async function lockEventDedupIdentity(
  sql: DbClient,
  connectionId: number,
  originId: string
): Promise<void> {
  const lockKey = eventDedupLockKey(connectionId, originId);
  await sql`
    SELECT pg_advisory_xact_lock(${EVENT_DEDUP_LOCK_NAMESPACE}, ${lockKey})
  `;
}

// ============================================
// Types
// ============================================

export interface InsertEventParams {
  entityIds: number[];
  organizationId: string | null;
  originId: string;

  title?: string | null;
  payloadType?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty';
  content?: string | null;
  payloadData?: Record<string, unknown>;
  payloadTemplate?: Record<string, unknown> | null;
  attachments?: unknown[];
  authorName?: string | null;
  sourceUrl?: string | null;
  /** Source-side timestamp. Defaults to insert time when omitted — a NULL
   *  occurred_at is excluded by date windows and can prevent cursor pagination,
   *  so "recorded now" is the better approximation. */
  occurredAt?: Date | string | null;
  semanticType: string;
  originType?: string | null;
  metadata?: Record<string, unknown>;

  /** Connector-sourced fields */
  connectorKey?: string | null;
  connectionId?: number | null;
  feedKey?: string | null;
  feedId?: number | null;
  runId?: number | null;
  /**
   * The Automation that PRODUCED this row, and the version of it that ran.
   * Produced, never analyzed — an Automation reading an event does not stamp it.
   *
   * Set it on the first write. A supersede copies producer/source lineage
   * from the predecessor — omit or null cannot drop it. A later number
   * restamps this version (new run / prompt version). Self-exclusion keys on
   * this column; human corrections do not clear the producer stamp.
   */
  automationId?: number | null;
  automationVersionId?: number | null;
  parentOriginId?: string | null;
  score?: number | null;
  embedding?: number[] | null;
  /** Model/version stamp that produced `embedding`; persisted so vector spaces never mix. */
  embeddingModel?: string | null;
  interactionType?: 'none' | 'approval' | 'suggestion';
  interactionStatus?:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'completed'
    | 'failed'
    // Non-blocking suggested actions: 'current' while shown, superseded or
    // cleared by a later successful turn rather than resolved by a click.
    | 'current'
    | null;
  interactionInputSchema?: Record<string, unknown> | null;
  interactionInput?: Record<string, unknown> | null;
  interactionOutput?: Record<string, unknown> | null;
  interactionError?: string | null;
  supersedesEventId?: number | null;

  /**
   * Stable identity of the THING this row is a version of, for writers that
   * have one. `events.id` is a stored-version id — a supersede mints a new one
   * — so it can never serve as cross-version identity.
   *
   * Namespaces that claim uniqueness get their own partial unique index over
   * chain ROOTS (see `idx_events_identity_root_automation`), which is what makes
   * "exactly one current version per thing" a database guarantee rather than a
   * convention two concurrent writers can silently violate. Roots, not live
   * heads: this function inserts the successor before stamping the
   * predecessor's `superseded_by`, so both are briefly live and a live-head
   * index would reject every ordinary supersede. Uniqueness is declared per
   * namespace on purpose: `entity_identities` instead enforces one blanket
   * index across every namespace, so a namespace that should not be unique has
   * no way to say so.
   *
   * Rows with no stable identity (messages, notes, tombstones, change audits)
   * leave this unset — there is no "current version of" a one-shot event.
   */
  identity?: { ns: string; key: string } | null;

  /** Audit */
  createdBy?: string | null;
  clientId?: string | null;
}

/**
 * How an insertEvent call settled.
 *
 * `state_updated` means durable content matched an existing head and only
 * volatile source state (engagement counters, `updated_at`) was reconciled onto
 * that row in place — no new stored version, no new vector. Consumers that
 * treat `superseded` as "the source item changed" should treat this the same
 * way; consumers that commit per-version side effects (artifacts, workspace
 * event activations) should treat it as `unchanged`.
 */
export type EventChangeKind = 'inserted' | 'superseded' | 'unchanged' | 'state_updated';

export interface InsertedEvent {
  id: number;
  entity_ids: number[] | null;
  origin_id: string;
  title: string | null;
  semantic_type: string;
  created_at: string;
  /** Whether this call landed a new immutable row or reused identical state. */
  change: EventChangeKind;
}

/** Key-order-independent JSON serialization for semantic equality checks. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * The fields of a materialized attachment that survive re-publication.
 *
 * Everything else on the reference is minted per publication and says nothing
 * about whether the attachment changed. `artifact_id` and `download_url` are
 * obviously so. `filename` is too, and less obviously: the retired
 * whatsapp.local bridge named voice notes with a fresh UUID each time, so prod
 * still carries supersede chains where the same 18623 bytes were stored as
 * `1c692a09-….opus` and then `cc9eab3c-….opus`. `size_bytes` and `duration_ms`
 * are derived from the bytes, so `sha256` already covers them.
 */
const DURABLE_ATTACHMENT_KEYS = ['kind', 'mime_type', 'sha256'] as const;

/**
 * Dedup view of `events.attachments`.
 *
 * A re-sync re-publishes the same bytes, so comparing attachments raw makes
 * every re-sync look like a new version and supersedes forever — prod has
 * three stored versions of one voice note that differ only by re-publication.
 * An attachment IS its bytes, so a materialized one is compared on its content
 * hash and how it is presented, and nothing else.
 *
 * Reducing to those keys is conditional on `sha256` being present, and the
 * condition is load-bearing rather than defensive. An attachment without one
 * was not published by us (a connector may reference an artifact it already
 * owns), so its `artifact_id` is durable identity, not a per-publication
 * accident — dropping it would collapse two distinct references into one. Rows
 * written before this field existed also land here, so the first re-sync after
 * deploy supersedes once and is stable from then on.
 *
 * Deliberate consequence: renaming an attachment without changing its bytes no
 * longer mints a new stored version.
 */
function semanticAttachmentState(attachments: unknown[] | undefined): string {
  if (!Array.isArray(attachments)) return stableJson([]);
  return stableJson(
    attachments.map((attachment) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
        return attachment;
      }
      const record = attachment as Record<string, unknown>;
      if (typeof record.sha256 !== 'string' || record.sha256.length === 0) return record;
      const durable: Record<string, unknown> = {};
      for (const key of DURABLE_ATTACHMENT_KEYS) {
        if (record[key] !== undefined) durable[key] = record[key];
      }
      return durable;
    })
  );
}

/**
 * Metadata keys whose value is a point-in-time observation of source state, not
 * something anyone authored.
 *
 * Measured on the 200,000 most recent supersede pairs in prod: 164,915 (82.5%)
 * differed ONLY in `score`/`metadata` with title, payload_text and attachments
 * byte-identical. Comparing metadata raw therefore minted a whole new stored
 * version — a duplicate row, a duplicate 768-dim vector and a permanent ivfflat
 * entry — every time an upvote landed.
 *
 * Same reasoning as DURABLE_ATTACHMENT_KEYS above, which already fixed this
 * exact class for attachments (they now differ in 7 of 200,000 pairs). These
 * keys are excluded from the durable comparison and written in place instead.
 */
const VOLATILE_METADATA_KEYS = new Set([
  'score',
  'upvote_ratio',
  'reply_count',
  'comments',
  'num_comments',
  'view_count',
  'like_count',
  'retweet_count',
  'quote_count',
  'bookmark_count',
  'rank',
  'updated_at',
]);

/**
 * Dedup view of `events.metadata`: everything a human or connector authored,
 * with the volatile observations stripped. Two payloads equal under this
 * projection describe the same content even if the counters moved.
 */
function durableMetadataState(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return stableJson(metadata ?? {});
  }
  const durable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!VOLATILE_METADATA_KEYS.has(key)) durable[key] = value;
  }
  return stableJson(durable);
}

/** The volatile subset actually present on an incoming payload. */
function volatileMetadataPatch(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return patch;
  for (const [key, value] of Object.entries(metadata)) {
    if (VOLATILE_METADATA_KEYS.has(key)) patch[key] = value;
  }
  return patch;
}

function normalizedTimestamp(value?: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function findCurrentEventByOrigin(
  sql: DbClient,
  params: InsertEventParams
): Promise<
  | {
      id: number;
      title: string | null;
      payload_text: string | null;
      payload_type: string;
      payload_data: Record<string, unknown>;
      payload_template: Record<string, unknown> | null;
      attachments: unknown[];
      author_name: string | null;
      source_url: string | null;
      occurred_at: string | null;
      semantic_type: string;
      origin_type: string | null;
      metadata: Record<string, unknown>;
      score: number | null;
      origin_parent_id: string | null;
      interaction_type: string;
      interaction_status: string | null;
      interaction_input_schema: Record<string, unknown> | null;
      interaction_input: Record<string, unknown> | null;
      interaction_output: Record<string, unknown> | null;
      interaction_error: string | null;
    }
  | undefined
> {
  if (!params.connectionId || !params.originId) return undefined;

  const rows = await sql`
    SELECT e.id, e.title, e.payload_text, e.payload_type, e.payload_data, e.payload_template,
           e.attachments, e.author_name, e.source_url, e.occurred_at, e.semantic_type, e.origin_type,
           e.metadata, e.score, e.origin_parent_id, e.interaction_type, e.interaction_status,
           e.interaction_input_schema, e.interaction_input, e.interaction_output, e.interaction_error
    FROM events e
    WHERE e.organization_id = ${params.organizationId}
      AND e.connection_id = ${params.connectionId}
      AND e.origin_id = ${params.originId}
      AND NOT EXISTS (
        SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1
  `;

  return rows[0] as any;
}

/**
 * Browser tabs fold their unread count into the document title, so a
 * page_visit's title is volatile in exactly the way `metadata` already is:
 * the badge moving in and out ("(3) WhatsApp" vs "WhatsApp") made one feed
 * supersede 93.6% of everything it wrote over a measured 3-day prod window
 * (#3328). Compare page_visit titles badge-normalized — the URL is the
 * identity, and a genuine title change still mints a new version.
 */
const UNREAD_BADGE_PREFIX = /^\(\d+\)\s+/;
function semanticEventTitle(
  title: string | null | undefined,
  semanticType: string | null | undefined
): string | null {
  const value = title ?? null;
  if (value === null || semanticType !== 'page_visit') return value;
  return value.replace(UNREAD_BADGE_PREFIX, '');
}

function isSemanticallyEqual(
  existing: NonNullable<Awaited<ReturnType<typeof findCurrentEventByOrigin>>>,
  params: InsertEventParams
): boolean {
  return (
    semanticEventTitle(existing.title, params.semanticType) ===
      semanticEventTitle(params.title, params.semanticType) &&
    (existing.payload_text ?? null) === (params.content ?? null) &&
    existing.payload_type === (params.payloadType ?? 'text') &&
    stableJson(existing.payload_data ?? {}) === stableJson(params.payloadData ?? {}) &&
    stableJson(existing.payload_template ?? null) === stableJson(params.payloadTemplate ?? null) &&
    semanticAttachmentState(existing.attachments) ===
      semanticAttachmentState(params.attachments) &&
    (existing.author_name ?? null) === (params.authorName ?? null) &&
    (existing.source_url ?? null) === (params.sourceUrl ?? null) &&
    // Only compare occurred_at when the caller supplied one. Insert defaults a
    // missing occurred_at to now(), so an occurredAt-less re-upsert comparing
    // null against the stamped default would supersede on every re-sync.
    (params.occurredAt == null ||
      normalizedTimestamp(existing.occurred_at ?? null) ===
        normalizedTimestamp(params.occurredAt)) &&
    existing.semantic_type === params.semanticType &&
    (existing.origin_type ?? null) === (params.originType ?? null) &&
    // Volatile observations (counters, `updated_at`) are deliberately absent
    // from this comparison and from `score` below — they are reconciled in
    // place by applyVolatileState instead of minting a new stored version.
    durableMetadataState(existing.metadata) === durableMetadataState(params.metadata) &&
    // Compare the value a supersede would WRITE: a null parentOriginId copies
    // the predecessor's parent (loadEventLineage), so only a caller-supplied
    // parent can differ. Comparing the raw param would re-supersede a
    // copied-parent head on every parentless re-sync, forever.
    (params.parentOriginId == null ||
      (existing.origin_parent_id ?? null) === params.parentOriginId) &&
    existing.interaction_type === (params.interactionType ?? 'none') &&
    (existing.interaction_status ?? null) === (params.interactionStatus ?? null) &&
    stableJson(existing.interaction_input_schema ?? null) ===
      stableJson(params.interactionInputSchema ?? null) &&
    stableJson(existing.interaction_input ?? null) ===
      stableJson(params.interactionInput ?? null) &&
    stableJson(existing.interaction_output ?? null) ===
      stableJson(params.interactionOutput ?? null) &&
    (existing.interaction_error ?? null) === (params.interactionError ?? null)
  );
}

/**
 * Reconcile volatile source state on the CURRENT row instead of superseding it.
 *
 * `events` is append-only by convention, but the DB-enforced invariant is
 * narrower: the only trigger on the table is `trg_events_append_only`, and it
 * is BEFORE DELETE. The ledger's job is to preserve what was authored; an
 * upvote count observed at read time is not an utterance, so it is reconciled
 * rather than versioned. The counter time-series is deliberately not retained —
 * it previously existed only as ~1.8M duplicate rows that nothing queried.
 *
 * `metadata || patch` merges just the volatile keys, so identity keys behind the
 * expression indexes on this table (`metadata->>'email'`, `->>'phone'`, …) are
 * left untouched. A volatile key REMOVED upstream is not unset — merging is
 * intentional, since a connector omitting a counter on one sync should not drop
 * the last known value.
 *
 * Returns true when a write actually happened.
 */
async function applyVolatileState(
  eventId: number,
  existing: { metadata: Record<string, unknown> | null; score: number | null },
  params: InsertEventParams,
  sql: DbClient
): Promise<boolean> {
  const patch = volatileMetadataPatch(params.metadata);
  const existingVolatile = volatileMetadataPatch(existing.metadata);
  const scoreChanged = Number(existing.score ?? 0) !== Number(params.score ?? 0);
  // The dirty check mirrors the merge below: an omitted counter is preserved,
  // not unset, so it must not count as a change either — comparing the raw
  // volatile sets instead would report `state_updated` (and fire a declared
  // updated_event_type) on every sync once a connector omits a key it once sent.
  const metadataChanged =
    stableJson({ ...existingVolatile, ...patch }) !== stableJson(existingVolatile);
  if (!scoreChanged && !metadataChanged) return false;

  await sql`
    UPDATE events
       SET score = ${params.score ?? null},
           metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json(patch)}::jsonb
     WHERE id = ${eventId}
  `;
  return true;
}

async function upsertEmbedding(
  eventId: number,
  embedding: number[] | null | undefined,
  embeddingModel: string | null | undefined,
  sql: DbClient = getDb()
): Promise<void> {
  if (!embedding || embedding.length === 0) return;
  // An unstamped vector is unusable — search scopes vector comparison to the
  // configured model — so skip it and let the embed backfill produce a properly
  // stamped one.
  if (!embeddingModel) return;
  const vectorLiteral = `[${embedding.join(',')}]`;
  const replaceIfLive = async (activeSql: DbClient): Promise<void> => {
    // Serialize every runtime embedding writer with the supersede UPDATE. A
    // refresh of semantically unchanged content can otherwise block behind the
    // predecessor deletion, then recreate that dead row after the supersede
    // commits. This path can later update volatile event state, so take the
    // stronger lock before touching event_embeddings; upgrading FOR SHARE after
    // a completion writer takes its own SHARE lock creates a lock cycle. Keep
    // the lock order events -> event_embeddings everywhere.
    const liveEvent = await activeSql`
      SELECT id
      FROM events
      WHERE id = ${eventId}
        AND superseded_by IS NULL
      FOR NO KEY UPDATE
    `;
    // Replace this (event, model)'s chunk set with a single chunk-0 row, scoped
    // to the model so old/new models can coexist during a zero-downtime swap
    // (PK is event_id + embedding_model + chunk_index). Delete first even when
    // the event is already dead, so this path also heals a stale row left by an
    // older writer; the liveness lock keeps a writer that saw the event live
    // from racing a superseder past the INSERT below.
    await activeSql`DELETE FROM event_embeddings WHERE event_id = ${eventId} AND embedding_model = ${embeddingModel}`;
    if (liveEvent.length === 0) return;
    await activeSql`
      INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
      VALUES (${eventId}, 0, ${vectorLiteral}::vector, ${embeddingModel})
    `;
  };

  // Existing insertEvent supersede/dedup callers already pass a transaction
  // handle. Plain inserts use the pool, so open a short transaction here to
  // keep the liveness lock through delete + insert.
  if (typeof sql.savepoint === 'function') {
    await replaceIfLive(sql);
  } else {
    await sql.begin(async (tx) => replaceIfLive(tx));
  }
}

type EventLineage = {
  connectorKey: string | null;
  connectionId: number | null;
  feedKey: string | null;
  feedId: number | null;
  runId: number | null;
  automationId: number | null;
  automationVersionId: number | null;
  parentOriginId: string | null;
  identityNs: string | null;
  identityKey: string | null;
};

function nullableNumber(value: number | string | null): number | null {
  return value == null ? null : Number(value);
}

/**
 * Resolve lineage for a new stored version. Connector/feed and identity belong
 * to the chain and are always copied. Producer, run, and parent copy unless
 * the caller supplies a replacement value — null cannot clear them; browser
 * containment may redact the inherited parent before insertion. Identity
 * cannot first appear on a successor: uniqueness is rooted at
 * supersedes_event_id NULL.
 */
async function loadEventLineage(
  sql: DbClient,
  supersedesEventId: number,
  params: InsertEventParams
): Promise<EventLineage> {
  const rows = await sql`
    SELECT connector_key, connection_id, feed_key, feed_id, run_id,
           automation_id, automation_version_id, origin_parent_id,
           identity_ns, identity_key
    FROM events
    WHERE id = ${supersedesEventId}
      AND organization_id = ${params.organizationId}
    LIMIT 1
  `;
  const prior = rows[0] as
    | {
        connector_key: string | null;
        connection_id: number | string | null;
        feed_key: string | null;
        feed_id: number | string | null;
        run_id: number | string | null;
        automation_id: number | string | null;
        automation_version_id: number | string | null;
        origin_parent_id: string | null;
        identity_ns: string | null;
        identity_key: string | null;
      }
    | undefined;
  if (!prior) {
    throw new Error(
      `insertEvent: cannot supersede event ${supersedesEventId} — not found in organization ${params.organizationId}`
    );
  }
  return {
    connectorKey: prior.connector_key ?? null,
    connectionId: nullableNumber(prior.connection_id),
    feedKey: prior.feed_key ?? null,
    feedId: nullableNumber(prior.feed_id),
    runId: params.runId ?? nullableNumber(prior.run_id),
    automationId: params.automationId ?? nullableNumber(prior.automation_id),
    automationVersionId:
      params.automationVersionId ?? nullableNumber(prior.automation_version_id),
    parentOriginId: params.parentOriginId ?? prior.origin_parent_id ?? null,
    identityNs: prior.identity_ns ?? null,
    identityKey: prior.identity_key ?? null,
  };
}

function isEventsClientIdForeignKeyViolation(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
  };
  if (err?.code !== '23503') return false;
  return (
    err.constraint === 'events_client_id_fkey' ||
    err.constraint_name === 'events_client_id_fkey' ||
    (typeof err.message === 'string' && err.message.includes('events_client_id_fkey'))
  );
}

/**
 * Insert a single event into the events table.
 *
 * Returns the inserted row (id, entity_ids, title, semantic_type, created_at).
 * If `onConflictUpdate` is true, performs an upsert on (connection_id, origin_id).
 * If `sql` is passed, the insert runs on that (transaction-bound) handle
 * instead of the singleton pool — used by the identity engine to keep its
 * fact + derivation writes atomic.
 */
export async function insertEvent(
  params: InsertEventParams,
  options?: {
    onConflictUpdate?: boolean;
    sql?: DbClient;
    /** Raw browser identity used only to supersede a pre-containment row. */
    sourceOriginId?: string;
    /** Transactional hook for durable derived work such as Automation runs. */
    afterPersist?: (event: InsertedEvent, sql: DbClient) => Promise<void>;
    /**
     * Set only after connector attribution has scrubbed and rebuilt the
     * server-owned identity-scope projection keys from durable identities.
     */
    trustedIdentityScopeProjections?: boolean;
  }
): Promise<InsertedEvent> {
  if (params.organizationId === null && options?.afterPersist) {
    throw new Error('Workspace activation requires an organization');
  }
  // This is the physical write funnel for event content. Connector items,
  // Automation output, and approval metadata all converge here. stripNulDeep
  // preserves Dates and other class instances.
  params = stripNulDeep(params) as InsertEventParams;
  if (!options?.trustedIdentityScopeProjections) {
    params = {
      ...params,
      metadata: stripIdentityScopeProjectionMetadata(params.metadata),
    };
  }
  const sourceOriginId = stripNul(options?.sourceOriginId ?? params.originId);
  const sql = options?.sql ?? getDb();
  // Explicit successors inherit connector lineage from their predecessor even
  // when the caller omits (or disagrees about) connectorKey.
  const inheritedConnectorRows = params.supersedesEventId != null
    ? ((await sql`
        SELECT connector_key FROM events
        WHERE id = ${params.supersedesEventId}
          AND organization_id = ${params.organizationId}
        LIMIT 1
      `) as Array<{ connector_key: string | null }>)
    : [];
  const browserConnector = isBrowserConnectorKey(
    inheritedConnectorRows[0]?.connector_key ?? params.connectorKey
  );
  if (browserConnector) {
    const sanitized = sanitizeBrowserIngestionFields({
      originId: params.originId,
      parentOriginId: params.parentOriginId,
      title: params.title,
      content: params.content,
      sourceUrl: params.sourceUrl,
      payloadData: params.payloadData,
      payloadTemplate: params.payloadTemplate,
      attachments: params.attachments,
      metadata: params.metadata,
      interactionInput: params.interactionInput,
      interactionOutput: params.interactionOutput,
      interactionError: params.interactionError,
    });
    params = {
      ...params,
      originId: sanitized.originId ?? params.originId,
      parentOriginId: sanitized.parentOriginId,
      title: sanitized.title,
      content: sanitized.content,
      sourceUrl: sanitized.sourceUrl,
      payloadData: sanitized.payloadData,
      payloadTemplate: sanitized.payloadTemplate,
      attachments: sanitized.attachments,
      metadata: sanitized.metadata,
      interactionInput: sanitized.interactionInput,
      interactionOutput: sanitized.interactionOutput,
      interactionError: sanitized.interactionError,
      // A worker may have embedded the unsanitized payload before it reached
      // the gateway. Force the normal server backfill from sanitized
      // payload_text instead of persisting/indexing that vector.
      embedding: undefined,
    };
  }
  // A pre-containment row may still be keyed by the raw browser URL. Use the
  // source identity once for lookup so a fresh sanitized version supersedes
  // it append-only; subsequent retries fall back to the sanitized identity.
  const hasDistinctSourceOrigin = browserConnector && sourceOriginId !== params.originId;
  const sourceOriginLookupParams = hasDistinctSourceOrigin
    ? { ...params, originId: sourceOriginId }
    : params;

  // Reverse-geocode lat/lng → city / admin1 / country once per event,
  // before insert. Silent no-op when the connector hasn't supplied
  // coordinates, when PostGIS / geo_places aren't seeded, or when the
  // nearest place is too far (ocean / desert). Connector-supplied
  // place_name etc. are preserved — enrichment only fills gaps.
  const enrichment = await lookupGeoEnrichment(params.metadata, { sql });
  const enrichedMetadata = mergeEnrichedMetadata(params.metadata, enrichment);
  if (enrichedMetadata !== params.metadata) {
    params = { ...params, metadata: enrichedMetadata };
  }

  const entityIdsValue = params.entityIds.length > 0 ? `{${params.entityIds.join(',')}}` : null;

  const requestedClientId = params.clientId ?? null;

  // Core find→decide→insert, parameterized on the active SQL handle so it can
  // run either directly on the singleton pool or inside the dedup transaction
  // below (which holds an advisory lock for the duration).
  const runInsert = async (
    activeSql: DbClient
  ): Promise<InsertedEvent> => {
    let supersedesEventId = params.supersedesEventId ?? null;

    if (options?.onConflictUpdate) {
      let existing = await findCurrentEventByOrigin(activeSql, sourceOriginLookupParams);
      const existingHasRawBrowserOrigin = existing != null && hasDistinctSourceOrigin;
      if (!existing && hasDistinctSourceOrigin) {
        existing = await findCurrentEventByOrigin(activeSql, params);
      }
      if (existing) {
        const existingHasRawBrowserParent =
          browserConnector &&
          sanitizeBrowserText(existing.origin_parent_id) !== existing.origin_parent_id;
        if (
          !existingHasRawBrowserOrigin &&
          !existingHasRawBrowserParent &&
          isSemanticallyEqual(existing, params)
        ) {
          // Reread before touching the embedding. If the row got
          // deleted / tombstoned between findCurrentEventByOrigin and
          // here, upsertEmbedding would FK-fail instead of letting us
          // fall through cleanly to a fresh insert (CodeRabbit catch
          // on PR #780).
          const existingRows = await activeSql`
            SELECT id, entity_ids, origin_id, title, semantic_type, created_at
            FROM events
            WHERE id = ${existing.id}
            LIMIT 1
          `;
          const existingRow = existingRows[0] as InsertedEvent | undefined;
          if (existingRow) {
            await upsertEmbedding(
              existingRow.id,
              params.embedding,
              params.embeddingModel,
              activeSql
            );
            // Durable content matched, so no new version is warranted. Volatile
            // observations may still have moved; reconcile them on this row.
            const stateWritten = await applyVolatileState(
              existingRow.id,
              { metadata: existing.metadata ?? null, score: existing.score ?? null },
              params,
              activeSql
            );
            const settled = {
              ...existingRow,
              change: (stateWritten ? 'state_updated' : 'unchanged') as
                | 'state_updated'
                | 'unchanged',
            };
            await options?.afterPersist?.(settled, activeSql);
            return settled;
          }
          // Race: the existing row was deleted/tombstoned between the
          // findCurrentEventByOrigin lookup above and the SELECT here. Fall
          // through into the INSERT path with `supersedesEventId` unset so we
          // create a fresh row instead of crashing on `undefined.id`.
          logger.warn(
            {
              existingId: existing.id,
              originId: browserConnector ? '[browser-origin]' : params.originId,
            },
            '[insert-event] existing row vanished between find and reread — proceeding with fresh insert'
          );
        } else {
          supersedesEventId = existing.id;
        }
      }
    }

    return insertRow(activeSql, supersedesEventId);
  };

  const insertRow = async (
    sql: DbClient,
    supersedesEventId: number | null
  ): Promise<InsertedEvent> => {
    let lineage: EventLineage =
      supersedesEventId != null
        ? await loadEventLineage(sql, supersedesEventId, params)
        : {
            connectorKey: params.connectorKey ?? null,
            connectionId: params.connectionId ?? null,
            feedKey: params.feedKey ?? null,
            feedId: params.feedId ?? null,
            runId: params.runId ?? null,
            automationId: params.automationId ?? null,
            automationVersionId: params.automationVersionId ?? null,
            parentOriginId: params.parentOriginId ?? null,
            identityNs: params.identity?.ns ?? null,
            identityKey: params.identity?.key ?? null,
          };
    if (browserConnector) {
      lineage = {
        ...lineage,
        parentOriginId: sanitizeBrowserText(lineage.parentOriginId) ?? null,
      };
    }

    const insertWithClientId = (activeSql: DbClient, clientId: string | null) => activeSql`
    INSERT INTO events (
      entity_ids, organization_id, origin_id, title,
      payload_type, payload_text, payload_data, payload_template, attachments, metadata,
      score, author_name, source_url, occurred_at, origin_parent_id, origin_type,
      connector_key, connection_id, feed_key, feed_id, run_id,
      automation_id, automation_version_id,
      semantic_type, client_id, created_by,
      interaction_type, interaction_status, interaction_input_schema, interaction_input,
      interaction_output, interaction_error, supersedes_event_id,
      identity_ns, identity_key,
      linked_org_ids
    ) VALUES (
      ${entityIdsValue}::bigint[],
      ${params.organizationId},
      ${params.originId},
      ${params.title ?? null},
      ${params.payloadType ?? 'text'},
      ${params.content ?? null},
      ${sql.json(params.payloadData ?? {})},
      ${params.payloadTemplate ? sql.json(params.payloadTemplate) : null},
      ${sql.json(params.attachments ?? [])},
      ${sql.json(params.metadata ?? {})},
      ${params.score ?? null},
      ${params.authorName ?? null},
      ${params.sourceUrl ?? null},
      ${params.occurredAt ?? new Date()},
      ${lineage.parentOriginId},
      ${params.originType ?? null},
      ${lineage.connectorKey},
      ${lineage.connectionId},
      ${lineage.feedKey},
      ${lineage.feedId},
      ${lineage.runId},
      ${lineage.automationId},
      ${lineage.automationVersionId},
      ${params.semanticType},
      ${clientId},
      ${params.createdBy ?? null},
      ${params.interactionType ?? 'none'},
      ${params.interactionStatus ?? null},
      ${params.interactionInputSchema ? sql.json(params.interactionInputSchema) : null},
      ${params.interactionInput ? sql.json(params.interactionInput) : null},
      ${params.interactionOutput ? sql.json(params.interactionOutput) : null},
      ${params.interactionError ?? null},
      ${supersedesEventId},
      ${lineage.identityNs},
      ${lineage.identityKey},
      (
        SELECT COALESCE(array_agg(DISTINCT x.o), '{}'::text[])
        FROM (
          SELECT ent.organization_id AS o
          FROM public.entities ent
          WHERE ent.id = ANY(${entityIdsValue}::bigint[])
          UNION ALL
          SELECT c.organization_id AS o
          FROM public.connections c
          WHERE c.id = ${lineage.connectionId}
        ) x
        WHERE x.o IS NOT NULL
          AND (x.o <> ${params.organizationId}::text OR ${params.organizationId}::text IS NULL)
      )
    )
    RETURNING id, entity_ids, origin_id, title, semantic_type, created_at
  `;

  // A synthetic or stale client id (worker/PAT sessions carry `'lobu-worker'`,
  // which has no oauth_clients row) trips `events_client_id_fkey`. The retry
  // must survive the enclosing transaction: the supersede path runs inside
  // `sql.begin`, and a bare failed INSERT aborts the whole transaction — the
  // NULL retry would then die on `current transaction is aborted`. Wrapping
  // the first attempt in a savepoint (only available on tx handles) rolls
  // back cleanly so the NULL retry runs against a live transaction. On the
  // plain pool handle there is no transaction to abort, so no savepoint is
  // needed.
  let result: Awaited<ReturnType<typeof insertWithClientId>>;
  const inTransaction = typeof sql.savepoint === 'function';
  try {
    result = inTransaction
      ? await sql.savepoint((sp) => insertWithClientId(sp, requestedClientId))
      : await insertWithClientId(sql, requestedClientId);
  } catch (error) {
    if (!requestedClientId || !isEventsClientIdForeignKeyViolation(error)) {
      throw error;
    }
    logger.warn(
      { clientId: requestedClientId },
      '[insert-event] retrying insert with client_id NULL — referenced oauth_clients row no longer exists'
    );
    result = await insertWithClientId(sql, null);
  }

  const inserted = result[0] as InsertedEvent | undefined;
  if (!inserted) {
    // INSERT ... RETURNING should always yield a row for a successful insert.
    // An empty result means either (a) a BEFORE INSERT trigger silently
    // RETURNed NULL (none in our schema today), or (b) postgres.js dropping
    // the rows for an obscure reason. Neither should drop events on the
    // floor — convert the cryptic `Cannot read
    // properties of undefined (reading 'id')` into a real error with
    // diagnostic context so we can root-cause when it next happens.
    logger.error(
      {
        originId: browserConnector ? '[browser-origin]' : params.originId,
        connectionId: params.connectionId,
        organizationId: params.organizationId,
        semanticType: params.semanticType,
        connectorKey: params.connectorKey,
        feedKey: params.feedKey,
      },
      '[insert-event] INSERT ... RETURNING returned no rows — event not persisted'
    );
    throw new Error(
      `insertEvent: INSERT RETURNING came back empty for ` +
        `origin_id=${browserConnector ? '[browser-origin]' : params.originId} ` +
        `connection_id=${params.connectionId}. ` +
        `Row was not persisted; check server logs for diagnostic context.`
    );
  }

    // Dual-write the denormalized supersession edge. `events.superseded_by`
    // holds the inverse of `supersedes_event_id`: we stamp the row we just
    // replaced with the id of THIS new superseding row so live-row reads can
    // one day use `WHERE superseded_by IS NULL` instead of the per-row
    // anti-join in current_event_records. This touches LINEAGE METADATA ONLY,
    // never payload — the append-only invariant applies to content (precedent:
    // search_tsv is likewise maintained post-insert). Runs on the SAME `sql`
    // handle as the INSERT, so when we're inside the dedup advisory-lock tx or
    // a caller-supplied tx (identity engine) it is atomic with the supersede.
    //
    // The `AND superseded_by IS NULL` guard is belt-and-braces: the partial
    // unique index idx_events_superseded_by already fired a 23505 on the INSERT
    // above if the target was already superseded, so a 0-row UPDATE here can
    // only happen if the column was backfilled/stamped by a losing concurrent
    // writer whose INSERT nonetheless slipped through — in which case leaving
    // the existing stamp intact is correct (the unique index still guarantees a
    // single superseder).
    if (supersedesEventId !== null) {
      await sql`
        UPDATE events
        SET superseded_by = ${inserted.id}
        WHERE id = ${supersedesEventId}
          AND superseded_by IS NULL
      `;
      // Vector readers exclude superseded events, but the unfiltered ivfflat
      // index still carries their vectors. That is a recall loss, not only
      // wasted storage: `ivfflat.probes` is 1 with `iterative_scan` off, so a
      // probe list spent on rows the live-row join then discards simply yields
      // fewer live candidates. Reclaim every model and chunk in the same
      // transaction as the supersede stamp; event_embeddings is derived data,
      // not the append-only events ledger.
      await sql`DELETE FROM event_embeddings WHERE event_id = ${supersedesEventId}`;
    }

    await upsertEmbedding(inserted.id, params.embedding, params.embeddingModel, sql);
    const persisted: InsertedEvent = {
      ...inserted,
      change: supersedesEventId === null ? 'inserted' : 'superseded',
    };
    await options?.afterPersist?.(persisted, sql);
    return persisted;
  };

  // The dedup path (onConflictUpdate) is a non-atomic read-then-insert: it
  // looks up the current row for (connection_id, origin_id), then either
  // supersedes it or inserts fresh. Without serialization, two concurrent
  // ingests of the SAME item — common under N>1 app replicas and even two
  // overlapping runs on one replica — can both see "no current row" and both
  // insert with supersedes_event_id NULL (→ permanent duplicate current rows),
  // or both target the same row to supersede (→ duplicate-key error on
  // idx_events_superseded_by, which fails the whole stream batch). Hold a
  // transaction-scoped advisory lock keyed on (connection_id, origin_id) so
  // these serialize. Only engage when we own the connection (no caller-supplied
  // tx, which already runs in its own atomic scope) and have both keys.
  const dedupConnectionId = params.connectionId;
  if (options?.onConflictUpdate && !options.sql && dedupConnectionId && params.originId) {
    return sql.begin(async (tx) => {
      await lockEventDedupIdentity(tx, dedupConnectionId, params.originId);
      return runInsert(tx);
    }) as Promise<InsertedEvent>;
  }

  // An explicit supersede without a caller-supplied tx must still commit the
  // superseding INSERT and the superseded_by stamp atomically: as two
  // autocommit statements, a crash between them would leave the superseded
  // row's denormalized edge permanently NULL — which, after the Stage-2 view
  // flip to `WHERE superseded_by IS NULL`, would resurrect it as a live row.
  // (The dedup path can only derive a supersede when connectionId+originId are
  // both present, and that case is already inside the advisory-lock tx above.)
  if (params.supersedesEventId != null && !options?.sql) {
    return sql.begin(async (tx) =>
      runInsert(tx)
    ) as Promise<InsertedEvent>;
  }

  return runInsert(sql);
}

// ============================================
// Change Event (fire-and-forget audit trail)
// ============================================

export interface ChangeEventParams {
  entityIds: number[];
  organizationId: string;
  /**
   * What changed, as the shared `<subject>.<op>` vocabulary. Explicit here
   * because this writer's `metadata` is caller-shaped free-form jsonb — unlike
   * its siblings it carries no structured field the funnel could classify from.
   */
  subject: string;
  op: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdBy?: string | null;
  clientId?: string | null;
}

/**
 * Queue Automation activation for a freshly written audit row, when anything
 * subscribes to its `<subject>.<op>` type.
 *
 * Fire-and-forget by design. The audit row is the durable record; a failure to
 * queue its activation must never fail — or roll back — the change being
 * audited. Double delivery is guarded twice over: the queue key is per event
 * id, and `createAutomationEventRun` dedupes per Automation on the
 * `workspace-event:<id>` delivery id even if a second task is ever queued.
 *
 * Causality comes from the producer and the run that produced it. A row with
 * no producer is a root (empty ancestry, depth 1). A row produced by an
 * Automation names that Automation as its own causal path, which stops it
 * waking itself — the matcher skips any Automation already in
 * `causal_automation_ids`, and `activateWorkspaceEventTask` rejects a payload
 * whose ancestry disagrees with the row's producer.
 *
 * When the producing run itself came from a workspace event, the row INHERITS
 * that run's ancestry instead of starting over. Without inheriting, an
 * A -> B -> A cascade would run forever: each audit row would be a fresh root
 * at depth 1, so the depth cap could never accrue across hops.
 */
async function queueWorkspaceEventActivation(args: {
  organizationId: string;
  eventId: number;
  eventType: string;
  producerAutomationId: number | null;
  actingRunId: number | null;
}): Promise<void> {
  try {
    const sql = getDb();
    await sql.begin(async (tx) => {
      await queueWorkspaceEventActivationInTransaction(args, tx);
    });
  } catch (err) {
    logger.error(
      {
        eventId: args.eventId,
        eventType: args.eventType,
        organizationId: args.organizationId,
        error: String(err),
      },
      '[insert-event] failed to queue workspace-event activation; audit row is durable'
    );
  }
}

/** Append the activation task on the same transaction as its platform event. */
async function queueWorkspaceEventActivationInTransaction(
  args: {
    organizationId: string;
    eventId: number;
    eventType: string;
    producerAutomationId: number | null;
    actingRunId: number | null;
  },
  tx: DbClient
): Promise<void> {
  const subscribed = await findSubscribedWorkspaceEventTypes(
    args.organizationId,
    [args.eventType],
    tx
  );
  if (!subscribed.has(args.eventType)) return;
  let inherited: Awaited<ReturnType<typeof loadRunEventCausality>> = null;
  if (args.producerAutomationId != null && args.actingRunId != null) {
    try {
      inherited = await loadRunEventCausality(
        args.organizationId,
        args.actingRunId,
        args.producerAutomationId,
        tx
      );
    } catch (error) {
      if (!(error instanceof WorkspaceEventCausalityLimitError)) throw error;
      logger.warn(
        {
          eventId: args.eventId,
          eventType: args.eventType,
          organizationId: args.organizationId,
          error: error.message,
        },
        '[insert-event] workspace-event causality cap reached; activation chain terminated'
      );
      return;
    }
  }
  await enqueueWorkspaceEventActivations(tx, [
    {
      organizationId: args.organizationId,
      eventId: args.eventId,
      rootEventIds: inherited?.rootEventIds ?? [args.eventId],
      causalAutomationIds:
        inherited?.causalAutomationIds ??
        (args.producerAutomationId == null ? [] : [args.producerAutomationId]),
      depth: inherited?.depth ?? 1,
    },
  ]);
}

const AUDIT_IDEMPOTENCY_INDEX = 'idx_events_org_idempotency_key';

interface ConnectionlessAuditInsertOptions {
  /** Join the state mutation transaction and make event + activation atomic. */
  sql?: DbClient;
  /**
   * Serialize this insert against a concurrent force-delete of the entities it
   * references, and omit ids that lost the race. Whichever side commits first
   * wins cleanly: if the audit does, the delete's `entity_ids` sweep sees and
   * detaches it; if the delete does, the immutable audit row still lands, just
   * without the ids it would otherwise dangle on.
   */
  lockAndPruneEntityRefs?: boolean;
}

async function findConnectionlessEventByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
  expected: Pick<
    InsertEventParams,
    'semanticType' | 'originType' | 'originId' | 'parentOriginId'
  >
): Promise<InsertedEvent | null> {
  const existing = await getDb()`
    SELECT id, entity_ids, origin_id, origin_type, origin_parent_id,
           title, semantic_type, created_at
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata ? '_lobu_idempotency_key'
      AND metadata->>'_lobu_idempotency_key' = ${idempotencyKey}
    ORDER BY id ASC
    LIMIT 1
  `;
  const row = existing[0] as
    | {
        id: number | string;
        entity_ids: number[] | null;
        origin_id: string;
        origin_type: string | null;
        origin_parent_id: string | null;
        title: string | null;
        semantic_type: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  if (
    row.semantic_type !== expected.semanticType ||
    row.origin_type !== (expected.originType ?? null) ||
    row.origin_id !== expected.originId ||
    row.origin_parent_id !== (expected.parentOriginId ?? null)
  ) {
    return null;
  }
  return {
    id: Number(row.id),
    entity_ids: row.entity_ids,
    origin_id: row.origin_id,
    title: row.title,
    semantic_type: row.semantic_type,
    created_at: row.created_at,
    change: 'unchanged',
  };
}

/**
 * Append a user/platform-authored workspace event and enqueue matching
 * Automations in the same transaction.
 *
 * `idempotencyKey` is server-derived by the producer (for example from a
 * verified webhook delivery). The reserved org-wide unique index makes exact
 * retries converge across replicas; callers never need process-local state.
 */
export async function insertConnectionlessWorkspaceEvent(
  params: InsertEventParams & { organizationId: string },
  idempotencyKey: string,
  options?: { sql?: DbClient }
): Promise<InsertedEvent> {
  const normalizedKey = stripNul(idempotencyKey);
  const actingScope = getActingAutomationScope();
  const producerAutomationId = params.automationId ?? actingScope?.automationId ?? null;
  const actingRunId =
    actingScope != null && actingScope.automationId === producerAutomationId
      ? actingScope.runId
      : null;
  const write = (tx: DbClient) =>
    insertEvent(
      {
        ...params,
        connectionId: null,
        automationId: producerAutomationId,
        metadata: {
          ...(params.metadata ?? {}),
          _lobu_idempotency_key: normalizedKey,
        },
      },
      {
        sql: tx,
        afterPersist: (event, activeTx) =>
          queueWorkspaceEventActivationInTransaction(
            {
              organizationId: params.organizationId,
              eventId: event.id,
              eventType: params.semanticType,
              producerAutomationId,
              actingRunId,
            },
            activeTx
          ),
      }
    );

  try {
    if (options?.sql) return await write(options.sql);
    return (await getDb().begin(write)) as InsertedEvent;
  } catch (error) {
    if (!isUniqueViolation(error, AUDIT_IDEMPOTENCY_INDEX) || options?.sql) throw error;
    const existing = await findConnectionlessEventByIdempotencyKey(
      params.organizationId,
      normalizedKey,
      params
    );
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Insert an audit row under the same row locks the force-delete path takes,
 * dropping any referenced entity that has already been hard-deleted.
 *
 * `organization` is claimed BEFORE `entities`, matching
 * `lockOrgForAclInvalidation`'s documented order. That order is not optional
 * here: `events_organization_id_fkey` makes the INSERT take a KEY SHARE on the
 * org row, so locking the entities first and only reaching the org row through
 * the foreign key inverts the order and deadlocks against a force-delete, which
 * holds the org row and is waiting for those same entity rows.
 *
 * Both locks are the weakest mode that still conflicts with `FOR UPDATE`, so
 * ordinary readers and non-key updates never wait on an audit write.
 */
async function insertAuditEventPruningDeletedEntityRefs(
  params: InsertEventParams & { organizationId: string },
  db: DbClient,
  afterPersist?: (event: InsertedEvent, tx: DbClient) => Promise<void>
): Promise<InsertedEvent> {
  const entityIdsLiteral = `{${params.entityIds.join(',')}}`;
  const write = async (tx: DbClient) => {
    await tx`
      SELECT 1 FROM organization WHERE id = ${params.organizationId} FOR KEY SHARE
    `;
    const surviving = await tx<{ id: number | string }>`
      SELECT id
      FROM entities
      WHERE id = ANY(${entityIdsLiteral}::bigint[])
      ORDER BY id
      FOR KEY SHARE
    `;
    const survivingIds = new Set(surviving.map((row) => Number(row.id)));
    return insertEvent(
      {
        ...params,
        entityIds: params.entityIds.filter((id) => survivingIds.has(id)),
      },
      { sql: tx, afterPersist }
    );
  };
  return (
    typeof db.savepoint === 'function' ? write(db) : db.begin(write)
  ) as Promise<InsertedEvent>;
}

/**
 * Persist a connectionless audit/change event with DB-enforced idempotency.
 *
 * Fire-and-forget writers retry with the same originId after a transient
 * failure. Connector-sourced rows use a unique (connection_id, origin_id)
 * path; connectionless audit rows do not. Stamp the reserved
 * `_lobu_idempotency_key` (unique per org via `idx_events_org_idempotency_key`)
 * so a concurrent or retry insert after an ambiguous success resolves to the
 * winner instead of appending a duplicate.
 *
 * `eventType` is required rather than optional so a new writer cannot introduce
 * an untyped audit row by omission: leaving it out is a compile error, not a
 * silently unclassifiable event. The `record*` helpers below each supply it
 * from data they already hold, so adding a new event type costs no code here —
 * pass a new `subject`.
 */
export async function insertConnectionlessAuditEvent(
  params: InsertEventParams & { organizationId: string },
  eventType: AuditEventType,
  options?: ConnectionlessAuditInsertOptions
): Promise<InsertedEvent> {
  // insertEvent strips NUL from originId, so derive the key from the stripped
  // value: the unique index and the reconciliation SELECT below both read the
  // persisted `_lobu_idempotency_key`, which is the stripped form.
  const idempotencyKey = `audit:${stripNul(params.originId)}`;
  const formattedEventType = formatAuditEventType(eventType);
  const metadata: Record<string, unknown> = {
    ...(params.metadata ?? {}),
    _lobu_idempotency_key: idempotencyKey,
    [AUDIT_EVENT_TYPE_METADATA_KEY]: formattedEventType,
  };
  // Who caused this change. An explicit id wins over ambient scope so a writer
  // that already resolved its producer keeps saying so; absent both, the row is
  // a genuine root (a person, a cron tick, a connector sync).
  const actingScope = getActingAutomationScope();
  const producerAutomationId =
    params.automationId ?? actingScope?.automationId ?? null;
  const actingRunId =
    actingScope != null && actingScope.automationId === producerAutomationId
      ? actingScope.runId
      : null;

  try {
    const eventParams = {
      ...params,
      connectionId: null,
      automationId: producerAutomationId,
      metadata,
    };
    const afterPersist = options?.sql
      ? (event: InsertedEvent, tx: DbClient) =>
          queueWorkspaceEventActivationInTransaction(
            {
              organizationId: params.organizationId,
              eventId: event.id,
              eventType: formattedEventType,
              producerAutomationId,
              actingRunId,
            },
            tx
          )
      : undefined;
    const inserted =
      options?.lockAndPruneEntityRefs && params.entityIds.length > 0
        ? await insertAuditEventPruningDeletedEntityRefs(
            eventParams,
            options?.sql ?? getDb(),
            afterPersist
          )
        : await insertEvent(eventParams, {
            ...(options?.sql ? { sql: options.sql } : {}),
            ...(afterPersist ? { afterPersist } : {}),
          });
    if (!options?.sql) {
      await queueWorkspaceEventActivation({
        organizationId: params.organizationId,
        eventId: inserted.id,
        eventType: formattedEventType,
        producerAutomationId,
        actingRunId,
      });
    }
    return inserted;
  } catch (error) {
    if (!isUniqueViolation(error, AUDIT_IDEMPOTENCY_INDEX)) throw error;
    if (options?.sql) throw error;
    const existing = await findConnectionlessEventByIdempotencyKey(
      params.organizationId,
      idempotencyKey,
      {
        semanticType: params.semanticType,
        originType: params.originType,
        originId: params.originId,
        parentOriginId: params.parentOriginId,
      }
    );
    if (!existing) throw error;
    return existing;
  }
}

/**
 * Record a change event for audit purposes.
 *
 * Fire-and-forget — never throws. Retries once after a short delay; the same
 * originId is reconciled before re-insert so an ambiguous success cannot
 * append a duplicate. If both attempts fail the dropped audit row is logged
 * at ERROR with full event context so it's visible in alerting rather than
 * silently lost. Used for entity updates, automation archival, connection/feed
 * deletion, etc.
 */
export function recordChangeEvent(params: ChangeEventParams): void {
  if (params.entityIds.length === 0) return;

  const externalId = `change_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  retryWithBackoff(
    () =>
      insertConnectionlessAuditEvent({
        entityIds: params.entityIds,
        organizationId: params.organizationId,
        originId: externalId,
        title: params.title,
        content: params.content,
        semanticType: 'change',
        metadata: params.metadata,
        createdBy: params.createdBy ?? null,
        clientId: params.clientId ?? null,
      },
      { subject: params.subject, op: params.op }),
    AUDIT_EVENT_RETRY
  ).catch((err) => {
    logger.error(
      {
        err,
        originId: externalId,
        organizationId: params.organizationId,
        entityIds: params.entityIds,
        title: params.title,
        metadata: params.metadata,
      },
      '[insert-event] change audit event DROPPED after retry — audit trail is missing this row'
    );
  });
}

/** Canonical entity.updated event joined to its semantic mutation transaction. */
export async function insertChangeEventInTransaction(
  params: ChangeEventParams,
  sql: DbClient
): Promise<InsertedEvent | null> {
  if (params.entityIds.length === 0) return null;
  return insertConnectionlessAuditEvent(
    {
      entityIds: params.entityIds,
      organizationId: params.organizationId,
      originId: `change_${crypto.randomUUID()}`,
      title: params.title,
      content: params.content,
      semanticType: 'change',
      metadata: params.metadata,
      createdBy: params.createdBy ?? null,
      clientId: params.clientId ?? null,
    },
    { subject: params.subject, op: params.op },
    { sql }
  );
}

interface EdgeFieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface EdgeChangeEventParams {
  organizationId: string;
  relationshipId: number;
  fromEntityId: number;
  toEntityId: number;
  relationshipTypeId: number;
  relationshipTypeSlug: string | null;
  op: 'link' | 'unlink' | 'update_link';
  changes: EdgeFieldChange[];
  createdBy?: string | null;
  clientId?: string | null;
}

/** Canonical relationship transition event joined to its edge transaction. */
export async function insertEdgeChangeEventInTransaction(
  params: EdgeChangeEventParams,
  sql: DbClient
): Promise<InsertedEvent> {
  const verb: EdgeOp =
    params.op === 'link' ? 'linked' : params.op === 'unlink' ? 'unlinked' : 'updated';
  return insertConnectionlessAuditEvent(
    {
      organizationId: params.organizationId,
      entityIds: [params.fromEntityId, params.toEntityId],
      originId: `edge:${params.relationshipId}:${params.op}:${crypto.randomUUID()}`,
      semanticType: 'change',
      title: `Relationship ${verb}: ${params.relationshipTypeSlug ?? params.relationshipTypeId}`,
      metadata: {
        _lobu_relationship_change: true,
        category: 'relationship',
        op: params.op,
        relationshipId: String(params.relationshipId),
        fromEntityId: String(params.fromEntityId),
        toEntityId: String(params.toEntityId),
        relationshipTypeId: String(params.relationshipTypeId),
        relationshipTypeSlug: params.relationshipTypeSlug,
        changes: params.changes,
      },
      createdBy: params.createdBy ?? null,
      clientId: params.clientId ?? null,
    },
    { subject: 'relationship', op: verb },
    { lockAndPruneEntityRefs: true, sql }
  );
}

// ============================================
// Lifecycle Event (entity create / update / delete)
// ============================================

type LifecycleOp = 'created' | 'updated' | 'deleted';

interface LifecycleEventParams {
  organizationId: string;
  /**
   * Platform object this row is about, used by dashboard SQL to pivot lifecycle
   * rows (`metadata->>'entity_type'`).
   *
   * Narrowed to `AUDIT_LIFECYCLE_SUBJECTS` rather than free-form: the same
   * value becomes the `<subject>` half of a subscribable event type, so a
   * subject the catalog does not know about would emit an event nothing can
   * ever subscribe to. Adding one is a one-line change in the catalog, which
   * then makes it subscribable and discoverable in the same edit.
   */
  entityType: AuditLifecycleSubject;
  op: LifecycleOp;
  entityId: string | number;
  /** Human-readable summary (e.g. "Agent 'Marketing' created"). */
  summary: string;
  /** Optional extra metadata merged under `metadata.extra`. */
  extra?: Record<string, unknown>;
  createdBy?: string | null;
}

/**
 * Record an entity-lifecycle change as a `semantic_type='change'` event.
 * Used by the metric_series SQL to compute cumulative counts (agents,
 * connections, …) and the dashboard sparklines. Fire-and-forget.
 *
 * Metadata shape (queryable via `metadata->>'category'`, etc.):
 *   {
 *     "category": "lifecycle",
 *     "entity_type": "connection",
 *     "op": "created",
 *     "entity_id": "...",
 *     "extra": { ... }    // optional
 *   }
 */
// ============================================
// Config Change Event (settings/deployment audit trail)
// ============================================

type ConfigOp = 'created' | 'updated' | 'deleted';
type ConfigActorSource = 'cli' | 'ui' | 'api' | 'agent';

interface StateChangeEventParams<ResourceKind extends AuditResourceKind> {
  organizationId: string;
  resourceKind: ResourceKind;
  resourceId: string | number;
  op: ConfigOp;
  /** Human-readable summary (e.g. "Agent 'Marketing' settings updated"). */
  summary: string;
  /**
   * Full post-change resource state (the row as written, including
   * server-merged fields — not the request body). Null for deletes and for
   * secret-only endpoints. Redacted by this writer before insert.
   */
  state: Record<string, unknown> | null;
  changedFields?: string[];
  /** `x-lobu-apply-id` when the mutation came from a `lobu apply` run. */
  applyId?: string | null;
  actorSource?: ConfigActorSource;
  createdBy?: string | null;
  clientId?: string | null;
}

export interface ConfigChangeEventParams extends StateChangeEventParams<ConfigResourceKind> {}

export interface WorkspaceChangeEventParams
  extends StateChangeEventParams<WorkspaceAuditResourceKind> {}

/**
 * Record a state mutation as a `semantic_type='change'` event with the full
 * redacted post-change state in `payload_data.state`. Config mutations use
 * `metadata.category='config'`, the settings audit trail behind the
 * Deployments feed; distinct from `category='lifecycle'` rows, which carry no
 * state and feed dashboard metric_series — handlers that emit lifecycle
 * events dual-write this one. Fire-and-forget, same retry/ERROR contract as
 * the writers above.
 *
 * Workspace identity mutations use `metadata.category='workspace'`, keeping
 * them out of the Deployments feed while still showing them in All activity.
 */
function recordStateChangeEvent(
  params: StateChangeEventParams<AuditResourceKind>,
  category: 'config' | 'workspace'
): void {
  const externalId = `${category}_${params.resourceKind}_${params.op}_${params.resourceId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state = redactConfigState(params.resourceKind, params.state);

  retryWithBackoff(
    () =>
      insertConnectionlessAuditEvent({
        entityIds: [],
        organizationId: params.organizationId,
        originId: externalId,
        title: params.summary,
        semanticType: 'change',
        originType: `${category}_${params.resourceKind}_${params.op}`,
        payloadType: 'empty',
        payloadData: { state },
        metadata: {
          category,
          // Server-owned discriminator for workspace-identity audit rows.
          // `category` alone is NOT a safe gate: save_memory accepts caller
          // metadata, so a member could stamp category='workspace' on a
          // legitimate event and lose read access. `_lobu_` is the reserved
          // server namespace callers cannot spoof — all exclusion predicates
          // gate on this key, not the human-readable category.
          ...(category === 'workspace' ? { _lobu_workspace_audit: true } : {}),
          resource_kind: params.resourceKind,
          resource_id: String(params.resourceId),
          op: params.op,
          ...(params.changedFields?.length ? { changed_fields: params.changedFields } : {}),
          ...(params.applyId ? { apply_id: params.applyId } : {}),
          ...(params.actorSource ? { actor_source: params.actorSource } : {}),
        },
        createdBy: params.createdBy ?? null,
        clientId: params.clientId ?? null,
      },
      { subject: params.resourceKind, op: params.op }),
    AUDIT_EVENT_RETRY
  ).catch((err) => {
    logger.error(
      {
        err,
        originId: externalId,
        organizationId: params.organizationId,
        resourceKind: params.resourceKind,
        op: params.op,
        resourceId: String(params.resourceId),
        summary: params.summary,
      },
      `[insert-event] ${category} audit event DROPPED after retry — audit trail is missing this row`
    );
  });
}

export function recordConfigChangeEvent(params: ConfigChangeEventParams): void {
  recordStateChangeEvent(params, 'config');
}

/**
 * Durable config audit seam for semantic mutations that already own a
 * transaction. The config event and any subscribed Automation activation task
 * commit with the state change; failures roll the whole mutation back.
 */
export async function insertConfigChangeEventInTransaction(
  params: ConfigChangeEventParams,
  sql: DbClient
): Promise<InsertedEvent> {
  return insertStateChangeEventInTransaction(params, 'config', sql);
}

/**
 * Durable workspace audit seam for identity mutations that already own a
 * transaction. The audit row and its Automation activation task commit with
 * the invitation/member state they describe.
 */
export async function insertWorkspaceChangeEventInTransaction(
  params: WorkspaceChangeEventParams,
  sql: DbClient
): Promise<InsertedEvent> {
  return insertStateChangeEventInTransaction(params, 'workspace', sql);
}

async function insertStateChangeEventInTransaction(
  params: StateChangeEventParams<AuditResourceKind>,
  category: 'config' | 'workspace',
  sql: DbClient
): Promise<InsertedEvent> {
  const originId = `${category}_${params.resourceKind}_${params.op}_${params.resourceId}_${crypto.randomUUID()}`;
  const state = redactConfigState(params.resourceKind, params.state);
  return insertConnectionlessAuditEvent(
    {
      entityIds: [],
      organizationId: params.organizationId,
      originId,
      title: params.summary,
      semanticType: 'change',
      originType: `${category}_${params.resourceKind}_${params.op}`,
      payloadType: 'empty',
      payloadData: { state },
      metadata: {
        category,
        ...(category === 'workspace' ? { _lobu_workspace_audit: true } : {}),
        resource_kind: params.resourceKind,
        resource_id: String(params.resourceId),
        op: params.op,
        ...(params.changedFields?.length ? { changed_fields: params.changedFields } : {}),
        ...(params.applyId ? { apply_id: params.applyId } : {}),
        ...(params.actorSource ? { actor_source: params.actorSource } : {}),
      },
      createdBy: params.createdBy ?? null,
      clientId: params.clientId ?? null,
    },
    { subject: params.resourceKind, op: params.op },
    { sql }
  );
}

export function recordWorkspaceChangeEvent(params: WorkspaceChangeEventParams): void {
  recordStateChangeEvent(params, 'workspace');
}

export function recordLifecycleEvent(params: LifecycleEventParams): void {
  // Include a random suffix so two same-entity/op lifecycle writes in the same
  // millisecond get distinct originIds (and distinct audit: idempotency keys).
  const externalId = `lifecycle_${params.entityType}_${params.op}_${params.entityId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Fire-and-forget with one bounded retry. Same originId + connectionless
  // reconcile so an ambiguous success cannot double-count. A doubly-failed
  // write is an ERROR — these rows feed the dashboard metric_series, and a
  // silent drop skews the cumulative counts forever.
  retryWithBackoff(
    () =>
      insertConnectionlessAuditEvent({
        entityIds: [],
        organizationId: params.organizationId,
        originId: externalId,
        title: params.summary,
        semanticType: 'change',
        originType: `${params.entityType}_${params.op}`,
        metadata: {
          category: 'lifecycle',
          entity_type: params.entityType,
          op: params.op,
          entity_id: String(params.entityId),
          ...(params.extra ? { extra: params.extra } : {}),
        },
        createdBy: params.createdBy ?? null,
      },
      { subject: params.entityType, op: params.op }),
    AUDIT_EVENT_RETRY
  ).catch((err) => {
    logger.error(
      {
        err,
        originId: externalId,
        organizationId: params.organizationId,
        entityType: params.entityType,
        op: params.op,
        entityId: String(params.entityId),
        summary: params.summary,
      },
      '[insert-event] lifecycle audit event DROPPED after retry — audit trail is missing this row'
    );
  });
}
