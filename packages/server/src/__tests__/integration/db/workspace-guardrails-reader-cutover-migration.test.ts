/**
 * Guardrails reader cutover (`20261125140000_workspace_guardrails_reader_cutover.sql`),
 * its custom config normalization (`20261125160000_workspace_guardrails_custom_config_keys.sql`)
 * and the upgrade refusal once custom checks retired
 * (`20261125210000_refuse_custom_guardrails.sql`).
 *
 * The backfill moves every agent's built-in toggles (`agents.guardrails`) and
 * custom checks (`agents.guardrails_inline`) into the workspace guardrail
 * library deterministically. Each case replays the migrations' up sections
 * inside a transaction that is ROLLED BACK, so the shared integration DB is
 * not mutated.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { listEntityApprovalPolicies } from '../../../authz/entity-policy';
import { loopPolicyCutoverComplete } from '../../../authz/policy-hooks';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20261125140000_workspace_guardrails_reader_cutover.sql';
const NORMALIZATION = '20261125160000_workspace_guardrails_custom_config_keys.sql';
const REFUSAL = '20261125210000_refuse_custom_guardrails.sql';
const POLICY_CUTOVER = '20261126040000_backfill_loop_policies.sql';

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

/**
 * Run `body` in a transaction that always rolls back, returning its result.
 * A later migration dropped the legacy agent column(s) this backfill reads, so
 * the transaction first restores the schema the backfill ran against: an
 * install upgrading from before the cutover still runs it on that schema.
 */
async function inRollback<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await getDb().begin(async (tx: Sql) => {
      await tx.unsafe(`ALTER TABLE agents
        ADD COLUMN guardrails jsonb DEFAULT '[]'::jsonb,
        ADD COLUMN guardrails_inline jsonb DEFAULT '[]'::jsonb`);
      await tx`DROP INDEX IF EXISTS write_approval_policies_loop_lookup`;
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
const normalize = () => loadMigrationUpSection(resolveMigrationsDir(), NORMALIZATION);
const refuse = () => loadMigrationUpSection(resolveMigrationsDir(), REFUSAL);

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

  it('normalizes custom checks the backfill gave stray keys, leaving built-ins as they are', async () => {
    const orgId = (await createTestOrganization()).id;
    const agent = synth('agent');

    // Each custom check carries a key outside the custom config contract,
    // which the retired inline validator accepted and the backfill copied.
    const cases = [
      { name: 'leaky', inline: judge('leaky', 'Never paste keys.', { builtin: 'secret-scan' }),
        config: { kind: 'judge', stage: 'output', policy: 'Never paste keys.' } },
      { name: 'ghost', inline: judge('ghost', 'Stay polite.', { builtin: 'synthetic-unregistered' }),
        config: { kind: 'judge', stage: 'output', policy: 'Stay polite.' } },
      { name: 'odd', inline: judge('odd', 'Be brief.', { builtin: 42, note: 'copied' }),
        config: { kind: 'judge', stage: 'output', policy: 'Be brief.' } },
      { name: 'egress-gate',
        inline: judge('egress-gate', 'Only GET.', { stage: 'egress', domains: ['.example.com'], builtin: 'pii-scan' }),
        config: { kind: 'judge', stage: 'egress', policy: 'Only GET.', domains: ['.example.com'] } },
      { name: 'must-reply',
        inline: { name: 'must-reply', enabled: true, stage: 'output', kind: 'require-tool', tools: ['send_message'], builtin: 'forbidden-tools' },
        config: { kind: 'require-tool', stage: 'output', tools: ['send_message'] } },
    ];

    const result = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, agent, ['secret-scan'], [
        ...cases.map((c) => c.inline),
        judge('plain', 'Plain policy.'),
      ]);
      const read = async () => {
        const rows = await tx<{ name: string; config: Record<string, unknown>; enabled: boolean; revision: number }>`
          SELECT g.name, g.config, g.enabled, g.revision::int AS revision
          FROM workspace_guardrails g JOIN workspace_guardrail_subjects s ON s.guardrail_id = g.id
          WHERE g.organization_id = ${orgId} AND s.principal_kind = 'agent' AND s.principal_id = ${agent}
        `;
        return { rows: Object.fromEntries(rows.map((row) => [row.name, row])) };
      };
      await tx.unsafe(up());
      const backfilled = await read();
      await tx.unsafe(normalize());
      const normalized = await read();
      await tx.unsafe(normalize());
      const rerun = await read();
      return { backfilled, normalized, rerun };
    });

    // The backfill copied each check's stray `builtin` key.
    for (const c of cases) {
      expect(Object.hasOwn(result.backfilled.rows[c.name]!.config, 'builtin')).toBe(true);
    }

    for (const c of cases) {
      expect(result.normalized.rows[c.name]?.config).toEqual(c.config);
      expect(result.normalized.rows[c.name]).toMatchObject({ enabled: true, revision: 2 });
    }
    // A genuine built-in and a check without stray keys stay untouched.
    expect(result.normalized.rows['secret-scan']?.config).toEqual({ builtin: 'secret-scan' });
    expect(result.normalized.rows['secret-scan']?.revision).toBe(1);
    expect(result.normalized.rows.plain?.config).toEqual({ kind: 'judge', stage: 'output', policy: 'Plain policy.' });
    expect(result.normalized.rows.plain?.revision).toBe(1);
    // Idempotent: a second run finds nothing to normalize.
    expect(result.rerun).toEqual(result.normalized);
  });

  it('refuses the upgrade while any custom check remains, archived included, and deletes nothing', async () => {
    const orgId = (await createTestOrganization()).id;
    const custom = synth('guardrail');

    const result = await inRollback(async (tx) => {
      const attempt = () =>
        tx.savepoint((sp: Sql) => sp.unsafe(refuse())).then(
          () => null,
          (err: unknown) => err as { message?: string }
        );
      await tx`
        INSERT INTO workspace_guardrails (id, organization_id, name, config)
        VALUES (${synth('guardrail')}, ${orgId}, 'secret-scan', ${tx.json({ builtin: 'secret-scan' })})
      `;
      const builtinsOnly = await attempt();
      await tx`
        INSERT INTO workspace_guardrails (id, organization_id, name, config, archived_at)
        VALUES (${custom}, ${orgId}, 'no-refunds',
                ${tx.json({ kind: 'judge', stage: 'output', policy: 'Never promise refunds.' })}, now())
      `;
      const withArchivedCustom = await attempt();
      const [{ count }] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM workspace_guardrails WHERE organization_id = ${orgId}
      `;
      return { builtinsOnly, withArchivedCustom, count };
    });

    expect(result.builtinsOnly).toBeNull();
    expect(result.withArchivedCustom?.message).toContain(`${orgId}/no-refunds`);
    expect(result.withArchivedCustom?.message).toMatch(/Custom guardrail checks are retired/);
    expect(result.count).toBe(2);
  });
});

describe('loop policy cutover', () => {
  it('copies active checks to the same agent and enables editing in the same transaction', async () => {
    const orgId = (await createTestOrganization()).id;
    const agentId = synth('agent');
    await inRollback(async (tx) => {
      await insertAgent(tx, orgId, agentId, ['secret-scan', 'pii-scan', 'forbidden-tools'], []);
      await tx.unsafe(up());
      expect(await loopPolicyCutoverComplete(tx)).toBe(false);
      await tx`
        INSERT INTO workspace_guardrails (id, organization_id, name, config, enabled, archived_at)
        VALUES
          (${synth('guardrail')}, ${orgId}, 'archived', '{"builtin":"secret-scan"}', true, now()),
          (${synth('guardrail')}, ${orgId}, 'disabled', '{"builtin":"pii-scan"}', false, null)
      `;
      // These rows have a distinct subject so an accidental conversion is visible.
      await tx`
        INSERT INTO workspace_guardrail_subjects (guardrail_id, organization_id, principal_kind, principal_id)
        SELECT id, organization_id, 'agent', NULL FROM workspace_guardrails
        WHERE organization_id = ${orgId} AND name IN ('disabled', 'archived')
      `;

      await tx.unsafe(loadMigrationUpSection(resolveMigrationsDir(), POLICY_CUTOVER));
      expect(await loopPolicyCutoverComplete(tx)).toBe(true);
      const summaries = async (hook: 'message_in' | 'reply_out' | 'tool_call') => {
        const policies = await listEntityApprovalPolicies(orgId, 'connector_action', tx, hook);
        expect(policies.every(rule => rule.principalKind === 'agent' && rule.principalId === agentId &&
          rule.effects.execute === 'deny' && rule.kind === 'guardrail')).toBe(true);
        return policies.map(rule => ({ when: rule.condition, tools: rule.toolPatterns }));
      };
      expect(await summaries('message_in')).toEqual([
        { when: [{ scan: 'pii', field: '/text' }], tools: null },
      ]);
      expect(await summaries('reply_out')).toEqual(expect.arrayContaining([
        { when: [{ scan: 'secrets', field: '/text' }], tools: null },
        { when: [{ scan: 'pii', field: '/text' }], tools: null },
      ]));
      expect(await summaries('tool_call')).toEqual(expect.arrayContaining([
        { when: [{ scan: 'pii', field: '/arguments' }], tools: null },
        { when: null, tools: ['delete_branch', 'delete_repo', 'drop_table'] },
      ]));
    });
  });
});
