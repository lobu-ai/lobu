import { describe, expect, test } from "bun:test";
import { coerceParams, defaultsFor, defineView, escapeLiteral, mintInteractionId, sql, tool } from "../api.js";

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
    expect(q.text).toBe("SELECT * FROM deal WHERE stage = 'open' AND amount > 10 AND won = FALSE");
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
    expect(() => sql`SELECT ${{ a: 1 }}`).toThrow("only string, number, boolean, null");
    expect(() => sql`SELECT ${[1]}`).toThrow("only string, number, boolean, null");
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
    expect(tool("query_sdk")).toEqual({ kind: "tool", name: "query_sdk", args: {} });
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
    const out = coerceParams(DEF, { by: "stage", limit: "25", open: "true", evil: "1=1", view: "x" });
    expect(out).toEqual({ by: "stage", limit: 25, open: true });
    // "evil" and "view" are undeclared: dropped, never reach SQL or the URL.
    expect("evil" in out).toBe(false);
  });

  test("a non-numeric number falls back to its default", () => {
    expect(coerceParams(DEF, { limit: "lots" })).toEqual({ by: "owner", limit: 50, open: true });
  });

  test("non-object input yields defaults", () => {
    expect(coerceParams(DEF, null)).toEqual({ by: "owner", limit: 50, open: true });
    expect(coerceParams(DEF, "owner")).toEqual({ by: "owner", limit: 50, open: true });
  });
});
