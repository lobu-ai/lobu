/**
 * How a connection's `visibility` is decided, through every path that sets it.
 *
 * A connection reads through ONE org-level credential (its auth profile's token),
 * so an `org`-visible connection lets every org member read live through the
 * owner's account. For a personal login (`oauth_account` or `browser_session`)
 * that means org-visible = the owner's private account exposed to
 * the whole org. So a personal-credential connection must default to `private`
 * EVEN when an admin/owner creates it — the credential being personal outranks
 * the role. Every other credential kind (env/oauth_app/service account) backs a
 * genuinely shared source and keeps the role-based default (owner → `org`).
 * Before the fix, resolveConnectionVisibility branched on role alone, so an
 * OWNER's oauth_account connection defaulted `org` — the exposure bug.
 *
 * Paths covered:
 *   - `manage_connections` create/update defaults and re-points, plus the DB
 *     guard trigger that backstops them.
 *   - the share switch: `manage_connections` `update` accepts
 *     `visibility: 'org' | 'private'` (notably for a device connection
 *     auto-wired as `private` in a team workspace). Only the creator may flip
 *     it, not even an admin, and a personal-credential connection can never be
 *     widened: the app answers with a readable error before the DB guard
 *     trigger would reject the write.
 *   - the real OAuth callback route (connectRoutes GET /oauth/callback): a fresh
 *     connect inserts the connection `org` with no profile yet, and the callback
 *     creates the oauth_account profile, attaches it and DOWNGRADES the
 *     connection to `private`. Driven against scoped fake public provider
 *     responses for /token + /userinfo, with no module mocking, so it is safe
 *     under this suite's shared module graph (vitest `isolate: false`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { PERSONAL_CRED_ORG_VISIBILITY_ERROR } from '../../../tools/admin/helpers/connection-helpers';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { createConnectToken } from '../../../utils/connect-tokens';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

function ctxFor(
  organizationId: string,
  userId: string,
  memberRole: 'owner' | 'admin' | 'member' = 'owner'
): ToolContext {
  return {
    organizationId,
    userId,
    memberRole,
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

async function visibilityOf(connectionId: number): Promise<string> {
  const [row] = (await getTestDb()`
    SELECT visibility FROM connections WHERE id = ${connectionId}
  `) as unknown as Array<{ visibility: string }>;
  return row.visibility;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

beforeEach(async () => {
  await cleanupTestDatabase();
});

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
  it("an OWNER's oauth_account (personal-login) connection defaults to PRIVATE", async () => {
    process.env.VISOAUTH_CLIENT_ID = 'env-id';
    process.env.VISOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Vis Org A' });
    const user = await createTestUser({ name: 'Owner A' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
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
    const ctx = ctxFor(org.id, user.id);
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
    const ctx = ctxFor(org.id, user.id);
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
    const ctx = ctxFor(org.id, user.id);
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
    // oauth_account profile and runs this exact CASE. This pins the mechanism
    // in isolation: downgrade org→private for a personal attach, leave a
    // non-personal attach untouched. Mirrors connect/routes.ts; the route
    // wiring itself is driven end to end in the OAuth callback describe below.
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

async function seedConnection(params: {
  orgId: string;
  createdBy: string;
  slug: string;
  authProfileId?: number | null;
  connectorKey?: string;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status, visibility,
      created_by, auth_profile_id
    ) VALUES (
      ${params.orgId}, ${params.connectorKey ?? 'share.noauth'}, ${params.slug}, ${params.slug},
      'active', 'private', ${params.createdBy}, ${params.authProfileId ?? null}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return row.id;
}

describe('manage_connections update visibility (share switch)', () => {
  it('lets the creator share and unshare their connection', async () => {
    const org = await createTestOrganization({ name: 'Share Org' });
    const member = await createTestUser({ name: 'Share Creator' });
    await addUserToOrganization(member.id, org.id, 'member');
    await createTestConnectorDefinition({
      key: 'share.noauth',
      name: 'Share NoAuth',
      organization_id: org.id,
      feeds_schema: { items: {} },
    });
    const connectionId = await seedConnection({ orgId: org.id, createdBy: member.id, slug: 'mine' });

    const shared = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, member.id, 'member')
    );
    expect('error' in shared ? shared.error : null).toBeNull();
    expect(await visibilityOf(connectionId)).toBe('org');

    const unshared = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'private' },
      TEST_ENV,
      ctxFor(org.id, member.id, 'member')
    );
    expect('error' in unshared ? unshared.error : null).toBeNull();
    expect(await visibilityOf(connectionId)).toBe('private');
  });

  it("refuses anyone but the creator, including a workspace owner", async () => {
    const org = await createTestOrganization({ name: 'Share Org B' });
    const creator = await createTestUser({ name: 'Creator B' });
    const owner = await createTestUser({ name: 'Owner B' });
    await addUserToOrganization(creator.id, org.id, 'member');
    await addUserToOrganization(owner.id, org.id, 'owner');
    await createTestConnectorDefinition({
      key: 'share.noauth',
      name: 'Share NoAuth',
      organization_id: org.id,
      feeds_schema: { items: {} },
    });
    const connectionId = await seedConnection({ orgId: org.id, createdBy: creator.id, slug: 'theirs' });

    const res = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, owner.id, 'owner')
    );
    expect(res).toEqual({ error: "Only the connection's creator can change who it is shared with." });
    expect(await visibilityOf(connectionId)).toBe('private');
  });

  it('refuses to widen a personal-credential connection', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Share Org C' });
    const creator = await createTestUser({ name: 'Creator C' });
    await addUserToOrganization(creator.id, org.id, 'owner');
    await createTestConnectorDefinition({
      key: 'share.oauth',
      name: 'Share OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'shareoauth',
            requiredScopes: ['read'],
            clientIdKey: 'SHAREOAUTH_CLIENT_ID',
            clientSecretKey: 'SHAREOAUTH_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
    const [profile] = (await sql`
      INSERT INTO auth_profiles (organization_id, slug, display_name, connector_key, profile_kind, status, created_by)
      VALUES (${org.id}, 'my-account', 'My Account', 'share.oauth', 'oauth_account', 'active', ${creator.id})
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const connectionId = await seedConnection({
      orgId: org.id,
      createdBy: creator.id,
      slug: 'my-inbox',
      authProfileId: profile.id,
      connectorKey: 'share.oauth',
    });

    const res = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, creator.id, 'owner')
    );
    expect(res).toEqual({ error: PERSONAL_CRED_ORG_VISIBILITY_ERROR });
    expect(await visibilityOf(connectionId)).toBe('private');
  });
});

const PROVIDER_TOKEN_URL = 'https://oauth-provider.example.com/token';
const PROVIDER_USERINFO_URL = 'https://oauth-provider.example.com/userinfo';
const originalFetch = globalThis.fetch;
const IDENTITY_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

describe('OAuth callback downgrades a fresh personal connection to private (e2e)', () => {
  beforeEach(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === PROVIDER_TOKEN_URL) {
        const rawBody = init?.body;
        if (!(typeof rawBody === 'string' || rawBody instanceof URLSearchParams)) {
          throw new TypeError('Expected an OAuth form body');
        }
        const body = new URLSearchParams(rawBody);
        const code = body.get('code') ?? '';
        const calendar = code === 'calendar-code';
        return Response.json({
          access_token: 'fake-access-token-' + code,
          refresh_token: 'fake-refresh-token-' + code,
          expires_in: 3600,
          scope: [
            calendar
              ? 'https://www.googleapis.com/auth/calendar.readonly'
              : 'https://www.googleapis.com/auth/gmail.readonly',
            ...IDENTITY_SCOPES,
            'synthetic.sibling.read',
          ].join(' '),
        });
      }
      if (url === PROVIDER_USERINFO_URL) {
        return Response.json({ email: 'owner@example.com', name: 'Owner D', id: 'acct-123' });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('a fresh Gmail-style OAuth connect ends up private after the callback', async () => {
    process.env.CBOAUTH_CLIENT_ID = 'env-id';
    process.env.CBOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'CB Org' });
    const user = await createTestUser({ name: 'Owner D' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();

    await createTestConnectorDefinition({
      key: 'cb.oauth',
      name: 'CB OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'cboauth',
            requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            clientIdKey: 'CBOAUTH_CLIENT_ID',
            clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
            tokenUrl: PROVIDER_TOKEN_URL,
            userinfoUrl: PROVIDER_USERINFO_URL,
          },
        ],
      },
      feeds_schema: { items: {} },
    });

    // The fresh connect: connection inserted pending_auth + visibility='org',
    // no auth_profile yet (the exposure precondition the callback must fix).
    const [conn] = (await sql`
      INSERT INTO connections (organization_id, connector_key, slug, display_name, status, visibility, created_by)
      VALUES (${org.id}, 'cb.oauth', 'cb-conn', 'CB Connection', 'pending_auth', 'org', ${user.id})
      RETURNING id
    `) as Array<{ id: number }>;

    // Connect token carrying pendingProfileMeta → the callback creates the
    // oauth_account profile and attaches it. tokenUrl/userinfoUrl point at the
    // scoped public-provider stub so the real exchange succeeds.
    const tokenRow = await createConnectToken({
      connectionId: conn.id,
      organizationId: org.id,
      connectorKey: 'cb.oauth',
      authType: 'oauth',
      createdBy: user.id,
      authConfig: {
        provider: 'cboauth',
        clientIdKey: 'CBOAUTH_CLIENT_ID',
        clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
        tokenUrl: PROVIDER_TOKEN_URL,
        userinfoUrl: PROVIDER_USERINFO_URL,
        requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        pendingProfileMeta: {
          displayName: 'CB Account',
          slug: 'cb-account',
          connectorKey: 'cb.oauth',
          provider: 'cboauth',
        },
      },
    });

    // Drive the REAL callback route.
    const res = await connectRoutes.request(
      `/oauth/callback?state=${encodeURIComponent(tokenRow.token)}&code=fake-auth-code`
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);

    const [after] = (await sql`
      SELECT c.visibility, c.status, ap.profile_kind
      FROM connections c
      LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      WHERE c.id = ${conn.id}
    `) as Array<{ visibility: string; status: string; profile_kind: string | null }>;

    // The oauth_account profile was created + attached, and the connection was
    // downgraded to private — the primary exposure is closed end-to-end.
    expect(after.profile_kind).toBe('oauth_account');
    expect(after.status).toBe('active');
    expect(after.visibility).toBe('private');

    delete process.env.CBOAUTH_CLIENT_ID;
    delete process.env.CBOAUTH_CLIENT_SECRET;
  });

  it('keeps same-provider connector OAuth grants isolated for the same upstream account', async () => {
    process.env.CBOAUTH_CLIENT_ID = 'env-id';
    process.env.CBOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Grant Isolation Org' });
    const user = await createTestUser({ name: 'Grant Isolation User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();

    const grants = [
      {
        connectorKey: 'cb.calendar',
        slug: 'calendar-account',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
        code: 'calendar-code',
      },
      {
        connectorKey: 'cb.gmail',
        slug: 'gmail-account',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        code: 'gmail-code',
      },
    ];

    for (const grant of grants) {
      await createTestConnectorDefinition({
        key: grant.connectorKey,
        name: grant.connectorKey,
        organization_id: org.id,
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'cboauth',
              requiredScopes: [grant.scope, 'email', 'profile'],
              clientIdKey: 'CBOAUTH_CLIENT_ID',
              clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
              tokenUrl: PROVIDER_TOKEN_URL,
              userinfoUrl: PROVIDER_USERINFO_URL,
            },
          ],
        },
        feeds_schema: { items: {} },
      });

      const [connection] = (await sql`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status, visibility, created_by
        )
        VALUES (
          ${org.id}, ${grant.connectorKey}, ${grant.connectorKey}, ${grant.connectorKey},
          'pending_auth', 'org', ${user.id}
        )
        RETURNING id
      `) as Array<{ id: number }>;

      const tokenRow = await createConnectToken({
        connectionId: connection.id,
        organizationId: org.id,
        connectorKey: grant.connectorKey,
        authType: 'oauth',
        createdBy: user.id,
        authConfig: {
          provider: 'cboauth',
          clientIdKey: 'CBOAUTH_CLIENT_ID',
          clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
          tokenUrl: PROVIDER_TOKEN_URL,
          userinfoUrl: PROVIDER_USERINFO_URL,
          requestedScopes: [grant.scope, 'email', 'profile'],
          pendingProfileMeta: {
            displayName: grant.connectorKey,
            slug: grant.slug,
            connectorKey: grant.connectorKey,
            provider: 'cboauth',
          },
        },
      });

      const res = await connectRoutes.request(
        '/oauth/callback?state=' + encodeURIComponent(tokenRow.token) + '&code=' + grant.code
      );
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(400);
    }

    const accounts = (await sql`
      SELECT
        ap.connector_key,
        ap.account_id,
        a."accountId" AS provider_account_id,
        a.scope,
        ap.auth_data,
        ap.status,
        a."accessToken" AS access_token
      FROM auth_profiles ap
      JOIN account a ON a.id = ap.account_id
      WHERE ap.organization_id = ${org.id}
        AND ap.connector_key IN ('cb.calendar', 'cb.gmail')
      ORDER BY ap.connector_key
    `) as Array<{
      connector_key: string;
      account_id: string;
      provider_account_id: string;
      scope: string | null;
      auth_data: { requested_scopes: string[]; granted_scopes: string[] };
      status: string;
      access_token: string | null;
    }>;

    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.account_id).not.toBe(accounts[1]?.account_id);
    for (const account of accounts) {
      const grant = grants.find((entry) => entry.connectorKey === account.connector_key)!;
      const expectedScopes = [grant.scope, ...IDENTITY_SCOPES];
      expect(account.provider_account_id.startsWith('lobu-connector:')).toBe(true);
      expect(account.scope?.split(' ')).toEqual(expectedScopes);
      expect(account.auth_data.granted_scopes).toEqual(expectedScopes);
      expect(account.auth_data.requested_scopes).toEqual([grant.scope, 'email', 'profile']);
      expect(account.status).toBe('active');
    }
    expect(accounts.find((row) => row.connector_key === 'cb.calendar')?.access_token).toBe(
      'fake-access-token-calendar-code'
    );
    expect(accounts.find((row) => row.connector_key === 'cb.gmail')?.access_token).toBe(
      'fake-access-token-gmail-code'
    );

    delete process.env.CBOAUTH_CLIENT_ID;
    delete process.env.CBOAUTH_CLIENT_SECRET;
  });
  it('migrates a legacy shared provider account to an isolated connector grant on reauth', async () => {
    process.env.CBOAUTH_CLIENT_ID = 'env-id';
    process.env.CBOAUTH_CLIENT_SECRET = 'env-secret';
    const org = await createTestOrganization({ name: 'Legacy Grant Repair Org' });
    const user = await createTestUser({ name: 'Legacy Grant Repair User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();
    const calendarScope = 'https://www.googleapis.com/auth/calendar.readonly';

    await createTestConnectorDefinition({
      key: 'cb.calendar',
      name: 'CB Calendar',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'cboauth',
            requiredScopes: [calendarScope],
            clientIdKey: 'CBOAUTH_CLIENT_ID',
            clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
            tokenUrl: PROVIDER_TOKEN_URL,
            userinfoUrl: PROVIDER_USERINFO_URL,
          },
        ],
      },
      feeds_schema: { items: {} },
    });

    const legacyAccountId = `legacy-google-${org.id}`;
    await sql`
      INSERT INTO account (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt",
        scope, "createdAt", "updatedAt"
      ) VALUES (
        ${legacyAccountId}, 'acct-123', 'cboauth', ${user.id},
        'gmail-overwrite-token', 'gmail-overwrite-refresh',
        ${new Date(Date.now() + 3600_000).toISOString()},
        'https://www.googleapis.com/auth/gmail.readonly',
        NOW(), NOW()
      )
    `;

    const [profile] = (await sql`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key, profile_kind,
        status, auth_data, account_id, provider, created_by
      ) VALUES (
        ${org.id}, 'legacy-calendar-account', 'Legacy Calendar', 'cb.calendar',
        'oauth_account', 'active',
        ${sql.json({
          requested_scopes: [calendarScope],
          granted_scopes: [calendarScope],
          identity: { id: 'acct-123', email: 'owner@example.com' },
        })},
        ${legacyAccountId}, 'cboauth', ${user.id}
      )
      RETURNING id
    `) as Array<{ id: number }>;

    const [connection] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, visibility,
        account_id, auth_profile_id, created_by
      ) VALUES (
        ${org.id}, 'cb.calendar', 'legacy-calendar', 'Legacy Calendar',
        'active', 'private', ${legacyAccountId}, ${profile.id}, ${user.id}
      )
      RETURNING id
    `) as Array<{ id: number }>;

    const tokenRow = await createConnectToken({
      authProfileId: profile.id,
      organizationId: org.id,
      connectorKey: 'cb.calendar',
      authType: 'oauth',
      createdBy: user.id,
      authConfig: {
        provider: 'cboauth',
        clientIdKey: 'CBOAUTH_CLIENT_ID',
        clientSecretKey: 'CBOAUTH_CLIENT_SECRET',
        tokenUrl: PROVIDER_TOKEN_URL,
        userinfoUrl: PROVIDER_USERINFO_URL,
        requestedScopes: [calendarScope],
      },
    });

    const res = await connectRoutes.request(
      '/oauth/callback?state=' +
        encodeURIComponent(tokenRow.token) +
        '&code=calendar-code'
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);

    const [after] = (await sql`
      SELECT
        ap.account_id,
        a."accountId" AS provider_account_id,
        a.scope,
        a."accessToken" AS access_token,
        c.account_id AS connection_account_id
      FROM auth_profiles ap
      JOIN account a ON a.id = ap.account_id
      JOIN connections c ON c.auth_profile_id = ap.id
      WHERE ap.id = ${profile.id}
        AND c.id = ${connection.id}
    `) as Array<{
      account_id: string;
      provider_account_id: string;
      scope: string | null;
      access_token: string | null;
      connection_account_id: string | null;
    }>;

    expect(after.account_id).not.toBe(legacyAccountId);
    expect(after.provider_account_id.startsWith('lobu-connector:')).toBe(true);
    expect(after.scope).toBe(calendarScope);
    expect(after.access_token).toBe('fake-access-token-calendar-code');
    expect(after.connection_account_id).toBe(after.account_id);

    const [legacy] = (await sql`
      SELECT scope, "accessToken" AS access_token
      FROM account
      WHERE id = ${legacyAccountId}
    `) as Array<{ scope: string | null; access_token: string | null }>;
    expect(legacy.scope).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(legacy.access_token).toBe('gmail-overwrite-token');

    delete process.env.CBOAUTH_CLIENT_ID;
    delete process.env.CBOAUTH_CLIENT_SECRET;
  });
});
