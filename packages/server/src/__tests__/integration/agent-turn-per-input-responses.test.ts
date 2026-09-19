/**
 * Per-input responses for agent turns (#3662), on the retained runs-backed
 * `thread_response` outbox — no new table.
 *
 * One execution may answer several accepted inputs (steering). The completion
 * transaction writes one terminal outbox row per input, each stamped with its
 * own answer text, its own tool ledger, and its own verbatim first error —
 * never execution-wide values borrowed across inputs, and never a fallback
 * text for an input the turn never answered. Receipts without `response_text`
 * are the older single-reply contract and still drain as one execution-wide
 * reply, so old claims finish under the contract they were admitted with.
 */
import { renderBaselineAgentPolicy } from '@lobu/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db/client';
import {
  enqueueAgentTurn,
} from '../../gateway/orchestration/agent-turn-producer';
import { sweepStaleAgentTurnRuns } from '../../worker-api/agent-turn';
import type { AgentSettingsStore } from '../../gateway/auth/settings/agent-settings-store';
import type { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import type { ModelProviderModule } from '../../gateway/modules/module-system';
import type { MessagePayload } from '@lobu/core';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const GATEWAY_URL = 'https://gateway.test.invalid/lobu';
const AGENT_ID = 'turn-agent';

function claudeModule(): ModelProviderModule {
  return {
    providerId: 'claude',
    sdkCompat: 'anthropic',
    getUpstreamConfig: () => ({
      slug: 'anthropic',
      upstreamBaseUrl: 'https://api.anthropic.com',
      apiKeyHeader: 'x-api-key' as const,
    }),
    getProxyBaseUrlMappings: (proxyUrl: string, agentId?: string, context?: { organizationId?: string; userId?: string }) => ({
      ANTHROPIC_BASE_URL: `${proxyUrl}/anthropic/a/${agentId}/o/${context?.organizationId}/u/${context?.userId}`,
    }),
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) =>
      context?.workerToken ?? 'lobu-proxy',
  } as unknown as ModelProviderModule;
}

const settingsStore = {
  getSettings: async () => ({
    identityMd: 'I am the turn agent.',
    soulMd: 'Answer briefly.',
    userMd: '',
  }),
} as unknown as AgentSettingsStore;

function messageFor(organizationId: string): MessagePayload {
  return {
    userId: 'user-turn',
    conversationId: 'conv-turn',
    messageId: 'msg-turn',
    channelId: 'api_user-turn',
    agentId: AGENT_ID,
    organizationId,
    botId: 'bot-turn',
    platform: 'api',
    messageText: 'what is the isolate lane?',
    platformMetadata: {},
    agentOptions: { model: 'claude/claude-opus-4-8' },
  } as MessagePayload;
}

async function admittedMessage(message: MessagePayload): Promise<MessagePayload> {
  const sql = getTestDb();
  const [input] = await sql`
    INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
    VALUES (${message.organizationId}, 'chat_message', 'messages', 'claimed', ${sql.json(message)}) RETURNING id
  `;
  return { ...message, runId: Number(input.id) };
}

async function enqueueMessage(message: MessagePayload) {
  return await enqueueAgentTurn(await admittedMessage(message), {
    agentSettings: settingsStore,
    catalog: { getInstalledModules: async () => [claudeModule()], findProviderForModel: async () => claudeModule() } as unknown as ProviderCatalogService,
    gatewayUrl: GATEWAY_URL,
  });
}

async function agentTurnRuns() {
  const sql = getTestDb();
  return (await sql`
    SELECT id, run_type, status, approval_status, organization_id, action_input, parent_run_id
    FROM runs WHERE run_type = 'agent_turn' ORDER BY id
  `) as unknown as Array<{
    id: number; run_type: string; status: string; approval_status: string;
    organization_id: string; action_input: Record<string, unknown>; parent_run_id: number | null;
  }>;
}

async function pollFleet(workerId: string, capabilities: Record<string, boolean>) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

async function postAsFleet(path: string, body: Record<string, unknown>) {
  return post(path, {
    body: path === '/api/workers/complete-agent-turn' && body.status === 'completed'
      ? { consumed_inputs: [], ...body } : body,
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

function nativeSession(entries: Array<Record<string, unknown>>): string {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return [
    { type: 'session', version: 3, id: 'native-session', timestamp, cwd: '/workspace' },
    ...entries.map((entry) => ({ timestamp, ...entry })),
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

const SEND_ERROR = 'Error: Not authorized for this conversation';

interface InputScenario {
  sql: ReturnType<typeof getTestDb>;
  owner: { id: number };
  followers: Array<{ id: number }>;
  body: Record<string, unknown>;
  worker_id: string;
}

/** Owner plus two identical-text steered followers, with a per-input completion body. */
async function inputScenario(): Promise<InputScenario> {
  const org = await createTestOrganization();
  const first = messageFor(org.id);
  const sql = getTestDb();
  const deps = {
    agentSettings: settingsStore,
    catalog: { getInstalledModules: async () => [claudeModule()], findProviderForModel: async () => claudeModule() } as unknown as ProviderCatalogService,
    gatewayUrl: GATEWAY_URL,
  };
  await enqueueMessage(first);
  const [owner] = await agentTurnRuns();
  const worker_id = 'fleet-per-input';
  await (await pollFleet(worker_id, { agent_turn: true })).json();
  for (const [index, text] of ['same text', 'same text'].entries()) {
    await enqueueAgentTurn(await admittedMessage({ ...first, messageId: `input-${index}`, messageText: text }), deps);
  }
  const followers = (await agentTurnRuns()).slice(1);
  const entries = [
    { type: 'message', id: 'current-user', parentId: null, message: { role: 'user', content: first.messageText, timestamp: 1 } },
    ...['same text', 'same text'].map((text, index) => ({
      type: 'message', id: `input-entry-${index}`,
      parentId: index ? `input-entry-${index - 1}` : 'current-user',
      message: { role: 'user', content: text, timestamp: 2 + index },
    })),
  ];
  const body = {
    run_id: owner.id, worker_id, status: 'completed',
    // Deliberately vague prose: the durable record must still carry the exact
    // connector error and the actual tool ledger, not the paraphrase.
    text: 'Owner answer with authorization issues.',
    tools_used: ['send_message'],
    first_error: SEND_ERROR,
    replied_in_band: true,
    session_jsonl: nativeSession(entries),
    consumed_inputs: followers.map((row, index) => ({
      run_id: row.id,
      session_entry_id: `input-entry-${index}`,
      response_text: `input ${index} answered`,
      ...(index === 0 ? { tools_used: ['get_approval'], first_error: 'Error: approval 4242 expired' } : {}),
    })),
    turn_tool_events: [
      { tool_call_id: 'c-owner', name: 'send_message', is_error: true, output: SEND_ERROR },
      { tool_call_id: 'c-delayed', name: 'get_approval', input_run_id: followers[0].id, is_error: false, output: '{"run_id":4242}' },
      { tool_call_id: 'c-other', name: 'send_message', input_run_id: followers[1].id, is_error: true, output: SEND_ERROR },
    ],
  };
  return { sql, owner, followers, body, worker_id };
}

async function threadResponseRows() {
  const sql = getTestDb();
  return (await sql`
    SELECT status, action_input FROM runs
    WHERE queue_name = 'thread_response' AND run_type = 'chat_message' ORDER BY id ASC
  `) as unknown as Array<{ status: string; action_input: Record<string, unknown> }>;
}

describe('agent turn per-input responses', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(() => {
  });

  it('writes one terminal row per input with its own text, tools, and verbatim error', async () => {
    const { sql, owner, followers, body } = await inputScenario();
    const response = await postAsFleet('/api/workers/complete-agent-turn', body);
    expect(await response.json()).toEqual({ ok: true, status: 'completed' });

    // Follower runs carry their own answer, not the execution text.
    const rows = await sql`SELECT id, status, output_tail, run_metadata FROM runs
      WHERE id IN (${followers[0].id}, ${followers[1].id}) ORDER BY id`;
    expect(rows[0]).toMatchObject({ status: 'completed', output_tail: 'input 0 answered' });
    expect(rows[1]).toMatchObject({ status: 'completed', output_tail: 'input 1 answered' });
    for (const [index, row] of rows.entries()) {
      expect(row.run_metadata).toMatchObject({ consumed_by_run_id: owner.id, session_entry_id: `input-entry-${index}` });
    }

    const delivered = await threadResponseRows();
    const terminals = delivered.filter((row) => Array.isArray(row.action_input.processedMessageIds));
    expect(terminals).toHaveLength(3);
    const byMessage = new Map(terminals.map((row) => [row.action_input.messageId as string, row.action_input]));
    // Owner: its own vague prose, but the exact error and its own ledger.
    expect(byMessage.get('msg-turn')).toMatchObject({
      finalText: 'Owner answer with authorization issues.',
      toolsUsed: ['send_message'],
      firstToolError: SEND_ERROR,
      processedMessageIds: ['msg-turn'],
      repliedInBand: true,
    });
    // Followers: their own answers and ledgers; the in-band flag stays on the
    // owner's row only, so one in-band post cannot suppress steered replies.
    expect(byMessage.get('input-0')).toMatchObject({
      finalText: 'input 0 answered',
      toolsUsed: ['get_approval'],
      firstToolError: 'Error: approval 4242 expired',
      processedMessageIds: ['input-0'],
    });
    expect(byMessage.get('input-0')).not.toHaveProperty('repliedInBand');
    expect(byMessage.get('input-1')).toMatchObject({
      finalText: 'input 1 answered',
      processedMessageIds: ['input-1'],
    });
    expect(byMessage.get('input-1')).not.toHaveProperty('toolsUsed');
    expect(byMessage.get('input-1')).not.toHaveProperty('firstToolError');

    // Tool traces route under their initiating input's message, including the
    // delayed async result that names its input explicitly.
    const traces = delivered.filter((row) => (row.action_input.customEvent as { name?: string } | undefined)?.name === 'tool_use');
    expect(traces).toHaveLength(3);
    const traceByCall = new Map(traces.map((row) => [
      (row.action_input.customEvent as { data: { toolCallId: string } }).data.toolCallId,
      row.action_input.messageId as string,
    ]));
    expect(traceByCall.get('c-owner')).toBe('msg-turn');
    expect(traceByCall.get('c-delayed')).toBe('input-0');
    expect(traceByCall.get('c-other')).toBe('input-1');
  });

  it('never invents approval linkage from prose or JID digits', async () => {
    const { sql, body } = await inputScenario();
    const jid = '905547406260';
    // The field shape: Draft requested, only Send ran, and the reply quotes a
    // phone/JID as a run id.
    const invented = await postAsFleet('/api/workers/complete-agent-turn', {
      ...body,
      text: `Draft attempted, pending approval ${jid}.`,
      tools_used: ['send_message'],
    });
    expect(await invented.json()).toEqual({ ok: true, status: 'completed' });
    const delivered = await threadResponseRows();
    const owner = delivered
      .map((row) => row.action_input)
      .find((payload) => payload.messageId === 'msg-turn' && Array.isArray(payload.processedMessageIds));
    // The durable ledger names the action that actually ran — Send, not Draft
    // — and keeps the verbatim send error. No structured receipt exists for
    // the quoted digits, so nothing downstream may treat them as an approval.
    expect(owner).toMatchObject({ toolsUsed: ['send_message'], firstToolError: SEND_ERROR });
    const approvals = await sql`SELECT id FROM current_event_records WHERE interaction_type = 'approval' AND run_id = ${Number(jid)}`;
    expect(approvals).toHaveLength(0);
    // The turn prompt itself forbids deriving run ids from digits in the
    // conversation rather than from returned tool receipts.
    expect(renderBaselineAgentPolicy()).toMatch(/only when a tool result .* returned that exact id/i);
    expect(renderBaselineAgentPolicy()).toMatch(/phone number.*message id|message id.*phone number/i);
  });

  it('stores an idempotent retry once and rejects conflicting content without a second terminal', async () => {
    const { body } = await inputScenario();
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', body)).json())
      .toEqual({ ok: true, status: 'completed' });
    const before = await threadResponseRows();
    expect(before).toHaveLength(6);
    // Exact retry: acknowledged, nothing stored twice.
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', body)).json())
      .toEqual({ ok: true, status: 'completed', idempotent: true });
    expect(await threadResponseRows()).toHaveLength(6);
    // Conflicting retry (changed answer after the seal): rejected with a
    // conflict, never a second terminal and never a re-send.
    const conflict = {
      ...body,
      text: 'Rewritten owner answer.',
      consumed_inputs: (body.consumed_inputs as Array<Record<string, unknown>>).map((receipt) => ({ ...receipt, response_text: 'rewritten' })),
    };
    const rejected = await postAsFleet('/api/workers/complete-agent-turn', conflict);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: expect.stringMatching(/conflict/i) });
    const after = await threadResponseRows();
    expect(after).toHaveLength(6);
    const finals = after
      .map((row) => row.action_input)
      .filter((payload) => Array.isArray(payload.processedMessageIds))
      .map((payload) => payload.finalText);
    expect(finals).toEqual(expect.arrayContaining(['Owner answer with authorization issues.', 'input 0 answered', 'input 1 answered']));
    expect(finals).not.toContain('Rewritten owner answer.');
  });

  it('fails honestly when a follower is lost before delivery, with no partial outbox', async () => {
    const { sql, followers, body } = await inputScenario();
    // A cancel/reaper race terminalizes the follower first. The receipt no
    // longer matches the offered pending prefix, so validation fails the turn;
    // a cancel landing even later (between the offer read and the row lock)
    // trips the dedicated lost-input guard instead. Either way the owner lands
    // failed with one error terminal, nothing is delivered for inputs the turn
    // can no longer attribute, and the survivor stays pending for next turn.
    await sql`UPDATE runs SET status = 'cancelled' WHERE id = ${followers[1].id}`;
    const response = await postAsFleet('/api/workers/complete-agent-turn', body);
    expect(await response.json()).toMatchObject({ ok: true, status: 'failed' });
    // Known tool traces still explain the failure; the trace explicitly tied
    // to the vanished input is quarantined rather than misattributed. Exactly
    // one terminal row exists.
    const delivered = await threadResponseRows();
    const terminals = delivered.filter((row) => Array.isArray(row.action_input.processedMessageIds));
    expect(terminals).toHaveLength(1);
    expect(terminals[0].action_input.error).toMatch(/invalid consumed input receipts|lost a consumed input/);
    expect(delivered).toHaveLength(2);
    const states = await sql`SELECT id, status FROM runs WHERE id IN (${followers[0].id}, ${followers[1].id}) ORDER BY id`;
    expect(states).toEqual([
      { id: followers[0].id, status: 'pending' },
      { id: followers[1].id, status: 'cancelled' },
    ]);
  });

  it('rolls back owner, input receipts, snapshot and delivery together', async () => {
    const { sql, owner, body } = await inputScenario();
    const realDb = db.getDb();
    const broken = new Proxy(realDb, {
      get(target, property) {
        if (property === 'begin') return (fn: (tx: db.DbClient) => Promise<unknown>) => target.begin((tx) => fn(new Proxy(tx, {
          apply(query, thisArg, args: unknown[]) {
            if (Array.from(args[0] as TemplateStringsArray).join(' ').includes("outcome = 'scoreable'")) throw new Error('synthetic input commit failure');
            return Reflect.apply(query, thisArg, args);
          },
        })));
        return Reflect.get(target, property);
      },
    });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(broken);
    try { expect((await postAsFleet('/api/workers/complete-agent-turn', body)).status).toBe(500); }
    finally { spy.mockRestore(); }
    expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['running', 'pending', 'pending']);
    expect(await sql`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${owner.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM runs WHERE queue_name = 'thread_response'`).toHaveLength(0);
    expect((await (await postAsFleet('/api/workers/complete-agent-turn', body)).json()).status).toBe('completed');
  });

  it('drains receipts without per-input text as one execution-wide reply', async () => {
    const { sql, body } = await inputScenario();
    const legacy = {
      ...body,
      tools_used: ['send_message'],
      consumed_inputs: (body.consumed_inputs as Array<Record<string, unknown>>)
        .map(({ response_text: _dropped, tools_used: _tools, first_error: _error, ...receipt }) => receipt),
    };
    delete (legacy as Record<string, unknown>).first_error;
    delete (legacy as Record<string, unknown>).replied_in_band;
    delete (legacy as Record<string, unknown>).turn_tool_events;
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', legacy)).json())
      .toEqual({ ok: true, status: 'completed' });
    // Old claims keep the old contract: a single owner row covering every
    // message, execution-wide tools, followers carrying the execution text.
    const delivered = await threadResponseRows();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].action_input).toMatchObject({
      finalText: 'Owner answer with authorization issues.',
      toolsUsed: ['send_message'],
      processedMessageIds: ['msg-turn', 'input-0', 'input-1'],
    });
    const tails = await sql`SELECT output_tail FROM runs WHERE run_type = 'agent_turn' AND status = 'completed' ORDER BY id`;
    expect(tails.map((row) => row.output_tail)).toEqual([
      'Owner answer with authorization issues.',
      'Owner answer with authorization issues.',
      'Owner answer with authorization issues.',
    ]);
  });

  it('stores an exact tool-event retry once, keyed by conversation/input/call', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id));
    const [owner] = await agentTurnRuns();
    const worker_id = 'fleet-tool-retry';
    await (await pollFleet(worker_id, { agent_turn: true })).json();
    const events = [
      { tool_call_id: 'dup-1', name: 'send_message', is_error: false, output: 'ok' },
      { tool_call_id: 'dup-2', name: 'get_approval', is_error: true, output: SEND_ERROR },
    ];
    const first = await postAsFleet('/api/workers/heartbeat', { run_id: owner.id, worker_id, turn_tool_events: events });
    expect(await first.json()).toMatchObject({ turn_tool_ack: { received: 2 } });
    // The retry carries the same canonical traces: recognised as exact
    // duplicates — acknowledged, but stored only once.
    const retry = await postAsFleet('/api/workers/heartbeat', { run_id: owner.id, worker_id, turn_tool_events: events });
    expect(await retry.json()).toMatchObject({ turn_tool_ack: { received: 2 } });
    const delivered = await threadResponseRows();
    expect(delivered.filter((row) =>
      (row.action_input.customEvent as { name?: string } | undefined)?.name === 'tool_use')).toHaveLength(2);
  });

  it('rejects a conflicting same-key tool trace with no ack and no second row', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id));
    const [owner] = await agentTurnRuns();
    const worker_id = 'fleet-tool-conflict';
    await (await pollFleet(worker_id, { agent_turn: true })).json();
    const first = await postAsFleet('/api/workers/heartbeat', {
      run_id: owner.id, worker_id,
      turn_tool_events: [{ tool_call_id: 'c1', name: 'send_message', is_error: false, output: 'ok' }],
    });
    expect(await first.json()).toMatchObject({ turn_tool_ack: { received: 1 } });
    // Same canonical key (same conversation/input/call), different trace body:
    // the publish throws, the beat carries no ack, the worker retries rather
    // than retiring the evidence — and nothing is stored twice.
    const conflict = await postAsFleet('/api/workers/heartbeat', {
      run_id: owner.id, worker_id,
      turn_tool_events: [{ tool_call_id: 'c1', name: 'a_different_tool', is_error: true, output: 'changed' }],
    });
    const conflictBody = await conflict.json();
    expect(conflictBody).not.toHaveProperty('turn_tool_ack');
    const delivered = await threadResponseRows();
    const traces = delivered.filter((row) =>
      (row.action_input.customEvent as { name?: string } | undefined)?.name === 'tool_use');
    expect(traces).toHaveLength(1);
    expect((traces[0].action_input.customEvent as { data: { name: string } }).data.name).toBe('send_message');
  });

  it('acknowledges an exact completion retry and rejects a conflicting one', async () => {
    const { body } = await inputScenario();
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', body)).json())
      .toEqual({ ok: true, status: 'completed' });
    // Byte-identical retry: acknowledged, nothing stored twice.
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', body)).json())
      .toEqual({ ok: true, status: 'completed', idempotent: true });
    expect(await threadResponseRows()).toHaveLength(6);
    // Same run, rewritten terminal claim: 409, no second terminal.
    const conflict = await postAsFleet('/api/workers/complete-agent-turn', { ...body, status: 'failed', error: 'lost response' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: expect.stringMatching(/conflict/i) });
    expect(await threadResponseRows()).toHaveLength(6);
  });

  it('acknowledges stored tool traces on the heartbeat and nothing on a liveness beat', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id));
    const [owner] = await agentTurnRuns();
    const worker_id = 'fleet-heartbeat-ack';
    await (await pollFleet(worker_id, { agent_turn: true })).json();
    const traced = await postAsFleet('/api/workers/heartbeat', {
      run_id: owner.id, worker_id,
      turn_tool_events: [
        { tool_call_id: 'h1', name: 'send_message', is_error: false, output: 'ok' },
        { tool_call_id: 'h2', name: 'get_approval', is_error: true, output: SEND_ERROR },
      ],
    });
    const ack = await traced.json();
    // Explicit post-commit acknowledgement for the substantive receipts.
    expect(ack.turn_tool_ack).toEqual({ received: 2 });
    const delivered = await threadResponseRows();
    expect(delivered.filter((row) =>
      (row.action_input.customEvent as { name?: string } | undefined)?.name === 'tool_use')).toHaveLength(2);
    // A liveness-only beat succeeds without acknowledging any receipt.
    const silent = await (await postAsFleet('/api/workers/heartbeat', { run_id: owner.id, worker_id })).json();
    expect(silent.continue).toBe(true);
    expect(silent).not.toHaveProperty('turn_tool_ack');
  });

  it('a reaped turn and a late completion produce exactly one terminal', async () => {
    const { body } = await inputScenario();
    // The worker dies mid-turn; the stale sweep terminalizes the owner. A
    // threshold of zero treats the just-claimed heartbeat as lapsed.
    const swept = await sweepStaleAgentTurnRuns(0);
    expect(swept.reaped).toBeGreaterThanOrEqual(1);
    expect(await threadResponseRows()).toHaveLength(1);
    // The late worker completion is acknowledged as a duplicate and stores
    // nothing further — no second terminal, no re-send.
    const late = await postAsFleet('/api/workers/complete-agent-turn', body);
    expect(await late.json()).toEqual({ ok: true, status: 'failed', idempotent: true });
    expect(await threadResponseRows()).toHaveLength(1);
  });

  it('recovers retained rows in any delivery state, scoped by org, never synthesizing pruned facts', async () => {
    const { sql, body } = await inputScenario();
    expect(await (await postAsFleet('/api/workers/complete-agent-turn', body)).json())
      .toEqual({ ok: true, status: 'completed' });
    // Delivery states change under the rows; the retained facts stay readable.
    // (Runs retention holds terminal rows ~30d by default — deployed config
    // unverified, so recovery promises retained facts, never permanence.)
    await sql`UPDATE runs SET status = 'claimed' WHERE queue_name = 'thread_response'
      AND action_input->>'messageId' = 'input-0'`;
    await sql`UPDATE runs SET status = 'failed' WHERE queue_name = 'thread_response'
      AND action_input->>'messageId' = 'input-1'`;
    const orgId = (await agentTurnRuns())[0].organization_id;
    const recovered = await sql`SELECT action_input->>'messageId' AS message_id, action_input->>'finalText' AS final_text
      FROM runs WHERE organization_id = ${orgId} AND run_type = 'chat_message' AND queue_name = 'thread_response'
        AND status IN ('pending', 'claimed', 'completed', 'failed')
        AND action_input ? 'processedMessageIds' ORDER BY id`;
    expect(recovered.map((row) => [row.message_id, row.final_text])).toEqual([
      ['msg-turn', 'Owner answer with authorization issues.'],
      ['input-0', 'input 0 answered'],
      ['input-1', 'input 1 answered'],
    ]);
    // Another tenant's scope reads nothing.
    const foreign = await sql`SELECT id FROM runs WHERE organization_id = ${'00000000-0000-0000-0000-000000000000'}
      AND queue_name = 'thread_response' AND action_input->>'conversationId' = 'conv-turn'`;
    expect(foreign).toHaveLength(0);
    // A pruned row reads as missing — the caller reports unavailable/expired
    // for that input rather than presenting the survivors as complete history.
    await sql`DELETE FROM runs WHERE queue_name = 'thread_response' AND action_input->>'messageId' = 'input-1'`;
    const afterPrune = await sql`SELECT action_input->>'messageId' AS message_id FROM runs
      WHERE organization_id = ${orgId} AND queue_name = 'thread_response' AND action_input ? 'processedMessageIds' ORDER BY id`;
    expect(afterPrune.map((row) => row.message_id)).toEqual(['msg-turn', 'input-0']);
  });
});
