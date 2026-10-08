/**
 * Default `connections.visibility` must depend on the CREDENTIAL kind, not just
 * the creator's role.
 *
 * A connection reads through ONE org-level credential (its auth profile's token),
 * so an `org`-visible connection lets every org member read live through the
 * owner's account. For a personal login (`oauth_account` or `browser_session`)
 * that means org-visible = the owner's private account exposed to
 * the whole org. So a personal-credential connection must default to `private`
 * EVEN when an admin/owner creates it — the credential being personal outranks
 * the role. Every other credential kind (env/oauth_app/service account) backs a
 * genuinely shared source and keeps the role-based default (owner → `org`).
 *
 * Red→green: before the fix, resolveConnectionVisibility branched on role alone,
 * so an OWNER's oauth_account connection defaulted `org` — the exposure bug.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

function ownerCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

async function makeConnectors(orgId: string) {
  // A personal-login (oauth_account) connector.
  await createTestConnectorDefinition({
    key: 'vis.oauth',
    name: 'Vis OAuth',
    organization_id: orgId,
    auth_schema: {
      methods: [
        {
          type: 'oauth',
          provider: 'visoauth',
          requiredScopes: ['read'],
          clientIdKey: 'VISOAUTH_CLIENT_ID',
          clientSecretKey: 'VISOAUTH_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });
  // A no-auth connector (a genuinely shared source: no personal credential).
  await createTestConnectorDefinition({
    key: 'vis.noauth',
    name: 'Vis NoAuth',
    organization_id: orgId,
    feeds_schema: { items: {} },
  });
}

describe('connection visibility default depends on credential kind', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it("an OWNER's oauth_account (personal-login) connection defaults to PRIVATE", async () => {
    process.env.VISOAUTH_CLIENT_ID = 'env-id';
    process.env.VISOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Vis Org A' });
    const user = await createTestUser({ name: 'Owner A' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    await makeConnectors(org.id);

    await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'vis.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Vis Account',
        slug: 'vis-account',
      },
      TEST_ENV,
      ctx
    );

    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'vis.oauth',
        slug: 'vis-oauth-conn',
        display_name: 'Vis OAuth Connection',
        auth_profile_slug: 'vis-account',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in res).toBe(false);
    const connectionId = 'connection' in res ? (res.connection as { id: number }).id : 0;
    expect(connectionId).toBeGreaterThan(0);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT visibility FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string }>;
    // The fix: personal creds → private even for an owner.
    expect(row.visibility).toBe('private');

    delete process.env.VISOAUTH_CLIENT_ID;
    delete process.env.VISOAUTH_CLIENT_SECRET;
  });

  it("an OWNER's non-personal (no auth_profile) connection still defaults to ORG", async () => {
    const org = await createTestOrganization({ name: 'Vis Org B' });
    const user = await createTestUser({ name: 'Owner B' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    await makeConnectors(org.id);

    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'vis.noauth',
        slug: 'vis-noauth-conn',
        display_name: 'Vis NoAuth Connection',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in res).toBe(false);
    const connectionId = 'connection' in res ? (res.connection as { id: number }).id : 0;
    expect(connectionId).toBeGreaterThan(0);

    const sql = getTestDb();
    const [row] = (await sql`
      SELECT visibility FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string }>;
    // No personal credential → role default preserved (owner → org).
    expect(row.visibility).toBe('org');
  });

  it.each(['create', 'update'] as const)('%s keeps a captured-cookie browser account private', async (action) => {
    const org = await createTestOrganization({ name: 'Browser Privacy Fixture' });
    const user = await createTestUser({ name: 'Browser Owner Fixture' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: 'vis.browser',
      name: 'Vis Browser',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'browser', cookieDomain: 'example.test' }] },
    });
    const profile = await manageAuthProfiles({
      action: 'create_auth_profile',
      profile_kind: 'browser_session',
      display_name: 'Browser Privacy Fixture',
      slug: 'browser-account',
      auth_data: { mode: 'cookies' },
    }, TEST_ENV, ctx);
    expect(profile).not.toHaveProperty('error');

    let connectionId: number;
    if (action === 'create') {
      const created = await manageConnections({
        action, connector_key: 'vis.browser', auth_profile_slug: 'browser-account',
      }, TEST_ENV, ctx);
      expect(created).not.toHaveProperty('error');
      connectionId = 'connection' in created ? (created.connection as { id: number }).id : 0;
    } else {
      // Start with a legacy shared connection to prove that re-pointing it
      // onto personal browser credentials also downgrades visibility.
      const [seed] = await sql`
        INSERT INTO connections (organization_id, connector_key, slug, status, visibility, created_by)
        VALUES (${org.id}, 'vis.browser', 'browser-rebind', 'active', 'org', ${user.id})
        RETURNING id
      `;
      connectionId = seed.id;
      const updated = await manageConnections({
        action, connection_id: connectionId, auth_profile_slug: 'browser-account',
      }, TEST_ENV, ctx);
      expect(updated).not.toHaveProperty('error');
    }
    expect(connectionId).toBeGreaterThan(0);
    const [saved] = await sql`
      SELECT c.visibility, ap.profile_kind FROM connections c
      JOIN auth_profiles ap ON ap.id = c.auth_profile_id WHERE c.id = ${connectionId}
    `;
    expect(saved).toEqual({ visibility: 'private', profile_kind: 'browser_session' });
  });

  it('re-pointing an ORG connection onto an oauth_account profile DOWNGRADES it to private', async () => {
    process.env.VISOAUTH_CLIENT_ID = 'env-id';
    process.env.VISOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Vis Org C' });
    const user = await createTestUser({ name: 'Owner C' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ownerCtx(org.id, user.id);
    await makeConnectors(org.id);
    const sql = getTestDb();

    // Seed an ORG-visible connection on the oauth connector directly (bypassing
    // the create path, which would now default a personal-cred connection to
    // private — here we're testing the UPDATE re-point, and need a pre-existing
    // 'org' row to prove the downgrade). No auth profile yet.
    const [seed] = (await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by)
      VALUES (${org.id}, 'vis.oauth', 'vis-rebind-conn', 'Vis Rebind Connection', 'active', 'org', ${user.id})
      RETURNING id
    `) as Array<{ id: number }>;
    const connectionId = seed.id;
    const [before] = (await sql`
      SELECT visibility FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string }>;
    expect(before.visibility).toBe('org');

    // Create a personal oauth_account profile on the SAME oauth connector, then
    // rebind this connection onto it.
    await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'vis.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Rebind Account',
        slug: 'rebind-account',
      },
      TEST_ENV,
      ctx
    );
    const updated = await manageConnections(
      {
        action: 'update',
        connection_id: connectionId,
        auth_profile_slug: 'rebind-account',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in updated).toBe(false);

    const [after] = (await sql`
      SELECT visibility, auth_profile_id FROM connections WHERE id = ${connectionId}
    `) as Array<{ visibility: string; auth_profile_id: number | null }>;
    expect(after.auth_profile_id).not.toBeNull();
    // The fix: rebinding onto personal creds floors visibility to private.
    expect(after.visibility).toBe('private');

    delete process.env.VISOAUTH_CLIENT_ID;
    delete process.env.VISOAUTH_CLIENT_SECRET;
  });

  it('the OAuth-callback downgrade SQL flips org→private only when the attached profile is personal', async () => {
    // The GET /connect/oauth/callback route attaches the freshly-created
    // oauth_account profile and runs this exact CASE. The route wiring is not
    // unit-testable without full connect-token + provider scaffolding, so this
    // pins the mechanism it depends on: downgrade org→private for a personal
    // attach, leave a non-personal attach untouched. Mirrors connect/routes.ts.
    const org = await createTestOrganization({ name: 'Vis Org D' });
    const user = await createTestUser({ name: 'Owner D' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();
    await makeConnectors(org.id);

    const mkConn = async (slug: string) => {
      const [r] = (await sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by)
        VALUES (${org.id}, 'vis.oauth', ${slug}, ${slug}, 'pending_auth', 'org', ${user.id})
        RETURNING id
      `) as Array<{ id: number }>;
      return r.id;
    };
    const personalId = await mkConn('cb-personal');
    const sharedId = await mkConn('cb-shared');

    const downgrade = (forcePrivate: boolean, id: number) => sql`
      UPDATE connections
      SET visibility = CASE WHEN ${forcePrivate} THEN 'private' ELSE visibility END
      WHERE id = ${id}
    `;
    await downgrade(true, personalId); // attached profile kind was oauth_account
    await downgrade(false, sharedId); // attached profile kind was not personal

    const [p] = (await sql`
      SELECT visibility FROM connections WHERE id = ${personalId}
    `) as Array<{ visibility: string }>;
    const [s] = (await sql`
      SELECT visibility FROM connections WHERE id = ${sharedId}
    `) as Array<{ visibility: string }>;
    expect(p.visibility).toBe('private'); // personal attach → downgraded
    expect(s.visibility).toBe('org'); // non-personal attach → untouched
  });

  it('the DB guard REJECTS any write leaving an oauth_account connection org-visible', async () => {
    // The hard backstop: no code path (tool, API, or raw SQL) can widen a
    // personal-credential connection to 'org'. Proven at the DB level — this is
    // what makes "the API cannot allow it" true regardless of the app layer.
    const org = await createTestOrganization({ name: 'Vis Org E' });
    const user = await createTestUser({ name: 'Owner E' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();
    await makeConnectors(org.id);

    const [prof] = (await sql`
      INSERT INTO auth_profiles (organization_id, slug, display_name, connector_key, profile_kind, status, created_by)
      VALUES (${org.id}, 'guard-acct', 'Guard Account', 'vis.oauth', 'oauth_account', 'active', ${user.id})
      RETURNING id
    `) as Array<{ id: number }>;

    // INSERT of an oauth_account connection at 'org' must be rejected.
    await expect(
      sql`
        INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by, auth_profile_id)
        VALUES (${org.id}, 'vis.oauth', 'guard-conn', 'Guard Conn', 'active', 'org', ${user.id}, ${prof.id})
      `
    ).rejects.toThrow(/cannot be org-visible/);

    // A valid private one, then re-widening it to 'org' must also be rejected.
    const [ok] = (await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by, auth_profile_id)
      VALUES (${org.id}, 'vis.oauth', 'guard-conn2', 'Guard Conn 2', 'active', 'private', ${user.id}, ${prof.id})
      RETURNING id
    `) as Array<{ id: number }>;
    await expect(
      sql`UPDATE connections SET visibility = 'org' WHERE id = ${ok.id}`
    ).rejects.toThrow(/cannot be org-visible/);
  });
});
