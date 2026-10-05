import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const name = '20261005150000_retire_agent_tool_config.sql';
const root = new URL('../../../../../../db/migrations/', import.meta.url);
const migration = readFileSync(new URL(name, root), 'utf8').split('-- migrate:down')[0]!;
const precondition = readFileSync(new URL(`preconditions/${name}`, root), 'utf8');

describe('agent tool configuration cutover', () => {
  beforeEach(cleanupTestDatabase);

  it.each([['precondition', precondition], ['migration', migration]])('%s refuses stored restrictions without changing them', async (_name, assertion) => {
    const sql = getDb();
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id });
    const restriction = { strictMode: true, allowedTools: ['query_sdk'] };
    await sql`UPDATE agents SET tools_config = ${sql.json(restriction)} WHERE id = ${agent.agentId}`;
    await expect(sql.unsafe(assertion)).rejects.toThrow('owner review');
    const [row] = await sql`SELECT tools_config FROM agents WHERE id = ${agent.agentId}`;
    expect(row!.tools_config).toEqual(restriction);
    await sql`UPDATE agents SET tools_config = '{}'::jsonb WHERE id = ${agent.agentId}`;
    await sql.unsafe(assertion);
  });

  it.each(['pending', 'claimed', 'running'])('refuses a %s legacy turn but ignores terminal history', async (status) => {
    const sql = getDb();
    const org = await createTestOrganization();
    const [run] = await sql`INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
      VALUES (${org.id}, 'agent_turn', 'agent_turn', ${status},
        ${sql.json({ turn: { tools: { bash_policy: { allow_all: false, allow_prefixes: ['git'], deny_prefixes: [] } } } })}) RETURNING id`;
    for (const assertion of [precondition, migration]) {
      await expect(sql.unsafe(assertion)).rejects.toThrow('Drain active agent turns');
    }
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${run!.id}`;
    await sql.unsafe(precondition);
    await sql.unsafe(migration);
    const [row] = await sql`SELECT action_input FROM runs WHERE id = ${run!.id}`;
    expect(row!.action_input.turn.tools.bash_policy.allow_prefixes).toEqual(['git']);
  });
});
