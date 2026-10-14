/**
 * A device's HOME workspace is chosen when it is paired (personal by default)
 * and its device connectors auto-wire there. The personal workspace keeps its
 * fleet model; a TEAM workspace gets one private connection per device, pinned
 * to it. These cases pin the flow end to end on the server surfaces a device
 * touches after approval:
 *   - mint-child-token: a new device inherits the parent grant's home; an
 *     existing device keeps its own (a rotation never moves it).
 *   - poll: a new device registers in its token's home, and auto-wire creates
 *     a PRIVATE connection there, pinned to the device and owned by its owner.
 *   - a Devices-page move (`PATCH /api/me/devices/:id`) invalidates the old pin
 *     and the next poll wires the new home; page activation follows the move.
 *   - team work runs only on the device a connection is pinned to, and a
 *     device behind the workspace's version gets none of that version's work
 *     until it catches up; nothing is paused for it.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_MANIFESTS_BY_PLATFORM } from '@lobu/connector-worker/daemon/device-manifests';
import type { AuthInfo } from '../../auth/oauth/types';
import { generateSecureToken, hashToken } from '../../auth/oauth/utils';
import type { Env } from '../../index';
import { mintDeviceChildToken, updateDeviceWorkerOrg } from '../../worker-api/device-management';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { activatePageRun } from '../../worker-api/page-activation';
import { materializeDueFeeds, type DueFeedClaimContext } from '../../scheduled/check-due-feeds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestConnection, createTestConnectorDefinition } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const OS_SHELL_MANIFEST = (DEVICE_MANIFESTS_BY_PLATFORM.headless ?? []).find(
  (entry) => (entry as { key?: string }).key === 'os.shell'
) as Record<string, unknown> | undefined;
if (!OS_SHELL_MANIFEST) throw new Error('headless daemon advertises no os.shell manifest');

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

async function seedUser(name: string) {
  const sql = getTestDb();
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
      ${JSON.stringify({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await addMember(personalOrgId, userId, 'owner');
  return { userId, personalOrgId };
}

async function seedTeamOrg() {
  const teamOrgId = `org-team-${generateSecureToken(4)}`;
  await getTestDb()`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (${teamOrgId}, 'Team', ${teamOrgId}, 'private', ${JSON.stringify({})}, NOW())
  `;
  return teamOrgId;
}

async function addMember(orgId: string, userId: string, role: string) {
  await getTestDb()`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, ${role}, NOW())
  `;
}

async function workerPat(userId: string, organizationId: string, workerId: string) {
  const token = `owl_pat_${generateSecureToken(24)}`;
  await getTestDb()`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${hashToken(token)}, ${token.substring(0, 12)}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, 'device_worker:run', ${workerId}, NOW(), NOW()
    )
  `;
  return token;
}

async function pollShell(token: string, workerId: string, manifest = OS_SHELL_MANIFEST) {
  const res = await post('/api/workers/poll', {
    token,
    body: {
      worker_id: workerId,
      platform: 'headless',
      app_version: '9.9.0',
      label: 'Build box',
      capabilities: { 'os.shell': true },
      connector_manifests: [manifest],
      capacity_available: 0,
    },
  });
  expect(res.status).toBe(200);
}

async function deviceRow(userId: string, workerId: string) {
  const [row] = (await getTestDb()`
    SELECT id, organization_id FROM device_workers
    WHERE user_id = ${userId} AND worker_id = ${workerId}
  `) as unknown as Array<{ id: string; organization_id: string }>;
  return row;
}

async function shellConnections(orgId: string) {
  return (await getTestDb()`
    SELECT c.id, c.status, c.visibility, c.created_by, c.device_worker_id::text AS device_worker_id,
           (SELECT COUNT(*)::int FROM feeds f
             WHERE f.connection_id = c.id AND f.status = 'active' AND f.deleted_at IS NULL) AS active_feeds
    FROM connections c
    WHERE c.organization_id = ${orgId} AND c.connector_key = 'os.shell' AND c.deleted_at IS NULL
    ORDER BY c.id
  `) as unknown as Array<{
    id: number;
    status: string;
    visibility: string;
    created_by: string;
    device_worker_id: string | null;
    active_feeds: number;
  }>;
}

type MintCaller = Pick<
  AuthInfo,
  'scopes' | 'tokenType' | 'authorizationGrantType' | 'workerId' | 'organizationId'
>;

function mintApp(userId: string, caller: MintCaller) {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: MintCaller } }>();
  app.post(
    '/mint',
    async (c, next) => {
      c.set('user', { id: userId });
      c.set('mcpAuthInfo', caller);
      await next();
    },
    (c) => mintDeviceChildToken(c)
  );
  return app;
}

async function mint(userId: string, organizationId: string, workerId?: string) {
  const res = await mintApp(userId, {
    scopes: ['mcp:read', 'device_worker:run'],
    tokenType: 'access_token',
    authorizationGrantType: 'device_code',
    organizationId,
  }).request(
    '/mint',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'headless', label: 'Build box', worker_id: workerId }),
    },
    TEST_ENV
  );
  return res;
}

async function moveDevice(userId: string, deviceId: string, organizationId: string) {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
  app.patch(
    '/devices/:id',
    async (c, next) => {
      c.set('user', { id: userId });
      await next();
    },
    (c) => updateDeviceWorkerOrg(c)
  );
  const res = await app.request(
    `/devices/${deviceId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: organizationId }),
    },
    TEST_ENV
  );
  expect(res.status).toBe(200);
}

describe('device home workspace chosen at pairing', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('mints a new device into the parent grant home and keeps an existing device home', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Minter');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');

    const res = await mint(userId, teamOrgId, 'mint-team-box');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect((await deviceRow(userId, 'mint-team-box')).organization_id).toBe(teamOrgId);
    const [pat] = (await sql`
      SELECT organization_id FROM personal_access_tokens WHERE token_hash = ${hashToken(body.access_token)}
    `) as unknown as Array<{ organization_id: string }>;
    expect(pat.organization_id).toBe(teamOrgId);

    // A personal-homed device re-minted from a team-bound parent (a routine
    // rotation) stays home: only the Devices page moves a device.
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${userId}, 'mint-personal-box', 'headless', ${sql.json([])}, 'Old box', ${personalOrgId})
    `;
    const remint = await mint(userId, teamOrgId, 'mint-personal-box');
    expect(remint.status).toBe(200);
    const reminted = (await remint.json()) as { access_token: string };
    expect((await deviceRow(userId, 'mint-personal-box')).organization_id).toBe(personalOrgId);
    const [remintedPat] = (await sql`
      SELECT organization_id FROM personal_access_tokens WHERE token_hash = ${hashToken(reminted.access_token)}
    `) as unknown as Array<{ organization_id: string }>;
    expect(remintedPat.organization_id).toBe(personalOrgId);
  });

  it('refuses to mint into a parent home the user has left', async () => {
    const { userId } = await seedUser('Leaver');
    const teamOrgId = await seedTeamOrg();
    const res = await mint(userId, teamOrgId, 'left-box');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'device_home_unavailable' });
  });

  it('rotates a legacy NULL home and a departed home into the personal workspace', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Rotation Owner');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${userId}, 'legacy-home', 'headless', ${sql.json([])}, NULL)
    `;
    const rotated = await mint(userId, teamOrgId, 'legacy-home');
    expect(rotated.status).toBe(200);
    const body = (await rotated.json()) as { access_token: string };
    const [pat] = await sql`
      SELECT organization_id FROM personal_access_tokens WHERE token_hash = ${hashToken(body.access_token)}
    `;
    expect(pat.organization_id).toBe(personalOrgId);

    await mint(userId, teamOrgId, 'departed-home');
    await sql`DELETE FROM member WHERE "organizationId" = ${teamOrgId} AND "userId" = ${userId}`;
    // A home the owner left serves the personal fleet (as reconciliation treats
    // it), so its rotated credential binds there; the row itself is unchanged.
    const departed = await mint(userId, personalOrgId, 'departed-home');
    expect(departed.status).toBe(200);
    const departedBody = (await departed.json()) as { access_token: string };
    const [departedPat] = await sql`
      SELECT organization_id FROM personal_access_tokens WHERE token_hash = ${hashToken(departedBody.access_token)}
    `;
    expect(departedPat.organization_id).toBe(personalOrgId);
    expect((await deviceRow(userId, 'departed-home')).organization_id).toBe(teamOrgId);
  });

  it('registers a new device in its token home and auto-wires a private connection there only', async () => {
    const { userId, personalOrgId } = await seedUser('Team Device Owner');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    const token = await workerPat(userId, teamOrgId, 'team-box');

    await pollShell(token, 'team-box');

    const device = await deviceRow(userId, 'team-box');
    expect(device.organization_id).toBe(teamOrgId);
    const team = await shellConnections(teamOrgId);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({
      status: 'active',
      visibility: 'private',
      created_by: userId,
      device_worker_id: device.id,
    });
    expect(await shellConnections(personalOrgId)).toHaveLength(0);
  });

  it('keeps a legacy NULL-home device personal when re-paired with a team credential', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Legacy Poll Owner');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${userId}, 'legacy-poll', 'headless', ${sql.json([])}, NULL)
    `;
    await pollShell(await workerPat(userId, teamOrgId, 'legacy-poll'), 'legacy-poll');
    expect((await deviceRow(userId, 'legacy-poll')).organization_id).toBe(personalOrgId);
    expect(await shellConnections(teamOrgId)).toHaveLength(0);
    expect(await shellConnections(personalOrgId)).toHaveLength(1);
  });

  it('invalidates the old pin on a Devices-page move and wires the new home pinned', async () => {
    const { userId, personalOrgId } = await seedUser('Mover');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'admin');
    const token = await workerPat(userId, personalOrgId, 'moving-box');

    await pollShell(token, 'moving-box');
    const device = await deviceRow(userId, 'moving-box');
    expect(device.organization_id).toBe(personalOrgId);
    expect(await shellConnections(personalOrgId)).toHaveLength(1);
    expect(await shellConnections(teamOrgId)).toHaveLength(0);

    await moveDevice(userId, device.id, teamOrgId);
    // The device keeps polling on its old (personal-bound) credential: the
    // poll must not move it back, and auto-wire must follow the new home.
    await pollShell(token, 'moving-box');

    expect((await deviceRow(userId, 'moving-box')).organization_id).toBe(teamOrgId);
    const team = await shellConnections(teamOrgId);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({
      status: 'active',
      visibility: 'private',
      created_by: userId,
      device_worker_id: device.id,
    });
    const personal = await shellConnections(personalOrgId);
    expect(personal).toHaveLength(1);
    expect(personal[0]).toMatchObject({ status: 'paused', device_worker_id: null, active_feeds: 0 });
  });

  it('gives each member of a team workspace their own private device connection', async () => {
    const alice = await seedUser('Alice');
    const bob = await seedUser('Bob');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, alice.userId, 'owner');
    await addMember(teamOrgId, bob.userId, 'member');

    await pollShell(await workerPat(alice.userId, teamOrgId, 'alice-box'), 'alice-box');
    await pollShell(await workerPat(bob.userId, teamOrgId, 'bob-box'), 'bob-box');
    // A second poll of each must converge, not adopt the colleague's row.
    await pollShell(await workerPat(alice.userId, teamOrgId, 'alice-box'), 'alice-box');

    const aliceDevice = await deviceRow(alice.userId, 'alice-box');
    const bobDevice = await deviceRow(bob.userId, 'bob-box');
    const team = await shellConnections(teamOrgId);
    expect(team).toHaveLength(2);
    expect(
      team.map((row) => [row.created_by, row.device_worker_id, row.visibility, row.status]).sort()
    ).toEqual(
      [
        [alice.userId, aliceDevice.id, 'private', 'active'],
        [bob.userId, bobDevice.id, 'private', 'active'],
      ].sort()
    );
  });

  it('gives one member two pinned connections for two devices in a team workspace', async () => {
    const { userId } = await seedUser('Two Boxes');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    await pollShell(await workerPat(userId, teamOrgId, 'box-one'), 'box-one');
    await pollShell(await workerPat(userId, teamOrgId, 'box-two'), 'box-two');
    await pollShell(await workerPat(userId, teamOrgId, 'box-one'), 'box-one');

    const one = await deviceRow(userId, 'box-one');
    const two = await deviceRow(userId, 'box-two');
    const team = await shellConnections(teamOrgId);
    expect(team.map((row) => [row.device_worker_id, row.created_by, row.visibility, row.status]).sort()).toEqual(
      [
        [one.id, userId, 'private', 'active'],
        [two.id, userId, 'private', 'active'],
      ].sort()
    );
  });

  describe('team version decision, one case per teamDeviceAction row', () => {
    const NEW = String(OS_SHELL_MANIFEST.version);
    const DECLARED_FEED = { feeds_schema: { items: { name: 'Items', operations: ['sync'] } } };
    const OLD = '0.0.1';

    /** Alice runs the OLDER extension and Bob the NEWER, both homed in Team. */
    async function teamOfTwo() {
      const sql = getTestDb();
      const alice = await seedUser('Older Extension');
      const bob = await seedUser('Newer Extension');
      const teamOrgId = await seedTeamOrg();
      await addMember(teamOrgId, alice.userId, 'member');
      await addMember(teamOrgId, bob.userId, 'member');
      const aliceToken = await workerPat(alice.userId, teamOrgId, 'old-box');
      const bobToken = await workerPat(bob.userId, teamOrgId, 'new-box');
      const ctx = {
        sql,
        alice,
        bob,
        teamOrgId,
        aliceOld: () => pollShell(aliceToken, 'old-box', { ...OS_SHELL_MANIFEST, version: OLD }),
        aliceNew: () => pollShell(aliceToken, 'old-box'),
        /** The same polls with a manifest that DECLARES a synced feed. */
        aliceOldFeed: () =>
          pollShell(aliceToken, 'old-box', { ...OS_SHELL_MANIFEST, ...DECLARED_FEED, version: OLD }),
        aliceNewFeed: () => pollShell(aliceToken, 'old-box', { ...OS_SHELL_MANIFEST, ...DECLARED_FEED }),
        bobNewFeed: () => pollShell(bobToken, 'new-box', { ...OS_SHELL_MANIFEST, ...DECLARED_FEED }),
        aliceNone: async () => {
          const res = await post('/api/workers/poll', {
            token: aliceToken,
            body: {
              worker_id: 'old-box', platform: 'headless', app_version: '9.9.0', label: 'Build box',
              capabilities: {}, connector_manifests: [], capacity_available: 0,
            },
          });
          expect(res.status).toBe(200);
        },
        bobNew: () => pollShell(bobToken, 'new-box'),
        bobLastSeen: (interval: string) => sql`
          UPDATE device_workers SET last_seen_at = NOW() - ${interval}::interval
          WHERE user_id = ${bob.userId} AND worker_id = 'new-box'
        `,
        installed: async () =>
          ((await sql`
            SELECT version FROM connector_definitions
            WHERE organization_id = ${teamOrgId} AND key = 'os.shell' AND status = 'active'
          `) as unknown as Array<{ version: string }>)[0]?.version ?? null,
        seedFeed: async (userId: string) => {
          await sql`
            INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
            VALUES (${teamOrgId}, ${(await ctx.connectionsOf(userId))[0].id}, 'items', 'active', '* * * * *', NOW())
          `;
        },
        connectionsOf: async (userId: string) =>
          (await sql`
            SELECT c.id, c.status, c.error_message, c.visibility,
                   c.device_worker_id::text AS device_worker_id,
                   (SELECT COUNT(*)::int FROM feeds f
                     WHERE f.connection_id = c.id AND f.status = 'active' AND f.deleted_at IS NULL) AS active_feeds
            FROM connections c
            WHERE c.organization_id = ${teamOrgId} AND c.connector_key = 'os.shell'
              AND c.created_by = ${userId} AND c.deleted_at IS NULL
          `) as unknown as Array<{
            id: number;
            status: string;
            error_message: string | null;
            visibility: string;
            device_worker_id: string | null;
            active_feeds: number;
          }>,
        /** Runs the scheduler creates for Alice's due feed when her device polls. */
        aliceScheduledRuns: async () => {
          const device = await deviceRow(alice.userId, 'old-box');
          const [own] = await ctx.connectionsOf(alice.userId);
          await sql`
            UPDATE feeds SET next_run_at = NOW() - INTERVAL '5 minutes'
            WHERE connection_id = ${own.id} AND deleted_at IS NULL
          `;
          await sql`DELETE FROM runs WHERE connection_id = ${own.id}`;
          const claimContext: DueFeedClaimContext = {
            isUserScopedWorker: true,
            deviceWorkerId: device.id,
            workerPlatform: 'headless',
            authorizedCapabilities: ['os.shell'],
            capabilityMatchSet: ['os.shell'],
            manifestClaimAuthorizations: await reconcileDeviceCapabilities(alice.userId, device.id),
            allowLegacyManifestCapabilityClaims: false,
            orgScopeIds: [teamOrgId],
            baseOrgScopeIds: [teamOrgId],
            workerHardensDbEgress: false,
            workerSupportsHttpAuth: false,
            backendCapacity: { compiled_connector: 1 },
          };
          return (await materializeDueFeeds({} as Env, sql, { claimContext })).runsCreated;
        },
        /** Claim authorizations Alice's device gets for the workspace's version. */
        aliceClaimsOnNew: async () => {
          const device = await deviceRow(alice.userId, 'old-box');
          return (await reconcileDeviceCapabilities(alice.userId, device.id)).filter(
            (auth) => auth.connectorKey === 'os.shell' && auth.connectorVersion === NEW
          );
        },
      };
      return ctx;
    }
    type Team = Awaited<ReturnType<typeof teamOfTwo>>;

    /**
     * Row 4: nothing about the version gap is written. An existing connection
     * keeps its pin and `status`; a device that never had one gets none until
     * it catches up. Either way her device gets no claim for the workspace's
     * version.
     */
    async function expectAliceBehind(team: Team, status: 'active' | 'paused' | 'none' = 'active') {
      const device = await deviceRow(team.alice.userId, 'old-box');
      expect(await team.connectionsOf(team.alice.userId)).toEqual(
        status === 'none'
          ? []
          : [
              expect.objectContaining({
                status,
                error_message: null,
                visibility: 'private',
                device_worker_id: device.id,
              }),
            ]
      );
      expect(await team.installed()).toBe(NEW);
      expect(await team.aliceClaimsOnNew()).toEqual([]);
    }

    const cases: Array<[string, (team: Team) => Promise<void>]> = [
      [
        'row 1 — no installed definition: the first pairing installs its version, wired active',
        async (team) => {
          await team.aliceOld();
          expect(await team.installed()).toBe(OLD);
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null, visibility: 'private' }),
          ]);
        },
      ],
      [
        'row 2 then 4 — older first: a newer device advances it; the older device keeps its connection but its scheduled work waits',
        async (team) => {
          await team.aliceOldFeed();
          expect(await team.aliceScheduledRuns()).toBe(1);
          await team.bobNewFeed();
          expect(await team.installed()).toBe(NEW);
          expect(await team.connectionsOf(team.bob.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null }),
          ]);
          await team.aliceOldFeed();
          await expectAliceBehind(team);
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ active_feeds: 1 }),
          ]);
          expect(await team.aliceScheduledRuns()).toBe(0);
        },
      ],
      [
        'row 3 — the device reaches the installed version: the same connection runs again, nothing to clear',
        async (team) => {
          await team.aliceOldFeed();
          await team.bobNewFeed();
          await team.aliceOldFeed();
          const [behind] = await team.connectionsOf(team.alice.userId);
          expect(await team.aliceScheduledRuns()).toBe(0);
          await team.aliceNewFeed();
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ id: behind.id, status: 'active', error_message: null, active_feeds: 1 }),
          ]);
          expect(await team.installed()).toBe(NEW);
          expect(await team.aliceScheduledRuns()).toBe(1);
        },
      ],
      [
        "row 4 then 3 — the user's own pauses survive being behind and the upgrade",
        async (team) => {
          await team.aliceOldFeed();
          const [own] = await team.connectionsOf(team.alice.userId);
          const declared = (await team.sql`
            SELECT id, status FROM feeds WHERE connection_id = ${own.id} AND feed_key = 'items' AND deleted_at IS NULL
          `) as unknown as Array<{ id: number; status: string }>;
          expect(declared).toEqual([expect.objectContaining({ status: 'active' })]);
          await team.sql`UPDATE feeds SET status = 'paused' WHERE id = ${declared[0].id}`;
          await team.sql`UPDATE connections SET status = 'paused' WHERE id = ${own.id}`;
          const feedStatus = async () =>
            ((await team.sql`SELECT status FROM feeds WHERE id = ${declared[0].id}`) as unknown as Array<{
              status: string;
            }>)[0].status;

          await team.bobNewFeed();
          await team.aliceOldFeed();
          await expectAliceBehind(team, 'paused');
          await team.aliceNewFeed();
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ id: own.id, status: 'paused', error_message: null }),
          ]);
          expect(await feedStatus()).toBe('paused');
        },
      ],
      [
        'row 4 then 3 — newer first: an older device gets no connection until it catches up, then one',
        async (team) => {
          await team.bobNew();
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
          await team.aliceNew();
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null, visibility: 'private' }),
          ]);
        },
      ],
      [
        'row 4 — the newer device was removed before the older one pairs',
        async (team) => {
          await team.bobNew();
          await team.sql`DELETE FROM device_workers WHERE user_id = ${team.bob.userId}`;
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
        },
      ],
      [
        'row 4 — the newer device moved out before the older one pairs',
        async (team) => {
          await team.bobNew();
          const bobDevice = await deviceRow(team.bob.userId, 'new-box');
          await moveDevice(team.bob.userId, bobDevice.id, team.bob.personalOrgId);
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
        },
      ],
      [
        'row 4 — the newer device went stale (8 days) before the older one pairs',
        async (team) => {
          await team.bobNew();
          await team.bobLastSeen('8 days');
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
        },
      ],
      [
        'row 5 + 7 — the device stops advertising: connection and feeds unchanged, nothing scheduled; the definition is neither changed nor archived',
        async (team) => {
          await team.aliceOld();
          await team.seedFeed(team.alice.userId);
          await team.aliceNone();
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null, active_feeds: 1 }),
          ]);
          expect(await team.installed()).toBe(OLD);
          // Offering it again changes nothing either.
          await team.aliceOld();
          expect(await team.connectionsOf(team.alice.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null, active_feeds: 1 }),
          ]);
        },
      ],
      [
        'row 6 — the newer device goes offline then stale: nothing downgrades',
        async (team) => {
          await team.bobNew();
          await team.aliceOld();
          await team.bobLastSeen('10 minutes');
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
          await team.bobLastSeen('8 days');
          await team.aliceOld();
          await expectAliceBehind(team, 'none');
          // Bob's device returning changes nothing either.
          await team.bobNew();
          await expectAliceBehind(team, 'none');
          expect(await team.connectionsOf(team.bob.userId)).toEqual([
            expect.objectContaining({ status: 'active', error_message: null }),
          ]);
        },
      ],
    ];
    it.each(cases)('%s', async (_name, run) => {
      await run(await teamOfTwo());
    });
  });

  it('does not attach a member device to an ownerless shared team connection', async () => {
    const sql = getTestDb();
    const alice = await seedUser('Orphan Owner');
    const bob = await seedUser('New Device Owner');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, alice.userId, 'owner');
    await addMember(teamOrgId, bob.userId, 'member');
    await pollShell(await workerPat(alice.userId, teamOrgId, 'orphan-box'), 'orphan-box');
    const [original] = await shellConnections(teamOrgId);
    await sql`
      UPDATE connections SET created_by = NULL, visibility = 'org', device_worker_id = NULL
      WHERE id = ${original.id}
    `;

    await pollShell(await workerPat(bob.userId, teamOrgId, 'new-box'), 'new-box');
    const connections = await shellConnections(teamOrgId);
    expect(connections).toHaveLength(2);
    expect(connections.find((row) => row.id === original.id)).toMatchObject({
      created_by: null, visibility: 'org', device_worker_id: null,
    });
    expect(connections.find((row) => row.created_by === bob.userId)).toMatchObject({
      visibility: 'private', device_worker_id: (await deviceRow(bob.userId, 'new-box')).id,
    });
  });

  it('runs team work only on the device a connection is pinned to', async () => {
    const sql = getTestDb();
    const alice = await seedUser('Claim Alice');
    const bob = await seedUser('Claim Bob');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, alice.userId, 'owner');
    await addMember(teamOrgId, bob.userId, 'member');
    const devices = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at)
      VALUES
        (${alice.userId}, 'claim-alice', 'headless', ${sql.json(['os.shell'])}, ${teamOrgId}, NOW()),
        (${bob.userId}, 'claim-bob', 'headless', ${sql.json(['os.shell'])}, ${teamOrgId}, NOW())
      RETURNING id, user_id
    `) as unknown as Array<{ id: string; user_id: string }>;
    const aliceDevice = devices.find((row) => row.user_id === alice.userId)!.id;
    const bobDevice = devices.find((row) => row.user_id === bob.userId)!.id;
    await createTestConnectorDefinition({
      key: 'test.home-claim',
      name: 'Home Claim',
      feeds_schema: { items: { description: 'Items', operations: ['sync'] } },
      organization_id: teamOrgId,
    });
    await sql`
      UPDATE connector_definitions SET required_capability = 'os.shell'
      WHERE key = 'test.home-claim' AND organization_id = ${teamOrgId}
    `;
    const bobConnection = await createTestConnection({
      organization_id: teamOrgId,
      connector_key: 'test.home-claim',
      created_by: bob.userId,
      createDefaultFeed: false,
    });
    await sql`UPDATE connections SET device_worker_id = ${bobDevice}::uuid WHERE id = ${bobConnection.id}`;
    const dueFeed = async () => {
      await sql`DELETE FROM runs WHERE connection_id = ${bobConnection.id}`;
      await sql`DELETE FROM feeds WHERE connection_id = ${bobConnection.id}`;
      await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
        VALUES (${teamOrgId}, ${bobConnection.id}, 'items', 'active', '* * * * *', NOW() - INTERVAL '5 minutes')
      `;
    };
    const deviceContext = (deviceWorkerId: string): DueFeedClaimContext => ({
      isUserScopedWorker: true,
      deviceWorkerId,
      workerPlatform: 'headless',
      authorizedCapabilities: ['os.shell'],
      capabilityMatchSet: ['os.shell'],
      manifestClaimAuthorizations: [],
      allowLegacyManifestCapabilityClaims: false,
      orgScopeIds: [teamOrgId],
      baseOrgScopeIds: [teamOrgId],
      workerHardensDbEgress: false,
      workerSupportsHttpAuth: false,
      backendCapacity: { compiled_connector: 1 },
    });
    const runsFor = async (deviceWorkerId: string) =>
      (await materializeDueFeeds({} as Env, sql, { claimContext: deviceContext(deviceWorkerId) })).runsCreated;

    // Bob's connection is pinned to his device: Alice's device in the same
    // workspace, serving the same capability, never claims it.
    await dueFeed();
    expect(await runsFor(aliceDevice)).toBe(0);
    expect(await runsFor(bobDevice)).toBe(1);

    // Unpinned, a team device connection is claimable by no device at all:
    // the unpinned capability lane is personal-only.
    await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${bobConnection.id}`;
    await dueFeed();
    expect(await runsFor(bobDevice)).toBe(0);
    expect(await runsFor(aliceDevice)).toBe(0);
  });

  it('activates page drafts by current placement after a move, never through the old pin', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Chrome Mover');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    const [chrome] = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at, app_version)
      VALUES (${userId}, 'moving-chrome', 'chrome-extension', ${sql.json(['browser.debugger'])}, ${personalOrgId}, NOW(), '0.6.1')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    for (const orgId of [personalOrgId, teamOrgId]) {
      await createTestConnectorDefinition({ key: 'test.page-draft', name: 'Page Draft', organization_id: orgId });
    }
    const draft = async (organizationId: string, slug: string) => {
      const connection = await createTestConnection({
        organization_id: organizationId,
        connector_key: 'test.page-draft',
        created_by: userId,
        createDefaultFeed: false,
      });
      await sql`UPDATE connections SET device_worker_id = ${chrome.id}::uuid, slug = ${slug} WHERE id = ${connection.id}`;
      const [run] = (await sql`
        INSERT INTO runs (
          organization_id, run_type, connection_id, connector_key, action_key,
          approval_status, status, expires_at, activation_kind, activation_target_urls,
          created_by_user_id, run_metadata
        ) VALUES (
          ${organizationId}, 'action', ${connection.id}, 'test.page-draft', 'prepare_reply',
          'auto', 'pending', NOW() + interval '1 day', 'page_visit',
          ARRAY['https://example.test/draft']::text[], ${userId}, ${sql.json({ page_activation_identity: 'exact' })}
        )
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return run.id;
    };
    const personalRun = await draft(personalOrgId, 'page-draft-personal');
    await moveDevice(userId, chrome.id, teamOrgId);
    const teamRun = await draft(teamOrgId, 'page-draft-team');

    // The credential is still bound to the personal workspace the device left.
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('workerAuthMode', 'user');
      c.set('workerUserId', userId);
      c.set('workerOrgIds', [personalOrgId]);
      await next();
    });
    app.post('/activate', activatePageRun);
    const activate = async (runId: number) =>
      (await (
        await app.request(
          '/activate',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ worker_id: 'moving-chrome', run_id: runId, tab_id: 3, url: 'https://example.test/draft' }),
          },
          TEST_ENV
        )
      ).json()) as { status: string };

    expect(await activate(personalRun)).toEqual({ status: 'unavailable' });
    expect(await activate(teamRun)).toEqual({ status: 'activated' });
  });
});
