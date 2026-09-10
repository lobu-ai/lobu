/**
 * The agent-turn producer end to end: a message produces an
 * `agent_turn` run, only a fleet worker that advertises the lane can claim it,
 * and the turn is reported back on the lane's own completion route. This is the
 * seam that makes the isolate turn lane REACHABLE — the executor suite proves
 * the turn runs, this proves a real message reaches it and comes back.
 */
import { getModel } from '@mariozechner/pi-ai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import type { SyncExecutor } from '@lobu/connector-worker/executor/interface';
import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import {
  AgentTurnPollPayloadSchema,
  PollResponseSchema,
} from '@lobu/core/contracts/worker/protocol';
import { AGENT_ERRORS, AgentErrorCode, parseSessionEntries, type MessagePayload, renderBaselineAgentPolicy, verifyWorkerToken } from '@lobu/core';
import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db/client';
import { createInteractionRoutes } from '../../gateway/routes/internal/interactions';
import { enqueueAgentTurn,
  cancelAgentTurn,
} from '../../gateway/orchestration/agent-turn-producer';
import { armTurnTimeout, failTurnIfPending } from '../../gateway/orchestration/turn-liveness';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { sweepStaleAgentTurnRuns } from '../../worker-api/agent-turn';
import { failClaimedWorkerRun } from '../../worker-api/poll';
import type { AgentSettingsStore } from '../../gateway/auth/settings/agent-settings-store';
import type { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import type { McpConfigService } from '../../gateway/auth/mcp/config-service';
import type { McpProxy } from '../../gateway/auth/mcp/proxy';
import type { ModelProviderModule } from '../../gateway/modules/module-system';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const GATEWAY_URL = 'https://gateway.test.invalid/lobu';
const AGENT_ID = 'turn-agent';

/**
 * A provider module shaped like the real Claude one: a Lobu id that differs
 * from its upstream slug, so the model-prefix strip is actually exercised.
 */
function claudeModule(overrides: Partial<ModelProviderModule> = {}): ModelProviderModule {
  return {
    providerId: 'claude',
    sdkCompat: 'anthropic',
    getUpstreamConfig: () => ({
      slug: 'anthropic',
      upstreamBaseUrl: 'https://api.anthropic.com',
      apiKeyHeader: 'x-api-key' as const,
    }),
    getProxyBaseUrlMappings: (
      proxyUrl: string,
      agentId?: string,
      context?: { organizationId?: string; userId?: string }
    ) => ({
      ANTHROPIC_BASE_URL: `${proxyUrl}/anthropic/a/${agentId}/o/${context?.organizationId}/u/${context?.userId}`,
    }),
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) => context?.workerToken,
    ...overrides,
  } as unknown as ModelProviderModule;
}

/**
 * The base provider module answers the worker token it is handed as the
 * credential — that is what lets one credential serve the proxy and the MCP
 * route. `claudeModule` above answers a fixed placeholder to pin the
 * lifting; this one behaves like production.
 */
function tokenEchoingModule(): ModelProviderModule {
  return claudeModule({
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) =>
      context?.workerToken ?? 'lobu-proxy',
  } as Partial<ModelProviderModule>);
}

interface McpFixture {
  mcp: { configService: McpConfigService; proxy: McpProxy };
  /** Every (mcpId, agentId, bearer) `fetchToolsForMcp` was asked for. */
  listed: Array<{ mcpId: string; agentId: string; token: string | undefined }>;
}

/** An MCP surface with one server publishing three tools and an instruction block. */
function mcpFixture(options: { fail?: boolean } = {}): McpFixture {
  const listed: McpFixture['listed'] = [];
  const configService = {
    getMcpStatus: async () => [
      { id: 'lobu-memory', name: 'lobu-memory', requiresAuth: false, requiresInput: false },
    ],
  } as unknown as McpConfigService;
  const proxy = {
    fetchToolsForMcp: async (mcpId: string, agentId: string, _tokenData: unknown, token?: string) => {
      listed.push({ mcpId, agentId, token });
      if (options.fail) throw new Error('upstream MCP is down');
      return {
        instructions: 'Use query_sdk before run_sdk.',
        tools: [
          { name: 'query_sdk', description: 'Read data', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
          { name: 'run_sdk', description: 'Write data', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
          { name: 'query_sql', inputSchema: undefined },
        ],
      };
    },
  } as unknown as McpProxy;
  return { mcp: { configService, proxy }, listed };
}

function catalogFor(module: ModelProviderModule | undefined): ProviderCatalogService {
  return {
    getInstalledModules: async () => (module ? [module] : []),
    findProviderForModel: async () => module,
  } as unknown as ProviderCatalogService;
}

const settingsStore = {
  getSettings: async () => ({
    identityMd: 'I am the turn agent.',
    soulMd: 'Answer briefly.',
    userMd: '',
  }),
} as unknown as AgentSettingsStore;

function messageFor(organizationId: string): MessagePayload {
  return {
    userId: 'user-turn',
    conversationId: 'conv-turn',
    messageId: 'msg-turn',
    channelId: 'api_user-turn',
    agentId: AGENT_ID,
    organizationId,
    botId: 'bot-turn',
    platform: 'api',
    messageText: 'what is the isolate lane?',
    platformMetadata: {},
    agentOptions: { model: 'claude/claude-opus-4-8' },
  } as MessagePayload;
}

async function admittedMessage(message: MessagePayload): Promise<MessagePayload> {
  const sql = getTestDb();
  const [input] = await sql`
    INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
    VALUES (${message.organizationId}, 'chat_message', 'messages', 'claimed', ${sql.json(message)}) RETURNING id
  `;
  return { ...message, runId: Number(input.id) };
}

/**
 * The producer receives an already admitted queue message in production.
 * Returns the producer's outcome: an `AgentErrorCode` when the agent cannot
 * run, `undefined` when the turn was produced or nothing is owed a reply.
 */
async function enqueueMessage(message: MessagePayload, deps: Parameters<typeof enqueueAgentTurn>[1]) {
  return await enqueueAgentTurn(await admittedMessage(message), deps);
}

/**
 * An artifact store holding exactly the fixtures the attachment tests publish.
 * Stands in for the gateway's real one so the producer's resolution path is
 * exercised without the filesystem — what matters is that it resolves by
 * ARTIFACT ID, which is the only key this fake answers to.
 */
function fakeArtifacts() {
  const held: Record<string, { contentType: string; bytes: Buffer }> = {
    'art-image': { contentType: 'image/png', bytes: Buffer.from('PNG!') },
    'art-doc': { contentType: 'application/pdf', bytes: Buffer.from('%PDF') },
  };
  const metadataFor = (artifactId: string) => {
    const fixture = held[artifactId];
    if (!fixture) return null;
    return {
      artifactId,
      filename: 'stored',
      contentType: fixture.contentType,
      size: fixture.bytes.length,
      createdAt: 0,
      sha256: '0'.repeat(64),
    };
  };
  return {
    inspect: async (artifactId: string) => metadataFor(artifactId) as never,
    read: async (artifactId: string) => {
      const fixture = held[artifactId];
      const metadata = metadataFor(artifactId);
      return fixture && metadata ? ({ metadata, bytes: fixture.bytes } as never) : null;
    },
  };
}

/** Queued `thread_response` payloads, oldest first, across the whole db. */
async function threadResponsesGlobal(): Promise<Array<Record<string, unknown>>> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT action_input FROM runs
    WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
    ORDER BY id ASC
  `) as unknown as Array<{ action_input: Record<string, unknown> }>;
  return rows.map((row) => row.action_input);
}

async function agentTurnRuns() {
  const sql = getTestDb();
  return (await sql`
    SELECT id, run_type, status, approval_status, organization_id, action_input, parent_run_id
    FROM runs
    WHERE run_type = 'agent_turn'
    ORDER BY id
  `) as unknown as Array<{
    id: number;
    run_type: string;
    status: string;
    approval_status: string;
    organization_id: string;
    action_input: Record<string, unknown>;
    parent_run_id: number | null;
  }>;
}

async function pollFleet(workerId: string, capabilities: Record<string, boolean>) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

async function postAsFleet(path: string, body: Record<string, unknown>) {
  return post(path, {
    body: path === '/api/workers/complete-agent-turn' && body.status === 'completed'
      ? { consumed_inputs: [], ...body } : body,
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

/** Enqueue a turn and claim it, as the fleet worker would. */
async function claimedTurnRun(workerId: string): Promise<number> {
  const org = await createTestOrganization();
  await enqueueMessage(messageFor(org.id), {
    agentSettings: settingsStore,
    catalog: catalogFor(claudeModule()),
    gatewayUrl: GATEWAY_URL,
  });
  const response = await pollFleet(workerId, { agent_turn: true });
  const body = await response.json();
  return body.run_id as number;
}

async function runRow(runId: number) {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, error_message, exit_reason, output_tail, action_input
    FROM runs WHERE id = ${runId}
  `) as unknown as Array<{
    status: string;
    error_message: string | null;
    exit_reason: string | null;
    output_tail: string | null;
    action_input: { turn?: unknown; result?: Record<string, unknown> };
  }>;
  return row;
}

/** Native session fixture: entry IDs and parent links belong to Pi, not the gateway. */
function nativeSession(entries: Array<Record<string, unknown>> = [
  { type: 'message', id: 'native-user', parentId: null,
    message: { role: 'user', content: 'what is the isolate lane?', timestamp: 1 } },
  { type: 'message', id: 'native-answer', parentId: 'native-user',
    message: { role: 'assistant', content: [{ type: 'text', text: 'the isolate answer' }], timestamp: 2 } },
]): string {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return [
    { type: 'session', version: 3, id: 'native-session', timestamp, cwd: '/workspace' },
    ...entries.map((entry) => ({ timestamp, ...entry })),
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

describe('agent turn producer', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(() => {
  });

  it('EXECUTES a real HTTP interaction live with the producer-minted turn credential', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    const postLinkButton = vi.fn(async () => ({ id: 'synthetic-post' }));
    const app = createInteractionRoutes({ postLinkButton } as never);
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/interactions/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${run.action_input.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ interactionType: 'link_button', url: 'https://example.invalid', label: 'Interaction attempt' }),
      });
      expect(response.status).toBe(200);
      // LIVE, because an ordinary turn is authoritative now. This asserted the
      // opposite while the lane produced a discardable copy: the effect was
      // captured and `postLinkButton` was never called. Inverting it is the
      // point of activation — `captureEffect` answers `success: true` without
      // performing the effect, so a turn left in capture mode would tell the
      // user it posted while posting nothing.
      expect(postLinkButton).toHaveBeenCalledTimes(1);
      expect(verifyWorkerToken(run.action_input.credential as string)).toMatchObject({
        runId: run.id, organizationId: org.id,
      });
      // No capture claim at all: absent means live, exactly as the subprocess
      // lane's token derivation means it.
      expect(
        (verifyWorkerToken(run.action_input.credential as string) as { executionMode?: string })
          .executionMode
      ).toBeUndefined();
      const [captured] = await getTestDb()`SELECT dry_run_preview FROM runs WHERE id = ${run.id}`;
      expect(captured.dry_run_preview).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('executes a compatible-provider tool round trip through worker HTTP and an isolate', async () => {
    const requests: Array<Record<string, any>> = [];
    const serverErrors: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (path.startsWith('/lobu/api/proxy/compatible/')) {
          requests.push(body);
          // Gemini rejects even store:false. This stub enforces that wire
          // contract while the real producer, daemon and Pi guest execute.
          if (Object.hasOwn(body, 'store')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Unknown name 'store'" } }));
            return;
          }
          const toolCall = requests.length === 1;
          const delta = toolCall
            ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-write', type: 'function',
                function: { name: 'write', arguments: JSON.stringify({ file_path: 'probe.txt', content: 'compatibility verified' }) } }] }
            : { role: 'assistant', content: 'Compatibility verified.' };
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1,
            model: 'compatible-model', choices: [{ index: 0, delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
          return;
        }
        const response = await post(path, { body, headers: { authorization: req.headers.authorization ?? '' },
          env: { WORKER_API_TOKEN: 'synthetic-compat-fleet' } });
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
      } catch (error) {
        serverErrors.push(String(error));
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const org = await createTestOrganization();
      const message = messageFor(org.id);
      message.agentOptions!.model = 'compatible/compatible-model';
      await enqueueMessage(message, {
        agentSettings: settingsStore, gatewayUrl: `${origin}/lobu`,
        catalog: catalogFor(claudeModule({ providerId: 'compatible', sdkCompat: 'openai',
          getUpstreamConfig: () => ({ slug: 'compatible', upstreamBaseUrl: 'https://compatible.example.test/v1' }),
          getProxyBaseUrlMappings: () => ({ OPENAI_BASE_URL: `${origin}/lobu/api/proxy/compatible/a/turn-agent` }),
        })),
      });
      const [run] = await agentTurnRuns();
      const client = new WorkerClient({ apiUrl: origin, workerId: 'synthetic-compat-worker',
        authToken: 'synthetic-compat-fleet', capabilities: { agent_turn: true } });
      const job = await client.poll();
      expect(job.run_id).toBe(Number(run.id));
      const result = await executeRun(client, job, {}, {
        executor: new IsolateExecutor({ allowedDomains: ['127.0.0.1'], timeoutMs: 20_000 }), timeoutMs: 20_000,
      });
      expect(serverErrors).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => !Object.hasOwn(request, 'store'))).toBe(true);
      expect(requests[1].messages.some((message: { role: string }) => message.role === 'tool')).toBe(true);
      expect((await runRow(Number(run.id))).status).toBe('completed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it('executes write/edit over worker HTTP with admitted history', async () => {
    const calls = [
      { name: 'write', input: { file_path: 'a.txt', content: '\ufeffbefore\r\n' } },
      { name: 'edit', input: { file_path: 'a.txt', old_string: 'before', new_string: 'after' } },
      { name: 'edit', input: { file_path: 'a.txt', old_string: 'absent', new_string: 'must not appear' } },
      { name: 'read', input: { file_path: 'a.txt' } },
      { name: 'bash', input: { command: 'base64 a.txt' } },
    ];
    const providerRequests: Array<{ tools: Array<{ name: string; input_schema: unknown }>; messages: unknown[] }> = [];
    const workerRequests: Array<{ path: string; body: Record<string, any> }> = [];
    const serverErrors: string[] = [];
    // Only the external model is scripted. Worker requests cross real HTTP,
    // then the real Hono routes, lease checks, and Postgres writes.
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (path.startsWith('/lobu/api/proxy/anthropic/')) {
          const step = providerRequests.length;
          providerRequests.push(body);
          if (step > calls.length) throw new Error('unexpected extra provider request');
          const call = calls[step];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          send('message_start', { type: 'message_start', message: {
            id: `msg_${step}`, type: 'message', role: 'assistant', model: 'claude-test',
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 },
          } });
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: call
            ? { type: 'tool_use', id: `tool_${step}`, name: call.name, input: {} }
            : { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: call
            ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
            : { type: 'text_delta', text: 'File edited; failed edit preserved its contents.' } });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta', delta: {
            stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null,
          }, usage: { output_tokens: 3 } });
          send('message_stop', { type: 'message_stop' });
          res.end();
          return;
        }
        workerRequests.push({ path, body });
        const response = await post(path, {
          body,
          headers: { authorization: req.headers.authorization ?? '' },
          env: { WORKER_API_TOKEN: 'test-file-tools-fleet' },
        });
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
      } catch (error) {
        serverErrors.push(String(error));
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const org = await createTestOrganization();
      const sql = getTestDb();
      const [prior] = await sql<{ id: number }>`
        INSERT INTO runs (run_type, status, organization_id, run_at)
        VALUES ('chat_message', 'completed', ${org.id}, now()) RETURNING id
      `;
      const timestamp = '2026-01-01T00:00:00.000Z';
      const history = nativeSession([
        { type: 'message', id: 'old-root', parentId: null, timestamp,
          message: { role: 'user', content: 'discarded-branch-history', timestamp: 1 } },
        { type: 'custom', id: 'old-flush', parentId: 'old-root', timestamp,
          customType: 'lobu.memory_flush_state', data: { compactionCount: 0 } },
        { type: 'message', id: 'new-root', parentId: null, timestamp,
          message: { role: 'user', content: 'retained-branch-history', timestamp: 2 } },
      ]);
      await sql`
        INSERT INTO agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
        VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${prior.id}, ${history}, ${Buffer.byteLength(history)}, 'completed')
      `;
      const source = await admittedMessage(messageFor(org.id));
      await enqueueAgentTurn(source, {
        agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: `${origin}/lobu`,
      });
      const [run] = await agentTurnRuns();
      expect(run.action_input.turn).toMatchObject({ session_jsonl: '' });
      // There is no shadow lane and no managed counterpart snapshot to
      // exclude: the assertions below are the whole contract.
      expect(run.action_input.turn).not.toHaveProperty('shadow');
      const client = new WorkerClient({
        apiUrl: origin, workerId: 'fleet-file-tools', authToken: 'test-file-tools-fleet', capabilities: { agent_turn: true },
      });
      const job = await client.poll();
      expect(job.run_id).toBe(Number(run.id));
      expect((job.payload as { turn: { session_jsonl: string } }).turn.session_jsonl).toBe(history);
      const result = await executeRun(client, job, {}, {
        executor: new IsolateExecutor({ allowedDomains: ['127.0.0.1'], timeoutMs: 20_000 }),
        timeoutMs: 20_000,
      });
      expect(serverErrors).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(providerRequests).toHaveLength(6);
      expect(JSON.stringify(providerRequests[0].messages)).toContain('retained-branch-history');
      expect(JSON.stringify(providerRequests[0].messages)).not.toContain('discarded-branch-history');
      expect(providerRequests[0].tools.find((tool) => tool.name === 'edit')?.input_schema).toMatchObject({
        required: ['file_path', 'old_string', 'new_string'],
      });
      expect(workerRequests.map((request) => request.path)).toContain('/api/workers/heartbeat');
      const completion = workerRequests.find((request) => request.path === '/api/workers/complete-agent-turn')!.body;
      expect(completion.status).toBe('completed');
      expect((await runRow(Number(run.id))).status).toBe('completed');
      const [snapshot] = await sql`SELECT snapshot_jsonl FROM agent_transcript_snapshot WHERE run_id = ${run.id}`;
      expect(completion.session_jsonl.startsWith(history)).toBe(true);
      expect(snapshot.snapshot_jsonl).toBe(completion.session_jsonl);
      expect((await runRow(Number(run.id))).action_input.result?.session_jsonl).toBe(completion.session_jsonl);
      const messages = parseSessionEntries(completion.session_jsonl).entries.map((entry) => entry.message).filter(Boolean) as any[];
      const toolResults = messages.filter((message) => message.role === 'toolResult');
      expect(toolResults.map((message) => [message.toolName, message.isError])).toEqual([
        ['write', false], ['edit', false], ['edit', true], ['read', false], ['bash', false],
      ]);
      expect(toolResults[1].details).toMatchObject({ firstChangedLine: 1 });
      expect(toolResults[2].content[0].text).toContain('Could not find the exact text in a.txt');
      // Pi's read preserves the BOM as well as the CRLF bytes retained by edit.
      expect(toolResults[3].content).toEqual([{ type: 'text', text: '\ufeffafter\r\n' }]);
      expect(toolResults[4].content).toEqual([{ type: 'text', text: `${Buffer.from('\ufeffafter\r\n').toString('base64')}\n` }]);
      const [reply] = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' AND action_input->>'finalText' = ${completion.text}`;
      // The turn is authoritative: its answer IS the conversation's reply.
      expect(reply.action_input).toMatchObject({ conversationId: 'conv-turn', finalText: completion.text });
      // A lost completion response must not append the same transcript twice.
      await client.completeAgentTurn(completion as never);
      const snapshots = await sql`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${run.id}`;
      expect(snapshots).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it.each(['mid', 'late', 'cancel'] as const)(
    'preserves accepted input across real HTTP and isolates (%s)', async (timing) => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const first = messageFor(org.id);
    const followUp = { ...first, messageId: 'http-follow-up', messageText: 'durable-http-follow-up' };
    const providerRequests: Array<{ messages: unknown[] }> = [];
    const completions: Array<Record<string, any>> = [];
    const errors: string[] = [];
    let origin = '';
    let followerId = 0;
    let offered = 0;
    let droppedBeat = false;
    let droppedCompletion = false;
    let guestExited = false;
    let lateOffer = false;
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let cleanupStarted!: () => void;
    const cleanupReady = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const enqueue = async (message: MessagePayload) => {
      const source = await admittedMessage(message);
      if (!await cancelAgentTurn(source)) await enqueueAgentTurn(source, {
        agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: `${origin}/lobu`,
      });
      const run = (await agentTurnRuns()).at(-1)!;
      return Number(run.id);
    };
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (path.startsWith('/lobu/api/proxy/anthropic/')) {
          const step = providerRequests.length;
          providerRequests.push(body);
          if (step > 1) throw new Error('duplicate or unexpected provider execution');
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          send('message_start', { type: 'message_start', message: { id: `native_${step}`, type: 'message', role: 'assistant',
            model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
          send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step ? 'Follow-up answered.' : 'Initial answer.' } });
          if (step === 0 && timing !== 'late') {
            followerId = await enqueue(followUp);
            if (timing === 'cancel') {
              await cancelAgentTurn(await admittedMessage({ ...first, messageId: 'http-cancel', messageText: '/cancel' }));
              await new Promise<void>((resolve) => res.once('close', resolve));
              return;
            }
            await providerGate;
          }
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
          send('message_stop', { type: 'message_stop' });
          res.end();
          return;
        }
        const response = await post(path, { body, headers: { authorization: req.headers.authorization ?? '' },
          env: { WORKER_API_TOKEN: 'test-input-fleet' } });
        const payload = await response.json();
        if (path.endsWith('/heartbeat') && payload.steer?.length) {
          offered++;
          if (guestExited && timing === 'late') lateOffer = true;
          if (timing === 'mid' && !droppedBeat) { droppedBeat = true; res.destroy(); return; }
        }
        if (path.endsWith('/complete-agent-turn')) {
          completions.push({ request: body, response: payload });
          if (timing === 'mid' && !droppedCompletion) { droppedCompletion = true; res.destroy(); return; }
        }
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      } catch (error) { errors.push(String(error)); res.writeHead(500).end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ownerId = await enqueue(first);
      const client = new WorkerClient({ apiUrl: origin, workerId: 'fleet-http-input', authToken: 'test-input-fleet', capabilities: { agent_turn: true } });
      const heartbeat = client.heartbeat.bind(client);
      let receivedOffers = 0;
      client.heartbeat = async (...args) => {
        // Keep the delta unacknowledged until late admission so the final
        // drain deterministically makes the real HTTP request under test.
        if (timing === 'late' && !guestExited) return { continue: true };
        const response = await heartbeat(...args);
        if (response.steer?.length && ++receivedOffers === 2) setTimeout(releaseProvider, 0);
        return response;
      };
      const real = new IsolateExecutor({ allowedDomains: ['127.0.0.1'], timeoutMs: 15_000 });
      let executions = 0;
      const executor: SyncExecutor = { execute: async (...args) => {
        const execution = ++executions;
        try { return await real.execute(...args); }
        finally {
          if (execution === 1) {
            if (timing === 'late') followerId = await enqueue(followUp);
            guestExited = true;
            if (timing === 'cancel') { cleanupStarted(); await cleanupGate; }
          }
        }
      } };
      const config = { executor, timeoutMs: 15_000, heartbeatIntervalMs: 20 };
      const running = executeRun(client, await client.poll(), {}, config);
      if (timing === 'cancel') {
        await cleanupReady;
        // The real isolate has disposed; the daemon has not reported cleanup.
        expect((await (await pollFleet('fleet-before-cleanup', { agent_turn: true })).json()).run_id).toBeUndefined();
        expect((await runRow(ownerId)).status).toBe('running');
        releaseCleanup();
      }
      const result = await running;
      if (timing === 'cancel') expect(result.error).toBeTruthy();
      else expect(result.error).toBeUndefined();
      if (timing === 'mid') {
        expect(droppedBeat && droppedCompletion).toBe(true);
        expect(offered).toBeGreaterThanOrEqual(3);
        expect((await runRow(followerId)).status).toBe('completed');
        const [row] = await sql`SELECT run_metadata, action_input FROM runs WHERE id = ${followerId}`;
        const completion = completions[0].request;
        expect(completion.consumed_inputs).toEqual([{ run_id: followerId, session_entry_id: row.run_metadata.session_entry_id }]);
        expect(row.run_metadata.consumed_by_run_id).toBe(ownerId);
        expect(row.action_input).not.toHaveProperty('result');
        const entry = completion.session_jsonl.trim().split('\n').map((line: string) => JSON.parse(line))
          .find((entry: { id: string }) => entry.id === row.run_metadata.session_entry_id);
        expect(entry.message).toMatchObject({ role: 'user', content: [{ type: 'text', text: followUp.messageText }] });
        expect(completions.at(-1)!.response).toMatchObject({ status: 'completed', idempotent: true });
      } else {
        expect((await runRow(followerId)).status).toBe('pending');
        if (timing === 'late') {
          expect(lateOffer).toBe(true);
          expect(completions[0].request.consumed_inputs).toEqual([]);
        }
        const successor = await client.poll();
        expect(successor.run_id).toBe(followerId);
        const history = (successor.payload as { turn: { session_jsonl: string } }).turn.session_jsonl;
        if (timing === 'late') expect(history).toContain('Initial answer.');
        else expect(history).toBe('');
        expect((await executeRun(client, successor, {}, config)).error).toBeUndefined();
        expect(executions).toBe(2);
      }
      expect(providerRequests).toHaveLength(2);
      expect(JSON.stringify(providerRequests[0].messages)).not.toContain(followUp.messageText);
      expect(JSON.stringify(providerRequests[1].messages).split(followUp.messageText)).toHaveLength(2);
      const replies = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' AND action_input->'processedMessageIds' ? 'http-follow-up'`;
      expect(replies).toHaveLength(1);
      if (timing === 'mid') expect(replies[0].action_input.processedMessageIds).toEqual([first.messageId, followUp.messageId]);
      expect(errors).toEqual([]);
    } finally {
      releaseProvider(); releaseCleanup(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 25_000);

  it('produces a claimable, schema-valid envelope with the credential lifted off the turn', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const rows = await agentTurnRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_type: 'agent_turn',
      status: 'pending',
      approval_status: 'auto',
      organization_id: org.id,
    });

    const envelope = rows[0].action_input as {
      turn: Record<string, unknown>;
      credential: string;
    };
    // Enqueued turns carry an empty native session; the claim supplies history.
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn: envelope.turn })).toBe(true);

    expect(envelope.turn).toMatchObject({
      agent_id: AGENT_ID,
      conversation_id: 'conv-turn',
      message_id: 'msg-turn',
      message_text: 'what is the isolate lane?',
      provider: {
        api: 'anthropic-messages',
        provider: 'anthropic',
        // Lobu stores "claude/…"; the upstream only knows the bare id.
        model_id: 'claude-opus-4-8',
        base_url: `${GATEWAY_URL}/api/proxy/anthropic/a/${AGENT_ID}/o/${org.id}/u/user-turn`,
      },
      // Deny-all: the gateway proxy and nothing else.
      allowed_hosts: ['gateway.test.invalid'],
    });
    expect(envelope.turn.system_prompt).toBe(
      // The anti-fabrication and disclosure rules lead every turn, whatever
      // tools it carries: "do not claim you checked something unless you did".
      renderBaselineAgentPolicy() +
        '\n\n## Agent Identity\n\nI am the turn agent.\n\n## Agent Instructions\n\nAnswer briefly.\n\n' +
        // Policy text must match the tools this envelope actually offers.
        '## Built-In Tool Policies\n\n' +
        '### Structured User Choices\nTools: `ask_user`\n' +
        '- Use ask_user when you need the user to choose from a short list of options or approvals.\n' +
        '- Use plain text only for open-ended clarifications or when you need a free-form value.\n' +
        "- After calling ask_user, stop. The user's answer arrives as the next message.\n\n" +
        '### Share Created Files\nTools: `upload_file`\n' +
        '- If you create a file that helps answer the request, use upload_file so the user can access it in-thread.\n' +
        '- Never claim a file was sent unless upload_file actually succeeded in this turn.\n' +
        '- Never show sandbox:, workspace, or local filesystem links to the user as if they are downloadable attachments.\n\n' +
        '### Participate In Your Channels\nTools: `list_conversations`, `read_conversation`, `send_message`\n' +
        '- You can participate in chat channels you are bound to, even on a scheduled/automated run with no one messaging you. Call list_conversations to see them.\n' +
        '- To act in a channel: read_conversation to catch up on what people said, then send_message to post. Pass a conversation handle to post to the channel, or a thread handle (returned by a previous send_message) to reply in that thread.\n' +
        '- Only what you send_message reaches the channel — your normal reply text does not. Decide deliberately what and where to post; it is fine to post nothing.\n\n' +
        '## Workspace\n\n' +
        'Your in-memory file workspace is at /workspace; file tools act there when available.\n' +
        'Nothing written to that in-memory workspace persists after the turn ends.\n' +
        'Your bash tool uses the same in-memory workspace when available.\n' +
        'The in-memory environment has no network access and no package manager; use your other tools to reach data.\n' +
        'Nothing in the workspace is visible to the user: to show them a file you produced, call upload_file before the turn ends.\n\n' +
        // The guest applies this prompt verbatim, so Pi's own date line never
        // reaches the model; the retired lane sent one on every turn.
        `Current date: ${new Date().toISOString().slice(0, 10)}`
    );
    expect(envelope.turn.session_jsonl).toBe('');
    // With no tool policy every workspace tool is admitted, bash with the
    // default package-manager denylist and no allowlist.
    const tools = envelope.turn.tools as {
      definitions: unknown[];
      media: string[];
      builtin: string[];
      bash_policy: { allow_all: boolean; allow_prefixes: string[]; deny_prefixes: string[] };
    };
    expect(tools.definitions).toEqual([]);
    expect(tools.media).toEqual(['upload_file', 'generate_image', 'generate_audio']);
    expect(tools.builtin).toEqual(['bash', 'read', 'write', 'edit', 'grep', 'ls', 'find']);
    expect(tools.bash_policy.allow_all).toBe(false);
    expect(tools.bash_policy.allow_prefixes).toEqual([]);
    expect(tools.bash_policy.deny_prefixes).toContain('pip install ');

    // The credential rides OUTSIDE the turn so the poll can lift it onto the
    // response's `credentials` and the worker can conceal it before the guest
    // ever sees a provider key.
    // No `executionMode` on an authoritative turn: `capture` suppresses side
    // effects and reports success anyway, so pinning it here would make the
    // agent claim it sent the message while doing nothing. Only a server-side
    // eval run carries it, derived by `buildWorkerTokenClaims` from the run row.
    const claims = verifyWorkerToken(envelope.credential);
    expect(claims).toMatchObject({ runId: rows[0].id });
    expect(claims).not.toHaveProperty('executionMode');
    expect(JSON.stringify(envelope.turn)).not.toContain('lobu_secret_');
  });

  it('omits file-delivery instructions when upload_file is denied', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.agentOptions = { ...message.agentOptions, disallowedTools: 'upload_file' };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn;
    expect(turn.tools.media).toEqual(['generate_image', 'generate_audio']);
    expect(turn.tools.builtin).toContain('write');
    expect(turn.system_prompt).not.toContain('### Share Created Files');
    expect(turn.system_prompt).not.toContain('call upload_file before the turn ends');
  });

  it('seeds only valid bounded skill files and names their directory in the prompt', async () => {
    const org = await createTestOrganization();
    const content = 'x'.repeat(64_000);
    const agentSettings = {
      getSettings: async () => ({
        identityMd: '',
        soulMd: '',
        userMd: '',
        skillsConfig: {
          skills: [
            { repo: 'owner', name: 'owner/triage', enabled: true, content },
            { repo: 'owner', name: 'bad skill', enabled: true, content: 'skip' },
            { repo: 'owner', name: '..', enabled: true, content: 'skip' },
            { repo: 'owner', name: 'x'.repeat(129), enabled: true, content: 'skip' },
            { repo: 'owner', name: 'oversized', enabled: true, content: 'x'.repeat(64_001) },
            { repo: 'owner', name: 'disabled', enabled: false, content: 'skip' },
          ],
        },
      }),
    } as unknown as AgentSettingsStore;
    await enqueueMessage(messageFor(org.id), {
      agentSettings,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn;
    expect(turn.skills).toEqual([{ name: 'triage', content }]);
    expect(turn.system_prompt).toContain('/workspace/.skills');
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn })).toBe(true);
  });

  it('REGRESSION: an Automation run seeds its VERSION-PINNED skills, not the live library', async () => {
    // The live library must not re-enter a frozen Automation: editing or
    // disabling a skill after approval would change the instructions an
    // already-approved Automation runs, and unrelated live skills would join
    // the run. The isolate producer read `agentSettings.skillsConfig`
    // unconditionally, so both happened.
    const sql = getTestDb();
    const org = await createTestOrganization();
    const author = await createTestUser({ name: 'Pinned Author' });
    const [automation] = await sql<{ id: number }>`
      INSERT INTO automations (organization_id, created_by, automation_group_id, name, slug, managed_agent_id)
      VALUES (${org.id}, ${author.id}, 0, 'Pinned skills', 'pinned-skills', ${AGENT_ID})
      RETURNING id
    `;
    const automationId = Number(automation!.id);
    await sql`UPDATE automations SET automation_group_id = ${automationId} WHERE id = ${automationId}`;
    const [version] = await sql<{ id: number }>`
      INSERT INTO automation_versions (automation_id, version, name, created_by, prompt, skills)
      VALUES (${automationId}, 1, 'Pinned skills', ${author.id}, 'prompt',
        ${sql.json([{ name: 'frozen', content: 'Frozen instructions.' }])})
      RETURNING id
    `;
    const [runRow] = await sql<{ id: number }>`
      INSERT INTO runs (organization_id, run_type, queue_name, status, automation_id, approved_input)
      VALUES (${org.id}, 'automation', 'automations', 'running', ${automationId},
        ${sql.json({ version_id: Number(version!.id) })})
      RETURNING id
    `;

    // The live library holds a DIFFERENT skill, which must not appear.
    const liveSettings = {
      getSettings: async () => ({
        identityMd: '', soulMd: '', userMd: '',
        skillsConfig: { skills: [{ repo: 'o', name: 'edited-after-approval', enabled: true, content: 'Live drift.' }] },
      }),
    } as unknown as AgentSettingsStore;

    await enqueueMessage(
      {
        ...messageFor(org.id),
        // The canonical correlation the resolver scopes its query by.
        conversationId: `${AGENT_ID}_automation_${automationId}_run_${Number(runRow!.id)}`,
      },
      { agentSettings: liveSettings, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL },
    );

    const runs = await agentTurnRuns();
    const turn = runs[runs.length - 1]!.action_input.turn as { skills?: Array<{ name: string; content: string }> };
    expect(turn.skills).toEqual([{ name: 'frozen', content: 'Frozen instructions.' }]);
  });

  it('does not advertise seeded inputs when a strict bash policy rejects cat', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.platformMetadata = {
      files: [{ id: 'art-doc', name: 'report.pdf', mimetype: 'application/pdf' }],
    };
    message.agentOptions = {
      model: 'claude/claude-opus-4-8',
      toolsConfig: { strictMode: true, allowedTools: ['Bash(git:*)'] },
    };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      artifacts: fakeArtifacts(),
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn;
    expect(turn.tools.builtin).toEqual(['bash']);
    expect(turn.message_files[0].data).toBe(Buffer.from('%PDF').toString('base64'));
    expect(turn.system_prompt).not.toContain('/workspace/input');
  });

  it('hands the turn its tools, its one credential being a worker token both gateway routes accept', async () => {
    const org = await createTestOrganization();
    const fixture = mcpFixture();
    const message = messageFor(org.id);
    message.platformMetadata = { connectionId: 'conn-turn' };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: fixture.mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const envelope = run.action_input as {
      turn: { tools?: Record<string, unknown>; system_prompt: string };
      credential: string;
    };
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn: envelope.turn })).toBe(true);

    // The credential is a worker token minted for THIS agent, user, org and
    // conversation: the secret proxy binds it to the agent in the proxy URL and
    // the MCP route authenticates it, so the guest holds exactly one secret.
    const claims = verifyWorkerToken(envelope.credential);
    expect(claims).toMatchObject({
      agentId: AGENT_ID,
      userId: 'user-turn',
      organizationId: org.id,
      conversationId: 'conv-turn',
      channelId: 'api_user-turn',
      connectionId: 'conn-turn',
      messageId: 'msg-turn',
      deploymentName: 'agent-turn:msg-turn',
    });
    expect(JSON.stringify(envelope.turn)).not.toContain(envelope.credential);

    // Discovery ran as the turn's own identity, with the same token.
    expect(fixture.listed).toEqual([
      { mcpId: 'lobu-memory', agentId: AGENT_ID, token: envelope.credential },
    ]);
    expect(envelope.turn.tools).toMatchObject({
      gateway_url: GATEWAY_URL,
      builtin: ['bash', 'read', 'write', 'edit', 'grep', 'ls', 'find'],
      definitions: [
        {
          mcp_id: 'lobu-memory',
          name: 'query_sdk',
          description: 'Read data',
          input_schema: { type: 'object', properties: { code: { type: 'string' } } },
        },
        {
          mcp_id: 'lobu-memory',
          name: 'run_sdk',
          description: 'Write data',
          input_schema: { type: 'object', properties: { code: { type: 'string' } } },
        },
        // No description and no schema published: the same defaults the
        // subprocess lane's plugin fills in.
        {
          mcp_id: 'lobu-memory',
          name: 'query_sql',
          description: 'MCP tool from lobu-memory',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    });
    // The server's own instructions join the prompt after the agent layers.
    expect(envelope.turn.system_prompt.endsWith(
      `\n\nUse query_sdk before run_sdk.\n\nCurrent date: ${new Date().toISOString().slice(0, 10)}`,
    )).toBe(true);
  });

  // The policy is the agent's own (`buildToolPolicy`, shared with the
  // subprocess lane); applying it to MCP tools is this lane's own stricter
  // choice — the subprocess lane registers its MCP tools unfiltered.
  it('filters the tools through the agent tool policy', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.agentOptions = {
      model: 'claude/claude-opus-4-8',
      toolsConfig: { strictMode: true, allowedTools: ['query_*'] },
      disallowedTools: 'query_sql',
    };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as {
      tools?: { definitions: Array<{ name: string }>; builtin?: string[]; bash_policy?: unknown };
      system_prompt: string;
    };
    expect(turn.tools?.definitions.map((tool) => tool.name)).toEqual(['query_sdk']);
    // Strict mode admits only what the allowlist names, and `query_*` names
    // no workspace tool — so there is no workspace, no bash policy to carry,
    // and no workspace section in the prompt.
    expect(turn.tools?.builtin).toBeUndefined();
    expect(turn.tools?.bash_policy).toBeUndefined();
    expect(turn.system_prompt).not.toContain('## Workspace');
  });

  it('carries the bash prefix policy with the workspace, and drops the tools the policy denies', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.agentOptions = {
      model: 'claude/claude-opus-4-8',
      toolsConfig: { allowedTools: ['Bash(git:*)', 'Bash(ls:*)'], deniedTools: ['write', 'Bash(rm:*)'] },
    };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as {
      tools?: {
        definitions: unknown[];
        builtin: string[];
        bash_policy: { allow_all: boolean; allow_prefixes: string[]; deny_prefixes: string[] };
      };
    };
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn })).toBe(true);
    // No MCP surface wired, yet the workspace still ships: the two halves of
    // the manifest are independent.
    expect(turn.tools?.definitions).toEqual([]);
    // `write` is denied; `edit` is a different tool and stays.
    expect(turn.tools?.builtin).toEqual(['bash', 'read', 'edit', 'grep', 'ls', 'find']);
    expect(turn.tools?.bash_policy.allow_all).toBe(false);
    expect(turn.tools?.bash_policy.allow_prefixes).toEqual(['git', 'ls']);
    expect(turn.tools?.bash_policy.deny_prefixes.slice(-1)).toEqual(['rm']);
    expect(turn.tools?.bash_policy.deny_prefixes).toContain('npm install ');
  });

  it('hands the turn the conversation tools its policy admits, addressed at this conversation', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as {
      tools?: { gateway?: string[]; conversation?: Record<string, string> };
    };
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn })).toBe(true);
    // With no policy every conversation tool is admitted. Names only: the
    // routing and the schemas live in `@lobu/plugin-conversations`, which the
    // guest runs directly, so nothing about the tools crosses this wire.
    expect(turn.tools?.gateway).toEqual([
      'list_conversations',
      'read_conversation',
      'send_message',
      'present_event',
      'schedule_followup',
      'react',
      'edit_message',
      'delete_message',
      'ask_user',
      'suggest_actions',
    ]);
    // Every one of them addresses a channel, so the routing travels with them
    // rather than being inferred inside the isolate.
    expect(turn.tools?.conversation).toEqual({
      channel_id: message.channelId,
      conversation_id: message.conversationId,
      platform: message.platform,
    });
  });

  it('denies a conversation tool the agent policy denies, on the same patterns the subprocess lane reads', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.agentOptions = {
      model: 'claude/claude-opus-4-8',
      toolsConfig: { deniedTools: ['ask_user', 'send_message'] },
    };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as { tools?: { gateway?: string[] } };
    expect(turn.tools?.gateway).not.toContain('ask_user');
    expect(turn.tools?.gateway).not.toContain('send_message');
    expect(turn.tools?.gateway).toContain('suggest_actions');
  });

  it('runs the turn without tools when it cannot honour them, and still enqueues it', async () => {
    const org = await createTestOrganization();
    const base = {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    };
    let produced = 0;
    const toolless = async () => {
      const rows = await agentTurnRuns();
      produced += 1;
      expect(rows).toHaveLength(produced);
      const turn = rows[produced - 1].action_input.turn as { tools?: { definitions: unknown[]; builtin?: string[] } };
      // The workspace tools are the policy's business, not the MCP surface's:
      // they ship regardless, with no MCP definitions beside them.
      // No tools means no gateway URL for the memory hooks either, so the
      // envelope promises no memory it cannot deliver.
      expect((turn as { memory?: unknown }).memory).toBeUndefined();
      expect(turn.tools?.definitions).toEqual([]);
      expect(turn.tools?.builtin).toEqual(['bash', 'read', 'write', 'edit', 'grep', 'ls', 'find']);
    };

    // No MCP surface wired.
    await enqueueMessage(messageFor(org.id), base);
    await toolless();

    // An unrecognised `toolsConfig` key must not cost the agent its tools. The
    // retired `mcpExposure: 'cli'` setting is what made this worth asserting:
    // its only implementation lived in the deleted worker package, and a
    // producer that treated an unknown presentation preference as "no tools"
    // would disable a working agent over a field it simply does not read.
    const extra = messageFor(org.id);
    extra.agentOptions = {
      model: 'claude/claude-opus-4-8',
      // A key the producer does not read at all — `mcpExposure` was exactly
      // this shape once its implementation was deleted. Not `strictMode`,
      // which really does filter the tool list.
      toolsConfig: { mcpPresentation: 'shell' } as never,
    };
    await enqueueMessage(extra, { ...base, mcp: mcpFixture().mcp });
    produced += 1;
    const extraRows = await agentTurnRuns();
    expect(extraRows).toHaveLength(produced);
    const extraTurn = extraRows[produced - 1].action_input.turn as { tools?: { definitions?: Array<{ name: string }> } };
    expect(extraTurn.tools?.definitions?.map((tool) => tool.name)).toContain('query_sdk');

    // A separate placeholder cannot enforce the signed capture policy.
    const before = (await agentTurnRuns()).length;
    await enqueueMessage(messageFor(org.id), {
      ...base,
      catalog: catalogFor(claudeModule({ buildCredentialPlaceholder: () => 'lobu_secret_11111111-2222-3333-4444-555555555555' })),
      mcp: mcpFixture().mcp,
    });
    expect(await agentTurnRuns()).toHaveLength(before);

    // Discovery failed: nothing to hand the turn, but the turn itself runs.
    await enqueueMessage(messageFor(org.id), { ...base, mcp: mcpFixture({ fail: true }).mcp });
    await toolless();
  });

  it('passes native tool history and provider metadata to Pi without gateway rewriting', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const at = new Date(Date.now() - 60_000).toISOString();
    let parentId: string | null = null;
    const entry = (id: string, message: Record<string, unknown>) => {
      const line = JSON.stringify({ type: 'message', id, parentId, timestamp: at, message });
      parentId = id;
      return line;
    };
    const assistant = (content: unknown[]) => ({
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: 1,
    });
    const snapshot = [
      JSON.stringify({ type: 'session', version: 3, id: 'prior', timestamp: at, cwd: '/w' }),
      // Interrupted tool history is passed through for Pi to repair.
      entry('orphan', { role: 'toolResult', toolCallId: 'toolu_00', toolName: 'query_sdk', content: [{ type: 'text', text: 'stale' }], isError: false, timestamp: 1 }),
      entry('u1', { role: 'user', content: 'how many entities?', timestamp: 1 }),
      entry('a1', assistant([
        { type: 'thinking', thinking: 'let me count', thinkingSignature: 'sig' },
        { type: 'toolCall', id: 'toolu_01', name: 'query_sdk', arguments: { code: 'entities.count()' } },
      ])),
      entry('t1', { role: 'toolResult', toolCallId: 'toolu_01', toolName: 'query_sdk', content: [{ type: 'text', text: '3 entities' }], isError: false, timestamp: 1 }),
      entry('a2', { ...assistant([{ type: 'text', text: 'There are 3.' }]), stopReason: 'stop' }),
      entry('u2', { role: 'user', content: 'and companies?', timestamp: 1 }),
      // The last turn died mid-call; the gateway must preserve this entry too.
      entry('a3', assistant([{ type: 'toolCall', id: 'toolu_02', name: 'query_sdk', arguments: {} }])),
      '',
    ].join('\n');
    const [prior] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
      VALUES ('chat_message', 'completed', ${org.id}, ${at}, ${at}, ${at})
      RETURNING id
    `;
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
      VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${prior.id}, ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed', ${at})
    `;

    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    expect((run.action_input.turn as Record<string, unknown>).session_jsonl).toBe('');
    const claimed = await (await pollFleet('fleet-native-history', { agent_turn: true })).json();
    // Pi owns branch replay, provider conversion and interrupted tool repair.
    // The gateway preserves the complete native session, including signatures.
    expect(claimed.payload.turn.session_jsonl).toBe(snapshot);
    expect(claimed.payload.turn).not.toHaveProperty('messages');
    expect(claimed.payload.turn).not.toHaveProperty('message_entry_ids');
    expect(claimed.payload.turn.memory_flush).not.toHaveProperty('due');
  });

  it('passes the whole native session with compaction and memory state at claim time', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const at = new Date(Date.now() - 60_000).toISOString();
    const entry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
      JSON.stringify({ type: 'message', id, parentId, timestamp: at, message });
    const reply = (text: string) => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      stopReason: 'stop',
      timestamp: 1,
    });
    // Forty turns — far past the twelve messages the lane used to keep — with a
    // compaction in the middle, exactly as pi's SessionManager writes one.
    const lines: string[] = [JSON.stringify({ type: 'session', version: 3, id: 'long', timestamp: at, cwd: '/w' })];
    let parent: string | null = null;
    for (let i = 0; i < 10; i++) {
      lines.push(entry(`u${i}`, parent, { role: 'user', content: `question ${i}`, timestamp: 1 }));
      lines.push(entry(`a${i}`, `u${i}`, reply(`answer ${i}`)));
      parent = `a${i}`;
    }
    lines.push(
      JSON.stringify({
        type: 'compaction',
        id: 'c1',
        parentId: parent,
        timestamp: at,
        summary: 'The first eight exchanges were small talk.',
        firstKeptEntryId: 'u8',
        tokensBefore: 90000,
      })
    );
    // This cycle already flushed: the subprocess lane's own state entry.
    lines.push(
      JSON.stringify({
        type: 'custom',
        id: 'flush1',
        parentId: 'c1',
        timestamp: at,
        customType: 'lobu.memory_flush_state',
        data: { compactionCount: 1, outcome: 'stored', timestamp: 1 },
      })
    );
    parent = 'flush1';
    for (let i = 10; i < 40; i++) {
      lines.push(entry(`u${i}`, parent, { role: 'user', content: `question ${i}`, timestamp: 1 }));
      lines.push(entry(`a${i}`, `u${i}`, reply(`answer ${i}`)));
      parent = `a${i}`;
    }
    const snapshot = `${lines.join('\n')}\n`;
    const [prior] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
      VALUES ('chat_message', 'completed', ${org.id}, ${at}, ${at}, ${at})
      RETURNING id
    `;
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
      VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${prior.id}, ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed', ${at})
    `;

    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    expect((run.action_input.turn as Record<string, unknown>).session_jsonl).toBe('');
    const claimed = await (await pollFleet('fleet-native-compacted', { agent_turn: true })).json();
    const turn = claimed.payload.turn;
    expect(turn.session_jsonl).toBe(snapshot);
    expect(turn.compaction).toMatchObject({ enabled: true, reserve_tokens: 16384, keep_recent_tokens: 20000 });
    expect(turn.compaction.context_window).toBeGreaterThan(16384);
    expect(turn.memory_flush).toMatchObject({ enabled: true, soft_threshold_tokens: 4000 });
    expect(turn.memory_flush).not.toHaveProperty('due');
  });

  it('reads the latest native snapshot when a queued turn is claimed', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const dependencies = { agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL };
    const firstSource = await admittedMessage(messageFor(org.id));
    const secondSource = await admittedMessage({ ...messageFor(org.id), messageId: 'queued-second' });
    await enqueueAgentTurn(firstSource, dependencies);
    await enqueueAgentTurn(secondSource, dependencies);
    const [first, second] = await agentTurnRuns();
    expect(first.id).toBeGreaterThan(secondSource.runId!);
    const firstClaim = await pollFleet('fleet-native-first', { agent_turn: true });
    expect((await firstClaim.json()).run_id).toBe(first.id);
    const session = nativeSession();
    const completed = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: first.id, worker_id: 'fleet-native-first', status: 'completed', text: 'the isolate answer', session_jsonl: session,
    });
    expect((await completed.json()).status).toBe('completed');
    const secondClaim = await pollFleet('fleet-native-second', { agent_turn: true });
    const claimed = await secondClaim.json();
    expect(claimed.run_id).toBe(second.id);
    expect(claimed.payload.turn.session_jsonl).toBe(session);
    expect(claimed.payload.turn).not.toHaveProperty('messages');
    expect(claimed.payload.turn).not.toHaveProperty('message_entry_ids');
    expect(claimed.payload.turn.memory_flush).not.toHaveProperty('due');
  });

  it('trims the persisted session to its latest compaction when it outgrows the cap', async () => {
    // Pi's session log is append-only, so a conversation that has crossed the
    // cap crosses it again on every later turn: failing the completion here
    // handed the user a raw internal error and then failed every message
    // after it, since each one re-hydrated the same last stored snapshot.
    const org = await createTestOrganization();
    const sql = getTestDb();
    const dependencies = { agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL };
    await enqueueAgentTurn(await admittedMessage(messageFor(org.id)), dependencies);
    await enqueueAgentTurn(await admittedMessage({ ...messageFor(org.id), messageId: 'after-trim' }), dependencies);
    const [first, second] = await agentTurnRuns();
    expect((await (await pollFleet('fleet-oversize', { agent_turn: true })).json()).run_id).toBe(first.id);
    const message = (id: string, parentId: string | null, role: string, text: string) => ({
      type: 'message', id, parentId, message: { role, content: [{ type: 'text', text }], timestamp: 1 },
    });
    // Ten exchanges, one of them alone larger than the cap, then the compaction
    // pi wrote for them: it keeps `u8` onward and summarised the rest.
    const before = Array.from({ length: 10 }, (_v, i) => [
      message(`u${i}`, i === 0 ? null : `a${i - 1}`, 'user', i === 3 ? 'x'.repeat(4 * 1024 * 1024) : `question ${i}`),
      message(`a${i}`, `u${i}`, 'assistant', `answer ${i}`),
    ]).flat();
    const compaction = { type: 'compaction', id: 'c1', parentId: 'a9', summary: 'The first eight exchanges were small talk.', firstKeptEntryId: 'u8', tokensBefore: 90_000 };
    const after = [message('u10', 'c1', 'user', 'what is the isolate lane?'), message('a10', 'u10', 'assistant', 'the isolate answer')];
    const completed = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: first.id, worker_id: 'fleet-oversize', status: 'completed', text: 'the isolate answer',
      session_jsonl: nativeSession([...before, compaction, ...after]),
    });
    expect((await completed.json()).status).toBe('completed');

    // Exactly what pi still sends the model, and nothing it no longer does: the
    // kept exchanges from `u8` (now the root), the summary, and everything
    // after it. The row is the trimmed log, and the run row keeps the same.
    const trimmed = nativeSession([{ ...before[16]!, parentId: null }, ...before.slice(17), compaction, ...after]);
    const [snapshot] = await sql`SELECT snapshot_jsonl, byte_size FROM agent_transcript_snapshot WHERE run_id = ${first.id}`;
    expect(snapshot.snapshot_jsonl).toBe(trimmed);
    expect(snapshot.byte_size).toBe(Buffer.byteLength(trimmed));
    const row = await runRow(first.id);
    expect(row.status).toBe('completed');
    expect(row.output_tail).toBe('the isolate answer');
    expect(row.action_input.result).toMatchObject({ session_jsonl: trimmed });
    const [reply] = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' AND action_input->>'finalText' = 'the isolate answer'`;
    expect(reply.action_input).toMatchObject({ conversationId: 'conv-turn', finalText: 'the isolate answer' });
    // And the next turn resumes from it rather than failing the same way.
    const claimed = await (await pollFleet('fleet-after-trim', { agent_turn: true })).json();
    expect(claimed.run_id).toBe(second.id);
    expect(claimed.payload.turn.session_jsonl).toBe(trimmed);
  });

  it('resets the native session when an oversize snapshot has no compaction to trim to', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const dependencies = { agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL };
    await enqueueAgentTurn(await admittedMessage(messageFor(org.id)), dependencies);
    await enqueueAgentTurn(await admittedMessage({ ...messageFor(org.id), messageId: 'after-reset' }), dependencies);
    const [first, second] = await agentTurnRuns();
    expect((await (await pollFleet('fleet-oversize', { agent_turn: true })).json()).run_id).toBe(first.id);
    const oversized = nativeSession([
      { type: 'message', id: 'native-user', parentId: null,
        message: { role: 'user', content: 'what is the isolate lane?', timestamp: 1 } },
      { type: 'message', id: 'native-answer', parentId: 'native-user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }], timestamp: 2 } },
    ]);
    const completed = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: first.id, worker_id: 'fleet-oversize', status: 'completed', text: 'the isolate answer', session_jsonl: oversized,
    });
    expect((await completed.json()).status).toBe('completed');

    // The turn still delivered; the session row exists, empty, and the next
    // turn starts fresh instead of failing.
    const row = await runRow(first.id);
    expect(row.status).toBe('completed');
    expect(row.output_tail).toBe('the isolate answer');
    expect(row.action_input.result).toMatchObject({ session_jsonl: '' });
    const [snapshot] = await sql`SELECT byte_size FROM agent_transcript_snapshot WHERE run_id = ${first.id}`;
    expect(snapshot.byte_size).toBe(0);
    const claimed = await (await pollFleet('fleet-after-reset', { agent_turn: true })).json();
    expect(claimed.run_id).toBe(second.id);
    expect(claimed.payload.turn.session_jsonl).toBe('');
  });

  it('carries the platform identity block the platform adapter registered', async () => {
    // The retired lane's `platformInstructions` — "you are reachable in Slack
    // as `@bot`; mentions of `<@U…>` are you". Without it a chat agent has
    // only third-person identity markdown and guesses whether the message is
    // addressed to it.
    const org = await createTestOrganization();
    const asked: Array<{ platform: string; connectionId?: string; organizationId?: string }> = [];
    await enqueueMessage({ ...messageFor(org.id), platform: 'slack', platformMetadata: { connectionId: 'conn-slack-1' } }, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      instructions: {
        getPlatformInstructions: async (platform, context) => {
          asked.push({ platform, connectionId: context.connectionId, organizationId: context.organizationId });
          return '**Slack identity:**\n- You are reachable in Slack as `@lobu` (user ID `U123`).';
        },
      },
    });
    const [run] = await agentTurnRuns();
    const prompt = (run.action_input.turn as { system_prompt: string }).system_prompt;
    expect(asked).toEqual([{ platform: 'slack', connectionId: 'conn-slack-1', organizationId: org.id }]);
    // After the agent's own layers, before the tool policies.
    expect(prompt).toContain('## Agent Instructions\n\nAnswer briefly.\n\n**Slack identity:**\n- You are reachable in Slack as `@lobu` (user ID `U123`).\n\n## Built-In Tool Policies');
  });

  it('rolls back the claim when its native snapshot cannot be read', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    const realDb = db.getDb();
    let attemptedRead = false;
    const unavailable = new Proxy(realDb, {
      get(target, property) {
        if (property === 'begin') return (fn: (tx: db.DbClient) => Promise<unknown>) =>
          target.begin((tx) => fn(new Proxy(tx, {
            apply(query, thisArg, args: unknown[]) {
              const parts = args[0] as TemplateStringsArray;
              if (Array.isArray(parts) && parts.join('').includes('FROM public.agent_transcript_snapshot')) {
                attemptedRead = true;
                throw new Error('synthetic snapshot read failure');
              }
              return Reflect.apply(query, thisArg, args);
            },
          })));
        return Reflect.get(target, property);
      },
    });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(unavailable);
    try {
      const response = await pollFleet('fleet-snapshot-unavailable', { agent_turn: true });
      expect(response.status).toBe(500);
      expect(attemptedRead).toBe(true);
      expect((await runRow(run.id)).status).toBe('pending');
    } finally {
      spy.mockRestore();
    }
    const sql = getTestDb();
    const current = nativeSession();
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
      VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${run.parent_run_id}, ${current}, ${Buffer.byteLength(current)}, 'completed')
    `;
    const retry = await pollFleet('fleet-snapshot-retry', { agent_turn: true });
    const claimed = await retry.json();
    expect(claimed.run_id).toBe(run.id);
    // The retry reads the conversation's whole snapshot. It used to be bounded
    // to before the source message, which made this `''`; a turn that answers
    // the conversation replays all of it.
    expect(claimed.payload.turn.session_jsonl).toBe(current);
  });

  it('repeats durable pending inputs after a lost heartbeat response', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-repeat-input', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'durable-follow-up', messageText: 'keep this input' }, deps);
    const follower = (await agentTurnRuns())[1];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await postAsFleet('/api/workers/heartbeat', { run_id, worker_id: 'fleet-repeat-input' });
      expect(await response.json()).toMatchObject({ continue: true, steer: [
        { run_id: follower.id, message_id: 'durable-follow-up', text: 'keep this input' },
      ] });
    }
    expect((await runRow(follower.id)).status).toBe('pending');
  });

  it('offers a follow-up whose transient context differs, and carries that context', async () => {
    // The API route attaches a live workspace-attention block, and it changes
    // as runs appear, so two messages sent seconds apart almost never carry
    // the same one. Per-message content is not execution policy, so the
    // follow-up is still offered — AND the offer carries the follower's own
    // block, so the guest can show the model the context that belongs beside
    // that message. Dropping it here would have meant the offer policy had to
    // refuse any message carrying one, which is the same data loss moved
    // earlier.
    const org = await createTestOrganization();
    const first = { ...messageFor(org.id), ephemeralContext: '## Workspace attention (recent)\n- Run #1 [pending]' };
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-transient-context', { agent_turn: true })).json();
    await enqueueMessage({
      ...first, messageId: 'context-follow-up', messageText: 'and this too',
      ephemeralContext: '## Workspace attention (recent)\n- Run #1 [pending]\n- Run #2 [pending]',
    }, deps);
    const [owner, follower] = await agentTurnRuns();
    expect(owner.action_input.turn.ephemeral_context).not.toBe(follower.action_input.turn.ephemeral_context);
    const response = await postAsFleet('/api/workers/heartbeat', { run_id, worker_id: 'fleet-transient-context' });
    expect(await response.json()).toMatchObject({ continue: true, steer: [
      {
        run_id: follower.id,
        message_id: 'context-follow-up',
        text: 'and this too',
        // The FOLLOWER's block, not the owner's: this is the message the model
        // is about to answer.
        ephemeral_context: '## Workspace attention (recent)\n- Run #1 [pending]\n- Run #2 [pending]',
      },
    ] });
  });

  it('offers a follow-up with no transient context without inventing one', async () => {
    // The owner carries a block and the follower does not. The offer must omit
    // the field rather than inherit the owner's, or the model would be told
    // stale context belongs beside a message that never had any.
    const org = await createTestOrganization();
    const first = { ...messageFor(org.id), ephemeralContext: '## Workspace attention (recent)\n- Run #1 [pending]' };
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-no-context', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'bare-follow-up', messageText: 'no context here', ephemeralContext: undefined }, deps);
    const [, follower] = await agentTurnRuns();

    const response = await postAsFleet('/api/workers/heartbeat', { run_id, worker_id: 'fleet-no-context' });
    const body = (await response.json()) as { steer?: Array<Record<string, unknown>> };
    expect(body.steer?.[0]).toMatchObject({ run_id: follower.id, message_id: 'bare-follow-up' });
    expect(body.steer?.[0]).not.toHaveProperty('ephemeral_context');
  });

  it('does not offer a follow-up admitted under a different model', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-policy-model', { agent_turn: true })).json();
    await enqueueMessage({
      ...first, messageId: 'other-model-follow-up', agentOptions: { model: 'claude/claude-sonnet-4-5' },
    }, deps);
    const response = await postAsFleet('/api/workers/heartbeat', { run_id, worker_id: 'fleet-policy-model' });
    expect(await response.json()).toEqual({ continue: true });
    expect((await agentTurnRuns())[1]!.status).toBe('pending');
  });

  it('does not offer an input whose signed credential belongs to another run', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-input-token-scope', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'wrong-token-input' }, deps);
    const [owner, follower] = await agentTurnRuns();
    const sql = getTestDb();
    await sql`UPDATE runs SET action_input = jsonb_set(action_input, '{credential}',
      (SELECT action_input->'credential' FROM runs WHERE id = ${owner.id})) WHERE id = ${follower.id}`;
    const response = await postAsFleet('/api/workers/heartbeat', {
      run_id, worker_id: 'fleet-input-token-scope',
    });
    expect(await response.json()).toEqual({ continue: true });
    expect((await runRow(follower.id)).status).toBe('pending');
  });

  it('deduplicates concurrent admission and replay after native completion', async () => {
    const org = await createTestOrganization();
    const source = await admittedMessage(messageFor(org.id));
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await Promise.all([enqueueAgentTurn(source, deps), enqueueAgentTurn(source, deps)]);
    expect(await agentTurnRuns()).toHaveLength(1);
    const sql = getTestDb();
    await sql`UPDATE runs SET status = 'completed' WHERE run_type = 'agent_turn' AND organization_id = ${org.id}`;
    await enqueueAgentTurn(source, deps);
    expect(await agentTurnRuns()).toHaveLength(1);
  });

  it('keeps cancellation nonterminal until its worker reports cleanup', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-stop-report', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'after-cancel' }, deps);
    const cancel = await admittedMessage({ ...first, messageId: 'stop-request', messageText: '/cancel' });
    await cancelAgentTurn(cancel);
    expect((await runRow(run_id)).status).toBe('running');
    expect((await (await pollFleet('fleet-next', { agent_turn: true })).json()).run_id).toBeUndefined();
    const report = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id, worker_id: 'fleet-stop-report', status: 'failed', error: 'aborted',
    });
    expect(await report.json()).toMatchObject({ status: 'cancelled' });
    expect((await (await pollFleet('fleet-next', { agent_turn: true })).json()).run_type).toBe('agent_turn');
  });

  async function inputScenario(texts = ['same text', 'same text'], base = '') {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const sql = getTestDb();
    if (base) {
      const prior = await admittedMessage({ ...first, messageId: 'prior-source' });
      await sql`INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
        VALUES (${org.id}, ${AGENT_ID}, ${first.conversationId}, ${prior.runId!}, ${base}, ${Buffer.byteLength(base)}, 'completed')`;
    }
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const [owner] = await agentTurnRuns();
    const worker_id = 'fleet-input-receipts';
    const job = await (await pollFleet(worker_id, { agent_turn: true })).json();
    for (const [index, text] of texts.entries()) {
      await enqueueMessage({ ...first, messageId: `input-${index}`, messageText: text }, deps);
    }
    const followers = (await agentTurnRuns()).slice(1);
    const entries = [
      ...(base ? base.trim().split('\n').slice(1).map((line) => JSON.parse(line)) : []),
      { type: 'message', id: 'current-user', parentId: base ? JSON.parse(base.trim().split('\n').at(-1)!).id : null,
        message: { role: 'user', content: first.messageText, timestamp: 1 } },
      ...texts.map((text, index) => ({ type: 'message', id: `input-entry-${index}`,
        parentId: index ? `input-entry-${index - 1}` : 'current-user', message: { role: 'user', content: text, timestamp: 2 + index } })),
    ];
    const body = { run_id: owner.id, worker_id, status: 'completed', text: 'all inputs answered',
      session_jsonl: nativeSession(entries), consumed_inputs: followers.map((row, index) => ({ run_id: row.id, session_entry_id: `input-entry-${index}` })) };
    return { sql, org, first, deps, owner, followers, job, body };
  }

  it('commits identical-text inputs by distinct native identities, once', async () => {
    const { sql, owner, followers, body } = await inputScenario();
    const response = await postAsFleet('/api/workers/complete-agent-turn', body);
    expect(await response.json()).toEqual({ ok: true, status: 'completed' });
    const rows = await sql`SELECT status, claimed_by, claimed_at, completed_at, output_tail, outcome, exit_reason, run_metadata, action_input
      FROM runs WHERE id IN (${followers[0].id}, ${followers[1].id}) ORDER BY id`;
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({ status: 'completed', claimed_by: null, claimed_at: null, outcome: 'scoreable', exit_reason: 'ok',
        output_tail: body.text, run_metadata: { consumed_by_run_id: owner.id, session_entry_id: `input-entry-${index}` } });
      expect(row.completed_at).not.toBeNull();
      expect(row.action_input).not.toHaveProperty('result');
    }
    const retry = await postAsFleet('/api/workers/complete-agent-turn', { ...body, status: 'failed', error: 'lost response' });
    expect(await retry.json()).toEqual({ ok: true, status: 'completed', idempotent: true });
    expect(await sql`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${owner.id}`).toHaveLength(1);
    const replies = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' AND action_input->>'messageId' = 'msg-turn'`;
    expect(replies).toHaveLength(1);
    expect(replies[0].action_input.processedMessageIds).toEqual(['msg-turn', 'input-0', 'input-1']);
    // This scenario arms no marker and queues no pending input, so these two
    // assert that completion INVENTS neither — not that discharge works. Real
    // discharge (arm, extend, discharge) is proven in the dedicated
    // `agent-turn-marker-discharge` suite, which calls `armTurnTimeout`.
    expect(await sql`SELECT id FROM runs WHERE queue_name = 'internal:turn_timeout'`).toHaveLength(0);
    expect(await sql`SELECT message_id FROM agent_run_input`).toHaveLength(0);
  });

  it.each(['missing', 'duplicate-run', 'duplicate-entry', 'wrong-run', 'wrong-entry', 'wrong-text', 'out-of-order', 'initial-entry', 'abandoned-branch'])(
    'rejects %s receipts without completing any pending input', async (kind) => {
      const { body, followers } = await inputScenario();
      if (kind === 'missing') body.consumed_inputs = undefined as never;
      if (kind === 'duplicate-run') body.consumed_inputs[1].run_id = followers[0].id;
      if (kind === 'duplicate-entry') body.consumed_inputs[1].session_entry_id = 'input-entry-0';
      if (kind === 'wrong-run') body.consumed_inputs[0].run_id = body.run_id;
      if (kind === 'wrong-entry') body.consumed_inputs[0].session_entry_id = 'missing-entry';
      if (kind === 'wrong-text') body.session_jsonl = body.session_jsonl.replace('same text', 'different text');
      if (kind === 'out-of-order') body.consumed_inputs.reverse();
      if (kind === 'initial-entry') body.consumed_inputs[0].session_entry_id = 'current-user';
      if (kind === 'abandoned-branch') body.session_jsonl += JSON.stringify({ type: 'message', id: 'new-branch', parentId: 'current-user',
        timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: 'different branch' } }) + '\n';
      const response = await postAsFleet('/api/workers/complete-agent-turn', body);
      expect(await response.json()).toMatchObject({ status: 'failed' });
      expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['failed', 'pending', 'pending']);
    },
  );

  it.each(['current', 'older', 'pre-existing-entry', 'wrong-session', 'missing-boundary', 'compaction'])(
    'checks %s native base identity before consuming follow-ups', async (kind) => {
      const base = nativeSession().replace('what is the isolate lane?', 'same text').replace('"version":3', kind === 'older' ? '"version":2' : '"version":3');
      const { body, job } = await inputScenario(undefined, base);
      expect(job.payload.turn.session_jsonl).toBe(base);
      const beat = await postAsFleet('/api/workers/heartbeat', { run_id: body.run_id, worker_id: body.worker_id });
      expect((await beat.json()).steer?.length ?? 0).toBe(kind === 'older' ? 0 : 2);
      if (kind === 'pre-existing-entry') body.consumed_inputs[0].session_entry_id = 'native-user';
      if (kind === 'wrong-session') body.session_jsonl = body.session_jsonl.replace('"id":"native-session"', '"id":"different-session"');
      if (kind === 'missing-boundary') body.session_jsonl = body.session_jsonl.replaceAll('native-answer', 'renamed-base-entry');
      if (kind === 'compaction') body.session_jsonl += JSON.stringify({ type: 'compaction', id: 'compact-inputs', parentId: 'input-entry-1',
        timestamp: '2026-01-01T00:00:00.000Z', firstKeptEntryId: 'input-entry-1', summary: 'Earlier input summarized', tokensBefore: 100 }) + '\n';
      const response = await postAsFleet('/api/workers/complete-agent-turn', body);
      expect((await response.json()).status).toBe(['current', 'compaction'].includes(kind) ? 'completed' : 'failed');
    },
  );

  it('rolls back owner, input receipts, snapshot and delivery together', async () => {
    const { sql, owner, body } = await inputScenario();
    const realDb = db.getDb();
    const broken = new Proxy(realDb, { get(target, property) {
      if (property === 'begin') return (fn: (tx: db.DbClient) => Promise<unknown>) => target.begin((tx) => fn(new Proxy(tx, {
        apply(query, thisArg, args: unknown[]) {
          if (Array.from(args[0] as TemplateStringsArray).join(' ').includes("outcome = 'scoreable'")) throw new Error('synthetic input commit failure');
          return Reflect.apply(query, thisArg, args);
        },
      })));
      return Reflect.get(target, property);
    } });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(broken);
    try { expect((await postAsFleet('/api/workers/complete-agent-turn', body)).status).toBe(500); }
    finally { spy.mockRestore(); }
    expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['running', 'pending', 'pending']);
    expect(await sql`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${owner.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM runs WHERE queue_name = 'thread_response'`).toHaveLength(0);
    expect((await (await postAsFleet('/api/workers/complete-agent-turn', body)).json()).status).toBe('completed');
  });

  it.each(['completed', 'failed', 'cancelled', 'timeout', 'malformed'])(
    '%s releases only the next pending startup deadline', async (terminal) => {
      const { sql, owner, followers, body, first } = await inputScenario();
      await sql`UPDATE runs SET run_at = now() - interval '1 hour' WHERE id IN (${followers[0].id}, ${followers[1].id})`;
      expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 0, delivered: 0 });
      if (terminal === 'timeout') {
        await sql`UPDATE runs SET last_heartbeat_at = now() - interval '1 hour' WHERE id = ${owner.id}`;
        // A reaped turn is the conversation's answer, so its error is
        // delivered rather than merely recorded on the run row.
        expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 1, delivered: 1 });
      } else if (terminal === 'malformed') {
        await failClaimedWorkerRun({ runId: owner.id, workerId: body.worker_id, errorMessage: 'malformed envelope' });
      } else {
        if (terminal === 'cancelled') {
          await cancelAgentTurn(await admittedMessage({ ...first, messageId: 'cancel-head', messageText: '/cancel' }));
          expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 0, delivered: 0 });
        }
        await postAsFleet('/api/workers/complete-agent-turn', { ...body, status: terminal === 'failed' ? 'failed' : 'completed', consumed_inputs: [] });
      }
      const ready = await sql`SELECT id, run_at > now() - interval '10 seconds' AS fresh FROM runs
        WHERE id IN (${followers[0].id}, ${followers[1].id}) ORDER BY id`;
      expect(ready.map((row) => row.fresh)).toEqual([true, false]);
      expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 0, delivered: 0 });
      await sql`UPDATE runs SET run_at = now() - interval '1 hour' WHERE id = ${followers[0].id}`;
      expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 1, delivered: 1 });
      expect((await (await pollFleet('fleet-released', { agent_turn: true })).json()).run_id).toBe(followers[1].id);
    },
  );

  it('expires an unresponsive cancellation despite heartbeats and fences late reports', async () => {
    const { sql, owner, followers, body, first } = await inputScenario();
    await cancelAgentTurn(await admittedMessage({ ...first, messageId: 'cancel-head', messageText: '/cancel' }));
    await sql`UPDATE runs SET run_metadata = jsonb_set(run_metadata, '{cancel_requested_at}', to_jsonb(now() - interval '1 hour')) WHERE id = ${owner.id}`;
    const beat = await postAsFleet('/api/workers/heartbeat', { run_id: owner.id, worker_id: body.worker_id });
    expect(await beat.json()).toMatchObject({ continue: false, stop_reason: 'cancelled' });
    // The user asked to cancel, so they are told the turn ended that way.
    expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 1, delivered: 1 });
    expect((await (await pollFleet('fleet-successor', { agent_turn: true })).json()).run_id).toBe(followers[0].id);
    const late = await postAsFleet('/api/workers/complete-agent-turn', body);
    expect(await late.json()).toEqual({ ok: true, status: 'cancelled', idempotent: true });
    expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['cancelled', 'running', 'pending']);
  });

  it('delivers pending cancellation and malformed dispatch errors atomically', async () => {
    const { sql, owner, followers, body, first } = await inputScenario();
    await postAsFleet('/api/workers/complete-agent-turn', { ...body, consumed_inputs: [] });
    await cancelAgentTurn(await admittedMessage({ ...first, messageId: 'cancel-pending', messageText: '/cancel' }));
    expect((await runRow(followers[0].id)).status).toBe('cancelled');
    const next = await (await pollFleet('fleet-malformed-response', { agent_turn: true })).json();
    await failClaimedWorkerRun({ runId: next.run_id, workerId: 'fleet-malformed-response', errorMessage: 'incomplete envelope' });
    const replies = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' ORDER BY id`;
    expect(replies.map((row) => row.action_input.processedMessageIds)).toEqual([['msg-turn'], ['input-0'], ['input-1']]);
    expect(replies.slice(1).map((row) => row.action_input.error)).toEqual(['agent turn cancelled', 'incomplete envelope']);
    expect((await runRow(owner.id)).status).toBe('completed');
  });

  it('rechecks a refreshed startup deadline after the reaper candidate read', async () => {
    const { sql, body, followers } = await inputScenario();
    await postAsFleet('/api/workers/complete-agent-turn', { ...body, consumed_inputs: [] });
    await sql`UPDATE runs SET run_at = now() - interval '1 hour' WHERE id = ${followers[0].id}`;
    const realDb = db.getDb();
    let refreshed = false;
    const racingDb = new Proxy(realDb, { apply(query, thisArg, args: unknown[]) {
      const result = Reflect.apply(query, thisArg, args);
      if (!refreshed && Array.from(args[0] as TemplateStringsArray).join(' ').startsWith('SELECT r.id FROM runs r WHERE')) {
        return Promise.resolve(result).then(async (rows) => {
          refreshed = true;
          await sql`UPDATE runs SET run_at = now() WHERE id = ${followers[0].id}`;
          return rows;
        });
      }
      return result;
    } });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(racingDb);
    try { expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 0, delivered: 0 }); }
    finally { spy.mockRestore(); }
    expect(refreshed).toBe(true);
    expect((await runRow(followers[0].id)).status).toBe('pending');
  });

  it('serializes admission with an empty terminal handoff', async () => {
    const { sql, first, deps, body } = await inputScenario([]);
    await Promise.all([
      postAsFleet('/api/workers/complete-agent-turn', body),
      enqueueMessage({ ...first, messageId: 'concurrent-admission' }, deps),
    ]);
    const [pending] = await sql`SELECT run_at > now() - interval '10 seconds' AS fresh FROM runs WHERE run_type = 'agent_turn' AND status = 'pending'`;
    expect(pending.fresh).toBe(true);
    const next = await (await pollFleet('fleet-concurrent-input', { agent_turn: true })).json();
    expect(next.payload.turn.message_id).toBe('concurrent-admission');
  });

  it('upgrades an older base alone and offers followers on the next current-version turn', async () => {
    const { body, followers } = await inputScenario(['second', 'third'], nativeSession().replace('"version":3', '"version":2'));
    body.session_jsonl = body.session_jsonl.trim().split('\n').filter((line) => !JSON.parse(line).id?.startsWith('input-entry-')).join('\n') + '\n';
    const response = await postAsFleet('/api/workers/complete-agent-turn', { ...body, consumed_inputs: [] });
    expect((await response.json()).status).toBe('completed');
    const next = await (await pollFleet('fleet-current-base', { agent_turn: true })).json();
    expect(next.payload.turn.session_jsonl).toBe(body.session_jsonl);
    const beat = await postAsFleet('/api/workers/heartbeat', { run_id: next.run_id, worker_id: 'fleet-current-base' });
    expect((await beat.json()).steer).toEqual([{ run_id: followers[1].id, message_id: 'input-1', text: 'third' }]);
  });

  it.each(['count', 'bytes', 'single-large'])('keeps inputs beyond the %s offer bound intact', async (kind) => {
    const texts = kind === 'count' ? Array.from({ length: 34 }, (_, index) => `input ${index}`)
      : kind === 'bytes' ? ['🌍'.repeat(12000), '🌍'.repeat(12000), 'intact tail'] : ['界'.repeat(24000), 'intact tail'];
    const { body, followers, sql } = await inputScenario(texts);
    const response = await postAsFleet('/api/workers/heartbeat', { run_id: body.run_id, worker_id: body.worker_id });
    const offered = (await response.json()).steer ?? [];
    expect(offered.length).toBe(kind === 'count' ? 32 : kind === 'bytes' ? 1 : 0);
    expect(Buffer.byteLength(JSON.stringify(offered))).toBeLessThanOrEqual(65536);
    const rows = await sql`SELECT action_input->'turn'->>'message_text' AS text FROM runs WHERE id > ${body.run_id} AND run_type = 'agent_turn' ORDER BY id`;
    expect(rows.map((row) => row.text)).toEqual(texts);
    await postAsFleet('/api/workers/complete-agent-turn', { ...body, session_jsonl: nativeSession(), consumed_inputs: [] });
    expect((await (await pollFleet('fleet-bound-next', { agent_turn: true })).json()).run_id).toBe(followers[0].id);
  });

  it.each([
    ['organization', { organizationId: 'different-org' }],
    ['agent', { agentId: 'other-selected-agent' }],
    ['conversation', { conversationId: 'other-conversation' }],
    ['user', { userId: 'other-user' }],
    ['model', { agentOptions: { model: 'claude/different-model' } }],
    ['tools', { agentOptions: { model: 'claude/claude-opus-4-8', disallowedTools: ['write'] } }],
    ['routing', { channelId: 'different-channel' }],
    ['grants', { networkConfig: { allowedDomains: ['different.example'] } }],
    ['packages', { nixConfig: { packages: ['git'] } }],
    ['platform metadata', { platformMetadata: { opaqueRouting: 'different' } }],
    ['attachment', { platformMetadata: { files: [{ name: 'notes.txt', mimetype: 'text/plain' }] } }],
    ['reset', { platformMetadata: { sessionReset: true } }],
    ['automation', { platformMetadata: { source: 'automation-run' } }],
  ])('keeps incompatible %s input separate and preserves FIFO barriers', async (kind, changes) => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    if (kind === 'organization') changes = { organizationId: (await createTestOrganization()).id };
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id } = await (await pollFleet('fleet-barrier', { agent_turn: true })).json();
    await enqueueMessage({ ...first, ...changes, messageId: 'barrier' } as MessagePayload, deps);
    await enqueueMessage({ ...first, messageId: 'after-barrier' }, deps);
    const response = await postAsFleet('/api/workers/heartbeat', { run_id, worker_id: 'fleet-barrier' });
    const offered = (await response.json()).steer ?? [];
    if (['organization', 'agent', 'conversation'].includes(kind)) {
      expect(offered.map((input: { message_id: string }) => input.message_id)).toEqual(['after-barrier']);
    } else expect(offered).toEqual([]);
    expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['running', 'pending', 'pending']);
  });

  it('cancels a native turn on explicit cancel admission instead of steering', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    await enqueueMessage(first, {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    const { run_id: runId } = await (await pollFleet('fleet-explicit-cancel', { agent_turn: true })).json();
    const cancel = await admittedMessage({ ...first, messageId: 'cancel-message', messageText: ' /CANCEL ' });
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect((await runRow(runId)).status).toBe('running');
    const response = await postAsFleet('/api/workers/heartbeat', { worker_id: 'fleet-explicit-cancel', run_id: runId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ continue: false, stop_reason: 'cancelled' });
  });

  it.each([
    { name: 'text', messageText: '/cancel', platformMetadata: {} },
    { name: 'control metadata without text', messageText: '', platformMetadata: { control: 'cancel' } },
    { name: 'intent metadata without text', messageText: '', platformMetadata: { intent: { kind: 'cancel' } } },
  ])('honors $name cancellation in every nonterminal native state', async (command) => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    for (const status of ['pending', 'claimed', 'running']) {
      const first = { ...messageFor(org.id), messageId: `original-${status}`, conversationId: `cancel-${status}` };
      await enqueueMessage(first, {
        agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
      });
      const run = (await agentTurnRuns()).at(-1)!;
      await sql`UPDATE runs SET status = ${status}, claimed_by = 'fleet-cancel-state' WHERE id = ${run.id}`;
      const cancel = await admittedMessage({ ...first, ...command, messageId: `cancel-${status}` });
      expect(await cancelAgentTurn(cancel)).toBe(true);
      const [row] = await sql`SELECT status, completed_at, exit_reason, run_metadata FROM runs WHERE id = ${run.id}`;
      if (status === 'pending') {
        expect(row).toMatchObject({ status: 'cancelled', exit_reason: 'cancelled' });
        expect(row.completed_at).not.toBeNull();
      } else {
        expect(row.status).toBe(status);
        expect(row.completed_at).toBeNull();
        expect(row.run_metadata.cancel_requested_at).toBeTruthy();
        const report = await postAsFleet('/api/workers/complete-agent-turn', {
          run_id: run.id, worker_id: 'fleet-cancel-state', status: 'failed', error: 'stopped',
        });
        expect(await report.json()).toMatchObject({ status: 'cancelled' });
      }
    }
  });

  it('answers a cancellation without producing a turn to be blamed for', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const first = messageFor(org.id);
    await enqueueMessage(first, {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    const before = (await agentTurnRuns()).length;

    // A cancel is the one admitted message that becomes NO turn: it reports
    // handled, and `enqueueAgentTurn` is never reached for it. That is what
    // makes the consumer's ordering load-bearing — a liveness marker armed
    // before this point would be a standing promise of a terminal event that
    // nothing can ever discharge, and the deadline sweep would blame an
    // unresponsive worker for a cancellation that worked. The consumer
    // therefore answers the cancel first and returns; these two facts are what
    // let it do that safely.
    const cancel = await admittedMessage({ ...first, messageId: 'cancel-no-turn', messageText: '/cancel' });
    expect(await cancelAgentTurn(cancel)).toBe(true);

    // No new turn was admitted for the control message, so there is nothing a
    // marker could be waiting on.
    expect(await agentTurnRuns()).toHaveLength(before);
    const [own] = (await sql`
      SELECT count(*)::int AS n FROM runs
      WHERE run_type = 'agent_turn' AND action_input->'reply'->>'message_id' = ${cancel.messageId}
    `) as unknown as Array<{ n: number }>;
    expect(own!.n).toBe(0);
  });

  it('keeps cancellation within its organization, agent, conversation and posting user', async () => {
    const org = await createTestOrganization();
    const otherOrg = await createTestOrganization();
    const first = messageFor(org.id);
    const variants = [first, { ...first, organizationId: otherOrg.id }, { ...first, agentId: 'other-selected-agent' },
      { ...first, conversationId: 'other-conversation' }, { ...first, userId: 'other-user' }];
    for (const [i, message] of variants.entries()) {
      await enqueueMessage({ ...message, messageId: `scope-${i}` }, {
        agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const cancel = await admittedMessage({ ...first, messageId: 'scoped-cancel', messageText: '/cancel' });
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect((await agentTurnRuns()).map((run) => run.status)).toEqual(['cancelled', 'pending', 'pending', 'pending', 'pending']);
  });

  it('controls the active turn before queued work and consumes duplicate cancellation across workers', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id: activeId } = await (await pollFleet('fleet-control-active', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'queued-after-active' }, deps);
    const queued = (await agentTurnRuns())[1];
    const cancel = await admittedMessage({ ...first, messageId: 'replayed-cancel', messageText: '/cancel' });
    expect(await Promise.all([cancelAgentTurn(cancel), cancelAgentTurn(cancel)])).toEqual([true, true]);
    expect((await runRow(activeId)).status).toBe('running');
    expect((await runRow(queued.id)).status).toBe('pending');
    expect((await (await pollFleet('fleet-control-next', { agent_turn: true })).json()).run_id).toBeUndefined();
    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: activeId, worker_id: 'fleet-control-active', status: 'failed', error: 'cancelled',
    });
    expect((await (await pollFleet('fleet-control-next', { agent_turn: true })).json()).run_id).toBe(queued.id);
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect((await runRow(queued.id)).status).toBe('running');
  });

  it('consumes a no-active cancellation without cancelling a future turn on replay', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const cancel = await admittedMessage({ ...first, messageId: 'early-cancel', messageText: '/cancel' });
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect(await agentTurnRuns()).toHaveLength(0);
    await enqueueMessage(first, {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect((await agentTurnRuns())[0].status).toBe('pending');
  });

  it('does not let a delayed cancellation stop a turn admitted after it', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    const cancel = await admittedMessage({ ...first, messageId: 'delayed-cancel', messageText: '/cancel' });
    await enqueueMessage(first, {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    const [later] = await agentTurnRuns();
    expect((await (await pollFleet('fleet-after-delayed-cancel', { agent_turn: true })).json()).run_id).toBe(later.id);
    expect(await cancelAgentTurn(cancel)).toBe(true);
    const heartbeat = await postAsFleet('/api/workers/heartbeat', {
      run_id: later.id, worker_id: 'fleet-after-delayed-cancel',
    });
    expect(await heartbeat.json()).toEqual({ continue: true });
  });

  it('propagates database failures and refuses an unbound cancellation receipt', async () => {
    const org = await createTestOrganization();
    const first = messageFor(org.id);
    await enqueueMessage(first, {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    const cancel = await admittedMessage({ ...first, messageId: 'retryable-cancel', messageText: '/cancel' });
    const spy = vi.spyOn(db, 'getDb').mockImplementationOnce(() => { throw new Error('synthetic database failure'); });
    try { await expect(cancelAgentTurn(cancel)).rejects.toThrow('synthetic database failure'); }
    finally { spy.mockRestore(); }
    await expect(cancelAgentTurn({ ...cancel, runId: 0 })).rejects.toThrow('admitted message run ID');
    await expect(cancelAgentTurn({ ...cancel, messageId: 'wrong-message' })).rejects.toThrow('no matching admitted message');
    expect((await agentTurnRuns())[0].status).toBe('pending');
    expect(await cancelAgentTurn(cancel)).toBe(true);
    expect((await agentTurnRuns())[0].status).toBe('cancelled');
  });

  it('preserves a completion committed while cancellation waits for the active row', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const first = messageFor(org.id);
    const deps = { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL };
    await enqueueMessage(first, deps);
    const { run_id: activeId } = await (await pollFleet('fleet-completing-control', { agent_turn: true })).json();
    await enqueueMessage({ ...first, messageId: 'queued-after-completion' }, deps);
    const queued = (await agentTurnRuns())[1];
    const cancel = await admittedMessage({ ...first, messageId: 'completion-race-cancel', messageText: '/cancel' });
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const completion = sql.begin(async (tx) => {
      await tx`UPDATE runs SET status = 'completed', completed_at = now(), exit_reason = 'ok' WHERE id = ${activeId}`;
      locked();
      await gate;
    });
    await lockReady;
    const control = cancelAgentTurn(cancel);
    try {
      await vi.waitFor(async () => {
        const waiting = await sql`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%ORDER BY id FOR UPDATE%'
        `;
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
    } finally {
      release();
      await completion;
      await control;
    }
    expect((await runRow(activeId))).toMatchObject({ status: 'completed', exit_reason: 'ok' });
    expect((await runRow(queued.id)).status).toBe('pending');
  });

  it('carries a pinned sandbox as signed token claims and a remote-bash marker', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(
      { ...messageFor(org.id), networkConfig: { allowedDomains: ['example.com'] }, nixConfig: { packages: ['ripgrep'] } } as MessagePayload,
      {
        agentSettings: settingsStore,
        catalog: catalogFor(tokenEchoingModule()),
        mcp: mcpFixture().mcp,
        gatewayUrl: GATEWAY_URL,
        runtime: { runtimeProviderId: 'vercel', sandboxId: 'sandbox-1' },
      }
    );
    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as { system_prompt: string; tools?: { remote_runtime?: unknown } };
    expect(turn.tools?.remote_runtime).toEqual({ provider_id: 'vercel' });
    expect(turn.system_prompt).toContain(
      "Your bash tool runs in the conversation's pinned remote sandbox and does not share the in-memory file workspace."
    );
    expect(turn.system_prompt).toContain(
      'Network access and installed tools in that sandbox follow its runtime configuration; direct package installation is blocked.'
    );
    expect(turn.system_prompt).not.toContain('The in-memory environment has no network access');
    // The exec route trusts only the signed token for these — never a body.
    const claims = verifyWorkerToken((run.action_input as { credential: string }).credential) as Record<string, unknown>;
    expect(claims).toMatchObject({
      runtimeProviderId: 'vercel',
      sandboxId: 'sandbox-1',
      allowedDomains: ['example.com'],
      nixPackages: ['ripgrep'],
    });
  });

  it('marks no remote bash for an unpinned conversation', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    expect((run.action_input.turn as { tools?: { remote_runtime?: unknown } }).tools?.remote_runtime).toBeUndefined();
  });

  it('arms no turn marker and journals no run input', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const sql = getTestDb();
    // The PRODUCER writes neither. Both are keyed (deploymentName, messageId)
    // and first-writer-wins, and `handleMessage` already armed the marker and
    // journaled the input before calling the producer — a second write here
    // would let one turn terminate or replay another.
    const [markers] = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE queue_name = 'internal:turn_timeout'
    `) as unknown as Array<{ n: number }>;
    expect(markers.n).toBe(0);
    const [journal] = (await sql`
      SELECT count(*)::int AS n FROM agent_run_input WHERE message_id = 'msg-turn'
    `) as unknown as Array<{ n: number }>;
    expect(journal.n).toBe(0);
  });

  it('serializes concurrent fleet claims for one conversation until completion', async () => {
    const org = await createTestOrganization();
    for (const messageId of ['claim-first', 'claim-second']) {
      await enqueueMessage({ ...messageFor(org.id), messageId }, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const [first, second] = await agentTurnRuns();
    const workers = ['fleet-claim-a', 'fleet-claim-b', 'fleet-claim-c'];
    const responses = await Promise.all(workers.map((worker) => pollFleet(worker, { agent_turn: true })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const claims = await Promise.all(responses.map((response) => response.json()));
    expect(claims.filter((claim) => claim.run_id).map((claim) => claim.run_id)).toEqual([first.id]);
    expect((await runRow(second.id)).status).toBe('pending');

    const owner = workers[claims.findIndex((claim) => claim.run_id === first.id)];
    const complete = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: first.id, worker_id: owner, status: 'completed', session_jsonl: nativeSession(), text: 'first finished',
    });
    expect(complete.status).toBe(200);
    expect((await (await pollFleet('fleet-claim-next', { agent_turn: true })).json()).run_id).toBe(second.id);
  });

  it('does not skip a locked earlier turn to claim its later sibling', async () => {
    const org = await createTestOrganization();
    for (const messageId of ['locked-first', 'locked-second']) {
      await enqueueMessage({ ...messageFor(org.id), messageId }, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const [first, second] = await agentTurnRuns();
    const sql = getTestDb();
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM runs WHERE id = ${first.id} FOR UPDATE`;
      const response = await pollFleet('fleet-locked-claim', { agent_turn: true });
      expect(response.status).toBe(200);
      expect((await response.json()).run_id).toBeUndefined();
      expect((await runRow(second.id)).status).toBe('pending');
    });
    expect((await (await pollFleet('fleet-after-unlock', { agent_turn: true })).json()).run_id).toBe(first.id);
  });

  it.each(['before', 'after'])('serializes an earlier insert committed %s the locked recheck', async (position) => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const [template] = await agentTurnRuns();
    const sql = getTestDb();
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${template.id}`;
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let inserted!: (id: number) => void;
    const earlierId = new Promise<number>((resolve) => { inserted = resolve; });
    const earlierCommit = sql.begin(async (tx) => {
      const [run] = await tx`
        INSERT INTO runs (organization_id, run_type, status, approval_status, action_input, parent_run_id)
        SELECT organization_id, run_type, 'pending', 'auto', action_input, parent_run_id FROM runs WHERE id = ${template.id}
        RETURNING id
      `;
      inserted(run.id);
      await insertGate;
    });
    const firstId = await earlierId;
    const realDb = db.getDb();
    let interleaved = false;
    let competingClaim: Record<string, unknown> | undefined;
    const barrierQuery = position === 'before'
      ? "SELECT pg_try_advisory_xact_lock"
      : 'SELECT r.id FROM runs r';
    const gatedDb = new Proxy(realDb, {
      get(target, property) {
        if (property === 'begin') return (fn: (tx: db.DbClient) => Promise<unknown>) =>
          target.begin((tx) => fn(new Proxy(tx, {
            apply(query, thisArg, args: unknown[]) {
              const result = Reflect.apply(query, thisArg, args);
              if (!interleaved && Array.from(args[0] as TemplateStringsArray).join(' ').includes(barrierQuery)) {
                return Promise.resolve(result).then(async (rows) => {
                  interleaved = true;
                  releaseInsert();
                  await earlierCommit;
                  if (position === 'after') {
                    // The later candidate is still pending in other snapshots.
                    // A row lock cannot stop a claimant of this earlier row.
                    const response = await pollFleet('fleet-during-recheck', { agent_turn: true });
                    expect(response.status).toBe(200);
                    competingClaim = await response.json();
                  }
                  return rows;
                });
              }
              return result;
            },
          })));
        return Reflect.get(target, property);
      },
    });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(gatedDb);
    try {
      const [later] = await sql`
        INSERT INTO runs (organization_id, run_type, status, approval_status, action_input, parent_run_id)
        SELECT organization_id, run_type, 'pending', 'auto', action_input, parent_run_id FROM runs WHERE id = ${template.id}
        RETURNING id
      `;
      const response = await pollFleet('fleet-insert-race', { agent_turn: true });
      expect(response.status).toBe(200);
      expect(interleaved).toBe(true);
      // Before recheck, the poll's second attempt picks the earlier row.
      // After recheck, the lock prevents overlapping claims of different rows.
      const claimedId = (await response.json()).run_id;
      expect(claimedId).toBe(position === 'before' ? firstId : later.id);
      if (position === 'after') {
        expect(competingClaim).toBeDefined();
        expect(competingClaim!.run_id).toBeUndefined();
      }
      expect((await agentTurnRuns()).filter((run) => run.status === 'pending')).toHaveLength(1);
      const complete = await postAsFleet('/api/workers/complete-agent-turn', {
        run_id: claimedId, worker_id: 'fleet-insert-race', status: 'completed', session_jsonl: nativeSession(), text: 'finished',
      });
      expect(complete.status).toBe(200);
      expect((await (await pollFleet('fleet-after-insert', { agent_turn: true })).json()).run_id)
        .toBe(position === 'before' ? later.id : firstId);
    } finally {
      spy.mockRestore();
      releaseInsert();
      await earlierCommit;
    }
  });

  it.each(['claimed', 'running'])(
    'keeps a crashed %s owner fenced until the reaper makes it terminal', async (status) => {
      const org = await createTestOrganization();
      for (const messageId of ['crashed-first', 'crashed-second']) {
        await enqueueMessage({ ...messageFor(org.id), messageId }, {
          agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
        });
      }
      const [first, second] = await agentTurnRuns();
      const sql = getTestDb();
      await sql`
        UPDATE runs SET status = ${status}, claimed_by = 'fleet-crashed',
          claimed_at = now() - interval '1 hour', last_heartbeat_at = now() - interval '1 hour'
        WHERE id = ${first.id}
      `;
      expect((await (await pollFleet('fleet-before-reap', { agent_turn: true })).json()).run_id).toBeUndefined();
      expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 1, delivered: 1 });
      expect((await runRow(first.id)).status).toBe('timeout');
      expect((await (await pollFleet('fleet-after-reap', { agent_turn: true })).json()).run_id).toBe(second.id);
    }
  );

  it.each(['agent_id', 'conversation_id'])(
    'fails a turn with missing %s instead of executing without its conversation fence', async (field) => {
      const org = await createTestOrganization();
      await enqueueMessage(messageFor(org.id), {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
      const [run] = await agentTurnRuns();
      const sql = getTestDb();
      await sql`
        UPDATE runs SET action_input = jsonb_set(action_input, '{turn}', (action_input->'turn') - ${field})
        WHERE id = ${run.id}
      `;
      const response = await pollFleet('fleet-invalid-scope', { agent_turn: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ skipped_run_id: run.id, error: 'agent turn run has an incomplete execution envelope' });
      expect((await runRow(run.id)).status).toBe('failed');
    }
  );

  it.each(['completed', 'failed', 'cancelled', 'timeout'])(
    'waits for an already-running later turn to become %s', async (terminalStatus) => {
      const org = await createTestOrganization();
      for (const messageId of ['waiting-first', 'running-second']) {
        await enqueueMessage({ ...messageFor(org.id), messageId }, {
          agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
        });
      }
      const [first, second] = await agentTurnRuns();
      const sql = getTestDb();
      // Existing/out-of-order work must also fence the older pending row.
      await sql`UPDATE runs SET status = 'running', claimed_by = 'fleet-existing-owner' WHERE id = ${second.id}`;
      expect((await (await pollFleet('fleet-waiting', { agent_turn: true })).json()).run_id).toBeUndefined();
      await sql`UPDATE runs SET status = ${terminalStatus}, completed_at = now() WHERE id = ${second.id}`;
      expect((await (await pollFleet('fleet-released', { agent_turn: true })).json()).run_id).toBe(first.id);
    }
  );

  it('claims distinct organization, agent and conversation scopes independently', async () => {
    const org = await createTestOrganization();
    const otherOrg = await createTestOrganization();
    const base = messageFor(org.id);
    for (const message of [
      { ...base, messageId: 'scope-base' },
      { ...base, messageId: 'scope-org', organizationId: otherOrg.id },
      { ...base, messageId: 'scope-agent', agentId: 'other-agent' },
      { ...base, messageId: 'scope-conversation', conversationId: 'other-conversation' },
    ]) {
      await enqueueMessage(message, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const runs = await agentTurnRuns();
    expect(runs).toHaveLength(4);
    const claims = await Promise.all(runs.map(async (_, index) =>
      (await pollFleet(`fleet-scope-${index}`, { agent_turn: true })).json()
    ));
    expect(claims.map((claim) => claim.run_id).sort()).toEqual(runs.map((run) => run.id).sort());
  });

  it('a fleet worker that advertises the lane claims it and receives the turn plus the credential', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();

    const response = await pollFleet('fleet-agent-turn', { agent_turn: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Value.Check(PollResponseSchema, body)).toBe(true);
    expect(body.run_id).toBe(run.id);
    expect(body.run_type).toBe('agent_turn');
    expect(body.organization_id).toBe(org.id);
    expect(body.payload.turn.provider.model_id).toBe('claude-opus-4-8');
    // T2: `expect.any(String)` accepted ANY token here, so this would have
    // passed on a credential minted for another run or another org. The polled
    // token must be the one persisted on this run's envelope, and its claims
    // must scope it to this run and org — that scoping is what the secret
    // proxy and the MCP route authorize against.
    expect(body.credentials.provider).toBe('anthropic');
    expect(body.credentials.accessToken).toBe(run.action_input.credential);
    expect(verifyWorkerToken(body.credentials.accessToken)).toMatchObject({
      runId: run.id,
      organizationId: org.id,
      conversationId: 'conv-turn',
    });
    // A token from a DIFFERENT run must not verify as this one: proves the
    // assertion above is discriminating and not just re-reading one value.
    await enqueueMessage({ ...messageFor(org.id), messageId: 'msg-other' }, {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const other = (await agentTurnRuns()).find((candidate) => candidate.id !== run.id);
    expect(other).toBeDefined();
    expect(verifyWorkerToken(other?.action_input.credential as string)?.runId).not.toBe(run.id);

    const sql = getTestDb();
    const [claimed] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string; claimed_by: string }>;
    expect(claimed).toEqual({ status: 'running', claimed_by: 'fleet-agent-turn' });
  });

  it('a fleet worker without the capability leaves the run pending', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();

    // An older daemon advertises no `agent_turn`. If it could claim the row it
    // would fall through `executeRun`'s default arm into `executeSyncRun`.
    const response = await pollFleet('fleet-old-daemon', { db_egress_hardening: true });
    const body = await response.json();
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [still] = (await sql`
      SELECT status FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string }>;
    expect(still.status).toBe('pending');
  });

  it('a user-scoped device worker cannot claim an agent turn', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();

    const sql = getTestDb();
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${user.id}, 'device-agent-turn', 'macos', ${sql.json([])}, ${org.id})
    `;
    const pat = await createTestPAT(user.id, org.id, { scope: 'device_worker:run' });
    const response = await post('/api/workers/poll', {
      token: pat.token,
      body: {
        worker_id: 'device-agent-turn',
        platform: 'macos',
        capabilities: { agent_turn: true },
      },
    });
    const body = await response.json();
    expect(body.run_id).toBeUndefined();

    const [still] = (await sql`
      SELECT status FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string }>;
    expect(still.status).toBe('pending');
  });

  it('enqueues an AUTHORITATIVE turn: no selection gate, and the reply is delivered', async () => {
    const org = await createTestOrganization();
    const deps = {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    };
    // No env var is set at all. Every agent runs natively now, so the turn is
    // produced anyway, and it owns the conversation's reply.
    await enqueueMessage(messageFor(org.id), deps);

    const [run] = await agentTurnRuns();
    expect(run).toBeDefined();
    // The completion route 409s a turn with no reply envelope, so the
    // producer must always stamp one.
    expect(run.action_input.reply).toMatchObject({
      message_id: expect.any(String),
      channel_id: expect.any(String),
      user_id: expect.any(String),
      platform: expect.any(String),
    });
  });

  it('THROWS when the enqueue fails unexpectedly, rather than swallowing it', async () => {
    const org = await createTestOrganization();
    // Two different failure shapes, two different contracts:
    //  - A misconfiguration the producer can NAME is returned as a code, so
    //    the caller discharges the armed marker with the real reason (see the
    //    misconfiguration tests below).
    //  - An UNEXPECTED failure has no user-facing explanation, so it must
    //    propagate into the queue's retry/fail handling instead of vanishing.
    // Here the settings store itself blows up, which is neither anticipated
    // nor explainable to the user.
    await expect(
      enqueueMessage(messageFor(org.id), {
        agentSettings: {
          getSettings: () => {
            throw new Error('settings store unreachable');
          },
        } as unknown as AgentSettingsStore,
        catalog: catalogFor(claudeModule()),
        gatewayUrl: GATEWAY_URL,
      })
    ).rejects.toThrow('settings store unreachable');
  });

  it('names the misconfiguration when the agent cannot run, instead of dropping the message', async () => {
    const org = await createTestOrganization();
    const deps = {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    };

    // Each of these used to be a silent `return`. That was right while a
    // managed subprocess still answered the user. This lane is now the ONLY
    // execution path AND `handleMessage` arms the turn-liveness marker before
    // enqueueing, so a silent skip spends the whole deadline and then blames
    // an unresponsive worker for what is really a misconfiguration. The
    // producer must name the cause so the marker can carry its remediation.

    const noModel = messageFor(org.id);
    noModel.agentOptions = {};
    expect(await enqueueMessage(noModel, deps)).toBe(AgentErrorCode.NO_MODEL_CONFIGURED);
    expect(await agentTurnRuns()).toHaveLength(0);

    // Google speaks a protocol whose pi-ai adapter is not fetch-native, so it
    // cannot be bundled for the isolate. The user's fix is the model choice.
    expect(
      await enqueueMessage(messageFor(org.id), {
        ...deps,
        catalog: catalogFor(claudeModule({ sdkCompat: 'google' })),
      })
    ).toBe(AgentErrorCode.NO_MODEL_CONFIGURED);
    expect(await agentTurnRuns()).toHaveLength(0);

    // No public gateway URL means no URL a fleet worker could reach the proxy on.
    expect(await enqueueMessage(messageFor(org.id), { ...deps, gatewayUrl: undefined })).toBe(
      AgentErrorCode.NO_MODEL_CONFIGURED
    );
    expect(await agentTurnRuns()).toHaveLength(0);

    // Whatever code the producer reports MUST carry its own prose. The four
    // `PROVIDER_*` codes deliberately do not — they exist to relay the
    // provider's error text — so reporting one of those from here would render
    // an empty message with a lone CTA button. Assert the text, not just the
    // code, because the code alone looks right while showing the user nothing.
    expect(AGENT_ERRORS[AgentErrorCode.NO_MODEL_CONFIGURED].message).toBeTruthy();
  });

  it.each([
    ['https://generativelanguage.googleapis.com/v1beta/openai', false],
    ['https://compatible.example.test/v1', false],
    ['https://api.openai.com.evil.example/v1', false],
    ['http://api.openai.com/v1', false],
    ['https://api.openai.com/v1', true],
  ])('carries storage capability from upstream %s through the proxy', async (upstreamBaseUrl, supportsStore) => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule({
        sdkCompat: 'openai',
        getUpstreamConfig: () => ({ slug: 'compatible', upstreamBaseUrl }),
      })),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    expect(run.action_input.turn.provider).toMatchObject({
      api: 'openai-completions', compat: { supportsStore },
    });
    expect(run.action_input.turn.provider.base_url).toContain('gateway.test.invalid');
  });

  it('routes every fetch-native protocol, including OpenAI Responses', async () => {
    // `provider-catalog` promotes the OFFICIAL OpenAI provider from the
    // generic `openai` (Chat Completions) to `openai-responses`, so current
    // reasoning models can use tools. `openai-responses` was missing from
    // LANE_APIS, so that promotion made every official-OpenAI agent
    // unroutable — the producer returned NO_MODEL_CONFIGURED and the agent
    // could not run at all. pi-ai implements Responses on the same `openai`
    // package as completions, so it is isolate-compatible for the same
    // reason; the omission was the bug, not the promotion.
    const org = await createTestOrganization();
    for (const sdkCompat of ['anthropic', 'openai', 'openai-responses'] as const) {
      expect(
        await enqueueMessage(messageFor(org.id), {
          agentSettings: settingsStore,
          catalog: catalogFor(claudeModule({ sdkCompat })),
          gatewayUrl: GATEWAY_URL,
        })
      ).toBeUndefined();
    }
    // One admitted run per protocol — none silently dropped.
    expect(await agentTurnRuns()).toHaveLength(3);
  });

  it("delivers the named misconfiguration to the client, not a deadline timeout", async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const message = messageFor(org.id);
    message.agentOptions = {};
    const deploymentName = 'agent-turn-unrunnable-fixture';

    // Exactly the sequence `handleMessage` runs: arm the liveness marker, then
    // produce the turn. Arming FIRST is what makes a silent skip dangerous —
    // the marker is a standing promise of a terminal event, and after the
    // managed lane's deletion nothing else can discharge it.
    const queue = {
      createQueue: async () => {},
      send: async (_q: string, body: unknown, opts?: { singletonKey?: string }) => {
        await sql`
          INSERT INTO runs (organization_id, run_type, queue_name, status, action_input, idempotency_key)
          VALUES (${org.id}, 'chat_message', 'internal:turn_timeout', 'pending',
                  ${sql.json(body as Record<string, unknown>)}, ${opts?.singletonKey ?? null})
        `;
      },
    };
    await armTurnTimeout(queue as never, {
      messageId: message.messageId,
      channelId: message.channelId,
      conversationId: message.channelId,
      userId: message.userId,
      platform: message.platform,
      platformMetadata: message.platformMetadata,
      deploymentName,
      organizationId: org.id,
    });

    const unrunnable = await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    expect(unrunnable).toBe(AgentErrorCode.NO_MODEL_CONFIGURED);
    expect(await agentTurnRuns()).toHaveLength(0);

    // The consumer discharges the marker it armed, with the producer's reason.
    expect(await failTurnIfPending(deploymentName, message.messageId, unrunnable!)).toBe(true);

    // The marker is gone, so the deadline sweep can never fire a second,
    // wrong-cause error for this turn.
    const [marker] = (await sql`
      SELECT count(*)::int AS n FROM runs
      WHERE queue_name = 'internal:turn_timeout' AND status = 'pending'
    `) as unknown as Array<{ n: number }>;
    expect(marker!.n).toBe(0);

    // What the user actually receives: the real cause, with prose and a CTA —
    // not WORKER_UNRESPONSIVE after 60s of silence.
    const delivered = await threadResponsesGlobal();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      messageId: message.messageId,
      errorCode: AgentErrorCode.NO_MODEL_CONFIGURED,
    });
    expect(delivered[0]!.errorCode).not.toBe(AgentErrorCode.WORKER_UNRESPONSIVE);
    expect(String(delivered[0]!.error)).toContain('model');
  });

  it('stays silent when no turn is owed a reply at all', async () => {
    const org = await createTestOrganization();
    const deps = {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    };

    // A message with neither text nor a resolvable attachment: both providers
    // reject an empty user turn, so enqueueing one could only ever produce a
    // failed run. Nothing is owed a reply, so this reports NO error code —
    // a terminal error here would invent a failure the user did not cause.
    const noText = messageFor(org.id);
    noText.messageText = '   ';
    expect(await enqueueMessage(noText, deps)).toBeUndefined();
    expect(await agentTurnRuns()).toHaveLength(0);
  });

  it('produces the turn for every agent, with no selection gate', async () => {
    const org = await createTestOrganization();
    // There is no env var and no allow-list any more: every agent runs
    // natively. The turn is produced and owns the conversation's reply.
    expect(
      await enqueueMessage(messageFor(org.id), {
        agentSettings: settingsStore,
        catalog: catalogFor(claudeModule()),
        gatewayUrl: GATEWAY_URL,
      })
    ).toBeUndefined();
    const runs = await agentTurnRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.action_input.reply).toBeDefined();
  });

  it("carries the message's image and non-image attachments as bytes", async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.platformMetadata = {
      files: [
        {
          id: 'art-image',
          name: 'shot.png',
          mimetype: 'image/png',
          size: 4,
          // Inert: the producer resolves by artifact id, never by URL.
          downloadUrl: 'https://attacker.invalid/pwn.png',
        },
        { id: 'art-doc', name: 'report.pdf', mimetype: 'application/pdf', size: 2048 },
      ],
    };

    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });

    const [run] = await agentTurnRuns();
    const turn = (run?.action_input as { turn: Record<string, unknown> }).turn;
    expect(turn.message_images).toEqual([
      { mime_type: 'image/png', data: Buffer.from('PNG!').toString('base64') },
    ]);
    // The non-image attachment now carries its BYTES too: the guest seeds them
    // into the turn's `input/` directory, which is what the subprocess lane's
    // mimetype-blind download gave the model on disk.
    expect(turn.message_files).toEqual([
      {
        name: 'report.pdf',
        mime_type: 'application/pdf',
        size: 2048,
        data: Buffer.from('%PDF').toString('base64'),
      },
    ]);
    // No attachment URL is anywhere in the envelope the guest will be handed.
    expect(JSON.stringify(turn)).not.toContain('attacker.invalid');
  });

  it.each(['application/pdf', 'image/png'])('claims an envelope with bounded %s attachment metadata', async (mimetype) => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.platformMetadata = {
      files: [
        { name: 'n'.repeat(513), mimetype: 't'.repeat(129), size: -1 },
        { name: 'fractional', mimetype, size: 1.5 },
        ...Array.from({ length: 31 }, (_, i) => ({ name: `file-${i}`, mimetype, size: 0 })),
        { id: 'art-image', name: 'valid.png', mimetype: 'image/png' },
      ],
    };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });
    const [run] = await agentTurnRuns();
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn: run.action_input.turn })).toBe(true);
    const response = await pollFleet('fleet-attachment-boundary', { agent_turn: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.run_id).toBe(run.id);
    expect(Value.Check(AgentTurnPollPayloadSchema, body.payload)).toBe(true);
    expect(body.payload.turn.message_files).toHaveLength(32);
    expect(body.payload.turn.message_files.slice(0, 2)).toEqual([
      { name: 'n'.repeat(512), mime_type: 't'.repeat(128) },
      { name: 'fractional', mime_type: mimetype },
    ]);
    expect(body.payload.turn.message_images).toEqual([{ mime_type: 'image/png', data: Buffer.from('PNG!').toString('base64') }]);
    const [claimed] = await getTestDb()`SELECT status, claimed_by FROM runs WHERE id = ${run.id}`;
    expect(claimed).toMatchObject({ status: 'running', claimed_by: 'fleet-attachment-boundary' });
  });

  it('enqueues an attachment-only message once its image resolves, and refuses one whose image does not', async () => {
    const org = await createTestOrganization();
    const withImage = messageFor(org.id);
    withImage.messageText = '';
    withImage.platformMetadata = {
      files: [{ id: 'art-image', name: 'shot.png', mimetype: 'image/png', size: 4 }],
    };

    await enqueueMessage(withImage, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });

    const [run] = await agentTurnRuns();
    const turn = (run?.action_input as { turn: Record<string, unknown> }).turn;
    expect(turn.message_text).toBe('');
    expect(turn.message_images).toHaveLength(1);

    // The same message against a store that holds nothing: no image resolves,
    // no name survives either, so there is no turn to send.
    const unresolvable = messageFor(org.id);
    unresolvable.messageText = '';
    unresolvable.platformMetadata = {
      files: [{ name: 'shot.png', mimetype: 'image/png' }],
    };
    await enqueueMessage(unresolvable, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });
    // Still just the first run: the unresolvable one names the file, so it DOES
    // enqueue — what must never enqueue is a message with nothing at all.
    expect(await agentTurnRuns()).toHaveLength(2);
    const second = (await agentTurnRuns())[1];
    const secondTurn = (second?.action_input as { turn: Record<string, unknown> }).turn;
    expect(secondTurn.message_images).toBeUndefined();
    expect(secondTurn.message_files).toEqual([{ name: 'shot.png', mime_type: 'image/png' }]);
  });

  it("puts the model's own modalities on the envelope, from pi-ai's registry", async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = (run?.action_input as { turn: { provider: { input?: string[] } } }).turn;
    // Whatever pi-ai says this model accepts — asserted as a non-empty list
    // that always contains text, because the registry's per-model answer is
    // pi-ai's to change, not this test's to pin.
    expect(turn.provider.input).toContain('text');
  });

  // R7: the guest builds its `Model` from this envelope and has no registry to
  // ask, so a field the producer omits becomes a hardcoded default there. The
  // lane ran every agent with `reasoning:false` and an 8192-token ceiling
  // while the registry said otherwise for the same model.
  it("carries the registry's reasoning support and output ceiling for a known model", async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    // A model pi-ai's registry actually carries, unlike the suite's default.
    message.agentOptions = { ...message.agentOptions, model: 'claude/claude-sonnet-4-5-20250929' };
    await enqueueMessage(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = (run?.action_input as {
      turn: { provider: { model_id: string; reasoning?: boolean; max_tokens?: number } };
    }).turn;
    expect(turn.provider.model_id).toBe('claude-sonnet-4-5-20250929');
    // Asserted against the registry rather than a literal: pinning 64000 here
    // would keep passing after pi-ai revised the model.
    const registryModel = getModel('anthropic' as never, 'claude-sonnet-4-5-20250929' as never) as
      | { reasoning?: boolean; maxTokens?: number }
      | undefined;
    expect(registryModel).toBeDefined();
    expect(turn.provider.reasoning).toBe(registryModel?.reasoning === true);
    expect(turn.provider.max_tokens).toBe(registryModel?.maxTokens);
    // The regression this replaces: a reasoning model described as incapable.
    expect(turn.provider.reasoning).toBe(true);
  });

  it("omits the output ceiling for a model the registry does not carry", async () => {
    // `claude-opus-4-8` is not in pi-ai's registry, so there is no ceiling to
    // state — and an absent field is how the envelope says "let the adapter
    // apply its own default" instead of inventing a number on either side.
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await agentTurnRuns();
    const turn = (run?.action_input as {
      turn: { provider: { model_id: string; reasoning?: boolean; max_tokens?: number } };
    }).turn;
    expect(turn.provider.model_id).toBe('claude-opus-4-8');
    expect(turn.provider.max_tokens).toBeUndefined();
    expect(turn.provider.reasoning).toBe(false);
  });

  it('carries ephemeralContext on the turn-scoped channel, NOT the durable message', async () => {
    // Both producers populate `ephemeralContext` (API body, and the chat
    // bridge's first-turn attention digest) and nothing read it, so a user
    // could supply context and get an answer that never saw it.
    const org = await createTestOrganization();
    await enqueueMessage(
      { ...messageFor(org.id), ephemeralContext: 'the deploy is frozen until Friday' },
      { agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL },
    );
    const [run] = await agentTurnRuns();
    const turn = run.action_input.turn as { message_text: string; ephemeral_context?: string };
    expect(turn.ephemeral_context).toBe('the deploy is frozen until Friday');
    // The durable user message replays on EVERY later turn, so folding a
    // one-turn hint into it would make it permanent history.
    expect(turn.message_text).toBe('what is the isolate lane?');
    expect(turn.message_text).not.toContain('frozen until Friday');
  });

  it('omits ephemeral_context entirely when the caller supplied none', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    expect(run.action_input.turn).not.toHaveProperty('ephemeral_context');
  });

  it('REGRESSION: /new starts the native session empty instead of replaying history', async () => {
    // The chat bridge turns `/new` into an ordinary turn stamped
    // `sessionReset`. Nothing consumed it, so poll hydrated the latest
    // snapshot and the reset became a normal prompt with the old context
    // still loaded — the user asked to start over and did not.
    const sql = getTestDb();
    const org = await createTestOrganization();
    const [prior] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, status, organization_id, run_at)
      VALUES ('chat_message', 'completed', ${org.id}, now()) RETURNING id
    `;
    const history = nativeSession([
      { type: 'message', id: 'pre-reset', parentId: null,
        message: { role: 'user', content: 'history-the-user-asked-to-drop', timestamp: 1 } },
    ]);
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
      VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${prior!.id}, ${history}, ${Buffer.byteLength(history)}, 'completed')
    `;

    const reset = { ...messageFor(org.id), platformMetadata: { sessionReset: true } };
    await enqueueMessage(reset, {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const claimed = await (await pollFleet('fleet-reset', { agent_turn: true })).json();
    // Hydration is SKIPPED: the guest starts from an empty native session even
    // though a snapshot for this conversation exists.
    expect(claimed.payload.turn.session_jsonl).toBe('');
    // Nothing was deleted to achieve it — the prior snapshot row still stands,
    // so the reset stays forward-only and `events` is untouched.
    const [kept] = (await sql`
      SELECT snapshot_jsonl FROM agent_transcript_snapshot WHERE run_id = ${prior!.id}
    `) as unknown as Array<{ snapshot_jsonl: string }>;
    expect(kept?.snapshot_jsonl).toBe(history);
  });

  it('an ordinary turn in that same conversation still replays its history', async () => {
    // The control for the reset case above: without the flag, the snapshot is
    // hydrated. Asserting only the reset would pass if hydration broke wholesale.
    const sql = getTestDb();
    const org = await createTestOrganization();
    const [prior] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, status, organization_id, run_at)
      VALUES ('chat_message', 'completed', ${org.id}, now()) RETURNING id
    `;
    const history = nativeSession();
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
      VALUES (${org.id}, ${AGENT_ID}, 'conv-turn', ${prior!.id}, ${history}, ${Buffer.byteLength(history)}, 'completed')
    `;
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const claimed = await (await pollFleet('fleet-no-reset', { agent_turn: true })).json();
    expect(claimed.payload.turn.session_jsonl).toBe(history);
  });

});


describe('agent turn completion', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(() => {
  });

  it('stamps the tool ledger onto the terminal reply the guardrail reads', async () => {
    // The middle of the ledger chain: the guest produces `tools_used` and the
    // `requireTool` guardrail consumes `payload.toolsUsed` off the
    // thread_response row. This is the hop between them, which nothing covered
    // — the guardrail passed on an absent ledger, so a break here was silent.
    const workerId = 'fleet-ledger';
    const runId = await claimedTurnRun(workerId);
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed',
      text: 'the isolate answer', stop_reason: 'stop',
      session_jsonl: nativeSession(), tools_used: ['query_sdk', 'suggest_actions'],
      exit_reason: 'ok',
    });
    expect(response.status).toBe(200);
    const [reply] = await getTestDb()`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND action_input->>'messageId' = 'msg-turn'
    ` as unknown as Array<{ action_input: { toolsUsed?: string[] } }>;
    expect(reply?.action_input.toolsUsed).toEqual(['query_sdk', 'suggest_actions']);
  });

  it('stamps an EMPTY ledger, which is what trips a missing required tool', async () => {
    // `[]` and absent are different answers downstream: the guardrail passes on
    // absent (it cannot prove a miss) and trips on empty. A turn that called
    // nothing must therefore report `[]`, not omit the field.
    const workerId = 'fleet-ledger-empty';
    const runId = await claimedTurnRun(workerId);
    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed',
      text: 'answered without tools', stop_reason: 'stop',
      session_jsonl: nativeSession(), tools_used: [], exit_reason: 'ok',
    });
    const [reply] = await getTestDb()`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND action_input->>'messageId' = 'msg-turn'
    ` as unknown as Array<{ action_input: Record<string, unknown> }>;
    expect(reply?.action_input.toolsUsed).toEqual([]);
    expect(reply?.action_input).toHaveProperty('toolsUsed');
  });

  it('leaves toolsUsed ABSENT when a worker reports none, rather than inventing []', async () => {
    // A completion with no ledger must not be recorded as "called nothing":
    // that would trip `requireTool` on a turn we have no evidence about, and
    // the follow-up bridge skips on absent precisely to avoid a duplicate card.
    const workerId = 'fleet-ledger-none';
    const runId = await claimedTurnRun(workerId);
    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed',
      text: 'from an older worker', stop_reason: 'stop',
      session_jsonl: nativeSession(), exit_reason: 'ok',
    });
    const [reply] = await getTestDb()`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND action_input->>'messageId' = 'msg-turn'
    ` as unknown as Array<{ action_input: Record<string, unknown> }>;
    expect(reply?.action_input).not.toHaveProperty('toolsUsed');
  });

  it('records the native session on the run row and is idempotent on a retry', async () => {
    const workerId = 'fleet-complete';
    const runId = await claimedTurnRun(workerId);

    const session_jsonl = nativeSession();
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'the isolate answer',
      stop_reason: 'stop',
      usage: { input: 11, output: 7 },
      session_jsonl,
      exit_reason: 'ok',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'completed' });

    const row = await runRow(runId);
    expect(row.status).toBe('completed');
    expect(row.exit_reason).toBe('ok');
    expect(row.output_tail).toBe('the isolate answer');
    expect(row.error_message).toBe(null);
    // The turn envelope survives alongside the result, so a completed run
    // still shows what it was asked to do, not only what it answered.
    expect(row.action_input.turn).toBeDefined();
    expect(row.action_input.result).toEqual({
      text: 'the isolate answer',
      stop_reason: 'stop',
      usage: { input: 11, output: 7 },
      session_jsonl,
    });

    // A retry (worker reconnect, at-least-once delivery) must not re-transition.
    const retry = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'a late duplicate report',
    });
    expect(await retry.json()).toEqual({
      ok: true,
      status: 'completed',
      idempotent: true,
    });
    expect((await runRow(runId)).status).toBe('completed');
  });

  it('persists native IDs, tool pairs and summaries verbatim under the completion fence', async () => {
    const workerId = 'fleet-native-snapshot';
    const runId = await claimedTurnRun(workerId);
    const session = nativeSession([
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'count' } },
      { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call-count', name: 'query_sdk', arguments: { code: 'entities.count()' } },
      ], stopReason: 'toolUse' } },
      { type: 'message', id: 't1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'call-count', toolName: 'query_sdk', content: [{ type: 'text', text: '3' }], isError: false } },
      { type: 'message', id: 'a2', parentId: 't1', message: { role: 'assistant', content: [{ type: 'text', text: 'there are 3' }], stopReason: 'stop' } },
      { type: 'custom', id: 'flush1', parentId: 'a2', customType: 'lobu.memory_flush_state', data: { compactionCount: 0, outcome: 'stored' } },
      { type: 'compaction', id: 'c1', parentId: 'flush1', firstKeptEntryId: 'u1', summary: 'Counted three.', tokensBefore: 900, details: { readFiles: ['a.txt'], modifiedFiles: ['b.txt'] } },
    ]);
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed', text: 'there are 3', session_jsonl: session,
    });
    expect(await response.json()).toMatchObject({ status: 'completed' });
    const sql = getTestDb();
    const [snapshot] = await sql`SELECT snapshot_jsonl, byte_size FROM agent_transcript_snapshot WHERE run_id = ${runId}`;
    expect(snapshot.snapshot_jsonl).toBe(session);
    expect(snapshot.byte_size).toBe(Buffer.byteLength(session));
    const late = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed', text: 'late overwrite', session_jsonl: nativeSession(),
    });
    expect(await late.json()).toMatchObject({ idempotent: true });
    const snapshots = await sql`SELECT snapshot_jsonl FROM agent_transcript_snapshot WHERE run_id = ${runId}`;
    expect(snapshots.map((row) => row.snapshot_jsonl)).toEqual([session]);
    expect(await threadResponses()).toHaveLength(1);
  });

  it('does not persist a stale completion after its lease changes during the request', async () => {
    const workerId = 'fleet-lost-lease';
    const runId = await claimedTurnRun(workerId);
    const realDb = db.getDb();
    let leaseChanged = false;
    const stolenLease = new Proxy(realDb, {
      get(target, property) {
        if (property === 'begin') return async (fn: (tx: db.DbClient) => Promise<unknown>) => {
          if (!leaseChanged) {
            leaseChanged = true;
            await realDb`UPDATE runs SET claimed_by = 'fleet-new-owner' WHERE id = ${runId}`;
          }
          return target.begin(fn);
        };
        return Reflect.get(target, property);
      },
    });
    const spy = vi.spyOn(db, 'getDb').mockReturnValue(stolenLease);
    try {
      const response = await postAsFleet('/api/workers/complete-agent-turn', {
        run_id: runId, worker_id: workerId, status: 'completed', text: 'stale answer', session_jsonl: nativeSession(),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toHaveProperty('error');
      expect(leaseChanged).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect((await runRow(runId)).status).toBe('running');
    expect(await realDb`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${runId}`).toHaveLength(0);
    expect(await threadResponses()).toHaveLength(0);
    const completion = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: 'fleet-new-owner', status: 'completed', text: 'current answer', session_jsonl: nativeSession(),
    });
    expect(await completion.json()).toEqual({ ok: true, status: 'completed' });
    expect(await realDb`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${runId}`).toHaveLength(1);
  });

  it('fails the run when the worker reports a failed turn', async () => {
    const workerId = 'fleet-fail';
    const runId = await claimedTurnRun(workerId);

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'the provider refused the request',
      exit_reason: 'error_message',
    });
    expect(await response.json()).toEqual({ ok: true, status: 'failed' });

    const row = await runRow(runId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('the provider refused the request');
    expect(row.exit_reason).toBe('error_message');
  });

  it('refuses a worker that did not claim the run', async () => {
    const runId = await claimedTurnRun('fleet-claimant');

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: 'fleet-impostor',
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'not mine to report',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty('error');
    expect((await runRow(runId)).status).toBe('running');
  });

  it('an authoritative turn publishes the reply and persists its native session', async () => {
    const workerId = 'fleet-delivers';
    const runId = await claimedTurnRun(workerId);
    const sql = getTestDb();
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'the isolate lane answered',
      session_jsonl: nativeSession(),
    });
    expect(response.status).toBe(200);

    const row = await runRow(runId);
    expect(row.status).toBe('completed');

    // The reply is queued for the same thread_response delivery the subprocess
    // lane uses, addressed from the run's own reply envelope.
    const [reply] = (await sql`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
      ORDER BY id DESC LIMIT 1
    `) as unknown as Array<{ action_input: Record<string, unknown> }>;
    expect(reply.action_input).toMatchObject({
      messageId: 'msg-turn',
      channelId: 'api_user-turn',
      conversationId: 'conv-turn',
      userId: 'user-turn',
      platform: 'api',
      finalText: 'the isolate lane answered',
    });

    // And the turn joins the conversation's transcript, so the next turn's
    // history includes it.
    const [snapshot] = (await sql`
      SELECT snapshot_jsonl FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `) as unknown as Array<{ snapshot_jsonl: string }>;
    expect(snapshot.snapshot_jsonl).toBe(nativeSession());
  });

  it.each([
    ['missing', undefined],
    ['malformed JSON', '{invalid'],
    ['missing header', JSON.stringify({ type: 'message', id: 'x', parentId: null, message: { role: 'user' } })],
    ['duplicate IDs', nativeSession([
      { type: 'message', id: 'x', parentId: null, message: { role: 'user' } },
      { type: 'message', id: 'x', parentId: 'x', message: { role: 'assistant' } },
    ])],
    ['dangling parent', nativeSession([{ type: 'message', id: 'x', parentId: 'missing', message: { role: 'user' } }])],
    ['dangling summary', nativeSession([{ type: 'compaction', id: 'x', parentId: null, firstKeptEntryId: 'missing', summary: 'lost history', tokensBefore: 1 }])],
    ['NUL byte', nativeSession() + '\0'],
    // Not in this table: an OVERSIZE snapshot. It is valid, and failing it
    // failed every later turn of the conversation too (the log is append-only,
    // so each one re-hydrated and outgrew the same stored snapshot). It is
    // trimmed to its latest compaction instead — see "trims the persisted
    // session to its latest compaction".
  ])('fails a %s snapshot visibly and preserves the previous session', async (_kind, session_jsonl) => {
    const workerId = 'fleet-invalid-snapshot';
    const runId = await claimedTurnRun(workerId);
    const sql = getTestDb();
    const [run] = await sql`SELECT organization_id FROM runs WHERE id = ${runId}`;
    const [prior] = await sql`
      INSERT INTO runs (organization_id, run_type, status, action_input)
      VALUES (${run.organization_id}, 'chat_message', 'completed', '{}'::jsonb) RETURNING id
    `;
    const previous = nativeSession();
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
      VALUES (${run.organization_id}, ${AGENT_ID}, 'conv-turn', ${prior.id}, ${previous}, ${Buffer.byteLength(previous)}, 'completed')
    `;
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId, worker_id: workerId, status: 'completed', text: 'unpersisted answer', session_jsonl,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'failed' });
    const result = await runRow(runId);
    expect(result.status).toBe('failed');
    expect(result.error_message).toContain('snapshot');
    expect(result.exit_reason).toBe('error_message');
    expect(result.action_input.result).not.toHaveProperty('session_jsonl');
    const snapshots = await sql`SELECT run_id, snapshot_jsonl FROM agent_transcript_snapshot`;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ run_id: prior.id, snapshot_jsonl: previous });
    const replies = await threadResponses();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ messageId: 'msg-turn', error: result.error_message });
    expect(replies[0]).not.toHaveProperty('finalText');
  });

  it('a failed authoritative turn delivers the error instead of hanging the client', async () => {
    const workerId = 'fleet-delivers-error';
    const runId = await claimedTurnRun(workerId);
    const sql = getTestDb();
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'the provider refused',
    });
    expect(response.status).toBe(200);

    const [reply] = (await sql`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
      ORDER BY id DESC LIMIT 1
    `) as unknown as Array<{ action_input: Record<string, unknown> }>;
    expect(reply.action_input).toMatchObject({ messageId: 'msg-turn', error: 'the provider refused' });
    // A failed turn writes no transcript: there is no answer to remember.
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  /** Just the delta spans of a set of thread_response rows, in order. */
  function rows_delta(rows: Array<Record<string, unknown>>): unknown[] {
    return rows.filter((row) => row.delta !== undefined).map((row) => row.delta);
  }

  /** The queued thread_response rows, oldest first. */
  async function threadResponses(): Promise<Array<Record<string, unknown>>> {
    const sql = getTestDb();
    const rows = (await sql`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
      ORDER BY id ASC
    `) as unknown as Array<{ action_input: Record<string, unknown> }>;
    return rows.map((row) => row.action_input);
  }

  it('drops an oversize or malformed span unpublished and unacknowledged, and keeps the beat', async () => {
    const workerId = 'fleet-oversize-span';
    const runId = await claimedTurnRun(workerId);
    // One past TURN_DELTA_MAX_CHARS (24_000): the schema bound, now enforced.
    const oversize = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: 'x'.repeat(24_001), sequence: 1 },
    });
    expect(oversize.status).toBe(200);
    expect(await oversize.json()).toEqual({ continue: true });
    const malformed = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_tool_events: [{ tool_call_id: 'c', name: 'x', is_error: 'yes', output: 'o' }],
    });
    expect(malformed.status).toBe(200);
    expect(await threadResponses()).toHaveLength(0);
    // A well-formed span still streams.
    const fine = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: 'ok', sequence: 1 },
    });
    expect(await fine.json()).toMatchObject({ turn_delta_ack: { sequence: 1, published: true } });
  });

  it('streams an in-flight turn to the client on the heartbeat it already sends', async () => {
    const workerId = 'fleet-streams';
    const runId = await claimedTurnRun(workerId);

    // The worker beats twice as the reply grows. The text is INCREMENTAL: the
    // second beat CONTINUES the first rather than restating it, because every
    // renderer of a delta appends (`ApiResponseRenderer` -> the SPA's
    // `textOut += content`), exactly as the subprocess lane's
    // `sendStreamDelta(delta, false)` intends.
    const first = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: 'the isolate', sequence: 1 },
    });
    expect(first.status).toBe(200);
    // The ack is what lets the worker retire the span it sent. Without one it
    // must re-send the same text under the same sequence.
    expect(await first.json()).toMatchObject({
      turn_delta_ack: { sequence: 1, published: true },
    });
    const second = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: ' lane answered', sequence: 2 },
    });
    expect(second.status).toBe(200);

    const rows = await threadResponses();
    expect(rows).toHaveLength(2);
    // Addressed from the RUN's own reply envelope, never from the heartbeat
    // body — the worker names no destination and cannot.
    expect(rows[0]).toMatchObject({
      messageId: 'msg-turn',
      channelId: 'api_user-turn',
      conversationId: 'conv-turn',
      userId: 'user-turn',
      platform: 'api',
      delta: 'the isolate',
      // Not a replacement: the client appends this span to what it has.
      isFullReplacement: false,
    });
    expect(rows[1]).toMatchObject({
      delta: ' lane answered',
      isFullReplacement: false,
    });
    // Appending the spans — all the client does — rebuilds the reply exactly.
    expect(rows.map((row) => row.delta).join('')).toBe('the isolate lane answered');
    // A delta is not terminal: it carries no finalText and discharges nothing,
    // so the turn is still awaiting its completion.
    expect(rows[1].finalText).toBeUndefined();
    expect(rows[1].processedMessageIds).toBeUndefined();
    const row = await runRow(runId);
    expect(row.status).toBe('running');
  });

  it('never publishes the same span twice on a retried or reordered heartbeat', async () => {
    const workerId = 'fleet-reorder';
    const runId = await claimedTurnRun(workerId);

    await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: 'the isolate', sequence: 1 },
    });
    await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: ' lane answered', sequence: 2 },
    });
    // An older sequence arriving late (at-least-once delivery) would otherwise
    // append a span the client has already read, a second time.
    const stale = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: 'the isolate', sequence: 1 },
    });
    // The heartbeat itself still succeeds — liveness is its job, and a dropped
    // delta must never get a live turn reaped.
    expect(stale.status).toBe(200);
    // And it is ACKNOWLEDGED, as not-published: there is nothing more the
    // worker can do about a sequence the run has already passed, so it retires
    // the batch rather than re-sending it forever.
    expect(await stale.json()).toMatchObject({
      turn_delta_ack: { sequence: 1, published: false },
    });
    // A redelivery of the newest sequence is likewise not republished.
    const redelivered = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_delta: { text: ' lane answered', sequence: 2 },
    });
    expect(await redelivered.json()).toMatchObject({
      turn_delta_ack: { sequence: 2, published: false },
    });

    // Exactly the two spans, each once: the retry duplicated nothing and the
    // reorder erased nothing.
    expect(rows_delta(await threadResponses())).toEqual([
      'the isolate',
      ' lane answered',
    ]);
  });

  it('refuses a delta from a worker that did not claim the run', async () => {
    const claimantRunId = await claimedTurnRun('fleet-claimant-stream');
    // Not this worker's run: its text must not reach another turn's client.
    // The lease fence refuses it, and — critically — it gets NO ack, because
    // an ack would tell a worker to drop text it may legitimately still owe.
    const impostor = await postAsFleet('/api/workers/heartbeat', {
      run_id: claimantRunId,
      worker_id: 'fleet-impostor-stream',
      turn_delta: { text: 'not mine to publish', sequence: 1 },
    });
    expect(await impostor.json()).not.toMatchObject({
      turn_delta_ack: { published: true },
    });

    expect(await threadResponses()).toEqual([]);
  });

  it('publishes a finished tool call as the tool_use event both lanes use', async () => {
    const workerId = 'fleet-tool-trace';
    const runId = await claimedTurnRun(workerId);

    const beat = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_tool_events: [
        {
          tool_call_id: 'call-1',
          name: 'search_memory',
          input: { query: 'pricing' },
          is_error: false,
          output: '3 results',
        },
      ],
    });
    expect(beat.status).toBe(200);

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    // The SAME customEvent name the subprocess lane emits per
    // `tool_execution_end`, so every consumer already subscribed to `tool_use`
    // sees this lane's tools without learning a second shape.
    expect(rows[0]).toMatchObject({
      conversationId: 'conv-turn',
      customEvent: {
        name: 'tool_use',
        // `input` is what the SPA renders as the tool row's args, as on the subprocess lane.
        data: { toolCallId: 'call-1', name: 'search_memory', input: { query: 'pricing' }, isError: false },
      },
    });
  });

  it('delivers a trace that arrives with the completion, not just on a beat', async () => {
    const workerId = 'fleet-tool-trace-trailing';
    const runId = await claimedTurnRun(workerId);

    // A turn's LAST tool call finishes after its final heartbeat, so its trace
    // has no beat left to ride. The heartbeat publish is fenced on the run
    // still being `running` and completion is what ends that, so before this
    // was carried on the completion body the trace was dropped every time —
    // a single-tool turn traced nothing at all.
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'Saved that for you.',
      turn_tool_events: [
        {
          tool_call_id: 'call-save-1',
          name: 'save_memory',
          input: { title: 'release freeze' },
          is_error: false,
          output: 'saved',
        },
      ],
    });
    expect(response.status).toBe(200);

    const rows = await threadResponses();
    // The trace AND the answer, in that order: the tool row explains the reply,
    // so a client reading them in id order sees the work before the conclusion.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      customEvent: {
        name: 'tool_use',
        data: { toolCallId: 'call-save-1', name: 'save_memory', isError: false },
      },
    });
    expect(rows[1]).toMatchObject({ finalText: 'Saved that for you.' });
  });

  it('completes without a trace batch when the turn called nothing', async () => {
    const workerId = 'fleet-tool-trace-none';
    const runId = await claimedTurnRun(workerId);

    // The field is optional and absent here: a turn that called no tool must
    // not manufacture an empty trace row beside its answer.
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'No tools needed.',
    });
    expect(response.status).toBe(200);

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ finalText: 'No tools needed.' });
  });

  it('stamps repliedInBand so an in-band reply is not delivered twice', async () => {
    const workerId = 'fleet-in-band';
    const runId = await claimedTurnRun(workerId);

    // The agent called `send_message` into the conversation it is answering,
    // so the user has already READ the answer. The guest reports it; without
    // this flag the completion route would queue `text` as well and the user
    // would see the same answer twice.
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'I posted the summary above.',
      replied_in_band: true,
    });
    expect(response.status).toBe(200);

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    // The row still carries the reply — it is the authoritative record and
    // other consumers read it — but it is marked, and the renderers' existing
    // suppression (`chat-response-bridge`) is what drops the delivery.
    expect(rows[0]).toMatchObject({
      finalText: 'I posted the summary above.',
      repliedInBand: true,
    });
  });

  it('leaves an ordinary turn unmarked, so only a positive signal suppresses', async () => {
    const workerId = 'fleet-not-in-band';
    const runId = await claimedTurnRun(workerId);

    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'here is the answer',
    });

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    // Absent, not false: suppression acts on a positive signal only, never on
    // silence, so an older worker still gets its reply delivered.
    expect(rows[0].repliedInBand).toBeUndefined();
  });

  it('never marks a FAILED turn as replied in band', async () => {
    const workerId = 'fleet-in-band-failed';
    const runId = await claimedTurnRun(workerId);

    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'provider refused',
      replied_in_band: true,
    });

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    // An error is not a duplicate of the reply and must always surface, so the
    // flag never rides an error row — suppressing it would leave the user with
    // no message at all.
    expect(rows[0].repliedInBand).toBeUndefined();
    expect(rows[0].error).toBe('provider refused');
  });

  it('classifies a native provider failure and preserves its CTA context', async () => {
    const workerId = 'fleet-provider-quota';
    const runId = await claimedTurnRun(workerId);
    const raw = '429 Weekly/Monthly Limit Exhausted';

    await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: raw,
    });

    const rows = await threadResponses();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      error: raw,
      errorCode: AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED,
      errorContext: { provider: 'claude', model: 'claude-opus-4-8' },
    });
  });

  it('refuses an authoritative turn that carries nowhere to deliver', async () => {
    const workerId = 'fleet-authoritative';
    const runId = await claimedTurnRun(workerId);
    // Authoritative, but with the reply envelope removed — the deploy-skew
    // shape where a newer producer marks turns authoritative and an older one
    // stamped no address. Completing it would transition the run and drop the
    // answer, leaving the client waiting forever, so it stays claimable.
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = action_input - 'reply'
      WHERE id = ${runId}
    `;

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'a reply nobody would deliver',
    });
    expect(response.status).toBe(409);
    const row = await runRow(runId);
    expect(row.status).toBe('running');
    expect(row.action_input.result).toBeUndefined();
  });

  it('the generic complete route refuses an agent turn and leaves it running', async () => {
    const workerId = 'fleet-generic';
    const runId = await claimedTurnRun(workerId);

    // A daemon that predates the lane would finalize the turn with sync
    // semantics, dropping the transcript and the reply. The reaper terminalizes
    // it instead.
    const response = await postAsFleet('/api/workers/complete', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      items_collected: 0,
    });
    expect(response.status).toBe(409);
    expect((await runRow(runId)).status).toBe('running');
  });
});

/**
 * The reaper's side of delivery: a fleet worker that crashes mid-turn never
 * reaches the completion route, so the run reaper is the only thing left that
 * can tell the client. It publishes the error the completion route would have,
 * as long as the run says where the reply goes.
 */
describe('agent turn reaper', () => {
  const STALE_THRESHOLD_SECONDS = 60;

  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  afterEach(() => {
  });

  /** The worker died: its last heartbeat is well past any threshold. */
  async function loseHeartbeat(runId: number) {
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET claimed_at = now() - interval '1 hour',
          last_heartbeat_at = now() - interval '1 hour'
      WHERE id = ${runId}
    `;
  }

  async function threadResponses() {
    const sql = getTestDb();
    return (await sql`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
      ORDER BY id
    `) as unknown as Array<{ action_input: Record<string, unknown> }>;
  }

  it('a crashed worker on an authoritative turn delivers the error instead of hanging the client', async () => {
    const runId = await claimedTurnRun('fleet-crashed');
    await loseHeartbeat(runId);

    // Through the real reaper tick, so the lane is proven reachable from the
    // 30s interval and not just from its own helper.
    const result = await reapStaleRuns();
    expect(result.acquired).toBe(true);
    expect(result.reaped).toBe(1);
    // A turn is never re-run behind the user's back.
    expect(result.retriesCreated).toBe(0);

    const row = await runRow(runId);
    expect(row.status).toBe('timeout');
    expect(row.error_message).toBe('worker_heartbeat_lost');

    // The client gets the same thread_response the completion route publishes
    // on failure, addressed from the run's own reply envelope and rendered
    // through the shared error catalog.
    const replies = await threadResponses();
    expect(replies).toHaveLength(1);
    expect(replies[0].action_input).toMatchObject({
      messageId: 'msg-turn',
      channelId: 'api_user-turn',
      conversationId: 'conv-turn',
      userId: 'user-turn',
      platform: 'api',
      error: AGENT_ERRORS[AgentErrorCode.WORKER_DIED].message,
      errorCode: AgentErrorCode.WORKER_DIED,
      processedMessageIds: ['msg-turn'],
    });
    expect(replies[0].action_input.finalText).toBeUndefined();

    // A second tick finds nothing: the row is terminal, so no duplicate error.
    const again = await reapStaleRuns();
    expect(again.reaped).toBe(0);
    expect(await threadResponses()).toHaveLength(1);
  });

  it('a turn no worker ever claimed times out and tells the client it never started', async () => {
    const org = await createTestOrganization();
    await enqueueMessage(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await agentTurnRuns();
    const sql = getTestDb();
    await sql`UPDATE runs SET created_at = now() - interval '1 hour', run_at = now() - interval '1 hour' WHERE id = ${run.id}`;

    expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({
      reaped: 1,
      delivered: 1,
    });
    const row = await runRow(run.id);
    expect(row.status).toBe('timeout');
    expect(row.error_message).toBe('worker_claim_timeout');
    const replies = await threadResponses();
    expect(replies).toHaveLength(1);
    expect(replies[0].action_input).toMatchObject({
      messageId: 'msg-turn',
      errorCode: AgentErrorCode.WORKER_STARTUP_FAILED,
      error: AGENT_ERRORS[AgentErrorCode.WORKER_STARTUP_FAILED].message,
    });
  });

  it('reaps a stale turn and delivers its error, leaving a heartbeating turn alone', async () => {
    // Each claimed run is its own org and worker. A stale turn next to a fresh
    // one shows the sweep terminalizing the former — and telling its client
    // why — while leaving the latter untouched.
    const stale = await claimedTurnRun('fleet-stale');
    await loseHeartbeat(stale);
    const live = await claimedTurnRun('fleet-live');

    expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({
      reaped: 1,
      delivered: 1,
    });
    const staleRow = await runRow(stale);
    expect(staleRow.status).toBe('timeout');
    expect(staleRow.error_message).toBe('worker_heartbeat_lost');
    // The turn owed this client an answer and the worker died, so the client
    // is told rather than left waiting.
    const [delivered] = await threadResponses();
    expect(delivered!.action_input).toMatchObject({ errorCode: AgentErrorCode.WORKER_DIED });
    // The live turn just claimed, so its heartbeat is fresh.
    expect((await runRow(live)).status).toBe('running');
  });

  it('an authoritative turn with no reply address terminalizes without delivering', async () => {
    // The deploy-skew case the completion route's 409 covers: a producer that
    // stamped an authoritative turn without saying where the reply goes. The
    // reaper has nowhere to deliver to, but the row must not wedge the lane.
    const runId = await claimedTurnRun('fleet-unaddressed');
    await loseHeartbeat(runId);
    const sql = getTestDb();
    await sql`UPDATE runs SET action_input = action_input - 'reply' WHERE id = ${runId}`;

    expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({
      reaped: 1,
      delivered: 0,
    });
    expect((await runRow(runId)).status).toBe('timeout');
    expect(await threadResponses()).toHaveLength(0);
  });

  it('a worker that completes between the candidate read and the timeout wins', async () => {
    // The fenced UPDATE re-asserts the staleness predicate, so a heartbeat or
    // completion that lands after the candidate read makes the reap a no-op
    // rather than an overwrite of a live answer.
    const workerId = 'fleet-late';
    const runId = await claimedTurnRun(workerId);
    await loseHeartbeat(runId);
    const completion = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'made it just in time',
    });
    expect(completion.status).toBe(200);

    expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({
      reaped: 0,
      delivered: 0,
    });
    expect((await runRow(runId)).status).toBe('completed');
    // Exactly the reply the worker delivered, no timeout error beside it.
    const replies = await threadResponses();
    expect(replies).toHaveLength(1);
    expect(replies[0].action_input).toMatchObject({ finalText: 'made it just in time' });
  });
});
