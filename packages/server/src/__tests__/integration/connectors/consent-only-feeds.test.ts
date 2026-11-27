/**
 * Consent-only connections — the by-construction "data stays local" guarantee.
 *
 * A managed connector's OAuth grant is held by a connection in a PUBLIC cloud
 * org. That cloud grant-holder must be CONSENT-ONLY: it exists solely to hold
 * the grant for delegation (the local instance fetches a short-lived token from
 * it via POST /oauth/connection-token), and it can NEVER have feeds — so the
 * cloud worker never syncs, so the data only ever lives on the local instance.
 *
 * This is enforced by construction, not convention: a connection whose
 * persisted `config.consent_only === true` rejects feed creation. These tests
 * pin that invariant:
 *   1. Creating a feed on a consent-only connection → rejected with a clear error.
 *   2. Creating a feed on a normal connection → still works (unchanged).
 *   3. A consent-only connection still resolves an access token via
 *      /oauth/connection-token (consent-only blocks feeds, not auth).
 */

import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionTokenRoutes } from '../../../connect/connection-token-route';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import type { ToolContext } from '../../../tools/registry';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

const REFRESHED = {
  access_token: 'consent-only-refreshed-token',
  refresh_token: 'consent-only-refresh-token',
  expires_in: 3600,
};
const MANAGED_SECRET = 'consent-only-secret';

const PROVIDER_TOKEN_URL = 'https://oauth-provider.example.com/consent/token';
const originalFetch = globalThis.fetch;

function ctxFor(organizationId: string, userId: string): ToolContext {
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

function buildCloudApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', connectionTokenRoutes);
  return app;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === PROVIDER_TOKEN_URL) return Response.json(REFRESHED);
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('consent-only connections — feed creation is rejected by construction', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('rejects creating a feed on a consent-only connection with a clear error', async () => {
    const org = await createTestOrganization({ name: 'Consent Only Org' });
    const user = await createTestUser({ name: 'Consent Only User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const sql = getTestDb();
    // A consent-only connection: holds the grant for delegation, no feeds ever.
    const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, created_by,
        created_at, updated_at
      ) VALUES (
        ${org.id}, 'demo.oauth', 'demo-consent', 'Consent Only Connection', 'active',
        ${sql.json({ consent_only: true })}, ${user.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const res = await manageFeeds(
      {
        action: 'create_feed',
        connection_id: Number(connRows[0].id),
        feed_key: 'items',
        display_name: 'Should Not Exist',
      },
      TEST_ENV,
      ctx
    );

    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toBe(
        'This connection is consent-only (holds an OAuth grant for delegation) and cannot have feeds.'
      );
    }

    // No feed row was created.
    const feedRows = await sql`
      SELECT id FROM feeds WHERE organization_id = ${org.id} AND connection_id = ${Number(connRows[0].id)}
    `;
    expect(feedRows).toHaveLength(0);
  });

  it('still allows creating a feed on a normal (non-consent-only) connection', async () => {
    const org = await createTestOrganization({ name: 'Normal Org' });
    const user = await createTestUser({ name: 'Normal User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const sql = getTestDb();
    // A normal connection: no consent_only flag (config carries an unrelated key).
    const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, created_by,
        created_at, updated_at
      ) VALUES (
        ${org.id}, 'demo.oauth', 'demo-normal', 'Normal Connection', 'active',
        ${sql.json({ some_setting: 'x' })}, ${user.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const res = await manageFeeds(
      {
        action: 'create_feed',
        connection_id: Number(connRows[0].id),
        feed_key: 'items',
        display_name: 'Normal Feed',
      },
      TEST_ENV,
      ctx
    );

    expect('error' in res).toBe(false);
    if ('feed' in res) {
      expect((res.feed as { status: string }).status).toBe('active');
    }

    const feedRows = await sql`
      SELECT id FROM feeds WHERE organization_id = ${org.id} AND connection_id = ${Number(connRows[0].id)} AND deleted_at IS NULL
    `;
    expect(feedRows).toHaveLength(1);
  });

  it('a consent-only connection still resolves an access token via /oauth/connection-token', async () => {
    // The consent-only connection holds the grant; consent_only blocks feeds,
    // NOT auth delegation. The token endpoint must still mint a fresh token.
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Consent Token Org', visibility: 'public' });
    const owner = await createTestUser({ name: 'Consent Token Owner' });
    await addUserToOrganization(owner.id, org.id, 'member');

    const connectorKey = 'demo.oauth';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'demo',
            requiredScopes: ['read'],
            authorizationUrl: 'https://demo.example/authorize',
            tokenUrl: PROVIDER_TOKEN_URL,
            tokenEndpointAuthMethod: 'client_secret_post',
            clientIdKey: 'DEMO_CLIENT_ID',
            clientSecretKey: 'DEMO_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });

    const appProfile = await createAuthProfile({
      organizationId: org.id,
      connectorKey,
      displayName: 'Managed Demo App',
      profileKind: 'oauth_app',
      provider: 'demo',
      authData: { DEMO_CLIENT_ID: 'managed-cid', DEMO_CLIENT_SECRET: MANAGED_SECRET },
    });

    const accountId = `acct_${org.id}`;
    const expiringSoon = new Date(Date.now() + 60 * 1000).toISOString();
    await sql`
      INSERT INTO "account" (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt",
        scope, "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, 'demo', ${owner.id},
        ${'stale-token'}, ${'refresh-original'}, ${expiringSoon},
        'read', NOW(), NOW()
      )
    `;
    const accountProfile = await createAuthProfile({
      organizationId: org.id,
      connectorKey,
      displayName: 'Demo Account',
      profileKind: 'oauth_account',
      provider: 'demo',
      accountId,
    });

    // The grant-holder connection is CONSENT-ONLY (config.consent_only) AND
    // owned by the member — the token endpoint must still serve it.
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        account_id, auth_profile_id, app_auth_profile_id, created_by, config,
        visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, ${connectorKey}, ${`demo-${org.id}`}, 'Demo Connection', 'active',
        ${accountId}, ${accountProfile.id}, ${appProfile.id}, ${owner.id},
        ${sql.json({ consent_only: true })}, 'private', NOW(), NOW()
      )
    `;

    const ownerPat = await createTestPAT(owner.id, org.id, {
      scope: 'mcp:read mcp:write connections:token',
    });
    const app = buildCloudApp();
    // Only a lender workspace's grants are delegated.
    const savedLenderOrgs = process.env.LOBU_MANAGED_AUTH_ORGS;
    process.env.LOBU_MANAGED_AUTH_ORGS = org.slug;
    let res: Response;
    try {
      res = await app.fetch(
        new Request('http://cloud.local/oauth/connection-token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerPat.token}`,
          },
          body: JSON.stringify({ org: org.id, connector_key: connectorKey }),
        }),
        TEST_ENV
      );
    } finally {
      if (savedLenderOrgs === undefined) delete process.env.LOBU_MANAGED_AUTH_ORGS;
      else process.env.LOBU_MANAGED_AUTH_ORGS = savedLenderOrgs;
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBe(REFRESHED.access_token);
    // Still never leaks the refresh token or secret.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(REFRESHED.refresh_token);
    expect(serialized).not.toContain(MANAGED_SECRET);
  });
});

describe('consent-only connections — making a connection consent-only is bidirectional', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function seedNormalConnection(orgName: string): Promise<{
    orgId: string;
    userId: string;
    ctx: ToolContext;
    connectionId: number;
  }> {
    const org = await createTestOrganization({ name: orgName });
    const user = await createTestUser({ name: `${orgName} User` });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);

    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [{ type: 'oauth', provider: 'demo', requiredScopes: ['read'] }],
      },
      feeds_schema: { items: {} },
    });

    const sql = getTestDb();
    const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, config, created_by,
        created_at, updated_at
      ) VALUES (
        ${org.id}, 'demo.oauth', ${`demo-${org.id}`}, 'Demo Connection', 'active',
        ${sql.json({})}, ${user.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return { orgId: org.id, userId: user.id, ctx, connectionId: Number(connRows[0].id) };
  }

  it('rejects making a connection that HAS a feed consent-only; the feed stays untouched', async () => {
    const { orgId, ctx, connectionId } = await seedNormalConnection('Has Feed Org');

    // Give the connection an active feed.
    const feedRes = await manageFeeds(
      { action: 'create_feed', connection_id: connectionId, feed_key: 'items', display_name: 'A Feed' },
      TEST_ENV,
      ctx
    );
    expect('error' in feedRes).toBe(false);

    // Attempt to flip it to consent-only → must be rejected.
    const updateRes = await manageConnections(
      { action: 'update', connection_id: connectionId, config: { consent_only: true } },
      TEST_ENV,
      ctx
    );
    expect('error' in updateRes).toBe(true);
    if ('error' in updateRes) {
      expect(updateRes.error).toBe(
        'This connection has feeds; a consent-only connection cannot have feeds. Remove its feeds first.'
      );
    }

    const sql = getTestDb();
    // The connection was NOT flipped to consent_only.
    const connRows = await sql`
      SELECT config FROM connections WHERE id = ${connectionId} AND organization_id = ${orgId}
    `;
    expect((connRows[0] as { config: Record<string, unknown> | null }).config?.consent_only).not.toBe(
      true
    );
    // The feed is untouched (still present + active).
    const feedRows = await sql`
      SELECT status FROM feeds WHERE connection_id = ${connectionId} AND deleted_at IS NULL
    `;
    expect(feedRows).toHaveLength(1);
    expect((feedRows[0] as { status: string }).status).toBe('active');
  });

  it('allows making a connection with NO feeds consent-only', async () => {
    const { orgId, ctx, connectionId } = await seedNormalConnection('No Feed Org');

    const updateRes = await manageConnections(
      { action: 'update', connection_id: connectionId, config: { consent_only: true } },
      TEST_ENV,
      ctx
    );
    expect('error' in updateRes).toBe(false);

    const sql = getTestDb();
    const connRows = await sql`
      SELECT config FROM connections WHERE id = ${connectionId} AND organization_id = ${orgId}
    `;
    expect((connRows[0] as { config: Record<string, unknown> | null }).config?.consent_only).toBe(true);

    // And now feed creation on it is rejected too (the other direction).
    const feedRes = await manageFeeds(
      { action: 'create_feed', connection_id: connectionId, feed_key: 'items', display_name: 'Nope' },
      TEST_ENV,
      ctx
    );
    expect('error' in feedRes).toBe(true);
    if ('error' in feedRes) {
      expect(feedRes.error).toBe(
        'This connection is consent-only (holds an OAuth grant for delegation) and cannot have feeds.'
      );
    }
  });
});
