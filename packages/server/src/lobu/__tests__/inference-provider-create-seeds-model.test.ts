/** Route coverage for org inference providers: create, edit and live model discovery. */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import {
	__resetEncryptionKeyCacheForTests,
	type ModuleInterface,
	moduleRegistry,
} from "@lobu/core";
import { ApiKeyProviderModule } from "../../gateway/auth/api-key-provider-module.js";
import { ChatGPTOAuthModule } from "../../gateway/auth/chatgpt/chatgpt-oauth-module.js";
import { ClaudeOAuthModule } from "../../gateway/auth/claude/oauth-module.js";
import { __resetModelsDevCacheForTests } from "../../gateway/auth/models-dev.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "org-create-seed";
const USER = "u-create-seed";
let savedEncryptionKey: string | undefined;
let savedRegistryPath: string | undefined;
let savedModules: Map<string, ModuleInterface> | undefined;
/** Signed-in subscription profiles by provider id (the org-bucket sign-in). */
let oauthProfiles: Record<string, { credential: string; authType: "oauth" }> = {};
const profileStore = {
	getBestProfile: async (_agentId: string, provider: string) =>
		oauthProfiles[provider] ? { ...oauthProfiles[provider], provider } : null,
	ensureFreshCredential: async (profile: { credential: string }) => profile.credential,
	hasProviderProfiles: async (_agentId: string, provider: string) => Boolean(oauthProfiles[provider]),
};

function restoreModules(): void {
	if (!savedModules) return;
	(
		moduleRegistry as unknown as { modules: Map<string, ModuleInterface> }
	).modules = savedModules;
	savedModules = undefined;
}

beforeAll(async () => {
	savedEncryptionKey = process.env.ENCRYPTION_KEY;
	savedRegistryPath = process.env.LOBU_PROVIDER_REGISTRY_PATH;
	await ensureDbForGatewayTests();
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	__resetEncryptionKeyCacheForTests();
	// The route resolves the registry via cwd/config/providers.json, which is the
	// REPO root — not packages/server, where the test runs. Point at the real
	// file so the routes read the same catalog production does.
	process.env.LOBU_PROVIDER_REGISTRY_PATH = new URL(
		"../../../../../config/providers.json",
		import.meta.url,
	).pathname;
}, 60_000);

afterAll(() => {
	if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
	else process.env.ENCRYPTION_KEY = savedEncryptionKey;
	if (savedRegistryPath === undefined)
		delete process.env.LOBU_PROVIDER_REGISTRY_PATH;
	else process.env.LOBU_PROVIDER_REGISTRY_PATH = savedRegistryPath;
	__resetEncryptionKeyCacheForTests();
});

async function seedOrg(): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Test', 'cs@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Register the provider modules the routes consult. A booted server populates
 * the MODULE REGISTRY; a bare test process does not, so without these the
 * catalog and model discovery would answer for no provider at all.
 */
function registerCatalogModules(): void {
	// The registry is a process-wide singleton and `bun test` shares one process
	// across files. Snapshot before registering so afterEach can restore it
	// without leaking these provider modules into another suite's catalog.
	savedModules = new Map(
		(moduleRegistry as unknown as { modules: Map<string, ModuleInterface> })
			.modules,
	);
	moduleRegistry.register(
		new ApiKeyProviderModule({
			providerId: "groq",
			slug: "groq",
			sdkCompat: "openai",
			upstreamBaseUrl:
				"https://api.groq.com/openai/v1",
			envVarName: "GROQ_API_KEY",
			providerDisplayName: "Groq",
			providerIconUrl: "",
			apiKeyInstructions: "",
			apiKeyPlaceholder: "",
			authProfilesManager: { getBestProfile: async () => null } as never,
		}) as unknown as ModuleInterface,
	);
	moduleRegistry.register(
		new ApiKeyProviderModule({
			providerId: "gemini",
			sdkCompat: "openai",
			upstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
			envVarName: "SYNTHETIC_GEMINI_API_KEY",
			providerDisplayName: "Gemini",
			providerIconUrl: "",
			apiKeyInstructions: "",
			apiKeyPlaceholder: "",
			modelsDevId: "google",
			authProfilesManager: {} as never,
		}) as unknown as ModuleInterface,
	);
	moduleRegistry.register(new ChatGPTOAuthModule(profileStore as never) as unknown as ModuleInterface);
	moduleRegistry.register(new ClaudeOAuthModule(profileStore as never) as unknown as ModuleInterface);
}

/** A synthetic ChatGPT access token: unsigned, carrying only an account claim. */
function syntheticChatGptToken(): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })}.signature`;
}

async function createProvider(body: Record<string, unknown>): Promise<Response> {
	const mod = await import("../agent-routes.js");
	return await mod.agentRoutes.request("/inference-providers", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readCapabilities(slug: string): Promise<unknown> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const rows = (await sql`
    SELECT capabilities FROM inference_providers
    WHERE organization_id = ${ORG} AND slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `) as Array<{ capabilities: unknown }>;
	return rows[0]?.capabilities;
}

describe("org inference provider routes", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg();
		oauthProfiles = {};
		__resetModelsDevCacheForTests();
		registerCatalogModules();
		authStash.user = {
			id: USER,
			name: "Test",
			email: "cs@test",
			emailVerified: true,
		};
		authStash.organizationId = ORG;
		authStash.authSource = "session";
    authStash.memberRole = "owner";
		authStash.mcpAuthInfo = null;
	});

	afterEach(() => restoreModules());

  test("REST, SDK and MCP share provider state under the mounted org route", async () => {
    const { Hono } = await import("hono");
    const { agentRoutes } = await import("../agent-routes.js");
    const { buildClientSDK } = await import("../../sandbox/client-sdk");
    const { extractAuthContext, toToolContext, executeTool } = await import("../../tools/execute");
    let auth: ReturnType<typeof extractAuthContext> | undefined;
    const app = new Hono();
    app.use("*", async (c, next) => { await next(); auth = extractAuthContext(c); });
    app.route("/api/:orgSlug/agents", agentRoutes);
    const url = `/api/${ORG}/agents/inference-providers`;
    const created = await app.request(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "parity", kind: "groq", apiKey: "synthetic-parity-key", capabilities: { text: { model: "synthetic-model" } } }) });
    expect(created.status).toBe(201);
    expect(auth).toBeDefined();
    const sdk = buildClientSDK(toToolContext(auth!), {});
    await sdk.inferenceProviders.update({ slug: "parity", displayName: "Shared" });
    await sdk.inferenceProviders.setCapability({ slug: "parity", modality: "image", block: { model: "image-model" } });
    const rest = await app.request(url);
    expect(rest.status).toBe(200);
    const listed = await rest.json();
    expect(listed).toEqual(await sdk.inferenceProviders.list());
    expect(listed).toEqual(await executeTool("manage_inference_providers", { action: "list" }, {}, auth!));
    const retarget = await app.request(`${url}/parity`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "other", displayName: "Rejected" }) });
    expect(retarget.status).toBe(400);
    expect((await sdk.inferenceProviders.list()).providers[0]?.displayName).toBe("Shared");
    const madeDefault = await app.request(`${url}/parity/default`, { method: "PUT", body: "" });
    expect(madeDefault.status).toBe(200);
    const removed = await app.request(`${url}/parity`, { method: "DELETE", body: "" });
    expect(removed.status).toBe(200);
    expect((await sdk.inferenceProviders.list()).providers).toEqual([]);
  });

	test("provider reads enforce PAT scopes with a JSON forbidden response", async () => {
		const { agentRoutes } = await import("../agent-routes.js");
		authStash.authSource = "pat";
		authStash.mcpAuthInfo = { scopes: [] };
		const denied = await agentRoutes.request("/inference-providers");
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: expect.any(String) });
		authStash.mcpAuthInfo = { scopes: ["mcp:read"] };
		const allowed = await agentRoutes.request("/inference-providers");
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ providers: [] });
	});

	test("Codex runtime support does not allow subscription credentials through API-key creation", async () => {
		const res = await createProvider({ slug: "chatgpt", kind: "chatgpt", apiKey: "synthetic-not-a-subscription" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Provider 'chatgpt' can't be added with an API key — it signs in instead." });
		expect(await readCapabilities("chatgpt")).toBeUndefined();
	});

	test("duplicate create remains a conflict without replacing state or audit", async () => {
		const body = { slug: "duplicate", kind: "groq", apiKey: "synthetic-original" };
		expect((await createProvider(body)).status).toBe(201);
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const before = await sql`SELECT name, ciphertext FROM agent_secrets WHERE organization_id = ${ORG}`;
		expect((await createProvider({ ...body, apiKey: "synthetic-replacement" })).status).toBe(409);
		expect(await sql`SELECT name, ciphertext FROM agent_secrets WHERE organization_id = ${ORG}`).toEqual(before);
		expect(await sql`SELECT id FROM inference_providers WHERE organization_id = ${ORG} AND deleted_at IS NULL`).toHaveLength(1);
		expect(await sql`SELECT id FROM events WHERE organization_id = ${ORG} AND metadata->>'resource_kind' = 'inference-provider'`).toHaveLength(1);
	});

	test("audit failure rolls back provider creation, edits, defaults, keys and deletion", async () => {
		for (const slug of ["original", "alternate"]) expect((await createProvider({ slug, kind: "groq", apiKey: `synthetic-${slug}`, capabilities: { text: { model: "synthetic-model" } } })).status).toBe(201);
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const snapshot = async () => ({
			providers: await sql`SELECT * FROM inference_providers WHERE organization_id = ${ORG} ORDER BY id`,
			secrets: await sql`SELECT name, ciphertext FROM agent_secrets WHERE organization_id = ${ORG} ORDER BY name`,
			audits: await sql`SELECT id FROM events WHERE organization_id = ${ORG} AND metadata->>'category' = 'config' ORDER BY id`,
		});
		const before = await snapshot();
		await sql.unsafe("CREATE FUNCTION reject_provider_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic provider audit failure'; END IF; RETURN NEW; END $$");
		await sql.unsafe("CREATE TRIGGER reject_provider_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_provider_audit()");
		try {
			expect((await createProvider({ slug: "rejected", kind: "groq", apiKey: "synthetic-rejected" })).status).toBe(500);
			const { agentRoutes } = await import("../agent-routes.js");
			for (const [path, method, body] of [
				["original", "PUT", { displayName: "Changed" }],
				["alternate/default", "PUT", {}],
				["original/key", "PUT", { value: "synthetic-rotated" }],
				["original/capabilities/text", "PUT", { block: { model: "synthetic-model" } }],
				["original", "DELETE", {}],
			] as const) {
				const response = await agentRoutes.request(`/inference-providers/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
				expect(response.status).toBe(500);
				expect(await snapshot()).toEqual(before);
			}
		} finally {
			await sql.unsafe("DROP TRIGGER reject_provider_audit ON events");
			await sql.unsafe("DROP FUNCTION reject_provider_audit()");
		}
	});

	test("concurrent creates serialize without a parent-lock upgrade deadlock", async () => {
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		let release!: () => void;
		let acquired!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		const ready = new Promise<void>(resolve => { acquired = resolve; });
		const blocker = sql.begin(async tx => {
			await tx`SELECT id FROM organization WHERE id = ${ORG} FOR UPDATE`;
			acquired();
			await held;
		});
		await ready;
		const requests = ["parallel-first", "parallel-second"].map(slug => createProvider({ slug, kind: "groq", apiKey: "synthetic-key", capabilities: { text: { model: "synthetic-model" } } }));
		try {
			const deadline = Date.now() + 5000;
			while (true) {
				const [row] = await sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM organization%'`;
				if (Number(row.waiting) >= 2) break;
				if (Date.now() >= deadline) throw new Error("provider requests never reached the lock barrier");
				await Bun.sleep(10);
			}
		} finally { release(); await blocker; }
		const results = await Promise.all(requests);
		expect(results.map(result => result.status)).toEqual([201, 201]);
		expect(await sql`SELECT id FROM inference_providers WHERE organization_id = ${ORG} AND is_default AND deleted_at IS NULL`).toHaveLength(1);
		expect(await sql`SELECT id FROM events WHERE organization_id = ${ORG} AND metadata->>'resource_kind' = 'inference-provider'`).toHaveLength(2);
	}, 10000);

	test("discovers Gemini text models under the org's provider slug after connecting", async () => {
		const { agentRoutes } = await import("../agent-routes.js");
		const path = "/inference-providers/team-google/models";
		expect((await agentRoutes.request(path)).status).toBe(404);
		expect((await createProvider({
			slug: "team-google",
			kind: "gemini",
			apiKey: "synthetic-google-credential",
		})).status).toBe(201);
		expect(await readCapabilities("team-google")).toEqual({});
		const originalFetch = globalThis.fetch;
		const requests: Array<{ page: string | null; key: string | null }> = [];
		let upstreamStatus = 200;
		let modelsDevReachable = true;
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (url.hostname === "models.dev") {
				if (!modelsDevReachable) throw new TypeError("synthetic network failure");
				return Response.json({ google: { models: {
					"text-1": { tool_call: true, modalities: { output: ["text"] } },
					"text-retired": { status: "deprecated", tool_call: true, modalities: { output: ["text"] } },
					"image-1": { tool_call: true, modalities: { output: ["image"] } },
					"text-no-tools": { tool_call: false, modalities: { output: ["text"] } },
					"null-entry": null,
					"text-string-output": { tool_call: true, modalities: { output: "text" } },
				} } });
			}
			const page = url.searchParams.get("pageToken");
			requests.push({ page, key: new Headers(init?.headers).get("x-goog-api-key") });
			if (upstreamStatus !== 200) return new Response("upstream error", { status: upstreamStatus });
			return Response.json(page ? {
				models: [{ name: "models/text-2", supportedGenerationMethods: ["generateContent"] }],
			} : {
				nextPageToken: "second",
				models: [
					{ name: "models/text-1", displayName: "Text One", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/embed-1", supportedGenerationMethods: ["embedContent"] },
					{ name: "models/text-retired", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/image-1", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/text-no-tools", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/null-entry", supportedGenerationMethods: ["generateContent"] },
					{ name: "models/text-string-output", supportedGenerationMethods: ["generateContent"] },
				],
			});
		}) as typeof fetch;
		try {
			// Only text-1 is a current, tool-capable text model per models.dev:
			// text-retired is deprecated, image-1 is image-only, text-no-tools
			// cannot call tools, text-2 is not in models.dev at all, and the
			// malformed null-entry and text-string-output entries are skipped
			// without failing the rest of the listing.
			const discovered = await agentRoutes.request(path);
			expect(discovered.status).toBe(200);
			expect(discovered.headers.get("cache-control")).toBe("private, no-store");
			expect(await discovered.json()).toEqual({ models: [
				{ id: "text-1", label: "Text One" },
			] });
			expect(requests).toEqual([
				{ page: null, key: "synthetic-google-credential" },
				{ page: "second", key: "synthetic-google-credential" },
			]);
			// Once the cached catalog expires, a failed refresh keeps filtering
			// with the last catalog models.dev returned.
			modelsDevReachable = false;
			const later = Date.now() + 2 * 60 * 60 * 1000;
			const clock = spyOn(Date, "now").mockReturnValue(later);
			try {
				const stale = await agentRoutes.request(path);
				expect(stale.status).toBe(200);
				expect(await stale.json()).toEqual({ models: [
					{ id: "text-1", label: "Text One" },
				] });
			} finally {
				clock.mockRestore();
			}
			// With no catalog ever fetched, an unreachable models.dev fails
			// open: the provider's own list, unfiltered.
			__resetModelsDevCacheForTests();
			const unfiltered = await agentRoutes.request(path);
			expect(unfiltered.status).toBe(200);
			expect(await unfiltered.json()).toEqual({ models: [
				{ id: "text-1", label: "Text One" },
				{ id: "text-retired", label: "text-retired" },
				{ id: "image-1", label: "image-1" },
				{ id: "text-no-tools", label: "text-no-tools" },
				{ id: "null-entry", label: "null-entry" },
				{ id: "text-string-output", label: "text-string-output" },
				{ id: "text-2", label: "text-2" },
			] });
			upstreamStatus = 503;
			expect((await agentRoutes.request(path)).status).toBe(503);
			authStash.memberRole = "member";
			expect((await agentRoutes.request(path)).status).toBe(403);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("lists Claude and ChatGPT models live from each provider's own catalog", async () => {
		const { agentRoutes } = await import("../agent-routes.js");
		const { ensureOAuthInferenceProvider } = await import("../stores/provider-secrets.js");
		expect((await createProvider({ slug: "team-claude", kind: "claude", apiKey: "synthetic-anthropic-key" })).status).toBe(201);
		await ensureOAuthInferenceProvider({ organizationId: ORG, slug: "chatgpt", kind: "chatgpt", createdBy: USER });
		// The modules honor upstream overrides; pin the default hosts this test serves.
		const upstreamOverrides = ["ANTHROPIC_BASE_URL", "OPENAI_CODEX_BASE_URL"] as const;
		const savedOverrides = upstreamOverrides.map((key) => [key, process.env[key]] as const);
		for (const key of upstreamOverrides) delete process.env[key];
		const originalFetch = globalThis.fetch;
		const credentials: Record<string, string | null> = {};
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			if (url.hostname === "models.dev") return Response.json({});
			if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/models") {
				credentials.anthropic = headers.get("x-api-key");
				return Response.json({ data: [{ id: "synthetic-claude-1", display_name: "Synthetic Claude One" }], has_more: false });
			}
			if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/models") {
				credentials.chatgpt = headers.get("chatgpt-account-id");
				return Response.json({ models: [{ slug: "synthetic-codex-1", context_window: 1000 }] });
			}
			return new Response("unexpected upstream", { status: 500 });
		}) as typeof fetch;
		try {
			const claude = await agentRoutes.request("/inference-providers/team-claude/models");
			expect(claude.status).toBe(200);
			expect(await claude.json()).toEqual({ models: [{ id: "synthetic-claude-1", label: "Synthetic Claude One" }] });
			expect(credentials.anthropic).toBe("synthetic-anthropic-key");

			// The ChatGPT row is a subscription sign-in with no row key, so
			// discovery needs the caller's org-bucket profile; 409 without one.
			expect((await agentRoutes.request("/inference-providers/chatgpt/models")).status).toBe(409);
			oauthProfiles.chatgpt = { credential: syntheticChatGptToken(), authType: "oauth" };
			const chatgpt = await agentRoutes.request("/inference-providers/chatgpt/models");
			expect(chatgpt.status).toBe(200);
			expect(await chatgpt.json()).toEqual({ models: [{ id: "synthetic-codex-1", label: "synthetic-codex-1" }] });
			expect(credentials.chatgpt).toBe("synthetic-account");
		} finally {
			globalThis.fetch = originalFetch;
			for (const [key, value] of savedOverrides) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("an explicitly requested text model is stored as given", async () => {
		const res = await createProvider({
			slug: "groq",
			kind: "groq",
			apiKey: "synthetic-key",
			capabilities: { text: { model: "explicit-text-model" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("groq")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("explicit-text-model");
	});

	test("a provider created without a text model gets none and is not the org default", async () => {
		// No repo default exists to seed: the text model is the user's choice,
		// and `promoteOldestRunnableProvider` keys on it, so a model-less row
		// must not become the org default.
		const res = await createProvider({
			slug: "my-claude",
			kind: "claude",
			apiKey: "sk-ant-test",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-claude")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBeUndefined();

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const rows = (await sql`
      SELECT is_default FROM inference_providers
      WHERE organization_id = ${ORG} AND slug = 'my-claude' AND deleted_at IS NULL
    `) as Array<{ is_default: boolean }>;
		expect(rows[0]?.is_default).toBe(false);
	});

	test("a kind absent from the catalog is created without a model and is not the org default", async () => {
		const res = await createProvider({
			slug: "my-mystery",
			kind: "some-unlisted-endpoint",
			apiKey: "sk-mystery",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-mystery")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBeUndefined();

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const rows = (await sql`
      SELECT is_default FROM inference_providers
      WHERE organization_id = ${ORG} AND slug = 'my-mystery' AND deleted_at IS NULL
    `) as Array<{ is_default: boolean }>;
		expect(rows[0]?.is_default).toBe(false);
	});
});
