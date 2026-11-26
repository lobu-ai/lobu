/**
 * Workspace skills apply to principals through subject rows.
 * These tables are trust boundaries: a subject must never bind an item of
 * another workspace, name an agent outside its workspace, or outlive the agent
 * it names (agent ids are reusable, so a leftover row would apply to the next
 * agent created with that id). The constraints live in
 * 20261125120000_workspace_skills_and_guardrails.sql.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const synthId = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

async function insertSkill(orgId: string, name: string, id = synthId('skill')) {
  await getTestDb()`
    INSERT INTO workspace_skills (id, organization_id, name, description, content)
    VALUES (${id}, ${orgId}, ${name}, 'Synthetic skill', 'Do the synthetic thing.')
  `;
  return id;
}

async function pgError(run: () => Promise<unknown>): Promise<{ code?: string; constraint_name?: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code?: string; constraint_name?: string; message: string };
  }
  throw new Error('expected the statement to be rejected');
}

describe('workspace skill subjects', () => {
  let orgId: string;
  let otherOrgId: string;

  const insertSubject = (
    subjectOrgId: string,
    itemId: string,
    kind: 'agent' | 'app' | null,
    principalId: string | null,
  ) =>
    getTestDb().unsafe(
      `INSERT INTO workspace_skill_subjects (skill_id, organization_id, principal_kind, principal_id)
       VALUES ($1, $2, $3, $4)`,
      [itemId, subjectOrgId, kind, principalId],
    );

  const subjectRows = async (itemId: string) =>
    (await getTestDb().unsafe(
      `SELECT principal_kind, principal_id FROM workspace_skill_subjects
       WHERE skill_id = $1 ORDER BY principal_kind NULLS FIRST, principal_id NULLS FIRST`,
      [itemId],
    )) as unknown as { principal_kind: string | null; principal_id: string | null }[];

  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    orgId = (await createTestOrganization()).id;
    otherOrgId = (await createTestOrganization()).id;
  });

  it("rejects a subject that claims another workspace's item", async () => {
    const foreignItem = await insertSkill(otherOrgId, 'foreign-item');
    const err = await pgError(() => insertSubject(orgId, foreignItem, null, null));
    expect(err.code).toBe('23503');
    expect(err.message).toContain('workspace_skill_subjects_');
    // The same item is bindable from its own workspace.
    await insertSubject(otherOrgId, foreignItem, null, null);
    expect(await subjectRows(foreignItem)).toEqual([{ principal_kind: null, principal_id: null }]);
  });

  it('rejects an agent subject naming a missing agent or another workspace agent', async () => {
    const item = await insertSkill(orgId, 'agent-scoped');
    await createTestAgent({ organizationId: otherOrgId, agentId: 'other-org-agent' });

    for (const agentId of ['missing-agent', 'other-org-agent']) {
      const err = await pgError(() => insertSubject(orgId, item, 'agent', agentId));
      expect(err.code).toBe('23503');
      expect(err.constraint_name).toBe('workspace_skill_subjects_agent_fkey');
    }

    // A rebind to a missing agent is rejected the same way.
    await createTestAgent({ organizationId: orgId, agentId: 'own-agent' });
    await insertSubject(orgId, item, 'agent', 'own-agent');
    const rebind = await pgError(() =>
      getTestDb().unsafe(
        `UPDATE workspace_skill_subjects SET principal_id = 'missing-agent' WHERE skill_id = $1`,
        [item],
      ),
    );
    expect(rebind.code).toBe('23503');
    expect(rebind.constraint_name).toBe('workspace_skill_subjects_agent_fkey');

    // Everyone, any-agent and app subjects name no agent row.
    await insertSubject(orgId, item, null, null);
    await insertSubject(orgId, item, 'agent', null);
    await insertSubject(orgId, item, 'app', 'web:example.test');
    expect(await subjectRows(item)).toEqual([
      { principal_kind: null, principal_id: null },
      { principal_kind: 'agent', principal_id: null },
      { principal_kind: 'agent', principal_id: 'own-agent' },
      { principal_kind: 'app', principal_id: 'web:example.test' },
    ]);

    const idWithoutKind = await pgError(() => insertSubject(orgId, item, null, 'own-agent'));
    expect(idWithoutKind.code).toBe('23514');
    const duplicate = await pgError(() => insertSubject(orgId, item, 'agent', null));
    expect(duplicate.code).toBe('23505');
  });

  it("deleting an agent removes its subject rows, and recreating the id doesn't bring them back", async () => {
    const item = await insertSkill(orgId, 'cascade-check');
    await createTestAgent({ organizationId: orgId, agentId: 'reused-agent' });
    await createTestAgent({ organizationId: orgId, agentId: 'kept-agent' });
    // The same agent id in another workspace keeps its own rows.
    await createTestAgent({ organizationId: otherOrgId, agentId: 'reused-agent' });
    const otherItem = await insertSkill(otherOrgId, 'cascade-check');
    await insertSubject(orgId, item, 'agent', 'reused-agent');
    await insertSubject(orgId, item, 'agent', 'kept-agent');
    await insertSubject(orgId, item, 'agent', null);
    await insertSubject(otherOrgId, otherItem, 'agent', 'reused-agent');

    await getTestDb()`DELETE FROM agents WHERE organization_id = ${orgId} AND id = 'reused-agent'`;
    const remaining = [
      { principal_kind: 'agent', principal_id: null },
      { principal_kind: 'agent', principal_id: 'kept-agent' },
    ];
    expect(await subjectRows(item)).toEqual(remaining);
    expect(await subjectRows(otherItem)).toEqual([{ principal_kind: 'agent', principal_id: 'reused-agent' }]);

    await createTestAgent({ organizationId: orgId, agentId: 'reused-agent' });
    expect(await subjectRows(item)).toEqual(remaining);
  });

  it('an agent delete waits for an in-flight subject insert, then removes it', async () => {
    const sql = getTestDb();
    const item = await insertSkill(orgId, 'race-check');
    await createTestAgent({ organizationId: orgId, agentId: 'racing-agent' });

    // The delete runs on its own connection so it can wait on the insert's lock.
    const deleter = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
    try {
      // Open the connection first: the delete must be waiting on the lock, not on a connect.
      await deleter`SELECT 1`;
      const { deleting } = await sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO workspace_skill_subjects (skill_id, organization_id, principal_kind, principal_id)
           VALUES ($1, $2, 'agent', 'racing-agent')`,
          [item, orgId],
        );
        const deleting = deleter`DELETE FROM agents WHERE organization_id = ${orgId} AND id = 'racing-agent'`.execute();
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [row] = await tx<{ c: number }[]>`
            SELECT count(*)::int AS c FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
          `;
          if ((row?.c ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error('the agent delete never waited on the subject insert');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return { deleting };
      });
      await deleting;
    } finally {
      await deleter.end({ timeout: 5 });
    }
    expect(await subjectRows(item)).toEqual([]);
  }, 30_000);

  it('enforces the name grammar and keeps unarchived names unique', async () => {
    for (const bad of ['Upper', 'under_score', 'dot.name', '-lead', 'trail-', 'double--hyphen', '', 'a'.repeat(65)]) {
      const err = await pgError(() => insertSkill(orgId, bad));
      expect(err.code, bad).toBe('23514');
    }
    await insertSkill(orgId, 'a'.repeat(64));
    const first = await insertSkill(orgId, 'triage-2');

    const duplicate = await pgError(() => insertSkill(orgId, 'triage-2'));
    expect(duplicate.code).toBe('23505');
    // Another workspace may use the name, and archiving frees it.
    await insertSkill(otherOrgId, 'triage-2');
    await getTestDb().unsafe(`UPDATE workspace_skills SET archived_at = now() WHERE id = $1`, [first]);
    await insertSkill(orgId, 'triage-2');
  });
});

describe('workspace skill bodies', () => {
  let orgId: string;

  const insertSkill = (description: string, content: string) =>
    getTestDb()`
      INSERT INTO workspace_skills (id, organization_id, name, description, content)
      VALUES (${synthId('skill')}, ${orgId}, ${synthId('body')}, ${description}, ${content})
    `;

  beforeEach(async () => {
    orgId = (await createTestOrganization()).id;
  });

  it('requires a 1..1024 character description and a 1..64000 character body', async () => {
    for (const [description, content] of [
      ['', 'body'],
      ['d'.repeat(1025), 'body'],
      ['description', ''],
      ['description', 'c'.repeat(64_001)],
    ]) {
      const err = await pgError(() => insertSkill(description, content));
      expect(err.code).toBe('23514');
    }
    const nullDescription = await pgError(() =>
      getTestDb()`
        INSERT INTO workspace_skills (id, organization_id, name, content)
        VALUES (${synthId('skill')}, ${orgId}, 'no-description', 'body')
      `,
    );
    expect(nullDescription.code).toBe('23502');
    await insertSkill('d'.repeat(1024), 'c'.repeat(64_000));
  });
});
