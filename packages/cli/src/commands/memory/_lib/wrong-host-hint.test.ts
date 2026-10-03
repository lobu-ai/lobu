import { describe, expect, test } from "bun:test";
import { wrongHostHint } from "./errors.js";

describe("wrongHostHint", () => {
  test("explains the missing-memoryUrl fallback only for 405", () => {
    expect(wrongHostHint(405)).toContain("no memoryUrl");
    expect(wrongHostHint(405)).toContain("https://lobu.ai/mcp");
    expect(wrongHostHint(404)).toBe("");
    expect(wrongHostHint(500)).toBe("");
  });
});
