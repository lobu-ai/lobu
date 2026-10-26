/**
 * Ported #1319 regression: the org-scoped LLM-provider OAuth flow must reuse the
 * EXACT `redirect_uri` from the authorize step at the token exchange. RFC 6749
 * §4.1.3 requires them byte-identical; the old per-agent handler once shipped a
 * hardcoded `console.anthropic.com` override that made Anthropic reject every
 * exchange with `invalid_grant: Invalid 'redirect_uri'`.
 *
 * This is the SAME invariant the deleted `agent-routes-oauth-redirect.test.ts`
 * guarded, re-pointed at the NEW generic routes:
 *
 *   POST /inference-providers/oauth/start     { providerId: 'claude' }
 *        → { mode:'redirect', authorizeUrl } (redirect_uri =
 *          CLAUDE_PROVIDER.redirectUri = https://platform.claude.com/oauth/code/callback)
 *   POST /inference-providers/oauth/complete  { providerId:'claude', code:'code#state' }
 *        → exchanges at the token endpoint and stores to the ORG BUCKET
 *          (userId, "__org_oauth__:<orgId>").
 *
 * Runs BOTH handlers through the Hono app with a mocked token endpoint, asserts
 * the exchange's redirect_uri equals the one the authorize step sent, that the
 * body was form-encoded (#1305), and that the credential persisted via the REAL
 * `AuthProfilesManager` to the org bucket with `organization_id` set.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { TEST_CLAUDE_OAUTH } from "../../gateway/auth/oauth/__tests__/fixtures.js";
import {
	clearOAuthProviderRegistry,
	setOAuthProviderRegistry,
} from "../../gateway/auth/oauth/providers.js";
import { orgContext } from "../stores/org-context";
import {
	buildRealClaudeAuthStack,
	type RealClaudeAuthStack,
} from "./helpers/real-claude-auth-stack";
import {
	authStash,
	coreServicesStash,
	installRouteTestMocks,
} from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ORG = "org-oauth";
const USER = "u1";
const ORG_BUCKET = `__org_oauth__:${ORG}`;

const EXPECTED_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";

const realFetch = globalThis.fetch;

beforeAll(async () => {
	await ensureDbForGatewayTests();
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function importAgentRoutes() {
	const mod = await import("../agent-routes.js");
	return mod.agentRoutes;
}

async function seedOrg(): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Test', 'u1@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
}

/** Captures the body POSTed to Anthropic's token endpoint, returns a fake
 *  token. Every other URL falls through to the real fetch. */
function installTokenEndpointMock(captured: {
	url?: string;
	contentType?: string | null;
	body?: string;
}): void {
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const parsedUrl = new URL(url);
			if (
				parsedUrl.hostname === "platform.claude.com" &&
				parsedUrl.pathname === "/v1/oauth/token"
			) {
				captured.url = url;
				captured.contentType = init?.headers?.["Content-Type"] ?? null;
				captured.body = typeof init?.body === "string" ? init.body : "";
			return new Response(
				JSON.stringify({
					access_token: "sk-ant-oat01-test-access",
					refresh_token: "sk-ant-ort01-test-refresh",
					token_type: "Bearer",
					expires_in: 28800,
					scope: "user:inference",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return realFetch(input, init);
	}) as typeof fetch;
}

describe("Org OAuth: redirect_uri matches between authorize and exchange", () => {
	let stack: RealClaudeAuthStack;

	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg();
		authStash.user = {
			id: USER,
			name: "Test",
			email: "u1@test",
			emailVerified: true,
		};
		authStash.organizationId = ORG;
		authStash.authSource = "session";
		authStash.mcpAuthInfo = null;

		stack = await orgContext.run({ organizationId: ORG }, () =>
			buildRealClaudeAuthStack({ durableSecrets: true }),
		);
		// Seed AFTER CoreServices.init — init reloads the OAuth registry from
		// providers.json (or empties it when the path is missing in CI cwd).
		setOAuthProviderRegistry([TEST_CLAUDE_OAUTH]);
		coreServicesStash.services = {
			getOAuthStateStore: () => stack.oauthStateStore,
			getAuthProfilesManager: () => stack.authProfilesManager,
		};
	});

	afterEach(async () => {
		globalThis.fetch = realFetch;
		coreServicesStash.services = null;
		clearOAuthProviderRegistry();
		await stack?.shutdown();
	});

	test("exchange reuses the authorize redirect_uri and stores to the org bucket", async () => {
		const captured: {
			url?: string;
			contentType?: string | null;
			body?: string;
		} = {};
		installTokenEndpointMock(captured);

		const app = await importAgentRoutes();

		// 1. start → JSON { mode:'redirect', authorizeUrl }; pull redirect_uri + state.
		const startRes = await app.request("/inference-providers/oauth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerId: "claude" }),
		});
		expect(startRes.status).toBe(200);
		const startJson = (await startRes.json()) as {
			mode: string;
			authorizeUrl: string;
		};
		expect(startJson.mode).toBe("redirect");
		const authorizeUrl = new URL(startJson.authorizeUrl);
		const authorizeRedirectUri = authorizeUrl.searchParams.get("redirect_uri");
		const state = authorizeUrl.searchParams.get("state");
		expect(authorizeRedirectUri).toBe(EXPECTED_REDIRECT_URI);
		expect(state).toBeTruthy();
		// #3 extraAuthParams echo: the authorize URL carries `code=true`.
		expect(authorizeUrl.searchParams.get("code")).toBe("true");

		// 2. complete with the pasted `code#state` → token exchange.
		const completeRes = await app.request(
			"/inference-providers/oauth/complete",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					providerId: "claude",
					code: `fake-auth-code#${state}`,
				}),
			},
		);
		expect(completeRes.status).toBe(200);
		expect(await completeRes.json()).toEqual({ status: "success" });

		// #1305: exchange must be form-encoded and carry the SAME redirect_uri.
		expect(captured.contentType).toBe("application/x-www-form-urlencoded");
		const exchangeParams = new URLSearchParams(captured.body ?? "");
		expect(exchangeParams.get("redirect_uri")).toBe(authorizeRedirectUri);
		expect(exchangeParams.get("redirect_uri")).toBe(EXPECTED_REDIRECT_URI);

		// Persisted via the REAL AuthProfilesManager to the ORG BUCKET.
		const stored = await orgContext.run({ organizationId: ORG }, () =>
			stack.authProfilesManager.getProviderProfiles(ORG_BUCKET, "claude", USER),
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ provider: "claude", authType: "oauth" });
		expect(stored[0]?.credential).toBe("sk-ant-oat01-test-access");

		const { listInferenceProviders, resolveInferenceProviderConfig } =
			await import("../stores/provider-secrets");
		const providers = await listInferenceProviders(ORG);
		expect(providers).toHaveLength(1);
		expect(providers[0]).toMatchObject({
			slug: "claude",
			kind: "claude",
			displayName: "Claude",
			status: "active",
		});
		expect(
			await resolveInferenceProviderConfig(ORG, "claude", "text"),
		).toBeNull();

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		await sql`
      UPDATE inference_providers
      SET deleted_at = now()
      WHERE organization_id = ${ORG} AND slug = 'claude'
    `;
		const repairedRes = await app.request("/inference-providers");
		expect(repairedRes.status).toBe(200);
		const repaired = (await repairedRes.json()) as {
			providers: Array<{
				slug: string;
				kind: string;
				displayName: string | null;
			}>;
		};
		expect(repaired.providers).toHaveLength(1);
		expect(repaired.providers[0]).toMatchObject({
			slug: "claude",
			kind: "claude",
			displayName: "Claude",
		});

		const deleteRes = await app.request("/inference-providers/claude", {
			method: "DELETE",
		});
		expect(deleteRes.status).toBe(200);
		const afterDeleteRes = await app.request("/inference-providers");
		expect(afterDeleteRes.status).toBe(200);
		const afterDelete = (await afterDeleteRes.json()) as {
			providers: Array<{ slug: string }>;
		};
		expect(afterDelete.providers).toHaveLength(0);
		const removedProfiles = await orgContext.run({ organizationId: ORG }, () =>
			stack.authProfilesManager.getProviderProfiles(ORG_BUCKET, "claude", USER),
		);
		expect(removedProfiles).toHaveLength(0);
	});

	test("audit failure rolls back OAuth profile, secrets and visible provider together", async () => {
		installTokenEndpointMock({});
		const app = await importAgentRoutes();
		const start = await app.request("/inference-providers/oauth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerId: "claude" }),
		});
		const state = new URL(
			((await start.json()) as { authorizeUrl: string }).authorizeUrl,
		).searchParams.get("state");
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		await sql.unsafe(
			`CREATE OR REPLACE FUNCTION reject_oauth_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' THEN RAISE EXCEPTION 'synthetic OAuth audit failure'; END IF; RETURN NEW; END $$`,
		);
		await sql.unsafe(
			"CREATE TRIGGER reject_oauth_config_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_oauth_config_audit()",
		);
		try {
			const response = await app.request("/inference-providers/oauth/complete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ providerId: "claude", code: `fake-auth-code#${state}` }),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: "synthetic OAuth audit failure" });
			expect(
				await sql`SELECT user_id FROM user_auth_profiles WHERE user_id = ${USER} AND agent_id = ${ORG_BUCKET}`,
			).toHaveLength(0);
			expect(await sql`SELECT name FROM agent_secrets WHERE organization_id = ${ORG}`).toHaveLength(0);
			expect(await sql`SELECT id FROM inference_providers WHERE organization_id = ${ORG}`).toHaveLength(0);
		} finally {
			await sql.unsafe("DROP TRIGGER reject_oauth_config_audit ON events");
			await sql.unsafe("DROP FUNCTION reject_oauth_config_audit()");
		}
	});

	test("headless (non-session) start hard-fails with a clear message", async () => {
		authStash.authSource = "pat";
		authStash.mcpAuthInfo = { scopes: ["mcp:admin"] };

		const app = await importAgentRoutes();
		const res = await app.request("/inference-providers/oauth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ providerId: "claude" }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()) as { error: string }).toEqual({
			error: "OAuth providers require interactive sign-in",
		});
	});
});
