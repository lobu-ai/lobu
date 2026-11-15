/**
 * A REST tool call refused by the role + MCP-scope gate answers 403 Forbidden:
 * the caller is authenticated, it just may not do this. Only the status of an
 * access denial is pinned here; a malformed call keeps its 400.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../../setup/test-fixtures';
import { get, post, testRequest } from '../../setup/test-helpers';

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

  it('keeps write-rule refusals actionable without committing the rejected entity', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const schema = await post(`/api/${org.slug}/manage_entity_schema`, {
      token,
      body: {
        schema_type: 'entity_type', action: 'create', slug: 'invoice', name: 'Invoice',
        rules_source: `export default (row) => {
          if (row.op === 'create' && row.next.status !== 'draft') {
            row.deny('an invoice is created in draft, not ' + row.next.status);
          }
        };`,
      },
    });
    expect(schema.status).toBe(200);
    const create = (status: string) => post(`/api/${org.slug}/manage_entity`, {
      token, body: { action: 'create', entity_type: 'invoice', name: `Invoice ${status}`, metadata: { status } },
    });
    const refused = await create('posted');
    expect({ status: refused.status, body: await refused.json() }).toMatchObject({
      status: 400, body: { error: expect.stringContaining('an invoice is created in draft, not posted') },
    });
    expect((await create('draft')).status).toBe(200);
    const sql = getTestDb();
    const rows = await sql`SELECT e.name FROM entities e JOIN entity_types t ON t.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND t.slug = 'invoice'`;
    expect(rows.map((row) => row.name)).toEqual(['Invoice draft']);
  });

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

  it.each(['synthetic_unknown_tool', 'invoke_view_action'])('keeps an unsupported REST tool %s as an actionable client error', async (toolName) => {
    const { token } = await createTestPAT(ownerId, org.id);
    const response = await post(`/api/${org.slug}/${toolName}`, { token, body: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining(toolName) });
  });

  it.each(['wrapper', 'proxy'] as const)('returns a safe server error for a database failure through the REST %s', async (route) => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const call = () => route === 'wrapper'
      ? get(`/api/${org.slug}/automations`, { token })
      : post(`/api/${org.slug}/manage_automations`, { token, body: { action: 'list' } });
    expect((await call()).status).toBe(200);
    const sql = getTestDb();
    await sql`ALTER TABLE automations RENAME TO test_unavailable_automations`;
    try {
      const failed = await call();
      expect(failed.status).toBe(500);
      const parsed = await failed.json();
      expect(parsed).toMatchObject({ error: expect.any(String) });
      const body = JSON.stringify(parsed);
      expect(body).not.toContain('automations');
      expect(body).not.toContain('SELECT');
    } finally {
      await sql`ALTER TABLE test_unavailable_automations RENAME TO automations`;
    }
    expect((await call()).status).toBe(200);
  });

  it.each(['{', 'null', '[]', '42', '"text"'])('keeps invalid request JSON %s as a client error', async (rawBody) => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    for (const route of ['manage_automations', 'events/1/actions/vote']) {
      const response = await testRequest('POST', `/api/${org.slug}/${route}`, { token, rawBody,
        headers: { 'content-type': 'application/json' } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
  });
});
