/**
 * Charge one failed feed sync to the feed's source health.
 *
 * This source-health failure policy is applied from three lanes:
 *
 *  1. the worker reported an outcome — `completeWorkerJob`
 *     (worker-api/run-lifecycle.ts), the lane the backoff policy was written
 *     for; and
 *  2. the gateway failed the run inside the poll request itself, after the
 *     claim CTE already stamped the feed `last_sync_status='pending'` —
 *     `pollWorkerJob` (worker-api/poll.ts) resolving the connector's bundle;
 *     and
 *  3. the stale-run reaper timed out a sync after it crossed the worker-claim
 *     boundary (scheduled/check-stalled-executions.ts).
 *
 * Only (1) used to apply the policy, so a connector that could never produce a
 * bundle re-fired on its plain cadence forever: `consecutive_failures` pinned
 * at 0, `last_error` NULL, no backoff and no auto-pause — a feed that reports
 * healthy while every run fails. (1) and (2) charge through
 * {@link applyFeedSyncFailure}; (3) updates feeds inside the reaper's single
 * statement, so it shares {@link feedSyncFailureAssignments} instead.
 *
 * This is the FAILURE half only. Success also resets the counter, advances the
 * checkpoint and adds `items_collected`, none of which a lane that never ran
 * connector code can report; `completeWorkerJob` keeps that half.
 *
 * The caller must have already transitioned the run to a terminal state under
 * a lease fence, and must call this only when that transition actually
 * happened — charging a feed for a run someone else finalized double-counts
 * the failure.
 */

import { maybeEmitFeedAutoPausedAfterFailure } from '../automations/platform-events';
import type { DbClient } from '../db/client';
import { nextRunAt as nextRunAtFromCron } from '../utils/cron';
import { errorMessage } from '../utils/errors';
import logger from '../utils/logger';
import { feedBackoff } from './feed-backoff';

interface SqlTag<TFragment> {
  (strings: TemplateStringsArray, ...values: any[]): TFragment;
}

/**
 * The `UPDATE feeds SET` assignments for one charged sync failure: stamp the
 * failed outcome, increment `consecutive_failures`, open the failure episode,
 * back `next_run_at` off beyond the supplied scheduling baseline (NULL keeps a
 * manual feed unscheduled), and hard-pause once the threshold is crossed.
 *
 * Exponential backoff on top of the cron cadence so a persistently-failing
 * feed retries progressively less often instead of re-enqueueing every plain
 * cadence. Computed from the NEW count directly in SQL so it stays correct
 * under concurrent completions across replicas. Once the NEW count crosses
 * the pause threshold the feed is paused and next_run_at nulled.
 */
export function feedSyncFailureAssignments<TFragment>(
  sql: SqlTag<TFragment>,
  params: { errorMessage: string | null; nextRun: TFragment }
): TFragment {
  const pauseThreshold = feedBackoff.pauseThreshold;
  return sql`
    last_sync_at = current_timestamp,
    last_sync_status = 'failed',
    last_error = ${params.errorMessage},
    consecutive_failures = consecutive_failures + 1,
    first_failure_at = COALESCE(first_failure_at, current_timestamp),
    status = CASE WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN 'paused' ELSE status END,
    next_run_at = CASE
          WHEN consecutive_failures + 1 >= ${pauseThreshold} THEN NULL
          WHEN (${params.nextRun})::timestamptz IS NULL THEN NULL
          ELSE GREATEST(
            (${params.nextRun})::timestamptz,
            current_timestamp + (LEAST(
              ${feedBackoff.baseMs}::bigint * (2 ^ LEAST(consecutive_failures, 30))::bigint,
              ${feedBackoff.maxMs}::bigint
            ) || ' milliseconds')::interval
          )
        END,
    updated_at = current_timestamp
  `;
}

/** What a recorded failure left behind, for {@link announceFeedAutoPause}. */
export interface RecordedFeedSyncFailure {
  feedId: number;
  runId: number;
  consecutiveFailures: number;
}

/**
 * Charge one failed sync to its feed ({@link feedSyncFailureAssignments}),
 * backing off from the feed's next cron slot.
 *
 * Runs on the caller's handle. A completion caller passes the transaction that
 * owns the run's terminal transition, so a crash cannot leave only one half of
 * that state committed. Announce the pause with {@link announceFeedAutoPause}
 * after the caller's transaction commits.
 */
export async function applyFeedSyncFailure(
  sql: DbClient,
  params: {
    feedId: number;
    errorMessage: string | null;
    runId: number;
  }
): Promise<RecordedFeedSyncFailure | null> {
  const feedRows = (await sql`
    SELECT schedule, timezone FROM feeds WHERE id = ${params.feedId}
  `) as unknown as Array<{ schedule: string | null; timezone: string | null }>;
  if (feedRows.length === 0) return null;

  // Manual feeds (no schedule) stay unscheduled after failure.
  const schedule = feedRows[0]?.schedule ?? null;
  const nextRun = schedule
    ? nextRunAtFromCron(schedule, new Date(), feedRows[0]?.timezone ?? null)
    : null;

  const updated = (await sql`
    UPDATE feeds
    SET ${feedSyncFailureAssignments(sql, {
      errorMessage: params.errorMessage,
      nextRun: sql`${nextRun}`,
    })}
    WHERE id = ${params.feedId}
    RETURNING consecutive_failures
  `) as unknown as Array<{ consecutive_failures: number }>;

  return {
    feedId: params.feedId,
    runId: params.runId,
    consecutiveFailures: Number(updated[0]?.consecutive_failures ?? 0),
  };
}

/**
 * Emit `feed.auto_paused` when a recorded failure crossed the pause threshold.
 * Best-effort, after the failure committed: the feed is already paused, and a
 * lost announcement must never undo that.
 */
export async function announceFeedAutoPause(
  recorded: RecordedFeedSyncFailure | null
): Promise<void> {
  if (!recorded) return;
  // delivery_id is stable per failure episode (first_failure_at), so retries
  // after a failed activation are idempotent and do not double-queue
  // Automations.
  try {
    await maybeEmitFeedAutoPausedAfterFailure({
      feedId: recorded.feedId,
      consecutiveFailures: recorded.consecutiveFailures,
      pauseThreshold: feedBackoff.pauseThreshold,
      runId: recorded.runId,
    });
  } catch (err) {
    // The feed is already paused; log hard so we notice a lost activation, but
    // never fail the caller — its run is already terminal.
    logger.error(
      { feed_id: recorded.feedId, error: errorMessage(err) },
      '[announceFeedAutoPause] maybeEmitFeedAutoPausedAfterFailure threw'
    );
  }
}
