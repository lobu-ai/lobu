import { afterEach, describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import type { BaseProviderModule } from "../auth/base-provider-module.js";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";

const ORG = "org-credential-test";
const USER = "user-credential-test";
const AGENT = "agent-credential-test";
const ACCOUNT = "acct_credential_test";
const STORED_CREDENTIAL = "synthetic-stored-oauth-credential";

function makeManager() {
  return new AuthProfilesManager({
    ephemeralProfiles: { get: () => undefined } as never,
    declaredAgents: { get: () => undefined } as never,
    userAuthProfiles: {
      list: async (userId: string, agentId: string) =>
        userId === USER && agentId === `__org_oauth__:${ORG}`
          ? [{
              id: "profile-credential-test", provider: "chatgpt", model: "*",
              authType: "oauth", credential: STORED_CREDENTIAL,
              metadata: { accountId: ACCOUNT, expiresAt: Date.now() + 3_600_000 },
              createdAt: 0,
            }]
          : [],
    } as never,
    secretStore: { get: async () => undefined } as never,
    agentOwnerResolver: async () => USER,
    agentOrgResolver: async () => ORG,
  });
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["ENCRYPTION_KEY", "DISPATCHER_URL", "WORKER_TOKEN"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("ChatGPT subscription credentials", () => {
  test("org-bucket account reaches the placeholder without exposing its credential", async () => {
    const module: BaseProviderModule = new ChatGPTOAuthModule(makeManager());
    const placeholder = await module.buildCredentialPlaceholder(AGENT, {
      organizationId: ORG, userId: USER,
    });
    expect(placeholder).not.toBe(STORED_CREDENTIAL);
    expect(placeholder.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(placeholder.split(".")[1]!, "base64url").toString()))
      .toEqual({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
  });

  test("another user cannot borrow the agent owner's subscription", async () => {
    const module: BaseProviderModule = new ChatGPTOAuthModule(makeManager());
    expect(await module.buildCredentialPlaceholder(AGENT, {
      organizationId: ORG, userId: "unlinked-user",
    })).toBe("lobu-proxy");
    expect(await module.buildCredentialPlaceholder(AGENT)).toBe("lobu-proxy");
  });

  test("model listing retains the requesting user", async () => {
    const module = new ChatGPTOAuthModule(makeManager());
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return Response.json({ models: [{ slug: "test-model", title: "Test model" }] });
    }) as typeof fetch;
    try {
      expect(await module.getModelOptions(AGENT, USER)).toEqual([
        { value: "openai-codex/test-model", label: "Test model" },
      ]);
      expect(authorization).toBe(`Bearer ${STORED_CREDENTIAL}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // The placeholder MAP the worker receives is asserted at the session-context
  // route, not through a worker run: `credentialPlaceholders` is produced only
  // by `worker-gateway`, and this is its only coverage. The guarantee that
  // matters is per-provider — a proxied provider gets the worker token, while
  // ChatGPT's own subscription credential never leaves the gateway.
  for (const defaultProvider of ["chatgpt", "deepseek"]) {
    test(`session context proxies keys but never the ChatGPT credential; default=${defaultProvider}`, async () => {
      process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
      const manager = makeManager();
      const chatgpt = new ChatGPTOAuthModule(manager);
      const apiKeyModule = (providerId: string, envVarName: string) =>
        new ApiKeyProviderModule({
          providerId,
          providerDisplayName: providerId,
          providerIconUrl: "",
          envVarName,
          upstreamBaseUrl: `https://${providerId}.example.invalid`,
          sdkCompat: "openai",
          authProfilesManager: manager,
        });
      const modules = [
        chatgpt,
        apiKeyModule("openai", "OPENAI_API_KEY"),
        apiKeyModule("deepseek", "DEEPSEEK_API_KEY"),
      ];
      // Availability is fixture-owned; the account lookup and placeholder
      // generation below use the real provider modules.
      for (const module of modules) module.hasSystemKey = () => true;
      const model =
        defaultProvider === "chatgpt"
          ? "chatgpt/gpt-5.5"
          : "deepseek/default-model";
      const gateway = new WorkerGateway(
        { send: async () => undefined } as never,
        "https://gateway.example.invalid",
        { getWorkerConfig: async () => ({ mcpServers: {} }) } as never,
        {
          getSessionContext: async () => ({
            agentLayers: {
              identityMd: "Synthetic test agent",
              soulMd: "",
              userMd: "",
              unconfiguredNotice: "",
            },
            platformInstructions: "",
            networkInstructions: "",
            skillsInstructions: "",
            mcpStatus: [],
          }),
        } as never,
        undefined,
        {
          getInstalledModules: async () => modules,
          resolveDispatchModel: async () => ({ model }),
          findProviderForModel: async (ref: string) =>
            modules.find((m) => m.providerId === ref.split("/")[0]),
        } as never,
        { getSettings: async () => ({ models: [model] }) } as never,
      );
      const conversationId = `conversation-${defaultProvider}`;
      const workerToken = generateWorkerToken(
        USER,
        conversationId,
        "worker-test",
        { channelId: "channel-test", agentId: AGENT, organizationId: ORG },
      );
      try {
        const response = await gateway.getApp().request("/session-context", {
          headers: {
            authorization: `Bearer ${workerToken}`,
            host: "gateway.example.invalid",
          },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          providerConfig?: Record<string, unknown>;
        };
        const providerConfig = body.providerConfig;
        // The stored subscription credential must never reach the worker.
        expect(JSON.stringify(providerConfig)).not.toContain(
          STORED_CREDENTIAL,
        );
        const placeholders = providerConfig?.credentialPlaceholders as
          | Record<string, string>
          | undefined;
        expect(placeholders).toBeDefined();
        // Proxied providers receive the worker token; ChatGPT does not, so its
        // subscription cannot be spent by anything holding that token.
        expect(placeholders?.openai).toBe(workerToken);
        expect(placeholders?.deepseek).toBe(workerToken);
        expect(placeholders?.chatgpt).not.toBe(workerToken);
      } finally {
        gateway.shutdown();
      }
    }, 30_000);
  }
});
