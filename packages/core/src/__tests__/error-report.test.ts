/**
 * Issue grouping and the redaction it relies on. Two failures of one defect
 * must share a fingerprint whatever ids, users or line numbers they carry, and
 * nothing recorded may keep a credential, an address or a machine path.
 */

import { describe, expect, test } from "bun:test";
import {
  annotateErrorLogRecord,
  classifyErrorKind,
  describeError,
  errorReportLogFields,
  parameterizeMessage,
  parseStackFrames,
} from "../error-report";

function stack(message: string, frames: string[]): string {
  return [message, ...frames.map((frame) => `    at ${frame}`)].join("\n");
}

describe("parameterizeMessage", () => {
  test("replaces every per-occurrence value with a placeholder", () => {
    expect(
      parameterizeMessage(
        "row 42 of 1000 at 2026-11-04T10:00:00Z from 10.0.0.1:5432 id 3f2a9b1c-1d2e-4f5a-8b9c-0d1e2f3a4b5c"
      )
    ).toBe("row <num> of <num> at <date> from <ip> id <uuid>");
    expect(
      parameterizeMessage(
        'entity "Synthetic Corp" missing; sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 at 0x7ffe'
      )
    ).toBe("entity <quoted> missing; sha <hash> at <hex>");
    expect(parameterizeMessage("run run9f3a1c2e7b4d timed out")).toBe(
      "run <id> timed out"
    );
  });

  test("keeps ordinary words so the message stays readable", () => {
    expect(parameterizeMessage("Connection terminated unexpectedly")).toBe(
      "Connection terminated unexpectedly"
    );
  });

  test("never keeps a credential, address or token", () => {
    const secrets = [
      "Authorization: Bearer synthetic-bearer-value failed",
      "api_key=synthetic-key-value rejected",
      "fetch https://example.test/x?token=synthetic-query failed for someone@example.test",
      "token ghp_syntheticsyntheticsyntheticsynth leaked",
    ];
    const out = secrets.map(parameterizeMessage).join("\n");
    expect(out).not.toMatch(
      /synthetic-bearer|synthetic-key|synthetic-query|someone@|ghp_synthetic/
    );
  });

  test("bounds the output to two lines and 300 characters", () => {
    expect(parameterizeMessage("first\nsecond\nthird")).toBe("first second");
    expect(parameterizeMessage("word ".repeat(200)).length).toBe(300);
  });
});

describe("parseStackFrames", () => {
  test("parses bundle, dependency and runtime frames without machine paths", () => {
    const frames = parseStackFrames(
      stack("Error: boom", [
        "async handleTool [as run] (file:///app/packages/server/dist/server-main.bundle.mjs:1234:56)",
        "dispatch (/home/someone/checkout/node_modules/hono/dist/compose.js:22:23)",
        "process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
        "/home/someone/scratch/script.js:3:9",
        "native",
      ])
    );
    expect(frames).toEqual([
      {
        function: "handleTool",
        file: "packages/server/dist/server-main.bundle.mjs",
        line: 1234,
        column: 56,
        inApp: true,
      },
      {
        function: "dispatch",
        file: "node_modules/hono/dist/compose.js",
        line: 22,
        column: 23,
        inApp: false,
      },
      {
        function: "process.processTicksAndRejections",
        file: "node:internal/process/task_queues",
        line: 105,
        column: 5,
        inApp: false,
      },
      {
        function: null,
        file: "script.js",
        line: 3,
        column: 9,
        inApp: true,
      },
      {
        function: null,
        file: "native",
        line: null,
        column: null,
        inApp: false,
      },
    ]);
  });
  test("skips oversized lines and bounds hostile message text in a stack", () => {
    const hostile = `at ${"a (a".repeat(1024)}`;
    expect(
      parseStackFrames(
        `Error: upstream said:\n${hostile}\n    at handleTool (/app/packages/server/src/tool.ts:1:2)`
      ).map((frame) => frame.function)
    ).toEqual(["handleTool"]);

    // Quadratic before the input was bounded: 256 KB took seconds.
    const started = performance.now();
    expect(
      parseStackFrames(`Error: upstream said:\nat ${"a (a".repeat(65536)}`)
    ).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("describeError grouping", () => {
  const bundle = "/app/packages/server/dist/server-main.bundle.mjs";

  test("a stack groups by in-app function names, not line numbers or message", () => {
    const first = describeError(
      {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'id')",
        stack: stack("TypeError: x", [
          `new ToolUserError (${bundle}:10:1)`,
          `resolveEntity (${bundle}:500:7)`,
          `handleTool (${bundle}:900:3)`,
          `dispatch (/app/node_modules/hono/dist/compose.js:22:23)`,
        ]),
      },
      { scope: "tool manage_entity" }
    );
    const moved = describeError(
      {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'name')",
        stack: stack("TypeError: x", [
          `new ToolUserError (${bundle}:12:1)`,
          `resolveEntity (${bundle}:611:7)`,
          `handleTool (${bundle}:950:3)`,
        ]),
      },
      { scope: "a different boundary" }
    );
    expect(first.grouping).toBe(
      "v1|TypeError||frames:resolveEntity>handleTool"
    );
    expect(moved.fingerprint).toBe(first.fingerprint);

    const otherCaller = describeError(
      {
        name: "TypeError",
        message: "x",
        stack: stack("TypeError: x", [
          `resolveEntity (${bundle}:500:7)`,
          `importRows (${bundle}:1200:3)`,
        ]),
      },
      { scope: "tool manage_entity" }
    );
    expect(otherCaller.fingerprint).not.toBe(first.fingerprint);
  });

  test("without a stack, scope and parameterized message group the failure", () => {
    const one = describeError(
      { name: "ToolResultError", message: "Entity 4817 not found" },
      { scope: "tool manage_entity" }
    );
    const two = describeError(
      { name: "ToolResultError", message: "Entity 9 not found" },
      { scope: "tool manage_entity" }
    );
    const elsewhere = describeError(
      { name: "ToolResultError", message: "Entity 9 not found" },
      { scope: "tool resolve_path" }
    );
    expect(one.message).toBe("Entity <num> not found");
    expect(two.fingerprint).toBe(one.fingerprint);
    expect(elsewhere.fingerprint).not.toBe(one.fingerprint);
    expect(one.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  test("the error code is part of the identity, including SQLSTATE codes", () => {
    const unique = describeError(
      { name: "PostgresError", message: "duplicate key", code: "23505" },
      { scope: "q" }
    );
    const fk = describeError(
      { name: "PostgresError", message: "duplicate key", code: "23503" },
      { scope: "q" }
    );
    expect(unique.code).toBe("23505");
    expect(fk.fingerprint).not.toBe(unique.fingerprint);
    for (const [code, kept] of [
      ["connector_setup_required", true],
      ["ERR_INVALID_ARG_TYPE", true],
      ["not a code", false],
      ["abc123def456", false],
      ["4/0AfJohXsynthetic", false],
    ] as const) {
      expect(
        describeError({ name: "Error", message: "m", code }, { scope: "q" })
          .code
      ).toBe(kept ? code : null);
    }
  });

  test("names the type of thrown strings, pino-serialized errors and unknown values", () => {
    expect(describeError("boom", { scope: "s" }).type).toBe("Message");
    expect(
      describeError(
        { type: "RangeError", message: "m", stack: "" },
        { scope: "s" }
      ).type
    ).toBe("RangeError");
    expect(describeError(new SyntaxError("m"), { scope: "s" }).type).toBe(
      "SyntaxError"
    );
    expect(describeError(null, { scope: "s" }).type).toBe("UnknownError");
  });

  test("the recorded stacktrace holds frame locations only, never the message", () => {
    const report = describeError(
      {
        name: "Error",
        message: "password=synthetic-secret-value",
        stack: stack("Error: password=synthetic-secret-value", [
          `handleTool (${bundle}:900:3)`,
        ]),
      },
      { scope: "s" }
    );
    expect(report.stacktrace).toBe(
      "at handleTool (packages/server/dist/server-main.bundle.mjs:900:3)"
    );
    expect(JSON.stringify(report)).not.toContain("synthetic-secret-value");
  });
});

describe("classifyErrorKind", () => {
  test("derives the kind from a code or status, defaulting to system", () => {
    expect(classifyErrorKind("VALIDATION", null)).toBe("user");
    expect(classifyErrorKind("RATE_LIMITED", 500)).toBe("dependency");
    expect(classifyErrorKind("PROVIDER_QUOTA", null)).toBe("dependency");
    expect(classifyErrorKind("23505", 404)).toBe("user");
    expect(classifyErrorKind(null, 503)).toBe("system");
    expect(classifyErrorKind(null, null)).toBe("system");
  });

  test("a boundary that knows better overrides the derived kind", () => {
    expect(
      describeError({ name: "E", message: "m" }, { scope: "s", kind: "user" })
        .kind
    ).toBe("user");
    expect(
      describeError(
        { name: "E", message: "m", httpStatus: 403 },
        { scope: "s" }
      ).kind
    ).toBe("user");
  });
});

describe("annotateErrorLogRecord", () => {
  test("leaves non-error levels untouched", () => {
    const record: Record<string, unknown> = {
      level: "warn",
      service: "svc",
      message: "slow",
    };
    annotateErrorLogRecord(record);
    expect(record.error_fingerprint).toBeUndefined();
  });

  test("groups a logged error by its stack, wherever it is nested", () => {
    const err = {
      type: "TypeError",
      message: "x",
      stack: stack("TypeError: x", [
        "resolveEntity (/app/packages/server/dist/server-main.bundle.mjs:500:7)",
      ]),
      code: "UPSTREAM_TIMEOUT",
    };
    const record: Record<string, unknown> = {
      level: "error",
      service: "svc",
      msg: "failed",
      data: [{ op: "x" }, { err }],
    };
    annotateErrorLogRecord(record);
    expect(record).toMatchObject({
      error_fingerprint: describeError(err, { scope: "ignored" }).fingerprint,
      error_type: "TypeError",
      error_kind: "dependency",
      error_code: "UPSTREAM_TIMEOUT",
    });
  });

  test("an error line without an error object groups by its message", () => {
    const first: Record<string, unknown> = {
      level: "fatal",
      service: "svc",
      message: "queue 7 stalled for run9f3a1c2e7b4d",
    };
    const second: Record<string, unknown> = {
      level: "fatal",
      service: "svc",
      message: "queue 12 stalled for run0b8e6d5c4a3f",
    };
    annotateErrorLogRecord(first);
    annotateErrorLogRecord(second);
    expect(first.error_type).toBe("LoggedError");
    expect(first.error_message).toBe("queue <num> stalled for <id>");
    expect(first.error_grouping).toBe(
      "v1|log svc|LoggedError||message:queue <num> stalled for <id>"
    );
    expect(first.error_fingerprint).toBe(second.error_fingerprint);
  });

  test("a writer that described its error keeps the span's grouping", () => {
    // A value-free wrapper line ("Tool call failed") would otherwise group
    // every failure behind it as one generic issue.
    const report = describeError(
      {
        name: "ToolUserError",
        message: "upstream timed out",
        code: "UPSTREAM_TIMEOUT",
      },
      { scope: "tool resolve_path" }
    );
    const record: Record<string, unknown> = {
      level: "error",
      service: "svc",
      msg: "Tool call failed",
      ...errorReportLogFields(report),
    };
    annotateErrorLogRecord(record);
    expect(record).toMatchObject({
      error_fingerprint: report.fingerprint,
      error_type: "ToolUserError",
      error_grouping: report.grouping,
      error_code: "UPSTREAM_TIMEOUT",
    });
    expect(report.grouping).toContain("tool resolve_path");
  });
});
