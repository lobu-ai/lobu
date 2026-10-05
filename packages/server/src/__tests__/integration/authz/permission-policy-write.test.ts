import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mcpAuth } from "../../../auth/middleware";
import {
	deleteEntityApprovalPolicy,
	listEntityApprovalPolicies,
	resolveConnectorPolicy,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { readConnectorPolicyCollection, replaceConnectorPolicyCollection } from "../../../http/connector-policy-collection";
import { explainPermissionPolicy, permissionPolicyCatalog, writePermissionPolicy } from "../../../http/permission-policy-write";
import type { Env } from "../../../index";
import { qualifiedOperationKey } from "../../../tools/admin/manage_operations/handlers/shared";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestAgent,
	createTestConnection,
	createTestConnectorDefinition,
	createTestOAuthClient,
	createTestOrganization,
	createTestPAT,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";

const env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	RATE_LIMIT_ENABLED: "false",
} as unknown as Env;
const app = new Hono<{ Bindings: Env }>();
app.on(
	["PUT", "DELETE"],
	[
		"/api/:orgSlug/write-permissions",
		"/api/:orgSlug/agent/:agentId/permissions",
	],
	mcpAuth,
	writePermissionPolicy,
);
app.get("/api/:orgSlug/write-permissions/explain", mcpAuth, explainPermissionPolicy);
app.get("/api/:orgSlug/write-permissions/connector-actions", mcpAuth, readConnectorPolicyCollection);
app.put("/api/:orgSlug/write-permissions/connector-actions", mcpAuth, replaceConnectorPolicyCollection);
const connectorPolicy = {
	resource_class: "connector_action",
	effects: { execute: "approval" },
};
const agentId = "policy-test-agent";
let org: Awaited<ReturnType<typeof createTestOrganization>>;
let cookie: string;
let oauth: string;
let pat: string;

function request(
	method: string,
	input: unknown,
	options: {
		agent?: string;
		headers?: Record<string, string>;
		raw?: string;
		explain?: boolean;
	} = {},
) {
	let path = `/api/${org.slug}/${options.agent ? `agent/${options.agent}/permissions` : "write-permissions"}`;
	if (options.explain) path += "/explain";
	if (method === "DELETE" || method === "GET")
		path += `?${new URLSearchParams(input as Record<string, string>)}`;
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: "http://localhost",
				...(options.headers ?? { Cookie: cookie }),
			},
			...(method === "PUT"
				? { body: options.raw ?? JSON.stringify(input) }
				: {}),
		}),
		env,
	);
}

async function orgRules(rules: Record<string, unknown>[]) {
	const url = `http://localhost/api/${org.slug}/write-permissions/connector-actions`;
	const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: "http://localhost" };
	const current = await (await app.fetch(new Request(url, { headers }), env)).json();
	return app.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({ revision: current.revision, rules }) }), env);
}

beforeAll(async () => {
	await initWorkspaceProvider();
});
afterAll(async () => {
	await cleanupTestDatabase();
});
beforeEach(async () => {
	org = await createTestOrganization();
	await deleteEntityApprovalPolicy({ organizationId: org.id, resourceClass: "connector_action", operationCategory: "read" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	cookie = (await createTestSession(user.id)).cookieHeader;
	const client = await createTestOAuthClient();
	oauth = (
		await createTestAccessToken(user.id, org.id, client.client_id, {
			scope: "mcp:read mcp:write mcp:admin",
		})
	).token;
	pat = (await createTestPAT(user.id, org.id)).token;
	await createTestAgent({ organizationId: org.id, agentId });
});

describe("permission policy HTTP writes", () => {
	it("requires a human session for agent connector restriction writes and deletes", async () => {
		const agent = agentId;
		expect((await request("PUT", connectorPolicy, { agent })).status).toBe(200);
		for (const token of [oauth, pat]) {
			const headers = { Authorization: `Bearer ${token}` };
			expect(
				(
					await request(
						"PUT",
						{ ...connectorPolicy, effects: { execute: "auto" } },
						{ agent, headers },
					)
				).status,
			).toBe(403);
			expect(
				(
					await request(
						"DELETE",
						{ resource_class: "connector_action" },
						{ agent, headers },
					)
				).status,
			).toBe(403);
		}
		const policies = await listEntityApprovalPolicies(org.id);
		expect(
			policies.find((p) => p.resourceClass === "connector_action")?.effects
				.execute,
		).toBe("approval");
		expect(
			await (
				await request(
					"DELETE",
					{ resource_class: "connector_action" },
					{ agent },
				)
			).json(),
		).toEqual({ deleted: true });
	});

	it("rejects org connector writes through the single-rule path without changing saved rules", async () => {
		expect((await orgRules([{ effect: "deny" }])).status).toBe(200);
		for (const method of ["PUT", "DELETE"]) {
			const response = await request(method, connectorPolicy);
			expect(response.status).toBe(400);
			expect((await response.json()).message).toContain("connector-actions");
		}
		expect((await listEntityApprovalPolicies(org.id, "connector_action"))[0].effects.execute).toBe("deny");
	});

	it("preserves OAuth admin access for other policy classes", async () => {
		const headers = { Authorization: `Bearer ${oauth}` };
		for (const resource_class of ["entity", "entity_schema", "agent_config"]) {
			const body = {
				resource_class,
				effects: {
					[resource_class === "entity_schema" ? "update_type" : "update"]:
						"approval",
				},
				...(resource_class === "entity"
					? { entity_type_slug: "policy_fixture" }
					: {}),
			};
			expect((await request("PUT", body, { headers })).status).toBe(200);
			expect(await (await request("DELETE", body, { headers })).json()).toEqual(
				{ deleted: true },
			);
		}
	});

	it("requires org membership and an owner/admin session", async () => {
		expect(
			(await request("PUT", connectorPolicy, { agent: agentId, headers: {} })).status,
		).toBe(401);
		for (const role of ["member", "admin"]) {
			const user = await createTestUser();
			await addUserToOrganization(user.id, org.id, role);
			const session = await createTestSession(user.id);
			expect(
				(
					await request("PUT", connectorPolicy, {
						agent: agentId, headers: { Cookie: session.cookieHeader },
					})
				).status,
			).toBe(role === "admin" ? 200 : 403);
		}
		const outsider = await createTestUser();
		const session = await createTestSession(outsider.id);
		expect(
			(
				await request("PUT", connectorPolicy, {
					agent: agentId, headers: { Cookie: session.cookieHeader },
				})
			).status,
		).toBe(403);
	});

	it("keeps org floors binding after an agent override is written or removed", async () => {
		expect(
			(
				await orgRules([{ effect: "deny" }])
			).status,
		).toBe(200);
		expect(
			(
				await request(
					"PUT",
					{ ...connectorPolicy, effects: { execute: "auto" } },
					{ agent: agentId },
				)
			).status,
		).toBe(200);
		const resolve = async () => (await resolveConnectorPolicy({
			organizationId: org.id,
			connectionId: 1,
			operation: { connector_key: "policy-fixture", operation_key: "classify", kind: "write" },
			actor: { kind: "agent", id: agentId, ownerAgentId: null, ownerResolved: true },
		})).effect;
		expect(await resolve()).toBe("deny");
		expect(
			await (
				await request(
					"DELETE",
					{ resource_class: "connector_action" },
					{ agent: agentId },
				)
			).json(),
		).toEqual({ deleted: true });
		expect(await resolve()).toBe("deny");
	});

	it("rejects malformed agent restriction updates/deletes without erasing rules", async () => {
		const agent = agentId;
		expect((await request("PUT", connectorPolicy, { agent })).status).toBe(200);
		for (const body of [
			null,
			[],
			1,
			{},
			{ ...connectorPolicy, effects: [] },
			{ ...connectorPolicy, effects: { delete: "auto" } },
			{ ...connectorPolicy, effects: { execute: "unknown" } },
			{ ...connectorPolicy, entity_type_slug: "fixture" },
			{ ...connectorPolicy, operation_key: " " },
		]) {
			expect((await request("PUT", body, { agent })).status).toBe(400);
		}
		expect((await request("PUT", null, { agent, raw: "{" })).status).toBe(400);
		for (const scope of [
			{ operation_key: " " },
			{ operation_key: "" },
			{ entity_type_slug: "fixture" },
			{ target_agent_id: "fixture" },
		]) {
			expect(
				(
					await request(
						"DELETE",
						{ resource_class: "connector_action", ...scope },
						{ agent },
					)
				).status,
			).toBe(400);
		}
		expect(
			(await listEntityApprovalPolicies(org.id)).find(
				(p) => p.resourceClass === "connector_action",
			)?.effects.execute,
		).toBe("approval");
	});

	it("preserves delivery and response fields while replacing sparse effects", async () => {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity",
			entityTypeSlug: "policy_fixture",
			effects: { update: "approval", delete: "deny" },
			approvalConnectionId: "test-policy-delivery",
			approvalChannelId: "test-policy-channel",
		});
		const response = await request("PUT", {
			resource_class: "entity",
			entity_type_slug: "policy_fixture",
			effects: { update: "auto" },
		});
		expect(response.status).toBe(200);
		const { policy } = await response.json();
		expect(policy).toMatchObject({
			organization_id: org.id,
			resource_class: "entity",
			principal_kind: null,
			principal_id: null,
			entity_type_slug: "policy_fixture",
			effects: { update: "auto" },
			approval_connection_id: "test-policy-delivery",
			approval_channel_id: "test-policy-channel",
		});
		expect(policy.effects).not.toHaveProperty("delete");
		expect(
			(
				await request("PUT", {
					resource_class: "entity",
					entity_type_slug: "policy_fixture",
					effects: {},
				})
			).status,
		).toBe(200);
	});

	it("preserves entity floors and validates agent targets in the current org", async () => {
		expect(
			await (await request("DELETE", { resource_class: "entity" })).json(),
		).toEqual({
			deleted: false,
		});
		const otherOrg = await createTestOrganization();
		await createTestAgent({
			organizationId: otherOrg.id,
			agentId: "foreign-policy-agent",
		});
		for (const target of ["foreign-policy-agent", "missing-policy-agent"]) {
			expect(
				(await request("PUT", connectorPolicy, { agent: target })).status,
			).toBe(404);
			expect(
				(
					await request("PUT", {
						resource_class: "agent_config",
						target_agent_id: target,
						effects: { update: "deny" },
					})
				).status,
			).toBe(400);
		}
		expect(
			(
				await request("PUT", {
					resource_class: "agent_config",
					target_agent_id: agentId,
					effects: { update: "deny" },
				})
			).status,
		).toBe(200);
		expect(
			await (
				await request("DELETE", {
					resource_class: " agent_config ",
					target_agent_id: agentId,
				})
			).json(),
		).toEqual({ deleted: true });
	});

	it("validates qualified operations and can remove policies after the catalog changes", async () => {
		const sql = getTestDb();
		for (const key of ["policy-fixture-a", "policy-fixture-b"]) {
			await createTestConnectorDefinition({
				key,
				name: key,
				organization_id: org.id,
			});
			await createTestConnection({
				organization_id: org.id,
				connector_key: key,
			});
			await sql`UPDATE connector_definitions SET actions_schema = '{"classify":{"name":"Classify","kind":"write"},"read":{"name":"Read","kind":"read"}}'::jsonb WHERE organization_id = ${org.id} AND key = ${key}`;
		}
		const key = qualifiedOperationKey("policy-fixture-a", "classify");
		for (const invalid of [
			"classify",
			qualifiedOperationKey("missing-connector", "classify"),
		]) {
			expect(
				(await request("PUT", { ...connectorPolicy, operation_key: invalid }, { agent: agentId }))
					.status,
			).toBe(400);
		}
		expect(
			(
				await request("PUT", {
					...connectorPolicy,
					operation_key: key,
					effects: { execute: "deny" },
				}, { agent: agentId })
			).status,
		).toBe(200);
		const resolve = async (connectorKey: string) => (await resolveConnectorPolicy({
			organizationId: org.id,
			connectionId: 1,
			operation: { connector_key: connectorKey, operation_key: "classify", kind: "write" },
			actor: { kind: "agent", id: agentId, ownerAgentId: null, ownerResolved: true },
		})).effect;
		expect((await listEntityApprovalPolicies(org.id, "connector_action")).find((row) => row.operationKey === key))
			.toMatchObject({ connectorKey: "policy-fixture-a", connectionId: null });
		expect(await resolve("policy-fixture-a")).toBe("deny");
		expect(await resolve("policy-fixture-b")).toBe("approval");
		expect((await request("PUT", {
			...connectorPolicy,
			operation_key: qualifiedOperationKey("policy-fixture-a", "read"),
			effects: { execute: "auto" },
		}, { agent: agentId })).status).toBe(200);
		expect((await request("DELETE", { resource_class: "connector_action", operation_key: "unqualified" }, { agent: agentId })).status).toBe(400);
		await sql`UPDATE connector_definitions SET actions_schema = '{}'::jsonb WHERE organization_id = ${org.id}`;
		expect(
			await (
				await request("DELETE", {
					resource_class: "connector_action",
					operation_key: key,
				}, { agent: agentId })
			).json(),
		).toEqual({ deleted: true });
	});

	it("saves scoped rules and explains the same result through authenticated HTTP", async () => {
		await createTestConnectorDefinition({ key: "policy-http", name: "Policy HTTP", organization_id: org.id });
		const connection = await createTestConnection({ organization_id: org.id, connector_key: "policy-http" });
		await getTestDb()`UPDATE connector_definitions SET actions_schema = '{"classify":{"name":"Classify","kind":"write"}}'::jsonb WHERE organization_id = ${org.id} AND key = 'policy-http'`;
		const scope = { resource_class: "connector_action", connection_id: connection.id, operation_category: "write" };
		const saved = await orgRules([{ connection_id: connection.id, operation_category: "write", effect: "auto" }]);
		expect(saved.status).toBe(200);
		expect((await saved.json()).rules).toEqual([{ connection_id: connection.id, operation_category: "write", effect: "auto" }]);
		const policy = (await listEntityApprovalPolicies(org.id, "connector_action")).find(row => row.connectionId === connection.id)!;
		const input = { connection_id: String(connection.id), operation_key: "classify", agent_id: agentId };
		const inspect = () => request("GET", input, { explain: true });
		expect(await (await inspect()).json()).toEqual({ effect: "auto", rule_ids: [policy.id], reason: "matched_rule" });
		expect((await request("PUT", { ...scope, effects: { execute: "deny" } }, { agent: agentId })).status).toBe(200);
		expect(await (await inspect()).json()).toMatchObject({ effect: "deny", reason: "matched_rule" });
		expect(await (await request("DELETE", scope, { agent: agentId })).json()).toEqual({ deleted: true });
		expect((await orgRules([])).status).toBe(200);
		expect(await (await inspect()).json()).toEqual({ effect: "approval", rule_ids: [], reason: "default_approval" });
	});

	it("rejects foreign connections, invalid scope combinations, and mismatched operation targets", async () => {
		const otherOrg = await createTestOrganization();
		await createTestConnectorDefinition({ organization_id: otherOrg.id, key: "policy-foreign", name: "Foreign policy fixture" });
		const foreign = await createTestConnection({ organization_id: otherOrg.id, connector_key: "policy-foreign" });
		for (const key of ["policy-scope-a", "policy-scope-b"]) {
			await createTestConnectorDefinition({ key, name: key, organization_id: org.id });
			await getTestDb()`UPDATE connector_definitions SET actions_schema = '{"read":{"name":"Read","kind":"read"}}'::jsonb WHERE organization_id = ${org.id} AND key = ${key}`;
		}
		const connection = await createTestConnection({ organization_id: org.id, connector_key: "policy-scope-a" });
		for (const scope of [
			{ connection_id: foreign.id },
			{ connector_key: "missing-policy-connector" },
			{ connection_id: connection.id, operation_key: "policy-scope-b::read" },
			{ connector_key: "policy-scope-a", operation_key: "policy-scope-b::read" },
			{ connector_key: "policy-scope-a", connection_id: connection.id },
			{ operation_key: "policy-scope-a::read", operation_category: "read" },
			{ connection_id: true },
			{ connection_id: "1.5" },
			{ connection_id: "0x10" },
			{ connection_id: Number.MAX_SAFE_INTEGER + 1 },
			{ operation_category: "invalid" },
			{ effects: { execute: "disabled" } },
		]) expect((await request("PUT", { ...connectorPolicy, ...scope }, { agent: agentId })).status).toBe(400);
		for (const resource_class of ["entity", "entity_schema", "agent_config"]) {
			for (const scope of [{ connection_id: connection.id }, { connector_key: "policy-scope-a" }, { operation_category: "read" }]) {
				expect((await request("PUT", { resource_class, ...scope, effects: {} })).status).toBe(400);
			}
		}
		const scope = { resource_class: "connector_action", connection_id: connection.id, operation_category: "read" };
		expect((await request("PUT", { ...scope, effects: { execute: "deny" } }, { agent: agentId })).status).toBe(200);
		await getTestDb()`UPDATE connections SET deleted_at = NOW() WHERE organization_id = ${org.id} AND id = ${connection.id}`;
		expect(await (await request("DELETE", scope, { agent: agentId })).json()).toEqual({ deleted: true });
	});

	it("lets admins inspect Blocked operations without trusting caller-supplied classification", async () => {
		await createTestConnectorDefinition({ key: "policy-inspect", name: "Inspect", organization_id: org.id });
		const connection = await createTestConnection({ organization_id: org.id, connector_key: "policy-inspect" });
		await getTestDb()`UPDATE connector_definitions SET actions_schema = '{"classify":{"name":"Classify","kind":"write"},"read":{"name":"Read","kind":"read","annotations":{"destructiveHint":false}}}'::jsonb WHERE organization_id = ${org.id} AND key = 'policy-inspect'`;
		expect((await orgRules([{ effect: "deny" }, { operation_category: "read", effect: "auto" }])).status).toBe(200);
		const query = { connection_id: String(connection.id), operation_key: "classify", kind: "read", destructive: "false" };
		expect(await (await request("GET", query, { explain: true })).json()).toMatchObject({ effect: "deny" });
		const catalog = await permissionPolicyCatalog(org.id);
		expect(catalog.connector_operations).toEqual(expect.arrayContaining([
			expect.objectContaining({ operation_key: "policy-inspect::classify", kind: "write", destructive: null }),
			expect.objectContaining({ operation_key: "policy-inspect::read", kind: "read", destructive: false }),
		]));
		expect(catalog.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: connection.id, connector_key: "policy-inspect" })]));
		expect(catalog.connectors).toContainEqual({ key: "policy-inspect", name: "Inspect" });
		expect(catalog.operation_categories).toEqual(["read", "write", "destructive", "non_destructive", "unknown"]);
		expect(catalog.connector_operations[0]).not.toHaveProperty("requires_approval");
		const otherOrg = await createTestOrganization();
		await createTestConnectorDefinition({ organization_id: otherOrg.id, key: "policy-foreign", name: "Foreign policy fixture" });
		const foreign = await createTestConnection({ organization_id: otherOrg.id, connector_key: "policy-foreign" });
		expect((await request("GET", { ...query, connection_id: String(foreign.id) }, { explain: true })).status).toBe(404);
		expect((await request("GET", { ...query, agent_id: agentId, automation_id: "1" }, { explain: true })).status).toBe(400);
		expect(await (await request("GET", { ...query, agent_id: "missing-agent" }, { explain: true })).json()).toMatchObject({ effect: "deny", reason: "unresolved_principal" });
	});
});
