/**
 * WhatsApp Web chat, end to end through production code.
 *
 * A paired device delivers a message REFERENCE (never its body) to the source
 * feed. Reply Automations are taken out of the background queue and get one
 * durable ingress job, committed with the delivery receipt. The real RunsQueue
 * worker runs that job: it hydrates the stored connection, reads the message
 * through the live feed read (bundled `whatsapp.web` connector, compiled), lets
 * the WhatsApp adapter accept or refuse the row, re-matches the Automations on
 * the hydrated chat, and hands the precomputed plan to the chat bridge. The
 * agent's completion then goes out as exactly one `send_message`.
 *
 * Only the operation boundary is faked: the Chrome actions the connector
 * dispatches to the paired browser, and the `send_message` operation.
 */

import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { planAutomationActivationsForRuntimeConnection } from "../../../automations/activation";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { AutomationSubscriptionService } from "../../../gateway/channels/automation-subscription-service";
import { CommandRegistry } from "@lobu/core";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager";
import { ChatResponseBridge } from "../../../gateway/connections/chat-response-bridge";
import { handleChatSourceIngress } from "../../../gateway/connections/chat-source-ingress";
import { connectorTransportPlatforms } from "../../../gateway/connections/platforms/index";
import { RunsQueue } from "../../../gateway/infrastructure/queue/runs-queue";
import type { QueueJob } from "../../../gateway/infrastructure/queue/types";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { CHAT_SOURCE_INGRESS_QUEUE, type ChatSourceIngressJob } from "../../../runs/chat-ingress-jobs";
import { receiveFeedNotifications } from "../../../runs/feed-notifications";
import { sourceFeedScopeKey } from "../../../runs/source-feed-subscriptions";
import * as executeHandler from "../../../tools/admin/manage_operations/handlers/execute";
import { upsertBundledConnectorForOrg } from "../../../utils/ensure-connector-installed";
import * as chromeDispatch from "../../../worker-api/dispatch-chrome-action";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
} from "../../setup/test-fixtures";

const DM_JID = "15550001111@s.whatsapp.net";
const OTHER_DM_JID = "15550003333@s.whatsapp.net";
const GROUP_JID = "120363000000000001@g.us";
const GROUP_SENDER = "15550002222@s.whatsapp.net";
const BASE_TIME = 1_787_358_200;

interface DeviceMessage {
  id: string;
  chat_jid: string;
  body: string;
  from_me?: boolean;
  sender_jid?: string;
}

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
let failNext: "source read" | "turn dispatch" | "send" | null;
let enqueued: Array<Record<string, any>>;
let sends: Array<{ input: Record<string, unknown>; idempotencyKey?: string }>;

/** The paired WhatsApp tab, answering the connector's generic Chrome actions. */
function fakeWhatsAppTab(params: { actionKey: string; actionInput: Record<string, unknown> }) {
  const done = (output: Record<string, unknown>) => ({ status: "completed" as const, output });
  if (params.actionKey === "navigate") return done({ tab_id: 7 });
  if (params.actionKey !== "evaluate") throw new Error(`unexpected chrome action ${params.actionKey}`);
  const expression = String(params.actionInput.expression);
  const marker = "return a.invoke(";
  const at = expression.indexOf(marker);
  if (at < 0) return done({ value: true }); // adapter already installed
  const request = JSON.parse(expression.slice(at + marker.length, expression.lastIndexOf(");")));
  if (request.op === "probe") return done({ value: { ok: true } });
  if (request.op !== "read_messages") throw new Error(`unexpected adapter op ${request.op}`);
  if (failNext === "source read") {
    failNext = null;
    throw new Error("synthetic tab crash");
  }
  const id = String(request.input.query).slice("id:".length);
  const results = deviceMessages
    .filter((message) => message.id === id)
    .map((message, index) => ({ ...message, timestamp: BASE_TIME + index }));
  return done({ value: { ok: true, results, hasMore: false } });
}

async function insertAutomation(slug: string, ...triggers: Array<Record<string, unknown>>): Promise<number> {
  const [{ id }] = await sql`SELECT nextval('automations_id_seq') AS id`;
  const automationId = Number(id);
  await sql`INSERT INTO automations (id, organization_id, slug, name, status, created_by, automation_group_id, managed_agent_id, triggers)
    VALUES (${automationId}, ${orgId}, ${slug}, ${slug}, 'active', ${ownerId}, ${automationId}, ${agentId},
      ${sql.json(triggers.map((trigger) => ({ kind: "event", connector_key: "whatsapp.web", connection_id: connectionId,
        event_types: ["message.created"], execution: "turn", active_run: "queue", ...trigger })))})`;
  const [row] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
    VALUES (${automationId}, 1, ${slug}, 'Answer the sender.', ${ownerId}) RETURNING id`;
  await sql`UPDATE automations SET current_version_id = ${row.id} WHERE id = ${automationId}`;
  return automationId;
}

const replyTo = (match?: Record<string, unknown>) =>
  ({ output: "reply_to_source", ...(match ? { match } : {}) });

/** The device's reference delivery for messages, in source order; new unless `occurredAt` says otherwise. */
async function deliver(messageIds: string | string[], notificationId = "n-1", occurredAt = new Date()) {
  const ids = typeof messageIds === "string" ? [messageIds] : messageIds;
  const [receipt] = await receiveFeedNotifications(sql, [{
    feed_id: feedId, connection_id: connectionId, feed_key: "live_messages",
    notification_id: notificationId, changed: true,
    subscription: {
      scope_key: sourceFeedScopeKey({}, version), binding_id: "synthetic-binding",
      epoch: "synthetic-epoch", needs_rebind: false,
      records: [{ revision: 1, payload: { id: `batch-${ids.join("-")}`, events: ids.map((id) => ({
        id, event_type: "message.created", resource_type: "message",
        resource_ref: id, occurred_at: occurredAt.toISOString(),
      })) } }],
    },
  } as any], deviceId, [orgId]);
  expect(receipt.active).toBe(true);
}

const ingressJobs = () => sql`SELECT id, status, attempts FROM runs
  WHERE organization_id = ${orgId} AND queue_name = ${CHAT_SOURCE_INGRESS_QUEUE} ORDER BY id`;

async function startWorker(): Promise<void> {
  queue = new RunsQueue();
  await queue.start();
  await queue.work(CHAT_SOURCE_INGRESS_QUEUE, (job: QueueJob<ChatSourceIngressJob>) =>
    handleChatSourceIngress(manager, job));
}

/** Wait until every ingress job is terminal. */
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
        if (failNext === "turn dispatch") {
          failNext = null;
          throw new Error("synthetic queue outage");
        }
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

describe("WhatsApp Web source chat", () => {
  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    deviceMessages = [];
    failNext = null;
    enqueued = [];
    sends = [];
    const org = await createTestOrganization({ name: "WhatsApp source chat" });
    orgId = org.id;
    const owner = await createTestUser({ email: "wa-owner@example.test" });
    ownerId = owner.id;
    await addUserToOrganization(ownerId, orgId, "owner");
    const [device] = await sql`INSERT INTO device_workers
      (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at)
      VALUES (${ownerId}, 'synthetic-wa-browser', 'chrome-extension', '9.9.0',
        ${sql.json(["browser.debugger", "browser.tabs"])}, 'Synthetic browser', ${orgId}, NOW()) RETURNING id`;
    deviceId = device.id;
    const installed = await upsertBundledConnectorForOrg({ organizationId: orgId, connectorKey: "whatsapp.web" });
    version = installed!.version;
    const [connection] = await sql`INSERT INTO connections
      (organization_id, connector_key, slug, status, visibility, device_worker_id, created_by)
      VALUES (${orgId}, 'whatsapp.web', 'whatsapp-web', 'active', 'private', ${deviceId}::uuid, ${ownerId}) RETURNING id`;
    connectionId = Number(connection.id);
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
      VALUES (${orgId}, ${connectionId}, 'live_messages', 'active', '{}'::jsonb) RETURNING id`;
    feedId = Number(feed.id);
    await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectorKey: "whatsapp.web",
      operationCategory: "read", effects: { execute: "auto" } });
    agentId = (await createTestAgent({ organizationId: orgId, ownerUserId: ownerId })).agentId;
    // Both senders are known members, so no access notice is ever due.
    for (const [index, jid] of [DM_JID, GROUP_SENDER].entries()) {
      const member = await createTestUser({ email: `wa-member-${index}@example.test` });
      await addUserToOrganization(member.id, orgId, "member");
      await linkChatIdentityInGraph({ organizationId: orgId, userId: member.id, platform: "whatsapp.web", platformUserId: jid });
    }

    vi.spyOn(chromeDispatch, "dispatchChromeActionToExtension").mockImplementation(async (params) =>
      fakeWhatsAppTab(params) as any);
    vi.spyOn(executeHandler, "handleExecute").mockImplementation(async (args: any) => {
      if (args.operation_key !== "send_message") throw new Error(`unexpected operation ${args.operation_key}`);
      sends.push({ input: args.input, idempotencyKey: args.idempotency_key });
      if (failNext === "send") {
        // The device may have sent it; only the acknowledgment was lost.
        failNext = null;
        throw new Error("synthetic send timeout");
      }
      return { action: "execute", status: "completed", output: { message_id: `SENT${sends.length}` } } as any;
    });
    manager = buildManager();
    await startWorker();
  }, 120_000);

  afterEach(async () => {
    await queue?.stop();
    queue = null;
    vi.restoreAllMocks();
  });

  afterAll(cleanupTestDatabase);

  it("answers a DM reference with exactly one send_message", async () => {
    const replyId = await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM1", chat_jid: DM_JID, body: "hello bot" });

    await deliver("SYNTHDM1");
    const [job] = await ingressJobs();
    expect(job).toBeDefined();
    const [stored] = await sql`SELECT action_input FROM runs WHERE id = ${job.id}`;
    expect(stored.action_input).toMatchObject({ connectionId, feedId, automationIds: [replyId] });
    // Reply Automations never run in the background lane.
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`).toHaveLength(0);

    await drain();
    expect((await ingressJobs())[0].status).toBe("completed");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ agentId, messageText: expect.stringContaining("hello bot") });
    await completeTurns();
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toEqual({ chat_jid: DM_JID, text: "Reply from the agent" });
  }, 60_000);

  it.each(["source read", "turn dispatch"] as const)("delivers once when the first attempt fails at the %s", async (stage) => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM2", chat_jid: DM_JID, body: "are you there" });
    failNext = stage;

    await deliver("SYNTHDM2");
    await drain();
    // One failed attempt was spent, and the retry completed the job.
    expect(await ingressJobs()).toEqual([expect.objectContaining({ status: "completed", attempts: 1 })]);
    expect(failNext).toBeNull();
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(sends).toHaveLength(1);
  }, 60_000);

  it("retries a command's confirmation under the same send key", async () => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM11", chat_jid: DM_JID, body: "/clear" });
    failNext = "send";

    await deliver("SYNTHDM11");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends.length).toBeGreaterThan(1);
    expect(new Set(sends.map((send) => send.idempotencyKey)).size).toBe(1);
  }, 60_000);

  it("does not answer a redelivered reference twice", async () => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM3", chat_jid: DM_JID, body: "once please" });

    await deliver("SYNTHDM3", "first");
    await drain();
    await deliver("SYNTHDM3", "replayed");
    await drain();
    expect(await ingressJobs()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(sends).toHaveLength(1);
  }, 60_000);

  it("admits a connection's messages in source order when an earlier one is retried", async () => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push(
      { id: "SYNTHDM8", chat_jid: DM_JID, body: "first" },
      { id: "SYNTHDM9", chat_jid: DM_JID, body: "second" },
    );
    failNext = "source read";

    await deliver(["SYNTHDM8", "SYNTHDM9"]);
    await drain();
    expect(enqueued.map((payload) => payload.messageText)).toEqual([
      expect.stringContaining("first"), expect.stringContaining("second"),
    ]);
  }, 60_000);

  it("stays silent in a chat no reply Automation matches", async () => {
    await insertAutomation("one-chat-reply", replyTo({ channel_id: OTHER_DM_JID }));
    deviceMessages.push({ id: "SYNTHDM4", chat_jid: DM_JID, body: "anyone?" });

    await deliver("SYNTHDM4");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("does not reply into a group without an Automation scoped to that group", async () => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHGR1", chat_jid: GROUP_JID, sender_jid: GROUP_SENDER, body: "hi all" });

    await deliver("SYNTHGR1");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("replies into a group that an Automation is scoped to", async () => {
    await insertAutomation("group-reply", replyTo({ channel_id: GROUP_JID }));
    deviceMessages.push({ id: "SYNTHGR2", chat_jid: GROUP_JID, sender_jid: GROUP_SENDER, body: "bot, summarize" });

    await deliver("SYNTHGR2");
    await drain();
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toEqual({ chat_jid: GROUP_JID, text: "Reply from the agent" });
  }, 60_000);

  it("never answers the account's own message", async () => {
    await insertAutomation("dm-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM5", chat_jid: DM_JID, body: "sent from my phone", from_me: true });

    await deliver("SYNTHDM5");
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("still runs a background Automation once, on the source signal", async () => {
    await insertAutomation("dm-reply", replyTo());
    const backgroundId = await insertAutomation("archive", { output: "silent" });
    deviceMessages.push({ id: "SYNTHDM6", chat_jid: DM_JID, body: "file this" });

    await deliver("SYNTHDM6");
    await drain();
    const runs = await sql`SELECT automation_id, approved_input FROM runs
      WHERE organization_id = ${orgId} AND run_type = 'automation'`;
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].automation_id)).toBe(backgroundId);
    expect(runs[0].approved_input.trigger_signals).toEqual([
      expect.objectContaining({ resource_ref: "SYNTHDM6", connection_id: connectionId }),
    ]);
    expect(enqueued).toHaveLength(1);
    await completeTurns();
    expect(sends).toHaveLength(1);
  }, 60_000);

  it.each([
    ["the scoped chat", DM_JID, { replies: 1, background: 0 }],
    ["any other chat", OTHER_DM_JID, { replies: 0, background: 1 }],
  ] as const)("routes a scoped reply trigger before its silent fallback in %s", async (_, chatJid, expected) => {
    // An Automation's first matching trigger wins, and the chat is known only
    // once the message is read.
    await insertAutomation("scoped-reply-or-archive", replyTo({ channel_id: DM_JID }), { output: "silent" });
    deviceMessages.push({ id: "SYNTHDM10", chat_jid: chatJid, body: "route me" });

    await deliver("SYNTHDM10");
    await drain();
    expect(enqueued).toHaveLength(expected.replies);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`)
      .toHaveLength(expected.background);
    await completeTurns();
    expect(sends).toHaveLength(expected.replies);
  }, 60_000);

  it("queues a cooldown-limited background run once even when the first insert fails", async () => {
    const automationId = await insertAutomation(
      "scoped-reply-or-archive", replyTo({ channel_id: DM_JID }), { output: "silent" });
    await sql`UPDATE automations SET min_cooldown_seconds = 3600 WHERE id = ${automationId}`;
    // A sequence is not rolled back, so exactly the first insert fails.
    await sql.unsafe(`
      CREATE SEQUENCE synthetic_fail_once;
      CREATE FUNCTION synthetic_fail_first_automation_run() RETURNS trigger AS $$
      BEGIN
        IF NEW.run_type = 'automation' AND nextval('synthetic_fail_once') = 1 THEN
          RAISE EXCEPTION 'synthetic run insert failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_fail_first_automation_run BEFORE INSERT ON runs
        FOR EACH ROW EXECUTE FUNCTION synthetic_fail_first_automation_run();
    `);
    try {
      deviceMessages.push({ id: "SYNTHDM12", chat_jid: OTHER_DM_JID, body: "archive me" });
      await deliver("SYNTHDM12");
      await drain();
    } finally {
      await sql.unsafe(`
        DROP TRIGGER synthetic_fail_first_automation_run ON runs;
        DROP FUNCTION synthetic_fail_first_automation_run();
        DROP SEQUENCE synthetic_fail_once;
      `);
    }
    expect(await ingressJobs()).toEqual([expect.objectContaining({ status: "completed", attempts: 1 })]);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`)
      .toHaveLength(1);
  }, 60_000);

  it.each([
    ["an inbound message in the scoped chat", { chat_jid: DM_JID }, 1],
    ["the account's own message in the scoped chat", { chat_jid: DM_JID, from_me: true }, 1],
    ["a message in another chat", { chat_jid: OTHER_DM_JID }, 0],
  ] as const)("runs a chat-scoped silent Automation for %s", async (_, message, expected) => {
    await insertAutomation("archive-one-chat", { output: "silent", match: { channel_id: DM_JID } });
    deviceMessages.push({ id: "SYNTHDM13", body: "keep this", ...message });

    await deliver("SYNTHDM13", "first");
    await drain();
    await deliver("SYNTHDM13", "replayed");
    await drain();
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`)
      .toHaveLength(expected);
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
  }, 60_000);

  it("answers a message with one reply Automation, the oldest that matches", async () => {
    const firstId = await insertAutomation("first-reply", replyTo());
    await insertAutomation("second-reply", replyTo());
    deviceMessages.push({ id: "SYNTHDM14", chat_jid: DM_JID, body: "who answers?" });

    await deliver("SYNTHDM14");
    await drain();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].messageId).toContain(`:automation:${firstId}`);
    await completeTurns();
    expect(sends).toHaveLength(1);
  }, 60_000);

  it("does not answer a replayed message older than its reply Automation", async () => {
    await insertAutomation("dm-reply", replyTo());
    const archiveId = await insertAutomation("archive", { output: "silent" });
    deviceMessages.push({ id: "SYNTHDM15", chat_jid: DM_JID, body: "sent two days ago" });

    await deliver("SYNTHDM15", "replayed", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    await drain();
    expect(enqueued).toHaveLength(0);
    expect(sends).toHaveLength(0);
    // Background Automations still see the replayed message.
    const runs = await sql`SELECT automation_id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`;
    expect(runs.map((run) => Number(run.automation_id))).toEqual([archiveId]);
  }, 60_000);

  it("resolves the connection's numeric runtime id for chat routing", async () => {
    const replyId = await insertAutomation("one-chat-reply", replyTo({ channel_id: DM_JID }));
    const runtimeId = String(connectionId);
    const plan = await planAutomationActivationsForRuntimeConnection({
      connectionOrganizationId: orgId,
      runtimeConnectionId: runtimeId,
      signal: {
        connector_key: "whatsapp.web", event_type: "message.created", resource_type: "message",
        resource_ref: "SYNTHDM7", delivery_id: "synthetic-delivery", label: "message", input_text: "hi",
        attributes: { channel_id: DM_JID },
      },
    });
    expect(plan.signal.connection_id).toBe(connectionId);
    expect(plan.replyTargets.map((target) => target.automationId)).toEqual([replyId]);
    const subscriptions = new AutomationSubscriptionService();
    expect(await subscriptions.resolveForConnection(runtimeId, DM_JID, orgId))
      .toMatchObject({ agentId, connectionId: runtimeId });

    // A credentialed chat connection is named only by its slug, never its row id.
    await sql`UPDATE connections SET credential_mode = 'byo' WHERE id = ${connectionId}`;
    expect(await subscriptions.resolveForConnection(runtimeId, DM_JID, orgId)).toBeNull();
  }, 60_000);
});
