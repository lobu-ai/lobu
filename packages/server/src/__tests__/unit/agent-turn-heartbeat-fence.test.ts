import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateWorkerToken } from '@lobu/core';
import { Hono } from 'hono';

let originalCredential: string;
let currentCredential: string;
let effects: string[];
let inTransaction = false;
const query = (strings: TemplateStringsArray) => {
  const statement = strings.join('');
  // The preliminary read sees the old attempt; the reaper rotates it before
  // this heartbeat acquires the conversation/row lock.
  if (statement.includes("SELECT run_type, action_input->>'credential'")) {
    return [{ run_type: 'agent_turn', credential: originalCredential }];
  }
  // The marker extension's plain (unlocked) read of the turn envelope.
  if (statement.includes('SELECT id, organization_id, action_input')) {
    return [{ id: 1, organization_id: 'test-org', action_input: {
      credential: currentCredential,
      turn: { agent_id: 'test-agent', conversation_id: 'test-conversation' },
      reply: { message_id: 'test-message', user_id: 'test-user', channel_id: 'test-channel', platform: 'api' },
    } }];
  }
  if (statement.includes('SELECT organization_id, action_input')) {
    return [{ organization_id: 'test-org', agent_id: 'test-agent', conversation_id: 'test-conversation' }];
  }
  if (statement.includes('ORDER BY id FOR UPDATE')) {
    return [{ id: 1, status: 'running', claimed_by: 'same-worker', organization_id: 'test-org',
      action_input: {
        credential: currentCredential,
        turn: { agent_id: 'test-agent', conversation_id: 'test-conversation' },
        reply: { message_id: 'test-message', user_id: 'test-user', channel_id: 'test-channel', platform: 'api' },
      }, run_metadata: {} }];
  }
  if (statement.includes('SELECT action_input, organization_id')) {
    return [{ organization_id: 'test-org', action_input: {
      turn: { conversation_id: 'test-conversation' },
      reply: { message_id: 'test-message', user_id: 'test-user', channel_id: 'test-channel', platform: 'api' },
    } }];
  }
  if (/UPDATE|INSERT/.test(statement)) {
    // The generic heartbeat update excludes agent turns, then retries under
    // the native turn lock. Only the second write could touch this run.
    if (statement.includes('last_heartbeat_at') && !inTransaction) return [];
    effects.push(statement);
    return [{ id: 1, run_type: 'agent_turn' }];
  }
  return [];
};
const sql = Object.assign(query, {
  json: (value: unknown) => value,
  unsafe: async (statement: string) => { effects.push(statement); return []; },
  begin: async (callback: (tx: typeof query) => Promise<unknown>) => {
    inTransaction = true;
    try { return await callback(query); }
    finally { inTransaction = false; }
  },
});
const realDb = { ...await import('../../db/client') };
mock.module('../../db/client', () => ({ ...realDb, getDb: () => sql }));
const { publishTurnDeltaBestEffort, publishTurnToolEventsBestEffort, publishTurnStatusBestEffort } = await import('../../worker-api/agent-turn');
const { heartbeat } = await import('../../worker-api/run-lifecycle');
const { extendHeartbeatedTurnMarker } = await import('../../runs/agent-turn-inputs');
const { agentTurnTokenScope } = await import('../../gateway/orchestration/deployment-identity');
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
afterAll(() => {
  mock.module('../../db/client', () => realDb);
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe('heartbeat attempt fence', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const mint = () => generateWorkerToken('test-user', 'test-conversation', agentTurnTokenScope('test-message'), {
      channelId: 'test-channel', organizationId: 'test-org', agentId: 'test-agent', runId: 1, messageId: 'test-message',
    });
    originalCredential = mint();
    currentCredential = mint();
    effects = [];
  });

  test('a re-claim during a heartbeat cannot refresh the replacement attempt', async () => {
    const app = new Hono();
    app.post('/heartbeat', heartbeat);
    const response = await app.request('/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 1, worker_id: 'same-worker', turn_credential: originalCredential }),
    });
    expect(response.status).toBe(409);
    expect(effects).toEqual([]);
  });

  test('a retired attempt cannot advance the delta sequence', async () => {
    await publishTurnDeltaBestEffort(1, 'same-worker', { text: 'stale', sequence: 1 }, originalCredential);
    expect(effects).toEqual([]);
  });

  test('a retired attempt cannot publish tool traces or status', async () => {
    await publishTurnToolEventsBestEffort(1, 'same-worker', [{ tool_call_id: 'old-call', name: 'read', is_error: false, output: 'ok' }], originalCredential);
    await publishTurnStatusBestEffort(1, 'same-worker', originalCredential);
    expect(effects).toEqual([]);
  });

  test('the current attempt can publish tool traces and status', async () => {
    expect(await publishTurnToolEventsBestEffort(1, 'same-worker', [{ tool_call_id: 'current-call', name: 'read', is_error: false, output: 'ok' }], currentCredential)).toBe(1);
    await publishTurnStatusBestEffort(1, 'same-worker', currentCredential);
    expect(effects.filter((statement) => statement.includes('INSERT INTO public.runs'))).toHaveLength(2);
  });

  test('a deferred marker extension checks the attempt again', async () => {
    await extendHeartbeatedTurnMarker(1, originalCredential);
    expect(effects).toEqual([]);
    await extendHeartbeatedTurnMarker(1, currentCredential);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain('SET run_at');
  });
});
