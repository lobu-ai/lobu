import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { __resetEncryptionKeyCacheForTests } from "@lobu/core";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import {
  createInferenceProvider,
  getOrgDefaultModel,
  listInferenceProviders,
  setInferenceProviderDefault,
  updateInferenceProviderCapabilities,
} from "../../lobu/stores/provider-secrets.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import { ProviderCatalogService } from "../auth/provider-catalog.js";

// createInferenceProvider encrypts the org key and ProviderCatalogService later
// decrypts it, so each test owns the process-wide env value and cached key.
const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let savedEncryptionKey: string | undefined;

const ORG = "org-agent-model-defaults";
const AGENT = "agent-model-defaults";

describe("agent model defaults (real DB)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    await resetTestDatabase();
    // Seed a bare model id under slug "openai"; getOrgDefaultModel prefixes it
    // to the routable "openai/gpt-5". (The slug must match the model's intended
    // provider prefix — a bare id gets `${slug}/` prepended.)
    await createInferenceProvider({
      organizationId: ORG,
      slug: "openai",
      kind: "openai",
      apiKey: "sk-e2e",
      capabilities: { text: { model: "gpt-5" } },
    });
    await setInferenceProviderDefault(ORG, "openai");
  }, 60_000);

  afterEach(() => {
    if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedEncryptionKey;
    __resetEncryptionKeyCacheForTests();
  });

  test("org default is readable via the real DB reader", async () => {
    expect(await getOrgDefaultModel(ORG)).toBe("openai/gpt-5");
  });

  test("agent with no models → org default in agentOptions.model", async () => {
    const store = {
      getSettings: async () => ({ models: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("openai/gpt-5");
  });

  test("agent models[0] wins over org default", async () => {
    const store = {
      getSettings: async () => ({ models: ["claude/claude-sonnet-4-6"] }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBe("claude/claude-sonnet-4-6");
  });

  test("automation override wins over both agent and org", async () => {
    const store = {
      getSettings: async () => ({ models: ["claude/claude-sonnet-4-6"] }),
    } as any;
    const opts = await resolveAgentOptions(
      AGENT,
      { model: "groq/llama-3.3" },
      store,
      ORG
    );
    expect(opts.model).toBe("groq/llama-3.3");
  });

  test("nothing anywhere → no model", async () => {
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    const store = {
      getSettings: async () => ({ models: undefined }),
    } as any;
    const opts = await resolveAgentOptions(AGENT, {}, store, ORG);
    expect(opts.model).toBeUndefined();
  });

  test("org default reaches an agent with NO installed providers (custom upstream synthesized)", async () => {
    // The layered fallback's headline case: an agent that pins nothing and has
    // an EMPTY models list must still get the org default provider synthesized
    // into its modules — otherwise a custom-upstream org default reaches the
    // worker as a bare model ref with no base_url/credentials and can't route.
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
    // A BYO/custom-upstream provider, marked the org default.
    await createInferenceProvider({
      organizationId: ORG,
      slug: "byo-default",
      kind: "openai",
      apiKey: "sk-byo",
      capabilities: {
        text: { base_url: "https://api.byo.example.com", model: "byo-model" },
      },
    });
    await updateInferenceProviderCapabilities(ORG, "byo-default", "text", {
      base_url: "https://api.byo.example.com",
      model: "byo-model",
    });
    expect(await setInferenceProviderDefault(ORG, "byo-default")).toBe('ok');

    const catalog = new ProviderCatalogService(
      // Agent settings with an EMPTY models list — the exact gap.
      { getSettings: async () => ({ models: [] }) } as any,
      {} as any,
      (org: string) => listInferenceProviders(org),
    );

    const modules = await catalog.getInstalledModules(AGENT, ORG);
    // The org default provider must be synthesized despite empty installed set.
    expect(modules.some((m) => m.providerId === "byo-default")).toBe(true);
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM inference_providers WHERE organization_id = ${ORG}`;
  });
});
