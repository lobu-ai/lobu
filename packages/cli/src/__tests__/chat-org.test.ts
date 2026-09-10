/**
 * Unit tests for `lobu chat --org` resolution and header threading.
 *
 * Covers:
 *  - `resolveChatOrg` precedence: explicit --org > LOBU_ORG env > context activeOrg.
 *  - The resolved org rides every Agent API call as the `x-lobu-org` header
 *    (POST /agents session create, POST /messages, GET /events SSE), and is
 *    absent when no org is configured (preserving the pre-flag semantics).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { chatCommand, resolveChatOrg } from "../commands/chat.js";
import * as context from "../internal/context.js";

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalToken = process.env.LOBU_API_TOKEN;
const originalOrg = process.env.LOBU_ORG;

function silenceTerminal(): void {
  // `writeStdout`/`writeStderr` in chat.ts wrap process.*.write in a Promise
  // that only resolves when the write callback fires — a stub that ignores the
  // callback would hang the stream loop. Invoke it like the real stream does.
  const sink = ((_chunk: string | Uint8Array, cb?: unknown) => {
    if (typeof cb === "function") (cb as (error?: Error | null) => void)(null);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
}

let sentMessageId = "synthetic-platform-message";

function createSseResponse(
  events: Array<{ event: string; data: Record<string, unknown> }>
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        // Subscription starts first; delivery follows the POST in this fixture.
        await Promise.resolve();
        const payload = events
          .map(
            ({ event, data }) =>
              `event: ${event}\ndata: ${JSON.stringify({ messageId: sentMessageId, turnMessageId: sentMessageId, ...data })}\n\n`
          )
          .join("");
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalToken === undefined) delete process.env.LOBU_API_TOKEN;
  else process.env.LOBU_API_TOKEN = originalToken;
  if (originalOrg === undefined) delete process.env.LOBU_ORG;
  else process.env.LOBU_ORG = originalOrg;
  sentMessageId = "synthetic-platform-message";
  process.exitCode = 0;
  mock.restore();
});

describe("resolveChatOrg — precedence", () => {
  beforeEach(() => {
    delete process.env.LOBU_ORG;
  });

  test("explicit --org wins over the context activeOrg", async () => {
    const spy = spyOn(context, "getActiveOrg").mockResolvedValue("ctx-org");
    const resolved = await resolveChatOrg({ org: "scratch", context: "prod" });
    expect(resolved).toBe("scratch");
    // Explicit flag short-circuits the context lookup entirely.
    expect(spy).not.toHaveBeenCalled();
  });

  test("blank --org falls through to the context activeOrg", async () => {
    spyOn(context, "getActiveOrg").mockResolvedValue("ctx-org");
    const resolved = await resolveChatOrg({ org: "   ", context: "prod" });
    expect(resolved).toBe("ctx-org");
  });

  test("no --org → falls back to context activeOrg (env folded in by getActiveOrg)", async () => {
    spyOn(context, "getActiveOrg").mockResolvedValue("ctx-org");
    const resolved = await resolveChatOrg({ context: "prod" });
    expect(resolved).toBe("ctx-org");
  });

  test("no --org and no active org → undefined (server falls back to default)", async () => {
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);
    const resolved = await resolveChatOrg({});
    expect(resolved).toBeUndefined();
  });
});

describe("chatCommand — x-lobu-org header threading", () => {
  test("--org rides every Agent API request as x-lobu-org", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    delete process.env.LOBU_ORG;
    silenceTerminal();
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    const headerSeen: Record<string, string | null> = {};

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const orgHeader =
          (init?.headers as Record<string, string> | undefined)?.[
            "x-lobu-org"
          ] ?? null;

        if (
          url === "http://gateway.test/lobu/api/v1/agents" &&
          init?.method === "POST"
        ) {
          headerSeen.create = orgHeader;
          return Response.json({
            agentId: "session-1",
            token: "session-token",
          });
        }
        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/events" &&
          !init?.method
        ) {
          headerSeen.events = orgHeader;
          return createSseResponse([
            { event: "output", data: { content: "hi\n" } },
            { event: "complete", data: {} },
          ]);
        }
        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/messages" &&
          init?.method === "POST"
        ) {
          headerSeen.messages = orgHeader;
          sentMessageId = JSON.parse(String(init?.body)).messageId;
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand("/tmp/does-not-matter", "hello", {
      gateway: "http://gateway.test",
      agent: "vc-tracking",
      org: "scratch",
      new: true,
    });

    expect(headerSeen.create).toBe("scratch");
    expect(headerSeen.messages).toBe("scratch");
    expect(headerSeen.events).toBe("scratch");
  });

  test("no org configured → x-lobu-org header is omitted", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    delete process.env.LOBU_ORG;
    silenceTerminal();
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    let createHadOrgHeader = true;

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (
          url === "http://gateway.test/lobu/api/v1/agents" &&
          init?.method === "POST"
        ) {
          createHadOrgHeader = Object.keys(
            (init?.headers as Record<string, string>) ?? {}
          ).includes("x-lobu-org");
          return Response.json({
            agentId: "session-1",
            token: "session-token",
          });
        }
        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/events" &&
          !init?.method
        ) {
          return createSseResponse([{ event: "complete", data: {} }]);
        }
        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/messages" &&
          init?.method === "POST"
        ) {
          sentMessageId = JSON.parse(String(init?.body)).messageId;
          return Response.json({ success: true });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand("/tmp/does-not-matter", "hello", {
      gateway: "http://gateway.test",
      agent: "vc-tracking",
      new: true,
    });

    expect(createHadOrgHeader).toBe(false);
  });
});
