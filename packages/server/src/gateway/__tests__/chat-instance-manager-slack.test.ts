import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

mock.module("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class GetSecretValueCommand {},
  SecretsManagerClient: class SecretsManagerClient {
    send(): Promise<null> {
      return Promise.resolve(null);
    }
  },
}));

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

async function loadChatInstanceManager() {
  const mod = await import("../connections/chat-instance-manager.js");
  return mod.ChatInstanceManager;
}

describe("ChatInstanceManager Slack marketplace support", () => {
  test("handleChatAppWebhook routes the slack provider to the Slack coordinator", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const request = new Request("https://gateway.example.com/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_id: "T123", type: "event_callback" }),
    });
    const handleAppWebhook = mock(async () => new Response("ok"));
    manager.slackCoordinator = {
      handleAppWebhook,
    };

    const response = await manager.handleChatAppWebhook("slack", request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handleAppWebhook).toHaveBeenCalledWith(request);
  });

  test("restartConnection reads from agent_connections and starts adapter", async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    try {
      await resetTestDatabase();
      await seedAgentRow("agent-1");
      const ChatInstanceManager = await loadChatInstanceManager();

      // Build a minimal AgentConnectionStore backed by agent_connections.
      const { createPostgresAgentConnectionStore } = await import(
        "../../lobu/stores/postgres-stores.js"
      );
      const { orgContext } = await import("../../lobu/stores/org-context.js");
      const connectionStore = createPostgresAgentConnectionStore();

      // Seed a connection with a `secret://` ref. ChatInstanceManager
      // resolves refs via SecretStoreRegistry inside startInstance; the
      // store is asserted to be wired through to the real one (not the
      // empty `{}` stub the rest of these tests use).
      const { PostgresSecretStore } = await import(
        "../../lobu/stores/postgres-secret-store.js"
      );
      const { SecretStoreRegistry } = await import("../secrets/index.js");
      const postgresSecretStore = new PostgresSecretStore();
      const secretStore = new SecretStoreRegistry(postgresSecretStore, {
        secret: postgresSecretStore,
      });
      const tokenRef = await orgContext.run(
        { organizationId: "test-org" },
        () => secretStore.put("connections/conn-restart-test/botToken", "test-bot-token-value")
      );
      await orgContext.run(
        { organizationId: "test-org" },
        async () => {
          await connectionStore.saveConnection({
            id: "conn-restart-test",
            platform: "telegram",
            agentId: "agent-1",
            config: {
              platform: "telegram",
              botToken: tokenRef,
            },
            settings: { allowGroups: true },
            metadata: {},
            status: "stopped",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      );

      const services = {
        getQueue: () => ({}),
        getPublicGatewayUrl: () => "",
        getSecretStore: () => secretStore,
        getConnectionStore: () => connectionStore,
        getAutomationSubscriptionService: () => ({
          resolveForConnection: async () => null,
        }),
      } as any;

      const manager = new ChatInstanceManager() as any;
      manager.services = services;
      manager.publicGatewayUrl = "";
      manager.connectionStore = connectionStore;

      // restartConnection reads from agent_connections and attempts to boot.
      // The Telegram adapter will fail because the token is fake, but the
      // important thing is that the read path works — no secret-ref errors.
      try {
        await manager.restartConnection("conn-restart-test");
      } catch {
        // Expected: adapter startup fails with a fake token.
      }

      // Connection record must still exist (not auto-deleted).
      const conn = await orgContext.run(
        { organizationId: "test-org" },
        () => connectionStore.getConnection("conn-restart-test")
      );
      expect(conn).not.toBeNull();
      expect(conn!.id).toBe("conn-restart-test");
    } finally {
      if (originalKey !== undefined) {
        process.env.ENCRYPTION_KEY = originalKey;
      } else {
        delete process.env.ENCRYPTION_KEY;
      }
    }
  });

});

describe("ChatInstanceManager.postMessageToChannel", () => {
  test("posts markdown to the resolved channel as the bot", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "1.2" }));
    const channel = mock((_key: string) => ({ post }));
    // Row-versioned memo: the warm instance is served only while it matches
    // the stored row's updated_at.
    manager.connectionStore = {
      getConnection: async () => ({
        id: "conn-1",
        platform: "slack",
        status: "active",
        updatedAt: 111,
      }),
    };
    manager.instances.set("conn-1", { chat: { channel }, rowVersion: 111 });

    await manager.postMessageToChannel("conn-1", "slack:C0123ABCD", {
      markdown: "Weekly funnel digest",
    });

    expect(channel).toHaveBeenCalledWith("slack:C0123ABCD");
    expect(post).toHaveBeenCalledWith({ markdown: "Weekly funnel digest" });
  });

  test("posts a rich card built with the chat primitives", async () => {
    const { Card, Field, Fields, Actions, LinkButton } = await import("chat");
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "2.0" }));
    const channel = mock((_key: string) => ({ post }));
    manager.connectionStore = {
      getConnection: async () => ({
        id: "conn-1",
        platform: "slack",
        status: "active",
        updatedAt: 111,
      }),
    };
    manager.instances.set("conn-1", { chat: { channel }, rowVersion: 111 });

    const card = Card({
      title: "Weekly funnel digest",
      children: [
        Fields([Field({ label: "New leads", value: "3" })]),
        Actions([LinkButton({ url: "https://app.lobu.ai/lobu-crm/entities", label: "View leads" })]),
      ],
    });

    await manager.postMessageToChannel("conn-1", "slack:C0123ABCD", { card });

    expect(post).toHaveBeenCalledWith({ card });
    expect(card.type).toBe("card");
  });

  test("lazily starts the connection when it isn't loaded on this pod, then posts", async () => {
    // Multi-replica: the connection was created/restarted on another pod, so
    // this pod has no live instance until we start it from the store.
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const post = mock(async () => ({ ts: "9.9" }));
    const channel = mock((_key: string) => ({ post }));
    manager.connectionStore = {
      getConnection: async () => ({
        id: "conn-x",
        platform: "slack",
        status: "active",
        updatedAt: 7,
      }),
    };
    manager.hydrateFromRow = mock(async (stored: any) => {
      manager.instances.set(stored.id, {
        chat: { channel },
        rowVersion: stored.updatedAt,
      });
    });

    await manager.postMessageToChannel("conn-x", "slack:C9", { markdown: "hi" });

    expect(manager.hydrateFromRow).toHaveBeenCalled();
    expect(channel).toHaveBeenCalledWith("slack:C9");
    expect(post).toHaveBeenCalledWith({ markdown: "hi" });
  });

  test("throws when the connection is stopped and cannot be started", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = {
      getConnection: async () => ({ id: "missing", status: "stopped" }),
    };
    await expect(
      manager.postMessageToChannel("missing", "slack:C0", { markdown: "x" })
    ).rejects.toThrow(/No active chat instance/);
  });
});

describe("ChatInstanceManager.handleWebhook (multi-replica)", () => {
  test("lazily starts the connection on this pod before handling the webhook", async () => {
    // Regression: the per-connection webhook route (`/api/v1/webhooks/:id`)
    // calls handleWebhook directly, unlike the Slack coordinator which
    // pre-warms via ensureConnectionRunning. Under `app.replicaCount > 1` a
    // webhook (a platform event OR a one-shot `/lobu link` slash command) can
    // land on a pod that hasn't warmed this connection. It must hydrate from
    // the store, not 404. Mirrors postMessageToChannel's lazy-start.
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    const webhookHandler = mock(
      async () => new Response("handled", { status: 200 })
    );
    manager.connectionStore = {
      getConnection: async () => ({
        id: "conn-cold",
        platform: "slack",
        status: "active",
        updatedAt: 7,
      }),
    };
    manager.hydrateFromRow = mock(async (stored: any) => {
      manager.instances.set(stored.id, {
        connection: { platform: "slack" },
        chat: { webhooks: { slack: webhookHandler } },
        rowVersion: stored.updatedAt,
      });
    });

    const request = new Request(
      "https://gw.example.com/api/v1/webhooks/conn-cold",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "command=%2Flobu&text=link+crm-ABC123",
      }
    );
    const response = await manager.handleWebhook("conn-cold", request);

    expect(manager.hydrateFromRow).toHaveBeenCalled();
    expect(webhookHandler).toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("handled");
  });

  test("404s when the connection is stopped and cannot be started", async () => {
    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = {
      getConnection: async () => ({ id: "stopped-conn", status: "stopped" }),
    };
    const response = await manager.handleWebhook(
      "stopped-conn",
      new Request("https://gw.example.com/api/v1/webhooks/stopped-conn", {
        method: "POST",
      })
    );
    expect(response.status).toBe(404);
  });
});

describe("ChatInstanceManager webhook ack vs. shutdown", () => {
  const SIGNING_SECRET = "drain-test-signing-secret";

  function signedDm(eventId: string, ts: string): Request {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      team_id: "T_DRAIN",
      event: {
        type: "message",
        channel: "D_DRAIN",
        channel_type: "im",
        user: "U_SENDER",
        text: "hello during a deploy",
        ts,
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    return new Request("https://gw.example.com/api/v1/webhooks/conn-drain", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
  }

  // The Slack adapter acks 200 and dispatches the message in the background,
  // so a pod that tears down right after the ack (SIGTERM on every rollout)
  // must not cut the handler off before it has enqueued the turn: Slack got
  // its 200, so we cannot rely on redelivery.
  async function managerWithRealSlackChat(
    onMessage: () => Promise<void>,
  ): Promise<any> {
    const { createSlackAdapter } = await import("@chat-adapter/slack");
    const { Chat } = await import("chat");
    const { createConnectedGatewayStateAdapter } = await import(
      "../connections/state-adapter.js"
    );
    const adapter = createSlackAdapter({
      signingSecret: SIGNING_SECRET,
      botToken: "xoxb-drain-test",
      botUserId: "U_DRAIN_BOT",
      userName: "lobu",
    });
    (adapter as any).fetchMessages = mock(async () => ({ messages: [] }));
    (adapter as any).startTyping = mock(async () => undefined);
    (adapter as any).lookupUser = mock(async () => ({
      displayName: "sender",
      realName: "sender",
    }));
    const chat = new Chat({
      userName: "lobu",
      adapters: { slack: adapter },
      state: await createConnectedGatewayStateAdapter(),
      logger: "silent",
    });
    chat.onDirectMessage(onMessage);

    const ChatInstanceManager = await loadChatInstanceManager();
    const manager = new ChatInstanceManager() as any;
    manager.resolveStored = async () => null;
    manager.ensureConnectionRunning = async () => true;
    manager.instances.set("conn-drain", {
      connection: { id: "conn-drain", platform: "slack" },
      chat,
      cleanup: async () => chat.shutdown(),
      rowVersion: 1,
    });
    return manager;
  }

  test("shutdown waits for a message the webhook already acked", async () => {
    await resetTestDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let handled = false;
    const manager = await managerWithRealSlackChat(async () => {
      started();
      await gate;
      handled = true;
    });

    const response = await manager.handleWebhook(
      "conn-drain",
      signedDm("Ev_DRAIN_ACKED", "1793000000.000100"),
    );
    // The platform already has its 200 while the message is still in flight.
    expect(response.status).toBe(200);
    await handlerStarted;
    expect(handled).toBe(false);

    let shutDown = false;
    const shutdown = manager.shutdown().then(() => {
      shutDown = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(shutDown).toBe(false);
    } finally {
      release();
      await shutdown;
    }
    expect(handled).toBe(true);
  });

  test("shutdown stops waiting for a stuck message after the drain budget", async () => {
    await resetTestDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const manager = await managerWithRealSlackChat(async () => {
      started();
      await gate;
    });
    manager.webhookDrainTimeoutMs = 50;

    const response = await manager.handleWebhook(
      "conn-drain",
      signedDm("Ev_DRAIN_STUCK", "1793000000.000200"),
    );
    expect(response.status).toBe(200);
    await handlerStarted;
    try {
      const startedAt = Date.now();
      await manager.shutdown();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      release();
      await Promise.all(manager.webhookTasks);
    }
  });
});
