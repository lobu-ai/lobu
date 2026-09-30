import { MCP_PROTOCOL_VERSION } from "@lobu/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app, type Env } from "../../index";
import { listOrgInstalled } from "../../catalog/installed";
import { getOperationsSummary, listOperations } from "../../operations/connector-operations";
import { manageOperations } from "../../tools/admin/manage_operations";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestAgent,
	createTestConnectorDefinition,
	createTestSession,
	createTestUser,
	seedOwnerContext,
} from "../setup/test-fixtures";

const KEY = "demo.mcp.catalog";
const URL = "https://catalog.example.test/mcp";
const originalFetch = globalThis.fetch;
type Tool = { name: string; inputSchema: Record<string, unknown> };
const tool = (name: string, property = "value"): Tool => ({
	name,
	inputSchema: { type: "object", properties: { [property]: { type: "string" } } },
});

describe("connection-scoped MCP catalog", () => {
	let owner: Awaited<ReturnType<typeof seedOwnerContext>>;
	let catalogs: Map<string, Tool[] | null>;
	let requests: string[];
	let anonymousTools: Tool[] | undefined;

	beforeAll(async () => { await initWorkspaceProvider(); });
	beforeEach(async () => {
		await cleanupTestDatabase();
		owner = await seedOwnerContext({ orgName: "MCP Catalog Workspace" });
		owner.ctx.baseUrl = "https://gateway.test/lobu";
		await createTestConnectorDefinition({ organization_id: owner.org.id, key: KEY, name: "MCP Catalog" });
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions SET
			  actions_schema = NULL,
			  mcp_config = ${sql.json({ upstream_url: URL, tool_prefix: "catalog" })},
			  auth_schema = ${sql.json({ methods: [{ type: "oauth", provider: "test", required: true }] })}
			WHERE organization_id = ${owner.org.id} AND key = ${KEY}
		`;
		catalogs = new Map();
		requests = [];
		anonymousTools = undefined;
		globalThis.fetch = vi.fn(async (url: string | globalThis.URL | Request, init?: RequestInit) => {
			if (String(url) !== URL) throw new Error(`Unexpected upstream: ${String(url)}`);
			const authorization = new Headers(init?.headers).get("authorization") ?? "anonymous";
			requests.push(authorization);
			const tools = authorization === "anonymous" ? anonymousTools : catalogs.get(authorization);
			if (tools === undefined) return new Response("unauthorized", { status: 401 });
			if (tools === null) return new Response("unavailable", { status: 503 });
			const body = JSON.parse(String(init?.body));
			const result = body.method === "initialize"
				? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } }
				: body.method === "tools/list" ? { tools } : {};
			return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result });
		}) as typeof fetch;
	});
	afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

	async function account(tools: Tool[] | null, userId = owner.user.id, status = "active") {
		const connection = await createTestConnection({
			organization_id: owner.org.id, connector_key: KEY, created_by: userId,
			visibility: "private", status, createDefaultFeed: false,
		});
		const accountId = `catalog-account-${connection.id}`;
		const token = `catalog-token-${connection.id}`;
		const sql = getTestDb();
		await sql`
			INSERT INTO "account" (id, "accountId", "providerId", "userId", "accessToken", "accessTokenExpiresAt", "createdAt", "updatedAt")
			VALUES (${accountId}, ${accountId}, 'test', ${userId}, ${token}, NOW() + INTERVAL '1 hour', NOW(), NOW())
		`;
		const profile = await createAuthProfile({
			organizationId: owner.org.id, connectorKey: KEY, displayName: accountId,
			profileKind: "oauth_account", provider: "test", accountId, status: "active", createdBy: userId,
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connection.id}`;
		catalogs.set(`Bearer ${token}`, tools);
		return connection;
	}

	async function list(args: Record<string, unknown> = {}) {
		return await manageOperations(
			{ action: "list_available", connector_key: KEY, ...args } as never,
			{} as Env, owner.ctx,
		) as { operations: Array<Record<string, any>>; total: number };
	}

	it("preserves account-specific tools and schemas without probing hidden or paused accounts", async () => {
		const first = await account([tool("shared"), tool("variant", "first"), tool("first_only")]);
		const second = await account([tool("shared"), tool("variant", "second"), tool("second_only")]);
		const other = await createTestUser();
		await account([tool("private_secret")], other.id);
		await account([tool("paused")], owner.user.id, "paused");

		const broad = await list();
		expect(broad.total).toBe(5);
		const shared = broad.operations.find((op) => op.operation_key === "shared")!;
		expect(shared.execution_targets.map((target: { connection_id: number }) => target.connection_id)).toEqual([first.id, second.id]);
		for (const [connection, property] of [[first, "first"], [second, "second"]] as const) {
			const variant = broad.operations.find((op) => op.operation_key === "variant" && op.input_schema.properties[property]);
			expect(variant?.execution_targets).toMatchObject([{ connection_id: connection.id }]);
			expect(variant?.execution_targets).toHaveLength(1);
			const direct = await list({ connection_id: connection.id });
			expect(direct.operations.find((op) => op.operation_key === "variant")).toEqual(variant);
		}
		const serialized = JSON.stringify(broad);
		expect(serialized).not.toMatch(/private_secret|paused|discovery_connection_ids|backend_config/);
		expect(new Set(requests)).toEqual(new Set([`Bearer catalog-token-${first.id}`, `Bearer catalog-token-${second.id}`]));

		const installed = await listOrgInstalled(owner.org.id, ["connectors"], owner.ctx);
		expect(installed.connectors?.items.find((item) => item.id === KEY)?.detail).toMatchObject({
			has_operations: true, operations_summary: { total: 5 },
		});
		const policyCatalog = await listOperations({
			organizationId: owner.org.id, discoveryUserId: owner.user.id, kind: "write",
		});
		expect(policyCatalog.operations.map((op) => op.operation_key)).toEqual(broad.operations.map((op) => op.operation_key));
	});

	it("paginates after merging shared tools and applying action readiness", async () => {
		const tools = Array.from({ length: 105 }, (_, i) => tool(`operation_${i}`));
		const first = await account(tools);
		await account(tools);
		await getTestDb()`UPDATE connections SET config = '{"action_modes":{"operation_104":"disabled"}}'::jsonb WHERE id = ${first.id}`;
		const firstPage = await list();
		const lastPage = await list({ offset: 100 });
		expect(firstPage.total).toBe(105);
		expect(firstPage.operations).toHaveLength(100);
		expect(lastPage.total).toBe(105);
		expect(lastPage.operations).toHaveLength(5);
		expect(lastPage.operations[4].execution_targets).toMatchObject([
			{ connection_id: first.id, executable: false, status: "disabled" },
			{ executable: true, status: "ready" },
		]);
	});

	it("does not anonymously probe a protected connector without visible active connections", async () => {
		const other = await createTestUser();
		await account([tool("private_secret")], other.id);
		await account([tool("paused")], owner.user.id, "paused");
		expect(await list()).toMatchObject({ operations: [], total: 0 });
		await listOrgInstalled(owner.org.id, ["connectors"], owner.ctx);
		expect(requests).toEqual([]);
	});

	it("keeps public no-auth MCP capabilities discoverable without a connection", async () => {
		await getTestDb()`UPDATE connector_definitions SET auth_schema = NULL WHERE organization_id = ${owner.org.id} AND key = ${KEY}`;
		anonymousTools = [tool("public_tool")];
		const result = await list();
		expect(result.operations).toMatchObject([{
			operation_key: "public_tool", readiness: "disconnected", executable: false, execution_targets: [],
		}]);
		expect(new Set(requests)).toEqual(new Set(["anonymous"]));
	});

	it("isolates an unavailable account while explicit discovery reports its failure", async () => {
		const broken = await account(null);
		const working = await account([tool("working")]);
		const result = await list();
		expect(result.operations).toMatchObject([{
			operation_key: "working", execution_targets: [{ connection_id: working.id }],
		}]);
		await expect(list({ connection_id: broken.id })).rejects.toThrow(/503.*unavailable/);
		expect(requests).not.toContain("anonymous");
	});

	it("uses the same private-account catalog in policy pickers and policy validation", async () => {
		await account([tool("private_write")]);
		const session = await createTestSession(owner.user.id);
		const agent = await createTestAgent({ organizationId: owner.org.id, ownerUserId: owner.user.id });
		const env = { ENVIRONMENT: "test", BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only" } as Env;
		for (const path of [
			`/api/${owner.org.slug}/write-permissions`,
			`/api/${owner.org.slug}/agent/${agent.agentId}/permissions`,
		]) {
			const headers = { Cookie: session.cookieHeader, "Content-Type": "application/json" };
			const picker = await app.request(path, { headers }, env);
			expect(picker.status).toBe(200);
			expect((await picker.json()).connector_operations).toMatchObject([{
				operation_key: `${KEY}::private_write`,
			}]);
			const saved = await app.request(path, {
				method: "PUT", headers,
				body: JSON.stringify({ resource_class: "connector_action", operation_key: `${KEY}::private_write`, effects: { execute: "approval" } }),
			}, env);
			expect(saved.status).toBe(200);
		}
	});

	it("summarizes org-shared connections without exposing private-account capabilities", async () => {
		await account([tool("private_only")]);
		await getTestDb()`UPDATE connector_definitions SET auth_schema = NULL WHERE organization_id = ${owner.org.id} AND key = ${KEY}`;
		for (let i = 0; i < 2; i++) {
			await createTestConnection({
				organization_id: owner.org.id, connector_key: KEY, visibility: "org", createDefaultFeed: false,
			});
		}
		anonymousTools = [tool("public_tool")];
		expect(await getOperationsSummary(owner.org.id, KEY)).toMatchObject({ total: 1, mcp_tool: 1 });
		expect(new Set(requests)).toEqual(new Set(["anonymous"]));
		expect(requests).toHaveLength(6); // Each account negotiated its own session and tool list.
	});
});
