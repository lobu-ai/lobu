/**
 * Serializes ACL syncs per connection.
 *
 * The generation counter fences the FRESH STAMP, not the edge writes that
 * precede it — `buildAccessGraph` reconciles membership in one transaction and
 * stamps in another. Two syncs of the SAME connection can therefore interleave
 * into a published leak that no generation check can see:
 *
 *   1. sync A captures generation 0, holding a snapshot that still contains a
 *      since-revoked member U
 *   2. a relationship retraction commits generation 1, drops U's edges, marks the state stale
 *   3. sync B captures generation 1, reconciles U away, stamps fresh — its
 *      generation still matches, so the stamp is correct
 *   4. A writes U's `member_of` edge back; nothing fences an edge WRITE
 *   5. A's stamp is refused (0 != 1), which is too late
 *
 * The connection ends at generation 1, `fresh`, with U's revoked edge live, and
 * the gate serves U. Ordering the two syncs removes step 4 entirely.
 *
 * The counter still earns its place: it covers an invalidation racing a sync of
 * a DIFFERENT connection, which no per-connection lock can order. There the
 * refused stamp leaves the state stale, which fails closed.
 */

import { getLockDb } from "../db/client.js";

const ACL_SYNC_LOCK_NS = "acl_connection_sync";

export type AclSyncLockOutcome<T> =
	| { ran: true; value: T }
	| { ran: false; value?: undefined };

/**
 * Run an entire ACL sync for one connection under a SESSION advisory lock.
 *
 * Session-scoped rather than `pg_advisory_xact_lock`: a sync spans several
 * transactions on the main pool (graph build, edge reconcile, fresh stamp), and
 * a transaction-scoped lock would release at the first commit — reopening the
 * window this closes. Acquire and release happen on ONE reserved connection so
 * the session identity is stable; any other connection serving the unlock makes
 * Postgres raise `you don't own a lock of type ExclusiveLock`.
 *
 * The reserved connection comes from the DEDICATED lock pool. A holder camps on
 * a connection for the whole sync while the sync's own queries run on the main
 * pool; camping on the main pool instead would let `DB_POOL_MAX` concurrent
 * syncs consume every slot and starve the very queries they are waiting on —
 * the permanent pool-wide deadlock `getLockDb` exists to prevent.
 *
 * TRY, not wait. A caller that cannot get the lock is a redundant sync of a
 * connection already being synced, and the holder is producing a fresher result
 * from a newer snapshot. Queueing would add a stale second pass and needs a
 * `lock_timeout` to bound it; skipping needs neither.
 *
 * Returns `{ ran: false }` when another sync held the lock. Callers MUST NOT
 * report that as success — a skipped sync has published nothing, so treating it
 * as done would suppress the retry that a genuinely failed sync deserves.
 */
export async function withAclConnectionSyncLock<T>(
	connectionId: string,
	fn: () => Promise<T>,
): Promise<AclSyncLockOutcome<T>> {
	const reserved = await getLockDb().reserve();
	try {
		const [acquisition] = await reserved<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${ACL_SYNC_LOCK_NS}), hashtext(${connectionId}))
        AS acquired
    `;
		if (!acquisition?.acquired) return { ran: false };
		try {
			return { ran: true, value: await fn() };
		} finally {
			await reserved`
        SELECT pg_advisory_unlock(hashtext(${ACL_SYNC_LOCK_NS}), hashtext(${connectionId}))
      `;
		}
	} finally {
		reserved.release();
	}
}
