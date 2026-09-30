/**
 * A script executor handles its whole arrival window inside one sandbox run
 * with a fixed wall-clock budget, and the mark only advances on success. An
 * unbounded window after an outage would time out on every retry and never
 * recover, so script windows target 200 stored arrivals. Timestamp ties stay
 * together, and the next window starts where the previous one stopped.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { materializeDueAutomationRuns } from '../../../automations/automation';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const WINDOW_START = '2026-01-01T00:00:00.000Z';
const WINDOW_END = '2026-01-01T06:00:00.000Z';

async function seedAutomation(executor: 'script' | 'agent', skipIfUnchanged = false) {
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
    ...(skipIfUnchanged ? { sources: [{ name: 'empty', query: 'SELECT id FROM events WHERE false' }] } : {}),
    ...(executor === 'script'
      ? { execution_config: { executor: { kind: 'script', source: 'export default async () => ({});' } } }
      : { prompt: 'Summarize the window.' }),
  } as never)) as { automation_id: string };
  return { orgId: workspace.org.id, agentId: agent.agentId, automationId: Number(created.automation_id) };
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

describe('script executor window bound', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
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
});
