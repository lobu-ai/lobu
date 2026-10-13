/**
 * Assembled Google Chat chat-automation characterization.
 *
 * Fakes stop at Google's network boundary: `chatApi.spaces.messages.*` (the
 * outbound HTTP calls) plus history reads and typing. A Google Chat webhook
 * payload goes through the real Google Chat adapter and Chat SDK, then the
 * real bridge, channel subscription reader, Automation planner, transcript
 * writer and Postgres run queue (`helpers/chat-bridge-harness.ts`, shared
 * with the Slack suite). Completions render through the real
 * `ChatResponseBridge` and default (live-streaming) strategy.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Chat, type StateAdapter } from "chat";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import {
  addUserToOrganization,
  createTestUser,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
} from "../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../db/client.js";
import { getRateLimiter, resetRateLimiterForTests } from "../../utils/rate-limiter.js";
import { UNLINKED_SENDER_TURNS_PER_HOUR } from "../orchestration/chat-turn-actor.js";
import { ChatResponseBridge } from "../connections/chat-response-bridge.js";
import { gchatPlatform } from "../connections/platforms/gchat.js";
import { createConnectedGatewayStateAdapter } from "../connections/state-adapter.js";
import type { PlatformConnection } from "../connections/types.js";
import {
  type AssembledChatBridge,
  startAssembledChatBridge,
  waitFor,
} from "./helpers/chat-bridge-harness.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "org-gchat-e2e";
const AGENT_ID = "agent-gchat-e2e";
const OWNING_AGENT_ID = "agent-gchat-connection-owner";
const RUNTIME_CONNECTION_ID = "gchat-e2e-connection";
const SPACE = "spaces/AAAA-e2e-room";
const DM_SPACE = "spaces/DDDD-e2e-dm";
const THREAD = `${SPACE}/threads/thread-e2e`;

setDefaultTimeout(30_000);

const credentials = JSON.stringify({
  client_email: "lobu-chat@example.iam.gserviceaccount.com",
  private_key: "not-used-by-the-inbound-webhook-test",
  project_id: "lobu-chat-test",
});

const sender = {
  // Google account ids are numeric; a non-numeric one can never be linked.
  name: "users/100000000000000000001",
  displayName: "Space Sender",
  email: "space.sender@example.test",
  type: "HUMAN",
};

const stranger = {
  name: "users/100000000000000000002",
  displayName: "Space Stranger",
  email: "space.stranger@example.test",
  type: "HUMAN",
};

function spaceMention(
  messageId: string,
  text: string,
  from: typeof sender = sender,
): Record<string, unknown> {
  const space = { name: SPACE, type: "ROOM", spaceType: "SPACE" };
  return {
    type: "MESSAGE",
    eventTime: "2026-10-12T12:00:00Z",
    space,
    user: from,
    message: {
      name: `${SPACE}/messages/${messageId}`,
      createTime: "2026-10-12T12:00:00Z",
      text: `@Lobu ${text}`,
      argumentText: ` ${text}`,
      sender: from,
      space,
      thread: { name: THREAD },
      annotations: [
        {
          type: "USER_MENTION",
          startIndex: 0,
          length: 5,
          userMention: {
            user: { name: "users/lobu-bot", displayName: "Lobu", type: "BOT" },
            type: "MENTION",
          },
        },
      ],
    },
  };
}

function directMessage(messageId: string, text: string): Record<string, unknown> {
  const space = { name: DM_SPACE, type: "DM", spaceType: "DIRECT_MESSAGE" };
  return {
    type: "MESSAGE",
    eventTime: "2026-10-12T12:00:00Z",
    space,
    user: sender,
    message: {
      name: `${DM_SPACE}/messages/${messageId}`,
      createTime: "2026-10-12T12:00:00Z",
      text,
      sender,
      space,
    },
  };
}

function webhook(body: Record<string, unknown>): Request {
  return new Request(`https://gateway.example.test/api/v1/webhooks/${RUNTIME_CONNECTION_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Google Chat event -> chat Automation -> Google Chat reply", () => {
  let chat: Chat;
  let state: StateAdapter;
  let bridge: AssembledChatBridge;
  let connectionDbId: number;
  let created: Array<Record<string, any>>;
  let updated: Array<Record<string, any>>;

  /** Deliver a webhook and wait for the SDK's background dispatch. */
  async function deliver(body: Record<string, unknown>): Promise<number> {
    const tasks: Promise<unknown>[] = [];
    const response = await chat.webhooks.gchat(webhook(body), {
      waitUntil: (task) => tasks.push(task),
    });
    await Promise.all(tasks);
    return response.status;
  }

  async function start(connectionAgentId: string | null): Promise<void> {
    await insertChatConnectionRow({
      id: RUNTIME_CONNECTION_ID,
      organizationId: ORG_ID,
      platform: "gchat",
      agentId: connectionAgentId,
      settings: { allowGroups: true },
    });
    const [row] = await getDb()<{ id: number }[]>`
      SELECT id FROM connections WHERE organization_id = ${ORG_ID} AND connector_key = 'gchat'
    `;
    if (!row) throw new Error("Google Chat connection was not seeded");
    connectionDbId = Number(row.id);

    state = await createConnectedGatewayStateAdapter();
    const adapter: any = await gchatPlatform.createAdapter({
      credentials,
      disableSignatureVerification: true,
      userName: "lobu",
    });
    created = [];
    updated = [];
    resetRateLimiterForTests();
    adapter.chatApi.spaces.messages.create = mock(async (request: Record<string, any>) => {
      created.push(request);
      return { data: { name: `${request.parent}/messages/bot-${created.length}` } };
    });
    adapter.chatApi.spaces.messages.update = mock(async (request: Record<string, any>) => {
      updated.push(request);
      return { data: { name: request.name } };
    });
    adapter.fetchMessages = mock(async () => ({ messages: [] }));
    adapter.startTyping = mock(async () => undefined);
    chat = new Chat({
      userName: "lobu",
      adapters: { gchat: adapter },
      state,
      logger: "silent",
    });
    const connection: PlatformConnection = {
      id: RUNTIME_CONNECTION_ID,
      platform: "gchat",
      organizationId: ORG_ID,
      ...(connectionAgentId ? { agentId: connectionAgentId } : {}),
      config: { platform: "gchat", credentials, disableSignatureVerification: true },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    bridge = await startAssembledChatBridge(chat, state, connection);
  }

  /**
   * Link the space, deliver one mention, and return the terminal-row payload
   * the worker would publish for the queued turn.
   */
  async function queueLinkedSpaceTurn(messageId: string) {
    await start(null);
    await createTestAutomationSubscription({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      connectionId: connectionDbId,
      platform: "gchat",
      channelId: SPACE,
    });
    expect(await deliver(spaceMention(messageId, "status?"))).toBe(200);
    let input: Record<string, any> = {};
    await waitFor(async () => {
      const [row] = await getDb()<{ action_input: Record<string, any> }[]>`
        SELECT action_input FROM runs WHERE run_type = 'chat_message'
      `;
      expect(row).toBeDefined();
      input = row!.action_input;
    });
    return {
      messageId: String(input.messageId),
      channelId: String(input.channelId),
      conversationId: String(input.conversationId),
      userId: String(input.userId),
      teamId: String(input.teamId ?? ""),
      platform: "gchat",
      timestamp: Date.now(),
      platformMetadata: input.platformMetadata,
    };
  }

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT_ID, { organizationId: ORG_ID });
    await seedAgentRow(OWNING_AGENT_ID, { organizationId: ORG_ID });
    // The suite's sender is a linked member, so these tests characterize
    // ingress and delivery, not sender authority. An unlinked sender in this
    // private org is reply-only and gets the access notice (tested below).
    const member = await createTestUser({});
    await addUserToOrganization(member.id, ORG_ID, "member");
    await linkChatIdentityInGraph({
      organizationId: ORG_ID,
      userId: member.id,
      platform: "gchat",
      platformUserId: sender.name,
    });
  });

  afterEach(async () => {
    await bridge?.stop();
  });

  test("a linked space mention queues one turn in its thread; a redelivery does not queue another", async () => {
    await start(null);
    await createTestAutomationSubscription({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      connectionId: connectionDbId,
      platform: "gchat",
      channelId: SPACE,
    });

    const event = spaceMention("inbound-1", "summarize the thread");
    expect(await deliver(event)).toBe(200);

    const sql = getDb();
    let threadId = "";
    await waitFor(async () => {
      const rows = await sql<{ organization_id: string; action_input: Record<string, any> }[]>`
        SELECT organization_id, action_input FROM runs WHERE run_type = 'chat_message'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBe(ORG_ID);
      expect(rows[0]?.action_input).toMatchObject({
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        platform: "gchat",
        // The Google user resource is the turn's userId — the platform sender,
        // not a Lobu user (see integration/mcp/chat-turn-principal.test.ts).
        userId: sender.name,
        channelId: `gchat:${SPACE}`,
        messageId: expect.stringContaining(`${SPACE}/messages/inbound-1:automation:`),
        messageText: expect.stringContaining("summarize the thread"),
        platformMetadata: {
          connectionId: RUNTIME_CONNECTION_ID,
          automationId: expect.any(Number),
          senderId: sender.name,
          senderDisplayName: sender.displayName,
        },
      });
      threadId = String(rows[0]?.action_input.conversationId);
    });
    // The turn's conversation is the Google thread, not the space.
    expect(threadId.startsWith(`gchat:${SPACE}:`)).toBe(true);
    expect(threadId).not.toBe(`gchat:${SPACE}`);

    await waitFor(async () => {
      const transcript = await sql`
        SELECT platform_message_id, author_id FROM channel_messages
        WHERE organization_id = ${ORG_ID} AND connection_id = ${RUNTIME_CONNECTION_ID}
      `;
      expect(transcript).toEqual([
        { platform_message_id: `${SPACE}/messages/inbound-1`, author_id: sender.name },
      ]);
    });

    // Google retries the same message resource: Chat SDK's message-id dedupe
    // admits it once, so neither the run nor the transcript row is duplicated.
    expect(await deliver(event)).toBe(200);
    expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
    expect(await sql`SELECT id FROM channel_messages WHERE connection_id = ${RUNTIME_CONNECTION_ID}`).toHaveLength(1);
    // Nothing was posted back to Google during ingress.
    expect(created).toEqual([]);
  });

  // Google Chat installs carry no authoritative domain, so the platform vouches
  // for no unlinked sender: in a private org the stranger is reply-only.
  test("an unlinked stranger in a private org gets one access notice per window and a reply-only turn", async () => {
    await start(null);
    await createTestAutomationSubscription({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      connectionId: connectionDbId,
      platform: "gchat",
      channelId: SPACE,
    });

    expect(await deliver(spaceMention("stranger-1", "who are you?", stranger))).toBe(200);
    const sql = getDb();
    await waitFor(async () => {
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.parent).toBe(SPACE);
    expect(String(created[0]?.requestBody?.text)).toContain("Ask an admin of this workspace to invite you");
    const [run] = await sql<{ action_input: Record<string, any> }[]>`
      SELECT action_input FROM runs WHERE run_type = 'chat_message'
    `;
    // Google Chat supplies no same-tenant evidence, so none is stamped.
    expect(run?.action_input.platformMetadata.senderVouched).toBeUndefined();

    // A second message inside the notice window gets a turn but no second notice.
    expect(await deliver(spaceMention("stranger-2", "still there?", stranger))).toBe(200);
    await waitFor(async () => {
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(2);
    });
    expect(created).toHaveLength(1);

    // Another replica (a fresh limiter with no cache of its own) shares the
    // window through Postgres: it must not post the notice again either.
    await getRateLimiter().flushPendingWrites();
    resetRateLimiterForTests();
    expect(await deliver(spaceMention("stranger-3", "anyone?", stranger))).toBe(200);
    await waitFor(async () => {
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(3);
    });
    expect(created).toHaveLength(1);
  });

  test("an unlinked sender over the hourly turn limit gets no turn", async () => {
    await start(null);
    await createTestAutomationSubscription({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      connectionId: connectionDbId,
      platform: "gchat",
      channelId: SPACE,
    });
    const limiter = getRateLimiter();
    const key = `chat-unlinked-turn:${ORG_ID}:gchat:${stranger.name}`;
    for (let i = 0; i < UNLINKED_SENDER_TURNS_PER_HOUR; i += 1) {
      expect(limiter.checkLimit(key, { limit: UNLINKED_SENDER_TURNS_PER_HOUR, windowSeconds: 3600 }).allowed).toBe(true);
    }
    // The budget was spent on another replica: this one only sees it through
    // the shared counter, never through its own (empty) cache.
    await limiter.flushPendingWrites();
    resetRateLimiterForTests();

    expect(await deliver(spaceMention("stranger-over", "one more", stranger))).toBe(200);
    const sql = getDb();
    // The ingress transcript row lands before the gate, so wait on it.
    await waitFor(async () => {
      expect(await sql`SELECT id FROM channel_messages WHERE connection_id = ${RUNTIME_CONNECTION_ID}`).toHaveLength(1);
    });
    expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(0);
    expect(created).toEqual([]);

    // A linked member is never limited: in a space their turn is org_shared,
    // like a vouched stranger's, but the limit is keyed on being unlinked.
    const memberKey = `chat-unlinked-turn:${ORG_ID}:gchat:${sender.name}`;
    for (let i = 0; i < UNLINKED_SENDER_TURNS_PER_HOUR; i += 1) {
      getRateLimiter().checkLimit(memberKey, { limit: UNLINKED_SENDER_TURNS_PER_HOUR, windowSeconds: 3600 });
    }
    expect(await deliver(spaceMention("member-ok", "status?"))).toBe(200);
    await waitFor(async () => {
      expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
    });
  });

  test("an unlinked DM on an agentless connection posts the link notice and queues nothing", async () => {
    await start(null);
    expect(await deliver(directMessage("dm-unlinked-1", "hello?"))).toBe(200);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.parent).toBe(DM_SPACE);
    expect(created[0]?.requestBody?.thread).toBeUndefined();
    expect(String(created[0]?.requestBody?.text)).toContain("link");
    const sql = getDb();
    expect(await sql`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(0);
    expect(await sql`SELECT id FROM channel_messages WHERE connection_id = ${RUNTIME_CONNECTION_ID}`).toHaveLength(0);
  });

  // CURRENT: the connection's own `agent_id` answers an unmatched DM without
  // materializing an Automation.
  test("a DM with no Automation falls back to the connection's owning agent", async () => {
    await start(OWNING_AGENT_ID);
    expect(await deliver(directMessage("dm-owner-1", "what's on my plate"))).toBe(200);

    const sql = getDb();
    await waitFor(async () => {
      const rows = await sql<{ action_input: Record<string, any> }[]>`
        SELECT action_input FROM runs WHERE run_type = 'chat_message'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action_input).toMatchObject({
        agentId: OWNING_AGENT_ID,
        organizationId: ORG_ID,
        userId: sender.name,
        channelId: `gchat:${DM_SPACE}`,
        conversationId: `gchat:${DM_SPACE}:dm`,
        messageId: `${DM_SPACE}/messages/dm-owner-1`,
        platformMetadata: {
          connectionId: RUNTIME_CONNECTION_ID,
          isDirect: true,
          responseChannel: `gchat:${DM_SPACE}`,
          responseThreadId: `gchat:${DM_SPACE}:dm`,
        },
      });
      expect(rows[0]?.action_input.platformMetadata.automationId).toBeUndefined();
    });
    expect(created).toEqual([]);
    // A DM fallback does not materialize a chat-link Automation.
    expect(await sql`SELECT id FROM automations WHERE organization_id = ${ORG_ID}`).toHaveLength(0);
  });

  test("a completion streams the reply into the originating Google thread", async () => {
    const payload = await queueLinkedSpaceTurn("inbound-reply");
    const responses = new ChatResponseBridge(bridge.manager as never);
    await responses.handleDelta({ ...payload, delta: "All green. " }, "s");
    await responses.handleDelta({ ...payload, delta: "Nothing blocked." }, "s");
    await responses.handleCompletion({ ...payload, finalText: "All green. Nothing blocked." }, "s");

    // Chat SDK's post-then-edit stream fallback: one placeholder message in
    // the inbound thread, then edited in place to the streamed text.
    await waitFor(() =>
      expect(updated.at(-1)?.requestBody?.text).toBe("All green. Nothing blocked."),
    );
    expect(created).toEqual([
      {
        parent: SPACE,
        messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
        requestBody: { text: "...", thread: { name: THREAD } },
      },
    ]);
    // Intermediate edits are throttle-timing dependent; every edit targets the
    // one placeholder and the last carries the complete reply.
    for (const edit of updated) {
      expect(edit).toMatchObject({ name: `${SPACE}/messages/bot-1`, updateMask: "text,cardsV2" });
    }
  });

  // CURRENT (known gap): under N>1 replicas the `thread_response` rows are
  // claimed competitively. For agents without output guardrails, Google Chat's
  // live-streaming path does not deliver `finalText` on a replica with no local
  // stream. Guardrail-enabled turns have a separate final-text delivery path;
  // Slack's strategy also consumes finalText without a local stream.
  test("without output guardrails, a completion on a replica with no deltas posts nothing", async () => {
    const payload = await queueLinkedSpaceTurn("inbound-crosspod");

    // Replica B claims only the terminal row.
    const replicaB = new ChatResponseBridge(bridge.manager as never);
    await replicaB.handleCompletion({ ...payload, finalText: "The full answer." }, "s");
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
});
