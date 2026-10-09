import { describe, expect, it } from "bun:test";
import {
  scrubSentryErrorEvent,
  scrubSentryValue,
} from "../utils/sentry-scrubber";

const SECRET = "SENTRY_SECRET_SENTINEL";

describe("Sentry credential scrubber", () => {
  it("preserves aggregate children and their causes with the same redaction and cycle bounds", () => {
    const child = Object.assign(
      new Error(`connection failed token=${SECRET}`),
      {
        code: "ECONNREFUSED",
        password: SECRET,
      }
    );
    const aggregate = new AggregateError([child], "multiple failures");
    const outer = new Error("outer", { cause: aggregate });
    child.cause = outer;
    const value = scrubSentryValue(outer) as {
      cause: { errors: Record<string, unknown>[] };
    };
    expect(value.cause.errors[0].code).toBe("ECONNREFUSED");
    expect(value.cause.errors[0].stack).toContain("sentry-scrubber.test.ts");
    expect(value.cause.errors[0].cause).toBe("[CIRCULAR]");
    expect(JSON.stringify(value)).not.toContain(SECRET);
  });

  it("redacts inline credential assignments without hiding diagnostic codes", () => {
    const error = new Error(
      `failed token=${SECRET} password=${SECRET} code=ECONNREFUSED`
    );
    const value = JSON.stringify(scrubSentryValue(error));
    expect(value).not.toContain(SECRET);
    expect(value).toContain("code=ECONNREFUSED");
  });
  it("redacts quoted credentials in inline assignments and query pairs", () => {
    for (const assignment of [
      `password="${SECRET} with spaces"`,
      `token='${SECRET} with spaces'`,
      `password="${SECRET} with \\"escaped quotes\\""`,
    ]) {
      for (const prefix of ["", "failed ", "/path?", "other=value; "]) {
        const value = JSON.stringify(
          scrubSentryValue(
            new Error(`${prefix}${assignment} code=ECONNREFUSED`)
          )
        );
        expect(value).not.toContain(SECRET);
        expect(value).toContain("code=ECONNREFUSED");
      }
    }
  });
  it("does not retain serialization hooks that can bypass scrubbing", () => {
    const payload = {
      data: { toJSON: () => ({ authorization: "synthetic-secret" }) },
      error: Object.assign(new Error("synthetic error"), {
        toJSON: () => ({ cookie: "synthetic-secret" }),
      }),
    };
    const serialized = JSON.stringify(scrubSentryValue(payload));
    expect(serialized).not.toContain("synthetic-secret");
    expect(serialized).toContain("synthetic error");
  });

  it("removes URL queries and fragments while preserving route paths", () => {
    const value = scrubSentryValue(
      `GET https://example.test/api/v1/files/a?token=${SECRET}&state=x#fragment`
    );
    expect(value).toBe("GET https://example.test/api/v1/files/a");
  });

  it("removes every query value, including duplicate, encoded, and mixed-case credentials", () => {
    const event = scrubSentryErrorEvent({
      request: {
        url: `https://example.test/api/v1/files/artifact?ToKeN=${SECRET}&token=${SECRET}&sigNature=${SECRET}&x%2Dapi%2Dkey=${SECRET}#${SECRET}`,
      },
      message: `signed download failed: https://example.test/api/v1/files/artifact?token=${SECRET}`,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("https://example.test/api/v1/files/artifact");
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain("#");
  });

  it("redacts mixed-case secret keys through nested arrays and objects", () => {
    const nested: Record<string, unknown> = {
      Authorization: `Bearer ${SECRET}`,
      "X-API-Key": SECRET,
      CoOkIe: SECRET,
      items: [{ signature: SECRET, safeRoute: "/api/v1/files/a" }],
    };
    const result = scrubSentryValue(nested) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((result.items as Array<Record<string, unknown>>)[0]?.safeRoute).toBe(
      "/api/v1/files/a"
    );
  });

  it("handles errors, causes, breadcrumbs, and circular values", () => {
    const cause = new Error(
      `download failed at https://example.test/file?code=${SECRET}`
    );
    const error = new Error("outer", { cause });
    (error as Error & { extras?: unknown }).extras = { api_key: SECRET };
    const circular: Record<string, unknown> = {
      error,
      breadcrumb: { data: { token: SECRET } },
    };
    circular.self = circular;

    const event = scrubSentryErrorEvent({
      message: error.message,
      extra: circular,
      breadcrumbs: [
        {
          message: `failed https://example.test/file?token=${SECRET}`,
          data: circular,
        },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: error.message,
            mechanism: { data: circular },
          },
        ],
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("https://example.test/file");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts credentials in relative URLs and bare query strings", () => {
    // Neither has a scheme, so a URL-only scrub never sees them. This is the
    // signed-download-token vector the scrubber exists to close.
    const relative = scrubSentryValue(
      `GET /api/v1/files/a?token=${SECRET}&page=2`
    ) as string;
    expect(relative).not.toContain(SECRET);
    expect(relative).toContain("/api/v1/files/a");
    expect(relative).toContain("page=2");

    const queryString = scrubSentryValue({
      request: { query_string: `signature=${SECRET}&limit=10` },
    }) as { request: { query_string: string } };
    expect(queryString.request.query_string).not.toContain(SECRET);
    expect(queryString.request.query_string).toContain("limit=10");
  });

  it("redacts cookie pairs written with a space after the separator", () => {
    // Cookie serialization is `a=b; c=d`. Without whitespace in the
    // separator, only the first pair anchors and every later credential
    // survives in a raw string headed for Sentry.
    const scrubbed = scrubSentryValue(
      `set-cookie rejected: theme=dark; token=${SECRET}; limit=10`
    ) as string;
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain("theme=dark");
    expect(scrubbed).toContain("limit=10");
  });

  it("keeps triage fields whose names merely contain a secret word", () => {
    const result = scrubSentryValue({
      status_code: 500,
      error_code: "E_TIMEOUT",
      stack_key: "abc",
    }) as Record<string, unknown>;
    expect(result.status_code).toBe(500);
    expect(result.error_code).toBe("E_TIMEOUT");
    expect(result.stack_key).toBe("abc");
  });

  it("keeps error codes as object keys but redacts them as query parameters", () => {
    // `code`/`state`/`key` are credentials in `?code=…` and diagnostics as
    // object keys. Redacting the key form blanks the Node errno and the
    // Postgres SQLSTATE, which are the first things read during triage.
    const result = scrubSentryValue({
      code: "ECONNREFUSED",
      state: "running",
      pgCode: "23505",
      url: `/oauth/callback?code=${SECRET}&state=${SECRET}`,
    }) as Record<string, string>;
    expect(result.code).toBe("ECONNREFUSED");
    expect(result.state).toBe("running");
    expect(result.pgCode).toBe("23505");
    expect(result.url).not.toContain(SECRET);
    expect(result.url).toContain("/oauth/callback");
  });

  it("uses the shared secret-key denylist rather than a private copy", () => {
    // These are all classified by @lobu/core's isSecretKey; a hand-rolled
    // local pattern silently missed every one of them.
    const result = scrubSentryValue({
      auth: SECRET,
      dsn: SECRET,
      private_key: SECRET,
      database_url: SECRET,
      session_id: SECRET,
    }) as Record<string, string>;
    for (const field of [
      "auth",
      "dsn",
      "private_key",
      "database_url",
      "session_id",
    ]) {
      expect(result[field]).toBe("[REDACTED]");
    }
  });

  it("redacts URI userinfo credentials that carry no query string at all", () => {
    const result = scrubSentryValue(
      `connect failed: postgres://lobu:${SECRET}@db.internal:5432/lobu`
    ) as string;
    expect(result).not.toContain(SECRET);
    expect(result).toContain("db.internal:5432/lobu");
  });

  it("redacts signature headers whose squashed form no exact set can hold", () => {
    // `X-Hub-Signature-256` squashes to `xhubsignature256`; matching the whole
    // key against a set silently missed every real signature header.
    const result = scrubSentryValue({
      "X-Hub-Signature-256": SECRET,
      "X-Amz-Signature": SECRET,
      "x-slack-signature": SECRET,
      design: "kept",
    }) as Record<string, string>;
    expect(result["X-Hub-Signature-256"]).toBe("[REDACTED]");
    expect(result["X-Amz-Signature"]).toBe("[REDACTED]");
    expect(result["x-slack-signature"]).toBe("[REDACTED]");
    expect(result.design).toBe("kept");
    expect(scrubSentryValue(`X-Amz-Signature=${SECRET}&limit=1`)).toBe(
      "X-Amz-Signature=[REDACTED]&limit=1"
    );
  });

  it("keeps the code_verifier and session_state coverage of the sanitizer it replaced", () => {
    // The shared denylist classifies neither: `verifier` and `state` are not
    // suffixes it knows, and both are far too broad to add as segments.
    const result = scrubSentryValue({
      code_verifier: SECRET,
      session_state: SECRET,
      codeVerifier: SECRET,
      freshness_state: "fresh",
      url: `/cb?code_verifier=${SECRET}`,
    }) as Record<string, string>;
    expect(result.code_verifier).toBe("[REDACTED]");
    expect(result.session_state).toBe("[REDACTED]");
    expect(result.codeVerifier).toBe("[REDACTED]");
    expect(result.freshness_state).toBe("fresh");
    expect(result.url).not.toContain(SECRET);
  });

  it("does not report a shared sibling reference as circular", () => {
    // `seen` tracks the current path; a repeated non-ancestor reference is
    // ordinary structure sharing, not a cycle.
    const shared = { api_key: SECRET, note: "kept" };
    const result = scrubSentryValue({ x: shared, y: shared }) as Record<
      string,
      Record<string, string>
    >;
    expect(result.y).not.toBe("[CIRCULAR]");
    expect(result.y.note).toBe("kept");
    expect(result.y.api_key).toBe("[REDACTED]");

    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;
    expect((scrubSentryValue(cycle) as Record<string, unknown>).self).toBe(
      "[CIRCULAR]"
    );
  });

  it("keeps trailing sentence punctuation outside the URL it strips", () => {
    const result = scrubSentryValue(
      `see https://example.test/a?token=${SECRET}, then retry.`
    ) as string;
    expect(result).toBe("see https://example.test/a, then retry.");
  });

  it("summarizes built-ins that a plain walk would flatten or explode", () => {
    const result = scrubSentryValue({
      at: new Date("2026-08-31T12:00:00.000Z"),
      buf: Buffer.from("abcd"),
      seen: new Set([1, 2]),
      byKey: new Map([["a", 1]]),
    }) as Record<string, unknown>;
    expect(result.at).toBe("2026-08-31T12:00:00.000Z");
    expect(result.buf).toBe("[Buffer 4 bytes]");
    expect(result.seen).toBe("[Set 2 items]");
    expect(result.byKey).toBe("[Map 1 entries]");
  });

  it("preserves an Error instead of flattening it to an empty object", () => {
    // name/message/stack live on the prototype, so Object.keys sees none of
    // them and a plain walk would discard the whole error.
    const error = new Error(`boom at https://example.test/f?token=${SECRET}`);
    const result = scrubSentryValue({ cause: error }) as {
      cause: { name: string; message: string; stack?: string };
    };
    expect(result.cause.name).toBe("Error");
    expect(result.cause.message).toContain("boom at");
    expect(result.cause.message).not.toContain(SECRET);
    expect(result.cause.stack).toBeDefined();
  });
});
