import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, createTestEvent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const name = '20261011002000_finish_product_eval_retirement.sql';
const root = new URL('../../../../../../db/migrations/', import.meta.url);
const [up, down] = readFileSync(new URL(name, root), 'utf8').split('-- migrate:down');
const precondition = readFileSync(new URL(`preconditions/${name}`, root), 'utf8');

async function withLegacyColumns(run: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback legacy eval fixture');
  try {
    await getDb().begin(async tx => {
      await tx.unsafe(down!);
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe('product eval retirement contract migration', () => {
  beforeEach(cleanupTestDatabase);

  it('drops cached scores while preserving Automations and historical events and runs', async () => {
    const sql = getDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    await sql`INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug)
      SELECT n, n, ${org.id}, ${agent.agentId}, ${user.id}, 'Retirement fixture ' || n, 'retirement-fixture-' || n
      FROM generate_series(1, 259) AS n`;
    await createTestEvent({ organization_id: org.id, content: 'Preserved evaluation result', semantic_type: 'eval_score' });
    const [run] = await sql`INSERT INTO runs (run_type, queue_name, status, action_key, action_input)
      VALUES ('task', 'task', 'completed', 'score-eval-runs', '{"name":"score-eval-runs"}') RETURNING id`;
    await withLegacyColumns(async tx => {
      await tx`UPDATE automations SET latest_eval_score = 0.750, latest_eval_at = now(), latest_eval_run_id = ${run!.id} WHERE id <= 4`;
      const before = await tx`SELECT to_jsonb(a) - 'latest_eval_score' - 'latest_eval_at' - 'latest_eval_run_id' AS value FROM automations a ORDER BY id`;
      const events = await tx`SELECT to_jsonb(e) AS value FROM events e ORDER BY id`;
      const runs = await tx`SELECT to_jsonb(r) AS value FROM runs r ORDER BY id`;
      await tx.unsafe(precondition);
      await tx.unsafe(up!);
      expect(await tx`SELECT to_jsonb(a) AS value FROM automations a ORDER BY id`).toEqual(before);
      expect(await tx`SELECT to_jsonb(e) AS value FROM events e ORDER BY id`).toEqual(events);
      expect(await tx`SELECT to_jsonb(r) AS value FROM runs r ORDER BY id`).toEqual(runs);
      await tx.unsafe(up!);
      await tx.unsafe(down!);
      expect(await tx`SELECT 1 FROM automations WHERE latest_eval_score IS NOT NULL OR latest_eval_at IS NOT NULL OR latest_eval_run_id IS NOT NULL`).toEqual([]);
      await tx.unsafe(up!);
      expect(await tx`SELECT to_jsonb(a) AS value FROM automations a ORDER BY id`).toEqual(before);
    });
  });

  it.each(['pending', 'claimed', 'running'])('refuses a %s scorer task and preserves its input', async status => {
    const sql = getDb();
    for (const legacyInput of [true, false]) {
      const [run] = await sql`INSERT INTO runs (run_type, queue_name, status, action_key, action_input)
        VALUES ('task', 'task', ${status}, ${legacyInput ? null : 'score-eval-runs'},
          ${sql.json(legacyInput ? { name: 'score-eval-runs' } : {})}) RETURNING id, action_input`;
      await withLegacyColumns(async tx => {
        for (const assertion of [precondition, up!]) {
          await expect(tx.savepoint(sp => sp.unsafe(assertion))).rejects.toThrow('Drain active score-eval-runs');
        }
        expect(await tx`SELECT action_input FROM runs WHERE id = ${run!.id}`).toEqual([{ action_input: run!.action_input }]);
        expect(await tx`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'automations' AND column_name = 'latest_eval_score'`).toHaveLength(1);
      });
      await sql`UPDATE runs SET status = 'completed' WHERE id = ${run!.id}`;
    }
    await sql.unsafe(precondition);
  });

  it('supports read-only prerequisites, fresh installs, and already retired storage', async () => {
    await getDb().begin('read only', tx => tx.unsafe(precondition));
    await getDb().begin(async tx => {
      await tx`ALTER TABLE runs RENAME TO runs_before_retirement_fixture`;
      await tx.unsafe(precondition);
      await tx`ALTER TABLE runs_before_retirement_fixture RENAME TO runs`;
    });
    expect(await getDb()`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'automations'
        AND column_name IN ('latest_eval_score', 'latest_eval_at', 'latest_eval_run_id')`).toEqual([]);
  });
});
