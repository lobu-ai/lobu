/**
 * Managed-connector connection-token endpoint + local resolver.
 *
 * The model: a managed connector lives in a PUBLIC org with a managed
 * `oauth_app`. A user JOINS the org (a `member` row) and CONNECTS normally —
 * consent against the managed app mints a connection OWNED by them
 * (`connections.created_by`). The managed client secret + refresh token stay in
 * the cloud. The user's LOCAL Lobu fetches a fresh ACCESS token for its own
 * user's connection at runtime via `POST /oauth/connection-token`, with the
 * instance's cloud PAT.
 *
 * Proven here without a real external provider:
 *
 *   1. A public org has a connector (whose oauth method `tokenUrl` points at a
 *      scoped fake public provider), a managed `oauth_app` (fake client_id/secret), an
 *      `oauth_account` profile + `account` row holding an EXPIRING access token
 *      + a refresh token, and a connection OWNED by a member (`created_by`).
 *   2. `POST /oauth/connection-token` is PAT-gated. The owner's PAT → the cloud
 *      resolves the managed app + connector endpoint, REFRESHES the expiring
 *      token with its secret, and returns ONLY `{ access_token, expires_at }` —
 *      never the refresh token or client secret.
 *   3. Owner-scope: a DIFFERENT member's PAT for the SAME org cannot fetch the
 *      owner's connection token (404). A NON-member PAT → 403. No PAT → 401, bad
 *      PAT → 401, malformed body → 400.
 *   4. Local resolver: a `managedBy` connection resolves its access token by
 *      calling the cloud endpoint (cloud = the in-process server in-test).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { connectionTokenRoutes } from "../../../connect/connection-token-route";
import type { Env } from "../../../index";
import { resolveCredentialsByConnectionId } from "../../../mcp-proxy/credential-resolver";
import { createAuthProfile } from "../../../utils/auth-profiles";
import { resolveExecutionAuth } from "../../../utils/execution-context";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestConnectorDefinition,
	createTestOAuthClient,
	createTestOrganization,
	createTestPAT,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

// Canned tokens the fake provider returns on refresh. Distinct from the stored
// (expiring) token so a successful refresh is observable.
const REFRESHED = {
	access_token: "refreshed-access-token-123",
	refresh_token: "managed-refresh-token-456",
	expires_in: 3600,
};
const STALE_ACCESS_TOKEN = "stale-access-token-000";
const MANAGED_SECRET = "managed-secret";

// Connector-controlled endpoints must remain public even in tests. A scoped
// fetch stub serves this URL while delegating every non-provider call.
const PROVIDER_TOKEN_URL = "https://oauth-provider.example.com/token";
const originalFetch = globalThis.fetch;
let lastRefreshBody: Record<string, string> = {};

// Cloud app served on a real port so the local resolver's `fetch` reaches it.
let cloudServer: ReturnType<typeof serve> | null = null;
let cloudBaseUrl = "";

// Saved instance cloud-config env so afterAll can restore it.
let savedCloudUrl: string | undefined;
let savedCloudPat: string | undefined;

function buildCloudApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/", connectionTokenRoutes);
	return app;
}

beforeAll(async () => {
	await initWorkspaceProvider();

	// Cloud app on a real port (Env carries DATABASE_URL so handlers hit test DB).
	const cloudApp = buildCloudApp();
	cloudServer = await new Promise((resolve) => {
		const s = serve(
			{
				fetch: (req: Request) => cloudApp.fetch(req, TEST_ENV),
				hostname: "127.0.0.1",
				port: 0,
			},
			(info) => {
				cloudBaseUrl = `http://127.0.0.1:${info.port}`;
				resolve(s);
			},
		);
	});

	savedCloudUrl = process.env.LOBU_CLOUD_URL;
	savedCloudPat = process.env.LOBU_CLOUD_PAT;
});

afterAll(async () => {
	if (savedCloudUrl === undefined) delete process.env.LOBU_CLOUD_URL;
	else process.env.LOBU_CLOUD_URL = savedCloudUrl;
	if (savedCloudPat === undefined) delete process.env.LOBU_CLOUD_PAT;
	else process.env.LOBU_CLOUD_PAT = savedCloudPat;
	await new Promise<void>((done) =>
		cloudServer ? cloudServer.close(() => done()) : done(),
	);
});

beforeEach(() => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url === PROVIDER_TOKEN_URL) {
			lastRefreshBody = Object.fromEntries(
				new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
			);
			return Response.json(REFRESHED);
		}
		return originalFetch(input, init);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface SeededManagedConnection {
	orgId: string;
	/** The org slug (callers may pass id OR slug as `org`). */
	orgSlug: string;
	/** The connection OWNER (created_by). */
	ownerId: string;
	/** The owner's PAT — member of the public org, WITH `connections:token`. */
	ownerPat: string;
	/** Same owner/org, but WITHOUT `connections:token` — must be rejected (403). */
	ownerPatNoScope: string;
	connectorKey: string;
	connectionId: number;
	connectionSlug: string;
}

/**
 * Seed a PUBLIC org with a managed `oauth_app`, an `oauth_account` grant (an
 * `account` row with an EXPIRING access token + refresh token), a connector
 * whose tokenUrl points at the fake provider, and a connection OWNED by a
 * member. The connector endpoints live in the org's OWN metadata — the cloud
 * resolves them server-side; the caller never supplies them.
 *
 * By default the org is PUBLIC and the connection is a consent-only managed
 * grant-holder (the only shape the token endpoint will delegate). The `opts`
 * let a test seed the rejected shapes — a private org, or a non-consent-only
 * connection — to prove they are NOT exported (404).
 */
async function seedManagedConnection(
	orgName: string,
	opts?: { visibility?: "public" | "private"; consentOnly?: boolean },
): Promise<SeededManagedConnection> {
	const sql = getTestDb();
	const visibility = opts?.visibility ?? "public";
	const consentOnly = opts?.consentOnly ?? true;
	const org = await createTestOrganization({
		name: orgName,
		visibility,
	});
	const owner = await createTestUser({ name: `${orgName} Owner` });
	await addUserToOrganization(owner.id, org.id, "member");

	const connectorKey = "demo.oauth";
	await createTestConnectorDefinition({
		key: connectorKey,
		name: "Demo OAuth",
		organization_id: org.id,
		auth_schema: {
			methods: [
				{
					type: "oauth",
					provider: "demo",
					requiredScopes: ["read"],
					authorizationUrl: "https://demo.example/authorize",
					tokenUrl: PROVIDER_TOKEN_URL,
					tokenEndpointAuthMethod: "client_secret_post",
					clientIdKey: "DEMO_CLIENT_ID",
					clientSecretKey: "DEMO_CLIENT_SECRET",
				},
			],
		},
		feeds_schema: { items: {} },
	});

	// Managed oauth_app holds the REAL client_id/secret (never leaves the cloud).
	const appProfile = await createAuthProfile({
		organizationId: org.id,
		connectorKey,
		displayName: "Managed Demo App",
		profileKind: "oauth_app",
		provider: "demo",
		authData: {
			DEMO_CLIENT_ID: "managed-cid",
			DEMO_CLIENT_SECRET: MANAGED_SECRET,
		},
	});

	// The grant: an account row with an EXPIRING access token + a refresh token.
	const accountId = `acct_${org.id}`;
	const expiringSoon = new Date(Date.now() + 60 * 1000).toISOString(); // < 5min buffer
	await sql`
    INSERT INTO "account" (
      id, "accountId", "providerId", "userId",
      "accessToken", "refreshToken", "accessTokenExpiresAt",
      scope, "createdAt", "updatedAt"
    ) VALUES (
      ${accountId}, ${accountId}, 'demo', ${owner.id},
      ${STALE_ACCESS_TOKEN}, ${"managed-refresh-token-original"}, ${expiringSoon},
      'read', NOW(), NOW()
    )
  `;

	const accountProfile = await createAuthProfile({
		organizationId: org.id,
		connectorKey,
		displayName: "Demo Account",
		profileKind: "oauth_account",
		provider: "demo",
		accountId,
	});

	// Connection OWNED by the member (created_by), wiring the grant + managed app.
	// Consent-only managed grant-holders carry `config.consent_only = true`.
	// A managed oauth_account grant is owner-scoped (the connection-token endpoint
	// gates on created_by), so it is NOT org-visible — production's create path
	// resolves it to 'private', and the personal-credential DB guard forbids
	// 'org'. Seed 'private' to match (was relying on the old 'org' schema default).
	const connRows = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      account_id, auth_profile_id, app_auth_profile_id, created_by, config,
      visibility, created_at, updated_at
    ) VALUES (
      ${org.id}, ${connectorKey}, ${`demo-${org.id}`}, 'Demo Connection', 'active',
      ${accountId}, ${accountProfile.id}, ${appProfile.id}, ${owner.id},
      ${consentOnly ? sql.json({ consent_only: true }) : null},
      'private', NOW(), NOW()
    )
    RETURNING id, slug
  `) as unknown as Array<{ id: number; slug: string }>;

	// Happy-path PAT carries the least-privilege `connections:token` scope; a
	// sibling PAT for the same owner/org WITHOUT it proves the scope gate.
	const ownerPat = await createTestPAT(owner.id, org.id, {
		scope: "mcp:read mcp:write connections:token",
	});
	const ownerPatNoScope = await createTestPAT(owner.id, org.id, {
		scope: "mcp:read mcp:write",
	});
	return {
		orgId: org.id,
		orgSlug: org.slug,
		ownerId: owner.id,
		ownerPat: ownerPat.token,
		ownerPatNoScope: ownerPatNoScope.token,
		connectorKey,
		connectionId: Number(connRows[0].id),
		connectionSlug: connRows[0].slug,
	};
}

function tokenRequest(
	app: Hono<{ Bindings: Env }>,
	opts: { pat?: string; body?: unknown },
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (opts.pat) headers.Authorization = `Bearer ${opts.pat}`;
	return app.fetch(
		new Request("http://cloud.local/oauth/connection-token", {
			method: "POST",
			headers,
			body: JSON.stringify(opts.body ?? {}),
		}),
		TEST_ENV,
	);
}

describe("managed connector — POST /oauth/connection-token", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		lastRefreshBody = {};
	});

	it("returns a fresh access token to the OWNER, refreshed server-side with the managed secret", async () => {
		const { ownerPat, orgId, connectorKey } =
			await seedManagedConnection("Public Org");
		const app = buildCloudApp();

		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: orgId, connector_key: connectorKey },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// The access token is the REFRESHED one — proves the cloud refreshed via
		// its own tokenUrl + secret (not the stored stale token).
		expect(body.access_token).toBe(REFRESHED.access_token);
		expect(typeof body.expires_at).toBe("string");

		// The cloud authed the refresh with ITS managed client_id/secret.
		expect(lastRefreshBody.client_id).toBe("managed-cid");
		expect(lastRefreshBody.client_secret).toBe(MANAGED_SECRET);
		expect(lastRefreshBody.grant_type).toBe("refresh_token");

		// The response leaks NEITHER the refresh token NOR the client secret.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain(REFRESHED.refresh_token);
		expect(serialized).not.toContain("managed-refresh-token-original");
		expect(serialized).not.toContain(MANAGED_SECRET);
		expect(body.refresh_token).toBeUndefined();
	});

	it("rejects a valid owner PAT that LACKS `connections:token` (403)", async () => {
		// Right user, right org, owns the connection — but the PAT carries only the
		// default `mcp:read mcp:write`. The scope gate (before any lookup) rejects
		// it, so a default member PAT can never mint a managed-connection token.
		const { ownerPatNoScope, orgId, connectorKey } =
			await seedManagedConnection("Public Org");
		const app = buildCloudApp();

		const res = await tokenRequest(app, {
			pat: ownerPatNoScope,
			body: { org: orgId, connector_key: connectorKey },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("insufficient_scope");
		// Rejected before any token resolution — the provider was never contacted.
		expect(lastRefreshBody).toEqual({});
	});

	it("resolves `org` passed as a SLUG (200), same as by id", async () => {
		const { ownerPat, orgSlug, connectorKey } =
			await seedManagedConnection("Public Org Slug");
		const app = buildCloudApp();

		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: orgSlug, connector_key: connectorKey },
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.access_token).toBe(REFRESHED.access_token);
	});

	it("requires an exact connection slug when an owner has multiple grants for a connector", async () => {
		const seeded = await seedManagedConnection("Public Org Multiple Grants");
		const sql = getTestDb();
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status,
				auth_profile_id, app_auth_profile_id, created_by, config,
				visibility, created_at, updated_at
			)
			SELECT
				organization_id, connector_key, ${`${seeded.connectionSlug}-second`},
				'Demo Connection Second', status,
				auth_profile_id, app_auth_profile_id, created_by, config,
				visibility, NOW(), NOW()
			FROM connections
			WHERE id = ${seeded.connectionId}
		`;

		const app = buildCloudApp();
		const ambiguous = await tokenRequest(app, {
			pat: seeded.ownerPat,
			body: { org: seeded.orgId, connector_key: seeded.connectorKey },
		});
		expect(ambiguous.status).toBe(409);
		expect((await ambiguous.json()) as Record<string, unknown>).toMatchObject({
			error: "ambiguous_connection",
		});
		expect(lastRefreshBody).toEqual({});

		const exact = await tokenRequest(app, {
			pat: seeded.ownerPat,
			body: {
				org: seeded.orgId,
				connector_key: seeded.connectorKey,
				connection_slug: seeded.connectionSlug,
			},
		});
		expect(exact.status).toBe(200);
		expect((await exact.json()) as Record<string, unknown>).toMatchObject({
			access_token: REFRESHED.access_token,
		});

		const missing = await tokenRequest(app, {
			pat: seeded.ownerPat,
			body: {
				org: seeded.orgId,
				connector_key: seeded.connectorKey,
				connection_slug: "does-not-exist",
			},
		});
		expect(missing.status).toBe(404);
	});

	it("rejects a DIFFERENT member's PAT for the SAME org (404 — owner-scoped)", async () => {
		const seeded = await seedManagedConnection("Public Org");

		// A second member of the SAME public org — NOT the connection owner. PAT
		// carries `connections:token` so the scope gate passes and we exercise the
		// downstream owner-scope check.
		const other = await createTestUser({ name: "Other Member" });
		await addUserToOrganization(other.id, seeded.orgId, "member");
		const otherPat = await createTestPAT(other.id, seeded.orgId, {
			scope: "mcp:read mcp:write connections:token",
		});

		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: otherPat.token,
			body: { org: seeded.orgId, connector_key: seeded.connectorKey },
		});

		// Member of the org, but does NOT own the connection → 404 (owner-scope).
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("not_found");

		// Sanity: the refresh provider was never contacted.
		expect(lastRefreshBody).toEqual({});
	});

	it("rejects a NON-member PAT (403)", async () => {
		const seeded = await seedManagedConnection("Public Org");

		// A user with their OWN private org — NOT a member of the public org. PAT
		// carries `connections:token` so the scope gate passes and we exercise the
		// downstream membership check.
		const outsider = await createTestUser({ name: "Outsider" });
		const outsiderOrg = await createTestOrganization({ name: "Outsider Org" });
		await addUserToOrganization(outsider.id, outsiderOrg.id, "owner");
		const outsiderPat = await createTestPAT(outsider.id, outsiderOrg.id, {
			scope: "mcp:read mcp:write connections:token",
		});

		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: outsiderPat.token,
			body: { org: seeded.orgId, connector_key: seeded.connectorKey },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("forbidden");
	});

	it("rejects a malformed body (400) — validated, not cast", async () => {
		const { ownerPat } = await seedManagedConnection("Public Org");
		const app = buildCloudApp();

		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: "", connector_key: 42 },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("bad_request");
	});

	it("rejects no PAT (401)", async () => {
		const { orgId, connectorKey } = await seedManagedConnection("Public Org");
		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			body: { org: orgId, connector_key: connectorKey },
		});
		expect(res.status).toBe(401);
	});

	it("rejects an invalid PAT (401)", async () => {
		const { orgId, connectorKey } = await seedManagedConnection("Public Org");
		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: "owl_pat_totally-bogus-token",
			body: { org: orgId, connector_key: connectorKey },
		});
		expect(res.status).toBe(401);
	});

	it("404 when the user owns no active connection for the connector in the org", async () => {
		const { ownerPat, orgId } = await seedManagedConnection("Public Org");
		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: orgId, connector_key: "demo.nonexistent" },
		});
		expect(res.status).toBe(404);
	});

	it("does NOT export the owner's own NON-consent-only connection (404)", async () => {
		// Same owner + public org, but the connection is an ordinary (non
		// consent-only) connection — NOT a managed grant-holder. The endpoint must
		// refuse to delegate it, so a user's normal connection tokens can't leak.
		const { ownerPat, orgId, connectorKey } = await seedManagedConnection(
			"Public Org NonConsent",
			{ consentOnly: false },
		);
		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: orgId, connector_key: connectorKey },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("not_found");
		// The refresh provider was never contacted — no token resolution at all.
		expect(lastRefreshBody).toEqual({});
	});

	it("does NOT export a consent-only connection in a PRIVATE org (404)", async () => {
		// Consent-only, owned by the caller, but the org is PRIVATE — managed
		// connectors only live in public orgs, so a private-org connection (even a
		// consent-only one) must not be exported.
		const { ownerPat, orgId, connectorKey } = await seedManagedConnection(
			"Private Org Consent",
			{ visibility: "private", consentOnly: true },
		);
		const app = buildCloudApp();
		const res = await tokenRequest(app, {
			pat: ownerPat,
			body: { org: orgId, connector_key: connectorKey },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("not_found");
		expect(lastRefreshBody).toEqual({});
	});
});

describe("managed connector — local resolver (env LOBU_CLOUD_PAT fallback)", () => {
	let savedConfigDir: string | undefined;

	beforeEach(async () => {
		await cleanupTestDatabase();
		lastRefreshBody = {};
		process.env.LOBU_CLOUD_URL = cloudBaseUrl;
		// Point the resolver's config dir at an EMPTY throwaway dir so it finds no
		// stored `lobu login` credential and falls back to LOBU_CLOUD_PAT /
		// LOBU_CLOUD_URL — the headless/CI path these tests exercise. Without this
		// the resolver would read the developer's real ~/.config/lobu login.
		savedConfigDir = process.env.LOBU_CONFIG_DIR;
		process.env.LOBU_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lobu-cred-test-"));
	});

	afterEach(() => {
		const dir = process.env.LOBU_CONFIG_DIR;
		if (dir?.includes("lobu-cred-test-")) {
			rmSync(dir, { recursive: true, force: true });
		}
		if (savedConfigDir === undefined) delete process.env.LOBU_CONFIG_DIR;
		else process.env.LOBU_CONFIG_DIR = savedConfigDir;
	});

	it("a `managedBy` connection resolves its access token via the cloud endpoint", async () => {
		// Cloud side: public org + managed app + grant + owner-owned connection +
		// the owner's PAT (the instance's cloud PAT in this single-user case).
		const cloud = await seedManagedConnection("Cloud Org");
		// The instance's cloud PAT is the user's OWN credential.
		process.env.LOBU_CLOUD_PAT = cloud.ownerPat;

		// Local side: a separate org with a local connection marked `managedBy`
		// (config.managedBy points at the cloud org). No local grant.
		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Local Org" });
		const localUser = await createTestUser({ name: "Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Local",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [
					{ type: "oauth", provider: "demo", requiredScopes: ["read"] },
				],
			},
			feeds_schema: { items: {} },
		});

		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-local', 'Local Demo', 'active',
        ${sql.json({ managedBy: { org: cloud.orgId, connectionSlug: cloud.connectionSlug } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		// The runtime token-resolution path: detects `managedBy`, fetches the
		// access token from the cloud, and returns it as the connection's creds.
		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
		// No local refresh token / secret ever materialized: execution credentials
		// carry the access token and its bookkeeping, nothing else.
		expect(Object.keys(resolved.credentials ?? {}).sort()).toEqual(["accessToken", "expiresAt", "provider", "scope"]);
		expect(resolved.connectionCredentials).toEqual({});

		// The MCP proxy must use the same execution-auth seam. A managedBy
		// connection deliberately has no local oauth_account profile, so the old
		// direct auth_profiles join returned null here.
		await expect(
			resolveCredentialsByConnectionId(Number(localConnRows[0].id), localOrg.id),
		).resolves.toEqual({
			accessToken: REFRESHED.access_token,
			tokenType: "Bearer",
		});
	});

	it("ignores a connection-supplied `managedBy.url` — the PAT always goes to LOBU_CLOUD_URL", async () => {
		// LOBU_CLOUD_URL is the real in-process cloud (set in beforeEach). The
		// connection config carries a bogus `url` (a stand-in for an attacker host
		// that would steal the PAT). If the resolver honored it, the fetch would
		// hit the bogus host and fail; instead it resolves a real token — proving
		// the PAT only ever targets the instance-configured cloud origin.
		const cloud = await seedManagedConnection("Cloud Org URL Ignored");
		process.env.LOBU_CLOUD_PAT = cloud.ownerPat;

		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Local Org URL" });
		const localUser = await createTestUser({ name: "Local URL User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Local URL",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [
					{ type: "oauth", provider: "demo", requiredScopes: ["read"] },
				],
			},
			feeds_schema: { items: {} },
		});

		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-local-url', 'Local Demo URL', 'active',
        ${sql.json({
					managedBy: { org: cloud.orgId, url: "http://attacker.invalid:1" },
				})}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		// Token resolved → the fetch hit LOBU_CLOUD_URL, NOT the bogus connection
		// URL (which would have failed and yielded null credentials).
		expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
	});

	it("a non-managed (local) connection ignores the cloud path entirely", async () => {
		// No managedBy on config → resolver must NOT call the cloud (no refresh).
		process.env.LOBU_CLOUD_PAT = "owl_pat_unused";
		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Plain Local Org" });
		const localUser = await createTestUser({ name: "Plain Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.plain",
			name: "Demo Plain",
			organization_id: localOrg.id,
			auth_schema: { methods: [{ type: "env_keys", keys: ["DEMO_API_KEY"] }] },
			feeds_schema: { items: {} },
		});
		const envProfile = await createAuthProfile({
			organizationId: localOrg.id,
			connectorKey: "demo.plain",
			displayName: "Demo Env",
			profileKind: "env",
			authData: { DEMO_API_KEY: "local-key-123" },
		});
		const connRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        auth_profile_id, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.plain', 'demo-plain', 'Plain Local', 'active',
        ${envProfile.id}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(connRows[0].id),
			authProfileId: envProfile.id,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		// Local env credentials resolve unchanged; the cloud was never contacted.
		expect(resolved.connectionCredentials.DEMO_API_KEY).toBe("local-key-123");
		expect(lastRefreshBody).toEqual({});
	});
});

describe("managed connector — local resolver (Stage 2: login credential)", () => {
	// Stage 2: the resolver sources its cloud credential from the stored
	// `lobu login` device credential (~/.config/lobu/credentials.json) instead of
	// LOBU_CLOUD_PAT. We point LOBU_CONFIG_DIR at a throwaway dir, write a
	// credentials.json holding the OWNER's real OAuth LOGIN access token (carrying
	// `connections:token`, granted at login by Stage 1), plus a config.json that
	// binds the default context to the in-process cloud origin. LOBU_CLOUD_PAT is
	// UNSET so the ONLY usable credential is the login token.
	let configDir = "";
	let savedConfigDir: string | undefined;

	beforeEach(async () => {
		await cleanupTestDatabase();
		lastRefreshBody = {};
		savedConfigDir = process.env.LOBU_CONFIG_DIR;
		configDir = mkdtempSync(join(tmpdir(), "lobu-login-test-"));
		process.env.LOBU_CONFIG_DIR = configDir;
		// No env PAT/URL — prove the resolver uses the LOGIN credential, not env.
		delete process.env.LOBU_CLOUD_PAT;
		delete process.env.LOBU_CLOUD_URL;
	});

	afterEach(() => {
		if (configDir.includes("lobu-login-test-")) {
			rmSync(configDir, { recursive: true, force: true });
		}
		if (savedConfigDir === undefined) delete process.env.LOBU_CONFIG_DIR;
		else process.env.LOBU_CONFIG_DIR = savedConfigDir;
	});

	it("resolves a managed connection using the stored `lobu login` token (no env PAT)", async () => {
		const cloud = await seedManagedConnection("Login Cloud Org");

		// Mint the OWNER's real OAuth login access token — the credential `lobu`
		// itself stores. It carries `connections:token` (Stage 1 grants it at
		// login), so it passes the connection-token endpoint's scope gate.
		const client = await createTestOAuthClient({ client_name: "Lobu CLI" });
		const login = await createTestAccessToken(cloud.ownerId, cloud.orgId, client.client_id, {
			scope: "mcp:read mcp:write connections:token",
		});

		// Write the CLI credential store + context config the resolver reads.
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				version: 2,
				contexts: { lobu: { accessToken: login.token } },
			}),
		);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				currentContext: "lobu",
				contexts: { lobu: { url: `${cloudBaseUrl}/api/v1` } },
			}),
		);

		// Local managed connection (no local grant).
		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Login Local Org" });
		const localUser = await createTestUser({ name: "Login Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Local Login",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [{ type: "oauth", provider: "demo", requiredScopes: ["read"] }],
			},
			feeds_schema: { items: {} },
		});
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-login', 'Login Demo', 'active',
        ${sql.json({ managedBy: { org: cloud.orgId } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		// The login token authenticated the cloud fetch → the refreshed token came
		// back, proving the resolver used the stored device-login credential (env
		// PAT is unset, so no other credential could have worked).
		expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
		expect(lastRefreshBody.client_secret).toBe(MANAGED_SECRET);
	});

	it("ignores the active LOCAL context and fetches from the cloud `lobu` context", async () => {
		// Under `lobu run` the active/current context is the local loopback
		// instance. The resolver must NOT use it (that would POST the local session
		// token to the local /oauth/connection-token) — it uses the explicit cloud
		// context. Here currentContext is `local`; the cloud login lives under
		// `lobu`. A naive resolver would pick `local` and fail.
		const cloud = await seedManagedConnection("Run Cloud Org");
		const client = await createTestOAuthClient({ client_name: "Lobu CLI" });
		const login = await createTestAccessToken(
			cloud.ownerId,
			cloud.orgId,
			client.client_id,
			{ scope: "mcp:read mcp:write connections:token" },
		);

		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				version: 2,
				contexts: {
					local: { accessToken: "local-session-token-must-not-be-used" },
					lobu: { accessToken: login.token },
				},
			}),
		);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				currentContext: "local",
				contexts: {
					local: { url: "http://localhost:9/api/v1" },
					lobu: { url: `${cloudBaseUrl}/api/v1` },
				},
			}),
		);

		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "Run Local Org" });
		const localUser = await createTestUser({ name: "Run Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Run",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [{ type: "oauth", provider: "demo", requiredScopes: ["read"] }],
			},
			feeds_schema: { items: {} },
		});
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-run', 'Run Demo', 'active',
        ${sql.json({ managedBy: { org: cloud.orgId } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		// The cloud (`lobu`) login token authenticated the fetch — not the local
		// context's token (which points at a dead local port).
		expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
		expect(lastRefreshBody.client_secret).toBe(MANAGED_SECRET);
	});

	it("returns no managed credentials when there is neither a login nor an env PAT", async () => {
		// Empty config dir (no credentials.json), no env PAT → resolver yields no
		// managed credentials (fail-soft) and never contacts the cloud.
		const cloud = await seedManagedConnection("No-Cred Cloud Org");
		const sql = getTestDb();
		const localOrg = await createTestOrganization({ name: "No-Cred Local Org" });
		const localUser = await createTestUser({ name: "No-Cred Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth No Cred",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [{ type: "oauth", provider: "demo", requiredScopes: ["read"] }],
			},
			feeds_schema: { items: {} },
		});
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-nocred', 'No Cred Demo', 'active',
        ${sql.json({ managedBy: { org: cloud.orgId } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		const resolved = await resolveExecutionAuth({
			organizationId: localOrg.id,
			connectionId: Number(localConnRows[0].id),
			authProfileId: null,
			appAuthProfileId: null,
			credentialDb: sql,
		});

		expect(resolved.credentials).toBeNull();
		expect(lastRefreshBody).toEqual({});
	});

	it("refreshes an EXPIRED login token, uses the rotated token, and writes it back to credentials.json", async () => {
		// T1 (the most important Stage-2 case): the stored login credential is
		// EXPIRED and refreshable (it carries oauth.tokenEndpoint + clientId +
		// refreshToken). resolveCloudCredential must (a) refresh the login token at
		// its issuer, (b) use the ROTATED login token to authenticate the cloud
		// connection-token fetch, and (c) PERSIST the rotated refresh token + new
		// expiry back to credentials.json (issuers revoke the old refresh token on
		// use; not writing back would strand the CLI).
		const cloud = await seedManagedConnection("Login Refresh Cloud Org");
		const client = await createTestOAuthClient({ client_name: "Lobu CLI" });

		// The ORIGINAL login token (what's stored, but expired) and the ROTATED one
		// the issuer hands back on refresh. Both are real, valid, connections:token
		// access tokens for the owner — only the rotated one is presented to the
		// cloud after refresh.
		const originalLogin = await createTestAccessToken(
			cloud.ownerId,
			cloud.orgId,
			client.client_id,
			{ scope: "mcp:read mcp:write connections:token" },
		);
		const rotatedLogin = await createTestAccessToken(
			cloud.ownerId,
			cloud.orgId,
			client.client_id,
			{ scope: "mcp:read mcp:write connections:token" },
		);

		// Fake LOGIN issuer token endpoint: a refresh_token grant returns the
		// rotated login access token + a rotated refresh token. Distinct from the
		// managed provider's /token endpoint (that one rotates the MANAGED grant).
		let loginRefreshBody: Record<string, string> = {};
		const ROTATED_REFRESH = "rotated-login-refresh-token-789";
		const loginIssuer = new Hono();
		loginIssuer.post("/token", async (c) => {
			loginRefreshBody = (await c.req.json().catch(() => ({}))) as Record<
				string,
				string
			>;
			return c.json({
				access_token: rotatedLogin.token,
				refresh_token: ROTATED_REFRESH,
				expires_in: 3600,
			});
		});
		let loginServerPort = 0;
		const loginServer = await new Promise<ReturnType<typeof serve>>(
			(resolve) => {
				const s = serve(
					{ fetch: loginIssuer.fetch, hostname: "127.0.0.1", port: 0 },
					(info) => {
						loginServerPort = info.port;
						resolve(s);
					},
				);
			},
		);
		const loginTokenEndpoint = `http://127.0.0.1:${loginServerPort}/token`;

		// credentials.json: an EXPIRED, refreshable login credential.
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				version: 2,
				contexts: {
					lobu: {
						accessToken: originalLogin.token,
						refreshToken: "original-login-refresh-token",
						expiresAt: Date.now() - 60_000, // expired a minute ago
						oauth: {
							clientId: client.client_id,
							tokenEndpoint: loginTokenEndpoint,
						},
					},
				},
			}),
		);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				currentContext: "lobu",
				contexts: { lobu: { url: `${cloudBaseUrl}/api/v1` } },
			}),
		);

		// Local managed connection (no local grant).
		const sql = getTestDb();
		const localOrg = await createTestOrganization({
			name: "Login Refresh Local",
		});
		const localUser = await createTestUser({ name: "Login Refresh User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Login Refresh",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [
					{ type: "oauth", provider: "demo", requiredScopes: ["read"] },
				],
			},
			feeds_schema: { items: {} },
		});
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-login-refresh', 'Login Refresh Demo', 'active',
        ${sql.json({ managedBy: { org: cloud.orgId } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		try {
			const resolved = await resolveExecutionAuth({
				organizationId: localOrg.id,
				connectionId: Number(localConnRows[0].id),
				authProfileId: null,
				appAuthProfileId: null,
				credentialDb: sql,
			});

			// (a) The cloud fetch succeeded — proving the ROTATED login token (not the
			// expired original) authenticated it: the managed refresh ran and returned
			// the managed access token.
			expect(resolved.credentials?.accessToken).toBe(REFRESHED.access_token);
			expect(lastRefreshBody.client_secret).toBe(MANAGED_SECRET);
			// The login issuer saw a refresh_token grant with the ORIGINAL refresh token.
			expect(loginRefreshBody.grant_type).toBe("refresh_token");
			expect(loginRefreshBody.refresh_token).toBe(
				"original-login-refresh-token",
			);

			// (b) credentials.json on disk now holds the ROTATED refresh token + a
			// fresh (future) expiry — the write-back happened.
			const onDisk = JSON.parse(
				readFileSync(join(configDir, "credentials.json"), "utf-8"),
			) as {
				contexts: {
					lobu: {
						accessToken: string;
						refreshToken: string;
						expiresAt: number;
					};
				};
			};
			expect(onDisk.contexts.lobu.refreshToken).toBe(ROTATED_REFRESH);
			expect(onDisk.contexts.lobu.accessToken).toBe(rotatedLogin.token);
			expect(onDisk.contexts.lobu.expiresAt).toBeGreaterThan(Date.now());
		} finally {
			await new Promise<void>((done) => loginServer.close(() => done()));
		}
	});

	it("fails soft (null credentials) when the cloud connection-token endpoint errors", async () => {
		// T4: the cloud returns 5xx for the token fetch. The resolver must NOT throw
		// — a managed connection whose cloud fetch fails resolves to null
		// credentials (the run fails loudly downstream, but resolution itself is
		// fail-soft and never crashes the worker).
		const sql = getTestDb();

		// Point the resolver at a cloud origin that always 500s.
		let errorServerPort = 0;
		const errorCloud = new Hono();
		errorCloud.post("/oauth/connection-token", (c) =>
			c.json({ error: "server_error" }, 500),
		);
		const errorServer = await new Promise<ReturnType<typeof serve>>(
			(resolve) => {
				const s = serve(
					{ fetch: errorCloud.fetch, hostname: "127.0.0.1", port: 0 },
					(info) => {
						errorServerPort = info.port;
						resolve(s);
					},
				);
			},
		);
		const errorCloudUrl = `http://127.0.0.1:${errorServerPort}`;

		// A login credential pointing at the erroring cloud. Reuse a real
		// owner/org just to mint a structurally valid login token; the cloud 500s
		// before any DB lookup matters.
		const client = await createTestOAuthClient({ client_name: "Lobu CLI" });
		const failOrg = await createTestOrganization({ name: "Fail Cloud Org" });
		const failOwner = await createTestUser({ name: "Fail Owner" });
		await addUserToOrganization(failOwner.id, failOrg.id, "member");
		const login = await createTestAccessToken(
			failOwner.id,
			failOrg.id,
			client.client_id,
			{ scope: "mcp:read mcp:write connections:token" },
		);
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				version: 2,
				contexts: { lobu: { accessToken: login.token } },
			}),
		);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				currentContext: "lobu",
				contexts: { lobu: { url: `${errorCloudUrl}/api/v1` } },
			}),
		);

		const localOrg = await createTestOrganization({ name: "Fail Local Org" });
		const localUser = await createTestUser({ name: "Fail Local User" });
		await addUserToOrganization(localUser.id, localOrg.id, "owner");
		await createTestConnectorDefinition({
			key: "demo.oauth",
			name: "Demo OAuth Fail",
			organization_id: localOrg.id,
			auth_schema: {
				methods: [
					{ type: "oauth", provider: "demo", requiredScopes: ["read"] },
				],
			},
			feeds_schema: { items: {} },
		});
		const localConnRows = (await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        config, created_at, updated_at
      ) VALUES (
        ${localOrg.id}, 'demo.oauth', 'demo-fail', 'Fail Demo', 'active',
        ${sql.json({ managedBy: { org: failOrg.id } })}, NOW(), NOW()
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

		try {
			const resolved = await resolveExecutionAuth({
				organizationId: localOrg.id,
				connectionId: Number(localConnRows[0].id),
				authProfileId: null,
				appAuthProfileId: null,
				credentialDb: sql,
			});
			// Fail-soft: no managed credentials, no throw.
			expect(resolved.credentials).toBeNull();
		} finally {
			await new Promise<void>((done) => errorServer.close(() => done()));
		}
	});
});
