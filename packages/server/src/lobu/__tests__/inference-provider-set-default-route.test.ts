/**
 * Route coverage for `PUT /inference-providers/:slug/default`.
 *
 * The store returns THREE distinct rejections and the route must turn each
 * into an accurate, actionable message. Collapsing them was a real defect: an
 * OAuth provider was told "no text model is configured", which is both false
 * (it has one) and unactionable (setting a model changes nothing).
 *
 * Covers all three branches end-to-end through Hono, not just the store:
 *   - missing slug            → 404
 *   - live row, no text model → 400 "has no text model configured"
 *   - live row, oauth:// ref  → 400 "signed in with OAuth"
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "org-set-default";
const USER = "u-set-default";

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
    VALUES (${USER}, 'Test', 'sd@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function setDefault(slug: string): Promise<Response> {
	const app = await importAgentRoutes();
	return await app.request(
		`/inference-providers/${encodeURIComponent(slug)}/default`,
		{ method: "PUT" },
	);
}

describe("PUT /inference-providers/:slug/default", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg();
		authStash.user = {
			id: USER,
			name: "Test",
			email: "sd@test",
			emailVerified: true,
		};
		authStash.organizationId = ORG;
		authStash.authSource = "session";
		authStash.mcpAuthInfo = null;
	});

	test("a runnable API-key provider is accepted", async () => {
		const { createInferenceProvider } = await import(
			"../stores/provider-secrets.js"
		);
		await orgContext.run({ organizationId: ORG }, () =>
			createInferenceProvider({
				organizationId: ORG,
				slug: "openai",
				kind: "openai",
				apiKey: "sk-openai",
				capabilities: { text: { model: "gpt-4o-mini" } },
			}),
		);

		const res = await setDefault("openai");
		expect(res.status).toBe(200);
		expect((await res.json()) as { isDefault: boolean }).toMatchObject({
			isDefault: true,
		});
	});

	test("a missing slug is 404, not a 400", async () => {
		const res = await setDefault("does-not-exist");
		expect(res.status).toBe(404);
	});

	test("no text model → 400 telling the caller to set one", async () => {
		const { createInferenceProvider } = await import(
			"../stores/provider-secrets.js"
		);
		await orgContext.run({ organizationId: ORG }, () =>
			createInferenceProvider({
				organizationId: ORG,
				slug: "groq",
				kind: "groq",
				apiKey: "sk-groq",
				capabilities: {},
			}),
		);

		const res = await setDefault("groq");
		expect(res.status).toBe(400);
		const { error } = (await res.json()) as { error: string };
		expect(error).toContain("no text model configured");
		expect(error).toContain(
			"lobu providers set-capability groq text --model <model>",
		);
	});

	test("an oauth provider → 400 explaining the credential is per-user", async () => {
		const {
			ensureOAuthInferenceProvider,
			updateInferenceProviderCapabilities,
		} = await import("../stores/provider-secrets.js");
		await orgContext.run({ organizationId: ORG }, async () => {
			await ensureOAuthInferenceProvider({
				organizationId: ORG,
				slug: "claude",
				kind: "claude",
			});
			await updateInferenceProviderCapabilities(ORG, "claude", "text", {
				model: "synthetic-model",
			});
		});

		const res = await setDefault("claude");
		expect(res.status).toBe(400);
		const { error } = (await res.json()) as { error: string };
		// The DISTINCT message: claude HAS a text model, so telling the caller to
		// set one would be false and would not help.
		expect(error).toContain("OAuth");
		expect(error).not.toContain("no text model configured");
	});
});
