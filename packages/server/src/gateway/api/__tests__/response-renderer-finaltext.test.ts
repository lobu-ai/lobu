/**
 * Terminal-repair (Gap C): streaming `output` deltas are best-effort under N>1
 * replicas — a delta claimed on a pod that doesn't hold the client's SSE socket
 * is lost, leaving the SPA's accumulated text truncated. The worker stamps the
 * full authoritative reply onto the terminal row as `finalText`
 * (gateway-integration.signalCompletion); the API renderer MUST forward it on
 * the `complete` SSE event so the SPA can repair. Without it a cross-pod delta
 * loss is permanent with no repair path.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiResponseRenderer } from "../response-renderer.js";
import type { ThreadResponsePayload } from "../../infrastructure/queue/types.js";

const resolveRunsMock = mock(async () => ({ resolved: 0 }));
mock.module("../../../automations/run-completion.js", () => ({
  resolveAutomationRunsByMessageIds: resolveRunsMock,
}));

function makeRenderer() {
  const broadcasts: Array<{ key: string; event: string; data: any }> = [];
  const sseManager = {
    broadcast: mock((key: string, event: string, data: any) => {
      broadcasts.push({ key, event, data });
    }),
  };
  const renderer = new ApiResponseRenderer(sseManager as never);
  return { renderer, broadcasts };
}

beforeEach(() => {
  resolveRunsMock.mockReset();
  resolveRunsMock.mockResolvedValue({ resolved: 0 });
});

const basePayload = (over: Partial<ThreadResponsePayload>): ThreadResponsePayload =>
  ({
    messageId: "m1",
    conversationId: "api:conv-1",
    channelId: "api:conv-1",
    userId: "api",
    teamId: "api",
    timestamp: 100,
    processedMessageIds: ["m1"],
    ...over,
  }) as ThreadResponsePayload;

describe("ApiResponseRenderer.handleCompletion finalText repair", () => {
  test("forwards finalText on the complete SSE event", async () => {
    const { renderer, broadcasts } = makeRenderer();

    await renderer.handleCompletion(
      basePayload({ finalText: "the full assistant reply" }),
      "session-key"
    );

    const complete = broadcasts.find((b) => b.event === "complete");
    expect(complete).toBeDefined();
    expect(complete?.key).toBe("api:conv-1");
    expect(complete?.data).toMatchObject({
      type: "complete",
      messageId: "m1",
      finalText: "the full assistant reply",
    });
  });

  test("leaves finalText undefined when the worker streamed nothing extra", async () => {
    const { renderer, broadcasts } = makeRenderer();

    await renderer.handleCompletion(basePayload({}), "session-key");

    const complete = broadcasts.find((b) => b.event === "complete");
    expect(complete?.data.finalText).toBeUndefined();
  });

  test("retries durable run resolution before broadcasting completion", async () => {
    const { renderer, broadcasts } = makeRenderer();
    resolveRunsMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      renderer.handleCompletion(basePayload({ finalText: "done" }), "session-key")
    ).rejects.toThrow("database unavailable");
    expect(broadcasts).toEqual([]);
  });
});

describe("ApiResponseRenderer.handleCompletion suggestion embed", () => {
  // The renderer is READ-ONLY: the durable set is finalized upstream by the
  // consumer (finalizeTurnSuggestions), so here we only mock the READ and assert
  // what the SPA is told to render. Clearing/superseding is covered by the
  // suggestion-persist integration test.
  const readMock = mock(async () => null as any);
  mock.module("../../suggestions/persist-suggestion.js", () => ({
    readCurrentSuggestion: readMock,
  }));

  beforeEach(() => {
    readMock.mockReset();
    readMock.mockResolvedValue(null as any);
  });

  test("embeds the current suggestion set on complete", async () => {
    readMock.mockResolvedValueOnce({
      id: 7,
      prompts: [{ title: "Ship", message: "Ship it" }],
      turnMessageId: "m1",
    });
    const { renderer, broadcasts } = makeRenderer();
    await renderer.handleCompletion(
      basePayload({ organizationId: "org-1", messageId: "m1", processedMessageIds: ["m1"] }),
      "k"
    );
    expect(broadcasts.find((b) => b.event === "complete")?.data.suggestions).toEqual([
      { title: "Ship", message: "Ship it" },
    ]);
  });

  test("tells the SPA to clear ([]) when no current row exists", async () => {
    // finalize already superseded any stale set upstream; the renderer just
    // reflects the post-turn state.
    const { renderer, broadcasts } = makeRenderer();
    await renderer.handleCompletion(
      basePayload({ organizationId: "org-1", messageId: "m1" }),
      "k"
    );
    expect(broadcasts.find((b) => b.event === "complete")?.data.suggestions).toEqual([]);
  });

  test("does not resolve suggestions on an errored completion", async () => {
    const { renderer, broadcasts } = makeRenderer();
    await renderer.handleCompletion(
      basePayload({ organizationId: "org-1", error: "boom", messageId: "m1" }),
      "k"
    );
    // undefined = "no change" to the SPA.
    expect(broadcasts.find((b) => b.event === "complete")?.data.suggestions).toBeUndefined();
    expect(readMock).not.toHaveBeenCalled();
    expect(resolveRunsMock).not.toHaveBeenCalled();
  });
});

describe("ApiResponseRenderer.handleError targeting context", () => {
  test("forwards context and renders the provider body on both browser error events", async () => {
    const { renderer, broadcasts } = makeRenderer();
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."},"request_id":"req_123"}';

    await renderer.handleError(
      basePayload({
        error: raw,
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        errorContext: { provider: "nvidia", model: "nvidia/moonshotai/kimi-k2.6" },
      }),
      "session-key"
    );

    for (const event of ["error", "agent-error"]) {
      expect(broadcasts.find((b) => b.event === event)?.data).toMatchObject({
        error: "NVIDIA NIM returned an error:\nYour credit balance is too low.",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        errorContext: { provider: "nvidia", model: "nvidia/moonshotai/kimi-k2.6" },
      });
    }
  });

  test("uses raw provider text only for quota parsing, not persisted run text", async () => {
    const { renderer } = makeRenderer();
    const raw = "429 Limit Exhausted. Your limit will reset at 2026-08-04 12:00:00";

    await renderer.handleError(basePayload({
      error: "Message blocked by guardrail: require-tool",
      bookkeepingError: raw,
      errorCode: "PROVIDER_QUOTA_EXHAUSTED",
    }), "session-key");

    expect(resolveRunsMock).toHaveBeenCalledWith(
      new Set(["m1"]),
      {
        ok: false,
        error: "Message blocked by guardrail: require-tool",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        quotaResetError: raw,
      }
    );
  });

  test("retries durable run resolution before broadcasting an error", async () => {
    const { renderer, broadcasts } = makeRenderer();
    resolveRunsMock.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      renderer.handleError(
        basePayload({
          error: "Your limit will reset at 2026-08-04 12:00:00",
          errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        }),
        "session-key"
      )
    ).rejects.toThrow("database unavailable");
    expect(broadcasts).toEqual([]);
  });
});

test("errors preserve every processed request ID for batched CLI requests", async () => {
  const { renderer, broadcasts } = makeRenderer();
  await renderer.handleError(basePayload({ error: "synthetic failure", processedMessageIds: ["m1", "m2"] }), "session-key");
  expect(broadcasts.find(b => b.event === "error")?.data.processedMessageIds).toEqual(["m1", "m2"]);
});

test("ephemeral terminal forwards available batch membership", async () => {
  const { renderer, broadcasts } = makeRenderer();
  await renderer.handleEphemeral(basePayload({ content: "synthetic notice", processedMessageIds: ["m1", "m2"] }));
  expect(broadcasts.find(b => b.event === "ephemeral")?.data.processedMessageIds).toEqual(["m1", "m2"]);
});
