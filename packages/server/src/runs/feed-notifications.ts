import { FeedSourceAckSchema, type PollRequest } from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import type { DbClient, DbQuery } from '../db/client';
import { pgTextArray } from '../db/client';
import { feedBackoff, feedBackoffDelayMs } from '../connectors/feed-backoff';
import { notifyWorkerWork } from './worker-wakeup';
import { createSyncRunWithClient } from './queue-service';
import logger from '../utils/logger';

function savedSourceAck(checkpoint: Record<string, unknown> | null) {
  const ack = checkpoint?.source_ack;
  return Value.Check(FeedSourceAckSchema, ack) ? ack : null;
}

type FeedNotification = NonNullable<PollRequest['feed_notifications']>[number];

/** Caller owns source routing; this is the single scheduling mutation. */
export async function requestFeedSync(sql: DbClient, selection: DbQuery) {
  const updated = await sql`
    UPDATE feeds f
    SET next_run_at = CASE
          WHEN f.consecutive_failures = 0 THEN LEAST(f.next_run_at, current_timestamp)
          ELSE COALESCE(f.next_run_at, current_timestamp +
            (LEAST(${feedBackoff.maxMs}::bigint,
              ${feedBackoff.baseMs}::bigint * (2 ^ LEAST(GREATEST(f.consecutive_failures - 1, 0), 30))::bigint
            ) || ' milliseconds')::interval)
        END,
        updated_at = current_timestamp
    WHERE f.id IN (${selection}) AND f.status = 'active' AND f.deleted_at IS NULL
    RETURNING f.id
  `;
  if (updated.length > 0) await notifyWorkerWork(sql);
  return updated;
}

/** Device notifications and provider webhooks wake the same existing feeds. */
export async function receiveFeedNotifications(
  sql: DbClient,
  notifications: FeedNotification[],
  deviceWorkerId: string,
  orgScopeIds: string[],
): Promise<Array<{ feed_id: number; connection_id: number; feed_key: string; notification_id: string; active: boolean; ack?: unknown }>> {
  const receipts: Array<{ feed_id: number; connection_id: number; feed_key: string; notification_id: string; active: boolean; ack?: unknown }> = [];
  for (const notice of notifications) {
    // One transaction owns both eligibility and any due write. For a changed
    // notification, its receipt means committed scheduling, not ingestion.
    const received = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT f.id, f.checkpoint, f.consecutive_failures, f.last_sync_at,
               d.feeds_schema->f.feed_key->'operations' AS operations
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
        JOIN LATERAL (
          SELECT feeds_schema FROM connector_definitions d
          WHERE d.organization_id = c.organization_id AND d.key = c.connector_key
            AND (d.status = 'active' OR d.version = f.pinned_version)
          ORDER BY (d.version = f.pinned_version) DESC NULLS LAST, (d.status = 'active') DESC, d.id DESC
          LIMIT 1
        ) d ON true
        WHERE f.id = ${notice.feed_id} AND c.id = ${notice.connection_id}
          AND c.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
          AND c.device_worker_id = ${deviceWorkerId}::uuid
          AND c.status = 'active' AND c.deleted_at IS NULL
          AND f.status = 'active' AND f.deleted_at IS NULL
          AND f.feed_key = ${notice.feed_key}
          AND d.feeds_schema->f.feed_key->'webhook' IS NOT NULL
          AND (d.feeds_schema->f.feed_key->'operations' @> '["sync"]'::jsonb
            OR d.feeds_schema->f.feed_key->'operations' @> '["delivery"]'::jsonb)
        FOR UPDATE OF f, c
      `;
      if (rows.length === 0) return { active: false };
      const feed = rows[0];
      const ack = savedSourceAck(feed.checkpoint);
      if (notice.changed && Array.isArray(feed.operations) && feed.operations.includes('delivery')) {
        // The source is the durable owner until successful ingestion ACK. With
        // one active run per feed, arrivals during execution stay in that source
        // buffer and are offered again; never overwrite the running snapshot.
        if (!notice.batch) return { active: true, ack };
        const batch = notice.batch;
        const acknowledged = ack?.binding_id === batch.binding_id && ack.epoch === batch.epoch
          ? new Map(ack.records.map((record) => [record.id, record.revision])) : new Map<string, number>();
        const records = batch.records.filter((record) =>
          acknowledged.get(String(record.payload.id)) !== record.revision);
        // Same backoff as the SQL in requestFeedSync, measured from the last
        // executed run rather than from next_run_at, which a delivery feed lacks.
        const retryReady = !feed.last_sync_at || Date.now() >=
          new Date(feed.last_sync_at).getTime() + feedBackoffDelayMs(Number(feed.consecutive_failures));
        if (retryReady && (records.length > 0 || batch.recovery === true)) {
          await createSyncRunWithClient(tx, notice.feed_id, {
            delivery: { id: notice.notification_id, event: 'records', payload: { ...batch, records } },
          });
        }
      } else if (notice.changed) {
        // Metadata-only trigger feeds retain their existing pull scheduling.
        await requestFeedSync(tx, tx`SELECT id FROM feeds WHERE id = ${notice.feed_id}`);
      }
      return { active: true, ack };
    }).catch((error) => {
      // Roll back this notice before continuing the device poll. No receipt
      // means no acknowledgment: the source retains the batch for retry.
      logger.warn({ error, feedId: notice.feed_id }, 'Source notification deferred; retaining unacknowledged batch');
      return null;
    });
    if (!received) continue;
    receipts.push({ feed_id: notice.feed_id, connection_id: notice.connection_id, feed_key: notice.feed_key, notification_id: notice.notification_id, ...received });
  }
  return receipts;
}

/** Only an active parent sync can authorize a device to observe its source feed. */
export async function sourceFeedContextForRun(
  sql: DbClient,
  parentRunId: number | null,
  deviceWorkerId: string | null,
  organizationId: string,
) {
  if (parentRunId == null || deviceWorkerId == null) return undefined;
  const [row] = await sql`
    SELECT f.id AS feed_id, f.connection_id, f.feed_key, f.checkpoint, r.dry_run,
           c.device_worker_id
    FROM runs r
    JOIN feeds f ON f.id = r.feed_id AND f.organization_id = r.organization_id
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (
      SELECT feeds_schema FROM connector_definitions d
      WHERE d.organization_id = c.organization_id AND d.key = c.connector_key
        AND (d.status = 'active' OR d.version = f.pinned_version)
      ORDER BY (d.version = f.pinned_version) DESC NULLS LAST, (d.status = 'active') DESC, d.id DESC
      LIMIT 1
    ) d ON true
    WHERE r.id = ${parentRunId} AND r.organization_id = ${organizationId}
      AND r.run_type = 'sync' AND r.status = 'running'
      AND r.connection_id = c.id
      AND c.device_worker_id = ${deviceWorkerId}::uuid
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND (f.status = 'active' OR (r.dry_run AND f.status = 'paused')) AND f.deleted_at IS NULL
      AND d.feeds_schema->f.feed_key->'webhook' IS NOT NULL
      AND (d.feeds_schema->f.feed_key->'operations' @> '["sync"]'::jsonb
        OR d.feeds_schema->f.feed_key->'operations' @> '["delivery"]'::jsonb)
  `;
  if (!row) return undefined;
  return {
    dry_run: row.dry_run === true,
    connection_id: Number(row.connection_id),
    feed_id: Number(row.feed_id),
    feed_key: String(row.feed_key),
    device_worker_id: String(row.device_worker_id),
    ack: row.dry_run ? null : savedSourceAck(row.checkpoint),
  };
}
