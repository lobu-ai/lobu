import { describe, expect, test } from "bun:test";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";

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

describe("ChatGPT subscription credentials", () => {
  test("admits the Codex protocol with the signed turn credential", async () => {
    const module = new ChatGPTOAuthModule(makeManager());
    expect(module.sdkCompat).toBe("openai-codex");
    expect(await module.buildCredentialPlaceholder(AGENT, {
      organizationId: ORG, userId: USER, workerToken: "synthetic-signed-turn",
    })).toBe("synthetic-signed-turn");
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
});
