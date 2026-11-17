/**
 * Stage 3 — connecting a managed connector in a PUBLIC org yields a
 * consent-only connection (grant only, no feeds).
 *
 * A managed connector lives in a `visibility='public'` org with a managed
 * org-level `oauth_app` profile (the client secret stays in the cloud). When a
 * member runs the connect flow against it, the resulting connection must be
 * CONSENT-ONLY: it holds the OAuth grant for delegation but has NO feeds, so
 * the cloud never syncs a copy — the data lives only on the member's local
 * instance.
 *
 * Proven here by driving `manageConnections({ action: 'connect' })`:
 *   1. PUBLIC org + managed oauth_app → the new connection carries
 *      `config.consent_only = true` and has zero feeds.
 *   2. PRIVATE org with the same setup → an ordinary connection (no
 *      consent_only), so the managed-only rule is scoped to public orgs.
 *   2b. PUBLIC org with its own app that is NOT named in
 *      `LOBU_MANAGED_AUTH_ORGS` → an ordinary connection that can have feeds:
 *      only a named provider workspace lends its app.
 *   3. The feed guard holds end-to-end: creating a feed on the resulting
 *      consent-only connection is rejected.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

/**
 * Seed an org (public by default) with an OAuth connector + an active managed
 * `oauth_app` profile (the client secret the cloud holds). Returns the owner's
 * tool context + the connector key.
 */
async function seedManagedConnector(opts: {
  visibility: 'public' | 'private';
  /** Managed oauth_app state: 'active' (default) | 'revoked' | 'absent'. */
  appState?: 'active' | 'revoked' | 'absent';
  envCredentialKeys?: { clientId: string; clientSecret: string };
  /** Name the org in LOBU_MANAGED_AUTH_ORGS (default true). */
  provider?: boolean;
}) {
  const appState = opts.appState ?? 'active';
  const { org, user, ctx } = await seedOwnerContext({
    orgName: `Managed ${opts.visibility} ${appState} Org`,
    userName: 'Connecting Member',
    visibility: opts.visibility,
  });
  if (opts.provider ?? true) process.env.LOBU_MANAGED_AUTH_ORGS = org.slug;

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
          tokenUrl: 'https://demo.example/token',
          clientIdKey: opts.envCredentialKeys?.clientId ?? 'DEMO_CLIENT_ID',
          clientSecretKey: opts.envCredentialKeys?.clientSecret ?? 'DEMO_CLIENT_SECRET',
        },
      ],
    },
    feeds_schema: { items: {} },
  });

  // The managed oauth_app — the signal that this connector is "managed". A
  // non-active (revoked) or absent app means the connector is NOT managed in
  // this org, so the consent_only marking must not apply.
  if (appState !== 'absent') {
    await createAuthProfile({
      organizationId: org.id,
      connectorKey,
      displayName: 'Managed Demo App',
      profileKind: 'oauth_app',
      provider: 'demo',
      authData: { DEMO_CLIENT_ID: 'managed-cid', DEMO_CLIENT_SECRET: 'managed-secret' },
      status: appState === 'revoked' ? 'revoked' : 'active',
    });
  }

  return { org, user, ctx, connectorKey };
}

describe('Stage 3 — managed-connect creates a consent-only connection', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(() => {
    delete process.env.LOBU_MANAGED_AUTH_ORGS;
  });

  it('a managed connector in a PUBLIC org yields a consent_only connection with no feeds', async () => {
    const { ctx, connectorKey } = await seedManagedConnector({ visibility: 'public' });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as { connection_id?: number; status?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeDefined();
    // The OAuth grant is pending until the user completes consent.
    expect(result.status).toBe('pending_auth');

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections WHERE id = ${result.connection_id} LIMIT 1
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    expect(connRows[0]?.config?.consent_only).toBe(true);

    // No feeds were created — the cloud never syncs this connection.
    const feedRows = (await sql`
      SELECT 1 FROM feeds WHERE connection_id = ${result.connection_id}
    `) as unknown as Array<unknown>;
    expect(feedRows.length).toBe(0);

    // And the by-construction guard holds: a feed cannot be added later.
    const feedResult = (await manageFeeds(
      { action: 'create_feed', connection_id: result.connection_id, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(feedResult.error).toMatch(/consent-only/i);
  });

  it('the first env-backed connect is consent_only when it provisions the managed app', async () => {
    const clientIdKey = 'MANAGED_FIRST_CONNECT_CLIENT_ID';
    const clientSecretKey = 'MANAGED_FIRST_CONNECT_CLIENT_SECRET';
    const { ctx, connectorKey } = await seedManagedConnector({
      visibility: 'public',
      appState: 'absent',
      envCredentialKeys: { clientId: clientIdKey, clientSecret: clientSecretKey },
    });
    process.env[clientIdKey] = 'managed-first-connect-client';
    process.env[clientSecretKey] = 'managed-first-connect-secret';

    try {
      const result = (await manageConnections(
        { action: 'connect', connector_key: connectorKey },
        TEST_ENV,
        ctx
      )) as { connection_id?: number; status?: string; error?: string };

      expect(result.error).toBeUndefined();
      expect(result.status).toBe('pending_auth');
      expect(result.connection_id).toBeDefined();
      const connectionId = Number(result.connection_id);

      const sql = getTestDb();
      const connRows = (await sql`
        SELECT config FROM connections WHERE id = ${connectionId} LIMIT 1
      `) as unknown as Array<{ config: Record<string, unknown> | null }>;
      expect(connRows[0]?.config?.consent_only).toBe(true);

      const feedResult = (await manageFeeds(
        { action: 'create_feed', connection_id: connectionId, feed_key: 'items' },
        TEST_ENV,
        ctx
      )) as { error?: string };
      expect(feedResult.error).toMatch(/consent-only/i);
    } finally {
      delete process.env[clientIdKey];
      delete process.env[clientSecretKey];
    }
  });

  it('a managed connector in a PRIVATE org is an ordinary connection (no consent_only)', async () => {
    const { ctx, connectorKey } = await seedManagedConnector({ visibility: 'private' });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as { connection_id?: number; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeDefined();

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections WHERE id = ${result.connection_id} LIMIT 1
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    // Not a public org → not managed → no consent_only marking.
    expect(connRows[0]?.config?.consent_only).toBeUndefined();
  });

  it.each([
    ['its own active OAuth app', 'active'],
    ['an app provisioned from server env on first connect', 'absent'],
  ] as const)(
    'a PUBLIC org not named in LOBU_MANAGED_AUTH_ORGS with %s is an ordinary connection that can have feeds',
    async (_label, appState) => {
      const envCredentialKeys = {
        clientId: 'ORDINARY_PUBLIC_CLIENT_ID',
        clientSecret: 'ORDINARY_PUBLIC_CLIENT_SECRET',
      };
      const { ctx, connectorKey } = await seedManagedConnector({
        visibility: 'public',
        appState,
        envCredentialKeys,
        provider: false,
      });
      process.env.LOBU_MANAGED_AUTH_ORGS = 'some-other-provider';
      process.env[envCredentialKeys.clientId] = 'ordinary-client';
      process.env[envCredentialKeys.clientSecret] = 'ordinary-secret';

      try {
        const result = (await manageConnections(
          { action: 'connect', connector_key: connectorKey },
          TEST_ENV,
          ctx
        )) as { connection_id?: number; error?: string };
        expect(result.error).toBeUndefined();
        expect(result.connection_id).toBeDefined();

        const sql = getTestDb();
        const connRows = (await sql`
          SELECT config FROM connections WHERE id = ${result.connection_id} LIMIT 1
        `) as unknown as Array<{ config: Record<string, unknown> | null }>;
        expect(connRows[0]?.config?.consent_only).toBeUndefined();

        const feedResult = (await manageFeeds(
          { action: 'create_feed', connection_id: result.connection_id, feed_key: 'items' },
          TEST_ENV,
          ctx
        )) as { error?: string };
        expect(feedResult.error).toBeUndefined();
      } finally {
        delete process.env[envCredentialKeys.clientId];
        delete process.env[envCredentialKeys.clientSecret];
      }
    }
  );

  it('a PUBLIC org whose managed oauth_app is REVOKED is NOT treated as managed (no consent_only connection)', async () => {
    // T3: the public-org signal alone is not enough — there must be an ACTIVE
    // managed oauth_app. A revoked app means the connector isn't actually
    // managed here, so the connect flow must NOT skip the app requirement and
    // mint a consent_only connection. (Without an active app the connect can't
    // build its consent URL, so it errors — and crucially no consent_only
    // connection is created.)
    const { org, ctx, connectorKey } = await seedManagedConnector({
      visibility: 'public',
      appState: 'revoked',
    });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as {
      connection_id?: number;
      error?: string;
      status?: string;
      setup_family?: string;
      next_action?: string;
      resume_call?: { sdk_method?: string };
    };

    // Not treated as managed → the normal OAuth-app setup requirement applies.
    expect(result).toMatchObject({
      status: 'setup_required',
      setup_family: 'oauth',
      next_action: 'configure_oauth_app',
      resume_call: { sdk_method: 'connections.connect' },
    });
    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeUndefined();

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${org.id} AND connector_key = ${connectorKey}
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    // No consent_only connection exists for this connector.
    expect(connRows.some((r) => r.config?.consent_only === true)).toBe(false);
  });

  it('a PUBLIC org with NO managed oauth_app is NOT treated as managed (no consent_only connection)', async () => {
    // T3 (absent variant): public org, OAuth connector, but no managed app at
    // all → not managed → the connect flow errors on the missing app rather
    // than minting a consent_only connection.
    const { org, ctx, connectorKey } = await seedManagedConnector({
      visibility: 'public',
      appState: 'absent',
    });

    const result = (await manageConnections(
      { action: 'connect', connector_key: connectorKey },
      TEST_ENV,
      ctx
    )) as {
      connection_id?: number;
      error?: string;
      status?: string;
      setup_family?: string;
      next_action?: string;
      resume_call?: { sdk_method?: string };
    };

    expect(result).toMatchObject({
      status: 'setup_required',
      setup_family: 'oauth',
      next_action: 'configure_oauth_app',
      resume_call: { sdk_method: 'connections.connect' },
    });
    expect(result.error).toBeUndefined();
    expect(result.connection_id).toBeUndefined();

    const sql = getTestDb();
    const connRows = (await sql`
      SELECT config FROM connections
      WHERE organization_id = ${org.id} AND connector_key = ${connectorKey}
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    expect(connRows.some((r) => r.config?.consent_only === true)).toBe(false);
  });

  it('the `create` path also marks consent_only for a managed connector in a PUBLIC org, and feeds are rejected', async () => {
    // T5 / FIX 5: handleConnect already marks consent_only, but a member could
    // `create` (action:'create') an OAuth connection with their own
    // oauth_account in the same managed public org. Without the fix that
    // connection would NOT be consent_only, so feeds could be attached and the
    // cloud would sync the member's data — breaking "data stays local". The
    // create path must mark it consent_only just like connect.
    const { org, user, ctx, connectorKey } = await seedManagedConnector({
      visibility: 'public',
    });

    // The member's OWN oauth_account grant (the thing `create` would bind).
    const sql = getTestDb();
    const accountId = `member-acct-${org.id}`;
    await sql`
      INSERT INTO "account" (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, 'demo', ${user.id},
        'member-grant', 'member-refresh', ${new Date(Date.now() + 3600_000).toISOString()},
        'read', NOW(), NOW()
      )
    `;
    await createAuthProfile({
      organizationId: org.id,
      connectorKey,
      displayName: 'Member Account',
      profileKind: 'oauth_account',
      provider: 'demo',
      status: 'active',
      accountId,
      createdBy: user.id,
    });

    const created = (await manageConnections(
      {
        action: 'create',
        connector_key: connectorKey,
        slug: 'member-managed-create',
      },
      TEST_ENV,
      ctx
    )) as { connection?: { id?: number }; error?: string };

    expect(created.error).toBeUndefined();
    expect(created.connection?.id).toBeDefined();
    const connectionId = Number(created.connection?.id);

    const connRows = (await sql`
      SELECT config FROM connections WHERE id = ${connectionId} LIMIT 1
    `) as unknown as Array<{ config: Record<string, unknown> | null }>;
    // The create path marked it consent_only (managed public org + OAuth).
    expect(connRows[0]?.config?.consent_only).toBe(true);

    // And the feed guard holds: no feed can be added to it.
    const feedResult = (await manageFeeds(
      { action: 'create_feed', connection_id: connectionId, feed_key: 'items' },
      TEST_ENV,
      ctx
    )) as { error?: string };
    expect(feedResult.error).toMatch(/consent-only/i);
  });
});
