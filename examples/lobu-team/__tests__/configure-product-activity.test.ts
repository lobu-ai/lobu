import { describe, expect, test } from "bun:test";
import { productActivityConfiguration } from "../product-activity-digest.prompt";

describe("external production digest configuration", () => {
  test("rejects unsafe selectors and ambiguous bootstrap timestamps before configuration", () => {
    const settings = {
      namespace: "synthetic-production",
      logStart: "2026-10-01T00:00:00.000Z",
      productStart: "2026-10-01T00:00:00.000Z",
    };
    for (const id of [
      "0",
      "-1",
      "1 OR 1=1",
      "42; SELECT 1",
      "9007199254740992",
      "42.0",
    ])
      expect(() => productActivityConfiguration(id, settings)).toThrow();
    for (const namespace of [
      "x' OR 1=1 --",
      "x\\'",
      "UPPER",
      "-start",
      "end-",
      "x".repeat(64),
    ])
      expect(() =>
        productActivityConfiguration("42", { ...settings, namespace })
      ).toThrow();
    for (const logStart of [
      "invalid",
      "2026-10-01T00:01:00.000Z",
      "2026-10-01T00:00:00+01:00",
      "2026-10-01",
    ])
      expect(() =>
        productActivityConfiguration("42", { ...settings, logStart })
      ).toThrow();
    expect(() => productActivityConfiguration("42", settings)).not.toThrow();
  });
});
