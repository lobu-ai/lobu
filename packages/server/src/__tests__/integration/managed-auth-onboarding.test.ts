/**
 * Managed-auth onboarding must be self-describing and usable by a brand-new
 * Lobu user. The user starts in their own workspace, discovers a public org's
 * managed OAuth offer, joins it, and creates their own consent-only grant.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localSetupOption, publicSetupOptions } from '../../connect/setup-options';
import { primeAppInstallationMethods, getPrimedBundledMethod } from '../../gateway/installation/app-install-credentials';
import { setupRoutes } from '../../connect/setup-routes';
import { createAuthProfile } from '../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../workspace';
import { TestApiClient } from '../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

async function seedManagedGoogleOrg() {
  const org = await createTestOrganization({
    name: 'Managed Connectors',
    slug: 'managed-connectors',
    visibility: 'public',
  });

  for (const [key, name] of [
    ['google.gmail', 'Gmail'],
    ['google.calendar', 'Google Calendar'],
  ] as const) {
    await createTestConnectorDefinition({
      key,
      name,
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: ['openid'],
            authorizationUrl: 'https://accounts.example/authorize',
            tokenUrl: 'https://accounts.example/token',
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
  }

  // A connector-bound Google app is provider-wide, so it can serve both Gmail
  // and Calendar. Discovery must mirror the runtime profile resolver.
  await createAuthProfile({
    organizationId: org.id,
    connectorKey: 'google.gmail',
    displayName: 'Managed Google App',
    profileKind: 'oauth_app',
    provider: 'google',
    authData: {
      GOOGLE_CLIENT_ID: 'managed-client-id',
      GOOGLE_CLIENT_SECRET: 'managed-client-secret',
    },
  });

  // The OAuth app is provider-wide, but this connector prefers env auth. It
  // must not be advertised because a bare managed connect would follow the env
  // path rather than start provider consent.
  await createTestConnectorDefinition({
    key: 'google.env-first',
    name: 'Google env-first',
    organization_id: org.id,
    auth_schema: {
      methods: [
        { type: 'env_keys', fields: [{ key: 'GOOGLE_TOKEN' }] },
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['openid'],
          authorizationUrl: 'https://accounts.example/authorize',
          tokenUrl: 'https://accounts.example/token',
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });

  return org;
}

async function seedHybridManagedConnector(organizationId: string) {
  await createTestConnectorDefinition({
    key: 'hybrid.oauth',
    name: 'Hybrid OAuth',
    organization_id: organizationId,
    auth_schema: {
      methods: [
        { type: 'app_installation', provider: 'hybrid' },
        {
          type: 'oauth',
          provider: 'hybrid',
          requiredScopes: ['profile'],
          authorizationUrl: 'https://hybrid.example/authorize',
          tokenUrl: 'https://hybrid.example/token',
          clientIdKey: 'HYBRID_CLIENT_ID',
          clientSecretKey: 'HYBRID_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });
  await createAuthProfile({
    organizationId,
    connectorKey: 'hybrid.oauth',
    displayName: 'Managed Hybrid App',
    profileKind: 'oauth_app',
    provider: 'hybrid',
    authData: {
      HYBRID_CLIENT_ID: 'hybrid-client-id',
      HYBRID_CLIENT_SECRET: 'hybrid-client-secret',
    },
  });
}

describe('managed-auth onboarding', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('offers a configured bundled app before the catalog connector is installed', async () => {
    const org = await createTestOrganization({ slug: 'catalog-setup-test' });
    await primeAppInstallationMethods([{ connectorKey: 'github' }]);
    const method = getPrimedBundledMethod('github');
    expect(method).toBeTruthy();
    const keys = [method!.appIdKey!, method!.privateKeyKey!, method!.appSlugKey!];
    const previous = keys.map(key => process.env[key]);
    try {
      for (const key of keys) process.env[key] = 'synthetic-app-value';
      expect(await localSetupOption(org.id, 'github', 'https://gateway.example')).toMatchObject({
        kind: 'local', configured: true, url: 'https://gateway.example/lobu/github/app/install',
      });
      delete process.env[keys[0]];
      expect(await localSetupOption(org.id, 'github', 'https://gateway.example')).toMatchObject({ configured: false });
      await createTestConnectorDefinition({ key: 'github', name: 'Org override', organization_id: org.id, auth_schema: { methods: [] } });
      expect(await localSetupOption(org.id, 'github', 'https://gateway.example')).toBeNull();
    } finally {
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
  });

  it('publishes only live public setup offers with no app secrets or private workspaces', async () => {
    const managed = await seedManagedGoogleOrg();
    const first = await publicSetupOptions('google.gmail', 'https://gateway.example');
    expect(first.options).toHaveLength(1);
    expect(first.options[0]).toMatchObject({ kind: 'managed_oauth', configured: true, execution: 'local', managed_by_org: managed.slug });
    expect(first.options[0].url).toContain('/connect/managed?');
    expect(JSON.stringify(first)).not.toContain('managed-client-secret');
    expect(JSON.stringify(first)).not.toContain('managed-client-id');
    const sql = getTestDb();
    await sql`UPDATE "organization" SET visibility = 'private' WHERE id = ${managed.id}`;
    expect((await publicSetupOptions('google.gmail', 'https://gateway.example')).options).toEqual([]);
  });

  it('removes the advertised choice when its app is disabled', async () => {
    const managed = await seedManagedGoogleOrg();
    const sql = getTestDb();
    await sql`UPDATE auth_profiles SET status = 'revoked' WHERE organization_id = ${managed.id}`;
    expect((await publicSetupOptions('google.gmail', 'https://gateway.example')).options).toEqual([]);
  });

  it('serves public setup metadata over HTTP without an account session', async () => {
    await seedManagedGoogleOrg();
    const response = await setupRoutes.request('https://gateway.example/api/connection-options?connector_key=google.gmail');
    expect(response.status).toBe(200);
    expect((await response.json()).options[0].kind).toBe('managed_oauth');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('discovers live managed OAuth offers before login without knowing the org slug', async () => {
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: managed.id,
      userId: null,
      memberRole: null,
      scopedToOrg: false,
    });
    const organizations = await client.organizations.list();
    const offer = organizations.find((organization) => organization.slug === managed.slug);

    expect(offer).toMatchObject({
      slug: 'managed-connectors',
      is_member: false,
      managed_auth: {
        credential_mode: 'managed',
        requires_user_login: true,
        requires_user_consent: true,
        join_required: true,
        connect_method: 'connections.connectManaged',
        local_bootstrap_command: 'lobu init --from-org managed-connectors',
        connectors: [
          {
            connector_key: 'google.calendar',
            provider: 'google',
            managed_by_org: 'managed-connectors',
          },
          {
            connector_key: 'google.gmail',
            provider: 'google',
            managed_by_org: 'managed-connectors',
          },
        ],
      },
    });
    expect(JSON.stringify(offer)).not.toContain('managed-client-secret');
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'google.gmail',
      })
    ).rejects.toThrow(/requires workspace membership with write access/i);
  });

  it('auto-joins the signed-in user when managed connect starts', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });

    const first = (await client.connections.connectManaged({
      managed_by_org: managed.slug,
      connector_key: 'google.gmail',
    })) as { connection_id: number; status: string };
    expect(first).toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
    });
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'google.gmail',
      })
    ).resolves.toMatchObject({
      connection_id: first.connection_id,
      status: 'pending_auth',
    });

    const organizations = await client.organizations.list();
    expect(organizations.find((organization) => organization.slug === managed.slug)).toMatchObject({
      is_member: true,
      managed_auth: { join_required: false },
    });
  });

  it('never reuses another user\'s managed OAuth account', async () => {
    const home = await createTestOrganization({ name: 'Second User Home' });
    const firstUser = await createTestUser({ email: 'first-user@example.com' });
    const secondUser = await createTestUser({ email: 'second-user@example.com' });
    await addUserToOrganization(secondUser.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();
    const firstUsersProfile = await createAuthProfile({
      organizationId: managed.id,
      connectorKey: 'google.gmail',
      displayName: 'First User Gmail',
      profileKind: 'oauth_account',
      provider: 'google',
      authData: { access_token: 'first-user-token' },
      createdBy: firstUser.id,
    });

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: secondUser.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    const result = (await client.connections.connectManaged({
      managed_by_org: managed.slug,
      connector_key: 'google.gmail',
    })) as { connection_id?: number; status?: string; connect_url?: string };

    expect(result).toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
      connect_url: expect.any(String),
    });
    const sql = getTestDb();
    const rows = (await sql`
      SELECT auth_profile_id, created_by
      FROM connections
      WHERE id = ${result.connection_id}
    `) as unknown as Array<{ auth_profile_id: number | null; created_by: string }>;
    expect(rows[0]).toEqual({ auth_profile_id: null, created_by: secondUser.id });
    expect(rows[0]?.auth_profile_id).not.toBe(firstUsersProfile.id);
  });

  it('uses managed OAuth when ordinary bare connects prefer app installation', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();
    await seedHybridManagedConnector(managed.id);

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'hybrid.oauth',
      })
    ).resolves.toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
    });
  });

  it('creates only the caller-owned consent grant and no cloud feeds', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const homeClient = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    const result = (await homeClient.connections.connectManaged({
      managed_by_org: managed.slug,
      connector_key: 'google.gmail',
    })) as { connection_id?: number; status?: string };

    expect(result).toMatchObject({
      connection_id: expect.any(Number),
      status: 'pending_auth',
    });

    const sql = getTestDb();
    const rows = (await sql`
      SELECT created_by, visibility, config
      FROM connections
      WHERE id = ${result.connection_id}
      LIMIT 1
    `) as unknown as Array<{
      created_by: string;
      visibility: string;
      config: Record<string, unknown> | null;
    }>;
    expect(rows[0]).toMatchObject({
      created_by: user.id,
      visibility: 'private',
      config: { consent_only: true },
    });

    const feeds = await sql`SELECT 1 FROM feeds WHERE connection_id = ${result.connection_id}`;
    expect(feeds).toHaveLength(0);
  });

  it('rejects a connector that the public org does not actively offer without joining', async () => {
    const home = await createTestOrganization({ name: 'Fresh User Home' });
    const user = await createTestUser({ email: 'fresh-user@example.com' });
    await addUserToOrganization(user.id, home.id, 'owner');
    const managed = await seedManagedGoogleOrg();

    const client = await TestApiClient.for({
      organizationId: home.id,
      userId: user.id,
      memberRole: 'owner',
      scopedToOrg: false,
    });
    await expect(
      client.connections.connectManaged({
        managed_by_org: managed.slug,
        connector_key: 'github',
      })
    ).rejects.toThrow(/No active managed OAuth offer/i);

    const sql = getTestDb();
    const memberships = await sql`
      SELECT 1
      FROM "member"
      WHERE "organizationId" = ${managed.id}
        AND "userId" = ${user.id}
    `;
    expect(memberships).toHaveLength(0);
  });
});
