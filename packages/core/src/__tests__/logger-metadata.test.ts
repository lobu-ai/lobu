/**
 * `createLogger`'s console transport is the default (Winston only runs under
 * USE_WINSTON_LOGGER), and it advertises the pino-style
 * `logger.warn({ meta }, "message")` signature alongside `(message, data)`.
 *
 * It accepted that signature and then dropped the metadata: the branch that
 * recognises the leading object took `args[0]` as the message and sliced the
 * object away without ever rendering it. Callers that pass the whole point of
 * the line in that object — `{ err }`, `{ source }`, `{ ignored }` — logged a
 * bare sentence with no cause attached.
 *
 * `packages/connector-sdk/src/logger.ts` is a deliberate standalone copy of
 * this formatter (it must load inside a V8 isolate). Keep metadata handling,
 * level gating and redaction in step; JSON output is a core host feature.
 */

import { describe, expect, test } from "bun:test";
import { createLogger } from "../logger";

function captureWarn(
  run: (log: ReturnType<typeof createLogger>) => void
): string {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    run(createLogger("test-svc"));
  } finally {
    console.warn = original;
  }
  return lines.join("\n");
}

describe("console logger pino-style metadata", () => {
  test("preserves diagnostic stack frames while scrubbing credentials in all fields", () => {
    const err = new Error(
      "fetch https://example.test/path?token=synthetic-query-secret"
    );
    err.stack = `${err.message}\n    at syntheticOperation (worker.js:12:3)`;
    const line = captureWarn((log) => {
      log.warn(
        "failed https://example.test/path?token=synthetic-message-secret",
        {
          err,
          nested: { cookie: "synthetic-cookie-secret" },
        }
      );
    });
    expect(line).toContain("syntheticOperation");
    expect(line).not.toContain("synthetic-query-secret");
    expect(line).not.toContain("synthetic-message-secret");
    expect(line).not.toContain("synthetic-cookie-secret");
  });

  test("renders BOTH the message and the leading metadata object", () => {
    const line = captureWarn((log) => {
      log.warn(
        { run_id: 4917, worker_id: "w-legacy" },
        "falling back to legacy path"
      );
    });

    expect(line).toContain("falling back to legacy path");
    // An operator told that "something" hit the branch, but not which worker,
    // is back at the silent misconfiguration the warn exists to break.
    expect(line).toContain("4917");
    expect(line).toContain("w-legacy");
  });

  test("renders the error cause passed as leading metadata", () => {
    const line = captureWarn((log) => {
      log.warn({ err: new Error("socket hang up") }, "catalog load failed");
    });

    expect(line).toContain("catalog load failed");
    expect(line).toContain("socket hang up");
  });

  test("still redacts sensitive keys inside the metadata object", () => {
    const line = captureWarn((log) => {
      log.warn({ api_key: "sk-live-must-not-appear" }, "credential check");
    });

    expect(line).toContain("credential check");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("sk-live-must-not-appear");
  });

  test("keeps trailing args alongside the metadata object", () => {
    const line = captureWarn((log) => {
      log.warn({ attempt: 3 }, "retrying", { backoff_ms: 250 });
    });

    expect(line).toContain("retrying");
    expect(line).toContain("attempt");
    expect(line).toContain("backoff_ms");
  });

  test("leaves the plain (message, data) form working", () => {
    const line = captureWarn((log) => {
      log.warn("plain message", { detail: "kept" });
    });

    expect(line).toContain("plain message");
    expect(line).toContain("kept");
  });

  test("renders a bare metadata object with no message", () => {
    const line = captureWarn((log) => {
      log.warn({ only: "object" });
    });

    expect(line).toContain("only");
    expect(line).toContain("object");
  });
});

describe("console logger structured output", () => {
  test("honors LOG_FORMAT=json with levels, metadata, and redaction", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { createLogger } from ${JSON.stringify(new URL("../logger.ts", import.meta.url).pathname)};
        const log = createLogger("synthetic-service");
        log.warn({ run_id: 42, authorization: "synthetic-secret", err: new Error("socket closed") }, "catalog failed");
        log.error("query failed", { status: 500 });
        log.info("request completed", { status: 200 });
        log.debug("hidden");`,
      ],
      {
        env: {
          ...process.env,
          USE_WINSTON_LOGGER: "false",
          LOG_FORMAT: "json",
          LOG_LEVEL: "info",
        },
      }
    );
    expect(result.exitCode).toBe(0);
    const output = result.stderr.toString() + result.stdout.toString();
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      level: "warn",
      service: "synthetic-service",
      message: "catalog failed",
      data: {
        run_id: 42,
        authorization: "[REDACTED]",
        err: { name: "Error", message: "socket closed" },
      },
    });
    expect(Number.isNaN(Date.parse(records[0].timestamp))).toBe(false);
    expect(records[1]).toMatchObject({
      level: "error",
      message: "query failed",
      data: { status: 500 },
    });
    expect(records[2]).toMatchObject({
      level: "info",
      message: "request completed",
      data: { status: 200 },
    });
    expect(output).not.toContain("synthetic-secret");
    expect(output).not.toContain("hidden");
  });
});
