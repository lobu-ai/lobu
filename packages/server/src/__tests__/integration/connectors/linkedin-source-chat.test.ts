/**
 * LinkedIn direct messages, end to end through production code.
 *
 * The paired browser delivers a message REFERENCE (never its body) to the
 * `live_messages` source feed. The real RunsQueue worker runs the ingress job:
 * it hydrates the stored connection, reads the message back through the live
 * feed read (bundled `linkedin` connector, compiled) by `id:<message URN>`,
 * lets the LinkedIn adapter accept or refuse the row, and hands it to the chat
 * bridge. The agent's completion goes out as exactly one `send_message`, keyed
 * so a retry adopts the first send.
 *
 * Only the operation boundary is faked: the Chrome actions the connector
 * dispatches to the paired browser, and the `send_message` operation.
 */

import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { CommandRegistry, verifyWorkerToken } from "@lobu/core";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import { ChatResponseBridge } from "../../../gateway/connections/chat-response-bridge";
import { handleChatSourceIngress } from "../../../gateway/connections/chat-source-ingress";
import { connectorTransportPlatforms } from "../../../gateway/connections/platforms/index";
import { mintTurnToken } from "../../../gateway/orchestration/agent-turn-producer";
import { RunsQueue } from "../../../gateway/infrastructure/queue/runs-queue";
import type { QueueJob } from "../../../gateway/infrastructure/queue/types";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { CHAT_SOURCE_INGRESS_QUEUE, type ChatSourceIngressJob } from "../../../runs/chat-ingress-jobs";
import { receiveFeedNotifications } from "../../../runs/feed-notifications";
import { sourceFeedScopeKey } from "../../../runs/source-feed-subscriptions";
import * as executeHandler from "../../../tools/admin/manage_operations/handlers/execute";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { upsertBundledConnectorForOrg } from "../../../utils/ensure-connector-installed";
import { resetRateLimiterForTests } from "../../../utils/rate-limiter";
import * as chromeDispatch from "../../../worker-api/dispatch-chrome-action";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
} from "../../setup/test-fixtures";

const SELF = "urn:li:fsd_profile:ACoAASyntheticSelf";
/** The signed-in account the connector's account probe reports. */
const ACCOUNT_ID = "urn:li:fs_miniProfile:ACoAASyntheticSelf";
const DM_THREAD = "2-c3ludGhldGljLWRt==";
const GROUP_THREAD = "2-c3ludGhldGljLWdyb3Vw==";
/** A linked member's LinkedIn member id. */
const MEMBER_ID = "ACoAASyntheticMember";
/** A LinkedIn account no member has linked. */
const STRANGER_ID = "ACoAASyntheticStranger";
const BASE_TIME = 1_787_358_200;

interface InboxMessage {
  id: string;
  thread: string;
  text: string;
  sender?: string;
  from_me?: boolean;
  is_group?: boolean | null;
  content_kind?: string;
}

let sql: ReturnType<typeof getTestDb>;
let orgId: string;
let ownerId: string;
let memberId: string;
let deviceId: string;
let connectionId: number;
let feedId: number;
let agentId: string;
let version: string;
let manager: ChatInstanceManager;
let queue: RunsQueue | null = null;
let inbox: InboxMessage[];
let reads: string[];
let failNextSend: boolean;
let enqueued: Array<Record<string, any>>;
let sends: Array<{ input: Record<string, unknown>; idempotencyKey?: string }>;

const messageUrn = (id: string) => `urn:li:msg_message:(${SELF},${id})`;

/** The row the connector's page program returns for one inbox message. */
function row(message: InboxMessage, index: number) {
  const sender = message.from_me ? SELF : `urn:li:fsd_profile:${message.sender ?? MEMBER_ID}`;
  return {
    id: messageUrn(message.id),
    conversation_id: `urn:li:msg_conversation:(${SELF},${message.thread})`,
    thread_id: message.thread,
    is_group: message.is_group === undefined ? message.thread === GROUP_THREAD : message.is_group,
    conversation_url: `https://www.linkedin.com/messaging/thread/${message.thread}/`,
    text: message.text,
    recalled: false,
    content_kind: message.content_kind ?? "text",
    source_revision: "a".repeat(64),
    has_attachments: false,
    sender_id: sender,
    sender_member_id: sender.slice("urn:li:fsd_profile:".length),
    sender_slug: message.from_me ? null : "synthetic-sender",
    sender_name: message.from_me ? "Lobu" : "Synthetic Sender",
    from_me: message.from_me === true,
    occurred_at: new Date((BASE_TIME + index) * 1000).toISOString(),
  };
}

/** The paired LinkedIn tab, answering the connector's generic Chrome actions. */
function fakeLinkedInTab(params: { actionKey: string; actionInput: Record<string, unknown> }) {
  const done = (output: Record<string, unknown>) => ({ status: "completed" as const, output });
  if (params.actionKey === "navigate") return done({ tab_id: 7 });
  if (params.actionKey !== "evaluate") throw new Error(`unexpected chrome action ${params.actionKey}`);
  const expression = String(params.actionInput.expression);
  const marker = "__lobuLinkedInInboxV1.read(";
  const at = expression.indexOf(marker);
  // The connection's verified-account probe, before any source read.
  if (at < 0 && expression.includes("/voyager/api/me")) return done({ value: { accountId: ACCOUNT_ID } });
  if (at < 0) throw new Error("unexpected LinkedIn page operation");
  const argument = expression.slice(at + marker.length, expression.lastIndexOf("); })()"));
  // The connector passes its input as an inert JSON.parse literal.
  const input = new Function(`return ${argument};`)() as Record<string, unknown>;
  expect(input.feed).toBe("live_messages");
  reads.push(String(input.query));
  const id = String(input.query).slice("id:".length);
  const rows = inbox
    .map((message, index) => row(message, index))
    .filter((candidate) => candidate.id === id);
  return done({ value: { rows, hasMore: false } });
}

async function insertAutomation(slug: string, ...triggers: Array<Record<string, unknown>>): Promise<number> {
  const [{ id }] = await sql`SELECT nextval('automations_id_seq') AS id`;
  const automationId = Number(id);
  const configuredAt = new Date((BASE_TIME - 60) * 1000).toISOString();
  await sql`INSERT INTO automations (id, organization_id, slug, name, status, created_by, automation_group_id, managed_agent_id, created_at, updated_at, triggers)
    VALUES (${automationId}, ${orgId}, ${slug}, ${slug}, 'active', ${ownerId}, ${automationId}, ${agentId},
      ${configuredAt}::timestamptz, ${configuredAt}::timestamptz,
      ${sql.json(triggers.map((trigger) => ({ kind: "event", connector_key: "linkedin", connection_id: connectionId,
        event_types: ["message.created"], execution: "turn", active_run: "queue", ...trigger })))})`;
  const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
    VALUES (${automationId}, 1, ${slug}, 'Answer the sender.', ${ownerId}) RETURNING id`;
  await sql`UPDATE automations SET current_version_id = ${version.id} WHERE id = ${automationId}`;
  return automationId;
}

const replyTo = (match?: Record<string, unknown>) =>
  ({ output: "reply_to_source", ...(match ? { match } : {}) });

/** The browser's reference delivery for messages, in source order. */
async function deliver(messageIds: string | string[], notificationId = "n-1") {
  const ids = (typeof messageIds === "string" ? [messageIds] : messageIds).map(messageUrn);
  const [receipt] = await receiveFeedNotifications(sql, [{
    feed_id: feedId, connection_id: connectionId, feed_key: "live_messages",
    notification_id: notificationId, changed: true,
    subscription: {
      scope_key: sourceFeedScopeKey({}, version), binding_id: "synthetic-binding",
      epoch: "synthetic-epoch", needs_rebind: false,
      records: [{ revision: 1, payload: { id: `batch-${ids.join("-")}`, events: ids.map((id) => ({
        id, event_type: "message.created", resource_type: "message",
        resource_ref: id, occurred_at: new Date(BASE_TIME * 1000).toISOString(),
      })) } }],
    },
  } as any], deviceId, [orgId]);
  expect(receipt.active).toBe(true);
}

const ingressJobs = () => sql`SELECT id, status, attempts FROM runs
  WHERE organization_id = ${orgId} AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} ORDER BY id`;

const dispositions = async () => (await sql`SELECT run_metadata->>'disposition' AS disposition FROM runs
  WHERE organization_id = ${orgId} AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} ORDER BY id`)
  .map((stored) => stored.disposition);

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

/** The agent answers each dispatched turn; the chat bridge delivers it. */
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

function buildManager(): ChatInstanceManager {
  const built = new ChatInstanceManager();
  const interactions = new EventEmitter();
  Object.assign(built as unknown as Record<string, unknown>, {
    connectionStore: createPostgresAgentConnectionStore({ connectorTransportPlatforms: connectorTransportPlatforms() }),
    publicGatewayUrl: "",
    services: {
      getAppInstallationStore: () => undefined,
      getSecretStore: () => undefined,
      getCommandRegistry: () => new CommandRegistry(),
      getAutomationSubscriptionService: () => undefined,
      getInteractionService: () => interactions,
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "",
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

describe("LinkedIn source chat", () => {
  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    inbox = [];
    reads = [];
    failNextSend = false;
    enqueued = [];
    sends = [];
    resetRateLimiterForTests();
    const org = await createTestOrganization({ name: "LinkedIn source chat" });
    orgId = org.id;
    const owner = await createTestUser({ email: "li-owner@example.test" });
    ownerId = owner.id;
    await addUserToOrganization(ownerId, orgId, "owner");
    const [device] = await sql`INSERT INTO device_workers
      (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${ownerId}, 'synthetic-li-browser', 'chrome-extension', '9.9.0',
        ${sql.json(["browser.debugger", "browser.tabs"])}, 'Synthetic browser', ${orgId}, NOW()) RETURNING id`;
    deviceId = device.id;
    const installed = await upsertBundledConnectorForOrg({ organizationId: orgId, connectorKey: "linkedin" });
    version = installed!.version;
    // The account the owner signed into in the paired browser.
    const browserAccount = await createAuthProfile({ organizationId: orgId, connectorKey: "linkedin",
      displayName: "Synthetic LinkedIn account", profileKind: "browser_session", status: "active", createdBy: ownerId,
      deviceWorkerId: deviceId, authData: { mode: "live", account_id: ACCOUNT_ID, verified_at: new Date().toISOString() } });
    const [connection] = await sql`INSERT INTO connections
      (organization_id, connector_key, slug, status, visibility, device_worker_id, auth_profile_id, created_by)
      VALUES (${orgId}, 'linkedin', 'linkedin', 'active', 'private', ${deviceId}::uuid, ${browserAccount.id}, ${ownerId}) RETURNING id`;
    connectionId = Number(connection.id);
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
      VALUES (${orgId}, ${connectionId}, 'live_messages', 'active', '{}'::jsonb) RETURNING id`;
    feedId = Number(feed.id);
    await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectorKey: "linkedin",
      operationCategory: "read", effects: { execute: "auto" } });
    agentId = (await createTestAgent({ organizationId: orgId, ownerUserId: ownerId })).agentId;
    const member = await createTestUser({ email: "li-member@example.test" });
    memberId = member.id;
    await addUserToOrganization(memberId, orgId, "member");
    await linkChatIdentityInGraph({ organizationId: orgId, userId: memberId, platform: "linkedin", platformUserId: MEMBER_ID });

    vi.spyOn(chromeDispatch, "dispatchChromeActionToExtension").mockImplementation(async (params) =>
      fakeLinkedInTab(params) as any);
    vi.spyOn(executeHandler, "handleExecute").mockImplementation(async (args: any) => {
      if (args.operation_key !== "send_message") throw new Error(`unexpected operation ${args.operation_key}`);
      sends.push({ input: args.input, idempotencyKey: args.idempotency_key });
      if (failNextSend) {
        // The browser may have sent it; only the acknowledgment was lost.
        failNextSend = false;
        throw new Error("synthetic send timeout");
      }
      return { action: "execute", status: "completed",
        output: { sent: true, message_id: messageUrn(`sent-${sends.length}`), conversation_id: args.input.conversation_id } } as any;
    });
    manager = buildManager();
    await startWorker();
  }, 120_000);

  afterEach(async () => {
    vi.useRealTimers();
    await queue?.stop();
    queue = null;
    resetRateLimiterForTests();
    vi.restoreAllMocks();
  });

  afterAll(cleanupTestDatabase);

  it("joins the chat store only because the built-in declares a reply-capable event", async () => {
    const [definition] = await sql`SELECT automation_events FROM connector_definitions
      WHERE organization_id = ${orgId} AND key = 'linkedin' AND status = 'active'`;
    expect(definition.automation_events).toContainEqual(expect.objectContaining({
      key: "message.created", capabilities: { replyToSource: true },
    }));
    expect(connectorTransportPlatforms()).toContain("linkedin");
    const stored = await createPostgresAgentConnectionStore({ connectorTransportPlatforms: connectorTransportPlatforms() })
      .getConnection(String(connectionId));
    expect(stored).toMatchObject({ id: String(connectionId), platform: "linkedin" });
  }, 60_000);

  it("answers a linked member's DM as that member with exactly one keyed send_message", async () => {
    await insertAutomation("dm-reply", replyTo());
    inbox.push({ id: "SYNTHDM1", thread: DM_THREAD, text: "are you around?" });

    await deliver("SYNTHDM1");
    await drain();
    expect(reads).toEqual([`id:${messageUrn("SYNTHDM1")}`]);
    expect(await dispositions()).toEqual(["admitted"]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ agentId, platform: "linkedin",
      messageText: expect.stringContaining("are you around?") });
    const [claimed] = await sql`INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
      VALUES (${orgId}, 'chat_message', 'messages', 'claimed', ${sql.json(enqueued[0])}) RETURNING id`;
    expect(verifyWorkerToken(await mintTurnToken(enqueued[0] as any, Number(claimed.id))))
      .toMatchObject({ userId: MEMBER_ID, chatAccess: "member", actorUserId: memberId });

    await completeTurns("**Yes**, around all afternoon.");
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toEqual({
      conversation_id: DM_THREAD,
      // LinkedIn renders no markdown.
      text: "Yes, around all afternoon.",
      idempotency_key: sends[0].idempotencyKey,
    });
    expect(sends[0].idempotencyKey).toMatch(/^chat-post:/);
  }, 60_000);

  it("retries a failed send under the same idempotency key", async () => {
    await insertAutomation("dm-reply", replyTo());
    inbox.push({ id: "SYNTHDM2", thread: DM_THREAD, text: "/clear" });
    failNextSend = true;

    await deliver("SYNTHDM2");
    await drain();
    expect(sends.length).toBeGreaterThan(1);
    expect(new Set(sends.map((send) => send.idempotencyKey)).size).toBe(1);
    expect(new Set(sends.map((send) => send.input.idempotency_key)).size).toBe(1);
  }, 60_000);

  it("does not answer a redelivered reference twice", async () => {
    await insertAutomation("dm-reply", replyTo());
    inbox.push({ id: "SYNTHDM3", thread: DM_THREAD, text: "once please" });

    await deliver("SYNTHDM3", "first");
    await drain();
    await deliver("SYNTHDM3", "replayed");
    await drain();
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(sends).toHaveLength(1);
  }, 60_000);

  it.each([
    ["the account's own message", { from_me: true }],
    ["a group message", { thread: GROUP_THREAD }],
    ["a conversation LinkedIn did not identify as 1:1", { is_group: null }],
    ["an attachment-only message", { content_kind: "media" }],
    ["a recalled message", { content_kind: "revoked", text: "" }],
  ])("never answers %s", async (_, overrides) => {
    await insertAutomation("dm-reply", replyTo());
    inbox.push({ id: "SYNTHNA1", thread: DM_THREAD, text: "hello", ...overrides });

    await deliver("SYNTHNA1");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(await dispositions()).toEqual(["not_answerable"]);
  }, 60_000);

  it("stays silent in a conversation no reply Automation matches", async () => {
    await insertAutomation("one-thread", replyTo({ channel_id: "2-c29tZW9uZS1lbHNl==" }));
    inbox.push({ id: "SYNTHDM4", thread: DM_THREAD, text: "hi" });

    await deliver("SYNTHDM4");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(await dispositions()).toEqual(["no_matching_reply_trigger"]);
  }, 60_000);

  it("answers an unlinked sender reply-only with the link notice in the same conversation", async () => {
    await insertAutomation("dm-reply", replyTo());
    inbox.push({ id: "SYNTHST1", thread: DM_THREAD, text: "who are you?", sender: STRANGER_ID });

    await deliver("SYNTHST1");
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({ conversation_id: DM_THREAD });
    expect(String(sends[0].input.text)).toContain("/connect/chat-identity?token=");
    const [claimed] = await sql`INSERT INTO runs (organization_id, run_type, queue_name, status, action_input)
      VALUES (${orgId}, 'chat_message', 'messages', 'claimed', ${sql.json(enqueued[0])}) RETURNING id`;
    const claims = verifyWorkerToken(await mintTurnToken(enqueued[0] as any, Number(claimed.id)));
    expect(claims).toMatchObject({ userId: STRANGER_ID, chatAccess: "reply_only" });
    expect(claims?.actorUserId).toBeUndefined();
  }, 60_000);
});
