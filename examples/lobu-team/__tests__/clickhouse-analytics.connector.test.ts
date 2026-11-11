import { describe, expect, it } from "bun:test";
import type { QueryContext } from "@lobu/connector-sdk";
import {
  queryAnalytics,
  readOnlyQuery,
} from "../clickhouse-analytics.connector.ts";
import { readUserMilestones } from "../user-milestones.ts";

describe("source-backed user milestones", () => {
  it("pages exact milestones through HTTP without leaking source extras or mixing accounts", async () => {
    const user = "synthetic-user";
    let sourceUser = user;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          meta: [
            "origin_id",
            "user_id",
            "occurred_at",
            "title",
            "payload_text",
            "private_extra",
            "__lobu_analytics_total__",
          ].map((name) => ({ name, type: "String" })),
          data: ["signup", "landing", "first-success"].map((kind) => ({
            origin_id: `${kind}:${user}`,
            user_id: sourceUser,
            occurred_at: "2026-01-02 03:04:05.123",
            title: kind,
            payload_text: "Recorded milestone",
            private_extra: "must-not-leak",
            __lobu_analytics_total__: "3",
          })),
        }),
    });
    const context = {
      feedKey: "user_milestones",
      config: { CLICKHOUSE_URL: "https://analytics.example.test" },
      credentials: null,
      match: { path: "metadata.user_id", values: [user] },
      limit: 1,
    };
    const read = (ctx: Parameters<typeof readUserMilestones>[0]) =>
      readUserMilestones(ctx, (query) =>
        queryAnalytics(query, (_url, init) => fetch(server.url, init))
      );
    try {
      const first = await read(context);
      const second = await read({ ...context, cursor: first.nextCursor });
      const last = await read({ ...context, cursor: second.nextCursor });
      const rows = [...first.rows, ...second.rows, ...last.rows];
      expect(new Set(rows.map((row) => row.origin_id)).size).toBe(3);
      expect(last.hasMore).toBe(false);
      expect(last.nextCursor).toBeUndefined();
      expect(
        rows.every((row) => row.occurred_at === "2026-01-02T03:04:05.123Z")
      ).toBe(true);
      expect(
        rows.every(
          (row) => (row.metadata as { user_id: string }).user_id === user
        )
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("must-not-leak");
      expect(first.rowCursors).toEqual([first.nextCursor!]);
      await expect(
        read({
          ...context,
          cursor: first.nextCursor,
          match: { path: "metadata.user_id", values: ["another-user"] },
        })
      ).rejects.toThrow("cursor");
      await expect(read({ ...context, match: undefined })).rejects.toThrow(
        "one exact"
      );
      sourceUser = "another-user";
      await expect(read(context)).rejects.toThrow("projection");
    } finally {
      server.stop(true);
    }
  });
});

describe("ClickHouse SQL boundary", () => {
  for (const sql of [
    "SELECT 1; DROP TABLE telemetry",
    "WITH x AS (SELECT 1) INSERT INTO telemetry SELECT * FROM x",
    "SELECT 1 INTO OUTFILE '/tmp/out'",
    "SELECT 1 SETTINGS readonly=0",
    "SELECT 1 FORMAT CSV",
    "SET readonly=0",
    "SELECT 1); SELECT 2 --",
    "SELECT 'unterminated",
    "SELECT 1 /* unclosed",
    "SELECT (1",
    "SELECT 1\0",
    "SELECT 1 AS __lobu_analytics_total__",
    'SELECT 1 AS "__lobu_analytics_total__"',
    "SELECT 1 AS `__lobu_analytics_total__`",
    "SELECT $$'$$ SETTINGS readonly=0 --'",
    "SELECT $t$'$t$ AS x FORMAT CSV --'",
  ])
    it(`refuses ${JSON.stringify(sql)}`, () =>
      expect(() => readOnlyQuery(sql)).toThrow());

  for (const sql of [
    "SELECT 'SETTINGS; INSERT INTO x' AS label",
    "SELECT 'escaped\\'quote' AS label",
    'SELECT "format", `settings` FROM telemetry',
    "/* outer /* nested */ comment */ SELECT 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "(SELECT 1) UNION ALL (SELECT 2)",
    "-- query\nSELECT 1 # SETTINGS readonly=0",
  ])
    it(`accepts a wrapped read ${JSON.stringify(sql)}`, () =>
      expect(readOnlyQuery(sql)).toBe(sql));

  it("counts bytes before accepting SQL", () => {
    expect(() => readOnlyQuery(`SELECT '${"é".repeat(33000)}'`)).toThrow(
      "UTF-8"
    );
  });
});

describe("ClickHouse query HTTP boundary", () => {
  const context = (
    query: string
  ): QueryContext<{ CLICKHOUSE_URL: string }> => ({
    query,
    config: { CLICKHOUSE_URL: "https://analytics.example.test" },
    credentials: null,
  });
  const total = "__lobu_analytics_total__";

  it("preserves lossless source values and removes the pagination count", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          meta: [
            { name: "id", type: "UInt64" },
            { name: "amount", type: "Decimal(38, 8)" },
            { name: total, type: "UInt64" },
          ],
          data: [
            {
              id: "18446744073709551615",
              amount: "12345678901234567890.12345678",
              [total]: "1",
            },
          ],
        }),
    });
    try {
      const result = await queryAnalytics(
        context("SELECT id, amount FROM telemetry"),
        (_url, init) => fetch(server.url, init)
      );
      expect(result).toEqual({
        rows: [
          {
            id: "18446744073709551615",
            amount: "12345678901234567890.12345678",
          },
        ],
        columns: [
          { name: "id", type: "UInt64" },
          { name: "amount", type: "Decimal(38, 8)" },
        ],
        total: 1,
      });
    } finally {
      server.stop(true);
    }
  });

  it("does not relay credential-bearing upstream errors", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("Authorization: Bearer synthetic-secret", { status: 403 }),
    });
    try {
      await expect(
        queryAnalytics(context("SELECT 1"), (_url, init) =>
          fetch(server.url, init)
        )
      ).rejects.toMatchObject({
        status: 403,
        message: "Analytics query failed (HTTP 403)",
      });
    } finally {
      server.stop(true);
    }
  });

  it("relays a ClickHouse query exception with its status", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          "Code: 47. DB::Exception: Unknown expression identifier `no_such_column` in scope SELECT no_such_column FROM telemetry. (UNKNOWN_IDENTIFIER) (version 25.3.1.1 (official build))\n",
          { status: 404, headers: { "X-ClickHouse-Exception-Code": "47" } }
        ),
    });
    try {
      const error = await queryAnalytics(
        context("SELECT no_such_column FROM telemetry"),
        (_url, init) => fetch(server.url, init)
      ).then(
        () => null,
        (thrown: unknown) => thrown
      );
      expect(error).toMatchObject({
        status: 404,
        message:
          "Analytics query failed: Unknown expression identifier `no_such_column` in scope SELECT no_such_column FROM telemetry. (UNKNOWN_IDENTIFIER)",
      });
    } finally {
      server.stop(true);
    }
  });

  it("rejects an oversized streamed response and inconsistent totals", async () => {
    await expect(
      queryAnalytics(
        context("SELECT 1"),
        async () => new Response("x".repeat(2097153))
      )
    ).rejects.toThrow("2 MiB");
    await expect(
      queryAnalytics(context("SELECT 1"), async () =>
        Response.json({
          meta: [{ name: total, type: "UInt64" }],
          data: [{ [total]: "9007199254740993" }],
        })
      )
    ).rejects.toThrow("supported range");
    await expect(
      queryAnalytics(context("SELECT 1"), async () =>
        Response.json({
          meta: [{ name: total, type: "UInt64" }],
          data: [{ [total]: "0" }],
        })
      )
    ).rejects.toThrow("inconsistent");
  });

  it("clamps metric-sized pages to 500 rows and keeps the source total", async () => {
    let statement = "";
    const result = await queryAnalytics(
      { ...context("SELECT 1"), limit: 5000 },
      async (_url, init) => {
        statement = String(init?.body);
        return Response.json({
          meta: [{ name: total, type: "UInt64" }],
          data: [{ [total]: "2000" }],
        });
      }
    );
    expect(statement).toContain("LIMIT 500 OFFSET 0");
    expect(result.total).toBe(2000);
  });

  it("rejects unsupported routing, sort and pagination before source access", async () => {
    const fail = async (): Promise<Response> => {
      throw new Error("unexpected source access");
    };
    for (const url of [
      "http://analytics.example.test",
      "https://name:password@analytics.example.test",
      "https://analytics.example.test/?user=ingest",
      "https://analytics.example.test/path",
    ]) {
      await expect(
        queryAnalytics(
          { ...context("SELECT 1"), config: { CLICKHOUSE_URL: url } },
          fail
        )
      ).rejects.toThrow("HTTPS origin");
    }
    await expect(
      queryAnalytics({ ...context("SELECT 1"), offset: 10001 }, fail)
    ).rejects.toThrow("Pagination");
    for (const limit of [0, -1, 1.5, 5000.5, Infinity, NaN]) {
      await expect(
        queryAnalytics({ ...context("SELECT 1"), limit }, fail)
      ).rejects.toThrow("Pagination");
    }
    await expect(
      queryAnalytics(
        { ...context("SELECT 1"), sort: { column: "id; DROP", order: "asc" } },
        fail
      )
    ).rejects.toThrow("sort column");
  });
});
