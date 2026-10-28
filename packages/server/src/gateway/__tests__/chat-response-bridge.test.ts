import { describe, expect, mock, test } from "bun:test";
import { GuardrailRegistry } from "@lobu/core";
import { ChatResponseBridge } from "../connections/chat-response-bridge.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { registerBuiltinGuardrails } from "../guardrails/builtins.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

/**
 * Build a target whose `post(iterable)` drains the AsyncIterable into
 * `collected`. Returns a `drained` promise that resolves when the adapter
 * finishes draining (mirroring real adapter semantics of `target.post`).
 */
function createStreamingTarget() {
  const collected: string[] = [];
  const plainPosts: unknown[] = [];
  let resolveDrained: (() => void) | null = null;
  const drained = new Promise<void>((r) => {
    resolveDrained = r;
  });

  const target = {
    post: mock(async (arg: unknown) => {
      if (arg && typeof (arg as any)[Symbol.asyncIterator] === "function") {
        for await (const chunk of arg as AsyncIterable<string>) {
          collected.push(chunk);
        }
        resolveDrained?.();
        return { id: "msg-stream" };
      }
      plainPosts.push(arg);
      return { id: "msg-plain" };
    }),
  };
  return { target, collected, plainPosts, drained };
}

function createHarness(
  target: unknown,
  platform = "telegram",
  slackPostMessage?: ReturnType<typeof mock>,
  linkContext?: {
    agentId: string;
    organizationId: string;
    publicGatewayUrl: string;
  }
) {
  const state = new InMemoryStateAdapter();
  const conversationState = new ConversationStateStore(state);
  const slackAdapter = slackPostMessage
    ? { client: { chat: { postMessage: slackPostMessage } } }
    : undefined;
  const manager = {
    getInstance: () => ({
      connection: {
        platform,
        agentId: linkContext?.agentId,
        organizationId: linkContext?.organizationId,
      },
      chat: {
        channel: () => target,
        getAdapter: (name: string) =>
          name === "slack" ? slackAdapter : undefined,
      },
      conversationState,
    }),
    has: () => true,
    warmConnection: async () => true,
    getPublicGatewayUrl: () => linkContext?.publicGatewayUrl ?? "",
  };
  return { state, conversationState, manager };
}

const basePayload = {
  messageId: "m1",
  channelId: "123",
  conversationId: "123",
  userId: "u1",
  teamId: "t1",
  timestamp: 0,
  platform: "telegram",
  platformMetadata: {
    connectionId: "conn-1",
    chatId: "123",
  },
};

describe("ChatResponseBridge — error delivery and replica routing", () => {
  test("handleError gives a native turn's worker failure a Retry button", async () => {
    // WORKER_DIED on an agent turn (it carries `turnRunId`): the card's button
    // is the `turn-retry:` action the interaction bridge turns into a retry.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      { ...basePayload, error: "worker_heartbeat_lost", errorCode: "WORKER_DIED", turnRunId: 42 },
      "s"
    );

    expect(plainPosts).toHaveLength(1);
    const posted = plainPosts[0] as { card: unknown; fallbackText: string };
    expect(posted.fallbackText).toContain("stopped unexpectedly");
    const card = JSON.stringify(posted.card);
    expect(card).toContain('"id":"turn-retry:42"');
    expect(card).toContain('"label":"Retry"');
  });

  test("handleError offers no Retry for a worker failure that is not a native turn's", async () => {
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      { ...basePayload, error: "worker_heartbeat_lost", errorCode: "WORKER_DIED" },
      "s"
    );

    expect(plainPosts).toHaveLength(1);
    expect(typeof plainPosts[0]).toBe("string");
    expect(String(plainPosts[0])).toContain("stopped unexpectedly");
  });

  test("handleError with no prior stream still posts fallback (worker crashed early)", async () => {
    // No delta was ever sent (e.g. NO_MODEL_CONFIGURED path calls signalError
    // with no preceding sendStreamDelta). The fallback is the only way the
    // user learns anything went wrong.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError({ ...basePayload, error: "boom" }, "s");

    expect(plainPosts).toContain("Error: boom");
  });

  test("handleError suppresses the fallback for SESSION_TIMEOUT (silent retry)", async () => {
    // A timed-out turn is retried automatically by the runs queue and the
    // worker deliberately emits no user-facing crash delta, so the platform
    // fallback must also stay silent — otherwise the user sees a raw
    // "Error: SESSION_TIMEOUT" for a turn that is about to be retried.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      {
        ...basePayload,
        error: "SESSION_TIMEOUT",
        errorCode: "SESSION_TIMEOUT",
      },
      "s"
    );

    expect(plainPosts).toEqual([]);
  });

  test("handleError renders PROVIDER_TOOL_CALL_FAILED as catalog text, never the raw provider blob", async () => {
    // Seen live on Telegram: a Gemini turn that ends with
    // `function_call_filter: MALFORMED_FUNCTION_CALL` reached the user as a raw
    // `💥 Worker crashed: Provider finish_reason: …` blob. The worker now
    // classifies it, so this bridge — the ONE place a coded error becomes
    // Telegram/Slack output — must swap in the catalog sentence and drop the
    // provider's own unusable finish_reason string entirely.
    const { target, plainPosts } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleError(
      {
        ...basePayload,
        error:
          "Provider finish_reason: function_call_filter: MALFORMED_FUNCTION_CALL",
        errorCode: "PROVIDER_TOOL_CALL_FAILED",
      },
      "s"
    );

    const posted = plainPosts.map((p) => String(p)).join("\n");
    expect(posted).toContain("rejected its own tool call");
    // The three fragments of the raw blob a user must never see.
    expect(posted).not.toContain("MALFORMED_FUNCTION_CALL");
    expect(posted).not.toContain("finish_reason");
    expect(posted).not.toContain("Worker crashed");
  });

  test("stream rejection falls back to non-streaming post of buffered text", async () => {
    // Adapter that rejects the streaming call (e.g. Slack's chatStream
    // validation when recipient user/team missing) but accepts plain text.
    const plainPosts: unknown[] = [];
    const target = {
      post: mock(async (arg: unknown) => {
        if (arg && typeof (arg as any)[Symbol.asyncIterator] === "function") {
          // Drain the iterator so producer completes, then reject.
          for await (const _ of arg as AsyncIterable<string>) {
            // swallow
          }
          throw new Error(
            "Slack streaming requires recipientUserId and recipientTeamId in options"
          );
        }
        plainPosts.push(arg);
        return { id: "msg-plain" };
      }),
    };
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta({ ...basePayload, delta: "hello " }, "s");
    await bridge.handleDelta({ ...basePayload, delta: "world" }, "s");
    await bridge.handleCompletion({ ...basePayload }, "s");

    // The buffered full text is posted non-streaming as fallback.
    expect(plainPosts).toEqual(["hello world"]);
  });

  test("ensureDeliverable returns false when no connectionId", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      await bridge.ensureDeliverable({
        ...basePayload,
        platformMetadata: {},
      } as any)
    ).toBe(false);
  });

  test("ensureDeliverable returns false when this replica cannot run the connection", async () => {
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target);
    (manager as any).warmConnection = async () => false;
    const bridge = new ChatResponseBridge(manager as any);
    expect(
      await bridge.ensureDeliverable({
        ...basePayload,
        platformMetadata: { connectionId: "conn-1" },
      } as any)
    ).toBe(false);
  });
});

describe("ChatResponseBridge.handleDelta — Slack markdown_text path", () => {
  test("Slack decodes HTML entities and strips empty markdown links", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    await bridge.handleDelta(
      {
        ...slackPayload,
        delta: "&lt;summary&gt;hi&lt;/summary&gt; [foo:1, 2]() bar",
      },
      "s"
    );
    await bridge.handleCompletion(slackPayload, "s");

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "<summary>hi</summary> foo:1, 2 bar",
    });
  });

  test("Slack chunks long content on paragraph boundaries", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    const slackPayload = {
      ...basePayload,
      platform: "slack",
      channelId: "slack:C123",
      conversationId: "slack:C123",
      platformMetadata: {
        connectionId: "conn-1",
        chatId: "slack:C123",
      },
    };

    // Build content > 11000 chars with explicit paragraph boundaries every ~5000 chars.
    const para = `${"x".repeat(5000)}`;
    const body = `${para}\n\n${para}\n\n${para}`;

    await bridge.handleDelta({ ...slackPayload, delta: body }, "s");
    await bridge.handleCompletion(slackPayload, "s");

    expect(slackPost).toHaveBeenCalledTimes(2);
    // Each posted chunk must NOT split mid-paragraph.
    for (const call of slackPost.mock.calls) {
      const md = (call[0] as { markdown_text: string }).markdown_text;
      expect(md.length).toBeLessThanOrEqual(11_000);
      // Chunks must start/end at paragraph boundaries (no leading/trailing
      // partial paragraph fragments split mid-content).
      expect(md.startsWith("xxxx")).toBe(true);
    }
  });
});

describe("ChatResponseBridge.handleCompletion — multi-replica finalText", () => {
  // Under N>1 replicas the `thread_response` queue is drained competitively
  // (FOR UPDATE SKIP LOCKED, no per-conversation affinity), so a run's delta
  // rows and its terminal row can land on different pods. A post-once renderer
  // (Slack) that completes on a pod which buffered no/partial deltas must
  // render from the worker's authoritative `finalText`, not the local buffer.
  const slackPayload = {
    ...basePayload,
    platform: "slack",
    channelId: "slack:C123",
    conversationId: "slack:C123:1700000000.123456",
    platformMetadata: {
      connectionId: "conn-1",
      chatId: "slack:C123",
    },
  };

  function chipsHarness() {
    const target = createStreamingTarget().target;
    const slackPostMessage = mock(async () => ({ ts: "1" }));
    const { manager } = createHarness(target, "slack", slackPostMessage, {
      agentId: "agent-1",
      organizationId: "org-1",
      publicGatewayUrl: "",
    });
    const bridge = new ChatResponseBridge(manager as any);
    const postSuggestion = mock(async () => ({ id: "s_1" }));
    bridge.setInteractionService({ postSuggestion } as any);
    return { bridge, postSuggestion };
  }

  const chips = [{ title: "Show details", message: "Show me the details" }];
  const chipsPayload = {
    ...slackPayload,
    finalText: "The connector runs every fifteen minutes.",
    processedMessageIds: ["m1"],
    toolsUsed: [],
    suggestions: chips,
    platformMetadata: {
      ...slackPayload.platformMetadata,
      agentId: "agent-1",
      organizationId: "org-1",
      teamId: "T_NATIVE",
    },
  };

  test("blocks secrets contained only in follow-up chips", async () => {
    const { bridge, postSuggestion } = chipsHarness();
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry, {
      getSettings: async () => ({ guardrails: ["secret-scan"] }),
    } as any);
    await bridge.handleCompletion({
      ...chipsPayload,
      suggestions: [{ title: "Use key", message: "Use AKIAIOSFODNN7EXAMPLE" }],
    }, "s");
    expect(postSuggestion).not.toHaveBeenCalled();
  });

  test("posts no chips for a reply an output guardrail blocked", async () => {
    const { bridge, postSuggestion } = chipsHarness();
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    bridge.setGuardrails(registry, {
      getSettings: async () => ({ guardrails: ["secret-scan"] }),
    } as any);
    await bridge.handleCompletion(
      { ...chipsPayload, finalText: "here is the key AKIAIOSFODNN7EXAMPLE" },
      "s"
    );
    expect(postSuggestion).not.toHaveBeenCalled();
  });

  test("guardrail-blocked completion posts the block and no answer", async () => {
    const { target, plainPosts } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost, {
      agentId: "agent-1",
      organizationId: "org-1",
      publicGatewayUrl: "https://app.lobu.com/lobu",
    });
    const bridge = new ChatResponseBridge(manager as any);
    const scanner = (bridge as any).outputGuardrail;
    scanner.hasOutputGuardrails = async () => true;
    scanner.scanFinal = async () => ({
      guardrail: "test-output",
      reason: "unsafe output",
    });

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "unsafe answer",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).not.toHaveBeenCalled();
    expect(plainPosts).toEqual(["Message blocked by guardrail: unsafe output"]);
  });

  test("in-band reply suppresses the terminal Slack post", async () => {
    // The agent already answered in this conversation via `send_message`, so
    // finalText is a report about a message the user has read. Delivering it
    // is the double-message this flag exists to prevent.
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { conversationState, manager } = createHarness(
      target,
      "slack",
      slackPost
    );
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "I answered the e2e check — confirmed I am up.",
        repliedInBand: true,
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).not.toHaveBeenCalled();
    expect(target.post).not.toHaveBeenCalled();
    // Prompt history still gets the assistant turn — suppression drops the
    // duplicate delivery, not the model's memory of having answered.
    expect(
      await conversationState.getHistory(
        "conn-1",
        "slack:C123",
        "slack:C123:1700000000.123456"
      )
    ).toEqual([
      {
        role: "assistant",
        content: "I answered the e2e check — confirmed I am up.",
        name: undefined,
      },
    ]);
  });

  test("Slack completion prefers finalText over a partial local buffer", async () => {
    // This replica claimed only a subset of the deltas, so its buffer is
    // incomplete. finalText is authoritative and must win.
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { manager } = createHarness(target, "slack", slackPost);
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleDelta(
      { ...slackPayload, delta: "partial " },
      "s"
    );
    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "partial reply complete and whole",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(slackPost).toHaveBeenCalledTimes(1);
    expect(slackPost.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "partial reply complete and whole",
    });
  });

  test("Slack completion persists finalText to history with no local stream", async () => {
    const { target } = createStreamingTarget();
    const slackPost = mock(async () => ({ ok: true, ts: "1.1" }));
    const { conversationState, manager } = createHarness(
      target,
      "slack",
      slackPost
    );
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...slackPayload,
        finalText: "persisted full reply",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    // Thread-scoped: the assistant reply lands under the conversation's
    // (channel, conversationId) bucket, not the bare channel.
    const history = await conversationState.getHistory(
      "conn-1",
      "slack:C123",
      "slack:C123:1700000000.123456"
    );
    expect(history).toEqual([
      { role: "assistant", content: "persisted full reply", name: undefined },
    ]);
  });

  test("two pods: pod A buffers deltas, pod B completes — reply delivered exactly once", async () => {
    // Faithful two-replica reproducer. Each ChatResponseBridge has its own
    // pod-local `streams` Map, so two instances model two pods. The competitive
    // SKIP-LOCKED queue can route a run's deltas to pod A and its terminal row
    // to pod B. On origin/main pod B has no local stream and drops the Slack
    // reply (the bug); with finalText, pod B delivers and pod A — which never
    // receives the terminal row — never posts, so the reply lands exactly once.
    const slackPostA = mock(async () => ({ ok: true, ts: "a.1" }));
    const slackPostB = mock(async () => ({ ok: true, ts: "b.1" }));
    const { target: targetA } = createStreamingTarget();
    const { target: targetB } = createStreamingTarget();
    const podA = new ChatResponseBridge(
      createHarness(targetA, "slack", slackPostA).manager as any
    );
    const podB = new ChatResponseBridge(
      createHarness(targetB, "slack", slackPostB).manager as any
    );

    // Pod A claims the delta rows and buffers them locally.
    await podA.handleDelta({ ...slackPayload, delta: "hello " }, "s");
    await podA.handleDelta({ ...slackPayload, delta: "world" }, "s");

    // Pod B claims the terminal row (it never saw the deltas).
    await podB.handleCompletion(
      {
        ...slackPayload,
        finalText: "hello world",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    // Exactly-once: pod B posted the full reply; pod A never did.
    expect(slackPostB).toHaveBeenCalledTimes(1);
    expect(slackPostB.mock.calls[0]?.[0]).toMatchObject({
      markdown_text: "hello world",
    });
    expect(slackPostA).not.toHaveBeenCalled();
  });

  test("live-streaming (Telegram) completion with NO local stream does NOT re-post finalText", async () => {
    // Default strategy streamed its deltas on whichever replica claimed them.
    // Re-posting finalText here would duplicate the reply, so a stream-less
    // completion is a no-op for live-streaming platforms.
    const { target } = createStreamingTarget();
    const { manager } = createHarness(target, "telegram");
    const bridge = new ChatResponseBridge(manager as any);

    await bridge.handleCompletion(
      {
        ...basePayload,
        finalText: "should not be posted again",
        processedMessageIds: ["m1"],
      },
      "s"
    );

    expect(target.post).not.toHaveBeenCalled();
  });
});
