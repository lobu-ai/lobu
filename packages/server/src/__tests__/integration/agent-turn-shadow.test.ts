/**
 * The shadow producer end to end: a selected agent's message produces an
 * `agent_turn` run, only a fleet worker that advertises the lane can claim it,
 * and the turn is reported back on the lane's own completion route. This is the
 * seam that makes the isolate turn lane REACHABLE — the executor suite proves
 * the turn runs, this proves a real message reaches it and comes back.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import { IsolateExecutor } from '@lobu/connector-worker/executor/isolate';
import {
  AgentTurnPollPayloadSchema,
  PollResponseSchema,
} from '@lobu/core/contracts/worker/protocol';
import { AGENT_ERRORS, AgentErrorCode, parseSessionEntries, type MessagePayload, verifyWorkerToken } from '@lobu/core';
import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db/client';
import { createInteractionRoutes } from '../../gateway/routes/internal/interactions';
import { enqueueAgentTurnShadow,
  steerActiveAgentTurn,
} from '../../gateway/orchestration/agent-turn-shadow';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { sweepStaleAgentTurnRuns } from '../../worker-api/agent-turn';
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

const SHADOW_ENV = 'LOBU_ISOLATE_TURN_SHADOW_AGENTS';
const GATEWAY_URL = 'https://gateway.test.invalid/lobu';
const AGENT_ID = 'shadow-agent';

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
    identityMd: 'I am the shadow agent.',
    soulMd: 'Answer briefly.',
    userMd: '',
  }),
} as unknown as AgentSettingsStore;

function messageFor(organizationId: string): MessagePayload {
  return {
    userId: 'user-shadow',
    conversationId: 'conv-shadow',
    messageId: 'msg-shadow',
    channelId: 'api_user-shadow',
    agentId: AGENT_ID,
    organizationId,
    botId: 'bot-shadow',
    platform: 'api',
    messageText: 'what is the shadow lane?',
    platformMetadata: {},
    agentOptions: { model: 'claude/claude-opus-4-8' },
  } as MessagePayload;
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

async function shadowRuns() {
  const sql = getTestDb();
  return (await sql`
    SELECT id, run_type, status, approval_status, organization_id, action_input
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
    body,
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

/** Enqueue a shadow turn and claim it, as the fleet worker would. */
async function claimedShadowRun(workerId: string): Promise<number> {
  const org = await createTestOrganization();
  await enqueueAgentTurnShadow(messageFor(org.id), {
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
    message: { role: 'user', content: 'what is the shadow lane?', timestamp: 1 } },
  { type: 'message', id: 'native-answer', parentId: 'native-user',
    message: { role: 'assistant', content: [{ type: 'text', text: 'an observational copy' }], timestamp: 2 } },
]): string {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return [
    { type: 'session', version: 3, id: 'native-session', timestamp, cwd: '/workspace' },
    ...entries.map((entry) => ({ timestamp, ...entry })),
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

describe('agent turn shadow producer', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

  it('captures a real HTTP interaction made with the producer-minted shadow credential', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();
    const postLinkButton = vi.fn(async () => ({ id: 'synthetic-post' }));
    const app = createInteractionRoutes({ postLinkButton } as never);
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/interactions/create`, {
        method: 'POST',
        headers: { authorization: `Bearer ${run.action_input.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ interactionType: 'link_button', url: 'https://example.invalid', label: 'Shadow attempt' }),
      });
      expect(response.status).toBe(200);
      expect(postLinkButton).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ captured: true });
      expect(verifyWorkerToken(run.action_input.credential as string)).toMatchObject({
        executionMode: 'capture', runId: run.id, organizationId: org.id,
      });
      const [captured] = await getTestDb()`SELECT dry_run_preview FROM runs WHERE id = ${run.id}`;
      expect(captured.dry_run_preview.side_effects).toMatchObject([{ action: 'interactions.create' }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('executes write/edit over worker HTTP and persists the real isolate transcript', async () => {
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
        VALUES (${org.id}, ${AGENT_ID}, 'conv-shadow', ${prior.id}, ${history}, ${Buffer.byteLength(history)}, 'completed')
      `;
      await enqueueAgentTurnShadow(messageFor(org.id), {
        agentSettings: settingsStore, catalog: catalogFor(tokenEchoingModule()), gatewayUrl: `${origin}/lobu`,
      });
      const [run] = await shadowRuns();
      expect(run.action_input.turn).toMatchObject({ session_jsonl: '' });
      // Exercise authoritative transcript/reply persistence in the isolated test DB.
      await sql`UPDATE runs SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb) WHERE id = ${run.id}`;
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
      expect(snapshot.snapshot_jsonl).toBe(completion.session_jsonl);
      expect(snapshot.snapshot_jsonl.startsWith(history)).toBe(true);
      const messages = parseSessionEntries(snapshot.snapshot_jsonl).entries.map((entry) => entry.message).filter(Boolean) as any[];
      const toolResults = messages.filter((message) => message.role === 'toolResult');
      expect(toolResults.map((message) => [message.toolName, message.isError])).toEqual([
        ['write', false], ['edit', false], ['edit', true], ['read', false], ['bash', false],
      ]);
      expect(toolResults[1].details).toMatchObject({ firstChangedLine: 1 });
      expect(toolResults[2].content[0].text).toContain('Could not find the exact text in a.txt');
      expect(toolResults[3].content).toEqual([{ type: 'text', text: 'after\r\n' }]);
      expect(toolResults[4].content).toEqual([{ type: 'text', text: `${Buffer.from('\ufeffafter\r\n').toString('base64')}\n` }]);
      const [reply] = await sql`SELECT action_input FROM runs WHERE queue_name = 'thread_response' AND action_input->>'finalText' = ${completion.text}`;
      expect(reply.action_input).toMatchObject({ conversationId: 'conv-shadow', finalText: completion.text });
      // A lost completion response must not append the same transcript twice.
      await client.completeAgentTurn(completion as never);
      const snapshots = await sql`SELECT id FROM agent_transcript_snapshot WHERE run_id = ${run.id}`;
      expect(snapshots).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it('produces a claimable, schema-valid envelope with the credential lifted off the turn', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const rows = await shadowRuns();
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
      conversation_id: 'conv-shadow',
      message_id: 'msg-shadow',
      message_text: 'what is the shadow lane?',
      shadow: true,
      provider: {
        api: 'anthropic-messages',
        provider: 'anthropic',
        // Lobu stores "claude/…"; the upstream only knows the bare id.
        model_id: 'claude-opus-4-8',
        base_url: `${GATEWAY_URL}/api/proxy/anthropic/a/${AGENT_ID}/o/${org.id}/u/user-shadow`,
      },
      // Deny-all: the gateway proxy and nothing else.
      allowed_hosts: ['gateway.test.invalid'],
    });
    expect(envelope.turn.system_prompt).toBe(
      '## Agent Identity\n\nI am the shadow agent.\n\n## Agent Instructions\n\nAnswer briefly.\n\n' +
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
        'Your bash, read, write, ls and find tools act on a private in-memory workspace at /workspace.\n' +
        'It starts empty on every turn and nothing written there persists after the turn ends.\n' +
        'It has no network access and no package manager; use your other tools to reach data.\n' +
        'Nothing in the workspace is visible to the user: to show them a file you produced, call upload_file before the turn ends.'
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
    expect(verifyWorkerToken(envelope.credential)).toMatchObject({ executionMode: 'capture', runId: rows[0].id });
    expect(JSON.stringify(envelope.turn)).not.toContain('lobu_secret_');
  });

  it('omits file-delivery instructions when upload_file is denied', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    message.agentOptions = { ...message.agentOptions, disallowedTools: 'upload_file' };
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();
    const turn = run.action_input.turn;
    expect(turn.tools.media).toEqual(['generate_image', 'generate_audio']);
    expect(turn.tools.builtin).toContain('write');
    expect(turn.system_prompt).not.toContain('### Share Created Files');
    expect(turn.system_prompt).not.toContain('call upload_file before the turn ends');
  });

  it('hands the turn its tools, its one credential being a worker token both gateway routes accept', async () => {
    const org = await createTestOrganization();
    const fixture = mcpFixture();
    const message = messageFor(org.id);
    message.platformMetadata = { connectionId: 'conn-shadow' };
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: fixture.mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
      userId: 'user-shadow',
      organizationId: org.id,
      conversationId: 'conv-shadow',
      channelId: 'api_user-shadow',
      connectionId: 'conn-shadow',
      messageId: 'msg-shadow',
      deploymentName: 'agent-turn:msg-shadow',
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
    expect(envelope.turn.system_prompt.endsWith('\n\nUse query_sdk before run_sdk.')).toBe(true);
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
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
      const rows = await shadowRuns();
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
    await enqueueAgentTurnShadow(messageFor(org.id), base);
    await toolless();

    // The agent exposes MCP as shell commands, which this lane does not carry.
    const cli = messageFor(org.id);
    cli.agentOptions = { model: 'claude/claude-opus-4-8', toolsConfig: { mcpExposure: 'cli' } };
    await enqueueAgentTurnShadow(cli, { ...base, mcp: mcpFixture().mcp });
    await toolless();

    // A separate placeholder cannot enforce the signed capture policy.
    const before = (await shadowRuns()).length;
    await enqueueAgentTurnShadow(messageFor(org.id), {
      ...base,
      catalog: catalogFor(claudeModule({ buildCredentialPlaceholder: () => 'lobu_secret_11111111-2222-3333-4444-555555555555' })),
      mcp: mcpFixture().mcp,
    });
    expect(await shadowRuns()).toHaveLength(before);

    // Discovery failed: nothing to hand the turn, but the turn itself runs.
    await enqueueAgentTurnShadow(messageFor(org.id), { ...base, mcp: mcpFixture({ fail: true }).mcp });
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
      VALUES (${org.id}, ${AGENT_ID}, 'conv-shadow', ${prior.id}, ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed', ${at})
    `;

    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
      VALUES (${org.id}, ${AGENT_ID}, 'conv-shadow', ${prior.id}, ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed', ${at})
    `;

    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
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
    await enqueueAgentTurnShadow(messageFor(org.id), dependencies);
    await enqueueAgentTurnShadow({ ...messageFor(org.id), messageId: 'queued-second' }, dependencies);
    const [first, second] = await shadowRuns();
    await sql`UPDATE runs SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb) WHERE id = ${first.id}`;
    const firstClaim = await pollFleet('fleet-native-first', { agent_turn: true });
    expect((await firstClaim.json()).run_id).toBe(first.id);
    const session = nativeSession();
    const completed = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: first.id, worker_id: 'fleet-native-first', status: 'completed', text: 'an observational copy', session_jsonl: session,
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

  it('rolls back the claim when its native snapshot cannot be read', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();
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
    const retry = await pollFleet('fleet-snapshot-retry', { agent_turn: true });
    expect((await retry.json()).run_id).toBe(run.id);
  });

  it('parks a steerable follow-up on the running turn instead of making it a turn of its own', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });
    const claimed = await pollFleet('fleet-steer', { agent_turn: true });
    const { run_id: runId } = (await claimed.json()) as { run_id: number };

    // The same human, in the same conversation, while the turn runs: parked.
    const followUp = { ...messageFor(org.id), messageId: 'msg-2', messageText: 'also check companies' };
    expect(await steerActiveAgentTurn(followUp)).toBe(true);
    // Another follow-up queues behind it, in order.
    expect(await steerActiveAgentTurn({ ...followUp, messageId: 'msg-3', messageText: 'and people' })).toBe(true);
    const [row] = (await sql`SELECT run_metadata FROM runs WHERE id = ${runId}`) as unknown as Array<{
      run_metadata: { steer?: unknown };
    }>;
    expect(row.run_metadata.steer).toEqual([
      { message_id: 'msg-2', text: 'also check companies' },
      { message_id: 'msg-3', text: 'and people' },
    ]);
    // No second run was produced for either.
    expect(await shadowRuns()).toHaveLength(1);

    // Someone else in the conversation, or an automation's message, is not a
    // steer — the predicate both lanes share says so.
    expect(await steerActiveAgentTurn({ ...followUp, userId: 'user-other' })).toBe(false);
    expect(
      await steerActiveAgentTurn({ ...followUp, platformMetadata: { source: 'automation-run' } } as typeof followUp)
    ).toBe(false);
    // Nothing running in another conversation: nothing to steer.
    expect(await steerActiveAgentTurn({ ...followUp, conversationId: 'conv-elsewhere' })).toBe(false);
    // An agent the operator has not selected costs the enqueue path nothing.
    expect(await steerActiveAgentTurn({ ...followUp, agentId: 'agent-not-selected' })).toBe(false);
  });

  it('carries a pinned sandbox as signed token claims and a remote-bash marker', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(
      { ...messageFor(org.id), networkConfig: { allowedDomains: ['example.com'] }, nixConfig: { packages: ['ripgrep'] } } as MessagePayload,
      {
        agentSettings: settingsStore,
        catalog: catalogFor(tokenEchoingModule()),
        mcp: mcpFixture().mcp,
        gatewayUrl: GATEWAY_URL,
        runtime: { runtimeProviderId: 'vercel', sandboxId: 'sandbox-1' },
      }
    );
    const [run] = await shadowRuns();
    const turn = run.action_input.turn as { tools?: { remote_runtime?: unknown } };
    expect(turn.tools?.remote_runtime).toEqual({ provider_id: 'vercel' });
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
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(tokenEchoingModule()),
      mcp: mcpFixture().mcp,
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();
    expect((run.action_input.turn as { tools?: { remote_runtime?: unknown } }).tools?.remote_runtime).toBeUndefined();
  });

  it('arms no turn marker and journals no run input', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const sql = getTestDb();
    // Both are keyed (deploymentName, messageId) and both are first-writer-wins,
    // so a shadow that wrote either would let the observational lane terminate
    // or replay the real turn.
    const [markers] = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE queue_name = 'internal:turn_timeout'
    `) as unknown as Array<{ n: number }>;
    expect(markers.n).toBe(0);
    const [journal] = (await sql`
      SELECT count(*)::int AS n FROM agent_run_input WHERE message_id = 'msg-shadow'
    `) as unknown as Array<{ n: number }>;
    expect(journal.n).toBe(0);
  });

  it('serializes concurrent fleet claims for one conversation until completion', async () => {
    const org = await createTestOrganization();
    for (const messageId of ['claim-first', 'claim-second']) {
      await enqueueAgentTurnShadow({ ...messageFor(org.id), messageId }, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const [first, second] = await shadowRuns();
    const workers = ['fleet-claim-a', 'fleet-claim-b'];
    const responses = await Promise.all(workers.map((worker) => pollFleet(worker, { agent_turn: true })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
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
      await enqueueAgentTurnShadow({ ...messageFor(org.id), messageId }, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const [first, second] = await shadowRuns();
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
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
    });
    const [template] = await shadowRuns();
    const sql = getTestDb();
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${template.id}`;
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let inserted!: (id: number) => void;
    const earlierId = new Promise<number>((resolve) => { inserted = resolve; });
    const earlierCommit = sql.begin(async (tx) => {
      const [run] = await tx`
        INSERT INTO runs (organization_id, run_type, status, approval_status, action_input)
        SELECT organization_id, run_type, 'pending', 'auto', action_input FROM runs WHERE id = ${template.id}
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
      ? "jsonb_build_array('agent_turn_claim'"
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
        INSERT INTO runs (organization_id, run_type, status, approval_status, action_input)
        SELECT organization_id, run_type, 'pending', 'auto', action_input FROM runs WHERE id = ${template.id}
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
      expect((await shadowRuns()).filter((run) => run.status === 'pending')).toHaveLength(1);
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
        await enqueueAgentTurnShadow({ ...messageFor(org.id), messageId }, {
          agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
        });
      }
      const [first, second] = await shadowRuns();
      const sql = getTestDb();
      await sql`
        UPDATE runs SET status = ${status}, claimed_by = 'fleet-crashed',
          claimed_at = now() - interval '1 hour', last_heartbeat_at = now() - interval '1 hour'
        WHERE id = ${first.id}
      `;
      expect((await (await pollFleet('fleet-before-reap', { agent_turn: true })).json()).run_id).toBeUndefined();
      expect(await sweepStaleAgentTurnRuns(60)).toEqual({ reaped: 1, delivered: 0 });
      expect((await runRow(first.id)).status).toBe('timeout');
      expect((await (await pollFleet('fleet-after-reap', { agent_turn: true })).json()).run_id).toBe(second.id);
    }
  );

  it.each(['agent_id', 'conversation_id'])(
    'fails a turn with missing %s instead of executing without its conversation fence', async (field) => {
      const org = await createTestOrganization();
      await enqueueAgentTurnShadow(messageFor(org.id), {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
      const [run] = await shadowRuns();
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
        await enqueueAgentTurnShadow({ ...messageFor(org.id), messageId }, {
          agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
        });
      }
      const [first, second] = await shadowRuns();
      const sql = getTestDb();
      // Existing/out-of-order work must also fence the older pending row.
      await sql`UPDATE runs SET status = 'running', claimed_by = 'fleet-existing-owner' WHERE id = ${second.id}`;
      expect((await (await pollFleet('fleet-waiting', { agent_turn: true })).json()).run_id).toBeUndefined();
      await sql`UPDATE runs SET status = ${terminalStatus}, completed_at = now() WHERE id = ${second.id}`;
      expect((await (await pollFleet('fleet-released', { agent_turn: true })).json()).run_id).toBe(first.id);
    }
  );

  it('claims distinct organization, agent and conversation scopes independently', async () => {
    process.env[SHADOW_ENV] = '*';
    const org = await createTestOrganization();
    const otherOrg = await createTestOrganization();
    const base = messageFor(org.id);
    for (const message of [
      { ...base, messageId: 'scope-base' },
      { ...base, messageId: 'scope-org', organizationId: otherOrg.id },
      { ...base, messageId: 'scope-agent', agentId: 'other-shadow-agent' },
      { ...base, messageId: 'scope-conversation', conversationId: 'other-shadow-conversation' },
    ]) {
      await enqueueAgentTurnShadow(message, {
        agentSettings: settingsStore, catalog: catalogFor(claudeModule()), gatewayUrl: GATEWAY_URL,
      });
    }
    const runs = await shadowRuns();
    expect(runs).toHaveLength(4);
    const claims = await Promise.all(runs.map(async (_, index) =>
      (await pollFleet(`fleet-scope-${index}`, { agent_turn: true })).json()
    ));
    expect(claims.map((claim) => claim.run_id).sort()).toEqual(runs.map((run) => run.id).sort());
  });

  it('a fleet worker that advertises the lane claims it and receives the turn plus the credential', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();

    const response = await pollFleet('fleet-agent-turn', { agent_turn: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Value.Check(PollResponseSchema, body)).toBe(true);
    expect(body.run_id).toBe(run.id);
    expect(body.run_type).toBe('agent_turn');
    expect(body.organization_id).toBe(org.id);
    expect(body.payload.turn.provider.model_id).toBe('claude-opus-4-8');
    expect(body.credentials).toEqual({
      provider: 'anthropic',
      accessToken: expect.any(String),
    });

    const sql = getTestDb();
    const [claimed] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string; claimed_by: string }>;
    expect(claimed).toEqual({ status: 'running', claimed_by: 'fleet-agent-turn' });
  });

  it('a fleet worker without the capability leaves the run pending', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();

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
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();

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

  it('produces nothing when the agent is not selected, has no model, or runs an unsupported protocol', async () => {
    const org = await createTestOrganization();
    const deps = {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    };

    process.env[SHADOW_ENV] = 'some-other-agent';
    await enqueueAgentTurnShadow(messageFor(org.id), deps);
    expect(await shadowRuns()).toHaveLength(0);

    process.env[SHADOW_ENV] = AGENT_ID;
    const noModel = messageFor(org.id);
    noModel.agentOptions = {};
    await enqueueAgentTurnShadow(noModel, deps);
    expect(await shadowRuns()).toHaveLength(0);

    // A message with neither text nor a resolvable attachment: both providers
    // reject an empty user turn, so enqueueing one would only ever produce a
    // failed run. (An attachment-only message that DOES resolve is a real turn
    // — see the attachment tests below.)
    const noText = messageFor(org.id);
    noText.messageText = '   ';
    await enqueueAgentTurnShadow(noText, deps);
    expect(await shadowRuns()).toHaveLength(0);

    // Google speaks a protocol whose pi-ai adapter is not fetch-native, so it
    // cannot be bundled for the isolate and must not produce a shadow.
    await enqueueAgentTurnShadow(messageFor(org.id), {
      ...deps,
      catalog: catalogFor(claudeModule({ sdkCompat: 'google' })),
    });
    expect(await shadowRuns()).toHaveLength(0);

    // No public gateway URL means no URL a fleet worker could reach the proxy on.
    await enqueueAgentTurnShadow(messageFor(org.id), { ...deps, gatewayUrl: undefined });
    expect(await shadowRuns()).toHaveLength(0);

    // `*` selects every agent — the operator's blanket switch.
    process.env[SHADOW_ENV] = '*';
    await enqueueAgentTurnShadow(messageFor(org.id), deps);
    expect(await shadowRuns()).toHaveLength(1);
  });

  it("carries the message's image attachments as bytes and the rest as names", async () => {
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

    await enqueueAgentTurnShadow(message, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });

    const [run] = await shadowRuns();
    const turn = (run?.action_input as { turn: Record<string, unknown> }).turn;
    expect(turn.message_images).toEqual([
      { mime_type: 'image/png', data: Buffer.from('PNG!').toString('base64') },
    ]);
    expect(turn.message_files).toEqual([
      { name: 'report.pdf', mime_type: 'application/pdf', size: 2048 },
    ]);
    // No attachment URL is anywhere in the envelope the guest will be handed.
    expect(JSON.stringify(turn)).not.toContain('attacker.invalid');
  });

  it('enqueues an attachment-only message once its image resolves, and refuses one whose image does not', async () => {
    const org = await createTestOrganization();
    const withImage = messageFor(org.id);
    withImage.messageText = '';
    withImage.platformMetadata = {
      files: [{ id: 'art-image', name: 'shot.png', mimetype: 'image/png', size: 4 }],
    };

    await enqueueAgentTurnShadow(withImage, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });

    const [run] = await shadowRuns();
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
    await enqueueAgentTurnShadow(unresolvable, {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
      artifacts: fakeArtifacts(),
    });
    // Still just the first run: the unresolvable one names the file, so it DOES
    // enqueue — what must never enqueue is a message with nothing at all.
    expect(await shadowRuns()).toHaveLength(2);
    const second = (await shadowRuns())[1];
    const secondTurn = (second?.action_input as { turn: Record<string, unknown> }).turn;
    expect(secondTurn.message_images).toBeUndefined();
    expect(secondTurn.message_files).toEqual([{ name: 'shot.png', mime_type: 'image/png' }]);
  });

  it("puts the model's own modalities on the envelope, from pi-ai's registry", async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const [run] = await shadowRuns();
    const turn = (run?.action_input as { turn: { provider: { input?: string[] } } }).turn;
    // Whatever pi-ai says this model accepts — asserted as a non-empty list
    // that always contains text, because the registry's per-model answer is
    // pi-ai's to change, not this test's to pin.
    expect(turn.provider.input).toContain('text');
  });
});


describe('agent turn completion', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

  it('records the native session on the run row and is idempotent on a retry', async () => {
    const workerId = 'fleet-complete';
    const runId = await claimedShadowRun(workerId);

    const session_jsonl = nativeSession();
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'an observational copy',
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
    expect(row.output_tail).toBe('an observational copy');
    expect(row.error_message).toBe(null);
    // The turn envelope survives alongside the result, so the shadow stays
    // diffable against what the subprocess lane answered.
    expect(row.action_input.turn).toBeDefined();
    expect(row.action_input.result).toEqual({
      text: 'an observational copy',
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);
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
      expect(await response.json()).toMatchObject({ idempotent: true });
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
    const runId = await claimedShadowRun(workerId);

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
    const runId = await claimedShadowRun('fleet-claimant');

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: 'fleet-impostor',
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'not mine to report',
    });
    // Not this worker's run: reported as already-settled rather than applied.
    expect(await response.json()).toMatchObject({ idempotent: true });
    expect((await runRow(runId)).status).toBe('running');
  });

  it('an authoritative turn publishes the reply and persists its native session', async () => {
    const workerId = 'fleet-delivers';
    const runId = await claimedShadowRun(workerId);
    // Flip the run the way the cutover will: authoritative, with the reply
    // envelope the producer stamps beside the guest's turn.
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;

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
      messageId: 'msg-shadow',
      channelId: 'api_user-shadow',
      conversationId: 'conv-shadow',
      userId: 'user-shadow',
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
    ['oversize', nativeSession([{ type: 'message', id: 'x', parentId: null, message: { role: 'user', content: 'x'.repeat(4 * 1024 * 1024) } }])],
  ])('fails a %s snapshot visibly and preserves the previous session', async (_kind, session_jsonl) => {
    const workerId = 'fleet-invalid-snapshot';
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);
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
      VALUES (${run.organization_id}, ${AGENT_ID}, 'conv-shadow', ${prior.id}, ${previous}, ${Buffer.byteLength(previous)}, 'completed')
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
    expect(replies[0]).toMatchObject({ messageId: 'msg-shadow', error: result.error_message });
    expect(replies[0]).not.toHaveProperty('finalText');
  });

  it('a failed authoritative turn delivers the error instead of hanging the client', async () => {
    const workerId = 'fleet-delivers-error';
    const runId = await claimedShadowRun(workerId);
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;

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
    expect(reply.action_input).toMatchObject({ messageId: 'msg-shadow', error: 'the provider refused' });
    // A failed turn writes no transcript: there is no answer to remember.
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  /** Make a claimed turn authoritative, the way the cutover will. */
  async function makeAuthoritative(runId: number): Promise<void> {
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;
  }

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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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
      messageId: 'msg-shadow',
      channelId: 'api_user-shadow',
      conversationId: 'conv-shadow',
      userId: 'user-shadow',
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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

  it('does not stream a shadow turn, and refuses a delta from a worker that did not claim the run', async () => {
    const shadowWorker = 'fleet-shadow-stream';
    const shadowRunId = await claimedShadowRun(shadowWorker);
    // Left as a shadow: it exists to be compared, not to answer anyone.
    const shadowBeat = await postAsFleet('/api/workers/heartbeat', {
      run_id: shadowRunId,
      worker_id: shadowWorker,
      turn_delta: { text: 'an observational copy', sequence: 1 },
    });
    expect(shadowBeat.status).toBe(200);
    // Acknowledged as not-published, so the worker stops re-sending text that
    // by definition has nowhere to go.
    expect(await shadowBeat.json()).toMatchObject({
      turn_delta_ack: { sequence: 1, published: false },
    });

    const claimantRunId = await claimedShadowRun('fleet-claimant-stream');
    await makeAuthoritative(claimantRunId);
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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
      conversationId: 'conv-shadow',
      customEvent: {
        name: 'tool_use',
        // `input` is what the SPA renders as the tool row's args, as on the subprocess lane.
        data: { toolCallId: 'call-1', name: 'search_memory', input: { query: 'pricing' }, isError: false },
      },
    });
  });

  it('does not publish a tool trace for a shadow turn', async () => {
    const workerId = 'fleet-tool-shadow';
    const runId = await claimedShadowRun(workerId);
    const beat = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: workerId,
      turn_tool_events: [
        { tool_call_id: 'c1', name: 'bash', is_error: false, output: 'ok' },
      ],
    });
    expect(beat.status).toBe(200);
    expect(await threadResponses()).toEqual([]);
  });

  it('stamps repliedInBand so an in-band reply is not delivered twice', async () => {
    const workerId = 'fleet-in-band';
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);

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

  it('a shadow turn still delivers nothing', async () => {
    const workerId = 'fleet-shadow-silent';
    const runId = await claimedShadowRun(workerId);
    const sql = getTestDb();
    const [before] = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE queue_name = 'thread_response'
    `) as unknown as Array<{ n: number }>;

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      session_jsonl: nativeSession(),
      text: 'an observational copy',
    });
    expect(response.status).toBe(200);

    const [after] = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE queue_name = 'thread_response'
    `) as unknown as Array<{ n: number }>;
    expect(after.n).toBe(before.n);
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('refuses an authoritative turn that carries nowhere to deliver', async () => {
    const workerId = 'fleet-authoritative';
    const runId = await claimedShadowRun(workerId);
    // Authoritative, but with the reply envelope removed — the deploy-skew
    // shape where a newer producer marks turns authoritative and an older one
    // stamped no address. Completing it would transition the run and drop the
    // answer, leaving the client waiting forever, so it stays claimable.
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input =
        jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb) - 'reply'
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
    const runId = await claimedShadowRun(workerId);

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
 * The reaper's side of the same distinction: a fleet worker that crashes
 * mid-turn never reaches the completion route, so the run reaper is the only
 * thing left that can tell the client. An authoritative turn gets the error
 * the completion route would have published; a shadow turn ends silently.
 */
describe('agent turn reaper', () => {
  const STALE_THRESHOLD_SECONDS = 60;

  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

  /** Make the run authoritative, as the cutover will. */
  async function makeAuthoritative(runId: number) {
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;
  }

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
    const runId = await claimedShadowRun('fleet-crashed');
    await makeAuthoritative(runId);
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
      messageId: 'msg-shadow',
      channelId: 'api_user-shadow',
      conversationId: 'conv-shadow',
      userId: 'user-shadow',
      platform: 'api',
      error: AGENT_ERRORS[AgentErrorCode.WORKER_DIED].message,
      errorCode: AgentErrorCode.WORKER_DIED,
      processedMessageIds: ['msg-shadow'],
    });
    expect(replies[0].action_input.finalText).toBeUndefined();

    // A second tick finds nothing: the row is terminal, so no duplicate error.
    const again = await reapStaleRuns();
    expect(again.reaped).toBe(0);
    expect(await threadResponses()).toHaveLength(1);
  });

  it('a turn no worker ever claimed times out and tells the client it never started', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });
    const [run] = await shadowRuns();
    await makeAuthoritative(run.id);
    const sql = getTestDb();
    await sql`UPDATE runs SET created_at = now() - interval '1 hour' WHERE id = ${run.id}`;

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
      messageId: 'msg-shadow',
      errorCode: AgentErrorCode.WORKER_STARTUP_FAILED,
      error: AGENT_ERRORS[AgentErrorCode.WORKER_STARTUP_FAILED].message,
    });
  });

  it('a shadow turn times out silently, and a heartbeating turn is left alone', async () => {
    // Each claimed run is its own org and worker. A stale shadow next to a
    // fresh authoritative turn shows one sweep reaping the former silently
    // while leaving the latter untouched.
    const staleShadow = await claimedShadowRun('fleet-shadow-stale');
    await loseHeartbeat(staleShadow);
    const live = await claimedShadowRun('fleet-live');
    await makeAuthoritative(live);

    expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({
      reaped: 1,
      delivered: 0,
    });
    // The shadow run ends the way the bulk connector reaper ended it before,
    // but the subprocess lane still owns the conversation's reply, so nothing
    // reaches the client from here.
    const shadowRow = await runRow(staleShadow);
    expect(shadowRow.status).toBe('timeout');
    expect(shadowRow.error_message).toBe('worker_heartbeat_lost');
    expect(await threadResponses()).toHaveLength(0);
    // The live turn just claimed, so its heartbeat is fresh.
    expect((await runRow(live)).status).toBe('running');
  });

  it('an authoritative turn with no reply address terminalizes without delivering', async () => {
    // The deploy-skew case the completion route's 409 covers: a producer that
    // stamped an authoritative turn without saying where the reply goes. The
    // reaper has nowhere to deliver to, but the row must not wedge the lane.
    const runId = await claimedShadowRun('fleet-unaddressed');
    await makeAuthoritative(runId);
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
    const runId = await claimedShadowRun(workerId);
    await makeAuthoritative(runId);
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
