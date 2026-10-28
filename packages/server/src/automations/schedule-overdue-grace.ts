import type { AutomationTrigger } from "../types/automations";
import { nextRunAt } from "../utils/cron";

/** Never treat a schedule as stalled less than this far past its due time. */
export const MIN_SCHEDULE_OVERDUE_MS = 60 * 60 * 1000;
/** A long cadence is still reported within this much of a missed run. */
export const MAX_SCHEDULE_OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How far past `next_run_at` a schedule may sit before it counts as stalled:
 * one whole missed interval, clamped to [1h, 6h]. A 20-minute digest is
 * reported after an hour (three windows); a daily job within six hours of
 * its miss. The overdue notification sweep and the health chip both derive
 * the threshold here so the chip turns degraded exactly when admins are told.
 * Returns null for an unparseable schedule, which the scheduler parks instead.
 */
export function scheduleOverdueGraceMs(input: {
	schedule: string;
	timezone: string | null | undefined;
	nextRunAt: Date | string | number;
}): number | null {
	const dueMs = new Date(input.nextRunAt).getTime();
	let intervalMs: number;
	try {
		intervalMs =
			new Date(nextRunAt(input.schedule, new Date(dueMs), input.timezone)).getTime() - dueMs;
	} catch {
		return null;
	}
	return Math.min(MAX_SCHEDULE_OVERDUE_GRACE_MS, Math.max(MIN_SCHEDULE_OVERDUE_MS, intervalMs));
}

/** The persisted schedule trigger, which carries the cron and timezone. */
export function scheduleTriggerOf(
	triggers: readonly AutomationTrigger[] | null | undefined,
): Extract<AutomationTrigger, { kind: "schedule" }> | undefined {
	return triggers?.find(
		(trigger): trigger is Extract<AutomationTrigger, { kind: "schedule" }> =>
			trigger.kind === "schedule",
	);
}
