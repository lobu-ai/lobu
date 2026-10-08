import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { createIsolateConnectorCompiler } from "../../../packages/connector-worker/src/compile/index";

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
                    stream: { app: "server" },
                    values: [
                      [
                        "1791000000000000000",
                        JSON.stringify({
                          level: "error",
                          stack: "Error: fixture\n at test.ts:2:1",
                          cookie: "secret-fixture",
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
    records: [
      {
        log: { cookie: "[REDACTED]", stack: "Error: fixture\n at test.ts:2:1" },
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("secret-fixture");
});
