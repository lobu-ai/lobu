/**
 * Device-backed source read — end to end.
 *
 * `local.directory` is a metadata-only device manifest: there is no compiled
 * connector on the server, so the compiled feed-read path cannot serve it. The
 * read is dispatched to the paired Mac over the existing device action queue
 * and awaited there.
 *
 * What each case pins:
 *
 *   (a) ROUTING — a `runtime`-bearing connector takes the device path, and the
 *       reserved `__lobu_feed_read` run is claimed by the pinned device
 *       through the ordinary `/api/workers/poll`, carrying the caller's query
 *       and window. Rows come back through `/api/workers/complete-action`.
 *   (b) NO RETENTION — a source read writes no events and no checkpoint, and the
 *       run row that carried the rows is scrubbed of BOTH the device's output
 *       and the caller's query. The rows transit Postgres (that is the
 *       cross-replica transport); they must not stay there.
 *   (c) The scrub survives every exit: device failure, a malformed device
 *       reply, and an exception thrown by the waiter itself.
 *   (d) OFFLINE — a read against a device that has stopped polling fails fast
 *       with a diagnosis, without parking a run for the 60s queue budget.
 */

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import type { AuthzScope } from '../../../authz/scope';
import { compileConnectorSource } from '../../../utils/connector-compiler';
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../../worker-api/device-manifests';

// The waiter is swapped through a server-internal slot so two cases can make it
// throw. NOT `vi.mock`: vitest runs this package with `isolate: false` (one
// shared module graph for the whole Postgres-backed run), and under that
// setting a module mock only lands if this file is the first to import
// `connector-pushdown` — these cases passed alone and timed out in a full run.
const { readSourceFeed } = await import('../../../lib/connector-pushdown');
const { readDeviceFeed, __setDeviceActionWaiterForTest } = await import(
  '../../../lib/device-feed-read'
);
const { DEVICE_FEED_READ_ACTION_KEY } = await import(
  '../../../lib/device-feed-read-protocol'
);
const { pollWorkerJob } = await import('../../../worker-api/poll');
const { cleanupTestDatabase, getTestDb } = await import('../../setup/test-db');
const { addUserToOrganization, createTestOrganization, createTestUser } = await import(
  '../../setup/test-fixtures'
);
const { post } = await import('../../setup/test-helpers');

const CONNECTOR_KEY = 'local.directory';
const CONNECTOR_VERSION = '0.3.0';
const FEED_KEY = 'files';
const WORKER_ID = 'wk-dir-source-read';
const DIRECTORY_MANIFEST: DeviceConnectorManifest = {
  key: CONNECTOR_KEY,
  version: CONNECTOR_VERSION,
  name: 'Local Folder',
  required_capability: 'local_directory',
  runtime: { platforms: ['macos'] },
  auth_schema: { methods: [{ type: 'none' }] },
  feeds_schema: { [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } },
};
const DIRECTORY_MANIFEST_HASH = deviceManifestHash(DIRECTORY_MANIFEST);
const DIRECTORY_INVENTORY = {
  [CONNECTOR_KEY]: {
    manifest: DIRECTORY_MANIFEST,
    manifest_hash: DIRECTORY_MANIFEST_HASH,
    received_at: new Date().toISOString(),
  },
};

const DEVICE_ROWS = [
  {
    id: 'row-1',
    occurred_at: '2026-08-18T09:00:00.000Z',
    text: 'invoice 4471 is overdue',
    chat_jid: 'folder-a',
    chat_name: 'Dana Ruiz',
    is_group: false,
    from_me: false,
    sender_phone: '15551230000',
  },
];
const DEVICE_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'text', type: 'text' },
];

let orgId: string;
let userId: string;
let deviceWorkerId: string;
let connectionId: number;
let feedId: number;

const scope = (): AuthzScope => ({ organizationId: orgId, principal: userId });

async function setDeviceLastSeen(interval: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE device_workers SET last_seen_at = now() - ${interval}::interval
    WHERE id = ${deviceWorkerId}::uuid
  `;
}

async function setDeviceCapabilities(capabilities: string[]): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE device_workers SET capabilities = ${sql.json(capabilities)}
    WHERE id = ${deviceWorkerId}::uuid
  `;
}

/** Rows the org has ever persisted from this connection, by any path. */
async function countPersistence(): Promise<{ events: number; checkpointed: number }> {
  const sql = getTestDb();
  const [events] = (await sql`
    SELECT count(*)::int AS n FROM events WHERE organization_id = ${orgId}
  `) as Array<{ n: number }>;
  const [checkpointed] = (await sql`
    SELECT count(*)::int AS n FROM feeds
    WHERE id = ${feedId} AND (checkpoint IS NOT NULL OR next_run_at IS NOT NULL)
  `) as Array<{ n: number }>;
  return { events: events.n, checkpointed: checkpointed.n };
}

async function readRunRows(): Promise<
  Array<{ id: number; status: string; action_key: string; action_input: unknown; action_output: unknown }>
> {
  const sql = getTestDb();
  return (await sql`
    SELECT id, status, action_key, action_input, action_output
    FROM runs
    WHERE organization_id = ${orgId} AND run_type = 'action'
    ORDER BY id
  `) as Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
  }>;
}

/**
 * Stand in for the Mac app: poll until the reserved source-read run is handed
 * over, then answer it. Uses the real worker endpoints, so this also proves
 * poll.ts routes a `run_type='action'` row on a device-pinned connection to the
 * device that owns the pin.
 */
async function respondAsDevice(
  reply: { status: 'success'; action_output: Record<string, unknown> } | { status: 'failed'; error_message: string }
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await post('/api/workers/poll', {
      body: {
        worker_id: WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Test Mac',
        capabilities: { local_directory: true },
      },
    });
    expect(response.status).toBe(200);
    const job = await response.json();
    if (job?.run_id && job?.operation_key === DEVICE_FEED_READ_ACTION_KEY) {
      const completion = await post('/api/workers/complete-action', {
        body: { run_id: job.run_id, worker_id: WORKER_ID, ...reply },
      });
      expect(completion.status).toBe(200);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('device never received the feed-read job');
}

describe('device-backed source feed read', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'WA Live' });
    orgId = org.id;
    const user = await createTestUser({ email: 'dir-live@test.com' });
    userId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const sql = getTestDb();
    // Anonymous local device polls adopt the personal-org owner; mark this org
    // as that user's personal org so the poll resolves to them.
    await sql`
      UPDATE "organization"
      SET metadata = ${sql.json({ personal_org_for_user_id: userId })}
      WHERE id = ${orgId}
    `;
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${userId}, ${WORKER_ID}, 'macos', '9.9.0',
              ${sql.json(['local_directory'])}, 'Test Mac', ${orgId})
      RETURNING id
    `) as Array<{ id: string }>;
    deviceWorkerId = device[0].id;

    // A device-manifest connector: `runtime` set, NO compiled code. That is the
    // whole reason the compiled pushdown cannot serve it.
    await sql`
      INSERT INTO connector_definitions
        (key, name, version, organization_id, status, runtime, required_capability,
         feeds_schema, auth_schema, created_at, updated_at)
      VALUES (${CONNECTOR_KEY}, 'Local Folder (this Mac)', ${CONNECTOR_VERSION}, ${orgId}, 'active',
              ${sql.json({ platforms: ['macos'] })}, 'local_directory',
              ${sql.json({ [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } })},
              ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
    `;
    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, compiled_code_hash, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, ${DIRECTORY_MANIFEST_HASH}, NOW())
    `;
    const connection = (await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility,
         device_worker_id, created_by, created_at, updated_at)
      VALUES (${orgId}, ${CONNECTOR_KEY}, 'local-directory', 'Local Folder (this Mac)', 'active', 'private',
              ${deviceWorkerId}::uuid, ${userId}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    connectionId = connection[0].id;
    const feed = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, display_name, status, config,
         next_run_at)
      VALUES (${orgId}, ${connectionId}, ${FEED_KEY}, 'Messages', 'active',
              ${sql.json({ recall: true, chat_filter: 'all' })}, NULL)
      RETURNING id
    `) as Array<{ id: number }>;
    feedId = feed[0].id;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    __setDeviceActionWaiterForTest(null);
    await setDeviceLastSeen('5 seconds');
    await setDeviceCapabilities(['local_directory']);
    const sql = getTestDb();
    await sql`UPDATE device_workers SET connector_manifests = ${sql.json(DIRECTORY_INVENTORY)} WHERE id = ${deviceWorkerId}::uuid`;
    await getTestDb()`UPDATE feeds SET status = 'active' WHERE id = ${feedId}`;
    await getTestDb()`DELETE FROM runs WHERE organization_id = ${orgId}`;
  });

  it('dispatches to the paired device, returns live rows, and retains nothing', async () => {
    const reading = readSourceFeed({
      scope: scope(),
      feedId,
      query: 'invoice',
      limit: 25,
      offset: 5,
    });
    const job = await respondAsDevice({
      status: 'success',
      action_output: { rows: DEVICE_ROWS, columns: DEVICE_COLUMNS },
    });

    // (a) The device was handed the caller's intent, not a bare "read the feed".
    expect(job.connector_key).toBe(CONNECTOR_KEY);
    expect(job.action_input).toMatchObject({
      feed_key: FEED_KEY,
      query: 'invoice',
      limit: 25,
      offset: 5,
    });
    // Feed config rides along so the device can apply the declared filters.
    expect((job.action_input as { config: Record<string, unknown> }).config).toMatchObject({
      chat_filter: 'all',
    });

    const live = await reading;
    expect(live.rows).toEqual(DEVICE_ROWS);
    expect(live.columns).toEqual(DEVICE_COLUMNS);

    // (b) Nothing persisted: no events, no checkpoint, no due time — and the
    // transport row no longer holds the messages or the query.
    expect(await countPersistence()).toEqual({ events: 0, checkpointed: 0 });
    const runs = await readRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].action_key).toBe(DEVICE_FEED_READ_ACTION_KEY);
    expect(runs[0].action_output).toBeNull();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('invoice 4471');
    expect(JSON.stringify(runs[0])).not.toContain('Dana Ruiz');
  }, 30_000);

  it('executes a pinned historical compiled version when active metadata is device-only', async () => {
    const historicalVersion = '0.2.0';
    const sourceCode = `
      import { defineConnector } from '@lobu/connector-sdk';
      export default defineConnector({
        key: '${CONNECTOR_KEY}',
        name: 'Historical Folder',
        version: '${historicalVersion}',
        authSchema: { methods: [{ type: 'none' }] },
        feeds: {
          ${FEED_KEY}: {
            key: '${FEED_KEY}',
            name: 'Messages',
            operations: ['read'],
            read: async () => ({
              rows: [{ source: 'historical-compiled' }],
              hasMore: false,
            }),
          },
        },
      });
    `;
    const compiled = await compileConnectorSource(sourceCode);
    const sql = getTestDb();
    await sql`
      INSERT INTO connector_versions (
        organization_id, connector_key, version, compiled_code,
        compiled_code_hash, compile_config_hash, source_code, created_at
      ) VALUES (
        ${orgId}, ${CONNECTOR_KEY}, ${historicalVersion}, ${compiled.compiledCode},
        ${compiled.compiledCodeHash}, ${COMPILE_CONFIG_HASH}, ${sourceCode}, NOW()
      )
    `;
    await sql`UPDATE feeds SET pinned_version = ${historicalVersion} WHERE id = ${feedId}`;
    await setDeviceLastSeen('1 hour');

    try {
      const result = await readSourceFeed({ scope: scope(), feedId });
      expect(result.rows).toEqual([{ source: 'historical-compiled' }]);
      expect(await readRunRows()).toEqual([]);
    } finally {
      await sql`UPDATE feeds SET pinned_version = NULL WHERE id = ${feedId}`;
      await sql`
        DELETE FROM connector_versions
        WHERE organization_id = ${orgId}
          AND connector_key = ${CONNECTOR_KEY}
          AND version = ${historicalVersion}
      `;
    }
  }, 30_000);

  it('surfaces a device-side failure and still scrubs the run', async () => {
    const reading = readSourceFeed({ scope: scope(), feedId, query: 'payslip' });
    await respondAsDevice({ status: 'failed', error_message: 'Full Disk Access denied' });

    await expect(reading).rejects.toThrow(/failed on the paired device: Full Disk Access denied/);
    const runs = await readRunRows();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('payslip');
  }, 30_000);

  it('rejects a malformed device reply rather than reporting an empty result', async () => {
    const reading = readSourceFeed({ scope: scope(), feedId });
    await respondAsDevice({ status: 'success', action_output: { unexpected: true } });

    await expect(reading).rejects.toThrow(/malformed/);
    const runs = await readRunRows();
    expect(runs[0].action_output).toBeNull();
  }, 30_000);

  // The scrub lives in a `finally` that wraps the WAIT, not just its result:
  // a DB error inside the poll loop throws, and without this the run row would
  // keep the caller's query (and any rows a device had already posted).
  it('scrubs the run even when the waiter itself throws', async () => {
    __setDeviceActionWaiterForTest(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(
      readSourceFeed({ scope: scope(), feedId, query: 'mortgage' })
    ).rejects.toThrow(/connection terminated unexpectedly/);

    const runs = await readRunRows();
    expect(runs).toHaveLength(1);
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('mortgage');
  });

  // Blanking the payload is not enough on the throw path: the run is still
  // `pending`, its claim horizon has not expired, and a device that polls a
  // moment later would claim it and POST a fresh page of messages straight back
  // into the row we just cleared. Closing the run in the same statement is what
  // makes the scrub final.
  it('closes an abandoned run so a late device answer cannot repopulate it', async () => {
    __setDeviceActionWaiterForTest(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(
      readSourceFeed({ scope: scope(), feedId, query: 'tenancy deposit' })
    ).rejects.toThrow(/connection terminated unexpectedly/);

    const [abandoned] = await readRunRows();
    expect(abandoned.status).toBe('timeout');

    // The device comes back and tries to answer the run it was about to claim.
    const claim = await post('/api/workers/poll', {
      body: {
        worker_id: WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Test Mac',
        capabilities: { local_directory: true },
      },
    });
    expect(claim.status).toBe(200);
    // A terminal run is not claimable, so the poll hands back no job at all.
    expect((await claim.json())?.run_id).toBeUndefined();

    // And a completion posted anyway is refused rather than re-filling the row.
    const late = await post('/api/workers/complete-action', {
      body: {
        run_id: abandoned.id,
        worker_id: WORKER_ID,
        status: 'success',
        action_output: { rows: DEVICE_ROWS, columns: DEVICE_COLUMNS },
      },
    });
    expect(await late.json()).toMatchObject({ success: false, reason: 'already_finalized' });

    const [after] = await readRunRows();
    expect(after.status).toBe('timeout');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(after)).not.toContain('tenancy deposit');
    expect(JSON.stringify(after)).not.toContain('Dana Ruiz');
  });

  // The pin is read off a row this caller does not necessarily own end to end,
  // and the offline diagnosis quotes the device's label and last-poll time. It
  // must be reached THROUGH the org's own connection, or a corrupt pin reports
  // another tenant's machine back in an error string.
  it('never describes a device the org\'s connection does not actually pin', async () => {
    const sql = getTestDb();
    const foreign = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${userId}, ${'wk-other-tenant'}, 'macos', '9.9.0',
              ${sql.json(['local_directory'])}, 'Acme Corp Mac', ${'org-someone-else'}, now())
      RETURNING id
    `) as Array<{ id: string }>;

    // A pin naming a device this org's connection does not hold: the preflight
    // reaches the device through the connection, so it finds nothing.
    const error = await readDeviceFeed({
      organizationId: orgId,
      feedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId,
      connectorKey: CONNECTOR_KEY,
      connectorVersion: CONNECTOR_VERSION,
      manifestHash: null,
      deviceOwnerUserId: userId,
      deviceWorkerId: foreign[0].id,
      feedStatus: 'active',
      requiredCapability: 'local_directory',
    }).then(
      () => new Error('expected the read to be refused'),
      (err: unknown) => err as Error
    );
    expect(error.message).toMatch(/cannot reach/);
    // And nothing about the other tenant's machine reaches this caller.
    expect(error.message).not.toContain('Acme Corp Mac');
    expect(error.message).not.toContain('last polled');
    expect(await readRunRows()).toHaveLength(0);

    await sql`DELETE FROM device_workers WHERE id = ${foreign[0].id}::uuid`;
  });

  it('fails fast with a diagnosis when the paired device is offline', async () => {
    await setDeviceLastSeen('30 minutes');
    await expect(readSourceFeed({ scope: scope(), feedId })).rejects.toThrow(
      /is unavailable: device "Test Mac" is offline \(last polled 30m ago\)/
    );
    // No run parked for the 60s queue budget — the server already knew.
    expect(await readRunRows()).toHaveLength(0);
  });

  it('refuses an online device with a different manifest before queuing a source read', async () => {
    const sql = getTestDb();
    const otherManifest = { ...DIRECTORY_MANIFEST, name: 'Different build' };
    await sql`
      UPDATE device_workers SET connector_manifests = ${sql.json({
        [CONNECTOR_KEY]: {
          manifest: otherManifest,
          manifest_hash: deviceManifestHash(otherManifest),
          received_at: new Date().toISOString(),
        },
      })} WHERE id = ${deviceWorkerId}::uuid
    `;
    await expect(readSourceFeed({ scope: scope(), feedId })).rejects.toThrow(/selected connector manifest.*assigned device/i);
    expect(await readRunRows()).toHaveLength(0);
  });

  it('keeps an offline execution pin authoritative over another device\'s setup state', async () => {
    await setDeviceLastSeen('30 minutes');
    const manifest = {
      key: CONNECTOR_KEY,
      version: CONNECTOR_VERSION,
      name: 'Local Folder',
      required_capability: 'local_directory',
      runtime: { platforms: ['macos'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: { [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } },
    };
    const sql = getTestDb();
    const other = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label,
         organization_id, last_seen_at, connector_manifests)
      VALUES (${userId}, ${'wk-dir-setup-incomplete'}, 'macos', '9.9.0',
              ${sql.json([])}, 'Other Mac', ${orgId}, now(),
              ${sql.json({
                [CONNECTOR_KEY]: {
                  manifest,
                  manifest_hash: deviceManifestHash(manifest as DeviceConnectorManifest),
                  received_at: new Date().toISOString(),
                },
              })})
      RETURNING id
    `) as Array<{ id: string }>;

    try {
      const error = await readSourceFeed({ scope: scope(), feedId }).then(
        () => new Error('expected the read to be refused'),
        (err: unknown) => err as Error
      );
      expect(error.message).toMatch(
        /is unavailable: device "Test Mac" is offline \(last polled 30m ago\)/
      );
      expect(error.message).not.toMatch(/requires setup/i);
      expect(await readRunRows()).toHaveLength(0);
    } finally {
      await sql`DELETE FROM device_workers WHERE id = ${other[0].id}::uuid`;
    }
  });

  it('reports setup_required for an auto-paused feed whose online manifest lacks permission', async () => {
    const manifest = {
      key: CONNECTOR_KEY,
      version: CONNECTOR_VERSION,
      name: 'Local Folder',
      required_capability: 'local_directory',
      runtime: { platforms: ['macos'] },
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: { [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } },
    };
    const manifestHash = deviceManifestHash(manifest as DeviceConnectorManifest);
    const sql = getTestDb();
    await sql`
      UPDATE device_workers
      SET capabilities = ${sql.json([])},
          connector_manifests = ${sql.json({
            [CONNECTOR_KEY]: {
              manifest,
              manifest_hash: manifestHash,
              received_at: new Date().toISOString(),
            },
          })}
      WHERE id = ${deviceWorkerId}::uuid
    `;
    await sql`UPDATE feeds SET status = 'paused' WHERE id = ${feedId}`;

    const error = await readSourceFeed({ scope: scope(), feedId }).then(
      () => null,
      (err: unknown) => err as { code?: string; retryable?: boolean; message: string }
    );
    expect(error).toMatchObject({ code: 'PERMISSION', retryable: false });
    expect(error?.message).toMatch(/requires setup.*local_directory.*finish setup.*retry/i);
    expect(await readRunRows()).toHaveLength(0);
  });
});

/**
 * Which org an UNPINNED device-backed source feed may be served in.
 *
 * poll.ts branch 1B gates the unpinned claim on `baseOrgScopeIds` — the worker
 * token's bound org plus the owner's personal org. At preflight time no token
 * has been presented, so the bound org is unknowable and only the personal-org
 * half is derivable. The preflight therefore serves exactly that lane and tells
 * a shared workspace to pin instead. Widening it to "any org the owner is a
 * member of" would report servable for runs branch 1B never claims, turning an
 * instant error into a 60-second queue timeout.
 *
 *   (1) PERSONAL org, unpinned, owner's device online — served end to end, even
 *       though `device_workers.organization_id` still points at a different,
 *       stale home org. The token here is genuinely user-scoped and bound to
 *       the personal org, so the real branch-1B SQL is what claims the run.
 *   (2) TEAM org, unpinned, owned by a mere member — refused with the fix ("pin
 *       this connection"), and zero runs enqueued.
 *   (3) That same TEAM connection, once PINNED, is served — the pinned branch
 *       already reaches through the connection and allows a foreign home org.
 */
const PERSONAL_WORKER_ID = 'wk-dir-personal';
const CAPABILITY = 'local_directory';

const PERSONAL_ROWS = [{ id: 'row-90', occurred_at: '2026-08-18T09:00:00.000Z', text: 'live row' }];
const PERSONAL_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'text', type: 'text' },
];

let personalUserId: string;
let personalOrgId: string;
let staleHomeOrgId: string;
let teamOrgId: string;
let personalDeviceWorkerId: string;
let personalFeedId: number;
let teamFeedId: number;
let teamConnectionId: number;

const scopeIn = (organizationId: string): AuthzScope => ({ organizationId, principal: personalUserId });

/**
 * The real poll handler behind a stub for the auth middleware ONLY — the shape
 * device-management-mint.test.ts uses. Everything that decides whether this
 * device may claim (branch 1B, `baseOrgScopeIds`, the capability allowlist, the
 * device_workers upsert) is production code.
 *
 * `boundOrgId` is what the worker token is bound to, so `workerOrgIds` here is
 * the genuine [bound org, personal org] pair poll.ts computes from a real
 * device_worker:run token.
 */
function personalDeviceApp(boundOrgId: string): Hono {
  const app = new Hono();
  app.post(
    '/api/workers/poll',
    async (c, next) => {
      c.set('workerAuthMode' as never, 'user' as never);
      c.set('workerUserId' as never, personalUserId as never);
      c.set(
        'workerOrgIds' as never,
        Array.from(new Set([boundOrgId, personalOrgId])) as never
      );
      c.set('organizationId' as never, boundOrgId as never);
      c.set('mcpAuthInfo' as never, { scopes: ['device_worker:run'] } as never);
      await next();
    },
    (c) => pollWorkerJob(c as never)
  );
  return app;
}

async function pollPersonalDevice(boundOrgId: string): Promise<Record<string, unknown> | null> {
  const response = await personalDeviceApp(boundOrgId).fetch(
    new Request('http://localhost/api/workers/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: PERSONAL_WORKER_ID,
        platform: 'macos',
        app_version: '9.9.0',
        label: 'Personal Mac',
        capabilities: { [CAPABILITY]: true },
      }),
    }),
    {} as never
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown> | null;
}

/** Stand in for the Mac: claim the reserved source-read run and answer it. */
async function respondAsPersonalDevice(boundOrgId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const job = await pollPersonalDevice(boundOrgId);
    if (job?.run_id && job?.operation_key === DEVICE_FEED_READ_ACTION_KEY) {
      const completion = await post('/api/workers/complete-action', {
        body: {
          run_id: job.run_id,
          worker_id: PERSONAL_WORKER_ID,
          status: 'success',
          action_output: { rows: PERSONAL_ROWS, columns: PERSONAL_COLUMNS },
        },
      });
      expect(completion.status).toBe(200);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('device never received the source-feed read job');
}

async function countRuns(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT count(*)::int AS n FROM runs WHERE organization_id = ${organizationId}
  `) as Array<{ n: number }>;
  return row.n;
}

async function readFails(organizationId: string, feedId: number): Promise<Error> {
  const error = await readSourceFeed({
    scope: scopeIn(organizationId),
    feedId,
    query: 'live',
    limit: 10,
  }).then(
    () => null,
    (err: Error) => err
  );
  if (!error) throw new Error('expected the read to be refused');
  return error;
}

/** A device-manifest connector + an unpinned source feed in `organizationId`. */
async function seedPersonalLaneConnection(
  organizationId: string,
  slug: string
): Promise<{ connectionId: number; feedId: number }> {
  const sql = getTestDb();
  await sql`
    INSERT INTO connector_definitions
      (key, name, version, organization_id, status, runtime, required_capability,
       feeds_schema, auth_schema, created_at, updated_at)
    VALUES (${CONNECTOR_KEY}, 'Local Folder (this Mac)', ${CONNECTOR_VERSION}, ${organizationId}, 'active',
            ${sql.json({ platforms: ['macos'] })}, ${CAPABILITY},
            ${sql.json({ [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } })},
            ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
  `;
  const connection = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, visibility,
       device_worker_id, created_by, created_at, updated_at)
    VALUES (${organizationId}, ${CONNECTOR_KEY}, ${slug}, 'Local Folder (this Mac)',
            'active', 'organization', NULL, ${personalUserId}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  const feed = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, display_name, status, config,
       next_run_at)
    VALUES (${organizationId}, ${connection[0].id}, ${FEED_KEY}, 'Messages', 'active',
            ${sql.json({ recall: true })}, NULL)
    RETURNING id
  `) as Array<{ id: number }>;
  return { connectionId: connection[0].id, feedId: feed[0].id };
}

describe('unpinned device source-feed reads are a personal-org lane', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const user = await createTestUser({ email: 'dir-personal@test.com' });
    personalUserId = user.id;

    const personal = await createTestOrganization({ name: 'Personal' });
    personalOrgId = personal.id;
    await addUserToOrganization(personalUserId, personalOrgId, 'owner');
    const staleHome = await createTestOrganization({ name: 'Old Home' });
    staleHomeOrgId = staleHome.id;
    await addUserToOrganization(personalUserId, staleHomeOrgId, 'owner');
    const team = await createTestOrganization({ name: 'Acme Workspace' });
    teamOrgId = team.id;
    await addUserToOrganization(personalUserId, teamOrgId, 'member');

    const sql = getTestDb();
    await sql`
      UPDATE "organization" SET metadata = ${sql.json({ personal_org_for_user_id: personalUserId })}
      WHERE id = ${personalOrgId}
    `;

    // `organization_id` is the device's HOME org, written once at pairing. It
    // points at neither org under test, which is the point: the lane is decided
    // by which org IS this user's personal one, not by this stale column.
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${personalUserId}, ${PERSONAL_WORKER_ID}, 'macos', '9.9.0',
              ${sql.json([CAPABILITY])}, 'Personal Mac', ${staleHomeOrgId})
      RETURNING id
    `) as Array<{ id: string }>;
    personalDeviceWorkerId = device[0].id;

    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, compiled_code_hash, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, ${DIRECTORY_MANIFEST_HASH}, NOW())
    `;
    personalFeedId = (await seedPersonalLaneConnection(personalOrgId, 'folder-personal')).feedId;
    const teamSeed = await seedPersonalLaneConnection(teamOrgId, 'folder-team');
    teamConnectionId = teamSeed.connectionId;
    teamFeedId = teamSeed.feedId;
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM runs WHERE organization_id IN (${personalOrgId}, ${teamOrgId})`;
    await sql`
      UPDATE device_workers
      SET last_seen_at = now(), capabilities = ${sql.json([CAPABILITY])},
          connector_manifests = ${sql.json(DIRECTORY_INVENTORY)}
      WHERE id = ${personalDeviceWorkerId}::uuid
    `;
    await sql`
      UPDATE connections SET device_worker_id = NULL WHERE id = ${teamConnectionId}
    `;
  });

  it('serves an unpinned read in the personal org despite a stale device home org', async () => {
    const sql = getTestDb();
    const [home] = (await sql`
      SELECT organization_id FROM device_workers WHERE id = ${personalDeviceWorkerId}::uuid
    `) as Array<{ organization_id: string }>;
    // The premise: were these equal the case would prove nothing.
    expect(home.organization_id).toBe(staleHomeOrgId);
    expect(home.organization_id).not.toBe(personalOrgId);

    const reading = readSourceFeed({
      scope: scopeIn(personalOrgId),
      feedId: personalFeedId,
      query: 'live',
      limit: 10,
    });
    const job = await respondAsPersonalDevice(personalOrgId);

    expect(job.connector_key).toBe(CONNECTOR_KEY);
    expect(job.operation_key).toBe(DEVICE_FEED_READ_ACTION_KEY);
    const live = await reading;
    expect(live.rows).toEqual(PERSONAL_ROWS);

    // The home org is set-once, so serving the personal org did not re-anchor
    // the device — the next read is the same shape.
    const [after] = (await sql`
      SELECT organization_id FROM device_workers WHERE id = ${personalDeviceWorkerId}::uuid
    `) as Array<{ organization_id: string }>;
    expect(after.organization_id).toBe(staleHomeOrgId);
  });

  it('refuses an unpinned read in a team org and says to pin it', async () => {
    const error = await readFails(teamOrgId, teamFeedId);
    expect(error.message).toMatch(/not pinned to a device/);
    // The fix, not just the diagnosis.
    expect(error.message).toMatch(/pin it to the device that should serve it/);
    // Membership in the team org is NOT what makes a device servable: branch 1B
    // gates on the token's bound org, which this preflight cannot see.
    expect(error.message).not.toMatch(/no online device/);
    expect(await countRuns(teamOrgId)).toBe(0);
  });

  it('serves the same team connection once it is pinned to the device', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE connections SET device_worker_id = ${personalDeviceWorkerId}::uuid
      WHERE id = ${teamConnectionId}
    `;

    const reading = readSourceFeed({
      scope: scopeIn(teamOrgId),
      feedId: teamFeedId,
      query: 'live',
      limit: 10,
    });
    const job = await respondAsPersonalDevice(teamOrgId);
    expect(job.operation_key).toBe(DEVICE_FEED_READ_ACTION_KEY);
    const live = await reading;
    expect(live.rows).toEqual(PERSONAL_ROWS);
  });
});

/**
 * Lifecycle of the transport run: DEADLINES and ORPHAN sweeping.
 *
 * The read seam's `finally` scrubs on every path the gateway process survives.
 * A gateway that DIES mid-read runs no `finally` at all. The retention
 *       promise cannot rest on a process staying alive, so the reaper
 *       re-asserts it set-wise from whichever replica is up.
 */
const LIFECYCLE_WORKER_ID = 'wk-dir-lifecycle';

const { sweepAbandonedDeviceFeedReadRuns } = await import(
  '../../../scheduled/check-stalled-executions'
);
const { manageOperations } = await import('../../../tools/admin/manage_operations');
const { ownerToolContext } = await import('../../setup/test-fixtures');
// manage_operations builds org-scoped view URLs, so the workspace provider has
// to be up. Initialized HERE rather than inherited from whichever suite booted
// the app first — that would make this case pass only in a particular file
// order.
const { initWorkspaceProvider } = await import('../../../workspace');

let lifecycleOrgId: string;
let lifecycleUserId: string;
let lifecycleDeviceId: string;
let lifecycleConnectionId: number;
let lifecycleFeedId: number;

async function lifecycleRuns(): Promise<
  Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>
> {
  const sql = getTestDb();
  return (await sql`
    SELECT id, status, action_key, action_input, action_output, error_message
    FROM runs
    WHERE organization_id = ${lifecycleOrgId} AND run_type = 'action'
    ORDER BY id
  `) as Array<{
    id: number;
    status: string;
    action_key: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>;
}

/** Insert a source-read run in an arbitrary state, bypassing the read seam. */
async function seedReservedRun(opts: {
  status: string;
  actionKey?: string;
  completedAtSecondsAgo?: number | null;
  expiresAtSecondsFromNow?: number | null;
  claimedSecondsAgo?: number | null;
  heartbeatSecondsAgo?: number | null;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key, connector_version,
      action_key, action_input, action_output, approval_status, status,
      completed_at, expires_at, claimed_at, last_heartbeat_at, created_at
    ) VALUES (
      ${lifecycleOrgId}, 'action', ${lifecycleConnectionId}, ${CONNECTOR_KEY},
      ${CONNECTOR_VERSION},
      ${opts.actionKey ?? DEVICE_FEED_READ_ACTION_KEY},
      ${sql.json({ feed_key: FEED_KEY, query: 'tenancy deposit', chat_jids: ['folder-a'] })},
      ${sql.json({ rows: DEVICE_ROWS })},
      'auto', ${opts.status},
      ${opts.completedAtSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.completedAtSecondsAgo}::int * interval '1 second')`},
      ${opts.expiresAtSecondsFromNow == null
        ? null
        : sql`current_timestamp + (${opts.expiresAtSecondsFromNow}::int * interval '1 second')`},
      ${opts.claimedSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.claimedSecondsAgo}::int * interval '1 second')`},
      ${opts.heartbeatSecondsAgo == null
        ? null
        : sql`current_timestamp - (${opts.heartbeatSecondsAgo}::int * interval '1 second')`},
      current_timestamp
    )
    RETURNING id
  `) as Array<{ id: number }>;
  return row.id;
}

async function readRunById(runId: number): Promise<{
  status: string;
  action_input: unknown;
  action_output: unknown;
  error_message: string | null;
}> {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, action_input, action_output, error_message FROM runs WHERE id = ${runId}
  `) as Array<{
    status: string;
    action_input: unknown;
    action_output: unknown;
    error_message: string | null;
  }>;
  return row;
}

describe('device source-feed read lifecycle — deadlines and orphan sweeping', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
    const org = await createTestOrganization({ name: 'WA Lifecycle' });
    lifecycleOrgId = org.id;
    const user = await createTestUser({ email: 'dir-lifecycle@test.com' });
    lifecycleUserId = user.id;
    await addUserToOrganization(user.id, org.id, 'owner');

    const sql = getTestDb();
    await sql`
      UPDATE "organization" SET metadata = ${sql.json({ personal_org_for_user_id: lifecycleUserId })}
      WHERE id = ${lifecycleOrgId}
    `;
    const device = (await sql`
      INSERT INTO device_workers
        (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
      VALUES (${lifecycleUserId}, ${LIFECYCLE_WORKER_ID}, 'macos', '9.9.0',
              ${sql.json([CAPABILITY])}, 'Lifecycle Mac', ${lifecycleOrgId})
      RETURNING id
    `) as Array<{ id: string }>;
    lifecycleDeviceId = device[0].id;

    // No `actions_schema`: the reserved read key is protocol, never a declared
    // operation. The manage_operations case below is what pins that.
    await sql`
      INSERT INTO connector_definitions
        (key, name, version, organization_id, status, runtime, required_capability,
         feeds_schema, auth_schema, created_at, updated_at)
      VALUES (${CONNECTOR_KEY}, 'Local Folder (this Mac)', ${CONNECTOR_VERSION}, ${lifecycleOrgId},
              'active', ${sql.json({ platforms: ['macos'] })}, ${CAPABILITY},
              ${sql.json({ [FEED_KEY]: { key: FEED_KEY, operations: ['read'] } })},
              ${sql.json({ methods: [{ type: 'none' }] })}, NOW(), NOW())
    `;
    await sql`
      INSERT INTO connector_versions (connector_key, version, compiled_code, source_path, compiled_code_hash, created_at)
      VALUES (${CONNECTOR_KEY}, ${CONNECTOR_VERSION}, NULL,
              ${`device-manifest://macos/${CONNECTOR_KEY}@${CONNECTOR_VERSION}`}, ${DIRECTORY_MANIFEST_HASH}, NOW())
    `;
    const connection = (await sql`
      INSERT INTO connections
        (organization_id, connector_key, slug, display_name, status, visibility,
         device_worker_id, created_by, created_at, updated_at)
      VALUES (${lifecycleOrgId}, ${CONNECTOR_KEY}, 'folder-lifecycle', 'Local Folder (this Mac)',
              'active', 'organization', ${lifecycleDeviceId}::uuid, ${lifecycleUserId}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    lifecycleConnectionId = connection[0].id;
    const feed = (await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, display_name, status, config,
         next_run_at)
      VALUES (${lifecycleOrgId}, ${lifecycleConnectionId}, ${FEED_KEY}, 'Messages', 'active',
              ${sql.json({ recall: true })}, NULL)
      RETURNING id
    `) as Array<{ id: number }>;
    lifecycleFeedId = feed[0].id;
  });

  afterAll(async () => {
    __setDeviceActionWaiterForTest(null);
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    __setDeviceActionWaiterForTest(null);
    const sql = getTestDb();
    await sql`DELETE FROM runs WHERE organization_id = ${lifecycleOrgId}`;
    await sql`
      UPDATE device_workers
      SET last_seen_at = now(), capabilities = ${sql.json([CAPABILITY])},
          connector_manifests = ${sql.json(DIRECTORY_INVENTORY)}
      WHERE id = ${lifecycleDeviceId}::uuid
    `;
  });

  // The abort has to reach the WAITER, not just the caller. A `Promise.race`
  // alone would return control while the run stayed pending for the full 60s
  // queue budget, holding the caller's query and claimable by a device that
  // would then post a page of messages into it.
  it('an aborted read stops waiting, terminalizes the run, and scrubs it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);

    const startedAt = Date.now();
    const error = await readDeviceFeed({
      organizationId: lifecycleOrgId,
      feedId: lifecycleFeedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId: lifecycleConnectionId,
      connectorKey: CONNECTOR_KEY,
      connectorVersion: CONNECTOR_VERSION,
      manifestHash: null,
      deviceOwnerUserId: lifecycleUserId,
      deviceWorkerId: lifecycleDeviceId,
      feedStatus: 'active',
      requiredCapability: CAPABILITY,
      query: 'tenancy deposit',
      signal: controller.signal,
    }).then(
      () => null,
      (err: Error) => err
    );
    const elapsedMs = Date.now() - startedAt;

    if (!error) throw new Error('expected the aborted read to fail');
    // Reported as a caller deadline, NOT as a device timeout: nothing here says
    // the device is unhealthy — it was never given the 60s the other message
    // would quote.
    expect(error.message).toMatch(/cut short by the caller's read deadline/);
    // Nowhere near the 60s pre-claim budget it would otherwise have waited.
    expect(elapsedMs).toBeLessThan(10_000);

    const runs = await lifecycleRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('timeout');
    expect(runs[0].action_output).toBeNull();
    expect(runs[0].action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(runs[0])).not.toContain('tenancy deposit');
  }, 30_000);

  // The preflight is two DB round-trips. An ambient read on a few seconds'
  // budget can spend it in there, and enqueueing afterwards would create a
  // transport run whose only future is cancellation — a row briefly holding the
  // caller's query for a read nobody is waiting on.
  it('creates no transport run when the deadline expires during the preflight', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await readDeviceFeed({
      organizationId: lifecycleOrgId,
      feedId: lifecycleFeedId,
      feedKey: FEED_KEY,
      feedConfig: {},
      connectionId: lifecycleConnectionId,
      connectorKey: CONNECTOR_KEY,
      connectorVersion: CONNECTOR_VERSION,
      manifestHash: null,
      deviceOwnerUserId: lifecycleUserId,
      deviceWorkerId: lifecycleDeviceId,
      feedStatus: 'active',
      requiredCapability: CAPABILITY,
      query: 'tenancy deposit',
      signal: controller.signal,
    }).then(
      () => null,
      (err: Error) => err
    );

    if (!error) throw new Error('expected the aborted read to fail');
    expect(error.message).toMatch(/before the request reached the paired device/);
    // Nothing enqueued at all — not enqueued-then-scrubbed.
    expect(await lifecycleRuns()).toHaveLength(0);
  });

  // Everything below is the CRASH path: rows the in-process `finally` never got
  // to, because the process that owned it is gone.
  it('scrubs a completed source-read run the crashed gateway never cleaned up', async () => {
    const runId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 120 });

    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(1);

    const after = await readRunById(runId);
    // The verdict is not the sweep's to rewrite — only the payload is.
    expect(after.status).toBe('completed');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(JSON.stringify(after)).not.toContain('tenancy deposit');
    expect(JSON.stringify(after)).not.toContain('folder-a');
    expect(JSON.stringify(after)).not.toContain('invoice 4471');

    // Idempotent: a second tick has nothing left to do.
    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(0);
  });

  it('times out AND scrubs an in-flight source-read run whose claim horizon lapsed', async () => {
    const runId = await seedReservedRun({ status: 'pending', expiresAtSecondsFromNow: -30 });

    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(1);

    const after = await readRunById(runId);
    // Terminal, so a device that wakes up late cannot claim it and post a fresh
    // page of messages into the row we just cleared.
    expect(after.status).toBe('timeout');
    expect(after.action_output).toBeNull();
    expect(after.action_input).toEqual({ scrubbed: true, feed_key: FEED_KEY });
    expect(after.error_message).toMatch(/swept by the run reaper/);
    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(0);
  });

  // `expires_at` on a device action is the UNCLAIMED claim horizon, not an
  // execution deadline — queue-service stamps it so an unclaimed run cannot sit
  // pending forever, and poll.ts enforces it only against `status = 'pending'`.
  // A device that claimed a folder query one second before expiry is doing
  // exactly what it was asked to; timing it out here would kill live work on a
  // clock that was never about execution.
  it('leaves a CLAIMED run with a lapsed horizon alone while it is still beating', async () => {
    for (const status of ['claimed', 'running']) {
      const runId = await seedReservedRun({
        status,
        expiresAtSecondsFromNow: -30,
        claimedSecondsAgo: 40,
        heartbeatSecondsAgo: 1,
      });

      expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(0);

      const after = await readRunById(runId);
      expect(after.status).toBe(status);
      expect(after.action_output).not.toBeNull();
      // The heartbeat/coarse reaper owns this row's failure; once IT
      // terminalizes, the terminal-grace lane clears the payload on a later
      // tick, so nothing is left holding messages either way.
      expect(JSON.stringify(after.action_input)).toContain('tenancy deposit');
      await getTestDb()`DELETE FROM runs WHERE id = ${runId}`;
    }
  });

  // The grace is the whole reason the sweep can run on a 30s tick without
  // breaking healthy reads: a run marked `completed` a moment ago is about to
  // be picked up by a waiter polling every 500ms.
  it('leaves a freshly completed run alone until the grace elapses', async () => {
    const runId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 1 });

    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(0);

    const after = await readRunById(runId);
    expect(after.action_output).not.toBeNull();
    expect(JSON.stringify(after.action_input)).toContain('tenancy deposit');
  });

  it('never touches an unrelated action run', async () => {
    const reservedId = await seedReservedRun({ status: 'completed', completedAtSecondsAgo: 120 });
    const unrelatedId = await seedReservedRun({
      status: 'completed',
      actionKey: 'send_message',
      completedAtSecondsAgo: 120,
    });

    expect(await sweepAbandonedDeviceFeedReadRuns(getTestDb())).toBe(1);

    expect((await readRunById(reservedId)).action_output).toBeNull();
    const unrelated = await readRunById(unrelatedId);
    expect(unrelated.action_output).not.toBeNull();
    expect(JSON.stringify(unrelated.action_input)).toContain('tenancy deposit');
  });

  // The reserved key is dispatched by the gateway, never declared. Declaring it
  // would flip `supportsExecute` and publish a read seam as a user-invokable
  // operation — so it must not be listable or executable through the operations
  // surface at all.
  it('does not expose the reserved read key as a manage_operations operation', async () => {
    const ctx = ownerToolContext(lifecycleOrgId, lifecycleUserId);
    const listed = (await manageOperations(
      { action: 'list_available', connector_key: CONNECTOR_KEY },
      {} as never,
      ctx
    )) as { operations?: Array<{ operation_key: string }> };
    expect(
      (listed.operations ?? []).some((o) => o.operation_key === DEVICE_FEED_READ_ACTION_KEY)
    ).toBe(false);

    const executed = (await manageOperations(
      {
        action: 'execute',
        connection_id: lifecycleConnectionId,
        operation_key: DEVICE_FEED_READ_ACTION_KEY,
        input: { feed_key: FEED_KEY, query: 'invoice', limit: 5, offset: 0, sort: null },
      },
      {} as never,
      ctx
    ).catch((err: Error) => ({ success: false, error: err.message }))) as {
      success?: boolean;
      error?: string;
    };
    expect(executed.success).not.toBe(true);
    // Refused because the key is not in `actions_schema` — the same gate any
    // undeclared operation hits, which is exactly the property being pinned.
    expect(String(executed.error ?? '')).toBe(
      `Invalid operation_key '${DEVICE_FEED_READ_ACTION_KEY}' for this connection.`
    );
    // And no run was enqueued behind the refusal.
    expect(await lifecycleRuns()).toHaveLength(0);
  }, 30_000);
});
