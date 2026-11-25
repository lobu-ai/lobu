/**
 * Skills reader cutover (`20261125130000_workspace_skills_reader_cutover.sql`).
 *
 * The backfill moves every agent's `skills_config` into the workspace library
 * deterministically, and the policy step turns agent_config rules into
 * skill_config rules without weakening any of them. Each case replays the
 * migration's up section inside a transaction that is ROLLED BACK, so the
 * shared integration DB is not mutated.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { createTestOrganization } from '../../setup/test-fixtures';

const MIGRATION = '20261125130000_workspace_skills_reader_cutover.sql';

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

async function insertAgent(tx: Sql, orgId: string, agentId: string, skills: unknown) {
  await tx`
    INSERT INTO agents (id, organization_id, name, owner_platform, owner_user_id, skills_config)
    VALUES (${agentId}, ${orgId}, ${agentId}, 'lobu', 'synthetic-owner', ${tx.json(skills as never)})
  `;
}

const up = () => loadMigrationUpSection(resolveMigrationsDir(), MIGRATION);

describe('workspace skills reader cutover migration', () => {
  it('backfills a deterministic library: collisions, empty names, instructions-only bodies, enabled splits', async () => {
    const orgId = (await createTestOrganization()).id;
    // Agent ids sort alpha < beta < gamma, which fixes first-occurrence order.
    const [alpha, beta, gamma] = ['a', 'b', 'c'].map((p) => `${p}-${synth('agent')}`);

    const result = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, alpha, {
        skills: [
          { repo: 'x/y', name: 'Deploy Helper', description: 'Deploys', enabled: true, content: 'Deploy it.' },
          { repo: 'x/y', name: '--', enabled: true, content: '# Title line\nbody' },
          { repo: 'x/y', name: 'notes', enabled: true, instructions: 'Only instructions here' },
          { repo: 'x/y', name: 'deploy-helper-2', description: 'natural', enabled: true, content: 'natural two' },
        ],
      });
      await insertAgent(tx, orgId, beta, {
        skills: [
          { repo: 'x/y', name: 'notes', enabled: true, instructions: 'Only instructions here' },
          { repo: 'x/y', name: 'deploy_helper', description: 'Deploys', enabled: true, content: 'Deploy it differently.' },
          { repo: 'x/y', name: 'Deploy Helper', description: 'Deploys', enabled: false, content: 'Deploy it.' },
        ],
      });
      await insertAgent(tx, orgId, gamma, {
        skills: [{ repo: 'x/y', name: 'Deploy Helper', description: 'Deploys', enabled: true, content: 'Deploy it.' }],
      });

      await tx.unsafe(up());
      const readLibrary = () => tx<{
        id: string; name: string; description: string; content: string; enabled: boolean;
        sort_order: number; provenance: string | null; agents: string[];
      }>`
        SELECT s.id, s.name, s.description, s.content, s.enabled, s.sort_order, s.provenance,
               to_jsonb(array_agg(ss.principal_id ORDER BY ss.principal_id COLLATE "C")) AS agents
        FROM workspace_skills s
        JOIN workspace_skill_subjects ss ON ss.skill_id = s.id
        WHERE s.organization_id = ${orgId} AND ss.principal_kind = 'agent'
        GROUP BY s.id
        ORDER BY s.name COLLATE "C"
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
      'deploy-helper',
      'deploy-helper-2',
      'deploy-helper-3',
      'deploy-helper-4',
      'notes',
      'skill',
    ]);
    // One row per distinct tuple, shared by every agent that held it.
    expect(byName['deploy-helper']).toMatchObject({
      content: 'Deploy it.', enabled: true, description: 'Deploys', provenance: 'x/y', sort_order: 0,
      agents: [alpha, gamma],
    });
    // A natural name keeps its spelling; later collisions skip past it.
    expect(byName['deploy-helper-2']).toMatchObject({ content: 'natural two', agents: [alpha] });
    expect(byName['deploy-helper-3']).toMatchObject({ content: 'Deploy it differently.', agents: [beta] });
    // Disagreeing enabled flags split into separate rows.
    expect(byName['deploy-helper-4']).toMatchObject({ content: 'Deploy it.', enabled: false, agents: [beta] });
    // Instructions-only bodies become the content; the description falls back to the first line.
    expect(byName.notes).toMatchObject({
      content: 'Only instructions here', description: 'Only instructions here', agents: [alpha, beta],
    });
    // An empty normalized name becomes `skill`; the heading becomes the description.
    expect(byName.skill).toMatchObject({ content: '# Title line\nbody', description: 'Title line', agents: [alpha] });
    // Ids are a function of (org, name), so a replay on another database mints the same ids.
    for (const row of result.first) expect(row.id).toMatch(/^skill_[0-9a-f]{32}$/);
  });

  it('aborts with every offender instead of dropping a skill', async () => {
    const orgId = (await createTestOrganization()).id;
    const agentId = synth('agent');
    const error = await inRollback(async (tx) => {
      await insertAgent(tx, orgId, agentId, {
        skills: [
          { name: 'empty', enabled: true, content: '   ' },
          'not-an-object',
        ],
      });
      try {
        await tx.unsafe(up());
      } catch (err) {
        return err as { code?: string; message: string };
      }
      return null;
    }).catch((err) => err as { code?: string; message: string });

    expect(error?.code).toBe('23514');
    expect(error?.message).toContain('workspace skill backfill aborted');
    expect(error?.message).toContain(`agent=${agentId} skills[0] has neither content nor instructions`);
    expect(error?.message).toContain(`agent=${agentId} skills[1] is not an object`);
  });

  it('turns agent_config rules into skill_config rules that are never weaker', async () => {
    const orgId = (await createTestOrganization()).id;
    const [alpha, beta, gamma] = ['a', 'b', 'c'].map((p) => `${p}-${synth('agent')}`);

    const rules = await inRollback(async (tx) => {
      for (const id of [alpha, beta, gamma]) await insertAgent(tx, orgId, id, { skills: [] });
      const insertRule = async (principal: string | null, target: string | null, effects: Record<string, string>) => {
        const [row] = await tx<{ id: string }>`
          INSERT INTO write_approval_policies
            (organization_id, resource_class, principal_kind, principal_id, target_agent_id, kind)
          VALUES (${orgId}, 'agent_config', ${principal === null ? null : 'agent'}, ${principal}, ${target}, 'grant')
          RETURNING id
        `;
        for (const [action, effect] of Object.entries(effects)) {
          await tx`INSERT INTO write_policy_action_effects (policy_id, action, effect) VALUES (${row.id}, ${action}, ${effect})`;
        }
      };
      // Two rules for alpha that target different agents collide once the target drops.
      await insertRule(alpha, beta, { update: 'approval' });
      await insertRule(alpha, gamma, { update: 'deny', read: 'deny' });
      // A workspace-wide rule that only sets delete.
      await insertRule(null, null, { delete: 'auto' });

      await tx.unsafe(up());
      return tx<{ principal_id: string | null; target_agent_id: string | null; action: string; effect: string }>`
        SELECT p.principal_id, p.target_agent_id, e.action, e.effect
        FROM write_approval_policies p
        JOIN write_policy_action_effects e ON e.policy_id = p.id
        WHERE p.organization_id = ${orgId} AND p.resource_class = 'skill_config'
        ORDER BY p.principal_id NULLS FIRST, e.action
      `;
    });

    expect(rules).toEqual([
      // Sparse stays sparse: only delete was set.
      { principal_id: null, target_agent_id: null, action: 'delete', effect: 'auto' },
      // The merged alpha rule takes the most restrictive effect per action;
      // create and delete inherit the stricter of themselves and update.
      { principal_id: alpha, target_agent_id: null, action: 'create', effect: 'deny' },
      { principal_id: alpha, target_agent_id: null, action: 'delete', effect: 'deny' },
      { principal_id: alpha, target_agent_id: null, action: 'read', effect: 'deny' },
      { principal_id: alpha, target_agent_id: null, action: 'update', effect: 'deny' },
    ]);
  });
});
