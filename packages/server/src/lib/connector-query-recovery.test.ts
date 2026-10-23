import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const resolveAuth = vi.fn();
let query: typeof import('./connector-pushdown').runConnectorQuery;
const result = { mode: 'query', rows: [{ probe: 1 }], columns: [] };
const auth = (token: string | null) => ({
  credentials: token ? { provider: 'synthetic-oauth', accessToken: token } : null,
  connectionCredentials: {}, sessionState: null,
});

beforeAll(async () => {
  vi.resetModules();
  const sql = async () => [{ id: 17, connector_key: 'synthetic-source', auth_profile_id: 1, app_auth_profile_id: 2 }];
  vi.doMock('../db/client', async () => ({ ...await vi.importActual('../db/client'), getDb: () => sql }));
  vi.doMock('../utils/ensure-connector-installed', () => ({ resolveConnectorCodeForKey: async () => 'synthetic-code' }));
  vi.doMock('../utils/execution-context', async () => ({
    ...await vi.importActual('../utils/execution-context'), resolveExecutionAuth: resolveAuth,
  }));
  vi.doMock('@lobu/connector-worker/executor/runtime', () => ({ executeCompiledConnector: execute }));
  query = (await import('./connector-pushdown')).runConnectorQuery;
});

afterAll(() => {
  for (const path of ['../db/client', '../utils/ensure-connector-installed', '../utils/execution-context', '@lobu/connector-worker/executor/runtime']) vi.doUnmock(path);
  vi.resetModules();
});

beforeEach(() => {
  vi.resetAllMocks();
  resolveAuth.mockResolvedValueOnce(auth('synthetic-old-token')).mockResolvedValue(auth('synthetic-fresh-token'));
  execute.mockResolvedValue(result);
});

function read(deadlineAt?: number) {
  return query({ scope: { organizationId: 'synthetic-org', principal: 'synthetic-owner' },
    isAdmin: true, connectionSlug: 'synthetic-source', query: 'SELECT 1', deadlineAt });
}
const failure = (status: number) => Object.assign(new Error('opaque upstream failure'), { httpStatus: status });

describe('read-only source query recovery', () => {
  it('refreshes an explicitly rejected token once and retries with the fresh token', async () => {
    execute.mockRejectedValueOnce(failure(401));
    expect((await read()).rows).toEqual([{ probe: 1 }]);
    expect(resolveAuth).toHaveBeenLastCalledWith(expect.objectContaining({ rejectedAccessToken: 'synthetic-old-token' }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0].job.credentials.accessToken).toBe('synthetic-fresh-token');
  });

  it('does not loop when the refreshed token is rejected', async () => {
    execute.mockRejectedValue(failure(401));
    await expect(read()).rejects.toMatchObject({ httpStatus: 401 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not retry with missing or unchanged credentials', async () => {
    for (const token of [null, 'synthetic-old-token']) {
      resolveAuth.mockReset().mockResolvedValueOnce(auth('synthetic-old-token')).mockResolvedValue(auth(token));
      execute.mockReset().mockRejectedValue(failure(401));
      await expect(read()).rejects.toMatchObject({ httpStatus: 401 });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a transient gateway failure once without refreshing credentials', async () => {
    execute.mockRejectedValueOnce(failure(502));
    await expect(read()).resolves.toMatchObject({ rows: [{ probe: 1 }] });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(resolveAuth).toHaveBeenCalledTimes(1);
  });

  it('does not retry permanent refusals or unstructured errors', async () => {
    for (const error of [failure(403), new Error('upstream HTTP 401')]) {
      execute.mockReset().mockRejectedValue(error);
      await expect(read()).rejects.toBe(error);
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a single caller deadline across attempts', async () => {
    execute.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 30)); throw failure(502); });
    await read(Date.now() + 1000);
    expect(execute.mock.calls[1][0].timeoutMs).toBeLessThan(execute.mock.calls[0][0].timeoutMs);
  });
});
