/**
 * Long-horizon expiry for undecided approvals.
 *
 * A run queued behind a human gate lands at `approval_status='pending'` and is
 * DELIBERATELY exempt from the short-horizon claim reaper (#2044, see
 * scheduled/stale-run-sweeper.ts): no worker will ever claim it, so timing it
 * out on the 120s claim horizon would kill the run before anyone could decide.
 * That exemption was never paired with a long-horizon expiry, so undecided
 * approvals accumulated forever — cluttering the approvals surface and keeping
 * side effects queued against inputs that went stale months ago.
 *
 * This reaper closes that hole at the OTHER end of the timescale: rows still
 * pending after `intervals.pendingApprovalTtlDays` (default 7 DAYS) go terminal
 * at `approval_status='expired', status='cancelled'`. It never touches anything
 * inside the TTL, so the #2044 grace window is untouched — the two reapers do
 * not overlap in the horizons they cover.
 *
 * 'expired' is a distinct value, not a reuse of 'rejected': rejection is a HUMAN
 * decision the batch-reject path feeds back to the Automation as a `correction` to
 * learn from, while expiry is the system giving up on an undecided run. An agent
 * must not train on silence as if it were disapproval.
 *
 * Scope is both human-gated lanes — `action` (connector operations) and
 * `internal` (builder / entity-change / Automation proposals). Nothing else can
 * hold `approval_status='pending'`.
 *
 * Fairness + throughput: candidates are selected round-robin across
 * organizations — interleaved by per-org rank, with a per-org cap — so neither
 * one huge tenant nor the N oldest tenants can consume a batch and starve
 * everyone else. The sweep then drains successive batches within a bounded
 * per-invocation ceiling, so a backlog larger than one batch clears in a single
 * run instead of one batch per daily tick.
 *
 * Multi-pod safety: the UPDATE re-asserts `approval_status = 'pending'`, so it
 * is the authoritative claim — a row a human approved between scan and write is
 * excluded by the predicate, and only one overlapping runner can commit an
 * expiry for a row. Pure Postgres, correct under N>1 replicas. The run
 * transition and card supersession share a transaction: if the event write
 * fails, the run remains pending for the next sweep.
 */

import { intervals } from "../config/intervals";
import { getDb, pgTextArray } from "../db/client";
import { queueApprovalNotificationCardRefresh } from "../notifications/service";
import { supersedeActionEvent } from "../tools/admin/approval-events";
import logger from "../utils/logger";
import { APPROVAL_RUN_TYPES } from "../utils/run-statuses";

/**
 * Rows claimed per batch. Bounds each SELECT and the write burst that follows
 * it; a backlog larger than this is drained by successive batches within the
 * same invocation rather than being deferred to tomorrow's tick.
 */
const EXPIRY_BATCH_SIZE = 500;

/**
 * Ceiling on rows expired per invocation. The sweep drains batch after batch up
 * to this many rows, so a >500-row backlog clears in one run instead of one
 * batch per DAY, while a pathological backlog still cannot run unbounded.
 */
const EXPIRY_INVOCATION_LIMIT = 10_000;

/**
 * Rows taken from any ONE organization per batch.
 *
 * Without this the selection is globally oldest-first, so a single tenant with
 * more stale approvals than the batch size consumes the entire budget on every
 * tick: its own backlog never drains AND every other org's stale approvals are
 * starved indefinitely — which defeats the point of the sweep. Taking a bounded
 * slice per org per batch means every org with a backlog makes progress on every
 * batch, and the round-robin across batches drains the big tenants too.
 */
const EXPIRY_PER_ORG_BATCH_SIZE = 50;

interface ExpiredApprovalRow {
	id: string | number;
	organization_id: string;
	action_key: string | null;
}

interface PendingApprovalCandidate {
	id: string | number;
}

interface ExpirePendingApprovalsResult {
	/** Rows transitioned pending → expired this tick. */
	expired: number;
}

/**
 * One pass of the pending-approval expiry sweep. Idempotent: a row already
 * expired no longer matches `approval_status = 'pending'`.
 *
 * `invocationLimit` is injectable purely so tests can exercise the ceiling
 * without seeding 10k rows; production always uses the default.
 */
export async function expirePendingApprovals(
	ttlDays: number = intervals.pendingApprovalTtlDays,
	invocationLimit: number = EXPIRY_INVOCATION_LIMIT,
): Promise<ExpirePendingApprovalsResult> {
	const sql = getDb();
	const reason = `Approval expired: nobody decided within ${ttlDays} day${ttlDays === 1 ? "" : "s"}.`;

	let expiredCount = 0;
	const expiredRunIdsByOrg = new Map<string, number[]>();
	// Drain successive batches so a backlog bigger than one batch clears in this
	// invocation. Bounded by EXPIRY_INVOCATION_LIMIT; also stops as soon as a
	// batch comes back empty or makes no progress (see below).
	while (expiredCount < invocationLimit) {
		const remaining = invocationLimit - expiredCount;
		const batchSize = Math.min(EXPIRY_BATCH_SIZE, remaining);

		// Fair selection, round-robin across organizations.
		//
		// Ranking per org and capping at EXPIRY_PER_ORG_BATCH_SIZE is NOT enough on
		// its own: if the capped set is then ordered globally by age, the oldest
		// (batchSize / perOrgCap) orgs fill the batch exactly and every other org
		// is invisible — starvation with the threshold moved from 1 org to N,
		// rather than removed.
		//
		// Ordering by `org_rank` FIRST interleaves the orgs: every org's oldest row
		// comes before any org's second row, and so on. Representation therefore
		// never depends on how many other orgs are backlogged. `created_at` stays
		// as the tiebreak WITHIN a rank, so the longest-waiting rows still lead at
		// equal standing, and the per-org cap keeps one tenant from monopolising
		// the tail of the batch.
		const candidates = (await sql`
      SELECT id FROM (
        SELECT id, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY organization_id ORDER BY created_at ASC, id ASC
               ) AS org_rank
        FROM runs
        WHERE approval_status = 'pending'
          AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
          AND created_at < NOW() - (${ttlDays}::int * interval '1 day')
      ) ranked
      WHERE org_rank <= ${EXPIRY_PER_ORG_BATCH_SIZE}
      ORDER BY org_rank ASC, created_at ASC, id ASC
      LIMIT ${batchSize}
    `) as unknown as PendingApprovalCandidate[];

		if (candidates.length === 0) break;

		const expiredBeforeBatch = expiredCount;
		for (const candidate of candidates) {
			try {
				const expiredRow = await sql.begin(async (tx) => {
					// Re-assert the full candidate predicate while claiming the row. A
					// human decision or another replica's committed expiry wins before
					// this write.
					const rows = (await tx`
            UPDATE runs
            SET approval_status = 'expired',
                status = 'cancelled',
                error_message = ${reason},
                completed_at = NOW()
            WHERE id = ${candidate.id}
              AND approval_status = 'pending'
              AND run_type = ANY(${pgTextArray([...APPROVAL_RUN_TYPES])}::text[])
              AND created_at < NOW() - (${ttlDays}::int * interval '1 day')
            RETURNING id, organization_id, action_key
          `) as unknown as ExpiredApprovalRow[];
					const row = rows[0];
					if (!row) return null;

					// `events` stays append-only. interaction_status has no 'expired'
					// member, so the card uses 'rejected' as its non-actionable UI state
					// while run status and metadata retain the precise expiry reason.
					// A pending approval always HAS a card (written at queue time), so a
					// missing one means corruption — fail closed: roll the expiry back and
					// leave the run pending for the next sweep rather than committing a
					// terminal run with no card.
					const eventId = await supersedeActionEvent(
						Number(row.id),
						row.organization_id,
						"rejected",
						(operation) => `${operation} — expired`,
						reason,
						{ reason, expired: true, expired_after_days: ttlDays },
						null,
						tx,
					);
					if (eventId === undefined) {
						throw new Error(
							`Cannot expire approval run ${Number(row.id)}: its approval card is missing`,
						);
					}
					return row;
				});
				if (expiredRow) {
					expiredCount += 1;
					const orgRunIds = expiredRunIdsByOrg.get(expiredRow.organization_id) ?? [];
					orgRunIds.push(Number(expiredRow.id));
					expiredRunIdsByOrg.set(expiredRow.organization_id, orgRunIds);
				}
			} catch (error) {
				logger.warn(
					{ runId: Number(candidate.id), error: String(error) },
					"[task] expire-pending-approvals: expiry rolled back after card supersede failure",
				);
			}
		}

		// No row in a non-empty batch advanced — every candidate was either decided
		// under us or is failing its supersede. Stop rather than re-selecting the
		// same rows forever; the next scheduled tick retries with fresh state.
		if (expiredCount === expiredBeforeBatch) break;
	}

	for (const [organizationId, runIds] of expiredRunIdsByOrg) {
		queueApprovalNotificationCardRefresh(organizationId, runIds);
	}
	return { expired: expiredCount };
}

/** Scheduled-task wrapper: run the sweep and log a summary. */
export async function runExpirePendingApprovals(): Promise<void> {
	const result = await expirePendingApprovals();
	if (result.expired > 0) {
		logger.info({ ...result }, "[task] expire-pending-approvals completed");
	}
}
