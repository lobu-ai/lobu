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
import { get, post } from '../../setup/test-helpers';

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

  it.each(['/mcp-directory', '/mcp-directory/'])('does not serve MCP at the removed %s path', async (path) => {
    const response = await post(path, {
      token: accountToken,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it.each(['mcp-directory', 'mcp-directory/'])('does not advertise OAuth discovery for removed %s', async (path) => {
    const response = await get(`/.well-known/oauth-protected-resource/${path}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  it.each([false, true])('preserves SDK tools and execution with workspace pinning %s', async (pinned) => {
    const client = new TestMcpClient({ token: pinned ? oauthToken : accountToken, orgSlug: pinned ? orgSlug : undefined });
    const listed = await client.raw('tools/list');
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['search_sdk', 'query_sdk', 'run_sdk', 'open_view']));
    for (const result of [
      await client.querySdk('export default async () => 7;'),
      await client.runSdk('export default async () => 7;'),
    ]) {
      expect(result).toMatchObject({ success: true, return_value: 7 });
    }
  });
});
