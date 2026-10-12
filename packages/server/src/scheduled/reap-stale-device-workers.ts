/**
 * Stale device-worker reaper.
 *
 * Safety net for `device_workers` orphaning. The primary fix is identity reuse
 * at mint-child-token (the Mac bridge forwards the extension's existing
 * worker_id so native re-pairs don't mint fresh ones) — but a row can still be
 * genuinely abandoned when the browser-profile install that owned it is gone:
 * extension uninstall, "clear extension data", or a second machine no longer in
 * use. Those rows have no live credential anywhere (the cred lived in the same
 * `chrome.storage.local` that got wiped), so the row is dead and only clutters
 * the Devices page.
 *
 * This reaper deletes device_workers rows that are BOTH stale (unseen far
 * beyond the 7-day freshness window) AND have no LIVE bindings — no pinned
 * connections, non-archived automations, or auth-profiles — so it never
 * disturbs a device a connection or a runnable automation still depends on.
 * An ARCHIVED automation is not a binding: it can never execute again, so
 * counting it would let one soft-deleted row anchor a dead machine forever.
 * Its pin is released in the delete transaction, matching what the explicit
 * device-delete path already does (`worker-api/device-management.ts`). The
 * no-binding predicate is re-checked under a row lock inside that transaction,
 * so a binding created between the candidate scan and the delete keeps the row
 * alive. Child PATs bound to the reaped worker_ids are revoked on the way out.
 *
 * It also revokes ORPHANED device PATs: worker-bound, still live, with no
 * device row for their (user_id, worker_id), and unused for the same 30 days.
 * Device deletes revoke bound PATs today, but older deletes did not, and those
 * tokens (some minted before child PATs expired) would otherwise live forever
 * and could re-create their device by polling.
 *
 * Single-claimant per tick via the runs-queue (like the other scheduled jobs);
 * pure Postgres, so it's correct under N>1 app replicas.
 */

import { type AuditedAccessToken, recordAccessTokenEvent } from '../auth/tokens';
import { getDb, pgTextArray } from '../db/client';
import { recordLifecycleEvent } from '../utils/insert-event';
import logger from '../utils/logger';

export async function reapStaleDeviceWorkers(): Promise<{
  scanned: number;
  reaped: number;
  orphanedTokens: number;
}> {
  const devices = await reapStaleDevices();
  const orphanedTokens = await revokeOrphanedDeviceTokens();
  return { ...devices, orphanedTokens };
}

/**
 * A worker-bound PAT whose device row is gone and that has not been used for
 * 30 days is dead weight. `COALESCE(last_used_at, created_at)` keeps a freshly
 * minted token (its device row is written right after it) out of reach.
 */
async function revokeOrphanedDeviceTokens(): Promise<number> {
  const revoked = (await getDb()`
    UPDATE personal_access_tokens p
    SET revoked_at = NOW(), updated_at = NOW()
    WHERE p.worker_id IS NOT NULL
      AND p.revoked_at IS NULL
      AND (p.expires_at IS NULL OR p.expires_at > NOW())
      AND COALESCE(p.last_used_at, p.created_at) < NOW() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM device_workers d
        WHERE d.user_id = p.user_id AND d.worker_id = p.worker_id
      )
    RETURNING p.id, p.organization_id, p.name, p.worker_id
  `) as unknown as AuditedAccessToken[];
  for (const token of revoked) {
    recordAccessTokenEvent('deleted', token, null, 'orphaned');
  }
  return revoked.length;
}

async function reapStaleDevices(): Promise<{ scanned: number; reaped: number }> {
  const sql = getDb();

  // 1. Candidate scan: stale + no bindings. Read-only; the authoritative
  //    no-binding check is repeated under lock in the transaction below. 30
  //    days is well beyond the 7-day freshness window
  //    reconcileDeviceCapabilities uses, so a temporarily offline device
  //    (laptop closed, vacation) is never reaped.
  const candidates = (await sql`
    SELECT id, worker_id FROM device_workers
    WHERE last_seen_at < now() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM connections c
        WHERE c.device_worker_id = device_workers.id AND c.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM automations w
        WHERE w.device_worker_id = device_workers.id AND w.status <> 'archived'
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_profiles ap WHERE ap.device_worker_id = device_workers.id
      )
    LIMIT 500
  `) as unknown as Array<{ id: string; worker_id: string }>;

  if (candidates.length === 0) {
    return { scanned: 0, reaped: 0 };
  }

  const ids = candidates.map((c) => c.id);

  // 2-3. Authoritative delete + PAT revocation in ONE transaction. Re-check
  //    every no-binding predicate inside the transaction so a binding created
  //    since the scan keeps its row; RETURNING the worker_ids actually deleted
  //    scopes PAT revocation to exactly the rows we removed. Doing both inside
  //    a single transaction avoids the inter-statement window where a
  //    concurrent poll could re-create a just-deleted row (poll upserts
  //    device_workers) and then have its token revoked afterward — here the
  //    row is gone and the PAT is revoked at the same commit, so there's no
  //    post-delete/pre-revoke gap.
  //
  //    A dangling PAT on a reaped worker_id CAN still poll if a device holding
  //    it comes back online — poll re-creates the device_workers row — so
  //    revoking ensures the row stays gone rather than resurrecting. Not a
  //    correctness hazard, just keeps the fleet honest.
  //
  //    `id::text = ANY(pgTextArray(...)::text[])` instead of `::uuid[]`: a
  //    pgTextArray literal passed through a `::uuid[]` cast trips a postgres
  //    "malformed array literal" under postgres.js's extended-protocol path
  //    (see the note in worker-api/device-reconcile.ts). UUIDs are canonical
  //    lowercase, so text equality matches the uuid form 1:1.
  type Reaped = { id: string; user_id: string; worker_id: string; organization_id: string | null; label: string | null };
  const { deleted, revokedTokens } = await sql.begin(async (tx) => {
    // Pick the doomed set FIRST, re-checking every predicate and taking a row
    // lock, so the decision to delete is made once and nothing downstream can
    // disagree with it. `FOR UPDATE` makes a concurrent poll (which upserts
    // device_workers) block until this commits rather than refreshing
    // last_seen_at underneath us; under READ COMMITTED the lock wait re-checks
    // the predicate, so a device that genuinely came back is dropped here.
    const doomed = (await tx`
      SELECT id FROM device_workers
      WHERE id::text = ANY(${pgTextArray(ids)}::text[])
        AND last_seen_at < now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM connections c
          WHERE c.device_worker_id = device_workers.id AND c.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM automations w
          WHERE w.device_worker_id = device_workers.id AND w.status <> 'archived'
        )
        AND NOT EXISTS (
          SELECT 1 FROM auth_profiles ap WHERE ap.device_worker_id = device_workers.id
        )
      FOR UPDATE
    `) as unknown as Array<{ id: string }>;

    if (doomed.length === 0) return { deleted: [] as Reaped[], revokedTokens: [] as AuditedAccessToken[] };
    const doomedIds = doomed.map((d) => d.id);

    // `automations.device_worker_id` is a NO ACTION FK, so a pin held by an
    // archived Automation would reject the DELETE even though the predicate
    // above ignores it. Release those pins — the same order, and the same
    // reasoning, as the explicit device-delete path in
    // `worker-api/device-management.ts`: archival is the supported soft-delete,
    // and an archived row is retained for history but must not keep the
    // restrictive FK alive.
    //
    // Scoped to `doomed`, NOT to every candidate: a pin must be released if and
    // only if its device is actually deleted. Releasing across all candidates
    // and letting a second predicate re-check refuse some of them strips history
    // from rows whose device then survives — the reaper's own 30-day window
    // exists to spare a laptop that was merely closed, and that laptop must keep
    // its Automations' pins.
    await tx`
      UPDATE automations
      SET device_worker_id = NULL, updated_at = NOW()
      WHERE device_worker_id::text = ANY(${pgTextArray(doomedIds)}::text[])
        AND status = 'archived'
    `;

    // Addressed by id: `doomed` is the authoritative set, already predicate-
    // checked and locked above, so re-stating the predicates here would only
    // invite the two lists to drift apart.
    const rows = (await tx`
      DELETE FROM device_workers
      WHERE id::text = ANY(${pgTextArray(doomedIds)}::text[])
      RETURNING id, user_id, worker_id, organization_id, label
    `) as unknown as Reaped[];

    // A device is (user_id, worker_id): another user's PAT on the same
    // worker_id belongs to a different device and must stay live.
    const revoked =
      rows.length > 0
        ? ((await tx`
            UPDATE personal_access_tokens
            SET revoked_at = NOW(), updated_at = NOW()
            WHERE (user_id, worker_id) IN (
                SELECT * FROM unnest(
                  ${pgTextArray(rows.map((r) => r.user_id))}::text[],
                  ${pgTextArray(rows.map((r) => r.worker_id))}::text[]
                )
              )
              AND revoked_at IS NULL
            RETURNING id, organization_id, name, worker_id
          `) as unknown as AuditedAccessToken[])
        : [];
    return { deleted: rows, revokedTokens: revoked };
  });

  for (const device of deleted) {
    if (!device.organization_id) continue;
    recordLifecycleEvent({
      organizationId: device.organization_id,
      entityType: 'device',
      op: 'deleted',
      entityId: device.id,
      summary: `Device "${device.label ?? device.worker_id}" removed after 30 days offline`,
      extra: { worker_id: device.worker_id, reason: 'stale' },
    });
  }
  for (const token of revokedTokens) {
    recordAccessTokenEvent('deleted', token, null, 'device-reaped');
  }

  return { scanned: candidates.length, reaped: deleted.length };
}

/** Scheduled-task wrapper: run the reaper and log a summary. */
export async function runReapStaleDeviceWorkers(): Promise<void> {
  const result = await reapStaleDeviceWorkers();
  if (result.reaped > 0 || result.orphanedTokens > 0) {
    logger.info({ ...result }, '[task] reap-stale-device-workers completed');
  }
}
