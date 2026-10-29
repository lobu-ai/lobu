/**
 * reconcileDeviceCapabilities: how an advertising device's manifests are wired
 * into connector definitions, connections and feeds.
 *
 * - Config seeding: auto-wired device connections seed `default_connection_config`
 *   exactly like manage_connections create/connect do, so connector settings
 *   survive a reconnect or a replacement device. The same pass must seed new
 *   rows from the org definition default, heal a surviving NULL-config row once
 *   a default exists, and never clobber an explicit per-connection config. No
 *   default → keep writing NULL, so the legacy shape is untouched.
 * - Feed re-arm: the slow wire path must not invent a trigger for a feed that
 *   has no cron, and must not resume a feed auto-paused by sync failures.
 * - Slug race: a device connector whose slug is taken out from under it must
 *   still wire, driven through the real poll endpoint with a forced collision.
 * - Artifact ownership guard: auto-wire into the owner's personal org must
 *   never replace an artifact the org installed with its own code.
 * - Pinned-org refresh: a team org that pins a connection to the device gets
 *   its definition brought up to the advertised version, within strict bounds.
 *
 * Every describe starts from a clean database and seeds its owner through one
 * helper: a user, the personal org it owns, and an owner membership.
 */
import type { DeviceConnectorManifest } from '@lobu/connector-sdk/device-manifest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { applyFeedSyncFailure } from '../../connectors/feed-sync-failure';
import { feedBackoff } from '../../connectors/feed-backoff';
import type { DbClient } from '../../db/client';
import { slugifyConnectionName } from '../../utils/connections';
import logger from '../../utils/logger';
import { deviceManifestHash } from '../../worker-api/device-manifests';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const sql = getTestDb();

/** A user plus the personal org it owns, as signup leaves them. */
async function seedOwner(name = 'Device Owner') {
  const userId = `user_${generateSecureToken(4)}`;
  const personalOrgId = `org-personal-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${name}, ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${personalOrgId}, 'Personal', ${personalOrgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${personalOrgId}, ${userId}, 'owner', NOW())
  `;
  return { userId, personalOrgId };
}

/** The `connector_manifests` map a poll stores for the advertised manifests. */
function advertisedManifests(manifests: DeviceConnectorManifest[]) {
  return Object.fromEntries(
    manifests.map((manifest) => [
      manifest.key,
      {
        manifest,
        manifest_hash: deviceManifestHash(manifest),
        received_at: new Date().toISOString(),
      },
    ]),
  );
}

/** A device advertising `manifests`, exactly as a poll would have stored it. */
async function seedDevice(params: {
  userId: string;
  organizationId: string;
  capabilities: string[];
  manifests: DeviceConnectorManifest[];
  platform?: string;
  appVersion?: string | null;
  label?: string;
}) {
  const workerId = `wk-${generateSecureToken(6)}`;
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, app_version, capabilities, label,
      organization_id, connector_manifests, last_seen_at
    ) VALUES (
      ${params.userId}, ${workerId}, ${params.platform ?? 'macos'},
      ${params.appVersion ?? null}, ${sql.json(params.capabilities)},
      ${params.label ?? 'Test Mac'}, ${params.organizationId},
      ${sql.json(advertisedManifests(params.manifests))}, NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { deviceId: String(row.id), workerId };
}

beforeEach(async () => {
  await cleanupTestDatabase();
});

describe('device reconcile config seeding', () => {
  const CONNECTOR = 'test.device_config_seed';
  const CAPABILITY = 'test_device_config_seed';
  const VERSION = '1.0.0';
  const DEFAULT_CONFIG = { fetch_limit: 25 };

  let orgId: string;
  let userId: string;

  async function seedDefinition(
    defaultConfig: Record<string, unknown> | null,
    feedsSchema: Record<string, unknown> = {},
  ) {
    await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, version, status, required_capability,
        runtime, feeds_schema, auth_schema, actions_schema, options_schema,
        default_connection_config
      ) VALUES (
        ${orgId}, ${CONNECTOR}, 'Test Device Config Seed', ${VERSION}, 'active', ${CAPABILITY},
        ${sql.json({ platforms: ['macos'] })}, ${sql.json(feedsSchema)}, ${sql.json({})},
        ${sql.json({})}, ${sql.json({})}, ${defaultConfig ? sql.json(defaultConfig) : null}
      )
    `;
    // device-manifest connectors install `connector_versions` through
    // upsertConnectorDefinitionRecords; the ready-gate version_key check needs
    // the match present, exactly as the pin-guard harness does.
    await sql`
      INSERT INTO connector_versions (organization_id, connector_key, version)
      VALUES (${orgId}, ${CONNECTOR}, ${VERSION})
      ON CONFLICT DO NOTHING
    `;
  }

  function manifestFor(feeds: Record<string, unknown> = {}): DeviceConnectorManifest {
    if (Object.keys(feeds).length === 0) {
      return {
        key: CONNECTOR,
        version: VERSION,
        name: 'Test Device Config Seed',
        required_capability: CAPABILITY,
        runtime: { platforms: ['macos'] },
        feeds_schema: {},
      } as unknown as DeviceConnectorManifest;
    }
    return {
      key: CONNECTOR,
      version: VERSION,
      name: 'Test Device Config Seed',
      required_capability: CAPABILITY,
      runtime: { platforms: ['macos'] },
      // Mirror the definition row seedDefinition writes so the manifest-matches-
      // source check (and with it the ready fast path) can actually pass —
      // without these the wildcard fields fall back to `{ methods: [...none] }`
      // / null and no poll ever converges to the fast path.
      auth_schema: {},
      actions_schema: {},
      options_schema: {},
      feeds_schema: feeds,
    } as unknown as DeviceConnectorManifest;
  }

  async function seedWorker(feeds: Record<string, unknown> = {}) {
    await seedDevice({
      userId,
      organizationId: orgId,
      capabilities: [CAPABILITY],
      manifests: [manifestFor(feeds)],
      label: 'Mac mini',
    });
  }

  async function seedConn(config: Record<string, unknown> | null): Promise<number> {
    const slug = `conn-${Math.random().toString(36).slice(2, 8)}`;
    const [row] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        auth_profile_id, created_by, visibility, config
      ) VALUES (
        ${orgId}, ${CONNECTOR}, ${slug}, 'Test Device Config Seed', 'active',
        NULL, ${userId}, 'private', ${config ? sql.json(config) : null}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return Number(row.id);
  }

  async function configOf(id: number): Promise<Record<string, unknown> | null> {
    const [row] = (await sql`
      SELECT config FROM connections WHERE id = ${id}
    `) as unknown as Array<{ config: unknown }>;
    if (row == null || row.config == null) return null;
    return typeof row.config === 'string'
      ? JSON.parse(row.config)
      : (row.config as Record<string, unknown>);
  }

  beforeEach(async () => {
    ({ userId, personalOrgId: orgId } = await seedOwner());
  });

  it('creates a connection whose config is seeded from the definition default', async () => {
    await seedDefinition(DEFAULT_CONFIG);
    await seedWorker();

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT id, config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ id: number; config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toEqual(DEFAULT_CONFIG);
  });

  it('seeds an existing NULL-config connection once the definition has a default', async () => {
    await seedDefinition(DEFAULT_CONFIG);
    await seedWorker();
    const id = await seedConn(null);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(DEFAULT_CONFIG);
  });

  it('never clobbers an explicit per-connection config', async () => {
    await seedDefinition(DEFAULT_CONFIG);
    await seedWorker();
    const explicit = { fetch_limit: 50 };
    const id = await seedConn(explicit);

    await reconcileDeviceCapabilities(userId);

    expect(await configOf(id)).toEqual(explicit);
  });

  it('keeps config NULL when the definition has no default', async () => {
    await seedDefinition(null);
    await seedWorker();

    await reconcileDeviceCapabilities(userId);

    const [row] = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
    `) as unknown as Array<{ config: unknown }>;
    expect(row).toBeDefined();
    expect(row.config).toBeNull();
  });

  it('converges without re-wiring when the definition default is wholly feed-scoped', async () => {
    const FEEDS = {
      main: {
        operations: ['sync'],
        configSchema: {
          type: 'object',
          properties: { lookback_days: { type: 'number' } },
        },
      },
    };
    await seedDefinition({ lookback_days: 30 }, FEEDS);
    await seedWorker(FEEDS);

    const info = vi.spyOn(logger, 'info');
    try {
      await reconcileDeviceCapabilities(userId);
      await reconcileDeviceCapabilities(userId);

      const [row] = (await sql`
        SELECT config FROM connections
        WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR} AND deleted_at IS NULL
      `) as unknown as Array<{ config: unknown }>;
      // Feed-scoped defaults never belong on the connection row.
      expect(row).toBeDefined();
      expect(row.config).toBeNull();

      const wired = info.mock.calls.filter(
        (call) => call[1] === '[device-connectors] Wired device connector',
      );
      // Exactly one wire pass. A ready-gate that approximated "default exists"
      // with the raw default instead of the seedable CONNECTION-scoped half
      // spun forever here: NULL config + wholly feed-scoped default re-wired
      // (and re-upserted the definition) on every single poll.
      expect(wired).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});

/**
 * The slow wire path must not invent a trigger for a feed that has no cron.
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
describe('device reconcile feed re-arm', () => {
  const CONNECTOR = 'test.device_feed_rearm';
  const CAPABILITY = 'test_device_feed_rearm';
  const FEED_KEY = 'items';
  const FEEDS_SCHEMA = {
    [FEED_KEY]: { key: FEED_KEY, name: 'Items', operations: ['sync'] },
  };

  let orgId: string;
  let userId: string;
  let workerDbId: string;

  function manifestFor(version: string): DeviceConnectorManifest {
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
    } as unknown as DeviceConnectorManifest;
  }

  async function seedDefinition(version: string) {
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
  async function advertise(version: string) {
    await sql`
      UPDATE device_workers
      SET connector_manifests = ${sql.json(advertisedManifests([manifestFor(version)]))},
          last_seen_at = NOW()
      WHERE id = ${workerDbId}::uuid
    `;
  }

  async function feedRow(): Promise<{
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

  beforeEach(async () => {
    ({ userId, personalOrgId: orgId } = await seedOwner());
    await seedDefinition('1.0.0');
    ({ deviceId: workerDbId } = await seedDevice({
      userId,
      organizationId: orgId,
      capabilities: [CAPABILITY],
      manifests: [manifestFor('1.0.0')],
      label: 'Mac mini',
    }));
  });

  it('arms a syncable feed once when it first wires the connector', async () => {
    await reconcileDeviceCapabilities(userId);
    const feed = await feedRow();
    expect(feed).toBeDefined();
    // The one-shot backfill: without it a newly connected device shows nothing.
    expect(feed.next_run_at).not.toBeNull();
  });

  it('does not re-arm a cron-less feed when the manifest changes', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow();
    await completeRunLeaving(created.id, null);

    // An extension upgrade: new version -> `definitionMatchesSource` fails ->
    // the wire path runs again instead of the pin-only fast path.
    await seedDefinition('2.0.0');
    await advertise('2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow();
    expect(after.schedule).toBeNull();
    // The regression: this used to be stamped NOW(), giving the feed exactly
    // one more sync and hiding a permanently dormant row behind a success.
    expect(after.next_run_at).toBeNull();
  });

  it('still re-arms a feed that carries a cron', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow();
    await completeRunLeaving(created.id, '*/5 * * * *');

    await seedDefinition('2.0.0');
    await advertise('2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow();
    expect(after.schedule).toBe('*/5 * * * *');
    expect(after.next_run_at).not.toBeNull();
  });

  it('does not resume a feed auto-paused by consecutive sync failures', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow();
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
    const paused = await feedRow();
    expect(paused.status).toBe('paused');
    expect(paused.next_run_at).toBeNull();
    expect(paused.consecutive_failures).toBeGreaterThanOrEqual(feedBackoff.pauseThreshold);

    // No manifest change here: the paused feed alone forces the slow wire
    // path, which is exactly the every-poll re-arm this guards against.
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow();
    expect(after.status).toBe('paused');
    expect(after.next_run_at).toBeNull();
  });

  it('re-activates a feed paused only because its capability went away', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow();
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

    const after = await feedRow();
    expect(after.status).toBe('active');
    expect(after.next_run_at).not.toBeNull();
  });

  it('still re-arms an active cron feed that failed below the pause threshold', async () => {
    await reconcileDeviceCapabilities(userId);
    const created = await feedRow();
    await sql`
      UPDATE feeds
      SET schedule = '*/5 * * * *', next_run_at = NULL, consecutive_failures = 3,
          last_sync_status = 'failed'
      WHERE id = ${created.id}
    `;

    await seedDefinition('2.0.0');
    await advertise('2.0.0');
    await reconcileDeviceCapabilities(userId);

    const after = await feedRow();
    expect(after.status).toBe('active');
    expect(after.next_run_at).not.toBeNull();
  });
});

/**
 * A device connector whose slug is taken out from under it must still wire.
 *
 * `ensureDeviceConnectorWired` derives a connection slug from the manifest's
 * display NAME, and `connections_org_slug_unique` enforces uniqueness per ORG —
 * but the advisory lock meant to serialize the wire is keyed on
 * (userId, connectorKey). Lock scope and uniqueness scope are not the same
 * scope, so two DIFFERENT connector keys take two DIFFERENT locks, run
 * concurrently, compute the same free slug, and the loser's INSERT trips the
 * constraint. The source comment asserting this "can't be raced" was wrong.
 *
 * The loser was then absent from `connections` until the next poll. That is how
 * this was found: as an unexplained ~1-in-8 flake in
 * device-connector-manifests.test.ts, where a sibling intermittently failed to
 * install.
 *
 * The regression guard FORCES that interleaving instead of hoping for it: an
 * uncommitted transaction squats on the exact slug the wire is about to
 * compute, and is committed only once the wire's INSERT is observed parked on
 * the unique index. Two live sibling manifests would reproduce it only
 * probabilistically — a 15-round loop still left roughly a 1-in-8 chance of
 * every round missing the collision, i.e. of the pre-fix code passing its own
 * regression test.
 *
 * Driven through the real poll endpoint rather than a hand-built
 * `device_workers` capability set — capabilities are stored in a shape poll
 * owns, and a fixture that guesses it wrong reconciles nothing and passes for
 * the wrong reason (observed: a hand-built row wired zero connectors and still
 * went green). A stubbed rejection would be worse: it would pass against any
 * wrapper and prove nothing about the path that actually fails.
 *
 * Asserts the OUTCOME (wired, with the suffixed slug) rather than a log line,
 * because the fix makes the failure stop happening rather than merely become
 * visible.
 */
describe('device connector slug race', () => {
  const SHARED_NAME = 'Colliding Device Connector';
  /** The slug the wire computes from `SHARED_NAME` when nothing has claimed it. */
  const BASE_SLUG = slugifyConnectionName(SHARED_NAME);
  const SQUATTER_KEY = 'apple.collide_squatter';

  function manifestFor(key: string, capability: string) {
    return {
      key,
      version: '0.1.0',
      // Same display name on both — this is the collision under test.
      name: SHARED_NAME,
      description: 'Device manifest used to force a connection-slug collision.',
      required_capability: capability,
      runtime: { platforms: ['macos'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: {
        snapshots: {
          key: 'snapshots',
          name: 'Snapshots',
          operations: ['sync'],
          configSchema: { type: 'object', properties: {} },
          eventKinds: {
            snapshot: {
              metadataSchema: {
                type: 'object',
                required: ['source', 'origin_id'],
                properties: {
                  source: { type: 'string' },
                  origin_id: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };
  }

  /** A promise plus its resolver, for handing control between two live tasks. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** An owner with one device that has advertised nothing yet; poll does the rest. */
  async function seedFleet() {
    const { userId, personalOrgId: orgId } = await seedOwner('Wire Failure Owner');
    const { workerId } = await seedDevice({
      userId,
      organizationId: orgId,
      capabilities: [],
      manifests: [],
      appVersion: '0.1.0',
      label: 'Colliding Mac',
    });
    return { userId, orgId, workerId };
  }

  function pollManifests(
    workerId: string,
    manifests: Array<ReturnType<typeof manifestFor>>,
  ) {
    return post('/api/workers/poll', {
      body: {
        worker_id: workerId,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Colliding Mac',
        capabilities: { screentime: true, photos: true },
        connector_manifests: manifests,
      },
    });
  }

  /**
   * Resolve once a backend is parked on `blockerPid`'s uncommitted row while
   * inserting into `connections` — i.e. once the slug collision has actually
   * happened. Waiting on this condition rather than on a fixed delay is what
   * makes the collision deterministic: releasing the squatter any earlier would
   * let the wire see the committed row and suffix its slug on the first try,
   * exercising nothing.
   */
  async function waitForWireBlockedOn(blockerPid: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const rows = (await sql`
        SELECT count(*)::int AS blocked
        FROM pg_stat_activity a
        WHERE ${blockerPid}::int = ANY(pg_blocking_pids(a.pid))
          AND a.query ILIKE '%INSERT INTO connections%'
      `) as unknown as Array<{ blocked: number }>;
      if ((rows[0]?.blocked ?? 0) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          'Timed out waiting for the device-connector wire to block on the squatted slug — ' +
            'the wire no longer computes it from the manifest display name, so this test ' +
            'is no longer forcing the collision it claims to force.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('retries the wire when a concurrent insert takes the slug it computed', async () => {
    const { userId, orgId, workerId } = await seedFleet();

    const squatterReady = deferred<number>();
    const releaseSquatter = deferred<void>();

    // Hold an UNCOMMITTED connection on the slug the wire is about to compute.
    // `ensureUniqueConnectionSlug`'s SELECT cannot see it under READ COMMITTED,
    // so the wire computes BASE_SLUG and its INSERT parks on the unique index
    // until this transaction resolves — exactly the interleaving a sibling
    // manifest produces in the field, minus the coin flip.
    const squatter = sql.begin(async (tx) => {
      await tx`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility
        ) VALUES (
          ${orgId}, ${SQUATTER_KEY}, ${BASE_SLUG}, ${SHARED_NAME}, 'active',
          NULL, NULL, NULL, ${userId}, 'private'
        )
      `;
      const pidRows =
        (await tx`SELECT pg_backend_pid()::int AS pid`) as unknown as Array<{
        pid: number;
      }>;
      squatterReady.resolve(pidRows[0].pid);
      await releaseSquatter.promise;
    });

    let status: number;
    try {
      const squatterPid = await squatterReady.promise;
      const polled = pollManifests(workerId, [
        manifestFor('apple.collide_one', 'screentime'),
      ]);
      await waitForWireBlockedOn(squatterPid);
      releaseSquatter.resolve();
      // COMMIT: the parked INSERT wakes into the unique violation.
      await squatter;
      status = (await polled).status;
    } finally {
      // Never leave the squatter's transaction open if the wait above threw.
      releaseSquatter.resolve();
      await squatter.catch(() => {});
    }
    expect(status).toBe(200);

    const conns = (await sql`
      SELECT connector_key, slug FROM connections
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
      ORDER BY connector_key
    `) as unknown as Array<{ connector_key: string; slug: string }>;

    // The connector must be wired. Pre-fix the unique violation escaped the
    // wire and the row was simply absent — that absence is the whole defect,
    // and it is what made an unrelated test flake ~1 run in 8.
    expect(
      conns.map((c) => c.connector_key),
      'the wire lost the slug race and never retried',
    ).toEqual(['apple.collide_one', SQUATTER_KEY]);

    // And the retry must resolve the collision by suffixing against the now
    // visible winner, not by betting on the same slug again.
    expect(
      conns.find((c) => c.connector_key === 'apple.collide_one')?.slug,
    ).toBe(`${BASE_SLUG}-2`);
  }, 60_000);

  it('wires both connectors when two manifests share a display name', async () => {
    const { orgId, workerId } = await seedFleet();

    // The field scenario, end-to-end: two sibling manifests, one display name,
    // both expected to land with distinct slugs. Whether the two wires actually
    // interleave here is up to the scheduler, so this is a smoke check on the
    // real shape of the bug — the forced-collision test above is the guard.
    const res = await pollManifests(workerId, [
      manifestFor('apple.collide_one', 'screentime'),
      manifestFor('apple.collide_two', 'photos'),
    ]);
    expect(res.status).toBe(200);

    const conns = (await sql`
      SELECT connector_key, slug FROM connections
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
      ORDER BY connector_key
    `) as unknown as Array<{ connector_key: string; slug: string }>;

    expect(
      conns.map((c) => c.connector_key),
      'a connector failed to wire',
    ).toEqual(['apple.collide_one', 'apple.collide_two']);
    expect(new Set(conns.map((c) => c.slug)).size, 'slugs collided').toBe(2);
  }, 60_000);
});

/**
 * Auto-wire installs a device connector into its owner's PERSONAL org, and a
 * device-manifest write replaces the whole artifact family rather than merging
 * into it (`replaceVersionArtifact` in `utils/connector-definition-install.ts`).
 *
 * Only `chrome.*` is a reserved namespace. `os.shell`, `apple.*` and
 * `local.directory` are all keys a user may legitimately install with their own
 * source — so a device advertising one of those keys could silently discard
 * those bytes and repoint the definition at a manifest, converting a working
 * code-backed connector into one that only runs while a device is awake.
 *
 * `refreshPinnedOrgDeviceConnectorDefinitions` already declines this in team
 * orgs (`IS_DEVICE_CONNECTOR_SQL`); these cases pin the same bound on the wire
 * path, and — just as important — pin that it does not freeze the wiring it is
 * supposed to do. Ownership is read off the org-scoped row's `source_path`, and
 * off its bytes only when it has no path at all: `resolveConnectorInstallSource`
 * leaves `source_path` NULL for a pasted-`source_code` install, while bytes on a
 * `device-manifest://` row are stale and scrubbing them back to manifest-only is
 * a deliberate invariant.
 */
describe('device auto-wire artifact ownership guard', () => {
  /** Deliberately outside the reserved `chrome.*` namespace — that is the collision. */
  const CONNECTOR_KEY = 'apple.notes_wire_guard';
  const CAPABILITY = 'os.files';
  const ADVERTISED_VERSION = '2.0.0';
  const INSTALLED_VERSION = '1.0.0';
  const ORG_CODE = 'export default { key: "apple.notes_wire_guard" };';
  const ORG_CODE_HASH = 'org-installed-artifact-hash';

  function manifest(version = ADVERTISED_VERSION): DeviceConnectorManifest {
    return {
      key: CONNECTOR_KEY,
      version,
      name: 'Wire Guard Notes',
      description: 'Device manifest used to prove the wire-path artifact guard.',
      required_capability: CAPABILITY,
      runtime: { platforms: ['macos'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: {
        commands: {
          key: 'commands',
          name: 'Commands',
          operations: ['sync'],
          eventKinds: { command: {} },
        },
      },
    };
  }

  async function seedAdvertisingDevice(userId: string, personalOrgId: string) {
    const advertised = manifest();
    const { deviceId } = await seedDevice({
      userId,
      organizationId: personalOrgId,
      capabilities: [CAPABILITY],
      manifests: [advertised],
      appVersion: '0.8.1',
    });
    return { deviceId, manifestHash: deviceManifestHash(advertised) };
  }

  /**
   * An existing personal-org definition under the same key. `artifact: 'code'` is
   * the shape a `source_uri` / `source_url` install leaves behind;
   * `'code-without-source-path'` is the shape a pasted-`source_code` install
   * leaves behind (`resolveConnectorInstallSource` derives a path from neither);
   * `'manifest'` is the shape device reconciliation itself installs;
   * `'manifest-with-stale-bytes'` is a device row that picked up compiled/source
   * bytes it must not keep; `'empty-marker'` is the content-empty preserve record
   * a rollback leaves behind, which owns nothing.
   */
  async function seedInstalledConnector(
    organizationId: string,
    {
      artifact,
    }: {
      artifact:
        | 'code'
        | 'code-without-source-path'
        | 'manifest'
        | 'manifest-with-stale-bytes'
        | 'empty-marker';
    },
  ) {
    const isCode = artifact === 'code' || artifact === 'code-without-source-path';
    const staleBytes = artifact === 'manifest-with-stale-bytes';
    await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, description, version, auth_schema, feeds_schema,
        status, required_capability, created_at, updated_at
      ) VALUES (
        ${organizationId}, ${CONNECTOR_KEY}, 'Wire Guard Notes', 'installed',
        ${INSTALLED_VERSION}, ${sql.json({ methods: [{ type: 'none' }] })}, ${sql.json({})},
        'active', ${isCode ? null : CAPABILITY}, NOW(), NOW()
      )
    `;
    await sql`
      INSERT INTO connector_versions (
        connector_key, version, organization_id, compiled_code, compiled_code_hash,
        compile_config_hash, source_code, source_path
      ) VALUES (
        ${CONNECTOR_KEY}, ${INSTALLED_VERSION}, ${organizationId},
        ${isCode || staleBytes ? ORG_CODE : null},
        ${artifact === 'empty-marker' ? null : ORG_CODE_HASH}, NULL,
        ${isCode || staleBytes ? ORG_CODE : null},
        ${
          artifact === 'code'
            ? 'org-install'
            : artifact === 'code-without-source-path' || artifact === 'empty-marker'
              ? null
              : `device-manifest://macos/${CONNECTOR_KEY}@${INSTALLED_VERSION}`
        }
      )
    `;
  }

  async function readDefinition(organizationId: string) {
    const rows = (await sql`
      SELECT cd.version,
             cv.compiled_code_hash AS artifact_hash,
             cv.compiled_code IS NOT NULL AS has_compiled_code,
             cv.source_code IS NOT NULL AS has_source_code,
             cv.source_path
      FROM connector_definitions cd
      LEFT JOIN LATERAL (
        SELECT v.compiled_code, v.compiled_code_hash, v.source_code, v.source_path
        FROM connector_versions v
        WHERE v.connector_key = cd.key
          AND v.version = cd.version
          AND (v.organization_id = cd.organization_id OR v.organization_id IS NULL)
        ORDER BY v.organization_id NULLS LAST
        LIMIT 1
      ) cv ON TRUE
      WHERE cd.organization_id = ${organizationId}
        AND cd.key = ${CONNECTOR_KEY}
        AND cd.status = 'active'
      LIMIT 1
    `) as unknown as Array<{
      version: string;
      artifact_hash: string | null;
      has_compiled_code: boolean;
      has_source_code: boolean;
      source_path: string | null;
    }>;
    return rows[0] ?? null;
  }

  it('never wires over an artifact the org installed with its own code', async () => {
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(personalOrgId);
    expect(untouched?.version).toBe(INSTALLED_VERSION);
    expect(untouched?.artifact_hash).toBe(ORG_CODE_HASH);
    expect(untouched?.has_compiled_code).toBe(true);
    expect(untouched?.has_source_code).toBe(true);
  });

  it('never wires over inline source installed with no source_path', async () => {
    // `resolveConnectorInstallSource` derives `source_path` only from
    // `source_uri` / `source_url`; pasting `source_code` — the commonest custom
    // install — stores bytes with a NULL path. Reading ownership off the path
    // alone would wire straight over exactly that artifact.
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code-without-source-path' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(personalOrgId);
    expect(untouched?.version).toBe(INSTALLED_VERSION);
    expect(untouched?.artifact_hash).toBe(ORG_CODE_HASH);
    expect(untouched?.has_compiled_code).toBe(true);
    expect(untouched?.has_source_code).toBe(true);
    expect(untouched?.source_path).toBeNull();
  });

  it('leaves the org-installed connection alone rather than adopting it', async () => {
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'code' });
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, display_name, status, config, slug,
        created_at, updated_at
      ) VALUES (
        ${personalOrgId}, ${CONNECTOR_KEY}, 'Hand-built shell', 'active',
        ${sql.json({})}, ${`shell-${generateSecureToken(4)}`}, NOW(), NOW()
      )
    `;

    await reconcileDeviceCapabilities(userId, deviceId);

    // A guarded pass must not pin the user's own connection to the device
    // either — the definition it would execute against is not the manifest.
    const [connection] = (await sql`
      SELECT device_worker_id FROM connections
      WHERE organization_id = ${personalOrgId} AND connector_key = ${CONNECTOR_KEY}
        AND deleted_at IS NULL
    `) as unknown as Array<{ device_worker_id: string | null }>;
    expect(connection?.device_worker_id).toBeNull();
    expect((await readDefinition(personalOrgId))?.has_compiled_code).toBe(true);
  });

  it('still upgrades a definition device reconciliation itself installed', async () => {
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'manifest' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const refreshed = await readDefinition(personalOrgId);
    expect(refreshed?.version).toBe(ADVERTISED_VERSION);
    // Readiness compares this exact slot against the device's claim.
    expect(refreshed?.artifact_hash).toBe(manifestHash);
    expect(refreshed?.has_compiled_code).toBe(false);
  });

  it('still reconciles stale bytes sitting on a device-manifest row', async () => {
    // A row that HAS a path is judged on that path alone. Bytes on a
    // `device-manifest://` row are stale — a manifest hash must never attest
    // compiled bytes — so the row stays reconcilable. A guard that consulted
    // bytes even when a path is present would wrongly freeze it here.
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'manifest-with-stale-bytes' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const reconciled = await readDefinition(personalOrgId);
    expect(reconciled?.version).toBe(ADVERTISED_VERSION);
    expect(reconciled?.artifact_hash).toBe(manifestHash);
    expect(reconciled?.has_compiled_code).toBe(false);
    expect(reconciled?.has_source_code).toBe(false);
  });

  it('still reconciles a content-empty rollback marker row', async () => {
    // The preserve record a rollback leaves (no path, no bytes) is not org code
    // and must stay wireable: refusing it would freeze the definition with no
    // self-service repair.
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedInstalledConnector(personalOrgId, { artifact: 'empty-marker' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const reconciled = await readDefinition(personalOrgId);
    expect(reconciled?.version).toBe(ADVERTISED_VERSION);
    expect(reconciled?.artifact_hash).toBe(manifestHash);
    expect(reconciled?.source_path).toMatch(/^device-manifest:\/\//);
  });

  it('still performs a first install when the org has no definition at all', async () => {
    const { userId, personalOrgId } = await seedOwner('Wire Guard Owner');
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);

    await reconcileDeviceCapabilities(userId, deviceId);

    const installed = await readDefinition(personalOrgId);
    expect(installed?.version).toBe(ADVERTISED_VERSION);
    expect(installed?.artifact_hash).toBe(manifestHash);
    expect(installed?.source_path).toMatch(/^device-manifest:\/\//);
  });
});

/**
 * A team org reaches a device by PINNING a connection to it, and that pin is
 * the consent claim scope follows (`resolveDeviceClaimableOrgs`). Definition
 * reconciliation did not follow it: it targets the owner's personal org only,
 * so a pinned org stayed on whatever `connector_definitions` row it was created
 * with while the fleet moved on. Readiness compares the org's selected artifact
 * against the exact version/hash the device advertises, so the drift made the
 * pin permanently unrunnable and no self-service path repaired it.
 *
 * These cases pin the repair AND its bounds: it must never invent a connector
 * in an org that does not already pin one, never reach an org the owner has
 * left, never resurrect a deleted connection's definition, and never replace an
 * artifact the org installed with its own code.
 */
describe('pinned-org device connector definition refresh', () => {
  const CONNECTOR_KEY = 'chrome.pinned_org_refresh';
  const CAPABILITY = 'browser.history';
  const ADVERTISED_VERSION = '0.4.0';
  const STALE_VERSION = '0.2.0';
  const STALE_ARTIFACT_HASH = 'stale-manifest-hash';

  function manifest(version = ADVERTISED_VERSION): DeviceConnectorManifest {
    return {
      key: CONNECTOR_KEY,
      version,
      name: 'Pinned Org Refresh',
      description: 'Chrome-extension manifest used to prove pinned-org refresh.',
      required_capability: CAPABILITY,
      runtime: { platforms: ['chrome-extension'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: {
        messages: {
          key: 'messages',
          name: 'Messages',
          operations: ['sync'],
          eventKinds: { message: {} },
        },
      },
    };
  }

  async function seedTeamOrg(userId: string, { asMember = true } = {}) {
    const teamOrgId = `org-team-${generateSecureToken(4)}`;
    await sql`
      INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
      VALUES (${teamOrgId}, 'Team', ${teamOrgId}, 'private', ${sql.json({})}, NOW())
    `;
    if (asMember) {
      await sql`
        INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
        VALUES (${`mem_${generateSecureToken(4)}`}, ${teamOrgId}, ${userId}, 'admin', NOW())
      `;
    }
    return teamOrgId;
  }

  async function seedAdvertisingDevice(userId: string, personalOrgId: string) {
    const advertised = manifest();
    const { deviceId } = await seedDevice({
      userId,
      organizationId: personalOrgId,
      capabilities: [CAPABILITY],
      manifests: [advertised],
      platform: 'chrome-extension',
      appVersion: '0.8.1',
      label: 'Test Extension',
    });
    return { deviceId, manifestHash: deviceManifestHash(advertised) };
  }

  /**
   * A team-org connector frozen at an old version, plus the pin that consents to
   * it. `artifact` is what the org's selected `connector_versions` row carries:
   * 'manifest' is the shape device reconciliation installs, 'code' is an org's
   * own `install_connector` bytes under the same key.
   */
  async function seedStaleTeamConnector(
    teamOrgId: string,
    deviceId: string | null,
    {
      deleted = false,
      artifact = 'manifest',
    }: { deleted?: boolean; artifact?: 'manifest' | 'code' } = {},
  ) {
    await sql`
      INSERT INTO connector_definitions (
        organization_id, key, name, description, version, auth_schema, feeds_schema,
        status, required_capability, created_at, updated_at
      ) VALUES (
        ${teamOrgId}, ${CONNECTOR_KEY}, 'Pinned Org Refresh', 'stale', ${STALE_VERSION},
        ${sql.json({ methods: [{ type: 'none' }] })}, ${sql.json({})},
        'active', ${CAPABILITY}, NOW(), NOW()
      )
    `;
    await sql`
      INSERT INTO connector_versions (
        connector_key, version, organization_id, compiled_code, compiled_code_hash,
        compile_config_hash, source_code, source_path
      ) VALUES (
        ${CONNECTOR_KEY}, ${STALE_VERSION}, ${teamOrgId},
        ${artifact === 'code' ? 'export default {};' : null}, ${STALE_ARTIFACT_HASH},
        NULL, ${artifact === 'code' ? 'export default {};' : null},
        ${
          artifact === 'code'
            ? 'org-install'
            : `device-manifest://chrome-extension/${CONNECTOR_KEY}@${STALE_VERSION}`
        }
      )
    `;
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, display_name, status, config,
        device_worker_id, slug, created_at, updated_at, deleted_at
      ) VALUES (
        ${teamOrgId}, ${CONNECTOR_KEY}, 'Team pin', 'active', ${sql.json({})},
        ${deviceId === null ? null : sql`${deviceId}::uuid`},
        ${`pin-${generateSecureToken(4)}`}, NOW(), NOW(),
        ${deleted ? sql`NOW()` : null}
      )
    `;
  }

  async function readDefinition(orgId: string) {
    const rows = (await sql`
      SELECT cd.version,
             (
               SELECT cv.compiled_code_hash
               FROM connector_versions cv
               WHERE cv.organization_id = ${orgId}
                 AND cv.connector_key = ${CONNECTOR_KEY}
                 AND cv.version = cd.version
               LIMIT 1
             ) AS artifact_hash
      FROM connector_definitions cd
      WHERE cd.organization_id = ${orgId}
        AND cd.key = ${CONNECTOR_KEY}
        AND cd.status = 'active'
      LIMIT 1
    `) as unknown as Array<{ version: string; artifact_hash: string | null }>;
    return rows[0] ?? null;
  }

  it('brings a pinned team org up to the version the device advertises', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);

    await reconcileDeviceCapabilities(userId, deviceId);

    const refreshed = await readDefinition(teamOrgId);
    expect(refreshed?.version).toBe(ADVERTISED_VERSION);
    // Readiness compares this exact slot against the device's claim.
    expect(refreshed?.artifact_hash).toBe(manifestHash);
  });

  it('leaves a team org that pins no device untouched', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    // Definition + connection exist, but the connection pins no device, so the
    // org never consented to this fleet.
    await seedStaleTeamConnector(teamOrgId, null);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });

  it('refreshes an owned pin even when old connections make its workspace a cleanup target', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId, manifestHash } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId);
    await sql`
      UPDATE connections SET created_by = ${userId}
      WHERE organization_id = ${teamOrgId} AND connector_key = ${CONNECTOR_KEY}
    `;

    await reconcileDeviceCapabilities(userId, deviceId);

    expect(await readDefinition(teamOrgId)).toMatchObject({
      version: ADVERTISED_VERSION, artifact_hash: manifestHash,
    });
  });

  it('never invents a connector in an org that has no connection for it', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect(await readDefinition(teamOrgId)).toBeNull();
  });

  it('does not reach an org the owner is no longer a member of', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId, { asMember: false });
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId);

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });

  it("never replaces an artifact the org installed with its own code", async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    // A device manifest is not always in a reserved namespace — `os.shell`,
    // `apple.*` and `local.directory` are keys an org may also install with its
    // own bytes. A device-manifest write replaces the whole artifact family, so
    // the repair has to leave those alone.
    await seedStaleTeamConnector(teamOrgId, deviceId, { artifact: 'code' });

    await reconcileDeviceCapabilities(userId, deviceId);

    const untouched = await readDefinition(teamOrgId);
    expect(untouched?.version).toBe(STALE_VERSION);
    expect(untouched?.artifact_hash).toBe(STALE_ARTIFACT_HASH);
  });

  it('does not refresh on the strength of a deleted connection', async () => {
    const { userId, personalOrgId } = await seedOwner('Pinned Org Owner');
    const teamOrgId = await seedTeamOrg(userId);
    const { deviceId } = await seedAdvertisingDevice(userId, personalOrgId);
    await seedStaleTeamConnector(teamOrgId, deviceId, { deleted: true });

    await reconcileDeviceCapabilities(userId, deviceId);

    expect((await readDefinition(teamOrgId))?.version).toBe(STALE_VERSION);
  });
});
