/**
 * Jira OAuth callback stamps cloud_id onto connection.config + external_tenant_id.
 *
 * Drives the real GET /connect/oauth/callback with scoped fake public-provider
 * responses. Non-provider requests still delegate to the original fetch.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectRoutes } from '../../../connect/routes';
import { createConnectToken } from '../../../utils/connect-tokens';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const PROVIDER_TOKEN_URL = 'https://oauth-provider.example.com/jira/token';
let accessibleHit = 0;
const originalFetch = globalThis.fetch;

describe('Jira OAuth callback stamps cloud_id (e2e)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JIRA_CLIENT_ID;
    delete process.env.JIRA_CLIENT_SECRET;
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    accessibleHit = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === PROVIDER_TOKEN_URL) {
        return Response.json({
          access_token: 'jira-access-token',
          refresh_token: 'jira-refresh-token',
          expires_in: 3600,
          scope: 'read:jira-work read:jira-user offline_access',
        });
      }
      if (url.includes('/oauth/token/accessible-resources')) {
        accessibleHit += 1;
        return new Response(
          JSON.stringify([
            {
              id: '49140293-40ce-45b6-8cdc-ec4e1356a7c8',
              url: 'https://rakam1.atlassian.net',
              name: 'rakam1',
              scopes: ['read:jira-work', 'read:jira-user', 'manage:jira-webhook'],
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  it('stamps cloud_id, site_url, external_tenant_id and preserves prior config', async () => {
    process.env.JIRA_CLIENT_ID = 'jira-client-id';
    process.env.JIRA_CLIENT_SECRET = 'jira-client-secret';
    const org = await createTestOrganization({ name: 'Jira Cloud Org' });
    const user = await createTestUser({ name: 'Jira Owner' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();

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
            tokenUrl: PROVIDER_TOKEN_URL,
          },
        ],
      },
      feeds_schema: {
        issues: {
          key: 'issues',
          name: 'Issues',
          operations: ['read'],
          configSchema: { type: 'object', properties: {} },
        },
      },
    });

    const [conn] = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, visibility, created_by, config
      )
      VALUES (
        ${org.id}, 'jira', 'jira-conn', 'Jira Connection', 'pending_auth', 'org', ${user.id},
        ${sql.json({ fetch_limit: 25 })}
      )
      RETURNING id
    `) as Array<{ id: number }>;

    const tokenRow = await createConnectToken({
      connectionId: conn.id,
      organizationId: org.id,
      connectorKey: 'jira',
      authType: 'oauth',
      createdBy: user.id,
      authConfig: {
        provider: 'jira',
        clientIdKey: 'JIRA_CLIENT_ID',
        clientSecretKey: 'JIRA_CLIENT_SECRET',
        tokenUrl: PROVIDER_TOKEN_URL,
        requestedScopes: ['read:jira-work'],
        pendingProfileMeta: {
          displayName: 'Jira Account',
          slug: 'jira-account',
          connectorKey: 'jira',
          provider: 'jira',
        },
      },
    });

    const res = await connectRoutes.request(
      `/oauth/callback?state=${encodeURIComponent(tokenRow.token)}&code=fake-auth-code`,
      { headers: { host: 'localhost' } }
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(400);
    expect(accessibleHit).toBe(1);

    const [after] = (await sql`
      SELECT c.status, c.visibility, c.config, c.external_tenant_id, ap.profile_kind
      FROM connections c
      LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      WHERE c.id = ${conn.id}
    `) as Array<{
      status: string;
      visibility: string;
      config: Record<string, unknown> | null;
      external_tenant_id: string | null;
      profile_kind: string | null;
    }>;

    expect(after.profile_kind).toBe('oauth_account');
    expect(after.status).toBe('active');
    expect(after.visibility).toBe('private');
    expect(after.external_tenant_id).toBe('49140293-40ce-45b6-8cdc-ec4e1356a7c8');
    expect(after.config).toMatchObject({
      fetch_limit: 25,
      cloud_id: '49140293-40ce-45b6-8cdc-ec4e1356a7c8',
      site_url: 'https://rakam1.atlassian.net',
      site_name: 'rakam1',
    });
  });
});
