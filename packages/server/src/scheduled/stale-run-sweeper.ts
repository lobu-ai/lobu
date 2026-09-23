/**
 * Shared stale-run reaping core.
 *
 * Three reapers mark stale `runs` rows as `timeout` when their liveness signal
 * lapses. Callers may additionally include never-claimed `pending` rows:
 *
 *   - the connector-lane reaper (scheduled/check-stalled-executions.ts) —
 *     sync/action/embed_backfill/auth, single 120s threshold
 *   - the agent-turn sweep (worker-api/agent-turn.ts) — `agent_turn` on the
 *     connector reaper's threshold, one row per transaction so the timeout
 *     can publish the client's `thread_response` alongside it
 *   - the automation sweep (automations/automation.ts) — 3min heartbeat-stale fast
 *     path + 2h coarse TTL for runs that never heartbeated
 *
 * Both share one predicate shape: a run with a live heartbeat signal is
 * judged on `last_heartbeat_at` against the heartbeat threshold; a run
 * without one is judged on `COALESCE(claimed_at, created_at)` against the
 * coarse threshold. What differs per caller is which rows count as
 * "heartbeating" and the two thresholds — captured in {@link StaleRunSweepSpec}.
 *
 * `buildStaleRunWhereSql` returns the WHERE fragment so the connector reaper
 * can keep its atomic timeout-plus-retry CTE (the UPDATE must stay inside
 * that single statement); `markStaleRunsAsTimeout` returns the transitioned
 * rows so Automation callers can apply lane-specific terminal policy in the
 * same transaction. The fragments are inlined via `sql.unsafe`, so every
 * input is validated against a strict literal pattern first.
 */

import { PG_INTERVAL_PATTERN } from "../config/intervals";
import type { DbClient } from "../db/client";
import { classifyRunOutcome } from "../runs/run-outcome";

interface StaleRunSweepSpec {
	/** `runs.run_type` values covered by this sweep. */
	runTypes: readonly string[];
	/**
	 * Which rows count as "heartbeating":
	 *  - 'any-heartbeat': any non-NULL `last_heartbeat_at` (connector lanes —
	 *    the claim doesn't stamp a heartbeat, so presence means the executor
	 *    beat at least once).
	 *  - 'beat-after-claim': only rows whose `last_heartbeat_at` advanced past
	 *    `claimed_at` (automation lane — the claim seeds
	 *    `last_heartbeat_at = claimed_at`, so equality means "never beat" and
	 *    a non-heartbeating client falls through to the coarse path).
	 */
	heartbeatSemantics: "any-heartbeat" | "beat-after-claim";
	/** Postgres interval literal (e.g. '3 minutes'). Heartbeating rows whose
	 *  last beat is older than this are reaped. */
	heartbeatStaleInterval: string;
	/** Postgres interval literal. Non-heartbeating rows whose
	 *  `COALESCE(claimed_at, created_at)` is older than this are reaped. */
	coarseStaleInterval: string;
	/**
	 * Include never-claimed pending rows. Auto-approved rows are judged on
	 * `created_at`; human-approved rows are judged on the `run_at` stamped when
	 * approval made them claimable.
	 *
	 * Only rows a worker is actually allowed to claim are reaped: a run with
	 * `approval_status = 'pending'` is parked waiting for a HUMAN to approve it —
	 * no worker will ever claim it, so the claim-timeout must NOT apply, or a
	 * queued-approval run is force-timed-out before anyone can approve it (#2044).
	 * Approval flips inline work to `status = 'running'`, after which the normal
	 * in-progress heartbeat/coarse predicate governs it. Worker-executed actions
	 * remain pending and start their claim clock at approval.
	 */
	includePending?: boolean;
}

const RUN_TYPE_PATTERN = /^[a-z_]+$/;

/** Validate + quote a `<n> <unit>` literal as a SQL interval expression. */
function intervalSql(literal: string): string {
	if (!PG_INTERVAL_PATTERN.test(literal)) {
		throw new Error(
			`Invalid Postgres interval literal: ${JSON.stringify(literal)}`,
		);
	}
	return `interval '${literal}'`;
}

function runTypeListSql(runTypes: readonly string[]): string {
	if (runTypes.length === 0) {
		throw new Error("StaleRunSweepSpec.runTypes must not be empty");
	}
	return runTypes
		.map((runType) => {
			if (!RUN_TYPE_PATTERN.test(runType)) {
				throw new Error(`Invalid run_type literal: ${JSON.stringify(runType)}`);
			}
			return `'${runType}'`;
		})
		.join(", ");
}

/** SQL boolean expr: this row has a live heartbeat signal per the spec. */
function hasHeartbeatSql(
	semantics: StaleRunSweepSpec["heartbeatSemantics"],
): string {
	return semantics === "beat-after-claim"
		? `(last_heartbeat_at IS NOT NULL
       AND claimed_at IS NOT NULL
       AND last_heartbeat_at > claimed_at)`
		: "last_heartbeat_at IS NOT NULL";
}

/** Exact complement of {@link hasHeartbeatSql}, spelled out (De Morgan) so
 *  the SQL is two-valued even when `claimed_at` / `last_heartbeat_at` are
 *  NULL. */
function neverHeartbeatedSql(
	semantics: StaleRunSweepSpec["heartbeatSemantics"],
): string {
	return semantics === "beat-after-claim"
		? `(last_heartbeat_at IS NULL
       OR claimed_at IS NULL
       OR last_heartbeat_at <= claimed_at)`
		: "last_heartbeat_at IS NULL";
}

/**
 * WHERE fragment selecting the stale rows for this spec.
 * Column references are unqualified — embed in an `UPDATE runs` (or
 * `UPDATE public.runs`) without an alias.
 */
export function buildStaleRunWhereSql(spec: StaleRunSweepSpec): string {
	const inProgressPredicate = `
      (status IN ('claimed', 'running')
       AND (
         -- Fast path: the executor was heartbeating, then went silent.
         (${hasHeartbeatSql(spec.heartbeatSemantics)}
          AND last_heartbeat_at
              < current_timestamp - ${intervalSql(spec.heartbeatStaleInterval)})
         OR
         -- Coarse backstop: ONLY for runs without a live heartbeat signal, so a
         -- heartbeating run that legitimately outlives the coarse TTL (fresh
         -- heartbeat) is never killed here.
         (${neverHeartbeatedSql(spec.heartbeatSemantics)}
          AND COALESCE(claimed_at, created_at)
              < current_timestamp - ${intervalSql(spec.coarseStaleInterval)})
       ))`;
	const statusPredicate = spec.includePending
		? `((status = 'pending'
         -- A run awaiting HUMAN approval is not worker-claimable; the
         -- claim-timeout must never reap it (#2044). Only 'auto'/'approved'
         -- pending rows are genuinely waiting for a worker.
         AND approval_status <> 'pending'
         AND (
           -- A page-activated action may remain intentionally parked until its
           -- explicit expiry. Once activated, its activation timestamp starts
           -- the ordinary worker-claim clock; the potentially old created_at
           -- must not make it time out immediately.
           -- An approved row became claimable at approval, which stamps
           -- run_at; judging it on queue-time created_at would time out any
           -- run whose review outlasted the interval before a worker polled.
           (activation_kind IS NULL
            AND CASE WHEN approval_status = 'approved' THEN run_at ELSE created_at END
                < current_timestamp - ${intervalSql(spec.coarseStaleInterval)})
           OR (activation_kind = 'page_visit'
               AND activated_at IS NOT NULL
               AND activated_at < current_timestamp - ${intervalSql(spec.coarseStaleInterval)})
           -- An ephemeral run whose explicit claim horizon lapsed must never
           -- execute later — terminalize it even if it is younger than the
           -- coarse interval (device action runs carry expires_at; see
           -- runs/queue-service.ts).
           OR (run_type = 'action'
               AND expires_at IS NOT NULL
               AND expires_at <= current_timestamp)
         ))
        OR ${inProgressPredicate})`
		: inProgressPredicate;

	return `
    run_type IN (${runTypeListSql(spec.runTypes)})
    AND ${statusPredicate}
  `;
}

/**
 * Mark every stale in-progress run matched by the spec as `timeout` in one
 * statement, stamping the path-appropriate error message. The locked CTE
 * retains each row's prior status so callers can distinguish work that was
 * actually running from a claim that never reached execution.
 */
export interface TimedOutStaleRun {
	id: number;
	automation_id: number | null;
	run_type: string;
	previous_status: string;
	dispatch_source: string | null;
}

export async function markStaleRunsAsTimeout(
	sql: DbClient,
	spec: StaleRunSweepSpec & {
		/** error_message for rows reaped via the heartbeat-stale fast path. */
		heartbeatErrorMessage: string;
		/** error_message for rows reaped via the coarse TTL backstop. */
		coarseErrorMessage: string;
	},
): Promise<TimedOutStaleRun[]> {
	const result = await sql.unsafe(
		`WITH stale AS MATERIALIZED (
       SELECT id,
              status AS previous_status,
              automation_id,
              run_type,
              approved_input->>'dispatch_source' AS dispatch_source,
              CASE
                WHEN ${hasHeartbeatSql(spec.heartbeatSemantics)} THEN $1
                ELSE $2
              END AS timeout_error
       FROM runs
       WHERE ${buildStaleRunWhereSql(spec)}
       FOR UPDATE SKIP LOCKED
     )
     UPDATE runs AS r
     SET status = 'timeout',
         outcome = $3,
         completed_at = current_timestamp,
         error_message = stale.timeout_error
     FROM stale
     WHERE r.id = stale.id
       AND r.status = stale.previous_status
     RETURNING r.id, r.automation_id, r.run_type,
               stale.previous_status, stale.dispatch_source`,
		[
			spec.heartbeatErrorMessage,
			spec.coarseErrorMessage,
			classifyRunOutcome({ status: "timeout" }),
		],
	);
	return result as unknown as TimedOutStaleRun[];
}
