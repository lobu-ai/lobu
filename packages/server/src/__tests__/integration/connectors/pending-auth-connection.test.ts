/**
 * Round-3 regression: a connection referencing a freshly-created `pending_auth`
 * `oauth_account` auth profile in the *same* `lobu apply` must succeed — the
 * connection is created `pending_auth` and the OAuth callback flips both to
 * `active`. Previously `manage_auth_profiles.create_auth_profile` for
 * `oauth_account` returned a token-only response (no row), so the connection's
 * `auth_profile_slug` lookup failed; and even after persisting the row, the
 * connection *create* path still rejected a non-`active` auth profile.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

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
    baseUrl: 'https://gateway.test/lobu',
  } as ToolContext;
}

describe('connectors — pending-auth oauth_account in the same apply', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates a pending_auth auth profile row + connect token, then a pending_auth connection that references it', async () => {
    const org = await createTestOrganization({ name: 'Pending Auth Org' });
    const user = await createTestUser({ name: 'Pending Auth User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    // Org-scoped connector with an OAuth method (so oauth_account/oauth_app are valid).
    await createTestConnectorDefinition({
      key: 'demo.oauth',
      name: 'Demo OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'demo',
            requiredScopes: ['read'],
            clientIdKey: 'DEMO_CLIENT_ID',
            clientSecretKey: 'DEMO_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });

    // App-credentials profile (active — carries client id/secret).
    const appRes = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_app',
        display_name: 'Demo OAuth App',
        slug: 'demo-app',
        credentials: { DEMO_CLIENT_ID: 'cid', DEMO_CLIENT_SECRET: 'csec' },
      },
      TEST_ENV,
      ctx
    );
    expect('auth_profile' in appRes && appRes.auth_profile).toBeTruthy();

    // Account profile — must persist a real pending_auth row + connect token.
    const accRes = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account',
        slug: 'demo-account',
      },
      TEST_ENV,
      ctx
    );
    expect('auth_profile' in accRes).toBe(true);
    if ('auth_profile' in accRes) {
      expect(accRes.auth_profile.status).toBe('pending_auth');
      expect(accRes.auth_profile.slug).toBe('demo-account');
    }
    expect('connect_url' in accRes && accRes.connect_url).toBeTruthy();
    expect('connect_token' in accRes && accRes.connect_token).toBeTruthy();

    const sql = getTestDb();
    const rows = await sql`
      SELECT status, profile_kind FROM auth_profiles
      WHERE organization_id = ${org.id} AND slug = 'demo-account'
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { status: string }).status).toBe('pending_auth');

    // The connect token must be linked to the profile (so the callback updates it).
    const profileId = (
      (await sql`SELECT id FROM auth_profiles WHERE organization_id = ${org.id} AND slug = 'demo-account'`)[0] as {
        id: number;
      }
    ).id;
    const tokenRows = await sql`
      SELECT auth_profile_id FROM connect_tokens
      WHERE organization_id = ${org.id} AND connector_key = 'demo.oauth' AND status = 'pending'
    `;
    expect(tokenRows).toHaveLength(1);
    expect(String((tokenRows[0] as { auth_profile_id: unknown }).auth_profile_id)).toBe(String(profileId));

    // Now create a connection referencing the pending_auth account profile in the
    // same "apply" — it must succeed and land in pending_auth.
    const connRes = await manageConnections(
      {
        action: 'create',
        connector_key: 'demo.oauth',
        slug: 'demo-conn',
        display_name: 'Demo Connection',
        auth_profile_slug: 'demo-account',
        app_auth_profile_slug: 'demo-app',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in connRes).toBe(false);
    let connectionId = 0;
    if ('connection' in connRes) {
      expect((connRes.connection as { status: string }).status).toBe('pending_auth');
      expect((connRes.connection as { slug: string }).slug).toBe('demo-conn');
      connectionId = (connRes.connection as { id: number }).id;
    }

    // A feed created for a pending_auth connection must land 'paused' with no
    // next_run_at (the feeds.status CHECK only allows active|paused|error; the
    // OAuth callback un-pauses it when it activates the connection).
    const feedRes = await manageFeeds(
      {
        action: 'create_feed',
        connection_id: connectionId,
        feed_key: 'items',
        display_name: 'Demo Feed',
        schedule: '0 */6 * * *',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in feedRes).toBe(false);
    if ('feed' in feedRes) {
      expect((feedRes.feed as { status: string }).status).toBe('paused');
      expect((feedRes.feed as { next_run_at: unknown }).next_run_at ?? null).toBeNull();
    }
    const feedRows = await sql`
      SELECT status, next_run_at FROM feeds
      WHERE organization_id = ${org.id} AND connection_id = ${connectionId}
    `;
    expect(feedRows).toHaveLength(1);
    expect((feedRows[0] as { status: string }).status).toBe('paused');
    expect((feedRows[0] as { next_run_at: unknown }).next_run_at).toBeNull();

    // The SDK's positional lookup and reauthentication methods must work as
    // advertised. OAuth reauthentication issues a fresh profile-scoped token;
    // the callback then activates every connection bound to this profile.
    const sdk = buildClientSDK(ctx, TEST_ENV);
    const profileResult = (await sdk.authProfiles.get('demo-account')) as {
      auth_profile: { id: number; slug: string; profile_kind: string };
    };
    expect(profileResult.auth_profile).toMatchObject({
      id: profileId,
      slug: 'demo-account',
      profile_kind: 'oauth_account',
    });

    const reconnectResult = (await sdk.connections.reauthenticate(connectionId)) as {
      action: string;
      connection_id: number;
      auth_profile_slug: string;
      connect_url: string;
      expires_at: string;
    };
    expect(reconnectResult).toMatchObject({
      action: 'reauthenticate',
      connection_id: connectionId,
      auth_profile_slug: 'demo-account',
    });
    expect(reconnectResult.connect_url).toMatch(
      /^https:\/\/gateway\.test\/lobu\/connect\/[A-Za-z0-9_-]+\/oauth\/start$/
    );
    expect(Number.isNaN(Date.parse(reconnectResult.expires_at))).toBe(false);

    const reconnectTokens = await sql`
      SELECT connection_id, auth_profile_id
      FROM connect_tokens
      WHERE organization_id = ${org.id}
        AND connector_key = 'demo.oauth'
        AND status = 'pending'
      ORDER BY created_at DESC
    `;
    expect(reconnectTokens).toHaveLength(2);
    expect(reconnectTokens[0]).toMatchObject({
      connection_id: connectionId,
      auth_profile_id: profileId,
    });

    // Re-creating the account profile is idempotent — reuses the row, returns a fresh token.
    const accRes2 = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account',
        slug: 'demo-account',
      },
      TEST_ENV,
      ctx
    );
    expect('connect_url' in accRes2 && accRes2.connect_url).toBeTruthy();
    const rows2 = await sql`SELECT count(*)::int AS n FROM auth_profiles WHERE organization_id = ${org.id} AND slug = 'demo-account'`;
    expect((rows2[0] as { n: number }).n).toBe(1);
  });
});
