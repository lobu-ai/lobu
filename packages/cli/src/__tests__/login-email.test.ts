import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

const openMock = mock(async (_url: string) => undefined);
mock.module("open", () => ({ default: openMock }));

const { loginCommand } = await import("../commands/login");
const context = await import("../internal/context");
const credentials = await import("../internal/credentials");

/**
 * Regression guard for `lobu login --email`: after the server accepts the
 * email claim, the command MUST keep polling and save the credential. An
 * earlier version checked the void result of the claim call as falsy and
 * returned immediately, so the email sent but no token was ever collected.
 */
describe("login device-code approval", () => {
  afterEach(() => {
    mock.restore();
    openMock.mockClear();
  });

  function mockOAuthServer(
    options: {
      expiresIn?: number;
      interval?: number;
      tokenResults?: Array<"success" | "pending">;
      onPending?: () => void;
    } = {}
  ): { calls: string[] } {
    const calls: string[] = [];
    const tokenResults = [...(options.tokenResults ?? ["success"])];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          issuer: "https://lobu.test",
          token_endpoint: "https://lobu.test/oauth/token",
          registration_endpoint: "https://lobu.test/oauth/register",
          device_authorization_endpoint:
            "https://lobu.test/oauth/device_authorization",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
          agent_auth: {
            claim_email_endpoint: "https://lobu.test/oauth/device/email",
          },
        });
      }
      if (url.endsWith("/oauth/register")) {
        return jsonResponse({ client_id: "agent-client" });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        return jsonResponse({
          device_code: "dev-code",
          user_code: "ABCD-1234",
          verification_uri: "https://lobu.test/oauth/device",
          verification_uri_complete:
            "https://lobu.test/oauth/device?user_code=ABCD-1234",
          expires_in: options.expiresIn ?? 600,
          interval: options.interval ?? 1,
        });
      }
      if (url.endsWith("/oauth/device/email")) {
        return jsonResponse({ status: "pending" }, 202);
      }
      if (url.endsWith("/oauth/token")) {
        if (tokenResults.shift() === "pending") {
          options.onPending?.();
          return jsonResponse({ error: "authorization_pending" }, 400);
        }
        return jsonResponse({
          access_token: "claimed-access-token",
          refresh_token: "claimed-refresh-token",
          expires_in: 3600,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return { calls };
  }

  test("sends the email claim, polls, and saves the collected credential", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();
    const output: string[] = [];
    spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    const originalFetch = globalThis.fetch;
    const { calls } = mockOAuthServer();
    try {
      await loginCommand({ email: "user@example.com", context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // It must have hit the claim endpoint AND gone on to poll the token endpoint.
    expect(calls.some((u) => u.endsWith("/oauth/device/email"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/oauth/token"))).toBe(true);
    // ...and persisted the collected access token (the bug skipped this).
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "claimed-access-token",
    });
    const text = output.join("\n");
    expect(text).toContain("ABCD-1234");
    expect(text).toContain(
      "https://lobu.test/oauth/device?user_code=ABCD-1234"
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  test("opens the browser to the complete verification URL for interactive login", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();
    spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    spyOn(process.stdin, "isTTY", "get").mockReturnValue(false);
    spyOn(console, "log").mockImplementation(() => undefined);

    const originalFetch = globalThis.fetch;
    const { calls } = mockOAuthServer({ expiresIn: 0 });
    try {
      await loginCommand({ context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock.mock.calls[0]?.[0]).toBe(
      "https://lobu.test/oauth/device?user_code=ABCD-1234"
    );
    expect(calls.some((u) => u.endsWith("/oauth/device/email"))).toBe(false);
    expect(calls.some((u) => u.endsWith("/oauth/token"))).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("keeps polling without a TTY when a supervisor explicitly owns the wait", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();
    spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    spyOn(process.stdin, "isTTY", "get").mockReturnValue(false);
    spyOn(console, "log").mockImplementation(() => undefined);

    const originalFetch = globalThis.fetch;
    const { calls } = mockOAuthServer({
      interval: 0,
      tokenResults: ["pending", "success"],
    });
    try {
      await loginCommand({
        context: "prod",
        waitForApproval: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.filter((url) => url.endsWith("/oauth/token"))).toHaveLength(2);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
  });

  for (const scenario of [
    {
      name: "supervised approval after five minutes",
      expiresIn: 900,
      elapsed: 360,
      succeeds: true,
    },
    {
      name: "email approval after five minutes",
      expiresIn: 900,
      elapsed: 360,
      succeeds: true,
      email: "user@example.com",
    },
    {
      name: "shorter server expiry",
      expiresIn: 60,
      elapsed: 61,
      succeeds: false,
    },
    {
      name: "local ceiling for oversized server lifetimes",
      expiresIn: 3600,
      elapsed: 901,
      succeeds: false,
    },
  ]) {
    test(scenario.name, async () => {
      spyOn(context, "resolveContext").mockResolvedValue({
        name: "prod",
        url: "https://lobu.test/api/v1",
        source: "config",
      });
      spyOn(credentials, "loadCredentials").mockResolvedValue(null);
      const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();
      spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
      spyOn(process.stdin, "isTTY", "get").mockReturnValue(false);
      spyOn(console, "log").mockImplementation(() => undefined);
      const start = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(start);
      const originalFetch = globalThis.fetch;
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      const { calls } = mockOAuthServer({
        expiresIn: scenario.expiresIn,
        interval: 0,
        tokenResults: ["pending", "success"],
        onPending: () => clock.mockReturnValue(start + scenario.elapsed * 1000),
      });
      try {
        await loginCommand({
          context: "prod",
          waitForApproval: !scenario.email,
          email: scenario.email,
        });
        expect(
          calls.filter((url) => url.endsWith("/oauth/token"))
        ).toHaveLength(scenario.succeeds ? 2 : 1);
        expect(saveSpy).toHaveBeenCalledTimes(scenario.succeeds ? 1 : 0);
        expect(process.exitCode).toBe(scenario.succeeds ? 0 : 1);
      } finally {
        globalThis.fetch = originalFetch;
        process.exitCode = originalExitCode;
      }
    });
  }

  test("still fails fast for an unsupervised non-interactive login", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();
    spyOn(process.stdout, "isTTY", "get").mockReturnValue(false);
    spyOn(process.stdin, "isTTY", "get").mockReturnValue(false);
    spyOn(console, "log").mockImplementation(() => undefined);

    const originalFetch = globalThis.fetch;
    const { calls } = mockOAuthServer({
      interval: 0,
      tokenResults: ["pending", "success"],
    });
    try {
      await loginCommand({ context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.filter((url) => url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("errors without polling when the server has no claim endpoint", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://lobu.test/lobu/api/v1",
      source: "config",
    });
    spyOn(credentials, "loadCredentials").mockResolvedValue(null);
    const saveSpy = spyOn(credentials, "saveCredentials").mockResolvedValue();

    const calls: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          token_endpoint: "https://lobu.test/oauth/token",
          registration_endpoint: "https://lobu.test/oauth/register",
          device_authorization_endpoint:
            "https://lobu.test/oauth/device_authorization",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
          // no agent_auth → email claim unsupported
        });
      }
      if (url.endsWith("/oauth/register"))
        return jsonResponse({ client_id: "c" });
      if (url.endsWith("/oauth/device_authorization")) {
        return jsonResponse({
          device_code: "d",
          user_code: "E-F",
          verification_uri: "https://lobu.test/oauth/device",
          expires_in: 600,
          interval: 0,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await loginCommand({ email: "user@example.com", context: "prod" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.some((u) => u.endsWith("/oauth/device/email"))).toBe(false);
    expect(calls.some((u) => u.endsWith("/oauth/token"))).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
