/**
 * Without an app profile, connector OAuth-connect credentials fall back to deployment env vars
 * (`${PROVIDER}_CLIENT_ID/_SECRET`) — the SAME fallback global LOGIN uses
 * (`auth/config.ts resolveLoginProviderCredentials`). An org should be able to
 * connect a connector whose OAuth app creds are env-configured with NO
 * hand-created `oauth_app` profile and NO secret entry.
 *
 * Critical distinction this guards:
 *  - missing APP configuration falls back to env; an explicit profile is authoritative,
 *  - the per-user ACCOUNT token (oauth_account) + the Authorize redirect are
 *    STILL required — the connection lands `pending_auth`, never silently
 *    `active`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageAuthProfiles } from '../../../tools/admin/manage_auth_profiles';
import { manageConnections } from '../../../tools/admin/manage_connections';
import {
  resolveOAuthAppClientCredentials,
  resolveRequestedOAuthScopes,
} from '../../../tools/admin/helpers/connection-helpers';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;
const CLIENT_ID_KEY = 'DEMOENV_CLIENT_ID';
const CLIENT_SECRET_KEY = 'DEMOENV_CLIENT_SECRET';

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

async function makeOAuthConnector(orgId: string) {
  await createTestConnectorDefinition({
    key: 'demoenv.oauth',
    name: 'DemoEnv OAuth',
    organization_id: orgId,
    auth_schema: {
      methods: [
        {
          type: 'oauth',
          provider: 'demoenv',
          requiredScopes: ['read'],
          clientIdKey: CLIENT_ID_KEY,
          clientSecretKey: CLIENT_SECRET_KEY,
        },
      ],
    },
    feeds_schema: { items: {} },
  });
}

describe('connector OAuth scope resolution (pure)', () => {
  it('includes login identity scopes alongside required connector scopes', () => {
    expect(
      resolveRequestedOAuthScopes(
        {
          type: 'oauth',
          provider: 'google',
          loginScopes: ['openid', 'email', 'profile'],
          requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          optionalScopes: ['https://www.googleapis.com/auth/gmail.send'],
        },
        ['https://www.googleapis.com/auth/gmail.send']
      )
    ).toEqual([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });
});

describe('resolveOAuthAppClientCredentials — env fallback (pure)', () => {
  afterEach(() => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
  });

  it('resolves client id + secret from process.env when no app profile exists', () => {
    process.env[CLIENT_ID_KEY] = 'env-client-id';
    process.env[CLIENT_SECRET_KEY] = 'env-client-secret';

    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: null,
      provider: 'demoenv',
      clientIdKey: CLIENT_ID_KEY,
      clientSecretKey: CLIENT_SECRET_KEY,
    });

    expect(resolved.clientId).toBe('env-client-id');
    expect(resolved.clientSecret).toBe('env-client-secret');
  });

  it('derives default ${PROVIDER}_CLIENT_ID/_SECRET keys when the method omits them', () => {
    process.env.DEMOENV_CLIENT_ID = 'default-key-id';
    process.env.DEMOENV_CLIENT_SECRET = 'default-key-secret';

    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: null,
      provider: 'demoenv',
    });

    expect(resolved.clientId).toBe('default-key-id');
    expect(resolved.clientSecret).toBe('default-key-secret');
  });

  it('an explicit app profile wins over env (manual entry is authoritative)', () => {
    process.env[CLIENT_ID_KEY] = 'env-client-id';
    process.env[CLIENT_SECRET_KEY] = 'env-client-secret';

    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: {
        [CLIENT_ID_KEY]: 'profile-client-id',
        [CLIENT_SECRET_KEY]: 'profile-client-secret',
      },
      provider: 'demoenv',
      clientIdKey: CLIENT_ID_KEY,
      clientSecretKey: CLIENT_SECRET_KEY,
    });

    expect(resolved.clientId).toBe('profile-client-id');
    expect(resolved.clientSecret).toBe('profile-client-secret');
  });

  it('returns null when neither a profile nor env carries the credentials', () => {
    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: null,
      provider: 'demoenv',
      clientIdKey: CLIENT_ID_KEY,
      clientSecretKey: CLIENT_SECRET_KEY,
    });

    expect(resolved.clientId).toBeNull();
    expect(resolved.clientSecret).toBeNull();
  });

  it.each([{}, { [CLIENT_ID_KEY]: 'profile-client-id' }])('does not fill an incomplete selected app from deployment credentials: %j', (authData) => {
    process.env[CLIENT_ID_KEY] = 'env-client-id';
    process.env[CLIENT_SECRET_KEY] = 'env-client-secret';

    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: authData,
      provider: 'demoenv',
      clientIdKey: CLIENT_ID_KEY,
      clientSecretKey: CLIENT_SECRET_KEY,
    });

    expect(resolved.clientId).toBe(CLIENT_ID_KEY in authData ? 'profile-client-id' : null);
    expect(resolved.clientSecret).toBeNull();
  });
});

describe('connector OAuth connect — env-backed app credentials (DB-backed)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(() => {
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];
  });

  it('creates the connection with ZERO hand-made app profile when env client creds are set, auto-provisioning an env-backed oauth_app profile — and the ACCOUNT step is still required', async () => {
    process.env[CLIENT_ID_KEY] = 'env-client-id';
    process.env[CLIENT_SECRET_KEY] = 'env-client-secret';

    const org = await createTestOrganization({ name: 'Env Creds Org' });
    const user = await createTestUser({ name: 'Env Creds User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    await makeOAuthConnector(org.id);

    // The ACCOUNT profile (the user's authorized token) is still created via the
    // real OAuth flow — it lands pending_auth and only the Authorize callback
    // flips it active.
    const accRes = await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demoenv.oauth',
        profile_kind: 'oauth_account',
        display_name: 'DemoEnv Account',
        slug: 'demoenv-account',
      },
      TEST_ENV,
      ctx
    );
    expect('auth_profile' in accRes).toBe(true);
    if ('auth_profile' in accRes) {
      expect(accRes.auth_profile.status).toBe('pending_auth');
    }

    const sql = getTestDb();
    // No oauth_app profile exists yet — that's the whole point.
    const appBefore = await sql`
      SELECT id FROM auth_profiles
      WHERE organization_id = ${org.id} AND connector_key = 'demoenv.oauth'
        AND profile_kind = 'oauth_app'
    `;
    expect(appBefore).toHaveLength(0);

    // Create the connection WITHOUT app_auth_profile_slug — previously this
    // errored "Select or create an OAuth app profile before creating the
    // connection." Now it must succeed via the env fallback.
    const connRes = await manageConnections(
      {
        action: 'create',
        connector_key: 'demoenv.oauth',
        slug: 'demoenv-conn',
        display_name: 'DemoEnv Connection',
        auth_profile_slug: 'demoenv-account',
      },
      TEST_ENV,
      ctx
    );
    expect('error' in connRes).toBe(false);
    let connectionId = 0;
    if ('connection' in connRes) {
      // Authorize step still required: pending_auth, not active.
      expect((connRes.connection as { status: string }).status).toBe('pending_auth');
      connectionId = (connRes.connection as { id: number }).id;
    }
    expect(connectionId).toBeGreaterThan(0);

    // An env-backed oauth_app profile was auto-provisioned, carrying the env
    // client id/secret — and the connection is linked to it.
    const appAfter = await sql`
      SELECT id, status, auth_data FROM auth_profiles
      WHERE organization_id = ${org.id} AND connector_key = 'demoenv.oauth'
        AND profile_kind = 'oauth_app'
    `;
    expect(appAfter).toHaveLength(1);
    const appRow = appAfter[0] as { id: number; status: string; auth_data: Record<string, string> };
    expect(appRow.status).toBe('active');
    expect(appRow.auth_data[CLIENT_ID_KEY]).toBe('env-client-id');
    expect(appRow.auth_data[CLIENT_SECRET_KEY]).toBe('env-client-secret');

    const connRow = (
      await sql`SELECT app_auth_profile_id FROM connections WHERE id = ${connectionId}`
    )[0] as { app_auth_profile_id: number | null };
    expect(Number(connRow.app_auth_profile_id)).toBe(Number(appRow.id));

    // The resolver the /connect/:token/oauth/start path uses now yields BOTH
    // client id and secret from this env-backed profile — no "OAuth client
    // secret not configured" throw.
    const resolved = resolveOAuthAppClientCredentials({
      appProfileAuthData: appRow.auth_data,
      provider: 'demoenv',
      clientIdKey: CLIENT_ID_KEY,
      clientSecretKey: CLIENT_SECRET_KEY,
    });
    expect(resolved.clientId).toBe('env-client-id');
    expect(resolved.clientSecret).toBe('env-client-secret');
  });

  it('creates a new OAuth connection private from the start and explains its agent-owner scope', async () => {
    process.env[CLIENT_ID_KEY] = 'env-client-id';
    process.env[CLIENT_SECRET_KEY] = 'env-client-secret';

    const org = await createTestOrganization({ name: 'OAuth Scope Org' });
    const user = await createTestUser({ name: 'OAuth Scope User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    await makeOAuthConnector(org.id);

    const result = await manageConnections(
      { action: 'connect', connector_key: 'demoenv.oauth' },
      TEST_ENV,
      ctx
    );

    expect(result).toMatchObject({
      action: 'connect',
      status: 'pending_auth',
      auth_type: 'oauth',
      instructions: expect.stringContaining('AGENT OWNER'),
    });
    const connectionId =
      'connection_id' in result ? Number(result.connection_id) : 0;
    expect(connectionId).toBeGreaterThan(0);

    const [row] = (await getTestDb()`
      SELECT status, visibility
      FROM connections
      WHERE id = ${connectionId}
    `) as Array<{ status: string; visibility: string }>;
    expect(row).toEqual({ status: 'pending_auth', visibility: 'private' });
  });

  it('still requires an app profile when NO env client creds are set (no silent bypass)', async () => {
    // Ensure the env vars are absent for this case.
    delete process.env[CLIENT_ID_KEY];
    delete process.env[CLIENT_SECRET_KEY];

    const org = await createTestOrganization({ name: 'No Env Creds Org' });
    const user = await createTestUser({ name: 'No Env Creds User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const ctx = ctxFor(org.id, user.id);
    await makeOAuthConnector(org.id);

    await manageAuthProfiles(
      {
        action: 'create_auth_profile',
        connector_key: 'demoenv.oauth',
        profile_kind: 'oauth_account',
        display_name: 'DemoEnv Account',
        slug: 'demoenv-account',
      },
      TEST_ENV,
      ctx
    );

    const connRes = await manageConnections(
      {
        action: 'create',
        connector_key: 'demoenv.oauth',
        slug: 'demoenv-conn',
        display_name: 'DemoEnv Connection',
        auth_profile_slug: 'demoenv-account',
      },
      TEST_ENV,
      ctx
    );

    // No env creds AND no hand-made app profile → return machine-actionable
    // setup guidance instead of leaving the caller to parse prose.
    expect(connRes).toMatchObject({
      error_code: 'connector_setup_required',
      connector_key: 'demoenv.oauth',
      provider: 'demoenv',
      install_type: 'oauth_app_profile',
      next_action: 'configure_oauth_app',
      setup_url: expect.stringContaining('/demoenv.oauth'),
    });
  });

	it('returns Jira-specific setup guidance when its OAuth app profile is missing', async () => {
		delete process.env.JIRA_CLIENT_ID;
		delete process.env.JIRA_CLIENT_SECRET;

		const org = await createTestOrganization({ name: 'Jira Setup Org' });
		const user = await createTestUser({ name: 'Jira Setup User' });
		await addUserToOrganization(user.id, org.id, 'owner');
		const ctx = ctxFor(org.id, user.id);
		await createTestConnectorDefinition({
			key: 'jira',
			name: 'Jira',
			organization_id: org.id,
			auth_schema: {
				methods: [
					{
						type: 'oauth',
						provider: 'jira',
						requiredScopes: ['read:jira-work'],
						clientIdKey: 'JIRA_CLIENT_ID',
						clientSecretKey: 'JIRA_CLIENT_SECRET',
						setupInstructions:
							'Create an OAuth 2.0 (3LO) app in the Atlassian Developer Console.',
					},
				],
			},
		});

		const result = await manageConnections(
			{ action: 'connect', connector_key: 'jira' },
			TEST_ENV,
			ctx
		);

		expect(result).toMatchObject({
			error_code: 'connector_setup_required',
			connector_key: 'jira',
			provider: 'jira',
			install_type: 'oauth_app_profile',
			next_action: 'configure_oauth_app',
			setup_url: expect.stringContaining('/jira'),
			setup_instructions: expect.stringContaining('Atlassian Developer Console'),
		});
		expect(result).not.toHaveProperty('install_url');

		const rows = await getTestDb()`
			SELECT id FROM connections
			WHERE organization_id = ${org.id} AND connector_key = 'jira'
		`;
		expect(rows).toHaveLength(0);
	});
});
