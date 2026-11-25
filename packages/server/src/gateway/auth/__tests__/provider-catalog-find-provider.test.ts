import { describe, expect, test } from "bun:test";
import { ProviderCatalogService } from "../provider-catalog.js";

/**
 * findProviderForModel routes a stored `<providerId>/<model>` ref by its
 * leading segment only — it never consults a provider's live model list, so a
 * slow or empty listing can never mis-route a turn to another provider.
 *
 * findProviderForModel reads only its arguments (never `this`), so we exercise
 * the real method with injected fake provider modules — no store/auth/registry
 * wiring required.
 */
describe("ProviderCatalogService.findProviderForModel — prefix routing", () => {
  const catalog = new ProviderCatalogService({} as never, {} as never);
  const providers = [
    { providerId: "gemini" },
    { providerId: "claude" },
    { providerId: "openrouter" },
  ] as never;

  test("routes a prefixed ref to the provider it names, not the first listed", async () => {
    const picked = await catalog.findProviderForModel(
      "claude/synthetic-model",
      providers
    );
    expect(picked?.providerId).toBe("claude");
  });

  test("a provider-native id with its own slashes routes by the first segment", async () => {
    const picked = await catalog.findProviderForModel(
      "openrouter/claude/synthetic-model",
      providers
    );
    expect(picked?.providerId).toBe("openrouter");
  });

  test("an unknown prefix or a bare id resolves to no provider", async () => {
    expect(
      await catalog.findProviderForModel("mystery/model-x", providers)
    ).toBeUndefined();
    expect(
      await catalog.findProviderForModel("gemini", providers)
    ).toBeUndefined();
  });

  test("a restriction sentinel never routes", async () => {
    expect(
      await catalog.findProviderForModel("claude/__unresolved__", providers)
    ).toBeUndefined();
  });
});
