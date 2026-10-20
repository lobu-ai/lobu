/**
 * X direct-message chat, end to end through production code.
 *
 * The paired browser delivers a DM REFERENCE (never its body) to the `x`
 * connector's `live_messages` feed. Reply Automations get one durable ingress
 * job; the real RunsQueue worker reads the message through the live feed read
 * (bundled `x` connector, compiled), lets the X adapter accept or refuse the
 * row, and hands the turn to the chat bridge. The agent's completion goes out
 * as exactly one `send_message`, keyed on the operation's idempotency key.
 *
 * An X sender linked to a member (`x_chat_user_id`) is answered as that member;
 * an unlinked sender is answered reply-only and offered a one-time link.
 * Chrome actions and `send_message` are faked at the operation boundary;
 * link redemption injects the signed-in browser session.
 */

import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { CommandRegistry, verifyWorkerToken } from "@lobu/core";
import { sessionCookieName } from "../../../auth/session-cookie-scope";
import { createChatIdentityRoutes } from "../../../connect/chat-identity-routes";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import { ChatResponseBridge } from "../../../gateway/connections/chat-response-bridge";
import { handleChatSourceIngress } from "../../../gateway/connections/chat-source-ingress";
import { connectorTransportPlatforms } from "../../../gateway/connections/platforms/index";
import { mintTurnToken } from "../../../gateway/orchestration/agent-turn-producer";
import { RunsQueue } from "../../../gateway/infrastructure/queue/runs-queue";
import type { QueueJob } from "../../../gateway/infrastructure/queue/types";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { resolveChatUserIdentity } from "../../../lobu/stores/chat-identity";
import { readChatIdentityLink } from "../../../lobu/stores/chat-identity-link";
import { CHAT_SOURCE_INGRESS_QUEUE, type ChatSourceIngressJob } from "../../../runs/chat-ingress-jobs";
import { receiveFeedNotifications } from "../../../runs/feed-notifications";
import { sourceFeedScopeKey } from "../../../runs/source-feed-subscriptions";
import * as executeHandler from "../../../tools/admin/manage_operations/handlers/execute";
import { upsertBundledConnectorForOrg } from "../../../utils/ensure-connector-installed";
import { resetRateLimiterForTests } from "../../../utils/rate-limiter";
import * as chromeDispatch from "../../../worker-api/dispatch-chrome-action";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

const SELF = "1000000001";
const PEER = "1000000002";
const DM = `${SELF}-${PEER}`;
const OTHER_DM = `${SELF}-1000000003`;
const GROUP = "1000000009";
const BASE_TIME = 1_787_358_200_000;
const ORIGIN = "https://cloud.example.test";

interface DeviceMessage {
  conversation_id: string;
  message_id: string;
  text: string;
  sender_id?: string;
  from_me?: boolean;
  is_request?: boolean;
}

const rowId = (message: DeviceMessage) => `${message.conversation_id}:${message.message_id}`;

let sql: ReturnType<typeof getTestDb>;
let orgId: string;
let ownerId: string;
let deviceId: string;
let connectionId: number;
let feedId: number;
let agentId: string;
let version: string;
let manager: ChatInstanceManager;
let queue: RunsQueue | null = null;
let deviceMessages: DeviceMessage[];
let enqueued: Array<Record<string, any>>;
let sends: Array<{ input: Record<string, unknown>; idempotencyKey?: string }>;

/** The paired x.com tab, answering the connector's generic Chrome actions. */
function fakeXTab(params: { actionKey: string; actionInput: Record<string, unknown> }) {
  const done = (output: Record<string, unknown>) => ({ status: "completed" as const, output });
  if (params.actionKey === "navigate") {
    return done({ tab_id: 7, current_url: "https://x.com/home" });
  }
  if (params.actionKey !== "evaluate") throw new Error(`unexpected chrome action ${params.actionKey}`);
  const expression = String(params.actionInput.expression);
  const marker = "globalThis.__lobuXDirectMessagesV1.read(";
  const at = expression.indexOf(marker);
  if (at < 0) throw new Error("unexpected X page call");
  const argument = expression.slice(at + marker.length, expression.lastIndexOf("); })()"));
  const input = new Function(`return ${argument};`)() as { query?: string };
  const id = String(input.query).slice("id:".length);
  const rows = deviceMessages.filter((message) => rowId(message) === id).map((message, index) => ({
    id: rowId(message),
    message_id: message.message_id,
    conversation_id: message.conversation_id,
    conversation_name: null,
    sender_id: message.from_me ? SELF : (message.sender_id ?? PEER),
    sender_handle: "synthetic_peer",
    sender_name: "Synthetic Peer",
    from_me: message.from_me === true,
    is_group: !message.conversation_id.includes("-"),
    is_request: message.is_request === true,
    text: message.text,
    content_kind: message.text ? "text" : "media",
    occurred_at: new Date(BASE_TIME + index * 1000).toISOString(),
  }));
  return done({ value: { rows, hasMore: false } });
}

async function insertAutomation(slug: string, ...triggers: Array<Record<string, unknown>>): Promise<number> {
  const [{ id }] = await sql`SELECT nextval('automations_id_seq') AS id`;
  const automationId = Number(id);
  const configuredAt = new Date(BASE_TIME - 60_000).toISOString();
  await sql`INSERT INTO automations (id, organization_id, slug, name, status, created_by, automation_group_id, managed_agent_id, created_at, updated_at, triggers)
    VALUES (${automationId}, ${orgId}, ${slug}, ${slug}, 'active', ${ownerId}, ${automationId}, ${agentId},
      ${configuredAt}::timestamptz, ${configuredAt}::timestamptz,
      ${sql.json(triggers.map((trigger) => ({ kind: "event", connector_key: "x", connection_id: connectionId,
        event_types: ["message.created"], execution: "turn", active_run: "queue", ...trigger })))})`;
  const [row] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
    VALUES (${automationId}, 1, ${slug}, 'Answer the sender.', ${ownerId}) RETURNING id`;
  await sql`UPDATE automations SET current_version_id = ${row.id} WHERE id = ${automationId}`;
  return automationId;
}

const replyTo = (match?: Record<string, unknown>) =>
  ({ output: "reply_to_source", ...(match ? { match } : {}) });

/** The browser's reference delivery for messages, in source order. */
async function deliver(messages: DeviceMessage | DeviceMessage[], notificationId = "n-1") {
  const ids = (Array.isArray(messages) ? messages : [messages]).map(rowId);
  const [receipt] = await receiveFeedNotifications(sql, [{
    feed_id: feedId, connection_id: connectionId, feed_key: "live_messages",
    notification_id: notificationId, changed: true,
    subscription: {
      scope_key: sourceFeedScopeKey({}, version), binding_id: "synthetic-binding",
      epoch: "synthetic-epoch", needs_rebind: false,
      records: [{ revision: 1, payload: { id: `batch-${ids.join("-")}`, events: ids.map((id) => ({
        id, event_type: "message.created", resource_type: "message",
        resource_ref: id, occurred_at: new Date(BASE_TIME).toISOString(),
      })) } }],
    },
  } as any], deviceId, [orgId]);
  expect(receipt.active).toBe(true);
}

/** The worker token the producer signs for a dispatched turn. */
async function mintedClaims(payload: Record<string, any>) {
  const [input] = await sql`INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
    VALUES (${payload.organizationId}, 'chat_message', 'messages', 'claimed', ${sql.json(payload)}) RETURNING id`;
  const claims = verifyWorkerToken(await mintTurnToken(payload as any, Number(input.id)));
  expect(claims).toBeTruthy();
  return claims!;
}

const ingressJobs = () => sql`SELECT id, status, attempts FROM runs
  WHERE organization_id = ${orgId} AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} ORDER BY id`;

async function startWorker(): Promise<void> {
  queue = new RunsQueue();
  await queue.start();
  await queue.work(CHAT_SOURCE_INGRESS_QUEUE, (job: QueueJob<ChatSourceIngressJob>) =>
    handleChatSourceIngress(manager, job));
}

async function drain(): Promise<void> {
  await expect.poll(async () => (await ingressJobs()).filter((job) =>
    ["pending", "claimed", "running"].includes(job.status)).length, { timeout: 20_000, interval: 100 }).toBe(0);
}

/** The agent answers each dispatched turn; its completion is delivered by the chat bridge. */
async function completeTurns(text = "Reply from the agent"): Promise<void> {
  const bridge = new ChatResponseBridge(manager);
  for (const payload of enqueued.splice(0)) {
    await bridge.handleCompletion({
      messageId: payload.messageId,
      channelId: payload.channelId,
      conversationId: payload.conversationId,
      userId: payload.userId,
      teamId: payload.teamId,
      timestamp: Date.now(),
      platform: payload.platform,
      platformMetadata: payload.platformMetadata,
      finalText: text,
    } as any, "session");
  }
}

/** Sends that are the agent's reply, not the reply-only access notice. */
const replies = () => sends.filter((send) => send.input.text === "Reply from the agent");

function buildManager(): ChatInstanceManager {
  const built = new ChatInstanceManager();
  const interactions = new EventEmitter();
  Object.assign(built as unknown as Record<string, unknown>, {
    connectionStore: createPostgresAgentConnectionStore({ connectorTransportPlatforms: connectorTransportPlatforms() }),
    publicGatewayUrl: ORIGIN,
    services: {
      getAppInstallationStore: () => undefined,
      getSecretStore: () => undefined,
      getCommandRegistry: () => new CommandRegistry(),
      getAutomationSubscriptionService: () => undefined,
      getInteractionService: () => interactions,
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => ORIGIN,
      getQueueProducer: () => ({ enqueueMessage: async (payload: Record<string, any>) => {
        enqueued.push(payload);
      } }),
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getSessionManager: () => undefined,
    },
  });
  return built;
}

describe("X source chat", () => {
  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    deviceMessages = [];
    enqueued = [];
    sends = [];
    resetRateLimiterForTests();
    const org = await createTestOrganization({ name: "X source chat" });
    orgId = org.id;
    const owner = await createTestUser({ email: "x-owner@example.test" });
    ownerId = owner.id;
    await addUserToOrganization(ownerId, orgId, "owner");
    const [device] = await sql`INSERT INTO device_workers
      (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${ownerId}, 'synthetic-x-browser', 'chrome-extension', '9.9.0',
        ${sql.json(["browser.debugger", "browser.tabs"])}, 'Synthetic browser', ${orgId}, NOW()) RETURNING id`;
    deviceId = device.id;
    const installed = await upsertBundledConnectorForOrg({ organizationId: orgId, connectorKey: "x" });
    version = installed!.version;
    const [connection] = await sql`INSERT INTO connections
      (organization_id, connector_key, slug, status, visibility, device_worker_id, created_by)
      VALUES (${orgId}, 'x', 'x-browser', 'active', 'private', ${deviceId}::uuid, ${ownerId}) RETURNING id`;
    connectionId = Number(connection.id);
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
      VALUES (${orgId}, ${connectionId}, 'live_messages', 'active', '{}'::jsonb) RETURNING id`;
    feedId = Number(feed.id);
    await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectorKey: "x",
      operationCategory: "read", effects: { execute: "auto" } });
    agentId = (await createTestAgent({ organizationId: orgId, ownerUserId: ownerId })).agentId;

    vi.spyOn(chromeDispatch, "dispatchChromeActionToExtension").mockImplementation(async (params) =>
      fakeXTab(params) as any);
    vi.spyOn(executeHandler, "handleExecute").mockImplementation(async (args: any) => {
      if (args.operation_key !== "send_message") throw new Error(`unexpected operation ${args.operation_key}`);
      sends.push({ input: args.input, idempotencyKey: args.idempotency_key });
      return { action: "execute", status: "completed", output: { message_id: String(9000 + sends.length) } } as any;
    });
    manager = buildManager();
    await startWorker();
  }, 120_000);

  afterEach(async () => {
    await queue?.stop();
    queue = null;
    __setChatInstanceManagerForTests(undefined);
    resetRateLimiterForTests();
    vi.restoreAllMocks();
  });

  afterAll(cleanupTestDatabase);

  it("answers a DM reference with exactly one send_message keyed on its operation", async () => {
    const replyId = await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: DM, message_id: "5001", text: "hello bot" };
    deviceMessages.push(message);

    await deliver(message);
    const [job] = await ingressJobs();
    const [stored] = await sql`SELECT action_input FROM runs WHERE id = ${job.id}`;
    expect(stored.action_input).toMatchObject({ connectionId, feedId, automationIds: [replyId] });

    await drain();
    expect((await ingressJobs())[0].status).toBe("completed");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ agentId, platform: "x", messageText: expect.stringContaining("hello bot") });

    // An unlinked X sender's turn is reply-only, and the sender is told once,
    // with a one-time link that proves this X account is theirs.
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({ conversation_id: DM });
    expect(String(sends[0].input.text)).toContain("I can't use this workspace's tools for you");
    expect(String(sends[0].input.text)).toContain("/connect/chat-identity?token=");
    expect(await mintedClaims(enqueued[0])).toMatchObject({ userId: PEER, chatAccess: "reply_only" });

    await completeTurns();
    expect(replies()).toHaveLength(1);
    const [reply] = replies();
    expect(reply.input).toEqual({
      conversation_id: DM,
      text: "Reply from the agent",
      idempotency_key: reply.idempotencyKey,
    });
    expect(reply.idempotencyKey).toBeTruthy();
    // Every send carries the key from which the connector derives X's request id.
    for (const send of sends) expect(send.input.idempotency_key).toBe(send.idempotencyKey);
  }, 60_000);

  it("redeems an X DM link and answers the next DM as that workspace's member", async () => {
    const member = await createTestUser({ email: "x-member@example.test" });
    await addUserToOrganization(member.id, orgId, "member");
    const otherOrg = await createTestOrganization({ name: "Other X workspace" });
    await addUserToOrganization(member.id, otherOrg.id, "member");
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: DM, message_id: "5201", text: "link my account" };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(await mintedClaims(enqueued[0])).toMatchObject({ userId: PEER, chatAccess: "reply_only" });
    expect(sends).toHaveLength(1);
    expect(sends[0].input.text).toMatch(/^I can't use this workspace's tools for you yet\. If you're a member, connect your Lobu account: /);
    const token = String(sends[0].input.text).match(/\/connect\/chat-identity\?token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(await readChatIdentityLink(token!)).toMatchObject({
      organizationId: orgId, connectionId: String(connectionId), platform: "x", senderId: PEER,
    });
    await completeTurns();
    sends.length = 0;
    __setChatInstanceManagerForTests(manager);

    const routes = createChatIdentityRoutes({
      session: async () => ({ user: member }),
      origin: () => ORIGIN,
    });
    const response = await routes.request(`${ORIGIN}/connect/chat-identity`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `${sessionCookieName(true)}=synthetic-session`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: token! }).toString(),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Chat account linked");
    expect(await readChatIdentityLink(token!)).toBeNull();
    // The chat hears it too, in the DM the link was offered in, through the
    // same connection's send.
    await expect.poll(() => sends.length, { timeout: 10_000, interval: 50 }).toBe(1);
    expect(sends[0].input).toMatchObject({
      conversation_id: DM,
      text: "You're connected. Messages you send me here now act as you in X source chat.",
    });
    expect(await resolveChatUserIdentity("x", undefined, PEER, orgId)).toBe(member.id);
    expect(await resolveChatUserIdentity("x", undefined, PEER, otherOrg.id)).toBeNull();
    expect(await resolveChatUserIdentity("x", undefined, PEER)).toBeNull();

    sends.length = 0;
    const nextMessage = { conversation_id: DM, message_id: "5202", text: "what's on my list?" };
    deviceMessages.push(nextMessage);
    await deliver(nextMessage, "after-link");
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(sends).toHaveLength(0);
    expect(await mintedClaims(enqueued[0])).toMatchObject({
      userId: PEER, chatAccess: "member", actorUserId: member.id,
    });

    await completeTurns();
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({ conversation_id: DM, text: "Reply from the agent" });
  }, 60_000);

  it("offers a fresh link on the next DM when the notice could not be sent", async () => {
    await insertAutomation("dm-reply", replyTo());
    let failedNotice = "";
    // X refuses the first send (the notice) with a transient over-capacity error.
    vi.mocked(executeHandler.handleExecute).mockImplementationOnce(async (args: any) => {
      failedNotice = String(args.input.text);
      return {
        action: "execute", status: "failed", error: "X direct messages: request failed (HTTP 503, X error 130)",
      } as any;
    });
    const first = { conversation_id: DM, message_id: "5301", text: "who am I?" };
    deviceMessages.push(first);
    await deliver(first);
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(sends).toHaveLength(0);
    expect(failedNotice).toContain("/connect/chat-identity?token=");
    await completeTurns();
    expect(replies()).toHaveLength(1);

    sends.length = 0;
    enqueued.length = 0;
    const second = { conversation_id: DM, message_id: "5302", text: "still there?" };
    deviceMessages.push(second);
    await deliver(second, "after-failed-notice");
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(String(sends[0].input.text)).toContain("/connect/chat-identity?token=");
    expect(sends[0].input.text).not.toBe(failedNotice);
  }, 60_000);

  it("answers a message request like any other DM", async () => {
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: OTHER_DM, message_id: "5101", text: "hi, can you help?", sender_id: "1000000003", is_request: true };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(replies()).toEqual([expect.objectContaining({ input: expect.objectContaining({ conversation_id: OTHER_DM }) })]);
  }, 60_000);

  it("does not answer a redelivered reference twice", async () => {
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: DM, message_id: "5002", text: "once please" };
    deviceMessages.push(message);

    await deliver(message, "first");
    await drain();
    await deliver(message, "replayed");
    await drain();
    expect(await ingressJobs()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(replies()).toHaveLength(1);
  }, 60_000);

  it("never answers the account's own message", async () => {
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: DM, message_id: "5003", text: "sent from my phone", from_me: true };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("never answers a message without text", async () => {
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: DM, message_id: "5004", text: "" };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("stays silent in a conversation no reply Automation matches", async () => {
    await insertAutomation("one-chat-reply", replyTo({ channel_id: OTHER_DM }));
    const message = { conversation_id: DM, message_id: "5005", text: "anyone?" };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("does not reply into a group without an Automation scoped to that group", async () => {
    await insertAutomation("dm-reply", replyTo());
    const message = { conversation_id: GROUP, message_id: "5006", text: "hi all" };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("replies into a group that an Automation is scoped to", async () => {
    await insertAutomation("group-reply", replyTo({ channel_id: GROUP }));
    const message = { conversation_id: GROUP, message_id: "5007", text: "bot, summarize" };
    deviceMessages.push(message);

    await deliver(message);
    await drain();
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(replies()).toHaveLength(1);
    expect(replies()[0].input).toMatchObject({ conversation_id: GROUP, text: "Reply from the agent" });
  }, 60_000);
});
