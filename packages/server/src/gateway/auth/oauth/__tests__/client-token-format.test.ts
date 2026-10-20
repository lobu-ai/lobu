import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OAuthTokenError } from "../base-client.js";
import { OAuthClient } from "../client.js";
import type { OAuthProviderConfig } from "../providers.js";
import { TEST_CLAUDE_OAUTH } from "./fixtures.js";

/**
 * Regression guard for the Claude OAuth "Token exchange failed: 400 Bad Request"
 * incident. Anthropic's token endpoint requires form-urlencoded body; JSON made
 * Anthropic return invalid_grant. Pin the request shape without hitting the network.
 */

interface CapturedRequest {
  url: string;
  contentType: string | null;
  rawBody: string;
}

const originalFetch = globalThis.fetch;
let captured: CapturedRequest | null;

function stubFetch(): void {
  captured = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: typeof input === "string" ? input : input.toString(),
      contentType: headers.get("Content-Type"),
      rawBody: String(init?.body ?? ""),
    };
    return new Response(
      JSON.stringify({
        access_token: "at_test",
        refresh_token: "rt_test",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:inference",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

beforeEach(stubFetch);
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuthClient token-request encoding", () => {
  for (const { status, body, code } of [
    { status: 400, body: '{"error":"invalid_grant"}', code: "invalid_grant" },
    { status: 200, body: '{"error":"invalid_grant"}', code: "invalid_grant" },
    { status: 401, body: '{"error":"invalid_client"}', code: "invalid_client" },
    { status: 429, body: '{"error":"temporarily_unavailable"}', code: "temporarily_unavailable" },
    { status: 503, body: "<html>unavailable</html>", code: undefined },
    { status: 400, body: '{"error":{"code":"invalid_grant"}}', code: undefined },
  ]) {
    test(`preserves structured refresh errors (${status}, ${code ?? "unknown"})`, async () => {
      globalThis.fetch = (async () => new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const client = new OAuthClient(TEST_CLAUDE_OAUTH);
      const error = await client.refreshToken("test-refresh").catch((err) => err);

      expect(error).toBeInstanceOf(OAuthTokenError);
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
      expect(error.isGrantDead()).toBe(code === "invalid_grant");
    });
  }

  test("Claude exchange POSTs form-encoded body with the genuine field set", async () => {
    const client = new OAuthClient(TEST_CLAUDE_OAUTH);

    await client.exchangeCodeForToken(
      "auth_code_xyz",
      "verifier_abc",
      undefined,
      "state_123",
    );

    expect(captured).not.toBeNull();
    const req = captured!;
    expect(req.url).toBe(TEST_CLAUDE_OAUTH.tokenUrl);
    // The bug: this was "application/json". Anthropic requires form-encoding.
    expect(req.contentType).toBe("application/x-www-form-urlencoded");

    // Body must be parseable as form data with the exact genuine field set.
    const form = new URLSearchParams(req.rawBody);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth_code_xyz");
    expect(form.get("code_verifier")).toBe("verifier_abc");
    expect(form.get("state")).toBe("state_123");
    expect(form.get("client_id")).toBe(TEST_CLAUDE_OAUTH.clientId);
    expect(form.get("redirect_uri")).toBe(TEST_CLAUDE_OAUTH.redirectUri);
    // The genuine claude-code exchange does NOT send expires_in.
    expect(form.get("expires_in")).toBeNull();
    // Sanity: it must not be JSON.
    expect(req.rawBody.trim().startsWith("{")).toBe(false);
  });

  test("a provider without tokenRequestFormat still uses JSON (no regression for other providers)", async () => {
    const jsonProvider: OAuthProviderConfig = {
      id: "external-auth",
      name: "External Auth",
      clientId: "client_json",
      authUrl: "https://provider.example/authorize",
      tokenUrl: "https://provider.example/token",
      redirectUri: "https://app.example/callback",
      scope: "openid",
      requireRefreshToken: false,
    };
    const client = new OAuthClient(jsonProvider);

    await client.exchangeCodeForToken("code_j", "verifier_j");

    expect(captured).not.toBeNull();
    const req = captured!;
    expect(req.contentType).toBe("application/json");
    const parsed = JSON.parse(req.rawBody);
    expect(parsed.grant_type).toBe("authorization_code");
    expect(parsed.client_id).toBe("client_json");
  });

  test("buildAuthUrl echoes extraAuthParams (code=true) into the authorize URL", () => {
    const client = new OAuthClient(TEST_CLAUDE_OAUTH);
    const url = new URL(client.buildAuthUrl("state_x", "verifier_y"));

    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("client_id")).toBe(TEST_CLAUDE_OAUTH.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      TEST_CLAUDE_OAUTH.redirectUri,
    );
    expect(url.searchParams.get("state")).toBe("state_x");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
