/**
 * Workspace cache invalidations, delivered across replicas.
 *
 * Each replica keeps its SSE subscribers in a local Map (an SSE socket lives
 * on one pod), but the signal itself travels through Postgres LISTEN/NOTIFY
 * on one channel so a write on any replica reaches browsers on every replica.
 *
 * Two producers:
 * - `emit()` — app-code invalidations after a committed write. Delivered to
 *   local subscribers synchronously and published to peers; receivers skip
 *   their own `origin`.
 * - `notifyEventContentChanged()` — the event write funnel. Issued on the
 *   writer's own SQL handle, so inside a transaction Postgres delivers it on
 *   COMMIT and drops it on ROLLBACK, and identical payloads in one
 *   transaction collapse into one notification. No origin: every replica,
 *   including the writer's, receives it through LISTEN.
 *
 * NOTIFYs sent while a replica's listener connection is down are lost. When
 * the listener re-subscribes, every local subscriber gets a `resync` and its
 * client re-reads durable state.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@lobu/core';
import { type DbClient, getDb, getDbListener } from '../db/client';

const logger = createLogger('invalidation-emitter');

export interface InvalidationEvent {
  /** Query keys to invalidate (e.g. ['resolve-path'], ['workspace-bootstrap']) */
  keys: string[];
  /** Set when deliveries may have been missed; clients re-read everything. */
  resync?: true;
}

/** Content cache root the frontend listens on for event writes. */
export const CONTENT_INVALIDATION_KEY = 'contents-filtered';

const CHANNEL = 'workspace_invalidation';
/** Trailing window that collapses a burst of autocommit event writes. */
const COALESCE_MS = 100;

type Listener = (event: InvalidationEvent) => void;

interface NotifyMessage {
  org: string;
  keys: string[];
  origin?: string;
}

const listeners = new Map<string, Set<Listener>>();
const origin = randomUUID();
const pending = new Map<string, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listening: Promise<void> | null = null;

function dispatch(organizationId: string, event: InvalidationEvent): void {
  const set = listeners.get(organizationId);
  if (!set) return;
  // Snapshot to avoid issues if a listener unsubscribes during iteration
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch {
      // Don't let one listener break others
    }
  }
}

function flushPending(): void {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (const [organizationId, keys] of batch) {
    dispatch(organizationId, { keys: [...keys] });
  }
}

function onNotify(payload: unknown): void {
  if (typeof payload !== 'string') return;
  let message: NotifyMessage;
  try {
    message = JSON.parse(payload) as NotifyMessage;
  } catch {
    return;
  }
  if (!message || typeof message.org !== 'string' || !Array.isArray(message.keys)) return;
  if (message.origin === origin) return;
  if (!listeners.has(message.org)) return;
  let keys = pending.get(message.org);
  if (!keys) {
    keys = new Set();
    pending.set(message.org, keys);
  }
  for (const key of message.keys) {
    if (typeof key === 'string') keys.add(key);
  }
  flushTimer ??= setTimeout(flushPending, COALESCE_MS);
}

function onResubscribed(): void {
  for (const organizationId of [...listeners.keys()]) {
    dispatch(organizationId, { keys: [], resync: true });
  }
}

/**
 * Start this replica's LISTEN once. Resolves after the subscription is live
 * (or after it failed — local `emit()` delivery still works then), so a
 * stream that awaits it before telling its client "connected" cannot miss a
 * NOTIFY between the client's initial read and the subscription.
 */
export function ensureInvalidationListener(): Promise<void> {
  listening ??= (async () => {
    let subscribed = false;
    try {
      await getDbListener().listen(CHANNEL, onNotify, () => {
        // postgres-js calls this on the first subscribe and again after every
        // reconnect; only the reconnect crossed a gap.
        if (subscribed) onResubscribed();
        subscribed = true;
      });
    } catch (err) {
      listening = null;
      logger.error(
        { err },
        'Invalidation LISTEN failed; cross-replica cache invalidation disabled on this replica'
      );
    }
  })();
  return listening;
}

export function subscribe(organizationId: string, listener: Listener): () => void {
  if (!listeners.has(organizationId)) {
    listeners.set(organizationId, new Set());
  }
  listeners.get(organizationId)!.add(listener);

  return () => {
    const set = listeners.get(organizationId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(organizationId);
    }
  };
}

export function emit(organizationId: string, event: InvalidationEvent): void {
  dispatch(organizationId, event);
  let payload: string;
  try {
    payload = JSON.stringify({ org: organizationId, keys: event.keys, origin } satisfies NotifyMessage);
    getDb()`SELECT pg_notify(${CHANNEL}, ${payload})`.catch((err: unknown) => {
      logger.debug({ err }, 'Invalidation NOTIFY failed');
    });
  } catch (err) {
    logger.debug({ err }, 'Invalidation NOTIFY failed');
  }
}

/**
 * Invalidate content caches for an event's organization and every
 * organization it is linked into. Run it on the SAME handle that wrote the
 * event so the notification commits or rolls back with the write.
 */
export async function notifyEventContentChanged(sql: DbClient, eventId: number): Promise<void> {
  await sql`
    SELECT pg_notify(
      ${CHANNEL},
      json_build_object('org', o.org, 'keys', json_build_array(${CONTENT_INVALIDATION_KEY}::text))::text
    )
    FROM (
      SELECT e.organization_id AS org FROM events e WHERE e.id = ${eventId}
      UNION
      SELECT unnest(e.linked_org_ids) FROM events e WHERE e.id = ${eventId}
    ) o
    WHERE o.org IS NOT NULL
  `;
}
