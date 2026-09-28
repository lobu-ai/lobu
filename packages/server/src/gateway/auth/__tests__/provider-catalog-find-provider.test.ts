import { describe, expect, test } from "bun:test";
import { ProviderCatalogService } from "../provider-catalog.js";

describe("ProviderCatalogService.findProviderForModel", () => {
  const catalog = new ProviderCatalogService({} as never, {} as never);
  const providers = ["claude", "openrouter", "custom-endpoint"].map(providerId => ({
    providerId,
    getModelOptions: async () => { throw new Error("Discovery must not participate in routing"); },
  })) as never;

  test.each([
    ["claude/claude-sonnet-5", "claude"],
    ["openrouter/anthropic/claude-sonnet-5", "openrouter"],
    ["custom-endpoint/private-model", "custom-endpoint"],
  ])("routes %s directly to %s", async (ref, expected) => {
    expect((await catalog.findProviderForModel(ref, providers))?.providerId).toBe(expected);
  });

  test.each(["claude-sonnet-5", "unknown/model", "claude/", "claude/__unresolved__"])(
    "rejects an unqualified, unknown or unresolved reference: %s", async ref => {
      expect(await catalog.findProviderForModel(ref, providers)).toBeUndefined();
    }
  );
});
