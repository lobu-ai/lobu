/**
 * waitForDeviceActionRun integration test.
 *
 * Exercises the real paths the manage_operations device-bound scheduling
 * branch can take:
 *
 *   1. happy: worker posts 'completed' with action_output → returns
 *      { status: 'completed', output }
 *   2. worker-failed: worker posts 'failed' → returns
 *      { status: 'failed', error_message, output }
 *   3. timeout-pre-claim: run never claimed before the queue budget →
 *      gateway marks the row 'timeout', returns timeout
 *   4. late-claim: the claim lands just before the queue deadline, so only the
 *      post-claim budget can carry the wait to completion.
 *   5. race: worker posts completion AFTER our timeout decision but
 *      BEFORE we re-read. The atomic UPDATE in completeActionRun
 *      (status='running' AND claimed_by=worker_id guard) must reject
 *      the worker write so the gateway's verdict stands.
 *   6. abort: an already-aborted signal short-circuits the poll loop.
 *   7. post-claim budget resolution: an action whose declared input schema
 *      bounds `timeout_ms` extends the post-claim wait to the requested value
 *      (clamped to that maximum) plus completion grace; every other shape —
 *      no declared maximum, a non-number request, a request under the default
 *      — leaves the default budget standing.
 *
 * Every path runs the production implementation. Cases 1-5 and 7 shrink its budgets
 * so the poll loops finish in milliseconds; case 6 uses the real ones because
 * the abort fires before the first sleep. Cases 1, 2 and 4 also supply the
 * `sleep` boundary, so the worker's writes land in a poll gap by construction
 * instead of by racing a wall-clock timer against the budget. Case 4 injects
 * the clock as well, since what it asserts is which deadline the waiter
 * consulted — not how long the host and Postgres happened to take.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertEntityApprovalPolicy } from '../../authz/entity-policy';
import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../../config/intervals';
import { createConnectorOperationRun } from '../../runs/queue-service';
import type { Env } from '../../index';
import {
  DEVICE_FEED_READ_ACTION_KEY,
  SOURCE_FEED_READ_METADATA_KEY,
} from '../../lib/device-feed-read-protocol';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import {
  waitForDeviceActionRun,
  waitForDeviceActionRunWithOptions,
} from '../../tools/admin/device-action-wait';
import { insertEvent } from '../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  seedOwnerContext,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

async function insertChromeConnector(
  organizationId: string,
  actionsSchema: Record<string, unknown> | null = null
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO connector_definitions
      (key, name, organization_id, version, status, runtime, required_capability,
       actions_schema)
    VALUES (
      'chrome', 'Chrome', ${organizationId}, '0.2.0', 'active',
      ${sql.json({ platforms: ['chrome-extension'] })},
      'browser.debugger',
      ${actionsSchema ? sql.json(actionsSchema) : null}
    )
  `;
}

// An action whose declared input schema bounds a `timeout_ms` budget — the
// shape a shell connector's `run` declares. Keyed by the fixture's action so
// the waiter resolves it through the run's connector definition. Installed
// definitions carry the input schema under either spelling, exactly as
// `getLocalActionOperations` reads it, so the fixture is built per spelling.
function timedActionsSchema(
  schemaKey: 'input_schema' | 'inputSchema'
): Record<string, unknown> {
  return {
    navigate: {
      key: 'navigate',
      [schemaKey]: {
        type: 'object',
        properties: {
          timeout_ms: { type: 'integer', minimum: 100, maximum: 150_000 },
        },
      },
    },
  };
}

const TIMED_ACTIONS_SCHEMA = timedActionsSchema('inputSchema');

async function insertChromeConnection(
  organizationId: string,
  deviceWorkerId: string | null = null
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug,
       device_worker_id, created_at, updated_at)
    VALUES
      (${organizationId}, 'chrome', 'active', 'org', 'chrome-test',
       ${deviceWorkerId}::uuid, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertPendingActionRun(
  organizationId: string,
  connectionId: number,
  actionInput: Record<string, unknown>
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, connection_id, connector_key,
       connector_version, action_key, action_input,
       approval_status, status, created_at)
    VALUES
      (${organizationId}, 'action', ${connectionId}, 'chrome', '0.2.0',
       'navigate', ${sql.json(actionInput)}, 'auto', 'pending', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

// Worker-side completion guarded by the atomic clause we use in
// production: status='running' AND claimed_by=worker — so a stale
// claimant or a terminal-state row results in a no-op.
async function workerCompleteAction(
  runId: number,
  workerId: string,
  outcome: 'success' | 'failed',
  actionOutput: Record<string, unknown> | null = null
): Promise<boolean> {
  const sql = getTestDb();
  const rows = (await sql`
    UPDATE runs
    SET status = ${outcome === 'success' ? 'completed' : 'failed'},
        completed_at = current_timestamp,
        action_output = ${actionOutput ? sql.json(actionOutput) : null},
        error_message = ${outcome === 'success' ? null : 'worker-failed'}
    WHERE id = ${runId}
      AND status = 'running'
      AND claimed_by = ${workerId}
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length > 0;
}

async function claim(
  runId: number,
  workerId: string,
  claimedAtMs?: number
): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE runs
    SET status = 'running',
        claimed_at = COALESCE(
          ${claimedAtMs == null ? null : new Date(claimedAtMs)}::timestamptz,
          current_timestamp
        ),
        claimed_by = ${workerId}
    WHERE id = ${runId}
      AND status = 'pending'
  `;
}

const FAST_BUDGETS = { queueMs: 400, postClaimMs: 600, pollMs: 30 };
const WORKER_ID = 'worker-test';

/**
 * A `sleep` boundary that lets the "worker" act exactly once, on the first
 * poll gap. The waiter re-reads the row before consulting any deadline, so the
 * poll after this sees the terminal status no matter how slow the writes were.
 * A second call means the waiter did not observe that write — fail loudly
 * rather than spin until the budget expires and report a timeout instead.
 */
function workerTurn(act: () => Promise<void>): () => Promise<void> {
  let turns = 0;
  return async () => {
    turns += 1;
    if (turns > 1) {
      throw new Error(
        `waiter did not observe the worker write (sleep ${turns})`
      );
    }
    await act();
  };
}

describe('waitForDeviceActionRun', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns completed + output on worker success', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {
      url: 'https://example.com',
    });

    // The "worker" claims + completes in the gap between two polls. Driving it
    // from the injected sleep instead of a wall-clock setTimeout means the next
    // poll always observes the terminal row, however long the writes take.
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      ...FAST_BUDGETS,
      sleep: workerTurn(async () => {
        await claim(runId, WORKER_ID);
        await workerCompleteAction(runId, WORKER_ID, 'success', {
          tab_id: 555,
          current_url: 'https://example.com/',
        });
      }),
    });
    expect(out.status).toBe('completed');
    expect(out.output).toMatchObject({ tab_id: 555 });
  });

  it('reports the claim once, so a caller can tell waiting from executing', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});
    let claimedReports = 0;
    let turns = 0;

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      ...FAST_BUDGETS,
      onClaimed: () => {
        claimedReports += 1;
      },
      sleep: async () => {
        turns += 1;
        expect(claimedReports).toBe(turns === 1 ? 0 : 1);
        if (turns === 1) await claim(runId, WORKER_ID);
        if (turns === 3) await workerCompleteAction(runId, WORKER_ID, 'success', {});
      },
    });

    expect(out.status).toBe('completed');
    expect(claimedReports).toBe(1);
  });

  it('surfaces worker-failed verdict', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      ...FAST_BUDGETS,
      sleep: workerTurn(async () => {
        await claim(runId, WORKER_ID);
        await workerCompleteAction(runId, WORKER_ID, 'failed', { browser_tab: { tab_id: 41 }, reason: 'synthetic-loading-failure' });
      }),
    });
    expect(out.status).toBe('failed');
    expect(out.error_message).toBe('worker-failed');
    expect(out.output).toEqual({ browser_tab: { tab_id: 41 }, reason: 'synthetic-loading-failure' });
  });

  it('times out + marks row when no worker claims within the queue budget', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, FAST_BUDGETS);
    expect(out.status).toBe('timeout');

    const sql = getTestDb();
    const rows = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string }>;
    expect(rows[0].status).toBe('timeout');
    expect(rows[0].error_message).toContain('no device claimed the run');
  });

  it.each([
    {
      kind: 'device feed read',
      actionKey: DEVICE_FEED_READ_ACTION_KEY,
      sourceRead: false,
      expectedInput: { scrubbed: true, feed_key: 'files' },
    },
    {
      kind: 'metadata source read',
      actionKey: 'navigate',
      sourceRead: true,
      expectedInput: { scrubbed: true },
    },
    {
      kind: 'device feed read with source metadata',
      actionKey: DEVICE_FEED_READ_ACTION_KEY,
      sourceRead: true,
      expectedInput: { scrubbed: true },
    },
    {
      kind: 'ordinary action',
      actionKey: 'navigate',
      sourceRead: false,
      expectedInput: null,
    },
  ])('atomically finalizes timeout payloads for $kind', async ({ actionKey, sourceRead, expectedInput }) => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const actionInput = {
      feed_key: 'files',
      query: 'private caller query',
      sort: [{ column: 'name', direction: 'asc' }],
      limit: 10,
    };
    const actionOutput = { rows: [{ name: 'private source row' }] };
    const runId = await insertPendingActionRun(org.id, connId, actionInput);
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_key = ${actionKey},
          run_metadata = ${sql.json({ [SOURCE_FEED_READ_METADATA_KEY]: sourceRead })},
          action_output = ${sql.json(actionOutput)}
      WHERE id = ${runId} AND organization_id = ${org.id}
    `;

    let syntheticNow = Date.now();
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      ...FAST_BUDGETS,
      now: () => syntheticNow,
      sleep: workerTurn(async () => {
        syntheticNow += FAST_BUDGETS.queueMs;
      }),
    });
    expect(out.status).toBe('timeout');

    // Read directly after the waiter returns, without the caller's finally scrub.
    const [row] = await sql`
      SELECT status, action_input, action_output FROM runs
      WHERE id = ${runId} AND organization_id = ${org.id}
    `;
    expect(row).toEqual({
      status: 'timeout',
      action_input: expectedInput ?? actionInput,
      action_output: expectedInput ? null : actionOutput,
    });
  });

  it('honors the post-claim budget after claim — extended wait if claimed late', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const queueMs = 1_000;
    const postClaimMs = 2_000;
    let syntheticNow = Date.now();
    const queueDeadline = syntheticNow + queueMs;
    let sleepCount = 0;

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs,
      postClaimMs,
      pollMs: 1,
      now: () => syntheticNow,
      sleep: async () => {
        sleepCount += 1;
        if (sleepCount === 1) {
          // Claim near, but still before, the original queue deadline.
          syntheticNow += queueMs - 100;
          await claim(runId, WORKER_ID, syntheticNow);
          return;
        }
        if (sleepCount === 2) {
          // The next poll sees a running row after the original deadline. The
          // helper must use claimed_at + postClaimMs instead of timing out.
          syntheticNow += 200;
          return;
        }
        if (sleepCount === 3) {
          syntheticNow += 100;
          await workerCompleteAction(runId, WORKER_ID, 'success', { ok: true });
          return;
        }
        throw new Error(`unexpected sleep ${sleepCount}`);
      },
    });
    expect(out.status).toBe('completed');
    expect(sleepCount).toBe(3);
    expect(syntheticNow).toBeGreaterThan(queueDeadline);
  });

  // A run whose action declares a bounded `timeout_ms` budget is still running
  // at 100s — past the 95s watchdog default — and the waiter must wait for it.
  // This is the regression: a shell command with a 150s budget was marked
  // timeout at 95s while the device was mid-command, and its output was lost.
  it.each(['input_schema', 'inputSchema'] as const)(
    "honors a requested action timeout within the action's declared maximum (%s)",
    async (schemaKey) => {
      const org = await createTestOrganization();
      await insertChromeConnector(org.id, timedActionsSchema(schemaKey));
      const connId = await insertChromeConnection(org.id);
      const runId = await insertPendingActionRun(org.id, connId, { timeout_ms: 150_000 });
      let syntheticNow = Date.now();
      await claim(runId, WORKER_ID, syntheticNow);
      let sleeps = 0;
      const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
        queueMs: 60_000,
        postClaimMs: 95_000,
        pollMs: 1,
        now: () => syntheticNow,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) {
            syntheticNow += 100_000;
            return;
          }
          if (sleeps === 2) {
            await workerCompleteAction(runId, WORKER_ID, 'success', { ok: true });
            return;
          }
          throw new Error('waiter failed to observe completion');
        },
      });
      expect(out.status).toBe('completed');
      expect(sleeps).toBe(2);
    }
  );

  // The fractional case is deliberately larger than the default budget: a
  // smaller one would clear the default floor either way and prove nothing
  // about the integer guard.
  it.each([null, 0, -1, 100_000.5, '150000'])(
    'does not extend the wait for an unusable requested timeout %s',
    async (timeout_ms) => {
      const org = await createTestOrganization();
      await insertChromeConnector(org.id, TIMED_ACTIONS_SCHEMA);
      const connId = await insertChromeConnection(org.id);
      const runId = await insertPendingActionRun(org.id, connId, { timeout_ms });
      let syntheticNow = Date.now();
      await claim(runId, WORKER_ID, syntheticNow);
      const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
        queueMs: 60_000,
        postClaimMs: 95_000,
        pollMs: 1,
        now: () => syntheticNow,
        sleep: async () => {
          syntheticNow += 100_000;
        },
      });
      expect(out.status).toBe('timeout');
      expect(out.error_message).toContain('95000ms');
    }
  );

  // The declared schema is the contract. A requested budget under an action
  // that declares no `timeout_ms` maximum cannot extend the wait, however
  // large — otherwise any input key could hold the gateway open.
  it('ignores a requested timeout when the action declares no maximum', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, { timeout_ms: 150_000 });
    let syntheticNow = Date.now();
    await claim(runId, WORKER_ID, syntheticNow);
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 60_000,
      postClaimMs: 95_000,
      pollMs: 1,
      now: () => syntheticNow,
      sleep: async () => {
        syntheticNow += 100_000;
      },
    });
    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('95000ms');
  });

  // Input validation rejects a request above the declared maximum at creation;
  // a row that carries one anyway (a direct write) is clamped to the maximum,
  // never honored as written — and the clamped budget still terminates the
  // wait once the declared maximum plus completion grace has elapsed.
  it('clamps a requested timeout above the declared maximum', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id, TIMED_ACTIONS_SCHEMA);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, { timeout_ms: 300_001 });
    let syntheticNow = Date.now();
    await claim(runId, WORKER_ID, syntheticNow);
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 60_000,
      postClaimMs: 95_000,
      pollMs: 1,
      now: () => syntheticNow,
      sleep: async () => {
        syntheticNow += 180_000;
      },
    });
    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('180000ms');
  });

  // A declared maximum is tenant input: an organization installs the connector
  // definition it is read from. A definition claiming a day-long action must
  // not hold the gateway request for a day.
  it('caps a budget an installed definition declares beyond the absolute ceiling', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id, {
      navigate: {
        key: 'navigate',
        inputSchema: {
          type: 'object',
          properties: {
            timeout_ms: { type: 'integer', minimum: 100, maximum: 86_400_000 },
          },
        },
      },
    });
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, { timeout_ms: 86_400_000 });
    let syntheticNow = Date.now();
    await claim(runId, WORKER_ID, syntheticNow);
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 60_000,
      postClaimMs: 95_000,
      pollMs: 1,
      now: () => syntheticNow,
      sleep: async () => {
        syntheticNow += 180_000;
      },
    });
    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('180000ms');
  });

  // The default is a floor: a device that requests a SHORT budget still gets
  // the full default wait, so a run that dies at 1s is reported by the device
  // rather than terminalized here at 31s.
  it('does not shorten the wait below the default budget', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id, TIMED_ACTIONS_SCHEMA);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, { timeout_ms: 1_000 });
    let syntheticNow = Date.now();
    await claim(runId, WORKER_ID, syntheticNow);
    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 60_000,
      postClaimMs: 95_000,
      pollMs: 1,
      now: () => syntheticNow,
      sleep: async () => {
        syntheticNow += 100_000;
      },
    });
    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('95000ms');
  });

  it('atomic guard: a worker that finalizes after gateway-timeout cannot overwrite the verdict', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});
    // Claim immediately but never complete — exhausts post-claim
    // budget. The waiter writes status='timeout'. Then the "worker"
    // tries to post completion; the atomic UPDATE should reject it
    // because status is no longer 'running'.
    await claim(runId, WORKER_ID);

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 50,
      postClaimMs: 200,
      pollMs: 30,
    });
    expect(out.status).toBe('timeout');

    // Worker arrives late.
    const wrote = await workerCompleteAction(runId, WORKER_ID, 'success', {
      foo: 'bar',
    });
    expect(wrote).toBe(false); // atomic UPDATE rejected

    const sql = getTestDb();
    const final = (await sql`
      SELECT status, action_output FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; action_output: Record<string, unknown> | null }>;
    expect(final[0].status).toBe('timeout');
    expect(final[0].action_output).toBeNull();
  });

  // Calls the default-budget entry point so the abortSignal wiring is covered
  // exactly as production callers use it: an automation reaction hitting its
  // wall-clock budget must cancel the poll loop instead of leaking it. An
  // already-aborted signal short-circuits on the first iteration, so this stays
  // fast despite the real 60s queue budget.
  it('aborts the wait + finalizes the run as timeout when the abort signal fires', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const controller = new AbortController();
    controller.abort(); // already aborted before we start waiting

    const start = Date.now();
    const out = await waitForDeviceActionRun(runId, org.id, controller.signal);
    const elapsed = Date.now() - start;

    expect(out.status).toBe('timeout');
    expect(elapsed).toBeLessThan(5_000); // did NOT sit through the 60s budget
    expect(out.error_message).toContain('caller cancelled the wait or reached its deadline');
    expect(out.error_message).toContain('before any device claimed the run');
    expect(out.error_message).not.toContain('60000ms');

    const sql = getTestDb();
    const rows = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string }>;
    expect(rows[0].status).toBe('timeout');
    expect(rows[0].error_message).toBe(out.error_message);
  });

  it.each([false, true])('reports an early caller abort honestly (claimed=%s)', async (claimed) => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `synthetic_dispatched_${runId}`,
      title: 'Navigate — dispatched',
      content: 'Operation dispatched: Navigate',
      semanticType: 'operation',
      runId,
      interactionType: 'approval',
      interactionStatus: 'approved',
      authorName: 'synthetic-agent',
    });
    let syntheticNow = Date.now();
    if (claimed) await claim(runId, WORKER_ID, syntheticNow);
    const controller = new AbortController();

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      queueMs: 60_000,
      postClaimMs: 95_000,
      pollMs: 500,
      now: () => syntheticNow,
      sleep: workerTurn(async () => {
        syntheticNow += 8_000;
        controller.abort();
      }),
      abortSignal: controller.signal,
    });

    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('caller cancelled the wait or reached its deadline after 8000ms');
    expect(out.error_message).toContain(
      claimed ? 'while the device was executing' : 'before any device claimed the run'
    );
    expect(out.error_message).not.toMatch(/60000ms|95000ms|offline|last seen|no paired device/);
    const sql = getTestDb();
    const rows = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string }>;
    expect(rows[0].status).toBe('timeout');
    expect(rows[0].error_message).toBe(out.error_message);
    const cards = await sql`
      SELECT title, interaction_status, interaction_error FROM current_event_records
      WHERE organization_id = ${org.id} AND run_id = ${runId}
    `;
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('navigate — caller wait ended');
    expect(cards[0].interaction_status).toBe('failed');
    expect(cards[0].interaction_error).toBe(out.error_message);
    // An aborted pending operation must not become claimable later.
    if (!claimed) await claim(runId, WORKER_ID);
    expect(await workerCompleteAction(runId, WORKER_ID, 'success', { late: true })).toBe(false);
  });

  it('preserves a worker result that arrives before caller cancellation is observed', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});
    await claim(runId, WORKER_ID);
    const controller = new AbortController();

    const out = await waitForDeviceActionRunWithOptions(runId, org.id, {
      ...FAST_BUDGETS,
      sleep: workerTurn(async () => {
        await workerCompleteAction(runId, WORKER_ID, 'success', { finished: true });
        controller.abort();
      }),
      abortSignal: controller.signal,
    });
    expect(out).toEqual({ status: 'completed', output: { finished: true } });
  });
});

describe('createConnectorOperationRun — ephemeral expires_at semantics', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function expiresAtOf(runId: number): Promise<Date | null> {
    const sql = getTestDb();
    const rows = (await sql`
      SELECT expires_at FROM runs WHERE id = ${runId}
    `) as Array<{ expires_at: Date | null }>;
    return rows[0]?.expires_at ?? null;
  }

  it('device-mode (ephemeral browser/device) runs get a bounded expires_at', async () => {
    const { org, user } = await seedOwnerContext({ orgName: 'Pinned Expiry Fixture' });
    const sql = getTestDb();
    await insertChromeConnector(org.id);
    const [device] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
      ) VALUES (
        ${user.id}, 'synthetic-expiry-browser', 'chrome-extension',
        ${sql.json(['browser.debugger'])}, 'Synthetic expiry browser', ${org.id}, NOW()
      )
      RETURNING id
    `) as Array<{ id: string }>;
    const connId = await insertChromeConnection(org.id, device.id);

    const createdBefore = Date.now();
    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
    });
    expect(claim.status).toBe('pending');
    expect(claim.approvalStatus).toBe('auto');

    const expiresAt = await expiresAtOf(claim.runId);
    expect(expiresAt).not.toBeNull();
    const expiresInMs = (expiresAt as Date).getTime() - createdBefore;
    expect(expiresInMs).toBeGreaterThan(DEVICE_ACTION_QUEUE_BUDGET_MS - 5_000);
    expect(expiresInMs).toBeLessThan(DEVICE_ACTION_QUEUE_BUDGET_MS + 5_000);
  });

  it('a device-pinned action queued behind a busy serial worker times out once without redispatch', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: 'Busy Device Action Org',
    });
    await insertChromeConnector(org.id);
    const workerId = 'busy-device-action-worker';
    const [device] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label,
        organization_id, last_seen_at
      ) VALUES (
        ${user.id}, ${workerId}, 'chrome-extension',
        ${sql.json(['browser.debugger'])}, 'Busy Chrome', ${org.id}, current_timestamp
      )
      RETURNING id
    `) as Array<{ id: string }>;
    const connId = await insertChromeConnection(org.id, device.id);

    // Device workers execute serially. Model the exact worker already holding
    // one action while another direct action is queued for the same pin. The
    // due-feed pull path cannot defer this row because actions are created by
    // their caller, not by the scheduled-feed materializer.
    const [busy] = await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key,
        connector_version, action_key, action_input, approval_status, status,
        claimed_at, last_heartbeat_at, claimed_by, executed_by_device_worker_id,
        created_at
      ) VALUES (
        ${org.id}, 'action', ${connId}, 'chrome', '0.2.0', 'busy_action',
        ${sql.json({})}, 'auto', 'running', current_timestamp - interval '70 seconds',
        current_timestamp, ${workerId}, ${device.id}::uuid, current_timestamp
      )
      RETURNING id
    `;
    const createdBefore = Date.now();
    const queued = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'queued_behind_busy',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
    });
    expect(queued.status).toBe('pending');
    const expiresAt = await expiresAtOf(queued.runId);
    expect(expiresAt).not.toBeNull();
    const expiresInMs = (expiresAt as Date).getTime() - createdBefore;
    expect(expiresInMs).toBeGreaterThan(DEVICE_ACTION_QUEUE_BUDGET_MS - 5_000);
    expect(expiresInMs).toBeLessThan(DEVICE_ACTION_QUEUE_BUDGET_MS + 5_000);

    // No zero-capacity poll extended the horizon, so it lapses on schedule.
    await sql`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queued.runId}`;
    const out = await waitForDeviceActionRunWithOptions(
      queued.runId,
      org.id,
      FAST_BUDGETS
    );
    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('was never claimed');
    expect(out.error_message).toMatch(
      new RegExp(`device "Busy Chrome" is busy: run ${busy.id} has been running for 7\\ds`)
    );

    const queuedRows = await sql`
      SELECT status, error_message
      FROM runs
      WHERE organization_id = ${org.id}
        AND run_type = 'action'
        AND action_key = 'queued_behind_busy'
    `;
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0].status).toBe('timeout');
    expect(String(queuedRows[0].error_message)).toContain('no device claimed the run');
    expect(String(queuedRows[0].error_message)).toContain(`device "Busy Chrome" is busy: run ${busy.id}`);
  });

  it('queued (durable human-decision) runs get NO expires_at', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);

    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'queued',
      requireCompiledCode: false,
      idempotencyKey: `durable-${Date.now()}`,
    });
    expect(claim.approvalStatus).toBe('pending');
    expect(await expiresAtOf(claim.runId)).toBeNull();
  });

  it('inline (immediate gateway-executed) runs get NO expires_at', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);

    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'inline',
      requireCompiledCode: false,
      idempotencyKey: `inline-${Date.now()}`,
    });
    expect(claim.status).toBe('running');
    expect(await expiresAtOf(claim.runId)).toBeNull();
  });

  it('an idempotent replay of an expired device run returns the prior terminal row', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const key = `replay-${Date.now()}`;

    const first = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
      idempotencyKey: key,
    });
    expect(first.created).toBe(true);

    // Age the run to terminal timeout with a lapsed expiry (as the reaper or
    // waitForDeviceActionRun would after the claim horizon).
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET status = 'timeout',
          completed_at = current_timestamp,
          expires_at = now() - interval '1 second'
      WHERE id = ${first.runId}
    `;

    // The same idempotency key must not mint a second run, and must return the
    // prior (now terminal) run rather than resurrecting it.
    const replay = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
      idempotencyKey: key,
    });
    expect(replay.created).toBe(false);
    expect(replay.runId).toBe(first.runId);
    expect(replay.status).toBe('timeout');
  });

  it('hydrates absent browser context on exact replay without replacing conflicts', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const key = `browser-context-replay-${Date.now()}`;
    const request = {
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device' as const,
      requireCompiledCode: false,
      idempotencyKey: key,
    };

    const first = await createConnectorOperationRun({
      ...request,
      runMetadata: { unrelated: { preserved: true } },
    });
    const browserContext = {
      id: 'conversation:abc123def456',
      title: 'Owletto · Conversation abc123def456',
      flow_id: 'conversation:abc123def456',
      kind: 'conversation',
    };
    const replay = await createConnectorOperationRun({
      ...request,
      runMetadata: { browser_context: browserContext },
    });
    expect(replay.created).toBe(false);
    expect(replay.runId).toBe(first.runId);

    const sql = getTestDb();
    const [row] = await sql`
      SELECT run_metadata FROM runs WHERE id = ${first.runId}
    `;
    expect(row.run_metadata).toEqual({
      unrelated: { preserved: true },
      browser_context: browserContext,
    });

    expect((await createConnectorOperationRun({ ...request, runMetadata: { browser_context: { ...browserContext, title: 'Lobu · Changed task' } } })).runId).toBe(first.runId);
    // Identity is flow_id + kind. A run stored while contexts still carried an
    // `id` replays cleanly under the same flow without one.
    const { id: _retiredId, ...withoutId } = browserContext;
    expect((await createConnectorOperationRun({ ...request, runMetadata: { browser_context: withoutId } })).runId).toBe(first.runId);

    for (const different of [
      { ...withoutId, flow_id: 'conversation:different' },
      { ...withoutId, kind: 'mcp' },
    ]) {
      await expect(
        createConnectorOperationRun({ ...request, runMetadata: { browser_context: different } })
      ).rejects.toThrow(/already bound to a different request/);
    }
  });

  it.each([false, true])('replays a bare SDK operation without adopting its owner (legacy=%s)', async (legacy) => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connectionId = await insertChromeConnection(org.id);
    const request = {
      organizationId: org.id, connectionId, connectorKey: 'chrome',
      operationKey: 'open_tab', operationInput: { url: 'about:blank' },
      approvalMode: 'device' as const, idempotencyKey: 'synthetic-sdk-replay',
    };
    const owner = { flow_id: 'sdk-first', kind: 'run' as const, title: 'Lobu · Same task · first' };
    const first = await createConnectorOperationRun({ ...request, sdkBrowserContext: legacy ? undefined : owner });
    const sql = getTestDb();
    await sql`UPDATE runs SET status = 'completed', action_output = '{"tab_id":123}'::jsonb WHERE id = ${first.runId}`;
    const replay = await createConnectorOperationRun({
      ...request, sdkBrowserContext: { ...owner, flow_id: 'sdk-second' },
    });
    expect(replay).toMatchObject({ runId: first.runId, created: false, status: 'completed', actionOutput: { tab_id: 123 } });
    const [row] = await sql`SELECT run_metadata FROM runs WHERE id = ${first.runId}`;
    expect(row.run_metadata?.browser_context ?? null).toEqual(legacy ? null : owner);
    await expect(createConnectorOperationRun({ ...request, operationInput: { url: 'https://different.example' } })).rejects.toThrow(/different request/);
    await expect(createConnectorOperationRun({ ...request, policyPrincipalKind: 'user', policyPrincipalId: 'synthetic-other-user' })).rejects.toThrow(/different request/);
  });

  it('keeps the winning invocation owner when two replicas insert the same SDK key', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connectionId = await insertChromeConnection(org.id);
    const request = {
      organizationId: org.id, connectionId, connectorKey: 'chrome',
      operationKey: 'open_tab', operationInput: {},
      approvalMode: 'device' as const, idempotencyKey: 'synthetic-sdk-race',
    };
    const contexts = ['first', 'second'].map((suffix) => ({
      flow_id: `sdk-${suffix}`, kind: 'run' as const, title: 'Lobu · Same task',
    }));
    const claims = await Promise.all(contexts.map((sdkBrowserContext) => createConnectorOperationRun({ ...request, sdkBrowserContext })));
    expect(new Set(claims.map((claim) => claim.runId)).size).toBe(1);
    const winner = claims.findIndex((claim) => claim.created);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    const sql = getTestDb();
    const [row] = await sql`SELECT run_metadata FROM runs WHERE id = ${claims[0].runId}`;
    expect(row.run_metadata.browser_context).toEqual(contexts[winner]);
  });

  it.each(['flow', 'kind', 'title', 'retired-id'] as const)('checks browser identity atomically during hydration (%s)', async (change) => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const key = `browser-context-race-${Date.now()}`;
    const request = {
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device' as const,
      requireCompiledCode: false,
      idempotencyKey: key,
    };
    await createConnectorOperationRun(request);

    const sql = getTestDb();
    let staleReads = 0;
    let releaseReads: (() => void) | null = null;
    const bothReadsComplete = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const gatedSql = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0] as TemplateStringsArray;
        const query = Array.from(strings).join(' ');
        const result = Reflect.apply(target, thisArg, args);
        if (
          query.includes('SELECT id, connection_id, connector_key') &&
          query.includes('action_idempotency_key')
        ) {
          return Promise.resolve(result).then(async (rows) => {
            staleReads += 1;
            if (staleReads === 2) releaseReads?.();
            await bothReadsComplete;
            return rows;
          });
        }
        return result;
      },
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof sql;

    const contextA = {
      title: 'Owletto · Conversation context-a',
      flow_id: 'conversation:context-a',
      kind: 'conversation',
    };
    const contextB = {
      ...contextA,
      ...({
        flow: { flow_id: 'conversation:context-b' },
        kind: { kind: 'mcp' },
        title: { title: 'Lobu · New task · context-a' },
        'retired-id': { id: 'conversation:context-a' },
      }[change]),
    };
    const results = await Promise.allSettled([
      createConnectorOperationRun({
        ...request,
        runMetadata: { browser_context: contextA },
        db: gatedSql,
      }),
      createConnectorOperationRun({
        ...request,
        runMetadata: { browser_context: contextB },
        db: gatedSql,
      }),
    ]);

    const compatible = change === 'title' || change === 'retired-id';
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(compatible ? 2 : 1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(compatible ? 0 : 1);
    const [row] = await sql`
      SELECT run_metadata FROM runs
      WHERE organization_id = ${org.id}
        AND action_idempotency_key = ${key}
    `;
    expect([contextA, contextB]).toContainEqual(row.run_metadata.browser_context);
  });
});

/**
 * A device whose slots are full keeps polling with `capacity_available: 0`.
 * That poll is the busy signal: a pinned run queued behind work the device is
 * actively executing must not expire at the 60s queue budget, while a device
 * that is offline, or alive with a free slot and still not claiming, fails as
 * before. Driven through the real poll, reaper, and completion routes.
 */
describe('device action queued behind a busy device', () => {
  const CONNECTOR = 'demo.device.busy';
  const DEVICE_WORKER = 'synthetic-busy-device';
  const savedEnv = new Map<string, string | undefined>();
  let organizationId: string;
  let userId: string;
  let toolCtx: ToolContext;
  let deviceId: string;
  let connectionId: number;

  beforeAll(() => {
    for (const key of ['RUNS_REAPER_STALE_AFTER_SECONDS', 'WORKER_API_TOKEN', 'LOBU_CLOUD_MODE']) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.RUNS_REAPER_STALE_AFTER_SECONDS = '120';
  });

  afterAll(async () => {
    await cleanupTestDatabase();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext({ orgName: 'Busy Device Fixture' });
    organizationId = seeded.ctx.organizationId;
    userId = seeded.user.id;
    toolCtx = { ...seeded.ctx, baseUrl: 'https://gateway.test/lobu' };
    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: CONNECTOR,
      name: 'Busy device fixture',
      organization_id: organizationId,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object' } },
    })}, supports_execute = true WHERE organization_id = ${organizationId} AND key = ${CONNECTOR}`;
    const [device] = await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${seeded.user.id}, ${DEVICE_WORKER}, 'macos', '0.1.0', '[]'::jsonb, 'Busy Mac', ${organizationId}, NOW())
      RETURNING id
    `;
    deviceId = String(device.id);
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: CONNECTOR,
      created_by: seeded.user.id,
      visibility: 'private',
    });
    connectionId = connection.id;
    await sql`UPDATE connections SET device_worker_id = ${deviceId}::uuid WHERE id = ${connectionId}`;
    await upsertEntityApprovalPolicy(organizationId, {
      resourceClass: 'connector_action',
      connectionId,
      effects: { execute: 'auto' },
    });
  });

  async function poll(capacity: number) {
    const response = await post('/api/workers/poll', {
      body: {
        worker_id: DEVICE_WORKER,
        platform: 'macos',
        app_version: '0.1.0',
        label: DEVICE_WORKER,
        capabilities: {},
        capacity_available: capacity,
      },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ run_id?: number }>;
  }

  /** The device's only slot, held by an action it claimed `runningForSeconds` ago. */
  async function occupySlot(runningForSeconds: number): Promise<number> {
    const sql = getTestDb();
    const [busy] = await sql`
      INSERT INTO runs (
        organization_id, run_type, connection_id, connector_key, action_key,
        action_input, approval_status, status, claimed_at, last_heartbeat_at,
        claimed_by, executed_by_device_worker_id, target_device_worker_id, created_at
      ) VALUES (
        ${organizationId}, 'action', ${connectionId}, ${CONNECTOR}, 'echo',
        ${sql.json({})}, 'auto', 'running',
        now() - make_interval(secs => ${runningForSeconds}), now(),
        ${DEVICE_WORKER}, ${deviceId}::uuid, ${deviceId}::uuid,
        now() - make_interval(secs => ${runningForSeconds})
      )
      RETURNING id
    `;
    return Number(busy.id);
  }

  async function queue(): Promise<number> {
    const run = await createConnectorOperationRun({
      organizationId,
      connectionId,
      connectorKey: CONNECTOR,
      operationKey: 'echo',
      operationInput: { n: 2 },
      approvalMode: 'device',
      requireCompiledCode: true,
      policyPrincipalKind: 'user',
      policyPrincipalId: userId,
      createdByUserId: userId,
    });
    expect(run.status).toBe('pending');
    return run.runId;
  }

  async function runRow(runId: number) {
    const [row] = await getTestDb()`
      SELECT status, error_message,
        EXTRACT(EPOCH FROM (expires_at - now()))::float AS horizon_seconds
      FROM runs WHERE id = ${runId}
    `;
    return row as { status: string; error_message: string | null; horizon_seconds: number | null };
  }

  /** Steps the device and the clock once per waiter poll gap, in order. */
  function script(steps: Array<() => Promise<void>>): () => Promise<void> {
    let index = 0;
    return async () => {
      const step = steps[index++];
      if (!step) throw new Error(`waiter kept polling after the scripted steps (sleep ${index})`);
      await step();
    };
  }

  it('a run queued behind a busy slot for longer than the queue budget is claimed and completes', async () => {
    const busyRunId = await occupySlot(80);
    const queuedRunId = await queue();
    const sql = getTestDb();
    let syntheticNow = Date.now();

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, {
      queueMs: DEVICE_ACTION_QUEUE_BUDGET_MS,
      postClaimMs: 95_000,
      pollMs: 500,
      now: () => syntheticNow,
      sleep: script([
        async () => {
          // The original horizon is about to lapse while the slot is still busy.
          await sql`UPDATE runs SET expires_at = now() + interval '10 seconds' WHERE id = ${queuedRunId}`;
          expect(await poll(0)).not.toHaveProperty('run_id');
          expect((await runRow(queuedRunId)).horizon_seconds).toBeGreaterThan(50);
          await reapStaleRuns();
          expect((await runRow(queuedRunId)).status).toBe('pending');
          syntheticNow += 40_000;
        },
        async () => {
          // Past the 60s queue budget: the device is still busy and polling.
          syntheticNow += 40_000;
          expect(await poll(0)).not.toHaveProperty('run_id');
          await reapStaleRuns();
          expect((await runRow(queuedRunId)).status).toBe('pending');
        },
        async () => {
          // The busy run finishes; the freed slot claims the queued run.
          await sql`UPDATE runs SET status = 'completed', completed_at = now() WHERE id = ${busyRunId}`;
          expect(await poll(1)).toMatchObject({ run_id: queuedRunId });
          const completed = await post('/api/workers/complete-action', {
            body: { run_id: queuedRunId, worker_id: DEVICE_WORKER, status: 'success', action_output: { done: true } },
          });
          expect(completed.status).toBe(200);
          syntheticNow += 5_000;
        },
      ]),
    });

    expect(out).toEqual({ status: 'completed', output: { done: true } });
    expect((await runRow(queuedRunId)).status).toBe('completed');
  });

  it('a busy device cannot hold a queued run past its horizon; the failure names the blocking run', async () => {
    const busyRunId = await occupySlot(70);
    const queuedRunId = await queue();
    // The busy-extension ceiling was reached: the horizon lapsed with the slot still held.
    await getTestDb()`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queuedRunId}`;

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, FAST_BUDGETS);

    expect(out.status).toBe('timeout');
    expect(out.error_message).toMatch(
      new RegExp(`device "Busy Mac" is busy: run ${busyRunId} has been running for 7\\ds`)
    );
    expect(out.error_message).not.toContain('last polled');
    expect(out.error_message).not.toContain('all slots in use');
    const row = await runRow(queuedRunId);
    expect(row.status).toBe('timeout');
    expect(row.error_message).toContain(`run ${busyRunId} has been running for`);
  });

  it.each(['auto', 'approved'] as const)('caps renewal from when an %s run became claimable', async (approvalStatus) => {
    await occupySlot(30);
    const queuedRunId = await queue();
    const sql = getTestDb();
    await sql`
      UPDATE runs SET approval_status = ${approvalStatus},
        created_at = now() - ${approvalStatus === 'approved' ? 3600 : 180}::int * interval '1 second',
        run_at = now() - interval '180 seconds',
        expires_at = now() + interval '30 seconds'
      WHERE id = ${queuedRunId}
    `;

    await poll(0);

    const [row] = await sql`
      SELECT EXTRACT(EPOCH FROM (expires_at -
        CASE WHEN approval_status = 'approved' THEN run_at ELSE created_at END))::float AS total_seconds
      FROM runs WHERE id = ${queuedRunId}
    `;
    expect(row.total_seconds).toBe(240);
  });

  it.each(['expired', 'background', 'native_source_read', 'compiled_source_read'] as const)(
    'does not renew a %s horizon', async (scenario) => {
      await occupySlot(30);
      const queuedRunId = await queue();
      const sql = getTestDb();
      const seconds = scenario === 'expired' ? -1 : scenario === 'background' ? 600 : 10;
      const [before] = await sql`
        UPDATE runs SET expires_at = now() + ${seconds}::int * interval '1 second',
          action_key = ${scenario === 'native_source_read' ? DEVICE_FEED_READ_ACTION_KEY : 'echo'},
          run_metadata = ${sql.json(scenario === 'compiled_source_read'
            ? { [SOURCE_FEED_READ_METADATA_KEY]: true }
            : scenario === 'background' ? { background: true } : {})}
        WHERE id = ${queuedRunId} RETURNING expires_at
      `;

      await poll(0);

      const [after] = await sql`SELECT expires_at FROM runs WHERE id = ${queuedRunId}`;
      expect(after.expires_at).toEqual(before.expires_at);
    }
  );

  it('does not renew a stale pin in a workspace the device cannot claim from', async () => {
    await occupySlot(30);
    const queuedRunId = await queue();
    const foreignOrg = await createTestOrganization({ name: 'Former Device Workspace' });
    const foreignConnection = await createTestConnection({
      organization_id: foreignOrg.id,
      connector_key: CONNECTOR,
      created_by: userId,
      createDefaultFeed: false,
    });
    const sql = getTestDb();
    // The pin survives the owner's departure; no membership grants claim access.
    await sql`UPDATE connections SET device_worker_id = ${deviceId}::uuid WHERE id = ${foreignConnection.id}`;
    const [before] = await sql`
      UPDATE runs SET organization_id = ${foreignOrg.id}, connection_id = ${foreignConnection.id},
        expires_at = now() + interval '30 seconds'
      WHERE id = ${queuedRunId} RETURNING expires_at
    `;

    await poll(0);

    const [after] = await sql`SELECT expires_at FROM runs WHERE id = ${queuedRunId}`;
    expect(after.expires_at).toEqual(before.expires_at);
  });

  it('an offline device still fails, even with a stale running row', async () => {
    await occupySlot(600);
    await getTestDb()`UPDATE device_workers SET last_seen_at = now() - interval '10 minutes' WHERE id = ${deviceId}::uuid`;
    const queuedRunId = await queue();

    // No poll extends an offline device's horizon, so it lapses on schedule.
    await getTestDb()`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queuedRunId}`;

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, FAST_BUDGETS);

    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('was never claimed');
    expect(out.error_message).toContain('device "Busy Mac" last polled 10m ago');
    expect(out.error_message).not.toContain('is busy');
  });

  it('a device alive with free capacity that never claims still fails with the last-polled text', async () => {
    const queuedRunId = await queue();
    // Reporting zero capacity with nothing running is not "busy": no extension.
    expect(await poll(0)).not.toHaveProperty('run_id');
    expect((await runRow(queuedRunId)).horizon_seconds).toBeLessThan(61);
    await getTestDb()`UPDATE runs SET expires_at = now() - interval '1 second' WHERE id = ${queuedRunId}`;

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, FAST_BUDGETS);

    expect(out.status).toBe('timeout');
    expect(out.error_message).toMatch(/was never claimed within 400ms — device "Busy Mac" last polled \d+s ago\./);
    expect(out.error_message).not.toContain('is busy');
  });

  it('a caller whose wait ends behind a busy device finalizes the run and names the blocker', async () => {
    // The caller (run_sdk's wall clock, a reaction budget) can no longer
    // receive a run id, so the run must not stay claimable and execute later.
    const busyRunId = await occupySlot(30);
    const queuedRunId = await queue();
    expect(await poll(0)).not.toHaveProperty('run_id');
    const controller = new AbortController();
    controller.abort();

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, {
      ...FAST_BUDGETS,
      abortSignal: controller.signal,
    });

    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain('before any device claimed the run');
    expect(out.error_message).toContain(`device "Busy Mac" is busy: run ${busyRunId} has been running for`);
    expect((await runRow(queuedRunId)).status).toBe('timeout');
    await getTestDb()`UPDATE runs SET status = 'completed' WHERE id = ${busyRunId}`;
    expect(await poll(1)).not.toHaveProperty('run_id', queuedRunId);
  });

  it('an execute call whose wait ends behind a busy device returns a timeout, never a later execution', async () => {
    const busyRunId = await occupySlot(30);
    const controller = new AbortController();
    controller.abort();

    const out = (await manageOperations(
      { action: 'execute', connection_id: connectionId, operation_key: 'echo', input: {} },
      {} as Env,
      { ...toolCtx, abortSignal: controller.signal }
    )) as { run_id: number; status: string; error_message?: string };

    expect(out.status).toBe('timeout');
    expect(out.error_message).toContain(`run ${busyRunId} has been running for`);
    expect((await runRow(out.run_id)).status).toBe('timeout');
  });

  it('a caller whose wait ends for an idle device keeps the plain abort message', async () => {
    const queuedRunId = await queue();
    const controller = new AbortController();
    controller.abort();

    const out = await waitForDeviceActionRunWithOptions(queuedRunId, organizationId, {
      ...FAST_BUDGETS,
      abortSignal: controller.signal,
    });

    expect(out.status).toBe('timeout');
    expect(out.error_message).toMatch(/before any device claimed the run\.$/);
    expect(out.error_message).not.toContain('is busy');
    expect((await runRow(queuedRunId)).status).toBe('timeout');
  });
});
