import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateWorkerToken, verifyWorkerToken } from '@lobu/core';

let rows: Array<{ status: string; credential: string }> = [];
const query = mock(async (strings: TemplateStringsArray) => strings.join('').includes('revoked_tokens') ? [] : rows);
const sql = Object.assign(query, {
  begin: async (callback: (tx: typeof query) => Promise<void>) => callback(query),
});
const realDb = { ...await import('../../db/client') };
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
mock.module('../../db/client', () => ({ ...realDb, getDb: () => sql }));
const { markAgentTurnToolStarted, StaleAgentTurnAttemptError } = await import('../../runs/agent-turn-inputs');
const { agentTurnTokenScope } = await import('../../gateway/orchestration/deployment-identity');
const { WorkerGateway } = await import('../../gateway/worker-dispatch/worker-gateway');
afterAll(() => {
  mock.module('../../db/client', () => realDb);
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

function token() {
  return generateWorkerToken('test-user', 'test-conversation', agentTurnTokenScope('test-message'), {
    channelId: 'test-channel', organizationId: 'test-org', agentId: 'test-agent', platform: 'api', runId: 1, messageId: 'test-message',
  });
}

describe('agent turn tool attempt fence', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    rows = [];
    query.mockClear();
  });

  test('refuses an old credential after a different attempt claims the same run', async () => {
    const oldClaims = verifyWorkerToken(token())!;
    rows = [{ status: 'running', credential: token() }];
    await expect(markAgentTurnToolStarted(oldClaims)).rejects.toBeInstanceOf(StaleAgentTurnAttemptError);
  });

  test('refuses a turn credential whose run no longer exists', async () => {
    await expect(markAgentTurnToolStarted(verifyWorkerToken(token())!)).rejects.toBeInstanceOf(StaleAgentTurnAttemptError);
  });

  test.each(['pending', 'timeout', 'completed', 'cancelled'])('refuses a %s turn', async (status) => {
    const credential = token();
    rows = [{ status, credential }];
    await expect(markAgentTurnToolStarted(verifyWorkerToken(credential)!)).rejects.toBeInstanceOf(StaleAgentTurnAttemptError);
  });

  test('allows the current running attempt', async () => {
    const credential = token();
    rows = [{ status: 'running', credential }];
    await expect(markAgentTurnToolStarted(verifyWorkerToken(credential)!)).resolves.toBeUndefined();
  });

  test('allows a refreshed token for the current attempt', async () => {
    const credential = token();
    rows = [{ status: 'running', credential }];
    const gateway = new WorkerGateway({} as never, 'https://gateway.test', {} as never, {} as never);
    const response = await gateway.getApp().request('/token/refresh', {
      method: 'POST', headers: { authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(200);
    const refreshed = (await response.json()) as { token: string };
    expect(refreshed.token).not.toBe(credential);
    await expect(markAgentTurnToolStarted(verifyWorkerToken(refreshed.token)!)).resolves.toBeUndefined();
    rows = [{ status: 'running', credential: token() }];
    await expect(markAgentTurnToolStarted(verifyWorkerToken(refreshed.token)!)).rejects.toBeInstanceOf(StaleAgentTurnAttemptError);
  });
});
