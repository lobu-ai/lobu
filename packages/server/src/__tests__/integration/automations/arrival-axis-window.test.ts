/**
 * Automation windows book progress on the ARRIVAL axis (`events.created_at`),
 * not on when things happened (`occurred_at`).
 *
 * Three properties, each of which the occurrence-axis design could not hold:
 *
 *  1. A row Lobu stored late (a resync, an archive import, a calendar item
 *     written days after it began) is still delivered — it arrives after the
 *     mark, so the next run sees it. Under occurrence-axis windows the same row
 *     landed inside an already-completed period and was never read.
 *  2. A failed run's range is reclaimed: the mark only moves on completion.
 *  3. No range is handed out twice: a completed range moves the mark to its
 *     end, and the next claim starts exactly there.
 *
 * The frontier is `now() − AUTOMATION_ARRIVAL_SETTLE_MS`, capped at the oldest
 * open transaction. Both bounds come from the database clock, so an
 * uncommitted writer's rows stay in a later range.
 *
 * A window never closes over a row whose writer has not committed yet.
 * `events.created_at` is `DEFAULT now()`: the writer's TRANSACTION START. The
 * row only becomes visible at commit. A window whose end passes `created_at`
 * while the writer is still open would complete without the row, the mark would
 * move past it, and every later window would start after it — the row skipped
 * for good, with no error anywhere. The settle budget only covers writers that
 * commit inside it; the open-writer suite runs with the budget collapsed to
 * zero (`vitest.config.ts`), so a writer held open across a claim is exactly
 * the production case of an event insert inside a transaction open longer
 * than 60s.
 *
 * Automation-mode `unprocessed_ranges` is a bounded histogram on the same
 * axis: monthly buckets scan `created_at` and are bounded to the
 * recent-arrival horizon, so events that arrived more than 90 days ago
 * contribute no month and a backfilled event (old `occurred_at`, recent
 * `created_at`) counts in its arrival month.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeDueAutomationRuns } from '../../../automations/automation';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import { insertEvent } from '../../../utils/insert-event';
import { automationArrivalSettleMs } from '../../../utils/window-utils';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedOwnerContext,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type ClaimResult = {
  run_id: number;
  context: {
    content: Array<{ id: number }>;
    window_start: string;
    window_end: string;
    window_token: string;
  };
};

describe('Automation windows on the arrival axis', () => {
  let sql: DbClient;
  let orgId: string;
  let entityId: number;
  let automationId: number;
  let api: TestApiClient;

  // The rest of the suite runs with the settle window collapsed to zero so a
  // fixture row is claimable the instant it lands (`vitest.config.ts`). These
  // cases exist to prove the settle window itself, so they restore the
  // production budget — every row below is stamped relative to it.
  const suiteSettleMs = process.env.AUTOMATION_ARRIVAL_SETTLE_MS;

  let agentId: string;

  beforeAll(async () => {
    process.env.AUTOMATION_ARRIVAL_SETTLE_MS = String(MINUTE_MS);
    await initWorkspaceProvider();
  });

  afterAll(() => {
    if (suiteSettleMs === undefined) delete process.env.AUTOMATION_ARRIVAL_SETTLE_MS;
    else process.env.AUTOMATION_ARRIVAL_SETTLE_MS = suiteSettleMs;
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    sql = getTestDb() as unknown as DbClient;
    orgId = seeded.org.id;
    const agent = await createTestAgent({
      organizationId: orgId,
      ownerUserId: seeded.user.id,
      agentId: 'arrival-axis-agent',
    });
    agentId = agent.agentId;
    const entity = await createTestEntity({
      name: 'Arrival axis subject',
      organization_id: orgId,
      created_by: seeded.user.id,
    });
    entityId = entity.id;
    api = await TestApiClient.for({
      organizationId: orgId,
      userId: seeded.user.id,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'arrival-axis',
      name: 'Arrival axis',
      prompt: 'Summarise everything that arrived since the last run.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, created_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
  });

  async function setMark(mark: Date): Promise<void> {
    await sql`
      UPDATE automations
      SET next_window_start = ${mark.toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;
  }

  async function storedRow(input: { occurredAt: Date; createdAt: Date; text: string }) {
    return createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: input.text,
      occurred_at: input.occurredAt,
      created_at: input.createdAt,
    });
  }

  async function claim(): Promise<ClaimResult> {
    return (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as ClaimResult;
  }

  async function complete(claimed: ClaimResult): Promise<void> {
    await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    });
  }

  async function readProjection() {
    const [row] = await sql<{
      next_window_start: Date | string;
      last_completed_window_start: Date | string | null;
    }>`
      SELECT next_window_start, last_completed_window_start
      FROM automations
      WHERE id = ${automationId}
    `;
    return {
      mark: new Date(row.next_window_start).toISOString(),
      lastCompletedWindowStart:
        row.last_completed_window_start == null
          ? null
          : new Date(row.last_completed_window_start).toISOString(),
    };
  }

  it('delivers a row stored late even though it happened long before the window', async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);

    // Happened a month ago, stored five minutes ago: a resync or an import.
    const lateRow = await storedRow({
      occurredAt: new Date(now - 30 * DAY_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'stored late',
    });
    // Stored just now: inside the settle window, so it belongs to the NEXT run.
    const freshRow = await storedRow({
      occurredAt: new Date(now - 2 * MINUTE_MS),
      createdAt: new Date(now),
      text: 'stored within the settle window',
    });
    // Stored before the mark: already booked by an earlier run.
    const bookedRow = await storedRow({
      occurredAt: new Date(now - MINUTE_MS),
      createdAt: new Date(now - 20 * MINUTE_MS),
      text: 'stored before the mark',
    });

    const claimed = await claim();
    const ids = claimed.context.content.map((row) => row.id);
    expect(ids).toContain(lateRow.id);
    expect(ids).not.toContain(freshRow.id);
    expect(ids).not.toContain(bookedRow.id);

    expect(claimed.context.window_start).toBe(mark.toISOString());
    const windowEnd = new Date(claimed.context.window_end).getTime();
    // The database clock is rounded up to a whole millisecond, so allow that.
    expect(windowEnd).toBeLessThanOrEqual(Date.now() - automationArrivalSettleMs() + 1);
    expect(windowEnd).toBeGreaterThan(now - automationArrivalSettleMs() - 10_000);
  });

  it("reclaims a failed run's range instead of skipping it", async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);
    const row = await storedRow({
      occurredAt: new Date(now - 5 * MINUTE_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'seen by the failed run',
    });

    const first = await claim();
    expect(first.context.content.map((r) => r.id)).toContain(row.id);
    await sql`
      UPDATE runs
      SET status = 'failed', outcome = 'agent_error', completed_at = NOW(),
          error_message = 'simulated failure'
      WHERE id = ${first.run_id}
    `;
    expect((await readProjection()).mark).toBe(mark.toISOString());

    const second = await claim();
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.context.window_start).toBe(first.context.window_start);
    expect(new Date(second.context.window_end).getTime()).toBeGreaterThanOrEqual(
      new Date(first.context.window_end).getTime()
    );
    expect(second.context.content.map((r) => r.id)).toContain(row.id);
  });

  it('never hands out the same range twice', async () => {
    const now = Date.now();
    const mark = new Date(now - 10 * MINUTE_MS);
    await setMark(mark);
    const row = await storedRow({
      occurredAt: new Date(now - 5 * MINUTE_MS),
      createdAt: new Date(now - 5 * MINUTE_MS),
      text: 'booked by the first run',
    });

    const first = await claim();
    expect(first.context.content.map((r) => r.id)).toContain(row.id);
    await complete(first);

    const projection = await readProjection();
    // The mark IS the coverage record: everything before it is booked, so a run
    // that starts exactly where the mark sits can never leave a gap behind it.
    expect(projection.mark).toBe(first.context.window_end);
    expect(projection.lastCompletedWindowStart).toBe(first.context.window_start);

    const second = await claim();
    expect(second.context.window_start).toBe(first.context.window_end);
    expect(second.context.content.map((r) => r.id)).not.toContain(row.id);

    // Completing the second range walks the mark forward with no gap: the second
    // window began exactly at the first mark (asserted above) and the mark now
    // sits at its end, so [seed, mark) stays contiguous without a coverage set.
    await complete(second);
    const after = await readProjection();
    expect(after.mark).toBe(second.context.window_end);
    expect(after.lastCompletedWindowStart).toBe(second.context.window_start);
  });

  it('lets a scheduled tick inside a fresh mark\'s settle budget wait instead of erroring', async () => {
    // A mark younger than the settle budget: the horizon has not passed it yet,
    // so there is nothing to hand out. Creation no longer produces this state —
    // it reaches a lookback back — but the CUTOVER migration does, seeding every
    // existing Automation at the clock, so the first tick after that deploy hits
    // this for every due Automation at once. `computePendingWindow`'s NULL-mark
    // repair lands here too.
    await setMark(new Date());
    const dueAt = new Date(Date.now() - MINUTE_MS);
    await sql`
      UPDATE automations
      SET next_run_at = ${dueAt.toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;

    const waited = await materializeDueAutomationRuns({} as Env);
    expect(waited.runsCreated).toBe(0);
    expect(waited.skipped).toBe(1);
    // No run, and the schedule was NOT advanced: the next tick retries.
    const runs = await sql<{ id: number }>`
      SELECT id FROM runs WHERE automation_id = ${automationId}
    `;
    expect(runs).toHaveLength(0);
    const [row] = await sql<{ next_run_at: Date | string }>`
      SELECT next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(row.next_run_at).toISOString()).toBe(dueAt.toISOString());

    // Once the horizon is past the mark, the same tick hands the range out
    // (here as a skip-completed run, since nothing arrived in it) and only then
    // moves the schedule on.
    await setMark(new Date(Date.now() - 10 * MINUTE_MS));
    const ready = await materializeDueAutomationRuns({} as Env);
    expect(ready.dueAutomations).toBe(1);
    const materialized = await sql<{ id: number }>`
      SELECT id FROM runs WHERE automation_id = ${automationId}
    `;
    expect(materialized).toHaveLength(1);
    const [advanced] = await sql<{ next_run_at: Date | string }>`
      SELECT next_run_at FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(advanced.next_run_at).getTime()).toBeGreaterThan(dueAt.getTime());
  });
  // A new Automation is created OVER a source that already has content. Seeding
  // its mark at the creation instant would make every one of those rows
  // permanently unreachable: they arrived before the mark and no window ever
  // reaches back. The old calendar axis never had this problem, because a first
  // window was a calendar period that already contained them.
  //
  // So creation — and only creation — starts one bounded lookback behind.
  it('lets a newly created Automation reach content that arrived before it', async () => {
    const arrivedBefore = await storedRow({
      occurredAt: new Date(Date.now() - 2 * DAY_MS),
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      text: 'ingested two days before the Automation existed',
    });

    // `automationId` was created in beforeEach, after nothing; create a second
    // one now, with the row already in place, and claim its very first window.
    const created = (await api.automations.create({
      slug: 'reaches-back',
      name: 'Reaches back',
      prompt: 'Summarise what is already here.',
      entity_ids: [entityId],
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, created_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: agentId,
    })) as { automation_id: string };
    const freshId = Number(created.automation_id);

    const [row] = await sql<{ next_window_start: Date | string }>`
      SELECT next_window_start FROM automations WHERE id = ${freshId}
    `;
    const mark = new Date(row.next_window_start).getTime();
    // Behind creation by the lookback, not at it.
    expect(mark).toBeLessThan(Date.now() - DAY_MS);
    expect(mark).toBeLessThan(new Date(arrivedBefore.created_at ?? Date.now()).getTime());

    const claimed = (await api.automations.claimNextWindow({
      automation_id: String(freshId),
    })) as ClaimResult;
    const ids = claimed.context.content.map((c) => Number(c.id));
    expect(ids).toContain(Number(arrivedBefore.id));
  });

});

describe('an Automation window and a writer still open across it', () => {
  let orgId: string;
  let entityId: number;
  let automationId: number;
  let api: TestApiClient;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    orgId = seeded.org.id;
    const agent = await createTestAgent({
      organizationId: orgId,
      ownerUserId: seeded.user.id,
      agentId: 'open-writer-agent',
    });
    const entity = await createTestEntity({
      name: 'Open writer subject',
      organization_id: orgId,
      created_by: seeded.user.id,
    });
    entityId = entity.id;
    api = await TestApiClient.for({
      organizationId: orgId,
      userId: seeded.user.id,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'open-writer',
      name: 'Open writer',
      prompt: 'Summarise everything that arrived since the last run.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, created_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { signals: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
    await getTestDb()`
      UPDATE automations
      SET next_window_start = ${new Date(Date.now() - 10 * MINUTE_MS).toISOString()}::timestamptz
      WHERE id = ${automationId}
    `;
  });

  async function claim(): Promise<ClaimResult> {
    return (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as ClaimResult;
  }

  async function complete(claimed: ClaimResult): Promise<void> {
    await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    });
  }

  it('delivers a row whose transaction stays open across a claim and completion', async () => {
    let inserted: (id: number) => void = () => {};
    let insertFailed: (error: unknown) => void = () => {};
    const insertedId = new Promise<number>((resolve, reject) => {
      inserted = resolve;
      insertFailed = reject;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The real ingestion funnel, inside a caller's transaction that stays open
    // after the insert — the shape of every `insertEvent(..., { sql: tx })` caller.
    const writer = getTestDb().begin(async (tx) => {
      const row = await insertEvent(
        {
          entityIds: [entityId],
          organizationId: orgId,
          originId: 'open-writer-row',
          title: 'Written inside a long transaction',
          content: 'stored by a writer that committed late',
          semanticType: 'content',
          occurredAt: new Date(),
        },
        { sql: tx as unknown as DbClient }
      );
      inserted(Number(row.id));
      await released;
    });
    void writer.catch(insertFailed);

    let rowId: number;
    try {
      rowId = await insertedId;
      // Let the database clock move past the row's created_at.
      await getTestDb()`SELECT pg_sleep(0.05)`;

      const first = await claim();
      // Not visible yet, so the first window cannot contain it...
      expect(first.context.content.map((r) => r.id)).not.toContain(rowId);
      await complete(first);
      // pg_stat_activity can lag in exposing the open writer, briefly leaving
      // the arrival horizon unclamped until the transaction becomes visible.
      await vi.waitFor(
        async () => {
          await expect(claim()).rejects.toThrow(/nothing new to claim yet/);
        },
        { timeout: 2_500, interval: 50 }
      );
    } finally {
      // Failed claims/assertions must not leave a writer blocking suite cleanup.
      release();
      await writer;
    }

    // ...which means some LATER window must. Every window starts at the mark the
    // previous one left, so the mark must not have moved past the row.
    const second = await claim();
    expect(second.context.content.map((r) => r.id)).toContain(rowId);
    await complete(second);
  });
});

describe("automation-mode unprocessed_ranges arrival bound", () => {
  let owner: TestApiClient;
  let automationId: string;
  let entityId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: "Ranges Bound Org" });
    const user = await createTestUser({ email: "ranges-bound@test.example.com" });
    await addUserToOrganization(user.id, org.id, "owner");
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: "owner",
    });
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    const entity = await createTestEntity({
      name: "Ranges Bound Target",
      entity_type: "company",
      organization_id: org.id,
      created_by: user.id,
    });
    entityId = Number(entity.id);
    await createTestConnection({
      organization_id: org.id,
      connector_key: "test.connector",
    });

    const now = Date.now();
    // Old arrival: outside the 90-day horizon on BOTH axes.
    await createTestEvent({
      entity_id: entityId,
      organization_id: org.id,
      content: "old arrival row",
      occurred_at: new Date(now - 100 * DAY_MS),
      created_at: new Date(now - 100 * DAY_MS),
    });
    // Backfill: source timestamp is ancient, but Lobu stored it this week.
    await createTestEvent({
      entity_id: entityId,
      organization_id: org.id,
      content: "backfilled row",
      occurred_at: new Date(now - 200 * DAY_MS),
      created_at: new Date(now - 5 * DAY_MS),
    });
    // Fresh on both axes.
    await createTestEvent({
      entity_id: entityId,
      organization_id: org.id,
      content: "fresh row",
      occurred_at: new Date(now - DAY_MS),
      created_at: new Date(now - DAY_MS),
    });

    const created = (await owner.automations.create({
      entity_id: entityId,
      slug: "ranges-bound",
      name: "Ranges Bound",
      prompt: "Summarize {{content}}.",
      managed_agent_id: agent.agentId,
      sources: [{ name: "content", query: "@feed:default" }],
    })) as { automation_id: string };
    automationId = created.automation_id;
  });

  it("excludes arrivals older than the horizon and buckets by created_at", async () => {
    const result = (await owner.knowledge.read({
      automation_id: automationId,
    })) as {
      unprocessed_ranges?: Array<{
        month: string;
        window_start: string;
        total_content: number;
        unprocessed_content: number;
      }>;
    };
    const ranges = result.unprocessed_ranges ?? [];
    const total = ranges.reduce((sum, r) => sum + r.total_content, 0);
    // Three events seeded, but only two arrived inside the horizon: the
    // 100-day-old arrival is excluded, while the backfill (occurred 200
    // days ago, stored 5 days ago) counts via its created_at arrival.
    // Bucketing by occurred_at would have dropped the backfill instead.
    expect(total).toBe(2);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((r) => r.unprocessed_content === r.total_content)).toBe(true);
    const horizon = new Date(Date.now() - 90 * DAY_MS).toISOString();
    expect(ranges.every((r) => r.window_start >= horizon)).toBe(true);
  });
});
