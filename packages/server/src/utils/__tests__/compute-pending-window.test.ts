/**
 * The arrival mark and the window it hands out.
 *
 * `computePendingWindow` is the only reader that may WRITE (it seeds a NULL
 * mark), `readPendingWindow` is its read-only twin for status surfaces, and
 * `advanceAutomationArrivalMark` is the only writer that may move the mark.
 * The end-to-end delivery these produce is covered by
 * `__tests__/integration/automations/arrival-axis-window.test.ts`; this suite
 * pins the bookkeeping itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceAutomationArrivalMark,
  automationArrivalHorizon,
  automationArrivalSettleMs,
  computePendingWindow,
  describeUnclaimedArrivals,
  readLastCompletedWindowStart,
  readPendingWindow,
  requestedArrivalWindow,
} from '../window-utils';
import type { DbClient } from '../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';

const MINUTE_MS = 60_000;

let orgId: string;
let userId: string;
let sql: DbClient;

/** An Automation whose mark starts wherever the caller says (NULL to leave it unseeded). */
async function seedAutomation(automationId: number, mark: Date | null): Promise<void> {
  const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
  await getTestDb()`
    INSERT INTO automations (
      id, name, slug, created_by, organization_id, managed_agent_id, automation_group_id,
      next_window_start
    ) VALUES (
      ${automationId}, ${`Window ${automationId}`}, ${`window-${automationId}`},
      ${userId}, ${orgId}, ${agent.agentId}, ${automationId},
      ${mark ? mark.toISOString() : null}::timestamptz
    )
  `;
}

async function readMark(automationId: number): Promise<Date | null> {
  const [row] = await getTestDb()`
    SELECT next_window_start FROM automations WHERE id = ${automationId}
  `;
  return row?.next_window_start ? new Date(row.next_window_start) : null;
}

describe('the arrival mark', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Arrival Org' });
    const user = await createTestUser({ email: 'arrival@test.example.com' });
    orgId = org.id;
    userId = user.id;
    sql = getTestDb() as unknown as DbClient;
  });

  afterEach(async () => {
    await cleanupTestDatabase();
  });

  it('hands out [mark, horizon) from the database clock', async () => {
    const mark = new Date(Date.now() - 30 * MINUTE_MS);
    await seedAutomation(1, mark);

    const [{ db_now }] = await sql<{ db_now: string | Date }>`SELECT current_timestamp AS db_now`;
    const dbNow = new Date(db_now);
    const { windowStart, windowEnd } = await computePendingWindow(sql, 1);

    expect(windowStart.toISOString()).toBe(mark.toISOString());
    // The end is the horizon as the DATABASE clock sees it, not the app's.
    expect(windowEnd.getTime()).toBeGreaterThanOrEqual(
      automationArrivalHorizon(dbNow, null).getTime()
    );
    expect(windowEnd.getTime()).toBeLessThan(dbNow.getTime() + MINUTE_MS);
  });

  it('seeds an unseeded mark to the database clock, and only once', async () => {
    await seedAutomation(1, null);
    expect(await readMark(1)).toBeNull();

    const first = await computePendingWindow(sql, 1);
    const seeded = await readMark(1);
    expect(seeded).not.toBeNull();
    expect(seeded?.toISOString()).toBe(first.windowStart.toISOString());

    // A second read is a plain read: it must not re-seed and move the frontier.
    const second = await computePendingWindow(sql, 1);
    expect(second.windowStart.toISOString()).toBe(first.windowStart.toISOString());
    expect((await readMark(1))?.toISOString()).toBe(seeded?.toISOString());
  });

  it('never inverts: nothing settled since the mark is an empty window, not a negative one', async () => {
    // A mark in the future of the horizon is exactly the state right after a
    // completion. The window collapses to a point; the claim path refuses it.
    const mark = new Date(Date.now() + 10 * MINUTE_MS);
    await seedAutomation(1, mark);

    const { windowStart, windowEnd } = await computePendingWindow(sql, 1);
    expect(windowEnd.getTime()).toBe(windowStart.getTime());
  });

  it('reads without a lock or a seed for status surfaces', async () => {
    await seedAutomation(1, null);
    const pending = await readPendingWindow(sql, 1);
    expect(pending).not.toBeNull();
    // The status read reported a mark, but did NOT write one.
    expect(await readMark(1)).toBeNull();
    expect(await readPendingWindow(sql, 9007)).toBeNull();
  });

  it('books a completed range by moving the mark to its end', async () => {
    const mark = new Date(Date.now() - 30 * MINUTE_MS);
    await seedAutomation(1, mark);
    const end = new Date(mark.getTime() + 10 * MINUTE_MS);

    expect(await advanceAutomationArrivalMark(sql, 1, mark, end)).toBe(true);
    expect((await readMark(1))?.toISOString()).toBe(end.toISOString());
    expect(await readLastCompletedWindowStart(sql, 1)).toEqual(mark);
  });

  it('walks the mark contiguously across consecutive completions', async () => {
    const first = new Date(Date.now() - 30 * MINUTE_MS);
    const second = new Date(first.getTime() + 10 * MINUTE_MS);
    const third = new Date(second.getTime() + 10 * MINUTE_MS);
    await seedAutomation(1, first);

    // Each advance requires `start <= mark < end`, so a second completion can
    // only ever butt against the first: [first, third) cannot fragment.
    expect(await advanceAutomationArrivalMark(sql, 1, first, second)).toBe(true);
    expect(await advanceAutomationArrivalMark(sql, 1, second, third)).toBe(true);

    expect((await readMark(1))?.toISOString()).toBe(third.toISOString());
    expect(await readLastCompletedWindowStart(sql, 1)).toEqual(second);
  });

  it('books nothing for a range that is entirely behind the mark (a re-read)', async () => {
    const mark = new Date(Date.now() - 10 * MINUTE_MS);
    await seedAutomation(1, mark);
    const stale = new Date(mark.getTime() - 20 * MINUTE_MS);

    expect(await advanceAutomationArrivalMark(sql, 1, stale, mark)).toBe(false);
    expect((await readMark(1))?.toISOString()).toBe(mark.toISOString());
  });

  it('books nothing for an explicitly selected LATER range, leaving the gap claimable', async () => {
    const mark = new Date(Date.now() - 30 * MINUTE_MS);
    await seedAutomation(1, mark);
    const laterStart = new Date(mark.getTime() + 10 * MINUTE_MS);
    const laterEnd = new Date(mark.getTime() + 20 * MINUTE_MS);

    expect(await advanceAutomationArrivalMark(sql, 1, laterStart, laterEnd)).toBe(false);
    // The mark did not jump the gap, so an ordinary claim still returns it.
    expect((await readMark(1))?.toISOString()).toBe(mark.toISOString());
  });
});

describe('the arrival horizon', () => {
  it('stops at the oldest open transaction when it is older than the settle budget', () => {
    const dbNow = new Date('2026-09-03T12:00:00.000Z');
    const openSince = new Date(dbNow.getTime() - automationArrivalSettleMs() - 5 * MINUTE_MS);
    expect(automationArrivalHorizon(dbNow, openSince).toISOString()).toBe(
      openSince.toISOString()
    );
  });

  it('is the settle budget when every open transaction is younger than it', () => {
    const dbNow = new Date('2026-09-03T12:00:00.000Z');
    const previousSettle = process.env.AUTOMATION_ARRIVAL_SETTLE_MS;
    process.env.AUTOMATION_ARRIVAL_SETTLE_MS = '60000';
    try {
      const settled = dbNow.getTime() - automationArrivalSettleMs();
      expect(automationArrivalHorizon(dbNow, new Date(dbNow.getTime() - 1)).getTime()).toBe(
        settled
      );
      expect(automationArrivalHorizon(dbNow, null).getTime()).toBe(settled);
    } finally {
      if (previousSettle === undefined) delete process.env.AUTOMATION_ARRIVAL_SETTLE_MS;
      else process.env.AUTOMATION_ARRIVAL_SETTLE_MS = previousSettle;
    }
  });
});

describe('an agent-chosen arrival range', () => {
  it("treats `until` as inclusive and clamps the end to the horizon", () => {
    const horizon = new Date('2026-09-03T12:00:00.000Z');
    const { windowStart, windowEnd } = requestedArrivalWindow(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-02T00:00:00.000Z'),
      horizon
    );
    expect(windowStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // "through Sep 2" ends at the start of Sep 3, which is behind the horizon.
    expect(windowEnd.toISOString()).toBe('2026-09-03T00:00:00.000Z');
  });

  it('never reaches past the horizon, however far `until` asks', () => {
    const horizon = new Date('2026-09-03T12:00:00.000Z');
    const { windowEnd } = requestedArrivalWindow(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2027-01-01T00:00:00.000Z'),
      horizon
    );
    expect(windowEnd.getTime()).toBe(horizon.getTime());
  });
});

describe('unclaimed-arrival guidance', () => {
  it('is silent when the range starts at or before the mark', () => {
    const mark = new Date('2026-09-03T12:00:00.000Z');
    expect(describeUnclaimedArrivals(mark, mark)).toBeNull();
    expect(describeUnclaimedArrivals(mark, new Date('2026-09-03T11:00:00.000Z'))).toBeNull();
  });

  it('names both ends of the gap and says the mark does not move', () => {
    const mark = new Date('2026-09-01T00:00:00.000Z');
    const note = describeUnclaimedArrivals(mark, new Date('2026-09-03T00:00:00.000Z'));
    expect(note).toContain('2026-09-01T00:00:00.000Z');
    expect(note).toContain('2026-09-03T00:00:00.000Z');
    expect(note).toContain('The mark stays where it is');
  });
});
