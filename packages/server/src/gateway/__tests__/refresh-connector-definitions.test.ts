/**
 * Connector-definition refresh (#14). Drives refreshConnectorDefinitions()
 * against real Postgres + the real bundled github connector source.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { refreshConnectorDefinitions } from "../../scheduled/refresh-connector-definitions.js";
import {
	getAppInstallationAuthMethods,
	normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG = "org-refresh";
const OTHER_ORG = "org-refresh-other";
const GITHUB_KEY = "github";

/** The pre-PR5 github auth_schema: oauth + env_keys only, no app_installation. */
const STALE_GITHUB_AUTH_SCHEMA = {
	methods: [
		{ type: "oauth", provider: "github", clientIdKey: "GITHUB_CLIENT_ID" },
		{ type: "env_keys", fields: [{ key: "GITHUB_TOKEN" }] },
	],
};

/** Insert an active, deliberately-stale github definition for an org. */
async function seedStaleGithubDef(
	orgId: string,
	opts: { loginEnabled?: boolean } = {},
): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version,
      auth_schema, status, login_enabled
    ) VALUES (
      ${orgId}, ${GITHUB_KEY}, 'GitHub', '0.0.1',
      ${sql.json(STALE_GITHUB_AUTH_SCHEMA)}, 'active', ${opts.loginEnabled ?? false}
    )
  `;
}

async function loadGithubDef(orgId: string): Promise<{
	auth_schema: unknown;
	version: string;
	login_enabled: boolean;
} | undefined> {
	const sql = getDb();
	const rows = (await sql`
    SELECT auth_schema, version, login_enabled
    FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${GITHUB_KEY} AND status = 'active'
    LIMIT 1
  `) as unknown as Array<{
		auth_schema: unknown;
		version: string;
		login_enabled: boolean;
	}>;
	return rows[0];
}

async function seedStaleAtlassianMcpDef(orgId: string): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, mcp_config, feeds_schema
    ) VALUES (
      ${orgId}, 'mcp.mcp-atlassian-com', 'Atlassian', '1.0.0', 'active',
      ${sql.json({
			upstream_url: "https://mcp.atlassian.com/v1/mcp",
			tool_prefix: "mcp_atlassian_com",
		})},
      NULL
    )
  `;
}

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
}, 30_000);

describe("refreshConnectorDefinitions", () => {
	test("a stale github def gains the app_installation method after refresh", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleGithubDef(ORG, { loginEnabled: true });

		// Precondition: the seeded def has NO app_installation method.
		const before = await loadGithubDef(ORG);
		expect(before).toBeDefined();
		expect(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(before?.auth_schema),
			).length,
		).toBe(0);

		const result = await refreshConnectorDefinitions();
		expect(result.errored).toBe(0);
		expect(result.refreshed).toBeGreaterThanOrEqual(1);

		const after = await loadGithubDef(ORG);
		expect(after).toBeDefined();
		// The code-defined github schema carries an app_installation method now,
		// so the install callback's hasAppInstallMethod check passes.
		const appMethods = getAppInstallationAuthMethods(
			normalizeConnectorAuthSchema(after?.auth_schema),
		);
		expect(appMethods.length).toBeGreaterThanOrEqual(1);
		expect(appMethods[0].provider).toBe("github");
		// Version was bumped from the stale 0.0.1 to whatever the code declares.
		expect(after?.version).not.toBe("0.0.1");
		// Org-specific config (login_enabled) is preserved across the refresh.
		expect(after?.login_enabled).toBe(true);
	});

	test("refresh is idempotent — a second run changes nothing observable", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleGithubDef(ORG);

		expect((await refreshConnectorDefinitions()).errored).toBe(0);
		const first = await loadGithubDef(ORG);

		expect((await refreshConnectorDefinitions()).errored).toBe(0);
		const second = await loadGithubDef(ORG);

		expect(second?.version).toBe(first?.version);
		expect(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(second?.auth_schema),
			).length,
		).toBe(
			getAppInstallationAuthMethods(
				normalizeConnectorAuthSchema(first?.auth_schema),
			).length,
		);
	});

	test("a second refresh rewrites no definition or version row", async () => {
		// The job runs hourly over every bundled definition; rewriting unchanged
		// rows left a dead copy of each large schema per run. A changed xmin
		// identifies a rewrite.
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleGithubDef(ORG);
		expect((await refreshConnectorDefinitions()).errored).toBe(0);

		const sql = getDb();
		const readXmins = async () => {
			const [definition] = await sql`
        SELECT xmin::text AS xmin, version FROM connector_definitions
        WHERE organization_id = ${ORG} AND key = ${GITHUB_KEY} AND status = 'active'
      `;
			const [shared] = await sql`
        SELECT xmin::text AS xmin FROM connector_versions
        WHERE connector_key = ${GITHUB_KEY} AND version = ${definition.version}
          AND organization_id IS NULL
      `;
			return { definition: definition.xmin, version: shared?.xmin };
		};
		const first = await readXmins();
		expect(first.version).toBeDefined();

		expect((await refreshConnectorDefinitions()).errored).toBe(0);
		expect(await readXmins()).toEqual(first);
	});

	test("does not install a connector into an org that didn't have it", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedAgentRow("agent-other", { organizationId: OTHER_ORG });
		// Only ORG has github; OTHER_ORG has none.
		await seedStaleGithubDef(ORG);

		expect((await refreshConnectorDefinitions()).errored).toBe(0);

		const other = await loadGithubDef(OTHER_ORG);
		expect(other).toBeUndefined();
	});

	test("backfills the Jira feed onto an existing Atlassian MCP definition", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleAtlassianMcpDef(ORG);

		const [before] = await getDb()`
      SELECT feeds_schema FROM connector_definitions
      WHERE organization_id = ${ORG} AND key = 'mcp.mcp-atlassian-com'
    `;
		expect(before?.feeds_schema).toBeNull();

		const result = await refreshConnectorDefinitions();
		expect(result.errored).toBe(0);
		expect(result.refreshed).toBeGreaterThanOrEqual(1);

		const [after] = await getDb()`
      SELECT feeds_schema FROM connector_definitions
      WHERE organization_id = ${ORG} AND key = 'mcp.mcp-atlassian-com'
    `;
		expect(after?.feeds_schema?.issues).toMatchObject({
			key: "issues",
			operations: ["read"],
		});
	});

	test("a second refresh leaves a backfilled Atlassian MCP definition unwritten", async () => {
		await seedAgentRow("agent-refresh", { organizationId: ORG });
		await seedStaleAtlassianMcpDef(ORG);
		expect((await refreshConnectorDefinitions()).errored).toBe(0);

		const xmin = async () =>
			(
				await getDb()`
          SELECT xmin::text AS xmin FROM connector_definitions
          WHERE organization_id = ${ORG} AND key = 'mcp.mcp-atlassian-com'
        `
			)[0].xmin;
		const first = await xmin();

		expect((await refreshConnectorDefinitions()).errored).toBe(0);
		expect(await xmin()).toBe(first);
	});
});
