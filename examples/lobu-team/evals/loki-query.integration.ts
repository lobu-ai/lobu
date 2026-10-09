import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { createIsolateConnectorCompiler } from "../../../packages/connector-worker/src/compile/index";

const credentialLogs = [
  "failed password=secret7 token=synthetic-opaque-token",
  "authorization=Bearer synthetic-bearer-secret status=500",
  "auth=Basic c3ludGhldGljOnNlY3JldA== status=500",
  "db.password=synthetic-dotted-password config.api_key=synthetic-dotted-key status=500",
  'failed password="synthetic spaced password"',
  `embedded ${JSON.stringify({ password: "synthetic quoted password", token: "synthetic-embedded-token" })}`,
  `escaped ${JSON.stringify(JSON.stringify({ password: "synthetic escaped password", token: "synthetic-escaped-token" }))}`,
  `embedded ${JSON.stringify({ credentials: { pass: "synthetic-nested-secret" }, status: 500 })}`,
  JSON.stringify({ message: "auth=Basic synthetic-nested-basic status=500" }),
];
let code: string;
beforeAll(async () => {
  code =
    await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(
      fileURLToPath(new URL("../loki-activity.connector.ts", import.meta.url))
    );
});

it("runs query_logs inside the native isolate through the existing HTTP auth capability", async () => {
  const seen: URL[] = [];
  const result = await new IsolateExecutor({ timeoutMs: 5000 }).execute(
    code,
    {
      mode: "action",
      actionKey: "query_logs",
      actionInput: {
        query: '{namespace="synthetic"}',
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-01T01:00:00Z",
        limit: 20,
      },
      config: { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      credentials: null,
      sessionState: null,
      env: {},
      httpAuth: true,
    },
    {
      onHttpFetch: async (request) => {
        seen.push(new URL(request.url));
        expect(new Headers(request.headers).has("authorization")).toBe(false);
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              status: "success",
              data: {
                resultType: "streams",
                result: [
                  {
                    stream: {
                      app: "server",
                      detail: "Bearer synthetic-label-secret",
                    },
                    values: [
                      ...credentialLogs.map((line, index) => [
                        String(index + 1),
                        line,
                      ]),
                      [
                        "1791000000000000000",
                        JSON.stringify({
                          level: "error",
                          stack: "Error: fixture\n at test.ts:2:1",
                          cookie: "secret-fixture",
                          message:
                            "failed with Bearer synthetic-message-secret",
                        }),
                      ],
                    ],
                  },
                ],
              },
            })
          ).toString("base64"),
        };
      },
    }
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.pathname).toBe("/loki/api/v1/query_range");
  expect(seen[0]?.searchParams.get("limit")).toBe("20");
  expect(result.output).toMatchObject({
    truncated: false,
    records: expect.arrayContaining([
      expect.objectContaining({
        log: expect.objectContaining({
          cookie: "[REDACTED]",
          stack: "Error: fixture\n at test.ts:2:1",
        }),
      }),
    ]),
  });
  expect(result.output).toHaveProperty(
    "records.length",
    credentialLogs.length + 1
  );
  for (const secret of [
    "secret7",
    "synthetic-bearer-secret",
    "c3ludGhldGljOnNlY3JldA==",
    "synthetic-dotted-password",
    "synthetic-dotted-key",
    "synthetic-opaque-token",
    "synthetic spaced password",
    "synthetic quoted password",
    "synthetic-embedded-token",
    "synthetic escaped password",
    "synthetic-escaped-token",
    "synthetic-nested-secret",
    "synthetic-nested-basic",
  ]) {
    expect(JSON.stringify(result)).not.toContain(secret);
  }
  expect(JSON.stringify(result)).not.toContain("secret-fixture");
  expect(JSON.stringify(result)).not.toContain("synthetic-label-secret");
  expect(JSON.stringify(result)).not.toContain("synthetic-message-secret");
});
