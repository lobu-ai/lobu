/**
 * Integration test for the stale device-worker reaper's automation binding.
 *
 * An ARCHIVED Automation can never execute again, so it must not count as a
 * binding that keeps a dead machine alive — otherwise one soft-deleted row
 * anchors its device permanently and the reaper skips it every night. Because
 * `automations.device_worker_id` is a NO ACTION FK, ignoring archived rows in
 * the predicate is not enough on its own: the pin has to be released inside the
 * delete transaction or the FK rejects the DELETE.
 *
 * A LIVE pin must still block, and must not be cleared as a side effect — that
 * is the difference between reaping a dead machine and silently un-pinning a
 * runnable Automation.
 *
 * The suite also covers the reaper's other two exits, which the pin work left
 * untested: child-token revocation (scoped to the worker_ids actually deleted)
 * and the `auth_profiles` predicate, whose FK is ON DELETE CASCADE and so fails
 * silently rather than loudly if the guard is ever lost.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import { handleDelete } from '../../tools/admin/manage_automations/crud';
import { readAutomationConfiguration } from '../../tools/admin/manage_automations/revision';
import { reapStaleDeviceWorkers } from '../reap-stale-device-workers';

const ORG_ID = 'device-pin-reaper-org';
const USER_ID = 'device-pin-reaper-user';

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "user" (id, name, email)
    VALUES (${USER_ID}, ${USER_ID}, ${`${USER_ID}@example.test`})
    ON CONFLICT (id) DO NOTHING
  `;
});

/** A device unseen well past the reaper's 30-day threshold. */
async function seedStaleDevice(workerId: string): Promise<string> {
  const sql = getDb();
  const [row] = (await sql`
    INSERT INTO device_workers (user_id, worker_id, organization_id, platform, last_seen_at)
    VALUES (${USER_ID}, ${workerId}, ${ORG_ID}, 'macos', now() - interval '40 days')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedAutomationPinnedTo(
  deviceWorkerId: string,
  name: string
): Promise<{ id: number; revision: string }> {
  const sql = getDb();
  const [row] = (await sql`
    WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
    INSERT INTO automations (
      id, automation_group_id, organization_id, created_by, name, slug, device_worker_id
    )
    SELECT id, id, ${ORG_ID}, ${USER_ID}, ${name}, ${name}, ${deviceWorkerId}
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  const snapshot = await readAutomationConfiguration(ORG_ID, String(row.id));
  if (!snapshot) throw new Error('Seeded Automation configuration was not found');
  return { id: Number(row.id), revision: snapshot.revision };
}

// Archive from the original seed snapshot; no read can refresh a stale intent.
async function archive(automation: { id: number; revision: string }): Promise<void> {
  const id = String(automation.id);
  const result = await handleDelete(
    { action: 'delete', automation_ids: [id], expected_revisions: { [id]: automation.revision } } as never,
    { organizationId: ORG_ID, userId: USER_ID } as never
  );
  expect(result.summary.successful).toBe(1);
}

async function deviceExists(id: string): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT 1 FROM device_workers WHERE id = ${id}
  `) as unknown as Array<unknown>;
  return rows.length > 0;
}

async function pinOf(automationId: number): Promise<string | null> {
  const sql = getDb();
  const [row] = (await sql`
    SELECT device_worker_id FROM automations WHERE id = ${automationId}
  `) as unknown as Array<{ device_worker_id: string | null }>;
  return row?.device_worker_id ?? null;
}

/**
 * A PAT bound to a device's `worker_id` (what mint-child-token issues), or an
 * ordinary unbound user token when `workerId` is null.
 */
async function seedChildToken(workerId: string | null, name: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO personal_access_tokens
      (token_hash, token_prefix, user_id, organization_id, name, worker_id)
    VALUES
      (${`hash-${name}`}, ${`pfx-${name}`}, ${USER_ID}, ${ORG_ID}, ${name}, ${workerId})
  `;
}

async function tokenRevoked(name: string): Promise<boolean> {
  const sql = getDb();
  const [row] = (await sql`
    SELECT revoked_at FROM personal_access_tokens WHERE name = ${name}
  `) as unknown as Array<{ revoked_at: Date | null }>;
  return row?.revoked_at != null;
}

describe('stale device-worker reaper', () => {
  test('reaps a device whose only pin is an archived Automation', async () => {
    const deviceId = await seedStaleDevice('worker-archived-pin');
    const automation = await seedAutomationPinnedTo(deviceId, 'stale-envelope');

    // Blocked while the Automation is live.
    const blocked = await reapStaleDeviceWorkers();
    expect(blocked.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);

    await archive(automation);

    // Archival is a soft delete: the pin is retained as history, NOT cleared
    // eagerly. Releasing it is the reaper's job, at the moment it deletes.
    expect(await pinOf(automation.id)).toBe(deviceId);

    const after = await reapStaleDeviceWorkers();
    expect(after.reaped).toBe(1);
    expect(await deviceExists(deviceId)).toBe(false);
    expect(await pinOf(automation.id)).toBeNull();
  });

  test('a live pin still blocks its device and is never cleared', async () => {
    const deviceId = await seedStaleDevice('worker-live-pin');
    const automation = await seedAutomationPinnedTo(deviceId, 'still-active');

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);
    // The release must be scoped to archived rows — a runnable Automation must
    // not be silently un-pinned by a reaper pass that spared its device.
    expect(await pinOf(automation.id)).toBe(deviceId);
  });

  test('one live pin protects the device even alongside archived ones', async () => {
    const deviceId = await seedStaleDevice('worker-mixed-pins');
    const archivedAutomation = await seedAutomationPinnedTo(deviceId, 'mixed-archived');
    const liveAutomation = await seedAutomationPinnedTo(deviceId, 'mixed-live');
    await archive(archivedAutomation);

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);
    expect(await pinOf(liveAutomation.id)).toBe(deviceId);
    expect(await pinOf(archivedAutomation.id)).toBe(deviceId);
  });

  /**
   * A pin is cleared IF AND ONLY IF its device is actually deleted. The
   * likeliest way for the two to disagree is `last_seen_at` moving between the
   * candidate scan and the delete: the dark laptop coming back.
   *
   * A real concurrent poll cannot be scheduled deterministically from one
   * connection, so a trigger stands in for it: it fires the moment the reaper
   * releases a pin and refreshes that device's `last_seen_at`, landing the
   * "device came back" change inside the reaper's own transaction — the worst
   * case for statement ordering. The assertion is the invariant, not the
   * simulation: whatever the reaper decides, released pins and deleted devices
   * must match.
   */
  test('releases a pin only if the device is actually deleted', async () => {
    const sql = getDb();
    const deviceId = await seedStaleDevice('worker-revived-midflight');
    const automation = await seedAutomationPinnedTo(deviceId, 'revived-envelope');
    await archive(automation);

    await sql`
      CREATE OR REPLACE FUNCTION test_revive_device_on_unpin() RETURNS trigger
      LANGUAGE plpgsql AS $revive$
      BEGIN
        UPDATE device_workers SET last_seen_at = now() WHERE id = OLD.device_worker_id;
        RETURN NEW;
      END
      $revive$
    `;
    await sql`
      CREATE TRIGGER test_revive_device_on_unpin
      AFTER UPDATE OF device_worker_id ON automations
      FOR EACH ROW
      WHEN (OLD.device_worker_id IS NOT NULL AND NEW.device_worker_id IS NULL)
      EXECUTE FUNCTION test_revive_device_on_unpin()
    `;

    try {
      await reapStaleDeviceWorkers();
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_revive_device_on_unpin ON automations`;
      await sql`DROP FUNCTION IF EXISTS test_revive_device_on_unpin()`;
    }

    const stillThere = await deviceExists(deviceId);
    const pinReleased = (await pinOf(automation.id)) === null;

    // Either both happened or neither did. The failure this guards is
    // pinReleased === true while stillThere === true: history destroyed for a
    // device the reaper decided to keep.
    expect(pinReleased).toBe(!stillThere);
    // ...and the pairing must not be satisfied by a reaper that does nothing:
    // this candidate had no live binding, so it is expected to go.
    expect(stillThere).toBe(false);
  });

  test('spares a non-candidate device and leaves its archived pin intact', async () => {
    const sql = getDb();
    // Reaped: stale, only an archived pin.
    const doomedId = await seedStaleDevice('worker-pair-doomed');
    const doomedAutomation = await seedAutomationPinnedTo(doomedId, 'pair-doomed');
    await archive(doomedAutomation);

    // Spared: identically stale with an archived pin, but a live connection
    // keeps it bound, so it never becomes a candidate.
    const sparedId = await seedStaleDevice('worker-pair-spared');
    const sparedAutomation = await seedAutomationPinnedTo(sparedId, 'pair-spared');
    await archive(sparedAutomation);
    await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, created_by, device_worker_id, status)
      VALUES
        (${ORG_ID}, 'os.shell', 'pair-spared-shell', ${USER_ID}, ${sparedId}, 'active')
    `;

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(1);
    expect(await deviceExists(doomedId)).toBe(false);
    expect(await pinOf(doomedAutomation.id)).toBeNull();

    // The spared device keeps both its row and its Automation's record of it.
    expect(await deviceExists(sparedId)).toBe(true);
    expect(await pinOf(sparedAutomation.id)).toBe(sparedId);
  });

  /**
   * The candidate scan runs OUTSIDE the delete transaction, so the set it
   * returns can be stale by the time the transaction re-picks under lock. This
   * is the only case where those two sets genuinely differ, and it is the case
   * the release must be scoped to: releasing across every candidate, rather
   * than the locked set, strips an archived pin from a device that then
   * survives.
   *
   * Unlike the trigger simulation above, this stages the real race with a
   * second connection. It holds a row lock on one candidate, lets the reaper
   * block on it inside its transaction, then revives that device and commits.
   * Under READ COMMITTED the reaper's `FOR UPDATE` wait re-evaluates the
   * predicate against the updated row, so the revived device drops out of the
   * locked set while remaining in the candidate list.
   */
  test('a candidate that stops qualifying keeps both its row and its pin', async () => {
    const revivedId = await seedStaleDevice('worker-race-revived');
    const revivedAutomation = await seedAutomationPinnedTo(revivedId, 'race-revived');
    await archive(revivedAutomation);

    // A second candidate with no contention, so the reaper is proven to still
    // do its job in the same pass rather than passing by doing nothing.
    const doomedId = await seedStaleDevice('worker-race-doomed');
    const doomedAutomation = await seedAutomationPinnedTo(doomedId, 'race-doomed');
    await archive(doomedAutomation);

    const blocker = postgres(process.env.DATABASE_URL as string, { max: 1 });
    let result: Awaited<ReturnType<typeof reapStaleDeviceWorkers>>;

    try {
      // The reaper's promise comes back WRAPPED in an object: `begin` awaits
      // whatever the callback returns, and awaiting the reaper directly would
      // deadlock (the reaper waits for this commit; the commit waits for the
      // reaper).
      const { reaping } = await blocker.begin(async (tx) => {
        // Hold the row the reaper will want. Its candidate scan is a plain
        // read and is unaffected, so `revivedId` still enters the batch.
        await tx`SELECT id FROM device_workers WHERE id = ${revivedId} FOR UPDATE`;

        const reaping = reapStaleDeviceWorkers();

        // Wait for the reaper to actually be parked on the lock. Polling
        // pg_stat_activity (never a sleep) keeps this deterministic, and the
        // throw means a run that never blocked fails loudly instead of
        // quietly testing nothing.
        const deadline = Date.now() + 8_000;
        for (;;) {
          // "Some backend is blocked by THIS one" is the unambiguous signal.
          // Matching on pg_stat_activity.query is not: a backend parked inside
          // a transaction reports the last statement its driver sent, which
          // for postgres.js is not the SELECT doing the waiting. Nor is any
          // ungranted lock: this suite shares its process (and database) with
          // other files whose stragglers could be waiting on something else.
          const [waiting] = (await tx`
            SELECT count(*)::int AS c FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
          `) as unknown as Array<{ c: number }>;
          if (Number(waiting?.c ?? 0) > 0) break;
          if (Date.now() > deadline) {
            const diag = (await tx`
              SELECT pid, state, wait_event_type, wait_event, left(query, 90) AS q
              FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query <> ''
            `) as unknown as Array<unknown>;
            throw new Error(
              'reaper never blocked on the held row lock; the race was not staged. ' +
                `backends=${JSON.stringify(diag)}`
            );
          }
          await new Promise((r) => setTimeout(r, 25));
        }

        // The dark laptop comes back. Committing here (end of the callback)
        // releases the lock and hands the reaper an updated row.
        await tx`UPDATE device_workers SET last_seen_at = now() WHERE id = ${revivedId}`;
        return { reaping };
      });

      result = await reaping;
    } finally {
      await blocker.end({ timeout: 5 });
    }

    // Both devices were candidates; only one was still doomed under lock.
    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);

    // The revived device keeps its row AND its Automation's record of it.
    expect(await deviceExists(revivedId)).toBe(true);
    expect(await pinOf(revivedAutomation.id)).toBe(revivedId);

    // The uncontended one is still collected normally.
    expect(await deviceExists(doomedId)).toBe(false);
    expect(await pinOf(doomedAutomation.id)).toBeNull();
  }, 30_000);

  test("revokes the reaped device's child token", async () => {
    const deviceId = await seedStaleDevice('worker-pat-reaped');
    const automation = await seedAutomationPinnedTo(deviceId, 'pat-reaped');
    await archive(automation);
    await seedChildToken('worker-pat-reaped', 'pat-reaped');

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(1);
    // A live PAT bound to a reaped worker_id would let the device re-create the
    // row on its next poll, undoing the reap.
    expect(await tokenRevoked('pat-reaped')).toBe(true);
  });

  test('leaves tokens belonging to other devices alone', async () => {
    const sql = getDb();
    const doomedId = await seedStaleDevice('worker-pat-doomed');
    const doomedAutomation = await seedAutomationPinnedTo(doomedId, 'pat-doomed');
    await archive(doomedAutomation);
    await seedChildToken('worker-pat-doomed', 'pat-doomed');

    // Stale but pinned by a live connection, so its device survives.
    const sparedId = await seedStaleDevice('worker-pat-spared');
    await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, created_by, device_worker_id, status)
      VALUES
        (${ORG_ID}, 'os.shell', 'pat-spared-shell', ${USER_ID}, ${sparedId}, 'active')
    `;
    await seedChildToken('worker-pat-spared', 'pat-spared');

    // An ordinary user PAT, bound to no device at all.
    await seedChildToken(null, 'pat-unbound');

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(1);
    expect(await tokenRevoked('pat-doomed')).toBe(true);
    // Revocation must be scoped to the worker_ids actually deleted — an
    // unscoped UPDATE would log every device in the org out at 3am.
    expect(await tokenRevoked('pat-spared')).toBe(false);
    expect(await tokenRevoked('pat-unbound')).toBe(false);
  });

  /**
   * `auth_profiles.device_worker_id` is ON DELETE CASCADE, unlike the NO ACTION
   * FK on `automations`. That asymmetry is why this predicate needs its own
   * guard: if it were ever dropped, the DELETE would not fail loudly the way an
   * unreleased automation pin does — it would succeed and silently take the
   * device's stored credentials with it.
   */
  test('an auth profile alone blocks the reap, and survives it', async () => {
    const sql = getDb();
    const guardedId = await seedStaleDevice('worker-auth-guarded');
    // Archived, so the automation itself is NOT what blocks: the auth profile
    // has to be the sole reason this device survives, or the test passes even
    // with the predicate removed.
    const guardedAutomation = await seedAutomationPinnedTo(guardedId, 'auth-guarded');
    await archive(guardedAutomation);
    await sql`
      INSERT INTO auth_profiles
        (organization_id, slug, display_name, profile_kind, connector_key, device_worker_id)
      VALUES
        (${ORG_ID}, 'auth-guarded-profile', 'Guarded', 'env', 'os.shell', ${guardedId})
    `;

    // Identical but for the auth profile, so a reaper that simply does nothing
    // cannot satisfy this test.
    const doomedId = await seedStaleDevice('worker-auth-doomed');
    const doomedAutomation = await seedAutomationPinnedTo(doomedId, 'auth-doomed');
    await archive(doomedAutomation);

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(1);
    expect(await deviceExists(doomedId)).toBe(false);

    expect(await deviceExists(guardedId)).toBe(true);
    expect(await pinOf(guardedAutomation.id)).toBe(guardedId);
    const profiles = (await sql`
      SELECT 1 FROM auth_profiles WHERE device_worker_id = ${guardedId}
    `) as unknown as Array<unknown>;
    expect(profiles.length).toBe(1);
  });
});
