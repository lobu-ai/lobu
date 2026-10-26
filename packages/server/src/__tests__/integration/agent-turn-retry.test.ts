/**
 * Retry of an agent turn that ended on a worker failure
 * (`retryInterruptedAgentTurn`).
 *
 * Driven through the real producer, fleet poll/heartbeat routes, gateway tool
 * stamps and reaper: a turn runs tools, its worker dies, the reaper shows
 * WORKER_DIED, and Retry re-admits the same message as a new `messages` run.
 * That run is fed to the producer exactly as the message consumer does, so the
 * retry turn's input and its write receipts are the production ones.
 */
import { AgentErrorCode, type MessagePayload, verifyWorkerToken } from '@lobu/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpProxy } from '../../gateway/auth/mcp/proxy';
import { registerActionHandlers } from '../../gateway/connections/interaction-bridge';
import type { PlatformConnection } from '../../gateway/connections/types';
import type { AgentSettingsStore } from '../../gateway/auth/settings/agent-settings-store';
import type { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import type { ModelProviderModule } from '../../gateway/modules/module-system';
import { enqueueAgentTurn } from '../../gateway/orchestration/agent-turn-producer';
import { retryInterruptedAgentTurn } from '../../gateway/orchestration/agent-turn-retry';
import { authenticateWorker } from '../../gateway/routes/internal/middleware';
import { AGENT_TURN_TOOL_LOG_MAX } from '../../runs/agent-turn-inputs';
import { isAuthorizationReadOnlyToolName } from '../../tools/registry';
import { agentTurnIdentityFromClaims, runTurnWriteOnce } from '../../tools/turn-write-idempotency';
import { sweepStaleAgentTurnRuns } from '../../worker-api/agent-turn';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const GATEWAY_URL = 'https://gateway.test.invalid/lobu';
const SENDER = 'user-retry';
const STALE_THRESHOLD_SECONDS = 60;

function claudeModule(): ModelProviderModule {
  return {
    providerId: 'claude',
    sdkCompat: 'anthropic',
    getUpstreamConfig: () => ({ slug: 'anthropic', upstreamBaseUrl: 'https://api.anthropic.com', apiKeyHeader: 'x-api-key' as const }),
    getProxyBaseUrlMappings: (proxyUrl: string, agentId?: string, context?: { organizationId?: string; userId?: string }) => ({
      ANTHROPIC_BASE_URL: `${proxyUrl}/anthropic/a/${agentId}/o/${context?.organizationId}/u/${context?.userId}`,
    }),
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) => context?.workerToken ?? 'lobu-proxy',
  } as unknown as ModelProviderModule;
}

const deps = {
  agentSettings: { getSettings: async () => ({ identityMd: 'I retry.', soulMd: '', userMd: '' }) } as unknown as AgentSettingsStore,
  catalog: {
    getInstalledModules: async () => [claudeModule()],
    findProviderForModel: async () => claudeModule(),
  } as unknown as ProviderCatalogService,
  gatewayUrl: GATEWAY_URL,
};

function messageFor(organizationId: string): MessagePayload {
  return {
    userId: SENDER,
    conversationId: 'conv-retry',
    messageId: 'msg-retry',
    channelId: `api_${SENDER}`,
    agentId: 'retry-agent',
    organizationId,
    botId: 'bot-retry',
    platform: 'api',
    messageText: 'post the weekly summary',
    platformMetadata: {},
    agentOptions: { model: 'claude/claude-opus-4-8' },
  } as MessagePayload;
}

/** Admit `message` as the consumer would have (a completed `messages` run) and produce its turn. */
async function produce(message: MessagePayload, admittedRunId?: number) {
  const sql = getTestDb();
  const runId = admittedRunId ?? Number((await sql`
    INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
    VALUES (${message.organizationId}, 'chat_message', 'messages', 'completed', ${sql.json(message)}) RETURNING id
  `)[0]!.id);
  expect(await enqueueAgentTurn({ ...message, runId }, deps)).toBeUndefined();
  await sql`UPDATE runs SET status = 'completed' WHERE id = ${runId}`;
  const [turn] = (await sql`
    SELECT id, action_input FROM runs WHERE run_type = 'agent_turn' AND parent_run_id = ${runId}
  `) as unknown as Array<{ id: number; action_input: { turn: Record<string, unknown>; credential: string } }>;
  return turn!;
}

function postAsFleet(path: string, body: Record<string, unknown>) {
  return post(path, { body, token: 'test-fleet-token', env: { WORKER_API_TOKEN: 'test-fleet-token' } });
}

/** Claim the pending turn and send the first credential-proving beat. */
async function claim(workerId: string): Promise<{ runId: number; credential: string }> {
  const body = await (await postAsFleet('/api/workers/poll', { worker_id: workerId, capabilities: { agent_turn: true } })).json();
  const credential = body.credentials.accessToken as string;
  const beat = await postAsFleet('/api/workers/heartbeat', {
    run_id: body.run_id, worker_id: workerId, turn_credential: credential, turn_tool_events: [],
  });
  expect(beat.status).toBe(200);
  return { runId: body.run_id as number, credential };
}

/** The worker died: the reaper sees a lost heartbeat and, with tools or a spent re-run, shows WORKER_DIED. */
async function killWorker(runId: number) {
  const sql = getTestDb();
  await sql`UPDATE runs SET claimed_at = now() - interval '1 hour', last_heartbeat_at = now() - interval '1 hour' WHERE id = ${runId}`;
  expect(await sweepStaleAgentTurnRuns(STALE_THRESHOLD_SECONDS)).toEqual({ reaped: 1, delivered: 1, requeued: 0 });
}

/** The gateway routes a turn's tools reach, mounted as production mounts them. */
function gatewayRoutes() {
  const app = new Hono();
  app.post('/lobu/internal/images/generate', authenticateWorker, (c) => c.json({ ok: true }));
  const proxy = new McpProxy({
    getHttpServer: async (id: string) => ({ id, internal: id === 'lobu', upstreamUrl: 'http://127.0.0.1:9/unreachable' }),
  } as never, { isReadOnlyLobuTool: isAuthorizationReadOnlyToolName });
  app.route('/lobu/mcp', proxy.getApp());
  return (path: string, credential: string) => app.fetch(new Request(`http://gateway.test${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: '{}',
  }));
}

async function retryAdmissions(): Promise<Array<{ id: number; action_input: MessagePayload }>> {
  return (await getTestDb()`
    SELECT id, action_input FROM runs
    WHERE run_type = 'chat_message' AND queue_name = 'messages'
      AND action_input->'platformMetadata' ? 'retryOfTurnRunId'
    ORDER BY id
  `) as unknown as Array<{ id: number; action_input: MessagePayload }>;
}

describe('retry of an interrupted agent turn', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
  });

  it('retries a failed turn that ran no tools with no note', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    const failed = await produce(message);
    const { runId } = await claim('fleet-no-tools');
    // Its one automatic re-run is already spent, so this death is shown to the user.
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_requeue_count": 1}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    const outcome = await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER });
    expect(outcome).toMatchObject({ status: 'started' });
    expect(outcome).not.toHaveProperty('note');
    const [admitted] = await retryAdmissions();
    expect(admitted!.action_input.ephemeralContext).toBeUndefined();
    expect(admitted!.action_input.messageId).toBe(message.messageId);
    const retry = await produce(admitted!.action_input, admitted!.id);
    expect(retry.action_input.turn.message_id).toBe(message.messageId);
    expect(retry.action_input.turn.ephemeral_context).toBeUndefined();
  });

  it('lists two traced tools and one stamped-but-untraced tool in the retry note', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    const failed = await produce(message);
    const workerId = 'fleet-two-tools';
    const { runId, credential } = await claim(workerId);
    const call = gatewayRoutes();
    // The gateway stamps each side-effecting call before it acts.
    await call('/lobu/mcp/external/tools/run_sdk', credential);
    await call('/lobu/internal/images/generate', credential);
    // The worker reports two finished calls; generate_image's trace never arrives.
    const beat = await postAsFleet('/api/workers/heartbeat', {
      run_id: runId, worker_id: workerId, turn_credential: credential,
      turn_tool_events: [
        { tool_call_id: 'call-search', name: 'search_memory', input: { query: 'weekly summary' }, is_error: false, output: 'found 3' },
        { tool_call_id: 'call-sdk', name: 'run_sdk', input: { code: 'post()' }, is_error: true, output: 'upstream refused' },
      ],
    });
    expect(await beat.json()).toMatchObject({ turn_tool_ack: { received: 2 } });
    await killWorker(runId);
    const [failedRow] = (await getTestDb()`SELECT status, run_metadata FROM runs WHERE id = ${failed.id}`) as unknown as Array<{
      status: string; run_metadata: Record<string, unknown>;
    }>;
    expect(failedRow).toMatchObject({ status: 'timeout', run_metadata: { turn_error_code: AgentErrorCode.WORKER_DIED } });

    const outcome = await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER });
    expect(outcome.status).toBe('started');
    const note = (outcome as { note?: string }).note;
    expect(note?.split('\n')).toEqual([
      'A previous attempt at this message was interrupted after it already did:',
      '- search_memory({"query":"weekly summary"}) → ok',
      '- run_sdk({"code":"post()"}) → error: upstream refused',
      '- generate_image: started, outcome unknown',
      "Don't repeat these; continue from here.",
    ]);
    const [admitted] = await retryAdmissions();
    expect(admitted!.action_input.ephemeralContext).toBe(note);
    // The consumer produces the retry turn from that admission: same input
    // message, with the note on the transient context the model sees.
    const retry = await produce(admitted!.action_input, admitted!.id);
    expect(retry.action_input.turn.message_id).toBe(message.messageId);
    expect(String(retry.action_input.turn.ephemeral_context).startsWith(note!)).toBe(true);
  });

  it('rebuilds one note across repeated failures without losing the original context', async () => {
    const org = await createTestOrganization();
    const callerContext = 'Keep the original caller instructions.';
    let message: MessagePayload = { ...messageFor(org.id), ephemeralContext: callerContext };
    let admissionId: number | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const failed = await produce(message, admissionId);
      const { runId } = await claim(`fleet-context-${attempt}`);
      await getTestDb()`UPDATE runs SET run_metadata = run_metadata || ${getTestDb().json({
        turn_tool_started: true, turn_started_tools: [`tool-${attempt}-${'x'.repeat(200)}`],
      })}::jsonb WHERE id = ${runId}`;
      await killWorker(runId);
      const outcome = await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER });
      expect(outcome.status).toBe('started');
      const admissions = await retryAdmissions();
      const admitted = admissions.at(-1)!;
      admissionId = admitted.id;
      message = admitted.action_input;
      expect(message.ephemeralContext?.split('A previous attempt').length).toBe(2);
      if (attempt === 5) expect(message.ephemeralContext).toContain('Earlier or additional tool activity may be omitted');
    }
    const retry = await produce(message, admissionId);
    expect(retry.action_input.turn.ephemeral_context).toContain(callerContext);
  });

  it.each([
    { metadata: { turn_tool_started: true }, warning: 'details are unavailable' },
    { metadata: { turn_tool_started: true, turn_tool_call_ids: ['missing-trace'] }, warning: 'details are unavailable' },
    { metadata: { turn_tool_started: true, turn_started_tools: Array.from({ length: AGENT_TURN_TOOL_LOG_MAX }, (_, i) => `tool-${i}`) }, warning: 'may be omitted' },
  ])('warns when recorded tool activity is incomplete: $warning', async ({ metadata, warning }) => {
    const org = await createTestOrganization();
    const failed = await produce(messageFor(org.id));
    const { runId } = await claim('fleet-missing-trace');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || ${getTestDb().json(metadata)}::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    const outcome = await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER });
    expect(outcome).toMatchObject({ status: 'started', note: expect.stringContaining(warning) });
    const [admitted] = await retryAdmissions();
    const retry = await produce(admitted!.action_input, admitted!.id);
    expect(retry.action_input.turn.ephemeral_context).toContain('check for effects before repeating it');
  });

  it('starts one new turn when Retry is pressed twice', async () => {
    const org = await createTestOrganization();
    const failed = await produce(messageFor(org.id));
    const { runId } = await claim('fleet-double-press');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_requeue_count": 1}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    const press = () => retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER });
    const outcomes = await Promise.all([press(), press()]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['already_retried', 'started']);
    expect(await press()).toMatchObject({ status: 'already_retried' });
    expect(await retryAdmissions()).toHaveLength(1);
  });

  it('refuses a retry from anyone but the sender', async () => {
    const org = await createTestOrganization();
    const failed = await produce(messageFor(org.id));
    const { runId } = await claim('fleet-other-user');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_requeue_count": 1}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    expect(await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: 'someone-else' }))
      .toEqual({ status: 'forbidden' });
    const other = await createTestOrganization();
    expect(await retryInterruptedAgentTurn({ organizationId: other.id, turnRunId: failed.id, actorUserId: SENDER }))
      .toEqual({ status: 'not_found' });
    expect(await retryAdmissions()).toHaveLength(0);
  });

  it('refuses a retry of a turn that did not end on a worker failure', async () => {
    const org = await createTestOrganization();
    const failed = await produce(messageFor(org.id));
    expect(await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER }))
      .toEqual({ status: 'not_retryable' });
    expect(await retryAdmissions()).toHaveLength(0);
  });

  it('retries from the Slack Retry button for the sender only, once', async () => {
    const org = await createTestOrganization();
    const message = {
      ...messageFor(org.id), platform: 'slack', channelId: 'slack:C_RETRY', conversationId: 'slack:C_RETRY:1787292000.000100',
      platformMetadata: { connectionId: 'conn-retry', senderId: SENDER },
    } as MessagePayload;
    const failed = await produce(message);
    const { runId } = await claim('fleet-slack');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_requeue_count": 1}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    let onAction: ((event: unknown) => Promise<void>) | undefined;
    const connection = (id: string) => ({ id, platform: 'slack', organizationId: org.id }) as PlatformConnection;
    registerActionHandlers({ onAction: (handler: typeof onAction) => { onAction = handler; } }, connection('conn-retry'));
    const posted = vi.fn(async () => undefined);
    const click = (userId: string) => onAction!({ actionId: `turn-retry:${failed.id}`, user: { userId }, thread: { post: posted } });

    await click('U_SOMEONE_ELSE');
    expect(posted).toHaveBeenLastCalledWith('Only the person who sent this message can retry it.');
    expect(await retryAdmissions()).toHaveLength(0);
    await click(SENDER);
    expect(await retryAdmissions()).toHaveLength(1);
    expect(posted).toHaveBeenCalledTimes(1);
    await click(SENDER);
    expect(posted).toHaveBeenLastCalledWith('This message is already being retried.');
    expect(await retryAdmissions()).toHaveLength(1);

    // The same button on another connection of the org matches no message.
    let otherAction: typeof onAction;
    registerActionHandlers({ onAction: (handler: typeof onAction) => { otherAction = handler; } }, connection('conn-other'));
    await otherAction!({ actionId: `turn-retry:${failed.id}`, user: { userId: SENDER }, thread: { post: posted } });
    expect(posted).toHaveBeenLastCalledWith("I couldn't find that message to retry.");
  });

  it('retries a turn a shared preview connection routed into another organization', async () => {
    const owner = await createTestOrganization();
    const routed = await createTestOrganization();
    const message = {
      ...messageFor(routed.id), platform: 'slack', channelId: 'slack:C_PREVIEW', conversationId: 'slack:C_PREVIEW:1787292000.000200',
      platformMetadata: { connectionId: 'conn-preview', senderId: SENDER },
    } as MessagePayload;
    const failed = await produce(message);
    const { runId } = await claim('fleet-preview');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_requeue_count": 1}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    let onAction: ((event: unknown) => Promise<void>) | undefined;
    registerActionHandlers({ onAction: (handler: typeof onAction) => { onAction = handler; } },
      { id: 'conn-preview', platform: 'slack', organizationId: owner.id, settings: { previewMode: true } } as unknown as PlatformConnection);
    const posted = vi.fn(async () => undefined);
    await onAction!({ actionId: `turn-retry:${failed.id}`, user: { userId: SENDER }, thread: { post: posted } });
    expect(posted).not.toHaveBeenCalled();
    const [admitted] = await retryAdmissions();
    expect(admitted!.action_input.organizationId).toBe(routed.id);
  });

  it('never lets the note push the caller context past the turn context cap', async () => {
    const org = await createTestOrganization();
    const callerContext = `${'Keep these instructions. '.repeat(74)}NEVER APPROVE WITHOUT ASKING.`;
    expect(callerContext.length).toBeGreaterThan(1_800);
    const failed = await produce({ ...messageFor(org.id), ephemeralContext: callerContext });
    const { runId } = await claim('fleet-near-cap');
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || ${getTestDb().json({
      turn_tool_started: true, turn_started_tools: ['send_message', 'run_sdk'],
    })}::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    expect((await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER })).status).toBe('started');
    const [admitted] = await retryAdmissions();
    const retry = await produce(admitted!.action_input, admitted!.id);
    const context = String(retry.action_input.turn.ephemeral_context);
    expect(context.endsWith('NEVER APPROVE WITHOUT ASKING.')).toBe(true);
    expect(context.length).toBeLessThanOrEqual(2_048);
  });

  it('keeps the input message id, so the retry turn replays a write the failed turn made', async () => {
    const org = await createTestOrganization();
    const message = messageFor(org.id);
    const failed = await produce(message);
    const { runId, credential } = await claim('fleet-wrote');
    const effect = vi.fn(async () => ({ store: { posted: 'message-1' } }));
    const args = { target: 'conv-retry', text: 'weekly summary' };
    const failedIdentity = agentTurnIdentityFromClaims(verifyWorkerToken(credential)!);
    expect(await runTurnWriteOnce(failedIdentity, 'send_message', args, effect)).toEqual({ kind: 'ran' });
    await getTestDb()`UPDATE runs SET run_metadata = run_metadata || '{"turn_tool_started": true}'::jsonb WHERE id = ${runId}`;
    await killWorker(runId);

    expect((await retryInterruptedAgentTurn({ organizationId: org.id, turnRunId: failed.id, actorUserId: SENDER })).status).toBe('started');
    const [admitted] = await retryAdmissions();
    const retry = await produce(admitted!.action_input, admitted!.id);
    expect(retry.id).not.toBe(failed.id);
    const retryIdentity = agentTurnIdentityFromClaims(verifyWorkerToken(retry.action_input.credential)!);
    expect(retryIdentity).toMatchObject({ messageId: message.messageId, runId: retry.id });
    expect(await runTurnWriteOnce(retryIdentity, 'send_message', args, effect))
      .toEqual({ kind: 'replay', result: { posted: 'message-1' } });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
