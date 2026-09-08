import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

const createInterfaceMock = mock(() => ({
  question: (_prompt: string, callback: (answer: string) => void) =>
    callback("1"),
  close: () => undefined,
}));

mock.module("node:readline", () => ({
  createInterface: createInterfaceMock,
}));

let chatCommand: typeof import("../commands/chat").chatCommand;

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleError = console.error;
const originalToken = process.env.LOBU_API_TOKEN;
const exampleDir = join(import.meta.dir, "../../../../examples/market");

function createSseResponse(
  events: Array<{ event: string; data: Record<string, unknown> }>
): Response {
  const encoder = new TextEncoder();
  const payload = events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    )
    .join("");

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

function captureTerminal(output: { stdout: string[]; stderr: string[] }): void {
  process.stdout.write = ((chunk: string | Uint8Array, cb?: unknown) => {
    output.stdout.push(String(chunk));
    if (typeof cb === "function") {
      (cb as (error?: Error | null) => void)(null);
    }
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, cb?: unknown) => {
    output.stderr.push(String(chunk));
    if (typeof cb === "function") {
      (cb as (error?: Error | null) => void)(null);
    }
    return true;
  }) as typeof process.stderr.write;

  console.error = (...args: unknown[]) => {
    output.stderr.push(args.map((arg) => String(arg)).join(" "));
  };
}

beforeAll(async () => {
  ({ chatCommand } = await import("../commands/chat"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.error = originalConsoleError;
  if (originalToken === undefined) {
    delete process.env.LOBU_API_TOKEN;
  } else {
    process.env.LOBU_API_TOKEN = originalToken;
  }
  mock.restore();
});

describe("chatCommand example integration", () => {
  test("uses the hr example agent and completes approval plus login interaction flow", async () => {
    process.env.LOBU_API_TOKEN = "test-token";

    const stdout: string[] = [];
    const stderr: string[] = [];
    const createBodies: Array<Record<string, unknown>> = [];
    const approvalBodies: Array<Record<string, unknown>> = [];

    captureTerminal({ stdout, stderr });

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (
          url === "http://gateway.test/lobu/api/v1/agents" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          createBodies.push(body);
          return Response.json({
            agentId: "session-1",
            token: "session-token",
          });
        }

        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/events" &&
          !init?.method
        ) {
          return createSseResponse([
            {
              event: "output",
              data: { content: "Starting request.\n" },
            },
            {
              event: "tool-approval",
              data: {
                requestId: "approval-1",
                mcpId: "github",
                toolName: "delete_issue",
                args: { issue_number: 42 },
              },
            },
            {
              event: "link-button",
              data: {
                label: "Connect GitHub",
                url: "https://auth.example.com/device",
              },
            },
            {
              event: "question",
              data: {
                question: "Pick one",
                options: ["A", "B"],
              },
            },
            {
              event: "suggestion",
              data: {
                prompts: ["retry", "show me the details"],
              },
            },
            {
              event: "complete",
              data: {},
            },
          ]);
        }

        if (
          url === "http://gateway.test/lobu/api/v1/agents/session-1/messages" &&
          init?.method === "POST"
        ) {
          return Response.json({ success: true });
        }

        if (
          url === "http://gateway.test/lobu/api/v1/agents/approve" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          approvalBodies.push(body);
          return Response.json({
            result: {
              content: [{ text: "Approved tool result." }],
            },
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand(exampleDir, "please run the workflow", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(createBodies).toEqual([
      {
        agentId: "vc-tracking",
        forceNew: true,
      },
    ]);
    expect(approvalBodies).toEqual([
      {
        requestId: "approval-1",
        decision: "1h",
      },
    ]);

    const stdoutText = stdout.join("");
    const stderrText = stderr.join("");

    expect(stdoutText).toContain("Starting request.");
    expect(stdoutText).toContain("Approved tool result.");
    expect(stderrText).toContain("Tool Approval Required");
    expect(stderrText).toContain("github");
    expect(stderrText).toContain('"event":"link-button"');
    expect(stderrText).toContain("Connect GitHub");
    expect(stderrText).toContain('"event":"question"');
    expect(stderrText).toContain('"event":"suggestion"');
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
  });

  test("prints structured file-uploaded events in platform mode", async () => {
    process.env.LOBU_API_TOKEN = "test-token";

    const stdout: string[] = [];
    const stderr: string[] = [];

    captureTerminal({ stdout, stderr });

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/messages" &&
          init?.method === "POST"
        ) {
          return Response.json({
            success: true,
            eventsUrl: "/api/v1/agents/vc-tracking/events?platform=telegram",
          });
        }

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/events?platform=telegram" &&
          !init?.method
        ) {
          return createSseResponse([
            {
              event: "file-uploaded",
              data: {
                tool: "upload_file",
                platform: "telegram",
                fileId: "file-123",
                name: "e2e.txt",
                permalink: "https://files.example/e2e.txt",
                size: 8,
              },
            },
            {
              event: "output",
              data: {
                content: "Uploaded e2e.txt successfully.\n",
              },
            },
            { event: "complete", data: {} },
          ]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand(exampleDir, "send me e2e.txt as a file", {
      gateway: "http://gateway.test",
      user: "telegram:chat-123",
    });

    expect(stdout.join("")).toContain("Uploaded e2e.txt successfully");
    expect(stderr.join("")).toContain('"event":"file-uploaded"');
    expect(stderr.join("")).toContain('"name":"e2e.txt"');
    expect(stderr.join("")).toContain('"tool":"upload_file"');
  });

  test("warns when a sandbox link is streamed without a file-uploaded event", async () => {
    process.env.LOBU_API_TOKEN = "test-token";

    const stdout: string[] = [];
    const stderr: string[] = [];

    captureTerminal({ stdout, stderr });

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/messages" &&
          init?.method === "POST"
        ) {
          return Response.json({
            success: true,
            eventsUrl: "/api/v1/agents/vc-tracking/events?platform=telegram",
          });
        }

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/events?platform=telegram" &&
          !init?.method
        ) {
          return createSseResponse([
            {
              event: "output",
              data: {
                content:
                  "[Download cli-proof.txt](sandbox:/workspace/cli-proof.txt)",
              },
            },
            { event: "complete", data: {} },
          ]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand(exampleDir, "send me cli-proof.txt as a file", {
      gateway: "http://gateway.test",
      user: "telegram:chat-123",
    });

    expect(stdout.join("")).toContain("cli-proof.txt");
    expect(stderr.join("")).toContain("no file-uploaded event was emitted");
  });

  test("streams raw output chunks without corrupting fragmented markdown", async () => {
    process.env.LOBU_API_TOKEN = "test-token";

    const stdout: string[] = [];
    const stderr: string[] = [];

    captureTerminal({ stdout, stderr });

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/messages" &&
          init?.method === "POST"
        ) {
          return Response.json({
            success: true,
            eventsUrl: "/api/v1/agents/vc-tracking/events?platform=telegram",
          });
        }

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/events?platform=telegram" &&
          !init?.method
        ) {
          return createSseResponse([
            { event: "output", data: { content: "**Hello" } },
            { event: "output", data: { content: " world**" } },
            { event: "complete", data: {} },
          ]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand(exampleDir, "say hello", {
      gateway: "http://gateway.test",
      user: "telegram:chat-123",
    });

    expect(stdout.join("")).toContain("**Hello world**");
    expect(stderr.join("")).not.toContain("file-uploaded");
  });

  test("streams platform-mode output for image and voice requests from the example agent", async () => {
    process.env.LOBU_API_TOKEN = "test-token";

    const stdout: string[] = [];
    const stderr: string[] = [];
    const messageBodies: Array<Record<string, unknown>> = [];

    captureTerminal({ stdout, stderr });

    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/messages" &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          messageBodies.push(body);
          return Response.json({
            success: true,
            eventsUrl: "/api/v1/agents/vc-tracking/events?platform=telegram",
          });
        }

        if (
          url ===
            "http://gateway.test/lobu/api/v1/agents/vc-tracking/events?platform=telegram" &&
          !init?.method
        ) {
          return createSseResponse([
            {
              event: "output",
              data: {
                content:
                  "Image sent successfully (generated with openai).\nVoice message sent successfully (generated with openai).\n",
              },
            },
            { event: "complete", data: {} },
          ]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      }
    ) as unknown as typeof fetch;

    await chatCommand(exampleDir, "send an image and a voice reply", {
      gateway: "http://gateway.test",
      user: "telegram:chat-123",
    });

    expect(messageBodies).toEqual([
      {
        platform: "telegram",
        content: "send an image and a voice reply",
        telegram: { chatId: "chat-123" },
      },
    ]);

    expect(stdout.join("")).toContain("Image sent successfully");
    expect(stdout.join("")).toContain("Voice message sent successfully");
    expect(stderr.join("")).not.toContain("Failed");
  });
});
