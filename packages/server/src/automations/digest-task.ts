/**
 * Runtime for the durable Automation material-change digest handoff (#3663),
 * queued by `./digest-enqueue` inside `complete_window`'s window transaction.
 *
 * Rehydrates everything from durable state: the material changes from the
 * run's `change_set` event (the evidence the window committed), the
 * destination from the Automation's stored `delivery_target` (fail closed —
 * a stale binding never falls back to another channel), and the content from
 * the shared `./digest` builder the UI preview uses.
 *
 * Delivery itself goes through the existing notification pipeline
 * (`createNotificationForUsers` + the `deliver-notification` task), keyed by
 * source run + destination + fingerprint, so a retry or replay resolves to
 * the same notification event instead of a duplicate. This task only QUEUES
 * that handoff: `createNotificationForUsers` commits the notification event
 * and its `deliver-notification` task row, and the actual channel post happens
 * later in `deliverNotificationTask`, with per-destination receipts persisted
 * on the event (`metadata.delivery`). History here records `digest_queued`
 * with the linked notification event + delivery task identity; actual
 * success/failure is observable on that existing delivery task/run/receipt
 * path, never on a parallel subsystem. Never record `digest_delivered` here —
 * provider acceptance with a lost receipt can still duplicate an external
 * message, so only the delivery receipts prove a post.
 *
 * Settles like `reaction-task`: success and deterministic failures return
 * (recorded on `automation_reactions`, where `get_automation` already
 * surfaces per-window reaction history); transient failures and a changed
 * destination THROW, which is the scheduler's signal to retry within its
 * bounded `maxAttempts: 3` budget — never infinite.
 */

import type { Env } from '@lobu/connector-sdk';
import { getDb } from '../db/client';
import { createNotificationForUsers } from '../notifications/service';
import { trackAutomationReaction } from '../utils/automation-reactions';
import { getErrorMessage } from '@lobu/core';
import logger from '../utils/logger';
import { NOTIFICATION_DELIVERY_TASK } from '../scheduled/task-definitions';
import { loadConfiguredAutomationDeliveryTarget } from './delivery-target';
import {
  automationChangeSetIdempotencyKey,
  automationDigestNotificationKey,
  buildAutomationDigestContent,
  fingerprintMaterialDigestChanges,
  materialDigestChanges,
  type AutomationDigestChange,
} from './digest';
import type { AutomationDigestTaskPayload } from './digest-enqueue';

/** Outcome reported back to the scheduler log; settled failures are tracked durably. */
export type AutomationDigestTaskOutcome =
  | { status: 'success'; eventId: number; deliveryTaskId: number | null }
  | { status: 'failed'; error: string | undefined }
  | { status: 'skipped'; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asDigestChanges(value: unknown): AutomationDigestChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    const entityId = Number(row.entityId);
    if (!Number.isSafeInteger(entityId) || entityId <= 0) return [];
    if (row.kind !== 'created' && row.kind !== 'updated' && row.kind !== 'denied') {
      return [];
    }
    return [
      {
        entityId,
        name: typeof row.name === 'string' ? row.name : `#${entityId}`,
        kind: row.kind,
      },
    ];
  });
}

/**
 * Execute one queued digest. Throws on a TRANSIENT failure or a CHANGED
 * destination (the scheduler's signal to retry within its bounded
 * `maxAttempts: 3` budget); every other outcome settles the task.
 *
 * All `automation_reactions` history carries `runId: taskRunId` so concurrent
 * retries serialize on the established provenance/idempotency edge (advisory
 * lock + WHERE NOT EXISTS) instead of duplicating history. The digest task
 * row is enqueued with `parent_run_id = sourceRunId`, so that lineage check
 * passes for exactly this task.
 */
export async function runAutomationDigestTask(
  payload: AutomationDigestTaskPayload,
  _env: Env,
  taskRunId: number,
  attempt = 1
): Promise<AutomationDigestTaskOutcome> {
  const { organizationId, automationId, sourceRunId } = payload;
  const sql = getDb();

  if (
    !Number.isSafeInteger(payload.connectionId) ||
    payload.connectionId <= 0 ||
    typeof payload.channelId !== 'string' ||
    payload.channelId.length === 0 ||
    typeof payload.fingerprint !== 'string' ||
    payload.fingerprint.length === 0
  ) {
    return { status: 'skipped', reason: 'digest payload is invalid' };
  }

  // The source run is the identity. A task that outlived its run (superseded,
  // or the org torn down between commit and claim) settles, never retries
  // against state that will never appear.
  const [run] = await sql<{ status: string }>`
    SELECT status
    FROM runs
    WHERE id = ${sourceRunId}
      AND organization_id = ${organizationId}
      AND automation_id = ${automationId}
    LIMIT 1
  `;
  if (!run) return { status: 'skipped', reason: 'source run not found' };
  if (run.status !== 'completed') {
    return { status: 'skipped', reason: `source run is ${run.status}` };
  }

  // Re-read the material-change evidence the window committed. The fingerprint
  // is the integrity check: the digest sends exactly what the run applied.
  const changeSetKey = automationChangeSetIdempotencyKey(automationId, sourceRunId);
  const [changeSet] = await sql<{ metadata: unknown }>`
    SELECT metadata
    FROM events
    WHERE organization_id = ${organizationId}
      AND metadata->>'_lobu_idempotency_key' = ${changeSetKey}
    LIMIT 1
  `;
  const changes = asDigestChanges(asRecord(changeSet?.metadata).changes);
  const material = materialDigestChanges(changes);
  if (material.length === 0) {
    await trackAutomationReaction({
      organizationId,
      automationId,
      sourceRunId,
      runId: taskRunId,
      reactionType: 'digest_skipped',
      toolName: 'automation_digest',
      toolArgs: { attempt, reason: 'no material changes' },
      toolResult: { success: true },
    });
    return { status: 'skipped', reason: 'no material changes' };
  }
  if (fingerprintMaterialDigestChanges(changes) !== payload.fingerprint) {
    const error = 'Digest fingerprint does not match the committed change set';
    await trackAutomationReaction({
      organizationId,
      automationId,
      sourceRunId,
      runId: taskRunId,
      reactionType: 'digest_failed',
      toolName: 'automation_digest',
      toolArgs: { attempt, fingerprint: payload.fingerprint },
      toolResult: { success: false, error },
    });
    return { status: 'failed', error };
  }

  // Fail closed on the destination: a cleared target means the digest was
  // disabled after commit (settle as skipped, never reroute); a CHANGED
  // binding records `digest_failed` with the mismatch visible then THROWS so
  // the scheduler's bounded retries (`maxAttempts: 3`) can recover if rebound
  // to the exact snapshot — this task re-reads the target and never replays
  // entity writes. A stale-but-matching binding (snapshot intact, channel
  // currently unresolvable) likewise THROWS so the scheduler retries visibly;
  // the source run stays completed and entity writes stay committed either way.
  const [automation] = await sql<{
    delivery_target: { connection_id: number; channel_id: string } | null;
    name: string;
  }>`
    SELECT w.delivery_target,
           COALESCE(wv.name, 'automation-' || w.id) AS name
    FROM automations w
    LEFT JOIN automation_versions wv ON wv.id = w.current_version_id
    WHERE w.id = ${automationId}
      AND w.organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!automation) return { status: 'skipped', reason: 'automation not found' };
  const current = automation.delivery_target;
  if (!current) {
    await trackAutomationReaction({
      organizationId,
      automationId,
      sourceRunId,
      runId: taskRunId,
      reactionType: 'digest_skipped',
      toolName: 'automation_digest',
      toolArgs: { attempt, reason: 'delivery target cleared' },
      toolResult: { success: true },
    });
    return { status: 'skipped', reason: 'delivery target cleared' };
  }
  // Both sides are the stored normalized target (writes canonicalize to the
  // platform-prefixed channel key), so exact equality is the comparison —
  // a legacy bare id still matches the snapshot taken from the same row.
  const sameDestination =
    Number(current.connection_id) === payload.connectionId &&
    String(current.channel_id) === payload.channelId;
  if (!sameDestination) {
    const error =
      `Digest destination changed since run ${sourceRunId} committed; ` +
      `not delivering to a superseded channel. Rebind to the exact snapshot ` +
      `to recover within the scheduler's bounded retries.`;
    await trackAutomationReaction({
      organizationId,
      automationId,
      sourceRunId,
      runId: taskRunId,
      reactionType: 'digest_failed',
      toolName: 'automation_digest',
      toolArgs: {
        attempt,
        reason: 'destination changed',
        expected_connection_id: payload.connectionId,
        expected_channel_id: payload.channelId,
        current_connection_id: Number(current.connection_id),
        current_channel_id: String(current.channel_id),
        fingerprint: payload.fingerprint,
      },
      toolResult: { success: false, error },
    });
    throw new Error(error);
  }
  const configured = await loadConfiguredAutomationDeliveryTarget(
    sql,
    organizationId,
    automationId
  );
  if (configured.configured && !configured.target) {
    throw new Error(
      'Automation digest channel is no longer available. Re-link the private channel or choose another delivery channel before retrying.'
    );
  }
  if (!configured.configured || !configured.target) {
    throw new Error('Automation digest channel is unavailable');
  }

  const content = buildAutomationDigestContent({
    automationName: automation.name,
    changes,
  });
  const recipients = await sql<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND role IN ('admin', 'owner')
  `;
  const userIds = recipients.map((r) => r.userId);
  if (userIds.length === 0) {
    await trackAutomationReaction({
      organizationId,
      automationId,
      sourceRunId,
      runId: taskRunId,
      reactionType: 'digest_skipped',
      toolName: 'automation_digest',
      toolArgs: { attempt, reason: 'no recipients' },
      toolResult: { success: true },
    });
    return { status: 'skipped', reason: 'no recipients' };
  }

  let notification;
  try {
    notification = await createNotificationForUsers(userIds, {
      organizationId,
      type: 'generic',
      title: content.title,
      body: content.body,
      idempotencyKey: automationDigestNotificationKey({
        automationId,
        sourceRunId,
        fingerprint: payload.fingerprint,
        connectionId: payload.connectionId,
        channelId: payload.channelId,
      }),
      entityIds: material.map((c) => c.entityId).filter((id) => id > 0),
      automationId,
      runId: sourceRunId,
    });
  } catch (error) {
    throw new Error(
      `Digest notification failed for run ${sourceRunId}: ${getErrorMessage(error)}`
    );
  }
  if (notification.eventId == null) {
    throw new Error(`Digest notification failed for run ${sourceRunId}: no event`);
  }

  // The notification insert above committed the event AND its
  // `deliver-notification` task row (`createNotificationForUsers` enqueues in
  // the same transaction with key `deliver-notification:<eventId>`). Resolve
  // that task so history links the queued handoff to the existing delivery
  // path — actual channel success/failure lives on that task's runs row and
  // the event's `metadata.delivery` receipts, not here.
  const [deliveryTask] = await sql<{ id: number }>`
    SELECT id FROM runs
    WHERE run_type = 'task'
      AND action_key = ${NOTIFICATION_DELIVERY_TASK}
      AND idempotency_key = ${`${NOTIFICATION_DELIVERY_TASK}:${notification.eventId}`}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;

  await trackAutomationReaction({
    organizationId,
    automationId,
    sourceRunId,
    runId: taskRunId,
    reactionType: 'digest_queued',
    toolName: 'automation_digest',
    toolArgs: {
      attempt,
      fingerprint: payload.fingerprint,
      connection_id: payload.connectionId,
      channel_id: payload.channelId,
      notification_event_id: notification.eventId,
      delivery_task_id: deliveryTask ? Number(deliveryTask.id) : null,
    },
    toolResult: {
      success: true,
      eventId: notification.eventId,
      deliveryTaskId: deliveryTask ? Number(deliveryTask.id) : null,
    },
  });

  logger.info(
    { automation_id: automationId, run_id: sourceRunId, eventId: notification.eventId },
    'Automation digest queued (task)'
  );
  return {
    status: 'success',
    eventId: notification.eventId,
    deliveryTaskId: deliveryTask ? Number(deliveryTask.id) : null,
  };
}
