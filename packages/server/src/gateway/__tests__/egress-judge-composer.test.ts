import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../proxy/egress-judge/verdict-parser.js";

describe("parseVerdict", () => {
  test("accepts a clean allow verdict", () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: "allow", reason: "within policy" })
      )
    ).toEqual({ verdict: "allow", reason: "within policy" });
  });

  test("accepts a clean deny verdict", () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: "deny", reason: "unknown domain" })
      )
    ).toEqual({ verdict: "deny", reason: "unknown domain" });
  });

  test("strips surrounding code fences", () => {
    const raw = '```json\n{"verdict":"allow","reason":"ok"}\n```';
    expect(parseVerdict(raw)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("supplies a placeholder reason when the model omits one", () => {
    expect(parseVerdict(JSON.stringify({ verdict: "allow" }))).toEqual({
      verdict: "allow",
      reason: "(no reason given)",
    });
  });

  test("throws when verdict is not allow/deny", () => {
    expect(() =>
      parseVerdict(JSON.stringify({ verdict: "maybe", reason: "x" }))
    ).toThrow();
  });

  test("throws on non-JSON output", () => {
    expect(() => parseVerdict("not json at all")).toThrow();
  });

  test("throws when the response is an array instead of an object", () => {
    expect(() => parseVerdict("[]")).toThrow();
  });

  test("extracts JSON from prose when the judge ignores the fixed format", () => {
    const raw =
      'Here is my analysis. The request looks fine: {"verdict":"allow","reason":"ok"}. Done.';
    expect(parseVerdict(raw)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("handles unfenced JSON with leading/trailing whitespace", () => {
    const raw = '\n\n  {"verdict":"deny","reason":"off-policy"}  \n';
    expect(parseVerdict(raw)).toEqual({
      verdict: "deny",
      reason: "off-policy",
    });
  });

  test("still rejects prose with no verdict JSON at all", () => {
    expect(() =>
      parseVerdict("I am unable to decide without more context.")
    ).toThrow();
  });
});
