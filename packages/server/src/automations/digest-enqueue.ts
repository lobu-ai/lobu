/**
 * Transactional handoff for the Automation material-change digest (#3663).
 *
 * Same durability shape as `./reaction-enqueue`: the digest task row commits
 * INSIDE `complete_window`'s window transaction, gated on the run's single
 * `running|claimed -> completed` transition, so exactly one handoff exists per
 * material run and a crash before the handler claims it leaves a `pending`
 * task the scheduler picks up. Idempotent replays short-circuit before the
 * enqueue and can never double-fire.
 *
 * Kept dependency-light like `reaction-enqueue`: the queueing end must not
 * drag in the consuming end. `complete-window.ts` imports only this module;
 * the digest content, channel resolution, and notification insert live in
 * `./digest-task`, which runs after commit. A digest-task failure therefore
 * never rolls back the window's entity writes.
 */

import type { DbClient } from '../db/client';
import { AUTOMATION_DIGEST_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import { automationDigestTaskKey } from './digest';

/**
 * Everything the handler needs to REHYDRATE from durable state. The material
 * changes themselves are re-read from the run's `change_set` event (the
 * evidence the window committed), never trusted from this bundle — the
 * fingerprint here is the integrity check that the evidence did not change
 * between commit and execution.
 */
export interface AutomationDigestTaskPayload {
  organizationId: string;
  automationId: number;
  sourceRunId: number;
  /** Stored `delivery_target` snapshot at commit time; revalidated at delivery. */
  connectionId: number;
  channelId: string;
  /** Fingerprint over the material changes, from `digest.ts`. */
  fingerprint: string;
}

/**
 * Queue the digest handoff on `tx`. Call INSIDE the window transaction, only
 * when the run actually transitioned to completed AND the window committed
 * material entity changes AND the Automation has a stored delivery target.
 * Zero-material-change runs enqueue nothing and stay silent.
 */
export async function enqueueAutomationDigest(
  tx: DbClient,
  payload: AutomationDigestTaskPayload
): Promise<number> {
  const idempotencyKey = automationDigestTaskKey({
    sourceRunId: payload.sourceRunId,
    connectionId: payload.connectionId,
    channelId: payload.channelId,
    fingerprint: payload.fingerprint,
  });
  const taskRunIds = await enqueueTasksInTransaction(tx, [
    {
      name: AUTOMATION_DIGEST_TASK,
      payload,
      opts: {
        idempotencyKey,
        maxAttempts: 3,
        organizationId: payload.organizationId,
        automationId: payload.automationId,
        parentRunId: payload.sourceRunId,
      },
    },
  ]);
  const taskRunId = taskRunIds.get(idempotencyKey);
  if (taskRunId === undefined) {
    throw new Error(
      `Failed to resolve queued digest task for source run ${payload.sourceRunId}`
    );
  }
  return taskRunId;
}
