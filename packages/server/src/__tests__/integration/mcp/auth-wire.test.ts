/**
 * MCP wire-level authentication and authorization.
 *
 * Replaces the deleted mcp/auth + member-write-access tests. Exercises the
 * real /mcp HTTP path so we cover JSON-RPC framing, session handshake, and
 * the auth middleware — none of which TestApiClient touches.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestMcpClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('MCP auth (wire)', () => {
  let orgSlug: string;
  let oauthToken: string;
  let accountToken: string;
  let patToken: string;

  beforeAll(async () => {
    await cleanupTestDatabase();

    const org = await createTestOrganization({ name: 'Auth Wire Org' });
    const user = await createTestUser({ email: 'auth-wire@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const oauthClient = await createTestOAuthClient();
    const oauthResult = await createTestAccessToken(user.id, org.id, oauthClient.client_id);
    const patResult = await createTestPAT(user.id, org.id);

    orgSlug = org.slug;
    oauthToken = oauthResult.token;
    accountToken = (await createTestAccessToken(user.id, null, oauthClient.client_id, {
      grantedOrganizationIds: [org.id],
    })).token;
    patToken = patResult.token;
  });

  it('accepts a valid OAuth token on /mcp/{slug}', async () => {
    const client = new TestMcpClient({ token: oauthToken, orgSlug });
    const result = await client.listOrganizations();
    expect(JSON.stringify(result)).toContain(orgSlug);
  });

  it('accepts a valid PAT (owl_pat_*) on /mcp/{slug}', async () => {
    const client = new TestMcpClient({ token: patToken, orgSlug });
    const result = await client.listOrganizations();
    expect(JSON.stringify(result)).toContain(orgSlug);
  });

  it('rejects a forged token on the same path', async () => {
    const client = new TestMcpClient({ token: 'forged_token_xyz', orgSlug });
    await expect(client.listOrganizations()).rejects.toThrow();
  });

  it('list_organizations works on the unscoped /mcp path with OAuth', async () => {
    // Org-agnostic tools must be reachable without an orgSlug.
    const client = new TestMcpClient({ token: accountToken });
    const result = await client.listOrganizations();
    expect(JSON.stringify(result)).toContain(orgSlug);
  });
});
