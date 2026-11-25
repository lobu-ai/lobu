/**
 * End-to-end guardrails-runtime test against the actual wired call sites.
 *
 * Each block constructs the real service (ChatResponseBridge / MessageConsumer
 * / McpProxy), or drives Lobu's own `/mcp` endpoint for the inbound pre-tool
 * stage, wires the same registry the production gateway uses, seeds
 * the workspace guardrail library (`resolveGuardrails` decides what runs for
 * the agent), and drives the public method that handles the corresponding
 * stage. Assertions cover:
 *
 *   - the block message is delivered (chat target / queue / JSON-RPC reply)
 *   - the `events` row lands with `semantic_type='guardrail-trip'`
 *   - the rolling output buffer catches secrets split across stream chunks
 *   - the audit org id comes from the required, authoritative payload identity
 *
 * Tests use `flushPendingGuardrailAudits()` (the production hook) instead of
 * a sleep — fire-and-forget audit writes are explicitly awaitable.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateWorkerToken, GuardrailRegistry, MCP_PROTOCOL_VERSION, mintGatewayMcpToken } from '@lobu/core';
import { deriveAppPrincipalId } from '../auth/app-principal';
import { AgentSettingsStore } from '../gateway/auth/settings/agent-settings-store';
import { McpProxy } from '../gateway/auth/mcp/proxy';
import { ApiResponseRenderer } from '../gateway/api/response-renderer';
import { ChatResponseBridge } from '../gateway/connections/chat-response-bridge';
import { UnifiedThreadResponseConsumer } from '../gateway/platform/unified-thread-consumer';
import {
  flushPendingGuardrailAudits,
} from '../gateway/guardrails/audit';
import { registerBuiltinGuardrails } from '../gateway/guardrails/builtins';
import { GatewayJudgeClient } from '../gateway/proxy/egress-judge/gateway-judge-client';
import { MessageConsumer } from '../gateway/orchestration/message-consumer';
import type {
  DeploymentManager,
} from '../gateway/orchestration/deployment-manager';
import * as gateway from '../lobu/gateway';
import { orgContext } from '../lobu/stores/org-context';
import { createPostgresAgentConfigStore } from '../lobu/stores/postgres-stores';
import { initWorkspaceProvider } from '../workspace';
import { cleanupTestDatabase, getTestDb } from './setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestAgent,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  createTestWorkspaceGuardrail,
  seedSystemEntityTypes,
} from './setup/test-fixtures';
import { post } from './setup/test-helpers';
import { createAuthProfile } from '../utils/auth-profiles';
import { ensureMemberEntityType } from '../utils/member-entity-type';

// Stub the judge transport so custom judge guardrails resolve to a
// deterministic verdict instead of reaching a provider. The shared TextJudge
// is a module singleton and the server suites share one module graph
// (`isolate: false`), so an earlier file may already have built it with a
// real GatewayJudgeClient; stubbing the prototype covers that instance too.
// Built-in guardrails (the other describe blocks) don't use a judge.
const judgeStub = vi
  .spyOn(GatewayJudgeClient.prototype, 'judge')
  .mockResolvedValue({ verdict: 'deny', reason: 'stub judge denied' });
afterAll(() => judgeStub.mockRestore());

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

interface PostedMessage {
  text?: string;
  iterableChunks?: string[];
}

/**
 * Mock chat target that captures `post(string)` and `post(asyncIterable)`
 * separately so the test can distinguish a streaming chunk from the
 * out-of-band block message.
 */
function createCapturingTarget() {
  const posted: PostedMessage[] = [];
  const target = {
    post: async (arg: unknown) => {
      if (typeof arg === 'string') {
        posted.push({ text: arg });
        return { id: 'msg' };
      }
      if (arg && typeof (arg as any)[Symbol.asyncIterator] === 'function') {
        const chunks: string[] = [];
        for await (const chunk of arg as AsyncIterable<string>) {
          chunks.push(chunk);
        }
        posted.push({ iterableChunks: chunks });
        return { id: 'msg-stream' };
      }
      posted.push({});
      return { id: 'msg-other' };
    },
    startTyping: async () => {},
  };
  return { target, posted };
}

function createManager(target: unknown, agentId: string, orgId: string) {
  return {
    getInstance: () => ({
      connection: {
        agentId,
        organizationId: orgId,
        platform: 'telegram',
      },
      chat: {
        channel: () => target,
        getAdapter: () => undefined,
      },
      conversationState: undefined,
    }),
    has: () => true,
  };
}

async function fetchGuardrailEvents(orgId: string, stage: string) {
  const db = getTestDb();
  return db<{
    id: number;
    semantic_type: string;
    origin_type: string | null;
    title: string;
    metadata: any;
  }[]>`
    SELECT id, semantic_type, origin_type, title, metadata
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'guardrail-trip'
      AND origin_type = ${`guardrail-${stage}`}
    ORDER BY id DESC
  `;
}

async function createQueuedMessageRun(orgId: string): Promise<string> {
  const db = getTestDb();
  const [run] = await db<{ id: number }[]>`
    INSERT INTO public.runs (organization_id, run_type, queue_name, status)
    VALUES (${orgId}, 'chat_message', 'messages', 'claimed')
    RETURNING id
  `;
  if (!run) throw new Error('Failed to create queued message run');
  return String(run.id);
}

// ─────────────────────────────────────────────────────────────────────────
// ChatResponseBridge (output stage)
// ─────────────────────────────────────────────────────────────────────────

describe('ChatResponseBridge — wired output guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails Output Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    await createTestWorkspaceGuardrail({
      organizationId: orgId,
      name: 'secret-scan',
      config: { builtin: 'secret-scan' },
      appliesTo: [{ kind: 'agent', id: agentId }],
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('withholds streaming deltas and blocks the secret at completion, posts the block message, audits the trip', async () => {
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId);
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: {
        connectionId: 'conn-1',
        chatId: '123',
        // agentId/organizationId omitted on purpose — connection fallback.
      },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      // Streaming deltas are WITHHELD for guardrail agents — nothing posts here.
      await bridge.handleDelta(
        { ...payload, delta: 'here is sk-abcdefghij0123456789AB please' },
        'session-1'
      );
      expect(posted.length).toBe(0);

      // The full authoritative finalText is scanned at completion and blocked.
      await bridge.handleCompletion(
        {
          ...payload,
          finalText: 'here is sk-abcdefghij0123456789AB please',
          processedMessageIds: ['m1'],
        } as any,
        'session-1'
      );
    });

    // Only the block message reaches the channel — never the secret.
    expect(
      posted.some((p) => p.text?.includes('Message blocked by guardrail'))
    ).toBe(true);
    expect(
      posted.some((p) => p.text?.includes('sk-abcdefghij0123456789AB'))
    ).toBe(false);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
    expect(rows[0]!.metadata.stage).toBe('output');
    expect(rows[0]!.metadata.agent_id).toBe(agentId);
    expect(rows[0]!.metadata.conversation_id).toBe('123');
  });

  it('audits the trip even when platformMetadata.organizationId is missing (connection fallback)', async () => {
    const { target } = createCapturingTarget();
    // Build a manager whose connection carries the org id — this is the
    // canonical fallback for response-bridge audits.
    const manager = {
      getInstance: () => ({
        connection: {
          agentId,
          organizationId: orgId,
          platform: 'telegram',
        },
        chat: {
          channel: () => target,
          getAdapter: () => undefined,
        },
      }),
      has: () => true,
    };
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      // No organizationId in metadata — bridge must resolve via the connection.
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleCompletion(
        {
          ...payload,
          finalText: 'token AKIAIOSFODNN7EXAMPLE leaked',
          processedMessageIds: ['m1'],
        } as any,
        's'
      );
    });

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });

  it('scans payload.finalText at completion for a post-once (Slack) reply with no local stream (cross-replica)', async () => {
    // Under N>1 replicas the terminal row can be claimed by a pod that never
    // saw the delta rows, so the per-delta scan never ran here. The Slack
    // completion path delivers payload.finalText, so it must be scanned at
    // completion or a secret would post unguarded. No handleDelta is called —
    // this mirrors the cross-pod terminal-only delivery.
    const { target, posted } = createCapturingTarget();
    const slackPostMessage = vi.fn(async () => ({ ok: true, ts: '1.1' }));
    const manager = {
      getInstance: () => ({
        connection: { agentId, organizationId: orgId, platform: 'slack' },
        chat: {
          channel: () => target,
          getAdapter: (name: string) =>
            name === 'slack'
              ? { client: { chat: { postMessage: slackPostMessage } } }
              : undefined,
        },
        conversationState: undefined,
      }),
      has: () => true,
    };
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry);

    const payload = {
      messageId: 'm1',
      channelId: 'slack:C123',
      conversationId: 'slack:C123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'slack',
      platformMetadata: { connectionId: 'conn-1', chatId: 'slack:C123' },
      finalText: 'here is sk-abcdefghij0123456789AB please',
      processedMessageIds: ['m1'],
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleCompletion(payload, 's');
    });

    // The secret must NOT reach Slack; only the block message is posted.
    expect(slackPostMessage).not.toHaveBeenCalled();
    expect(posted).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Message blocked by guardrail'),
      }),
    ]);
    expect(posted[0]?.text).toMatch(/openai-key/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });

  it('scans finalText at completion for a LIVE-STREAMING (telegram) reply — catches a secret longer than the per-delta window', async () => {
    // Regression: the completion full-text scan was gated on
    // `deliversAtCompletion`, so live-streaming platforms (telegram) only had
    // the bounded per-delta window. A secret LONGER than that window trips no
    // per-delta scan and previously landed in history unscanned. The completion
    // scan now runs for every strategy.
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId); // telegram = live-streaming
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry);

    // A JWT well over the 512-char per-delta window — only the full-text
    // completion scan can see it whole. No handleDelta is called.
    const longJwt = `eyJhbGciOiJSUzI1NiJ9.eyJ${'A'.repeat(900)}.${'S'.repeat(342)}`;
    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
      finalText: `your token is ${longJwt}`,
      processedMessageIds: ['m1'],
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleCompletion(payload as any, 's');
    });

    const blockPost = posted.find((p) =>
      p.text?.startsWith('Message blocked by guardrail')
    );
    expect(blockPost).toBeDefined();
    expect(blockPost!.text).toMatch(/jwt/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });

  // Finding 2 (grok [medium]) — FIXED: the per-stream state machine
  // (blockedStreams/guardrailTails) that leaked across turns is gone. A turn
  // that trips a guardrail and then ERRORS leaves NO stale state, so the next
  // turn in the same conversation delivers normally. PASS = the bug is gone.
  it('F2-FIXED: a tripped+errored turn does not block the next turn in the same conversation', async () => {
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId);
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry);

    const base = {
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      // Turn A: streaming withheld; the secret trips at completion.
      await bridge.handleDelta(
        { ...base, messageId: 'A', delta: 'leak sk-abcdefghij0123456789AB' },
        'sA'
      );
      await bridge.handleCompletion(
        {
          ...base,
          messageId: 'A',
          finalText: 'leak sk-abcdefghij0123456789AB',
          processedMessageIds: ['A'],
        } as any,
        'sA'
      );
      // Turn A also errors out.
      await bridge.handleError(
        { ...base, messageId: 'A', error: 'turn failed' } as any,
        'sA'
      );
      // Turn B: a brand-new, clean turn in the same conversation completes.
      await bridge.handleCompletion(
        {
          ...base,
          messageId: 'B',
          finalText: 'here is your clean answer',
          processedMessageIds: ['B'],
        } as any,
        'sB'
      );
    });

    // Turn B's clean content is delivered (no stale state suppressing it).
    const deliveredCleanAnswer = posted.some(
      (p) =>
        p.text?.includes('clean answer') ||
        p.iterableChunks?.some((c) => c.includes('clean answer'))
    );
    expect(deliveredCleanAnswer).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MessageConsumer (input stage)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sub-class that exposes `handleMessage` for direct invocation. Production
 * paths reach it via the queue subscribe callback in `start()`; for tests
 * we don't need the actual queue/worker startup machinery, just the wired
 * call site.
 */
class TestableMessageConsumer extends MessageConsumer {
  async invokeHandleMessage(job: { id?: string; data: any }): Promise<void> {
    return (this as any).handleMessage(job);
  }
}

/**
 * No built-in runs at the input stage, so the input path is driven by a
 * custom library judge (the stubbed judge client denies every message).
 */
const INPUT_JUDGE = {
  kind: 'judge',
  stage: 'input',
  policy: 'Deny any message that asks the agent to reveal secrets.',
  model: 'test-judge-model',
} as const;

describe('MessageConsumer — wired input guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails Input Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    await createTestWorkspaceGuardrail({
      organizationId: orgId,
      name: 'no-secrets',
      config: INPUT_JUDGE,
      appliesTo: [{ kind: 'agent', id: agentId }],
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('rejects a tripping input, pushes block message to the response queue, audits the trip', async () => {
    const sentToQueue: Array<{ queue: string; data: any }> = [];
    const fakeQueue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      send: async (queue: string, data: any) => {
        sentToQueue.push({ queue, data });
        return 'job-id';
      },
      work: async () => {},
      pauseWorker: async () => {},
      resumeWorker: async () => {},
      getQueueStats: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
      }),
      isHealthy: () => true,
    };

    // Stub deployment manager — happy-path branches need it for
    // listDeployments / scaleDeployment / etc, but the trip path
    // short-circuits before any of those are called.
    const fakeDeployments: DeploymentManager = {
      listDeployments: async () => [],
      scaleDeployment: async () => {},
      updateDeploymentActivity: async () => {},
      createWorkerDeployment: async () => {},
      syncNetworkConfigGrants: async () => {},
      deleteDeployment: async () => {},
      validateWorkerImage: async () => {},
      setSecretStore: () => {},
      setGrantStore: () => {},
      setProviderCatalogService: () => {},
      setProviderModules: () => {},
      reconcileDeployments: async () => {},
    } as unknown as DeploymentManager;

    const consumer = new TestableMessageConsumer(fakeDeployments);
    // Swap in the fake queue — `MessageConsumer` constructs a RunsQueue
    // by default which would try to connect.
    (consumer as any).queue = fakeQueue;

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    consumer.setGuardrails(registry, settingsStore);

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.invokeHandleMessage({
        id: '1',
        data: {
          userId: 'u1',
          conversationId: 'conv-1',
          messageId: 'm1',
          channelId: 'c1',
          teamId: 't1',
          agentId,
          organizationId: orgId,
          botId: 'bot',
          platform: 'telegram',
          messageText: 'hello SECRET world',
          platformMetadata: {},
          agentOptions: {},
        },
      });
    });

    // The trip path must NOT enqueue to the worker thread queue and MUST
    // enqueue a single thread_response with the rejection. The notice rides the
    // `error` field (not `content`): routeToRenderer has no plain-`content`
    // branch, so a `content`-only payload is dropped — `error` renders
    // end-to-end (SSE error event + CLI exit 1; platforms post `Error: …`).
    const threadResponses = sentToQueue.filter(
      (q) => q.queue === 'thread_response'
    );
    const workerEnqueues = sentToQueue.filter((q) =>
      q.queue.startsWith('thread_message_')
    );
    expect(workerEnqueues.length).toBe(0);
    expect(threadResponses.length).toBe(1);
    expect(threadResponses[0]!.data.error).toMatch(/Message rejected:/);
    expect(threadResponses[0]!.data.error).toMatch(/stub judge denied/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'input');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('no-secrets');
  });

  it('audits with the required payload organization when platform metadata omits it', async () => {
    const sentToQueue: Array<{ queue: string; data: any }> = [];
    const fakeQueue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      send: async (queue: string, data: any) => {
        sentToQueue.push({ queue, data });
        return 'job-id';
      },
      work: async () => {},
      pauseWorker: async () => {},
      resumeWorker: async () => {},
      getQueueStats: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
      }),
      isHealthy: () => true,
    };
    const fakeDeployments = {
      listDeployments: async () => [],
    } as unknown as DeploymentManager;

    const consumer = new TestableMessageConsumer(fakeDeployments);
    (consumer as any).queue = fakeQueue;

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    consumer.setGuardrails(registry, settingsStore);

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.invokeHandleMessage({
        id: '1',
        data: {
          userId: 'u1',
          conversationId: 'conv-1',
          messageId: 'm1',
          channelId: 'c1',
          teamId: 't1',
          agentId,
          organizationId: orgId,
          botId: 'bot',
          platform: 'telegram',
          messageText: 'leaking SECRET data',
          platformMetadata: {},
          agentOptions: {},
        },
      });
    });

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'input');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('no-secrets');
  });

  it.each([
    ['is disabled', 'disable'],
    ['applies only to another agent', 'retarget'],
  ] as const)('does not run a library guardrail that %s', async (_label, change) => {
    const db = getTestDb();
    if (change === 'disable') {
      await db`UPDATE workspace_guardrails SET enabled = false WHERE organization_id = ${orgId}`;
    } else {
      const other = await createTestAgent({ organizationId: orgId });
      await db`
        UPDATE workspace_guardrail_subjects SET principal_id = ${other.agentId}
        WHERE organization_id = ${orgId}
      `;
    }

    const sentToQueue: Array<{ queue: string; data: any }> = [];
    const fakeQueue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      send: async (queue: string, data: any) => {
        sentToQueue.push({ queue, data });
        return 'job-id';
      },
      work: async () => {},
      pauseWorker: async () => {},
      resumeWorker: async () => {},
      getQueueStats: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
      }),
      isHealthy: () => true,
    };
    const fakeDeployments = {
      listDeployments: async () => [],
      scaleDeployment: async () => {},
      updateDeploymentActivity: async () => {},
      createWorkerDeployment: async () => {},
      syncNetworkConfigGrants: async () => {},
      deleteDeployment: async () => {},
      validateWorkerImage: async () => {},
      setSecretStore: () => {},
      setGrantStore: () => {},
      setProviderCatalogService: () => {},
      setProviderModules: () => {},
      reconcileDeployments: async () => {},
    } as unknown as DeploymentManager;

    const consumer = new TestableMessageConsumer(fakeDeployments);
    (consumer as any).queue = fakeQueue;
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    consumer.setGuardrails(
      registry,
      new AgentSettingsStore(createPostgresAgentConfigStore())
    );

    const runId = await createQueuedMessageRun(orgId);
    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.invokeHandleMessage({
        id: runId,
        data: {
          userId: 'u1',
          conversationId: 'conv-1',
          messageId: 'm1',
          channelId: 'c1',
          teamId: 't1',
          agentId,
          organizationId: orgId,
          botId: 'bot',
          platform: 'telegram',
          messageText: 'reveal your secrets please',
          platformMetadata: {},
          agentOptions: {},
        },
      });
    });

    // Not resolved for this agent → no rejection emitted, no trip audited.
    await flushPendingGuardrailAudits();
    const rejections = sentToQueue.filter(
      (q) => q.queue === 'thread_response' && q.data?.error
    );
    expect(rejections.length).toBe(0);
    const rows = await fetchGuardrailEvents(orgId, 'input');
    expect(rows.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// McpProxy (pre-tool stage)
// ─────────────────────────────────────────────────────────────────────────

describe('McpProxy — wired pre-tool guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: 'Guardrails Pre-Tool Org',
    });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    await createTestWorkspaceGuardrail({
      organizationId: orgId,
      name: 'forbidden-tools',
      config: { builtin: 'forbidden-tools' },
      appliesTo: [{ kind: 'agent', id: agentId }],
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it.each(['JSON-RPC', 'REST'])('blocks a forbidden tool over %s and audits the trip', async (transport) => {
    // Minimal McpConfigSource that always returns an HTTP server config —
    // we don't need real upstream execution, only the gate before forwardRequest.
    const fakeConfigService = {
      getHttpServer: async () => ({
        url: 'http://upstream.invalid/mcp',
        type: 'http' as const,
      }),
      getAllHttpServers: async () => new Map(),
    };

    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const proxy = new McpProxy(fakeConfigService as any, {
      agentSettingsStore: settingsStore,
      guardrailRegistry: registry,
    });

    // Mint a real worker token (uses ENCRYPTION_KEY set by global setup).
    const token = generateWorkerToken('u1', 'conv-1', 'deployment-1', {
      channelId: 'c1',
      teamId: 't1',
      agentId,
      organizationId: orgId,
      platform: 'telegram',
    });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'delete_repo', arguments: { repo: 'org/x' } },
    });

    const response = await orgContext.run(
      { organizationId: orgId },
      async () => {
        return proxy.getApp().fetch(
          new Request(transport === 'REST' ? 'http://localhost/test-mcp/tools/delete_repo' : 'http://localhost/test-mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: transport === 'REST' ? JSON.stringify({ repo: 'org/x' }) : body,
          })
        );
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    if (transport === 'JSON-RPC') {
      expect(json.jsonrpc).toBe('2.0');
      expect(json.id).toBe(42);
    }
    const result = transport === 'REST' ? json : json.result;
    expect(result.isError).toBe(true);
    // Generic text — no reason leak.
    expect(result.content[0].text).toBe('Tool call blocked by policy.');
    expect(result.content[0].text).not.toMatch(/delete_repo/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'pre-tool');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('forbidden-tools');
    // Reason is recorded in the audit row even though it's not surfaced
    // to the worker — operators need it.
    expect(rows[0]!.metadata.reason).toMatch(/delete_repo/);
  });

  it('rejects a JSON-RPC BATCH wrapping a forbidden tools/call instead of forwarding it unguarded', async () => {
    // Regression: the pre-tool gate only fired when `jsonRpc.method` was
    // "tools/call". A top-level JSON-RPC array (batch) has `method` undefined,
    // so the whole guardrail + approval block was skipped and the raw batch was
    // forwarded verbatim — a spec-compliant upstream then executes the batched
    // tool call with zero enforcement. The fix rejects any batch containing a
    // tools/call at the proxy (-32600) rather than forwarding it.
    const fakeConfigService = {
      // Unresolvable upstream: if the batch were ever forwarded (pre-fix) the
      // fetch would fail with -32603 "Failed to connect", NOT our -32600. So a
      // -32600 invalid-request response proves the gate rejected it pre-forward.
      getHttpServer: async () => ({
        url: 'http://upstream.invalid/mcp',
        type: 'http' as const,
      }),
      getAllHttpServers: async () => new Map(),
    };

    const settingsStore = new AgentSettingsStore(
      createPostgresAgentConfigStore()
    );

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const proxy = new McpProxy(fakeConfigService as any, {
      agentSettingsStore: settingsStore,
      guardrailRegistry: registry,
    });

    const token = generateWorkerToken('u1', 'conv-1', 'deployment-1', {
      channelId: 'c1',
      teamId: 't1',
      agentId,
      organizationId: orgId,
      platform: 'telegram',
    });

    // Top-level ARRAY (JSON-RPC batch) wrapping the forbidden tool call.
    const body = JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'delete_repo', arguments: { repo: 'org/x' } },
      },
    ]);

    const response = await orgContext.run(
      { organizationId: orgId },
      async () => {
        return proxy.getApp().fetch(
          new Request('http://localhost/test-mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body,
          })
        );
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.jsonrpc).toBe('2.0');
    // Rejected at the proxy with an invalid-request error — NOT forwarded.
    expect(json.error?.code).toBe(-32600);
    expect(json.error?.message).toMatch(/Batched tools\/call is not permitted/);
    // The forbidden call never reached an upstream, so no -32603 connect error.
    expect(json.error?.message).not.toMatch(/Failed to connect/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// UnifiedThreadResponseConsumer → ApiResponseRenderer (output stage)
//
// Regression: output guardrails were wired ONLY into ChatResponseBridge, so
// pure API/SSE rows (web SPA + programmatic Agent API) — which route through
// ApiResponseRenderer — streamed secrets/PII to the client uninspected and
// never wrote a guardrail-trip event. These tests drive the real consumer +
// real ApiResponseRenderer over an API row and assert the secret is blocked.
// ─────────────────────────────────────────────────────────────────────────

describe('UnifiedThreadResponseConsumer — wired output guardrail (API path)', () => {
  let orgId: string;
  let agentId: string;

  /** Capturing SSE manager: records every broadcast, owns every session. */
  function createCapturingSse() {
    const events: Array<{ sessionId: string; event: string; payload: any }> =
      [];
    const sse = {
      broadcast: (sessionId: string, event: string, payload: any) => {
        events.push({ sessionId, event, payload });
      },
      hasActiveConnection: () => true,
    };
    return { sse, events };
  }

  function createConsumer(sse: unknown) {
    const renderer = new ApiResponseRenderer(sse as any);
    const queue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      work: async () => {},
      send: async () => 'job-id',
    };
    const platformRegistry = {
      get: () => ({ getResponseRenderer: () => renderer }),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sse as any
    ) as any;
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    consumer.setOutputGuardrails(registry);
    return consumer;
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails API Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    await createTestWorkspaceGuardrail({
      organizationId: orgId,
      name: 'secret-scan',
      config: { builtin: 'secret-scan' },
      appliesTo: [{ kind: 'agent', id: agentId }],
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  // Finding 1 (grok [medium]) — FIXED: a secret in an ERROR row's `data.error`
  // is now scanned (the terminal branch scans `finalText ?? error`) and replaced
  // with the block notice before broadcast.
  it('F1-FIXED: a secret in data.error is scanned and blocked, not broadcast', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      error: 'upstream error: token sk-abcdefghij0123456789AB leaked',
      platformMetadata: { agentId, organizationId: orgId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    const errEvt = events.find(
      (e) => e.event === 'error' || e.event === 'agent-error'
    );
    expect(errEvt).toBeDefined();
    // The secret must NOT be in the broadcast; the block notice replaces it.
    expect(JSON.stringify(errEvt!.payload)).not.toContain(
      'sk-abcdefghij0123456789AB'
    );
    expect(JSON.stringify(errEvt!.payload)).toContain(
      'Message blocked by guardrail'
    );
  });

  // VERIFY Finding 3 (grok [low]): when platformMetadata omits organizationId
  // (as the agent-threads/messaging-api dispatch paths do), a trip still BLOCKS
  // but writes NO audit row. PASS = the audit gap is real.
  it('VERIFY-F3: a trip with no organizationId blocks but drops the audit row', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      processedMessageIds: ['m1'],
      finalText: 'your key is sk-abcdefghij0123456789AB',
      // organizationId intentionally ABSENT (mirrors the internal dispatch paths)
      platformMetadata: { agentId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    // Block still works.
    const complete = events.find((e) => e.event === 'complete');
    expect(complete!.payload.finalText).toContain('Message blocked by guardrail');

    // But no audit row lands (org unresolvable).
    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(0);
  });

  it('blocks a secret in the terminal finalText, broadcasts the block message instead, audits the trip', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      processedMessageIds: ['m1'],
      finalText: 'your key is sk-abcdefghij0123456789AB please',
      platformMetadata: { agentId, organizationId: orgId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    const complete = events.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    // The SPA repairs its message from finalText on `complete` — it must be the
    // block notice, NOT the leaked secret.
    expect(complete!.payload.finalText).toContain(
      'Message blocked by guardrail'
    );
    expect(complete!.payload.finalText).not.toContain(
      'sk-abcdefghij0123456789AB'
    );

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
    expect(rows[0]!.metadata.stage).toBe('output');
    expect(rows[0]!.metadata.agent_id).toBe(agentId);
  });

  it('withholds ALL streaming deltas for a guardrail-enabled agent (cross-pod split-secret cannot leak)', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    // Even a delta that LOOKS clean is withheld — a secret could be split across
    // deltas claimed on different replicas, which no per-pod scan would catch.
    // The scanned finalText is delivered at completion instead.
    for (const delta of ['here it is ', 'sk-abcdefghij', '0123456789AB done']) {
      await orgContext.run({ organizationId: orgId }, async () => {
        await consumer.handleThreadResponse({
          id: '1',
          data: {
            messageId: 'm1',
            channelId: 'api:conv-1',
            conversationId: 'conv-1',
            originalMessageId: 'm1',
            userId: 'u1',
            teamId: 'api',
            platform: 'api',
            timestamp: 0,
            delta,
            platformMetadata: { agentId, organizationId: orgId },
          },
        });
      });
    }

    // No delta reaches the client as an `output` event.
    expect(events.filter((e) => e.event === 'output').length).toBe(0);
  });

  it('streams deltas normally for an agent with NO output guardrails', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    // A separate agent with no guardrails configured — streaming is unaffected.
    const plain = await createTestAgent({ organizationId: orgId });

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({
        id: '1',
        data: {
          messageId: 'm2',
          channelId: 'api:conv-2',
          conversationId: 'conv-2',
          originalMessageId: 'm2',
          userId: 'u1',
          teamId: 'api',
          platform: 'api',
          timestamp: 0,
          delta: 'streaming token',
          platformMetadata: { agentId: plain.agentId, organizationId: orgId },
        },
      });
    });

    const outputs = events.filter((e) => e.event === 'output');
    expect(outputs.length).toBe(1);
    expect(outputs[0]!.payload.content).toBe('streaming token');
  });

  it('passes a clean finalText through unchanged (no false block)', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      processedMessageIds: ['m1'],
      finalText: 'here is a perfectly normal reply with no secrets',
      platformMetadata: { agentId, organizationId: orgId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    const complete = events.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.payload.finalText).toBe(
      'here is a perfectly normal reply with no secrets'
    );

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reset for global test isolation
// ─────────────────────────────────────────────────────────────────────────

afterEach(async () => {
  // Drain anything still in flight so it doesn't leak into the next test.
  await flushPendingGuardrailAudits();
});

// ─────────────────────────────────────────────────────────────────────────
// Inbound: a connected app calling Lobu's own MCP server
// ─────────────────────────────────────────────────────────────────────────

/** A pre-tool library judge; the stubbed judge client denies every call it sees. */
const PRE_TOOL_JUDGE = {
  kind: 'judge',
  stage: 'pre-tool',
  policy: 'Deny inbound probe calls (inbound-policy-body).',
  model: 'test-judge-model',
} as const;

/** A hosted web app's OAuth client, and the app key its tokens act as. */
async function hostedApp(host: string) {
  const redirectUri = `https://${host}/oauth/callback`;
  const clientName = `${host} app`;
  const client = await createTestOAuthClient({ redirect_uris: [redirectUri], client_name: clientName });
  const appKey = deriveAppPrincipalId({
    kind: 'oauth',
    clientId: client.client_id,
    clientName,
    authorizationGrantType: 'authorization_code',
    redirectUris: [redirectUri],
  });
  return { clientId: client.client_id, appKey };
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: { rows?: unknown[] };
}

/**
 * Open a session on the real `/mcp` transport, announcing `clientName` in
 * `initialize`, and return a `tools/call` function bound to it.
 */
async function openMcpSession(
  path: string,
  token: string,
  options: { clientName?: string; headers?: Record<string, string> } = {}
) {
  const headers = options.headers ?? {};
  const init = await post(path, {
    body: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: options.clientName ?? 'lobu-test', version: '1.0' },
      },
    },
    token,
    headers,
  });
  const initBody = await init.json();
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`initialize returned no session: ${JSON.stringify(initBody)}`);
  const sessionHeaders = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_PROTOCOL_VERSION };
  await post(path, { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, token, headers: sessionHeaders });
  return async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    const response = await post(path, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      token,
      headers: { ...sessionHeaders, 'X-MCP-Format': 'json' },
    });
    const json = await response.json();
    expect(json.error, JSON.stringify(json.error)).toBeUndefined();
    return json.result as ToolCallResult;
  };
}

const PROBE = { title: 'Inbound probe', sql: 'SELECT 7 AS value' };

function expectRan(result: ToolCallResult) {
  expect(result.isError, result.content?.[0]?.text).toBeFalsy();
  expect(result.structuredContent?.rows).toEqual([{ value: 7 }]);
}

function expectBlocked(result: ToolCallResult) {
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Tool call blocked by policy.');
  // The judge's reason and the guardrail's policy are never echoed.
  expect(result.content[0]!.text).not.toMatch(/stub judge denied|inbound-policy-body/);
}

describe("Inbound MCP — app-targeted pre-tool guardrails on Lobu's own tools", () => {
  const registry = new GuardrailRegistry();
  registerBuiltinGuardrails(registry);
  let services: ReturnType<typeof vi.spyOn>;
  let userId: string;
  let orgA: { id: string; slug: string };
  let orgB: { id: string; slug: string };
  let agentId: string;
  let blocked: Awaited<ReturnType<typeof hostedApp>>;
  let other: Awaited<ReturnType<typeof hostedApp>>;
  let nested: Awaited<ReturnType<typeof hostedApp>>;

  /** A token scoped to one workspace (`/mcp/{slug}`), or a bare `/mcp` grant. */
  const appToken = async (
    clientId: string,
    org: { id: string; slug: string } | null,
    granted: string[],
    grantType: 'authorization_code' | 'device_code' = 'authorization_code',
    scope = 'mcp:read'
  ) =>
    (
      await createTestAccessToken(userId, (org?.id ?? null) as string, clientId, {
        authorizationGrantType: grantType,
        scope,
        grantedOrganizationIds: granted,
        ...(org ? { resource: `http://localhost/mcp/${org.slug}` } : {}),
      })
    ).token;

  const scopedSession = async (clientId: string, clientName?: string) =>
    openMcpSession(`/mcp/${orgA.slug}`, await appToken(clientId, orgA, [orgA.id]), { clientName });

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    services = vi
      .spyOn(gateway, 'getLobuCoreServices')
      .mockReturnValue({ getGuardrailRegistry: () => registry } as never);
    orgA = await createTestOrganization({ slug: 'inbound-guardrails-a' });
    orgB = await createTestOrganization({ slug: 'inbound-guardrails-b' });
    const user = await createTestUser({ email: 'inbound-guardrails@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgA.id, 'owner');
    await addUserToOrganization(userId, orgB.id, 'owner');
    agentId = (await createTestAgent({ organizationId: orgA.id, ownerUserId: userId })).agentId;
    blocked = await hostedApp('chat.inbound-blocked.test');
    other = await hostedApp('chat.inbound-other.test');
    nested = await hostedApp('chat.inbound-nested.test');

    await createTestWorkspaceGuardrail({
      organizationId: orgA.id,
      name: 'a-judge',
      config: PRE_TOOL_JUDGE,
      appliesTo: [{ kind: 'app', id: blocked.appKey }],
    });
    // Applies to `other` but passes any Lobu tool: only a lookup failure can
    // make it block.
    await createTestWorkspaceGuardrail({
      organizationId: orgA.id,
      name: 'a-forbidden-tools',
      config: { builtin: 'forbidden-tools' },
      appliesTo: [{ kind: 'app', id: other.appKey }],
    });
    await createTestWorkspaceGuardrail({
      organizationId: orgB.id,
      name: 'b-judge',
      config: PRE_TOOL_JUDGE,
      appliesTo: [{ kind: 'app', id: nested.appKey }],
    });
  });

  afterAll(async () => {
    services.mockRestore();
    await getTestDb()`TRUNCATE agents CASCADE`;
  });

  it('blocks the targeted app, not another app, and audits the trip without the config body', async () => {
    expectBlocked(await (await scopedSession(blocked.clientId))('query_sql', PROBE));
    expectRan(await (await scopedSession(other.clientId))('query_sql', PROBE));
    expectRan(await (await scopedSession(nested.clientId))('query_sql', PROBE));

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgA.id, 'pre-tool');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      guardrail: 'a-judge',
      stage: 'pre-tool',
      agent_id: null,
      app_id: blocked.appKey,
      user_id: userId,
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/inbound-policy-body|SELECT 7/);
  });

  it('keys on the verified app, never a self-asserted client name', async () => {
    // The MCP clientInfo name is ignored, in both directions.
    expectBlocked(await (await scopedSession(blocked.clientId, other.appKey))('query_sql', PROBE));
    expectRan(await (await scopedSession(other.clientId, blocked.appKey))('query_sql', PROBE));
    // A device client registered under the blocked app's key derives
    // `local:<name>`, a different principal.
    const spoof = await createTestOAuthClient({
      client_name: blocked.appKey,
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    });
    const spoofToken = await appToken(spoof.client_id, orgA, [orgA.id], 'device_code');
    expectRan(await (await openMcpSession(`/mcp/${orgA.slug}`, spoofToken))('query_sql', PROBE));
  });

  it("does not apply app subjects to an agent's gateway MCP calls", async () => {
    const everyApp = await createTestWorkspaceGuardrail({
      organizationId: orgA.id,
      name: 'a-every-app',
      config: PRE_TOOL_JUDGE,
      appliesTo: [{ kind: 'app', id: null }],
    });
    try {
      const workerToken = mintGatewayMcpToken(
        generateWorkerToken(userId, 'conv-inbound-agent', 'test-deployment', {
          channelId: 'api-conv-inbound-agent',
          agentId,
          organizationId: orgA.id,
          platform: 'api',
          source: 'internal',
        })
      );
      if (!workerToken) throw new Error('failed to narrow the worker token');
      const agentCall = await openMcpSession(`/mcp/${orgA.slug}`, workerToken, {
        headers: { 'X-Lobu-Memory-Direct-Auth': '1' },
      });
      expectRan(await agentCall('query_sql', PROBE));
      expectBlocked(await (await scopedSession(other.clientId))('query_sql', PROBE));
    } finally {
      await getTestDb()`DELETE FROM workspace_guardrails WHERE id = ${everyApp.id}`;
    }
  });

  it('fails closed when the guardrails cannot be checked', async () => {
    await flushPendingGuardrailAudits();
    const tripsBefore = (await fetchGuardrailEvents(orgA.id, 'pre-tool')).length;
    const call = await scopedSession(other.clientId);
    services.mockReturnValueOnce({ getGuardrailRegistry: () => undefined } as never);
    const result = await call('query_sql', PROBE);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('guardrails could not be checked');
    expect(result.structuredContent?.rows).toBeUndefined();
    // The lookup failure is not a trip, and the same call passes once the
    // guardrails can be read.
    await flushPendingGuardrailAudits();
    expect(await fetchGuardrailEvents(orgA.id, 'pre-tool')).toHaveLength(tripsBefore);
    expectRan(await call('query_sql', PROBE));
  });

  it('refuses the call as a policy block when the judge provider fails, without running the tool or leaking why', async () => {
    const down = await hostedApp('chat.inbound-judge-down.test');
    const control = await hostedApp('chat.inbound-judge-down-control.test');
    const guardrail = await createTestWorkspaceGuardrail({
      organizationId: orgA.id,
      name: 'a-judge-provider-down',
      // A policy of its own, so no verdict cached by an earlier test answers it.
      config: { ...PRE_TOOL_JUDGE, policy: 'Deny inbound writes (provider-down-policy-body).' },
      appliesTo: [{ kind: 'app', id: down.appKey }],
    });
    const writer = async (clientId: string) =>
      openMcpSession(
        `/mcp/${orgA.slug}`,
        await appToken(clientId, orgA, [orgA.id], 'authorization_code', 'mcp:read mcp:write')
      );
    const savedNotes = (marker: string) =>
      getTestDb()`SELECT 1 FROM events WHERE organization_id = ${orgA.id} AND payload_text = ${marker}`;
    judgeStub.mockRejectedValue(new Error('judge-transport-sentinel-provider-unavailable'));
    try {
      await flushPendingGuardrailAudits();
      const tripsBefore = (await fetchGuardrailEvents(orgA.id, 'pre-tool')).length;

      const refused = await (await writer(down.clientId))('save_memory', { semantic_type: 'note', content: 'judge-down blocked note' });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toBe('Tool call blocked by policy.');
      expect(refused.structuredContent).toMatchObject({ error: { code: 'PERMISSION' } });
      // Distinctive literals only: the response carries a random call_id.
      expect(JSON.stringify(refused)).not.toMatch(
        /judge-transport-sentinel|provider-down-policy-body|Judge call failed; denied/
      );
      expect(await savedNotes('judge-down blocked note')).toHaveLength(0);

      // The judge did deny: it is audited as a trip of that guardrail.
      await flushPendingGuardrailAudits();
      const trips = await fetchGuardrailEvents(orgA.id, 'pre-tool');
      expect(trips).toHaveLength(tripsBefore + 1);
      expect(trips[0]!.metadata).toMatchObject({ guardrail: 'a-judge-provider-down', app_id: down.appKey, agent_id: null });

      // The same rejecting judge does not apply to another app.
      const allowed = await (await writer(control.clientId))('save_memory', { semantic_type: 'note', content: 'judge-down control note' });
      expect(allowed.isError, allowed.content[0]?.text).toBeFalsy();
      expect(await savedNotes('judge-down control note')).toHaveLength(1);
    } finally {
      judgeStub.mockResolvedValue({ verdict: 'deny', reason: 'stub judge denied' });
      await getTestDb()`DELETE FROM workspace_guardrails WHERE id = ${guardrail.id}`;
    }
  });

  it('enforces in the workspace a bare /mcp call switches into, including client.org()', async () => {
    await flushPendingGuardrailAudits();
    const tripsInABefore = (await fetchGuardrailEvents(orgA.id, 'pre-tool')).length;
    const call = await openMcpSession('/mcp', await appToken(nested.clientId, null, [orgA.id, orgB.id]));
    const script = (slug: string) =>
      `export default async (ctx, client) => (await client.org('${slug}')).query('SELECT 7 AS value');`;

    const inA = await call('query_sdk', { title: 'Nested A', script: script(orgA.slug) });
    expect(inA.isError, inA.content[0]?.text).toBeFalsy();
    expect(JSON.parse(inA.content[0]!.text)).toMatchObject({ success: true, return_value: [{ value: 7 }] });

    // A script that starts with no workspace and reaches into B is checked in B.
    const inB = await call('query_sdk', { title: 'Nested B', script: script(orgB.slug) });
    expect(inB.content[0]!.text).toContain('Tool call blocked by policy.');
    expect(inB.content[0]!.text).not.toMatch(/"success":\s*true/);

    // So is a workspace named by the tool argument, and a federated search
    // that would read B.
    expectRan(await call('query_sql', { ...PROBE, org_slug: orgA.slug }));
    expectBlocked(await call('query_sql', { ...PROBE, org_slug: orgB.slug }));
    expectBlocked(await call('search_memory', { query: 'inbound guardrail probe' }));

    await flushPendingGuardrailAudits();
    expect(await fetchGuardrailEvents(orgA.id, 'pre-tool')).toHaveLength(tripsInABefore);
    const tripsInB = await fetchGuardrailEvents(orgB.id, 'pre-tool');
    expect(tripsInB.length).toBeGreaterThanOrEqual(3);
    for (const trip of tripsInB) {
      expect(trip.metadata).toMatchObject({ guardrail: 'b-judge', app_id: nested.appKey, agent_id: null });
    }
  });
  /** A bare `/mcp` session for the app blocked only in B, granted A and B. */
  const bareNestedSession = async () =>
    openMcpSession('/mcp', await appToken(nested.clientId, null, [orgA.id, orgB.id]));

  /** A `/mcp/{A}` session for the app blocked only in B, able to write. */
  const scopedNestedWriter = async () =>
    openMcpSession(
      `/mcp/${orgA.slug}`,
      await appToken(nested.clientId, orgA, [orgA.id], 'authorization_code', 'mcp:read mcp:write')
    );

  const sdkScript = (body: string) => `export default async (ctx, client) => { ${body} };`;

  it('search_memory: a named workspace and the all-granted default are checked before any shard is read', async () => {
    const call = await bareNestedSession();
    const inA = await call('search_memory', { query: 'inbound guardrail probe', workspace: orgA.slug });
    expect(inA.content[0]!.text).not.toContain('Tool call blocked');
    expectBlocked(await call('search_memory', { query: 'inbound guardrail probe', workspace: orgB.slug }));
    // The default fans out to every granted workspace; a block in one refuses
    // the whole search rather than returning A's results alone.
    expectBlocked(await call('search_memory', { query: 'inbound guardrail probe' }));
  });

  it('search_sdk: connector discovery fanned out from bare /mcp checks each workspace before reading its inventory', async () => {
    const call = await bareNestedSession();
    expectBlocked(await call('search_sdk', { query: 'gmail' }));
    // A workspace-scoped session for the same app only reaches A.
    const scoped = await openMcpSession(`/mcp/${orgA.slug}`, await appToken(nested.clientId, orgA, [orgA.id]));
    const inA = await scoped('search_sdk', { query: 'gmail' });
    expect(inA.isError, inA.content[0]?.text).toBeFalsy();
  });

  it('connect_managed: the public org is checked before the caller is joined to it', async () => {
    const managed = await createTestOrganization({ slug: 'inbound-guardrails-managed', visibility: 'public' });
    await createTestConnectorDefinition({
      key: 'google.gmail',
      name: 'Gmail',
      organization_id: managed.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'google',
            requiredScopes: ['openid'],
            authorizationUrl: 'https://accounts.example/authorize',
            tokenUrl: 'https://accounts.example/token',
            clientIdKey: 'GOOGLE_CLIENT_ID',
            clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          },
        ],
      },
      feeds_schema: { items: {} },
    });
    await createAuthProfile({
      organizationId: managed.id,
      connectorKey: 'google.gmail',
      displayName: 'Managed Google App',
      profileKind: 'oauth_app',
      provider: 'google',
      authData: { GOOGLE_CLIENT_ID: 'synthetic-client-id', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret' },
    });
    await createTestWorkspaceGuardrail({
      organizationId: managed.id,
      name: 'managed-judge',
      config: PRE_TOOL_JUDGE,
      appliesTo: [{ kind: 'app', id: nested.appKey }],
    });
    const previous = process.env.LOBU_MANAGED_AUTH_ORGS;
    process.env.LOBU_MANAGED_AUTH_ORGS = managed.slug;
    try {
      const call = await scopedNestedWriter();
      const result = await call('run_sdk', {
        title: 'Managed connect',
        script: sdkScript(
          `return client.connections.connectManaged({ managed_by_org: '${managed.slug}', connector_key: 'google.gmail' });`
        ),
      });
      expect(result.content[0]!.text).toContain('Tool call blocked by policy.');
      // Refused before the join: no member row, projection or connection exists there.
      const sql = getTestDb();
      expect(await sql`SELECT 1 FROM "member" WHERE "organizationId" = ${managed.id} AND "userId" = ${userId}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM connections WHERE organization_id = ${managed.id}`).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.LOBU_MANAGED_AUTH_ORGS;
      else process.env.LOBU_MANAGED_AUTH_ORGS = previous;
    }
  });

  it("notifications: the receiving workspace's inbox is checked before it is listed or written", async () => {
    await ensureMemberEntityType(orgB.id);
    const sql = getTestDb();
    const inbox = {
      inbound_probe: {
        description: 'Synthetic inbox',
        metadataSchema: { type: 'object' },
        inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' },
      },
    };
    await sql`UPDATE entity_types SET event_kinds = COALESCE(event_kinds, '{}'::jsonb) || ${sql.json(inbox)}
      WHERE organization_id = ${orgB.id} AND slug = '$member'`;
    const call = await scopedNestedWriter();
    const listed = await call('query_sdk', {
      title: 'List B inboxes',
      script: sdkScript(`return client.notifications.listInboxes({ organization: '${orgB.slug}' });`),
    });
    expect(listed.content[0]!.text).toContain('Tool call blocked by policy.');
    expect(listed.content[0]!.text).not.toContain('inbound_probe');
    const submitted = await call('run_sdk', {
      title: 'Submit to B',
      script: sdkScript(
        `return client.notifications.submit({ organization: '${orgB.slug}', inbox: 'inbound_probe', title: 'Probe', idempotency_key: 'inbound-probe-1' });`
      ),
    });
    expect(submitted.content[0]!.text).toContain('Tool call blocked by policy.');
    expect(await sql`SELECT 1 FROM notification_targets nt JOIN events e ON e.id = nt.event_id
      WHERE e.organization_id = ${orgB.id}`).toHaveLength(0);
  });
});
