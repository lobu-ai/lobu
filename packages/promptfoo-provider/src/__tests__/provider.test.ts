import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LobuProvider } from "../provider";

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function createFetchStub(events: string[]) {
  let sentMessageId = "";
  return mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/lobu/api/v1/agents") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ agentId: "agent-x", token: "session-token" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/messages")) {
      sentMessageId = JSON.parse(String(init?.body)).messageId;
      return new Response(
        JSON.stringify({
          messageId: sentMessageId,
          traceparent: "00-traceabcdef-span0-01",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/events")) {
      return new Response(
        streamFromChunks(
          events.map((event) =>
            event.replaceAll('"msg-1"', JSON.stringify(sentMessageId))
          )
        ),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }
      );
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });
}

const originalFetch = globalThis.fetch;

describe("LobuProvider tool_use SSE handling", () => {
  beforeEach(() => {
    process.env.LOBU_TOKEN = "dummy";
    process.env.LOBU_AGENT = "test-agent";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("populates metadata.toolCalls and metadata.retrievedContext from search_memory tool_use events", async () => {
    const events = [
      sseEvent("connected", { agentId: "agent-x" }),
      sseEvent("output", {
        content: "Looking at your records...",
        messageId: "msg-1",
      }),
      sseEvent("tool_use", {
        toolCallId: "tc-1",
        name: "search_memory",
        input: { query: "rent due" },
        isError: false,
        result_summary: {
          event_ids: [42, 43],
          snippets: [
            { id: 42, text: "Tenant Acme pays £1,200 on the 1st" },
            { id: 43, text: "Lease ends Dec 2027" },
          ],
        },
        messageId: "msg-1",
      }),
      sseEvent("output", {
        content: " Acme pays £1,200 monthly.",
        messageId: "msg-1",
      }),
      sseEvent("complete", {
        messageId: "msg-1",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("when is rent due?");

    expect(result.output).toBe(
      "Looking at your records... Acme pays £1,200 monthly."
    );
    expect(result.metadata.toolCalls).toBeDefined();
    expect(result.metadata.toolCalls).toHaveLength(1);
    expect(result.metadata.toolCalls![0]!.name).toBe("search_memory");
    expect(result.metadata.toolCalls![0]!.result_summary?.event_ids).toEqual([
      42, 43,
    ]);
    expect(result.metadata.retrievedContext).toBe(
      "Tenant Acme pays £1,200 on the 1st\n\nLease ends Dec 2027"
    );
    expect(result.metadata.traceId).toBe("traceabcdef");
    expect(result.tokenUsage?.total).toBe(18);
  });

  test("ignores tool_use events for other messageIds", async () => {
    const events = [
      sseEvent("tool_use", {
        toolCallId: "tc-other",
        name: "search_memory",
        input: { query: "stale" },
        result_summary: {
          event_ids: [1],
          snippets: [{ id: 1, text: "stale" }],
        },
        messageId: "different-message",
      }),
      sseEvent("output", { content: "hi", messageId: "msg-1" }),
      sseEvent("complete", { messageId: "msg-1" }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("hi");
    expect(result.metadata.toolCalls).toBeUndefined();
    expect(result.metadata.retrievedContext).toBeUndefined();
  });

  test("captures non-retrieval tool calls in metadata.toolCalls without retrievedContext", async () => {
    const events = [
      sseEvent("tool_use", {
        toolCallId: "tc-bash",
        name: "bash",
        input: { command: "ls" },
        messageId: "msg-1",
      }),
      sseEvent("output", { content: "done", messageId: "msg-1" }),
      sseEvent("complete", { messageId: "msg-1" }),
    ];
    globalThis.fetch = createFetchStub(events) as any;

    const provider = new LobuProvider({
      config: { agent: "test-agent", gateway: "http://gateway", token: "tok" },
    });
    const result = await provider.callApi("ls");
    expect(result.metadata.toolCalls).toEqual([
      { toolCallId: "tc-bash", name: "bash", input: { command: "ls" } },
    ]);
    expect(result.metadata.retrievedContext).toBeUndefined();
  });
});

// Each test installs its own fetch mock that records every request and returns
// canned responses for the gateway's four endpoints: POST /agents (create
// session), POST /agents/<id>/messages (send turn), GET /agents/<id>/events
// (SSE stream), DELETE /agents/<id> (cleanup).
//
// The SSE stream returns a `complete` event whose `data.content` echoes the
// turn-index counter so the test can assert which turn's response actually
// got returned to promptfoo.

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

function installGatewayMock() {
  const recorded: Recorded[] = [];
  let messageCounter = 0;
  let sentMessageId = "";

  const originalFetch = globalThis.fetch;
  const fetchMock = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      recorded.push({ url, method, body });

      // Create session
      if (method === "POST" && url.endsWith("/lobu/api/v1/agents")) {
        return new Response(
          JSON.stringify({ agentId: "agent-1", token: "session-token" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Send message — returns a fresh messageId per turn so the SSE filter
      // works.
      if (method === "POST" && url.endsWith("/messages")) {
        messageCounter += 1;
        sentMessageId = JSON.parse(body ?? "{}").messageId;
        return new Response(
          JSON.stringify({
            messageId: sentMessageId,
            traceparent: `00-trace${messageCounter}-span-01`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // SSE event stream — emits one `complete` event tagged with the current
      // messageId.
      if (method === "GET" && url.endsWith("/events")) {
        const messageId = sentMessageId;
        const payload =
          `event: output\ndata: ${JSON.stringify({ messageId, content: `turn-${messageCounter}` })}\n\n` +
          `event: complete\ndata: ${JSON.stringify({ messageId, usage: { input_tokens: 1, output_tokens: 2 } })}\n\n`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      // Delete session
      if (method === "DELETE") {
        return new Response("", { status: 204 });
      }

      return new Response("not found", { status: 404 });
    }
  );

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return {
    recorded,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("LobuProvider.callApi", () => {
  let mockHandle: ReturnType<typeof installGatewayMock>;

  beforeEach(() => {
    mockHandle = installGatewayMock();
  });

  afterEach(() => {
    mockHandle.restore();
  });

  test("single-turn: sends one user message and returns the response", async () => {
    const provider = new LobuProvider({
      config: { agent: "test-agent", token: "tok" },
    });
    const result = await provider.callApi("hello");

    expect(result.output).toBe("turn-1");
    const sends = mockHandle.recorded.filter((r) =>
      r.url.endsWith("/messages")
    );
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body ?? "{}").content).toBe("hello");
  });

  test("multi-turn: replays vars.transcript in one thread and returns the final response", async () => {
    const provider = new LobuProvider({
      config: { agent: "test-agent", token: "tok" },
    });
    const result = await provider.callApi("ignored", {
      vars: {
        transcript: ["first turn", "second turn", "third turn"],
      },
    });

    // The final turn's content is what comes back.
    expect(result.output).toBe("turn-3");

    // All three turns went out as separate messages, in order.
    const sends = mockHandle.recorded.filter((r) =>
      r.url.endsWith("/messages")
    );
    expect(sends).toHaveLength(3);
    expect(sends.map((r) => JSON.parse(r.body ?? "{}").content)).toEqual([
      "first turn",
      "second turn",
      "third turn",
    ]);

    // Only one session was created — the same thread is re-used across turns.
    const creates = mockHandle.recorded.filter(
      (r) => r.method === "POST" && r.url.endsWith("/lobu/api/v1/agents")
    );
    expect(creates).toHaveLength(1);

    // And only one cleanup at the end.
    const deletes = mockHandle.recorded.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  test("multi-turn: filters out empty / whitespace entries", async () => {
    const provider = new LobuProvider({
      config: { agent: "test-agent", token: "tok" },
    });
    await provider.callApi("ignored", {
      vars: {
        transcript: ["real turn", "", "   ", "second real turn"],
      },
    });

    const sends = mockHandle.recorded.filter((r) =>
      r.url.endsWith("/messages")
    );
    expect(sends).toHaveLength(2);
    expect(sends.map((r) => JSON.parse(r.body ?? "{}").content)).toEqual([
      "real turn",
      "second real turn",
    ]);
  });

  test("multi-turn: non-array transcript falls back to single-turn prompt", async () => {
    const provider = new LobuProvider({
      config: { agent: "test-agent", token: "tok" },
    });
    await provider.callApi("fallback prompt", {
      vars: { transcript: "not an array" },
    });

    const sends = mockHandle.recorded.filter((r) =>
      r.url.endsWith("/messages")
    );
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body ?? "{}").content).toBe("fallback prompt");
  });

  test("multi-turn: empty array falls back to single-turn prompt", async () => {
    const provider = new LobuProvider({
      config: { agent: "test-agent", token: "tok" },
    });
    await provider.callApi("fallback prompt", {
      vars: { transcript: [] },
    });

    const sends = mockHandle.recorded.filter((r) =>
      r.url.endsWith("/messages")
    );
    expect(sends).toHaveLength(1);
    expect(JSON.parse(sends[0]!.body ?? "{}").content).toBe("fallback prompt");
  });
});

describe("LobuProvider retained HTTP backlog", () => {
  test.each([
    "complete",
    "error",
    "agent-error",
  ])("correlates follow-ups and batched %s without a response messageId", async (terminal) => {
    const turns: Array<{ content: string; messageId: string }> = [];
    let backlog = "";
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/agents") && request.method === "POST") {
          return Response.json({
            agentId: "test-session",
            token: "session-token",
          });
        }
        if (path.endsWith("/messages")) {
          const body = (await request.json()) as {
            content: string;
            messageId?: string;
          };
          const messageId = body.messageId ?? `server-${turns.length}`;
          turns.push({ content: body.content, messageId });
          const current =
            turns.length === 1
              ? sseEvent("output", { messageId, content: "old reply" }) +
                sseEvent("complete", { messageId })
              : sseEvent("output", {
                  messageId: "unrelated",
                  content: "stale delta",
                }) +
                sseEvent(terminal, {
                  messageId: "batch-leader",
                  processedMessageIds: ["batch-leader", messageId],
                  finalText: "new batched reply",
                  error: "current failure",
                });
          backlog += current;
          // Some compatible gateways omit the optional response id. The caller
          // must use its submitted identity rather than accepting the backlog.
          return Response.json({ queued: true });
        }
        if (path.endsWith("/events")) {
          return new Response(backlog, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const provider = new LobuProvider({
        config: {
          agent: "test-agent",
          token: "test-token",
          gateway: gateway.url.toString(),
        },
      });
      const result = await provider.callApi("ignored", {
        vars: { transcript: ["first task", "new task"] },
      });
      if (terminal === "complete")
        expect(result.output).toBe("new batched reply");
      else expect(result.error).toBe("current failure");
      expect(turns).toHaveLength(2);
      expect(turns[0]?.messageId).not.toBe(turns[1]?.messageId);
    } finally {
      await gateway.stop(true);
    }
  });
});
