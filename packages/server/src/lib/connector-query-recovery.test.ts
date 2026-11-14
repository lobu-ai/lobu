import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const resolveAuth = vi.fn();
const resolveCode = vi.fn();
const adapterRead = vi.fn();
const browserGrant = vi.fn();
let query: typeof import('./connector-pushdown').runConnectorQuery;
let readFeed: typeof import('./connector-pushdown').readSourceFeed;
let admission: typeof import('./source-admission').sourceAdmission;
const result = { mode: 'query', rows: [{ probe: 1 }], columns: [] };
const auth = (token: string | null) => ({
  credentials: token ? { provider: 'synthetic-oauth', accessToken: token } : null,
  connectionCredentials: {}, sessionState: null,
});

beforeAll(async () => {
  vi.resetModules();
  const sql = Object.assign(
    async () => [{ id: 17, connector_key: 'synthetic-source', auth_profile_id: 1, app_auth_profile_id: 2 }],
    { unsafe: async () => [{
      id: 1, feed_key: 'items', connection_id: 17, connector_key: 'synthetic-source',
      device_worker_id: null, feed_status: 'active', feed_operations: ['read'],
      has_compiled_code: true, config: {}, connection_config: {}, runtime: null,
    }] },
  );
  vi.doMock('../db/client', async () => ({ ...await vi.importActual('../db/client'), getDb: () => sql }));
  vi.doMock('../utils/ensure-connector-installed', () => ({ resolveConnectorCodeForKey: resolveCode }));
  vi.doMock('../utils/execution-context', async () => ({
    ...await vi.importActual('../utils/execution-context'), resolveExecutionAuth: resolveAuth,
  }));
  vi.doMock('./source-feed-adapters', () => ({ readSourceFeedFromAdapter: adapterRead }));
  vi.doMock('../connectors/browser-resource', async () => ({
    ...await vi.importActual('../connectors/browser-resource'), connectionBrowserGrant: browserGrant,
  }));
  vi.doMock('@lobu/connector-worker/executor/runtime', () => ({ executeCompiledConnector: execute }));
  const pushdown = await import('./connector-pushdown');
  query = pushdown.runConnectorQuery;
  readFeed = pushdown.readSourceFeed;
  admission = (await import('./source-admission')).sourceAdmission;
});

afterAll(() => {
  for (const path of ['../db/client', '../utils/ensure-connector-installed', '../utils/execution-context', './source-feed-adapters', '../connectors/browser-resource', '@lobu/connector-worker/executor/runtime']) vi.doUnmock(path);
  vi.resetModules();
});

beforeEach(() => {
  vi.resetAllMocks();
  resolveCode.mockResolvedValue('synthetic-code');
  adapterRead.mockResolvedValue(null);
  browserGrant.mockResolvedValue(undefined);
  resolveAuth.mockResolvedValueOnce(auth('synthetic-old-token')).mockResolvedValue(auth('synthetic-fresh-token'));
  execute.mockImplementation(async ({ job }) => ({ ...result, mode: job.mode }));
});

function read(deadlineAt?: number, options: Partial<Parameters<typeof query>[0]> = {}) {
  return query({ scope: { organizationId: 'synthetic-org', principal: 'synthetic-owner' },
    isAdmin: true, connectionSlug: 'synthetic-source', query: 'SELECT 1', deadlineAt, callerClass: 'member', ...options });
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

  it('recovers once inside a read shared by identical concurrent callers', async () => {
    execute.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 30)); throw failure(401); });
    const results = await Promise.all([read(), read(), read()]);
    expect(results.map(r => r.rows)).toEqual([[{ probe: 1 }], [{ probe: 1 }], [{ probe: 1 }]]);
    // Each caller owns its rows; the shared run is not handed out by reference.
    expect(results[0].rows).not.toBe(results[1].rows);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(resolveAuth).toHaveBeenCalledTimes(2);
  });

  it('keeps a single caller deadline across attempts', async () => {
    execute.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 30)); throw failure(502); });
    await read(Date.now() + 1000);
    expect(execute.mock.calls[1][0].timeoutMs).toBeLessThan(execute.mock.calls[0][0].timeoutMs);
  });
});

describe('source admission through live read entrypoints', () => {
  it('lets a member use the reserved slot while an identical anonymous read is queued', async () => {
    const held = await Promise.all(Array.from({ length: 3 }, () => admission.acquire(17, {
      callerClass: 'anonymous', deadlineAt: Date.now() + 20_000,
    })));
    const visitor = read(Date.now() + 2150, { callerClass: 'anonymous' }).catch(error => error);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await read(Date.now() + 20_000)).rows).toEqual([{ probe: 1 }]);
    } finally {
      for (const slot of held) slot.release({ rateLimited: false });
      await visitor;
    }
  });

  describe.each(['deadline', 'abort'] as const)('%s during preparation', (termination) => {
    it.each([
      ['query', 'code'], ['query', 'credentials'], ['query', 'refresh'],
      ['feed', 'adapter'], ['feed', 'code'], ['feed', 'credentials'], ['feed', 'browser grant'],
    ] as const)('releases %s slots stalled at %s and never starts late connector work', async (mode, stage) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let resume!: (value: unknown) => void;
      const blocked = new Promise(resolve => { resume = resolve; });
      let ranAfterAbort = false;
      execute.mockImplementation(async ({ job, hooks }) => {
        ranAfterAbort ||= hooks.signal.aborted;
        if (stage === 'refresh') throw failure(401);
        return { ...result, mode: job.mode };
      });
      if (stage === 'code') resolveCode.mockReturnValue(blocked);
      if (stage === 'credentials') resolveAuth.mockReset().mockReturnValue(blocked);
      if (stage === 'adapter') adapterRead.mockReturnValue(blocked);
      if (stage === 'browser grant') browserGrant.mockReturnValue(blocked);
      if (stage === 'refresh') resolveAuth.mockReset().mockImplementation(params =>
        params.rejectedAccessToken ? blocked : Promise.resolve(auth('synthetic-old-token')));
      const outcomes: unknown[] = [];
      const pending = Array.from({ length: 4 }, (_, index) => {
        const deadlineAt = Date.now() + (termination === 'deadline' ? 25 : 20_000);
        const read = mode === 'query'
          ? query({ scope: { organizationId: 'synthetic-org', principal: 'synthetic-owner' },
            isAdmin: true, connectionSlug: 'synthetic-source', query: `SELECT ${index}`,
            callerClass: 'member', deadlineAt, signal: controller.signal })
          : readFeed({ scope: { organizationId: 'synthetic-org', principal: 'synthetic-owner', chatAccess: 'member' },
            feedId: 1, deadlineAt, signal: controller.signal });
        return read.catch(error => { outcomes.push(error); });
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        if (termination === 'abort') controller.abort(new Error('caller left'));
        await vi.advanceTimersByTimeAsync(30);
        expect(outcomes).toHaveLength(4);
        for (const error of outcomes) expect(error).toMatchObject(termination === 'deadline'
          ? { exitReason: 'timeout' } : { message: 'caller left' });

        resolveCode.mockResolvedValue('synthetic-code');
        resolveAuth.mockReset().mockResolvedValue(auth('synthetic-fresh-token'));
        adapterRead.mockResolvedValue(null);
        browserGrant.mockResolvedValue(undefined);
        execute.mockImplementation(async ({ job, hooks }) => {
          ranAfterAbort ||= hooks.signal.aborted;
          return { ...result, mode: job.mode };
        });
        expect((await read(Date.now() + 25, { query: 'SELECT 99' })).rows).toEqual([{ probe: 1 }]);
      } finally {
        resume(stage === 'code' ? 'synthetic-code'
          : stage === 'adapter' ? null : stage === 'browser grant' ? undefined : auth('synthetic-fresh-token'));
        await vi.advanceTimersByTimeAsync(0);
        await Promise.all(pending);
        vi.useRealTimers();
      }
      expect(ranAfterAbort).toBe(false);
    });
  });
});
