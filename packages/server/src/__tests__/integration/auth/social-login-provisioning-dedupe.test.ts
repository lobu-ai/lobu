/**
 * Social-login connection auto-provisioning must dedupe by the STABLE account
 * identity, not by the auth-profile row.
 *
 * Duplicate profiles and null-profile connections must be reconciled only
 * within the stored grant owner.
 *
 * Foreign-owner rows stay unchanged, and a login event cannot claim another
 * user's stored grant.
 */

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

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

describe('social-login connection provisioning dedupes by account', () => {
  let provisionCalls: number;

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    vi.resetModules();
    provisionCalls = 0;
    vi.doMock('../../../connect/oauth-providers', () => ({
      fetchUserInfoWithRaw: async () => ({
        raw: { sub: 'google-sub-1', name: 'Synthetic User', email: 'synthetic-user@example.test' },
        normalized: { name: 'Synthetic User', email: 'synthetic-user@example.test' },
      }),
    }));
    vi.doMock('../../../utils/provisioned-connection', () => ({
      createProvisionedConnection: async () => {
        provisionCalls += 1;
        return { connectionId: null, error: null };
      },
    }));
  });

  afterEach(() => {
    // The integration suite runs with isolate:false (shared module graph) —
    // clear these mocks so they cannot leak into sibling test files.
    vi.resetModules();
    vi.doUnmock('../../../connect/oauth-providers');
    vi.doUnmock('../../../utils/provisioned-connection');
  });

  /** Org + connector definition + app profile + account row shared by every case. */
  async function seedBase() {
    const org = await createTestOrganization({ slug: 'acme' });
    const user = await createTestUser();
    const sql = getTestDb();

    // Grant the connector's required scope so a synced connection is usable
    // (active), not pending.
    await sql`
      INSERT INTO "account" (id, "accountId", "providerId", "userId", scope, "createdAt", "updatedAt")
      VALUES ('google-sub-1', 'google-sub-1', 'google', ${user.id}, ${`openid email ${GMAIL_SCOPE}`}, NOW(), NOW())
    `;

    await createTestConnectorDefinition({
      key: 'google.gmail',
      name: 'Gmail',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: [GMAIL_SCOPE],
            loginProvisioning: { autoCreateConnection: true },
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
          },
        ],
      },
      feeds_schema: { threads: {} },
    });

    // OAuth app profile — required for the auto-provision path.
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'Google App',
      profileKind: 'oauth_app',
      provider: 'google',
      authData: { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' },
    });

    return { org, user, sql };
  }

  /** The historical duplication: two oauth_account profiles for the SAME Google account. */
  async function seedDuplicateProfiles(orgId: string, userId: string) {
    const older = await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'google.gmail',
      displayName: 'personal',
      slug: 'personal',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      createdBy: userId,
      provider: 'google',
      status: 'active',
    });
    await createAuthProfile({
      organizationId: orgId,
      connectorKey: 'google.gmail',
      displayName: 'gmail-account',
      slug: 'gmail-account',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      createdBy: userId,
      provider: 'google',
      status: 'active',
    });
    return older;
  }

  async function runProvision(organizationId: string, userId: string) {
    const { provisionConnectorFromSocialLogin } = await import(
      '../../../auth/social-login-provisioning'
    );
    await provisionConnectorFromSocialLogin({
      env: {} as Env,
      organizationId,
      request: new Request('https://example.test/acme/oauth2/callback/google'),
      account: {
        id: 'google-sub-1',
        userId,
        providerId: 'google',
        accessToken: 'tok',
        scope: `openid email ${GMAIL_SCOPE}`,
      },
    });
  }

  async function connectionRows(sql: ReturnType<typeof getTestDb>, orgId: string) {
    return sql<{ id: number; auth_profile_id: number | null; status: string }[]>`
      SELECT id, auth_profile_id, status FROM connections
      WHERE organization_id = ${orgId}
        AND connector_key = 'google.gmail'
        AND deleted_at IS NULL
      ORDER BY id
    `;
  }

  it('does not reuse a profile or connection owned by somebody else', async () => {
    const { org, user, sql } = await seedBase();
    const older = await seedDuplicateProfiles(org.id, user.id);
    const other = await createTestUser({ name: 'Synthetic other owner' });
    // Model legacy corruption directly; normal profile writers must reject it.
    await sql`UPDATE auth_profiles SET created_by = ${other.id} WHERE organization_id = ${org.id} AND profile_kind = 'oauth_account'`;
    const [connection] = await sql`INSERT INTO connections
      (organization_id, connector_key, slug, display_name, status, auth_profile_id, account_id, created_by, visibility)
      VALUES (${org.id}, 'google.gmail', 'synthetic-other-mail', 'Synthetic other mail', 'pending_auth',
        ${older.id}, 'google-sub-1', ${other.id}, 'private') RETURNING *`;
    const profilesBefore = await sql`SELECT * FROM auth_profiles WHERE profile_kind = 'oauth_account' ORDER BY id`;
    await runProvision(org.id, user.id);
    expect(provisionCalls).toBe(1);
    expect(await sql`SELECT * FROM connections WHERE id = ${connection.id}`).toEqual([connection]);
    expect(await sql`SELECT * FROM auth_profiles WHERE created_by = ${other.id} ORDER BY id`).toEqual(profilesBefore);
    const [own] = await sql`SELECT created_by, account_id FROM auth_profiles WHERE profile_kind = 'oauth_account' AND created_by = ${user.id}`;
    expect(own).toMatchObject({ created_by: user.id, account_id: 'google-sub-1' });
  });

  it('checks the stored grant owner before provisioning from a login event', async () => {
    const { org, sql } = await seedBase();
    const other = await createTestUser({ name: 'Synthetic forged login owner' });
    await expect(runProvision(org.id, other.id)).rejects.toThrow();
    expect(provisionCalls).toBe(0);
    expect(await sql`SELECT id FROM auth_profiles WHERE profile_kind = 'oauth_account'`).toHaveLength(0);
  });

  it('reuses the connection of a duplicate older profile for the same account', async () => {
    const { org, user, sql } = await seedBase();
    const older = await seedDuplicateProfiles(org.id, user.id);

    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, auth_profile_id, created_by, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'google.gmail', 'synthetic-mail', 'Gmail', 'active', ${older.id}, ${user.id}, 'private', NOW(), NOW()
      )
    `;

    await runProvision(org.id, user.id);

    expect(provisionCalls).toBe(0);
    const rows = await connectionRows(sql, org.id);
    expect(rows).toHaveLength(1);
    // Rebound onto the resolved (newer) profile, then synced usable.
    expect(rows[0].status).toBe('active');
  });

  it('reuses a connection whose auth_profile_id is null but account_id is materialized', async () => {
    const { org, user, sql } = await seedBase();
    // No duplicate profiles needed — the connection carries the identity itself.
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'gmail-account',
      slug: 'gmail-account',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      createdBy: user.id,
      provider: 'google',
      status: 'active',
    });

    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, auth_profile_id, created_by, account_id, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'google.gmail', 'synthetic-mail', 'Gmail', 'active', NULL, ${user.id}, 'google-sub-1', 'private', NOW(), NOW()
      )
    `;

    await runProvision(org.id, user.id);

    expect(provisionCalls).toBe(0);
    const rows = await connectionRows(sql, org.id);
    expect(rows).toHaveLength(1);
    // Rebound onto the resolved profile and synced usable.
    expect(rows[0].auth_profile_id).not.toBeNull();
    expect(rows[0].status).toBe('active');
  });

  it('reconciles a pending connection on the older profile instead of leaving it stranded', async () => {
    const { org, user, sql } = await seedBase();
    const older = await seedDuplicateProfiles(org.id, user.id);

    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, auth_profile_id, created_by, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'google.gmail', 'synthetic-mail', 'Gmail', 'pending_auth', ${older.id}, ${user.id}, 'private', NOW(), NOW()
      )
    `;

    await runProvision(org.id, user.id);

    expect(provisionCalls).toBe(0);
    const rows = await connectionRows(sql, org.id);
    expect(rows).toHaveLength(1);
    // No duplicate, and the pending connection was reconciled to usable.
    expect(rows[0].status).toBe('active');
  });

  it('floors an org-visible null-profile connection to private when rebinding a personal credential', async () => {
    const { org, user, sql } = await seedBase();
    await createAuthProfile({
      organizationId: org.id,
      connectorKey: 'google.gmail',
      displayName: 'gmail-account',
      slug: 'gmail-account',
      profileKind: 'oauth_account',
      accountId: 'google-sub-1',
      createdBy: user.id,
      provider: 'google',
      status: 'active',
    });

    // A null-auth_profile connection may legally be org-visible; the
    // personal-credential trigger rejects attaching an oauth_account profile
    // at org visibility, so the rebind must floor visibility to private.
    await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status, auth_profile_id, created_by, account_id, visibility, created_at, updated_at
      ) VALUES (
        ${org.id}, 'google.gmail', 'synthetic-mail', 'Gmail', 'active', NULL, ${user.id}, 'google-sub-1', 'org', NOW(), NOW()
      )
    `;

    await runProvision(org.id, user.id);

    expect(provisionCalls).toBe(0);
    const rows = await sql<{ id: number; auth_profile_id: number | null; status: string; visibility: string }[]>`
      SELECT id, auth_profile_id, status, visibility FROM connections
      WHERE organization_id = ${org.id}
        AND connector_key = 'google.gmail'
        AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_profile_id).not.toBeNull();
    expect(rows[0].visibility).toBe('private');
    expect(rows[0].status).toBe('active');
  });
});
