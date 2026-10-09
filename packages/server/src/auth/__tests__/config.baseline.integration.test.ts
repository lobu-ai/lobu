/**
 * Integration test for the global login-provider baseline.
 *
 * Reproduces the original symptom — an org-scoped login page (resolved from a
 * `/market/...` callback) returned `social: {}` while the default login page
 * showed Google/GitHub — and proves the fix: every deployment exposes the
 * baseline providers (those with env credentials) regardless of org context,
 * with no AUTH_DEFAULT_ORGANIZATION_SLUG pointer.
 *
 * Unlike config.test.ts, this does NOT mock the catalog or the DB: it scans the
 * real bundled connector catalog (via the prebuilt manifest) and uses the
 * embedded-Postgres test database. It therefore exercises the actual
 * catalog → collect → merge → credential-gate path end to end.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDb } from "../../__tests__/setup/test-db";
import { createTestOrganization } from "../../__tests__/setup/test-fixtures";
import { clearCatalogCacheForTests } from "../../catalog/load";
import type { Env } from "../../index";
import {
	clearLoginProviderCachesForTests,
	getAuthConfig,
	getEnabledLoginProviderConfigs,
} from "../config";

// Dummy credentials are enough: getAuthConfig only needs clientId + clientSecret
// to *resolve* for a provider to be marked enabled — it never calls the IdP here.
const ENV = {
	GOOGLE_CLIENT_ID: "test-google-id",
	GOOGLE_CLIENT_SECRET: "test-google-secret",
	GITHUB_CLIENT_ID: "test-github-id",
	GITHUB_CLIENT_SECRET: "test-github-secret",
} as unknown as Env;

// resolveLoginProviderCredentials falls back to process.env
// (`authValues[key] || env[key] || process.env[key]`), so ambient
// GOOGLE_*/GITHUB_*/… credentials in a dev shell would silently enable
// providers these tests assert are hidden. Scrub them for the duration of
// the file (every test passes its credentials via an explicit Env object)
// and restore after — the suite runs single-fork with isolate:false, so a
// leaked deletion would bleed into later files.
const CREDENTIAL_ENV_KEYS = [
	"GOOGLE",
	"GITHUB",
	"LINKEDIN",
	"MICROSOFT",
	"SLACK",
	"AGENTID",
].flatMap((provider) => [`${provider}_CLIENT_ID`, `${provider}_CLIENT_SECRET`]);

describe("login provider baseline (integration)", () => {
	let prevCatalogUris: string | undefined;
	const ambientCredentials = new Map<string, string | undefined>();

	beforeAll(async () => {
		prevCatalogUris = process.env.LOBU_CATALOG_URIS;
		delete process.env.LOBU_CATALOG_URIS;
		clearCatalogCacheForTests();
		for (const key of CREDENTIAL_ENV_KEYS) {
			ambientCredentials.set(key, process.env[key]);
			delete process.env[key];
		}
		clearLoginProviderCachesForTests();
	});

	afterAll(async () => {
		if (prevCatalogUris === undefined) delete process.env.LOBU_CATALOG_URIS;
		else process.env.LOBU_CATALOG_URIS = prevCatalogUris;
		clearCatalogCacheForTests();
		for (const [key, value] of ambientCredentials) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearLoginProviderCachesForTests();
	});

	it("exposes baseline providers with no org context (the default login page)", async () => {
		const config = await getAuthConfig(ENV, { organizationId: null });
		expect(config.social.google).toBe(true);
		expect(config.social.github).toBe(true);
		expect(Object.keys(config.socialMeta).sort()).toEqual(
			Object.keys(config.social).sort(),
		);
		expect(typeof config.socialMeta.google.name).toBe("string");
		expect(config.socialMeta.google.name.length).toBeGreaterThan(0);
	});

	it("exposes the SAME baseline for an org with no login_enabled connectors (the /market case)", async () => {
		// An org id that has no rows in connector_definitions — exactly the state
		// that previously produced `social: {}`. It must now inherit the baseline.
		const config = await getAuthConfig(ENV, {
			organizationId: "org-with-no-login-connectors",
		});
		expect(config.social.google).toBe(true);
		expect(config.social.github).toBe(true);
	});

	it("exposes AgentID metadata only when its credentials resolve", async () => {
		const enabled = await getAuthConfig({
			AGENTID_CLIENT_ID: "test-agentid-id",
			AGENTID_CLIENT_SECRET: "test-agentid-secret",
		} as unknown as Env, { organizationId: null });
		expect(enabled.social.agentid).toBe(true);
		expect(enabled.socialMeta.agentid).toEqual({
			name: "AgentID",
			faviconDomain: "agentid.com",
		});

		const disabled = await getAuthConfig(ENV, { organizationId: null });
		expect(disabled.social.agentid).toBeUndefined();
		expect(disabled.socialMeta.agentid).toBeUndefined();
	});

	it("hides providers whose credentials are absent (no silent enable)", async () => {
		// Only Google creds present → GitHub must not appear.
		const googleOnly = {
			GOOGLE_CLIENT_ID: "test-google-id",
			GOOGLE_CLIENT_SECRET: "test-google-secret",
		} as unknown as Env;
		const config = await getAuthConfig(googleOnly, { organizationId: null });
		expect(config.social.google).toBe(true);
		expect(config.social.github).toBeUndefined();
	});

	it("unions an org-specific login connector on top of the baseline (real DB)", async () => {
		const org = await createTestOrganization();
		const sql = getTestDb();
		// A login-enabled connector for a provider NOT in the bundled catalog,
		// scoped to this org. It must be additive — baseline providers survive.
		await sql`
      INSERT INTO connector_definitions (key, name, version, auth_schema, organization_id, status, login_enabled, created_at, updated_at)
      VALUES (
        'acme.sso',
        'Acme SSO',
        '1.0.0',
        ${sql.json({ methods: [{ type: "oauth", provider: "acme", loginScopes: ["openid"] }] })},
        ${org.id},
        'active',
        true,
        NOW(), NOW()
      )
    `;
		clearLoginProviderCachesForTests();

		const providers = (await getEnabledLoginProviderConfigs(org.id)).map(
			(c) => c.provider,
		);
		expect(providers).toContain("acme"); // org-specific, additive
		expect(providers).toContain("google"); // baseline preserved
		expect(providers).toContain("github"); // baseline preserved
	});

	it("lets an org override a baseline provider with its own connector key (real DB)", async () => {
		const org = await createTestOrganization();
		const sql = getTestDb();
		// Org brings its own `google` login connector — it must shadow the baseline
		// google entry (same provider, org's connectorKey wins).
		await sql`
      INSERT INTO connector_definitions (key, name, version, auth_schema, organization_id, status, login_enabled, created_at, updated_at)
      VALUES (
        'org.google',
        'Org Google',
        '1.0.0',
        ${sql.json({ methods: [{ type: "oauth", provider: "google", loginScopes: ["openid", "email"] }] })},
        ${org.id},
        'active',
        true,
        NOW(), NOW()
      )
    `;
		clearLoginProviderCachesForTests();

		const configs = await getEnabledLoginProviderConfigs(org.id);
		const google = configs.find((c) => c.provider === "google");
		expect(google?.connectorKey).toBe("org.google");
	});
});
