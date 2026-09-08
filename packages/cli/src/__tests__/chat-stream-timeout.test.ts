import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { chatCommand } from "../commands/chat.js";

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleError = console.error;
const originalToken = process.env.LOBU_API_TOKEN;
const originalIdle = process.env.LOBU_CHAT_IDLE_TIMEOUT_MS;
const exampleDir = join(import.meta.dir, "../../../../examples/market");

function captureTerminal(
  output: { stdout: string[]; stderr: string[] },
  stdoutWriteDelayMs = 0
): void {
  process.stdout.write = ((chunk: string | Uint8Array, cb?: unknown) => {
    output.stdout.push(String(chunk));
    if (typeof cb === "function") {
      const finish = () => (cb as (e?: Error | null) => void)(null);
      if (stdoutWriteDelayMs > 0) setTimeout(finish, stdoutWriteDelayMs);
      else finish();
    }
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, cb?: unknown) => {
    output.stderr.push(String(chunk));
    if (typeof cb === "function") (cb as (e?: Error | null) => void)(null);
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    output.stderr.push(args.map((a) => String(a)).join(" "));
  };
}

/**
 * Mirrors what a real `fetch` does: aborting the signal errors the body
 * stream, so `reader.read()` rejects with an AbortError. A hand-rolled
 * ReadableStream that ignores the signal would hang instead of exercising
 * the timeout path at all.
 */
function sseResponse(
  chunks: string[],
  signal: AbortSignal | null | undefined,
  { close }: { close: boolean }
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (close) {
          controller.close();
          return;
        }
        signal?.addEventListener("abort", () => {
          try {
            controller.error(
              new DOMException("The operation was aborted.", "AbortError")
            );
          } catch {
            // already closed
          }
        });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function installFetch(sseFor: (signal?: AbortSignal | null) => Response): void {
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agents") && init?.method === "POST") {
        return Response.json({ agentId: "session-1", token: "session-token" });
      }
      if (url.endsWith("/session-1/events") && !init?.method) {
        return sseFor(init?.signal);
      }
      if (url.endsWith("/session-1/messages") && init?.method === "POST") {
        return Response.json({ success: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.error = originalConsoleError;
  process.exitCode = 0;
  if (originalToken === undefined) delete process.env.LOBU_API_TOKEN;
  else process.env.LOBU_API_TOKEN = originalToken;
  if (originalIdle === undefined) delete process.env.LOBU_CHAT_IDLE_TIMEOUT_MS;
  else process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = originalIdle;
  mock.restore();
});

describe("chat stream idle timeout", () => {
  test("a stalled stream exits non-zero and says so", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "150";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr });

    // Streams one chunk, then goes silent forever — no `complete`, no ping.
    installFetch((signal) =>
      sseResponse([sse("output", { content: "thinking..." })], signal, {
        close: false,
      })
    );

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(stderr.join("")).toContain("timed out");
    expect(stderr.join("")).toContain("for 150ms");
    expect(process.exitCode).toBe(1);
  });

  test("a stream that closes without a terminal event exits non-zero", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "5000";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr });

    installFetch((signal) =>
      sseResponse([sse("output", { content: "partial" })], signal, {
        close: true,
      })
    );

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(stderr.join("")).toContain("closed before the agent finished");
    expect(process.exitCode).toBe(1);
  });

  test("a stream that completes normally exits zero", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "5000";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr });

    installFetch((signal) =>
      sseResponse(
        [sse("output", { content: "done thinking" }), sse("complete", {})],
        signal,
        { close: true }
      )
    );

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(stderr.join("")).not.toContain("timed out");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("slow output rendering does not count as stream silence", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "100";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr }, 150);

    installFetch((signal) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(sse("output", { content: "rendering..." }))
            );
            setTimeout(
              () => controller.enqueue(encoder.encode(sse("complete", {}))),
              10
            );
            signal?.addEventListener("abort", () => {
              controller.error(
                new DOMException("The operation was aborted.", "AbortError")
              );
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(stderr.join("")).not.toContain("timed out");
    expect(process.exitCode ?? 0).toBe(0);
  });
  test("heartbeat pings alone do not hold the stream open forever", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "200";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr });

    // Exactly what a run that died server-side looks like from here: the
    // gateway keeps heartbeating the open connection (its interval is not
    // conditioned on run state) but the agent never says anything again.
    // A deadline reset by any traffic would wait forever.
    const timers: ReturnType<typeof setInterval>[] = [];
    installFetch((signal) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(sse("output", { content: "working" }))
            );
            const beat = setInterval(() => {
              try {
                controller.enqueue(
                  encoder.encode(sse("ping", { timestamp: Date.now() }))
                );
              } catch {
                clearInterval(beat);
              }
            }, 20);
            timers.push(beat);
            signal?.addEventListener("abort", () => {
              clearInterval(beat);
              try {
                controller.error(
                  new DOMException("The operation was aborted.", "AbortError")
                );
              } catch {
                // already closed
              }
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });
    for (const t of timers) clearInterval(t);

    expect(stderr.join("")).toContain("timed out");
    expect(process.exitCode).toBe(1);
  });
  test("a leftover turn's output does not hold this turn open", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "200";

    const stdout: string[] = [];
    const stderr: string[] = [];
    captureTerminal({ stdout, stderr });

    // The agent stream is per-agent, not per-turn: a run started by an
    // earlier `lobu chat` can still be talking on it. Those events are
    // filtered out of the render, so they must not count as our agent
    // being alive either — otherwise this turn hangs on someone else's.
    const timers: ReturnType<typeof setInterval>[] = [];
    installFetch((signal) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const beat = setInterval(() => {
              try {
                controller.enqueue(
                  encoder.encode(
                    sse("output", {
                      content: "previous turn still going",
                      messageId: "a-different-turn",
                    })
                  )
                );
              } catch {
                clearInterval(beat);
              }
            }, 20);
            timers.push(beat);
            signal?.addEventListener("abort", () => {
              clearInterval(beat);
              try {
                controller.error(
                  new DOMException("The operation was aborted.", "AbortError")
                );
              } catch {
                // already closed
              }
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });
    for (const t of timers) clearInterval(t);

    expect(stdout.join("")).not.toContain("previous turn still going");
    expect(stderr.join("")).toContain("timed out");
    expect(process.exitCode).toBe(1);
  });

  test("slow rendering is not charged against the silence budget", async () => {
    process.env.LOBU_API_TOKEN = "test-token";
    process.env.LOBU_CHAT_IDLE_TIMEOUT_MS = "100";

    const stdout: string[] = [];
    const stderr: string[] = [];
    // stdout takes 150ms to drain — longer than the whole budget.
    captureTerminal({ stdout, stderr }, 150);

    // `complete` lands 50ms after rendering finishes: well inside the budget
    // as measured in NETWORK silence, but far outside it if the 150ms spent
    // writing to the terminal is charged too.
    installFetch((signal) => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(sse("output", { content: "slow to render" }))
            );
            setTimeout(() => {
              try {
                controller.enqueue(encoder.encode(sse("complete", {})));
              } catch {
                // already closed
              }
            }, 200);
            signal?.addEventListener("abort", () => {
              try {
                controller.error(
                  new DOMException("The operation was aborted.", "AbortError")
                );
              } catch {
                // already closed
              }
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });

    await chatCommand(exampleDir, "run it", {
      gateway: "http://gateway.test",
      new: true,
    });

    expect(stderr.join("")).not.toContain("timed out");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
