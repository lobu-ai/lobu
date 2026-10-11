import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  bumpInterval,
  DEVICE_CODE_GRANT_TYPE,
  discoverOAuth,
  fetchUserInfo,
  OAuthError,
  pollDeviceToken,
  refreshTokens,
  LOBU_CLI_CLIENT_NAME,
  registerClient,
  revokeToken,
  startDeviceAuthorization,
} from "../oauth";

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const call = { url, init };
      calls.push(call);
      return await handler(call);
    }
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

describe("oauth", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    mock.restore();
  });

  describe("bumpInterval", () => {
    test("bumps by 5 seconds when slowDown is true", () => {
      expect(bumpInterval(5, true)).toBe(10);
      expect(bumpInterval(0, true)).toBe(5);
    });

    test("returns the same interval when slowDown is false", () => {
      expect(bumpInterval(7, false)).toBe(7);
    });
  });

  test("DEVICE_CODE_GRANT_TYPE is the RFC 8628 grant URI", () => {
    expect(DEVICE_CODE_GRANT_TYPE).toBe(
      "urn:ietf:params:oauth:grant-type:device_code"
    );
  });

  describe("discoverOAuth", () => {
    test("fetches the .well-known doc at the API origin", async () => {
      const { calls } = setFetch(() =>
        jsonResponse({
          issuer: "https://issuer.example.com",
          token_endpoint: "https://issuer.example.com/token",
          authorization_endpoint: "https://issuer.example.com/authorize",
          registration_endpoint: "https://issuer.example.com/register",
          device_authorization_endpoint:
            "https://issuer.example.com/device_authorization",
          revocation_endpoint: "https://issuer.example.com/revoke",
          userinfo_endpoint: "https://issuer.example.com/userinfo",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:device_code",
            "refresh_token",
            42, // ignored — non-string
          ],
        })
      );

      const meta = await discoverOAuth("https://api.example.com/v1/agents");

      expect(calls[0]?.url).toBe(
        "https://api.example.com/.well-known/oauth-authorization-server"
      );
      expect(meta.tokenEndpoint).toBe("https://issuer.example.com/token");
      expect(meta.authorizationEndpoint).toBe(
        "https://issuer.example.com/authorize"
      );
      expect(meta.registrationEndpoint).toBe(
        "https://issuer.example.com/register"
      );
      expect(meta.deviceAuthorizationEndpoint).toBe(
        "https://issuer.example.com/device_authorization"
      );
      expect(meta.revocationEndpoint).toBe("https://issuer.example.com/revoke");
      expect(meta.userinfoEndpoint).toBe("https://issuer.example.com/userinfo");
      expect(meta.grantTypesSupported).toEqual([
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ]);
      expect(meta.issuer).toBe("https://issuer.example.com");
    });

    test("parses the auth.md claim_email_endpoint from the agent_auth block", async () => {
      setFetch(() =>
        jsonResponse({
          token_endpoint: "https://issuer.example.com/token",
          agent_auth: {
            flows_supported: ["user_claimed"],
            claim_email_endpoint:
              "https://issuer.example.com/oauth/device/email",
          },
        })
      );

      const meta = await discoverOAuth("https://api.example.com/v1");

      expect(meta.claimEmailEndpoint).toBe(
        "https://issuer.example.com/oauth/device/email"
      );
    });

    test("leaves claimEmailEndpoint undefined when agent_auth is absent", async () => {
      setFetch(() =>
        jsonResponse({ token_endpoint: "https://issuer.example.com/token" })
      );

      const meta = await discoverOAuth("https://api.example.com/v1");

      expect(meta.claimEmailEndpoint).toBeUndefined();
    });

    test("falls back to origin when issuer field is absent", async () => {
      setFetch(() =>
        jsonResponse({
          token_endpoint: "https://api.example.com/token",
        })
      );

      const meta = await discoverOAuth("https://api.example.com/v1");

      expect(meta.issuer).toBe("https://api.example.com");
      expect(meta.grantTypesSupported).toEqual([]);
    });

    test("throws OAuthError(discovery_invalid) when token_endpoint is missing", async () => {
      setFetch(() => jsonResponse({ issuer: "https://x.example.com" }));

      try {
        await discoverOAuth("https://api.example.com/v1");
        throw new Error("Expected discoverOAuth to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("discovery_invalid");
      }
    });

    test("throws OAuthError(discovery_failed) on non-2xx", async () => {
      setFetch(() => new Response("bad", { status: 500 }));

      try {
        await discoverOAuth("https://api.example.com/v1");
        throw new Error("Expected discoverOAuth to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("discovery_failed");
      }
    });

    test("throws OAuthError(discovery_unreachable) on network error", async () => {
      globalThis.fetch = (() => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;

      try {
        await discoverOAuth("https://api.example.com/v1");
        throw new Error("Expected discoverOAuth to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("discovery_unreachable");
      }
    });
  });

  describe("registerClient", () => {
    test("posts the registration body and parses client info", async () => {
      const { calls } = setFetch(() =>
        jsonResponse({
          client_id: "abc123",
          client_secret: "secret-shh",
        })
      );

      const client = await registerClient(
        "https://issuer.example.com/register",
        "1.2.3",
        LOBU_CLI_CLIENT_NAME
      );

      expect(client).toEqual({
        clientId: "abc123",
        clientSecret: "secret-shh",
      });
      const body = JSON.parse(calls[0]?.init?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.client_name).toBe("Lobu CLI");
      expect(body.software_id).toBe("lobu-cli");
      expect(body.software_version).toBe("1.2.3");
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.grant_types).toContain(DEVICE_CODE_GRANT_TYPE);
      expect(body.grant_types).toContain("refresh_token");
    });

    test("throws OAuthError(registration_invalid) when client_id is missing", async () => {
      setFetch(() => jsonResponse({}));

      try {
        await registerClient(
          "https://issuer.example.com/register",
          "1.0.0",
          LOBU_CLI_CLIENT_NAME
        );
        throw new Error("Expected registerClient to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("registration_invalid");
      }
    });

    test("throws OAuthError(registration_failed) on non-2xx", async () => {
      setFetch(() =>
        jsonResponse(
          { error: "invalid_request", error_description: "Bad client" },
          400
        )
      );

      try {
        await registerClient(
          "https://issuer.example.com/register",
          "1.0.0",
          LOBU_CLI_CLIENT_NAME
        );
        throw new Error("Expected registerClient to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("registration_failed");
        expect((err as OAuthError).message).toBe("Bad client");
      }
    });
  });

  describe("startDeviceAuthorization", () => {
    test("returns parsed device authorization response", async () => {
      const { calls } = setFetch(() =>
        jsonResponse({
          device_code: "device-xyz",
          user_code: "ABCD-EFGH",
          verification_uri: "https://issuer.example.com/device",
          verification_uri_complete:
            "https://issuer.example.com/device?user_code=ABCD-EFGH",
          expires_in: 900,
          interval: 5,
        })
      );

      const result = await startDeviceAuthorization(
        "https://issuer.example.com/device_authorization",
        { clientId: "client-1", clientSecret: "shh" }
      );

      expect(result.deviceCode).toBe("device-xyz");
      expect(result.userCode).toBe("ABCD-EFGH");
      expect(result.verificationUri).toBe("https://issuer.example.com/device");
      expect(result.verificationUriComplete).toBe(
        "https://issuer.example.com/device?user_code=ABCD-EFGH"
      );
      expect(result.expiresIn).toBe(900);
      expect(result.interval).toBe(5);

      const body = JSON.parse(calls[0]?.init?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.client_id).toBe("client-1");
      expect(body.client_secret).toBe("shh");
      expect(body.scope).toBe(
        "device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token"
      );
    });

    test("clamps interval to a minimum of 1 and uses 600s default expires_in", async () => {
      setFetch(() =>
        jsonResponse({
          device_code: "d",
          user_code: "u",
          verification_uri: "https://x/y",
          interval: 0,
        })
      );

      const result = await startDeviceAuthorization(
        "https://issuer.example.com/device_authorization",
        { clientId: "client-1" }
      );

      expect(result.interval).toBe(1);
      expect(result.expiresIn).toBe(600);
    });

    test("throws OAuthError(device_authorization_invalid) on missing fields", async () => {
      setFetch(() => jsonResponse({ device_code: "d" }));

      try {
        await startDeviceAuthorization(
          "https://issuer.example.com/device_authorization",
          { clientId: "client-1" }
        );
        throw new Error("Expected startDeviceAuthorization to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("device_authorization_invalid");
      }
    });

    test("throws OAuthError(device_authorization_failed) on non-2xx", async () => {
      setFetch(() => jsonResponse({ error: "server_error" }, 500));

      try {
        await startDeviceAuthorization(
          "https://issuer.example.com/device_authorization",
          { clientId: "client-1" }
        );
        throw new Error("Expected startDeviceAuthorization to throw.");
      } catch (err) {
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("device_authorization_failed");
      }
    });
  });

  describe("pollDeviceToken", () => {
    test("returns complete with parsed tokens on success", async () => {
      setFetch(() =>
        jsonResponse({
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
        })
      );

      const result = await pollDeviceToken(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "device-code"
      );

      expect(result.status).toBe("complete");
      if (result.status === "complete") {
        expect(result.tokens.accessToken).toBe("AT");
        expect(result.tokens.refreshToken).toBe("RT");
        expect(result.tokens.expiresIn).toBe(3600);
      }
    });

    test("returns pending without bumpInterval for authorization_pending", async () => {
      setFetch(() => jsonResponse({ error: "authorization_pending" }, 400));

      const result = await pollDeviceToken(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "device-code"
      );

      expect(result.status).toBe("pending");
      if (result.status === "pending") {
        expect(result.bumpInterval).toBe(false);
      }
    });

    test("returns pending with bumpInterval for slow_down", async () => {
      setFetch(() => jsonResponse({ error: "slow_down" }, 400));

      const result = await pollDeviceToken(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "device-code"
      );

      expect(result.status).toBe("pending");
      if (result.status === "pending") {
        expect(result.bumpInterval).toBe(true);
      }
    });

    test("returns error with description for terminal failures", async () => {
      setFetch(() =>
        jsonResponse(
          { error: "expired_token", error_description: "Code expired" },
          400
        )
      );

      const result = await pollDeviceToken(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "device-code"
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.code).toBe("expired_token");
        expect(result.message).toBe("Code expired");
      }
    });

    test("falls back to unknown_error code when error field is missing", async () => {
      setFetch(() => jsonResponse({ ok: false }, 500));

      const result = await pollDeviceToken(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "device-code"
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.code).toBe("unknown_error");
        expect(result.message).toContain("500");
      }
    });
  });

  describe("refreshTokens", () => {
    test("posts refresh grant and parses tokens", async () => {
      const { calls } = setFetch(() =>
        jsonResponse({ access_token: "new-AT", expires_in: 1800 })
      );

      const result = await refreshTokens(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "old-refresh"
      );

      expect(result?.accessToken).toBe("new-AT");
      expect(result?.expiresIn).toBe(1800);

      const body = JSON.parse(calls[0]?.init?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old-refresh");
    });

    test("returns null on 4xx error", async () => {
      setFetch(() => jsonResponse({ error: "invalid_grant" }, 400));

      const result = await refreshTokens(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "old-refresh"
      );

      expect(result).toBeNull();
    });

    test("returns null when access_token is absent", async () => {
      setFetch(() => jsonResponse({ refresh_token: "rt" }));

      const result = await refreshTokens(
        "https://issuer.example.com/token",
        { clientId: "c" },
        "old-refresh"
      );

      expect(result).toBeNull();
    });
  });

  describe("fetchUserInfo", () => {
    test("returns parsed user info on success", async () => {
      const { calls } = setFetch(() =>
        jsonResponse({ sub: "user-1", email: "u@example.com", name: "User" })
      );

      const info = await fetchUserInfo(
        "https://issuer.example.com/userinfo",
        "AT"
      );

      expect(info).toEqual({
        sub: "user-1",
        email: "u@example.com",
        name: "User",
      });
      expect(
        (calls[0]?.init?.headers as Record<string, string>).Authorization
      ).toBe("Bearer AT");
    });

    test("returns null on non-2xx", async () => {
      setFetch(() => new Response("nope", { status: 401 }));

      const info = await fetchUserInfo(
        "https://issuer.example.com/userinfo",
        "AT"
      );

      expect(info).toBeNull();
    });

    test("returns null when sub is missing", async () => {
      setFetch(() => jsonResponse({ email: "u@example.com" }));

      const info = await fetchUserInfo(
        "https://issuer.example.com/userinfo",
        "AT"
      );

      expect(info).toBeNull();
    });

    test("returns null on network error", async () => {
      globalThis.fetch = (() => {
        throw new Error("ETIMEDOUT");
      }) as unknown as typeof fetch;

      const info = await fetchUserInfo(
        "https://issuer.example.com/userinfo",
        "AT"
      );

      expect(info).toBeNull();
    });
  });

  describe("revokeToken", () => {
    test("posts the revocation body with hint and client", async () => {
      const { calls } = setFetch(() => jsonResponse({}));

      await revokeToken(
        "https://issuer.example.com/revoke",
        { clientId: "c", clientSecret: "s" },
        "the-token",
        "refresh_token"
      );

      const body = JSON.parse(calls[0]?.init?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.token).toBe("the-token");
      expect(body.token_type_hint).toBe("refresh_token");
      expect(body.client_id).toBe("c");
      expect(body.client_secret).toBe("s");
    });

    test("swallows network errors", async () => {
      globalThis.fetch = (() => {
        throw new Error("offline");
      }) as unknown as typeof fetch;

      // Should not throw.
      await revokeToken(
        "https://issuer.example.com/revoke",
        { clientId: "c" },
        "the-token",
        "access_token"
      );
    });
  });
});
