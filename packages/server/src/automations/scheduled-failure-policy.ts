import type { DbClient } from "../db/client";
import { insertConfigChangeEventInTransaction } from "../utils/insert-event";

const DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES = 5;

function scheduledFailurePauseThreshold(): number {
	const raw = process.env.AUTOMATION_PAUSE_AFTER_CONSECUTIVE_FAILURES;
	if (raw === undefined) return DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_PAUSE_AFTER_CONSECUTIVE_FAILURES;
}

function isScheduledDispatch(
	dispatchSource: string | null | undefined,
): boolean {
	// Older scheduled runs predate the explicit dispatch_source stamp. Manual
	// and event runs have always carried their source when they need different
	// cursor semantics, so NULL remains the backwards-compatible schedule lane.
	return dispatchSource == null || dispatchSource === "scheduled";
}

/**
 * Count one terminal failure from a real, executed scheduled Automation run.
 *
 * The UPDATE is the counter lock: concurrent distinct failures serialize on
 * the Automation row, while a duplicate terminal report never reaches this
 * helper because every caller first wins a status-guarded run transition.
 * Once the threshold winner stamps the pause, later in-flight failures leave
 * both the stable count and pause timestamp untouched.
 *
 * Atomicity: production callers pass their terminal-state tx, so the
 * preimage SELECT (FOR UPDATE), the guarded UPDATE, and the config audit
 * share the caller's commit. A bare pool handle (tests, standalone callers)
 * gets its own `begin`; the `savepoint` probe distinguishes the two without
 * ever nesting a transaction.
 */
export async function recordScheduledExecutionFailure(
	sql: DbClient,
	automationId: number | null | undefined,
	dispatchSource: string | null | undefined,
): Promise<void> {
	if (automationId == null || !isScheduledDispatch(dispatchSource)) {
		return;
	}

	const inTransactionProbe = (sql as unknown as { savepoint?: unknown }).savepoint;
	// postgres.js only exposes `savepoint` on a tx handle; the pool handle
	// has no such property (see utils/insert-event.ts). Probe it to avoid a
	// nested begin when the caller already holds the transaction.
	const isTxHandle = typeof inTransactionProbe === 'function';
	if (isTxHandle) {
		await recordFailureInTransaction(sql, automationId);
		return;
	}
	await sql.begin(async (tx) => {
		await recordFailureInTransaction(tx, automationId);
	});
}

async function recordFailureInTransaction(
	sql: DbClient,
	automationId: number,
): Promise<void> {
	const threshold = scheduledFailurePauseThreshold();
	const beforeRows = await sql`
    SELECT id, organization_id, consecutive_scheduled_failures, schedule_auto_paused_at, next_run_at
    FROM automations WHERE id = ${automationId} LIMIT 1
    FOR UPDATE
  `;
	const before = (beforeRows[0] ?? null) as {
		organization_id: string | null;
		consecutive_scheduled_failures: number | null;
		schedule_auto_paused_at: unknown;
		next_run_at: unknown;
	} | null;
	const updated = await sql`
    UPDATE automations
    SET consecutive_scheduled_failures = consecutive_scheduled_failures + 1,
        schedule_auto_paused_at = CASE
          WHEN consecutive_scheduled_failures + 1 >= ${threshold}
            THEN date_trunc('milliseconds', current_timestamp)
          ELSE NULL
        END,
        next_run_at = CASE
          WHEN consecutive_scheduled_failures + 1 >= ${threshold}
            THEN NULL
          ELSE next_run_at
        END,
        updated_at = current_timestamp
    WHERE id = ${automationId}
      AND status = 'active'
      AND schedule IS NOT NULL
      AND schedule_auto_paused_at IS NULL
    RETURNING id, organization_id, consecutive_scheduled_failures, schedule_auto_paused_at, next_run_at
  `;
	if (updated.length === 0 || !before?.organization_id) return;
	const after = updated[0] as Record<string, unknown>;
	const paused = (after as { schedule_auto_paused_at: unknown }).schedule_auto_paused_at != null;
	// System-attributed (#3664) with the existing vocabulary — no new enum:
	// actor_source 'agent', token_type 'system', null principals.
	await insertConfigChangeEventInTransaction({
		organizationId: before.organization_id,
		resourceKind: 'automation',
		resourceId: automationId,
		op: 'updated',
		action: paused ? 'auto_pause' : 'failure_count',
		summary: paused
			? `Automation ${automationId} auto-paused after ${String((after as { consecutive_scheduled_failures: unknown }).consecutive_scheduled_failures)} consecutive scheduled failures`
			: `Automation ${automationId} scheduled failure counted`,
		before: {
			id: automationId,
			consecutive_scheduled_failures: before.consecutive_scheduled_failures,
			schedule_auto_paused_at: before.schedule_auto_paused_at ?? null,
			next_run_at: before.next_run_at ?? null,
		},
		state: {
			id: automationId,
			consecutive_scheduled_failures: (after as { consecutive_scheduled_failures: unknown }).consecutive_scheduled_failures,
			schedule_auto_paused_at: (after as { schedule_auto_paused_at: unknown }).schedule_auto_paused_at ?? null,
			next_run_at: (after as { next_run_at: unknown }).next_run_at ?? null,
		},
		changedFields: paused
			? ['consecutive_scheduled_failures', 'schedule_auto_paused_at', 'next_run_at']
			: ['consecutive_scheduled_failures'],
		actorSource: 'agent',
		tokenType: 'system',
		createdBy: null,
		clientId: null,
	}, sql);
}

/** Clear the circuit breaker after a successful non-event window. Same
 * atomic scope as the failure counter above: caller tx when present,
 * own begin only for a bare pool handle. */
export async function resetScheduledFailureState(
	sql: DbClient,
	automationId: number,
): Promise<void> {
	const isTxHandle = typeof (sql as unknown as { savepoint?: unknown }).savepoint === 'function';
	if (isTxHandle) {
		await resetFailureInTransaction(sql, automationId);
		return;
	}
	await sql.begin(async (tx) => {
		await resetFailureInTransaction(tx, automationId);
	});
}

async function resetFailureInTransaction(
	sql: DbClient,
	automationId: number,
): Promise<void> {
	const beforeRows = await sql`
    SELECT id, organization_id, consecutive_scheduled_failures, schedule_auto_paused_at
    FROM automations WHERE id = ${automationId} LIMIT 1
    FOR UPDATE
  `;
	const before = (beforeRows[0] ?? null) as {
		organization_id: string | null;
		consecutive_scheduled_failures: number | null;
		schedule_auto_paused_at: unknown;
	} | null;
	const updated = await sql`
    UPDATE automations
    SET consecutive_scheduled_failures = 0,
        schedule_auto_paused_at = NULL
    WHERE id = ${automationId}
      AND (
        consecutive_scheduled_failures <> 0
        OR schedule_auto_paused_at IS NOT NULL
      )
    RETURNING id, organization_id, consecutive_scheduled_failures, schedule_auto_paused_at
  `;
	if (updated.length === 0 || !before?.organization_id) return;
	const after = updated[0] as Record<string, unknown>;
	await insertConfigChangeEventInTransaction({
		organizationId: before.organization_id,
		resourceKind: 'automation',
		resourceId: automationId,
		op: 'updated',
		action: 'cadence_reset',
		summary: `Automation ${automationId} schedule failure state reset`,
		before: {
			id: automationId,
			consecutive_scheduled_failures: before.consecutive_scheduled_failures,
			schedule_auto_paused_at: before.schedule_auto_paused_at ?? null,
		},
		state: {
			id: automationId,
			consecutive_scheduled_failures: (after as { consecutive_scheduled_failures: unknown }).consecutive_scheduled_failures,
			schedule_auto_paused_at: (after as { schedule_auto_paused_at: unknown }).schedule_auto_paused_at ?? null,
		},
		changedFields: ['consecutive_scheduled_failures', 'schedule_auto_paused_at'],
		actorSource: 'agent',
		tokenType: 'system',
		createdBy: null,
		clientId: null,
	}, sql);
}
