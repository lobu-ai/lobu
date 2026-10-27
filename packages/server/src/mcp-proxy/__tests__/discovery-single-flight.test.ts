import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverTools } from '../client';

const jsonResponse = (body: unknown, sessionId?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config = {
  upstream_url: 'https://mcp.example.com/rpc',
  tool_prefix: 'sf',
};

const okInitialize = (sessionId: string) =>
  jsonResponse(
    {
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
      },
    },
    sessionId
  );

const toolList = (names: string[]) =>
  jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) },
  });

describe('discoverTools single-flight discovery', () => {
  it('shares one upstream discovery across concurrent same-key calls', async () => {
    const gate = deferred<void>();
    let initializeCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        initializeCount += 1;
        await gate.promise;
        return okInitialize('session-1');
      }
      if (body.method === 'tools/list') {
        return toolList(['alpha']);
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const first = discoverTools('sf.shared', config, 'sf-shared-org');
    const second = discoverTools('sf.shared', config, 'sf-shared-org');
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(initializeCount).toBe(1);
    expect(a.map((tool) => tool.originalName)).toEqual(['alpha']);
    expect(b.map((tool) => tool.originalName)).toEqual(['alpha']);
  });

  it('does not share discovery across different cache keys', async () => {
    let initializeCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      if (body.method === 'initialize') {
        initializeCount += 1;
        return okInitialize(`session-${initializeCount}`);
      }
      if (body.method === 'tools/list') {
        const sessionId = headers.get('mcp-session-id') ?? 'missing';
        return toolList([sessionId.replace(/\W+/g, '_')]);
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      discoverTools('sf.shared', config, 'sf-org-a'),
      discoverTools('sf.shared', config, 'sf-org-b'),
    ]);

    expect(initializeCount).toBe(2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].originalName).not.toEqual(b[0].originalName);
  });

  it('fails every waiter closed, clears the in-flight entry, and lets a later call retry', async () => {
    let mode: 'down' | 'down-gated' | 'up' = 'down';
    const gate = deferred<void>();
    let initializeCount = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        initializeCount += 1;
        if (mode === 'down') throw new Error('connect ECONNREFUSED');
        if (mode === 'down-gated') {
          await gate.promise;
          throw new Error('connect ECONNREFUSED');
        }
        return okInitialize('session-up');
      }
      if (body.method === 'tools/list') {
        return toolList(['recovered']);
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const org = 'sf-retry-org';
    await expect(discoverTools('sf.shared', config, org)).rejects.toThrow(/ECONNREFUSED/);
    expect(initializeCount).toBe(1);

    // A failed attempt must not wedge the key: a concurrent pair starts one
    // fresh shared attempt, and both waiters receive that attempt's rejection.
    mode = 'down-gated';
    const first = discoverTools('sf.shared', config, org);
    const second = discoverTools('sf.shared', config, org);
    gate.resolve();
    await expect(first).rejects.toThrow(/ECONNREFUSED/);
    await expect(second).rejects.toThrow(/ECONNREFUSED/);
    expect(initializeCount).toBe(2);

    mode = 'up';
    const tools = await discoverTools('sf.shared', config, org);
    expect(tools.map((tool) => tool.originalName)).toEqual(['recovered']);
    expect(initializeCount).toBe(3);
  });
});
