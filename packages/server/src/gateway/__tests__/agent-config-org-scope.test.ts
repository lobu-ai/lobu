import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentConfigStore,
  type AgentSettings,
  type ModuleInterface,
  moduleRegistry,
} from "@lobu/core";
import { Hono } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module.js";
import { __resetModelsDevCacheForTests } from "../auth/models-dev.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { UserAgentsStore } from "../auth/user-agents-store.js";
import type { GrantStore } from "../permissions/grant-store.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import { DeclaredAgentRegistry } from "../services/declared-agent-registry.js";

const AGENT_ID = "lobu-builder";
const ORGANIZATION_ID = "org-b";

function createApp(
  settingsReads: Array<string | undefined>,
  organizations = [ORGANIZATION_ID],
  options: { declaredSettings?: AgentSettings; grantStore?: GrantStore } = {},
): Hono {
  const configStore = {
    async getSettings(): Promise<AgentSettings> {
      settingsReads.push(orgContext.getStore()?.organizationId);
      return {
        models: ["gemini/gemini-2.5-flash"],
        updatedAt: Date.now(),
      };
    },
    async getMetadata() {
      return null;
    },
  } as AgentConfigStore;
  const userAgentsStore = {
    async findAgentOrganizations() {
      return organizations;
    },
  } as UserAgentsStore;
  const agentSettingsStore = new AgentSettingsStore(configStore);
  if (options.declaredSettings) {
    const registry = new DeclaredAgentRegistry();
    registry.replaceAll(
      new Map([
        [AGENT_ID, { settings: options.declaredSettings, credentials: [] }],
      ]),
    );
    agentSettingsStore.setDeclaredAgents(registry);
  }
  const router = createAgentConfigRoutes({
    agentSettingsStore,
    agentConfigStore: configStore,
    userAgentsStore,
    grantStore: options.grantStore,
  });
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/config", router);
  return app;
}

describe("agent config tenant scope", () => {
  afterEach(() => {
    setAuthProvider(null);
  });

  test("uses the tenant proven by the settings-cookie owner mapping", async () => {
    const settingsReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const response = await createApp(settingsReads).request(
      `/api/v1/agents/${AGENT_ID}/config`,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual([
      "gemini/gemini-2.5-flash",
    ]);
    expect(settingsReads).toEqual([ORGANIZATION_ID]);
  });

  test("rejects an ambiguous owner mapping without reading settings", async () => {
    const settingsReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const response = await createApp(settingsReads, [
      "org-a",
      ORGANIZATION_ID,
    ]).request(`/api/v1/agents/${AGENT_ID}/config`);

    expect(response.status).toBe(401);
    expect(settingsReads).toEqual([]);
  });

  test("serves an orgless declared agent with no grants instead of failing", async () => {
    // `verifyToken` authorizes a declared (SDK-embedded) agent without a
    // tenant on purpose — its settings are org-agnostic. Grants are not:
    // there is no org to scope them to, so the response reports none rather
    // than reading `grants` across every tenant.
    const settingsReads: Array<string | undefined> = [];
    const grantReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const grantStore = {
      async listGrants(_agentId: string, organizationId?: string) {
        grantReads.push(organizationId);
        return [];
      },
    } as unknown as GrantStore;

    const app = createApp(settingsReads, [], {
      declaredSettings: {
        models: ["anthropic/claude-sonnet-4"],
        updatedAt: Date.now(),
      },
      grantStore,
    });

    const response = await app.request(`/api/v1/agents/${AGENT_ID}/config`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models).toEqual(["anthropic/claude-sonnet-4"]);
    expect(body.tools.permissions).toEqual([]);
    // Neither the DB settings row nor the grants table is read unscoped.
    expect(settingsReads).toEqual([]);
    expect(grantReads).toEqual([]);
  });

  test("orgless declared agent lists no grants instead of reading unscoped", async () => {
    const settingsReads: Array<string | undefined> = [];
    const grantReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const grantStore = {
      async listGrants(_agentId: string, organizationId?: string) {
        grantReads.push(organizationId);
        return [];
      },
    } as unknown as GrantStore;

    const response = await createApp(settingsReads, [], {
      declaredSettings: {
        models: ["anthropic/claude-sonnet-4"],
        updatedAt: Date.now(),
      },
      grantStore,
    }).request(`/api/v1/agents/${AGENT_ID}/config/grants`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(grantReads).toEqual([]);
  });

  test("lists every provider's live models as <providerId>/<model id>", async () => {
    const modules = (
      moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
    ).modules;
    const savedModules = new Map(modules);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const credentials: Record<string, string> = {
      claude: "synthetic-anthropic-key",
      chatgpt: `${encode({ alg: "none" })}.${encode({
        "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
      })}.signature`,
    };
    const profiles = {
      getBestProfile: async (_agentId: string, provider: string) =>
        credentials[provider]
          ? {
              provider,
              credential: credentials[provider],
              authType: provider === "claude" ? "api-key" : "oauth",
            }
          : null,
      ensureFreshCredential: async (profile: { credential: string }) =>
        profile.credential,
    };
    moduleRegistry.register(
      new ClaudeOAuthModule(profiles as never) as unknown as ModuleInterface,
    );
    moduleRegistry.register(
      new ChatGPTOAuthModule(profiles as never) as unknown as ModuleInterface,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "models.dev") return Response.json({});
      if (url.hostname === "api.anthropic.com") {
        return Response.json({
          data: [{ id: "synthetic-claude-1", display_name: "Synthetic Claude" }],
        });
      }
      if (url.hostname === "chatgpt.com") {
        return Response.json({
          models: [{ slug: "synthetic-codex-1" }],
        });
      }
      return new Response("unexpected upstream", { status: 500 });
    }) as typeof fetch;
    __resetModelsDevCacheForTests();
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));
    try {
      const response = await createApp([], [], {
        declaredSettings: { models: [], updatedAt: Date.now() },
      }).request(`/api/v1/agents/${AGENT_ID}/config`);

      expect(response.status).toBe(200);
      const listed = (await response.json()).providers.models as Record<
        string,
        Array<{ value: string; label: string }>
      >;
      expect(listed.chatgpt).toEqual([
        { value: "chatgpt/synthetic-codex-1", label: "synthetic-codex-1" },
      ]);
      expect(listed.claude).toEqual([
        { value: "claude/synthetic-claude-1", label: "Synthetic Claude" },
      ]);
      for (const [providerId, options] of Object.entries(listed)) {
        for (const option of options) {
          expect(option.value.startsWith(`${providerId}/`)).toBe(true);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      (
        moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
      ).modules = savedModules;
    }
  });
});
