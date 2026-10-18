import { describe, expect, it } from "bun:test";
import { scrubDiagnosticValue } from "../utils/diagnostic-scrubber";

const SECRET = "DIAGNOSTIC_SECRET_SENTINEL";

describe("diagnostic credential scrubber", () => {
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
    const value = scrubDiagnosticValue(outer) as {
      cause: { errors: Record<string, unknown>[] };
    };
    expect(value.cause.errors[0].code).toBe("ECONNREFUSED");
    expect(value.cause.errors[0].stack).toContain(
      "diagnostic-scrubber.test.ts"
    );
    expect(value.cause.errors[0].cause).toBe("[CIRCULAR]");
    expect(JSON.stringify(value)).not.toContain(SECRET);
  });

  it("redacts inline credential assignments without hiding diagnostic codes", () => {
    const error = new Error(
      `failed token=${SECRET} password=${SECRET} code=ECONNREFUSED`
    );
    const value = JSON.stringify(scrubDiagnosticValue(error));
    expect(value).not.toContain(SECRET);
    expect(value).toContain("code=ECONNREFUSED");
  });
  it("redacts quoted credentials in inline assignments and query pairs", () => {
    for (const assignment of [
      `password="${SECRET} with spaces"`,
      `token='${SECRET} with spaces'`,
      `password="${SECRET} with \\"escaped quotes\\""`,
    ]) {
      for (const prefix of [
        "",
        "failed ",
        "/path?",
        "https://example.test/path?",
        "other=value; ",
      ]) {
        const value = JSON.stringify(
          scrubDiagnosticValue(
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
    const serialized = JSON.stringify(scrubDiagnosticValue(payload));
    expect(serialized).not.toContain("synthetic-secret");
    expect(serialized).toContain("synthetic error");
  });

  it("removes URL queries and fragments while preserving route paths", () => {
    const value = scrubDiagnosticValue(
      `GET https://example.test/api/v1/files/a?token=${SECRET}&state=x#fragment`
    );
    expect(value).toBe("GET https://example.test/api/v1/files/a");
  });

  it("removes every query value, including duplicate, encoded, and mixed-case credentials", () => {
    const event = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue(nested) as Record<string, unknown>;
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

    const event = scrubDiagnosticValue({
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
    const relative = scrubDiagnosticValue(
      `GET /api/v1/files/a?token=${SECRET}&page=2`
    ) as string;
    expect(relative).not.toContain(SECRET);
    expect(relative).toContain("/api/v1/files/a");
    expect(relative).toContain("page=2");

    const queryString = scrubDiagnosticValue({
      request: { query_string: `signature=${SECRET}&limit=10` },
    }) as { request: { query_string: string } };
    expect(queryString.request.query_string).not.toContain(SECRET);
    expect(queryString.request.query_string).toContain("limit=10");
  });

  it("redacts cookie pairs written with a space after the separator", () => {
    // Cookie serialization is `a=b; c=d`. Without whitespace in the
    // separator, only the first pair anchors and every later credential
    // survives in a raw string headed for telemetry.
    const scrubbed = scrubDiagnosticValue(
      `set-cookie rejected: theme=dark; token=${SECRET}; limit=10`
    ) as string;
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain("theme=dark");
    expect(scrubbed).toContain("limit=10");
  });

  it("keeps triage fields whose names merely contain a secret word", () => {
    const result = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue(
      `connect failed: postgres://lobu:${SECRET}@db.internal:5432/lobu`
    ) as string;
    expect(result).not.toContain(SECRET);
    expect(result).toContain("db.internal:5432/lobu");
  });

  it("redacts signature headers whose squashed form no exact set can hold", () => {
    // `X-Hub-Signature-256` squashes to `xhubsignature256`; matching the whole
    // key against a set silently missed every real signature header.
    const result = scrubDiagnosticValue({
      "X-Hub-Signature-256": SECRET,
      "X-Amz-Signature": SECRET,
      "x-slack-signature": SECRET,
      design: "kept",
    }) as Record<string, string>;
    expect(result["X-Hub-Signature-256"]).toBe("[REDACTED]");
    expect(result["X-Amz-Signature"]).toBe("[REDACTED]");
    expect(result["x-slack-signature"]).toBe("[REDACTED]");
    expect(result.design).toBe("kept");
    expect(scrubDiagnosticValue(`X-Amz-Signature=${SECRET}&limit=1`)).toBe(
      "X-Amz-Signature=[REDACTED]&limit=1"
    );
  });

  it("keeps the code_verifier and session_state coverage of the sanitizer it replaced", () => {
    // The shared denylist classifies neither: `verifier` and `state` are not
    // suffixes it knows, and both are far too broad to add as segments.
    const result = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue({ x: shared, y: shared }) as Record<
      string,
      Record<string, string>
    >;
    expect(result.y).not.toBe("[CIRCULAR]");
    expect(result.y.note).toBe("kept");
    expect(result.y.api_key).toBe("[REDACTED]");

    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;
    expect((scrubDiagnosticValue(cycle) as Record<string, unknown>).self).toBe(
      "[CIRCULAR]"
    );
  });

  it("keeps trailing sentence punctuation outside the URL it strips", () => {
    const result = scrubDiagnosticValue(
      `see https://example.test/a?token=${SECRET}, then retry.`
    ) as string;
    expect(result).toBe("see https://example.test/a, then retry.");
  });

  it("summarizes built-ins that a plain walk would flatten or explode", () => {
    const result = scrubDiagnosticValue({
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
    const result = scrubDiagnosticValue({ cause: error }) as {
      cause: { name: string; message: string; stack?: string };
    };
    expect(result.cause.name).toBe("Error");
    expect(result.cause.message).toContain("boom at");
    expect(result.cause.message).not.toContain(SECRET);
    expect(result.cause.stack).toBeDefined();
  });

  it("redacts camel-cased credential headers the suffix denylist never sees", () => {
    // `authorizationHeader` squashes to a whole name the shared denylist does
    // not classify; the old substring logger replacer caught it, so the
    // scrubber carries it as an exact name to avoid the regression.
    const result = scrubDiagnosticValue({
      authorizationHeader: `Bearer ${SECRET}`,
      authorization_header: `Bearer ${SECRET}`,
      authorization_mode: "strict",
    }) as Record<string, unknown>;
    expect(result.authorizationHeader).toBe("[REDACTED]");
    expect(result.authorization_header).toBe("[REDACTED]");
    expect(result.authorization_mode).toBe("strict");
  });

  it("redacts prefixed authorization headers and serialized credential fields", () => {
    // Split-form names the whole/suffix rules miss: a trailing
    // `authorization` segment is a vendor-prefixed header, and a leading
    // `credential(s)` segment names a serialized credential field. The mode
    // half of `authorization_mode` stays readable by construction, as does
    // `token_count` (a leading `token` segment is not a credential pin).
    const result = scrubDiagnosticValue({
      "x-authorization": `Bearer ${SECRET}`,
      xAuthorization: `Bearer ${SECRET}`,
      credentials_json: JSON.stringify({ password: SECRET }),
      credentialsJson: JSON.stringify({ password: SECRET }),
      credentialBlob: SECRET,
      authorization_mode: "strict",
      token_count: 7,
    }) as Record<string, unknown>;
    expect(result["x-authorization"]).toBe("[REDACTED]");
    expect(result.xAuthorization).toBe("[REDACTED]");
    expect(result.credentials_json).toBe("[REDACTED]");
    expect(result.credentialsJson).toBe("[REDACTED]");
    expect(result.credentialBlob).toBe("[REDACTED]");
    expect(result.authorization_mode).toBe("strict");
    expect(result.token_count).toBe(7);
  });

  it("recurses into credential maps instead of collapsing them", () => {
    // A structured value beneath a credential container recurses, so
    // pre-redacted leaves and surviving key names pass through (the Loki
    // connector relies on this per-key treatment) — but raw scalar leaves
    // beneath one are credential-adjacent and collapse, including provider
    // names the key rules alone would miss (`credentialsByName.github`).
    const result = scrubDiagnosticValue({
      credentialsByName: {
        PGPASSWORD: "[REDACTED]",
        github: `token-${SECRET}`,
        note: "kept",
      },
      credentials_json: JSON.stringify({ password: SECRET }),
    }) as Record<string, Record<string, unknown>>;
    expect(result.credentialsByName).toEqual({
      PGPASSWORD: "[REDACTED]",
      github: "[REDACTED]",
      note: "[REDACTED]",
    });
    expect(result.credentials_json).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("redacts password/secret segments with trailing qualifiers", () => {
    // `password_confirmation`, `secret_value`: the credential term is not a
    // suffix, so the shared denylist misses them; the container rule still
    // collapses scalar values while recursing structured ones.
    const result = scrubDiagnosticValue({
      password_confirmation: SECRET,
      secret_value: { nested: SECRET },
      authorization_mode: "strict",
      token_count: 7,
    }) as Record<string, unknown>;
    expect(result.password_confirmation).toBe("[REDACTED]");
    expect(result.secret_value).toEqual({ nested: "[REDACTED]" });
    expect(result.authorization_mode).toBe("strict");
    expect(result.token_count).toBe(7);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("redacts authorization values and serialized authorization objects", () => {
    const result = scrubDiagnosticValue({
      authorization_value: SECRET,
      authorizationValueJson: JSON.stringify({ token: SECRET }),
      authorization_mode: "strict",
      authorization_policy: "admin-only",
    }) as Record<string, unknown>;
    expect(result.authorization_value).toBe("[REDACTED]");
    expect(result.authorizationValueJson).toBe("[REDACTED]");
    expect(result.authorization_mode).toBe("strict");
    expect(result.authorization_policy).toBe("admin-only");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("scrubs credential text out of Error names", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "name", {
      value: "Custom password=synthetic-name-secret",
      enumerable: false,
    });
    const result = scrubDiagnosticValue({ cause: error }) as {
      cause: { name: string; message: string };
    };
    expect(result.cause.name).not.toContain("synthetic-name-secret");
    expect(result.cause.name).toContain("Custom");
    expect(result.cause.message).toBe("boom");
    expect(JSON.stringify(result)).not.toContain("synthetic-name-secret");
  });
  it("redacts prefixed authorization headers", () => {
    // The auth term followed by a `header` segment is still a header
    // (`requestAuthorizationHeader`); a bare `headers` map or one ending in
    // any other segment stays readable.
    const result = scrubDiagnosticValue({
      requestAuthorizationHeader: `Bearer ${SECRET}`,
      headers: { "content-type": "application/json" },
    }) as Record<string, unknown>;
    expect(result.requestAuthorizationHeader).toBe("[REDACTED]");
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it("redacts leading credential terms with trailing qualifiers", () => {
    // The qualifier half is matched positionally because the shared suffix
    // rules are end-anchored (`token_value`, `accessTokenValue`,
    // `api_key_value`). A usage-metric qualifier stays readable
    // (`token_count`, `token_total`, `max_tokens`).
    const result = scrubDiagnosticValue({
      token_value: SECRET,
      accessTokenValue: SECRET,
      api_key_value: SECRET,
      token_count: 7,
      token_total: 9,
      max_tokens: 100,
      totalTokens: 9,
    }) as Record<string, unknown>;
    expect(result.token_value).toBe("[REDACTED]");
    expect(result.accessTokenValue).toBe("[REDACTED]");
    expect(result.api_key_value).toBe("[REDACTED]");
    expect(result.token_count).toBe(7);
    expect(result.token_total).toBe(9);
    expect(result.max_tokens).toBe(100);
    expect(result.totalTokens).toBe(9);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(scrubDiagnosticValue("usage token_count=7")).toBe(
      "usage token_count=7"
    );
  });

  it("redacts Error and RegExp values beneath credential containers", () => {
    // Built-in rendering (Error message/stack, RegExp source) bypasses
    // key-side classification, so the container flag travels with the value.
    const result = scrubDiagnosticValue({
      credentialsByName: {
        provider: new Error(`login failed: ${SECRET}`),
        pattern: /token=synthetic-pattern-secret/,
      },
    }) as {
      credentialsByName: {
        provider: { name: string; message: string };
        pattern: string;
      };
    };
    expect(result.credentialsByName.provider.message).toBe("[REDACTED]");
    expect(result.credentialsByName.pattern).toBe("[REDACTED]");
    expect(result.credentialsByName.provider.name).toBe("Error");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
  it("leaves non-credential hyphenated keys readable", () => {
    // Whole-name exact matches never seed a compound head: `cookie-policy`
    // and `authorization_mode` stay readable even though `cookie` and
    // `authorization` classify on their own.
    const result = scrubDiagnosticValue({
      "cookie-policy": "strict",
      authorization_mode: "oauth",
      "content-type": "application/json",
    }) as Record<string, unknown>;
    expect(result).toEqual({
      "cookie-policy": "strict",
      authorization_mode: "oauth",
      "content-type": "application/json",
    });
  });
  it("redacts separator-free token compounds without touching usage counters", () => {
    // `csrftoken`, `githubtoken`, `authtoken`: bare `token` endings with no
    // separator. `max_tokens` and `totalTokens` stay readable — usage
    // metadata, per the logger contract.
    const result = scrubDiagnosticValue({
      csrftoken: SECRET,
      githubtoken: SECRET,
      authtoken: SECRET,
      max_tokens: 100,
      totalTokens: 9,
    }) as Record<string, unknown>;
    expect(result.csrftoken).toBe("[REDACTED]");
    expect(result.githubtoken).toBe("[REDACTED]");
    expect(result.authtoken).toBe("[REDACTED]");
    expect(result.max_tokens).toBe(100);
    expect(result.totalTokens).toBe(9);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("redacts credential terms buried in separator-free compounds", () => {
    // `clientsecretvalue`: no separators and no credential suffix for the
    // shared rules or split segment tests to catch.
    const result = scrubDiagnosticValue({
      clientsecretvalue: SECRET,
    }) as Record<string, unknown>;
    expect(result.clientsecretvalue).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses usage-metric exemptions for credential-bearing names", () => {
    // A benign qualifier only exempts an exact two-segment usage metric
    // (`token_count`); anywhere else the credential term wins
    // (`used_access_token`, `token_usage_secret`).
    const result = scrubDiagnosticValue({
      used_access_token: SECRET,
      token_usage_secret: SECRET,
      token_count: 7,
    }) as Record<string, unknown>;
    expect(result.used_access_token).toBe("[REDACTED]");
    expect(result.token_usage_secret).toBe("[REDACTED]");
    expect(result.token_count).toBe(7);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("stays linear on pathological segmented keys", () => {
    const key = `${"a_".repeat(2000)}token_count`;
    const started = performance.now();
    const result = scrubDiagnosticValue({ [key]: "kept" }) as Record<
      string,
      unknown
    >;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result[key]).toBe("kept");
  });
  it("redacts concatenated and provider-prefixed credential names", () => {
    // Separator-free compounds the suffix rules never see: bare credential
    // endings (`PGPASSWORD`, `authtoken`, `idtoken`) and a provider-prefixed
    // serialized field (`oauthCredentialsJson`). Bare `*token` compounds
    // collapse; two-segment usage metrics (`token_count`) stay readable via
    // the benign-usage exemption.
    const result = scrubDiagnosticValue({
      PGPASSWORD: SECRET,
      authtoken: SECRET,
      idtoken: SECRET,
      oauthCredentialsJson: JSON.stringify({ token: SECRET }),
      token_count: 7,
    }) as Record<string, unknown>;
    expect(result.PGPASSWORD).toBe("[REDACTED]");
    expect(result.authtoken).toBe("[REDACTED]");
    expect(result.idtoken).toBe("[REDACTED]");
    expect(result.oauthCredentialsJson).toBe("[REDACTED]");
    expect(result.token_count).toBe(7);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("scrubs credential patterns out of RegExp sources", () => {
    // A RegExp source is message text: `password=...` assignments scrub the
    // same as anywhere else (the base caught these in its final text pass).
    const result = scrubDiagnosticValue({
      pattern: /test password=synthetic-pattern-secret/,
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain("synthetic-pattern-secret");
    expect(JSON.stringify(result)).toContain("test password=");
  });

  it("collapses authorization headers regardless of value type", () => {
    // Headers are scalar-or-list carriers, never credential maps: an
    // array-valued header collapses wholesale instead of recursing into
    // elements whose text carries no assignment for value-side rules.
    const result = scrubDiagnosticValue({
      headers: {
        "x-authorization": [`Bearer ${SECRET}`],
        "content-type": "application/json",
      },
    }) as { headers: Record<string, unknown> };
    expect(result.headers["x-authorization"]).toBe("[REDACTED]");
    expect(result.headers["content-type"]).toBe("application/json");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("applies key classification to Error custom properties", () => {
    const error = Object.assign(new Error("boom"), {
      headers: { "x-authorization": [`Bearer ${SECRET}`] },
    });
    const result = scrubDiagnosticValue({ cause: error }) as {
      cause: { headers: Record<string, unknown> };
    };
    expect(result.cause.headers["x-authorization"]).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("redacts credential query pairs embedded in object keys", () => {
    // Attribution and cache maps keyed by URL carry the secret in the KEY
    // text, past value-side redaction. The key stays identifiable; the
    // secret portion does not survive.
    const result = scrubDiagnosticValue({
      [`https://example.test/path?token=${SECRET}`]: "cached",
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("https://example.test/path");
  });
});
