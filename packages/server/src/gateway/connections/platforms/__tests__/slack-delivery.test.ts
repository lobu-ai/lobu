import { describe, expect, test } from "bun:test";
import type { SlackAdapter } from "@chat-adapter/slack";
import { deliveryError } from "../../../../notifications/delivery.js";
import { slackPlatform } from "../slack.js";

const fixtures = [
  ["channel_not_found", "provider_not_found", false],
  ["user_not_found", "provider_not_found", false],
  ["is_archived", "provider_permission", false],
  ["not_in_channel", "provider_permission", false],
  ["cannot_dm_bot", "provider_permission", false],
  ["invalid_auth", "provider_authentication", false],
  ["token_revoked", "provider_authentication", false],
  ["account_inactive", "provider_authentication", false],
  ["not_authed", "provider_authentication", false],
  ["missing_scope", "provider_permission", false],
  ["no_permission", "provider_permission", false],
  ["restricted_action", "provider_permission", false],
  ["ratelimited", "provider_rate_limited", true],
  ["unknown_error", "delivery_unknown", true],
] as const;

async function adapterRejecting(error: unknown): Promise<SlackAdapter> {
  const adapter = await slackPlatform.createAdapter({
    botToken: "test-token", signingSecret: "test-secret",
    webClientOptions: {
      adapter: async () => { throw new Error("Unexpected SDK transport"); },
      retryConfig: { retries: 0 },
    },
  }) as SlackAdapter;
  // Outbound methods use _client, not the public token-scoped webClient getter.
  Object.defineProperty(adapter, "_client", { value: {
    chat: { postMessage: async () => { throw error; } },
    conversations: { open: async () => { throw error; } },
  } });
  return adapter;
}

describe("Slack delivery classification", () => {
  test("preserves the factory's socket-mode app token environment fallback", async () => {
    const previous = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_APP_TOKEN = "test-app-token";
    try {
      const adapter = await slackPlatform.createAdapter({ mode: "socket", botToken: "test-token" });
      expect(Reflect.get(adapter, "appToken")).toBe("test-app-token");
    } finally {
      if (previous === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = previous;
    }
  });

  test("preserves factory validation of socket-mode OAuth configuration", async () => {
    await expect(slackPlatform.createAdapter({
      mode: "socket", appToken: "test-app-token", clientId: "test-client-id", clientSecret: "test-client-secret",
    })).rejects.toThrow("Multi-workspace (clientId/clientSecret) is not supported in socket mode.");
  });

  for (const [providerCode, code, retryable] of fixtures) {
    test(providerCode, async () => {
      const upstream = Object.assign(new Error("unsafe provider prose test-token"), {
        code: "slack_webapi_platform_error",
        data: { error: providerCode, token: "test-token", response_metadata: { secret: "test-secret" } },
      });
      const adapter = await adapterRejecting(upstream);
      for (const send of [
        () => adapter.postChannelMessage("slack:CTEST", "hello"),
        () => adapter.postMessage("slack:CTEST:1.0", "hello"),
        () => adapter.openDM("UTEST"),
      ]) {
        const error = await send().catch((error: unknown) => error);
        expect(deliveryError(error)).toEqual({ code, retryable });
        expect(error).toMatchObject({ cause: { code: providerCode } });
        expect(JSON.stringify(error)).not.toContain("test-token");
        expect(JSON.stringify(error)).not.toContain("test-secret");
        expect(String(error)).not.toContain("unsafe provider prose");
      }
    });
  }

  test("unrelated transport errors retain their generic classification", async () => {
    const upstream = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const adapter = await adapterRejecting(upstream);
    const error = await adapter.postChannelMessage("slack:CTEST", "hello").catch((error: unknown) => error);
    expect(error).toBe(upstream);
    expect(deliveryError(error)).toEqual({ code: "provider_unavailable", retryable: true });
  });

  test("malformed provider codes are discarded and remain retryable", async () => {
    for (const providerCode of [undefined, "unsafe provider prose test-token"]) {
      const adapter = await adapterRejecting({
        code: "slack_webapi_platform_error", data: { error: providerCode },
      });
      const error = await adapter.openDM("UTEST").catch((error: unknown) => error);
      expect(deliveryError(error)).toEqual({ code: "delivery_unknown", retryable: true });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("test-token");
    }
  });
});
