/**
 * A device's HOME workspace is chosen when it is paired (personal by default)
 * and its device connectors auto-wire there — not always in the personal
 * workspace. These cases pin the flow end to end on the server surfaces a
 * device touches after approval:
 *   - mint-child-token: a new device inherits the parent grant's home; an
 *     existing device keeps its own (a rotation never moves it).
 *   - poll: a new device registers in its token's home, and auto-wire creates
 *     a PRIVATE connection there, owned by the device's owner, and none in the
 *     personal workspace.
 *   - a Devices-page move (`PATCH /api/me/devices/:id`) re-homes the wiring on
 *     the next poll and leaves the old home's connection paused.
 *   - in a shared team workspace each member gets their own device connection;
 *     nobody adopts a colleague's private one.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_MANIFESTS_BY_PLATFORM } from '@lobu/connector-worker/daemon/device-manifests';
import type { AuthInfo } from '../../auth/oauth/types';
import { generateSecureToken, hashToken } from '../../auth/oauth/utils';
import type { Env } from '../../index';
import { resolveDeviceClaimableOrgs } from '../../utils/device-claimable-orgs';
import { mintDeviceChildToken, updateDeviceWorkerOrg } from '../../worker-api/device-management';
import { authorizeRunForWorker } from '../../worker-api/shared';
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

  it('preserves a legacy personal home and refuses rotation after leaving an existing home', async () => {
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
    const denied = await mint(userId, personalOrgId, 'departed-home');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'device_home_unavailable' });
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

  it('re-homes auto-wiring after a Devices-page move and leaves the old home paused', async () => {
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

  it('keeps a member on an older device manifest wired while a colleague runs a newer one', async () => {
    const sql = getTestDb();
    const alice = await seedUser('Older Extension');
    const bob = await seedUser('Newer Extension');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, alice.userId, 'member');
    await addMember(teamOrgId, bob.userId, 'member');
    const olderManifest = { ...OS_SHELL_MANIFEST, version: '0.0.1' };
    const aliceToken = await workerPat(alice.userId, teamOrgId, 'older-box');
    const bobToken = await workerPat(bob.userId, teamOrgId, 'newer-box');

    // Bob's newer manifest selects the workspace's one definition first.
    await pollShell(bobToken, 'newer-box');
    await pollShell(aliceToken, 'older-box', olderManifest);
    const definitionVersion = async () =>
      ((await sql`
        SELECT version FROM connector_definitions
        WHERE organization_id = ${teamOrgId} AND key = 'os.shell' AND status = 'active'
      `) as unknown as Array<{ version: string }>)[0]?.version;
    expect(await definitionVersion()).toBe(OS_SHELL_MANIFEST.version);

    const connections = await shellConnections(teamOrgId);
    expect(connections.map((row) => [row.created_by, row.status]).sort()).toEqual(
      [
        [alice.userId, 'active'],
        [bob.userId, 'active'],
      ].sort()
    );
    // os.shell declares no feeds; seed one on each member's connection.
    for (const row of connections) {
      await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
        VALUES (${teamOrgId}, ${row.id}, 'items', 'active', '* * * * *', NOW())
      `;
    }

    await pollShell(aliceToken, 'older-box', olderManifest);
    await pollShell(bobToken, 'newer-box');

    expect(await definitionVersion()).toBe(OS_SHELL_MANIFEST.version);
    expect(
      (await shellConnections(teamOrgId)).map((row) => [row.created_by, row.status, row.active_feeds]).sort()
    ).toEqual(
      [
        [alice.userId, 'active', 1],
        [bob.userId, 'active', 1],
      ].sort()
    );
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

  it('authorizes an unpinned run in a moved device home while membership remains valid', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Moved Worker');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'member');
    const workerId = 'scope-moving-box';
    const token = await workerPat(userId, personalOrgId, workerId);
    await pollShell(token, workerId);
    const device = await deviceRow(userId, workerId);
    await moveDevice(userId, device.id, teamOrgId);
    await pollShell(token, workerId);
    const [connection] = await shellConnections(teamOrgId);
    // Several eligible devices leave the connection unpinned. Scope must not
    // rely on a connection pin to discover the device's current home.
    await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${connection.id}`;
    const scope = () => resolveDeviceClaimableOrgs(sql, {
      deviceWorkerId: device.id, ownerUserId: userId, baseOrgIds: [personalOrgId],
    });
    expect(await scope()).toContain(teamOrgId);
    const [run] = await sql`
      INSERT INTO runs (organization_id, run_type, connection_id, connector_key,
                        action_key, status, approval_status, claimed_by)
      VALUES (${teamOrgId}, 'action', ${connection.id}, 'os.shell',
              'test-action', 'running', 'auto', ${workerId})
      RETURNING id
    `;
    const app = new Hono<{ Bindings: Env }>();
    app.get('/authorize', async (c) => {
      c.set('workerAuthMode', 'user');
      c.set('workerUserId', userId);
      c.set('workerOrgIds', [personalOrgId]);
      const denial = await authorizeRunForWorker(c, Number(run.id), workerId);
      return denial ?? c.json({ ok: true });
    });
    expect((await app.request('/authorize', {}, TEST_ENV)).status).toBe(200);

    await sql`DELETE FROM member WHERE "organizationId" = ${teamOrgId} AND "userId" = ${userId}`;
    expect(await scope()).not.toContain(teamOrgId);
    expect((await app.request('/authorize', {}, TEST_ENV)).status).toBe(403);
  });

  it("never lets a member's device claim a colleague's unpinned device connection", async () => {
    const sql = getTestDb();
    const alice = await seedUser('Claim Alice');
    const bob = await seedUser('Claim Bob');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, alice.userId, 'owner');
    await addMember(teamOrgId, bob.userId, 'member');
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
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
      VALUES (${teamOrgId}, ${bobConnection.id}, 'items', 'active', '* * * * *', NOW() - INTERVAL '5 minutes')
    `;
    const deviceContext = (userId: string): DueFeedClaimContext => ({
      isUserScopedWorker: true,
      deviceWorkerId: null,
      workerUserId: userId,
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

    // Alice's device lives in the same team workspace and serves os.shell, but
    // the unpinned connection is Bob's private one: it must not run on Alice's
    // machine.
    expect(
      (await materializeDueFeeds({} as Env, sql, { claimContext: deviceContext(alice.userId) }))
        .runsCreated
    ).toBe(0);
    expect(
      (await materializeDueFeeds({} as Env, sql, { claimContext: deviceContext(bob.userId) }))
        .runsCreated
    ).toBe(1);
  });

  it('pauses an unpinned old-home connection once no device homed there serves it', async () => {
    const sql = getTestDb();
    const { userId, personalOrgId } = await seedUser('Fleet Mover');
    const teamOrgId = await seedTeamOrg();
    await addMember(teamOrgId, userId, 'admin');
    const tokenA = await workerPat(userId, personalOrgId, 'fleet-box-a');
    const tokenB = await workerPat(userId, personalOrgId, 'fleet-box-b');
    await pollShell(tokenA, 'fleet-box-a');
    await pollShell(tokenB, 'fleet-box-b');
    // The first poll pinned the connection to its sole advertiser; a fleet of
    // several eligible devices can leave it unpinned, which is the shape the
    // Devices-page move cannot reach. os.shell declares no feeds, so seed one.
    const [pinned] = await shellConnections(personalOrgId);
    await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${pinned.id}`;
    await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
      VALUES (${personalOrgId}, ${pinned.id}, 'items', 'active', '* * * * *', NOW())
    `;
    const [personal] = await shellConnections(personalOrgId);
    expect(personal).toMatchObject({ device_worker_id: null, active_feeds: 1 });

    await moveDevice(userId, (await deviceRow(userId, 'fleet-box-a')).id, teamOrgId);
    await moveDevice(userId, (await deviceRow(userId, 'fleet-box-b')).id, teamOrgId);
    await pollShell(tokenA, 'fleet-box-a');

    // The unpinned connection survived both moves (the move only pauses pins),
    // so reconciliation must pause its feeds in the now device-less home.
    const [after] = await shellConnections(personalOrgId);
    expect(after).toMatchObject({ id: personal.id, active_feeds: 0 });
    expect(await shellConnections(teamOrgId)).toHaveLength(1);
  });
});
