/**
 * Scheduled feed materialization must respect the liveness of a connection's
 * pinned device. An offline device cannot claim the run, so queueing one only
 * produces a run that ages into a worker_claim_timeout dispatch failure. The
 * feed stays overdue while the device is offline and is materialized as soon
 * as that device polls again.
 *
 * Only EXECUTION pins defer. A chrome-extension pin on a non-chrome connector
 * is browser affinity — worker-api/poll.ts keeps that parent sync on the fleet
 * and refuses it on the extension's own claim lane — so those feeds keep
 * syncing while the browser is closed.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../index';
import {
  type DueFeedClaimContext,
  materializeDueFeeds,
} from '../../scheduled/check-due-feeds';
import { getSchedulerHealth } from '../../scheduled/scheduler-health';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../../utils/device-liveness';
import logger from '../../utils/logger';
import { pollWorkerJob } from '../../worker-api/poll';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

describe('scheduled feed device liveness', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('defers only an offline execution pin, and only until that device polls again', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: 'Device Feed Scheduler Org',
    });

    async function createDevice(
      label: string,
      staleSeconds: number,
      platform: 'macos' | 'chrome-extension' | null = 'macos'
    ): Promise<string> {
      const [device] = (await sql`
        INSERT INTO device_workers (
          user_id, worker_id, platform, capabilities, label,
          organization_id, last_seen_at
        ) VALUES (
          ${user.id}, ${`worker-${label}`}, ${platform}, ${sql.json([])},
          ${label}, ${org.id},
          current_timestamp - make_interval(secs => ${staleSeconds})
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return device.id;
    }

    async function createDueFeed(connectorKey: string, deviceId?: string): Promise<number> {
      await createTestConnectorDefinition({
        key: connectorKey,
        name: connectorKey,
        feeds_schema: { items: { description: 'Items', operations: ['sync'] } },
        organization_id: org.id,
      });
      const connection = await createTestConnection({
        organization_id: org.id,
        connector_key: connectorKey,
        created_by: user.id,
        createDefaultFeed: false,
      });
      if (deviceId) {
        await sql`
          UPDATE connections
          SET device_worker_id = ${deviceId}::uuid
          WHERE id = ${connection.id}
        `;
      }
      const [feed] = (await sql`
        INSERT INTO feeds (
          organization_id, connection_id, feed_key, status,
          schedule, next_run_at, created_at, updated_at
        ) VALUES (
          ${org.id}, ${connection.id}, 'items', 'active',
          '* * * * *', current_timestamp - INTERVAL '5 minutes',
          current_timestamp, current_timestamp
        )
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(feed.id);
    }

    const staleDeviceId = await createDevice('Stale Mac', DEVICE_ONLINE_WINDOW_SECONDS + 60);
    const onlineDeviceId = await createDevice('Online Mac', 5);
    const staleBrowserId = await createDevice(
      'Closed Chrome',
      DEVICE_ONLINE_WINDOW_SECONDS + 60,
      'chrome-extension'
    );
    const staleLegacyDeviceId = await createDevice(
      'Legacy Device',
      DEVICE_ONLINE_WINDOW_SECONDS + 60,
      null
    );
    const staleFeedId = await createDueFeed('test.scheduler-stale-device', staleDeviceId);
    const onlineFeedId = await createDueFeed('test.scheduler-online-device', onlineDeviceId);
    const affinityFeedId = await createDueFeed('test.scheduler-affinity', staleBrowserId);
    await createDueFeed('test.scheduler-legacy-device', staleLegacyDeviceId);
    const unpinnedFeedId = await createDueFeed('test.scheduler-unpinned');
    const [staleBefore] = await sql`
      SELECT next_run_at FROM feeds WHERE id = ${staleFeedId}
    `;

    const firstPass = await materializeDueFeeds({} as Env, sql);
    expect(firstPass).toEqual({ dueFeeds: 3, runsCreated: 3, skipped: 0 });

    const firstRuns = (await sql`
      SELECT feed_id FROM runs
      WHERE run_type = 'sync'
      ORDER BY feed_id
    `) as unknown as Array<{ feed_id: number }>;
    expect(firstRuns.map((run) => Number(run.feed_id))).toEqual(
      [onlineFeedId, affinityFeedId, unpinnedFeedId].sort((a, b) => a - b)
    );

    const [staleDeferred] = await sql`
      SELECT next_run_at, last_sync_status
      FROM feeds
      WHERE id = ${staleFeedId}
    `;
    expect(new Date(String(staleDeferred.next_run_at)).getTime()).toBe(
      new Date(String(staleBefore.next_run_at)).getTime()
    );
    expect(staleDeferred.last_sync_status).toBeNull();

    const manifestFeedId = await createDueFeed('local.directory');
    await sql`
      UPDATE connector_definitions
      SET required_capability = 'local_directory',
          runtime = ${sql.json({ platforms: ['macos'] })}
      WHERE organization_id = ${org.id} AND key = 'local.directory'
    `;
    await sql`
      INSERT INTO connector_versions (
        organization_id, connector_key, version, compiled_code,
        compiled_code_hash, compile_config_hash, source_code, source_path, created_at
      ) VALUES (
        ${org.id}, 'local.directory', '1.0.0', NULL,
        'mac-directory-manifest-hash', NULL, NULL,
        'device-manifest://macos/local.directory@1.0.0', NOW()
      )
      ON CONFLICT DO NOTHING
    `;
    await sql`
      UPDATE connector_versions
      SET compiled_code = NULL,
          compiled_code_hash = 'mac-directory-manifest-hash',
          compile_config_hash = NULL,
          source_code = NULL,
          source_path = 'device-manifest://macos/local.directory@1.0.0'
      WHERE connector_key = 'local.directory' AND version = '1.0.0'
        AND organization_id = ${org.id}
    `;
    await sql`
      UPDATE feeds
      SET pinned_version = '1.0.0'
      WHERE id = ${manifestFeedId}
    `;
    await sql`
      UPDATE connector_definitions
      SET version = '2.0.0'
      WHERE organization_id = ${org.id} AND key = 'local.directory'
    `;

    // A deferred feed sits past next_run_at for as long as its device is away,
    // so /health/scheduler must not read that as a stalled scheduler. The
    // manifest feed is pinned to its historical artifact while the active
    // definition has moved on; its device-only placement must still be
    // deferred from source-health counts.
    await sql`
      UPDATE feeds
      SET next_run_at = current_timestamp - INTERVAL '2 hours'
      WHERE id IN (${staleFeedId}, ${onlineFeedId}, ${manifestFeedId})
    `;
    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.overdueFeeds).toBe(1);
    expect(health.metrics.overdueByHours).toBeGreaterThan(1);
    expect(health.issues.filter((issue) => issue.includes('overdue'))).toHaveLength(1);

    // Restore the online feed's materialized schedule before checking that the
    // newly-live stale device alone becomes eligible on the next pass.
    await sql`
      UPDATE feeds
      SET next_run_at = current_timestamp + INTERVAL '1 hour'
      WHERE id IN (${onlineFeedId}, ${manifestFeedId})
    `;

    await sql`
      UPDATE device_workers
      SET last_seen_at = current_timestamp
      WHERE id = ${staleDeviceId}::uuid
    `;
    const refreshedPass = await materializeDueFeeds({} as Env, sql);
    expect(refreshedPass).toEqual({ dueFeeds: 1, runsCreated: 1, skipped: 0 });

    const finalRuns = (await sql`
      SELECT feed_id, COUNT(*)::int AS count
      FROM runs
      WHERE run_type = 'sync'
      GROUP BY feed_id
      ORDER BY feed_id
    `) as unknown as Array<{ feed_id: number; count: number }>;
    expect(
      Object.fromEntries(finalRuns.map((run) => [Number(run.feed_id), Number(run.count)]))
    ).toEqual({
      [staleFeedId]: 1,
      [onlineFeedId]: 1,
      [affinityFeedId]: 1,
      [unpinnedFeedId]: 1,
    });
  });

  it('materializes one due feed only when the current idle poller can claim it', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: 'Poll Scoped Feed Scheduler Org',
    });

    async function createDevice(
      workerId: string,
      platform: 'macos' | 'chrome-extension',
      capabilities: string[]
    ): Promise<string> {
      const [device] = (await sql`
        INSERT INTO device_workers (
          user_id, worker_id, platform, capabilities, label,
          organization_id, last_seen_at
        ) VALUES (
          ${user.id}, ${workerId}, ${platform}, ${sql.json(capabilities)},
          ${workerId}, ${org.id}, current_timestamp
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return device.id;
    }

    async function createDueFeed(options: {
      connectorKey: string;
      deviceId?: string;
      requiredCapability?: string;
    }): Promise<number> {
      await createTestConnectorDefinition({
        key: options.connectorKey,
        name: options.connectorKey,
        feeds_schema: { items: { description: 'Items', operations: ['sync'] } },
        organization_id: org.id,
      });
      if (options.requiredCapability) {
        await sql`
          UPDATE connector_definitions
          SET required_capability = ${options.requiredCapability}
          WHERE key = ${options.connectorKey}
            AND organization_id = ${org.id}
        `;
      }
      const connection = await createTestConnection({
        organization_id: org.id,
        connector_key: options.connectorKey,
        created_by: user.id,
        createDefaultFeed: false,
      });
      if (options.deviceId) {
        await sql`
          UPDATE connections
          SET device_worker_id = ${options.deviceId}::uuid
          WHERE id = ${connection.id}
        `;
      }
      const [feed] = (await sql`
        INSERT INTO feeds (
          organization_id, connection_id, feed_key, status,
          schedule, next_run_at, created_at, updated_at
        ) VALUES (
          ${org.id}, ${connection.id}, 'items', 'active',
          '* * * * *', current_timestamp - INTERVAL '5 minutes',
          current_timestamp, current_timestamp
        )
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(feed.id);
    }

    const macDeviceId = await createDevice('poll-scoped-mac', 'macos', ['os.shell']);
    const chromeDeviceId = await createDevice('poll-scoped-chrome', 'chrome-extension', [
      'browser.history',
    ]);
    const macPinnedFeedId = await createDueFeed({
      connectorKey: 'test.poll-scoped.mac',
      deviceId: macDeviceId,
    });
    const chromePinnedFeedId = await createDueFeed({
      connectorKey: 'chrome.history',
      deviceId: chromeDeviceId,
    });
    const browserAffinityFeedId = await createDueFeed({
      connectorKey: 'test.poll-scoped.affinity',
      deviceId: chromeDeviceId,
    });
    const fleetFeedId = await createDueFeed({
      connectorKey: 'test.poll-scoped.fleet',
    });
    const brokenFleetFeedId = await createDueFeed({
      connectorKey: 'test.poll-scoped.broken-fleet',
    });
    await sql`
      DELETE FROM connector_versions
      WHERE connector_key = 'test.poll-scoped.broken-fleet'
    `;
    await sql`
      UPDATE feeds
      SET next_run_at = current_timestamp - INTERVAL '10 minutes'
      WHERE id = ${brokenFleetFeedId}
    `;
    const capabilityFeedId = await createDueFeed({
      connectorKey: 'test.poll-scoped.capability',
      requiredCapability: 'os.shell',
    });
    const healthBeforePoll = await getSchedulerHealth({} as Env);
    expect(healthBeforePoll.metrics.activeFeeds).toBe(6);
    expect(healthBeforePoll.metrics.overdueFeeds).toBe(5);
    const fleetContext: DueFeedClaimContext = {
      isUserScopedWorker: false,
      deviceWorkerId: null,
      workerPlatform: null,
      authorizedCapabilities: [],
      capabilityMatchSet: [''],
      manifestClaimAuthorizations: [],
      allowLegacyManifestCapabilityClaims: false,
      orgScopeIds: [''],
      baseOrgScopeIds: [''],
      workerHardensDbEgress: true,
      workerSupportsHttpAuth: false,
      backendCapacity: { compiled_connector: 1 },
    };
    const macContext: DueFeedClaimContext = {
      isUserScopedWorker: true,
      deviceWorkerId: macDeviceId,
      workerPlatform: 'macos',
      authorizedCapabilities: ['os.shell'],
      capabilityMatchSet: ['os.shell'],
      manifestClaimAuthorizations: [],
      allowLegacyManifestCapabilityClaims: true,
      orgScopeIds: [org.id],
      baseOrgScopeIds: [org.id],
      workerHardensDbEgress: false,
      workerSupportsHttpAuth: false,
      // Deliberately the map a headless daemon advertises, both backends open,
      // so the claim assertions below double as the regression test: `headless`
      // is the default platform of `lobu daemon` and that daemon asserts its
      // compiled runtime loads before it polls, so owning the daemon builtin
      // must never cost a worker its compiled lane. If it did, every
      // execution-pinned compiled connection on a self-hosted device would stop
      // being claimed with no error anywhere.
      backendCapacity: { compiled_connector: 1 },
    };
    const chromeContext: DueFeedClaimContext = {
      isUserScopedWorker: true,
      deviceWorkerId: chromeDeviceId,
      workerPlatform: 'chrome-extension',
      authorizedCapabilities: ['browser.history'],
      capabilityMatchSet: ['browser.history'],
      manifestClaimAuthorizations: [],
      allowLegacyManifestCapabilityClaims: false,
      orgScopeIds: [org.id],
      baseOrgScopeIds: [org.id],
      workerHardensDbEgress: false,
      workerSupportsHttpAuth: false,
      // Matches what poll.ts advertises for a non-headless platform. This
      // feed claims through the manifest/bridge lane, which does not consult
      // compiled capacity at all -- so the value here must mirror production
      // rather than imply a restriction the lane never applies.
      backendCapacity: { compiled_connector: 1 },
    };

    // Production incident shape: the Mac is recently seen but busy, so it is not
    // the worker polling here. A fleet poll must not enqueue its
    // execution-pinned work — it only gets the fleet feed and the
    // browser-affinity one, which is deliberately fleet work. The deliberately
    // unrunnable oldest fleet feed throws, so it counts as neither created nor
    // skipped — the loop logs it and moves on rather than letting it
    // monopolize the poller's single successful creation slot.
    expect(
      await materializeDueFeeds({} as Env, sql, {
        claimContext: fleetContext,
        maxRunsCreated: 1,
      })
    ).toEqual({ dueFeeds: 3, runsCreated: 1, skipped: 0 });
    expect(
      await materializeDueFeeds({} as Env, sql, {
        claimContext: fleetContext,
        maxRunsCreated: 1,
      })
    ).toEqual({ dueFeeds: 2, runsCreated: 1, skipped: 0 });

    // The device registry upsert is best-effort. If it transiently fails but
    // the fallback resolves the existing device row, this current poll is
    // stronger readiness evidence than its stale stored timestamp.
    await sql`
      UPDATE device_workers
      SET last_seen_at = current_timestamp - INTERVAL '10 minutes'
      WHERE id = ${macDeviceId}::uuid
    `;

    // Same Mac, same pins, same authorized capability -- but with its compiled
    // backend closed it must claim nothing. That is the gate's whole point: a
    // worker can be online and fully authorized and still be unable to RUN a
    // compiled artifact because its connector compiler/SDK runtime is
    // unavailable, and claiming it would surface the failure only after the run
    // is already running. An advertisement that omits the backend is not a
    // grant either.
    for (const backendCapacity of [{ compiled_connector: 0 }, {}]) {
      expect(
        await materializeDueFeeds({} as Env, sql, {
          claimContext: { ...macContext, backendCapacity },
          maxRunsCreated: 1,
        })
      ).toMatchObject({ runsCreated: 0 });
    }

    // The Mac poll owns both its explicit pin and the unpinned capability lane,
    // but each idle poll materializes only one claim slot.
    expect(
      await materializeDueFeeds({} as Env, sql, {
        claimContext: macContext,
        maxRunsCreated: 1,
      })
    ).toEqual({ dueFeeds: 2, runsCreated: 1, skipped: 0 });
    expect(
      await materializeDueFeeds({} as Env, sql, {
        claimContext: macContext,
        maxRunsCreated: 1,
      })
    ).toEqual({ dueFeeds: 1, runsCreated: 1, skipped: 0 });

    expect(
      await materializeDueFeeds({} as Env, sql, {
        claimContext: chromeContext,
        maxRunsCreated: 1,
      })
    ).toEqual({ dueFeeds: 1, runsCreated: 1, skipped: 0 });

    const runs = (await sql`
      SELECT feed_id, COUNT(*)::int AS count
      FROM runs
      WHERE run_type = 'sync'
      GROUP BY feed_id
      ORDER BY feed_id
    `) as unknown as Array<{ feed_id: number; count: number }>;
    expect(
      Object.fromEntries(runs.map((run) => [Number(run.feed_id), Number(run.count)]))
    ).toEqual({
      [macPinnedFeedId]: 1,
      [chromePinnedFeedId]: 1,
      [browserAffinityFeedId]: 1,
      [fleetFeedId]: 1,
      [capabilityFeedId]: 1,
    });
    expect(runs.some((run) => Number(run.feed_id) === brokenFleetFeedId)).toBe(false);
  });

  it('delivers an overdue execution-pinned feed when its device resumes polling', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: 'Resumed Device Scheduler Org',
    });
    const workerId = 'resumed-device-worker';
    const [device] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label,
        organization_id, last_seen_at
      ) VALUES (
        ${user.id}, ${workerId}, 'macos', ${sql.json([])}, 'Resumed Mac',
        ${org.id}, current_timestamp - INTERVAL '10 minutes'
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await createTestConnectorDefinition({
      key: 'test.scheduler-resumed-device',
      name: 'Resumed Device Connector',
      feeds_schema: { items: { description: 'Items', operations: ['sync'] } },
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.scheduler-resumed-device',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await sql`
      UPDATE connections
      SET device_worker_id = ${device.id}::uuid
      WHERE id = ${connection.id}
    `;
    const [feed] = (await sql`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, status,
        schedule, next_run_at, created_at, updated_at
      ) VALUES (
        ${org.id}, ${connection.id}, 'items', 'active',
        '* * * * *', current_timestamp - INTERVAL '5 minutes',
        current_timestamp, current_timestamp
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const app = new Hono();
    app.post(
      '/api/workers/poll',
      async (c, next) => {
        c.set('workerAuthMode' as never, 'user' as never);
        c.set('workerUserId' as never, user.id as never);
        c.set('workerOrgIds' as never, [org.id] as never);
        c.set('organizationId' as never, org.id as never);
        c.set('mcpAuthInfo' as never, { scopes: ['device_worker:run'] } as never);
        await next();
      },
      (c) => pollWorkerJob(c as never)
    );
    const poll = (pollingWorkerId: string) =>
      app.fetch(
        new Request('http://localhost/api/workers/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            worker_id: pollingWorkerId,
            platform: 'macos',
            app_version: '1.0.0',
            capabilities: {},
          }),
        }),
        {} as never
      );

    const info = vi.spyOn(logger, 'info');
    try {
      // A different idle worker polls first and materializes nothing — the feed
      // is pinned to this device, so it is outside that worker's claim lanes.
      // The exact device can materialize it on its next poll.
      expect((await poll('bystander-device-worker')).status).toBe(200);

      const response = await poll(workerId);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Number(body.feed_id)).toBe(Number(feed.id));
      expect(body.run_type).toBe('sync');

      const runs = await sql`
        SELECT id, status, claimed_by
        FROM runs
        WHERE feed_id = ${feed.id}
          AND run_type = 'sync'
      `;
      expect(runs).toHaveLength(1);
      expect(String(runs[0].status)).toBe('running');
      expect(String(runs[0].claimed_by)).toBe(workerId);

      const dispatchEvents = info.mock.calls.filter(
        (call) => call[1] === '[pollWorkerJob] Materialized due sync for current poller'
      );
      expect(dispatchEvents).toHaveLength(1);
      expect(dispatchEvents[0]?.[0]).toMatchObject({
        dispatch_event: 'worker_scoped_sync_materialized',
        run_id: Number(runs[0].id),
        feed_id: Number(feed.id),
        worker_id: workerId,
        device_worker_id: device.id,
        eligibility_lane: 'device_pin',
      });
    } finally {
      info.mockRestore();
    }
  });
});
