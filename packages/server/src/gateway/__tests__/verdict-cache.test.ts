import { describe, expect, test } from "bun:test";
import { VerdictCache } from "../inference/verdict-cache.js";

describe("VerdictCache", () => {
  test("returns undefined for unknown keys", () => {
    const cache = new VerdictCache<string>(60_000, 100);
    expect(cache.get("nope")).toBeUndefined();
  });

  test("stores and retrieves a verdict", () => {
    const cache = new VerdictCache<{ verdict: string; reason: string }>(60_000, 100);
    const key = "org-1:abc";
    cache.set(key, { verdict: "allow", reason: "ok" });
    expect(cache.get(key)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("expires entries after the TTL", async () => {
    const cache = new VerdictCache<{ verdict: string; reason: string }>(10, 100);
    const key = "org-1:h";
    cache.set(key, { verdict: "allow", reason: "ok" });
    expect(cache.get(key)).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(key)).toBeUndefined();
  });

  test("evicts the oldest entry when over capacity", () => {
    const cache = new VerdictCache<{ verdict: string; reason: string }>(60_000, 2);
    cache.set("a", { verdict: "allow", reason: "" });
    cache.set("b", { verdict: "allow", reason: "" });
    cache.set("c", { verdict: "allow", reason: "" });
    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  test("LRU touch keeps recently-read entries alive under pressure", () => {
    const cache = new VerdictCache<{ verdict: string; reason: string }>(60_000, 2);
    cache.set("a", { verdict: "allow", reason: "" });
    cache.set("b", { verdict: "allow", reason: "" });
    // Touch a — now b is the oldest.
    cache.get("a");
    cache.set("c", { verdict: "allow", reason: "" });
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });
});
