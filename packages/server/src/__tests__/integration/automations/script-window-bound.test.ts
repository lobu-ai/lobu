/**
 * A script executor handles its whole arrival window inside one sandbox run
 * with a fixed wall-clock budget, and the mark only advances on success. An
 * unbounded window after an outage would time out on every retry and never
 * recover, so script windows target 200 stored arrivals. Timestamp ties stay
 * together, and the next window starts where the previous one stopped.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AutomationSource } from '@lobu/core/contracts/tools/manage-automations';
import { dispatchPendingAutomationRuns, materializeDueAutomationRuns } from '../../../automations/automation';
import { runAutomationScriptTask } from '../../../automations/script-task';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const WINDOW_START = '2026-01-01T00:00:00.000Z';
const WINDOW_END = '2026-01-01T06:00:00.000Z';

async function seedAutomation(executor: 'script' | 'agent', skipIfUnchanged = false, sources?: AutomationSource[]) {
  const workspace = await TestWorkspace.create({ name: `Window Bound ${executor}` });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: `window-bound-${executor}`,
    name: 'Window Bound Owner',
  });
  const created = (await workspace.owner.automations.create({
    slug: `window-bound-${executor}`,
    name: 'Window Bound',
    managed_agent_id: agent.agentId,
    triggers: [{ kind: 'schedule', cron: '*/5 * * * *', execution: 'window', skip_if_unchanged: skipIfUnchanged }],
    ...(sources ? { sources } : skipIfUnchanged ? { sources: [{ name: 'empty', query: 'SELECT id FROM events WHERE false' }] } : {}),
    ...(executor === 'script'
      ? { execution_config: { executor: { kind: 'script', source: 'export default async () => ({});' } } }
      : { prompt: 'Summarize the window.' }),
  } as never)) as { automation_id: string };
  return { workspace, orgId: workspace.org.id, agentId: agent.agentId, automationId: Number(created.automation_id) };
}

/** `count` live events, one per second from the window start. */
async function seedArrivals(orgId: string, count: number): Promise<Date[]> {
  const stamps: Date[] = [];
  for (let i = 0; i < count; i++) {
    const createdAt = new Date(Date.parse(WINDOW_START) + (i + 1) * 1000);
    await createTestEvent({ organization_id: orgId, content: `arrival ${i}`, created_at: createdAt });
    stamps.push(createdAt);
  }
  return stamps;
}

async function claimedWindow(runId: number): Promise<{ start: string; end: string }> {
  const [row] = await getTestDb()<{ start: string; end: string }>`
    SELECT approved_input->>'window_start' AS start, approved_input->>'window_end' AS "end"
    FROM runs WHERE id = ${runId}
  `;
  return row;
}

async function arrivalsIn(orgId: string, window: { start: string; end: string }): Promise<number> {
  const [row] = await getTestDb()<{ n: number }>`
    SELECT count(*)::int AS n FROM events
    WHERE organization_id = ${orgId} AND superseded_by IS NULL
      AND created_at >= ${window.start}::timestamptz AND created_at < ${window.end}::timestamptz
  `;
  return row.n;
}

const TEST_ENV = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL } as Env;

/** Dispatch a created script run and execute its task to completion. */
async function completeScriptRun(orgId: string, automationId: number, runId: number): Promise<void> {
  expect(await dispatchPendingAutomationRuns({ runIds: [runId] })).toMatchObject({ dispatched: 1, failed: 0 });
  await executeScriptTask(orgId, automationId, runId);
}

/** Execute an already-dispatched script run's task to completion. */
async function executeScriptTask(orgId: string, automationId: number, runId: number): Promise<void> {
  const sql = getTestDb();
  const [task] = await sql`SELECT id FROM runs WHERE parent_run_id = ${runId} AND action_key = 'automation-script'`;
  const taskRunId = Number(task!.id);
  await sql`UPDATE runs SET status = 'claimed', claimed_by = 'script-fixture', claimed_at = now() WHERE id = ${taskRunId}`;
  await runAutomationScriptTask({ organizationId: orgId, automationId, sourceRunId: runId }, TEST_ENV, taskRunId);
  const [run] = await sql`SELECT status FROM runs WHERE id = ${runId}`;
  expect(run!.status).toBe('completed');
}

async function scheduleState(automationId: number): Promise<{ next_window_start: string; due: boolean }> {
  const [row] = await getTestDb()<{ next_window_start: string | Date; due: boolean }>`
    SELECT next_window_start, next_run_at <= current_timestamp AS due FROM automations WHERE id = ${automationId}
  `;
  return { next_window_start: new Date(row.next_window_start).toISOString(), due: row.due };
}

describe('script executor window bound', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each(['scheduled', 'manual'] as const)('keeps context-only %s scripts on their intended window without a backlog chain', async (dispatchSource) => {
    const seed = await seedAutomation('script', false, [
      { name: 'state', query: 'SELECT 1 AS id', context: true },
    ]);
    await seedArrivals(seed.orgId, 250);
    const sql = getTestDb();
    await sql`UPDATE automations SET next_window_start = ${WINDOW_START}::timestamptz WHERE id = ${seed.automationId}`;
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource,
      sourceFingerprint: 'current-state-fingerprint',
      ...(dispatchSource === 'scheduled' ? { expectedWindowStart: WINDOW_START } : {}),
    });
    expect(await claimedWindow(run.runId)).toEqual({ start: WINDOW_START, end: WINDOW_END });
    const [queued] = await sql`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(queued.approved_input.source_fingerprint).toBe('current-state-fingerprint');
    expect(queued.approved_input.window_truncated).toBeUndefined();

    await completeScriptRun(seed.orgId, seed.automationId, run.runId);

    expect(await scheduleState(seed.automationId)).toEqual({ next_window_start: WINDOW_END, due: false });
    const runs = await sql`SELECT id FROM runs WHERE automation_id = ${seed.automationId} AND run_type = 'automation'`;
    expect(runs.map((row) => Number(row.id))).toEqual([run.runId]);
    const tasks = await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
    expect(tasks).toHaveLength(1);
    expect(await materializeDueAutomationRuns(TEST_ENV)).toMatchObject({ runsCreated: 0 });
  });

  it('keeps mixed context and event sources bounded', async () => {
    const seed = await seedAutomation('script', false, [
      { name: 'state', query: 'SELECT 1 AS id', context: true },
      { name: 'arrivals', query: 'SELECT id FROM events' },
    ]);
    const stamps = await seedArrivals(seed.orgId, 250);
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
    });
    expect((await claimedWindow(run.runId)).end).toBe(stamps[200].toISOString());
  });

  it('keeps an existing run pinned while a new version switches from context to events', async () => {
    const seed = await seedAutomation('script', false, [
      { name: 'state', query: 'SELECT 1 AS id', context: true },
    ]);
    const stamps = await seedArrivals(seed.orgId, 250);
    const params = {
      organizationId: seed.orgId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled' as const,
    };
    const first = await createAutomationRun(params);
    const sql = getTestDb();
    const [before] = await sql`SELECT approved_input FROM runs WHERE id = ${first.runId}`;
    await seed.workspace.owner.automations.createVersion({
      automation_id: String(seed.automationId),
      sources: [{ name: 'arrivals', query: 'SELECT id FROM events' }],
    });
    expect(await createAutomationRun(params)).toMatchObject({ runId: first.runId, created: false });
    const [after] = await sql`SELECT approved_input FROM runs WHERE id = ${first.runId}`;
    expect(after.approved_input).toEqual(before.approved_input);
    expect((await claimedWindow(first.runId)).end).toBe(WINDOW_END);

    // Replay the same arrival range under the new version through the manual
    // lane so its own idempotency key is distinct from the scheduled run.
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${first.runId}`;
    const next = await createAutomationRun({ ...params, dispatchSource: 'manual' });
    const [nextRow] = await sql`SELECT approved_input FROM runs WHERE id = ${next.runId}`;
    expect(nextRow.approved_input.version_id).not.toBe(before.approved_input.version_id);
    expect((await claimedWindow(next.runId)).end).toBe(stamps[200].toISOString());
  });

  it('uses normalized entity-reference context without requiring the custom-SQL flag', async () => {
    const seed = await seedAutomation('script');
    await seed.workspace.owner.entity_schema.createType({
      slug: 'synthetic-state',
      name: 'Synthetic state',
      metadata_schema: { type: 'object', properties: {} },
    });
    await seed.workspace.owner.automations.createVersion({
      automation_id: String(seed.automationId),
      sources: [{ name: 'state', query: '@entity:synthetic-state' }],
    });
    await seedArrivals(seed.orgId, 250);
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
    });
    expect((await claimedWindow(run.runId)).end).toBe(WINDOW_END);
  });

  it.each(['scheduled', 'manual'] as const)('bounds %s windows and leaves the rest to the next run', async (dispatchSource) => {
    const seed = await seedAutomation('script');
    const stamps = await seedArrivals(seed.orgId, 250);

    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource,
      sourceFingerprint: 'full-window-fingerprint',
    });
    const window = await claimedWindow(run.runId);

    expect(window.start).toBe(WINDOW_START);
    // Ends at the 201st arrival, so exactly 200 fall inside [start, end).
    expect(window.end).toBe(stamps[200].toISOString());
    expect(await arrivalsIn(seed.orgId, window)).toBe(200);
    const [row] = await getTestDb()`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(row.approved_input.source_fingerprint).toBeUndefined();

    await getTestDb()`UPDATE runs SET status = 'completed' WHERE id = ${run.runId}`;
    const next = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: window.end,
      windowEnd: WINDOW_END,
      dispatchSource,
    });
    expect(await arrivalsIn(seed.orgId, await claimedWindow(next.runId))).toBe(50);
  });

  it.each([0, 150, 200])('keeps the whole window and fingerprint for %i arrivals', async (count) => {
    const seed = await seedAutomation('script');
    await seedArrivals(seed.orgId, count);

    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
      sourceFingerprint: 'full-window-fingerprint',
    });

    expect((await claimedWindow(run.runId)).end).toBe(WINDOW_END);
    const [row] = await getTestDb()`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(row.approved_input.source_fingerprint).toBe('full-window-fingerprint');
  });

  it.each(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000123Z'])(
    'consumes only the first millisecond when a burst at %s exceeds the target', async (burstAt) => {
      const seed = await seedAutomation('script');
      await getTestDb()`
        INSERT INTO events (organization_id, origin_id, payload_type, payload_text, semantic_type, created_at, occurred_at)
        SELECT ${seed.orgId}, 'burst-' || n, 'text', 'burst arrival', 'content',
          ${burstAt}::timestamptz, ${burstAt}::timestamptz
        FROM generate_series(1, 250) n
      `;
      await seedArrivals(seed.orgId, 10);
      const run = await createAutomationRun({
        organizationId: seed.orgId,
        automationId: seed.automationId,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        dispatchSource: 'scheduled',
      });
      const window = await claimedWindow(run.runId);
      expect(window.end).toBe('2026-01-01T00:00:00.001Z');
      expect(await arrivalsIn(seed.orgId, window)).toBe(250);
    }
  );

  it('recovers a unique conflict after the active-run lookup misses a concurrent insert', async () => {
    const seed = await seedAutomation('script');
    await seedArrivals(seed.orgId, 250);
    const params = {
      organizationId: seed.orgId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled' as const,
    };
    const first = await createAutomationRun(params);
    const sql = getTestDb();
    // A running winner isolates the idempotency index from the pending-only index.
    await sql`UPDATE runs SET status = 'running' WHERE id = ${first.runId}`;
    const staleLookup = new Proxy(sql, {
      apply(target, thisArg, args) {
        if (args[0].join(' ').includes('ORDER BY created_at ASC')) return Promise.resolve([]);
        return Reflect.apply(target, thisArg, args);
      },
    }) as unknown as DbClient;
    await expect(createAutomationRun(params, staleLookup)).resolves.toEqual({
      runId: first.runId, status: 'running', created: false,
    });
  });

  it('books only the recorded window when the scheduler skips empty sources', async () => {
    const seed = await seedAutomation('script', true);
    const stamps = await seedArrivals(seed.orgId, 250);
    const sql = getTestDb();
    await sql`
      UPDATE automations SET next_window_start = ${WINDOW_START}::timestamptz,
        next_run_at = now() - interval '1 hour'
      WHERE id = ${seed.automationId}
    `;
    await materializeDueAutomationRuns({} as Env);
    const [run] = await sql`SELECT id, status FROM runs WHERE automation_id = ${seed.automationId} AND run_type = 'automation'`;
    expect(run.status).toBe('completed');
    const window = await claimedWindow(Number(run.id));
    expect(window.end).toBe(stamps[200].toISOString());
    const [automation] = await sql`SELECT next_window_start FROM automations WHERE id = ${seed.automationId}`;
    expect(new Date(automation.next_window_start).toISOString()).toBe(window.end);
  });

  it('leaves agent windows unbounded: the model reads them in pages', async () => {
    const seed = await seedAutomation('agent');
    await seedArrivals(seed.orgId, 250);

    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
    });

    expect((await claimedWindow(run.runId)).end).toBe(WINDOW_END);
  });

  it.each(['scheduled', 'manual'] as const)('starts the next window as soon as a truncated %s window completes', async (dispatchSource) => {
    const seed = await seedAutomation('script');
    const stamps = await seedArrivals(seed.orgId, 250);
    await getTestDb()`UPDATE automations SET next_window_start = ${WINDOW_START}::timestamptz WHERE id = ${seed.automationId}`;
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource,
    });

    await completeScriptRun(seed.orgId, seed.automationId, run.runId);

    // The mark moved to where the window stopped, and the remainder is already
    // dispatched rather than waiting for the next scheduler tick.
    expect((await scheduleState(seed.automationId)).next_window_start).toBe(stamps[200].toISOString());
    const [next] = await getTestDb()`
      SELECT id FROM runs WHERE automation_id = ${seed.automationId}
        AND run_type = 'automation' AND status = 'running'
    `;
    expect(next).toBeDefined();
    const nextWindow = await claimedWindow(Number(next.id));
    expect(nextWindow.start).toBe(stamps[200].toISOString());
    // Count the seeded backlog separately from recent configuration events.
    expect(await arrivalsIn(seed.orgId, { start: nextWindow.start, end: WINDOW_END })).toBe(50);
    await executeScriptTask(seed.orgId, seed.automationId, Number(next.id));
    expect(await scheduleState(seed.automationId)).toEqual({ next_window_start: nextWindow.end, due: false });
    expect(await materializeDueAutomationRuns(TEST_ENV)).toMatchObject({ runsCreated: 0 });
  });

  it('does not dispatch another Automation after the current one is archived', async () => {
    const seed = await seedAutomation('script');
    await seedArrivals(seed.orgId, 250);
    const sql = getTestDb();
    await sql`UPDATE automations SET next_window_start = ${WINDOW_START}::timestamptz WHERE id = ${seed.automationId}`;
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
    });
    expect(await dispatchPendingAutomationRuns({ runIds: [run.runId] })).toMatchObject({ dispatched: 1, failed: 0 });
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${seed.automationId}`;

    const other = await seedAutomation('script');
    const pending = await createAutomationRun({
      organizationId: other.orgId,
      agentId: other.agentId,
      automationId: other.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'manual',
    });

    await executeScriptTask(seed.orgId, seed.automationId, run.runId);

    const [untouched] = await sql`SELECT status FROM runs WHERE id = ${pending.runId}`;
    expect(untouched.status).toBe('pending');
    const next = await sql`
      SELECT id FROM runs WHERE automation_id = ${seed.automationId}
        AND run_type = 'automation' AND id <> ${run.runId}
    `;
    expect(next).toHaveLength(0);
  });

  it.each(['historical replay', 'later retry boundary'] as const)(
    'does not expedite a truncated window with a %s',
    async (scenario) => {
      const seed = await seedAutomation('script');
      const stamps = await seedArrivals(seed.orgId, 250);
      const mark = scenario === 'historical replay' ? WINDOW_END : WINDOW_START;
      await getTestDb()`
        UPDATE automations SET next_window_start = ${mark}::timestamptz,
          next_run_at = CASE WHEN ${scenario === 'later retry boundary'}
            THEN now() + interval '1 day' ELSE next_run_at END
        WHERE id = ${seed.automationId}
      `;
      const [before] = await getTestDb()`SELECT next_run_at FROM automations WHERE id = ${seed.automationId}`;
      const run = await createAutomationRun({
        organizationId: seed.orgId,
        agentId: seed.agentId,
        automationId: seed.automationId,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        dispatchSource: 'manual',
      });

      await completeScriptRun(seed.orgId, seed.automationId, run.runId);

      expect(await scheduleState(seed.automationId)).toEqual({
        next_window_start: scenario === 'historical replay' ? WINDOW_END : stamps[200].toISOString(),
        due: false,
      });
      const [after] = await getTestDb()`SELECT next_run_at FROM automations WHERE id = ${seed.automationId}`;
      expect(new Date(after.next_run_at).getTime()).toBeGreaterThanOrEqual(new Date(before.next_run_at).getTime());
      const started = await getTestDb()`
        SELECT id FROM runs WHERE automation_id = ${seed.automationId}
          AND run_type = 'automation' AND id <> ${run.runId}
      `;
      expect(started).toHaveLength(0);
    }
  );

  it('keeps the schedule cadence after a window that was not truncated', async () => {
    const seed = await seedAutomation('script');
    await seedArrivals(seed.orgId, 50);
    await getTestDb()`UPDATE automations SET next_window_start = ${WINDOW_START}::timestamptz WHERE id = ${seed.automationId}`;
    const run = await createAutomationRun({
      organizationId: seed.orgId,
      agentId: seed.agentId,
      automationId: seed.automationId,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      dispatchSource: 'scheduled',
    });

    await completeScriptRun(seed.orgId, seed.automationId, run.runId);

    expect(await scheduleState(seed.automationId)).toEqual({ next_window_start: WINDOW_END, due: false });
  });
});
