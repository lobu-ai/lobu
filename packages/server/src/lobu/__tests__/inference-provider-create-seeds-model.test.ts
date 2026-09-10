/** Route coverage for seeding a catalog default text model at provider create. */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	__resetEncryptionKeyCacheForTests,
	type ModuleInterface,
	moduleRegistry,
} from "@lobu/core";
import { ApiKeyProviderModule } from "../../gateway/auth/api-key-provider-module.js";
import { ChatGPTOAuthModule } from "../../gateway/auth/chatgpt/chatgpt-oauth-module.js";
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
	// file so the seed reads the same catalog defaults production does.
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
 * Register the provider modules the route's seeding predicate consults.
 *
 * `wouldRoute` asks `buildProviderCatalog()` — with NO configs — because that
 * is the exact expression `getModelPolicy` evaluates when it decides whether a
 * row routes. That reads the MODULE REGISTRY, which a booted server populates
 * and a bare test process does not. Without these registrations the predicate
 * answers "nothing routes" and every alias assertion below would pass for the
 * wrong reason.
 *
 * `gemini` registers as a real ApiKeyProviderModule (an API key reaches it);
 * `claude` as a plain OAuth-shaped module, which is what it actually is — it
 * has an upstream in providers.json that only a signed-in session can use.
 */
function registerCatalogModules(): void {
	// The registry is a process-wide singleton and `bun test` shares one process
	// across files. Snapshot before registering so afterEach can put it back —
	// without that, a leaked `gemini` module changes the answer in
	// worker-session-context-model-fallback.test.ts, which depends on gemini
	// being ABSENT. (Observed: that suite failed with "Expected byo2, Received
	// gemini" the moment these registrations leaked.)
	savedModules = new Map(
		(moduleRegistry as unknown as { modules: Map<string, ModuleInterface> })
			.modules,
	);
	moduleRegistry.register(
		new ApiKeyProviderModule({
			providerId: "gemini",
			slug: "gemini",
			sdkCompat: "openai",
			upstreamBaseUrl:
				"https://generativelanguage.googleapis.com/v1beta/openai",
			envVarName: "GEMINI_API_KEY",
			providerDisplayName: "Gemini",
			providerIconUrl: "",
			apiKeyInstructions: "",
			apiKeyPlaceholder: "",
			authProfilesManager: { getBestProfile: async () => null } as never,
		}) as unknown as ModuleInterface,
	);
	moduleRegistry.register(new ChatGPTOAuthModule({} as never) as unknown as ModuleInterface);
	moduleRegistry.register({
		name: "claude-provider",
		isEnabled: () => true,
		providerId: "claude",
		providerDisplayName: "Claude",
		providerIconUrl: "",
		authType: "oauth",
		supportedAuthTypes: ["oauth", "api-key"],
		sdkCompat: "anthropic",
		hasSystemKey: () => false,
		getSecretEnvVarNames: () => [],
	} as unknown as ModuleInterface);
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

describe("POST /inference-providers seeds a routable text model", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg();
		registerCatalogModules();
		authStash.user = {
			id: USER,
			name: "Test",
			email: "cs@test",
			emailVerified: true,
		};
		authStash.organizationId = ORG;
		authStash.authSource = "session";
		authStash.mcpAuthInfo = null;
	});

	afterEach(() => restoreModules());

	test("Codex runtime support does not allow subscription credentials through API-key creation", async () => {
		const res = await createProvider({ slug: "chatgpt", kind: "chatgpt", apiKey: "synthetic-not-a-subscription" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "Provider 'chatgpt' can't be added with an API key — it signs in instead." });
		expect(await readCapabilities("chatgpt")).toBeUndefined();
	});

	test("a catalog provider created with NO capabilities gets the catalog default model", async () => {
		const res = await createProvider({
			slug: "gemini",
			kind: "gemini",
			apiKey: "AIza-test",
		});
		expect(res.status).toBe(201);

		// Without the seed this remains `{}` and cannot become the org default.
		const capabilities = (await readCapabilities("gemini")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an explicitly requested model is NOT overwritten by the catalog default", async () => {
		const res = await createProvider({
			slug: "gemini",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { model: "gemini-2.5-flash" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("gemini")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-flash");
	});

	test("a caller-supplied base_url survives seeding", async () => {
		// Seeding must MERGE into the caller's text block, never replace it —
		// dropping a tenant upstream would silently re-point the org at the
		// catalog URL.
		const res = await createProvider({
			slug: "my-upstream",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { base_url: "https://tenant.example.com/v1" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-upstream")) as {
			text?: { model?: string; base_url?: string };
		};
		expect(capabilities?.text?.base_url).toBe("https://tenant.example.com/v1");
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an ALIAS slug with no base_url IS seeded — its kind's catalog upstream routes it", async () => {
		// `getModelPolicy` keys its module map by SLUG, so "my-gemini" matches no
		// static module and synthesis is the row's only route. Synthesis falls
		// back to the upstream the row's KIND resolves to, so the row does route
		// and must be seeded like any other: a text model is the predicate the
		// org-default promotion uses, and an unseeded row would be passed over
		// even though it works.
		const res = await createProvider({
			slug: "my-gemini",
			kind: "gemini",
			apiKey: "AIza-test",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-gemini")) as {
			text?: { model?: string; base_url?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
		// Seeding must NOT write the catalog URL onto the row — the row stays
		// "no custom upstream" so resolveUrlInvariant keeps answering
		// `org-credential` rather than the tenant-URL `org-only` path.
		expect(capabilities?.text?.base_url).toBeUndefined();
	});

	test("an OAuth kind is NOT seeded and does NOT become the org default", async () => {
		// The trap this pins: providers.json gives `claude` BOTH an
		// `upstreamBaseUrl` and `sdkCompat: "anthropic"`, so a seeding predicate
		// that trusts providers.json says "this routes". It does not — claude
		// registers as an OAuth module, not an ApiKeyProviderModule, so
		// `buildProviderCatalog()` reports baseUrl "" and synthesis refuses it.
		//
		// Seeding it anyway would be the worst outcome available: a text model is
		// what `promoteOldestRunnableProvider` keys on, so the unroutable row
		// becomes the ORG DEFAULT and breaks every allow-all agent in the org.
		// The predicate therefore asks the same question routing asks.
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

	test("a kind absent from the catalog is still NOT seeded — nothing to route to", async () => {
		// The remaining unroutable shape: no static module answers to the slug,
		// the row names no upstream, and the kind has none to fall back to.
		// Seeding it would promote an unroutable row to org default.
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

	test("an alias slug WITH a base_url is seeded — synthesis can route it", async () => {
		const res = await createProvider({
			slug: "my-gemini-2",
			kind: "gemini",
			apiKey: "AIza-test",
			capabilities: { text: { base_url: "https://tenant.example.com/v1" } },
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("my-gemini-2")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBe("gemini-2.5-pro");
	});

	test("an unknown kind with no model is still created (no catalog default to seed)", async () => {
		const res = await createProvider({
			slug: "custom-thing",
			kind: "some-unlisted-endpoint",
			apiKey: "sk-custom",
		});
		expect(res.status).toBe(201);

		const capabilities = (await readCapabilities("custom-thing")) as {
			text?: { model?: string };
		};
		expect(capabilities?.text?.model).toBeUndefined();
	});
});
