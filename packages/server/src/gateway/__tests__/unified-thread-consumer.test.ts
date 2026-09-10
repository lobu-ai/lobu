import { describe, expect, mock, test } from "bun:test";
import { InteractionService } from "../interactions.js";
import {
  registerChatInteractionFanout,
  UnifiedThreadResponseConsumer,
} from "../platform/unified-thread-consumer.js";

const basePayload = {
  messageId: "m1",
  channelId: "telegram:123",
  conversationId: "telegram:123",
  userId: "u1",
  teamId: "telegram",
  timestamp: 0,
  platform: "telegram",
  processedMessageIds: ["m1"],
  platformMetadata: {
    connectionId: "marketing-telegram",
  },
};

function createConsumer(overrides?: {
  chatResponseBridge?: unknown;
  renderer?: unknown;
}) {
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const renderer = overrides?.renderer ?? {
    handleCompletion: mock(async () => undefined),
    handleError: mock(async () => undefined),
  };
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const sseManager = {
    broadcast: mock(() => undefined),
    hasActiveConnection: mock(() => true),
  };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as any,
    platformRegistry as any,
    sseManager as any
  ) as any;
  if (overrides?.chatResponseBridge) {
    consumer.setChatResponseBridge(overrides.chatResponseBridge as any);
  }
  return { consumer, platformRegistry, renderer };
}

describe("UnifiedThreadResponseConsumer customEvent broadcast", () => {
  test("broadcasts tool_use customEvent to conversation + cli session", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = { broadcast };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;

    const payload = {
      messageId: "m1",
      channelId: "api:1",
      conversationId: "api:1",
      userId: "u1",
      teamId: "api",
      platform: "api",
      timestamp: 1000,
      platformMetadata: { sessionId: "cli-session-1" },
      customEvent: {
        name: "tool_use",
        data: {
          toolCallId: "tc-1",
          name: "search_memory",
          input: { query: "rent" },
          isError: false,
          result_summary: {
            event_ids: [42],
            snippets: [{ id: 42, text: "Rent is due 1st" }],
          },
        },
      },
    };

    await consumer.handleThreadResponse({ id: "job-1", data: payload });

    const broadcasts = broadcast.mock.calls;
    const toolUseBroadcasts = broadcasts.filter(
      (call: any[]) => call[1] === "tool_use"
    );
    // Exactly one broadcast, keyed by conversation id — the legacy
    // platformMetadata.sessionId side-channel is gone (no producer ever set
    // it; clients subscribe on conversationId).
    expect(toolUseBroadcasts.length).toBe(1);
    const conversationBroadcast = toolUseBroadcasts.find(
      (call: any[]) => call[0] === "api:1"
    );
    expect(conversationBroadcast).toBeDefined();
    expect(conversationBroadcast?.[2]).toMatchObject({
      toolCallId: "tc-1",
      name: "search_memory",
      result_summary: {
        event_ids: [42],
      },
      messageId: "m1",
      timestamp: 1000,
    });
  });
});

describe("UnifiedThreadResponseConsumer interaction card owner-routing", () => {
  function makeInteractionConsumer(
    hasActiveConnection: boolean,
    readSuggestion = mock(async () => null)
  ) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const broadcast = mock(() => undefined);
    const sseManager = {
      broadcast,
      hasActiveConnection: mock(() => hasActiveConnection),
    };
    const platformRegistry = {
      get: mock(() => ({
        getResponseRenderer: () => ({
          handleCompletion: mock(async () => undefined),
          handleError: mock(async () => undefined),
        }),
      })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any,
      readSuggestion
    ) as any;
    return { consumer, broadcast, readSuggestion, sseManager };
  }

  const interactionPayload = {
    messageId: "m-int-1",
    channelId: "api:conv-1",
    conversationId: "api:conv-1",
    userId: "u1",
    teamId: "api",
    platform: "api",
    timestamp: 1234,
    customEvent: {
      name: "question",
      data: { type: "question", questionId: "q_1", question: "Proceed?" },
      requireSseOwner: true,
    },
  };

  test("re-queues an ask_user card when this pod does not own the SSE", async () => {
    const { consumer, broadcast, sseManager } = makeInteractionConsumer(false);

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: interactionPayload })
    ).rejects.toThrow(/not owned by this gateway instance/);

    expect(sseManager.hasActiveConnection).toHaveBeenCalledWith("api:conv-1");
    // Must NOT broadcast into the wrong pod's SseManager.
    expect(broadcast).not.toHaveBeenCalled();
  });

  test("delivers a headless-sourced card on first claim without an SSE owner (F12)", async () => {
    // A card emitted from a headless turn (automation/scheduled/repair/internal)
    // has no browser SSE on ANY pod. Before the source was stamped onto the
    // card it owner-gated, re-queued 30x and dead-lettered, hanging the worker.
    // Stamped headless, it must deliver on first claim instead.
    const { consumer, broadcast, sseManager } = makeInteractionConsumer(false);

    await consumer.handleThreadResponse({
      id: "job-headless",
      data: {
        ...interactionPayload,
        messageId: "m-int-headless",
        platformMetadata: { source: "automation-run" },
      },
    });

    // Exempt: the owner check is short-circuited, so it never even asks.
    expect(sseManager.hasActiveConnection).not.toHaveBeenCalled();
    const questionBroadcasts = broadcast.mock.calls.filter(
      (call: any[]) => call[1] === "question"
    );
    expect(questionBroadcasts.length).toBe(1);
    expect(questionBroadcasts[0][0]).toBe("api:conv-1");
  });

  test("delivers the card on the pod that owns the SSE connection", async () => {
    const { consumer, broadcast } = makeInteractionConsumer(true);

    await consumer.handleThreadResponse({
      id: "job-2",
      data: interactionPayload,
    });

    const questionBroadcasts = broadcast.mock.calls.filter(
      (call: any[]) => call[1] === "question"
    );
    expect(questionBroadcasts.length).toBe(1);
    expect(questionBroadcasts[0][0]).toBe("api:conv-1");
    expect(questionBroadcasts[0][2]).toMatchObject({
      type: "question",
      questionId: "q_1",
      messageId: "m-int-1",
      timestamp: 1234,
    });
  });

  test("refreshes a delayed suggestion card from the durable current set", async () => {
    const readSuggestion = mock(async () => ({
      id: 22,
      prompts: [{ title: "New", message: "Use the newer turn" }],
      turnMessageId: "m-new",
    }));
    const { consumer, broadcast } = makeInteractionConsumer(
      true,
      readSuggestion
    );

    await consumer.handleThreadResponse({
      id: "job-suggestion",
      data: {
        ...interactionPayload,
        organizationId: "org-1",
        customEvent: {
          name: "suggestion",
          data: {
            type: "suggestion",
            suggestionId: "stale-card",
            prompts: [{ title: "Old", message: "Use the older turn" }],
          },
          requireSseOwner: true,
        },
      },
    });

    expect(readSuggestion).toHaveBeenCalledWith("org-1", "api:conv-1");
    const suggestionBroadcast = broadcast.mock.calls.find(
      (call: any[]) => call[1] === "suggestion"
    );
    expect(suggestionBroadcast?.[2]).toMatchObject({
      prompts: [{ title: "New", message: "Use the newer turn" }],
      turnMessageId: "m-new",
    });
    // The card carries prompts only, exactly like the terminal `complete`
    // embed and history replay. A stale enqueued id must not ride along.
    expect(suggestionBroadcast?.[2]).not.toHaveProperty("suggestionId");
  });
});

describe("UnifiedThreadResponseConsumer headless owner-gate exemption", () => {
  function makeApiConsumer(hasActiveConnection: boolean) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const sseManager = {
      broadcast: mock(() => undefined),
      hasActiveConnection: mock(() => hasActiveConnection),
    };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    return { consumer, renderer, sseManager };
  }

  // Worker terminal rows for headless turns carry teamId "api" without
  // `platform`, plus the dispatch-time source echoed in platformMetadata.
  const automationTerminal = {
    messageId: "m-w-1",
    channelId: "api_automation_7",
    conversationId: "api_automation_7",
    userId: "automation-7",
    teamId: "api",
    timestamp: 99,
    processedMessageIds: ["m-w-1"],
    platformMetadata: { source: "automation-run" },
  };

  test("automation terminal success row is delivered on first claim with no SSE anywhere", async () => {
    const { consumer, renderer, sseManager } = makeApiConsumer(false);

    await consumer.handleThreadResponse({ id: "job-1", data: automationTerminal });

    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
    expect(sseManager.hasActiveConnection).not.toHaveBeenCalled();
  });

  test("automation terminal error row resolves immediately (was: 2h stale sweep)", async () => {
    const { consumer, renderer } = makeApiConsumer(false);
    const errorRow = {
      ...automationTerminal,
      processedMessageIds: undefined,
      error: "worker exited 1",
    };

    await consumer.handleThreadResponse({ id: "job-2", data: errorRow });

    expect(renderer.handleError).toHaveBeenCalledTimes(1);
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1); // error path also completes
  });

  for (const source of ["connector-repair", "scheduled-job", "internal"]) {
    test(`${source} terminal row bypasses the owner-gate`, async () => {
      const { consumer, renderer } = makeApiConsumer(false);

      await consumer.handleThreadResponse({
        id: `job-${source}`,
        data: {
          ...automationTerminal,
          platformMetadata: { source },
        },
      });

      expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
    });
  }

  test("direct-api terminal row is still owner-gated", async () => {
    const { consumer, renderer } = makeApiConsumer(false);

    await expect(
      consumer.handleThreadResponse({
        id: "job-3",
        data: {
          ...automationTerminal,
          userId: "u1",
          platformMetadata: { source: "direct-api" },
        },
      })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("terminal row without any source is still owner-gated", async () => {
    const { consumer, renderer } = makeApiConsumer(false);
    const { platformMetadata, ...noMeta } = automationTerminal;
    void platformMetadata;

    await expect(
      consumer.handleThreadResponse({ id: "job-4", data: { ...noMeta, userId: "u1" } })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });
});

describe("UnifiedThreadResponseConsumer owner-gate last-attempt fallback", () => {
  function makeApiConsumer() {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const sseManager = {
      broadcast: mock(() => undefined),
      hasActiveConnection: mock(() => false),
    };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => renderer })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    return { consumer, renderer };
  }

  const directApiTerminal = {
    messageId: "m-d-1",
    channelId: "api_u1",
    conversationId: "conv-d-1",
    userId: "u1",
    teamId: "api",
    timestamp: 99,
    processedMessageIds: ["m-d-1"],
    platformMetadata: { source: "direct-api" },
  };

  test("success row delivers locally on the final attempt instead of dropping the reply", async () => {
    const { consumer, renderer } = makeApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-final-ok",
      attempt: 29,
      maxAttempts: 30,
      data: { ...directApiTerminal, finalText: "the answer" },
    });

    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });

  test("error row delivers locally on the final attempt so the run still resolves", async () => {
    const { consumer, renderer } = makeApiConsumer();

    await consumer.handleThreadResponse({
      id: "job-final-err",
      attempt: 29,
      maxAttempts: 30,
      data: {
        ...directApiTerminal,
        processedMessageIds: undefined,
        error: "The agent didn't finish responding in time.",
      },
    });

    expect(renderer.handleError).toHaveBeenCalledTimes(1);
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });

  test("still re-queues while attempts remain", async () => {
    const { consumer, renderer } = makeApiConsumer();

    await expect(
      consumer.handleThreadResponse({
        id: "job-mid",
        attempt: 28,
        maxAttempts: 30,
        data: directApiTerminal,
      })
    ).rejects.toThrow(/not owned by this gateway instance/);
    expect(renderer.handleCompletion).not.toHaveBeenCalled();
  });

  test("re-queues when the queue supplies no attempt budget", async () => {
    const { consumer } = makeApiConsumer();

    await expect(
      consumer.handleThreadResponse({ id: "job-nobudget", data: directApiTerminal })
    ).rejects.toThrow(/not owned by this gateway instance/);
  });
});

describe("UnifiedThreadResponseConsumer dead-letters instead of silent drops", () => {
  test("missing platform adapter throws so the row retries then dead-letters", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const platformRegistry = { get: mock(() => undefined) };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      { broadcast: mock(() => undefined) } as any
    ) as any;

    await expect(
      consumer.handleThreadResponse({
        id: "job-1",
        data: { messageId: "m1", userId: "u1", teamId: "ghost-platform" },
      })
    ).rejects.toThrow(/No platform adapter registered/);
  });

  test("platform without renderer throws so the row retries then dead-letters", async () => {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
    };
    const platformRegistry = {
      get: mock(() => ({ getResponseRenderer: () => undefined })),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      { broadcast: mock(() => undefined) } as any
    ) as any;

    await expect(
      consumer.handleThreadResponse({
        id: "job-2",
        data: { messageId: "m2", userId: "u1", teamId: "telegram" },
      })
    ).rejects.toThrow(/does not provide a response renderer/);
  });
});

describe("UnifiedThreadResponseConsumer API guardrail bookkeeping", () => {
  test("preserves the raw provider error while redacting user-visible output", async () => {
    const handleError = mock(async () => undefined);
    const { consumer } = createConsumer({
      renderer: { handleError, handleCompletion: mock(async () => undefined) },
    });
    const scanner = (consumer as any).outputGuardrail;
    scanner.registry = {};
    scanner.settingsStore = {};
    scanner.scanFinal = mock(async () => ({
      guardrail: "require-tool",
      reason: "required tool was not called",
    }));

    const raw =
      "429 Limit Exhausted. Your limit will reset at 2026-08-04 06:00:00";
    await consumer.handleThreadResponse({
      id: "job-api-quota",
      data: {
        messageId: "m-api-quota",
        channelId: "api:quota",
        conversationId: "api:quota",
        userId: "u1",
        teamId: "api",
        platform: "api",
        timestamp: 0,
        error: raw,
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        toolsUsed: [],
        platformMetadata: { agentId: "agent-1", organizationId: "org-1" },
      },
    });

    const delivered = handleError.mock.calls[0]?.[0] as any;
    expect(delivered.error).toMatch(/Message blocked by guardrail/);
    expect(delivered.bookkeepingError).toBe(raw);
  });
});

describe("UnifiedThreadResponseConsumer Chat SDK hydrate-on-claim", () => {
  test("throws for Chat SDK connection responses this replica cannot serve", async () => {
    // ensureDeliverable=false means hydration failed (deleted/stopped row or
    // an exclusive transport leased elsewhere) — fail the job so the retry
    // can land on a replica that can serve it.
    const chatResponseBridge = {
      parkQuotaExhaustedAutomation: mock(async () => undefined),
      ensureDeliverable: mock(async () => false),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await expect(
      consumer.handleThreadResponse({ id: "job-1", data: basePayload })
    ).rejects.toThrow(/cannot be served by this gateway instance/);

    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).not.toHaveBeenCalled();
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("parks quota errors before checking whether the chat connection is deliverable", async () => {
    const chatResponseBridge = {
      parkQuotaExhaustedAutomation: mock(async () => undefined),
      ensureDeliverable: mock(async () => false),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer } = createConsumer({ chatResponseBridge });

    await expect(
      consumer.handleThreadResponse({
        id: "job-quota",
        data: {
          ...basePayload,
          processedMessageIds: undefined,
          error:
            "429 Limit Exhausted. Your limit will reset at 2026-08-04 06:00:00",
          errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        },
      })
    ).rejects.toThrow(/cannot be served by this gateway instance/);

    expect(chatResponseBridge.parkQuotaExhaustedAutomation).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleError).not.toHaveBeenCalled();
  });

  test("routes Chat SDK responses after hydrating on the claiming replica", async () => {
    const chatResponseBridge = {
      parkQuotaExhaustedAutomation: mock(async () => undefined),
      ensureDeliverable: mock(async () => true),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ chatResponseBridge });

    await consumer.handleThreadResponse({ id: "job-1", data: basePayload });

    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    expect(chatResponseBridge.handleCompletion).toHaveBeenCalledTimes(1);
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("legacy platform responses without connectionId still use platform renderer", async () => {
    const renderer = {
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    const { consumer, platformRegistry } = createConsumer({ renderer });
    const { platformMetadata, ...payloadWithoutMetadata } = basePayload;
    void platformMetadata;

    await consumer.handleThreadResponse({
      id: "job-1",
      data: payloadWithoutMetadata,
    });

    expect(platformRegistry.get).toHaveBeenCalledWith("telegram");
    expect(renderer.handleCompletion).toHaveBeenCalledTimes(1);
  });
});

// Cross-pod fan-out for CHAT-PLATFORM interaction cards (the bug fixed here):
// a worker posts an ask_user card into ITS pod's InteractionService, but under
// N>1 replicas (Slack webhooks don't pin to the connection's pod) that pod
// rarely owns the connection's interaction bridge — so the card was lost. The
// producer rides the thread_response queue; the consumer re-emits it on the
// owning pod, gated by the same ensureDeliverable/warmConnection owner-gate the
// text path uses, and dedups against the bridge's per-connection handledEvents.
describe("chat interaction fan-out producer (registerChatInteractionFanout)", () => {
  function makeFanout(opts?: { warmLocally?: boolean }) {
    const send = mock(async () => "job-id");
    const queue = { send } as any;
    const svc = new InteractionService();
    const warm = opts?.warmLocally ?? false;
    const cleanup = registerChatInteractionFanout(
      svc,
      queue,
      (_id: string) => warm
    );
    return { svc, send, cleanup };
  }

  const slackQuestion = {
    id: "q_slack_1",
    userId: "U1",
    conversationId: "slack:D095:thread",
    channelId: "D095",
    teamId: "T1",
    connectionId: "cfa916c95eb64939",
    platform: "slack",
    question: "Proceed?",
    options: ["Yes", "No"],
  };

  test("enqueues a chat card when this pod does NOT own the connection", () => {
    const { svc, send } = makeFanout({ warmLocally: false });

    svc.emit("question:created", slackQuestion);

    expect(send).toHaveBeenCalledTimes(1);
    const [queueName, payload, opts] = send.mock.calls[0] as any[];
    expect(queueName).toBe("thread_response");
    // connectionId rides platformMetadata so ensureDeliverable can warm the
    // owning replica's connection.
    expect(payload.platformMetadata.connectionId).toBe("cfa916c95eb64939");
    expect(payload.platform).toBe("slack");
    expect(payload.customEvent.name).toBe("chat-interaction");
    expect(payload.customEvent.data.eventName).toBe("question:created");
    expect(payload.customEvent.data.event.id).toBe("q_slack_1");
    // Raised-retry re-claim budget, same as terminal/API-card delivery.
    expect(opts).toMatchObject({ retryLimit: 30, retryDelay: 1 });
  });

  test("does NOT enqueue when this pod already owns the connection (local render handles it)", () => {
    const { svc, send } = makeFanout({ warmLocally: true });

    svc.emit("question:created", slackQuestion);

    expect(send).not.toHaveBeenCalled();
  });

  test("does NOT enqueue api cards (ApiPlatform owner-routes those to the SSE)", () => {
    const { svc, send } = makeFanout({ warmLocally: false });

    svc.emit("question:created", {
      ...slackQuestion,
      platform: "api",
      connectionId: undefined,
    });

    expect(send).not.toHaveBeenCalled();
  });

  test("does NOT enqueue chat cards missing a connectionId", () => {
    const { svc, send } = makeFanout({ warmLocally: false });

    svc.emit("question:created", { ...slackQuestion, connectionId: undefined });

    expect(send).not.toHaveBeenCalled();
  });

  test("fans out every interaction channel (approval, link-button)", () => {
    const { svc, send } = makeFanout({ warmLocally: false });

    svc.emit("tool:approval-needed", {
      ...slackQuestion,
      id: "req_1",
    });
    svc.emit("link-button:created", {
      ...slackQuestion,
      id: "lb_1",
    });

    expect(send).toHaveBeenCalledTimes(2);
    const names = send.mock.calls.map(
      (c: any[]) => c[1].customEvent.data.eventName
    );
    expect(names).toEqual([
      "tool:approval-needed",
      "link-button:created",
    ]);
  });

  test("cleanup detaches all listeners (no fan-out after teardown)", () => {
    const { svc, send, cleanup } = makeFanout({ warmLocally: false });
    cleanup();

    svc.emit("question:created", slackQuestion);

    expect(send).not.toHaveBeenCalled();
  });
});

describe("chat interaction fan-out consumer (handleChatInteraction)", () => {
  function makeChatInteractionRow(connectionId = "cfa916c95eb64939") {
    return {
      messageId: "q_slack_1",
      conversationId: "slack:D095:thread",
      channelId: "D095",
      userId: "U1",
      platform: "slack",
      teamId: "slack",
      timestamp: 42,
      platformMetadata: { connectionId },
      customEvent: {
        name: "chat-interaction",
        data: {
          eventName: "question:created",
          event: {
            id: "q_slack_1",
            connectionId,
            platform: "slack",
            question: "Proceed?",
            options: ["Yes", "No"],
          },
        },
      },
    };
  }

  function makeConsumer(ensureDeliverable: boolean) {
    const queue = {
      start: mock(async () => undefined),
      stop: mock(async () => undefined),
      createQueue: mock(async () => undefined),
      work: mock(async () => undefined),
      send: mock(async () => "id"),
    };
    const platformRegistry = { get: mock(() => undefined) };
    const sseManager = { broadcast: mock(() => undefined) };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sseManager as any
    ) as any;
    const chatResponseBridge = {
      ensureDeliverable: mock(async () => ensureDeliverable),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    };
    consumer.setChatResponseBridge(chatResponseBridge);
    const svc = new InteractionService();
    // Wire the interaction service with a not-warm-locally producer guard so
    // re-emit drives the consumer-side path under test.
    consumer.setInteractionService(svc, (_id: string) => false);
    return { consumer, svc, chatResponseBridge, platformRegistry };
  }

  test("re-emits the card onto the local InteractionService on the OWNING pod", async () => {
    const { consumer, svc, chatResponseBridge, platformRegistry } =
      makeConsumer(true);
    const rendered: any[] = [];
    svc.on("question:created", (e: any) => rendered.push(e));

    await consumer.handleThreadResponse({
      id: "job-1",
      data: makeChatInteractionRow(),
    });

    // Owner-gate consulted (warmConnection), then re-emitted exactly once with
    // the ORIGINAL id (drives the bridge's handledEvents dedup).
    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    expect(rendered.length).toBe(1);
    expect(rendered[0].id).toBe("q_slack_1");
    // Never falls through to the platform-renderer text path.
    expect(platformRegistry.get).not.toHaveBeenCalled();
  });

  test("re-queues (throws) and does NOT render on a pod that can't serve the connection", async () => {
    const { consumer, svc, chatResponseBridge } = makeConsumer(false);
    const rendered: any[] = [];
    svc.on("question:created", (e: any) => rendered.push(e));

    await expect(
      consumer.handleThreadResponse({ id: "job-2", data: makeChatInteractionRow() })
    ).rejects.toThrow(/cannot be served by this gateway instance/);

    expect(chatResponseBridge.ensureDeliverable).toHaveBeenCalledTimes(1);
    // The card is NOT lost on the wrong pod — it throws to re-queue, and never
    // renders locally.
    expect(rendered.length).toBe(0);
  });

  test("drops (does NOT re-emit) when the envelope connectionId mismatches the row connectionId", async () => {
    const { consumer, svc, chatResponseBridge } = makeConsumer(true);
    const rendered: any[] = [];
    svc.on("question:created", (e: any) => rendered.push(e));

    const row = makeChatInteractionRow("conn-A");
    // Corrupt the envelope so the event is tagged for a DIFFERENT connection
    // than the row's routing key (what ensureDeliverable would warm).
    (row.customEvent.data.event as any).connectionId = "conn-B";

    await consumer.handleThreadResponse({ id: "job-mismatch", data: row });

    // Guard fires before the owner-gate: we must not warm or render a misrouted
    // card onto connection conn-A's warm pod.
    expect(rendered.length).toBe(0);
    expect(chatResponseBridge.ensureDeliverable).not.toHaveBeenCalled();
  });

  test("idempotent / at-most-once: a re-claim of the SAME card renders once via the bridge dedup", async () => {
    // Simulate the bridge's per-connection handledEvents dedup: a listener that
    // renders each id at most once. Both the local emit (owner pod produced) and
    // the queue re-emit carry the SAME id, so the second is a no-op — proving no
    // double-render across the produce+consume seam.
    const { consumer, svc } = makeConsumer(true);
    const handled = new Set<string>();
    let renders = 0;
    svc.on("question:created", (e: any) => {
      if (handled.has(e.id)) return; // mirrors bridge markHandled(event.id)
      handled.add(e.id);
      renders += 1;
    });

    // First delivery (e.g. local emit on the owner pod, or first queue claim).
    svc.emit("question:created", makeChatInteractionRow().customEvent.data.event);
    // Second delivery of the same card via the queue consumer (re-claim/retry).
    await consumer.handleThreadResponse({
      id: "job-3",
      data: makeChatInteractionRow(),
    });

    expect(renders).toBe(1);
  });
});
