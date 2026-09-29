import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ConnectorHttpRequest, ConnectorHttpResponse } from '@lobu/core/contracts/worker/protocol';
import { WorkerClient } from '../daemon/client.js';

const request: ConnectorHttpRequest = { url: 'https://service.example/read', method: 'GET', headers: {} };
const response: ConnectorHttpResponse = { status: 200, statusText: 'OK', headers: {}, body: 'b2s=' };

describe('worker gateway HTTP authentication', () => {
  test('the real client binds the worker/run and keeps its bearer in transport headers', async () => {
    let received: unknown;
    let authorization: string | undefined;
    let path: string | undefined;
    let hits = 0;
    let failure = false;
    const server = createServer(async (req, res) => {
      hits++;
      authorization = req.headers.authorization;
      path = req.url;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      if (failure) res.statusCode = 503;
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP port');
    const client = new WorkerClient({
      apiUrl: `http://127.0.0.1:${address.port}`, workerId: 'synthetic-worker',
      authToken: 'synthetic-host-bearer', capabilities: {},
    });
    try {
      expect(await client.httpFetch(42, request)).toEqual(response);
      expect(path).toBe('/api/workers/http-fetch');
      expect(authorization).toBe('Bearer synthetic-host-bearer');
      expect(received).toEqual({ worker_id: 'synthetic-worker', run_id: 42, request });
      expect(JSON.stringify(received)).not.toContain('synthetic-host-bearer');
      failure = true;
      await expect(client.httpFetch(42, { ...request, method: 'POST' })).rejects.toThrow('503');
      expect(hits).toBe(2);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(client.httpFetch(42, request, cancelled.signal)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('native isolate preserves the HTTP credential boundary, limits and cancellation', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/http-auth-isolate.fixture.ts', import.meta.url));
    const child = Bun.spawn(['node', '--import', 'tsx', '--test', fixture], {
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr, stdout: exitCode ? stdout : '' }).toEqual({ exitCode: 0, stderr: '', stdout: '' });
    expect(stdout).toContain('tests 10');
  }, 30_000);
});
