/**
 * The run-lease vocabulary shared by every write that lands an outcome on a
 * run somebody else could have taken in the meantime.
 *
 * Two kinds of holder take a run lease, and both fence the same way:
 *  - the gateway executing a run inline, which claims it as
 *    `gateway-inline-<uuid>` and holds that across the external call;
 *  - a worker that claimed the run through `/poll`, which holds it across the
 *    whole execution and reports back over the worker API.
 *
 * Either way the write can land long after the claim, by which time a cancel,
 * the stale-run reaper, or a second claim may have handed the run to someone
 * else. Every one of them fences on the owner so a late write cannot overwrite
 * whoever holds the run now.
 *
 * The fence values are REQUIRED parameters. An "omit it to skip the fence"
 * escape hatch is a fail-open guard dressed as a guard: the one caller that
 * forgets is exactly the one that clobbers another owner's run.
 */

import { intervals } from "../config/intervals";
import { type DbClient, getDb } from "../db/client";
import logger from "../utils/logger";

/**
 * Reported when a fenced terminal write matches no row: the run was cancelled,
 * reaped, or re-claimed while this request was still executing. The external
 * call may well have succeeded, but this request no longer owns the run, so it
 * must not overwrite whoever does — the durable row is the answer.
 */
export const LOST_LEASE_MESSAGE =
	"Inline execution lost its run lease; the durable run state is authoritative.";

/**
 * The guard every terminal write shares: land the outcome only while this
 * holder still owns the run it claimed and nothing has terminalized it.
 * One definition, because hand-written copies drift and a fence that silently
 * matches no row looks exactly like one that worked. This was nine identical
 * hand-written copies across the worker API, the automation completion path
 * and the inline gateway path before it was one function.
 */
export function runLeaseFence(sql: DbClient, claimedBy: string) {
	return sql`AND status = 'running' AND claimed_by = ${claimedBy}`;
}

/**
 * Fence a write on the owner ALONE, leaving the run's status out of it. Two
 * callers need that: recovery paths finalizing a run they did not claim
 * themselves, and non-terminal progress writes that must not care which
 * lifecycle state the run is in, only that it is still ours. `null` is not "no fence": it
 * asserts the run is still unowned, which is what a run claimed before the
 * gateway took leases looks like. Either way the write loses to a concurrent
 * re-claim instead of overwriting it.
 */
export function runOwnerFence(sql: DbClient, expectedOwner: string | null) {
	return expectedOwner === null
		? sql`AND claimed_by IS NULL`
		: sql`AND claimed_by = ${expectedOwner}`;
}

/**
 * Keep a gateway-inline run's lease alive while its execution is in flight.
 *
 * The inline claim stamps `last_heartbeat_at` once, and the stale-run reaper
 * times out any heartbeating `action` run whose beat is older than
 * `runsReaperStaleAfterSeconds`. Without a refresher, an inline call that
 * outlived that threshold was reaped mid-flight: the external mutation then
 * succeeded, the fenced terminal write matched no row, and the caller was told
 * it failed. Each beat is fenced on this holder's own lease, so it can never
 * revive a run somebody else took, and it stops at the first beat that matches
 * no row. The timer lives in this process only: a crashed pod stops beating
 * and the reaper still reclaims its run. The cadence is derived from the
 * reaper threshold so the two cannot drift apart.
 *
 * Returns the stop function; call it as soon as execution returns.
 */
export function keepInlineRunLeaseAlive(
	runId: number,
	organizationId: string,
	claimedBy: string,
): () => void {
	const periodMs = Math.max(
		250,
		Math.floor((intervals.runsReaperStaleAfterSeconds * 1000) / 4),
	);
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(beat, periodMs);
		timer.unref?.();
	};
	const beat = async () => {
		if (stopped) return;
		try {
			const sql = getDb();
			const rows = await sql`
				UPDATE runs SET last_heartbeat_at = current_timestamp
				WHERE id = ${runId} AND organization_id = ${organizationId}
				${runLeaseFence(sql, claimedBy)}
				RETURNING id
			`;
			if (rows.length === 0) {
				stopped = true;
				return;
			}
		} catch (error) {
			// A missed beat is survivable (the threshold spans four of them); the
			// next tick retries. The terminal write stays lease-fenced either way.
			logger.warn(
				{ run_id: runId, error: String(error) },
				"[run-lease] Inline run heartbeat failed",
			);
		}
		schedule();
	};
	schedule();
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
