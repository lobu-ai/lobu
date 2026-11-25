import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClaudeOAuthModule } from "../oauth-module.js";

/**
 * The model picker lists Claude models with the system env key when the agent
 * has no auth profile — otherwise an env-configured Anthropic agent shows an
 * empty picker and the operator can't select a model (required, since Lobu
 * never picks a default). The env var decides how the key is presented.
 */
describe("ClaudeOAuthModule model listing — env-key credential", () => {
  const ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = originalFetch;
  });

  function makeModule(): ClaudeOAuthModule {
    // No per-agent profile — forces the system-env-key path.
    const authProfilesManager = { getBestProfile: async () => null } as never;
    return new ClaudeOAuthModule(authProfilesManager);
  }

  async function listModels(): Promise<string[] | null> {
    const module = makeModule();
    const credential = await module.resolveModelListingCredential(
      "agent-1",
      { userId: "user-1" },
      { includeSystemEnv: true }
    );
    const models = await module.listModels(
      credential,
      AbortSignal.timeout(5000)
    );
    return models ? models.map((model) => model.id) : null;
  }

  test("uses ANTHROPIC_API_KEY (x-api-key) and lists the live models", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    let sentAuthHeader: string | undefined;
    let sentApiKeyHeader: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      sentAuthHeader = h.Authorization;
      sentApiKeyHeader = h["x-api-key"];
      return new Response(
        JSON.stringify({
          data: [
            { id: "claude-newest-1", display_name: "Newest", type: "model" },
            { id: "claude-older-2", display_name: "Older", type: "model" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    expect(await listModels()).toEqual(["claude-newest-1", "claude-older-2"]);
    expect(sentApiKeyHeader).toBe("sk-ant-api03-test");
    expect(sentAuthHeader).toBeUndefined();
  });

  test("uses ANTHROPIC_AUTH_TOKEN as a Bearer token, not x-api-key", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat-bearer";
    let sentAuthHeader: string | undefined;
    let sentApiKeyHeader: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      sentAuthHeader = h.Authorization;
      sentApiKeyHeader = h["x-api-key"];
      return new Response(
        JSON.stringify({ data: [{ id: "claude-x", type: "model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    expect(await listModels()).toEqual(["claude-x"]);
    expect(sentAuthHeader).toBe("Bearer sk-ant-oat-bearer");
    expect(sentApiKeyHeader).toBeUndefined();
  });

  test.each([
    { kind: "api-key" as const, basePath: "" },
    { kind: "api-key" as const, basePath: "/anthropic///" },
    { kind: "oauth" as const, basePath: "" },
    { kind: "oauth" as const, basePath: "/anthropic///" },
  ])(
    "lists models from the configured upstream ($kind, '$basePath')",
    async ({ kind, basePath }) => {
      const credential = { kind, value: "synthetic-proxy-only-credential" };
      const expectedPath = basePath
        ? "/anthropic/v1/models?limit=1000"
        : "/v1/models?limit=1000";
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          const validAuth = kind === "oauth"
            ? request.headers.get("authorization") === `Bearer ${credential.value}` &&
              !request.headers.has("x-api-key")
            : request.headers.get("x-api-key") === credential.value &&
              !request.headers.has("authorization");
          if (`${url.pathname}${url.search}` !== expectedPath || !validAuth) {
            return new Response(null, { status: 401 });
          }
          return Response.json({ data: [{ id: "claude-proxy-model" }] });
        },
      });
      try {
        process.env.ANTHROPIC_BASE_URL = `${server.url.origin}${basePath}`;
        // Block nonlocal requests if a regression targets the public API.
        globalThis.fetch = ((input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input)
          );
          if (url.origin !== server.url.origin) {
            throw new Error("Unexpected model listing destination");
          }
          return originalFetch(input, init);
        }) as typeof globalThis.fetch;

        const models = await makeModule().listModels(
          credential,
          AbortSignal.timeout(5000)
        );
        expect(models?.map((model) => model.id)).toEqual(["claude-proxy-model"]);
      } finally {
        await server.stop(true);
      }
    }
  );

  test("no credentials → nothing listed and no request (no silent model)", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    expect(await listModels()).toBeNull();
    expect(fetched).toBe(false);
  });
});
