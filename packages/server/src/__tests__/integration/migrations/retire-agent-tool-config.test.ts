import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const name = '20261005150000_retire_agent_tool_config.sql';
const root = new URL('../../../../../../db/migrations/', import.meta.url);
const migration = readFileSync(new URL(name, root), 'utf8').split('-- migrate:down')[0]!;
const precondition = readFileSync(new URL(`preconditions/${name}`, root), 'utf8');

const dropName = '20261005173700_drop_retired_agent_tool_config.sql';
const [dropUp, dropDown] = readFileSync(new URL(dropName, root), 'utf8').split('-- migrate:down');
const dropPrecondition = readFileSync(new URL(`preconditions/${dropName}`, root), 'utf8');

/** The legacy schema exists only inside this transaction, never between tests. */
async function withLegacyColumn(run: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback legacy agent tool column fixture');
  try {
    await getDb().begin(async tx => {
      await tx.unsafe(dropDown!);
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('agent tool configuration cutover', () => {
  beforeEach(cleanupTestDatabase);

  it('fresh migrated schema no longer contains retired tool configuration', async () => {
    const columns = await getDb()`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'`;
    expect(columns).toEqual([]);
  });

  it.each([['precondition', precondition], ['migration', migration]])('%s refuses stored restrictions without changing them', async (_name, assertion) => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id });
    const restriction = { strictMode: true, allowedTools: ['query_sdk'] };
    await withLegacyColumn(async tx => {
      await tx`UPDATE agents SET tools_config = ${tx.json(restriction)} WHERE id = ${agent.agentId}`;
      await expect(tx.savepoint(sp => sp.unsafe(assertion))).rejects.toThrow('owner review');
      const [row] = await tx`SELECT tools_config FROM agents WHERE id = ${agent.agentId}`;
      expect(row!.tools_config).toEqual(restriction);
      await tx`UPDATE agents SET tools_config = '{}'::jsonb WHERE id = ${agent.agentId}`;
      await tx.unsafe(assertion);
    });
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

describe('retired agent tool column contract migration', () => {
  beforeEach(cleanupTestDatabase);

  it('drops only the empty column at production row count and supports schema rollback/retry', async () => {
    const sql = getDb();
    const org = await createTestOrganization();
    await sql`INSERT INTO agents (id, organization_id, name)
      SELECT 'tool-drop-fixture-' || n, ${org.id}, 'Migration agent ' || n
      FROM generate_series(1, 53) AS n`;
    await withLegacyColumn(async tx => {
      await tx`UPDATE agents SET tools_config = NULL WHERE id = 'tool-drop-fixture-1'`;
      const before = await tx`SELECT to_jsonb(a) - 'tools_config' AS agent FROM agents a ORDER BY id`;
      expect(before).toHaveLength(53);
      await tx.unsafe(dropPrecondition);
      await tx.unsafe(dropUp!);
      expect(await tx`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'`).toEqual([]);
      expect(await tx`SELECT to_jsonb(a) AS agent FROM agents a ORDER BY id`).toEqual(before);
      // A direct SQL retry is harmless; framework fresh-up is exercised by setup.
      await tx.unsafe(dropUp!);
      await tx.unsafe(dropDown!);
      expect(await tx`SELECT tools_config FROM agents WHERE id = 'tool-drop-fixture-1'`).toEqual([{ tools_config: {} }]);
      await tx.unsafe(dropUp!);
      expect(await tx`SELECT to_jsonb(a) AS agent FROM agents a ORDER BY id`).toEqual(before);
    });
  });

  it.each([['precondition', dropPrecondition], ['migration', dropUp!]])('%s refuses nonempty legacy settings without losing data', async (_name, assertion) => {
    const org = await createTestOrganization();
    const agent = await createTestAgent({ organizationId: org.id });
    await withLegacyColumn(async tx => {
      const restriction = { strictMode: true, deniedTools: ['Bash'] };
      await tx`UPDATE agents SET tools_config = ${tx.json(restriction)} WHERE id = ${agent.agentId}`;
      await expect(tx.savepoint(sp => sp.unsafe(assertion))).rejects.toThrow('Refusing to drop nonempty');
      expect(await tx`SELECT tools_config FROM agents WHERE id = ${agent.agentId}`).toEqual([{ tools_config: restriction }]);
    });
  });

  it('keeps prerequisites read-only and supports absent-column and fresh-install schemas', async () => {
    await getDb().begin('read only', tx => tx.unsafe(dropPrecondition));
    await withLegacyColumn(async tx => {
      await tx`ALTER TABLE public.agents RENAME TO agents_before_tool_column_fixture`;
      await tx.unsafe(dropPrecondition);
    });
    expect(await getDb()`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'tools_config'`).toEqual([]);
  });
});
