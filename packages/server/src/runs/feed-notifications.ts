import { createHash } from 'node:crypto';
import { FeedSourceAckSchema, type PollRequest } from '@lobu/core/contracts/worker/protocol';
import { Value } from '@sinclair/typebox/value';
import type { DbClient, DbQuery } from '../db/client';
import { pgTextArray } from '../db/client';
import { feedBackoff } from '../connectors/feed-backoff';
import { feedDefinitionSelection } from '../connectors/feed-definition-selection';
import { feedWebhookDrivenSql } from '../connectors/feed-health-semantics';
import { notifyWorkerWork } from './worker-wakeup';
import { enqueueSourceFeedListener } from './source-feed-listener';
import { sourceFeedScopeKey, sourceFeedSubscriptions } from './source-feed-subscriptions';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY } from '../lib/device-feed-read-protocol';
import { findMatchingAutomationActivations, queueAutomationActivations, dispatchAutomationRunsBestEffort } from '../automations/activation';
import logger from '../utils/logger';

type ReceivedNotification = { active: boolean; ack?: unknown; queued?: Array<{ runId: number; status: string }> };

function savedSourceAck(checkpoint: Record<string, unknown> | null) {
  const ack = checkpoint?.source_ack;
  return Value.Check(FeedSourceAckSchema, ack) ? ack : null;
}

type FeedNotification = NonNullable<PollRequest['feed_notifications']>[number];
type NotificationFeed = {
  organization_id: string;
  connector_key: string;
  version: string | null;
  automation_events: Array<{ key: string }> | null;
  event_types: string[] | null;
  source_only: boolean;
};

/** Called under the feed lock; references and replay progress commit together. */
async function receiveSourceReferenceDelivery(
  tx: DbClient,
  notice: FeedNotification,
  feed: NotificationFeed,
  config: unknown,
  allowed: Set<number>,
): Promise<ReceivedNotification> {
  const delivery = notice.subscription;
  if (!delivery || delivery.scope_key !== sourceFeedScopeKey(config, feed.version)) return { active: false };
  const declared = new Set((feed.automation_events ?? []).map(event => event.key));
  const eventTypes = new Set(feed.event_types ?? []);
  if (Buffer.byteLength(JSON.stringify(delivery)) > 256 * 1024
    || delivery.records.reduce((count, record) => count + record.payload.events.length, 0) > 1000
    || delivery.records.some(record => record.payload.events.some(event =>
      !declared.has(event.event_type) || !eventTypes.has(event.event_type)
      || (event.occurred_at && !Number.isFinite(Date.parse(event.occurred_at)))))) {
    // Revoke the bad binding before any writes. The next setup replays from the
    // unchanged source cursor instead of retrying this malformed buffer forever.
    logger.warn({ feedId: notice.feed_id }, 'Revoking invalid source reference delivery');
    return { active: false };
  }
  // A valid binding confirms setup. Preserve due recovery and failure backoff;
  // only a successful setup's future confirmation window can be cleared.
  await tx`UPDATE feeds SET next_run_at = NULL
    WHERE id = ${notice.feed_id} AND organization_id = ${feed.organization_id}
      AND consecutive_failures = 0 AND next_run_at > now()`;
  const queued: Array<{ runId: number; status: string }> = [];
  for (const { payload } of delivery.records) {
    for (const event of payload.events) {
      const deliveryId = createHash('sha256').update(JSON.stringify([
        feed.organization_id, notice.connection_id, event.event_type, event.id,
      ])).digest('hex');
      const signal = {
        connector_key: feed.connector_key, connection_id: notice.connection_id,
        event_type: event.event_type, resource_ref: event.resource_ref, resource_type: event.resource_type,
        occurred_at: event.occurred_at, delivery_id: `source:${deliveryId}`,
        label: `Source ${event.event_type}`,
        input_text: `Source change ${event.event_type}: ${JSON.stringify(event.resource_ref)}. Read its content from the source when needed.`,
      };
      const matches = await findMatchingAutomationActivations(feed.organization_id, signal, tx);
      queued.push(...await queueAutomationActivations({ signal, matches: matches.filter(match => allowed.has(match.automationId)), db: tx }));
    }
    // A lost receipt may replay an older page. Delivering it is harmless;
    // its cursor may advance only from the position it actually read.
    if (payload.checkpoint) await tx`UPDATE feeds
      SET checkpoint = jsonb_build_object('cursor', ${tx.json(payload.checkpoint.next)}::jsonb)
      WHERE id = ${notice.feed_id} AND organization_id = ${feed.organization_id}
        AND checkpoint->'cursor' IS NOT DISTINCT FROM ${payload.checkpoint.previous === null ? null : tx.json(payload.checkpoint.previous)}::jsonb`;
  }
  // The browser retains this hint after acknowledgments, so a finishing
  // setup task cannot consume and lose the next replay request.
  if (delivery.needs_rebind && delivery.records.length === 0) await enqueueSourceFeedListener(tx, feed.organization_id, notice.feed_id);
  return { active: true, queued, ack: { binding_id: delivery.binding_id, epoch: delivery.epoch,
    records: delivery.records.map(record => ({ id: record.payload.id, revision: record.revision })) } };
}

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
  const activations: Array<{ runId: number; status: string }> = [];
  for (const notice of notifications) {
    // One transaction owns both eligibility and any due write. For a changed
    // notification, its receipt means committed scheduling, not ingestion.
    const received = await sql.begin(async (tx): Promise<ReceivedNotification> => {
      const rows = await tx<NotificationFeed>`
        SELECT f.organization_id, c.connector_key,
          COALESCE(f.pinned_version, d.version) AS version,
          d.automation_events,
          d.feeds_schema->f.feed_key->'webhook'->'events' AS event_types,
          NOT (d.feeds_schema->f.feed_key->'operations' ? 'sync') AS source_only
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
        JOIN LATERAL (${feedDefinitionSelection(tx)}) d ON true
        WHERE f.id = ${notice.feed_id} AND c.id = ${notice.connection_id}
          AND c.organization_id = ANY(${pgTextArray(orgScopeIds)}::text[])
          AND c.device_worker_id = ${deviceWorkerId}::uuid
          AND c.status = 'active' AND c.deleted_at IS NULL
          AND f.status = 'active' AND f.deleted_at IS NULL
          AND f.feed_key = ${notice.feed_key}
          AND (${tx.unsafe(feedWebhookDrivenSql('d', 'f'))})
          AND COALESCE(d.feeds_schema->f.feed_key->'webhook'->>'mode', 'trigger') = 'trigger'
          AND d.feeds_schema->f.feed_key->'operations' ?| ARRAY['sync', 'read']
      `;
      if (rows.length === 0) return { active: false };
      const feed = rows[0];
      const subscriptions = feed.source_only ? await sourceFeedSubscriptions(tx, feed.organization_id, notice.feed_id) : [];
      if (feed.source_only && !subscriptions.length) return { active: false };
      // Resolve subscription authority before locking the checkpoint. Only this
      // feed's scheduling/ack mutation needs serialization, not its connection.
      const [locked] = await tx`SELECT checkpoint, config FROM feeds WHERE id = ${notice.feed_id}
        AND organization_id = ${feed.organization_id} AND status = 'active' AND deleted_at IS NULL FOR UPDATE`;
      if (!locked) return { active: false };
      if (feed.source_only) {
        return receiveSourceReferenceDelivery(tx, notice, feed, locked.config,
          new Set(subscriptions.map(subscription => subscription.automationId)));
      }
      if (notice.changed) {
        // Never use a live event to defeat failure backoff. A manual feed that
        // failed has no cron retry, so retain one bounded retry for its buffer.
        await requestFeedSync(tx, tx`
          SELECT id FROM feeds WHERE id = ${notice.feed_id}
        `);
      }
      return { active: true, ack: savedSourceAck(locked.checkpoint) };
    }).catch(error => {
      // No receipt: this binding keeps its batch for retry. Other bindings on
      // the device must still make progress, including already-committed ones.
      logger.warn({ err: error, feedId: notice.feed_id }, 'Source notification delivery failed');
      return null;
    });
    if (!received) continue;
    const { queued, ...receipt } = received;
    activations.push(...queued ?? []);
    receipts.push({ feed_id: notice.feed_id, connection_id: notice.connection_id, feed_key: notice.feed_key, notification_id: notice.notification_id, ...receipt });
  }
  await dispatchAutomationRunsBestEffort(activations);
  return receipts;
}

/** A running sync or authorized subscription setup owns its browser binding. */
export async function sourceFeedContextForRun(
  sql: DbClient,
  parentRunId: number | null,
  deviceWorkerId: string | null,
  organizationId: string,
) {
  if (parentRunId == null || deviceWorkerId == null) return undefined;
  const [row] = await sql`
    SELECT f.id AS feed_id, f.connection_id, f.feed_key, f.checkpoint, f.config, r.dry_run,
           c.device_worker_id, r.run_type, r.automation_id, r.connector_version,
           d.feeds_schema->f.feed_key->'webhook'->'events' AS event_types
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
      AND (${sql.unsafe(feedWebhookDrivenSql('d', 'f'))})
      AND COALESCE(d.feeds_schema->f.feed_key->'webhook'->>'mode', 'trigger') = 'trigger'
      AND ((r.run_type = 'sync' AND d.feeds_schema->f.feed_key->'operations' @> '["sync"]'::jsonb)
      OR (r.run_type = 'action' AND r.action_key = ${DEVICE_FEED_READ_ACTION_KEY}
        AND r.run_metadata->>${SOURCE_FEED_READ_METADATA_KEY} = 'true'
        AND r.run_metadata->>${SOURCE_FEED_SUBSCRIPTION_METADATA_KEY} = 'true'
        AND r.parent_run_id IS NULL AND r.approval_status IN ('auto', 'approved')
        AND r.expires_at > now() AND NOT r.dry_run
        AND d.feeds_schema->f.feed_key->'operations' ? 'read'
        AND NOT (d.feeds_schema->f.feed_key->'operations' ? 'sync')))
  `;
  if (!row) return undefined;
  if (row.run_type === 'action'
    && !(await sourceFeedSubscriptions(sql, organizationId, Number(row.feed_id), Number(row.automation_id))).length) return undefined;
  return {
    dry_run: row.dry_run === true,
    connection_id: Number(row.connection_id),
    feed_id: Number(row.feed_id),
    feed_key: String(row.feed_key),
    device_worker_id: String(row.device_worker_id),
    ack: row.dry_run ? null : savedSourceAck(row.checkpoint),
    ...(row.run_type === 'action' ? { subscription: {
      scope_key: sourceFeedScopeKey(row.config, row.connector_version), event_types: row.event_types ?? [],
    } } : {}),
  };
}
