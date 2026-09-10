import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import { generateWorkerToken, mintGatewayMcpToken, verifyWorkerToken, type MessagePayload } from '@lobu/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enqueueAgentTurn } from '../../gateway/orchestration/agent-turn-producer';
import { createInteractionRoutes } from '../../gateway/routes/internal/interactions';
import { createImageRoutes } from '../../gateway/routes/internal/images';
import { createAudioRoutes } from '../../gateway/routes/internal/audio';
import { createFileRoutes } from '../../gateway/routes/internal/files';
import { createConversationsRoutes } from '../../gateway/routes/internal/conversations';
import { createRuntimeRoutes } from '../../gateway/routes/internal/runtime';
import { authenticateWorker } from '../../gateway/routes/internal/middleware';
import { captureEffect } from '../../gateway/routes/internal/capture-mode';
import { registerGatewayRuntimeProvider } from '../../gateway/runtime/registry';
import { resolveAddressableTargets } from '../../gateway/conversations/authorization';
import { McpProxy } from '../../gateway/auth/mcp/proxy';
import { SecretProxy } from '../../gateway/proxy/secret-proxy';
import { WorkerGateway } from '../../gateway/worker-dispatch/worker-gateway';
import { __setChatInstanceManagerForTests } from '../../lobu/gateway';
import * as db from '../../db/client';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser, addUserToOrganization, insertChatConnectionRow } from '../setup/test-fixtures';
import { createTestAutomationSubscription } from '../setup/automation-subscriptions';
import { post } from '../setup/test-helpers';

const AGENT = 'capture-fixture-agent';
const CONNECTION = 'capture-fixture-connection';
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'capture-test', version: '1' },
} };

describe('native capture over HTTP and Postgres', () => {
  let server: ReturnType<typeof serve>;
  let origin: string;
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let token: string;
  let live: string;
  let runId: number;
  let target: string;
  const delivered = vi.fn(async () => ({ id: 'synthetic-card', messageId: 'synthetic-message', threadId: 'slack:C_CAPTURE:root' }));
  const generated = vi.fn(async () => { throw new Error('media generation must be captured'); });
  const runtimeExec = vi.fn(async () => { throw new Error('remote execution must be captured'); });
  const warmConnection = vi.fn(async () => {});
  const writeArtifact = vi.fn(async () => { throw new Error('artifact writes must be captured'); });
  const upstream = vi.fn();
  let proxy: McpProxy;
  let workerGateway: WorkerGateway;
  const queueReply = vi.fn(async () => {});

  async function request(path: string, body: unknown, credential = token, headers: Record<string, string> = {}) {
    return fetch(origin + path, {
      method: 'POST', headers: { authorization: `Bearer ${credential}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(path === '/embedded' ? { 'x-lobu-memory-direct-auth': '1' } : {}), ...headers },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
  }
  async function records(id = runId) {
    const [row] = await getTestDb()`SELECT dry_run_preview FROM runs WHERE id = ${id}`;
    return row?.dry_run_preview?.side_effects ?? [];
  }
  async function mcpCall(credential: string, session: string, name: string, args: Record<string, unknown>) {
    return request('/embedded', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, credential, { 'mcp-session-id': session });
  }
  async function openMcp(credential: string) {
    const response = await request('/embedded', INIT, credential);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.headers.get('mcp-session-id')!;
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization();
    const owner = await createTestUser();
    await addUserToOrganization(owner.id, org.id, 'owner');
    await createTestAgent({ organizationId: org.id, agentId: AGENT, ownerUserId: owner.id });
    await insertChatConnectionRow({ id: CONNECTION, organizationId: org.id, agentId: AGENT, platform: 'slack' });
    await createTestAutomationSubscription({ organizationId: org.id, agentId: AGENT, connectionSlug: `agentconn-${CONNECTION}`, platform: 'slack', channelId: 'slack:C_CAPTURE' });
    [target] = (await resolveAddressableTargets(AGENT, org.id)).map((item) => item.handle);
    __setChatInstanceManagerForTests({ postToConversation: delivered, reactToMessage: delivered, editMessage: delivered, deleteMessage: delivered });
    registerGatewayRuntimeProvider({ id: 'capture-fixture-runtime', credentialFields: [], exec: runtimeExec });
    const app = new Hono();
    workerGateway = new WorkerGateway({ send: queueReply } as never, 'http://fixture.invalid', {} as never, {} as never);
    app.route('/worker', workerGateway.getApp());
    app.route('/lobu', createInteractionRoutes({ postLinkButton: delivered } as never));
    app.route('/lobu', createImageRoutes({ generate: generated } as never));
    app.route('/lobu', createAudioRoutes({ synthesize: generated } as never));
    app.route('/lobu/internal/files', createFileRoutes({ get: () => ({ warmConnection }) } as never, { put: writeArtifact } as never, 'http://fixture.invalid'));
    app.route('/lobu/internal', createConversationsRoutes());
    app.route('/lobu', createRuntimeRoutes());
    app.post('/lobu/internal/unreviewed-mutation', authenticateWorker, (c) => { delivered(); return c.json({ ok: true }); });
    app.post('/embedded', async (c) => {
      const response = await post(`/mcp/${org.slug}`, { body: await c.req.json(), headers: { ...c.req.header(), 'accept-encoding': 'identity' } });
      return new Response(await response.text(), { status: response.status, headers: response.headers });
    });
    proxy = new McpProxy({ getHttpServer: async (id: string) => ({ id, internal: id === 'internal', upstreamUrl: `${origin}/embedded` }) } as never, {});
    app.route('/lobu/mcp', proxy.getApp());
    const provider = new SecretProxy({ defaultUpstreamUrl: 'http://fixture.invalid' }, {} as never);
    provider.setAuthProfilesManager({ getBestProfile: async () => ({ credential: 'synthetic-provider-key' }), ensureFreshCredential: async () => 'synthetic-provider-key' } as never);
    app.route('/lobu', provider.getApp());
    app.post('/upstream/v1/messages', (c) => { upstream(c.req.path); return c.json({ content: [] }); });
    app.post('/upstream/responses', (c) => { upstream(c.req.path); return c.json({ output: [] }); });
    app.post('/upstream/codex/responses', (c) => { upstream(c.req.path); return c.json({ output: [] }); });
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider.registerUpstream({ slug: 'anthropic', upstreamBaseUrl: `${origin}/upstream` }, 'capture-fixture-provider');
    const module = {
      providerId: 'capture-fixture-provider', sdkCompat: 'anthropic',
      getUpstreamConfig: () => ({ slug: 'anthropic', upstreamBaseUrl: `${origin}/upstream`, apiKeyHeader: 'x-api-key' }),
      getProxyBaseUrlMappings: (url: string, agentId: string) => ({ ANTHROPIC_BASE_URL: `${url}/anthropic/a/${agentId}/o/${org.id}/u/${owner.id}` }),
      buildCredentialPlaceholder: (_agentId: string, context: { workerToken: string }) => context.workerToken,
    };
    const message = { userId: owner.id, conversationId: 'capture-conversation', messageId: 'capture-message', channelId: 'C_CAPTURE',
      agentId: AGENT, organizationId: org.id, platform: 'slack', messageText: 'Capture tool attempts',
      // This suite's baseline `token` must be a CAPTURE credential, so the run
      // asks for capture the only way that works: `platformMetadata`, which is
      // where `buildWorkerTokenClaims` reads it from and which originates
      // server-side. The producer no longer pins the mode — doing so made an
      // ordinary live turn report success while performing no side effects.
      platformMetadata: { connectionId: CONNECTION, executionMode: 'capture' }, agentOptions: { model: 'capture-fixture-provider/fixture' },
    } as MessagePayload;
    const sql = getTestDb();
    const [source] = await sql`
      INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
      VALUES (${org.id}, 'chat_message', 'messages', 'claimed', ${sql.json(message)}) RETURNING id
    `;
    await enqueueAgentTurn({ ...message, runId: Number(source.id) }, {
      gatewayUrl: `${origin}/lobu`, agentSettings: { getSettings: async () => ({}) } as never,
      catalog: { getInstalledModules: async () => [module], findProviderForModel: async () => module } as never,
      runtime: { runtimeProviderId: 'capture-fixture-runtime' } as never,
    });
    const [run] = await getTestDb()`SELECT id, action_input FROM runs WHERE run_type = 'agent_turn'`;
    runId = run.id; token = run.action_input.credential;
    const identity = verifyWorkerToken(token)!;
    expect(identity).toMatchObject({ runId, executionMode: 'capture' });
    expect(identity.automationRunId).toBeUndefined();
    live = generateWorkerToken(identity.userId, identity.conversationId, identity.deploymentName, { ...identity, executionMode: 'live' });
  });

  afterAll(async () => {
    __setChatInstanceManagerForTests(null);
    vi.restoreAllMocks();
    workerGateway?.shutdown();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    await cleanupTestDatabase();
  });

  it('captures every internal mutation class without touching delivery, media, workspace or runtime', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['/internal/interactions/create', { interactionType: 'link_button', url: 'https://example.invalid', label: 'test' }, 'interactions.create'],
      ['/internal/suggestions/create', { prompts: [{ title: 'Next', message: 'Next synthetic step' }] }, 'suggestions.create'],
      ['/internal/images/generate', { prompt: 'synthetic image' }, 'images.generate'],
      ['/internal/audio/synthesize', { text: 'synthetic audio' }, 'audio.synthesize'],
      ['/internal/runtime/exec', { command: 'touch captured.txt' }, 'runtime.exec'],
      ['/internal/conversations/send', { target, text: 'synthetic message' }, 'conversations.send'],
      ['/internal/conversations/present-event', { eventId: 123 }, 'conversations.present-event'],
      ['/internal/conversations/schedule-followup', { runAt: new Date(Date.now() + 60_000).toISOString(), prompt: 'synthetic followup', idempotencyKey: 'capture-followup' }, 'conversations.schedule-followup'],
      ...['react', 'edit', 'delete'].map((action): [string, unknown, string] => [`/internal/conversations/${action}`, { thread: target, message: 'synthetic-message', emoji: 'check', text: 'synthetic edit' }, `conversations.${action}`]),
    ];
    for (const [suffix, field, action] of [['upload', 'file', 'files.upload'], ['upload-batch', 'files', 'files.upload_batch']]) {
      const form = new FormData(); form.append(field, new File(['synthetic'], 'capture.txt'));
      cases.push([`/internal/files/${suffix}`, form, action]);
    }
    for (const [path, body, action] of cases) {
      const response = await request('/lobu' + path, body);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      expect(await response.json()).toMatchObject({ captured: true });
      expect((await records()).some((entry: { action: string }) => entry.action === action), action).toBe(true);
    }
    for (const effect of [delivered, generated, runtimeExec, warmConnection, writeArtifact, upstream]) expect(effect).not.toHaveBeenCalled();
  });

  it('rejects unreviewed routes and forged tokens, while live delivery still executes', async () => {
    expect((await request('/lobu/internal/unreviewed-mutation', {})).status).toBe(403);
    expect((await request('/lobu/internal/interactions/create', {}, token.slice(0, -8) + '00000000')).status).toBe(401);
    const response = await request('/lobu/internal/interactions/create', { interactionType: 'link_button', url: 'https://example.invalid', label: 'live control' }, live);
    expect(response.status).toBe(200);
    expect(delivered).toHaveBeenCalledTimes(1);
    delivered.mockClear();
  });

  it('captures external MCP REST and RPC before approvals, discovery or forwarding', async () => {
    const approval = vi.spyOn(proxy, 'evaluateToolApproval');
    const dispatch = vi.spyOn(proxy.upstream, 'sendUpstreamRequest');
    const rest = await request('/lobu/mcp/external/tools/mutate', { dry_run: false, executionMode: 'live' });
    expect(rest.status).toBe(200);
    expect(JSON.stringify(await rest.json())).toContain('captured');
    const rpc = await request('/lobu/mcp/external', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'mutate', arguments: {} } });
    expect(await rpc.json()).toMatchObject({ id: 7, result: { isError: false } });
    for (const body of [[], [{ jsonrpc: '2.0', method: 'tools/call' }], { jsonrpc: '2.0', method: 'resources/subscribe' }, { jsonrpc: '2.0', method: 'tools/call' }, null]) {
      expect(await (await request('/lobu/mcp/external', body)).json()).toHaveProperty('error');
    }
    expect(approval).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect((await records()).filter((entry: { action: string }) => entry.action === 'mcp.external.mutate')).toHaveLength(2);
    approval.mockRestore(); dispatch.mockRestore();
  });

  it('keeps direct memory and SDK mutations captured across real embedded MCP sessions', async () => {
    const derived = mintGatewayMcpToken(token)!;
    const session = await openMcp(derived);
    const memory = await mcpCall(derived, session, 'save_memory', { text: 'capture only', content: 'capture only', executionMode: 'live' });
    expect(memory.status).toBe(200);
    expect(JSON.stringify(await memory.json())).toContain('captured');
    const sdk = await mcpCall(derived, session, 'run_sdk', { title: 'capture test', dry_run: false, script: 'export default async (_, client) => client.knowledge.save({ content: "SDK capture only" });' });
    expect(sdk.status).toBe(200);
    const result = await sdk.json();
    expect(JSON.stringify(result)).toContain('"dry_run":true');
    expect((await records()).some((entry: { action: string }) => entry.action === 'sdk.run'), JSON.stringify(result)).toBe(true);
    const saved = await getTestDb()`SELECT id FROM events WHERE organization_id = ${org.id} AND payload_text IN ('capture only', 'SDK capture only')`;
    expect(saved).toHaveLength(0);
  });

  it('preserves capture through both internal MCP proxy entry points', async () => {
    const before = (await records()).filter((entry: { action: string }) => entry.action === 'tools.save_memory').length;
    const rest = await request('/lobu/mcp/internal/tools/save_memory', { content: 'proxied capture only' });
    expect(rest.status, await rest.clone().text()).toBe(200);
    expect(JSON.stringify(await rest.json())).toContain('captured');
    const rpc = await request('/lobu/mcp/internal', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'save_memory', arguments: { content: 'RPC capture only' } } });
    expect(rpc.status, await rpc.clone().text()).toBe(200);
    expect(JSON.stringify(await rpc.json())).toContain('captured');
    expect((await records()).filter((entry: { action: string }) => entry.action === 'tools.save_memory')).toHaveLength(before + 2);
  });

  it('refuses live/capture session reuse in both directions and another capture owner', async () => {
    const captureSession = await openMcp(mintGatewayMcpToken(token)!);
    const liveSession = await openMcp(mintGatewayMcpToken(live)!);
    expect((await mcpCall(mintGatewayMcpToken(token)!, liveSession, 'save_memory', { text: 'must not write' })).status).toBe(400);
    expect((await mcpCall(mintGatewayMcpToken(live)!, captureSession, 'save_memory', { text: 'must not write' })).status).toBe(400);
    const identity = verifyWorkerToken(token)!;
    const another = generateWorkerToken(identity.userId, identity.conversationId, identity.deploymentName, { ...identity, runId: runId + 1000 });
    expect((await mcpCall(mintGatewayMcpToken(another)!, captureSession, 'save_memory', { text: 'must not write' })).status).toBe(400);
  });

  it('refuses the old worker reply endpoint before the native guest can enqueue delivery', async () => {
    const [row] = await getTestDb()`SELECT action_input->'turn'->'provider' AS provider FROM runs WHERE id = ${runId}`;
    const code = `exports.runAgentTurn = async () => {
      try {
        const response = await fetch(${JSON.stringify(origin + '/worker/response')}, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ delta: 'synthetic shadow escape' }),
        });
        return { text: JSON.stringify({ status: response.status, body: await response.text() }) };
      } catch (error) { return { text: JSON.stringify({ error: error.message }) }; }
    };`;
    const result = await new IsolateExecutor({ allowedDomains: ['127.0.0.1'] }).execute(code, {
      mode: 'agent_turn', turn: { provider: { api: row.provider.api, baseUrl: row.provider.base_url } } as never,
      credentials: { provider: 'fixture', accessToken: token }, config: {}, env: {}, sessionState: null,
    });
    expect(result.mode).toBe('agent_turn');
    if (result.mode !== 'agent_turn') throw new Error('Expected agent turn');
    expect(JSON.parse(result.turn.text)).toMatchObject({ error: expect.stringContaining('admitted inference or tool endpoint') });
    expect(queueReply).not.toHaveBeenCalled();
  });

  it('pins capture in the actual isolate host despite forged headers and refuses raw sockets', async () => {
    const [row] = await getTestDb()`SELECT action_input->'turn'->'provider' AS provider FROM runs WHERE id = ${runId}`;
    const url = origin + '/lobu/internal/interactions/create';
    const code = `exports.runAgentTurn = async () => {
      const statuses = [];
      for (const headers of [{}, { authorization: 'Bearer garbage' }, { 'x-api-key': 'garbage' },
        { authorization: 'Bearer garbage', 'x-api-key': 'garbage', 'x-lobu-worker-token': 'garbage' }]) {
        const response = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ interactionType: 'link_button', url: 'https://example.invalid', label: 'host pin' }) });
        statuses.push([response.status, (await response.json()).captured]);
      }
      let socketError = '';
      try { await __lobuHost.async('socketOpen', '127.0.0.1', 80, '{}'); } catch (error) { socketError = error.message; }
      let originError = '';
      try { await fetch(${JSON.stringify(url.replace('127.0.0.1', 'localhost'))}); } catch (error) { originError = error.message; }
      return { text: JSON.stringify({ statuses, socketError, originError }) };
    };`;
    const result = await new IsolateExecutor({ allowedDomains: ['127.0.0.1', 'localhost'] }).execute(code, {
      mode: 'agent_turn', turn: { provider: { api: row.provider.api, baseUrl: row.provider.base_url }, tools: { gatewayUrl: origin + '/lobu' } } as never,
      credentials: { provider: 'fixture', accessToken: token }, config: {}, env: {}, sessionState: null,
    });
    expect(result.mode).toBe('agent_turn');
    if (result.mode !== 'agent_turn') throw new Error('Expected agent turn');
    const output = result.turn;
    const observed = JSON.parse(output.text);
    expect(observed.statuses).toEqual([[200, true], [200, true], [200, true], [200, true]]);
    expect(delivered).not.toHaveBeenCalled();
    expect(observed.socketError).toContain('raw sockets');
    expect(observed.originError).toContain('gateway origin');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('binds provider inference to the admitted path, including x-api-key authentication', async () => {
    const [row] = await getTestDb()`SELECT action_input->'turn'->'provider' AS provider FROM runs WHERE id = ${runId}`;
    const path = new URL(row.provider.base_url).pathname;
    for (const suffix of ['/v1/files', '/v1/messages/batches', '/v1/messages?alternate=1']) {
      const response = await request(path + suffix, {}, '', { 'x-api-key': token });
      expect(response.status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
    const response = await request(path + '/v1/messages', {}, '', { 'x-api-key': token });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([['openai-responses', '/responses'], ['openai-codex-responses', '/codex/responses']])('admits the %s path during capture', async (api, suffix) => {
    const sql = getTestDb();
    const [row] = await sql`SELECT action_input->'turn'->'provider' AS provider FROM runs WHERE id = ${runId}`;
    const path = new URL(row.provider.base_url).pathname;
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,provider,api}', to_jsonb(${api}::text))
      WHERE id = ${runId}
    `;
    upstream.mockClear();
    try {
      const denied = await request(path + '/v1/messages', {}, '', { authorization: `Bearer ${token}` });
      expect(denied.status).toBe(403);
      const response = await request(path + suffix, {}, '', { authorization: `Bearer ${token}` });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(upstream).toHaveBeenCalledWith('/upstream' + suffix);
    } finally {
      await sql`
        UPDATE runs
        SET action_input = jsonb_set(action_input, '{turn,provider,api}', '"anthropic-messages"')
        WHERE id = ${runId}
      `;
    }
  });

  it('does not write a cross-org, wrong-type or wrong-conversation capture record', async () => {
    const identity = verifyWorkerToken(token)!;
    const before = (await records()).length;
    for (const wrong of [{ ...identity, organizationId: '00000000-0000-4000-8000-000000000099' }, { ...identity, conversationId: 'different-conversation' }, { ...identity, automationRunId: runId }]) {
      expect(await captureEffect(wrong, 'test.wrong-owner', {})).toMatchObject({ captured: true });
    }
    expect(await records()).toHaveLength(before);
  });
  it('still suppresses HTTP effects when the capture record cannot be written', async () => {
    const failDb = vi.spyOn(db, 'getDb').mockImplementation(() => { throw new Error('synthetic capture storage failure'); });
    try {
      const response = await request('/lobu/internal/interactions/create', { interactionType: 'link_button', url: 'https://example.invalid', label: 'capture failure' });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ captured: true });
      expect(delivered).not.toHaveBeenCalled();
    } finally { failDb.mockRestore(); }
  });

  it('bounds native capture records under concurrent writers', async () => {
    const identity = verifyWorkerToken(token)!;
    await Promise.all(Array.from({ length: 55 }, (_, n) => captureEffect(identity, 'test.concurrent', { n, text: 'x'.repeat(5000) })));
    const [row] = await getTestDb()`SELECT dry_run_preview FROM runs WHERE id = ${runId}`;
    expect(row.dry_run_preview.side_effects).toHaveLength(50);
    expect(row.dry_run_preview.side_effects_truncated).toBe(true);
    const added = row.dry_run_preview.side_effects.filter((entry: { action: string }) => entry.action === 'test.concurrent');
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((entry: { details: { details_truncated: boolean } }) => entry.details.details_truncated)).toBe(true);
  });

});
