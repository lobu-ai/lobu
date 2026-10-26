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
import { resolveAddressableTargets } from '../../gateway/conversations/authorization';
import { createAudioRoutes } from '../../gateway/routes/internal/audio';
import { createConversationsRoutes } from '../../gateway/routes/internal/conversations';
import { createFileRoutes } from '../../gateway/routes/internal/files';
import { createImageRoutes } from '../../gateway/routes/internal/images';
import { createInteractionRoutes } from '../../gateway/routes/internal/interactions';
import { __setChatInstanceManagerForTests } from '../../lobu/gateway';
import { pruneTurnWriteReceipts } from '../../tools/turn-write-idempotency';
import { createTestAutomationSubscription } from '../setup/automation-subscriptions';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  insertAgentTurnRun,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
  seedSystemEntityTypes,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const AGENT = 'turn-receipts-agent';
const CONNECTION = 'turn-receipts-connection';
const TEAM = 'T0RECEIPTS';
const SENDER = 'U0RECEIPTS';
const CONVERSATION = 'slack:C_RECEIPTS:1787292000.000100';

let org: Awaited<ReturnType<typeof createTestOrganization>>;
let target: string;
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
  return { token: await mintTurnToken(payload, runId), runId };
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
  await seedSystemEntityTypes();
  org = await createTestOrganization();
  const owner = await createTestUser();
  await addUserToOrganization(owner.id, org.id, 'owner');
  await linkChatIdentityInGraph({ organizationId: org.id, userId: owner.id, platform: 'slack', teamId: TEAM, platformUserId: SENDER });
  await createTestAgent({ organizationId: org.id, agentId: AGENT, ownerUserId: owner.id });
  await insertChatConnectionRow({ id: CONNECTION, organizationId: org.id, agentId: AGENT, platform: 'slack' });
  await createTestAutomationSubscription({ organizationId: org.id, agentId: AGENT, connectionSlug: `agentconn-${CONNECTION}`, platform: 'slack', channelId: 'slack:C_RECEIPTS' });
  await getTestDb()`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'company', 'Company', now(), now())
  `;
  [target] = (await resolveAddressableTargets(AGENT, org.id)).map((item) => item.handle);
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
    await create('receipts-entity-4', 'Taken Co');
    expect(await create('receipts-entity-5', 'Taken Co', true)).toContain('already exists');
    expect(await create('receipts-entity-5', 'Taken Co', true)).toContain('already attempted');
  });

  it('a typed refusal releases its claim, so the retry is refused the same way', async () => {
    const first = await create('receipts-entity-6', 'Typeless Co', true, 'no_such_type');
    expect(first).toContain("Unknown entity type 'no_such_type'");
    expect(await create('receipts-entity-6', 'Typeless Co', true, 'no_such_type')).toEqual(first);
  });
});
