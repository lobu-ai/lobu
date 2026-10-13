/**
 * `manage_connections` `update` accepts `visibility: 'org' | 'private'` — the
 * share switch for a connection (notably a device connection auto-wired as
 * `private` in a team workspace). Only the connection's creator may flip it,
 * not even an admin, and a personal-credential connection can never be widened:
 * the app answers with a readable error before the DB guard trigger would
 * reject the write.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { PERSONAL_CRED_ORG_VISIBILITY_ERROR } from '../../../tools/admin/helpers/connection-helpers';
import { manageConnections } from '../../../tools/admin/manage_connections';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

function ctxFor(organizationId: string, userId: string, memberRole: 'owner' | 'admin' | 'member'): ToolContext {
  return {
    organizationId,
    userId,
    memberRole,
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

async function seedConnection(params: {
  orgId: string;
  createdBy: string;
  slug: string;
  authProfileId?: number | null;
  connectorKey?: string;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status, visibility,
      created_by, auth_profile_id
    ) VALUES (
      ${params.orgId}, ${params.connectorKey ?? 'share.noauth'}, ${params.slug}, ${params.slug},
      'active', 'private', ${params.createdBy}, ${params.authProfileId ?? null}
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return row.id;
}

async function visibilityOf(connectionId: number): Promise<string> {
  const [row] = (await getTestDb()`
    SELECT visibility FROM connections WHERE id = ${connectionId}
  `) as unknown as Array<{ visibility: string }>;
  return row.visibility;
}

describe('manage_connections update visibility (share switch)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets the creator share and unshare their connection', async () => {
    const org = await createTestOrganization({ name: 'Share Org' });
    const member = await createTestUser({ name: 'Share Creator' });
    await addUserToOrganization(member.id, org.id, 'member');
    await createTestConnectorDefinition({
      key: 'share.noauth',
      name: 'Share NoAuth',
      organization_id: org.id,
      feeds_schema: { items: {} },
    });
    const connectionId = await seedConnection({ orgId: org.id, createdBy: member.id, slug: 'mine' });

    const shared = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, member.id, 'member')
    );
    expect('error' in shared ? shared.error : null).toBeNull();
    expect(await visibilityOf(connectionId)).toBe('org');

    const unshared = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'private' },
      TEST_ENV,
      ctxFor(org.id, member.id, 'member')
    );
    expect('error' in unshared ? unshared.error : null).toBeNull();
    expect(await visibilityOf(connectionId)).toBe('private');
  });

  it("refuses anyone but the creator, including a workspace owner", async () => {
    const org = await createTestOrganization({ name: 'Share Org B' });
    const creator = await createTestUser({ name: 'Creator B' });
    const owner = await createTestUser({ name: 'Owner B' });
    await addUserToOrganization(creator.id, org.id, 'member');
    await addUserToOrganization(owner.id, org.id, 'owner');
    await createTestConnectorDefinition({
      key: 'share.noauth',
      name: 'Share NoAuth',
      organization_id: org.id,
      feeds_schema: { items: {} },
    });
    const connectionId = await seedConnection({ orgId: org.id, createdBy: creator.id, slug: 'theirs' });

    const res = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, owner.id, 'owner')
    );
    expect(res).toEqual({ error: "Only the connection's creator can change who it is shared with." });
    expect(await visibilityOf(connectionId)).toBe('private');
  });

  it('refuses to widen a personal-credential connection', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Share Org C' });
    const creator = await createTestUser({ name: 'Creator C' });
    await addUserToOrganization(creator.id, org.id, 'owner');
    await createTestConnectorDefinition({
      key: 'share.oauth',
      name: 'Share OAuth',
      organization_id: org.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'shareoauth',
            requiredScopes: ['read'],
            clientIdKey: 'SHAREOAUTH_CLIENT_ID',
            clientSecretKey: 'SHAREOAUTH_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
    const [profile] = (await sql`
      INSERT INTO auth_profiles (organization_id, slug, display_name, connector_key, profile_kind, status, created_by)
      VALUES (${org.id}, 'my-account', 'My Account', 'share.oauth', 'oauth_account', 'active', ${creator.id})
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    const connectionId = await seedConnection({
      orgId: org.id,
      createdBy: creator.id,
      slug: 'my-inbox',
      authProfileId: profile.id,
      connectorKey: 'share.oauth',
    });

    const res = await manageConnections(
      { action: 'update', connection_id: connectionId, visibility: 'org' },
      TEST_ENV,
      ctxFor(org.id, creator.id, 'owner')
    );
    expect(res).toEqual({ error: PERSONAL_CRED_ORG_VISIBILITY_ERROR });
    expect(await visibilityOf(connectionId)).toBe('private');
  });
});
