import { describe, expect, test } from "bun:test";
import { VerdictCache } from "../proxy/egress-judge/cache.js";

describe("VerdictCache", () => {
  test("returns undefined for unknown keys", () => {
    const cache = new VerdictCache(60_000, 100);
    expect(cache.get("nope")).toBeUndefined();
  });

  test("stores and retrieves a verdict", () => {
    const cache = new VerdictCache(60_000, 100);
    const key = VerdictCache.key({
      orgId: "org-1",
      policyHash: "abc",
      hostname: "example.com",
      method: "GET",
      path: "/",
    });
    cache.set(key, { verdict: "allow", reason: "ok" });
    expect(cache.get(key)).toEqual({ verdict: "allow", reason: "ok" });
  });

  test("key is case-insensitive for hostname and method", () => {
    const a = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "Example.COM",
      method: "get",
    });
    const b = VerdictCache.key({
      orgId: "org-1",
      policyHash: "h",
      hostname: "example.com",
      method: "GET",
    });
    expect(a).toBe(b);
  });

  test("different policy hashes do not collide", () => {
    const a = VerdictCache.key({ orgId: "org-1", policyHash: "h1", hostname: "x.com" });
    const b = VerdictCache.key({ orgId: "org-1", policyHash: "h2", hostname: "x.com" });
    expect(a).not.toBe(b);
  });

  test("different orgIds do not collide even for identical policy+request", () => {
    const a = VerdictCache.key({ orgId: "org-a", policyHash: "h", hostname: "x.com" });
    const b = VerdictCache.key({ orgId: "org-b", policyHash: "h", hostname: "x.com" });
    expect(a).not.toBe(b);
  });

  test("a field's content cannot bleed into its neighbour", () => {
    const a = VerdictCache.key({ orgId: "org|h", policyHash: "x", hostname: "x.com" });
    const b = VerdictCache.key({ orgId: "org", policyHash: "h|x", hostname: "x.com" });
    expect(a).not.toBe(b);
  });

  test("expires entries after the TTL", async () => {
    const cache = new VerdictCache(10, 100);
    const key = VerdictCache.key({ orgId: "org-1", policyHash: "h", hostname: "x.com" });
    cache.set(key, { verdict: "allow", reason: "ok" });
    expect(cache.get(key)).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get(key)).toBeUndefined();
  });

  test("evicts the oldest entry when over capacity", () => {
    const cache = new VerdictCache(60_000, 2);
    cache.set("a", { verdict: "allow", reason: "" });
    cache.set("b", { verdict: "allow", reason: "" });
    cache.set("c", { verdict: "allow", reason: "" });
    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  test("LRU touch keeps recently-read entries alive under pressure", () => {
    const cache = new VerdictCache(60_000, 2);
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
