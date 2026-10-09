import { runSync } from "./sync-harness";
import { describe, expect, it, mock, spyOn } from "bun:test";
import LokiActivityConnector, {
  queryLokiActivity,
  queryLokiLogs,
  windowsToCollect,
} from "../loki-activity.connector.ts";

describe("Lobu Team Loki activity connector", () => {
  it("uses the text credential rules for structured logs and labels", async () => {
    const credentials = Object.fromEntries(
      [
        "PGPASSWORD",
        "customapikey",
        "nested.AWS_CUSTOM_KEY",
        "aWs_Custom_Key",
      ].map((key) => [key, { value: "synthetic-structured-secret" }])
    );
    const result = await queryLokiLogs(
      { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      {
        query: '{namespace="synthetic"}',
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-01T01:00:00Z",
      },
      async () =>
        Response.json({
          status: "success",
          data: {
            resultType: "streams",
            result: [
              {
                stream: Object.fromEntries(
                  Object.keys(credentials).map((key) => [
                    key,
                    "synthetic-label-secret",
                  ])
                ),
                values: [
                  [
                    "1",
                    JSON.stringify({
                      credentialsByName: credentials,
                      status: 500,
                    }),
                  ],
                ],
              },
            ],
          },
        })
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-structured-secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-label-secret");
    expect(result.records[0]?.log).toMatchObject({
      credentialsByName: Object.fromEntries(
        Object.keys(credentials).map((key) => [key, "[REDACTED]"])
      ),
      status: 500,
    });
  });

  it("scrubs credentials in plain logs, nested messages, and labels", async () => {
    const result = await queryLokiLogs(
      { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      {
        query: '{namespace="synthetic"}',
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-01T01:00:00Z",
      },
      async () =>
        Response.json({
          status: "success",
          data: {
            resultType: "streams",
            result: [
              {
                stream: { detail: "Bearer synthetic-label-secret" },
                values: [
                  ["0", "PGPASSWORD=synthetic-concatenated-secret"],
                  ["1", "Authorization: Basic synthetic-header-secret"],
                  [
                    "2",
                    JSON.stringify({
                      message:
                        "request failed with Bearer synthetic-message-secret",
                      error: {
                        stack:
                          "Error: failed\npassword=synthetic-password-secret\n at test.ts:1:1",
                      },
                    }),
                  ],
                ],
              },
            ],
          },
        })
    );
    const serialized = JSON.stringify(result);
    for (const secret of [
      "label",
      "header",
      "message",
      "password",
      "concatenated",
    ]) {
      expect(serialized).not.toContain(`synthetic-${secret}-secret`);
    }
    expect(serialized).toContain("test.ts:1:1");
  });

  it("bounds investigation, preserves stack evidence, and scrubs credentials", async () => {
    const fake = mock(async () =>
      Response.json({
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
                    message: "failed",
                    stack: "Error: failed\n at source.ts:4:1",
                    authorization: "private-secret",
                  }),
                ],
              ],
            },
          ],
        },
      })
    );
    const input = {
      query: '{namespace="synthetic"}',
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-01T01:00:00Z",
      limit: 1,
    };
    const result = await queryLokiLogs(
      { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      input,
      fake
    );
    expect(result.records[0]?.log).toMatchObject({
      stack: "Error: failed\n at source.ts:4:1",
      authorization: "[REDACTED]",
    });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
    for (const bad of [
      { limit: 201 },
      { limit: 0 },
      { start: "invalid" },
      { end: "2026-10-02T01:00:00Z" },
      { query: "" },
    ]) {
      await expect(
        queryLokiLogs(
          { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
          { ...input, ...bad },
          fake
        )
      ).rejects.toThrow();
    }
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("reports bounded output and rejects non-log and oversized upstream responses", async () => {
    const config = {
      LOKI_URL: "https://loki.example.test",
      namespace: "synthetic",
    };
    const input = {
      query: '{namespace="synthetic"}',
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-01T01:00:00Z",
    };
    const hugeLog = await queryLokiLogs(config, input, async () =>
      Response.json({
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: {},
              values: [
                ["1", "x".repeat(110000)],
                ["2", "kept"],
              ],
            },
          ],
        },
      })
    );
    expect(hugeLog.truncated).toBe(true);
    expect(hugeLog.records).toHaveLength(1);
    await expect(
      queryLokiLogs(config, input, async () =>
        Response.json({
          status: "success",
          data: { resultType: "matrix", result: [] },
        })
      )
    ).rejects.toThrow("log query");
    await expect(
      queryLokiLogs(
        config,
        input,
        async () => new Response("x".repeat(2000001))
      )
    ).rejects.toThrow("2 MB");
    await expect(
      queryLokiLogs(
        config,
        input,
        async () => new Response("failed", { status: 503 })
      )
    ).rejects.toThrow("503");
  });

  it("keeps the endpoint in public config and declares only the HTTP credential", () => {
    const { definition } = new LokiActivityConnector();
    expect(definition.optionsSchema).toMatchObject({
      required: ["LOKI_URL", "namespace"],
      properties: { LOKI_URL: { type: "string", format: "uri" } },
    });
    expect(definition.authSchema).toMatchObject({
      methods: [
        { fields: [{ key: "AUTHORIZATION", secret: true, required: true }] },
      ],
    });
  });

  it("keeps completed windows when a later query fails and resumes after them", async () => {
    const initialCheckpoint = { window_end: "2026-08-13T11:40:00.000Z" };
    const completedWindowEnd = "2026-08-13T12:00:00.000Z";
    let checkpoint = initialCheckpoint;
    const committedOrigins: string[] = [];
    const requestedTimes: string[] = [];
    let requests = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        requestedTimes.push(new URL(String(input)).searchParams.get("time")!);
        if (++requests > 1) throw new Error("upstream unavailable");
        return Response.json({
          status: "success",
          data: { resultType: "vector", result: [] },
        });
      }
    );
    const run = () =>
      runSync(new LokiActivityConnector(), {
        feedKey: "activity",
        checkpoint,
        config: {
          LOKI_URL: "https://loki.example.test",
          namespace: "synthetic",
        },
        commit: async (events, nextCheckpoint) => {
          committedOrigins.push(...events.map((event) => event.origin_id));
          checkpoint = nextCheckpoint as typeof checkpoint;
        },
      });

    try {
      await expect(run()).rejects.toThrow("upstream unavailable");
      expect(committedOrigins).toEqual([completedWindowEnd]);
      expect(checkpoint).toEqual({ window_end: completedWindowEnd });

      requestedTimes.length = 0;
      await expect(run()).rejects.toThrow("upstream unavailable");
      expect(requestedTimes).toEqual([
        String(new Date("2026-08-13T12:20:00.000Z").getTime() / 1000),
      ]);
      expect(committedOrigins).toEqual([completedWindowEnd]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not commit a window whose sample query fails", async () => {
    const commit = mock(async () => undefined);
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: {
            resultType: "vector",
            result: [{ metric: { level: "error" }, value: [0, "1"] }],
          },
        })
      )
      .mockRejectedValueOnce(new Error("sample query failed"));
    try {
      await expect(
        runSync(new LokiActivityConnector(), {
          feedKey: "activity",
          checkpoint: null,
          config: {
            LOKI_URL: "https://loki.example.test",
            namespace: "synthetic",
          },
          commit,
        })
      ).rejects.toThrow("sample query failed");
      expect(commit).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("persists a successful empty window as coverage evidence", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        status: "success",
        data: { resultType: "vector", result: [] },
      })
    );
    try {
      const result = await runSync(new LokiActivityConnector(), {
        feedKey: "activity",
        checkpoint: null,
        config: {
          LOKI_URL: "https://loki.example.test",
          namespace: "synthetic",
        },
      } as never);
      expect(result.events).toHaveLength(1);
      const event = result.events[0]!;
      expect(event.metadata).toMatchObject({
        errors: 0,
        warnings: 0,
      });
      expect(result.checkpoint).toEqual({
        window_end: event.origin_id,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("retains an old checkpoint and drains backlog in bounded oldest-first batches", () => {
    const checkpoint = { window_end: "2026-08-10T12:00:00.000Z" };
    const now = new Date("2026-08-13T12:23:00.000Z");
    const first = windowsToCollect(checkpoint, now);
    expect(first).toHaveLength(72);
    expect(first[0]?.start.toISOString()).toBe(checkpoint.window_end);
    expect(first.at(-1)?.end.toISOString()).toBe("2026-08-11T12:00:00.000Z");
    const firstBatchEnd = first.at(-1)!.end.toISOString();
    const second = windowsToCollect({ window_end: firstBatchEnd }, now);
    expect(second[0]?.start.toISOString()).toBe(firstBatchEnd);
    expect(second).toHaveLength(72);
  });
  it("collects aligned 20-minute windows and resumes from its checkpoint", () => {
    const windows = windowsToCollect(
      { window_end: "2026-08-13T11:40:00.000Z" },
      new Date("2026-08-13T12:23:00.000Z")
    );

    expect(windows).toEqual([
      {
        start: new Date("2026-08-13T11:40:00.000Z"),
        end: new Date("2026-08-13T12:00:00.000Z"),
      },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
    ]);
  });

  it("returns counts and useful error/warning samples", async () => {
    const urls: URL[] = [];
    const responses = [
      {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { level: "error" }, value: [0, "2"] },
            { metric: { level: "warning" }, value: [0, "1"] },
          ],
        },
      },
      {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { pod: "lobu-server-1", level: "error" },
              values: [["1", '{"level":"error","message":"DB pool failed"}']],
            },
            {
              stream: { pod: "lobu-worker-1", level: "warn" },
              values: [["2", '{"level":"warn","msg":"retrying run"}']],
            },
          ],
        },
      },
    ];
    const fetchImpl = async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json(responses.shift());
    };

    const result = await queryLokiActivity(
      {
        LOKI_URL: "https://loki.example.test",
        namespace: "lobu",
      },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      fetchImpl
    );

    expect(result).toEqual({
      errors: 2,
      warnings: 1,
      http_client_errors: 0,
      http_server_errors: 0,
      http_samples: [],
      error_samples: ["[lobu-server-1] DB pool failed"],
      warning_samples: ["[lobu-worker-1] retrying run"],
    });
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get("start")).toBe("1786622400000000000");
    expect(urls[1]?.searchParams.get("end")).toBe("1786623600000000000");
  });

  it("does not request samples when the window has no log activity", async () => {
    let calls = 0;
    const result = await queryLokiActivity(
      { LOKI_URL: "https://loki.example.test", namespace: "lobu" },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      async () => {
        calls += 1;
        return Response.json({
          status: "success",
          data: { resultType: "vector", result: [] },
        });
      }
    );

    expect(result).toEqual({
      errors: 0,
      warnings: 0,
      http_client_errors: 0,
      http_server_errors: 0,
      http_samples: [],
      error_samples: [],
      warning_samples: [],
    });
    expect(calls).toBe(1);
  });
  it("reports info-level HTTP failures separately and keeps severity samples", async () => {
    const urls: URL[] = [];
    const responses = [
      {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { level: "error" }, value: [0, "2"] },
            { metric: { level: "info", res_status: "400" }, value: [0, "60"] },
            { metric: { level: "info", res_status: "500" }, value: [0, "1"] },
          ],
        },
      },
      {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { pod: "server" },
              values: [
                [
                  "1",
                  JSON.stringify({
                    level: "error",
                    msg: "Database unavailable",
                  }),
                ],
              ],
            },
          ],
        },
      },
      {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { pod: "server" },
              values: [
                [
                  "2",
                  JSON.stringify({
                    level: "info",
                    msg: "Request completed",
                    req: {
                      method: "POST",
                      url: "/api/synthetic/entities?token=secret-query",
                      headers: { authorization: "secret-header" },
                    },
                    res: { status: 400 },
                  }),
                ],
                [
                  "3",
                  JSON.stringify({
                    level: "info",
                    msg: "Request completed",
                    req: { method: "GET", url: "/health" },
                    res: { status: 500 },
                  }),
                ],
              ],
            },
          ],
        },
      },
    ];
    const result = await queryLokiActivity(
      { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      async (input) => {
        urls.push(new URL(String(input)));
        return Response.json(responses.shift());
      }
    );
    expect(result).toMatchObject({
      errors: 2,
      warnings: 0,
      http_client_errors: 60,
      http_server_errors: 1,
      error_samples: ["[server] Database unavailable"],
      http_samples: [
        "[server] HTTP 400 POST /api/synthetic/entities",
        "[server] HTTP 500 GET /health",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(urls).toHaveLength(3);
    const query = urls[0]!.searchParams.get("query")!;
    expect(query).toContain('res_status=~"[45][0-9][0-9]"');
    expect(query).toContain(
      'res_status!~"401|404" or req_headers_authorization!="" or req_headers_cookie!=""'
    );
  });
  it("keeps a warning-level anonymous auth probe out of HTTP samples", async () => {
    const responses = [
      {
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: { level: "warn" }, value: [0, "1"] }],
        },
      },
      {
        status: "success",
        data: {
          resultType: "streams",
          result: [
            {
              stream: { pod: "server" },
              values: [
                [
                  "1",
                  JSON.stringify({
                    level: "warn",
                    req: { method: "POST", url: "/mcp?token=secret" },
                    res: { status: 401 },
                  }),
                ],
              ],
            },
          ],
        },
      },
    ];
    const result = await queryLokiActivity(
      { LOKI_URL: "https://loki.example.test", namespace: "synthetic" },
      {
        start: new Date("2026-08-13T12:00:00.000Z"),
        end: new Date("2026-08-13T12:20:00.000Z"),
      },
      async () => Response.json(responses.shift())
    );
    expect(result).toMatchObject({
      warnings: 1,
      http_client_errors: 0,
      http_server_errors: 0,
      warning_samples: ["[server] HTTP 401 POST /mcp"],
      http_samples: [],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
