import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mcpAuth } from "../../../auth/middleware";
import {
	listEntityApprovalPolicies,
	resolveWriteEffect,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { writePermissionPolicy } from "../../../http/permission-policy-write";
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
	} = {},
) {
	let path = `/api/${org.slug}/${options.agent ? `agent/${options.agent}/permissions` : "write-permissions"}`;
	if (method === "DELETE")
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

beforeAll(async () => {
	await initWorkspaceProvider();
});
afterAll(async () => {
	await cleanupTestDatabase();
});
beforeEach(async () => {
	org = await createTestOrganization();
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
	it.each([
		undefined,
		agentId,
	])("requires a human session for connector policy writes and deletes (agent=%s)", async (agent) => {
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
			(await request("PUT", connectorPolicy, { headers: {} })).status,
		).toBe(401);
		for (const role of ["member", "admin"]) {
			const user = await createTestUser();
			await addUserToOrganization(user.id, org.id, role);
			const session = await createTestSession(user.id);
			expect(
				(
					await request("PUT", connectorPolicy, {
						headers: { Cookie: session.cookieHeader },
					})
				).status,
			).toBe(role === "admin" ? 200 : 403);
		}
		const outsider = await createTestUser();
		const session = await createTestSession(outsider.id);
		expect(
			(
				await request("PUT", connectorPolicy, {
					headers: { Cookie: session.cookieHeader },
				})
			).status,
		).toBe(403);
	});

	it("keeps org floors binding after an agent override is written or removed", async () => {
		expect(
			(
				await request("PUT", {
					...connectorPolicy,
					effects: { execute: "deny" },
				})
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
		const resolve = () =>
			resolveWriteEffect({
				organizationId: org.id,
				resourceClass: "connector_action",
				principalKind: "agent",
				principalId: agentId,
				action: "execute",
			});
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

	it.each([
		undefined,
		agentId,
	])("rejects malformed updates/deletes without erasing rules (agent=%s)", async (agent) => {
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

	it("validates qualified write operations and can remove policies after the catalog changes", async () => {
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
			qualifiedOperationKey("policy-fixture-a", "read"),
			qualifiedOperationKey("missing-connector", "classify"),
		]) {
			expect(
				(await request("PUT", { ...connectorPolicy, operation_key: invalid }))
					.status,
			).toBe(400);
		}
		expect(
			(
				await request("PUT", {
					...connectorPolicy,
					operation_key: key,
					effects: { execute: "disabled" },
				})
			).status,
		).toBe(200);
		const resolve = (operationKey: string) =>
			resolveWriteEffect({
				organizationId: org.id,
				resourceClass: "connector_action",
				principalKind: "agent",
				principalId: agentId,
				action: "execute",
				operationKey,
			});
		expect(await resolve(key)).toBe("disabled");
		expect(
			await resolve(qualifiedOperationKey("policy-fixture-b", "classify")),
		).toBe("auto");
		await sql`UPDATE connector_definitions SET actions_schema = '{}'::jsonb WHERE organization_id = ${org.id}`;
		expect(
			await (
				await request("DELETE", {
					resource_class: "connector_action",
					operation_key: key,
				})
			).json(),
		).toEqual({ deleted: true });
	});
});
