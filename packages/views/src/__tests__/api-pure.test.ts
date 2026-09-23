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
    ).toEqual({ data: null, error: "Unknown table 'entity_types'" });
  });

  test("rows come back when the statement ran", () => {
    expect(
      queryResult("sql", { structuredContent: { rows: [{ n: 1 }] } })
    ).toEqual({ data: [{ n: 1 }], error: null });
  });

  test("a failed query script is an error", () => {
    expect(
      queryResult("sdk", {
        structuredContent: {
          success: false,
          error: { name: "E", message: "boom" },
        },
      })
    ).toEqual({ data: null, error: "boom" });
    expect(
      queryResult("sdk", {
        structuredContent: { success: true, return_value: 3 },
      })
    ).toEqual({ data: 3, error: null });
  });

  test("a named tool's body is data, even one with an error field", () => {
    const body = { error: "domain value", items: [] };
    expect(queryResult("tool", { structuredContent: body })).toEqual({
      data: body,
      error: null,
    });
  });

  test("a host-reported tool error wins", () => {
    expect(
      queryResult("sql", {
        isError: true,
        content: [{ type: "text", text: "denied" }],
      })
    ).toEqual({ data: null, error: "denied" });
  });
});

describe("coerceScope", () => {
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
