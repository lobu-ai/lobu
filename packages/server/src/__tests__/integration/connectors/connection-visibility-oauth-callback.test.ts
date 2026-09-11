/**
 * END-TO-END proof of the PRIMARY exposure fix: a user connecting their own
 * Gmail via the fresh OAuth flow must end up `private`.
 *
 * The fresh connect inserts the connection with visibility='org' (no
 * oauth_account profile exists yet). The OAuth callback then CREATES the
 * oauth_account profile, attaches it, and DOWNGRADES the connection to 'private'.
 * This drives the REAL callback route (connectRoutes GET /oauth/callback) against
 * scoped fake public provider responses for /token + /userinfo — no module
 * mocking, so it is safe under this suite's shared module graph
 * (vitest `isolate: false`). It covers the route wiring the SQL-invariant test in
 * connection-visibility-default.test.ts could not.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import type { Env } from '../../../index';
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

const PROVIDER_TOKEN_URL = 'https://oauth-provider.example.com/token';
const PROVIDER_USERINFO_URL = 'https://oauth-provider.example.com/userinfo';
const originalFetch = globalThis.fetch;

describe('OAuth callback downgrades a fresh personal connection to private (e2e)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

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
          scope: calendar
            ? 'https://www.googleapis.com/auth/calendar.readonly'
            : 'https://www.googleapis.com/auth/gmail.readonly',
        });
      }
      if (url === PROVIDER_USERINFO_URL) {
        return Response.json({ email: 'owner@example.com', name: 'Owner D', id: 'acct-123' });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    await cleanupTestDatabase();
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
              requiredScopes: [grant.scope],
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
          requestedScopes: [grant.scope],
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
      access_token: string | null;
    }>;

    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.account_id).not.toBe(accounts[1]?.account_id);
    for (const account of accounts) {
      expect(account.provider_account_id.startsWith('lobu-connector:')).toBe(true);
    }
    expect(accounts.find((row) => row.connector_key === 'cb.calendar')?.scope).toBe(
      'https://www.googleapis.com/auth/calendar.readonly'
    );
    expect(accounts.find((row) => row.connector_key === 'cb.gmail')?.scope).toBe(
      'https://www.googleapis.com/auth/gmail.readonly'
    );
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
