import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { generateWorkerToken } from '@lobu/core';
import { TURN_INPUT_RUN_HEADER } from '@lobu/core/agent-tooling';
import { Hono } from 'hono';
import type { McpProxy } from '../../gateway/auth/mcp/proxy';
import { handleCallTool } from '../../gateway/auth/mcp/proxy-rest-routes';
import { getRevokedTokenStore } from '../../gateway/auth/revoked-token-store';

const originalKey = process.env.ENCRYPTION_KEY;
let revocation: ReturnType<typeof spyOn>;
let token: string;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  revocation = spyOn(getRevokedTokenStore(), 'isRevoked').mockResolvedValue(false);
  token = generateWorkerToken('synthetic-user', 'synthetic-conversation', 'agent-turn:synthetic-message', {
    channelId: 'synthetic-channel', agentId: 'synthetic-agent', organizationId: 'synthetic-org', runId: 701, messageId: 'synthetic-message',
  });
});

afterAll(() => {
  revocation.mockRestore();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

test.each([
  { internal: true, input: undefined },
  { internal: true, input: '702' },
  { internal: true, input: '' },
  { internal: true, input: 'invalid' },
  { internal: false, input: '702' },
])('turn input forwarding: %j', async ({ internal, input }) => {
  let forwarded: Record<string, string> | undefined;
  const proxy = {
    configService: { getHttpServer: async () => ({ id: 'synthetic-mcp', internal }) },
    runPreToolGuardrails: async () => false,
    upstream: {
      getSession: () => 'synthetic-session',
      sendUpstreamRequest: async (...args: unknown[]) => {
        forwarded = args[7] as Record<string, string> | undefined;
        return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } });
      },
    },
  } as unknown as McpProxy;
  const app = new Hono();
  app.post('/:mcpId/tools/:toolName', (c) => handleCallTool(proxy, c));
  const response = await app.request('/synthetic-mcp/tools/notify', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(input !== undefined ? { [TURN_INPUT_RUN_HEADER]: input } : {}),
    },
    body: JSON.stringify({ action: 'send', title: 'Test' }),
  });
  expect(response.status).toBe(200);
  // Preserve malformed values for the embedded verifier to reject. Dropping
  // one would turn a bad follow-up binding into an owner-input write.
  expect(forwarded?.[TURN_INPUT_RUN_HEADER]).toBe(internal ? input : undefined);
});
