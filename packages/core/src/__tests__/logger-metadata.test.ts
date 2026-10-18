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

  test("scrubs a credential-bearing URL in a pino-style message", () => {
    const line = captureWarn((log) => {
      log.warn(
        { op: "fetch" },
        "fetch failed https://example.test/path?token=synthetic-pino-secret"
      );
    });

    expect(line).toContain("fetch failed");
    expect(line).toContain("op");
    expect(line).not.toContain("synthetic-pino-secret");
  });

  test("scrubs a credential-bearing URL in a top-level Error", () => {
    const line = captureWarn((log) => {
      log.warn(
        new Error(
          "fetch failed https://example.test/path?token=synthetic-error-secret"
        )
      );
    });

    expect(line).toContain("fetch failed");
    expect(line).not.toContain("synthetic-error-secret");
  });

  test("scrubs a credential-bearing URL in a top-level array", () => {
    const line = captureWarn((log) => {
      log.warn([
        "fetch failed https://example.test/path?token=synthetic-array-secret",
      ]);
    });

    expect(line).toContain("fetch failed");
    expect(line).not.toContain("synthetic-array-secret");
  });

  test("redacts camel-cased credential headers the suffix denylist misses", () => {
    const line = captureWarn((log) => {
      log.warn({ authorizationHeader: "Bearer synthetic-header-secret" });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-header-secret");
  });

  test("redacts password/secret segments with trailing qualifiers", () => {
    const line = captureWarn((log) => {
      log.warn({
        password_confirmation: "synthetic-confirm-secret",
        secret_value: { nested: "synthetic-nested-secret" },
        token_count: 7,
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).toContain("token_count");
    expect(line).not.toContain("synthetic-confirm-secret");
    expect(line).not.toContain("synthetic-nested-secret");
  });

  test("redacts prefixed authorization-header compounds", () => {
    const line = captureWarn((log) => {
      log.warn({
        requestAuthorizationHeader: "Bearer synthetic-req-auth-secret",
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-req-auth-secret");
  });

  test("redacts concatenated auth tokens and auth-header compounds", () => {
    const line = captureWarn((log) => {
      log.warn({
        csrftoken: "synthetic-csrf-secret",
        githubtoken: "synthetic-github-secret",
        authorizationValueJson: '{"token":"synthetic-authzjson-secret"}',
        clientsecretvalue: "synthetic-clientsecret-secret",
        requestAuthorizationValue: "synthetic-req-authz-secret",
        proxy_authorization_value: "synthetic-proxy-authz-secret",
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-csrf-secret");
    expect(line).not.toContain("synthetic-github-secret");
    expect(line).not.toContain("synthetic-authzjson-secret");
    expect(line).not.toContain("synthetic-clientsecret-secret");
    expect(line).not.toContain("synthetic-req-authz-secret");
    expect(line).not.toContain("synthetic-proxy-authz-secret");
  });

  test("scrubs credential text out of Error names", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "name", {
      value: "Custom password=synthetic-name-secret",
      enumerable: false,
    });
    const line = captureWarn((log) => {
      log.warn({ cause: error });
    });

    expect(line).toContain("boom");
    expect(line).not.toContain("synthetic-name-secret");
  });

  test("redacts leading credential terms with trailing qualifiers", () => {
    const line = captureWarn((log) => {
      log.warn({
        token_value: "synthetic-token-value-secret",
        accessTokenValue: "synthetic-access-secret",
        api_key_value: "synthetic-apikey-secret",
        token_count: 7,
        token_total: 9,
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).toContain("token_count");
    expect(line).not.toContain("synthetic-token-value-secret");
    expect(line).not.toContain("synthetic-access-secret");
    expect(line).not.toContain("synthetic-apikey-secret");
  });

  test("redacts concatenated and provider-prefixed credential names", () => {
    const line = captureWarn((log) => {
      log.warn({
        PGPASSWORD: "synthetic-concat-secret",
        authtoken: "synthetic-authtoken-secret",
        idtoken: "synthetic-idtoken-secret",
        oauthCredentialsJson: '{"token":"synthetic-oauth-secret"}',
        authorization_value: "synthetic-authz-value-secret",
        secretsByName: { provider: "synthetic-provider-secret" },
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-concat-secret");
    expect(line).not.toContain("synthetic-authtoken-secret");
    expect(line).not.toContain("synthetic-idtoken-secret");
    expect(line).not.toContain("synthetic-oauth-secret");
    expect(line).not.toContain("synthetic-authz-value-secret");
    expect(line).not.toContain("synthetic-provider-secret");
  });

  test("refuses usage-metric exemptions for credential-bearing names", () => {
    const line = captureWarn((log) => {
      log.warn({
        used_access_token: "synthetic-used-secret",
        token_usage_secret: "synthetic-usage-secret",
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-used-secret");
    expect(line).not.toContain("synthetic-usage-secret");
  });

  test("redacts concatenated auth tokens and authorization values", () => {
    const line = captureWarn((log) => {
      log.warn({
        authtoken: "synthetic-concat-authtoken-secret",
        authorization_value: "synthetic-authz-value-secret",
        used_access_token: "synthetic-used-secret",
        token_usage_secret: "synthetic-usage-secret",
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-concat-authtoken-secret");
    expect(line).not.toContain("synthetic-authz-value-secret");
    expect(line).not.toContain("synthetic-used-secret");
    expect(line).not.toContain("synthetic-usage-secret");
  });

  test("redacts Error and RegExp values beneath credential containers", () => {
    const line = captureWarn((log) => {
      log.warn({
        credentialsByName: {
          provider: new Error("login failed: synthetic-provider-error-secret"),
          pattern: /token=synthetic-provider-pattern-secret/,
        },
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("synthetic-provider-error-secret");
    expect(line).not.toContain("synthetic-provider-pattern-secret");
  });
  test("redacts prefixed authorization headers and serialized credential fields", () => {
    const line = captureWarn((log) => {
      log.warn({
        "x-authorization": "Bearer synthetic-prefixed-secret",
        xAuthorization: "Bearer synthetic-xauth-secret",
        credentials_json: '{"password":"synthetic-serialized-secret"}',
        credentialsJson: '{"password":"synthetic-camel-secret"}',
        credentialBlob: "synthetic-blob-secret",
        PGPASSWORD: "synthetic-concat-secret",
        oauthCredentialsJson: '{"token":"synthetic-oauth-secret"}',
        credentialsByName: { github: "synthetic-provider-secret" },
        token_count: 7,
      });
    });

    expect(line).toContain("[REDACTED]");
    expect(line).toContain("token_count");
    expect(line).not.toContain("synthetic-prefixed-secret");
    expect(line).not.toContain("synthetic-xauth-secret");
    expect(line).not.toContain("synthetic-serialized-secret");
    expect(line).not.toContain("synthetic-camel-secret");
    expect(line).not.toContain("synthetic-blob-secret");
    expect(line).not.toContain("synthetic-concat-secret");
    expect(line).not.toContain("synthetic-oauth-secret");
    expect(line).not.toContain("synthetic-provider-secret");
  });

  test("collapses array-valued authorization headers and Error properties", () => {
    const arrayLine = captureWarn((log) => {
      log.warn({
        headers: { "x-authorization": ["Bearer synthetic-array-secret"] },
      });
    });
    expect(arrayLine).toContain("[REDACTED]");
    expect(arrayLine).not.toContain("synthetic-array-secret");

    const errorLine = captureWarn((log) => {
      log.warn(
        Object.assign(new Error("boom"), {
          headers: {
            "x-authorization": ["Bearer synthetic-error-prop-secret"],
          },
        })
      );
    });
    expect(errorLine).toContain("boom");
    expect(errorLine).not.toContain("synthetic-error-prop-secret");
  });

  test("redacts credential query pairs embedded in object keys", () => {
    const line = captureWarn((log) => {
      log.warn({
        "https://example.test/path?token=synthetic-key-secret": "cached",
      });
    });

    expect(line).toContain("https://example.test/path");
    expect(line).not.toContain("synthetic-key-secret");
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

  test("honors LOG_FORMAT=json for pino-style messages and top-level Errors", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { createLogger } from ${JSON.stringify(new URL("../logger.ts", import.meta.url).pathname)};
        const log = createLogger("synthetic-service");
        log.warn({ op: "fetch" }, "fetch failed https://example.test/path?token=synthetic-pino-secret");
        log.warn(new Error("fetch failed https://example.test/path?token=synthetic-error-secret"));
        log.warn(["fetch failed https://example.test/path?token=synthetic-array-secret"]);
        log.warn({ authorizationHeader: "Bearer synthetic-header-secret" });
        log.warn({ "https://example.test/path?token=synthetic-key-secret": "cached" });
        log.warn({
          "x-authorization": "Bearer synthetic-json-prefixed-secret",
          credentials_json: '{"password":"synthetic-json-serialized-secret"}',
          credentialsJson: '{"password":"synthetic-json-camel-secret"}',
          credentialBlob: "synthetic-json-blob-secret",
          xAuthorization: "Bearer synthetic-json-xauth-secret",
          PGPASSWORD: "synthetic-json-concat-secret",
          oauthCredentialsJson:
            '{"token":"synthetic-json-oauth-secret"}',
          credentialsByName: { github: "synthetic-json-provider-secret" },
          password_confirmation: "synthetic-json-confirm-secret",
          secret_value: { nested: "synthetic-json-nested-secret" },
          requestAuthorizationHeader:
            "Bearer synthetic-json-req-auth-secret",
          token_value: "synthetic-json-token-value-secret",
          accessTokenValue: "synthetic-json-access-secret",
          api_key_value: "synthetic-json-apikey-secret",
          authtoken: "synthetic-json-authtoken-secret",
          idtoken: "synthetic-json-idtoken-secret",
          authorization_value: "synthetic-json-authz-value-secret",
          used_access_token: "synthetic-json-used-secret",
          token_usage_secret: "synthetic-json-usage-secret",
          csrftoken: "synthetic-json-csrftoken-secret",
          githubtoken: "synthetic-json-githubtoken-secret",
          authorizationValueJson:
            '{"token":"synthetic-json-authzjson-secret"}',
          clientsecretvalue: "synthetic-json-clientsecret-secret",
          requestAuthorizationValue: "synthetic-json-req-authz-secret",
          proxy_authorization_value: "synthetic-json-proxy-authz-secret",
        });
        log.warn({
          headers: { "x-authorization": ["Bearer synthetic-json-array-secret"] },
        });
        log.warn(
          Object.assign(new Error("synthetic-json-boom"), {
            headers: { "x-authorization": ["Bearer synthetic-json-error-prop-secret"] },
            credentialsByName: {
              provider: new Error("login failed: synthetic-json-provider-error-secret"),
            },
          })
        );`,
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
    expect(records).toHaveLength(8);
    expect(records[0]).toMatchObject({
      level: "warn",
      message: expect.stringContaining("fetch failed"),
    });
    expect(records[1]).toMatchObject({
      level: "warn",
      message: expect.stringContaining("fetch failed"),
    });
    expect(records[2]).toMatchObject({
      level: "warn",
      message: expect.stringContaining("fetch failed"),
    });
    expect(records[3].level).toBe("warn");
    expect(records[3].message).toContain("[REDACTED]");
    expect(records[4].message).toContain("https://example.test/path");
    expect(records[5].level).toBe("warn");
    expect(records[5].message).toContain("[REDACTED]");
    expect(records[5].message).not.toContain("synthetic-json-prefixed-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-serialized-secret"
    );
    expect(records[5].message).not.toContain("synthetic-json-camel-secret");
    expect(records[5].message).not.toContain("synthetic-json-blob-secret");
    expect(records[5].message).not.toContain("synthetic-json-xauth-secret");
    expect(records[5].message).not.toContain("synthetic-json-concat-secret");
    expect(records[5].message).not.toContain("synthetic-json-oauth-secret");
    expect(records[5].message).not.toContain("synthetic-json-provider-secret");
    expect(records[5].message).not.toContain("synthetic-json-confirm-secret");
    expect(records[5].message).not.toContain("synthetic-json-nested-secret");
    expect(records[5].message).not.toContain("synthetic-json-req-auth-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-token-value-secret"
    );
    expect(records[5].message).not.toContain("synthetic-json-access-secret");
    expect(records[5].message).not.toContain("synthetic-json-apikey-secret");
    expect(records[5].message).not.toContain("synthetic-json-authtoken-secret");
    expect(records[5].message).not.toContain("synthetic-json-idtoken-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-authz-value-secret"
    );
    expect(records[5].message).not.toContain("synthetic-json-used-secret");
    expect(records[5].message).not.toContain("synthetic-json-usage-secret");
    expect(records[5].message).not.toContain("synthetic-json-csrftoken-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-githubtoken-secret"
    );
    expect(records[5].message).not.toContain("synthetic-json-authzjson-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-clientsecret-secret"
    );
    expect(records[5].message).not.toContain("synthetic-json-req-authz-secret");
    expect(records[5].message).not.toContain(
      "synthetic-json-proxy-authz-secret"
    );
    expect(records[6].level).toBe("warn");
    expect(records[6].message).toContain("[REDACTED]");
    expect(records[6].message).not.toContain("synthetic-json-array-secret");
    expect(records[7].level).toBe("warn");
    expect(records[7].message).toContain("synthetic-json-boom");
    expect(records[7].message).not.toContain(
      "synthetic-json-error-prop-secret"
    );
    expect(records[7].message).not.toContain(
      "synthetic-json-provider-error-secret"
    );
    expect(output).not.toContain("synthetic-pino-secret");
    expect(output).not.toContain("synthetic-error-secret");
    expect(output).not.toContain("synthetic-array-secret");
    expect(output).not.toContain("synthetic-header-secret");
    expect(output).not.toContain("synthetic-key-secret");
    expect(output).not.toContain("synthetic-json-prefixed-secret");
    expect(output).not.toContain("synthetic-json-serialized-secret");
    expect(output).not.toContain("synthetic-json-camel-secret");
    expect(output).not.toContain("synthetic-json-blob-secret");
    expect(output).not.toContain("synthetic-json-xauth-secret");
    expect(output).not.toContain("synthetic-json-concat-secret");
    expect(output).not.toContain("synthetic-json-oauth-secret");
    expect(output).not.toContain("synthetic-json-provider-secret");
    expect(output).not.toContain("synthetic-json-confirm-secret");
    expect(output).not.toContain("synthetic-json-nested-secret");
    expect(output).not.toContain("synthetic-json-req-auth-secret");
    expect(output).not.toContain("synthetic-json-token-value-secret");
    expect(output).not.toContain("synthetic-json-access-secret");
    expect(output).not.toContain("synthetic-json-apikey-secret");
    expect(output).not.toContain("synthetic-json-authtoken-secret");
    expect(output).not.toContain("synthetic-json-idtoken-secret");
    expect(output).not.toContain("synthetic-json-authz-value-secret");
    expect(output).not.toContain("synthetic-json-used-secret");
    expect(output).not.toContain("synthetic-json-usage-secret");
    expect(output).not.toContain("synthetic-json-csrftoken-secret");
    expect(output).not.toContain("synthetic-json-githubtoken-secret");
    expect(output).not.toContain("synthetic-json-authzjson-secret");
    expect(output).not.toContain("synthetic-json-clientsecret-secret");
    expect(output).not.toContain("synthetic-json-req-authz-secret");
    expect(output).not.toContain("synthetic-json-proxy-authz-secret");
    expect(output).not.toContain("synthetic-json-provider-error-secret");
    expect(output).not.toContain("synthetic-json-array-secret");
    expect(output).not.toContain("synthetic-json-error-prop-secret");
  });
});
