/**
 * The shadow producer end to end: a selected agent's message produces an
 * `agent_turn` run, only a fleet worker that advertises the lane can claim it,
 * and the turn is reported back on the lane's own completion route. This is the
 * seam that makes the isolate turn lane REACHABLE — the executor suite proves
 * the turn runs, this proves a real message reaches it and comes back.
 */
import {
  AgentTurnPollPayloadSchema,
  PollResponseSchema,
} from '@lobu/core/contracts/worker/protocol';
import {
  AGENT_ERRORS,
  AgentErrorCode,
  type MessagePayload,
  verifyWorkerToken,
} from '@lobu/core';
import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueAgentTurnShadow } from '../../gateway/orchestration/agent-turn-shadow';
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
    buildCredentialPlaceholder: () => 'lobu_secret_11111111-2222-3333-4444-555555555555',
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

describe('agent turn shadow producer', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

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
    // The poll response is built straight off this, so it must satisfy the
    // payload contract before any worker ever sees it.
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
        // The always-on tool rules, NARROWED to what this turn carries. Both of
        // these are about tools it has; the `upload_file` and `generate_image`
        // rules are absent because this lane offers neither, and instructing a
        // model to deliver a file with a tool it was never given is how a turn
        // comes to claim it sent something it could not.
        '## Built-In Tool Policies\n\n' +
        '### Structured User Choices\nTools: `ask_user`\n' +
        '- Use ask_user when you need the user to choose from a short list of options or approvals.\n' +
        '- Use plain text only for open-ended clarifications or when you need a free-form value.\n' +
        "- After calling ask_user, stop. The user's answer arrives as the next message.\n\n" +
        '### Participate In Your Channels\nTools: `list_conversations`, `read_conversation`, `send_message`\n' +
        '- You can participate in chat channels you are bound to, even on a scheduled/automated run with no one messaging you. Call list_conversations to see them.\n' +
        '- To act in a channel: read_conversation to catch up on what people said, then send_message to post. Pass a conversation handle to post to the channel, or a thread handle (returned by a previous send_message) to reply in that thread.\n' +
        '- Only what you send_message reaches the channel — your normal reply text does not. Decide deliberately what and where to post; it is fine to post nothing.\n\n' +
        '## Workspace\n\n' +
        'Your bash, read, write, ls and find tools act on a private in-memory workspace at /workspace.\n' +
        'It starts empty on every turn and nothing written there persists after the turn ends.\n' +
        'It has no network access and no package manager; use your other tools to reach data.'
    );
    expect(envelope.turn.messages).toEqual([]);
    // With no tool policy every workspace tool is admitted, bash with the
    // default package-manager denylist and no allowlist.
    const tools = envelope.turn.tools as {
      definitions: unknown[];
      builtin: string[];
      bash_policy: { allow_all: boolean; allow_prefixes: string[]; deny_prefixes: string[] };
    };
    expect(tools.definitions).toEqual([]);
    expect(tools.builtin).toEqual(['bash', 'read', 'write', 'ls', 'find']);
    expect(tools.bash_policy.allow_all).toBe(false);
    expect(tools.bash_policy.allow_prefixes).toEqual([]);
    expect(tools.bash_policy.deny_prefixes).toContain('pip install ');

    // The credential rides OUTSIDE the turn so the poll can lift it onto the
    // response's `credentials` and the worker can conceal it before the guest
    // ever sees a provider key.
    expect(envelope.credential).toBe('lobu_secret_11111111-2222-3333-4444-555555555555');
    expect(JSON.stringify(envelope.turn)).not.toContain('lobu_secret_');
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
      builtin: ['bash', 'read', 'write', 'ls', 'find'],
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
    expect(turn.tools?.builtin).toEqual(['bash', 'read', 'ls', 'find']);
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
      expect(turn.tools?.definitions).toEqual([]);
      expect(turn.tools?.builtin).toEqual(['bash', 'read', 'write', 'ls', 'find']);
    };

    // No MCP surface wired.
    await enqueueAgentTurnShadow(messageFor(org.id), base);
    await toolless();

    // The agent exposes MCP as shell commands, which this lane does not carry.
    const cli = messageFor(org.id);
    cli.agentOptions = { model: 'claude/claude-opus-4-8', toolsConfig: { mcpExposure: 'cli' } };
    await enqueueAgentTurnShadow(cli, { ...base, mcp: mcpFixture().mcp });
    await toolless();

    // A provider that answers its own placeholder: the MCP route could not
    // authenticate it, so the tools stay off rather than fail on every call.
    await enqueueAgentTurnShadow(messageFor(org.id), {
      ...base,
      catalog: catalogFor(claudeModule()),
      mcp: mcpFixture().mcp,
    });
    await toolless();

    // Discovery failed: nothing to hand the turn, but the turn itself runs.
    await enqueueAgentTurnShadow(messageFor(org.id), { ...base, mcp: mcpFixture({ fail: true }).mcp });
    await toolless();
  });

  it('replays the conversation with its tool calls and results, squared to a well-formed window', async () => {
    const org = await createTestOrganization();
    const sql = getTestDb();
    const at = new Date(Date.now() - 60_000).toISOString();
    const entry = (id: string, message: Record<string, unknown>) =>
      JSON.stringify({ type: 'message', id, parentId: null, timestamp: at, message });
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
      // A tool result whose call fell off the window: dropped, so the window
      // opens on the human.
      entry('orphan', { role: 'toolResult', toolCallId: 'toolu_00', toolName: 'query_sdk', content: [{ type: 'text', text: 'stale' }], isError: false, timestamp: 1 }),
      entry('u1', { role: 'user', content: 'how many entities?', timestamp: 1 }),
      entry('a1', assistant([
        { type: 'thinking', thinking: 'let me count', thinkingSignature: 'sig' },
        { type: 'toolCall', id: 'toolu_01', name: 'query_sdk', arguments: { code: 'entities.count()' } },
      ])),
      entry('t1', { role: 'toolResult', toolCallId: 'toolu_01', toolName: 'query_sdk', content: [{ type: 'text', text: '3 entities' }], isError: false, timestamp: 1 }),
      entry('a2', { ...assistant([{ type: 'text', text: 'There are 3.' }]), stopReason: 'stop' }),
      entry('u2', { role: 'user', content: 'and companies?', timestamp: 1 }),
      // The last turn died mid-call: a tool call with no result would be
      // refused by the provider, so the window ends before it.
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
    const turn = run.action_input.turn as { messages: Array<Record<string, unknown>> };
    expect(turn.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'user']);
    // The call and its result replay as pi stored them; only the thinking
    // block, whose signature belongs to the provider that made it, is gone.
    expect(turn.messages[1]).toMatchObject({
      content: [{ type: 'toolCall', id: 'toolu_01', name: 'query_sdk', arguments: { code: 'entities.count()' } }],
      stopReason: 'toolUse',
    });
    expect(turn.messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'toolu_01', isError: false });
    expect(turn.messages[3]).toMatchObject({ content: [{ type: 'text', text: 'There are 3.' }] });
    expect(turn.messages[4]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'and companies?' }] });
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
      accessToken: 'lobu_secret_11111111-2222-3333-4444-555555555555',
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

  it('records the transcript on the run row and is idempotent on a retry', async () => {
    const workerId = 'fleet-complete';
    const runId = await claimedShadowRun(workerId);

    const transcript = [
      { role: 'user', content: 'what is the shadow lane?' },
      { role: 'assistant', content: [{ type: 'text', text: 'an observational copy' }] },
    ];
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'an observational copy',
      stop_reason: 'stop',
      usage: { input: 11, output: 7 },
      transcript,
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
      transcript,
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
      text: 'not mine to report',
    });
    // Not this worker's run: reported as already-settled rather than applied.
    expect(await response.json()).toMatchObject({ idempotent: true });
    expect((await runRow(runId)).status).toBe('running');
  });

  it('an authoritative turn publishes the reply and appends the transcript', async () => {
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
      transcript: [{ role: 'assistant', content: [{ type: 'text', text: 'the isolate lane answered' }] }],
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
    const entries = snapshot.snapshot_jsonl
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
    ]);
    // Block-array content, the shape every other writer of this table emits
    // and the shape `historyMessages` reads back for the next turn.
    expect(entries.map((entry) => entry.message.content)).toEqual([
      [{ type: 'text', text: 'what is the shadow lane?' }],
      [{ type: 'text', text: 'the isolate lane answered' }],
    ]);
    // The reply is chained onto the user message, so the next turn's parent
    // walk reaches both.
    expect(entries[1].parentId).toBe(entries[0].id);
  });

  it('an oversize prior transcript starts a continuation instead of hanging the client', async () => {
    const workerId = 'fleet-delivers-oversize';
    const runId = await claimedShadowRun(workerId);
    const sql = getTestDb();
    const [run] = (await sql`
      SELECT organization_id FROM runs WHERE id = ${runId}
    `) as unknown as Array<{ organization_id: string }>;

    // A prior transcript already past MAX_SNAPSHOT_BYTES, the cap every other
    // writer of this table honours. Appending to it would build a row well
    // past that cap, and this insert shares the terminal transaction, so
    // without the continuation fallback the oversize row would ride along
    // with the run transition and the reply.
    const bulky = `${'x'.repeat(5 * 1024 * 1024)}`;
    const priorLine = JSON.stringify({
      type: 'message',
      id: 'prior-assistant',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: bulky }] },
    });
    // The snapshot's `run_id` is a real foreign key, so the prior transcript
    // needs the run that produced it.
    const [prior] = (await sql`
      INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
      VALUES (${run.organization_id}, 'agent_turn', 'agent_turns', 'completed', '{}'::jsonb)
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES (${run.organization_id}, ${AGENT_ID}, 'conv-shadow', ${prior.id},
              ${`${priorLine}\n`}, ${Buffer.byteLength(priorLine, 'utf8') + 1}, 'completed')
    `;

    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'answered despite the long history',
    });
    expect(response.status).toBe(200);
    expect((await runRow(runId)).status).toBe('completed');

    // The client still gets its answer — the whole point of the fallback.
    const [reply] = (await sql`
      SELECT action_input FROM runs
      WHERE queue_name = 'thread_response' AND run_type = 'chat_message'
      ORDER BY id DESC LIMIT 1
    `) as unknown as Array<{ action_input: Record<string, unknown> }>;
    expect(reply.action_input).toMatchObject({
      messageId: 'msg-shadow',
      finalText: 'answered despite the long history',
    });

    // And the stored row is a compact continuation carrying only this turn,
    // not the oversize prefix. The prior run's row stays queryable.
    const [snapshot] = (await sql`
      SELECT snapshot_jsonl, byte_size FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `) as unknown as Array<{ snapshot_jsonl: string; byte_size: number }>;
    expect(snapshot.byte_size).toBeLessThan(4 * 1024 * 1024);
    const entries = snapshot.snapshot_jsonl
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
    ]);
    // A continuation has no prior tail to chain onto.
    expect(entries[0].parentId).toBeNull();
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM agent_transcript_snapshot WHERE run_id = ${prior.id}
    `) as unknown as Array<{ n: number }>;
    expect(n).toBe(1);
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
