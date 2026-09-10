import { describe, expect, it } from "bun:test";
import { normalizePageActivationUrl, normalizePageActivationUrls, supportsExactPageActivation } from "../../runs/page-activation";
import { normalizePageUrl } from "../../../../owletto/apps/chrome/page-url.js";

describe("exact page URL identity on server and Chrome", () => {
  it.each([
    ["HTTPS://EXAMPLE.TEST:443/item?id=111", "https://example.test/item?id=111"],
    ["http://EXAMPLE.TEST:80/", "http://example.test/"],
    ["https://example.test/item?b=2&a=1&a=3", "https://example.test/item?b=2&a=1&a=3"],
    ["https://example.test/item?id=%2F&value=a+b", "https://example.test/item?id=%2F&value=a+b"],
    ["https://example.test/item/#resource", "https://example.test/item/#resource"],
  ])("canonicalizes %s consistently", (input, expected) => {
    expect(normalizePageActivationUrl(input)).toBe(expected);
    expect(normalizePageUrl(input)).toBe(expected);
  });
  it.each([
    ["?id=111", "?id=222"], ["?a=1&b=2", "?b=2&a=1"],
    ["?a=1&a=2", "?a=2&a=1"], ["?id=%2F", "?id=/"],
    ["#one", "#two"], ["", "/"],
  ])("does not collapse potentially distinct targets %s and %s", (a, b) => {
    for (const normalize of [normalizePageActivationUrl, normalizePageUrl]) {
      expect(normalize(`https://example.test/item${a}`)).not.toBe(normalize(`https://example.test/item${b}`));
    }
  });
  it.each(["invalid", "file:///tmp/item", "javascript:void(0)"])("rejects %s", (input) => {
    expect(() => normalizePageActivationUrl(input)).toThrow();
    expect(normalizePageUrl(input)).toBeNull();
  });
  it("bounds and deduplicates targets", () => {
    expect(normalizePageActivationUrls(["https://EXAMPLE.TEST:443/", "https://example.test/"])).toEqual(["https://example.test/"]);
    expect(() => normalizePageActivationUrls([])).toThrow();
    expect(() => normalizePageActivationUrls(Array.from({ length: 9 }, (_, i) => `https://example.test/${i}`))).toThrow();
  });
  it.each([null, "", "garbage", "0.6.0", "0.5.99"])("rejects an incompatible extension %s", (version) => {
    expect(supportsExactPageActivation(version)).toBe(false);
  });
  it.each(["0.6.1", "0.6.1.1", "0.7.0", "1.0.0"])("accepts a compatible extension %s", (version) => {
    expect(supportsExactPageActivation(version)).toBe(true);
  });
});
