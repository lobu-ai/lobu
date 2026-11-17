import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { contextListCommand } from "../commands/context";
import { runCli } from "../index";
import * as context from "../internal/context";
import * as credentials from "../internal/credentials";

const HOUR = 3_600_000;

function oauthCreds(accessToken: string, expiresAt: number) {
  return {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt,
    oauth: {
      clientId: "test-client",
      tokenEndpoint: "https://issuer.example/token",
      userinfoEndpoint: "https://app.lobu.example/oauth/userinfo",
    },
  };
}

/**
 * One context per state: a live login, no login, an expired token that can
 * refresh and one that cannot (neither is sent anywhere), a revoked token, and
 * a stopped local server.
 */
function stubContexts() {
  spyOn(context, "loadContextConfig").mockResolvedValue({
    currentContext: "work",
    contexts: {
      work: { url: "https://app.lobu.example/api/v1" },
      side: { url: "https://app.lobu.example/api/v1" },
      stale: { url: "https://app.lobu.example/api/v1" },
      dead: { url: "https://app.lobu.example/api/v1" },
      revoked: { url: "https://app.lobu.example/api/v1" },
      local: { url: "http://localhost:8787" },
    },
  });
  spyOn(context, "getCurrentContextName").mockResolvedValue("work");
  const now = Date.now();
  spyOn(credentials, "loadCredentials").mockImplementation(async (name) => {
    switch (name) {
      case "work":
        return oauthCreds("work-token", now + HOUR);
      case "stale":
        return oauthCreds("stale-token", now - HOUR);
      case "dead":
        return { accessToken: "dead-token", expiresAt: now - HOUR };
      case "revoked":
        return oauthCreds("revoked-token", now + HOUR);
      case "local":
        return { accessToken: "local-token" };
      default:
        return null;
    }
  });
  return spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith("http://localhost:8787")) {
      throw new TypeError("Unable to connect");
    }
    if (url !== "https://app.lobu.example/oauth/userinfo") {
      return new Response("not found", { status: 404 });
    }
    if (auth === "Bearer work-token") {
      return Response.json({
        sub: "user-1",
        personal_org_slug: "home",
        organizations: [
          { id: "org-1", slug: "home", name: "Home" },
          { id: "org-2", slug: "team" },
        ],
      });
    }
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }) as typeof fetch);
}

describe("context list", () => {
  beforeEach(() => {
    process.env.LOBU_API_TOKEN = "env-token-for-another-target";
  });

  afterEach(() => {
    delete process.env.LOBU_API_TOKEN;
    mock.restore();
  });

  test("--json reports each context's live workspace grant or why it is unknown", async () => {
    const fetchSpy = stubContexts();
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runCli(["node", "lobu", "context", "list", "--json"]);

    const output = writes.join("");
    expect(JSON.parse(output)).toEqual({
      current: "work",
      contexts: [
        {
          name: "work",
          url: "https://app.lobu.example/api/v1",
          current: true,
          loggedIn: true,
          access: {
            state: "ok",
            workspaces: [
              { slug: "home", name: "Home", personal: true },
              { slug: "team" },
            ],
          },
        },
        {
          name: "side",
          url: "https://app.lobu.example/api/v1",
          current: false,
          loggedIn: false,
          access: { state: "logged_out" },
        },
        {
          name: "stale",
          url: "https://app.lobu.example/api/v1",
          current: false,
          loggedIn: true,
          access: { state: "expired", refreshable: true },
        },
        {
          name: "dead",
          url: "https://app.lobu.example/api/v1",
          current: false,
          loggedIn: true,
          access: { state: "expired", refreshable: false },
        },
        {
          name: "revoked",
          url: "https://app.lobu.example/api/v1",
          current: false,
          loggedIn: true,
          access: { state: "rejected", status: 401 },
        },
        {
          name: "local",
          url: "http://localhost:8787",
          current: false,
          loggedIn: true,
          access: { state: "unreachable" },
        },
      ],
    });
    expect(output).not.toContain("token");

    // Each login is sent only to its own server, never LOBU_API_TOKEN, and an
    // expired token is not sent (listing never refreshes).
    const sent = fetchSpy.mock.calls.map(([input, init]) => [
      String(input),
      new Headers(init?.headers).get("authorization"),
    ]);
    expect(sent.sort()).toEqual([
      ["http://localhost:8787/oauth/userinfo", "Bearer local-token"],
      ["https://app.lobu.example/oauth/userinfo", "Bearer revoked-token"],
      ["https://app.lobu.example/oauth/userinfo", "Bearer work-token"],
    ]);
  });

  test("plain output shows workspace slugs and keeps unknown states distinct from an empty grant", async () => {
    stubContexts();
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);

    await contextListCommand();

    const lines = logSpy.mock.calls.map(([line]) => String(line));
    const stateLineOf = (name: string) =>
      lines[lines.findIndex((line) => line.includes(` ${name} `)) + 1]!;
    expect(lines.find((line) => line.includes(" work "))).toMatch(/\*.* work/);
    expect(stateLineOf("work")).toContain("home, team");
    const unknownStates = ["side", "stale", "dead", "revoked", "local"].map(
      stateLineOf
    );
    expect(new Set(unknownStates).size).toBe(5);
    expect(stateLineOf("dead")).toContain("lobu login -c dead");
    for (const line of unknownStates) expect(line).not.toContain("workspaces:");
  });
});
