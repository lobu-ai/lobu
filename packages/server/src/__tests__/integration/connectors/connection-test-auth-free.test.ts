/**
 * Regression: connections.test must NOT warn "No auth profile configured" for a
 * connector whose auth schema is `{ methods: [{ type: 'none' }] }` (#2051).
 *
 * An auth-free connector (RSS/Atom is the production case) legitimately has no
 * auth profile. Before the fix, handleTest fell through to a hardcoded
 * `status: 'warning', message: 'No auth profile configured'` — a misleading
 * warning on a perfectly valid active connection. The fix consults the
 * connector's stored `auth_schema`: when the `none` method is offered, an absent
 * profile is expected, so the test reports `status: 'ok'`.
 *
 * A connector that genuinely REQUIRES auth (env_keys) with no profile must still
 * warn — the fix must not blanket-suppress the warning.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { pgTextArray } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { buildConnectionsNamespace } from '../../../sandbox/namespaces/connections';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { OAUTH_SCOPE_PAUSE_LAST_ERROR } from '../../../utils/oauth-connection-state';
import { CONNECT_TOKEN_EXPIRED_ERROR } from '../../../utils/connect-tokens';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

const CONNECTORS = {
  none: 'demo.authfree.none',
  env: 'demo.authfree.env',
  mixed: 'demo.authfree.mixed',
} as const;

async function purge(organizationId: string): Promise<void> {
  const sql = getTestDb();
  const keys = Object.values(CONNECTORS);
  await sql`DELETE FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
  await sql`DELETE FROM connector_definitions WHERE key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
}

async function seedConnection(
  organizationId: string,
  createdBy: string,
  connectorKey: string,
  slug: string
): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status, config, created_by
    ) VALUES (
      ${organizationId}, ${connectorKey}, ${slug}, ${slug},
      'active', ${sql.json({})}, ${createdBy}
    )
    RETURNING id
  `;
  return Number(row.id);
}

describe('connections.test — auth-free connectors', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();
  });

  afterEach(async () => {
    const sql = getTestDb();
    const orgs = await sql`SELECT id FROM "organization"`;
    for (const org of orgs) await purge(org.id as string);
  });

  it('reports ok (not a warning) for a connector that supports the "none" auth method', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Auth-Free OK Org' });
    await createTestConnectorDefinition({
      key: CONNECTORS.none,
      name: 'Auth-free connector',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.none, 'rss-like');

    const res = (await manageConnections(
      { action: 'test', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as Record<string, unknown>;

    expect(res.action).toBe('test');
    expect(res.status).toBe('ok');
    expect(String(res.message)).not.toMatch(/No auth profile configured/i);
  });

  it('still warns for a connector that REQUIRES auth but has no profile', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Auth-Required Warn Org' });
    await createTestConnectorDefinition({
      key: CONNECTORS.env,
      name: 'Env-keys connector',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'env_keys', fields: [{ key: 'API_KEY' }] }] },
    });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.env, 'needs-key');

    const res = (await manageConnections(
      { action: 'test', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as Record<string, unknown>;

    expect(res.action).toBe('test');
    expect(res.status).toBe('warning');
    expect(String(res.message)).toMatch(/No auth profile configured/i);
    // Structured taxonomy (lobu#2051 Item 2): a missing-auth warning is a stable,
    // non-retryable AUTH_MISSING — the agent shouldn't retry the identical test.
    expect(res.error_code).toBe('AUTH_MISSING');
    expect(res.retryable).toBe(false);
  });

  it('the auth-free ok result carries no error taxonomy', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Auth-Free No-Code Org' });
    await createTestConnectorDefinition({
      key: CONNECTORS.none,
      name: 'Auth-free connector',
      organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.none, 'rss-ok');

    const res = (await manageConnections(
      { action: 'test', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as Record<string, unknown>;

    expect(res.status).toBe('ok');
    expect(res.error_code).toBeUndefined();
    expect(res.retryable).toBeUndefined();
  });

  it.each([false, true])('creates with explicit no-auth when a primary OAuth profile exists: %s', async (withProfile) => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic Auth Choice' });
    await createTestConnectorDefinition({
      key: CONNECTORS.mixed,
      name: 'Synthetic optional OAuth',
      organization_id: org.id,
      auth_schema: { methods: [
        { type: 'oauth', provider: 'synthetic', requiredScopes: [],
          clientIdKey: 'client_id', clientSecretKey: 'client_secret',
          authorizationUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token' },
        { type: 'none' },
      ] },
    });
    if (withProfile) await createAuthProfile({
      organizationId: org.id, connectorKey: CONNECTORS.mixed,
      displayName: 'Synthetic OAuth account', profileKind: 'oauth_account',
      provider: 'synthetic', authData: {}, status: 'active', createdBy: user.id,
    });
    const client = buildConnectionsNamespace(ctx, TEST_ENV);
    // The raw SDK entry point exercises schema validation as well as the handler.
    const res = await client.manage({ action: 'create', connector_key: CONNECTORS.mixed,
      auth_profile_slug: null, app_auth_profile_slug: null }) as { connection: { id: number } };
    expect(res).toHaveProperty('connection.id');
    const [row] = await getTestDb()`SELECT status, auth_profile_id, app_auth_profile_id, config
      FROM connections WHERE id = ${res.connection.id}`;
    expect(row).toMatchObject({ status: 'active', auth_profile_id: null, app_auth_profile_id: null });
    expect(row.config?.consent_only).not.toBe(true);
  });

  it('clears a retained credential when update explicitly selects no-auth', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic Auth Clear' });
    await createTestConnectorDefinition({
      key: CONNECTORS.mixed, name: 'Synthetic optional credential', organization_id: org.id,
      auth_schema: { methods: [{ type: 'env_keys', fields: [{ key: 'API_KEY' }] }, { type: 'none' }] },
    });
    const profile = await createAuthProfile({ organizationId: org.id, connectorKey: CONNECTORS.mixed,
      displayName: 'Synthetic key', profileKind: 'env', authData: { API_KEY: 'synthetic-key' },
      status: 'active', createdBy: user.id });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.mixed, 'clear-auth');
    await getTestDb()`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connectionId}`;
    await buildConnectionsNamespace(ctx, TEST_ENV).update({ connection_id: connectionId,
      auth_profile_slug: null, app_auth_profile_slug: null });
    const [row] = await getTestDb()`SELECT auth_profile_id, app_auth_profile_id FROM connections WHERE id = ${connectionId}`;
    expect(row).toEqual({ auth_profile_id: null, app_auth_profile_id: null });
  });

  it.each(['oauth_account', 'browser_session'] as const)('detaches %s without resuming manually paused state', async (kind) => {
    const sql = getTestDb();
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic Auth Detachment' });
    await createTestConnectorDefinition({ key: CONNECTORS.mixed, name: 'Synthetic optional OAuth',
      organization_id: org.id, auth_schema: { methods: [{ type: 'oauth', provider: 'synthetic' }, { type: 'none' }] },
      feeds_schema: { 'synthetic-items': { operations: ['sync'] }, 'auth-paused': { operations: ['sync'] } } });
    const accountId = `synthetic-detach-${org.id}`;
    await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
      VALUES (${accountId}, ${accountId}, 'synthetic', ${user.id}, NOW(), NOW())`;
    const profile = await createAuthProfile({ organizationId: org.id, connectorKey: CONNECTORS.mixed,
      displayName: 'Synthetic old auth', profileKind: kind, provider: 'synthetic',
      accountId: kind === 'oauth_account' ? accountId : null,
      authData: kind === 'browser_session' ? { cdp_url: 'http://127.0.0.1:9222' } : {}, status: 'active', createdBy: user.id });
    const app = await createAuthProfile({ organizationId: org.id, connectorKey: CONNECTORS.mixed,
      displayName: 'Synthetic app', profileKind: 'oauth_app', provider: 'synthetic', authData: {}, status: 'active', createdBy: user.id });
    const states = [
      { status: 'pending_auth', error: 'Synthetic awaiting auth', recover: true },
      { status: 'paused', error: null, recover: false },
      { status: 'revoked', error: CONNECT_TOKEN_EXPIRED_ERROR, recover: true },
      { status: 'revoked', error: 'Synthetic manual revoke', recover: false },
    ];
    for (const [index, { status, error, recover }] of states.entries()) {
      const connectionId = await seedConnection(org.id, user.id, CONNECTORS.mixed, `detach-${index}`);
      await sql`UPDATE connections SET visibility = 'private', status = ${status}, account_id = ${accountId},
        error_message = ${error}, auth_profile_id = ${profile.id}, app_auth_profile_id = ${app.id} WHERE id = ${connectionId}`;
      await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status)
        VALUES (${org.id}, ${connectionId}, 'synthetic-items', 'Manually paused', 'paused')`;
      await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, last_error, schedule)
        VALUES (${org.id}, ${connectionId}, 'auth-paused', 'Auth pause', 'paused', ${OAUTH_SCOPE_PAUSE_LAST_ERROR}, '0 * * * *')`;
      const client = buildConnectionsNamespace(ctx, TEST_ENV);
      await client.update({ connection_id: connectionId, auth_profile_slug: null, app_auth_profile_slug: null });
      await client.update({ connection_id: connectionId, display_name: 'Synthetic metadata edit' });
      const [row] = await sql`SELECT status, error_message, auth_profile_id, app_auth_profile_id, account_id FROM connections WHERE id = ${connectionId}`;
      expect(row).toEqual({ status: recover ? 'active' : status, error_message: recover ? null : error,
        auth_profile_id: null, app_auth_profile_id: null, account_id: null });
      const feeds = await sql`SELECT feed_key, status, last_error, next_run_at FROM feeds WHERE connection_id = ${connectionId}`;
      expect(feeds.find(feed => feed.feed_key === 'synthetic-items')?.status).toBe('paused');
      const authPaused = feeds.find(feed => feed.feed_key === 'auth-paused');
      expect(authPaused?.status).toBe(recover ? 'active' : 'paused');
      if (recover) {
        expect(authPaused?.last_error).toBeNull();
        expect(authPaused?.next_run_at).not.toBeNull();
      }
    }
  });

  it('does not bypass required auth or change omitted selection', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic Required Auth' });
    await createTestConnectorDefinition({ key: CONNECTORS.env, name: 'Synthetic required key', organization_id: org.id,
      auth_schema: { methods: [{ type: 'env_keys', fields: [{ key: 'API_KEY' }] }] } });
    const client = buildConnectionsNamespace(ctx, TEST_ENV);
    for (const selection of [{}, { auth_profile_slug: null, app_auth_profile_slug: null }]) {
      expect(await client.create({ connector_key: CONNECTORS.env, ...selection })).toMatchObject({ status: 'setup_required' });
    }
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.env, 'required-auth');
    await expect(client.update({ connection_id: connectionId, auth_profile_slug: null, app_auth_profile_slug: null })).rejects.toThrow('requires an auth profile');
  });

  it.each([{ managedBy: { org: 'synthetic-cloud' } }, { installation_ref: 'synthetic-install' }, { consent_only: true }])('rejects no-auth with retained delegation %j', async (config) => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic Delegation Guard' });
    await createTestConnectorDefinition({ key: CONNECTORS.mixed, name: 'Synthetic mixed auth', organization_id: org.id,
      auth_schema: { methods: [{ type: 'oauth', provider: 'synthetic' }, { type: 'none' }] } });
    const client = buildConnectionsNamespace(ctx, TEST_ENV);
    await expect(client.create({ connector_key: CONNECTORS.mixed, config,
      auth_profile_slug: null, app_auth_profile_slug: null })).rejects.toThrow(/delegated|app-installation/);
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.mixed, 'retained-delegation');
    await getTestDb()`UPDATE connections SET config = ${getTestDb().json(config)} WHERE id = ${connectionId}`;
    await expect(client.update({ connection_id: connectionId, auth_profile_slug: null, app_auth_profile_slug: null })).rejects.toThrow(/Delegated|app-installation/);
  });

  it('allows a member to round-trip an empty app binding but keeps actual app clearing admin-only', async () => {
    const { org, user, ctx } = await seedOwnerContext({ orgName: 'Synthetic App Clear Policy' });
    await createTestConnectorDefinition({ key: CONNECTORS.none, name: 'Synthetic no-auth', organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] } });
    const connectionId = await seedConnection(org.id, user.id, CONNECTORS.none, 'member-no-auth');
    await getTestDb()`UPDATE member SET role = 'member' WHERE "organizationId" = ${org.id} AND "userId" = ${user.id}`;
    const client = buildConnectionsNamespace({ ...ctx, memberRole: 'member' }, TEST_ENV);
    await client.update({ connection_id: connectionId, auth_profile_slug: null, app_auth_profile_slug: null });
    const app = await createAuthProfile({ organizationId: org.id, connectorKey: CONNECTORS.none,
      displayName: 'Synthetic app', profileKind: 'oauth_app', authData: {}, status: 'active', createdBy: user.id });
    await getTestDb()`UPDATE connections SET app_auth_profile_id = ${app.id} WHERE id = ${connectionId}`;
    await expect(client.update({ connection_id: connectionId, auth_profile_slug: null, app_auth_profile_slug: null })).rejects.toThrow('Only admins can clear');
  });
});
