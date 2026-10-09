/**
 * Scheduler Health Check
 *
 * Provides metrics and health status for the feed/run scheduling system.
 * Used for monitoring and alerting when the scheduler stops working.
 */

import { intervals } from '../config/intervals';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../utils/device-liveness';
import {
  delegatedBrowserAffinitySql,
  selectedConnectorVersionArtifactSql,
} from '../utils/connector-execution-placement';
import logger from '../utils/logger';
import { EXECUTING_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

interface SchedulerHealthStatus {
  healthy: boolean;
  issues: string[];
  metrics: {
    activeFeeds: number;
    overdueFeeds: number;
    overdueByHours: number;
    pendingRuns: number;
    runningRuns: number;
    lastRunCreatedAt: string | null;
    lastSuccessfulRun: string | null;
    runsLast24h: {
      success: number;
      failed: number;
      timeout: number;
    };
    /** Automation (automation-lane) scheduling health — item 3.2, #2033. */
    activeAutomations: number;
    overdueAutomations: number;
    automationsOverdueByHours: number;
    stalePendingAutomationRuns: number;
    deferredDeviceAutomations: number;
    oldestDeviceDeferralHours: number;
    /** Approvals still undecided past PENDING_APPROVAL_TTL_DAYS. */
    stalePendingApprovals: number;
    /** Age of the oldest undecided approval, in days. */
    oldestPendingApprovalDays: number;
  };
}

const OVERDUE_THRESHOLD_HOURS = 1; // Alert if feeds are overdue by more than 1 hour
const EXECUTION_GAP_THRESHOLD_HOURS = 2; // Alert if no runs are created in 2 hours
// Automations are dispatched by reconcileAutomationRuns on a 5-minute cron, so an
// active automation can sit up to one cron period past next_run_at between ticks.
// Alert only once it is overdue by more than an hour — matches the feed
// threshold and avoids flapping on normal tick jitter.
const AUTOMATION_OVERDUE_THRESHOLD_HOURS = 1;
// Cadence of the pending-approval expiry sweep (`expire-pending-approvals` is
// registered on a daily cron in scheduled/jobs.ts). Used as the grace window on
// top of the TTL before a stale approval counts as a fault rather than drift.
const EXPIRY_SWEEP_INTERVAL_DAYS = 1;

export async function getSchedulerHealth(_env: Env): Promise<SchedulerHealthStatus> {
  const sql = getDb();
  const issues: string[] = [];

  try {
    // Get feed counts.
    //
    // Device-owned feeds are held back on purpose (check-due-feeds.ts) until a
    // claim-capable device actually polls. That includes an offline execution
    // pin and an unpinned connector with a required device capability. Counting
    // either as scheduler lag would put this endpoint in a permanent 503 for
    // the ordinary case of a closed laptop — the same "train operators to
    // ignore it" failure the approval-TTL grace below avoids.
    //
    // This drops no signal: a pinned device that has gone silent is already an
    // operator-facing alert on its own hours-scale threshold (`device_stale` in
    // connectors/connector-health.ts). "Is the scheduler firing" and "is that
    // laptop on" are different questions, answered on different surfaces.
    //
    // Browser affinity stays a fleet lane: a chrome-extension pin on a
    // connector that does not execute natively in the extension is genuinely
    // overdue. A fresh execution pin also remains overdue here until its
    // 2-minute liveness proxy ages out, making a sustained stopped poll loop
    // visible without charging source health.
    const feedStats = await sql`
      WITH scheduling AS (
        SELECT
          f.status,
          f.next_run_at,
          (
            (
              c.device_worker_id IS NOT NULL
              AND dw.last_seen_at <= current_timestamp
                - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
              AND NOT COALESCE(
                ${delegatedBrowserAffinitySql(sql, {
                  platform: sql`dw.platform`,
                  connectorKey: sql`c.connector_key`,
                })},
                false
              )
            )
            OR (
              c.device_worker_id IS NULL
              AND (
                cd.run_required_capability IS NOT NULL
                OR COALESCE(run_cv.manifest_backed, false)
              )
            )
          ) AS device_deferred
        FROM feeds f
        LEFT JOIN connections c ON c.id = f.connection_id
        LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
        LEFT JOIN LATERAL (
          SELECT
            definitions.version,
            CASE
              WHEN f.pinned_version IS NULL OR definitions.version = f.pinned_version
                THEN definitions.required_capability
              ELSE NULL
            END AS run_required_capability,
            CASE
              WHEN f.pinned_version IS NULL OR definitions.version = f.pinned_version
                THEN definitions.runtime
              ELSE NULL
            END AS run_runtime
          FROM connector_definitions definitions
          WHERE definitions.key = c.connector_key
            AND definitions.organization_id = f.organization_id
            AND definitions.status = 'active'
          ORDER BY definitions.updated_at DESC, definitions.id DESC
          LIMIT 1
        ) cd ON true
        LEFT JOIN LATERAL (
          ${selectedConnectorVersionArtifactSql(sql, {
            connectorKey: sql`c.connector_key`,
            version: sql`COALESCE(f.pinned_version, cd.version)`,
            organizationId: sql`f.organization_id`,
          })}
        ) run_cv ON true
        WHERE f.deleted_at IS NULL
      )
      SELECT
        CAST(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS INTEGER) as active_feeds,
        CAST(SUM(CASE
          WHEN status = 'active' AND next_run_at < current_timestamp AND NOT device_deferred
            THEN 1 ELSE 0
        END) AS INTEGER) as overdue_feeds,
        MAX(CASE
          WHEN status = 'active' AND next_run_at < current_timestamp AND NOT device_deferred
            THEN EXTRACT(EPOCH FROM (current_timestamp - next_run_at)) / 3600.0
          ELSE NULL
        END) as max_overdue_hours
      FROM scheduling
    `;

    const activeFeeds = Number(feedStats[0]?.active_feeds || 0);
    const overdueFeeds = Number(feedStats[0]?.overdue_feeds || 0);
    const overdueByHours = Number(feedStats[0]?.max_overdue_hours || 0);

    // Get run counts
    const runStats = await sql`
      SELECT
        CAST(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS INTEGER) as pending,
        CAST(SUM(CASE WHEN status = ANY(${runStatusLiteral(EXECUTING_RUN_STATUSES)}::text[]) THEN 1 ELSE 0 END) AS INTEGER) as running,
        MAX(CASE WHEN status = 'pending' THEN created_at ELSE NULL END) as last_pending_created,
        MAX(CASE WHEN status = 'completed' THEN completed_at ELSE NULL END) as last_success
      FROM runs
      WHERE run_type = 'sync'
    `;

    const pendingRuns = Number(runStats[0]?.pending || 0);
    const runningRuns = Number(runStats[0]?.running || 0);
    const lastPendingRaw = runStats[0]?.last_pending_created;
    const lastSuccessRaw = runStats[0]?.last_success;
    const lastRunCreatedAt = lastPendingRaw ? String(lastPendingRaw) : null;
    const lastSuccessfulRun = lastSuccessRaw ? String(lastSuccessRaw) : null;

    // Get run counts for last 24 hours
    const recentStats = await sql`
      SELECT
        CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS INTEGER) as success,
        CAST(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS INTEGER) as failed,
        CAST(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS INTEGER) as timeout
      FROM runs
      WHERE run_type = 'sync'
        AND completed_at > current_timestamp - INTERVAL '24 hours'
    `;

    const runsLast24h = {
      success: Number(recentStats[0]?.success || 0),
      failed: Number(recentStats[0]?.failed || 0),
      timeout: Number(recentStats[0]?.timeout || 0),
    };

    // Automation-lane scheduling health (item 3.2, #2033). Previously this
    // health check filtered run_type='sync' ONLY, so automations (the automation
    // lane) were invisible to the overdue/alarm path even though they share the
    // same "scheduler stopped firing" failure mode. Surface overdue active
    // automations (by automations.next_run_at) and pending automation runs stuck past
    // the stale interval, feeding the SAME issues[] the feed path uses.
    const automationStats = await sql`
      WITH scheduling AS (
        SELECT a.status, a.schedule, a.next_run_at,
          a.device_worker_id IS NOT NULL AND NOT (
            d.id IS NOT NULL
            AND d.last_seen_at > current_timestamp
              - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})
            AND COALESCE(d.platform = 'macos' OR d.capabilities ? 'automations.execute', false)
            AND (
              d.agent_kinds IS NULL
              OR CASE WHEN NULLIF(a.agent_kind, '') IS NULL
                THEN cardinality(d.agent_kinds) > 0
                ELSE a.agent_kind = ANY(d.agent_kinds)
              END
            )
          ) AS device_deferred
        FROM automations a
        LEFT JOIN device_workers d ON d.id = a.device_worker_id
        WHERE a.execution_config->'executor'->>'kind' IS DISTINCT FROM 'external'
      )
      SELECT
        CAST(COUNT(*) FILTER (WHERE status = 'active' AND schedule IS NOT NULL) AS INTEGER)
          AS active_automations,
        CAST(COUNT(*) FILTER (
          WHERE status = 'active' AND schedule IS NOT NULL
            AND next_run_at < current_timestamp AND NOT device_deferred
        ) AS INTEGER) AS overdue_automations,
        MAX(CASE WHEN status = 'active' AND schedule IS NOT NULL
          AND next_run_at < current_timestamp AND NOT device_deferred
          THEN EXTRACT(EPOCH FROM (current_timestamp - next_run_at)) / 3600.0
        END) AS max_overdue_hours,
        CAST(COUNT(*) FILTER (WHERE status = 'active' AND schedule IS NOT NULL
          AND next_run_at < current_timestamp AND device_deferred
        ) AS INTEGER) AS deferred_device_automations,
        MAX(CASE WHEN status = 'active' AND schedule IS NOT NULL
          AND next_run_at < current_timestamp AND device_deferred
          THEN EXTRACT(EPOCH FROM (current_timestamp - next_run_at)) / 3600.0
        END) AS max_device_deferral_hours
      FROM scheduling
    `;

    const activeAutomations = Number(automationStats[0]?.active_automations || 0);
    const overdueAutomations = Number(automationStats[0]?.overdue_automations || 0);
    const automationsOverdueByHours = Number(automationStats[0]?.max_overdue_hours || 0);
    const deferredDeviceAutomations = Number(
      automationStats[0]?.deferred_device_automations || 0
    );
    const oldestDeviceDeferralHours = Number(
      automationStats[0]?.max_device_deferral_hours || 0
    );

    // Pending automation runs stuck past AUTOMATION_RUN_STALE_INTERVAL — the reaper
    // should have timed these out; a growing count means the reaper/dispatch is
    // wedged.
    const staleAutomationRunStats = await sql.unsafe(
      `
      SELECT CAST(COUNT(*) AS INTEGER) AS stale_pending
      FROM runs
      WHERE run_type = 'automation'
        AND status = 'pending'
        AND created_at < current_timestamp - INTERVAL '${intervals.automationRunStaleInterval}'
        AND NOT (
          COALESCE(approved_input->>'dispatch_source', 'scheduled') = 'scheduled'
          AND NULLIF(approved_input->>'device_worker_id', '') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM device_workers dw
            WHERE dw.id::text = approved_input->>'device_worker_id'
          )
        )
    `
    );
    const stalePendingAutomationRuns = Number(
      (staleAutomationRunStats as unknown as Array<{ stale_pending: number }>)[0]
        ?.stale_pending || 0
    );

    // Undecided approvals past the long-horizon TTL — the expire-pending-
    // approvals sweep (scheduled/expire-pending-approvals.ts) should have taken
    // these terminal. The COUNT is always reported: it is the operator's view of
    // the backlog, which the original gap let grow forever unseen (the
    // short-horizon reaper exempts these rows on purpose, #2044, and nothing
    // else resolved them). The health ISSUE is raised only past the sweep grace
    // below, since a non-zero count between daily ticks is expected drift.
    const stalePendingApprovalStats = await sql`
      SELECT
        CAST(COUNT(*) AS INTEGER) AS stale_pending,
        MAX(EXTRACT(EPOCH FROM (current_timestamp - created_at)) / 86400.0)
          AS oldest_days
      FROM runs
      WHERE approval_status = 'pending'
        AND run_type IN ('action', 'internal')
        AND created_at
            < current_timestamp - (${intervals.pendingApprovalTtlDays}::int * interval '1 day')
    `;
    // One full sweep interval of slack on top of the TTL. The expiry job is
    // registered on a daily cron (scheduled/jobs.ts), so anything younger than
    // this is drift the next tick will clear, not a fault.
    const staleApprovalAlarmAfterDays =
      intervals.pendingApprovalTtlDays + EXPIRY_SWEEP_INTERVAL_DAYS;
    const stalePendingApprovals = Number(
      stalePendingApprovalStats[0]?.stale_pending || 0
    );
    const oldestPendingApprovalDays = Number(
      stalePendingApprovalStats[0]?.oldest_days || 0
    );

    // Check for issues
    if (overdueByHours > OVERDUE_THRESHOLD_HOURS) {
      issues.push(`${overdueFeeds} feeds overdue by up to ${overdueByHours.toFixed(1)} hours`);
    }

    if (lastRunCreatedAt) {
      const hoursSinceLastRun =
        (Date.now() - new Date(lastRunCreatedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastRun > EXECUTION_GAP_THRESHOLD_HOURS && overdueFeeds > 0) {
        issues.push(
          `No new runs created in ${hoursSinceLastRun.toFixed(1)} hours despite ${overdueFeeds} overdue feeds`
        );
      }
    } else if (overdueFeeds > 0) {
      issues.push(`No pending runs exist despite ${overdueFeeds} overdue feeds`);
    }

    if (runsLast24h.timeout > runsLast24h.success) {
      issues.push(
        `More timeouts (${runsLast24h.timeout}) than successes (${runsLast24h.success}) in last 24h`
      );
    }

    if (automationsOverdueByHours > AUTOMATION_OVERDUE_THRESHOLD_HOURS) {
      issues.push(
        `${overdueAutomations} automations overdue by up to ${automationsOverdueByHours.toFixed(1)} hours`
      );
    }

    if (stalePendingAutomationRuns > 0) {
      issues.push(
        `${stalePendingAutomationRuns} automation runs stuck pending past the stale interval`
      );
    }

    // Alarm only once a full sweep opportunity has been MISSED, not merely
    // because a row crossed the TTL. The expiry sweep runs daily, so an approval
    // that ages past the TTL just after a tick sits stale for up to a day by
    // design; alarming on that would put /health/scheduler in 503 during normal
    // operation and train operators to ignore it. Past TTL + one sweep interval,
    // a row that is still pending means the sweep did not do its job.
    if (oldestPendingApprovalDays > staleApprovalAlarmAfterDays) {
      issues.push(
        `${stalePendingApprovals} approvals undecided past the ${intervals.pendingApprovalTtlDays}-day TTL with the oldest at ${oldestPendingApprovalDays.toFixed(1)} days — past the ${staleApprovalAlarmAfterDays}-day sweep grace, so the expiry sweep looks wedged`
      );
    }

    const healthy = issues.length === 0;

    if (!healthy) {
      logger.warn({ issues }, '[SchedulerHealth] Health check failed');
    }

    return {
      healthy,
      issues,
      metrics: {
        activeFeeds,
        overdueFeeds,
        overdueByHours: Math.round(overdueByHours * 10) / 10,
        pendingRuns,
        runningRuns,
        lastRunCreatedAt,
        lastSuccessfulRun,
        runsLast24h,
        activeAutomations,
        overdueAutomations,
        automationsOverdueByHours: Math.round(automationsOverdueByHours * 10) / 10,
        stalePendingAutomationRuns,
        deferredDeviceAutomations,
        oldestDeviceDeferralHours: Math.round(oldestDeviceDeferralHours * 10) / 10,
        stalePendingApprovals,
        oldestPendingApprovalDays: Math.round(oldestPendingApprovalDays * 10) / 10,
      },
    };
  } catch (error) {
    logger.error({ error }, '[SchedulerHealth] Failed to get health status');
    return {
      healthy: false,
      issues: [`Failed to query scheduler health: ${(error as Error).message}`],
      metrics: {
        activeFeeds: 0,
        overdueFeeds: 0,
        overdueByHours: 0,
        pendingRuns: 0,
        runningRuns: 0,
        lastRunCreatedAt: null,
        lastSuccessfulRun: null,
        runsLast24h: { success: 0, failed: 0, timeout: 0 },
        activeAutomations: 0,
        overdueAutomations: 0,
        automationsOverdueByHours: 0,
        stalePendingAutomationRuns: 0,
        deferredDeviceAutomations: 0,
        oldestDeviceDeferralHours: 0,
        stalePendingApprovals: 0,
        oldestPendingApprovalDays: 0,
      },
    };
  }
}
