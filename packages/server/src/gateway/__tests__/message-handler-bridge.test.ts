import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type MatchingAutomationActivation,
  planAutomationActivations,
} from "../../automations/activation.js";
import { matchingAutomationTriggers } from "../../automations/event-trigger.js";
import { normalizeStatefulChatCommand } from "../commands/command-spelling.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import {
  buildAttachmentTranscriptText,
  type InboundAttachmentLike,
  ingestInboundAttachments,
  isEarlyDispatchableChatCommand,
  isSenderAllowed,
  MessageHandlerBridge,
  parsePreviewLinkCode,
  registerMessageHandlers,
} from "../connections/message-handler-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";
import {
  type ArtifactTestEnv,
  createArtifactTestEnv,
  TEST_GATEWAY_URL,
} from "./setup.js";

/** The reply cooldown operations are injected so this unit suite stays DB-free. */
const cooldownClaims: number[] = [];
const activationMarks: number[] = [];
let cooldownAllows = true;
let markZeroThrows = false;
const automationCooldown = {
  claim: async (automationId: number) => {
    cooldownClaims.push(automationId);
    return cooldownAllows;
  },
  markZero: async (automationId: number) => {
    if (markZeroThrows) throw new Error("activation stamp unavailable");
    activationMarks.push(automationId);
    return true;
  },
};

describe("buildAttachmentTranscriptText", () => {
  const file = (id: string, name: string, mimetype: string) => ({
    id,
    name,
    mimetype,
    size: 1,
    downloadUrl: `http://gw/api/v1/files/${id}?token=x`,
  });

  test("appends a tokenless ref for a non-image file", () => {
    expect(
      buildAttachmentTranscriptText("see attached", [
        file("abc", "report.pdf", "application/pdf"),
			]),
    ).toBe("see attached\n\n[report.pdf](/api/v1/files/abc)");
  });

  test("supports a file-only message (empty caption)", () => {
    expect(
			buildAttachmentTranscriptText("", [
				file("xyz", "notes.txt", "text/plain"),
			]),
    ).toBe("[notes.txt](/api/v1/files/xyz)");
  });

  test("skips images (they persist as inline transcript blocks)", () => {
    expect(
			buildAttachmentTranscriptText("hi", [
				file("img", "pic.png", "image/png"),
			]),
    ).toBe("hi");
  });

  test("appends one ref per non-image file, images skipped", () => {
    expect(
      buildAttachmentTranscriptText("docs", [
        file("a", "a.pdf", "application/pdf"),
        file("b", "pic.jpg", "image/jpeg"),
        file("c", "b.csv", "text/csv"),
			]),
    ).toBe("docs\n\n[a.pdf](/api/v1/files/a)\n[b.csv](/api/v1/files/c)");
  });

  test("sanitizes filenames that would break the [name](url) link grammar", () => {
    // brackets/parens/newlines in the label are collapsed so the web's
    // strip/lift regex stays reliable; the real name rides Content-Disposition.
    const out = buildAttachmentTranscriptText("x", [
      file("id1", "weird]name)evil[.txt", "text/plain"),
    ]);
    expect(out).toBe("x\n\n[weird name evil .txt](/api/v1/files/id1)");
    // label has no unescaped link-breaking chars
    expect(/\[[^\]]*\]\(\/api\/v1\/files\/id1\)/.test(out)).toBe(true);
  });

  test("falls back to 'file' when the name sanitizes to empty", () => {
    expect(
			buildAttachmentTranscriptText("", [file("id2", "()[]", "text/plain")]),
    ).toBe("[file](/api/v1/files/id2)");
  });

  test("returns the original text unchanged when there are no files", () => {
    expect(buildAttachmentTranscriptText("just text", [])).toBe("just text");
  });
});

describe("parsePreviewLinkCode", () => {
  test("bare code paste in a DM", () => {
    expect(parsePreviewLinkCode("crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("multi-segment slug bare code", () => {
    expect(parsePreviewLinkCode("food-ordering-ABC123", false)).toBe(
			"food-ordering-ABC123",
    );
  });
  test("`link <code>`", () => {
    expect(parsePreviewLinkCode("link crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("`/lobu link <code>` delivered as text", () => {
    expect(parsePreviewLinkCode("/lobu link crm-TGHE0Z", false)).toBe(
			"crm-TGHE0Z",
    );
  });
  test("`/link <code>`", () => {
    expect(parsePreviewLinkCode("/link crm-TGHE0Z", false)).toBe("crm-TGHE0Z");
  });
  test("bare code is ignored in a channel (false-positive guard)", () => {
    expect(parsePreviewLinkCode("crm-TGHE0Z", true)).toBeNull();
  });
  test("`link me` (no hyphenated code) is not a link", () => {
    expect(parsePreviewLinkCode("link me", false)).toBeNull();
  });
  test("normal chatter is ignored", () => {
    expect(
			parsePreviewLinkCode("can you help me link the accounts", false),
    ).toBeNull();
  });
});

describe("isSenderAllowed", () => {
  test.each([
    { allow: undefined, user: "user-1", expected: true, label: "no allowlist" },
    { allow: [], user: "user-1", expected: false, label: "empty allowlist" },
    { allow: ["user-1"], user: "user-1", expected: true, label: "listed user" },
    {
      allow: ["user-1"],
      user: "user-2",
      expected: false,
      label: "unlisted user",
    },
  ] as const)("$label → $expected", ({ allow, user, expected }) => {
    expect(isSenderAllowed(allow as string[] | undefined, user)).toBe(expected);
  });
});

describe("isEarlyDispatchableChatCommand", () => {
  test("early dispatch keeps complete commands but excludes reset placeholders", () => {
    expect(isEarlyDispatchableChatCommand("/link code-123")).toBe(true);
    expect(isEarlyDispatchableChatCommand("/help")).toBe(true);
    expect(isEarlyDispatchableChatCommand("/lobu agents")).toBe(true);
    expect(isEarlyDispatchableChatCommand("/new")).toBe(false);
    expect(isEarlyDispatchableChatCommand("/lobu clear")).toBe(false);
    expect(isEarlyDispatchableChatCommand("/HELP")).toBe(false);
    expect(isEarlyDispatchableChatCommand("help")).toBe(false);
  });
});

describe("normalizeStatefulChatCommand", () => {
  test.each([
    ["/new", "new"],
    ["/lobu new", "new"],
    ["/clear", "clear"],
    ["/lobu clear", "clear"],
  ] as const)("normalizes %s", (input, expected) => {
    expect(normalizeStatefulChatCommand(input)).toBe(expected);
  });

  test("does not consume arguments or unrelated commands", () => {
    expect(normalizeStatefulChatCommand("/lobu clear now")).toBeNull();
    expect(normalizeStatefulChatCommand("/lobu help")).toBeNull();
  });
});

describe("ingestInboundAttachments", () => {
  let env: ArtifactTestEnv;
  const ingest = (atts: InboundAttachmentLike[] | undefined) =>
    ingestInboundAttachments(atts, env.artifactStore, TEST_GATEWAY_URL);

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("returns empty arrays when there are no attachments", async () => {
    const result = await ingest(undefined);
    expect(result).toEqual({ files: [], audioBytes: [] });
  });

  test("publishes every attachment as an artifact and surfaces a signed downloadUrl", async () => {
    let pdfFetched = 0;
    const { files } = await ingest([
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        data: Buffer.from("png-bytes"),
      },
      {
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        fetchData: async () => {
          pdfFetched += 1;
          return Buffer.from("pdf-bytes");
        },
      },
    ]);

    expect(pdfFetched).toBe(1);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      name: "screenshot.png",
      mimetype: "image/png",
      size: Buffer.from("png-bytes").length,
    });
    expect(files[1]).toMatchObject({
      name: "report.pdf",
      mimetype: "application/pdf",
      size: Buffer.from("pdf-bytes").length,
    });
    for (const file of files) {
      expect(file.id).toBeTruthy();
      expect(file.downloadUrl).toContain("/api/v1/files/");
      expect(file.downloadUrl).toContain("token=");
    }
  });

  test("audio attachments are published AND surfaced for transcription", async () => {
    const { files, audioBytes } = await ingest([
      {
        type: "audio",
        name: "voice.ogg",
        mimeType: "audio/ogg",
        fetchData: async () => Buffer.from("opus-bytes"),
      },
      {
        type: "audio",
        name: "alt.ogg",
        mimeType: "application/ogg",
        fetchData: async () => Buffer.from("vorbis-bytes"),
      },
    ]);

    // Audio still goes through artifact publishing so the worker can refer
    // to the original recording, AND its bytes are returned for immediate
    // transcription.
    expect(files).toHaveLength(2);
    expect(audioBytes).toHaveLength(2);
    expect(audioBytes[0]?.buffer.toString()).toBe("opus-bytes");
    expect(audioBytes[0]?.mimeType).toBe("audio/ogg");
    expect(audioBytes[1]?.mimeType).toBe("application/ogg");
  });

  // A bad attachment must never abort the rest of the batch — whether it has
  // no fetchable bytes or its fetchData throws, the good one still publishes.
  test.each([
    {
      label: "no fetchable bytes",
      bad: { type: "file", name: "empty.txt", mimeType: "text/plain" },
    },
    {
      label: "fetchData throws",
      bad: {
        type: "file",
        name: "boom.bin",
        mimeType: "application/octet-stream",
        fetchData: async () => {
          throw new Error("network down");
        },
      },
    },
  ] as const)("skips $label and still publishes the rest of the batch", async ({
    bad,
  }) => {
    const { files } = await ingest([
      bad as InboundAttachmentLike,
      {
        type: "file",
        name: "ok.txt",
        mimeType: "text/plain",
        data: Buffer.from("ok"),
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("ok.txt");
  });

  test("derives a filename from mimeType + index when none is provided", async () => {
    const { files } = await ingest([
      { type: "image", mimeType: "image/jpeg", data: Buffer.from("jpg") },
    ]);
    expect(files[0]?.name).toBe("image-1.jpeg");
  });
});

/**
 * MessageHandlerBridge.handleMessage previously had zero coverage despite
 * being the single entry point for every inbound platform message. The
 * thread-history backfill bug — bot mentioned mid-thread had no context —
 * lived here undetected because no test exercised this path.
 *
 * These tests pin the backfill semantics so future regressions trip CI.
 */

const CONN_ID = "conn-test";
const CHANNEL_ID = "C123";
const THREAD_ID = "slack:C123:1700000000.000100";
const TEMPLATE_AGENT_ID = "agent-template";

function buildConnection(): PlatformConnection {
  return {
    id: CONN_ID,
    platform: "slack",
    agentId: TEMPLATE_AGENT_ID,
    organizationId: "org-template",
    config: { platform: "slack" } as any,
    settings: { allowGroups: true } as any,
    metadata: {
      botUsername: "testbot",
      botUserId: "U_BOT",
    },
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createBridgeHarness(opts: {
  fetchMessages?: ReturnType<typeof mock> | undefined;
  withAdapter?: boolean;
}) {
  const state = new InMemoryStateAdapter();
  const conversationState = new ConversationStateStore(state);
  const connection = buildConnection();
  const enqueueMessage = mock(async () => undefined);

  const services = {
    getArtifactStore: () => null,
    getPublicGatewayUrl: () => "https://gateway.example.com",
    getAutomationSubscriptionService: () => undefined,
    getAgentMetadataStore: () => undefined,
    getUserAgentsStore: () => undefined,
    getTranscriptionService: () => undefined,
    getAgentSettingsStore: () => undefined,
    getDeclaredAgentRegistry: () => undefined,
    getQueueProducer: () => ({ enqueueMessage }),
  } as any;

  const manager = {
    has: () => true,
    getInstance: () => ({ connection, conversationState }),
  } as any;

  const bridge = new MessageHandlerBridge(
    connection,
    services,
    manager,
    undefined,
    async ({ signal }) => planAutomationActivations(signal, []),
  );

  let adapter: unknown;
  if (opts.withAdapter === false) {
    adapter = undefined;
  } else if (opts.fetchMessages === undefined && opts.withAdapter !== true) {
    adapter = undefined;
  } else if (opts.fetchMessages) {
    adapter = { fetchMessages: opts.fetchMessages };
  } else {
    adapter = {};
  }

  return { bridge, conversationState, enqueueMessage, adapter };
}

function makeMessage(overrides: Record<string, any> = {}) {
  return {
    id: "M_NEW",
    text: "<@U_BOT> what was the prior context?",
    author: {
      userId: "U_USER",
      userName: "alice",
      fullName: "Alice",
      isBot: false,
      isMe: false,
    },
    raw: {},
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    ...overrides,
  };
}

function makeThread(adapter: unknown) {
  return {
    id: THREAD_ID,
    channelId: CHANNEL_ID,
    adapter,
    subscribe: mock(async () => undefined),
    post: mock(async () => undefined),
    startTyping: mock(async () => undefined),
  };
}

describe("registerMessageHandlers linked-channel ingress", () => {
  test("does not add a catch-all to non-Slack adapters", () => {
    const onNewMessage = mock(() => undefined);
    registerMessageHandlers(
      {
        onNewMention: mock(() => undefined),
        onDirectMessage: mock(() => undefined),
        onSubscribedMessage: mock(() => undefined),
        onNewMessage,
      },
      { ...buildConnection(), platform: "telegram" },
      {
        getArtifactStore: () => null,
        getPublicGatewayUrl: () => "https://gateway.example.com",
      } as any,
      { getInstance: () => null } as any,
    );

    expect(onNewMessage).not.toHaveBeenCalled();
  });

  test("Enterprise Grid ordinary channel events reach the Automation bridge", async () => {
    let unmatchedHandler:
      | ((thread: unknown, message: unknown) => Promise<void>)
      | undefined;
    const chat = {
      onNewMention: mock(() => undefined),
      onDirectMessage: mock(() => undefined),
      onSubscribedMessage: mock(() => undefined),
      onNewMessage: mock(
        (
          _pattern: RegExp,
          handler: (thread: unknown, message: unknown) => Promise<void>,
        ) => {
          unmatchedHandler = handler;
        },
      ),
    };
    const channelHasMessageSubscription = mock(async () => true);
    const connection: PlatformConnection = {
      ...buildConnection(),
      id: "slackinst-grid",
      organizationId: "org-grid",
      agentId: undefined,
      metadata: {
        teamId: "E0ENTERPRISE",
        enterpriseId: "E0ENTERPRISE",
        isEnterpriseInstall: true,
        botUserId: "U_BOT",
      },
    };
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.com",
      getAutomationSubscriptionService: () => ({
        channelHasMessageSubscription,
      }),
    } as any;
    const bridge = registerMessageHandlers(
      chat,
      connection,
      services,
      { getInstance: () => null } as any,
    );
    const handleMessage = mock(async () => undefined);
    bridge.handleMessage = handleMessage as typeof bridge.handleMessage;
    // Real adapter shape: `channelIdFromThreadId` returns the prefixed
    // `slack:C…`, which the subscription reader normalizes to native `C…`.
    const thread = {
      id: "slack:C0CHANNEL:1787290503.806889",
      channelId: "slack:C0CHANNEL",
    };
    const message = makeMessage({
      id: "1787290503.806889",
      isMention: false,
      raw: { team_id: "T0WORKSPACE" },
    });

    expect(unmatchedHandler).toBeDefined();
    await unmatchedHandler!(thread, message);

    expect(channelHasMessageSubscription).toHaveBeenCalledWith(
      "slackinst-grid",
      "slack:C0CHANNEL",
      "org-grid",
      { crossOrganization: false, teamId: "T0WORKSPACE" },
    );
    expect(handleMessage).toHaveBeenCalledWith(thread, message, "subscribed");
  });

  test("ordinary messages in unlinked channels stay silent", async () => {
    let unmatchedHandler:
      | ((thread: unknown, message: unknown) => Promise<void>)
      | undefined;
    const chat = {
      onNewMention: mock(() => undefined),
      onDirectMessage: mock(() => undefined),
      onSubscribedMessage: mock(() => undefined),
      onNewMessage: mock(
        (
          _pattern: RegExp,
          handler: (thread: unknown, message: unknown) => Promise<void>,
        ) => {
          unmatchedHandler = handler;
        },
      ),
    };
    const channelHasMessageSubscription = mock(async () => false);
    const connection: PlatformConnection = {
      ...buildConnection(),
      id: "slackinst-grid",
      organizationId: "org-grid",
      agentId: undefined,
    };
    const bridge = registerMessageHandlers(
      chat,
      connection,
      {
        getArtifactStore: () => null,
        getPublicGatewayUrl: () => "https://gateway.example.com",
        getAutomationSubscriptionService: () => ({
          channelHasMessageSubscription,
        }),
      } as any,
      { getInstance: () => null } as any,
    );
    const handleMessage = mock(async () => undefined);
    bridge.handleMessage = handleMessage as typeof bridge.handleMessage;

    await unmatchedHandler!(
      { id: "slack:C_OTHER:1", channelId: "slack:C_OTHER" },
      makeMessage({ id: "1", text: "unlinked" }),
    );

    expect(channelHasMessageSubscription).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  test("bot-authored catch-all messages cannot create reply loops", async () => {
    let unmatchedHandler:
      | ((thread: unknown, message: unknown) => Promise<void>)
      | undefined;
    const chat = {
      onNewMention: mock(() => undefined),
      onDirectMessage: mock(() => undefined),
      onSubscribedMessage: mock(() => undefined),
      onNewMessage: mock(
        (
          _pattern: RegExp,
          handler: (thread: unknown, message: unknown) => Promise<void>,
        ) => {
          unmatchedHandler = handler;
        },
      ),
    };
    const channelHasMessageSubscription = mock(async () => true);
    const connection: PlatformConnection = {
      ...buildConnection(),
      id: "slackinst-grid",
      organizationId: "org-grid",
      agentId: undefined,
    };
    const bridge = registerMessageHandlers(
      chat,
      connection,
      {
        getArtifactStore: () => null,
        getPublicGatewayUrl: () => "https://gateway.example.com",
        getAutomationSubscriptionService: () => ({
          channelHasMessageSubscription,
        }),
      } as any,
      { getInstance: () => null } as any,
    );
    const handleMessage = mock(async () => undefined);
    bridge.handleMessage = handleMessage as typeof bridge.handleMessage;

    await unmatchedHandler!(
      { id: "slack:C_LINKED:2", channelId: "slack:C_LINKED" },
      makeMessage({
        id: "2",
        author: {
          userId: "B_OTHER",
          userName: "otherbot",
          isBot: true,
          isMe: false,
        },
      }),
    );

    expect(channelHasMessageSubscription).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
  });
});

function priorMessage(id: string, text: string, isMe: boolean, whenMs: number) {
  return {
    id,
    text,
    author: {
      userId: isMe ? "U_BOT" : "U_USER",
      userName: isMe ? "testbot" : "alice",
      fullName: isMe ? "TestBot" : "Alice",
      isBot: isMe,
      isMe,
    },
    raw: {},
    attachments: [],
    metadata: { dateSent: new Date(whenMs), edited: false },
  };
}

describe("MessageHandlerBridge.handleMessage — thread backfill", () => {
  test("first mention with empty history backfills via adapter.fetchMessages", async () => {
    const fetchMessages = mock(async () => ({
      messages: [
        priorMessage("M1", "favorite color is teal", false, 1_700_000_001_000),
        priorMessage("M2", "I drive a Civic", false, 1_700_000_002_000),
        // Drop the current mention — handler should skip it by id.
        priorMessage(
          "M_NEW",
          "<@U_BOT> what was the prior context?",
          false,
					1_700_000_003_000,
        ),
      ],
    }));
    const { bridge, conversationState, adapter, enqueueMessage } =
      createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(fetchMessages.mock.calls[0]?.[0]).toBe(THREAD_ID);
    expect(fetchMessages.mock.calls[0]?.[1]).toEqual({
      limit: 50,
      direction: "forward",
    });

		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    // 2 backfilled (current message id is skipped) + the current mention
    // message (mention text stripped of `<@U_BOT>`).
    expect(entries.map((e) => e.content)).toEqual([
      "favorite color is teal",
      "I drive a Civic",
      "what was the prior context?",
    ]);
    expect(entries[0]?.role).toBe("user");

    // Worker payload's conversationHistory was snapshotted AFTER backfill
    // but BEFORE the new mention was appended — so backfill is visible
    // and the current message is not (it gets passed via messageText).
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    const history = payload.platformMetadata.conversationHistory;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "favorite color is teal",
    });
  });

  test("backfilled bot replies are tagged role=assistant", async () => {
    const fetchMessages = mock(async () => ({
      messages: [
        priorMessage("M1", "Alice: hi", false, 1),
        priorMessage("M2", "Hi Alice — how can I help?", true, 2),
      ],
    }));
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "mention");

		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    expect(entries[0]?.role).toBe("user");
    expect(entries[1]?.role).toBe("assistant");
  });

  test("second mention in the same thread does not refetch — claim is one-shot", async () => {
    const fetchMessages = mock(async () => ({
      messages: [priorMessage("M1", "hello", false, 1)],
    }));
    const { bridge, adapter } = createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  test("DM source skips backfill — DMs are linear, no hidden history", async () => {
    const fetchMessages = mock(async () => ({ messages: [] }));
    const { bridge, adapter } = createBridgeHarness({ fetchMessages });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "dm");

    expect(fetchMessages).not.toHaveBeenCalled();
  });

  test("subscribed source also backfills if no prior claim exists", async () => {
    const fetchMessages = mock(async () => ({
      messages: [priorMessage("M1", "earlier note", false, 1)],
    }));
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    await bridge.handleMessage(thread, makeMessage(), "subscribed");

    expect(fetchMessages).toHaveBeenCalledTimes(1);
		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    expect(entries.map((e) => e.content)).toContain("earlier note");
  });

  test("fetchMessages failure releases the claim so the next event retries", async () => {
    let calls = 0;
    const fetchMessages = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("Slack rate limited");
      return { messages: [priorMessage("M1", "recovered", false, 1)] };
    });
    const { bridge, conversationState, adapter } = createBridgeHarness({
      fetchMessages,
    });
    const thread = makeThread(adapter);

    // First mention — fetch throws, marker is released.
    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    expect(fetchMessages).toHaveBeenCalledTimes(1);
		let entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    // Only the current message survives — no backfill from the throw.
    expect(entries.map((e) => e.content)).toEqual([
      "what was the prior context?",
    ]);

    // Second mention — claim is free, fetch retries and succeeds.
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");
    expect(fetchMessages).toHaveBeenCalledTimes(2);
		entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    expect(entries.map((e) => e.content)).toContain("recovered");
  });

  test("adapter without fetchMessages does not retry-storm", async () => {
    // Some adapters may not implement fetchMessages. We must keep the claim
    // (treating it as success) so subsequent events don't re-probe a
    // missing capability on every message.
    const { bridge, conversationState } = createBridgeHarness({
      withAdapter: true,
    });
    const thread = makeThread({});

    await bridge.handleMessage(thread, makeMessage({ id: "M_A" }), "mention");
    await bridge.handleMessage(thread, makeMessage({ id: "M_B" }), "mention");

    // Only the two current mentions land in history.
		const entries = await conversationState.getEntries(
			CONN_ID,
			CHANNEL_ID,
			THREAD_ID,
		);
    expect(entries).toHaveLength(2);
  });
});

describe("MessageHandlerBridge.handleMessage — routing and unlinked chats", () => {
  function makePreviewHarness(opts: {
    /** Chat platform for the connection (default "slack"). */
    platform?: string;
    linkedAutomation?: {
      agentId: string;
      organizationId?: string;
      model?: string;
    } | null;
    fallbackSubscription?: {
      agentId: string;
      organizationId?: string;
      model?: string;
    };
    previewMode?: boolean;
    agentId?: string | undefined;
    metadata?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    commandDispatcher?: {
      tryHandleSlashText?: (...args: any[]) => Promise<boolean>;
      tryHandle?: (...args: any[]) => Promise<boolean>;
    };
    providerCatalog?: unknown;
    automations?: MatchingAutomationActivation[];
    provideSubscriptionService?: boolean;
  }) {
    const state = new InMemoryStateAdapter();
    const conversationState = new ConversationStateStore(state);
    const platform = opts.platform ?? "slack";
    const connection: PlatformConnection = {
      id: CONN_ID,
      platform,
      // Default to the template agent; tests for an OAuth-installed workspace
      // connection (no owning agent) pass `agentId: undefined` explicitly.
      agentId: "agentId" in opts ? opts.agentId : TEMPLATE_AGENT_ID,
      // The hosted preview connection lives in its OWN org; linked Automations may
      // live in OTHER orgs (see the cross-org test below).
      organizationId: "org-connection",
      config: { platform } as any,
      settings: {
        allowGroups: true,
        previewMode: opts.previewMode ?? true,
        ...opts.settings,
      },
      metadata: opts.metadata ?? { botUsername: "testbot", botUserId: "U_BOT" },
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    const enqueueMessage = mock(async () => undefined);
    const healSubscriptionTeam = mock(async () => undefined);
    const plannedAutomations: MatchingAutomationActivation[] =
      opts.automations ??
      (opts.linkedAutomation
        ? [
            {
              automationId: 70,
              organizationId:
                opts.linkedAutomation.organizationId ?? connection.organizationId,
              agentId: opts.linkedAutomation.agentId,
              deviceWorkerId: null,
              agentKind: null,
              model: opts.linkedAutomation.model ?? null,
              instructions: "Respond helpfully to the incoming message.",
              minCooldownSeconds: 0,
              trigger: {
                kind: "event",
                connector_key: "slack",
                connection_id: 42,
                event_types: ["message.created"],
                match: { channel_id: CHANNEL_ID },
                execution: "turn",
                active_run: "steer",
                output: "reply_to_source",
                skip_if_unchanged: false,
              },
            },
          ]
        : []);
    const resolveForConnection = mock(
      async () => opts.fallbackSubscription ?? null,
    );
    // Default: if the harness planned Automations for this channel, treat the
    // channel as subscribed (even when trigger filters reject this message).
    const channelHasMessageSubscription = mock(
      async () => plannedAutomations.length > 0,
    );
    const materializeConnectionFallbackLink = mock(async () => true);
    // `provideSubscriptionService` forces the service to be present even with no
    // planned Automations — needed to assert the connection-fallback materializer.
    const automationSubscriptionService =
      plannedAutomations.length === 0 &&
      opts.fallbackSubscription === undefined &&
      !opts.provideSubscriptionService
        ? undefined
				: {
						resolveForConnection,
						healSubscriptionTeam,
						channelHasMessageSubscription,
						materializeConnectionFallbackLink,
					};
    const services = {
      getArtifactStore: () => null,
      getPublicGatewayUrl: () => "https://gateway.example.com",
      getAutomationSubscriptionService: () => automationSubscriptionService,
      getAgentMetadataStore: () => undefined,
      getUserAgentsStore: () => undefined,
      getTranscriptionService: () => undefined,
      getAgentSettingsStore: () => undefined,
      getDeclaredAgentRegistry: () => undefined,
      getQueueProducer: () => ({ enqueueMessage }),
      getProviderCatalogService: () => opts.providerCatalog,
    } as any;
    const manager = {
      has: () => true,
      getInstance: () => ({ connection, conversationState }),
    } as any;
    const bridge = new MessageHandlerBridge(
      connection,
      services,
      manager,
			opts.commandDispatcher as never,
      async ({ signal }) =>
        planAutomationActivations(
          {
            ...signal,
            connection_id: plannedAutomations[0]?.trigger.connection_id,
          },
          plannedAutomations.filter(
            (automation) =>
              matchingAutomationTriggers([automation.trigger], {
                ...signal,
                connection_id: automation.trigger.connection_id,
              }).length > 0,
          ),
        ),
      automationCooldown,
    );
    return {
      bridge,
      enqueueMessage,
      conversationState,
      healSubscriptionTeam,
      resolveForConnection,
      materializeConnectionFallbackLink,
    };
  }

  test("unlinked chat → posts /lobu link instructions, no agent run", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("adapter-normalized help dispatches before preview onboarding", async () => {
    const tryHandleSlashText = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      linkedAutomation: null,
      commandDispatcher: {
        tryHandleSlashText,
        tryHandle: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/help" }),
      "dm",
    );

    expect(tryHandleSlashText).toHaveBeenCalledTimes(1);
    expect(tryHandleSlashText.mock.calls[0]?.[0]).toBe("/help");
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("Google Chat /lobu clear clears the scoped history without an agent turn", async () => {
    const { bridge, conversationState, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      previewMode: false,
    });
    const thread = makeThread(undefined);
    await conversationState.appendHistory(CONN_ID, CHANNEL_ID, THREAD_ID, {
      role: "user",
      content: "remember this",
      timestamp: Date.now(),
    });

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/lobu clear" }),
      "dm",
    );

    expect(
      await conversationState.getEntries(CONN_ID, CHANNEL_ID, THREAD_ID),
    ).toEqual([]);
    expect(thread.post).toHaveBeenCalledWith({ text: "Chat history cleared." });
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("Google Chat /lobu new reaches the worker as a real session reset", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      previewMode: false,
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ text: "/lobu new" }),
      "dm",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.messageText).toBe("Starting new session.");
    expect(payload.platformMetadata?.sessionReset).toBe(true);
  });

  test("linked chat → routes to the Automation's agent, no notice", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
			"linked-agent",
    );
    expect(
      thread.post.mock.calls.every(
				(c: unknown[]) => !String(c[0]).includes("/lobu link"),
			),
    ).toBe(true);
  });

  test("Google Chat typed messages preserve the verified sender at Automation ingress", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "gchat",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      automations: [
        {
          automationId: 90,
          organizationId: "org-connection",
          agentId: "poll-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Interpret typed poll responses.",
          minCooldownSeconds: 0,
          trigger,
        },
      ],
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({
        id: "spaces/AAAA/messages/vote-typed-1",
        text: "Vote B",
        author: {
          userId: "users/typed-voter",
          userName: "typed-voter",
          fullName: "Typed Voter",
          isBot: false,
          isMe: false,
        },
      }),
      "mention",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMessage.mock.calls[0]?.[0]).toMatchObject({
      userId: "users/typed-voter",
      messageId: "spaces/AAAA/messages/vote-typed-1:automation:90",
      platformMetadata: {
        senderId: "users/typed-voter",
        senderDisplayName: "Typed Voter",
        automationId: 90,
        automationDeliveryId: `chat:${CONN_ID}:spaces/AAAA/messages/vote-typed-1`,
      },
    });
  });

  test("stamps authoritative directness on messages but not interaction clicks", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
    });
    const thread = makeThread(undefined);

    // A reply inside a DM thread has conversationId !== channelId. Directness
    // comes from the inbound event type, not that threading relationship.
    await bridge.handleMessage(thread, makeMessage(), "dm");
    const dmPayload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(dmPayload.platformMetadata.isDirect).toBe(true);

    await bridge.ingestClick({
      userId: "U_USER",
      channelId: CHANNEL_ID,
      conversationId: THREAD_ID,
      value: "Continue",
      thread,
    });
    const clickPayload = enqueueMessage.mock.calls[1]?.[0] as any;
    expect(clickPayload.platformMetadata.isDirect).toBeUndefined();
  });

  test("fails closed when an interaction has no routing context", async () => {
    const { bridge } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
    });

    await expect(
      bridge.handleMessage(
        makeThread(undefined),
        makeMessage(),
        "interaction",
        undefined as never,
      ),
    ).rejects.toThrow("Interaction messages require explicit routing context");
  });

  test("routes suggestion clicks through message.created Automation ingress with a replay-stable identity", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "gchat",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const automation: MatchingAutomationActivation = {
      automationId: 91,
      organizationId: "org-connection",
      agentId: "poll-agent",
      deviceWorkerId: null,
      agentKind: null,
      model: null,
      instructions: "Handle the verified chat interaction.",
      minCooldownSeconds: 0,
      trigger,
    };
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      automations: [automation],
    });
    const thread = makeThread(undefined);

    await bridge.ingestClick({
      userId: "users/clicker-a",
      channelId: CHANNEL_ID,
      conversationId: THREAD_ID,
      teamId: "gchat-workspace-1",
      value: "Vote B",
      thread,
      interactionId: "interaction-gchat-card-click-1",
    });

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.userId).toBe("users/clicker-a");
    expect(payload.messageId).toBe(
      "interaction-gchat-card-click-1:automation:91"
    );
    expect(payload.teamId).toBe("gchat-workspace-1");
    expect(payload.platformMetadata).toMatchObject({
      senderId: "users/clicker-a",
      automationId: 91,
      automationDeliveryId:
        `chat:${CONN_ID}:interaction-gchat-card-click-1`,
    });
  });

  test("matching reply Automations fan out as independent turns with one history entry", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const automations: MatchingAutomationActivation[] = [
      {
        automationId: 71,
        organizationId: "org-a",
        agentId: "agent-a",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Handle support messages.",
        minCooldownSeconds: 0,
        trigger,
      },
      {
        automationId: 72,
        organizationId: "org-b",
        agentId: "agent-b",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Audit support messages.",
        minCooldownSeconds: 0,
        trigger,
      },
    ];
    const {
      bridge,
      enqueueMessage,
      conversationState,
      healSubscriptionTeam,
    } = makePreviewHarness({ automations });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(2);
    const payloads = enqueueMessage.mock.calls.map((call) => call[0] as any);
    expect(payloads.map((payload) => payload.agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(payloads.map((payload) => payload.organizationId)).toEqual([
      "org-a",
      "org-b",
    ]);
    expect(payloads[0]?.messageId).not.toBe(payloads[1]?.messageId);
    expect(payloads[0]?.ephemeralContext).toContain("Handle support messages.");
    expect(healSubscriptionTeam).toHaveBeenCalledTimes(2);
    expect(healSubscriptionTeam.mock.calls.map((call) => call[2])).toEqual([
      "org-a",
      "org-b",
    ]);
    const entries = await conversationState.getEntries(
      CONN_ID,
      CHANNEL_ID,
      THREAD_ID,
    );
    expect(entries).toHaveLength(1);
  });

  test("a reply Automation inside its cooldown window is suppressed", async () => {
    // `reply_to_source` targets are handed to the chat transport and never
    // write a `automation` run row, so a cooldown expressed over `runs` was a
    // silent no-op for these Automations.
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const automations: MatchingAutomationActivation[] = [
      {
        automationId: 81,
        organizationId: "org-a",
        agentId: "agent-a",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Handle support messages.",
        minCooldownSeconds: 1800,
        trigger,
      },
    ];
    cooldownClaims.length = 0;
    activationMarks.length = 0;
    cooldownAllows = false;
    try {
      const { bridge, enqueueMessage } = makePreviewHarness({ automations });
      const thread = makeThread(undefined);

      await bridge.handleMessage(
        thread,
        makeMessage({ raw: { team_id: "TREAL" } }),
        "mention",
      );

      expect(cooldownClaims).toEqual([81]);
      expect(activationMarks).toEqual([]);
      expect(enqueueMessage).not.toHaveBeenCalled();
      // A suppressed Automation must not fall through to the connection owner —
      // that would answer the message with a plain chat turn and defeat the
      // debounce entirely.
      expect(
        thread.post.mock.calls.every(
          (c: unknown[]) => !String(c[0]).includes("/lobu link"),
        ),
      ).toBe(true);
    } finally {
      cooldownAllows = true;
    }
  });

  test("a reply Automation at the 0 default never reaches the cooldown claim", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const automations: MatchingAutomationActivation[] = [
      {
        automationId: 82,
        organizationId: "org-a",
        agentId: "agent-a",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Handle support messages.",
        minCooldownSeconds: 0,
        trigger,
      },
    ];
    cooldownClaims.length = 0;
    activationMarks.length = 0;
    const { bridge, enqueueMessage } = makePreviewHarness({ automations });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    // Ordinary chat must not enter the serialized pre-enqueue cooldown claim.
    expect(cooldownClaims).toEqual([]);
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(activationMarks).toEqual([82]);
  });

  test("a failed zero-cooldown enqueue does not stamp activation", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const automations: MatchingAutomationActivation[] = [
      {
        automationId: 83,
        organizationId: "org-a",
        agentId: "agent-a",
        deviceWorkerId: null,
        agentKind: null,
        model: null,
        instructions: "Handle support messages.",
        minCooldownSeconds: 0,
        trigger,
      },
    ];
    activationMarks.length = 0;
    const { bridge, enqueueMessage } = makePreviewHarness({ automations });
    enqueueMessage.mockImplementationOnce(async () => {
      throw new Error("queue unavailable");
    });

    await expect(
      bridge.handleMessage(
        makeThread(undefined),
        makeMessage({ raw: { team_id: "TREAL" } }),
        "mention",
      ),
    ).rejects.toThrow("queue unavailable");

    expect(activationMarks).toEqual([]);
  });

  test("a failed activation stamp still dispatches every matched Automation", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const base = {
      organizationId: "org-a",
      agentId: "agent-a",
      deviceWorkerId: null,
      agentKind: null,
      model: null,
      instructions: "Handle support messages.",
      minCooldownSeconds: 0,
      trigger,
    };
    const automations: MatchingAutomationActivation[] = [
      { ...base, automationId: 84 },
      { ...base, automationId: 85 },
    ];
    activationMarks.length = 0;
    markZeroThrows = true;
    try {
      const { bridge, enqueueMessage } = makePreviewHarness({ automations });

      // The stamp is observability only — the first target's failure must not
      // abort the loop and strand the second Automation's turn.
      await bridge.handleMessage(
        makeThread(undefined),
        makeMessage({ raw: { team_id: "TREAL" } }),
        "mention",
      );

      expect(enqueueMessage).toHaveBeenCalledTimes(2);
    } finally {
      markZeroThrows = false;
    }
  });

  test("a rejected Automation filter cannot be bypassed by channel fallback", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID, mention_only: true },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    activationMarks.length = 0;
    const { bridge, enqueueMessage, resolveForConnection } = makePreviewHarness({
      agentId: undefined,
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      fallbackSubscription: {
        agentId: "filtered-agent",
        organizationId: "org-filtered",
      },
      automations: [
        {
          automationId: 73,
          organizationId: "org-filtered",
          agentId: "filtered-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Only respond to mentions.",
          trigger,
        },
      ],
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "ordinary chatter", isMention: false }),
      "subscribed",
    );

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(activationMarks).toEqual([]);
    expect(resolveForConnection).not.toHaveBeenCalled();
    // Linked + filter-rejected must not spam the "link your agent" notice.
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("adapter-normalized help bypasses a rejected linked Automation filter", async () => {
    const tryHandleSlashText = mock(async () => true);
    const trigger = {
      kind: "event" as const,
      connector_key: "gchat",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID, mention_only: true },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, enqueueMessage, resolveForConnection } = makePreviewHarness({
      platform: "gchat",
      agentId: undefined,
      previewMode: false,
      commandDispatcher: {
        tryHandleSlashText,
        tryHandle: mock(async () => false),
      },
      fallbackSubscription: {
        agentId: "filtered-agent",
        organizationId: "org-filtered",
      },
      automations: [
        {
          automationId: 74,
          organizationId: "org-filtered",
          agentId: "filtered-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Only respond to mentions.",
          trigger,
        },
      ],
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ text: "/help", isMention: false }),
      "subscribed",
    );

    expect(tryHandleSlashText).toHaveBeenCalledTimes(1);
    expect(tryHandleSlashText.mock.calls[0]?.[0]).toBe("/help");
    expect(resolveForConnection).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("adapter-normalized help bypasses record-only capture for a matched Automation", async () => {
    const tryHandleSlashText = mock(async () => true);
    const trigger = {
      kind: "event" as const,
      connector_key: "gchat",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "gchat",
      previewMode: false,
      settings: { recordChannelMessages: true },
      commandDispatcher: {
        tryHandleSlashText,
        tryHandle: mock(async () => false),
      },
      automations: [
        {
          automationId: 75,
          organizationId: "org-connection",
          agentId: "recording-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Capture ordinary messages and respond to commands.",
          trigger,
        },
      ],
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ text: "/help", isMention: false }),
      "subscribed",
    );

    expect(tryHandleSlashText).toHaveBeenCalledTimes(1);
    expect(tryHandleSlashText.mock.calls[0]?.[0]).toBe("/help");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("recordChannelMessages skips agent turns for Automation-routed subscribed messages", async () => {
    // Pre-Automation, record-only mode captured non-mention channel traffic
    // without starting a turn. After the cutover, Automation-routed channels
    // must honor the same flag (mentions still respond).
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
      previewMode: false,
      settings: { recordChannelMessages: true },
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({
        text: "ordinary channel chatter",
        isMention: false,
      }),
      "subscribed",
    );

    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("recordChannelMessages still enqueues Automation turns on mentions", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
      previewMode: false,
      settings: { recordChannelMessages: true },
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ isMention: true }),
      "mention",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
  });

  test("matching Automation self-heals its Slack workspace team", async () => {
    const trigger = {
      kind: "event" as const,
      connector_key: "slack",
      connection_id: 42,
      event_types: ["message.created"],
      match: { channel_id: CHANNEL_ID },
      execution: "turn" as const,
      active_run: "queue" as const,
      output: "reply_to_source" as const,
      skip_if_unchanged: false,
    };
    const { bridge, healSubscriptionTeam } = makePreviewHarness({
      automations: [
        {
          automationId: 71,
          organizationId: "org-automation",
          agentId: "agent-a",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Handle support messages.",
          minCooldownSeconds: 0,
          trigger,
        },
      ],
    });

    await bridge.handleMessage(
      makeThread(undefined),
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(healSubscriptionTeam).toHaveBeenCalledWith(
      CONN_ID,
      CHANNEL_ID,
      "org-automation",
      "TREAL",
    );
  });

  test("OAuth workspace connection (no agent, not preview): unlinked → link notice, no agent run", async () => {
    // A tenant's OAuth-installed bot has no owning agent and metadata.teamId.
    // An unlinked non-command message must get a "link your agent" notice instead
    // of being silently dropped, and must NOT enqueue a worker turn against a
    // non-existent agent.
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("telegram unrouted message → generic link notice, no agent run (#2230)", async () => {
    // Same dead end as the Slack OAuth test above, but on a non-Slack platform:
    // no owning agent, no channel Automation. Slack replies with a link notice;
    // every other platform used to log a warn and drop the message silently.
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "telegram",
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { botUsername: "testbot" },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "hello, anyone there?" }),
      "dm"
    );

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    const posted = String(thread.post.mock.calls[0]?.[0]);
    expect(posted).toContain("isn't linked");
    // Platform-native command spelling — not Slack's `/lobu link` wrapper.
    expect(posted).toContain("/link <code>");
    expect(posted).not.toContain("/lobu link");
  });

  test("telegram unrouted button click → generic link notice, no turn (#2230)", async () => {
    // The interaction drop site has the same shape as the message one.
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "telegram",
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { botUsername: "testbot" },
    });
    const thread = makeThread(undefined);

    await bridge.ingestClick({
      userId: "U_USER",
      channelId: CHANNEL_ID,
      conversationId: THREAD_ID,
      value: "Approve",
      thread,
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/link <code>");
  });

  test("slack OAuth workspace unrouted click → link notice (interaction parity)", async () => {
    // Slack itself also used to drop unrouted interactions silently — only the
    // message path had the notice. Both sites now share one helper.
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
    });
    const thread = makeThread(undefined);

    await bridge.ingestClick({
      userId: "U_USER",
      channelId: CHANNEL_ID,
      conversationId: THREAD_ID,
      value: "Approve",
      thread,
    });

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("/lobu link");
  });

  test("`/link <code>` in an unrouted telegram chat reaches the dispatcher, not the notice (#2230)", async () => {
    // The notice tells the user to paste `/link <code>` into this same chat.
    // On Slack that arrives as a native slash command (its own ingress path);
    // on every other platform it arrives as plain message text — so it must
    // dispatch from the unrouted dead end instead of being dropped with it.
    const tryHandleSlashText = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "telegram",
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { botUsername: "testbot" },
      commandDispatcher: {
        tryHandleSlashText,
        tryHandle: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/link crm-ABC123" }),
      "dm"
    );

    expect(tryHandleSlashText).toHaveBeenCalledTimes(1);
    expect(tryHandleSlashText.mock.calls[0]?.[0]).toBe("/link crm-ABC123");
    expect(thread.post).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("`@bot /link <code>` in an unrouted chat dispatches on mention-stripped text", async () => {
    // Addressing the bot by mention is the normal way to reach it in a
    // mention-gated group chat, and the slash regex requires a leading `/` — so
    // the dead-end dispatch must run on the same mention-stripped text every
    // other command call site uses, not the raw message.
    const tryHandleSlashText = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "telegram",
      linkedAutomation: null,
      previewMode: false,
      agentId: undefined,
      metadata: { botUsername: "testbot", botUserId: "U_BOT" },
      commandDispatcher: {
        tryHandleSlashText,
        tryHandle: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "@testbot <@U_BOT> /link crm-ABC123" }),
      "mention"
    );

    expect(tryHandleSlashText).toHaveBeenCalledTimes(1);
    expect(tryHandleSlashText.mock.calls[0]?.[0]).toBe("/link crm-ABC123");
    expect(thread.post).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("telegram linked mention-only channel: ordinary chatter gets no notice spam", async () => {
    // Mirror of the Slack loop-prevention semantics: a channel that HAS an
    // Automation subscription but whose trigger filters rejected this message
    // must stay silent — the notice is only for genuinely unlinked chats.
    const { bridge, enqueueMessage } = makePreviewHarness({
      platform: "telegram",
      previewMode: false,
      agentId: undefined,
      metadata: { botUsername: "testbot" },
      automations: [
        {
          automationId: 74,
          organizationId: "org-connection",
          agentId: "tg-agent",
          deviceWorkerId: null,
          agentKind: null,
          model: null,
          instructions: "Only respond to mentions.",
          trigger: {
            kind: "event",
            connector_key: "telegram",
            connection_id: 42,
            event_types: ["message.created"],
            match: { channel_id: CHANNEL_ID, mention_only: true },
            execution: "turn",
            active_run: "queue",
            output: "reply_to_source",
            skip_if_unchanged: false,
          },
        },
      ],
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "ordinary chatter", isMention: false }),
      "subscribed"
    );

    expect(thread.post).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  // Build a mock ProviderCatalogService for the preflight path. `findProviderForModel`
  // matches a ref to its module by the `<slug>/` prefix (mirrors the real one).
  function makeCatalogMock(opts: {
    modules: Array<{ providerId: string }>;
    allowedRefs: string[] | null;
  }) {
    return {
      getModelPolicy: mock(async () => ({
        modules: opts.modules,
        allowedRefs: opts.allowedRefs,
      })),
      findProviderForModel: mock(async (ref: string, mods?: Array<{ providerId: string }>) => {
        const slash = ref.indexOf("/");
        const prefix = slash > 0 ? ref.slice(0, slash) : ref;
        return (mods ?? opts.modules).find((m) => m.providerId === prefix);
      }),
    };
  }

  test("device chat bypasses cloud provider lookup and preserves its exact local model", async () => {
    const providerCatalog = makeCatalogMock({ modules: [], allowedRefs: null });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "local-agent", organizationId: "org-bound" },
      automations: [{
        automationId: 71, organizationId: "org-bound", agentId: "local-agent",
        deviceWorkerId: "device-test", agentKind: "codex", model: "test-local-model",
        effort: "medium", instructions: "Run this chat", minCooldownSeconds: 0,
        trigger: { kind: "event", connector_key: "slack", connection_id: 42,
          event_types: ["message.created"], match: { channel_id: CHANNEL_ID },
          execution: "turn", output: "reply_to_source", active_run: "steer" },
      }],
      providerCatalog,
    });
    const thread = makeThread(undefined);
    await bridge.handleMessage(thread, makeMessage(), "mention");
    expect(providerCatalog.getModelPolicy).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMessage.mock.calls[0]?.[0]).toMatchObject({
      executionTarget: { kind: "device", deviceWorkerId: "device-test", agentKind: "codex" },
      agentOptions: { model: "test-local-model", effort: "medium" },
    });
  });

  test("device chat without a model uses the local CLI default", async () => {
    const providerCatalog = makeCatalogMock({ modules: [], allowedRefs: null });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "local-agent", organizationId: "org-bound" },
      automations: [{
        automationId: 71, organizationId: "org-bound", agentId: "local-agent",
        deviceWorkerId: "device-test", agentKind: "codex", model: null,
        effort: "medium", instructions: "Run this chat", minCooldownSeconds: 0,
        trigger: { kind: "event", connector_key: "slack", connection_id: 42,
          event_types: ["message.created"], match: { channel_id: CHANNEL_ID },
          execution: "turn", output: "reply_to_source", active_run: "steer" },
      }],
      providerCatalog,
    });
    const thread = makeThread(undefined);
    await bridge.handleMessage(thread, makeMessage(), "mention");
    expect(providerCatalog.getModelPolicy).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMessage.mock.calls[0]?.[0]).toMatchObject({
      executionTarget: { kind: "device", deviceWorkerId: "device-test", agentKind: "codex" },
      agentOptions: { effort: "medium" },
    });
    expect(enqueueMessage.mock.calls[0]?.[0].agentOptions).not.toHaveProperty("model");
  });

  test("a device pin naming no local CLI is refused instead of enqueued unclaimable", async () => {
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: { agentId: "local-agent", organizationId: "org-bound" },
      automations: [{
        automationId: 71, organizationId: "org-bound", agentId: "local-agent",
        deviceWorkerId: "device-test", agentKind: null, model: null,
        effort: null, instructions: "Run this chat", minCooldownSeconds: 0,
        trigger: { kind: "event", connector_key: "slack", connection_id: 42,
          event_types: ["message.created"], match: { channel_id: CHANNEL_ID },
          execution: "turn", output: "reply_to_source", active_run: "steer" },
      }],
    });
    const thread = makeThread(undefined);
    await bridge.handleMessage(thread, makeMessage(), "mention");
    // The device claim filter matches on `executionTarget.agentKind`, so an
    // enqueued run with a null kind would sit pending forever.
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(String(thread.post.mock.calls[0]?.[0])).toContain("local agent CLI");
  });

  test("unroutable model provider posts a plain Slack text fallback and skips enqueue", async () => {
    // Empty allow-list (allow-all) but the provider module isn't present/routable.
    const providerCatalog = makeCatalogMock({ modules: [], allowedRefs: null });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    // The preflight now emits its reason text + a provider-connect CTA through
    // the shared buildCtaCardPayload path. With no WorkspaceProvider inited in
    // this bun suite, the org slug can't resolve, so the CTA URL is null and the
    // payload degrades to a plain text string (no card) — the fallback the
    // helper guarantees. Assert the new copy; there's no setup URL to check.
    const posted = thread.post.mock.calls[0]?.[0];
    expect(typeof posted).toBe("string");
    expect(posted).toContain("z-ai/glm-5.2");
    expect(posted).toContain("isn't connected or has no credentials");
    expect(posted).not.toContain("api/proxy");
  });

  test("EXACT GATE: an override on a LISTED provider but NOT in the list is rejected", async () => {
    // The agent allows only openai/gpt-5. The override is openai/other — same
    // PROVIDER, different MODEL — so the exact gate must reject it, even though a
    // provider-slug gate would have let it through.
    const openai = {
      providerId: "openai",
      hasSystemKey: () => true,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => [{ value: "openai/gpt-5" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [openai],
      allowedRefs: ["openai/gpt-5"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "openai/other",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    // openai/other is NOT in the allow-list, so the exact gate blocks it. The
    // only listed ref (openai/gpt-5) is routable, so preflight falls back to it.
    // The disallowed model must never reach the worker.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentOptions?.model).not.toBe("openai/other");
    expect(payload.agentOptions?.model).toBe("openai/gpt-5");
  });

  test("FALLBACK iterates the LISTED alternates in order, never the catalog default", async () => {
    // models=["xai/grok-4","openai/gpt-5"] but the DEFAULT provider (xai) is
    // unroutable. The fallback must be the LISTED alternate openai/gpt-5 (an
    // exact models[] entry), and the code must NOT consult getModelOptions to
    // pick a provider's catalog/first default. We prove that by exploding if
    // getModelOptions is ever called.
    const xai = {
      providerId: "xai",
      hasSystemKey: () => false,
      hasCredentials: async () => false, // unroutable
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => {
        throw new Error("fallback must not consult getModelOptions");
      },
    };
    const openai = {
      providerId: "openai",
      hasSystemKey: () => true,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => {
        throw new Error("fallback must not consult getModelOptions");
      },
    };
    const providerCatalog = makeCatalogMock({
      modules: [xai, openai],
      allowedRefs: ["xai/grok-4", "openai/gpt-5"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "xai/grok-4",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    // The exact LISTED alternate wins.
    expect(payload.agentOptions?.model).toBe("openai/gpt-5");
  });

  test("configured model provider unconnected, but a listed alternate IS routable → falls back and enqueues", async () => {
    const zai = {
      providerId: "z-ai",
      hasSystemKey: () => false,
      hasCredentials: async () => false, // unroutable: no credentials
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => [{ value: "z-ai/glm-5.2" }],
    };
    const openai = {
      providerId: "openai",
      hasSystemKey: () => false,
      hasCredentials: async () => true,
      getProxyBaseUrlMappings: () => ({ openai: "https://gw/api/proxy/openai" }),
      getModelOptions: async () => [{ value: "openai/gpt-4o-mini" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [zai, openai],
      // Both the failed default and the routable alternate are listed exactly.
      allowedRefs: ["z-ai/glm-5.2", "openai/gpt-4o-mini"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    // Ran on the listed alternate, did not post a "can't run this yet" error.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentOptions?.model).toBe("openai/gpt-4o-mini");
    expect(
      thread.post.mock.calls.every(
        (c: unknown[]) => !String(c[0]).includes("I can't run this yet"),
      ),
    ).toBe(true);
  });

  test("no connected provider at all → still posts the setup-link error, no enqueue", async () => {
    const zai = {
      providerId: "z-ai",
      hasSystemKey: () => false,
      hasCredentials: async () => false,
      getProxyBaseUrlMappings: () => ({}),
      getModelOptions: async () => [{ value: "z-ai/glm-5.2" }],
    };
    const providerCatalog = makeCatalogMock({
      modules: [zai],
      allowedRefs: ["z-ai/glm-5.2"],
    });
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "lobu-builder",
        organizationId: "org-bound",
        model: "z-ai/glm-5.2",
      },
      providerCatalog,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledTimes(1);
    // Model is allowed but its provider isn't routable → the new provider-connect
    // reason copy (see the sibling test for why this degrades to a text string).
    expect(String(thread.post.mock.calls[0]?.[0])).toContain(
      "isn't connected or has no credentials",
    );
  });

  test("cross-org: routes the worker turn under the Automation's org, not the connection's", async () => {
    // Regression for the hosted-preview cross-org bug: a `/lobu link <code>`
    // creates an Automation for an agent in a DIFFERENT org than the preview connection.
    // The worker turn MUST run under the Automation's org, or the agent's workspace
    // (knowledge, secrets, providers) resolves under the wrong tenant.
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: {
        agentId: "food-ordering",
        organizationId: "org-bound",
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const payload = enqueueMessage.mock.calls[0]?.[0] as any;
    expect(payload.agentId ?? payload.platformMetadata?.agentId).toBe(
			"food-ordering",
    );
    // The Automation's org wins over the connection's org ("org-connection").
    expect(payload.organizationId).toBe("org-bound");
  });

  test("`/lobu link <code>` DM message dispatches link before the preview menu", async () => {
    // On a previewMode bot, an unlinked DM normally gets the demo-agent menu.
    // A `/lobu link <code>` arrives as plain message text in an AI-app DM (Slack
    // won't run slash commands there), so it MUST reach the dispatcher and bind
    // — not be preempted by the menu. parsePreviewLinkCode routes it to `link`.
    const tryHandle = mock(async () => true);
    const tryHandleSlashText = mock(async () => false);
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
      commandDispatcher: { tryHandle, tryHandleSlashText },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "/lobu link crm-ABC123" }),
			"dm",
    );

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("link");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("crm-ABC123");
    // The preview menu was NOT posted, and no agent run was queued.
    expect(
      thread.post.mock.calls.every(
				(c: unknown[]) => !String(c[0]).includes("/lobu link"),
			),
    ).toBe(true);
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("a bare preview-code paste in a DM dispatches link, not the menu", async () => {
    const tryHandle = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
      commandDispatcher: {
        tryHandle,
        tryHandleSlashText: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "crm-ABC123" }),
			"dm",
    );

    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(tryHandle.mock.calls[0]?.[0]).toBe("link");
    expect(tryHandle.mock.calls[0]?.[1]).toBe("crm-ABC123");
    expect(enqueueMessage).not.toHaveBeenCalled();
  });

  test("non-preview connection: a code-looking DM goes to the agent, not link", async () => {
    // The plain-text link parsing is gated to previewMode bots. On a normal
    // agent bot, `crm-ABC123` is just a message for the agent — it must NOT be
    // swallowed by the link command.
    const tryHandle = mock(async () => true);
    const { bridge, enqueueMessage } = makePreviewHarness({
      linkedAutomation: null,
      previewMode: false,
      commandDispatcher: {
        tryHandle,
        tryHandleSlashText: mock(async () => false),
      },
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ text: "crm-ABC123" }),
			"dm",
    );

    expect(tryHandle).not.toHaveBeenCalled();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
  });

  test("connection-owner fallback in a group channel materializes the chat-link Automation", async () => {
    // No Automation matches; the connection owns an agent, so routing falls back
    // to `source:"connection"`. The channel has no subscription row, so it would
    // be invisible to history/ACL/search — the materializer writes the row.
    const {
      bridge,
      enqueueMessage,
      materializeConnectionFallbackLink,
    } = makePreviewHarness({
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    // The turn still runs.
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    // …and the missing chat-link is materialized with the real workspace team.
    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
    const call = materializeConnectionFallbackLink.mock.calls[0] as unknown[];
    expect(call[1]).toBe("org-connection"); // organizationId
    expect(call[2]).toBe(TEMPLATE_AGENT_ID); // agentId
    expect(call[3]).toBe("slack"); // platform
    expect(call[5]).toBe("TREAL"); // real T-team passed through
  });

  test("connection fallback passes no team when Slack sends only an enterprise id", async () => {
    const { bridge, materializeConnectionFallbackLink } = makePreviewHarness({
      previewMode: false,
      metadata: { teamId: "T_WS", botUserId: "U_BOT" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "E0ENTERPRISE" } }),
      "mention",
    );

    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
    const call = materializeConnectionFallbackLink.mock.calls[0] as unknown[];
    expect(call[5]).toBeUndefined(); // enterprise E… id is never used as a team
  });

  test("connection fallback materialization is create-only so it cannot clobber an existing link", async () => {
    // A mention-only Automation exists but rejected this non-mention message, so
    // routing falls to the connection owner. The bridge still calls the
    // materializer — but it's create-only (see the DB-level preserve test in
    // agent-thread-list-scope-all), so an existing explicit link is never
    // relinked to the connection owner even under a check-then-write race.
    const automation: MatchingAutomationActivation = {
      automationId: 71,
      organizationId: "org-connection",
      agentId: "mention-only-agent",
      deviceWorkerId: null,
      agentKind: null,
      model: null,
      instructions: "Respond helpfully to the incoming message.",
      minCooldownSeconds: 0,
      trigger: {
        kind: "event",
        connector_key: "slack",
        connection_id: 42,
        event_types: ["message.created"],
        match: { channel_id: CHANNEL_ID, mention_only: true },
        execution: "turn",
        active_run: "steer",
        output: "reply_to_source",
        skip_if_unchanged: false,
      },
    };
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        previewMode: false,
        automations: [automation],
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "subscribed",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(materializeConnectionFallbackLink).toHaveBeenCalledTimes(1);
  });

  test("hosted-preview fallback does NOT materialize its placeholder agent", async () => {
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        provideSubscriptionService: true,
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(thread, makeMessage(), "mention");

    expect(thread.post).toHaveBeenCalledTimes(1);
    expect(enqueueMessage).not.toHaveBeenCalled();
    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });

  test("connection fallback does NOT materialize for a DM", async () => {
    // DMs stay out of the bound-channel set — only group channels materialize.
    const { bridge, enqueueMessage, materializeConnectionFallbackLink } =
      makePreviewHarness({
        previewMode: false,
        metadata: { teamId: "T_WS", botUserId: "U_BOT" },
        provideSubscriptionService: true,
      });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "dm",
    );

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });

  test("a matched Automation does NOT trigger connection-fallback materialization", async () => {
    // source:"automation" already owns a subscription row; no materialization.
    const { bridge, materializeConnectionFallbackLink } = makePreviewHarness({
      linkedAutomation: { agentId: "linked-agent" },
      provideSubscriptionService: true,
    });
    const thread = makeThread(undefined);

    await bridge.handleMessage(
      thread,
      makeMessage({ raw: { team_id: "TREAL" } }),
      "mention",
    );

    expect(materializeConnectionFallbackLink).not.toHaveBeenCalled();
  });
});
