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

  // The remediation wording is pinned by unit/scope-denial-message.test.ts;
  // this suite pins the wire shape over a real OAuth MCP session.
  it('returns an insufficient_scope step-up challenge for mcp:admin on a nested admin SDK call', async () => {
    const result = await runAdminScript(await oauthToken(owner.id, 'mcp:read mcp:write'));

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.error?.message).toContain('manage_connections.install_connector');
    const challenge = result?._meta?.['mcp/www_authenticate']?.[0];
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('mcp:admin');
  });

  it.each([
    ['owner', 'mcp:read mcp:write', 'install_connector'],
    ['member', 'mcp:read mcp:write', 'install_connector'],
    ['member', 'mcp:read', 'save_memory'],
    ['owner', 'mcp:read', 'save_memory'],
  ] as const)('denies a direct call as a tool error (%s, %s, %s)', async (role, scope, tool) => {
    const token = await oauthToken(role === 'owner' ? owner.id : member.id, scope);
    const text = tool === 'save_memory' ? await saveMemoryText(token) : await installConnectorText(token);
    expect(text).toContain(tool === 'save_memory' ? 'save_memory' : 'manage_connections.install_connector');
  });
});
