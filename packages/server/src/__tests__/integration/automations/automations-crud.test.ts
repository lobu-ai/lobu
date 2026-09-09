/**
 * Automation CRUD via the post-#348 SDK surface.
 *
 * Covers manage_automations create, read, update, and delete on automations
 * attached to an entity, plus access-control around the destructive actions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_CATALOG_TEMPLATES } from '../../../catalog/automation-templates';
import { executeReaction } from '../../../automations/reaction-executor';
import { createAutomationRun } from '../../../runs/queue-service';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('automation CRUD', () => {
  let owner: TestApiClient;
  let intruder: TestApiClient;
  let entityId: number;
  let agentId: string;
  let ownerOrgId: string;
  let ownerUserId: string;
  let otherOrgId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Automation Test Org' });
    const user = await createTestUser({ email: 'automation-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerOrgId = org.id;
    ownerUserId = user.id;
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    agentId = agent.agentId;

    const otherOrg = await createTestOrganization({
      name: 'Automation Other Org',
    });
    const otherUser = await createTestUser({ email: 'automation-other@test.com' });
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
    otherOrgId = otherOrg.id;
    otherUserId = otherUser.id;
    intruder = await TestApiClient.for({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Automation Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;
  });

  it('creates → reads back → updates → deletes an automation', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'lifecycle-automation',
      name: 'Lifecycle Automation',
      prompt: 'Track product launches.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const automationId = created.automation_id;
    expect(automationId).toBeDefined();
    // A new Automation starts covering arrivals from its lookback seed: the
    // mark is set and nothing has completed yet.
    const [createdProjection] = await getTestDb()<{
      next_window_start: string | Date | null;
      last_completed_window_start: string | Date | null;
    }[]>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${automationId}
    `;
    expect(createdProjection.next_window_start).not.toBeNull();
    expect(createdProjection.last_completed_window_start).toBeNull();

    const got = (await owner.automations.get({ automation_id: automationId })) as {
      automation?: { automation_name: string };
    };
    expect(got.automation?.automation_name).toBe('Lifecycle Automation');

    await owner.automations.update({
      automation_id: automationId,
      triggers: [{ kind: 'schedule', cron: '0 10 * * *' }],
    });
    const after = (await owner.automations.get({ automation_id: automationId })) as {
      automation?: { triggers: Array<{ kind: string; cron?: string }> };
    };
    expect(after.automation).not.toHaveProperty('schedule');
    expect(after.automation?.triggers).toMatchObject([
      { kind: 'schedule', cron: '0 10 * * *' },
    ]);

    const listed = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<Record<string, unknown>>;
    };
    const listedAutomation = listed.automations?.find((automation) => automation.automation_id === automationId);
    expect(listedAutomation).not.toHaveProperty('schedule');
    expect(listedAutomation?.triggers).toEqual(after.automation?.triggers);

    await owner.automations.delete({ automation_ids: [automationId] });
    const list = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<{ automation_id: string }>;
    };
    expect(list.automations?.some((w) => w.automation_id === automationId)).toBe(false);
  });

  // The calendar cursor reset whenever a cadence change moved the granularity,
  // because the stored coverage was expressed in periods that no longer existed.
  // The arrival mark is schedule-independent — cadence decides how often a run
  // fires, not what it covers — so a cadence change must leave it exactly where
  // it is. Resetting would silently drop every row stored since the last
  // completion, which is the failure this test now guards.
  it('leaves the arrival mark alone when an update changes the cadence', async () => {
    const sql = getTestDb();
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'projection-granularity-reset',
      prompt: 'Track each scheduled period.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    await sql`
      UPDATE automations
      SET next_window_start = '2025-01-01T00:00:00.000Z'::timestamptz,
          last_completed_window_start = '2025-01-08T00:00:00.000Z'::timestamptz
      WHERE id = ${created.automation_id}
    `;

    await owner.automations.update({
      automation_id: created.automation_id,
      triggers: [{ kind: 'schedule', cron: '0 9 * * 1' }],
    });

    const [projection] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }[]>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(new Date(projection.next_window_start).toISOString()).toBe(
      '2025-01-01T00:00:00.000Z'
    );
    expect(new Date(projection.last_completed_window_start as string).toISOString()).toBe(
      '2025-01-08T00:00:00.000Z'
    );

    // A new version with yet another cadence leaves it alone too.
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Track each daily scheduled period.',
      triggers: [{ kind: 'schedule', cron: '0 10 * * *' }],
    });
    const [afterVersion] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }[]>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(new Date(afterVersion.next_window_start).toISOString()).toBe(
      '2025-01-01T00:00:00.000Z'
    );
    expect(new Date(afterVersion.last_completed_window_start as string).toISOString()).toBe(
      '2025-01-08T00:00:00.000Z'
    );
  });

  it('resets an auto-pause only for a real cadence change', async () => {
    const sql = getTestDb();
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'schedule-auto-pause-reset-contract',
      prompt: 'Track the scheduled period.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const pauseAt = new Date('2026-08-27T12:00:00.000Z');
    await sql`
      UPDATE automations
      SET consecutive_scheduled_failures = 5,
          schedule_auto_paused_at = ${pauseAt}::timestamptz
      WHERE id = ${created.automation_id}
    `;

    // Resending byte-identical triggers may still re-anchor the legacy cursor,
    // but it is not operator recovery and must not clear the circuit breaker.
    await owner.automations.update({
      automation_id: created.automation_id,
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    });
    let [state] = await sql`
      SELECT next_run_at, consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(state.next_run_at).toBeNull();
    expect(Number(state.consecutive_scheduled_failures)).toBe(5);
    expect(new Date(state.schedule_auto_paused_at as string).toISOString()).toBe(
      pauseAt.toISOString(),
    );

    // A prompt-only version is definition history, not schedule recovery.
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Track the scheduled period with clearer instructions.',
    });
    [state] = await sql`
      SELECT next_run_at, consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(state.next_run_at).toBeNull();
    expect(Number(state.consecutive_scheduled_failures)).toBe(5);
    expect(new Date(state.schedule_auto_paused_at as string).toISOString()).toBe(
      pauseAt.toISOString(),
    );

    await owner.automations.update({
      automation_id: created.automation_id,
      triggers: [{ kind: 'schedule', cron: '0 10 * * *' }],
    });
    [state] = await sql`
      SELECT next_run_at, consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(state.next_run_at).not.toBeNull();
    expect(Number(state.consecutive_scheduled_failures)).toBe(0);
    expect(state.schedule_auto_paused_at).toBeNull();

    await sql`
      UPDATE automations
      SET consecutive_scheduled_failures = 5,
          schedule_auto_paused_at = ${pauseAt}::timestamptz
      WHERE id = ${created.automation_id}
    `;
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Track the rescheduled period.',
      triggers: [{ kind: 'schedule', cron: '0 11 * * *' }],
    });
    [state] = await sql`
      SELECT next_run_at, consecutive_scheduled_failures, schedule_auto_paused_at
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(state.next_run_at).not.toBeNull();
    expect(Number(state.consecutive_scheduled_failures)).toBe(0);
    expect(state.schedule_auto_paused_at).toBeNull();
  });

  it('creates an automation and its reaction contract atomically', async () => {
    const sql = getTestDb();
    const reaction = `export const input = { type: "object", properties: { merge_proposals: { type: "array" } }, required: ["merge_proposals"] }; export default async function () {}`;
    const created = (await owner.automations.create({
      slug: 'atomic-reaction-automation',
      name: 'Atomic Reaction Automation',
      prompt: 'Return merge proposals.',
      managed_agent_id: agentId,
      reaction_script: reaction,
    })) as { automation_id: string };

    const [row] = await sql<
      {
        reaction_script: string | null;
        reaction_script_compiled: string | null;
        reaction_input_schema: Record<string, unknown> | null;
      }[]
    >`
      SELECT reaction_script, reaction_script_compiled, reaction_input_schema
      FROM automations WHERE id = ${created.automation_id}
    `;
    expect(row?.reaction_script).toBe(reaction);
    expect(row?.reaction_script_compiled).toContain('merge_proposals');
    expect(row?.reaction_input_schema).toMatchObject({
      required: ['merge_proposals'],
    });
  });

  it('executes an installed merge reaction and queues exactly one pending, unapplied approval with automation/window attribution', async () => {
    const sql = getTestDb();

    // Three people form one exact-identity component (winner ↔ bridge by email,
    // bridge ↔ loser by phone), proving grouping does not depend on model output.
    const winner = await createTestEntity({
      name: 'Reaction Merge Winner',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    const bridge = await createTestEntity({
      name: 'Reaction Merge Bridge',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    const loser = await createTestEntity({
      name: 'Reaction Merge Loser',
      entity_type: 'person',
      organization_id: ownerOrgId,
      created_by: ownerUserId,
    });
    await sql`
      UPDATE entities
      SET metadata = CASE id
        WHEN ${winner.id} THEN ${sql.json({ email: 'shared@test.example', phone: '+44 7700 900001', handle: 'winner' })}
        WHEN ${bridge.id} THEN ${sql.json({ email: 'shared@test.example', phone: '+44 7700 900002' })}
        WHEN ${loser.id} THEN ${sql.json({ phone: '+44 7700 900002' })}
      END
      WHERE id IN (${winner.id}, ${bridge.id}, ${loser.id})
    `;
    await sql`
      UPDATE entity_types
      SET metadata_schema = ${sql.json({
        type: 'object',
        'x-lobu-resolution': {
          rules: [
            { fields: ['email'], normalizer: 'email', onMatch: 'review' },
            { fields: ['phone'], normalizer: 'phone', onMatch: 'review' },
          ],
        },
      })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
    `;

    const template = AUTOMATION_CATALOG_TEMPLATES.find((t) => t.id === 'duplicate-merge');
    if (!template) throw new Error('duplicate-merge automation template is missing');
    const reactionScript = String(template.detail.reaction_script);

    const created = (await owner.automations.create({
      slug: 'reaction-merge-exec-automation',
      name: 'Reaction Merge Exec Automation',
      prompt: 'Find and merge duplicate people.',
      managed_agent_id: agentId,
      sources: template.detail.sources,
      reaction_script: reactionScript,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    const [installed] = await sql<{ reaction_script_compiled: string | null }[]>`
      SELECT reaction_script_compiled FROM automations WHERE id = ${automationId}
    `;
    expect(installed?.reaction_script_compiled).toBeTruthy();

    const sourceRun = await createAutomationRun({
      organizationId: ownerOrgId,
      automationId,
      agentId,
      windowStart: new Date('2026-01-01').toISOString(),
      windowEnd: new Date('2026-01-02').toISOString(),
      dispatchSource: 'manual',
    }, sql);
    const res = await executeReaction({
      compiledScript: installed?.reaction_script_compiled as string,
      context: {
        extracted_data: {
          analysis_summary: 'The source contains one exact-identity component.',
          uncertain_groups: [],
        },
        entities: [],
        window: {
          run_id: sourceRun.runId,
          automation_id: automationId,
          window_start: new Date('2026-01-01').toISOString(),
          window_end: new Date('2026-01-02').toISOString(),
          content_analyzed: 1,
        },
        automation: {
          id: automationId,
          slug: 'reaction-merge-exec-automation',
          name: 'Reaction Merge Exec Automation',
          version: 1,
        },
        organization_id: ownerOrgId,
      } as never,
      env: {
        ...process.env,
        JWT_SECRET: 'test-jwt-secret-for-testing-only',
      } as Record<string, string | undefined>,
    });
    expect(res.error ?? null).toBeNull();
    expect(res.success).toBe(true);

    const pending = await sql<
      {
        automation_id: number | null;
        parent_run_id: number | null;
        approval_status: string;
        status: string;
      }[]
    >`
      SELECT automation_id, parent_run_id, approval_status, status
      FROM runs
      WHERE organization_id = ${ownerOrgId}
        AND run_type = 'internal'
        AND action_input->>'operation' = 'merge'
        AND action_input->>'winner_entity_id' = ${String(winner.id)}
    `;
    expect(pending).toHaveLength(1);
    expect(Number(pending[0].automation_id)).toBe(automationId);
    expect(Number(pending[0].parent_run_id)).toBe(sourceRun.runId);
    expect(pending[0].approval_status).toBe('pending');
    expect(pending[0].status).toBe('pending');

    const [pendingInput] = await sql<{ entity_ids: number[] }[]>`
      SELECT action_input->'entity_ids' AS entity_ids
      FROM runs
      WHERE organization_id = ${ownerOrgId}
        AND run_type = 'internal'
        AND action_input->>'operation' = 'merge'
        AND action_input->>'winner_entity_id' = ${String(winner.id)}
    `;
    expect(pendingInput.entity_ids.map(Number)).toEqual([bridge.id]);

    const duplicateRows = await sql<
      { id: number; merged_into: number | null; deleted_at: string | null }[]
    >`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE id IN (${bridge.id}, ${loser.id})
      ORDER BY id
    `;
    expect(duplicateRows.map((row) => Number(row.id))).toEqual(
      [bridge.id, loser.id].sort((a, b) => a - b)
    );
    expect(duplicateRows.every((row) => row.merged_into === null)).toBe(true);
    expect(duplicateRows.every((row) => row.deleted_at === null)).toBe(true);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('does not create an automation when its reaction fails compilation', async () => {
    await expect(
      owner.automations.create({
        slug: 'invalid-reaction-automation',
        name: 'Invalid Reaction Automation',
        prompt: 'Return merge proposals.',
        managed_agent_id: agentId,
        reaction_script: 'export default async function reaction() {',
      })
    ).rejects.toThrow();

    const [row] = await getTestDb()<{ id: number }[]>`
      SELECT id FROM automations WHERE slug = 'invalid-reaction-automation'
    `;
    expect(row).toBeUndefined();
  });

  it('concurrent creates of the same slug: one wins, every loser gets the coded 409 (not raw 23505)', async () => {
    // The slug precheck SELECT is not a lock, so concurrent replicas can all
    // pass it and race idx_automations_org_slug. Fire many at once: exactly one
    // wins, and every loser must surface the SAME coded 409 the sequential
    // precheck emits — not a raw Postgres "duplicate key value" 23505.
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        owner.automations.create({
          slug: 'race-automation',
          name: 'Race Automation',
          prompt: 'Track races.',
          managed_agent_id: agentId,
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      const e = r.reason as Error & { httpStatus?: number };
      expect(e.message).toMatch(/Automation with slug .*already exists/);
      expect(e.message).not.toMatch(/23505|duplicate key value/);
      expect(e.httpStatus).toBe(409);
    }
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ automation_id: string }>).value;
    await owner.automations.delete({ automation_ids: [winner.automation_id] });
  });

  it('concurrent creates of DISTINCT slugs all succeed with unique ids (no PK collision)', async () => {
    // Directly covers the moved id allocation: getNextNumericId now runs inside
    // the transaction so its advisory xact lock serializes. Pre-fix, concurrent
    // creates computed the same MAX(id)+1 on the pooled autocommit connection
    // and collided on the automation PK even with different slugs.
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        owner.automations.create({
          slug: `distinct-race-${i}`,
          name: `Distinct Race ${i}`,
          prompt: 'Track things.',
          managed_agent_id: agentId,
        })
      )
    );
    const ids = results.map((r) => (r as { automation_id: string }).automation_id);
    expect(ids.length).toBe(N);
    expect(new Set(ids).size).toBe(N); // all unique — no PK collision
    await owner.automations.delete({ automation_ids: ids });
  });

  it('concurrent group-locked writes on DISTINCT groups do not exhaust the pool (holder starvation)', async () => {
    // withAutomationGroupLock holders keep a main-pool connection for the whole
    // handler run. With N >= DB_POOL_MAX concurrent writes on DISTINCT groups
    // (nothing serializes them), the holders camp every slot and their own
    // handlers can't get a connection for reads/transactions — a permanent
    // pool-wide wedge. Regression guard for the dedicated lock pool: N
    // concurrent create_from_version calls, each from its OWN source automation
    // (own group), must all complete.
    const sql = getTestDb();

    const N = 6; // > the CI pool of DB_POOL_MAX=5
    const versionIds: number[] = [];
    const baseIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const base = (await owner.automations.create({
        entity_id: entityId,
        slug: `cfv-group-race-base-${i}`,
        name: `CFV Group Race Base ${i}`,
        prompt: 'Track things.',
        managed_agent_id: agentId,
        sources: [{ name: 'content', query: 'SELECT id FROM events' }],
      })) as { automation_id: string };
      baseIds.push(base.automation_id);
      const [row] = await sql<{ current_version_id: number }[]>`
        SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
      `;
      versionIds.push(Number(row?.current_version_id));
    }

    const targets: number[] = [];
    for (let i = 0; i < N; i++) {
      const e = (await owner.entities.create({
        type: 'company',
        name: `CFV Group Race Target ${i}`,
      })) as { entity: { id: number } };
      targets.push(e.entity.id);
    }

    // N truly-parallel group-locked writes: distinct groups, so the group lock
    // serializes nothing and all N handlers run concurrently.
    const results = await Promise.all(
      versionIds.map((vid, i) =>
        owner.automations.createFromVersion({
          version_id: vid,
          entity_ids: [targets[i]],
        })
      )
    );
    const createdIds = results.flatMap((r) =>
      (r as { created: Array<{ automation_id: string }> }).created.map((c) => c.automation_id)
    );
    expect(createdIds.length).toBe(N);
    expect(new Set(createdIds).size).toBe(N); // all unique — the cross-group id race
    await owner.automations.delete({ automation_ids: [...baseIds, ...createdIds] });
  });

  it('concurrent create_from_version fan-outs allocate unique ids (no PK collision)', async () => {
    // create_from_version allocated ids on the pooled autocommit connection —
    // the same anti-pattern the create handler had. Fire many concurrent
    // assignments to DISTINCT entities: each produces a distinct slug, so the
    // only way to fail is the automations PK colliding on a shared MAX(id)+1.
    const sql = getTestDb();

    const base = (await owner.automations.create({
      entity_id: entityId,
      slug: 'cfv-race-base',
      name: 'CFV Race Base',
      prompt: 'Track things.',
      managed_agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { automation_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
    `;
    const versionId = Number(row?.current_version_id);

    // Distinct target entities → distinct derived slugs, so no slug race.
    const N = 6;
    const targets: number[] = [];
    for (let i = 0; i < N; i++) {
      const e = (await owner.entities.create({
        type: 'company',
        name: `CFV Target ${i}`,
      })) as { entity: { id: number } };
      targets.push(e.entity.id);
    }

    const results = await Promise.all(
      targets.map((eid) =>
        owner.automations.createFromVersion({
          version_id: versionId,
          entity_ids: [eid],
        })
      )
    );
    const createdIds = results.flatMap((r) =>
      (r as { created: Array<{ automation_id: string }> }).created.map((c) => c.automation_id)
    );
    expect(createdIds.length).toBe(N);
    expect(new Set(createdIds).size).toBe(N); // all unique — no PK collision
    await owner.automations.delete({
      automation_ids: [base.automation_id, ...createdIds],
    });
  });

  it('concurrent create_from_version to the SAME entity: one wins, losers get a coded 409 (not raw 23505)', async () => {
    // A repeated assignment to the same entity produces the SAME derived slug.
    // The insert isn't pre-checked and isn't locked, so concurrent fan-outs race
    // idx_automations_org_slug. The loser must surface a coded 409, not a raw 23505,
    // and no partial fan-out may leak (single-entity here, but the transaction is
    // what guarantees all-or-nothing for multi-entity calls).
    const sql = getTestDb();

    const base = (await owner.automations.create({
      entity_id: entityId,
      slug: 'cfv-slug-race-base',
      name: 'CFV Slug Race Base',
      prompt: 'Track things.',
      managed_agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { automation_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
    `;
    const versionId = Number(row?.current_version_id);

    const target = (await owner.entities.create({
      type: 'company',
      name: 'CFV Slug Race Target',
    })) as { entity: { id: number } };

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        owner.automations.createFromVersion({
          version_id: versionId,
          entity_ids: [target.entity.id],
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      const e = r.reason as Error & { httpStatus?: number };
      expect(e.message).not.toMatch(/23505|duplicate key value/);
      expect(e.httpStatus).toBe(409);
    }
    const winnerIds = (
      fulfilled[0] as PromiseFulfilledResult<{
        created: Array<{ automation_id: string }>;
      }>
    ).value.created.map((c) => c.automation_id);
    await owner.automations.delete({
      automation_ids: [base.automation_id, ...winnerIds],
    });
  });

  it('multi-entity create_from_version is all-or-nothing: a mid-fan-out collision rolls back the earlier target too', async () => {
    // The fan-out runs in one transaction. If a LATER target's derived slug
    // already exists, the whole call must roll back — the EARLIER target in the
    // same call must not leak a half-created automation. This is the atomicity the
    // transaction wrapper exists for; without it the earlier insert would commit.
    const sql = getTestDb();

    const base = (await owner.automations.create({
      entity_id: entityId,
      slug: 'cfv-rollback-base',
      name: 'CFV Rollback Base',
      prompt: 'Track things.',
      managed_agent_id: agentId,
      sources: [{ name: 'content', query: 'SELECT id FROM events' }],
    })) as { automation_id: string };
    const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
    `;
    const versionId = Number(row?.current_version_id);

    const freshTarget = (await owner.entities.create({
      type: 'company',
      name: 'CFV Rollback Fresh',
    })) as { entity: { id: number } };
    const collidingTarget = (await owner.entities.create({
      type: 'company',
      name: 'CFV Rollback Colliding',
    })) as { entity: { id: number } };

    // Seed the colliding target so a SECOND assignment to it clashes on the
    // derived slug. This assignment succeeds on its own.
    const seed = (await owner.automations.createFromVersion({
      version_id: versionId,
      entity_ids: [collidingTarget.entity.id],
    })) as { created: Array<{ automation_id: string }> };
    expect(seed.created.length).toBe(1);

    // Now fan out to [fresh, colliding]. The colliding insert hits the seeded
    // slug → 23505 → coded 409, and the whole tx rolls back.
    await expect(
      owner.automations.createFromVersion({
        version_id: versionId,
        entity_ids: [freshTarget.entity.id, collidingTarget.entity.id],
      })
    ).rejects.toMatchObject({ httpStatus: 409 });

    // The earlier (fresh) target must have NO automation — the rollback took it.
    const leaked = await sql<{ id: number }[]>`
      SELECT id FROM automations
      WHERE organization_id = ${ownerOrgId} AND ${freshTarget.entity.id} = ANY(entity_ids)
    `;
    expect(leaked.length).toBe(0);

    await owner.automations.delete({
      automation_ids: [base.automation_id, ...seed.created.map((c) => c.automation_id)],
    });
  });

  it('creates an org-scoped automation without an inline extraction schema', async () => {
    const created = (await owner.automations.create({
      slug: 'org-scoped-summary-automation',
      name: 'Org Scoped Summary Automation',
      prompt: 'Summarize recent workspace activity.',
      triggers: [{ kind: 'schedule', cron: '0 12 * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const got = (await owner.automations.get({
      automation_id: created.automation_id,
    })) as {
      automation?: { entity_id?: number | null };
    };
    expect(got.automation?.entity_id ?? null).toBeNull();
  });

  it('derives sources[] from @-mention tokens in the prompt (no sources sent)', async () => {
    // The owletto composer serializes a picked reference into the prompt as an
    // inline `@[kind:id:label](path)` token and sends ONLY the raw prompt — the
    // backend derives sources[]. A `sql` token carries its query URL-encoded in
    // the path (`#sql=…`); we use it here because it resolves without any seeded
    // feed/connection (a raw-SQL source is a valid custom source).
    const query = 'SELECT id, payload_text FROM events ORDER BY occurred_at DESC';
    const sqlPath = `#sql=${encodeURIComponent(query).replace(
      /[()'!*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )}`;
    const prompt = `Summarize @[sql:recent:Recent events](${sqlPath}) each morning.`;

    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'prompt-derived-sources-automation',
      name: 'Prompt Derived Sources Automation',
      prompt,
      managed_agent_id: agentId,
      // NOTE: no `sources` — the backend must derive them from the prompt token.
    })) as { automation_id: string };

    const got = (await owner.automations.get({
      automation_id: created.automation_id,
    })) as {
      automation?: { sources?: Array<{ name: string; query: string }> | null };
    };
    expect(got.automation?.sources).toEqual([{ name: 'recent_events', query }]);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('a version bump does not re-derive sources from the prompt — the caller sends them', async () => {
    // The prompt is compiled skill text since #2331, so its `@`-tokens are the
    // skill's prose, not an authoring surface. Changing a source is explicit.
    const enc = (q: string) =>
      `#sql=${encodeURIComponent(q).replace(
        /[()'!*~]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )}`;
    const oldQuery = "SELECT id FROM events WHERE payload_type = 'a'";
    const newQuery = "SELECT id FROM events WHERE payload_type = 'b'";

    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'sql-edit-rederive-automation',
      name: 'SQL Edit Rederive Automation',
      prompt: `Watch @[sql:recent:Recent](${enc(oldQuery)}).`,
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const readSources = async () => {
      const got = (await owner.automations.get({
        automation_id: created.automation_id,
      })) as {
        automation?: { sources?: Array<{ name: string; query: string }> | null };
      };
      return got.automation?.sources ?? [];
    };

    // A new prompt naming a different query leaves the stored source alone.
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: `Watch @[sql:recent:Recent](${enc(newQuery)}).`,
      change_notes: 'edit sql',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query: oldQuery }]);

    // Sending `sources` replaces wholesale — no stranded old query, no
    // suffixed `recent_2`.
    await owner.automations.createVersion({
      automation_id: created.automation_id,
      sources: [{ name: 'recent', query: newQuery }],
      change_notes: 'repoint source',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query: newQuery }]);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('removing every @-mention chip does not clear sources — `sources: []` does', async () => {
    const enc = (q: string) =>
      `#sql=${encodeURIComponent(q).replace(
        /[()'!*~]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )}`;
    const query = 'SELECT id FROM events';
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'clear-sources-on-edit-automation',
      name: 'Clear Sources On Edit Automation',
      prompt: `Watch @[sql:recent:Recent](${enc(query)}).`,
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const readSources = async () => {
      const got = (await owner.automations.get({
        automation_id: created.automation_id,
      })) as {
        automation?: { sources?: Array<{ name: string; query: string }> | null };
      };
      return got.automation?.sources ?? [];
    };

    await owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Just watch everything, no specific source.',
      change_notes: 'remove chip',
    });
    expect(await readSources()).toEqual([{ name: 'recent', query }]);

    await owner.automations.createVersion({
      automation_id: created.automation_id,
      sources: [],
      change_notes: 'clear sources',
    });
    expect(await readSources()).toEqual([]);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('clears durable outputs when create_version receives outputs: null', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'clear-outputs-automation',
      name: 'Clear Outputs Automation',
      prompt: 'Extract companies.',
      managed_agent_id: agentId,
      outputs: {
        items: { entity: 'company', key: ['name'] },
      },
    })) as { automation_id: string };

    await owner.automations.createVersion({
      automation_id: created.automation_id,
      outputs: null,
      change_notes: 'switch to reaction-only output',
    });

    const sql = getTestDb();
    const [row] = await sql`
      SELECT wv.outputs AS version_outputs
      FROM automations w
      JOIN automation_versions wv ON wv.id = w.current_version_id
      WHERE w.id = ${created.automation_id}
    `;
    expect(row.version_outputs).toBeNull();

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('clears durable outputs when create_version receives serialized null', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'clear-serialized-outputs-automation',
      name: 'Clear Serialized Outputs Automation',
      prompt: 'Extract companies.',
      managed_agent_id: agentId,
      outputs: {
        items: { entity: 'company', key: ['name'] },
      },
    })) as { automation_id: string };

    await owner.automations.createVersion({
      automation_id: created.automation_id,
      outputs: 'null',
      change_notes: 'switch to reaction-only output',
    });

    const sql = getTestDb();
    const [row] = await sql`
      SELECT wv.outputs AS version_outputs
      FROM automations w
      JOIN automation_versions wv ON wv.id = w.current_version_id
      WHERE w.id = ${created.automation_id}
    `;
    expect(row.version_outputs).toBeNull();

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('round-trips execution_config through create → list → update', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'exec-config-automation',
      name: 'Exec Config Automation',
      prompt: 'Track things.',
      managed_agent_id: agentId,
      execution_config: {
        timeout_seconds: 1800,
        max_budget_usd: 2.5,
        model: 'opus',
        permission_mode: 'acceptEdits',
        effort: 'high',
      },
    })) as { automation_id: string };
    const automationId = created.automation_id;

    const findRow = (
      res: {
        automations?: Array<{
          automation_id: string;
          execution_config?: Record<string, unknown> | null;
        }>;
      },
      id: string
    ) => res.automations?.find((w) => String(w.automation_id) === String(id));

    const list = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<{
        automation_id: string;
        execution_config?: Record<string, unknown>;
      }>;
    };
    expect(findRow(list, automationId)?.execution_config).toEqual({
      timeout_seconds: 1800,
      max_budget_usd: 2.5,
      model: 'opus',
      permission_mode: 'acceptEdits',
      effort: 'high',
    });

    // Update replaces the whole jsonb; a partial object is stored verbatim.
    await owner.automations.update({
      automation_id: automationId,
      execution_config: { timeout_seconds: 300 },
    });
    const after = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<{
        automation_id: string;
        execution_config?: Record<string, unknown>;
      }>;
    };
    expect(findRow(after, automationId)?.execution_config).toEqual({
      timeout_seconds: 300,
    });

    // Passing null clears the saved config back to NULL/defaults.
    await owner.automations.update({
      automation_id: automationId,
      execution_config: null,
    });
    const cleared = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<{
        automation_id: string;
        execution_config?: Record<string, unknown> | null;
      }>;
    };
    expect(findRow(cleared, automationId)?.execution_config ?? null).toBeNull();

    await owner.automations.delete({ automation_ids: [automationId] });
  });

  it('leaves execution_config null when unset', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'no-exec-config-automation',
      name: 'No Exec Config',
      prompt: 'Track things.',
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const list = (await owner.automations.list({ entity_id: entityId })) as {
      automations?: Array<{
        automation_id: string;
        execution_config?: Record<string, unknown> | null;
      }>;
    };
    const row = list.automations?.find((w) => String(w.automation_id) === String(created.automation_id));
    expect(row).toBeDefined();
    expect(row?.execution_config ?? null).toBeNull();

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('rejects an invalid execution_config (type/range/unknown-key)', async () => {
    const base = {
      entity_id: entityId,
      name: 'Bad Exec',
      prompt: 'x',
      managed_agent_id: agentId,
    };
    // timeout_seconds below minimum
    await expect(
      owner.automations.create({
        ...base,
        slug: 'bad-1',
        execution_config: { timeout_seconds: 0 },
      })
    ).rejects.toThrow(/execution_config/i);
    // uncoercible type (non-numeric string where integer expected) — would
    // otherwise brick the Swift payload decode at run time. A numeric string
    // like '600' is coerced to 600 by boundary validation instead.
    await expect(
      owner.automations.create({
        ...base,
        slug: 'bad-2',
        execution_config: { timeout_seconds: 'abc' },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // unknown key (additionalProperties: false)
    await expect(
      owner.automations.create({
        ...base,
        slug: 'bad-3',
        execution_config: { bogus: true },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // above maximum
    await expect(
      owner.automations.create({
        ...base,
        slug: 'bad-4',
        execution_config: { timeout_seconds: 999_999 },
      })
    ).rejects.toThrow(/execution_config/i);
  });

  it('creates an org-scoped automation with no entity_id', async () => {
    const created = (await owner.automations.create({
      slug: 'org-scoped-automation',
      name: 'Org Scoped',
      prompt: 'Track org-wide signals.',
      managed_agent_id: agentId,
    })) as { automation_id: string };
    expect(created.automation_id).toBeDefined();

    const got = (await owner.automations.get({
      automation_id: created.automation_id,
    })) as {
      automation?: { entity_ids?: number[] };
    };
    expect(got.automation?.entity_ids ?? []).toEqual([]);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('rejects an org-scoped automation when there is no organization context', async () => {
    const noOrg = owner.withAuth({ organizationId: null });
    await expect(
      noOrg.automations.create({
        slug: 'no-org-automation',
        name: 'No Org',
        prompt: 'should fail',
        managed_agent_id: agentId,
      })
    ).rejects.toThrow('Select a workspace before making changes.');
  });

  it('blocks cross-org reads and writes for org-scoped automations', async () => {
    const created = (await owner.automations.create({
      slug: 'cross-org-org-scoped-automation',
      name: 'Cross Org Protected',
      prompt: 'Track org-wide signals.',
      managed_agent_id: agentId,
    })) as { automation_id: string };

    await expect(intruder.automations.get({ automation_id: created.automation_id })).rejects.toThrow(
      /access|organization/i
    );
    await expect(
      intruder.automations.update({
        automation_id: created.automation_id,
        triggers: [{ kind: 'schedule', cron: '0 11 * * *' }],
      })
    ).rejects.toThrow(/access|organization/i);
    await expect(intruder.automations.delete({ automation_ids: [created.automation_id] })).rejects.toThrow(
      /access|organization/i
    );

    const got = (await owner.automations.get({
      automation_id: created.automation_id,
    })) as {
      automation?: { triggers: unknown[] };
    };
    expect(got.automation?.triggers).toEqual([]);

    await owner.automations.delete({ automation_ids: [created.automation_id] });
  });

  it('blocks a member from deleting automations (admin-only)', async () => {
    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: 'protected-automation',
      name: 'Protected',
      prompt: 'guarded.',
      managed_agent_id: agentId,
    })) as { automation_id: string };

    const member = owner.withAuth({ memberRole: 'member' });
    await expect(member.automations.delete({ automation_ids: [created.automation_id] })).rejects.toThrow(
      /admin|owner|access/i
    );
  });

  // Issue #1060: a device pin (automations.device_worker_id) runs the automation's
  // agent CLI on the device owner's machine, so create/update must verify the
  // caller may target that device. The exhaustive role × ownership matrix is in
  // src/__tests__/unit/automation-device-access.test.ts; this proves the gate is
  // wired into the handlers end-to-end, including the raw `manage()` escape hatch.
  describe('device_worker_id ownership gate', () => {
    async function seedDevice(opts: {
      userId: string;
      organizationId: string | null;
      worker: string;
    }): Promise<string> {
      const sql = getTestDb();
      const rows = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
        VALUES (${opts.userId}, ${opts.worker}, 'macos', ${sql.json([])}, 'Seed Device', ${opts.organizationId})
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return String(rows[0].id);
    }

    it('lets an org owner pin a foreign device attached to their org', async () => {
      // A different user's device, but it lives in the owner's org → allowed
      // for an owner/admin role.
      const deviceId = await seedDevice({
        userId: otherUserId,
        organizationId: ownerOrgId,
        worker: 'dev-in-org',
      });
      const created = (await owner.automations.manage({
        action: 'create',
        entity_id: entityId,
        slug: 'device-pin-allowed',
        name: 'Device Pin Allowed',
        prompt: 'x',
        managed_agent_id: agentId,
        device_worker_id: deviceId,
      })) as { automation_id: string };
      expect(created.automation_id).toBeDefined();

      const got = (await owner.automations.get({
        automation_id: created.automation_id,
      })) as {
        automation?: { device_worker_id?: string | null };
      };
      expect(got.automation?.device_worker_id).toBe(deviceId);
      await owner.automations.delete({ automation_ids: [created.automation_id] });
    });

    it('rejects pinning to a device in another org (create)', async () => {
      // Device owned by another user AND attached to another org — even an owner
      // cannot pin it; this is the privilege-escalation case.
      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-org',
      });
      await expect(
        owner.automations.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-foreign',
          name: 'Device Pin Foreign',
          prompt: 'x',
          managed_agent_id: agentId,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);
    });

    it('rejects pinning to a nonexistent device (create)', async () => {
      await expect(
        owner.automations.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-missing',
          name: 'Device Pin Missing',
          prompt: 'x',
          managed_agent_id: agentId,
          device_worker_id: '00000000-0000-0000-0000-000000000000',
        })
      ).rejects.toThrow(/not found or not accessible/i);
    });

    it('rejects re-pinning an existing automation to a foreign-org device (update)', async () => {
      const created = (await owner.automations.create({
        entity_id: entityId,
        slug: 'device-pin-update',
        name: 'Device Pin Update',
        prompt: 'x',
        managed_agent_id: agentId,
      })) as { automation_id: string };

      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-update',
      });
      await expect(
        owner.automations.manage({
          action: 'update',
          automation_id: created.automation_id,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);

      await owner.automations.delete({ automation_ids: [created.automation_id] });
    });
  });

  describe('create_from_version executor cloning', () => {
    async function seedDevice(worker: string): Promise<string> {
      const sql = getTestDb();
      const rows = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
        VALUES (${ownerUserId}, ${worker}, 'macos', ${sql.json([])}, 'CFV Device', ${ownerOrgId})
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return String(rows[0].id);
    }

    it('clones a device-pinned automation and copies the device pin (no executor flip, no zombie)', async () => {
      const sql = getTestDb();
      const deviceId = await seedDevice('cfv-device-pin');
      const target = (await owner.entities.create({
        type: 'company',
        name: 'CFV Device Clone Target',
      })) as { entity: { id: number } };

      // Device-pinned (agent present for skills anchoring, device wins at
      // dispatch). The old clone path copied only managed_agent_id, silently dropping
      // device_worker_id + agent_kind — a clone that flipped from device
      // execution to server/agent dispatch. The clone must carry the pin.
      const base = (await owner.automations.manage({
        action: 'create',
        entity_id: entityId,
        slug: 'cfv-device-base',
        name: 'CFV Device Base',
        prompt: 'Track on device.',
        triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
        managed_agent_id: agentId,
        device_worker_id: deviceId,
        agent_kind: 'codex',
      })) as { automation_id: string };
      const [row] = await sql<{ current_version_id: number }[]>`
        SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
      `;
      const versionId = Number(row?.current_version_id);

      const res = (await owner.automations.createFromVersion({
        version_id: versionId,
        entity_ids: [target.entity.id],
      })) as { created: Array<{ automation_id: string }> };
      const cloneId = res.created[0].automation_id;

      const [clone] = await sql`
        SELECT managed_agent_id, device_worker_id, agent_kind,
               triggers::text AS triggers, next_window_start,
               last_completed_window_start
        FROM automations WHERE id = ${cloneId}
      `;
      expect(clone.managed_agent_id).toBe(agentId);
      expect(clone.device_worker_id).toBe(deviceId);
      expect(clone.agent_kind).toBe('codex');
      expect(clone.next_window_start).not.toBeNull();
      expect(clone.last_completed_window_start).toBeNull();
      // The schedule trigger is preserved and still resolves via the device pin.
      expect(clone.triggers).toMatch(/schedule/);

      await owner.automations.delete({
        automation_ids: [base.automation_id, cloneId],
      });
    });

    it('creates and clones an agentless manual-only automation (executor optional)', async () => {
      const sql = getTestDb();
      const target = (await owner.entities.create({
        type: 'company',
        name: 'CFV Manual Clone Target',
      })) as { entity: { id: number } };

      // No triggers → manual-only → executor optional. Both create and the
      // clone must accept an executor-less row (managed_agent_id nullable, no device
      // pin) — the manual activation stays pending for any MCP client.
      const base = (await owner.automations.create({
        entity_id: entityId,
        slug: 'cfv-manual-base',
        name: 'CFV Manual Base',
        prompt: 'Manual only.',
        sources: [{ name: 'content', query: 'SELECT id FROM events' }],
      })) as { automation_id: string; view_url?: string };

      // The Automation route is workspace-level, so an agentless Automation gets a
      // link like any other. Gating view_url on managed_agent_id left exactly the rows
      // this feature adds (device-pinned / manual-only) with no way for an MCP
      // agent to hand the user a link. Asserted on the path, not the origin:
      // a local packages/owletto/dist flips the builder to a relative URL.
      expect(base.view_url).toContain(`/automations/${base.automation_id}`);

      const [row] = await sql<{ current_version_id: number }[]>`
        SELECT current_version_id FROM automations WHERE id = ${base.automation_id}
      `;
      const versionId = Number(row?.current_version_id);

      const res = (await owner.automations.createFromVersion({
        version_id: versionId,
        entity_ids: [target.entity.id],
      })) as { created: Array<{ automation_id: string }> };
      const cloneId = res.created[0].automation_id;
      const [clone] = await sql`
        SELECT managed_agent_id, device_worker_id FROM automations WHERE id = ${cloneId}
      `;
      expect(clone.managed_agent_id).toBeNull();
      expect(clone.device_worker_id).toBeNull();

      // Same for the read paths an agent actually calls.
      const listed = (await owner.automations.manage({
        action: 'list',
        entity_id: entityId,
      })) as { automations?: Array<{ automation_id?: string; view_url?: string }> };
      const listedBase = (listed.automations ?? []).find(
        (b) => String(b.automation_id) === String(base.automation_id)
      );
      expect(listedBase?.view_url).toContain(`/automations/${base.automation_id}`);

      const fetched = (await owner.automations.get({
        automation_id: base.automation_id,
      })) as { view_url?: string };
      expect(fetched.view_url).toContain(`/automations/${base.automation_id}`);

      await owner.automations.delete({
        automation_ids: [base.automation_id, cloneId],
      });
    });

    it('list resolves organization_slug and view_url for an ORG-SCOPED automation (no entity)', async () => {
      // The regression this guards: list projected `e.organization_id` from a
      // LEFT JOIN on entities, so an Automation with empty entity_ids — the common
      // prod shape — carried a NULL org, which stranded the slug lookup and
      // dropped BOTH organization_slug and view_url. Every earlier view_url
      // assertion here passed only because it attached an entity_id.
      const base = (await owner.automations.manage({
        action: 'create',
        slug: 'org-scoped-url-check',
        name: 'Org Scoped URL Check',
        prompt: 'Org-scoped, no entity.',
        managed_agent_id: agentId,
      })) as { automation_id: string };

      const listed = (await owner.automations.manage({
        action: 'list',
      })) as {
        automations?: Array<{
          automation_id?: string;
          organization_slug?: string | null;
          view_url?: string;
          entity_id?: number | null;
        }>;
      };
      const row = (listed.automations ?? []).find(
        (b) => String(b.automation_id) === String(base.automation_id)
      );
      expect(row).toBeDefined();
      expect(row?.entity_id ?? null).toBeNull();
      expect(row?.organization_slug).toBeTruthy();
      expect(row?.view_url).toContain(`/automations/${base.automation_id}`);

      await owner.automations.delete({ automation_ids: [base.automation_id] });
    });
  });
});
