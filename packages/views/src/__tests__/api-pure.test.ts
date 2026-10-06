import { describe, expect, test } from "bun:test";
import {
  coerceParams,
  coerceScope,
  defaultsFor,
  defineView,
  escapeLiteral,
  mintInteractionId,
  queryResult,
  sql,
  tool,
} from "../api.js";

const DEF = defineView({
  key: "pipeline",
  attach: [{ type: "deal" }],
  params: {
    by: { type: "string", default: "owner" },
    limit: { type: "number", default: 50 },
    open: { type: "boolean", default: true },
  },
  actions: { markWon: { emits: "deal.won" } },
});

describe("defineView", () => {
  test("requires a key and an attach array", () => {
    expect(() => defineView({ key: "", attach: [] })).toThrow("non-empty key");
    expect(() =>
      defineView({ key: "ok", attach: "deal" as unknown as [] })
    ).toThrow("attach to be an array");
  });
});

describe("sql escaping", () => {
  test("renders scalars as literals, never raw", () => {
    const q = sql`SELECT * FROM deal WHERE stage = ${"open"} AND amount > ${10} AND won = ${false}`;
    expect(q.text).toBe(
      "SELECT * FROM deal WHERE stage = 'open' AND amount > 10 AND won = FALSE"
    );
  });

  test("doubles single quotes so a hostile string cannot break out", () => {
    const hostile = `' OR '1'='1`;
    const q = sql`SELECT * FROM deal WHERE name = ${hostile}`;
    expect(q.text).toBe(`SELECT * FROM deal WHERE name = ''' OR ''1''=''1'`);
    expect(q.text).not.toContain("' OR '1'='1");
  });

  test("null becomes NULL; non-finite numbers and objects throw", () => {
    expect(sql`SELECT ${null}`.text).toBe("SELECT NULL");
    expect(() => sql`SELECT ${Number.NaN}`).toThrow("finite numbers");
    expect(() => sql`SELECT ${Infinity}`).toThrow("finite numbers");
    expect(() => sql`SELECT ${{ a: 1 }}`).toThrow(
      "only string, number, boolean, null"
    );
    expect(() => sql`SELECT ${[1]}`).toThrow(
      "only string, number, boolean, null"
    );
  });

  test("escapeLiteral maps booleans to TRUE/FALSE", () => {
    expect(escapeLiteral(true)).toBe("TRUE");
    expect(escapeLiteral(false)).toBe("FALSE");
    expect(escapeLiteral(undefined)).toBe("NULL");
  });
});

describe("tool()", () => {
  test("requires a name and defaults args", () => {
    expect(tool("manage_connections", { action: "list" })).toEqual({
      kind: "tool",
      name: "manage_connections",
      args: { action: "list" },
    });
    expect(tool("query_sdk")).toEqual({
      kind: "tool",
      name: "query_sdk",
      args: {},
    });
    expect(() => tool("")).toThrow("requires a tool name");
  });
});

describe("mintInteractionId", () => {
  test("mints a unique non-empty id per click", () => {
    const a = mintInteractionId();
    const b = mintInteractionId();
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("params", () => {
  test("defaultsFor picks up declared defaults only", () => {
    expect(defaultsFor(DEF)).toEqual({ by: "owner", limit: 50, open: true });
    expect(defaultsFor(defineView({ key: "bare", attach: [] }))).toEqual({});
  });

  test("coerceParams ignores unknown names and keeps defaults on mismatch", () => {
    const out = coerceParams(DEF, {
      by: "stage",
      limit: "25",
      open: "true",
      evil: "1=1",
      view: "x",
    });
    expect(out).toEqual({ by: "stage", limit: 25, open: true });
    // "evil" and "view" are undeclared: dropped, never reach SQL or the URL.
    expect("evil" in out).toBe(false);
  });

  test("a non-numeric number falls back to its default", () => {
    expect(coerceParams(DEF, { limit: "lots" })).toEqual({
      by: "owner",
      limit: 50,
      open: true,
    });
  });

  test("non-object input yields defaults", () => {
    expect(coerceParams(DEF, null)).toEqual({
      by: "owner",
      limit: 50,
      open: true,
    });
    expect(coerceParams(DEF, "owner")).toEqual({
      by: "owner",
      limit: 50,
      open: true,
    });
  });
});

describe("queryResult", () => {
  test("a rejected SQL statement is an error, not an empty result", () => {
    // query_sql answers an unknown table with a normal result: rows: [] plus
    // `error`. Reading only `rows` rendered it as "no matching records".
    expect(
      queryResult("sql", {
        structuredContent: { rows: [], error: "Unknown table 'entity_types'" },
      })
    ).toEqual({
      data: null,
      error: "Unknown table 'entity_types'",
      errorCode: null,
      truncated: false,
    });
  });

  test("rows come back when the statement ran", () => {
    expect(
      queryResult("sql", { structuredContent: { rows: [{ n: 1 }] } })
    ).toEqual({
      data: [{ n: 1 }],
      error: null,
      errorCode: null,
      truncated: false,
    });
  });

  test("a failed query script is an error", () => {
    expect(
      queryResult("sdk", {
        structuredContent: {
          success: false,
          error: { name: "E", message: "boom" },
        },
      })
    ).toEqual({ data: null, error: "boom", errorCode: null, truncated: false });
    expect(
      queryResult("sdk", {
        structuredContent: { success: true, return_value: 3 },
      })
    ).toEqual({ data: 3, error: null, errorCode: null, truncated: false });
  });

  test("a named tool's body is data, even one with an error field", () => {
    const body = { error: "domain value", items: [] };
    expect(queryResult("tool", { structuredContent: body })).toEqual({
      data: body,
      error: null,
      errorCode: null,
      truncated: false,
    });
  });

  test("a host-reported tool error wins", () => {
    expect(
      queryResult("sql", {
        isError: true,
        content: [{ type: "text", text: "denied" }],
      })
    ).toEqual({
      data: null,
      error: "denied",
      errorCode: null,
      truncated: false,
    });
  });
});

describe("queryResult guardrails", () => {
  test("a capped query_sql page is flagged truncated, never silently short", () => {
    // query_sql caps a page at 500 rows and reports the rest via has_more.
    const rows = Array.from({ length: 500 }, (_, i) => ({ n: i }));
    const out = queryResult("sql", {
      structuredContent: { rows, has_more: true, total_count: 1200 },
    });
    expect(out.data).toEqual(rows);
    expect(out.truncated).toBe(true);
    expect(out.errorCode).toBeNull();
  });

  test("a complete query_sql page is not truncated", () => {
    const out = queryResult("sql", {
      structuredContent: { rows: [{ n: 1 }], has_more: false, total_count: 1 },
    });
    expect(out.truncated).toBe(false);
  });

  test("a statement timeout carries its typed code", () => {
    const out = queryResult("sql", {
      structuredContent: {
        rows: [],
        error: "Query exceeded the 5 second timeout.",
        error_code: "UPSTREAM_TIMEOUT",
        retryable: true,
      },
    });
    expect(out).toEqual({
      data: null,
      error: "Query exceeded the 5 second timeout.",
      errorCode: "UPSTREAM_TIMEOUT",
      truncated: false,
    });
  });

  test.each([
    "sql",
    "sdk",
  ] as const)("%s preserves typed failures when MCP marks them isError", (kind) => {
    const body =
      kind === "sql"
        ? { rows: [], error: "slow", error_code: "UPSTREAM_TIMEOUT" }
        : {
            success: false,
            error: { name: "Error", message: "slow", code: "UPSTREAM_TIMEOUT" },
          };
    for (const structuredContent of [body, undefined]) {
      expect(
        queryResult(kind, {
          isError: true,
          structuredContent,
          content: [{ type: "text", text: JSON.stringify(body) }],
        })
      ).toEqual({
        data: null,
        error: "slow",
        errorCode: "UPSTREAM_TIMEOUT",
        truncated: false,
      });
    }
  });

  test.each([
    "sql",
    "sdk",
    "tool",
  ] as const)("%s preserves a thrown MCP tool error's structured code", (kind) => {
    expect(
      queryResult(kind, {
        isError: true,
        structuredContent: { error: { code: "FORBIDDEN", retryable: false } },
        content: [{ type: "text", text: "denied" }],
      })
    ).toEqual({
      data: null,
      error: "denied",
      errorCode: "FORBIDDEN",
      truncated: false,
    });
  });

  test("a query script's typed code and output cap come through", () => {
    expect(
      queryResult("sdk", {
        structuredContent: {
          success: false,
          error: { name: "E", message: "slow", code: "UPSTREAM_TIMEOUT" },
        },
      }).errorCode
    ).toBe("UPSTREAM_TIMEOUT");
    const capped = queryResult("sdk", {
      structuredContent: {
        success: true,
        return_value_preview: '[{"n":1',
        return_truncated: { total_bytes: 900000, kept_bytes: 1000 },
      },
    });
    expect(capped.data).toBeNull();
    expect(capped.error).toBeNull();
    expect(capped.truncated).toBe(true);
  });
});

describe("coerceScope", () => {
  test("keeps collection context separate from record and event scopes", () => {
    const collection = {
      search: "Alpha",
      filters: [{ field: "tier", op: "eq", value: "large" }],
    };
    expect(coerceScope({ type: "account", collection })).toEqual({
      type: "account",
      collection,
    });
    for (const scope of [
      { collection },
      { type: "account", entity: "alpha", collection },
      { type: "account", event: 7, collection },
    ]) {
      expect(() => coerceScope(scope)).toThrow(/Collection/);
    }
    expect(() =>
      coerceScope({ type: "account", collection: "invalid" })
    ).toThrow();
    const raw = { filters: [{ field: "tier", op: "unknown", value: 1 }] };
    expect(
      coerceScope({ type: "account", collection: raw }).collection
    ).toEqual(raw);
  });
  test("keeps an event subject: the host seeds scope.event on an event page", () => {
    expect(coerceScope({ event: 4309390 })).toEqual({ event: 4309390 });
    expect(coerceScope({ type: "deal", entity: 7 })).toEqual({
      type: "deal",
      entity: 7,
    });
  });

  test("drops an event id that is not an integer", () => {
    expect(coerceScope({ event: "4309390" })).toEqual({});
    expect(coerceScope({ event: 1.5 })).toEqual({});
    expect(coerceScope(null)).toEqual({});
  });
});
