/**
 * A worker's REST tool call (`POST /lobu/mcp/<id>/tools/<name>`) whose agent is
 * deleted mid-turn. The embedded MCP's direct-auth gate refuses the token with
 * 403 `insufficient_scope`; the gateway proxy must hand that refusal back as a
 * 403 with its description, not relabel it a 502 (which the CDN then replaces
 * with an HTML error page, so the agent reports the backend as down).
 */

import { generateWorkerToken } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpProxy } from '../../../gateway/auth/mcp/proxy';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'deleted-mid-turn-agent';
const UPSTREAM = 'http://embedded-memory.test/mcp';

describe('REST tool route when the embedded MCP refuses the caller', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let workerToken: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Deleted Agent Org' });
    const owner = await createTestUser({});
    await addUserToOrganization(owner.id, org.id, 'owner');
    await createTestAgent({ organizationId: org.id, agentId: AGENT_ID, ownerUserId: owner.id });
    workerToken = generateWorkerToken(owner.id, 'conv-deleted-agent', 'deploy-deleted-agent', {
      channelId: 'api-conv-deleted-agent',
      agentId: AGENT_ID,
      organizationId: org.id,
      platform: 'api',
      source: 'internal',
    });

    // The proxy's internal upstream is the real embedded `/mcp/<orgSlug>`.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== UPSTREAM) return originalFetch(input, init);
      const response = await post(`/mcp/${org.slug}`, {
        rawBody: String(init?.body ?? ''),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(await response.text(), { status: response.status, headers: response.headers });
    }) as typeof fetch;
  });

  /** A gateway pod whose sessions with the embedded MCP start empty. */
  function newProxy() {
    return new McpProxy(
      { getHttpServer: async (id: string) => ({ id, internal: true, upstreamUrl: UPSTREAM }) } as never,
      {}
    );
  }

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function callTool(proxy: McpProxy, name: string, args: Record<string, unknown>) {
    return proxy.getApp().request(`/lobu-memory/tools/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  }

  it('answers while the agent exists, then returns the 403 refusal once it is deleted', async () => {
    // The turn's pod already holds a session (the prod sequence: the refusal
    // arrives on tools/call); a fresh pod meets it on the initialize handshake.
    const warm = newProxy();
    const before = await callTool(warm, 'resolve_path', { path: `/${org.slug}` });
    expect(before.status, await before.clone().text()).toBe(200);

    await getTestDb()`DELETE FROM agents WHERE id = ${AGENT_ID} AND organization_id = ${org.id}`;

    const refusal = {
      content: [],
      isError: true,
      error: 'insufficient_scope: Worker token is not valid for this organization',
    };
    for (const [label, proxy] of [['cached session', warm], ['fresh session', newProxy()]] as const) {
      const after = await callTool(proxy, 'save_memory', { content: 'a note' });
      expect(after.status, label).toBe(403);
      expect(await after.json(), label).toEqual(refusal);
    }
  });
});
