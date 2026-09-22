import { describe, expect, test } from "bun:test";
import {
  classifyToolError,
  isRetryable,
  isToolError,
  TOOL_ERRORS,
  ToolError,
  type ToolErrorCode,
  toToolErrorCode,
} from "../connector-query-errors";

describe("TOOL_ERRORS catalog", () => {
  test("every code has a spec with a message", () => {
    for (const [code, spec] of Object.entries(TOOL_ERRORS)) {
      expect(typeof spec.retryable).toBe("boolean");
      expect(spec.message.length).toBeGreaterThan(0);
      // isRetryable agrees with the spec
      expect(isRetryable(code as ToolErrorCode)).toBe(spec.retryable);
    }
  });

  test("permanent codes are not retryable", () => {
    for (const code of [
      "AUTH_MISSING",
      "AUTH_INVALID",
      "NOT_FOUND",
      "VALIDATION",
      "PERMISSION",
      "INTERNAL",
    ] as ToolErrorCode[]) {
      expect(isRetryable(code)).toBe(false);
    }
  });

  test("transient codes are retryable", () => {
    for (const code of [
      "RATE_LIMITED",
      "UPSTREAM_TIMEOUT",
      "UPSTREAM_5XX",
      "NETWORK",
      "UPSTREAM_UNAVAILABLE",
    ] as ToolErrorCode[]) {
      expect(isRetryable(code)).toBe(true);
    }
  });
});

describe("toToolErrorCode", () => {
  test("accepts known codes, rejects everything else", () => {
    expect(toToolErrorCode("RATE_LIMITED")).toBe("RATE_LIMITED");
    expect(toToolErrorCode("NOPE")).toBeUndefined();
    expect(toToolErrorCode("constructor")).toBeUndefined();
    expect(toToolErrorCode("toString")).toBeUndefined();
    expect(toToolErrorCode("__proto__")).toBeUndefined();
    expect(toToolErrorCode(429)).toBeUndefined();
    expect(toToolErrorCode(null)).toBeUndefined();
    expect(toToolErrorCode(undefined)).toBeUndefined();
  });
});

describe("ToolError", () => {
  test("derives retryable + default message from the code", () => {
    const e = new ToolError("RATE_LIMITED");
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.retryable).toBe(true);
    expect(e.message).toBe(TOOL_ERRORS.RATE_LIMITED.message);
    expect(e.name).toBe("ToolError");
    expect(isToolError(e)).toBe(true);
    expect(isToolError(new Error("plain"))).toBe(false);
  });

  test("honors a custom message and callId, preserves cause", () => {
    const cause = new Error("root");
    const e = new ToolError("AUTH_MISSING", "connector X needs auth", {
      cause,
      callId: "abc-123",
    });
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("connector X needs auth");
    expect(e.callId).toBe("abc-123");
    expect(e.cause).toBe(cause);
  });

  test("toJSON emits code/retryable/message and call_id only when set", () => {
    expect(new ToolError("NOT_FOUND").toJSON()).toEqual({
      code: "NOT_FOUND",
      retryable: false,
      message: TOOL_ERRORS.NOT_FOUND.message,
    });
    const withId = new ToolError("NETWORK", undefined, {
      callId: "c1",
    }).toJSON();
    expect(withId.call_id).toBe("c1");
  });
});

describe("classifyToolError", () => {
  test("HTTP status precedence", () => {
    expect(classifyToolError({ httpStatus: 429 })).toBe("RATE_LIMITED");
    expect(classifyToolError({ httpStatus: 401 })).toBe("AUTH_INVALID");
    expect(classifyToolError({ httpStatus: 403 })).toBe("AUTH_INVALID");
    expect(classifyToolError({ httpStatus: 404 })).toBe("NOT_FOUND");
    expect(classifyToolError({ httpStatus: 408 })).toBe("UPSTREAM_TIMEOUT");
    expect(classifyToolError({ httpStatus: 504 })).toBe("UPSTREAM_TIMEOUT");
    expect(classifyToolError({ httpStatus: 500 })).toBe("UPSTREAM_5XX");
    expect(classifyToolError({ httpStatus: 502 })).toBe("UPSTREAM_5XX");
    expect(classifyToolError({ httpStatus: 400 })).toBe("VALIDATION");
    expect(classifyToolError({ httpStatus: 422 })).toBe("VALIDATION");
  });

  test("PG SQLSTATE codes", () => {
    expect(classifyToolError({ pgCode: "57014" })).toBe("UPSTREAM_TIMEOUT");
    expect(classifyToolError({ pgCode: "08006" })).toBe("NETWORK");
    expect(classifyToolError({ pgCode: "40001" })).toBe("NETWORK");
    expect(classifyToolError({ pgCode: "40P01" })).toBe("NETWORK");
    expect(classifyToolError({ pgCode: "42601" })).toBe("VALIDATION"); // syntax_error
  });

  test("non-SQLSTATE driver codes fall through to message matching (not VALIDATION)", () => {
    // postgres.js surfaces connection-level failures with a non-SQLSTATE `code`.
    // These must NOT be swallowed by the pgCode branch's VALIDATION catch-all —
    // they should classify from the message as the transient failures they are.
    expect(
      classifyToolError({
        pgCode: "ECONNREFUSED",
        message: "write ECONNREFUSED 127.0.0.1:5432",
      })
    ).toBe("NETWORK");
    expect(
      classifyToolError({
        pgCode: "CONNECTION_CLOSED",
        message: "connection terminated",
      })
    ).toBe("NETWORK");
    // A generic five-letter `Error.code` can have the SQLSTATE shape without
    // coming from PostgreSQL: a broken pipe is transient, not the caller's fault.
    expect(classifyToolError({ pgCode: "EPIPE", message: "write EPIPE" })).toBe(
      "NETWORK"
    );
    expect(
      classifyToolError({ message: "getaddrinfo EAI_AGAIN api.example.com" })
    ).toBe("NETWORK");
    // A non-SQLSTATE code with no transient message hint → INTERNAL, not VALIDATION.
    expect(
      classifyToolError({ pgCode: "SOME_DRIVER_CODE", message: "weird" })
    ).toBe("INTERNAL");
  });

  test("subprocess exit reasons", () => {
    expect(classifyToolError({ exitReason: "timeout" })).toBe(
      "UPSTREAM_TIMEOUT"
    );
    expect(classifyToolError({ exitReason: "oom" })).toBe(
      "UPSTREAM_UNAVAILABLE"
    );
    expect(classifyToolError({ exitReason: "crash" })).toBe(
      "UPSTREAM_UNAVAILABLE"
    );
  });

  test("error_message exit reason falls through to message matching", () => {
    expect(
      classifyToolError({
        exitReason: "error_message",
        message: "429 too many requests",
      })
    ).toBe("RATE_LIMITED");
    expect(
      classifyToolError({ exitReason: "error_message", message: "ECONNRESET" })
    ).toBe("NETWORK");
    // no structured hint and an opaque message → INTERNAL
    expect(
      classifyToolError({
        exitReason: "error_message",
        message: "something odd",
      })
    ).toBe("INTERNAL");
  });

  test("explicit transient flag wins when no status/pgCode", () => {
    expect(classifyToolError({ transient: true })).toBe("NETWORK");
  });

  test("structured fields win over the message string", () => {
    // message says 'timeout' (would keyword-match) but 404 is authoritative → NOT_FOUND
    expect(
      classifyToolError({ httpStatus: 404, message: "timeout while fetching" })
    ).toBe("NOT_FOUND");
  });

  test("message fallback", () => {
    expect(classifyToolError({ message: "rate limit exceeded" })).toBe(
      "RATE_LIMITED"
    );
    expect(classifyToolError({ message: "fetch failed: ENOTFOUND" })).toBe(
      "NETWORK"
    );
    expect(classifyToolError({})).toBe("INTERNAL");
    expect(classifyToolError({ message: "totally unrelated" })).toBe(
      "INTERNAL"
    );
  });
});
