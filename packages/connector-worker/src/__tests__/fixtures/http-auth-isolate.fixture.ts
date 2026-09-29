import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CONNECTOR_HTTP_MAX_BYTES, type ConnectorHttpRequest, type ConnectorHttpResponse } from '@lobu/core/contracts/worker/protocol';
import type { ExecutorClient, PollResponse } from '../../daemon/client.js';
import { executeRun } from '../../daemon/executor.js';
import { IsolateExecutor, type IsolateExecutorOptions } from '../../executor/isolate.js';
import type { ExecutionHooks, ExecutorJob } from '../../executor/interface.js';

const job: ExecutorJob = {
  mode: 'action', actionKey: 'read', actionInput: {}, config: {},
  credentials: null, sessionState: null, env: {}, httpAuth: true,
};
const reply = (body = ''): ConnectorHttpResponse => ({
  status: 200, statusText: 'OK', headers: { 'content-type': 'application/octet-stream' },
  body: Buffer.from(body).toString('base64'),
});
const code = (body: string) => `module.exports.default = class { sync() {} async execute(ctx) { ${body} } };`;
const run = (body: string, hooks: ExecutionHooks, options: Partial<IsolateExecutorOptions> = {}, bound = true) =>
  new IsolateExecutor({ timeoutMs: 5_000, ...options }).execute(code(body), { ...job, httpAuth: bound }, hooks);

for (const mode of ['sync', 'action'] as const) {
  test(`the ${mode} daemon path forwards the flag and current run hook`, async () => {
    const request: ConnectorHttpRequest = { url: 'https://service.example/read', method: 'GET', headers: {} };
    const response = reply('ok');
    const calls: unknown[] = [];
    const completed: unknown[] = [];
    const client = {
      id: 'synthetic-worker',
      async heartbeat() { return { continue: true }; },
      async complete(result: unknown) { completed.push(result); },
      async completeAction(result: unknown) { completed.push(result); },
      async httpFetch(runId: number, req: ConnectorHttpRequest, signal?: AbortSignal) {
        calls.push({ runId, req, signal });
        return response;
      },
    } as unknown as ExecutorClient;
    const signal = new AbortController().signal;
    const result = await executeRun(client, {
      run_id: 73, run_type: mode, connector_key: 'synthetic-http', compiled_code: 'fixture',
      feed_id: 12, feed_key: 'items', action_key: 'read', config: {}, http_auth: true,
    } as PollResponse, {}, {
      generateEmbeddings: false,
      executor: { async execute(_code, runJob, hooks) {
        assert.equal(runJob.httpAuth, true);
        assert.deepEqual(await hooks!.onHttpFetch!(request, signal), response);
        return mode === 'sync' ? { mode: 'sync', status: 'complete' } : { mode: 'action', output: {} };
      } },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(calls, [{ runId: 73, req: request, signal }]);
    assert.equal(completed.length, 1);
  });
}

test('bound fetch crosses the native isolate as bytes and exposes no host hook', async () => {
  let calls = 0;
  const result = await run(`
    const response = await fetch('https://service.example/read', {
      method: 'POST', headers: { 'X-Request': 'synthetic' }, body: new Uint8Array([0, 255, 128, 10])
    });
    return { success: true, output: {
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())), status: response.status,
      header: response.headers.get('x-reply'), url: response.url,
      credential: ctx.credentials, hook: typeof ctx.onHttpFetch,
      token: typeof process === 'undefined' ? null : process.env.WORKER_API_TOKEN ?? null
    }};
  `, { onHttpFetch: async (request, signal) => {
    calls++;
    assert.deepEqual(request, {
      url: 'https://service.example/read', method: 'POST', headers: { 'x-request': 'synthetic' }, body: 'AP+ACg==',
    });
    assert.ok(signal instanceof AbortSignal);
    return { status: 201, statusText: 'Created', headers: { 'X-Reply': 'gateway' }, body: 'AID/' };
  }});
  assert.equal(calls, 1);
  assert.deepEqual(result, { mode: 'action', output: {
    bytes: [0, 128, 255], status: 201, header: 'gateway', url: 'https://service.example/read',
    credential: null, hook: 'undefined', token: null,
  }});
});

test('gateway rejection is terminal for that fetch and never falls back to local egress', async () => {
  let calls = 0;
  await assert.rejects(run(`await fetch('https://service.example/read'); return { success: true };`, {
    onHttpFetch: async () => { calls++; throw new Error('synthetic lease revoked'); },
  }), /synthetic lease revoked/);
  assert.equal(calls, 1);
});

test('bound requests retain the host domain restriction and require HTTPS', async () => {
  let calls = 0;
  const hooks: ExecutionHooks = { onHttpFetch: async () => { calls++; return reply(); } };
  await assert.rejects(run(`await fetch('https://service.example/read');`, hooks, { allowedDomains: [] }), /no allowed domains/);
  await assert.rejects(run(`await fetch('http://service.example/read');`, hooks), /requires HTTPS/);
  assert.equal(calls, 0);
});

test('bound requests never follow a gateway redirect', async () => {
  let calls = 0;
  await assert.rejects(run(`await fetch('https://service.example/read');`, {
    onHttpFetch: async () => {
      calls++;
      return { ...reply(), status: 302, headers: { location: 'https://elsewhere.example/' } };
    },
  }), /cannot follow redirects/);
  assert.equal(calls, 1);
});

test('a gateway 304 with Location remains a bodyless response', async () => {
  let calls = 0;
  const result = await run(`
    const response = await fetch('https://service.example/read');
    return { success: true, output: {
      status: response.status, location: response.headers.get('location'), body: await response.text()
    }};
  `, { onHttpFetch: async () => {
    calls++;
    return { ...reply(), status: 304, headers: { location: 'https://service.example/current' } };
  }});
  assert.equal(calls, 1);
  assert.deepEqual(result, { mode: 'action', output: {
    status: 304, location: 'https://service.example/current', body: '',
  }});
});

test('sync, query, source read and webhook lifecycle all use the same bound fetch', async () => {
  const modes: ExecutorJob[] = [
    { ...job, mode: 'sync', checkpoint: null, entityIds: [] },
    { ...job, mode: 'query', query: 'select 1' },
    { ...job, mode: 'read', feedKey: 'items' },
    { ...job, mode: 'webhook_register', callbackUrl: 'https://gateway.example/callback' },
    { ...job, mode: 'webhook_unregister', externalId: 'synthetic-subscription' },
  ];
  const connector = `module.exports.default = class {
    execute() {}
    async load() { return (await fetch('https://service.example/read')).text(); }
    async sync() { await this.load(); return { status: 'complete' }; }
    async query() { return { rows: [{ value: await this.load() }] }; }
    async read() { return { rows: [{ value: await this.load() }] }; }
    async registerWebhook() { await this.load(); return { externalId: 'synthetic-subscription' }; }
    async unregisterWebhook() { await this.load(); }
  };`;
  const calls: string[] = [];
  for (const modeJob of modes) {
    const result = await new IsolateExecutor({ timeoutMs: 5_000 }).execute(connector, modeJob, {
      onHttpFetch: async (request) => { calls.push(request.url); return reply('gateway'); },
    });
    assert.equal(result.mode, modeJob.mode);
  }
  assert.deepEqual(calls, Array(5).fill('https://service.example/read'));
});

test('request and response caps apply before bytes can cross the authenticated path', async () => {
  let calls = 0;
  const hooks: ExecutionHooks = { onHttpFetch: async () => { calls++; return reply('x'.repeat(1025)); } };
  await assert.rejects(run(`await fetch('https://service.example/read', {
    method: 'POST', body: new Uint8Array(${CONNECTOR_HTTP_MAX_BYTES + 1})
  });`, hooks), /request body exceeded/);
  assert.equal(calls, 0);
  await assert.rejects(run(`await fetch('https://service.example/read');`, hooks, { fetchBodyBytes: 1024 }), /response body exceeded/);
  assert.equal(calls, 1);
});

test('guest fetch cancellation reaches the gateway hook signal', async () => {
  let aborted = false;
  await assert.rejects(run(`
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await fetch('https://service.example/read', { signal: controller.signal });
  `, { onHttpFetch: async (_request, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('This operation was aborted'));
    }, { once: true });
  }) }), /aborted/);
  assert.equal(aborted, true);
});

test('an unbound job retains guarded host fetch and cannot acquire the supplied auth hook', async () => {
  let hits = 0;
  const server = createServer((_request, response) => { hits++; response.end('public'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const result = await run(`
      const response = await fetch('http://127.0.0.1:${address.port}/read');
      return { success: true, output: { text: await response.text() }};
    `, { onHttpFetch: async () => { throw new Error('unbound job acquired auth'); } }, { allowedDomains: ['127.0.0.1'] }, false);
    assert.deepEqual(result, { mode: 'action', output: { text: 'public' } });
    assert.equal(hits, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
