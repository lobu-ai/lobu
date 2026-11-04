import { describe, expect, test } from "bun:test";
import { Lobu } from "../client.js";
import { LobuAgentError } from "../errors.js";

describe("Lobu", () => {
  test("creates a session and sends with the session token", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: string;
    }> = [];
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      calls.push(request);

      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }

      return json({
        success: true,
        messageId: "msg_1",
        queued: true,
      });
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu/",
      token: "api-token",
      fetch: fetchImpl,
    });

    const session = await lobu.sessions.create({
      agentId: "support",
      userId: "user_1",
    });
    const result = await session.send("hello", { messageId: "msg_1" });

    expect(session.conversationId).toBe("support_user_1");
    expect(result.queued).toBe(true);
    expect(calls[0]).toMatchObject({
      url: "https://lobu.test/lobu/api/v1/agents",
      authorization: "Bearer api-token",
    });
    expect(calls[1]).toMatchObject({
      url: "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
      authorization: "Bearer session-token",
      body: JSON.stringify({ content: "hello", messageId: "msg_1" }),
    });
  });

  test("streams SSE events with authorization", async () => {
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }

      expect(request.authorization).toBe("Bearer session-token");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: connected\ndata: {"agentId":"support"}\n\nevent: text\ndata: "hi"\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});
    const events = [];

    for await (const event of session.events()) events.push(event);

    expect(events).toEqual([
      { event: "connected", data: { agentId: "support" }, retry: 3000 },
      { event: "text", data: "hi", retry: 3000 },
    ]);
  });

  test("rejects (does not hang) when the SSE stream returns a non-OK status", async () => {
    let sseAttempts = 0;
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }
      // The SSE endpoint is unauthorized — without the fix the generated client
      // would retry this forever and the iterator would never settle.
      sseAttempts++;
      return json({ error: "unauthorized" }, 401);
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});

    let threw: unknown;
    const collected: unknown[] = [];
    try {
      for await (const event of session.events()) collected.push(event);
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeDefined();
    expect((threw as Error).message).toContain("401");
    expect(collected).toEqual([]);
    // Default cap is a single attempt — no infinite reconnect loop.
    expect(sseAttempts).toBe(1);
  });

  test("terminates cleanly when the caller aborts the stream", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }
      // An open stream that yields one event then stays open until aborted.
      return new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(
              new TextEncoder().encode('event: text\ndata: "first"\n\n')
            );
            // Never close — the caller's abort must end the iteration.
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});

    const collected: unknown[] = [];
    for await (const event of session.events({ signal: controller.signal })) {
      collected.push(event);
      controller.abort(); // abort right after the first event
    }

    // The loop must EXIT (not hang) after the abort; the first event arrived.
    expect(collected).toEqual([{ event: "text", data: "first", retry: 3000 }]);
  });

  test("refresh() re-mints the token via the resume path and updates it in place", async () => {
    const agentsBodies: unknown[] = [];
    let mint = 0;
    const fetchImpl = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        agentsBodies.push(JSON.parse(await request.clone().text()));
        mint += 1;
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: `session-token-${mint}`,
            expiresAt: 1000 * mint,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }
      return json({ success: true, messageId: "m", queued: true });
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });

    const input = { agentId: "support", userId: "user_1", forceNew: true };
    const session = await lobu.sessions.create(input);
    expect(session.token).toBe("session-token-1");
    expect(session.expiresAt).toBe(1000);

    // Mutating the caller's object must not change what refresh replays.
    input.agentId = "evil";

    const returned = await session.refresh();
    expect(returned).toBe(session);
    expect(session.token).toBe("session-token-2");
    expect(session.expiresAt).toBe(2000);

    // refresh normalizes to the resume path with the ORIGINAL agentId.
    expect(agentsBodies[1]).toMatchObject({
      agentId: "support",
      userId: "user_1",
      forceNew: false,
    });
  });

  test("ask() sends after `connected`, concatenates output, resolves on complete", async () => {
    const messagesBodies: unknown[] = [];
    const fetchImpl = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }
      if (request.url.endsWith("/messages")) {
        messagesBodies.push(JSON.parse(await request.clone().text()));
        return json({ success: true, messageId: "ask_1", queued: true });
      }
      // SSE: connected, a stale delta for another id (must be ignored), our
      // deltas, then complete for ask_1.
      return new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'event: connected\ndata: {"agentId":"support","timestamp":1}\n\n'
              )
            );
            controller.enqueue(
              enc.encode(
                'event: output\ndata: {"type":"delta","content":"stale","messageId":"other","timestamp":2}\n\n'
              )
            );
            controller.enqueue(
              enc.encode(
                'event: output\ndata: {"type":"delta","content":"Hello ","messageId":"ask_1","timestamp":3}\n\n'
              )
            );
            controller.enqueue(
              enc.encode(
                'event: output\ndata: {"type":"delta","content":"world","messageId":"ask_1","timestamp":4}\n\n'
              )
            );
            controller.enqueue(
              enc.encode(
                'event: complete\ndata: {"type":"complete","messageId":"ask_1","timestamp":5}\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});

    const result = await session.ask("hi", { messageId: "ask_1" });

    expect(result).toEqual({ text: "Hello world", messageId: "ask_1" });
    // The message was actually sent, tagged with our correlation id.
    expect(messagesBodies).toEqual([{ content: "hi", messageId: "ask_1" }]);
  });

  test("ask() rejects with LobuAgentError on agent-error for the message", async () => {
    const fetchImpl = (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }
      if (request.url.endsWith("/messages")) {
        return json({ success: true, messageId: "ask_1", queued: true });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'event: connected\ndata: {"agentId":"support","timestamp":1}\n\n'
              )
            );
            controller.enqueue(
              enc.encode(
                'event: agent-error\ndata: {"type":"error","error":"boom","messageId":"ask_1","timestamp":2}\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});

    let threw: unknown;
    try {
      await session.ask("hi", { messageId: "ask_1" });
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeInstanceOf(LobuAgentError);
    expect((threw as LobuAgentError).message).toBe("boom");
    expect((threw as LobuAgentError).messageId).toBe("ask_1");
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function requestInfo(
  input: RequestInfo | URL,
  init: RequestInit | undefined
) {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    authorization: request.headers.get("authorization"),
    body: await request.clone().text(),
  };
}

describe("AgentSession.ask HTTP batch correlation", () => {
  test.each([
    "complete",
    "error",
    "agent-error",
  ])("handles a batched %s after retained events from the previous ask", async (terminal) => {
    const encoder = new TextEncoder();
    let backlog = "";
    let turn = 0;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const event = (name: string, data: unknown) =>
      `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/agents"))
          return Response.json({
            agentId: "test-session",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl: `${gateway.url}api/v1/agents/test-session/events`,
            messagesUrl: `${gateway.url}api/v1/agents/test-session/messages`,
          });
        if (path.endsWith("/events"))
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(
                  encoder.encode(
                    event("connected", {
                      agentId: "test-agent",
                      timestamp: Date.now(),
                    }) + backlog
                  )
                );
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
          );
        const body = (await request.json()) as { messageId: string };
        turn += 1;
        const current =
          turn === 1
            ? event("output", {
                messageId: body.messageId,
                content: "first reply",
              }) + event("complete", { messageId: body.messageId })
            : event(terminal, {
                messageId: "batch-leader",
                processedMessageIds: ["batch-leader", body.messageId],
                finalText: "batched final reply",
                error: "batched failure",
              });
        backlog += current;
        stream?.enqueue(encoder.encode(current));
        stream?.close();
        return Response.json({ messageId: body.messageId, queued: true });
      },
    });
    try {
      const lobu = new Lobu({
        baseUrl: gateway.url.toString(),
        token: "test-token",
      });
      const session = await lobu.sessions.create({ agentId: "test-agent" });
      expect((await session.ask("first task")).text).toBe("first reply");
      if (terminal === "complete") {
        expect((await session.ask("new task")).text).toBe(
          "batched final reply"
        );
      } else {
        await expect(session.ask("new task")).rejects.toBeInstanceOf(
          LobuAgentError
        );
        await expect(session.ask("another task")).rejects.toThrow(
          "batched failure"
        );
      }
    } finally {
      await gateway.stop(true);
    }
  });
});
