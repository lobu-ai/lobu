/**
 * Assembled Slack chat-automation regression.
 *
 * Fakes stop at Slack's network boundary. The test drives a signed Events API
 * request through the real Slack adapter and Chat SDK, then uses the real
 * channel subscription reader, Automation planner, transcript writer,
 * Postgres run queue, and Slack completion strategy.
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
import { createHmac } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Chat, type StateAdapter } from "chat";
import { CommandRegistry } from "@lobu/core";
import { addUserToOrganization, createTestUser, linkSlackIdentityInGraph } from "../../__tests__/setup/test-fixtures.js";
import { bindChatToAgentForOwner } from "../../preview/slack.js";
import { planAutomationActivationsForRuntimeConnection } from "../../automations/activation.js";
import { registerBuiltInCommands } from "../commands/built-in-commands.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import { getDb } from "../../db/client.js";
import { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { registerMessageHandlers } from "../connections/message-handler-bridge.js";
import { getResponseStrategy } from "../connections/platform-strategies/index.js";
import { createConnectedGatewayStateAdapter } from "../connections/state-adapter.js";
import type { PlatformConnection } from "../connections/types.js";
import { QueueProducer } from "../infrastructure/queue/queue-producer.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const SIGNING_SECRET = "slack-e2e-signing-secret-20260821";
const BOT_USER_ID = "U_LOBU_BOT";
const ENTERPRISE_ID = "E0ENTERPRISE";
const WORKSPACE_TEAM_ID = "T0WORKSPACE";
const CHANNEL_ID = "C0CHANNEL";
const DM_ID = "D0DIRECT";
const RUNTIME_CONNECTION_ID = "slackinst-grid-message-e2e";

setDefaultTimeout(30_000);

function signedEventRequest(
  payload: Record<string, unknown>,
  retryNum?: number,
): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  return new Request("https://gateway.example.test/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
      ...(retryNum === undefined
        ? {}
        : {
            "x-slack-retry-num": String(retryNum),
            "x-slack-retry-reason": "http_timeout",
          }),
    },
    body,
  });
}

function slackEvent(options: {
  eventId: string;
  channel: string;
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  channelType?: "channel" | "im";
  eventType?: "message" | "app_mention";
}) {
  return {
    token: "legacy-verification-token",
    type: "event_callback",
    api_app_id: "A_LOBU",
    event_id: options.eventId,
    event_time: Math.floor(Number(options.ts)),
    team_id: WORKSPACE_TEAM_ID,
    enterprise_id: ENTERPRISE_ID,
    is_enterprise_install: true,
    event: {
      type: options.eventType ?? "message",
      team: WORKSPACE_TEAM_ID,
      team_id: WORKSPACE_TEAM_ID,
      channel: options.channel,
      channel_type: options.channelType ?? "channel",
      ts: options.ts,
      text: options.text,
      ...(options.user ? { user: options.user, username: "burak" } : {}),
      ...(options.botId
        ? { bot_id: options.botId, username: "another-app" }
        : {}),
    },
  };
}

async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe("Slack Enterprise Grid event -> chat Automation -> Slack reply", () => {
  let chat: Chat;
  let state: StateAdapter;
  let queue: RunsQueue;
  let connectionDbId: number;
  let slackPostMessage: ReturnType<typeof mock>;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();

    const organizationId = "org-slack-grid-e2e";
    const agentId = "agent-slack-grid-e2e";
    await seedAgentRow(agentId, { organizationId });
    const sql = getDb();
    const [connectionRow] = await sql<{ id: number }[]>`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, external_tenant_id, config
      ) VALUES (
        ${organizationId}, 'slack', ${RUNTIME_CONNECTION_ID}, 'Grid Slack',
        'active', 'managed', ${ENTERPRISE_ID},
        ${sql.json({
          platform: "slack",
          settings: { allowGroups: true },
          chatMetadata: {
            teamId: ENTERPRISE_ID,
            enterpriseId: ENTERPRISE_ID,
            isEnterpriseInstall: true,
            botUserId: BOT_USER_ID,
          },
        })}
      )
      RETURNING id
    `;
    if (!connectionRow) throw new Error("Slack E2E connection was not seeded");
    connectionDbId = Number(connectionRow.id);

    await createTestAutomationSubscription({
      organizationId,
      agentId,
      connectionId: connectionDbId,
      platform: "slack",
      channelId: CHANNEL_ID,
      teamId: WORKSPACE_TEAM_ID,
    });
    queue = new RunsQueue();
    await queue.start();
    const producer = new QueueProducer(queue);
    await producer.start();

    state = await createConnectedGatewayStateAdapter();
    const adapter = createSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-test-boundary-token",
      botUserId: BOT_USER_ID,
      userName: "lobu",
    });
    // Slack API reads/status writes are the external boundary too. Keep the
    // assembled server path hermetic while still exercising its calls.
    (adapter as any).fetchMessages = mock(async () => ({ messages: [] }));
    (adapter as any).startTyping = mock(async () => undefined);
    slackPostMessage = mock(async () => ({ ts: "1787292000.999999" }));
    (adapter as any).postMessage = slackPostMessage;
    chat = new Chat({
      userName: "lobu",
      adapters: { slack: adapter },
      state,
      logger: "silent",
    });

    const connection: PlatformConnection = {
      id: RUNTIME_CONNECTION_ID,
      platform: "slack",
      organizationId,
      config: {
        platform: "slack",
        signingSecret: SIGNING_SECRET,
        botToken: "xoxb-test-boundary-token",
        botUserId: BOT_USER_ID,
      },
      settings: { allowGroups: true },
      metadata: {
        teamId: ENTERPRISE_ID,
        enterpriseId: ENTERPRISE_ID,
        isEnterpriseInstall: true,
        botUserId: BOT_USER_ID,
      },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    const conversationState = new ConversationStateStore(state);
    const subscriptions = new AutomationSubscriptionService();
    const manager = {
      has: (connectionId: string) => connectionId === RUNTIME_CONNECTION_ID,
      getInstance: (connectionId: string) =>
        connectionId === RUNTIME_CONNECTION_ID
          ? { connection, conversationState, chat }
          : undefined,
    };
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.test",
      getAutomationSubscriptionService: () => subscriptions,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getProviderCatalogService: () => undefined,
      getQueueProducer: () => producer,
    };
    registerMessageHandlers(
      chat,
      connection,
      services as never,
      manager as never,
    );
  });

  afterEach(async () => {
    await chat?.shutdown();
    await queue?.stop();
  });

  test("first-contact message.im posts a setup notice without a DM Automation", async () => {
    const sql = getDb();
    const dmTs = "1787292001.000821";
    const response = await chat.webhooks.slack(
      signedEventRequest(
        slackEvent({
          eventId: "Ev_GRID_DM_FIRST_CONTACT_20260821",
          channel: DM_ID,
          channelType: "im",
          ts: dmTs,
          text: "LOBU_SLACK_E2E_20260821 first contact dm",
          user: "U_BURAK",
        }),
      ),
    );

    expect(response.status).toBe(200);
    await waitFor(() => {
      expect(slackPostMessage).toHaveBeenCalledTimes(1);
    });
    expect(slackPostMessage.mock.calls[0]?.[0]).toBe(`slack:${DM_ID}:`);
    expect(String(slackPostMessage.mock.calls[0]?.[1])).toContain(
      "isn't linked to one of your agents yet",
    );
    const runs = await sql`
      SELECT id FROM runs WHERE run_type = 'chat_message'
    `;
    expect(runs).toHaveLength(0);
    const transcript = await sql`
      SELECT id
      FROM channel_messages
      WHERE organization_id = 'org-slack-grid-e2e'
        AND connection_id = ${RUNTIME_CONNECTION_ID}
        AND channel_id = ${DM_ID}
    `;
    expect(transcript).toHaveLength(0);
    const activationCursors = await sql`
      SELECT last_event_activation_at
      FROM automations
      WHERE organization_id = 'org-slack-grid-e2e'
    `;
    expect(activationCursors).toEqual([{ last_event_activation_at: null }]);
  });

  test("workspace-stamped channel and DM events persist, activate once, and reply", async () => {
    const sql = getDb();
    const channelTs = "1787292000.000821";
    const channelPayload = slackEvent({
      eventId: "Ev_GRID_CHANNEL_20260821",
      channel: CHANNEL_ID,
      ts: channelTs,
      text: "LOBU_SLACK_E2E_20260821 integration channel",
      user: "U_BURAK",
    });

    const first = await chat.webhooks.slack(signedEventRequest(channelPayload));
    expect(first.status).toBe(200);

    await waitFor(async () => {
      const rows = await sql`
        SELECT id, action_input
        FROM runs
        WHERE run_type = 'chat_message'
        ORDER BY id
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action_input).toMatchObject({
        agentId: "agent-slack-grid-e2e",
        organizationId: "org-slack-grid-e2e",
        messageText: "LOBU_SLACK_E2E_20260821 integration channel",
        platformMetadata: {
          automationId: expect.any(Number),
          teamId: WORKSPACE_TEAM_ID,
          connectionId: RUNTIME_CONNECTION_ID,
        },
      });
    });
    await waitFor(async () => {
      const rows = await sql`
        SELECT platform_message_id, team_id, text
        FROM channel_messages
        WHERE organization_id = 'org-slack-grid-e2e'
          AND connection_id = ${RUNTIME_CONNECTION_ID}
          AND channel_id = ${CHANNEL_ID}
      `;
      expect(rows).toEqual([
        {
          platform_message_id: channelTs,
          team_id: WORKSPACE_TEAM_ID,
          text: "LOBU_SLACK_E2E_20260821 integration channel",
        },
      ]);
    });
    const [channelAutomation] = await sql<{ id: number }[]>`
      SELECT id
      FROM automations
      WHERE organization_id = 'org-slack-grid-e2e'
        AND triggers->0->'match'->>'channel_id' = ${CHANNEL_ID}
      LIMIT 1
    `;
    if (!channelAutomation) throw new Error("Channel Automation was not seeded");
    let channelActivationAt: Date | null = null;
    await waitFor(async () => {
      const [row] = await sql<{ last_event_activation_at: Date | null }[]>`
        SELECT last_event_activation_at
        FROM automations
        WHERE id = ${channelAutomation.id}
      `;
      expect(row?.last_event_activation_at).not.toBeNull();
      channelActivationAt = row?.last_event_activation_at ?? null;
    });

    // Delayed Events and normal Slack retries carry the same event_id. The
    // durable adapter marker and message idempotency must leave one transcript
    // row and one pending agent turn.
    await waitFor(async () => {
      expect(
        await state.get("slack:event-delivered:Ev_GRID_CHANNEL_20260821"),
      ).toBe(true);
    });
    const retry = await chat.webhooks.slack(
      signedEventRequest(channelPayload, 1),
    );
    expect(retry.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterRetry = await sql`
      SELECT id FROM runs WHERE run_type = 'chat_message'
    `;
    expect(afterRetry).toHaveLength(1);
    const transcriptAfterRetry = await sql`
      SELECT id FROM channel_messages
      WHERE organization_id = 'org-slack-grid-e2e'
        AND connection_id = ${RUNTIME_CONNECTION_ID}
        AND channel_id = ${CHANNEL_ID}
    `;
    expect(transcriptAfterRetry).toHaveLength(1);
    const [channelAfterRetry] = await sql<
      { last_event_activation_at: Date | null }[]
    >`
      SELECT last_event_activation_at
      FROM automations
      WHERE id = ${channelAutomation.id}
    `;
    expect(channelAfterRetry?.last_event_activation_at).toEqual(
      channelActivationAt,
    );

    // Linked DM ingress remains on the dedicated Chat SDK branch and routes
    // through the same workspace-scoped Automation planner.
    await createTestAutomationSubscription({
      organizationId: "org-slack-grid-e2e",
      agentId: "agent-slack-grid-e2e",
      connectionId: connectionDbId,
      platform: "slack",
      channelId: DM_ID,
      teamId: WORKSPACE_TEAM_ID,
    });
    const linkedDmTs = "1787292001.100821";
    const linkedDmResponse = await chat.webhooks.slack(
      signedEventRequest(
        slackEvent({
          eventId: "Ev_GRID_DM_LINKED_20260821",
          channel: DM_ID,
          channelType: "im",
          ts: linkedDmTs,
          text: "LOBU_SLACK_E2E_20260821 linked dm",
          user: "U_BURAK",
        }),
      ),
    );
    expect(linkedDmResponse.status).toBe(200);
    await waitFor(async () => {
      const rows = await sql`
        SELECT id FROM runs WHERE run_type = 'chat_message' ORDER BY id
      `;
      expect(rows).toHaveLength(2);
    });
    await waitFor(async () => {
      const rows = await sql`
        SELECT platform_message_id, team_id
        FROM channel_messages
        WHERE organization_id = 'org-slack-grid-e2e'
          AND connection_id = ${RUNTIME_CONNECTION_ID}
          AND channel_id = ${DM_ID}
      `;
      expect(rows).toEqual([
        { platform_message_id: linkedDmTs, team_id: WORKSPACE_TEAM_ID },
      ]);
    });
    // The activation stamp lands in a different statement from the `runs` and
    // `channel_messages` rows polled above, so a bare read here races it: the
    // rows can be present while `last_event_activation_at` is still null.
    await waitFor(async () => {
      const [dmAutomation] = await sql<
        { id: number; last_event_activation_at: Date | null }[]
      >`
        SELECT id, last_event_activation_at
        FROM automations
        WHERE organization_id = 'org-slack-grid-e2e'
          AND triggers->0->'match'->>'channel_id' = ${DM_ID}
        LIMIT 1
      `;
      expect(dmAutomation?.last_event_activation_at).not.toBeNull();
    });
    const activationTimesBeforeBots = new Map(
      (
        await sql<{ id: number; last_event_activation_at: Date | null }[]>`
          SELECT id, last_event_activation_at
          FROM automations
          WHERE organization_id = 'org-slack-grid-e2e'
        `
      ).map((row) => [Number(row.id), row.last_event_activation_at]),
    );

    // The bot's own Slack echo is filtered by Chat SDK before the catch-all;
    // another app's bot message is rejected by the bridge's loop guard.
    for (const ownOrBot of [
      slackEvent({
        eventId: "Ev_GRID_SELF_20260821",
        channel: CHANNEL_ID,
        ts: "1787292002.000821",
        text: "self echo",
        user: BOT_USER_ID,
      }),
      slackEvent({
        eventId: "Ev_GRID_OTHER_BOT_20260821",
        channel: CHANNEL_ID,
        ts: "1787292003.000821",
        text: "another bot",
        botId: "B_OTHER_APP",
      }),
    ]) {
      const response = await chat.webhooks.slack(signedEventRequest(ownOrBot));
      expect(response.status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterBots = await sql`
      SELECT id FROM runs WHERE run_type = 'chat_message'
    `;
    expect(afterBots).toHaveLength(2);
    const activationTimesAfterBots = await sql<
      { id: number; last_event_activation_at: Date | null }[]
    >`
      SELECT id, last_event_activation_at
      FROM automations
      WHERE organization_id = 'org-slack-grid-e2e'
    `;
    for (const row of activationTimesAfterBots) {
      expect(row.last_event_activation_at).toEqual(
        activationTimesBeforeBots.get(Number(row.id)),
      );
    }

    // Feed the authoritative terminal text into the real Slack transport. The
    // only fake is chat.postMessage itself, Slack's external HTTP boundary.
    const [channelRun] = await sql<{ action_input: Record<string, any> }[]>`
      SELECT action_input
      FROM runs
      WHERE run_type = 'chat_message'
      ORDER BY id
      LIMIT 1
    `;
    if (!channelRun) throw new Error("Channel agent turn was not queued");
    expect(channelRun.action_input.channelId).toBe(`slack:${CHANNEL_ID}`);
    const postMessage = mock(async () => ({ ok: true }));
    await getResponseStrategy("slack").handleCompletion({
      ctx: {
        connectionId: RUNTIME_CONNECTION_ID,
        platform: "slack",
        channelId: String(channelRun.action_input.channelId),
        instance: {
          chat: {
            getAdapter: () => ({ client: { chat: { postMessage } } }),
          },
        },
      },
      payload: {
        messageId: String(channelRun.action_input.messageId),
        channelId: String(channelRun.action_input.channelId),
        conversationId: String(channelRun.action_input.conversationId),
        userId: String(channelRun.action_input.userId),
        teamId: WORKSPACE_TEAM_ID,
        platform: "slack",
        timestamp: Date.now(),
        finalText: "ACK_LOBU_SLACK_E2E_20260821 integration channel",
      },
      stream: null,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      channel: CHANNEL_ID,
      thread_ts: channelTs,
      markdown_text: "ACK_LOBU_SLACK_E2E_20260821 integration channel",
    });

    // The connection is enterprise-scoped (`external_tenant_id` = E…), but
    // routing and durable state must retain the real workspace T id. An E id
    // in either place would cross the Grid boundary.
    const teamStamps = await sql<{ team_id: string }[]>`
      SELECT DISTINCT team_id
      FROM channel_messages
      WHERE organization_id = 'org-slack-grid-e2e'
        AND connection_id = ${RUNTIME_CONNECTION_ID}
    `;
    expect(teamStamps).toEqual([{ team_id: WORKSPACE_TEAM_ID }]);
    const runStamps = await sql<{ action_input: Record<string, any> }[]>`
      SELECT action_input FROM runs WHERE run_type = 'chat_message'
    `;
    for (const row of runStamps) {
      expect(row.action_input.platformMetadata.teamId).toBe(WORKSPACE_TEAM_ID);
    }
  });

  test("a verified admin links another Lobu workspace and signed Slack messages queue there", async () => {
    const sourceOrg = "org-slack-grid-e2e";
    const targetOrg = "org-slack-linked-workspace";
    const targetAgent = "agent-slack-linked-workspace";
    const channel = "C_CROSS_WORKSPACE";
    await seedAgentRow(targetAgent, { organizationId: targetOrg });
    const user = await createTestUser();
    await addUserToOrganization(user.id, sourceOrg, "owner");
    await addUserToOrganization(user.id, targetOrg, "admin");
    await linkSlackIdentityInGraph({
      organizationId: sourceOrg, userId: user.id,
      teamId: WORKSPACE_TEAM_ID, slackUserId: "U_LINK_ADMIN",
    });
    const subscriptions = new AutomationSubscriptionService();
    const registry = new CommandRegistry();
    registerBuiltInCommands(registry, { agentSettingsStore: {} as never, automationSubscriptionService: subscriptions });
    const dispatcher = new CommandDispatcher({ registry, automationSubscriptionService: subscriptions });
    const replies: string[] = [];
    await dispatcher.tryHandleSlashText(`/lobu link ${targetAgent}`, {
      platform: "slack", userId: "U_LINK_ADMIN", channelId: channel,
      teamId: WORKSPACE_TEAM_ID, isGroup: true,
      connectionId: RUNTIME_CONNECTION_ID, organizationId: sourceOrg,
      reply: async (text) => { replies.push(String(text)); },
    });
    expect(replies).toEqual([`Linked this chat to agent \`${targetAgent}\`. Say hi — I'll reply here from now on.`]);

    const response = await chat.webhooks.slack(signedEventRequest(slackEvent({
      eventId: "Ev_CROSS_WORKSPACE", channel, ts: "1787292010.000001",
      text: "Create the follow-up task", user: "U_LINK_ADMIN",
    })));
    expect(response.status).toBe(200);
    await waitFor(async () => {
      const rows = await getDb()`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action_input).toMatchObject({
        agentId: targetAgent, organizationId: targetOrg,
        messageText: "Create the follow-up task",
        platformMetadata: { teamId: WORKSPACE_TEAM_ID, connectionId: RUNTIME_CONNECTION_ID },
      });
    });
    const linked = await subscriptions.resolveForConnection(
      RUNTIME_CONNECTION_ID, channel, sourceOrg, { teamId: WORKSPACE_TEAM_ID },
    );
    expect(linked?.organizationId).toBe(targetOrg);
    const [automation] = await getDb()`SELECT created_by FROM automations WHERE organization_id = ${targetOrg}`;
    expect(automation?.created_by).toBe(user.id);
    const mentionResponse = await chat.webhooks.slack(signedEventRequest(slackEvent({
      eventId: "Ev_CROSS_WORKSPACE_MENTION", channel, ts: "1787292011.000001",
      eventType: "app_mention", text: `<@${BOT_USER_ID}> Follow up`, user: "U_LINK_ADMIN",
    })));
    expect(mentionResponse.status).toBe(200);
    await waitFor(async () => {
      const runs = await getDb()`SELECT action_input FROM runs WHERE run_type = 'chat_message'`;
      expect(runs).toHaveLength(2);
      for (const row of runs) expect(row.action_input.organizationId).toBe(targetOrg);
    });
    expect(slackPostMessage).not.toHaveBeenCalled();
    const messages = await getDb()`SELECT organization_id, team_id FROM channel_messages WHERE channel_id = ${channel}`;
    expect(messages).toHaveLength(2);
    for (const message of messages) expect(message).toEqual({ organization_id: targetOrg, team_id: WORKSPACE_TEAM_ID });
  });

  test.each([
    "no installation membership", "installation member", "agent member",
    "missing team", "ambiguous agent",
  ])("codeless linking rejects unauthorized or ambiguous targets: %s", async (boundary) => {
    const targetOrg = "org-slack-untrusted-workspace";
    await seedAgentRow("agent-slack-untrusted", { organizationId: targetOrg });
    const user = await createTestUser();
    await addUserToOrganization(user.id, targetOrg, boundary === "agent member" ? "member" : "owner");
    if (boundary !== "no installation membership") {
      await addUserToOrganization(user.id, "org-slack-grid-e2e", boundary === "installation member" ? "member" : "owner");
    }
    if (boundary === "ambiguous agent") {
      await seedAgentRow("agent-slack-untrusted", { organizationId: "org-slack-grid-e2e" });
    }
    const result = await bindChatToAgentForOwner({
      platform: "slack", teamId: boundary === "missing team" ? undefined : WORKSPACE_TEAM_ID, channelId: "slack:C_UNAUTHORIZED",
      agentId: "agent-slack-untrusted", lobuUserId: user.id,
      connectionId: RUNTIME_CONNECTION_ID, connectionOrganizationId: "org-slack-grid-e2e",
    });
    expect(result).toEqual({ status: "forbidden" });
    const rows = await getDb()`SELECT id FROM automations WHERE organization_id = ${targetOrg}`;
    expect(rows).toHaveLength(0);
  });

  test.each([
    "source membership revoked", "target membership revoked",
    "source member is not admin", "target member is not admin",
    "wrong team", "missing delivery team", "missing link team",
    "wrong channel", "wrong connection", "wrong installation organization",
    "inactive installation", "deleted installation", "untagged Automation",
    "connector-wide trigger", "foreign agent",
  ])("cross-workspace routing fails closed: %s", async (boundary) => {
    const sourceOrg = "org-slack-grid-e2e";
    const targetOrg = "org-slack-boundary";
    const targetAgent = "agent-slack-boundary";
    const channel = "C_BOUNDARY";
    await seedAgentRow(targetAgent, { organizationId: targetOrg });
    const user = await createTestUser();
    await addUserToOrganization(user.id, sourceOrg, "owner");
    await addUserToOrganization(user.id, targetOrg, "admin");
    await createTestAutomationSubscription({
      organizationId: targetOrg, agentId: targetAgent, connectionId: connectionDbId,
      channelId: channel, teamId: WORKSPACE_TEAM_ID, configuredBy: user.id,
    });
    const sql = getDb();
    let deliveryTeam: string | undefined = WORKSPACE_TEAM_ID;
    let deliveryChannel = channel;
    let runtimeConnection = RUNTIME_CONNECTION_ID;
    let installationOrg = sourceOrg;
    if (boundary.endsWith("membership revoked") || boundary.endsWith("member is not admin")) {
      const org = boundary.startsWith("source") ? sourceOrg : targetOrg;
      if (boundary.endsWith("membership revoked")) {
        await sql`DELETE FROM member WHERE "organizationId" = ${org} AND "userId" = ${user.id}`;
      } else await sql`UPDATE member SET role = 'member' WHERE "organizationId" = ${org} AND "userId" = ${user.id}`;
    } else if (boundary === "wrong team") deliveryTeam = "T_OTHER_WORKSPACE";
    else if (boundary === "missing delivery team") deliveryTeam = undefined;
    else if (boundary === "wrong channel") deliveryChannel = "C_OTHER_CHANNEL";
    else if (boundary === "wrong installation organization") installationOrg = targetOrg;
    else if (boundary === "wrong connection") {
      runtimeConnection = "slackinst-unrelated";
      await sql`INSERT INTO connections (organization_id, connector_key, slug, display_name, status, credential_mode, config)
        VALUES (${sourceOrg}, 'slack', ${runtimeConnection}, 'Other install', 'active', 'managed', '{}')`;
    } else if (boundary === "inactive installation") {
      await sql`UPDATE connections SET status = 'error' WHERE id = ${connectionDbId}`;
    } else if (boundary === "deleted installation") {
      await sql`UPDATE connections SET deleted_at = now() WHERE id = ${connectionDbId}`;
    } else if (boundary === "untagged Automation") {
      await sql`UPDATE automations SET tags = '{}'::text[] WHERE organization_id = ${targetOrg}`;
    } else if (boundary === "foreign agent") {
      await sql`UPDATE automations SET managed_agent_id = 'agent-slack-grid-e2e' WHERE organization_id = ${targetOrg}`;
    } else {
      const [row] = await sql`SELECT triggers FROM automations WHERE organization_id = ${targetOrg}`;
      const trigger = row.triggers[0];
      if (boundary === "connector-wide trigger") delete trigger.connection_id;
      else delete trigger.match.team_id;
      await sql`UPDATE automations SET triggers = ${sql.json([trigger])} WHERE organization_id = ${targetOrg}`;
    }
    const plan = await planAutomationActivationsForRuntimeConnection({
      connectionOrganizationId: installationOrg, runtimeConnectionId: runtimeConnection,
      signal: {
        connector_key: "slack", event_type: "message.created", delivery_id: "boundary-message",
        resource_type: "channel", resource_ref: `slack:channel:${deliveryChannel}`,
        attributes: { channel_id: deliveryChannel, ...(deliveryTeam ? { team_id: deliveryTeam } : {}) },
      },
    });
    expect(plan.replyTargets).toHaveLength(0);
    expect(plan.backgroundTargets).toHaveLength(0);
    const subscriptions = new AutomationSubscriptionService();
    expect(await subscriptions.resolveForConnection(runtimeConnection, deliveryChannel, installationOrg, { teamId: deliveryTeam })).toBeNull();
    expect(await subscriptions.channelHasMessageSubscription(runtimeConnection, deliveryChannel, installationOrg, { teamId: deliveryTeam })).toBe(false);
  });

  test("foreign chat links only activate their exact trigger, preserving mention filters", async () => {
    const sourceOrg = "org-slack-grid-e2e";
    const targetOrg = "org-slack-trigger-scope";
    const channel = "C_TRIGGER_SCOPE";
    await seedAgentRow("agent-slack-trigger-scope", { organizationId: targetOrg });
    const user = await createTestUser();
    await addUserToOrganization(user.id, sourceOrg, "owner");
    await addUserToOrganization(user.id, targetOrg, "owner");
    await createTestAutomationSubscription({
      organizationId: targetOrg, agentId: "agent-slack-trigger-scope",
      connectionId: connectionDbId, channelId: channel,
      teamId: WORKSPACE_TEAM_ID, configuredBy: user.id,
    });
    const sql = getDb();
    const [row] = await sql`SELECT triggers FROM automations WHERE organization_id = ${targetOrg}`;
    const linkedTrigger = row.triggers[0];
    linkedTrigger.match.mention_only = true;
    await sql`UPDATE automations SET triggers = ${sql.json([
      { ...linkedTrigger, connection_id: undefined, match: {}, output: "silent" },
      { ...linkedTrigger, match: { channel_id: channel, team_id: "T_OTHER_WORKSPACE" }, output: "silent" },
      linkedTrigger,
    ])} WHERE organization_id = ${targetOrg}`;
    const subscription = await new AutomationSubscriptionService().resolveForConnection(
      RUNTIME_CONNECTION_ID, channel, sourceOrg, { teamId: WORKSPACE_TEAM_ID },
    );
    expect(subscription?.teamId).toBe(WORKSPACE_TEAM_ID);
    for (const mention of [false, true]) {
      const plan = await planAutomationActivationsForRuntimeConnection({
        connectionOrganizationId: sourceOrg, runtimeConnectionId: RUNTIME_CONNECTION_ID,
        signal: {
          connector_key: "slack", event_type: "message.created", delivery_id: `mention-${mention}`,
          resource_type: "channel", resource_ref: `slack:channel:${channel}`,
          attributes: { channel_id: channel, team_id: WORKSPACE_TEAM_ID, mention_only: mention },
        },
      });
      expect(plan.replyTargets).toHaveLength(mention ? 1 : 0);
      expect(plan.backgroundTargets).toHaveLength(0);
    }
  });
});
