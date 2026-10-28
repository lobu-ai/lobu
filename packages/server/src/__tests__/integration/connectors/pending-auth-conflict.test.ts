/**
 * Regression: the partial unique index `auth_profiles_pending_unique` allows
 * exactly one pending oauth_account profile per (org, connector_key,
 * profile_kind, provider). Repeat "Create OAuth account" clicks from the web
 * UI omit `slug`, so prior to this guard the second insert collided with the
 * index and leaked a raw PG `duplicate key value violates unique constraint`
 * message into a toast. Cover:
 *   1. No-slug repeat call → reuses the existing pending row (idempotent).
 *   2. Explicit different slug while a pending row exists →
 *      PendingAuthConflictError with a friendly message that does NOT
 *      include "duplicate key" or the constraint name.
 *   3. Direct `createAuthProfile` collision → same friendly error class.
 *
 * Also: create_auth_profile auto-installs a bundled connector that is not yet
 * installed, so an auth profile can be created before any connection (#1898).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import type { ToolContext } from '../../../tools/registry';
import {
  PendingAuthConflictError,
  createAuthProfile,
} from '../../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

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
  } as ToolContext;
}

async function setupOAuthConnector(orgId: string) {
  await createTestConnectorDefinition({
    key: 'demo.oauth',
    name: 'Demo OAuth',
    organization_id: orgId,
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
}

describe('auth profiles — pending-auth conflict handling', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('repeat create_auth_profile without slug reuses the pending row', async () => {
    const org = await createTestOrganization({ name: 'Pending Conflict Org' });
    const user = await createTestUser({ name: 'Pending Conflict User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    await setupOAuthConnector(org.id);

    const first = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account',
      },
      TEST_ENV,
      ctx
    );
    expect('auth_profile' in first).toBe(true);
    if (!('auth_profile' in first)) throw new Error('first call missing auth_profile');
    const firstProfile = first.auth_profile;
    expect(firstProfile.status).toBe('pending_auth');

    const second = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account',
      },
      TEST_ENV,
      ctx
    );
    expect('auth_profile' in second).toBe(true);
    if (!('auth_profile' in second)) throw new Error('second call missing auth_profile');
    expect(second.auth_profile.id).toBe(firstProfile.id);
    expect(second.auth_profile.slug).toBe(firstProfile.slug);
    expect('connect_token' in second && second.connect_token).toBeTruthy();

    // Exactly one auth_profile row should exist.
    const sql = getTestDb();
    const rows = await sql`
      SELECT id FROM auth_profiles
      WHERE organization_id = ${org.id}
        AND connector_key = 'demo.oauth'
        AND profile_kind = 'oauth_account'
    `;
    expect(rows).toHaveLength(1);
  });

  it('create_auth_profile with a fresh slug while a pending row exists returns a friendly error', async () => {
    const org = await createTestOrganization({ name: 'Pending Conflict Org 2' });
    const user = await createTestUser({ name: 'Pending Conflict User 2' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    await setupOAuthConnector(org.id);

    await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account',
        slug: 'demo-account-a',
      },
      TEST_ENV,
      ctx
    );

    const collide = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'Demo Account B',
        slug: 'demo-account-b',
      },
      TEST_ENV,
      ctx
    );

    expect('error' in collide).toBe(true);
    if (!('error' in collide)) throw new Error('expected error response');
    expect(collide.error).toMatch(/already pending authorization/i);
    expect(collide.error).not.toMatch(/duplicate key/i);
    expect(collide.error).not.toMatch(/auth_profiles_pending_unique/i);
    expect(collide.error).toContain('demo-account-a');
  });

  it('two users in the same org can run parallel pending oauth_account flows', async () => {
    const org = await createTestOrganization({ name: 'Parallel Flows Org' });
    const userA = await createTestUser({ name: 'User A' });
    const userB = await createTestUser({ name: 'User B' });
    await addUserToOrganization(userA.id, org.id, 'owner');
    await addUserToOrganization(userB.id, org.id, 'admin');
    await setupOAuthConnector(org.id);

    const resA = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'A Account',
      },
      TEST_ENV,
      ctxFor(org.id, userA.id)
    );
    expect('auth_profile' in resA).toBe(true);
    if (!('auth_profile' in resA)) throw new Error('A missing auth_profile');

    const resB = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'B Account',
      },
      TEST_ENV,
      ctxFor(org.id, userB.id)
    );
    expect('auth_profile' in resB).toBe(true);
    if (!('auth_profile' in resB)) throw new Error('B missing auth_profile');

    expect(resB.auth_profile.id).not.toBe(resA.auth_profile.id);
    expect(resA.auth_profile.created_by).toBe(userA.id);
    expect(resB.auth_profile.created_by).toBe(userB.id);

    // Both pending rows must coexist — the new index is per-user.
    const sql = getTestDb();
    const rows = await sql`
      SELECT id, created_by FROM auth_profiles
      WHERE organization_id = ${org.id}
        AND connector_key = 'demo.oauth'
        AND profile_kind = 'oauth_account'
        AND status = 'pending_auth'
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);

    // User B repeating without a slug still reuses *their own* pending row,
    // not A's — per-user dedup.
    const resBAgain = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demo.oauth',
        profile_kind: 'oauth_account',
        display_name: 'B Account again',
      },
      TEST_ENV,
      ctxFor(org.id, userB.id)
    );
    if (!('auth_profile' in resBAgain)) throw new Error('B repeat missing auth_profile');
    expect(resBAgain.auth_profile.id).toBe(resB.auth_profile.id);
  });

  it('createAuthProfile throws PendingAuthConflictError carrying the existing row', async () => {
    const org = await createTestOrganization({ name: 'Pending Conflict Org 3' });
    const user = await createTestUser({ name: 'Pending Conflict User 3' });
    await addUserToOrganization(user.id, org.id, 'owner');
    await setupOAuthConnector(org.id);

    const first = await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'demo.oauth',
      displayName: 'Demo Account',
      slug: 'demo-account-first',
      profileKind: 'oauth_account',
      provider: 'demo',
      status: 'pending_auth',
      createdBy: user.id,
    });

    await expect(
      createAuthProfile({
        organizationId: org.id,
        connectorKey: 'demo.oauth',
        displayName: 'Demo Account Again',
        slug: 'demo-account-second',
        profileKind: 'oauth_account',
        provider: 'demo',
        status: 'pending_auth',
        createdBy: user.id,
      })
    ).rejects.toBeInstanceOf(PendingAuthConflictError);

    try {
      await createAuthProfile({
        organizationId: org.id,
        connectorKey: 'demo.oauth',
        displayName: 'Demo Account Again',
        slug: 'demo-account-third',
        profileKind: 'oauth_account',
        provider: 'demo',
        status: 'pending_auth',
        createdBy: user.id,
      });
      throw new Error('expected PendingAuthConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(PendingAuthConflictError);
      const conflict = err as PendingAuthConflictError;
      expect(conflict.existing.id).toBe(first.id);
      expect(conflict.existing.slug).toBe('demo-account-first');
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.message).not.toMatch(/duplicate key/i);
    }
  });

  it('create_auth_profile auto-installs a bundled connector on demand (#1898) so an auth profile can be created before any connection', async () => {
    // Fresh org, `postgres` connector NOT installed. Before the fix this hit the
    // seed chicken/egg: create_auth_profile errored "Connector 'postgres' not
    // found or not active" because only manage_connections create auto-installed
    // the connector — and creating a connection needs the auth profile.
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Auto-install Org',
      userName: 'Auto-install Owner',
    });
    const sql = getTestDb();

    const before = await sql`
      SELECT 1 FROM connector_definitions
      WHERE key = 'postgres' AND organization_id = ${org.id} AND status = 'active'
      LIMIT 1
    `;
    expect(before).toHaveLength(0);

    const res = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'postgres',
        profile_kind: 'env',
        display_name: 'Postgres Credentials',
        slug: 'postgres-db',
        credentials: { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' },
      },
      TEST_ENV,
      ctx
    );

    // The profile is created (no connector-not-found error)…
    expect('error' in res ? res.error : undefined).toBeUndefined();
    expect('auth_profile' in res).toBe(true);
    if ('auth_profile' in res) {
      expect(res.auth_profile.connector_key).toBe('postgres');
    }

    // …because the connector was auto-installed from the bundled catalog.
    const after = await sql`
      SELECT 1 FROM connector_definitions
      WHERE key = 'postgres' AND organization_id = ${org.id} AND status = 'active'
      LIMIT 1
    `;
    expect(after).toHaveLength(1);
  });
});
