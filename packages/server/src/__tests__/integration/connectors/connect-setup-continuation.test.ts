/**
 * `connections.connect` setup-required continuation contract.
 *
 * Setup-required outcomes (GitHub app install, missing OAuth app config,
 * interactive pairing, env/browser auth selection, ...) are NON-TERMINAL,
 * actionable continuations — NOT prose-only business errors. They MUST:
 *
 *   1. return as a structured `{ action: 'connect', status: 'setup_required' }`
 *      result (no `error` field), so the action-call boundary does NOT throw and
 *      the value SURVIVES `run_sdk` as a return_value (red→green proof below);
 *   2. carry absolute URL(s) + a machine-readable `next_action` +
 *      `completion_check`;
 *   3. omit `resume_call` when setup itself creates the active connection
 *      (GitHub App install / interactive auth), and expose only an immediately
 *      callable completion poll.
 *
 * Covers the setup families: oauth, app_installation, env_keys, browser,
 * interactive, none (active), and device-bound (see the e2e matrix file).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pgTextArray } from "../../../db/client";
import type { Env } from "../../../index";
import { manageConnections } from "../../../tools/admin/manage_connections";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestConnectorDefinition,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
	seedOwnerContext,
} from "../../setup/test-fixtures";
import { TestMcpClient } from "../../setup/test-mcp-client";

const TEST_ENV = {} as Env;

const CONNECTORS = {
	appInstall: "demo.cont.appinstall.cont",
	oauth: "demo.cont.oauth.cont",
	env: "demo.cont.env.cont",
	browser: "demo.cont.browser.cont",
	interactive: "demo.cont.interactive.cont",
	none: "demo.cont.none.cont",
} as const;

async function seedConnectors(organizationId: string): Promise<void> {
	await createTestConnectorDefinition({
		key: CONNECTORS.appInstall,
		name: "App Install Continuation",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "app_installation",
					provider: "github",
					providerInstance: "cloud",
					installShape: "github-app",
					appIdKey: "DEMO_APP_ID",
					appSlugKey: "DEMO_APP_SLUG",
					privateKeyKey: "DEMO_APP_PRIVATE_KEY",
				},
				{ type: "env_keys", fields: [{ key: "DEMO_TOKEN" }] },
			],
		},
	});
	await createTestConnectorDefinition({
		key: CONNECTORS.oauth,
		name: "OAuth Continuation",
		organization_id: organizationId,
		auth_schema: {
			methods: [
				{
					type: "oauth",
					provider: "google",
					requiredScopes: ["read"],
					clientIdKey: "CLIENT_ID",
					clientSecretKey: "CLIENT_SECRET",
					tokenUrl: "https://example.test/token",
				},
			],
		},
	});
	await createTestConnectorDefinition({
		key: CONNECTORS.env,
		name: "Env Continuation",
		organization_id: organizationId,
		auth_schema: {
			methods: [{ type: "env_keys", fields: [{ key: "API_KEY" }] }],
		},
	});
	await createTestConnectorDefinition({
		key: CONNECTORS.browser,
		name: "Browser Continuation",
		organization_id: organizationId,
		auth_schema: {
			methods: [{ type: "browser", cookieDomain: "example.test" }],
		},
	});
	await createTestConnectorDefinition({
		key: CONNECTORS.interactive,
		name: "Interactive Continuation",
		organization_id: organizationId,
		auth_schema: { methods: [{ type: "interactive" }] },
	});
	await createTestConnectorDefinition({
		key: CONNECTORS.none,
		name: "No Auth Continuation",
		organization_id: organizationId,
		auth_schema: { methods: [{ type: "none" }] },
	});
}

async function setupConnectorCase(orgName: string) {
	const seeded = await seedOwnerContext({ orgName });
	seeded.ctx.baseUrl = "https://gateway.test/lobu";
	await seedConnectors(seeded.org.id);
	return seeded;
}

function isAbsoluteUrl(value: unknown): boolean {
	return typeof value === "string" && /^https?:\/\//i.test(value);
}

async function purge(organizationId: string): Promise<void> {
	const sql = getTestDb();
	const keys = Object.values(CONNECTORS);
	// Order matters: connections reference auth_profiles via a composite FK with
	// ON DELETE SET NULL, so connections must go before auth_profiles (deleting
	// the profile first tries to NULL the connection's organization_id, which is
	// NOT NULL).
	await sql`DELETE FROM runs WHERE organization_id = ${organizationId} AND connector_key = ANY(${pgTextArray(keys)}::text[])`;
	await sql`DELETE FROM feeds WHERE connection_id IN (SELECT id FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId})`;
	await sql`DELETE FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
	await sql`DELETE FROM auth_profiles WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
	await sql`DELETE FROM connector_definitions WHERE key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
}

describe("connections.connect — setup_required continuation", () => {
	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	afterEach(async () => {
		const sql = getTestDb();
		const orgs = await sql`SELECT id FROM "organization"`;
		for (const org of orgs) await purge(org.id as string);
	});

	it("app_installation: returns an immediately callable completion poll and no connect retry", async () => {
		const { org, user, ctx } = await setupConnectorCase("App Install Cont Org");
		const sql = getTestDb();
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, created_by
			) VALUES (
				${org.id}, ${CONNECTORS.appInstall}, 'older-install', 'Older install',
				'active', ${sql.json({ installation_ref: 1 })}, ${user.id}
			)
		`;
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config,
				created_by, created_at
			)
			SELECT
				${org.id}, ${CONNECTORS.appInstall}, 'newer-install-' || n,
				'Newer install ' || n, 'active', ${sql.json({ installation_ref: 2 })},
				${user.id}, NOW() + n * interval '1 second'
			FROM generate_series(1, 55) AS n
		`;

		const res = (await manageConnections(
			{ action: "connect", connector_key: CONNECTORS.appInstall },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		// MUST be a continuation, not an error.
		expect(res.action).toBe("connect");
		expect(res.status).toBe("setup_required");
		expect(res).not.toHaveProperty("error");
		expect(res.setup_family).toBe("app_installation");
		expect(res.next_action).toBe("install_app");
		// Absolute install + setup URLs.
		expect(isAbsoluteUrl(res.install_url)).toBe(true);
		expect(isAbsoluteUrl(res.setup_url)).toBe(true);
		const setupAttemptId = String(res.setup_attempt_id);
		expect(setupAttemptId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(
			new URL(String(res.install_url)).searchParams.get("setup_attempt_id"),
		).toBe(setupAttemptId);
		// The callback creates the connection, so there is no resume/retry call.
		expect(res.resume_call).toBeUndefined();
		const check = res.completion_check as Record<string, unknown>;
		expect(check).toMatchObject({
			call: {
				sdk_method: "connections.list",
				arguments: [
					{
						connector_key: CONNECTORS.appInstall,
						status: "active",
						setup_attempt_id: setupAttemptId,
					},
				],
			},
			success_when: {
				path: "connections[].config.setup_attempt_ids",
				includes: setupAttemptId,
			},
		});
		// The older active connection must NOT satisfy this attempt's condition.
		const [completionArgs] = (
			check.call as { arguments: Array<Record<string, unknown>> }
		).arguments;
		const before = (await manageConnections(
			{ action: "list", ...completionArgs },
			TEST_ENV,
			ctx,
		)) as { connections: Array<Record<string, unknown>> };
		expect(
			before.connections.some((connection) => {
				const ids = (connection.config as Record<string, unknown> | undefined)
					?.setup_attempt_ids;
				return Array.isArray(ids) && ids.includes(setupAttemptId);
			}),
		).toBe(false);

		// Simulate the callback's correlation stamp: now the same completion check
		// becomes true, including for a re-install that reuses an existing row.
		await sql`
			UPDATE connections
			SET config = config || ${sql.json({ setup_attempt_ids: [setupAttemptId] })}::jsonb
			WHERE organization_id = ${org.id}
				AND connector_key = ${CONNECTORS.appInstall}
				AND slug = 'older-install'
		`;
		const after = (await manageConnections(
			{ action: "list", ...completionArgs },
			TEST_ENV,
			ctx,
		)) as { connections: Array<Record<string, unknown>> };
		expect(after.connections).toHaveLength(1);
		expect(after.connections[0]?.slug).toBe("older-install");
		expect(
			after.connections.some((connection) => {
				const ids = (connection.config as Record<string, unknown> | undefined)
					?.setup_attempt_ids;
				return Array.isArray(ids) && ids.includes(setupAttemptId);
			}),
		).toBe(true);
	});

	it("oauth (missing app profile): returns setup_required with configure_oauth_app", async () => {
		const { ctx } = await setupConnectorCase("OAuth Cont Org");

		const res = (await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTORS.oauth,
				display_name: "Preserved OAuth setup",
				slug: "preserved-oauth-setup",
				config: { repository: "acme/widget" },
			},
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.action).toBe("connect");
		expect(res.status).toBe("setup_required");
		expect(res).not.toHaveProperty("error");
		expect(res.setup_family).toBe("oauth");
		expect(res.next_action).toBe("configure_oauth_app");
		expect(new URL(String(res.setup_url)).searchParams.get("setup")).toBe("oauth_app");
		expect(new URL(String(res.setup_url)).hash).toBe("#connector-oauth-apps");
		expect(res.instructions).toContain("Keep secrets in that browser form");
		expect(isAbsoluteUrl(res.setup_url)).toBe(true);
		expect(res.resume_call).toMatchObject({
			sdk_method: "connections.connect",
			arguments: [
				{
					connector_key: CONNECTORS.oauth,
					display_name: "Preserved OAuth setup",
					slug: "preserved-oauth-setup",
					config: { repository: "acme/widget" },
				},
			],
		});
		// No connection exists yet, so no completion poll could be called now.
		expect(res.completion_check).toBeUndefined();
	});

	it("connect resume_call omits secret config values without executable placeholders", async () => {
		const { ctx } = await setupConnectorCase("Secret Connect Cont Org");

		const res = (await manageConnections(
			{
				action: "connect",
				connector_key: CONNECTORS.oauth,
				display_name: "Safe resumable connect",
				config: {
					repository: "acme/widget",
					token: "top-level-connect-secret",
					nested: {
						region: "eu-west-1",
						apiKey: "nested-connect-secret",
					},
					accounts: [
						{ label: "primary", access_token: "array-connect-secret" },
					],
				},
			},
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.resume_call).toEqual({
			sdk_method: "connections.connect",
			arguments: [
				{
					connector_key: CONNECTORS.oauth,
					display_name: "Safe resumable connect",
					config: {
						repository: "acme/widget",
						nested: { region: "eu-west-1" },
						accounts: [{ label: "primary" }],
					},
				},
			],
		});
		const serialized = JSON.stringify(res.resume_call);
		expect(serialized).not.toContain("connect-secret");
		expect(serialized).not.toContain("redacted");
		expect(serialized).not.toContain("LOBU_REDACTED");
	});

	it("env_keys (no auth profile): returns setup_required with select_auth_profile", async () => {
		const { ctx } = await setupConnectorCase("Env Cont Org");

		const res = (await manageConnections(
			{ action: "connect", connector_key: CONNECTORS.env },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("setup_required");
		expect(res).not.toHaveProperty("error");
		expect(res.setup_family).toBe("env_keys");
		expect(res.next_action).toBe("select_auth_profile");
		expect(res.resume_call).toMatchObject({
			sdk_method: "connections.connect",
			arguments: [{ connector_key: CONNECTORS.env }],
		});
		expect(res.completion_check).toBeUndefined();
	});

	it("browser (no profile): returns setup_required pointing at browser pairing", async () => {
		const { ctx } = await setupConnectorCase("Browser Cont Org");

		const res = (await manageConnections(
			{ action: "connect", connector_key: CONNECTORS.browser },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("setup_required");
		expect(res).not.toHaveProperty("error");
		expect(res.setup_family).toBe("browser");
		expect(["pair_browser", "select_auth_profile"]).toContain(res.next_action);
		expect(res.resume_call).toMatchObject({
			sdk_method: "connections.connect",
		});
		expect(res.completion_check).toBeUndefined();
	});

	it("interactive: creates a pending connection + auth run and returns pair_interactive continuation", async () => {
		const { ctx } = await setupConnectorCase("Interactive Cont Org");

		const res = (await manageConnections(
			{ action: "connect", connector_key: CONNECTORS.interactive },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.status).toBe("setup_required");
		expect(res).not.toHaveProperty("error");
		expect(res.setup_family).toBe("interactive");
		expect(res.next_action).toBe("pair_interactive");
		// Interactive path MUST create the connection + kick off an auth run.
		expect(typeof res.connection_id).toBe("number");
		expect(typeof res.auth_run_id).toBe("number");
		expect(res.resume_call).toBeUndefined();
		expect(res.completion_check).toMatchObject({
			call: {
				sdk_method: "connections.get",
				arguments: [res.connection_id],
			},
			success_when: { path: "connection.status", equals: "active" },
		});

		const sql = getTestDb();
		const conn =
			(await sql`SELECT status FROM connections WHERE id = ${res.connection_id}`) as Array<{
				status: string;
			}>;
		expect(conn[0].status).toBe("pending_auth");
		const run =
			(await sql`SELECT run_type, status FROM runs WHERE id = ${res.auth_run_id}`) as Array<{
				run_type: string;
				status: string;
			}>;
		expect(run[0].run_type).toBe("auth");
	});

	it("create uses the same structured env setup continuation", async () => {
		const { ctx } = await setupConnectorCase("Create Env Cont Org");

		const res = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTORS.env,
				display_name: "Env pending setup",
			},
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res).toMatchObject({
			action: "create",
			status: "setup_required",
			setup_family: "env_keys",
			next_action: "select_auth_profile",
			resume_call: {
				sdk_method: "connections.create",
				arguments: [
					{
						connector_key: CONNECTORS.env,
						display_name: "Env pending setup",
					},
				],
			},
		});
		expect(res).not.toHaveProperty("error");
		expect(res.completion_check).toBeUndefined();
	});

	it("create resume_call omits secret config values without executable placeholders", async () => {
		const { ctx } = await setupConnectorCase("Secret Create Cont Org");

		const res = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTORS.env,
				display_name: "Safe resumable create",
				config: {
					workspace: "engineering",
					secret: "top-level-create-secret",
					nested: {
						enabled: true,
						privateKey: "nested-create-secret",
					},
					accounts: [
						{ label: "primary", refreshTokens: ["array-create-secret"] },
					],
				},
			},
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.resume_call).toEqual({
			sdk_method: "connections.create",
			arguments: [
				{
					connector_key: CONNECTORS.env,
					display_name: "Safe resumable create",
					config: {
						workspace: "engineering",
						nested: { enabled: true },
						accounts: [{ label: "primary" }],
					},
				},
			],
		});
		const serialized = JSON.stringify(res.resume_call);
		expect(serialized).not.toContain("create-secret");
		expect(serialized).not.toContain("redacted");
		expect(serialized).not.toContain("LOBU_REDACTED");
	});

	it("create interactive atomically creates the profile, connection, and auth run", async () => {
		const { ctx } = await setupConnectorCase("Create Interactive Cont Org");

		const res = (await manageConnections(
			{ action: "create", connector_key: CONNECTORS.interactive },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res).toMatchObject({
			action: "create",
			status: "setup_required",
			setup_family: "interactive",
			next_action: "pair_interactive",
		});
		expect(typeof res.connection_id).toBe("number");
		expect(typeof res.auth_run_id).toBe("number");
		expect(res.resume_call).toBeUndefined();
		const [row] = await getTestDb()`
			SELECT c.status, ap.profile_kind, r.run_type
			FROM connections c
			JOIN auth_profiles ap ON ap.id = c.auth_profile_id
			JOIN runs r ON r.auth_profile_id = ap.id
			WHERE c.id = ${res.connection_id} AND r.id = ${res.auth_run_id}
		`;
		expect(row).toMatchObject({
			status: "pending_auth",
			profile_kind: "interactive",
			run_type: "auth",
		});
	});

	it("assigns an admin-created interactive auth run to the target connection owner", async () => {
		const { org, ctx } = await setupConnectorCase(
			"Delegated Interactive Cont Org",
		);
		const targetOwner = await createTestUser();
		await addUserToOrganization(targetOwner.id, org.id, "member");

		const res = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTORS.interactive,
				created_by: targetOwner.id,
			},
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		const [row] = await getTestDb()`
			SELECT c.created_by, r.created_by_user_id
			FROM connections c
			JOIN runs r ON r.auth_profile_id = c.auth_profile_id
			WHERE c.id = ${res.connection_id} AND r.id = ${res.auth_run_id}
		`;
		expect(row).toEqual({
			created_by: targetOwner.id,
			created_by_user_id: targetOwner.id,
		});
	});

	it("interactive setup rolls back profile and connection if the auth run cannot be created", async () => {
		const { org, ctx } = await setupConnectorCase("Interactive Rollback Org");
		await getTestDb()`DELETE FROM connector_versions WHERE connector_key = ${CONNECTORS.interactive}`;

		for (const action of ["connect", "create"] as const) {
			await expect(
				manageConnections(
					{ action, connector_key: CONNECTORS.interactive },
					TEST_ENV,
					ctx,
				),
			).rejects.toThrow(
				/connector version|active connector definition|compiled code/i,
			);
			const [counts] = await getTestDb()`
				SELECT
				  (SELECT count(*)::int FROM connections WHERE organization_id = ${org.id} AND connector_key = ${CONNECTORS.interactive}) AS connections,
				  (SELECT count(*)::int FROM auth_profiles WHERE organization_id = ${org.id} AND connector_key = ${CONNECTORS.interactive}) AS profiles
			`;
			expect(counts).toMatchObject({ connections: 0, profiles: 0 });
		}
	});

	it("device-bound connectors return a setup continuation instead of prose-only failure", async () => {
		const { org, ctx } = await setupConnectorCase("Device Bound Cont Org");
		await getTestDb()`
			UPDATE connector_definitions
			SET required_capability = 'computer_use'
			WHERE organization_id = ${org.id} AND key = ${CONNECTORS.none}
		`;

		for (const action of ["connect", "create"] as const) {
			const res = (await manageConnections(
				{ action, connector_key: CONNECTORS.none },
				TEST_ENV,
				ctx,
			)) as Record<string, unknown>;
			expect(res).toMatchObject({
				action,
				status: "setup_required",
				setup_family: "device_bound",
				next_action: "connect_device",
			});
			expect(res).not.toHaveProperty("error");
			expect(res.resume_call).toBeUndefined();
			expect(res.completion_check).toBeUndefined();
		}
	});

	it("none (no-auth): connects active immediately, not a setup_required", async () => {
		const { ctx } = await setupConnectorCase("None Cont Org");

		const res = (await manageConnections(
			{ action: "connect", connector_key: CONNECTORS.none },
			TEST_ENV,
			ctx,
		)) as Record<string, unknown>;

		expect(res.action).toBe("connect");
		expect(res.status).toBe("active");
		expect(res).not.toHaveProperty("error");
	});

	it("SURVIVES run_sdk: an app_installation connect returns the continuation as return_value, not a ScriptError", async () => {
		const org = await createTestOrganization({ name: "Connect RunSdk Org" });
		const user = await createTestUser({ email: "connect-rsdk@test.com" });
		await addUserToOrganization(user.id, org.id, "owner");
		await seedConnectors(org.id);
		const oauthClient = await createTestOAuthClient();
		const oauthResult = await createTestAccessToken(
			user.id,
			org.id,
			oauthClient.client_id,
			{
				scope: "mcp:read mcp:write mcp:admin",
			},
		);

		const client = new TestMcpClient({
			token: oauthResult.token,
			orgSlug: org.slug,
		});
		const result = await client.runSdk<{
			success: boolean;
			return_value?: unknown;
			error?: { name: string; message: string };
		}>(
			'export default async (_ctx, client) => { return await client.connections.connect({ connector_key: "demo.cont.appinstall.cont" }); }',
		);

		// The continuation must survive as a return value — NOT a thrown ScriptError.
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		const rv = result.return_value as Record<string, unknown>;
		expect(rv.status).toBe("setup_required");
		expect(rv).not.toHaveProperty("error");
		expect(rv.setup_family).toBe("app_installation");
		expect(["install_app", "open_setup"]).toContain(rv.next_action);

		const failed = await client.runSdk<{
			success: boolean;
			error?: {
				name: string;
				message: string;
				code?: string;
				retryable?: boolean;
			};
		}>(
			`export default async (_ctx, client) => client.connections.connect({ connector_key: "missing-continuation-connector" });`,
		);
		expect(failed.success).toBe(false);
		expect(failed.error).toMatchObject({
			name: "ClientSdkActionError",
			message: expect.stringMatching(/connector.*not found/i),
		});
		expect(failed.error).not.toHaveProperty("details");
		expect(failed.error).not.toHaveProperty("stack");
		expect(failed.error?.message).not.toContain('{"');
	});
});
