/**
 * A connection approved at a lower access level than an action needs must say
 * exactly how to get that level. Refresh never widens an OAuth grant, so the
 * only fix is to reconnect and pick a higher level on the Lobu consent screen
 * — and "Administer workspaces" only takes effect for an owner/admin. A member
 * must be told that reconnecting cannot help.
 *
 * Exercised over a real OAuth MCP session, the way ChatGPT/Claude reach it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpRequest } from '../../setup/test-helpers';

const ORG_SLUG = 'scope-guidance-org';
const ADMIN_SCRIPT =
  'export default async (_c, client) => { await client.connections.installConnector({ connector_id: "__nonexistent__" }); return { ok: true }; }';

describe('MCP scope denial guidance', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let member: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Scope Guidance Org', slug: ORG_SLUG });
    owner = await createTestUser({ email: 'scope-owner@test.example.com' });
    member = await createTestUser({ email: 'scope-member@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(member.id, org.id, 'member');
    client = await createTestOAuthClient();
  });

  async function oauthToken(userId: string, scope: string) {
    const { token } = await createTestAccessToken(userId, org.id, client.client_id, { scope });
    return token;
  }

  async function runAdminScript(token: string) {
    const response = await mcpRequest<any>(
      'tools/call',
      { name: 'run_sdk', arguments: { script: ADMIN_SCRIPT } },
      { token, orgSlug: ORG_SLUG }
    );
    return response.result as any;
  }

  async function toolErrorText(token: string, name: string, args: Record<string, unknown>) {
    const response = await mcpRequest<any>(
      'tools/call',
      { name, arguments: args },
      { token, orgSlug: ORG_SLUG }
    );
    const result = response.result as any;
    expect(result?.isError).toBe(true);
    return (result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
  }

  const saveMemoryText = (token: string) =>
    toolErrorText(token, 'save_memory', { content: 'scope guidance probe' });
  const installConnectorText = (token: string) =>
    toolErrorText(token, 'manage_connections', {
      action: 'install_connector',
      connector_id: '__nonexistent__',
    });

  it('tells an owner on a write-level connection how to get admin without promising the option', async () => {
    const result = await runAdminScript(await oauthToken(owner.id, 'mcp:read mcp:write'));
    const message: string = result?.structuredContent?.error?.message ?? '';

    expect(result?.isError).toBe(true);
    expect(message).toContain('manage_connections.install_connector needs admin access');
    expect(message).toContain(`which this connection to ${ORG_SLUG} doesn't have`);
    expect(message).toContain("tokens aren't upgraded on refresh");
    expect(message).toContain(`As an owner of ${ORG_SLUG}, retry the action`);
    expect(message).toContain("choose 'Administer workspaces' if the consent screen offers it");
    expect(message).toContain('do this from the Lobu web app or CLI instead');
    // The progressive step-up challenge is unchanged and still offered.
    const challenge = result?._meta?.['mcp/www_authenticate']?.[0];
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('mcp:admin');
  });

  it('gives the same guidance when the admin tool is called directly', async () => {
    const text = await installConnectorText(await oauthToken(owner.id, 'mcp:read mcp:write'));

    expect(text).toContain('manage_connections.install_connector needs admin access');
    expect(text).toContain(`As an owner of ${ORG_SLUG}, retry the action`);
    expect(text).toContain("choose 'Administer workspaces' if the consent screen offers it");
  });

  it('tells a member that admin needs an owner/admin role, not a reconnect', async () => {
    const text = await installConnectorText(await oauthToken(member.id, 'mcp:read mcp:write'));

    expect(text).toContain(`manage_connections.install_connector requires admin or owner access in ${ORG_SLUG}`);
    expect(text).toContain(`Your role in ${ORG_SLUG} is member`);
    expect(text).toContain('reconnecting this app cannot change that');
    expect(text).not.toContain('Administer workspaces');
  });

  it('tells a read-only member to reconnect and choose Read and make changes', async () => {
    const text = await saveMemoryText(await oauthToken(member.id, 'mcp:read'));

    expect(text).toContain('save_memory needs write access');
    expect(text).toContain(`This connection to ${ORG_SLUG} was approved read-only`);
    expect(text).toContain("choose 'Read and make changes' on the Lobu consent screen");
    expect(text).not.toContain('Administer workspaces');
  });

  it('offers a read-only owner the admin level as well', async () => {
    const text = await saveMemoryText(await oauthToken(owner.id, 'mcp:read'));

    expect(text).toContain('save_memory needs write access');
    expect(text).toContain("choose 'Read and make changes' (or 'Administer workspaces'");
  });
});
