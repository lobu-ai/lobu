/**
 * reconcileDeviceCapabilities — the slow wire path must not invent a trigger
 * for a feed that has no cron.
 *
 * `CheckDueFeeds` selects on `next_run_at <= now`, and after #2021 a feed with
 * no `schedule` is manual: `run-lifecycle` deliberately leaves `next_run_at`
 * NULL when such a run completes. Auto-wire's re-arm then stamped NOW() over
 * that NULL every time the wire path ran — which the `ready` fast path skips
 * until the manifest hash changes, so the feed resynced once per extension
 * version and looked healthy in between (every run `completed`, so no failure
 * signal, no backoff, no auto-pause).
 *
 * Measured on prod 2026-09-03: chrome `tab_events` and `watch_observations`
 * had 9 sync runs since 2026-08-04 while their cron'd siblings (`visits`,
 * `bookmarks`, `downloads`) had 5,449 / 5,530 / 5,445.
 *
 * A feed that DOES carry a cron keeps the re-arm: there NULL means auto-paused
 * or cleared, and resuming its cadence is the documented self-heal.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyFeedSyncFailure } from '../../connectors/feed-sync-failure';
import { feedBackoff } from '../../connectors/feed-backoff';
import type { DbClient } from '../../db/client';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.device_feed_rearm';
const CAPABILITY = 'test_device_feed_rearm';
const FEED_KEY = 'items';

const FEEDS_SCHEMA = {
  [FEED_KEY]: { key: FEED_KEY, name: 'Items', operations: ['sync'] },
};

function manifestFor(version: string) {
  return {
    key: CONNECTOR,
    version,
    name: 'Test Device Feed Rearm',
    required_capability: CAPABILITY,
    runtime: { platforms: ['macos'] },
    auth_schema: {},
    actions_schema: {},
    options_schema: {},
    feeds_schema: FEEDS_SCHEMA,
  };
}

async function seedDefinition(orgId: string, version: string) {
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Device Feed Rearm', ${version}, 'active', ${CAPABILITY},
      ${sql.json({ platforms: ['macos'] })}, ${sql.json(FEEDS_SCHEMA)}, ${sql.json({})},
      ${sql.json({})}, ${sql.json({})}
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO connector_versions (organization_id, connector_key, version)
    VALUES (${orgId}, ${CONNECTOR}, ${version})
    ON CONFLICT DO NOTHING
  `;
}

/** Publish `version` as the device's advertised manifest, as an app upgrade would. */
async function advertise(workerDbId: string, version: string) {
  const manifest = manifestFor(version);
  const manifests = {
    [CONNECTOR]: {
      manifest,
      manifest_hash: deviceManifestHash(manifest as unknown as DeviceConnectorManifest),
      received_at: new Date().toISOString(),
    },
  };
  await sql`
    UPDATE device_workers
    SET connector_manifests = ${sql.json(manifests)}, last_seen_at = NOW()
    WHERE id = ${workerDbId}::uuid
  `;
}

async function seedWorker(userId: string, orgId: string, version: string): Promise<string> {
  const manifest = manifestFor(version);
  const manifests = {
    [CONNECTOR]: {
      manifest,
      manifest_hash: deviceManifestHash(manifest as unknown as DeviceConnectorManifest),
      received_at: new Date().toISOString(),
    },
  };
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${userId}, ${`mac-${Math.random().toString(36).slice(2, 10)}`}, 'macos',
      ${sql.json([CAPABILITY])}, 'Mac mini', ${orgId}, NOW(), ${sql.json(manifests)}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function feedRow(orgId: string): Promise<{
  id: number;
  status: string;
  schedule: string | null;
  next_run_at: Date | null;
  consecutive_failures: number;
}> {
  const [row] = (await sql`
    SELECT f.id, f.status, f.schedule, f.next_run_at, f.consecutive_failures
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.connector_key = ${CONNECTOR}
      AND c.organization_id = ${orgId}
      AND f.feed_key = ${FEED_KEY}
      AND f.deleted_at IS NULL
  `) as unknown as Array<{ id: number; status: string; schedule: string | null; next_run_at: Date | null; consecutive_failures: number }>;
  return { ...row, consecutive_failures: Number(row.consecutive_failures ?? 0) };
}

/** The state `run-lifecycle` leaves after a manual feed's run completes. */
async function completeRunLeaving(feedId: number, schedule: string | null) {
  await sql`
    UPDATE feeds
    SET schedule = ${schedule}, next_run_at = NULL, last_sync_at = NOW(),
        last_sync_status = 'success'
    WHERE id = ${feedId}
  `;
}

async function setUpOrg(): Promise<{ orgId: string; userId: string }> {
  const user = await createTestUser();
  const org = await createTestOrganization();
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
    WHERE id = ${org.id}
  `;
  return { orgId: org.id, userId: user.id };
}

describe('device reconcile feed re-arm', () => {
  let orgId: string;
  let userId: string;
  let workerDbId: string;

  beforeEach(async () => {
    ({ orgId, userId } = await setUpOrg());
    await seedDefinition(orgId, '1.0.0');
    workerDbId = await seedWorker(userId, orgId, '1.0.0');
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('arms a syncable feed once when it first wires the connector', async () => {
    await reconcileDeviceCapabilities(userId);
    const feed = await feedRow(orgId);
    expect(feed).toBeDefined();
    // The one-shot backfill: without it a newly connected device shows nothing.
    expect(feed.next_run_at).not.toBeNull();
  });

  it('does not re-arm a cron-less feed when the manifest changes', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow(orgId);
    await completeRunLeaving(created.id, null);

    // An extension upgrade: new version -> `definitionMatchesSource` fails ->
    // the wire path runs again instead of the pin-only fast path.
    await seedDefinition(orgId, '2.0.0');
    await advertise(workerDbId, '2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow(orgId);
    expect(after.schedule).toBeNull();
    // The regression: this used to be stamped NOW(), giving the feed exactly
    // one more sync and hiding a permanently dormant row behind a success.
    expect(after.next_run_at).toBeNull();
  });

  it('still re-arms a feed that carries a cron', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow(orgId);
    await completeRunLeaving(created.id, '*/5 * * * *');

    await seedDefinition(orgId, '2.0.0');
    await advertise(workerDbId, '2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow(orgId);
    expect(after.schedule).toBe('*/5 * * * *');
    expect(after.next_run_at).not.toBeNull();
  });

  it('does not resume a feed auto-paused by consecutive sync failures', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow(orgId);
    // A cron'd feed, so the old self-heal would have re-armed it: NULL means
    // "auto-paused / cleared" on that path. Prod: chrome `downloads`, 422 on
    // every sync, re-armed by every device reconcile until the pause stuck.
    await sql`
      UPDATE feeds SET schedule = '*/5 * * * *', next_run_at = NOW()
      WHERE id = ${created.id}
    `;
    for (let i = 0; i < feedBackoff.pauseThreshold; i++) {
      await applyFeedSyncFailure(sql as unknown as DbClient, {
        feedId: created.id,
        errorMessage: 'Request failed with status 422',
        runId: 999001 + i,
      });
    }
    const paused = await feedRow(orgId);
    expect(paused.status).toBe('paused');
    expect(paused.next_run_at).toBeNull();
    expect(paused.consecutive_failures).toBeGreaterThanOrEqual(feedBackoff.pauseThreshold);

    // No manifest change here: the paused feed alone forces the slow wire
    // path, which is exactly the every-poll re-arm this guards against.
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow(orgId);
    expect(after.status).toBe('paused');
    expect(after.next_run_at).toBeNull();
  });

  it('re-activates a feed paused only because its capability went away', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow(orgId);
    // What `pauseStaleDeviceFeeds` leaves behind: status='paused' with the
    // failure counters untouched (consecutive_failures 0), e.g. the laptop
    // was asleep or offline. The wire path must still resume it when the
    // capability comes back.
    await sql`
      UPDATE feeds
      SET schedule = '*/5 * * * *', status = 'paused', next_run_at = NULL,
          consecutive_failures = 0, first_failure_at = NULL
      WHERE id = ${created.id}
    `;

    // No manifest change here either: the paused feed alone forces the slow
    // wire path, which is the capability-return re-activation.
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow(orgId);
    expect(after.status).toBe('active');
    expect(after.next_run_at).not.toBeNull();
  });

  it('still re-arms an active cron feed that failed below the pause threshold', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow(orgId);
    await sql`
      UPDATE feeds
      SET schedule = '*/5 * * * *', next_run_at = NULL, consecutive_failures = 3,
          last_sync_status = 'failed'
      WHERE id = ${created.id}
    `;

    await seedDefinition(orgId, '2.0.0');
    await advertise(workerDbId, '2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow(orgId);
    expect(after.status).toBe('active');
    expect(after.next_run_at).not.toBeNull();
  });
});
