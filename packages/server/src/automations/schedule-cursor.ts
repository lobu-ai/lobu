import type { DbClient } from "../db/client";
import { nextRunAt } from "../utils/cron";
import logger from "../utils/logger";
import { resetScheduledFailureState } from "./scheduled-failure-policy";

/**
 * Move an automation's `next_run_at` forward to its next cron tick.
 *
 * The target is `nextRunAt(schedule, now)`. The write never moves an existing
 * cursor backward, so overlapping completions cannot pull it to an earlier tick.
 * (Basing it on `max(now, next_run_at)` instead compounded the schedule: each
 * manual trigger's completion pushed an already-future `next_run_at` one more
 * tick out, so N manual runs silently skipped N cron slots.)
 *
 * Pass either the singleton `sql` client or a transaction handle from
 * `sql.begin(...)` to advance inside the caller's transaction. Schedule-less
 * automations (manual-only) are no-ops.
 * Returns the next cron tick, when schedulable, so backlog completion can tell
 * that cadence apart from a cursor that is already later.
 *
 * Errors are split by whether a retry could ever succeed, because the callers
 * are terminal state transitions inside a transaction:
 *
 * - **Database errors propagate.** They are transient, so the caller SHOULD roll
 *   back its run-failure/completion and let the next tick retry.
 * - **An unparseable cron/timezone does NOT propagate.** It is permanent, so
 *   throwing would roll the caller back forever. Worse, `dispatchAutomationRun`
 *   calls `failAutomationRun` from inside its own `catch`, and
 *   `dispatchPendingAutomationRuns` has no per-run guard — a throw there escapes
 *   both and aborts the dispatch tick for EVERY org, permanently, since the
 *   rolled-back run is re-claimed next tick. Park the Automation instead: NULL
 *   drops out of the `next_run_at <= now()` due predicate, so it stops
 *   re-selecting until someone fixes the schedule.
 */
export async function advanceAutomationSchedule(
	sql: DbClient,
	automationId: number | null | undefined
): Promise<string | undefined> {
	if (automationId == null) return;
	const rows = await sql`
    SELECT schedule, timezone, schedule_auto_paused_at
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
	const schedule = (rows[0]?.schedule as string | null) ?? null;
	const timezone = (rows[0]?.timezone as string | null) ?? null;
	const autoPausedAt = rows[0]?.schedule_auto_paused_at ?? null;
	if (autoPausedAt != null) return;
	if (!schedule) return;

	// `nextRunAt` returns an ISO string, not a Date.
	let nextTick: string;
	try {
		nextTick = nextRunAt(schedule, new Date(), timezone);
	} catch (error) {
		logger.error(
			{ error, automationId, schedule, timezone },
			"[automations] Automation schedule is unparseable — parking it (next_run_at = NULL). " +
				"It will not run again until the schedule or timezone is corrected."
		);
		await sql`
      UPDATE automations
      SET next_run_at = NULL,
          updated_at = NOW()
      WHERE id = ${automationId}
        AND schedule_auto_paused_at IS NULL
    `;
		return;
	}

	await sql`
    UPDATE automations
    SET next_run_at = GREATEST(next_run_at, ${nextTick}::timestamptz),
        updated_at = NOW()
    WHERE id = ${automationId}
      AND schedule_auto_paused_at IS NULL
  `;
	return nextTick;
}

/**
 * Clear the failure streak and advance the cron cursor. Return the next tick so
 * a truncated script window can resume without pulling a later cursor back.
 */
export async function advanceAutomationScheduleAfterSuccessfulWindow(
	sql: DbClient,
	automationId: number
): Promise<string | undefined> {
	await resetScheduledFailureState(sql, automationId);
	return advanceAutomationSchedule(sql, automationId);
}

/**
 * Advance after terminal failure unless the run came from an event. Event
 * delivery is independent of the cron cursor, so a failed event run never moves
 * it. A provider quota failure is an ordinary failure here: the cursor moves to
 * the next tick and the scheduled-failure breaker decides when to pause.
 * Call inside the caller's terminal-state transaction. Every run-backed failure
 * path shares this policy so the event carve-out cannot drift.
 */
export async function advanceScheduleAfterTerminalFailure(
	sql: DbClient,
	automationId: number | null | undefined,
	dispatchSource: string | null | undefined
): Promise<void> {
	if (dispatchSource === "event") return;
	await advanceAutomationSchedule(sql, automationId);
}
