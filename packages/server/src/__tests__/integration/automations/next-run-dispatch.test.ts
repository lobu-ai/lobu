/**
 * A run queued behind an in-flight run is dispatched as soon as that run ends.
 *
 * The claim's one-active-run guard rejects a follow-up while its predecessor
 * runs, so the fast dispatch at enqueue claims nothing. Before this, the
 * follow-up sat `pending` until the minute `automation` tick. Both
 * terminal paths must now dispatch it: the reply-finished resolution
 * (`ApiResponseRenderer`) and `complete_window`.
 *
 * The test server runs no embedded Lobu, so a dispatched follow-up is claimed
 * by `lobu-dispatcher` and then failed with "Embedded Lobu is not available."
 * — that claim is the observable proof it left the queue.
 */
import { createServer } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchNextPendingAutomationRuns } from '../../../automations/automation';
import type { DbClient } from '../../../db/client';
import { ApiResponseRenderer } from '../../../gateway/api/response-renderer';
import { createAutomationRun } from '../../../runs/queue-service';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function setup(slug: string) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: `Next Run Dispatch ${slug}` });
  const ownerUserId = workspace.users.owner.id;
  const entity = await createTestEntity({
    name: 'Next Run Entity',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: `next-run-agent-${slug}`,
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await api.automations.create({
    entity_id: entity.id,
    slug,
    prompt: 'Summarize content.',
    triggers: [
      {
        kind: 'schedule',
        cron: '0 * * * *',
        execution: 'window',
        active_run: 'coalesce',
        skip_if_unchanged: false,
      },
    ],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  return {
    sql,
    api,
    organizationId: workspace.org.id,
    agentId: agent.agentId,
    automationId: Number(created.automation_id),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** A pending follow-up the server dispatcher would claim if nothing blocked it. */
async function insertFollowUp(
  h: Harness,
  extra: Record<string, unknown> = {}
): Promise<number> {
  const now = new Date();
  const [row] = await h.sql`
    INSERT INTO runs (organization_id, run_type, automation_id, status, approved_input)
    VALUES (${h.organizationId}, 'automation', ${h.automationId}, 'pending',
            ${h.sql.json({
              automation_id: h.automationId,
              agent_id: h.agentId,
              window_start: new Date(now.getTime() - 60_000).toISOString(),
              window_end: now.toISOString(),
              dispatch_source: 'event',
              trigger_execution: 'turn',
              ...extra,
            })})
    RETURNING id
  `;
  return Number(row.id);
}

async function runState(h: Harness, runId: number) {
  const [row] = await h.sql<{
    status: string;
    claimed_by: string | null;
    error_message: string | null;
  }>`SELECT status, claimed_by, error_message FROM runs WHERE id = ${runId}`;
  return row;
}

function renderer(): ApiResponseRenderer {
  return new ApiResponseRenderer({
    broadcast() {},
  } as unknown as ConstructorParameters<typeof ApiResponseRenderer>[0]);
}

async function finishReply(messageId: string) {
  await renderer().handleCompletion(
    {
      messageId,
      channelId: `api-${messageId}`,
      conversationId: `api-${messageId}`,
      userId: 'automation-test',
      teamId: 'api',
      timestamp: Date.now(),
    },
    'session'
  );
}

async function insertRunningTurn(h: Harness, messageId: string): Promise<number> {
  const [row] = await h.sql`
    INSERT INTO runs (organization_id, run_type, automation_id, status,
                      claimed_by, claimed_at, dispatched_message_id, approved_input)
    VALUES (${h.organizationId}, 'automation', ${h.automationId}, 'running',
            'lobu-dispatcher', NOW(), ${messageId},
            ${h.sql.json({ dispatch_source: 'event', trigger_execution: 'turn' })})
    RETURNING id
  `;
  return Number(row.id);
}

describe('next pending Automation run dispatch on completion', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each(['completed', 'failed'])('dispatches the follow-up when the in-flight reply is %s', async (status) => {
    const h = await setup('reply-finished');
    const activeId = await insertRunningTurn(h, 'msg-reply-finished');
    const followUpId = await insertFollowUp(h);

    if (status === 'completed') {
      await finishReply('msg-reply-finished');
    } else {
      await renderer().handleError({
        messageId: 'msg-reply-finished',
        channelId: 'api-msg-reply-finished',
        conversationId: 'api-msg-reply-finished',
        userId: 'automation-test',
        teamId: 'api',
        timestamp: Date.now(),
        error: 'Synthetic failure',
      }, 'session');
    }

    expect((await runState(h, activeId)).status).toBe(status);
    const followUp = await runState(h, followUpId);
    expect(followUp.status).not.toBe('pending');
    expect(followUp.claimed_by).toBe('lobu-dispatcher');
    expect(followUp.error_message).toBe('Embedded Lobu is not available.');
  });

  it('bounds immediate dispatch even when every queued run fails', async () => {
    const h = await setup('bounded-dispatch');
    await h.sql`
      INSERT INTO runs (organization_id, run_type, automation_id, status, approved_input)
      SELECT ${h.organizationId}, 'automation', ${h.automationId}, 'pending',
             ${h.sql.json({ agent_id: h.agentId, dispatch_source: 'event' })}
      FROM generate_series(1, 101)
    `;

    await dispatchNextPendingAutomationRuns([h.automationId]);

    const rows = await h.sql`SELECT status FROM runs WHERE automation_id = ${h.automationId}`;
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(100);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
  });

  it('dispatches the follow-up when complete_window commits', async () => {
    const h = await setup('complete-window');
    await h.sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${h.automationId}`;
    const pending = await computePendingWindow(h.sql as unknown as DbClient, h.automationId);
    const active = await createAutomationRun({
      organizationId: h.organizationId,
      automationId: h.automationId,
      agentId: h.agentId,
      windowStart: pending.windowStart.toISOString(),
      windowEnd: pending.windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });
    await h.sql`
      UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${h.agentId}`}
      WHERE id = ${active.runId}
    `;
    const followUpId = await insertFollowUp(h);
    const knowledge = (await h.api.knowledge.read({
      automation_id: h.automationId,
      run_id: active.runId,
    })) as { window_token: string };

    await h.api.automations.completeWindow({
      automation_id: String(h.automationId),
      window_token: knowledge.window_token,
      extracted_data: {},
      run_id: active.runId,
    });

    expect((await runState(h, active.runId)).status).toBe('completed');
    const followUp = await runState(h, followUpId);
    expect(followUp.status).not.toBe('pending');
    expect(followUp.claimed_by).toBe('lobu-dispatcher');
  });

  it.each([
    ['device-pinned', { device_worker_id: 'device-worker-synthetic' }],
    ['external', { executor: { kind: 'external' } }],
    ['manual-open', { agent_id: null }],
  ])('leaves a %s follow-up to its own executor', async (label, extra) => {
    const h = await setup(`leave-${label}`);
    await insertRunningTurn(h, `msg-leave-${label}`);
    const followUpId = await insertFollowUp(h, extra);

    await finishReply(`msg-leave-${label}`);

    const followUp = await runState(h, followUpId);
    expect(followUp.status).toBe('pending');
    expect(followUp.claimed_by).toBeNull();
  });
});

describe('Automation dispatcher ownership across HTTP waits', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    ['cancelled', 200, 'session'],
    ['reclaimed', 200, 'session'],
    ['reclaimed', 503, 'session'],
    ['unchanged', 200, 'session'],
    ['unchanged', 503, 'session'],
    ['reclaimed', 200, 'message'],
  ] as const)('fences a %s run across HTTP %s at %s', async (transition, responseStatus, waitAt) => {
    const h = await setup(`dispatch-fence-${transition}-${responseStatus}-${waitAt}`);
    const runId = await insertFollowUp(h);
    let sessionStarted!: () => void;
    let releaseSession!: () => void;
    const started = new Promise<void>(resolve => { sessionStarted = resolve; });
    const released = new Promise<void>(resolve => { releaseSession = resolve; });
    const delivered: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/api/v1/agents') {
        if (waitAt === 'session') {
          sessionStarted();
          await released;
        }
        response.writeHead(responseStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ agentId: h.agentId, messagesUrl: `${baseUrl}/messages` }));
      } else {
        for await (const chunk of request) delivered.push(chunk.toString());
        if (waitAt === 'message') {
          sessionStarted();
          await released;
        }
        response.writeHead(waitAt === 'message' ? 503 : 200).end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const priorUrl = process.env.DISPATCHER_URL;
    let dispatch: Promise<unknown> | undefined;
    try {
      process.env.DISPATCHER_URL = baseUrl;
      vi.resetModules();
      vi.doMock('../../../lobu/gateway', async () => ({
        ...await vi.importActual<typeof import('../../../lobu/gateway')>('../../../lobu/gateway'),
        isLobuGatewayRunning: () => true,
      }));
      const { dispatchPendingAutomationRuns } = await import('../../../automations/automation');
      dispatch = dispatchPendingAutomationRuns({ db: h.sql as unknown as DbClient, runIds: [runId] });
      await started;
      if (transition === 'cancelled') {
        await h.sql`UPDATE runs SET status = 'cancelled', completed_at = now(), error_message = 'Cancelled during dispatch'
          WHERE id = ${runId}`;
      } else if (transition === 'reclaimed') {
        // A different replica reclaims with the same dispatcher name. Preserve
        // microseconds so an owner-only or JS-Date fence cannot pass this test.
        await h.sql`UPDATE runs SET claimed_at = claimed_at + interval '1 microsecond', error_message = 'Replacement claim'
          WHERE id = ${runId}`;
      }
      releaseSession();
      const result = await dispatch;
      const state = await runState(h, runId);
      if (transition === 'unchanged') {
        expect(state.status).toBe(responseStatus === 200 ? 'running' : 'failed');
        expect(result).toMatchObject({ dispatched: responseStatus === 200 ? 1 : 0, failed: responseStatus === 503 ? 1 : 0 });
      } else {
        expect(state).toMatchObject({
          status: transition === 'cancelled' ? 'cancelled' : waitAt === 'message' ? 'running' : 'claimed',
          claimed_by: waitAt === 'message' ? `lobu:${h.agentId}` : 'lobu-dispatcher',
          error_message: transition === 'cancelled' ? 'Cancelled during dispatch' : 'Replacement claim',
        });
        expect(result).toMatchObject({ reconciled: 1, dispatched: 0, failed: 0 });
      }
      expect(delivered.length).toBe(waitAt === 'message' || (transition === 'unchanged' && responseStatus === 200) ? 1 : 0);
    } finally {
      releaseSession();
      await dispatch;
      vi.doUnmock('../../../lobu/gateway');
      vi.resetModules();
      if (priorUrl === undefined) delete process.env.DISPATCHER_URL;
      else process.env.DISPATCHER_URL = priorUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
