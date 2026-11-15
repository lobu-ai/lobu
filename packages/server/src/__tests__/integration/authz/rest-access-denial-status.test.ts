/**
 * A REST tool call refused by the role + MCP-scope gate answers 403 Forbidden:
 * the caller is authenticated, it just may not do this. Only the status of an
 * access denial is pinned here; a malformed call keeps its 400.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
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

  it('keeps a malformed reaction_script actionable on create and set_reaction_script', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const { agentId } = await createTestAgent({ organizationId: org.id, ownerUserId: ownerId });
    const malformed = 'export default async () => { return ( ;';
    const expectCompileRefusal = async (response: Awaited<ReturnType<typeof post>>) => {
      expect({ status: response.status, body: await response.json() }).toMatchObject({
        status: 422, body: { error: expect.stringContaining('ReactionCompiler compilation failed') },
      });
    };
    const automation = {
      action: 'create', slug: 'rest-reaction', name: 'REST reaction',
      prompt: 'Track launches.', managed_agent_id: agentId,
    };
    await expectCompileRefusal(await post(`/api/${org.slug}/manage_automations`, {
      token, body: { ...automation, reaction_script: malformed },
    }));
    const created = await post(`/api/${org.slug}/manage_automations`, { token, body: automation });
    expect(created.status).toBe(200);
    const { automation_id } = (await created.json()) as { automation_id: string };
    await expectCompileRefusal(await post(`/api/${org.slug}/manage_automations`, {
      token, body: { action: 'set_reaction_script', automation_id, reaction_script: malformed },
    }));
    const [row] = await getTestDb()`SELECT reaction_script FROM automations WHERE id = ${automation_id}`;
    expect(row?.reaction_script ?? null).toBeNull();
  });

  it('refuses an apply-scoped mutation during a deployment pause with the resume instruction', async () => {
    const { token } = await createTestPAT(ownerId, org.id, { scope: 'mcp:read mcp:write mcp:admin' });
    const sql = getTestDb();
    await sql`
      INSERT INTO deployment_pause (organization_id, apply_id, rollback_of, paused_by)
      VALUES (${org.id}, 'apl_aaaaaaaa-1111-2222-3333-444444444444',
              'apl_bbbbbbbb-1111-2222-3333-444444444444', ${ownerId})
    `;
    const response = await post(`/api/${org.slug}/manage_entity_schema`, {
      token,
      headers: { 'x-lobu-apply-id': 'apl_cccccccc-1111-2222-3333-444444444444' },
      body: { schema_type: 'entity_type', action: 'create', slug: 'paused-type', name: 'Paused type' },
    });
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 409, body: { error: expect.stringContaining('lobu apply --resume') },
    });
    expect(await sql`SELECT id FROM entity_types WHERE organization_id = ${org.id} AND slug = 'paused-type'`)
      .toEqual([]);
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
