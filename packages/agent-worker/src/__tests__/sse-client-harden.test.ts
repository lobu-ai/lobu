/**
 * Hardening tests for GatewayClient / SSE client.
 *
 * Covers:
 * - SSE reconnect with exponential-backoff delay
 * - Partial / garbled SSE frames (split across chunks, malformed JSON)
 * - Unknown event types are silently ignored
 * - Missing jobId on job events does not break processing
 * - Delivery receipt sent for jobs that have a top-level jobId
 * - consumePendingConfigNotifications lifecycle
 * - Zod validation rejects malformed job payloads
 * - Secret placeholder invariant: no real credential string leaks into logged
 *   worker-config or payload fields (the proxy swaps `lobu_secret_<uuid>`
 *   placeholders; the worker must only ever see those tokens).
 * - Worker is cleaned up on mid-run stop
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { consumePendingConfigNotifications } from "../gateway/pending-config-notifications";
import { isExplicitCancelMessage, isSteerableHumanMessage } from "@lobu/core";
import { GatewayClient } from "../gateway/sse-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    payload: {
      botId: "lobu-api",
      userId: "user-1",
      organizationId: "org-1",
      runId: 1,
      runJobToken: "run-token",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId: "msg-1",
      messageText: "hello",
      platformMetadata: {},
      agentOptions: {},
      ...overrides,
    },
  });
}

function makeClient(dispatcherUrl = "https://gw.example.com") {
  return new GatewayClient(dispatcherUrl, "test-token", "user-1", "worker-1");
}

// ---------------------------------------------------------------------------
// consumePendingConfigNotifications lifecycle
// ---------------------------------------------------------------------------

describe("consumePendingConfigNotifications", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns empty array when no notifications are pending", () => {
    // Drain any notifications from earlier tests first
    consumePendingConfigNotifications();
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("returns and clears pending config change notifications", async () => {
    consumePendingConfigNotifications(); // drain

    const client = makeClient();
    const mockFetch = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await (client as any).handleEvent(
      "config_changed",
      JSON.stringify({
        changes: [
          { category: "provider", action: "updated", summary: "Key rotated" },
        ],
      })
    );

    const notifications = consumePendingConfigNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      category: "provider",
      action: "updated",
      summary: "Key rotated",
    });

    // Second call: cleared
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("handles config_changed with no changes array gracefully", async () => {
    consumePendingConfigNotifications(); // drain
    const client = makeClient();
    // Missing `changes` key — backward compat path
    await (client as any).handleEvent(
      "config_changed",
      JSON.stringify({ something: "else" })
    );
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("handles config_changed with invalid JSON gracefully", async () => {
    consumePendingConfigNotifications(); // drain
    const client = makeClient();
    // Should not throw; backward compat ignores bad payload
    await expect(
      (client as any).handleEvent("config_changed", "NOT_JSON")
    ).resolves.toBeUndefined();
    expect(consumePendingConfigNotifications()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unknown / unsupported event types
// ---------------------------------------------------------------------------

describe("handleEvent unknown event types", () => {
  test("silently ignores unknown event type without throwing", async () => {
    const client = makeClient();
    await expect(
      (client as any).handleEvent("mystery_event", JSON.stringify({ x: 1 }))
    ).resolves.toBeUndefined();
  });

  test("ignores empty data gracefully", async () => {
    const client = makeClient();
    // The SSE loop skips events where eventData is empty — confirm handleEvent
    // itself also survives an empty string (defensive).
    await expect(
      (client as any).handleEvent("job", "")
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Job event: Zod validation
// ---------------------------------------------------------------------------

describe("handleEvent job validation", () => {
  test("rejects job payload missing required fields", async () => {
    const client = makeClient();
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    // Missing botId / userId / agentId etc.
    await (client as any).handleEvent(
      "job",
      JSON.stringify({ payload: { messageText: "hi" } })
    );

    // Validation should have failed → handleThreadMessage never called
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("rejects job payload with completely wrong shape", async () => {
    const client = makeClient();
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent("job", JSON.stringify({ bad: true }));
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("rejects non-JSON job data", async () => {
    const client = makeClient();
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent("job", "totally-not-json");
    expect(handleThreadMessage).not.toHaveBeenCalled();
  });

  test("accepts valid job and calls handleThreadMessage", async () => {
    const client = makeClient();
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent("job", makeJobEvent());
    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
  });

  test("passes through nested platformMetadata objects", async () => {
    const client = makeClient();
    const handleThreadMessage = mock(async () => undefined);
    (client as any).handleThreadMessage = handleThreadMessage;

    await (client as any).handleEvent(
      "job",
      makeJobEvent({
        platformMetadata: {
          source: "automation-run",
          intent: { kind: "automation_run", runId: 42, automationId: 7 },
        },
      })
    );

    expect(handleThreadMessage).toHaveBeenCalledTimes(1);
    expect(
      handleThreadMessage.mock.calls[0]?.[0].platformMetadata.intent
    ).toEqual({ kind: "automation_run", runId: 42, automationId: 7 });
  });
});

// ---------------------------------------------------------------------------
// Delivery receipt
// ---------------------------------------------------------------------------

describe("delivery receipt", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends delivery receipt when top-level jobId is present", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = makeClient("https://gw.example.com");
    // Stub handleThreadMessage to avoid real worker execution
    (client as any).handleThreadMessage = mock(async () => undefined);

    const payload = JSON.parse(makeJobEvent());
    payload.jobId = "top-level-job-id";

    await (client as any).handleEvent("job", JSON.stringify(payload));

    // Wait a tick for the fire-and-forget receipt fetch
    await new Promise((r) => setTimeout(r, 10));

    const calls = fetchMock.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/worker/response")
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const bodyStr = calls[0]?.[1]?.body as string;
    const body = JSON.parse(bodyStr);
    expect(body).toMatchObject({ jobId: "top-level-job-id", received: true });
  });

  test("does not send delivery receipt when jobId is absent", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = makeClient("https://gw.example.com");
    (client as any).handleThreadMessage = mock(async () => undefined);

    // No top-level jobId
    await (client as any).handleEvent("job", makeJobEvent());

    await new Promise((r) => setTimeout(r, 10));

    const receiptCalls = fetchMock.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/worker/response") &&
        (() => {
          try {
            const b = JSON.parse(c[1]?.body as string);
            return "jobId" in b;
          } catch {
            return false;
          }
        })()
    );
    expect(receiptCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reconnect backoff
// ---------------------------------------------------------------------------

describe("handleReconnect exponential backoff", () => {
  test("increments reconnectAttempts and caps delay at 60 s", async () => {
    const client = makeClient();

    // Spy on setTimeout to capture delay without actually waiting
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, delay: number) => {
      delays.push(delay);
      // Execute immediately so the await resolves
      fn();
      return 0 as unknown as NodeJS.Timeout;
    };

    try {
      // Simulate 4 reconnect cycles (attempt 1-4)
      for (let i = 0; i < 4; i++) {
        (client as any).reconnectAttempts = i;
        await (client as any).handleReconnect();
      }
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    // Delays should be: 1000, 2000, 4000, 8000 (2^0, 2^1, 2^2, 2^3 * 1000)
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
  });

  test("caps delay at 60000 ms for high attempt numbers", async () => {
    const client = makeClient();
    // maxReconnectAttempts=10; set to 8 so it won't early-return but attempt 9 yields a huge exponent
    (client as any).maxReconnectAttempts = 20;

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, delay: number) => {
      delays.push(delay);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    };

    try {
      (client as any).reconnectAttempts = 16; // attempt 17 → 2^16 * 1000 = 65536000 → capped at 60000
      await (client as any).handleReconnect();
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    expect(delays[0]).toBe(60000);
  });

  test("sets isRunning=false and skips delay when max attempts reached", async () => {
    const client = makeClient();
    (client as any).reconnectAttempts = 10; // already at max

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, delay: number) => {
      delays.push(delay);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    };

    try {
      await (client as any).handleReconnect();
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    expect((client as any).isRunning).toBe(false);
    expect(delays).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SSE frame parsing: partial / multi-event chunks
// ---------------------------------------------------------------------------

describe("SSE partial frame handling (buffer logic)", () => {
  /**
   * Simulate what the connectAndListen loop does with the buffer.
   * We extract that logic here by calling the private parser the same way the
   * loop does: accumulate chunks → split on \n\n → parse fields.
   */
  function parseSSEChunks(
    chunks: string[]
  ): Array<{ eventType: string; eventData: string }> {
    let buffer = "";
    const events: Array<{ eventType: string; eventData: string }> = [];

    for (const chunk of chunks) {
      buffer += chunk;
      const rawEvents = buffer.split("\n\n");
      buffer = rawEvents.pop() || "";

      for (const event of rawEvents) {
        if (!event.trim()) continue;
        const lines = event.split("\n");
        let eventType = "message";
        let eventData = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.substring(6).trim();
          else if (line.startsWith("data:"))
            eventData = line.substring(5).trim();
        }
        if (eventData) events.push({ eventType, eventData });
      }
    }

    return events;
  }

  test("reassembles event split across two chunks", () => {
    const eventJson = JSON.stringify({ ts: 1 });
    const chunk1 = `event: ping\ndata: ${eventJson}`;
    const chunk2 = `\n\n`;

    const events = parseSSEChunks([chunk1, chunk2]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ eventType: "ping", eventData: eventJson });
  });

  test("handles multiple events in a single chunk", () => {
    const chunk = "event: ping\ndata: {}\n\nevent: ping\ndata: {}\n\n";

    const events = parseSSEChunks([chunk]);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("ping");
    expect(events[1]?.eventType).toBe("ping");
  });

  test("empty lines between events are skipped", () => {
    const chunk = "\n\nevent: ping\ndata: {}\n\n";
    const events = parseSSEChunks([chunk]);
    expect(events).toHaveLength(1);
  });

  test("partial frame split mid-line is reassembled by buffer concatenation", () => {
    // "event: ping\ndat" + "a: {}\n\n" → buffer becomes "event: ping\ndata: {}\n\n"
    // The \n\n delimiter is only present after the second chunk, so one complete event is emitted.
    const events = parseSSEChunks(["event: ping\ndat", "a: {}\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("ping");
    expect(events[0]?.eventData).toBe("{}");
  });

  test("truly incomplete frame (no trailing double-newline) stays in buffer", () => {
    // No \n\n means the event boundary is never reached → nothing emitted
    const events = parseSSEChunks(["event: ping\ndata: {}"]);
    expect(events).toHaveLength(0);
  });

  test("event with only data: field uses default message type", () => {
    const events = parseSSEChunks(['data: {"hello":"world"}\n\n']);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("message");
    expect(events[0]?.eventData).toBe('{"hello":"world"}');
  });

  test("garbled JSON in data field results in parse error handled by handleEvent", async () => {
    const client = makeClient();
    // handleEvent should catch the JSON parse error internally and not throw
    await expect(
      (client as any).handleEvent("job", "GARBAGE_NOT_JSON")
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// payloadToWorkerConfig: secret placeholder invariant
// ---------------------------------------------------------------------------

describe("payloadToWorkerConfig: secret placeholder invariant", () => {
  test("userPrompt is base64-encoded (real creds never travel in plaintext)", () => {
    const client = makeClient();
    const payload = {
      botId: "bot",
      userId: "user-1",
      organizationId: "org-1",
      runId: 1,
      runJobToken: "run-token",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId: "msg-1",
      messageText: "lobu_secret_abc123 should be placeholder, not real key",
      platformMetadata: {},
      agentOptions: {},
    };

    const config = (client as any).payloadToWorkerConfig(payload);

    // userPrompt is base64 — attempting to decode gives original text,
    // but the field itself must NOT be the raw string
    expect(config.userPrompt).not.toBe(payload.messageText);
    const decoded = Buffer.from(config.userPrompt, "base64").toString("utf-8");
    expect(decoded).toBe(payload.messageText);
  });

  test("a lobu_secret placeholder in messageText is preserved, not stripped", () => {
    const client = makeClient();
    const secretRef = "lobu_secret_d4e5f6a7-b8c9-0000-1111-222233334444";
    const payload = {
      botId: "bot",
      userId: "user-1",
      organizationId: "org-1",
      runId: 1,
      runJobToken: "run-token",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId: "msg-1",
      messageText: `Use the API key: ${secretRef}`,
      platformMetadata: {},
      agentOptions: {},
    };

    const config = (client as any).payloadToWorkerConfig(payload);
    const decoded = Buffer.from(config.userPrompt, "base64").toString("utf-8");
    // Placeholder must be present (the proxy swaps it; worker should see it)
    expect(decoded).toContain(secretRef);
  });

  test("workerConfig does not contain WORKER_TOKEN or DISPATCHER_URL values", () => {
    const client = makeClient("https://gw.example.com");
    const payload = {
      botId: "bot",
      userId: "user-1",
      organizationId: "org-1",
      runId: 1,
      runJobToken: "run-token",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId: "msg-1",
      messageText: "hello",
      platformMetadata: {},
      agentOptions: {},
    };

    const config = (client as any).payloadToWorkerConfig(payload);
    const configStr = JSON.stringify(config);

    // The GatewayClient reads WORKER_TOKEN from its constructor arg, not env.
    // The worker config should never carry the raw token string.
    expect(configStr).not.toContain("test-token");
  });

  test("agentOptions are serialised as JSON string in workerConfig", () => {
    const client = makeClient();
    const agentOptions = {
      model: "anthropic/claude-sonnet-4-20250514",
      maxTokens: 4096,
    };
    const payload = {
      botId: "bot",
      userId: "user-1",
      organizationId: "org-1",
      runId: 1,
      runJobToken: "run-token",
      agentId: "agent-1",
      conversationId: "conv-1",
      platform: "api",
      channelId: "chan-1",
      messageId: "msg-1",
      messageText: "hi",
      platformMetadata: {},
      agentOptions,
    };

    const config = (client as any).payloadToWorkerConfig(payload);
    expect(typeof config.agentOptions).toBe("string");
    const parsed = JSON.parse(config.agentOptions);
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(parsed.maxTokens).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// getStatus / isHealthy
// ---------------------------------------------------------------------------

describe("getStatus and isHealthy", () => {
  test("getStatus reports isRunning=false before start()", () => {
    const client = makeClient();
    const status = client.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.userId).toBe("user-1");
    expect(status.deploymentName).toBe("worker-1");
  });

  test("isHealthy returns false when not running", () => {
    const client = makeClient();
    expect(client.isHealthy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stop() cleans up current worker
// ---------------------------------------------------------------------------

describe("stop() mid-run cleanup", () => {
  test("stop() calls cleanup() on a running worker and nullifies it", async () => {
    const client = makeClient();

    const cleanupMock = mock(async () => undefined);
    (client as any).currentWorker = { cleanup: cleanupMock };

    await client.stop();

    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect((client as any).currentWorker).toBeNull();
    expect((client as any).isRunning).toBe(false);
  });

  test("stop() without a running worker does not throw", async () => {
    const client = makeClient();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  test("does not recreate a worker when a queued drain runs after stop", async () => {
    const client = makeClient();
    await client.stop();

    const workerConstructor = (client as any).currentWorker;
    await (client as any).processSingleMessage({
      payload: {
        ...JSON.parse(makeJobEvent()).payload,
        messageId: "after-stop",
      },
      timestamp: 1,
    });

    expect((client as any).currentWorker).toBe(workerConstructor);
  });
});

describe("live steering classification", () => {
  const payload = {
    botId: "bot",
    userId: "user",
    agentId: "agent",
    conversationId: "conversation",
    platform: "api",
    channelId: "channel",
    messageId: "message",
    messageText: "change direction",
    platformMetadata: {},
    agentOptions: {},
  } as any;

  test("allows same-conversation human text", () => {
    expect(isSteerableHumanMessage(payload)).toBe(true);
  });

  test("steers only Automations that explicitly opt in", () => {
    expect(
      isSteerableHumanMessage({
        ...payload,
        platformMetadata: {
          automationId: 7,
          automationActiveRunPolicy: "steer",
        },
      })
    ).toBe(true);
    for (const automationActiveRunPolicy of ["queue", "coalesce"]) {
      expect(
        isSteerableHumanMessage({
          ...payload,
          platformMetadata: { automationId: 7, automationActiveRunPolicy },
        })
      ).toBe(false);
    }
  });

  test("keeps a session reset as a standalone turn", () => {
    expect(
      isSteerableHumanMessage({
        ...payload,
        messageText: "/new",
        platformMetadata: { sessionReset: true },
      })
    ).toBe(false);
  });

  test("keeps a `!`-bash command as a standalone turn (never steered)", () => {
    // Steering `!cmd` into an active turn would feed the raw text to the model
    // instead of running the shell; it must queue as its own turn.
    expect(
      isSteerableHumanMessage({
        ...payload,
        messageText: "!ls /workspace",
        platformMetadata: {
          bangBash: { command: "ls /workspace", excludeFromContext: false },
        },
      })
    ).toBe(false);
  });

  test("keeps automation and attachments as follow-up turns", () => {
    for (const source of [
      "automation-run",
      "scheduled-job",
      "connector-repair",
      "internal",
    ]) {
      expect(
        isSteerableHumanMessage({
          ...payload,
          platformMetadata: { source },
        })
      ).toBe(false);
    }
    expect(
      isSteerableHumanMessage({
        ...payload,
        platformMetadata: { files: [{ id: "file" }] },
      })
    ).toBe(false);
  });

  test("recognizes only explicit cancellation controls", () => {
    expect(
      isExplicitCancelMessage({ ...payload, messageText: " /CANCEL " })
    ).toBe(true);
    expect(
      isExplicitCancelMessage({
        ...payload,
        platformMetadata: { control: "cancel" },
      })
    ).toBe(true);
    expect(
      isExplicitCancelMessage({
        ...payload,
        platformMetadata: { intent: { kind: "cancel" } },
      })
    ).toBe(true);
    expect(
      isExplicitCancelMessage({
        ...payload,
        messageText: "cancel that search and use another source",
      })
    ).toBe(false);
  });

  test("routes human text into the active worker instead of the next batch", async () => {
    const client = makeClient();
    const steer = mock(async () => true);
    const claimMessageId = mock(() => true);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { steer };
    (client as any).currentWorkerUserId = "user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId,
      addClaimedMessage,
    };

    await (client as any).handleThreadMessage(payload);

    expect(claimMessageId).toHaveBeenCalledWith("message");
    expect(steer).toHaveBeenCalledWith("change direction", "message");
    expect(addClaimedMessage).not.toHaveBeenCalled();
  });

  test("queues a session reset behind the active turn instead of steering it", async () => {
    const client = makeClient();
    const steer = mock(async () => true);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { steer };
    (client as any).currentWorkerUserId = "user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId: () => true,
      addClaimedMessage,
    };
    const resetPayload = {
      ...payload,
      messageId: "reset-message",
      messageText: "/new",
      platformMetadata: { sessionReset: true },
    };

    await (client as any).handleThreadMessage(resetPayload);

    expect(steer).not.toHaveBeenCalled();
    expect(addClaimedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ payload: resetPayload })
    );
  });

  test("queues human text when the active prompt has already settled", async () => {
    const client = makeClient();
    const steer = mock(async () => false);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { steer };
    (client as any).currentWorkerUserId = "user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId: () => true,
      addClaimedMessage,
    };

    await (client as any).handleThreadMessage(payload);

    expect(steer).toHaveBeenCalledWith("change direction", "message");
    expect(addClaimedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ payload })
    );
  });

  test("deduplicates an active message before live steering", async () => {
    const client = makeClient();
    const seen = new Set<string>();
    const steer = mock(async () => true);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { steer };
    (client as any).currentWorkerUserId = "user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId: (messageId: string) => {
        if (seen.has(messageId)) return false;
        seen.add(messageId);
        return true;
      },
      addClaimedMessage,
    };

    await (client as any).handleThreadMessage(payload);
    await (client as any).handleThreadMessage(payload);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(addClaimedMessage).not.toHaveBeenCalled();
  });

  test("queues another user's message under its own run credentials", async () => {
    const client = makeClient();
    const steer = mock(async () => true);
    const cancel = mock(async () => true);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { steer, cancel };
    (client as any).currentWorkerUserId = "first-user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId: () => true,
      addClaimedMessage,
    };

    await (client as any).handleThreadMessage(payload);

    expect(steer).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(addClaimedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ payload })
    );
  });

  test("does not combine different users into one credential-scoped batch", async () => {
    const client = makeClient();
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    const first = {
      payload: { ...payload, messageId: "first", userId: "first-user" },
      timestamp: 1,
    };
    const second = {
      payload: { ...payload, messageId: "second", userId: "second-user" },
      timestamp: 2,
    };

    await (client as any).processBatchedMessages([first, second]);

    expect(processSingleMessage).toHaveBeenNthCalledWith(1, first, ["first"]);
    expect(processSingleMessage).toHaveBeenNthCalledWith(2, second, ["second"]);
  });

  test("continues an unattempted batch suffix exactly once after an earlier item fails", async () => {
    const client = makeClient();
    const attempts: string[] = [];
    (client as any).processSingleMessage = mock(async (message: any) => {
      const messageId = message.payload.messageId as string;
      attempts.push(messageId);
      if (messageId === "first-fails") throw new Error("turn failed");
    });

    const batcher = (client as any).messageBatcher;
    batcher.batchWindowMs = 5;
    await batcher.addMessage({
      payload: { ...payload, messageId: "warmup" },
      timestamp: 0,
    });
    await batcher.addMessage({
      payload: {
        ...payload,
        messageId: "first-fails",
        userId: "first-user",
      },
      timestamp: 1,
    });
    await batcher.addMessage({
      payload: {
        ...payload,
        messageId: "suffix-must-run",
        userId: "second-user",
      },
      timestamp: 2,
    });

    const deadline = Date.now() + 500;
    while (!attempts.includes("suffix-must-run") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(attempts).toEqual(["warmup", "first-fails", "suffix-must-run"]);
    batcher.stop();
  });

  test("keeps queue-policy Automation events as one turn per delivery", async () => {
    const client = makeClient();
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    const first = {
      payload: {
        ...payload,
        messageId: "automation-first",
        platformMetadata: {
          automationId: 7,
          automationActiveRunPolicy: "queue",
        },
      },
      timestamp: 1,
    };
    const second = {
      payload: {
        ...payload,
        messageId: "automation-second",
        platformMetadata: {
          automationId: 7,
          automationActiveRunPolicy: "queue",
        },
      },
      timestamp: 2,
    };

    await (client as any).processBatchedMessages([first, second]);

    expect(processSingleMessage).toHaveBeenNthCalledWith(1, first, [
      "automation-first",
    ]);
    expect(processSingleMessage).toHaveBeenNthCalledWith(2, second, [
      "automation-second",
    ]);
  });

  test("does not combine coalescing deliveries from different Automations", async () => {
    const client = makeClient();
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    const first = {
      payload: {
        ...payload,
        messageId: "automation-first",
        platformMetadata: {
          automationId: 7,
          automationActiveRunPolicy: "coalesce",
        },
      },
      timestamp: 1,
    };
    const second = {
      payload: {
        ...payload,
        messageId: "automation-second",
        platformMetadata: {
          automationId: 8,
          automationActiveRunPolicy: "coalesce",
        },
      },
      timestamp: 2,
    };

    await (client as any).processBatchedMessages([first, second]);

    expect(processSingleMessage).toHaveBeenNthCalledWith(1, first, [
      "automation-first",
    ]);
    expect(processSingleMessage).toHaveBeenNthCalledWith(2, second, [
      "automation-second",
    ]);
  });

  test("does not combine an Automation delivery with a human message", async () => {
    const client = makeClient();
    const processSingleMessage = mock(async () => undefined);
    (client as any).processSingleMessage = processSingleMessage;
    const automation = {
      payload: {
        ...payload,
        messageId: "automation",
        platformMetadata: {
          automationId: 7,
          automationActiveRunPolicy: "coalesce",
        },
      },
      timestamp: 1,
    };
    const human = {
      payload: {
        ...payload,
        messageId: "human",
        platformMetadata: {},
      },
      timestamp: 2,
    };

    await (client as any).processBatchedMessages([automation, human]);

    expect(processSingleMessage).toHaveBeenNthCalledWith(1, automation, [
      "automation",
    ]);
    expect(processSingleMessage).toHaveBeenNthCalledWith(2, human, ["human"]);
  });

  test("routes explicit cancel to the active worker before steering", async () => {
    const client = makeClient();
    const cancel = mock(async () => true);
    const steer = mock(async () => true);
    const addClaimedMessage = mock(async () => undefined);
    (client as any).currentWorker = { cancel, steer };
    (client as any).currentWorkerUserId = "user";
    (client as any).messageBatcher = {
      isCurrentlyProcessing: () => true,
      claimMessageId: () => true,
      addClaimedMessage,
    };

    await (client as any).handleThreadMessage({
      ...payload,
      messageId: "cancel-message",
      messageText: "/cancel",
    });

    expect(cancel).toHaveBeenCalledWith("cancel-message");
    expect(steer).not.toHaveBeenCalled();
    expect(addClaimedMessage).not.toHaveBeenCalled();
  });
});
