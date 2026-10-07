/** Social-login profiles must not carry sibling connector scopes into reconnect. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import { createAuthProfile } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const DRIVE_OPTIONAL = 'synthetic.drive.optional';
const DRIVE_FEED = 'synthetic.drive.feed';

describe('social-login provisioning isolates scopes per connector', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    vi.resetModules();
    vi.doMock('../../../connect/oauth-providers', () => ({
      fetchUserInfoWithRaw: async () => ({
        raw: { sub: 'google-sub-1', name: 'Synthetic User', email: 'synthetic@example.test' },
        normalized: { name: 'Synthetic User', email: 'synthetic@example.test' },
      }),
    }));
    vi.doMock('../../../utils/provisioned-connection', () => ({
      createProvisionedConnection: async () => ({ connectionId: null, error: null }),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../connect/oauth-providers');
    vi.doUnmock('../../../utils/provisioned-connection');
  });

  async function seedBase(identityScopes: string[]) {
    const scope = [...identityScopes, DRIVE_SCOPE, YOUTUBE_SCOPE, DRIVE_OPTIONAL, DRIVE_FEED].join(' ');
    const org = await createTestOrganization({ slug: 'acme' });
    const user = await createTestUser();
    const sql = getTestDb();

    await sql`
      INSERT INTO "account" (id, "accountId", "providerId", "userId", scope, "createdAt", "updatedAt")
      VALUES ('google-sub-1', 'google-sub-1', 'google', ${user.id}, ${scope}, NOW(), NOW())
    `;

    for (const [key, name, scope] of [
      ['google.drive', 'Drive', DRIVE_SCOPE],
      ['youtube', 'YouTube', YOUTUBE_SCOPE],
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
              loginScopes: ['openid', 'email', 'profile'],
              requiredScopes: [scope],
              optionalScopes: key === 'google.drive' ? [DRIVE_OPTIONAL] : [],
              loginProvisioning: { autoCreateConnection: true },
              clientIdKey: 'GOOGLE_CLIENT_ID',
              clientSecretKey: 'GOOGLE_CLIENT_SECRET',
              tokenUrl: 'https://oauth2.googleapis.com/token',
              userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
            },
          ],
        },
        feeds_schema: key === 'google.drive' ? { files: { requiredScopes: [DRIVE_FEED] } } : {},
      });
      await createAuthProfile({
        organizationId: org.id,
        connectorKey: key,
        displayName: 'Google App',
        profileKind: 'oauth_app',
        provider: 'google',
        authData: { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' },
      });
    }

    return { org, user, sql, scope };
  }

  async function profileScopes(sql: ReturnType<typeof getTestDb>, orgId: string, key: string) {
    const rows = await sql<{ auth_data: Record<string, unknown> }[]>`
      SELECT auth_data FROM auth_profiles
      WHERE organization_id = ${orgId}
        AND connector_key = ${key}
        AND profile_kind = 'oauth_account'
        AND account_id = 'google-sub-1'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    const authData = (rows[0]?.auth_data ?? {}) as {
      requested_scopes?: string[];
      granted_scopes?: string[];
    };
    return {
      requested: (authData.requested_scopes ?? []) as string[],
      granted: (authData.granted_scopes ?? []) as string[],
    };
  }

  it.each([
    { identityScopes: ['openid', 'email', 'profile'] },
    { identityScopes: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ] },
  ])('isolates declared scopes and preserves identity aliases: %j', async ({ identityScopes }) => {
    const { org, user, sql, scope } = await seedBase(identityScopes);
    const { provisionConnectorFromSocialLogin } = await import(
      '../../../auth/social-login-provisioning'
    );
    await provisionConnectorFromSocialLogin({
      env: {} as Env,
      request: new Request('https://example.test/acme/oauth2/callback/google'),
      account: {
        id: 'google-sub-1',
        userId: user.id,
        providerId: 'google',
        accessToken: 'tok',
        scope,
      },
    });

    const drive = await profileScopes(sql, org.id, 'google.drive');
    const youtube = await profileScopes(sql, org.id, 'youtube');

    expect(drive.requested).toEqual([...identityScopes, DRIVE_SCOPE, DRIVE_OPTIONAL, DRIVE_FEED]);
    expect(drive.granted).toEqual(drive.requested);
    expect(youtube.requested).toEqual([...identityScopes, YOUTUBE_SCOPE]);
    expect(youtube.granted).toEqual(youtube.requested);
  });
});
