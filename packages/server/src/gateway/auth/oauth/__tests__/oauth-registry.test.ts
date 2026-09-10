import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderConfigEntry, ProvidersConfigFile } from "@lobu/core";
import { REFRESHABLE_AUTH_TYPES } from "../../settings/user-auth-profile-store.js";
import { buildOAuthRefreshers } from "../client.js";
import { grantStrategyFor } from "../grant-strategy.js";
import {
  clearOAuthProviderRegistry,
  getOAuthProviderConfig,
  listOAuthProviders,
  loadOAuthProvidersFromConfigs,
} from "../providers.js";

function loadProvidersJson(): Record<string, ProviderConfigEntry> {
  const candidates = [
    path.resolve(process.cwd(), "config/providers.json"),
    path.resolve(process.cwd(), "../../config/providers.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as ProvidersConfigFile;
      const map: Record<string, ProviderConfigEntry> = {};
      for (const entry of raw.providers) {
        const first = entry.providers?.[0];
        if (first) map[entry.id] = first;
      }
      return map;
    } catch {
      /* try next */
    }
  }
  throw new Error("config/providers.json not found for registry test");
}

describe("OAuth registry from providers.json", () => {
  beforeEach(() => {
    clearOAuthProviderRegistry();
  });
  afterEach(() => {
    clearOAuthProviderRegistry();
  });

  test("loads claude, chatgpt, xai oauth blocks from config", () => {
    const configs = loadProvidersJson();
    const loaded = loadOAuthProvidersFromConfigs(configs);
    const ids = loaded.map((p) => p.id).sort();
    expect(ids).toContain("claude");
    expect(ids).toContain("chatgpt");
    expect(ids).toContain("xai");

    expect(getOAuthProviderConfig("claude")?.grant).toBe("authorization-code");
    expect(getOAuthProviderConfig("claude")?.defaultModel).toBe(
      configs.claude?.defaultModel
    );
    expect(getOAuthProviderConfig("chatgpt")?.grant).toBe("openai-device-auth");
    expect(getOAuthProviderConfig("xai")?.grant).toBe("device-code");
    expect(getOAuthProviderConfig("xai")?.deviceCodeUrl).toContain("auth.x.ai");
  });

  test("every loaded entry has a strategy and refresher", () => {
    loadOAuthProvidersFromConfigs(loadProvidersJson());
    for (const config of listOAuthProviders()) {
      expect(() => grantStrategyFor(config)).not.toThrow();
    }
    const refreshers = buildOAuthRefreshers();
    expect(refreshers.length).toBe(listOAuthProviders().length);
    for (const r of refreshers) {
      expect(typeof r.refresher.refreshToken).toBe("function");
    }
  });

  test("unknown id is undefined (no hard-coded allowlist)", () => {
    loadOAuthProvidersFromConfigs(loadProvidersJson());
    expect(getOAuthProviderConfig("nope")).toBeUndefined();
  });

  test("shipped authType literals are refreshable", () => {
    loadOAuthProvidersFromConfigs(loadProvidersJson());
    for (const config of listOAuthProviders()) {
      const authType = config.authType ?? "oauth";
      expect(REFRESHABLE_AUTH_TYPES.has(authType)).toBe(true);
    }
  });

  test("skips invalid oauth blocks instead of throwing", () => {
    const loaded = loadOAuthProvidersFromConfigs({
      bad: {
        displayName: "Bad",
        iconUrl: "",
        envVarName: "X",
        upstreamBaseUrl: "https://example.com",
        apiKeyInstructions: "",
        apiKeyPlaceholder: "",
        oauth: {
          // missing clientId / tokenUrl / grant
          scope: "x",
        } as never,
      },
      good: {
        displayName: "Good",
        iconUrl: "",
        envVarName: "Y",
        upstreamBaseUrl: "https://example.com",
        apiKeyInstructions: "",
        apiKeyPlaceholder: "",
        oauth: {
          clientId: "cid",
          tokenUrl: "https://example.com/token",
          scope: "openid",
          grant: "device-code",
          authType: "device-code",
          deviceCodeUrl: "https://example.com/device",
          defaultVerificationUrl: "https://example.com/verify",
        },
      },
    });
    expect(loaded.map((p) => p.id)).toEqual(["good"]);
  });
});
