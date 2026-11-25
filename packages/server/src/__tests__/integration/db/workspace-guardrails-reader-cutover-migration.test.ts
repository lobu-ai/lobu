/**
 * Guardrails reader cutover (`20261125140000_workspace_guardrails_reader_cutover.sql`).
 *
 * The backfill moves every agent's built-in toggles (`agents.guardrails`) and
 * custom checks (`agents.guardrails_inline`) into the workspace guardrail
 * library deterministically. Each case replays the migration's up section
 * inside a transaction that is ROLLED BACK, so the shared integration DB is
 * not mutated.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20261125140000_workspace_guardrails_reader_cutover.sql';

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

class Rollback extends Error {}

type Sql = ReturnType<typeof getDb>;

const synth = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;

/** Run `body` in a transaction that always rolls back, returning its result. */
async function inRollback<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await getDb().begin(async (tx: Sql) => {
      result = await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result as T;
}

async function insertAgent(
  tx: Sql,
  orgId: string,
  agentId: string,
  guardrails: unknown,
  inline: unknown
) {
  await tx`
    INSERT INTO agents (id, organization_id, name, owner_platform, owner_user_id, guardrails, guardrails_inline)
    VALUES (${agentId}, ${orgId}, ${agentId}, 'lobu', 'synthetic-owner',
            ${tx.json(guardrails as never)}, ${tx.json(inline as never)})
  `;
}

const up = () => loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

const judge = (name: string, policy: string, extra: Record<string, unknown> = {}) => ({
  name,
  enabled: true,
  stage: 'output',
  policy,
  ...extra,
});

describe('workspace guardrails reader cutover migration', () => {
  it('backfills built-ins per agent set and merges or splits custom checks deterministically', async () => {
    const orgId = (await createTestOrganization()).id;
    // Agent ids sort alpha < beta < gamma, which fixes first-occurrence order.
    const [alpha, beta, gamma] = ['a', 'b', 'c'].map((p) => `${p}-${synth('agent')}`);

    const result = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, alpha, ['secret-scan', 'pii-scan'], [
        judge('No Refunds', 'Never promise refunds.'),
        // Shares a built-in's name: the built-in keeps it.
        judge('secret-scan', 'Custom secret policy.'),
        { name: 'must-reply', enabled: true, stage: 'output', kind: 'require-tool', tools: ['send_message'] },
        judge('egress-check', 'Only read.', { stage: 'egress', domains: ['.example.com'], model: 'openai/gpt-4o-mini' }),
      ]);
      await insertAgent(tx, orgId, beta, ['secret-scan'], [
        // Identical config to alpha's: one row, two subjects.
        judge('no refunds', 'Never promise refunds.'),
        // Same name, different config: split.
        judge('no-refunds', 'Refunds need a manager.'),
      ]);
      await insertAgent(tx, orgId, gamma, [], [
        // Same config but disabled: kept as its own disabled row.
        { ...judge('No Refunds', 'Never promise refunds.'), enabled: false },
      ]);

      await tx.unsafe(up());
      const readLibrary = () => tx<{
        id: string; name: string; config: Record<string, unknown>; enabled: boolean; agents: string[];
      }>`
        SELECT g.id, g.name, g.config, g.enabled,
               to_jsonb(array_agg(gs.principal_id ORDER BY gs.principal_id COLLATE "C")) AS agents
        FROM workspace_guardrails g
        JOIN workspace_guardrail_subjects gs ON gs.guardrail_id = g.id
        WHERE g.organization_id = ${orgId} AND gs.principal_kind = 'agent'
        GROUP BY g.id
        ORDER BY g.name COLLATE "C"
      `;
      const first = await readLibrary();
      // Idempotent: a second run sees a non-empty library and changes nothing.
      await tx.unsafe(up());
      const second = await readLibrary();
      return { first, second };
    });

    expect(result.second).toEqual(result.first);
    const byName = Object.fromEntries(result.first.map((row) => [row.name, row]));
    expect(Object.keys(byName)).toEqual([
      'egress-check',
      'must-reply',
      'no-refunds',
      'no-refunds-2',
      'no-refunds-3',
      'pii-scan',
      'secret-scan',
      'secret-scan-2',
    ]);
    expect(byName['secret-scan']).toMatchObject({
      config: { builtin: 'secret-scan' }, enabled: true, agents: [alpha, beta],
    });
    expect(byName['pii-scan']).toMatchObject({ config: { builtin: 'pii-scan' }, agents: [alpha] });
    expect(byName['secret-scan-2']).toMatchObject({
      config: { kind: 'judge', stage: 'output', policy: 'Custom secret policy.' }, agents: [alpha],
    });
    expect(byName['no-refunds']).toMatchObject({
      config: { kind: 'judge', stage: 'output', policy: 'Never promise refunds.' },
      enabled: true,
      agents: [alpha, beta],
    });
    expect(byName['no-refunds-2']).toMatchObject({
      config: { policy: 'Refunds need a manager.' }, enabled: true, agents: [beta],
    });
    expect(byName['no-refunds-3']).toMatchObject({
      config: { policy: 'Never promise refunds.' }, enabled: false, agents: [gamma],
    });
    expect(byName['must-reply']?.config).toEqual({
      kind: 'require-tool', stage: 'output', tools: ['send_message'],
    });
    expect(byName['egress-check']?.config).toEqual({
      kind: 'judge', stage: 'egress', policy: 'Only read.', domains: ['.example.com'], model: 'openai/gpt-4o-mini',
    });
    // Deterministic ids from (org, name).
    for (const row of result.first) {
      expect(row.id).toMatch(/^guardrail_[0-9a-f]{32}$/);
    }
  });

  it('aborts and lists every malformed agent guardrail instead of dropping it', async () => {
    const orgId = (await createTestOrganization()).id;
    const agent = synth('agent');

    const error = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, agent, ['secret-scan', 'made-up'], [
        { name: 'bad-stage', enabled: true, stage: 'sideways', policy: 'x' },
        { name: 'no-policy', enabled: true, stage: 'input' },
        { name: 'rt', enabled: true, stage: 'input', kind: 'require-tool', tools: [] },
      ]);
      return tx.unsafe(up()).then(
        () => null,
        (err: unknown) => err as { code?: string; message?: string }
      );
    });

    expect(error?.code).toBe('23514');
    expect(error?.message).toContain(`agent=${agent} guardrails[1] is not a built-in guardrail name`);
    expect(error?.message).toContain('guardrails_inline[0].stage must be one of');
    expect(error?.message).toContain('guardrails_inline[1].policy must be a non-empty string');
    expect(error?.message).toContain('guardrails_inline[2].stage: require-tool only supports stage "output"');
    expect(error?.message).toContain('guardrails_inline[2].tools must be a non-empty array');
  });

  it('skips an organization that already has library guardrails', async () => {
    const orgId = (await createTestOrganization()).id;
    const agent = synth('agent');

    const names = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, agent, ['secret-scan'], []);
      await tx`
        INSERT INTO workspace_guardrails (id, organization_id, name, config)
        VALUES (${synth('guardrail')}, ${orgId}, 'existing', ${tx.json({ builtin: 'pii-scan' })})
      `;
      await tx.unsafe(up());
      return tx<{ name: string }[]>`
        SELECT name FROM workspace_guardrails WHERE organization_id = ${orgId} ORDER BY name
      `;
    });

    expect(names.map((row) => row.name)).toEqual(['existing']);
  });
});
