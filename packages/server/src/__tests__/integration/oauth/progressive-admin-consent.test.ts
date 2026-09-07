/**
 * Progressive `mcp:admin` consent — re-authorizing REPLACES a narrower grant.
 *
 * When `run_sdk` hits a nested admin-only SDK method, the MCP result carries an
 * `insufficient_scope` challenge naming the COMPLETE replacement grant
 * (`mcp:read mcp:write mcp:admin`), not just the missing `mcp:admin` delta —
 * hosts that replace rather than merge grants would otherwise drop read/write
 * on the upgrade. That contract only holds if the authorization-code path
 * actually issues the wider grant on a second consent for a client that already
 * holds a narrower one.
 *
 * This drives the real `oauthRoutes`: register → consent → token at
 * `mcp:read mcp:write`, then consent → token again at
 * `mcp:read mcp:write mcp:admin`, asserting the token response reports the
 * elevated scope.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createAuthorizationIntent } from '../../../auth/oauth/authorization-intent';
import { mcpAuth } from '../../../auth/middleware';
import { OAuthProvider } from '../../../auth/oauth/provider';
import { oauthRoutes } from '../../../auth/oauth/routes';
import { hashToken } from '../../../auth/oauth/utils';
import { parsePgTextArray } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

// The consent handler enforces `isAllowedConsentOrigin`: the request must carry
// an Origin matching the app's own base URL. The test app is served at
// http://localhost, so send that as Origin.
const ORIGIN = 'http://localhost';

function signAuthorizationRequest(params: {
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  state?: string;
  resource?: string;
}): string {
  return createAuthorizationIntent(
    { ...params, response_type: 'code' },
    TEST_ENV.JWT_SECRET as string
  );
}

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', oauthRoutes);
  return app;
}

function call(
  app: Hono<{ Bindings: Env }>,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string>; env?: Partial<Env> }
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...opts?.headers,
  };
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    { ...TEST_ENV, ...opts?.env }
  );
}

async function authorizeCodeGrant(params: {
  app: Hono<{ Bindings: Env }>;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  sessionCookie: string;
  organizationIds?: string[];
  workspaceAccess?: 'all_current' | 'selected';
  multiWorkspaceGrantsEnabled?: boolean;
}): Promise<{ access_token: string; refresh_token?: string; scope?: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await call(params.app, 'POST', '/oauth/authorize/consent', {
    body: {
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      scope: params.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: params.resource,
      authorization_intent: signAuthorizationRequest({
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        scope: params.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: params.resource,
      }),
      ...(params.organizationIds ? { organization_ids: params.organizationIds } : {}),
      ...(params.workspaceAccess ? { workspace_access: params.workspaceAccess } : {}),
      approved: true,
    },
    headers: { Cookie: params.sessionCookie },
    env: params.multiWorkspaceGrantsEnabled
      ? { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' }
      : undefined,
  });
  expect(authorize.status).toBe(200);
  const { redirect_url } = (await authorize.json()) as { redirect_url: string };
  const code = new URL(redirect_url).searchParams.get('code');
  expect(code).toBeTruthy();

  const token = await call(params.app, 'POST', '/oauth/token', {
    body: {
      grant_type: 'authorization_code',
      code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_verifier: verifier,
      resource: params.resource,
    },
    env: params.multiWorkspaceGrantsEnabled
      ? { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' }
      : undefined,
  });
  expect(token.status, await token.clone().text()).toBe(200);
  return token.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    scope?: string;
  }>;
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

afterAll(async () => {
  // app is in-process; nothing to tear down
});

describe('Progressive mcp:admin consent', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  // The grant path never branches on `client_name`, so one registered client
  // covers every MCP host that walks this flow (ChatGPT, Claude Desktop, …).
  it('replaces a read/write grant with a cumulative admin grant', async () => {
    const app = buildApp();
    const org = await createTestOrganization({ name: 'Progressive Admin Org' });
    const user = await createTestUser({ name: 'Progressive Admin User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/callback`;
    const resource = `${ORIGIN}/mcp/${org.slug}`;

    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Progressive Admin Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const initial = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource,
      scope: 'mcp:read mcp:write',
      sessionCookie: session.cookieHeader,
    });
    expect(initial.scope).toBe('mcp:read mcp:write');

    const elevated = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource,
      scope: 'mcp:read mcp:write mcp:admin',
      sessionCookie: session.cookieHeader,
    });
    expect(elevated.scope).toBe('mcp:read mcp:write mcp:admin');
    expect(await new OAuthProvider(getTestDb(), ORIGIN).verifyAccessToken(elevated.access_token))
      .toMatchObject({ organizationId: org.id, grantedOrganizationIds: [org.id] });
  });

  it.each(['public', 'private'] as const)(
    'preserves scoped %s workspace access for nonmembers',
    async (visibility) => {
      const app = buildApp();
      const org = await createTestOrganization({ name: 'Scoped Nonmember Workspace', visibility });
      const user = await createTestUser({ name: 'Scoped Nonmember' });
      const session = await createTestSession(user.id);
      const redirectUri = `${ORIGIN}/scoped-nonmember`;
      const registration = await call(app, 'POST', '/oauth/register', {
        body: {
          client_name: 'Scoped Nonmember Client', redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
        },
      });
      const client = (await registration.json()) as { client_id: string };
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const request = {
        client_id: client.client_id, redirect_uri: redirectUri, scope: 'mcp:read',
        code_challenge: challenge, code_challenge_method: 'S256' as const,
        resource: `${ORIGIN}/mcp/${org.slug}`,
      };
      const consent = await call(app, 'POST', '/oauth/authorize/consent', {
        body: { ...request, approved: true, authorization_intent: signAuthorizationRequest(request) },
        headers: { Cookie: session.cookieHeader },
      });
      expect(consent.status).toBe(visibility === 'public' ? 200 : 403);
      const codes = await getTestDb()`
        SELECT organization_id, granted_organization_ids FROM oauth_authorization_codes
        WHERE client_id = ${client.client_id}
      `;
      if (visibility === 'public') {
        expect(codes[0]?.organization_id).toBe(org.id);
        expect(parsePgTextArray(codes[0]?.granted_organization_ids as string)).toEqual([org.id]);
      } else {
        expect(codes).toHaveLength(0);
      }
    }
  );

  it('never grants device-flow credential scopes on the authorization-code path', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Public OAuth Scope Org' });
    const user = await createTestUser({ name: 'Public OAuth Scope User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/public-scope-callback`;
    const resource = `${ORIGIN}/mcp/${org.slug}`;
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Public Scope Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };

    const mixed = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource,
      scope: 'mcp:read connections:token device_worker:run',
      sessionCookie: session.cookieHeader,
    });
    expect(mixed.scope).toBe('mcp:read');

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const onlyPrivate = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'connections:token device_worker:run',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        authorization_intent: signAuthorizationRequest({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: 'connections:token device_worker:run',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
    });
    expect(onlyPrivate.status).toBe(400);
    expect(await onlyPrivate.json()).toMatchObject({ error: 'invalid_scope' });

    const empty = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: '',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        authorization_intent: signAuthorizationRequest({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: 'mcp:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }),
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: 'invalid_scope' });

    const elevated = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read mcp:write mcp:admin',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
        authorization_intent: signAuthorizationRequest({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: 'mcp:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource,
        }),
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
    });
    expect(elevated.status).toBe(400);
    expect(await elevated.json()).toMatchObject({ error: 'invalid_scope' });

    // Codes minted before the consent-path fix must be narrowed again at
    // exchange time so a rolling deploy cannot preserve a private scope.
    const legacyVerifier = randomBytes(32).toString('base64url');
    const legacyChallenge = createHash('sha256').update(legacyVerifier).digest('base64url');
    await sql`
      INSERT INTO oauth_authorization_codes (
        code, client_id, user_id, organization_id, granted_organization_ids,
        code_challenge, code_challenge_method, redirect_uri, scope, resource, expires_at
      ) VALUES
        ('legacy-mixed-private-code', ${client.client_id}, ${user.id}, ${org.id},
         ARRAY[${org.id}]::text[], ${legacyChallenge}, 'S256', ${redirectUri},
         'mcp:read connections:token', ${resource}, NOW() + INTERVAL '10 minutes'),
        ('legacy-only-private-code', ${client.client_id}, ${user.id}, ${org.id},
         ARRAY[${org.id}]::text[], ${legacyChallenge}, 'S256', ${redirectUri},
         'connections:token device_worker:run', ${resource}, NOW() + INTERVAL '10 minutes')
    `;

    const exchangedMixed = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: 'legacy-mixed-private-code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: legacyVerifier,
        resource,
      },
    });
    expect(exchangedMixed.status).toBe(200);
    const exchangedMixedBody = (await exchangedMixed.json()) as {
      access_token: string;
      scope: string;
    };
    expect(exchangedMixedBody.scope).toBe('mcp:read');
    const exchangedRows = await sql`
      SELECT authorization_grant_type, scope
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(exchangedMixedBody.access_token)}
    `;
    expect(exchangedRows[0]).toMatchObject({
      authorization_grant_type: 'authorization_code',
      scope: 'mcp:read',
    });

    const exchangedOnlyPrivate = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: 'legacy-only-private-code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: legacyVerifier,
        resource,
      },
    });
    expect(exchangedOnlyPrivate.status).toBe(400);
    expect(await exchangedOnlyPrivate.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('fails closed for legacy privileged OAuth tokens without device-flow provenance', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Legacy Private Scope Org' });
    const user = await createTestUser({ name: 'Legacy Private Scope User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Legacy Private Scope Client',
        redirect_uris: [`${ORIGIN}/legacy-private-callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const accessToken = 'owl_at_legacy-private-scope';
    const refreshToken = 'owl_rt_legacy-private-scope';
    await expect(sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        granted_organization_ids, authorization_grant_type, scope, resource, expires_at
      ) VALUES (
        'unsafe-private-access', 'access', ${hashToken('owl_at_unsafe-private-scope')},
        ${client.client_id}, ${user.id}, ${org.id}, ARRAY[${org.id}]::text[], NULL,
        'mcp:read connections:token', ${`${ORIGIN}/mcp`}, NOW() + INTERVAL '1 hour'
      )
    `).rejects.toThrow(/oauth_tokens_private_scopes_require_device_grant/);

    // Simulate active pre-migration rows so the application-level verifier and
    // refresh defenses remain covered independently of the database constraint.
    await sql`
      ALTER TABLE oauth_tokens
      DROP CONSTRAINT oauth_tokens_private_scopes_require_device_grant
    `;
    try {
      await sql`
        INSERT INTO oauth_tokens (
          id, token_type, token_hash, client_id, user_id, organization_id,
          granted_organization_ids, authorization_grant_type, scope, resource, expires_at
        ) VALUES
          ('legacy-private-access', 'access', ${hashToken(accessToken)}, ${client.client_id},
           ${user.id}, ${org.id}, ARRAY[${org.id}]::text[], NULL,
           'mcp:read connections:token', ${`${ORIGIN}/mcp`}, NOW() + INTERVAL '1 hour'),
          ('legacy-private-refresh', 'refresh', ${hashToken(refreshToken)}, ${client.client_id},
           ${user.id}, ${org.id}, ARRAY[${org.id}]::text[], NULL,
           'mcp:read connections:token', ${`${ORIGIN}/mcp`}, NOW() + INTERVAL '1 day')
      `;

      const provider = new OAuthProvider(sql, ORIGIN);
      expect(await provider.verifyAccessToken(accessToken)).toBeNull();
      const refreshed = await call(app, 'POST', '/oauth/token', {
        body: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: client.client_id,
          resource: `${ORIGIN}/mcp`,
        },
      });
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
      const descendants = await sql`
        SELECT id FROM oauth_tokens WHERE parent_token_id = 'legacy-private-refresh'
      `;
      expect(descendants).toHaveLength(0);
    } finally {
      await sql`
        UPDATE oauth_tokens
        SET revoked_at = NOW()
        WHERE authorization_grant_type IS NULL
          AND regexp_split_to_array(btrim(COALESCE(scope, '')), E'\\s+')
              && ARRAY['device_worker:run', 'connections:token']::text[]
      `;
      await sql`
        ALTER TABLE oauth_tokens
        ADD CONSTRAINT oauth_tokens_private_scopes_require_device_grant
        CHECK (
          revoked_at IS NOT NULL
          OR COALESCE(authorization_grant_type = 'device_code', false)
          OR NOT (
            regexp_split_to_array(btrim(COALESCE(scope, '')), E'\\s+')
              && ARRAY['device_worker:run', 'connections:token']::text[]
          )
        ) NOT VALID
      `;
    }
  });

  it('rejects a whitespace-only refresh scope instead of widening a profile grant', async () => {
    const app = buildApp();
    const user = await createTestUser({ name: 'Refresh Scope User' });
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/refresh-scope-callback`;
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Refresh Scope Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const profileGrant = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource: `${ORIGIN}/mcp`,
      scope: 'profile:read',
      sessionCookie: session.cookieHeader,
    });
    expect(profileGrant.refresh_token).toBeTruthy();

    const refresh = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: profileGrant.refresh_token,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp`,
        scope: '   ',
      },
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('keeps multi-workspace issuance default-off and requires explicit singleton grants', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const primary = await createTestOrganization({ name: 'Rollout Primary Org' });
    const secondary = await createTestOrganization({ name: 'Rollout Secondary Org' });
    const user = await createTestUser({ name: 'Rollout Gate User' });
    await addUserToOrganization(user.id, primary.id, 'owner');
    await addUserToOrganization(user.id, secondary.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/rollout-callback`;
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Rollout Gate Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const consentBody = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: 'mcp:read',
      code_challenge: challenge,
      code_challenge_method: 'S256' as const,
      resource: `${ORIGIN}/mcp`,
      organization_ids: [primary.id, secondary.id],
      workspace_access: 'selected' as const,
      authorization_intent: signAuthorizationRequest({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${ORIGIN}/mcp`,
      }),
      approved: true,
    };

    const disabled = await call(app, 'POST', '/oauth/authorize/consent', {
      body: consentBody,
      headers: { Cookie: session.cookieHeader },
    });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Multiple-workspace authorization is not enabled',
    });

    const obsoletePrimary = await call(app, 'POST', '/oauth/authorize/consent', {
      body: { ...consentBody, organization_id: primary.id },
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(obsoletePrimary.status).toBe(400);
    const missingGrant = await call(app, 'POST', '/oauth/authorize/consent', {
      body: { ...consentBody, organization_ids: undefined, workspace_access: undefined },
      headers: { Cookie: session.cookieHeader },
    });
    expect(missingGrant.status).toBe(400);

    const pendingCodes = await sql`
      SELECT 1 FROM oauth_authorization_codes WHERE client_id = ${client.client_id}
    `;
    expect(pendingCodes).toHaveLength(0);

    // A code approved by an enabled pod must still fail closed if its exchange
    // lands on a disabled pod during rollout.
    const staged = await call(app, 'POST', '/oauth/authorize/consent', {
      body: consentBody,
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(staged.status).toBe(200);
    const stagedCode = new URL(
      ((await staged.json()) as { redirect_url: string }).redirect_url
    ).searchParams.get('code');
    expect(stagedCode).toBeTruthy();
    const disabledExchange = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: stagedCode,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      },
    });
    expect(disabledExchange.status).toBe(400);
    expect(await disabledExchange.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Multiple-workspace authorization is not enabled',
    });
    const disabledExchangeTokens = await sql`
      SELECT 1 FROM oauth_tokens WHERE client_id = ${client.client_id}
    `;
    expect(disabledExchangeTokens).toHaveLength(0);

    // A singleton still needs explicit grants and has no implicit target.
    const singleton = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource: `${ORIGIN}/mcp`,
      scope: 'mcp:read',
      sessionCookie: session.cookieHeader,
      organizationIds: [primary.id],
      workspaceAccess: 'selected',
    });
    const singletonRows = await sql`
      SELECT organization_id, granted_organization_ids
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(singleton.access_token)}
    `;
    expect(singletonRows[0]?.organization_id).toBeNull();
    expect(parsePgTextArray(singletonRows[0]?.granted_organization_ids as string | null)).toEqual([
      primary.id,
    ]);

    const authorizeQuery = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'mcp:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    });
    const disabledUi = await call(app, 'GET', `/oauth/authorize?${authorizeQuery}`);
    const disabledLocation = disabledUi.headers.get('location');
    expect(disabledLocation).toBeTruthy();
    if (!disabledLocation) throw new Error('Expected consent redirect');
    expect(new URL(disabledLocation).searchParams.has('workspace_grants')).toBe(false);
    const enabledUi = await call(app, 'GET', `/oauth/authorize?${authorizeQuery}`, {
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    const enabledLocation = enabledUi.headers.get('location');
    expect(enabledLocation).toBeTruthy();
    if (!enabledLocation) throw new Error('Expected consent redirect');
    const enabledSearch = new URL(enabledLocation).searchParams;
    expect(enabledSearch.get('workspace_grants')).toBe('1');
    expect(enabledSearch.get('authorization_intent')).toBeTruthy();

    const displayedConsentBody = {
      client_id: enabledSearch.get('client_id'),
      redirect_uri: enabledSearch.get('redirect_uri'),
      scope: enabledSearch.get('scope'),
      state: enabledSearch.get('state'),
      code_challenge: enabledSearch.get('code_challenge'),
      code_challenge_method: enabledSearch.get('code_challenge_method'),
      resource: enabledSearch.get('resource'),
      client_name: enabledSearch.get('client_name'),
      authorization_intent: enabledSearch.get('authorization_intent'),
      organization_ids: [primary.id],
      workspace_access: 'selected',
      approved: true,
    };
    const changedDisplay = await call(app, 'POST', '/oauth/authorize/consent', {
      body: { ...displayedConsentBody, resource: `${ORIGIN}/mcp/not-the-displayed-request` },
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(changedDisplay.status).toBe(400);
    expect(await changedDisplay.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'The displayed authorization request was changed',
    });

    const changedIdentity = await call(app, 'POST', '/oauth/authorize/consent', {
      body: { ...displayedConsentBody, client_name: 'Trusted Finance App' },
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(changedIdentity.status).toBe(400);
    expect(await changedIdentity.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'The displayed application identity was changed',
    });

    const submittedFromGet = await call(app, 'POST', '/oauth/authorize/consent', {
      body: displayedConsentBody,
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(submittedFromGet.status).toBe(200);
  });

  it('rejects an empty workspace selection without issuing an authorization code', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const organization = await createTestOrganization({ name: 'Empty Grant Org' });
    const user = await createTestUser({ name: 'Empty Grant User' });
    await addUserToOrganization(user.id, organization.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/empty-grant-callback`;
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Empty Grant Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const response = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${ORIGIN}/mcp`,
        organization_ids: [],
        workspace_access: 'selected',
        authorization_intent: signAuthorizationRequest({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: 'mcp:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: `${ORIGIN}/mcp`,
        }),
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'The workspace selection is empty or too large',
    });

    const authorizationCodes = await sql`
      SELECT 1 FROM oauth_authorization_codes WHERE client_id = ${client.client_id}
    `;
    expect(authorizationCodes).toHaveLength(0);
  });

  it('persists an explicit bare-MCP workspace snapshot through userinfo and refresh', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const primary = await createTestOrganization({ name: 'Primary Grant Org' });
    const admin = await createTestOrganization({ name: 'Admin Grant Org' });
    const unselected = await createTestOrganization({ name: 'Unselected Org' });
    const user = await createTestUser({ name: 'Multi Grant User' });
    await addUserToOrganization(user.id, primary.id, 'member');
    await addUserToOrganization(user.id, admin.id, 'owner');
    await addUserToOrganization(user.id, unselected.id, 'owner');
    await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })}
      WHERE id = ${unselected.id}
    `;
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/multi-callback`;

    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Explicit Workspace Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const grant = await authorizeCodeGrant({
      app,
      clientId: client.client_id,
      redirectUri,
      resource: `${ORIGIN}/mcp`,
      scope: 'mcp:read mcp:write mcp:admin profile:read',
      sessionCookie: session.cookieHeader,
      organizationIds: [primary.id, admin.id],
      workspaceAccess: 'selected',
      multiWorkspaceGrantsEnabled: true,
    });

    expect(grant.scope).toContain('mcp:admin');
    const accessRows = await sql`
      SELECT organization_id, granted_organization_ids
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(grant.access_token)}
      LIMIT 1
    `;
    expect(accessRows[0]?.organization_id).toBeNull();
    expect(parsePgTextArray(accessRows[0]?.granted_organization_ids as string | null)).toEqual([
      primary.id,
      admin.id,
    ]);

    const infoRes = await call(app, 'GET', '/oauth/userinfo', {
      headers: { Authorization: `Bearer ${grant.access_token}` },
    });
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as { organizations: { id: string }[] };
    expect(info.organizations.map((organization) => organization.id)).toEqual([
      primary.id,
      admin.id,
    ]);
    expect(info.organizations.some((organization) => organization.id === unselected.id)).toBe(
      false,
    );

    const mcpApp = new Hono<{ Bindings: Env }>();
    mcpApp.use('/mcp', mcpAuth);
    mcpApp.get('/mcp', (c) => c.json({
      userId: c.get('user')?.id,
      organizationId: c.get('organizationId'),
      memberRole: c.get('memberRole'),
      authSource: c.get('authSource'),
    }));
    const account = await call(mcpApp, 'GET', '/mcp', {
      headers: { Authorization: `Bearer ${grant.access_token}` },
    });
    expect(account.status).toBe(200);
    expect(await account.json()).toEqual({
      userId: user.id, organizationId: null, memberRole: null, authSource: 'oauth',
    });

    expect(grant.refresh_token).toBeTruthy();
    const disabledRefresh = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: grant.refresh_token,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp`,
      },
    });
    expect(disabledRefresh.status).toBe(400);
    expect(await disabledRefresh.json()).toMatchObject({ error: 'invalid_grant' });
    const refreshed = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: grant.refresh_token,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp`,
        scope: 'profile:read',
      },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = (await refreshed.json()) as { access_token: string };
    const refreshedRows = await sql`
      SELECT organization_id, granted_organization_ids
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(refreshedBody.access_token)}
      LIMIT 1
    `;
    expect(refreshedRows[0]?.organization_id).toBeNull();
    expect(parsePgTextArray(refreshedRows[0]?.granted_organization_ids as string | null)).toEqual([
      primary.id,
      admin.id,
    ]);
    const downscopedInfoRes = await call(app, 'GET', '/oauth/userinfo', {
      headers: { Authorization: `Bearer ${refreshedBody.access_token}` },
    });
    expect(downscopedInfoRes.status).toBe(200);
    const downscopedInfo = (await downscopedInfoRes.json()) as {
      personal_org_slug: string | null;
      organizations: { id: string }[];
    };
    expect(downscopedInfo.organizations.map((organization) => organization.id)).toEqual([
      primary.id,
      admin.id,
    ]);
    expect(downscopedInfo.personal_org_slug).toBeNull();
  });

  it.each(['selected', 'all_current'] as const)(
    'issues ordinary device-code %s grants without a workspace binding',
    async (workspaceAccess) => {
      const app = buildApp();
      const sql = getTestDb();
      const workspace = await createTestOrganization({ name: 'Device Login Workspace' });
      const user = await createTestUser({ name: 'Device Login User' });
      await addUserToOrganization(user.id, workspace.id, 'member');
      const session = await createTestSession(user.id);
      const registration = await call(app, 'POST', '/oauth/register', {
        body: {
          client_name: 'Ordinary Device Login',
          grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          token_endpoint_auth_method: 'none',
        },
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const resource = `${ORIGIN}/mcp`;
      const authorization = await call(app, 'POST', '/oauth/device_authorization', {
        body: { client_id: client.client_id, resource, scope: 'mcp:read mcp:admin profile:read' },
      });
      expect(authorization.status).toBe(200);
      const device = (await authorization.json()) as { device_code: string; user_code: string };
      const verified = await call(app, 'GET', `/oauth/device/info?user_code=${device.user_code}`, {
        headers: { Cookie: session.cookieHeader },
      });
      expect(verified.status).toBe(200);
      const missingGrant = await call(app, 'POST', '/oauth/device/approve', {
        body: { user_code: device.user_code, approved: true },
        headers: { Cookie: session.cookieHeader },
      });
      expect(missingGrant.status).toBe(400);
      const approved = await call(app, 'POST', '/oauth/device/approve', {
        body: {
          user_code: device.user_code, approved: true,
          organization_ids: [workspace.id], workspace_access: workspaceAccess,
        },
        headers: { Cookie: session.cookieHeader },
      });
      expect(approved.status).toBe(200);
      const codes = await sql`
        SELECT organization_id, granted_organization_ids FROM oauth_device_codes
        WHERE device_code = ${device.device_code}
      `;
      expect(codes[0]?.organization_id).toBeNull();
      expect(parsePgTextArray(codes[0]?.granted_organization_ids as string)).toEqual([workspace.id]);
      const exchanged = await call(app, 'POST', '/oauth/token', {
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: client.client_id, device_code: device.device_code, resource,
        },
      });
      expect(exchanged.status).toBe(200);
      const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
      const provider = new OAuthProvider(sql, ORIGIN);
      const auth = await provider.verifyAccessToken(tokens.access_token);
      expect(auth).toMatchObject({
        userId: user.id, organizationId: null, grantedOrganizationIds: [workspace.id],
        authorizationGrantType: 'device_code', resource,
      });
      expect(auth?.scopes).not.toContain('mcp:admin');
      const futureWorkspace = await createTestOrganization({ name: 'Future Device Membership' });
      await addUserToOrganization(user.id, futureWorkspace.id, 'owner');
      const refreshed = await call(app, 'POST', '/oauth/token', {
        body: {
          grant_type: 'refresh_token', client_id: client.client_id,
          refresh_token: tokens.refresh_token, resource,
        },
      });
      expect(refreshed.status).toBe(200);
      const refreshTokens = (await refreshed.json()) as { access_token: string };
      expect(await provider.verifyAccessToken(refreshTokens.access_token)).toMatchObject({
        organizationId: null, grantedOrganizationIds: [workspace.id],
      });
    }
  );

  it('rejects an unowned workspace in the snapshot without partially granting it', async () => {
    const app = buildApp();
    const owned = await createTestOrganization({ name: 'Owned Grant Org' });
    const foreign = await createTestOrganization({ name: 'Foreign Grant Org' });
    const user = await createTestUser({ name: 'Grant Validation User' });
    await addUserToOrganization(user.id, owned.id, 'owner');
    const session = await createTestSession(user.id);
    const redirectUri = `${ORIGIN}/reject-callback`;
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Reject Workspace Client',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const response = await call(app, 'POST', '/oauth/authorize/consent', {
      body: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: 'mcp:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: `${ORIGIN}/mcp`,
        organization_ids: [owned.id, foreign.id],
        workspace_access: 'selected',
        authorization_intent: signAuthorizationRequest({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          scope: 'mcp:read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          resource: `${ORIGIN}/mcp`,
        }),
        approved: true,
      },
      headers: { Cookie: session.cookieHeader },
      env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'access_denied' });
  });

  it('never reconstructs missing stored grants from an organization binding', async () => {
    const app = buildApp();
    const sql = getTestDb();
    const anchor = await createTestOrganization({ name: 'Legacy Anchor Org' });
    const other = await createTestOrganization({ name: 'Legacy Other Org' });
    const user = await createTestUser({ name: 'Legacy Grant User' });
    await addUserToOrganization(user.id, anchor.id, 'owner');
    await addUserToOrganization(user.id, other.id, 'owner');
    const registration = await call(app, 'POST', '/oauth/register', {
      body: {
        client_name: 'Legacy Grant Client',
        redirect_uris: [`${ORIGIN}/legacy-callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    const client = (await registration.json()) as { client_id: string };
    const accessToken = 'owl_at_legacy-null-grant';
    const refreshToken = 'owl_rt_legacy-null-grant';
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        granted_organization_ids, scope, resource, expires_at
      ) VALUES
        ('legacy-null-access', 'access', ${hashToken(accessToken)}, ${client.client_id},
         ${user.id}, ${anchor.id}, NULL, 'mcp:read profile:read', ${`${ORIGIN}/mcp`},
         NOW() + INTERVAL '1 hour'),
        ('legacy-null-refresh', 'refresh', ${hashToken(refreshToken)}, ${client.client_id},
         ${user.id}, ${anchor.id}, NULL, 'mcp:read profile:read', ${`${ORIGIN}/mcp`},
         NOW() + INTERVAL '1 day')
    `;

    const provider = new OAuthProvider(sql, ORIGIN);
    const verified = await provider.verifyAccessToken(accessToken);
    expect(verified?.grantedOrganizationIds).toEqual([]);
    const info = await provider.getUserInfo(accessToken);
    expect(info?.organizations).toEqual([]);

    const refreshed = await call(app, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
        resource: `${ORIGIN}/mcp`,
      },
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = (await refreshed.json()) as { access_token: string };
    const refreshedRows = await sql`
      SELECT granted_organization_ids
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(refreshedBody.access_token)}
    `;
    expect(parsePgTextArray(refreshedRows[0]?.granted_organization_ids as string)).toEqual([]);
  });
});
