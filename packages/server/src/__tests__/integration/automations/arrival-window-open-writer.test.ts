/**
 * A window never closes over a row whose writer has not committed yet.
 *
 * `events.created_at` is `DEFAULT now()`: the writer's TRANSACTION START. The
 * row only becomes visible at commit. A window whose end passes `created_at`
 * while the writer is still open completes without the row, the mark moves past
 * it, and every later window starts after it — the row is skipped by that
 * Automation for good, with no error anywhere.
 *
 * The settle budget (`AUTOMATION_ARRIVAL_SETTLE_MS`) only covers writers that
 * commit inside it. This suite runs with the budget collapsed to zero
 * (`vitest.config.ts`), so any writer held open across a claim is a writer that
 * outlived its budget: exactly the production case of an event insert inside a
 * transaction open longer than 60s.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

const MINUTE_MS = 60_000;

type ClaimResult = {
  run_id: number;
  context: {
    content: Array<{ id: number }>;
    window_start: string;
    window_end: string;
    window_token: string;
  };
};

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
      await expect(claim()).rejects.toThrow('nothing new to claim yet');
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
