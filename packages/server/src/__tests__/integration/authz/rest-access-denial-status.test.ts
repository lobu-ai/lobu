/**
 * A REST tool call refused by the role + MCP-scope gate answers 403 Forbidden:
 * the caller is authenticated, it just may not do this. Only the status of an
 * access denial is pinned here; a malformed call keeps its 400.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('REST access denials answer 403', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerId: string;
  let memberId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Denial status org', slug: 'denial-status-org' });
    const owner = await createTestUser({ email: 'owner@denial-status.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    ownerId = owner.id;
    const member = await createTestUser({ email: 'member@denial-status.example.com' });
    await addUserToOrganization(member.id, org.id, 'member');
    memberId = member.id;
  });

  const deleteAgent = { action: 'delete', agent_id: 'synthetic-agent' };

  it('refuses an admin action for a PAT without mcp:admin with 403', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write' });
    const response = await post(`/api/${org.slug}/manage_agents`, { token, body: deleteAgent });
    const body = (await response.json()) as { error: string };
    expect({ status: response.status, error: body.error }).toMatchObject({
      status: 403,
      error: expect.stringMatching(/admin access/),
    });
  });

  it("refuses an admin action for a member's full-scope PAT with 403", async () => {
    const { token } = await createTestPAT(memberId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const response = await post(`/api/${org.slug}/manage_agents`, { token, body: deleteAgent });
    const body = (await response.json()) as { error: string };
    expect({ status: response.status, error: body.error }).toMatchObject({
      status: 403,
      error: expect.stringMatching(/requires admin or owner access/),
    });
  });

  it('refuses a write for a read-only PAT with 403', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read' });
    const response = await post(`/api/${org.slug}/save_memory`, {
      token,
      body: { content: 'Synthetic note', entity_type: 'note' },
    });
    expect(response.status).toBe(403);
  });

  it('keeps 400 for a malformed call by an authorized caller', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const response = await post(`/api/${org.slug}/manage_agents`, {
      token,
      body: { action: 'not_a_real_action' },
    });
    expect(response.status).toBe(400);
  });
});
