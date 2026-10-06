import { FeedSourceAckSchema, type PollRequest } from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import type { DbClient, DbQuery } from '../db/client';
import { pgTextArray } from '../db/client';
import { feedBackoff } from '../connectors/feed-backoff';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { notifyWorkerWork } from './worker-wakeup';
import { enqueueSourceFeedObservation } from './source-feed-observation';
import { sourceFeedSubscriptions } from './source-feed-subscriptions';
import { SOURCE_FEED_OBSERVE_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY } from '../lib/device-feed-read-protocol';

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
        SELECT f.id, f.organization_id, f.checkpoint,
          d.feeds_schema->f.feed_key->'operations' ? 'observe' AS observes
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
        JOIN LATERAL (${feedDefinitionSelection(tx)}) d ON true
        WHERE f.id = ${notice.feed_id} AND c.id = ${notice.connection_id}
          AND c.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
          AND c.device_worker_id = ${deviceWorkerId}::uuid
          AND c.status = 'active' AND c.deleted_at IS NULL
          AND f.status = 'active' AND f.deleted_at IS NULL
          AND f.feed_key = ${notice.feed_key}
          AND (d.feeds_schema->f.feed_key->'operations' ? 'observe' OR (
          d.feeds_schema->f.feed_key->'webhook' IS NOT NULL
          AND COALESCE(d.feeds_schema->f.feed_key->'webhook'->>'mode', 'trigger') = 'trigger'
          AND d.feeds_schema->f.feed_key->'operations' @> '["sync"]'::jsonb))
        FOR UPDATE OF f, c
      `;
      if (rows.length === 0) return { active: false };
      if (rows[0].observes) {
        if (!(await sourceFeedSubscriptions(tx, rows[0].organization_id, notice.feed_id)).length) return { active: false };
        if (notice.changed) await enqueueSourceFeedObservation(tx, rows[0].organization_id, notice.feed_id);
        return { active: true, ack: savedSourceAck(rows[0].checkpoint) };
      }
      if (notice.changed) {
        // Never use a live event to defeat failure backoff. A manual feed that
        // failed has no cron retry, so retain one bounded retry for its buffer.
        await requestFeedSync(tx, tx`
          SELECT id FROM feeds WHERE id = ${notice.feed_id}
        `);
      }
      return { active: true, ack: savedSourceAck(rows[0].checkpoint) };
    });
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
           c.device_worker_id, r.run_type, r.automation_id
    FROM runs r
    JOIN feeds f ON f.id = r.feed_id AND f.organization_id = r.organization_id
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
    JOIN LATERAL (${feedDefinitionSelection(sql)}) d ON true
    WHERE r.id = ${parentRunId} AND r.organization_id = ${organizationId}
      AND r.status = 'running'
      AND r.connection_id = c.id
      AND c.device_worker_id = ${deviceWorkerId}::uuid
      AND c.status = 'active' AND c.deleted_at IS NULL
      AND (f.status = 'active' OR (r.dry_run AND f.status = 'paused')) AND f.deleted_at IS NULL
      AND ((r.run_type = 'sync' AND d.feeds_schema->f.feed_key->'webhook' IS NOT NULL
      AND COALESCE(d.feeds_schema->f.feed_key->'webhook'->>'mode', 'trigger') = 'trigger'
      AND d.feeds_schema->f.feed_key->'operations' @> '["sync"]'::jsonb)
      OR (r.run_type = 'action' AND r.action_key = ${SOURCE_FEED_OBSERVE_ACTION_KEY}
        AND r.run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true'
        AND r.parent_run_id IS NULL AND r.approval_status IN ('auto', 'approved')
        AND r.expires_at > now() AND NOT r.dry_run
        AND d.feeds_schema->f.feed_key->'operations' ? 'observe'))
  `;
  if (!row) return undefined;
  if (row.run_type === 'action' && !(await sourceFeedSubscriptions(sql, organizationId, Number(row.feed_id)))
    .some(subscription => subscription.automationId === Number(row.automation_id))) return undefined;
  return {
    dry_run: row.dry_run === true,
    connection_id: Number(row.connection_id),
    feed_id: Number(row.feed_id),
    feed_key: String(row.feed_key),
    device_worker_id: String(row.device_worker_id),
    ack: row.dry_run ? null : savedSourceAck(row.checkpoint),
  };
}
