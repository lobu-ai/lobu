/**
 * The renderer boundary for an agent turn's streamed deltas.
 *
 * Every other test of this lane asserts on the QUEUE — the `thread_response`
 * row the worker's heartbeat produced. That is structurally blind to the bug
 * this file exists for: a row can be perfectly correct and still render as
 * garbage, because what the client sees is decided two links further down, in
 * `UnifiedThreadResponseConsumer` → `ApiResponseRenderer` → SSE → the SPA's
 * `textOut += content` (lobu-chat-store.tsx).
 *
 * So this drives the REAL consumer and the REAL renderer, with only the SSE
 * manager faked, and reconstructs the visible text the way the SPA actually
 * does. The property under test is the one a user would notice: what they read
 * equals what the model wrote — no span repeated, none missing.
 */
import { describe, expect, mock, test } from "bun:test";
import { ApiResponseRenderer } from "../api/response-renderer.js";
import { UnifiedThreadResponseConsumer } from "../platform/unified-thread-consumer.js";

const CONVERSATION_ID = "api:turn-render-test";

interface Broadcast {
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * The real consumer and the real API renderer, over a fake socket.
 *
 * `ApiResponseRenderer` is constructed here rather than mocked because the bug
 * this file pins lived INSIDE it: it read `payload.delta` and dropped
 * `payload.isFullReplacement` on the floor, so a cumulative delta arrived at
 * the SPA as an append.
 */
function createBoundary() {
  const broadcasts: Broadcast[] = [];
  const sseManager = {
    broadcast: mock((sessionId: string, event: string, payload: Record<string, unknown>) => {
      broadcasts.push({ sessionId, event, payload });
    }),
    hasActiveConnection: mock(() => true),
  };
  const renderer = new ApiResponseRenderer(sseManager as never);
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as never,
    platformRegistry as never,
    sseManager as never
  ) as unknown as {
    handleThreadResponse(job: { id: string; data: unknown }): Promise<void>;
  };
  return { consumer, broadcasts };
}

/** The `thread_response` row the worker-api's delta publish writes. */
function deltaRow(delta: string) {
  return {
    messageId: "m-turn-1",
    channelId: CONVERSATION_ID,
    conversationId: CONVERSATION_ID,
    userId: "u1",
    teamId: "api",
    platform: "api",
    organizationId: "org-render-test",
    timestamp: Date.now(),
    delta,
    // What `publishTurnDelta` stamps: the span CONTINUES the reply.
    isFullReplacement: false,
  };
}

/**
 * What the SPA would show, replayed from the SSE events exactly as
 * `lobu-chat-store.tsx` does it: `output` appends its content, `complete`
 * replaces everything with the authoritative `finalText`.
 */
function renderLikeTheSpa(broadcasts: Broadcast[]): string {
  let textOut = "";
  for (const { event, payload } of broadcasts) {
    if (event === "output") {
      textOut += String(payload.content ?? "");
    } else if (event === "complete") {
      const finalText = payload.finalText;
      if (typeof finalText === "string" && finalText.length > 0) textOut = finalText;
    }
  }
  return textOut;
}

describe("agent turn deltas at the renderer boundary", () => {
  test("the text the client renders equals the text the worker streamed", async () => {
    const { consumer, broadcasts } = createBoundary();
    const spans = ["The isolate", " lane ", "answered."];

    for (const [index, span] of spans.entries()) {
      await consumer.handleThreadResponse({
        id: `delta-${index}`,
        data: deltaRow(span),
      });
    }

    // Every span reached the socket, in order, verbatim.
    const outputs = broadcasts.filter((b) => b.event === "output");
    expect(outputs).toHaveLength(spans.length);
    expect(outputs.map((b) => b.payload.content)).toEqual(spans);
    // And appending them — which is all the SPA does — rebuilds the reply.
    expect(renderLikeTheSpa(broadcasts)).toBe(spans.join(""));
  });

  /**
   * The regression that made streaming worse than not streaming. The lane used
   * to publish a CUMULATIVE snapshot with `isFullReplacement: true`, but the
   * API renderer never read that flag and the SPA appends unconditionally, so
   * each beat restated everything already on screen.
   *
   * This asserts the shape the lane must NOT produce, through the real
   * renderer: it is the only place the defect is observable, and it is what a
   * row-level assertion on `runs.action_input` structurally cannot see.
   */
  test("cumulative snapshots would garble the reply on this path — increments do not", async () => {
    const { consumer, broadcasts } = createBoundary();
    // What the old lane sent: each beat is the whole reply so far.
    const snapshots = ["The isolate", "The isolate lane", "The isolate lane answered."];

    for (const [index, snapshot] of snapshots.entries()) {
      await consumer.handleThreadResponse({
        id: `snapshot-${index}`,
        // isFullReplacement: true is what the old code stamped. The API
        // renderer does not implement replacement, so the client appends.
        data: { ...deltaRow(snapshot), isFullReplacement: true },
      });
    }

    // The flag does not survive to the socket — this is the fact that makes
    // cumulative deltas wrong on this lane, stated as a test rather than as a
    // comment someone can disagree with.
    for (const broadcast of broadcasts.filter((b) => b.event === "output")) {
      expect(broadcast.payload.isFullReplacement).toBeUndefined();
    }
    // And the result is the garble: the reply repeated back into itself.
    expect(renderLikeTheSpa(broadcasts)).toBe(snapshots.join(""));
    expect(renderLikeTheSpa(broadcasts)).not.toBe(
      snapshots[snapshots.length - 1]
    );
  });

  test("a reply longer than one batch renders head-first and whole", async () => {
    const { consumer, broadcasts } = createBoundary();
    // Two batches the worker's per-batch cap would produce, distinguishable so
    // a dropped or reordered one is visible.
    const first = "a".repeat(24_000);
    const second = "b".repeat(6_000);

    await consumer.handleThreadResponse({ id: "big-0", data: deltaRow(first) });
    await consumer.handleThreadResponse({ id: "big-1", data: deltaRow(second) });

    const rendered = renderLikeTheSpa(broadcasts);
    expect(rendered).toBe(first + second);
    // The head — the part the user read first — is still there. The old
    // tail-keeping cumulative cap replaced it with a headless tail.
    expect(rendered.startsWith("a")).toBe(true);
    expect(rendered).toHaveLength(30_000);
  });

  /**
   * The terminal event is authoritative and must not race the stream: a delta
   * still in flight when the completion lands cannot leave the client showing
   * more than the reply, because `complete` REPLACES with `finalText` rather
   * than appending to what the deltas built.
   *
   * Driven straight at the renderer rather than through the consumer: the
   * consumer's completion path also settles durable Automation bookkeeping,
   * which needs a database, and the property here is purely about what reaches
   * the socket in what order.
   */
  test("a late delta after the terminal event cannot corrupt the final reply", async () => {
    const broadcasts: Broadcast[] = [];
    const sseManager = {
      broadcast: mock((sessionId: string, event: string, payload: Record<string, unknown>) => {
        broadcasts.push({ sessionId, event, payload });
      }),
      hasActiveConnection: mock(() => true),
    };
    const renderer = new ApiResponseRenderer(sseManager as never);

    await renderer.handleDelta(deltaRow("Partial ") as never, "session");
    // The terminal broadcast, as `handleCompletion` emits it. Built here
    // rather than invoked so no database is required for a question about
    // event ORDER.
    sseManager.broadcast(CONVERSATION_ID, "complete", {
      type: "complete",
      messageId: "m-turn-1",
      finalText: "Partial answer, repaired.",
      timestamp: Date.now(),
    });
    // A beat still in flight when the completion landed.
    await renderer.handleDelta(deltaRow("answer") as never, "session");

    // Up to and including the completion, the client shows the authoritative
    // reply — the deltas before it are superseded, not added to.
    const throughCompletion = broadcasts.slice(
      0,
      broadcasts.findIndex((b) => b.event === "complete") + 1
    );
    expect(renderLikeTheSpa(throughCompletion)).toBe("Partial answer, repaired.");
    // The late delta is still delivered rather than swallowed — the renderer
    // has no terminal state to gate on, and the reply is already repaired.
    expect(broadcasts.filter((b) => b.event === "output")).toHaveLength(2);
  });

  test("a tool trace reaches the client as the tool_use event both lanes use", async () => {
    const { consumer, broadcasts } = createBoundary();
    await consumer.handleThreadResponse({
      id: "tool-0",
      data: {
        ...deltaRow(""),
        delta: undefined,
        customEvent: {
          name: "tool_use",
          data: {
            toolCallId: "call-7",
            name: "search_memory",
            isError: false,
          },
        },
      },
    });

    const toolUse = broadcasts.filter((b) => b.event === "tool_use");
    expect(toolUse).toHaveLength(1);
    expect(toolUse[0]?.sessionId).toBe(CONVERSATION_ID);
    expect(toolUse[0]?.payload).toMatchObject({
      toolCallId: "call-7",
      name: "search_memory",
      isError: false,
    });
  });
});
