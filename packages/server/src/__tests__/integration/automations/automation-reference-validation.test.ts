/**
 * Foreign-key-shaped reference validation on manage_automations.
 *
 * `managed_agent_id`, `outputs.*.entity`, and `outputs.*.event` are free-text references with NO
 * database foreign key, so a typo is accepted and only fails much later — or
 * never fails at all, silently:
 *
 *  - `managed_agent_id`: the scheduler joins automations to agents on `managed_agent_id`, so a
 *    nonexistent agent yields an Automation that reports status 'active' /
 *    health 'healthy' and never runs. `automations.create` documents
 *    `throws: ["EntityNotFound"]` for exactly this case (see
 *    src/sandbox/method-metadata.ts) but never resolved the id.
 *  - `outputs.*.entity`: schema derivation cannot resolve an unknown type
 *    for an unknown type, and complete_window SKIPS extraction validation when
 *    the derived schema is null — so an unknown type silently VOIDS the output
 *    contract instead of enforcing it. Its sibling `entity_id` is validated
 *    and throws, so the pair was inconsistent.
 *
 * Both are validated on create, update, and create_version.
 */

import { readAutomationRevision } from './revision-fixture';
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { ensureMemberEntityType } from "../../../utils/member-entity-type";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
};

function ownerCtx(orgId: string, userId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgId}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	};
}

describe("manage_automations reference validation", () => {
	let workspace: TestWorkspace;
	let ctx: AuthContext;
	let agentId: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create();
		await ensureMemberEntityType(workspace.org.id);
		ctx = ownerCtx(workspace.org.id, workspace.users.owner.id);
		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		agentId = agent.agentId;
	});

	// ============================================
	// managed_agent_id
	// ============================================

	it("create rejects a nonexistent managed_agent_id (documented EntityNotFound)", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "ghost-agent",
					name: "ghost-agent",
					prompt: "Track things.",
					managed_agent_id: "agent-does-not-exist",
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Agent "agent-does-not-exist" not found/i);
	});

	it("create does NOT persist an Automation when managed_agent_id is nonexistent", async () => {
		await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ghost-agent-norow",
				name: "ghost-agent-norow",
				prompt: "Track things.",
				managed_agent_id: "agent-does-not-exist",
			},
			TEST_ENV,
			ctx
		).catch(() => undefined);

		const rows = await getTestDb()<{ id: number }>`
      SELECT id FROM automations WHERE slug = ${"ghost-agent-norow"}
    `;
		expect(rows).toHaveLength(0);
	});

	it("create rejects a managed_agent_id belonging to ANOTHER organization", async () => {
		const other = await TestWorkspace.create({ name: "Other Org" });
		const foreign = await createTestAgent({
			organizationId: other.org.id,
			ownerUserId: other.users.owner.id,
		});

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "cross-org-agent",
					name: "cross-org-agent",
					prompt: "Track things.",
					managed_agent_id: foreign.agentId,
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/not found/i);
	});

	it("update rejects a nonexistent managed_agent_id", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "update-agent-target",
				name: "update-agent-target",
				prompt: "Track things.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					expected_revision: await readAutomationRevision(workspace.owner, created.automation_id),
					action: "update",
					automation_id: created.automation_id,
					managed_agent_id: "agent-does-not-exist",
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Agent "agent-does-not-exist" not found/i);

		// The stored owner must be untouched by the rejected update.
		const [row] = await getTestDb()<{ managed_agent_id: string }>`
      SELECT managed_agent_id FROM automations WHERE id = ${Number(created.automation_id)}
    `;
		expect(row.managed_agent_id).toBe(agentId);
	});

	it("create/update accept a real managed_agent_id", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "happy-agent",
				name: "happy-agent",
				prompt: "Track things.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };
		expect(created.automation_id).toBeDefined();

		const second = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		const updated = (await executeTool(
			"manage_automations",
			{
				expected_revision: await readAutomationRevision(workspace.owner, created.automation_id),
				action: "update",
				automation_id: created.automation_id,
				managed_agent_id: second.agentId,
			},
			TEST_ENV,
			ctx
		)) as { updated_fields: string[] };
		expect(updated.updated_fields).toContain("managed_agent_id");
	});

	// ============================================
	// outputs.*.entity
	// ============================================

	it("create rejects a nonexistent entity output type", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "ghost-entity-type",
					name: "ghost-entity-type",
					prompt: "Track things.",
					managed_agent_id: agentId,
					outputs: {
						rows: { entity: "not-a-real-type", key: ["sku"] },
					},
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Unknown entity type 'not-a-real-type'/i);
	});

	it("create accepts an entity output type that exists", async () => {
		await workspace.owner.entity_schema.createType({
			slug: "price",
			name: "Price",
		});

		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "real-entity-type",
				name: "real-entity-type",
				prompt: "Track things.",
				managed_agent_id: agentId,
				outputs: {
					prices: { entity: "price", key: ["sku"] },
				},
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };
		expect(created.automation_id).toBeDefined();
	});

	it("create rejects entity key and name fields missing from a declared schema", async () => {
		await workspace.owner.entity_schema.createType({
			slug: "typed-price",
			name: "Typed Price",
			metadata_schema: {
				type: "object",
				properties: { sku: { type: "string" }, label: { type: "string" } },
			},
		});

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "bad-output-key",
					prompt: "Track prices.",
					managed_agent_id: agentId,
					outputs: {
						prices: { entity: "typed-price", key: ["skuu"], name: ["label"] },
					},
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Unknown field 'skuu'.*typed-price/i);
	});

	it("create validates a tenant-local entity output type before a public shadow", async () => {
		const catalog = await TestWorkspace.create({
			name: "Public Output Catalog",
			visibility: "public",
		});
		await catalog.owner.entity_schema.createType({
			slug: "shadowed-output",
			name: "Public Shadow",
			metadata_schema: {
				type: "object",
				properties: { public_key: { type: "string" } },
			},
		});
		await workspace.owner.entity_schema.createType({
			slug: "shadowed-output",
			name: "Local Shadow",
			metadata_schema: {
				type: "object",
				properties: { local_key: { type: "string" } },
			},
		});

		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "local-shadow-output",
				prompt: "Track local rows.",
				managed_agent_id: agentId,
				outputs: {
					rows: { entity: "shadowed-output", key: ["local_key"] },
				},
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };

		expect(Number(created.automation_id)).toBeGreaterThan(0);
	});

	it("create_version rejects a nonexistent entity output type", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "version-entity-type",
				name: "version-entity-type",
				prompt: "Track things.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					expected_revision: await readAutomationRevision(workspace.owner, created.automation_id),
					action: "create_version",
					automation_id: created.automation_id,
					prompt: "Track things differently.",
					outputs: {
						rows: { entity: "not-a-real-type", key: ["sku"] },
					},
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Unknown entity type 'not-a-real-type'/i);
	});

	it("create and create_version reject event output types outside the org registry", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "ghost-event-type",
					prompt: "Track things.",
					managed_agent_id: agentId,
					outputs: { alerts: { event: "not_a_registered_kind" } },
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Invalid event type 'not_a_registered_kind'/i);

		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "event-version-target",
				prompt: "Track things.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };
		await expect(
			executeTool(
				"manage_automations",
				{
					expected_revision: await readAutomationRevision(workspace.owner, created.automation_id),
					action: "create_version",
					automation_id: created.automation_id,
					outputs: { alerts: { event: "not_a_registered_kind" } },
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/Invalid event type 'not_a_registered_kind'/i);
	});

	it("accepts the built-in draft_reply output type", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "draft-reply-output",
				prompt: "Draft a reply without publishing it.",
				managed_agent_id: agentId,
				outputs: { drafts: { event: "draft_reply" } },
			},
			TEST_ENV,
			ctx
		)) as { automation_id: string };

		expect(Number(created.automation_id)).toBeGreaterThan(0);
	});

	it("rejects outputs on event turn execution", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "turn-output",
					managed_agent_id: agentId,
					outputs: { alerts: { event: "observation" } },
					triggers: [
						{
							kind: "event",
							connector_key: "github",
							event_types: ["pull_request.created"],
							execution: "turn",
						},
					],
				},
				TEST_ENV,
				ctx
			)
		).rejects.toThrow(/outputs require window execution/i);
	});
});
