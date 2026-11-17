/**
 * A turn's delivery writes run once per input message (`turn_write_receipts`).
 *
 * Driven through the production turn mint, the real worker routes and the
 * embedded MCP lane. A re-run of the same input mints a NEW run and credential
 * for the SAME message, which is the repeat these tests model; the effect
 * mocks count service calls, not live provider deliveries.
 */

import { mintGatewayMcpToken, type MessagePayload } from '@lobu/core';
import { TURN_INPUT_RUN_HEADER } from '@lobu/core/agent-tooling';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintTurnToken } from '../../gateway/orchestration/agent-turn-producer';
import { resolveAddressableTargets, threadHandleForMessage } from '../../gateway/conversations/authorization';
import { createAudioRoutes } from '../../gateway/routes/internal/audio';
import { createConversationsRoutes } from '../../gateway/routes/internal/conversations';
import { createFileRoutes } from '../../gateway/routes/internal/files';
import { createImageRoutes } from '../../gateway/routes/internal/images';
import { createInteractionRoutes } from '../../gateway/routes/internal/interactions';
import { ImageGenerationService } from '../../gateway/services/image-generation-service';
import { TranscriptionService } from '../../gateway/services/transcription-service';
import { __setChatInstanceManagerForTests } from '../../lobu/gateway';
import { pruneTurnWriteReceipts } from '../../tools/turn-write-idempotency';
import { ensureConnectorInstalled } from '../../utils/ensure-connector-installed';
import * as entityHooks from '../../utils/entity-hooks';
import { initWorkspaceProvider } from '../../workspace';
import { __setLocalFrontendForTests } from '../../utils/public-origin';
import type { Env } from '../../index';
import { manageOperations } from '../../tools/admin/manage_operations';
import { handleExecute } from '../../tools/admin/manage_operations/handlers/execute';
import { qualifiedOperationKey } from '../../tools/admin/manage_operations/handlers/shared';
import { createTestAutomationSubscription } from '../setup/automation-subscriptions';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  insertAgentTurnRun,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
  ownerToolContext,
  seedSystemEntityTypes,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const AGENT = 'turn-receipts-agent';
const CONNECTION = 'turn-receipts-connection';
const TEAM = 'T0RECEIPTS';
const SENDER = 'U0RECEIPTS';
const CONVERSATION = 'slack:C_RECEIPTS:1787292000.000100';

let org: Awaited<ReturnType<typeof createTestOrganization>>;
let owner: Awaited<ReturnType<typeof createTestUser>>;
/** The thread the turns are asked in: a send there is the turn's reply. */
let target: string;
/** The bound channel at top level: a send there is a post elsewhere. */
let channelTarget: string;
const posted = vi.fn(async () => ({ messageId: 'synthetic-post', threadId: CONVERSATION }));
const question = vi.fn(async () => ({ id: 'synthetic-question' }));
const generate = vi.fn(async () => ({ imageBuffer: Buffer.from('png'), mimeType: 'image/png', provider: 'fixture' }));
const synthesize = vi.fn(async () => ({ audioBuffer: Buffer.from('mp3'), mimeType: 'audio/mpeg', provider: 'fixture' }));
const publish = vi.fn(async (input: { filename: string; buffer: Buffer }) => ({
  artifactId: `artifact-${publish.mock.calls.length}`,
  downloadUrl: 'http://fixture.invalid/artifact',
  filename: input.filename,
  size: input.buffer.length,
}));
const app = new Hono();

function message(messageId: string): MessagePayload {
  return {
    userId: SENDER, conversationId: CONVERSATION, messageId, channelId: 'slack:C_RECEIPTS', teamId: `slack:${TEAM}`,
    agentId: AGENT, organizationId: org.id, platform: 'slack', messageText: 'deliver it',
    platformMetadata: { connectionId: CONNECTION, teamId: TEAM, senderId: SENDER, responseThreadId: CONVERSATION },
    agentOptions: {},
  } as MessagePayload;
}

/** A stored agent turn for `messageId` (one per call: a re-run) and its worker credential. */
async function turn(messageId: string): Promise<{ token: string; runId: number }> {
  const payload = message(messageId);
  const runId = await insertAgentTurnRun(payload);
  const token = await mintTurnToken(payload, runId);
  // The gateway admits a turn's side-effecting call only from the attempt
  // that holds the run, named by the credential the run stores.
  await getTestDb()`UPDATE runs SET action_input = action_input || ${getTestDb().json({ credential: token })}::jsonb WHERE id = ${runId}`;
  return { token, runId };
}

function call(path: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/lobu' + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
}

function upload(text: string) {
  const form = new FormData();
  form.append('file', new File([text], 'report.txt', { type: 'text/plain' }));
  form.append('filename', 'report.txt');
  return form;
}

const routes: Array<[string, string, () => unknown, () => ReturnType<typeof vi.fn>]> = [
  ['send_message', '/internal/conversations/send', () => ({ target, text: 'the answer' }), () => posted],
  ['ask_user', '/internal/interactions/create', () => ({ question: 'Which one?', options: ['a', 'b'] }), () => question],
  ['upload_file', '/internal/files/upload', () => upload('report body'), () => publish],
  ['generate_image', '/internal/images/generate', () => ({ prompt: 'a lighthouse' }), () => generate],
  ['generate_audio', '/internal/audio/synthesize', () => ({ text: 'hello there' }), () => synthesize],
];

beforeAll(async () => {
  await cleanupTestDatabase();
  await initWorkspaceProvider();
  await seedSystemEntityTypes();
  org = await createTestOrganization();
  owner = await createTestUser();
  await addUserToOrganization(owner.id, org.id, 'owner');
  await linkChatIdentityInGraph({ organizationId: org.id, userId: owner.id, platform: 'slack', teamId: TEAM, platformUserId: SENDER });
  await createTestAgent({ organizationId: org.id, agentId: AGENT, ownerUserId: owner.id });
  await insertChatConnectionRow({ id: CONNECTION, organizationId: org.id, agentId: AGENT, platform: 'slack' });
  await createTestAutomationSubscription({ organizationId: org.id, agentId: AGENT, connectionSlug: `agentconn-${CONNECTION}`, platform: 'slack', channelId: 'slack:C_RECEIPTS' });
  await getTestDb()`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'company', 'Company', now(), now())
  `;
  const [channel] = await resolveAddressableTargets(AGENT, org.id);
  channelTarget = channel!.handle;
  target = threadHandleForMessage(channel!, '1787292000.000100');
  __setChatInstanceManagerForTests({ postToConversation: posted });
  app.route('/lobu', createInteractionRoutes({ postQuestion: question } as never));
  app.route('/lobu', createImageRoutes({ generate } as never));
  app.route('/lobu', createAudioRoutes({ synthesize } as never));
  app.route('/lobu/internal/files', createFileRoutes({ get: () => undefined } as never, { publish } as never, 'http://fixture.invalid'));
  app.route('/lobu/internal', createConversationsRoutes());
});

afterAll(async () => {
  __setChatInstanceManagerForTests(null);
  await cleanupTestDatabase();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getTestDb()`DELETE FROM turn_write_receipts`;
});

describe('turn write receipts on the worker delivery routes', () => {
  it.each(routes)('%s: a re-run of the same input executes once', async (_name, path, body, effect) => {
    const first = await turn('receipts-message-1');
    const rerun = await turn('receipts-message-1');
    const a = await call(path, first.token, body());
    expect(a.status, await a.clone().text()).toBe(200);
    const b = await call(path, rerun.token, body());
    expect(effect()).toHaveBeenCalledTimes(1);
    if ((a.headers.get('content-type') ?? '').includes('application/json')) {
      expect(b.status).toBe(200);
      expect(await b.json()).toEqual(await a.json());
    } else {
      // The route generated bytes but has no receipt for the subsequent upload.
      // Refuse another generation without claiming delivery succeeded.
      expect(b.status).toBe(409);
      expect((await b.json()).error).toContain('delivery is unconfirmed');
    }
  });

  it.each(routes)('%s: a different input message delivers again', async (_name, path, body, effect) => {
    expect((await call(path, (await turn('receipts-message-2')).token, body())).status).toBe(200);
    expect((await call(path, (await turn('receipts-message-3')).token, body())).status).toBe(200);
    expect(effect()).toHaveBeenCalledTimes(2);
  });

  it('a different send in the same turn is its own delivery', async () => {
    const { token } = await turn('receipts-message-4');
    await call('/internal/conversations/send', token, { target, text: 'first' });
    await call('/internal/conversations/send', token, { target, text: 'second' });
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it('a claim left without a result answers "already attempted" and does not deliver', async () => {
    const first = await turn('receipts-message-5');
    let finish: () => void = () => {};
    posted.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ messageId: 'synthetic-post', threadId: CONVERSATION });
    }));
    const inFlight = call('/internal/conversations/send', first.token, { target, text: 'slow' });
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    const repeat = await call('/internal/conversations/send', (await turn('receipts-message-5')).token, { target, text: 'slow' });
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).error).toContain('already attempted');
    finish();
    expect((await inFlight).status).toBe(200);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it.each(routes)('%s: an exception after dispatch retains its claim', async (_name, path, body, effect) => {
    effect().mockRejectedValueOnce(new Error('Response lost after dispatch'));
    const failed = await call(path, (await turn('receipts-ambiguous')).token, body());
    expect(failed.status).toBe(500);
    const retry = await call(path, (await turn('receipts-ambiguous')).token, body());
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toContain('already attempted');
    expect(effect()).toHaveBeenCalledTimes(1);
  });

  it('a failed delivery releases its claim so the retry delivers', async () => {
    generate.mockResolvedValueOnce({ error: 'provider down', availableProviders: [] } as never);
    const failed = await call('/internal/images/generate', (await turn('receipts-message-6')).token, { prompt: 'retry me' });
    expect(failed.status).toBe(400);
    const retry = await call('/internal/images/generate', (await turn('receipts-message-6')).token, { prompt: 'retry me' });
    expect(retry.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('send: a refusal before posting releases its claim, so the retry after recovery delivers once', async () => {
    __setChatInstanceManagerForTests(null);
    try {
      const refused = await call('/internal/conversations/send', (await turn('receipts-unavailable')).token, { target, text: 'later' });
      expect(refused.status).toBe(503);
    } finally {
      __setChatInstanceManagerForTests({ postToConversation: posted });
    }
    const retry = await call('/internal/conversations/send', (await turn('receipts-unavailable')).token, { target, text: 'later' });
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it('present-event: a refusal before posting releases its claim, so the retry after recovery delivers once', async () => {
    const event = await createTestEvent({ organization_id: org.id, title: 'Presentable', content: 'body' });
    // Permalinks resolve against the hosted UI only without a bundled frontend.
    __setLocalFrontendForTests(false);
    __setChatInstanceManagerForTests(null);
    try {
      const refused = await call('/internal/conversations/present-event', (await turn('receipts-present')).token, { eventId: Number(event.id) });
      expect(refused.status, await refused.clone().text()).toBe(503);
    } finally {
      __setChatInstanceManagerForTests({ postToConversation: posted });
    }
    try {
      const retry = await call('/internal/conversations/present-event', (await turn('receipts-present')).token, { eventId: Number(event.id) });
      expect(retry.status, await retry.clone().text()).toBe(200);
      expect(posted).toHaveBeenCalledTimes(1);
    } finally {
      __setLocalFrontendForTests(undefined);
    }
  });

  it('a steered follow-up repeating an identical send delivers once more, and only once', async () => {
    const owner = await turn('receipts-owner');
    const follower = await insertAgentTurnRun(message('receipts-follower'));
    await getTestDb()`
      UPDATE runs SET run_metadata = jsonb_build_object('consumed_by_run_id', ${owner.runId}::bigint) WHERE id = ${follower}
    `;
    const send = (headers: Record<string, string> = {}) =>
      call('/internal/conversations/send', owner.token, { target, text: 'same words' }, headers);
    expect((await send()).status).toBe(200);
    expect((await send({ [TURN_INPUT_RUN_HEADER]: String(follower) })).status).toBe(200);
    expect((await send({ [TURN_INPUT_RUN_HEADER]: String(follower) })).status).toBe(200);
    expect(posted).toHaveBeenCalledTimes(2);
    const unowned = await insertAgentTurnRun(message('receipts-unowned'));
    expect((await send({ [TURN_INPUT_RUN_HEADER]: String(unowned) })).status).toBe(409);
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it('prunes receipts past the runs retention window', async () => {
    await call('/internal/conversations/send', (await turn('receipts-message-7')).token, { target, text: 'old' });
    await getTestDb()`UPDATE turn_write_receipts SET created_at = now() - interval '10 days'`;
    expect(await pruneTurnWriteReceipts(7)).toBe(1);
    expect(await getTestDb()`SELECT 1 FROM turn_write_receipts`).toHaveLength(0);
  });
});

describe('turn write receipts on entity create', () => {
  async function create(messageId: string, name: string, expectError = false, entityType = 'company') {
    const { token: worker } = await turn(messageId);
    const token = mintGatewayMcpToken(worker)!;
    const headers = { 'X-Lobu-Memory-Direct-Auth': '1' };
    const init = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'initialize', id: 0, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'turn', version: '1' } } },
      token, headers,
    });
    const session = init.headers.get('mcp-session-id') as string;
    const response = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'manage_entity', arguments: { action: 'create', entity_type: entityType, name } } },
      token, headers: { ...headers, 'mcp-session-id': session, 'X-MCP-Format': 'json' },
    });
    const body = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(body.result?.isError === true, JSON.stringify(body)).toBe(expectError);
    const text = body.result?.content?.[0]?.text ?? '{}';
    return expectError ? text : JSON.parse(text);
  }
  async function companies(name: string) {
    return getTestDb()`SELECT id FROM entities WHERE organization_id = ${org.id} AND name = ${name} AND deleted_at IS NULL`;
  }

  it('a re-run of the same input creates one row and replays the first result', async () => {
    const first = await create('receipts-entity-1', 'Receipts Co');
    const again = await create('receipts-entity-1', 'Receipts Co');
    expect(await companies('Receipts Co')).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it('a different input message reaches the create again instead of a replay', async () => {
    await create('receipts-entity-2', 'Twice Co');
    // Entity names are unique per type, so the second real create is refused
    // by the store: proof it ran rather than replaying the first result.
    expect(await create('receipts-entity-3', 'Twice Co', true)).toContain('already exists');
    expect(await companies('Twice Co')).toHaveLength(1);
  });

  it('a thrown create error retains its claim because commit status is unknown', async () => {
    // A constraint failure in a post-commit hook must not be classified as a
    // refused insert: the entity already exists and its receipt must stay held.
    const hooks = vi.spyOn(entityHooks, 'getEntityHooks').mockReturnValue({
      afterCreate: async () => {
        await getTestDb()`
          INSERT INTO entity_types (organization_id, slug, name)
          VALUES (${org.id}, 'company', 'Company')
        `;
      },
    });
    try {
      expect(await create('receipts-entity-4', 'Committed Co', true)).toContain('duplicate key');
      expect(await create('receipts-entity-4', 'Committed Co', true)).toContain('already attempted');
    } finally {
      hooks.mockRestore();
    }
    expect(await companies('Committed Co')).toHaveLength(1);
  });

  it.each([
    ['an unknown type', 'receipts-entity-6', 'Typeless Co', 'no_such_type', "Unknown entity type 'no_such_type'"],
    ['a duplicate name', 'receipts-entity-5', 'Duplicate Co', 'company', 'already exists'],
  ])('a typed refusal (%s) releases its claim, so the retry is refused the same way', async (_label, messageId, name, type, refusal) => {
    if (type === 'company') await create(`${messageId}-seed`, name);
    const first = await create(messageId, name, true, type);
    expect(first).toContain(refusal);
    expect(await create(messageId, name, true, type)).toEqual(first);
  });
});

describe('turn write receipts over the real media services', () => {
  // The provider answers 200 and then the body read fails: the image or audio
  // may have been generated and billed, but nothing came back. A repeat of the
  // same input must not call the provider again.
  const provider = vi.fn(async () => new Response(new ReadableStream({ start: (stream) => stream.error(new Error('connection reset')) }), { status: 200 }));
  let configured = true;
  const source = async () => configured ? { apiKey: 'synthetic-key', baseUrl: 'https://provider.example.test/v1/endpoint', model: 'synthetic-model' } : null;
  const profiles = { getBestProfile: async () => null } as never;
  const media = new Hono();
  media.route('/lobu', createImageRoutes(new ImageGenerationService(profiles, source as never)));
  media.route('/lobu', createAudioRoutes(new TranscriptionService(profiles, undefined, source as never)));
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    configured = true;
    provider.mockClear();
    globalThis.fetch = provider as unknown as typeof fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  function mediaCall(path: string, token: string, body: unknown) {
    return media.request('/lobu' + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it.each([
    ['generate_image', '/internal/images/generate', { prompt: 'a lighthouse' }],
    ['generate_audio', '/internal/audio/synthesize', { text: 'hello there' }],
  ])('%s: a failure after the provider call keeps the claim, so the repeat is not re-billed', async (_name, path, body) => {
    const failed = await mediaCall(path, (await turn(`receipts-${path}-lost`)).token, body);
    // 500, not 502: the CDN replaces a 502 body, which would drop this error.
    expect(failed.status, await failed.clone().text()).toBe(500);
    expect((await failed.json()).error).toContain('connection reset');
    const repeat = await mediaCall(path, (await turn(`receipts-${path}-lost`)).token, body);
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).error).toContain('already attempted');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await getTestDb()`SELECT state FROM turn_write_receipts WHERE surface = ${path.endsWith('generate') ? 'images.generate' : 'audio.synthesize'}`).toEqual([{ state: 'claimed' }]);
  });

  it.each([
    ['generate_image', '/internal/images/generate', { prompt: 'a lighthouse' }],
    ['generate_audio', '/internal/audio/synthesize', { text: 'hello there' }],
  ])('%s: a refusal before the provider call releases the claim', async (_name, path, body) => {
    configured = false;
    const refused = await mediaCall(path, (await turn(`receipts-${path}-unconfigured`)).token, body);
    expect(refused.status).toBe(400);
    expect(await getTestDb()`SELECT 1 FROM turn_write_receipts`).toHaveLength(0);
    configured = true;
    provider.mockResolvedValueOnce(path.endsWith('generate')
      ? Response.json({ data: [{ b64_json: 'AQID' }] })
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const retry = await mediaCall(path, (await turn(`receipts-${path}-unconfigured`)).token, body);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('send_message: a reply in the asking conversation vs a post elsewhere', () => {
  const sql = () => getTestDb();
  async function rule(effect: 'auto' | 'approval' | 'deny') {
    const [policy] = await sql()<{ id: number }>`
      INSERT INTO write_approval_policies (organization_id, resource_class, principal_kind, principal_id, operation_key, connector_key)
      VALUES (${org.id}, 'connector_action', NULL, NULL, ${qualifiedOperationKey('slack', 'send_message')}, 'slack') RETURNING id
    `;
    await sql()`INSERT INTO write_policy_action_effects (policy_id, action, effect) VALUES (${policy!.id}, 'execute', ${effect})`;
  }
  const sendRuns = () => sql()<{ id: number; status: string; approval_status: string; action_input: Record<string, unknown> }>`
    SELECT id, status, approval_status, action_input FROM runs
    WHERE organization_id = ${org.id} AND action_key = 'send_message' ORDER BY id
  `;

  beforeEach(async () => {
    await sql()`DELETE FROM write_approval_policies WHERE organization_id = ${org.id} AND connector_key = 'slack'`;
  });

  it('a reply into the asking thread posts directly and is reported as delivered in band', async () => {
    const res = await call('/internal/conversations/send', (await turn('p3-reply-1')).token, { target, text: 'in the thread' });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(body.deliveredInBand).toBe(true);
    expect(await sendRuns()).toHaveLength(0);
  });

  it('a post elsewhere is held for approval, posts once when approved, and a repeat answers with the run', async () => {
    const asked = await turn('p3-ask-1');
    const held = await call('/internal/conversations/send', asked.token, { target: channelTarget, text: 'to the whole channel' });
    const heldBody = await held.json();
    expect(held.status, JSON.stringify(heldBody)).toBe(409);
    expect(heldBody).toMatchObject({ code: 'PENDING_APPROVAL', run_id: expect.any(Number) });
    expect(heldBody.error).toBe(`Held for approval (run ${heldBody.run_id}): ${heldBody.approval_url}. Not sent; do not resend.`);
    expect(posted).not.toHaveBeenCalled();
    const [run] = await sendRuns();
    // The stored destination is the bare channel id the approver reads.
    expect(run).toMatchObject({ id: heldBody.run_id, approval_status: 'pending' });
    expect(run!.action_input).toEqual({ channel_id: 'C_RECEIPTS', text: 'to the whole channel' });

    // Asking again for the same input finds the same held run.
    const again = await call('/internal/conversations/send', (await turn('p3-ask-1')).token, { target: channelTarget, text: 'to the whole channel' });
    expect(again.status).toBe(409);
    expect((await again.json()).run_id).toBe(heldBody.run_id);
    expect(await sendRuns()).toHaveLength(1);

    const approved = (await manageOperations({ action: 'approve', run_id: heldBody.run_id }, {} as Env, ownerToolContext(org.id, owner.id))) as Record<string, unknown>;
    expect(approved.error, JSON.stringify(approved)).toBeUndefined();
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith(CONNECTION, expect.objectContaining({ channelId: 'C_RECEIPTS', threadId: undefined, threadFallback: false }));
    expect((await sendRuns())[0]).toMatchObject({ status: 'completed' });

    const repeat = await call('/internal/conversations/send', (await turn('p3-ask-1')).token, { target: channelTarget, text: 'to the whole channel' });
    expect(repeat.status, await repeat.clone().text()).toBe(200);
    expect(await repeat.json()).toMatchObject({ run_id: heldBody.run_id, deliveredInBand: false });
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it('a blocked post elsewhere is refused and nothing is posted', async () => {
    await rule('deny');
    const res = await call('/internal/conversations/send', (await turn('p3-block-1')).token, { target: channelTarget, text: 'blocked' });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(posted).not.toHaveBeenCalled();
  });

  it('an allowed post elsewhere is sent and recorded as a completed run', async () => {
    await rule('auto');
    const res = await call('/internal/conversations/send', (await turn('p3-auto-1')).token, { target: channelTarget, text: 'allowed' });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ messageId: 'synthetic-post', deliveredInBand: false, run_id: expect.any(Number) });
    expect(posted).toHaveBeenCalledTimes(1);
    expect((await sendRuns()).find((run) => run.id === body.run_id)).toMatchObject({ status: 'completed', approval_status: 'auto' });
  });

  it('a stale or missing connector definition is synced before the send is evaluated', async () => {
    await rule('auto');
    await ensureConnectorInstalled({ organizationId: org.id, connectorKey: 'slack' });
    // Installed before the platform declared send_message.
    await sql()`UPDATE connector_definitions SET actions_schema = actions_schema - 'send_message' WHERE organization_id = ${org.id} AND key = 'slack' AND status = 'active'`;
    const stale = await call('/internal/conversations/send', (await turn('p3-stale-1')).token, { target: channelTarget, text: 'after a stale definition' });
    expect(stale.status, await stale.clone().text()).toBe(200);
    // No active definition at all.
    await sql()`UPDATE connector_definitions SET status = 'archived' WHERE organization_id = ${org.id} AND key = 'slack' AND status = 'active'`;
    const missing = await call('/internal/conversations/send', (await turn('p3-stale-2')).token, { target: channelTarget, text: 'after no definition' });
    expect(missing.status, await missing.clone().text()).toBe(200);
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it('send_message is not directly executable as an operation', async () => {
    await rule('auto');
    const [connection] = await sql()<{ id: number }>`SELECT id FROM connections WHERE organization_id = ${org.id} AND slug = ${`agentconn-${CONNECTION}`}`;
    const result = await handleExecute(
      { action: 'execute', connection_id: Number(connection!.id), operation_key: 'send_message', input: { channel_id: 'C_RECEIPTS', text: 'direct' } },
      ownerToolContext(org.id, owner.id), {} as Env,
    );
    expect((result as { error_code?: string }).error_code).toBe('VALIDATION');
    expect(posted).not.toHaveBeenCalled();
  });

  it('edit is refused outside the asking conversation', async () => {
    const editManager = vi.fn(async () => undefined);
    __setChatInstanceManagerForTests({ postToConversation: posted, editMessage: editManager } as never);
    try {
      const res = await call('/internal/conversations/edit', (await turn('p3-edit-1')).token, { thread: channelTarget, message: '1787292999.000200', text: 'rewritten' });
      expect(res.status, await res.clone().text()).toBe(403);
      expect(editManager).not.toHaveBeenCalled();
    } finally {
      __setChatInstanceManagerForTests({ postToConversation: posted });
    }
  });

  it("a post on another workspace's hosted-preview connection is refused", async () => {
    const host = await createTestOrganization();
    await insertChatConnectionRow({ id: 'p3-preview-conn', organizationId: host.id, agentId: null, platform: 'slack', settings: { previewMode: true }, metadata: {} });
    await createTestAutomationSubscription({ organizationId: org.id, agentId: AGENT, connectionSlug: 'agentconn-p3-preview-conn', platform: 'slack', channelId: 'slack:C_PREVIEW' });
    const preview = (await resolveAddressableTargets(AGENT, org.id)).find((item) => item.channelId === 'C_PREVIEW');
    expect(preview?.crossOrg).toBe(true);
    await rule('auto');
    const res = await call('/internal/conversations/send', (await turn('p3-preview-1')).token, { target: preview!.handle, text: 'borrowed' });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(posted).not.toHaveBeenCalled();
  });
});
