import { getDb } from "../db/client";
import { emit } from "../events/emitter";
import { createNotificationForUsers } from "../notifications/service";
import logger from "../utils/logger";
import { buildAutomationUrl } from "../utils/url-builder";
import { MIN_SCHEDULE_OVERDUE_MS, scheduleOverdueGraceMs } from "./schedule-overdue-grace";

interface OverdueAutomationRow {
	id: number;
	name: string | null;
	organization_id: string;
	organization_slug: string;
	schedule: string;
	timezone: string | null;
	next_run_at: Date | string;
	external: boolean;
	admin_user_ids: string[];
}

export function automationScheduleOverdueNotificationKey(
	automationId: number,
	nextRunAt: Date | string,
): string {
	return `automation:schedule-overdue:${automationId}:${new Date(nextRunAt).getTime()}`;
}

/**
 * Tell an org's admins when an active schedule stopped running.
 *
 * The case nothing else reports: an external-executor schedule no client
 * claims, or a schedule the dispatcher never materializes. No run fails, so
 * the failure counter and auto-pause never move; only `next_run_at` sits in
 * the past. `computeAutomationHealth` keeps an unclaimed external
 * window healthy for the same grace, because a client may be a few minutes
 * away; past it the chip degrades and this sweep tells the admins.
 *
 * The cursor is the episode: it does not move while nothing runs, so the
 * notification keyed on it fires once, and the next stall (a new cursor) is a
 * new notice. Concurrent ticks collapse on the events idempotency index. A
 * run in flight holds the cursor back legitimately (a window advances the
 * schedule when it completes) and is not reported; timing out a stuck run is
 * the reaper's job, after which an unmoved cursor is reported here.
 */
export async function runAutomationScheduleOverdueNotificationSweep(
	opts: { limit?: number; now?: number } = {},
): Promise<{ scanned: number; notified: number; errors: number }> {
	const sql = getDb();
	const now = opts.now ?? Date.now();
	const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
	const rows = await sql<OverdueAutomationRow>`
    SELECT
      a.id,
      a.name,
      a.organization_id,
      o.slug AS organization_slug,
      a.schedule,
      a.timezone,
      a.next_run_at,
      a.execution_config->'executor'->>'kind' IS NOT DISTINCT FROM 'external' AS external,
      to_jsonb(array_agg(DISTINCT m."userId" ORDER BY m."userId")) AS admin_user_ids
    FROM automations a
    JOIN "organization" o ON o.id = a.organization_id
    JOIN "member" m
      ON m."organizationId" = a.organization_id
     AND m.role IN ('admin', 'owner')
    WHERE a.status = 'active'
      AND a.schedule IS NOT NULL
      AND a.schedule_auto_paused_at IS NULL
      AND a.next_run_at < ${new Date(now - MIN_SCHEDULE_OVERDUE_MS)}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.automation_id = a.id
          AND r.run_type = 'automation'
          AND r.status IN ('pending', 'claimed', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM events e
        WHERE e.organization_id = a.organization_id
          AND e.metadata ? '_lobu_idempotency_key'
          AND e.metadata->>'_lobu_idempotency_key' =
            'automation:schedule-overdue:' || a.id::text || ':' ||
            floor(extract(epoch FROM a.next_run_at) * 1000)::bigint::text
      )
    GROUP BY a.id, a.name, a.organization_id, o.slug, a.schedule, a.timezone,
             a.next_run_at, a.execution_config
    ORDER BY a.next_run_at ASC, a.id ASC
  `;

	let attempted = 0;
	let notified = 0;
	let errors = 0;
	for (const row of rows) {
		const graceMs = scheduleOverdueGraceMs({
			schedule: row.schedule,
			timezone: row.timezone,
			nextRunAt: row.next_run_at,
		});
		if (graceMs === null) continue;
		const overdueMs = now - new Date(row.next_run_at).getTime();
		if (overdueMs < graceMs) continue;
		// Bound delivery attempts after cron eligibility: an earlier daily schedule
		// still in grace (or an invalid cron) must not hide a later overdue one.
		if (attempted >= limit) break;
		attempted++;

		const hours = Math.max(1, Math.round(overdueMs / (60 * 60 * 1000)));
		const body = row.external
			? `This schedule was due ${hours}h ago and no external client has claimed it. ` +
				"Check that the client processing this Automation is running and polling for due work."
			: `This schedule was due ${hours}h ago and has not run. ` +
				"Open the Automation to check its latest run and executor.";
		try {
			const result = await createNotificationForUsers(row.admin_user_ids, {
				organizationId: row.organization_id,
				type: "generic",
				title: `Automation "${row.name ?? row.id}" has not run`,
				body,
				resourceType: "automation",
				resourceId: String(row.id),
				resourceUrl: buildAutomationUrl(row.organization_slug, row.id),
				idempotencyKey: automationScheduleOverdueNotificationKey(
					row.id,
					row.next_run_at,
				),
			});
			if (result.created) notified++;
			emit(row.organization_id, {
				keys: ["notifications", "notifications-unread-count"],
			});
		} catch (error) {
			errors++;
			logger.warn(
				{ error, automationId: row.id },
				"[automations] Failed to deliver schedule overdue notification",
			);
		}
	}

	return { scanned: rows.length, notified, errors };
}
