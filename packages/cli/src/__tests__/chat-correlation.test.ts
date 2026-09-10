import { afterEach, describe, expect, test } from "bun:test";
import { chatCommand } from "../commands/chat.js";

const stdoutWrite = process.stdout.write;
const stderrWrite = process.stderr.write;
const token = process.env.LOBU_API_TOKEN;
const idle = process.env.LOBU_CHAT_IDLE_TIMEOUT_MS;
afterEach(() => {
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
  process.exitCode = 0;
  if (token === undefined) delete process.env.LOBU_API_TOKEN;
  else process.env.LOBU_API_TOKEN = token;
  if (idle === undefined) delete process.env.LOBU_CHAT_IDLE_TIMEOUT_MS;
  else process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = idle;
});

type Event = { event: string; data: Record<string, unknown> };
const frame = ({ event, data }: Event) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function runChat(
  reply: (id: string) => Event[],
  options: {
    json?: boolean;
    thread?: string;
    new?: boolean;
    continue?: boolean;
    user?: string;
  } = {},
  staleTraffic = false
) {
  process.env.LOBU_API_TOKEN = "synthetic-token";
  process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "150";
  const output = { stdout: "", stderr: "" };
  for (const key of ["stdout", "stderr"] as const) {
    process[key].write = ((chunk: unknown, cb?: unknown) => {
      output[key] += String(chunk);
      if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stdout.write;
  }
  const requests: Record<string, unknown>[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  let subscribed = false;
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Event[] = [];
  const send = (event: Event) => stream.enqueue(encoder.encode(frame(event)));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              subscribed = true;
              send({
                event: "output",
                data: { messageId: "old", content: "OLD ANSWER" },
              });
              send({ event: "complete", data: { messageId: "old" } });
              send({ event: "complete", data: {} });
              for (const event of pending) send(event);
              if (staleTraffic)
                timer = setInterval(() => {
                  try {
                    send({
                      event: "status",
                      data: { messageId: "old", status: "working" },
                    });
                  } catch {
                    clearInterval(timer);
                  }
                }, 10);
            },
            cancel() {
              cancelled = true;
              clearInterval(timer);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      if (path.endsWith("/agents"))
        return Response.json({
          agentId: "synthetic-session",
          token: "synthetic-session-token",
        });
      const id = options.user
        ? "synthetic-platform-message"
        : String(body.messageId);
      pending = reply(id);
      if (subscribed) for (const event of pending) send(event);
      return Response.json({
        success: true,
        messageId: id,
        ...(options.user
          ? { eventsUrl: "/api/v1/agents/synthetic-session/events" }
          : {}),
      });
    },
  });
  try {
    await chatCommand("/tmp", "NEW QUESTION", {
      gateway: `http://127.0.0.1:${server.port}`,
      agent: "synthetic-agent",
      org: "synthetic-org",
      context: "synthetic-context",
      ...options,
    });
    // Let the server observe cancellation of the HTTP response body.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ...output,
      requests,
      subscribed,
      cancelled,
      exitCode: process.exitCode ?? 0,
    };
  } finally {
    clearInterval(timer);
    await server.stop(true);
  }
}

describe("chat request correlation over HTTP", () => {
  for (const options of [
    {},
    { json: true },
    { thread: "synthetic-thread" },
    { new: true },
    { continue: true },
  ]) {
    test(`ignores replay and completes the submitted request ${JSON.stringify(options)}`, async () => {
      const result = await runChat(
        (id) => [
          {
            event: "output",
            data: { messageId: id, content: "CURRENT ANSWER" },
          },
          {
            event: "complete",
            data: { messageId: id, finalText: "CURRENT ANSWER" },
          },
        ],
        options
      );
      expect(result.stdout).not.toContain("OLD ANSWER");
      expect(result.stdout).toContain("CURRENT ANSWER");
      expect(result.requests[1]?.messageId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.exitCode).toBe(0);
      expect(result.cancelled).toBe(true);
    });
  }
  test("batch membership accepts the terminal answer and rejects unrelated batches", async () => {
    const result = await runChat((id) => [
      {
        event: "complete",
        data: {
          messageId: "other",
          processedMessageIds: ["unrelated"],
          finalText: "WRONG BATCH",
        },
      },
      {
        event: "complete",
        data: {
          messageId: "batch-owner",
          processedMessageIds: ["batch-owner", id],
          finalText: "BATCH ANSWER",
        },
      },
    ]);
    expect(result.stdout).toBe("BATCH ANSWER\n");
    expect(result.exitCode).toBe(0);
  });
  test("cards match their originating request rather than their delivery ID", async () => {
    const result = await runChat(
      (id) => [
        {
          event: "tool-approval",
          data: {
            messageId: "old-card",
            turnMessageId: "old",
            requestId: "old-approval",
          },
        },
        {
          event: "tool-approval",
          data: {
            messageId: "new-card",
            turnMessageId: id,
            requestId: "current-approval",
          },
        },
        { event: "complete", data: { messageId: id } },
      ],
      { json: true }
    );
    expect(result.stdout).toContain("current-approval");
    expect(result.stdout).not.toContain("old-approval");
    expect(result.exitCode).toBe(0);
  });
  for (const json of [false, true]) {
    for (const terminal of ["error", "ephemeral"]) {
      test(`${terminal} terminates in ${json ? "JSON" : "normal"} mode`, async () => {
        const result = await runChat(
          (id) => [
            {
              event: terminal,
              data: {
                messageId: id,
                error: "synthetic failure",
                content: "sign in",
              },
            },
          ],
          { json }
        );
        expect(result.exitCode).toBe(terminal === "error" ? 1 : 0);
        expect(result.stderr).not.toContain("timed out");
        expect(result.cancelled).toBe(true);
      });
    }
  }
  test("stale activity cannot renew the idle budget", async () => {
    const result = await runChat(() => [], {}, true);
    expect(result.stderr).toContain("timed out");
    expect(result.exitCode).toBe(1);
  });
  test("platform replies use the returned request ID", async () => {
    const result = await runChat(
      (id) => [
        {
          event: "complete",
          data: { messageId: id, finalText: "PLATFORM ANSWER" },
        },
      ],
      { user: "slack:synthetic-channel" }
    );
    expect(result.stdout).toBe("PLATFORM ANSWER\n");
    expect(result.exitCode).toBe(0);
  });
});

test("batched ephemeral terminates only its member request", async () => {
  const result = await runChat(
    (id) => [
      {
        event: "ephemeral",
        data: {
          messageId: "other",
          processedMessageIds: ["unrelated"],
          content: "OLD NOTICE",
        },
      },
      {
        event: "ephemeral",
        data: {
          messageId: "batch-owner",
          processedMessageIds: [id],
          content: "CURRENT NOTICE",
        },
      },
    ],
    { json: true }
  );
  expect(result.stdout).toContain("CURRENT NOTICE");
  expect(result.stdout).not.toContain("OLD NOTICE");
  expect(result.exitCode).toBe(0);
});
