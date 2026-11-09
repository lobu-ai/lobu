import { getDb } from "../db/client";
import { emit } from "../events/emitter";
import { createNotificationForUsers } from "../notifications/service";
import logger from "../utils/logger";
import { buildAutomationUrl } from "../utils/url-builder";

interface PausedAutomationNotificationRow {
	id: number;
	name: string | null;
	organization_id: string;
	organization_slug: string;
	consecutive_scheduled_failures: number;
	schedule_auto_paused_at: Date | string;
	admin_user_ids: string[];
	latest_error: string | null;
}

/** Characters of the latest run error quoted in the notification body. */
const LATEST_ERROR_MAX_CHARS = 300;

/**
 * Quote the latest failed run's error so the admin sees why the schedule
 * paused (for example the provider's quota message) without opening the run.
 * The query fetches one character past the bound so truncation is detectable.
 */
function latestErrorSentence(error: string | null): string {
	if (!error) return "";
	const chars = Array.from(error);
	const quoted =
		chars.length > LATEST_ERROR_MAX_CHARS
			? `${chars.slice(0, LATEST_ERROR_MAX_CHARS).join("").trimEnd()}…`
			: error;
	return ` Latest error: ${quoted}`;
}

export function automationAutoPauseNotificationKey(
	automationId: number,
	pausedAt: Date | string,
): string {
	return `automation:schedule-auto-paused:${automationId}:${new Date(pausedAt).getTime()}`;
}

/**
 * Deliver durable admin notifications for newly auto-paused Automations.
 *
 * The notification event is the completion marker. A failed insert remains
 * absent and is retried next tick; concurrent ticks collapse on the existing
 * events idempotency index. Rows without an admin/owner are excluded from the
 * bounded window so they cannot starve later, deliverable pauses.
 *
 * The latest failed run is looked up per selected Automation, after the window
 * is bounded: `idx_runs_automation_id` narrows it to that Automation's own runs,
 * and only Automations not yet notified for this pause are selected.
 */
export async function runAutomationAutoPauseNotificationSweep(
	opts: { limit?: number } = {},
): Promise<{
	scanned: number;
	attempted: number;
	created: number;
	errors: number;
}> {
	const sql = getDb();
	const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
	const rows = await sql<PausedAutomationNotificationRow>`
    WITH paused AS (
      SELECT
        a.id,
        a.name,
        a.organization_id,
        o.slug AS organization_slug,
        a.consecutive_scheduled_failures,
        a.schedule_auto_paused_at,
        to_jsonb(array_agg(DISTINCT m."userId" ORDER BY m."userId")) AS admin_user_ids
      FROM automations a
      JOIN "organization" o ON o.id = a.organization_id
      JOIN "member" m
        ON m."organizationId" = a.organization_id
       AND m.role IN ('admin', 'owner')
      WHERE a.schedule_auto_paused_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM events e
          WHERE e.organization_id = a.organization_id
            AND e.metadata ? '_lobu_idempotency_key'
            AND e.metadata->>'_lobu_idempotency_key' =
              'automation:schedule-auto-paused:' || a.id::text || ':' ||
              floor(extract(epoch FROM a.schedule_auto_paused_at) * 1000)::bigint::text
        )
      GROUP BY a.id, a.name, a.organization_id, o.slug,
               a.consecutive_scheduled_failures, a.schedule_auto_paused_at
      ORDER BY a.schedule_auto_paused_at ASC, a.id ASC
      LIMIT ${limit}
    )
    SELECT p.*, latest_failure.error AS latest_error
    FROM paused p
    LEFT JOIN LATERAL (
      SELECT left(btrim(r.error_message), ${LATEST_ERROR_MAX_CHARS + 1}) AS error
      FROM runs r
      WHERE r.automation_id = p.id
        AND r.run_type = 'automation'
        AND r.status IN ('failed', 'timeout')
      ORDER BY r.completed_at DESC NULLS LAST, r.id DESC
      LIMIT 1
    ) latest_failure ON true
    ORDER BY p.schedule_auto_paused_at ASC, p.id ASC
  `;

	let attempted = 0;
	let created = 0;
	let errors = 0;
	for (const row of rows) {
		attempted++;
		try {
			const result = await createNotificationForUsers(row.admin_user_ids, {
				organizationId: row.organization_id,
				type: "generic",
				title: `Automation "${row.name ?? row.id}" was auto-paused`,
				body:
					`Lobu paused this schedule after ${row.consecutive_scheduled_failures} ` +
					"consecutive execution failures. Review the latest run, then complete " +
					"a successful manual run or change the cadence to resume it." +
					latestErrorSentence(row.latest_error),
				resourceType: "automation",
				resourceId: String(row.id),
				resourceUrl: buildAutomationUrl(row.organization_slug, row.id),
				idempotencyKey: automationAutoPauseNotificationKey(
					row.id,
					row.schedule_auto_paused_at,
				),
			});
			if (result.created) created++;
			emit(row.organization_id, {
				keys: ["notifications", "notifications-unread-count"],
			});
		} catch (error) {
			errors++;
			logger.warn(
				{ error, automationId: row.id },
				"[automations] Failed to deliver schedule auto-pause notification",
			);
		}
	}

	return { scanned: rows.length, attempted, created, errors };
}
