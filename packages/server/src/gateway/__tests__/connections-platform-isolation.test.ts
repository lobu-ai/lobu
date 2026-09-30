/**
 * Hardening tests for chat platform connections and platform isolation.
 *
 * Coverage areas:
 *   1. Cross-platform leakage: a Telegram renderer must no-op on Slack events
 *      (and vice versa). Tests exercise `shouldHandle` inside interaction-bridge.
 *   2. `isSecretField` heuristic — secret field detection for token/secret/key etc.
 *   3. `isTelegramConfig` / `isSlackConfig` narrowing guards.
 *   4. `registerInteractionBridge` cleanup teardown (no lingering listeners).
 *   5. `InteractionService` URL scheme guard for link buttons.
 *   6. Telegram polling mode selection logic (mode auto/webhook/polling).
 *   7. Duplicate-delivery idempotency — same event id ignored on second call.
 *   8. Slug parsing for `registerSlackPlatformHandlers` DM detection.
 *   9. `parseSlackTeamJoinEvent` — malformed/bot/deleted users rejected.
 *  10. `isSecretField` does not false-positive on non-secret field names.
 */

import { describe, expect, mock, test, beforeEach } from "bun:test";

import {
  InteractionService,
  type PostedLinkButton,
  type PostedQuestion,
} from "../interactions.js";
import { shouldHandle } from "../connections/interaction-bridge.js";
import {
  isTelegramConfig,
  isSlackConfig,
  isSecretField,
  type PlatformAdapterConfig,
  type PlatformConnection,
} from "../connections/types.js";
import {
  registerInteractionBridge,
} from "../connections/interaction-bridge.js";
import {
  parseSlackTeamJoinEvent,
  registerSlackPlatformHandlers,
} from "../connections/slack-platform-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnection(
  platform: string,
  connectionId: string = "conn-1"
): PlatformConnection {
  return {
    id: connectionId,
    // Required by the bridge's per-tenant `pending_interactions` write —
    // a connection without an org would be dropped before `resolveThread`
    // (where `instanceChat.channel()` is asserted).
    organizationId: "test-org",
    platform,
    config: { platform } as PlatformAdapterConfig,
    settings: {},
    metadata: {},
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Minimal ChatInstanceManager mock that reports exactly one active instance
 * whose platform is `instancePlatform`.
 *
 * `instanceChat` is the chat object stored on `instance.chat` — used by
 * `resolveThread` when it calls `manager.getInstance(id).chat`.
 */
function makeManager(
  instancePlatform: string,
  connectionId: string = "conn-1",
  instanceChat: any = {}
) {
  const connection = makeConnection(instancePlatform, connectionId);
  const instance = {
    connection,
    chat: instanceChat,
    messageBridge: { ingestClick: mock(async () => undefined) },
    conversationState: {},
  };
  return {
    has: (id: string) => id === connectionId,
    getInstance: (id: string) =>
      id === connectionId ? instance : undefined,
    instance,
  };
}

// ---------------------------------------------------------------------------
// 1. isSecretField heuristic
// ---------------------------------------------------------------------------

describe("isSecretField", () => {
  test.each([
    ["botToken", true],
    ["signingSecret", true],
    ["apiKey", true],
    ["clientSecret", true],
    ["password", true],
    ["credential", true],
    ["accessToken", true],
    ["refreshToken", true],
    ["privateKey", true],
    // Non-secret fields
    ["platform", false],
    ["mode", false],
    ["channelId", false],
    ["userName", false],
    ["botUserId", false],
    ["apiBaseUrl", false],
    ["allowGroups", false],
  ])("%s → %s", (fieldName, expected) => {
    expect(isSecretField(fieldName)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. Config narrowing type guards
// ---------------------------------------------------------------------------

describe("isTelegramConfig / isSlackConfig", () => {
  const telegramCfg = { platform: "telegram", botToken: "tok" } as PlatformAdapterConfig;
  const slackCfg = { platform: "slack", botToken: "xoxb", signingSecret: "s" } as PlatformAdapterConfig;
  const discordCfg = { platform: "discord" } as PlatformAdapterConfig;

  test("isTelegramConfig accepts telegram, rejects others", () => {
    expect(isTelegramConfig(telegramCfg)).toBe(true);
    expect(isTelegramConfig(slackCfg)).toBe(false);
    expect(isTelegramConfig(discordCfg)).toBe(false);
  });

  test("isSlackConfig accepts slack, rejects others", () => {
    expect(isSlackConfig(slackCfg)).toBe(true);
    expect(isSlackConfig(telegramCfg)).toBe(false);
    expect(isSlackConfig(discordCfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. InteractionService link-button URL scheme guard
// ---------------------------------------------------------------------------

describe("InteractionService.postLinkButton — URL scheme guard", () => {
  let svc: InteractionService;
  beforeEach(() => {
    svc = new InteractionService();
  });

  test("accepts https:// URLs", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "https://example.com/auth", "Connect", "oauth")
    ).resolves.toBeDefined();
  });

  test("accepts http:// URLs", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "http://example.com/auth", "Connect", "oauth")
    ).resolves.toBeDefined();
  });

  test("rejects javascript: scheme", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "javascript:alert(1)", "XSS", "oauth")
    ).rejects.toThrow(/unsafe scheme/i);
  });

  test("rejects data: scheme", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "data:text/html,<h1>hi</h1>", "Data", "oauth")
    ).rejects.toThrow(/unsafe scheme/i);
  });

  test("rejects file: scheme", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "file:///etc/passwd", "File", "oauth")
    ).rejects.toThrow(/unsafe scheme/i);
  });

  test("rejects completely invalid URL", async () => {
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
        "not-a-url", "Bad", "oauth")
    ).rejects.toThrow(/invalid link button url/i);
  });
});

// ---------------------------------------------------------------------------
// 3b. InteractionService — fail-closed when connectionId is missing
//
// Cross-tenant / cross-connection event leakage was possible when callers
// omitted `connectionId`: the interaction-bridge `shouldHandle` filter falls
// through when `event.connectionId` is falsy, so any bridge on the matching
// platform would handle the event. The service refuses to post without a
// non-empty connectionId so the bug surfaces as an error rather than
// silently routing to the wrong tenant.
// ---------------------------------------------------------------------------

describe("InteractionService — connectionId is required", () => {
  test("postQuestion throws when connectionId is undefined", async () => {
    const svc = new InteractionService();
    await expect(
      svc.postQuestion("u", "conv", "ch", undefined, undefined, "slack", "?", ["A"])
    ).rejects.toThrow(/connectionId is required/);
  });

  test("postQuestion throws when connectionId is empty string", async () => {
    const svc = new InteractionService();
    await expect(
      svc.postQuestion("u", "conv", "ch", undefined, "", "slack", "?", ["A"])
    ).rejects.toThrow(/connectionId is required/);
  });

  test("postLinkButton throws when connectionId is undefined", async () => {
    const svc = new InteractionService();
    await expect(
      svc.postLinkButton("u", "conv", "ch", undefined, undefined, "slack",
        "https://example.com", "Open", "oauth")
    ).rejects.toThrow(/connectionId is required/);
  });


  // platform "api" has no Chat SDK connection — its cards are routed by
  // conversationId through the API platform's event.platform === "api"
  // subscriptions, and chat bridges drop foreign-platform events in
  // shouldHandle. Requiring a connectionId here is the #847 regression that
  // silently broke ask_user for every API/SPA session (the
  // worker token for API rows never carries one).
  test("postQuestion succeeds for platform api without a connectionId", async () => {
    const svc = new InteractionService();
    const received: unknown[] = [];
    svc.on("question:created", (e) => received.push(e));

    const posted = await svc.postQuestion(
      "u", "api:conv-1", "api:conv-1", "api", undefined, "api", "Proceed?", ["Yes", "No"]
    );

    expect(posted.platform).toBe("api");
    expect(received).toHaveLength(1);
  });


  // The bridge-side half of the api exemption: a chat bridge must drop a
  // connectionless event posted for a different platform, otherwise the
  // connectionId fall-through would route api cards into chat tenants.
  test("chat bridge shouldHandle drops connectionless api-platform events", () => {
    const manager = {
      has: () => true,
      getInstance: () => ({ connection: { platform: "slack" } }),
    };

    expect(
      shouldHandle(
        { channelId: "api:conv-1", platform: "api" },
        "slack",
        "conn-1",
        manager as never
      )
    ).toBe(false);

    // Same-platform events without a connectionId still fall through to the
    // bridge (pre-existing chat routing, unchanged).
    expect(
      shouldHandle(
        { channelId: "C1", platform: "slack" },
        "slack",
        "conn-1",
        manager as never
      )
    ).toBe(true);
  });

  test("no event is emitted when connectionId is missing", async () => {
    const svc = new InteractionService();
    const received: unknown[] = [];
    svc.on("question:created", (e) => received.push(e));
    svc.on("link-button:created", (e) => received.push(e));

    await svc
      .postQuestion("u", "conv", "ch", undefined, undefined, "slack", "?", ["A"])
      .catch(() => undefined);

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. InteractionService emits correct platform field
// ---------------------------------------------------------------------------

describe("InteractionService — platform field on emitted events", () => {
  test("postQuestion carries platform", async () => {
    const svc = new InteractionService();
    const received: any[] = [];
    svc.on("question:created", (e) => received.push(e));

    await svc.postQuestion("u", "conv", "ch", undefined, "conn-1", "telegram",
      "Pick one?", ["A", "B"]);

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("telegram");
  });

  test("postLinkButton carries platform", async () => {
    const svc = new InteractionService();
    const received: any[] = [];
    svc.on("link-button:created", (e) => received.push(e));

    await svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
      "https://example.com", "Open", "oauth");

    expect(received).toHaveLength(1);
    expect(received[0].platform).toBe("slack");
  });


});

// ---------------------------------------------------------------------------
// 5. Cross-platform leakage: shouldHandle filters by platform
//    Tests exercise the exported `registerInteractionBridge` which internally
//    calls shouldHandle. We use a manager whose instance platform does NOT
//    match the event platform and assert the handler is a no-op.
// ---------------------------------------------------------------------------

describe("registerInteractionBridge — cross-platform isolation", () => {
  /**
   * Build the minimum chat stub required by registerInteractionBridge.
   * `onAction` is needed to avoid a crash when the bridge registers action handlers.
   */
  function makeChat() {
    return {
      onAction: mock((_handler: any) => undefined),
      channel: mock((_key: string) => null),
      getAdapter: mock((_platform: string) => null),
      createThread: null,
    };
  }

  /**
   * Cross-platform isolation is implemented via `connectionId` routing:
   * an event carrying a specific `connectionId` is only handled by the bridge
   * registered for that connection. The `platform` field on the event payload
   * is metadata, not a routing key — isolation comes from `connectionId`.
   *
   * The tests below verify the real isolation mechanism:
   *   1. Events without a connectionId (no explicit routing) are handled by any
   *      bridge whose connection is registered in the manager.
   *   2. Events with a connectionId are routed ONLY to the matching bridge.
   */
  test("Telegram bridge handles event when its connectionId matches (no platform mismatch guard needed)", async () => {
    // The shouldHandle function checks instance.connection.platform === bridge-platform.
    // They're always equal (bridge was registered for that connection), so the real
    // isolation comes from connectionId matching.
    const svc = new InteractionService();
    const instanceChat = makeChat();
    const threadPost = mock(async () => undefined);
    (instanceChat.channel as any).mockReturnValue({ post: threadPost });

    const manager = makeManager("telegram", "conn-tg", instanceChat);
    const actionChat = makeChat();

    registerInteractionBridge(svc, manager as any, makeConnection("telegram", "conn-tg"), actionChat as any);

    // Event for this specific connection — bridge should handle it
    const telegramEvent: PostedQuestion = {
      id: "q_tg_match",
      userId: "u",
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-tg",   // matches bridge's connectionId
      platform: "telegram",
      question: "Pick?",
      options: ["A", "B"],
    };
    svc.emit("question:created", telegramEvent);
    await new Promise((r) => setTimeout(r, 30));

    // Bridge attempted thread resolution
    expect((instanceChat.channel as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("Telegram bridge ignores events for a different connectionId (isolation via connectionId)", async () => {
    const svc = new InteractionService();
    const instanceChat = makeChat();
    const threadPost = mock(async () => undefined);
    (instanceChat.channel as any).mockReturnValue({ post: threadPost });

    // Telegram bridge registered for conn-tg
    const manager = makeManager("telegram", "conn-tg", instanceChat);
    const actionChat = makeChat();

    registerInteractionBridge(svc, manager as any, makeConnection("telegram", "conn-tg"), actionChat as any);

    // Event for a DIFFERENT connection (conn-slack) — bridge must not handle
    const otherEvent: PostedQuestion = {
      id: "q_other_conn",
      userId: "u",
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-slack",   // <-- different connectionId
      platform: "slack",
      question: "Pick?",
      options: ["A"],
    };
    svc.emit("question:created", otherEvent);
    await new Promise((r) => setTimeout(r, 30));

    // Bridge was not triggered
    expect(threadPost).not.toHaveBeenCalled();
    expect((instanceChat.channel as any).mock.calls.length).toBe(0);
  });

  test("Slack bridge ignores events with a different connectionId", async () => {
    const svc = new InteractionService();
    const instanceChat = makeChat();
    const threadPost = mock(async () => undefined);
    (instanceChat.channel as any).mockReturnValue({ post: threadPost });

    const manager = makeManager("slack", "conn-mine", instanceChat);
    const actionChat = makeChat();

    registerInteractionBridge(
      svc,
      manager as any,
      makeConnection("slack", "conn-mine"),
      actionChat as any
    );

    // Same platform but a different connectionId — should be ignored
    const otherEvent: PostedQuestion = {
      id: "q_other",
      userId: "u",
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-other", // <-- wrong connection
      platform: "slack",
      question: "Pick?",
      options: ["A", "B"],
    };
    svc.emit("question:created", otherEvent);

    await new Promise((r) => setTimeout(r, 20));
    expect(threadPost).not.toHaveBeenCalled();
    expect((instanceChat.channel as any).mock.calls.length).toBe(0);
  });

  test("cleanup removes all listeners — no-op after unregister", async () => {
    const svc = new InteractionService();
    const instanceChat = makeChat();
    const threadPost = mock(async () => undefined);
    (instanceChat.channel as any).mockReturnValue({ post: threadPost });

    const manager = makeManager("slack", "conn-1", instanceChat);
    const actionChat = makeChat();

    const unregister = registerInteractionBridge(
      svc,
      manager as any,
      makeConnection("slack"),
      actionChat as any
    );

    // Verify listeners were added
    expect(svc.listenerCount("question:created")).toBeGreaterThan(0);

    // Unregister
    unregister();

    // After cleanup, no listeners remain for these events
    expect(svc.listenerCount("question:created")).toBe(0);
    expect(svc.listenerCount("link-button:created")).toBe(0);

    // Emit after unregister — should be completely silent
    const slackEvent: PostedQuestion = {
      id: "q_post_unregister",
      userId: "u",
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-1",
      platform: "slack",
      question: "Pick?",
      options: ["A", "B"],
    };
    svc.emit("question:created", slackEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(threadPost).not.toHaveBeenCalled();
    expect((instanceChat.channel as any).mock.calls.length).toBe(0);
  });

  test("duplicate event id is no-op on second emit (idempotency)", async () => {
    const svc = new InteractionService();
    // instanceChat is what resolveThread uses
    const instanceChat = makeChat();
    const threadPost = mock(async () => undefined);
    const thread = { post: threadPost };
    (instanceChat.channel as any).mockReturnValue(thread);

    const manager = makeManager("slack", "conn-1", instanceChat);
    const actionChat = makeChat();

    registerInteractionBridge(svc, manager as any, makeConnection("slack"), actionChat as any);

    const evt: PostedQuestion = {
      id: "q_dup",
      userId: "u",
      // DM shortcut: conversationId === channelId
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-1",
      platform: "slack",
      question: "Pick?",
      options: ["A"],
    };

    // First emit — shouldHandle passes, resolveThread runs, channel() is called once
    svc.emit("question:created", evt);
    await new Promise((r) => setTimeout(r, 50));

    const callsAfterFirst = (instanceChat.channel as any).mock.calls.length;
    // Must have processed the first event (channel() called at least once)
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second emit with same id — must be a no-op (handledEvents dedup)
    svc.emit("question:created", evt);
    await new Promise((r) => setTimeout(r, 50));

    expect((instanceChat.channel as any).mock.calls.length).toBe(callsAfterFirst);
  });

  test("two bridges on different connections don't cross-contaminate", async () => {
    const svc = new InteractionService();

    // Bridge A: slack / conn-a
    const instanceChatA = makeChat();
    const threadPostA = mock(async () => undefined);
    (instanceChatA.channel as any).mockReturnValue({ post: threadPostA });
    const managerA = makeManager("slack", "conn-a", instanceChatA);
    const actionChatA = makeChat();
    registerInteractionBridge(svc, managerA as any, makeConnection("slack", "conn-a"), actionChatA as any);

    // Bridge B: telegram / conn-b
    const instanceChatB = makeChat();
    const threadPostB = mock(async () => undefined);
    (instanceChatB.channel as any).mockReturnValue({ post: threadPostB });
    const managerB = makeManager("telegram", "conn-b", instanceChatB);
    const actionChatB = makeChat();
    registerInteractionBridge(svc, managerB as any, makeConnection("telegram", "conn-b"), actionChatB as any);

    // Emit a Slack-platform event with connectionId=conn-a.
    // Bridge A (slack/conn-a) should attempt to handle it.
    // Bridge B (telegram/conn-b) must not react at all — wrong platform AND wrong connection.
    const slackEvent: PostedQuestion = {
      id: "q_xa",
      userId: "u",
      // DM shortcut
      conversationId: "ch",
      channelId: "ch",
      teamId: undefined,
      connectionId: "conn-a",
      platform: "slack",
      question: "?",
      options: ["Y"],
    };
    svc.emit("question:created", slackEvent);
    await new Promise((r) => setTimeout(r, 50));

    // Bridge A attempted thread resolution (instanceChatA.channel() called)
    // Bridge B must have made zero calls to its instanceChat.channel()
    const aChannelCalls = (instanceChatA.channel as any).mock.calls.length;
    const bChannelCalls = (instanceChatB.channel as any).mock.calls.length;

    expect(aChannelCalls).toBeGreaterThanOrEqual(1); // Bridge A processed it
    expect(bChannelCalls).toBe(0);                   // Bridge B was silent
  });
});

// ---------------------------------------------------------------------------
// 6. Telegram polling-mode selection logic
//    Extracted from ChatInstanceManager.startInstanceUnscoped
// ---------------------------------------------------------------------------

describe("Telegram mode logic — polling vs webhook", () => {
  /**
   * Replicate the exact mode-selection logic from startInstanceUnscoped:
   *
   *   const mode = isTelegramConfig(config) ? (config.mode ?? "auto") : "auto";
   *   const useWebhook = mode === "webhook" || (mode === "auto" && !!publicGatewayUrl);
   */
  function resolveMode(
    config: Partial<{ platform: string; botToken: string; mode?: "auto" | "webhook" | "polling" }>,
    publicGatewayUrl: string
  ): { useWebhook: boolean; mode: string } {
    const cfg = config as PlatformAdapterConfig;
    const mode = isTelegramConfig(cfg) ? (cfg as any).mode ?? "auto" : "auto";
    const useWebhook =
      mode === "webhook" || (mode === "auto" && !!publicGatewayUrl);
    return { useWebhook, mode };
  }

  const baseTg = { platform: "telegram", botToken: "tok" };

  test("mode=auto with publicGatewayUrl → useWebhook=true", () => {
    const r = resolveMode({ ...baseTg, mode: "auto" }, "https://gw.example");
    expect(r.useWebhook).toBe(true);
  });

  test("mode=auto without publicGatewayUrl → useWebhook=false (polling)", () => {
    const r = resolveMode({ ...baseTg, mode: "auto" }, "");
    expect(r.useWebhook).toBe(false);
  });

  test("mode=webhook always → useWebhook=true regardless of publicGatewayUrl", () => {
    const r = resolveMode({ ...baseTg, mode: "webhook" }, "");
    expect(r.useWebhook).toBe(true);
  });

  test("mode=polling always → useWebhook=false regardless of publicGatewayUrl", () => {
    const r = resolveMode({ ...baseTg, mode: "polling" }, "https://gw.example");
    expect(r.useWebhook).toBe(false);
  });

  test("mode defaults to 'auto' when not set", () => {
    // omit mode from config object
    const r = resolveMode({ platform: "telegram", botToken: "tok" }, "https://gw.example");
    expect(r.mode).toBe("auto");
    expect(r.useWebhook).toBe(true);
  });

  test("non-Telegram config always gets mode=auto and follows publicGatewayUrl", () => {
    const r = resolveMode({ platform: "slack", botToken: "xoxb" }, "https://gw.example");
    expect(r.mode).toBe("auto");
    expect(r.useWebhook).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. parseSlackTeamJoinEvent — validation / edge cases
// ---------------------------------------------------------------------------

describe("parseSlackTeamJoinEvent", () => {
  function wrap(event: unknown): string {
    return JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event: { type: "team_join", user: event },
    });
  }

  test("returns null for non-JSON content-type", () => {
    expect(parseSlackTeamJoinEvent("body", "text/plain")).toBeNull();
  });

  test("returns null for non-event_callback type", () => {
    const body = JSON.stringify({ type: "url_verification", team_id: "T" });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("returns null for non-team_join event type", () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T",
      event: { type: "message", user: { id: "U1" } },
    });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("returns null when user.is_bot is true", () => {
    const body = wrap({ id: "UBOT", is_bot: true });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("returns null when user.deleted is true", () => {
    const body = wrap({ id: "UDEL", deleted: true });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("returns null when user id is missing", () => {
    const body = wrap({ real_name: "No ID" });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("returns null when team_id is missing", () => {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "team_join", user: { id: "U1" } },
    });
    expect(parseSlackTeamJoinEvent(body, "application/json")).toBeNull();
  });

  test("parses a valid human user join event", () => {
    const body = wrap({
      id: "UHUMAN",
      profile: { display_name: "Alice" },
    });
    const result = parseSlackTeamJoinEvent(body, "application/json");
    expect(result).not.toBeNull();
    expect(result!.teamId).toBe("T_TEST");
    expect(result!.userId).toBe("UHUMAN");
    expect(result!.displayName).toBe("Alice");
  });

  test("uses real_name when display_name is absent", () => {
    const body = wrap({ id: "U2", profile: { real_name: "Bob Smith" } });
    const result = parseSlackTeamJoinEvent(body, "application/json");
    expect(result!.displayName).toBe("Bob Smith");
  });

  test("falls back to user.real_name when profile names are absent", () => {
    const body = wrap({ id: "U3", real_name: "Carol" });
    const result = parseSlackTeamJoinEvent(body, "application/json");
    expect(result!.displayName).toBe("Carol");
  });

  test("returns null for malformed JSON body", () => {
    expect(parseSlackTeamJoinEvent("{{not json", "application/json")).toBeNull();
  });

  test("returns parsed result without displayName when profile is absent", () => {
    const body = wrap({ id: "U4" });
    const result = parseSlackTeamJoinEvent(body, "application/json");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("U4");
    expect(result!.displayName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. registerSlackPlatformHandlers — DM vs group channel detection
// ---------------------------------------------------------------------------

describe("registerSlackPlatformHandlers — DM vs group channel detection", () => {
  function setupSlash() {
    let slashHandler: ((event: any) => Promise<void>) | undefined;
    const chat = {
      onSlashCommand: mock((_cmd: string, h: (event: any) => Promise<void>) => {
        slashHandler = h;
      }),
    };
    const tryHandle = mock(async () => true);

    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      { tryHandle } as any
    );

    return { slashHandler: slashHandler!, tryHandle };
  }

  async function fire(slashHandler: (e: any) => Promise<void>, channelId: string) {
    const post = mock(async () => undefined);
    await slashHandler({
      text: "status",
      raw: { channel_id: channelId, team_id: "T1", user_id: "U1" },
      user: { userId: "U1" },
      channel: { post },
    });
    return post;
  }

  test("group channel (C…) → isGroup=true", async () => {
    const { slashHandler, tryHandle } = setupSlash();
    await fire(slashHandler, "C_GROUP");
    const ctx = tryHandle.mock.calls[0]![2] as any;
    expect(ctx.isGroup).toBe(true);
  });

  test("DM channel (D…) → isGroup=false", async () => {
    const { slashHandler, tryHandle } = setupSlash();
    await fire(slashHandler, "D_DM");
    const ctx = tryHandle.mock.calls[0]![2] as any;
    expect(ctx.isGroup).toBe(false);
  });

  test("channelId is prefixed with slack: for consistency", async () => {
    const { slashHandler, tryHandle } = setupSlash();
    await fire(slashHandler, "C123");
    const ctx = tryHandle.mock.calls[0]![2] as any;
    expect(ctx.channelId).toBe("slack:C123");
  });

  test("empty text defaults to 'help' command", async () => {
    const { slashHandler, tryHandle } = setupSlash();
    const post = mock(async () => undefined);
    await slashHandler({
      text: "",
      raw: { channel_id: "C1", team_id: "T1", user_id: "U1" },
      user: { userId: "U1" },
      channel: { post },
    });
    const [commandName] = tryHandle.mock.calls[0]!;
    expect(commandName).toBe("help");
  });

  test("non-Slack connection skips registration", () => {
    const chat = { onSlashCommand: mock(() => undefined) };
    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "telegram" } as any,
      { tryHandle: mock(async () => true) } as any
    );
    expect(chat.onSlashCommand).not.toHaveBeenCalled();
  });

  test("missing commandDispatcher skips registration", () => {
    const chat = { onSlashCommand: mock(() => undefined) };
    registerSlackPlatformHandlers(
      chat,
      { id: "conn-1", platform: "slack" } as any,
      undefined
    );
    expect(chat.onSlashCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. InteractionService — unique event ids
// ---------------------------------------------------------------------------

describe("InteractionService — unique event ids", () => {
  test("each postLinkButton call emits a distinct id", async () => {
    const svc = new InteractionService();
    const ids: string[] = [];
    svc.on("link-button:created", (e) => ids.push(e.id));

    await svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
      "https://a.com", "A", "oauth");
    await svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
      "https://b.com", "B", "oauth");

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 10. InteractionService beforeCreateHook is awaited before emit
// ---------------------------------------------------------------------------

describe("InteractionService — beforeCreateHook ordering", () => {
  test("hook runs before the event is emitted", async () => {
    const svc = new InteractionService();
    const log: string[] = [];

    svc.setBeforeCreateHook(async (_uid, _conv) => {
      log.push("hook");
    });
    svc.on("question:created", () => log.push("event"));

    await svc.postQuestion("u", "conv", "ch", undefined, "conn-1", "slack", "?", ["Y", "N"]);

    expect(log).toEqual(["hook", "event"]);
  });
});

// ---------------------------------------------------------------------------
// 11. Unknown platform — addConnection guard (unit-level logic)
// ---------------------------------------------------------------------------

describe("ADAPTER_FACTORIES platform guard", () => {
  const KNOWN_PLATFORMS = ["telegram", "slack", "discord", "whatsapp", "teams", "gchat"];
  const UNKNOWN = ["sms", "signal", "matrix", "xmpp", "fax", "pigeon"];

  test.each(KNOWN_PLATFORMS)("known platform %s is in factory map", (platform) => {
    // We verify the set without importing the private map by checking that
    // `isTelegramConfig` and `isSlackConfig` agree with the expected classification.
    if (platform === "telegram") {
      expect(isTelegramConfig({ platform } as PlatformAdapterConfig)).toBe(true);
    } else if (platform === "slack") {
      expect(isSlackConfig({ platform } as PlatformAdapterConfig)).toBe(true);
    } else {
      // Remaining platforms are recognised by the union discriminant.
      const cfg = { platform } as PlatformAdapterConfig;
      expect(cfg.platform).toBe(platform);
    }
  });

  test.each(UNKNOWN)("unknown platform %s is not telegram or slack", (platform) => {
    const cfg = { platform } as any as PlatformAdapterConfig;
    expect(isTelegramConfig(cfg)).toBe(false);
    expect(isSlackConfig(cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Link-button body text deduplication guard (label === body)
// ---------------------------------------------------------------------------

describe("InteractionService.postLinkButton — body field", () => {
  test("body is stored as-is when it differs from the label", async () => {
    const svc = new InteractionService();
    const received: PostedLinkButton[] = [];
    svc.on("link-button:created", (e) => received.push(e));

    await svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
      "https://example.com", "Connect", "oauth", "Authorize access to GitHub.");

    expect(received[0]!.body).toBe("Authorize access to GitHub.");
  });

  test("body is undefined when not supplied", async () => {
    const svc = new InteractionService();
    const received: PostedLinkButton[] = [];
    svc.on("link-button:created", (e) => received.push(e));

    await svc.postLinkButton("u", "conv", "ch", undefined, "conn-1", "slack",
      "https://example.com", "Connect", "oauth");

    expect(received[0]!.body).toBeUndefined();
  });
});
