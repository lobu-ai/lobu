/**
 * MCP entitySchema.createType approval lifecycle.
 *
 * This is intentionally a wire-level test for proposal creation: the caller
 * enters through JSON-RPC tools/call -> run_sdk -> ClientSDK, which is the same
 * path MCP Inspector and ChatGPT use. Approval resolution enters through the
 * existing MCP App tools, proving the held proposal is applied only after a
 * human owner uses the capability-bound confirmation surface.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CHECK_NOT_APPLICABLE } from "../../../auth/tool-access";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { getDb } from "../../../db/client";
import type { Env } from "../../../index";
import { clearInMemoryMcpSessionsForTests } from "../../../mcp-handler";
import { getNextNumericId } from "../../../tools/admin/helpers/db-helpers";
import { manageEntitySchema } from "../../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../../tools/registry";
import {
	addUserToOrganization,
	createTestAgent,
	createTestAccessToken,
	createTestOAuthClient,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";
import { cleanupTestDatabase } from "../../setup/test-db";
import { mcpRequest, mcpToolsCall, post } from "../../setup/test-helpers";
import { freshSchemaEditor, TestApiClient } from "../../setup/test-mcp-client";

type PendingCreate = {
	schema_type: "entity_type";
	action: "create";
	status: "pending_approval";
	run_id: number;
	event_id: number;
	approval_url: string;
	proposal: {
		version: 1;
		resource_class: "entity_schema";
		policy_action: "create_type";
		schema_type: "entity_type";
		action: "create";
		args: Record<string, unknown>;
	};
	current: null;
};

describe("MCP entitySchema.createType approval", () => {
	let org: Awaited<ReturnType<typeof createTestOrganization>>;
	let owner: Awaited<ReturnType<typeof createTestUser>>;
	let member: Awaited<ReturnType<typeof createTestUser>>;
	let memberToken: string;
	let ownerWriteToken: string;
	let ownerAdminToken: string;
	let automationId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		clearInMemoryMcpSessionsForTests();

		org = await createTestOrganization({
			name: "Entity schema MCP approval",
			slug: "entity-schema-mcp-approval",
		});
		owner = await createTestUser({
			email: "entity-schema-owner@test.example.com",
		});
		member = await createTestUser({
			email: "entity-schema-member@test.example.com",
		});
		await addUserToOrganization(owner.id, org.id, "owner");
		await addUserToOrganization(member.id, org.id, "member");

		const oauthClient = await createTestOAuthClient();
		memberToken = (
			await createTestAccessToken(member.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write profile:read",
			})
		).token;
		ownerWriteToken = (
			await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write profile:read",
			})
		).token;
		ownerAdminToken = (
			await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
				scope: "mcp:read mcp:write mcp:admin profile:read",
			})
		).token;

		automationId = (await getDb().begin(async (tx) => {
			const id = await getNextNumericId(tx, "automations");
			await tx`
				INSERT INTO automations (
					id, automation_group_id, organization_id, created_by, name, slug
				) VALUES (
					${id}, ${id}, ${org.id}, ${owner.id},
					'Reaction schema mutation', 'reaction-schema-mutation'
				)
			`;
			return id;
		})) as number;
	});

	beforeEach(async () => {
		await getDb()`DELETE FROM write_approval_policies WHERE organization_id = ${org.id}`;
		await getDb()`UPDATE automations SET managed_agent_id = NULL, status = 'active' WHERE id = ${automationId}`;
	});

	function inProcessAgentCtx(agentId: string): ToolContext {
		return {
			organizationId: org.id,
			userId: null,
			memberRole: null,
			isAuthenticated: true,
			tokenType: "session",
			scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
			scopedToOrg: true,
			allowCrossOrg: false,
			clientId: null,
			agentId,
			sourceContext: { source: "automation-run" },
		};
	}

	async function setCreatePolicy(effect: "auto" | "approval" | "deny") {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_type: effect },
		});
	}

	async function setUpdatePolicy(effect: "auto" | "approval" | "deny") {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { update_type: effect },
		});
	}

	async function entityTypeExists(slug: string): Promise<boolean> {
		const rows = await getDb()`
			SELECT 1 FROM entity_types
			WHERE organization_id = ${org.id} AND slug = ${slug} AND deleted_at IS NULL
		`;
		return rows.length > 0;
	}

	async function propose(
		slug: string,
		token = ownerAdminToken,
		name = slug,
		extra: Record<string, unknown> = {},
	): Promise<PendingCreate> {
		const input = { ...extra, slug, name };
		const result = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script: `export default async (_ctx, client) => client.entitySchema.createType(${JSON.stringify(input)});`,
			},
			{ token, orgSlug: org.slug },
		);
		expect(result.success).toBe(true);
		return result.return_value;
	}

	async function resolveInApp(
		runId: number,
		decision: "approve" | "reject",
		token = ownerWriteToken,
	) {
		const viewResponse = await mcpRequest<any>(
			"tools/call",
			{
				name: "get_approval",
				arguments: { run_id: runId },
			},
			{ token, orgSlug: org.slug },
		);
		expect(viewResponse.result?.isError).not.toBe(true);
		expect(viewResponse.result?.structuredContent?.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "approve", tool: "resolve_approval" }),
				expect.objectContaining({ id: "reject", tool: "resolve_approval" }),
				expect.objectContaining({
					id: "review",
					href: expect.stringMatching(/^https?:\/\//),
				}),
			]),
		);
		const capability = viewResponse.result?._meta?.["lobu/approval-capability"];
		expect(typeof capability).toBe("string");
		const view = viewResponse.result?.structuredContent;

		const response = await mcpRequest<any>(
			"tools/call",
			{
				name: "resolve_approval",
				arguments: {
					run_id: runId,
					decision,
					_meta: { "lobu/approval-capability": capability },
				},
			},
			{ token, orgSlug: org.slug },
		);
		return { response, capability, view };
	}

	it("keeps a direct human owner create immediate", async () => {
		const client = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		const result = (await client.entity_schema.createType({
			slug: "direct-human-type",
			name: "Direct human type",
		})) as Record<string, unknown>;
		expect(result.status).toBe("applied");
		expect(await entityTypeExists("direct-human-type")).toBe(true);

		const directMember = await TestApiClient.for({
			organizationId: org.id,
			userId: member.id,
			memberRole: "member",
			scopes: ["mcp:read", "mcp:write"],
		});
		await expect(
			directMember.entity_schema.createType({
				slug: "direct-member-type",
				name: "Direct member type",
			}),
		).rejects.toThrow(/admin|owner/i);
		expect(await entityTypeExists("direct-member-type")).toBe(false);
	});

	it("governs trusted in-process Automation schema mutations without a human role", async () => {
		const reactionCtx: ToolContext = {
			organizationId: org.id,
			userId: null,
			memberRole: null,
			isAuthenticated: true,
			tokenType: "session",
			scopes: [...SCOPE_CHECK_NOT_APPLICABLE],
			scopedToOrg: true,
			allowCrossOrg: false,
			clientId: null,
			actingAutomationId: automationId,
			actingRunId: 1,
			sourceContext: { source: "automation-run" },
		};
		const env = {} as Env;

		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "automation",
			effects: { create_type: "deny" },
		});
		const denied = await manageEntitySchema(
			{
				schema_type: "entity_type",
				action: "create",
				slug: "reaction-denied-type",
				name: "Reaction denied type",
			},
			env,
			reactionCtx,
		);
		expect(denied).toMatchObject({ status: "denied" });
		expect(await entityTypeExists("reaction-denied-type")).toBe(false);

		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "automation",
			effects: {
				create_type: "auto",
				update_type: "auto",
				create_relationship_type: "auto",
				update_relationship_type: "auto",
			},
		});
		for (const [slug, name] of [
			["reaction-source-type", "Reaction source type"],
			["reaction-target-type", "Reaction target type"],
		] as const) {
			await expect(
				manageEntitySchema(
					{ schema_type: "entity_type", action: "create", slug, name },
					env,
					reactionCtx,
				),
			).resolves.toMatchObject({ status: "applied" });
		}
		await expect(
			manageEntitySchema(
				{
					schema_type: "entity_type",
					action: "update",
					slug: "reaction-source-type",
					expected_revision: (await manageEntitySchema({ schema_type: "entity_type", action: "get", slug: "reaction-source-type" }, env, reactionCtx)).entity_type!.revision,
					name: "Reaction source updated",
				},
				env,
				reactionCtx,
			),
		).resolves.toMatchObject({ status: "applied" });
		await expect(
			manageEntitySchema(
				{
					schema_type: "relationship_type",
					action: "create",
					slug: "reaction-related-type",
					name: "Reaction related type",
				},
				env,
				reactionCtx,
			),
		).resolves.toMatchObject({ status: "applied" });
		await expect(
			manageEntitySchema(
				{
					schema_type: "relationship_type",
					action: "add_rule",
					slug: "reaction-related-type",
					expected_revision: (await manageEntitySchema({ schema_type: "relationship_type", action: "get", slug: "reaction-related-type" }, env, reactionCtx)).relationship_type!.revision,
					source_entity_type_slug: "reaction-source-type",
					target_entity_type_slug: "reaction-target-type",
				},
				env,
				reactionCtx,
			),
		).resolves.toMatchObject({ status: "applied" });

		const [source] = await getDb()<[{ name: string }]>`
			SELECT name FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'reaction-source-type'
		`;
		expect(source.name).toBe("Reaction source updated");
		expect(
			await getDb()`
				SELECT r.id FROM entity_relationship_type_rules r
				JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
				WHERE rt.organization_id = ${org.id}
					AND rt.slug = 'reaction-related-type'
					AND r.deleted_at IS NULL
			`,
		).toHaveLength(1);
	});

	it("fails closed when the agent that proposed a pending schema mutation is deleted", async () => {
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			principalId: agent.agentId,
			effects: { create_type: "approval" },
		});
		const pending = await manageEntitySchema(
			{
				schema_type: "entity_type",
				action: "create",
				slug: "deleted-agent-held-type",
				name: "Deleted agent held type",
			},
			{} as Env,
			inProcessAgentCtx(agent.agentId),
		);
		expect(pending).toMatchObject({ status: "pending_approval" });
		await getDb()`DELETE FROM agents WHERE organization_id = ${org.id} AND id = ${agent.agentId}`;

		const { response } = await resolveInApp(Number(pending.run_id), "approve");
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(/denies|policy/i);
		expect(await entityTypeExists("deleted-agent-held-type")).toBe(false);
	});

	it("uses the current Automation owner policy when a pending schema mutation is approved", async () => {
		const originalOwner = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
		});
		const currentOwner = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
		});
		await getDb()`UPDATE automations SET managed_agent_id = ${originalOwner.agentId} WHERE id = ${automationId}`;
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "automation",
			principalId: `automation:${automationId}`,
			effects: { create_type: "approval" },
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			principalId: currentOwner.agentId,
			effects: { create_type: "deny" },
		});
		const pending = await manageEntitySchema(
			{
				schema_type: "entity_type",
				action: "create",
				slug: "reassigned-automation-held-type",
				name: "Reassigned Automation held type",
			},
			{} as Env,
			{
				...inProcessAgentCtx(originalOwner.agentId),
				agentId: null,
				actingAutomationId: automationId,
				actingRunId: 1,
			},
		);
		expect(pending).toMatchObject({ status: "pending_approval" });
		await getDb()`UPDATE automations SET managed_agent_id = ${currentOwner.agentId} WHERE id = ${automationId}`;

		const { response } = await resolveInApp(Number(pending.run_id), "approve");
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(/denies|policy/i);
		expect(await entityTypeExists("reassigned-automation-held-type")).toBe(false);
	});

	it("requires policy approval and applies only after embedded human approval", async () => {
		await setCreatePolicy("approval");
		const pending = await propose(
			"member-proposed-type",
			ownerAdminToken,
			"ChatGPT schema E2E",
		);
		expect(pending).toMatchObject({
			schema_type: "entity_type",
			action: "create",
			status: "pending_approval",
			run_id: expect.any(Number),
			event_id: expect.any(Number),
			approval_url: expect.stringMatching(/^https?:\/\//),
			proposal: {
				version: 1,
				resource_class: "entity_schema",
				policy_action: "create_type",
				schema_type: "entity_type",
				action: "create",
				args: { slug: "member-proposed-type", name: "ChatGPT schema E2E" },
			},
			current: null,
		});
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const [run] = await getDb()<
			[
				{
					approval_status: string;
					status: string;
					action_key: string;
					created_by_user_id: string;
				},
			]
		>`
			SELECT approval_status, status, action_key, created_by_user_id
			FROM runs WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({
			approval_status: "pending",
			status: "pending",
			action_key: "manage_entity_schema",
			created_by_user_id: owner.id,
		});
		const [interaction] = await getDb()<
			[{ id: number; interaction_type: string; interaction_status: string }]
		>`
			SELECT id, interaction_type, interaction_status
			FROM events
			WHERE id = ${pending.event_id} AND run_id = ${pending.run_id}
		`;
		expect(interaction).toEqual({
			id: pending.event_id,
			interaction_type: "approval",
			interaction_status: "pending",
		});

		const reviewView = await mcpRequest<any>(
			"tools/call",
			{
				name: "get_approval",
				arguments: { run_id: pending.run_id },
			},
			{ token: ownerWriteToken, orgSlug: org.slug },
		);
		expect(reviewView.result?.isError).not.toBe(true);
		const reviewBlocks = reviewView.result?.structuredContent?.blocks ?? [];
		expect(reviewBlocks.find((block: { type?: string }) => block.type === "diff")).toEqual({
			type: "diff",
			fields: [
				{ label: "Resource", after: "Entity type" },
				{ label: "Name", after: "ChatGPT schema E2E" },
				{
					label: "Slug",
					after: "member-proposed-type",
					format: "code",
				},
				{ label: "Metadata schema", after: "Any metadata (no schema)" },
				{ label: "Storage", after: "Stored" },
				{ label: "Event kinds", after: "None declared" },
				{ label: "Metrics", after: "None declared" },
				{ label: "Write rules", after: "None" },
			],
		});
		expect(reviewBlocks.some((block: { type?: string }) => block.type === "code")).toBe(false);
		expect(JSON.stringify(reviewBlocks)).not.toMatch(
			/owner_resolved|policy_action|precondition|resource_class/,
		);
		expect(reviewView.result?.structuredContent?.title).toBe(
			"Create entity type: ChatGPT schema E2E",
		);
		expect(reviewView.result?.structuredContent?.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "review", label: "Review in Lobu" }),
			]),
		);

		const unauthorized = await resolveInApp(
			pending.run_id,
			"approve",
			memberToken,
		);
		expect(unauthorized.response.result?.isError).toBe(true);
		expect(unauthorized.response.result?.content?.[0]?.text).toMatch(
			/admin or owner/i,
		);
		expect(await entityTypeExists("member-proposed-type")).toBe(false);

		const { response: resolved, view } = await resolveInApp(
			pending.run_id,
			"approve",
		);
		expect(view.title).toBe("Create entity type: ChatGPT schema E2E");
		expect(view.icon).toBe("entity-schema");
		expect(view.impact).toEqual({ level: "normal" });
		expect(view.tone).toBe("default");
		expect(view.blocks[0]).toEqual({
			type: "diff",
			fields: [
				{ label: "Resource", after: "Entity type" },
				{ label: "Name", after: "ChatGPT schema E2E" },
				{
					label: "Slug",
					after: "member-proposed-type",
					format: "code",
				},
				{ label: "Metadata schema", after: "Any metadata (no schema)" },
				{ label: "Storage", after: "Stored" },
				{ label: "Event kinds", after: "None declared" },
				{ label: "Metrics", after: "None declared" },
				{ label: "Write rules", after: "None" },
			],
		});
		expect(view.blocks.some((block: { type?: string }) => block.type === "code")).toBe(false);
		expect(JSON.stringify(view.blocks)).not.toMatch(
			/owner_resolved|policy_action|precondition|resource_class/,
		);
		expect(view.actions.map((action: { label: string }) => action.label)).toEqual([
			"Approve",
			"Reject",
			"Review in Lobu",
		]);
		expect(resolved.result?.isError).not.toBe(true);
		expect(resolved.result?.structuredContent).toEqual(
			expect.objectContaining({
				actions: [],
				title: expect.stringMatching(/completed/i),
			}),
		);
		expect(await entityTypeExists("member-proposed-type")).toBe(true);

		const [created] = await getDb()<[{ created_by: string }]>`
			SELECT created_by FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'member-proposed-type'
		`;
		expect(created.created_by).toBe(owner.id);
		const [completed] = await getDb()<
			[{ approval_status: string; status: string }]
		>`
			SELECT approval_status, status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(completed).toEqual({
			approval_status: "approved",
			status: "completed",
		});
		const configEvents = await getDb()`
			SELECT id FROM events
			WHERE organization_id = ${org.id}
				AND semantic_type = 'change'
				AND metadata->>'category' = 'config'
				AND metadata->>'resource_kind' = 'entity-type'
				AND metadata->>'resource_id' = 'member-proposed-type'
				AND metadata->>'op' = 'created'
		`;
		expect(configEvents).toHaveLength(1);
	});

	it("renders an explicit metadata schema exactly with code typography", async () => {
		await setCreatePolicy("approval");
		const metadataSchema = {
			type: "object",
			properties: {
				status: { type: "string", enum: ["active", "archived"] },
			},
			required: ["status"],
		};
		const pending = await propose(
			"typed-proposed-type",
			ownerAdminToken,
			"Typed proposed type",
			{ metadata_schema: metadataSchema },
		);
		const { response, view } = await resolveInApp(pending.run_id, "reject");
		const schemaField = view.blocks[0].fields.find(
			(field: { label: string }) => field.label === "Metadata schema",
		);
		expect(schemaField).toMatchObject({
			label: "Metadata schema",
			format: "code",
		});
		expect(JSON.parse(schemaField.after)).toEqual(metadataSchema);
		expect(response.result?.isError).not.toBe(true);
		expect(await entityTypeExists("typed-proposed-type")).toBe(false);
	});

	it("rejects a policy-held mutation without applying and refuses replay", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("admin-token-proposed-type", ownerAdminToken);
		expect(pending.status).toBe("pending_approval");
		expect(await entityTypeExists("admin-token-proposed-type")).toBe(false);

		const { response: rejected, capability } = await resolveInApp(
			pending.run_id,
			"reject",
			ownerAdminToken,
		);
		expect(rejected.result?.isError).not.toBe(true);
		expect(rejected.result?.structuredContent?.title).toMatch(/rejected/i);
		expect(await entityTypeExists("admin-token-proposed-type")).toBe(false);

		const replay = await mcpRequest<any>(
			"tools/call",
			{
				name: "resolve_approval",
				arguments: {
					run_id: pending.run_id,
					decision: "reject",
					_meta: { "lobu/approval-capability": capability },
				},
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(replay.result?.isError).toBe(true);
		expect(replay.result?.content?.[0]?.text).toMatch(/stale|pending/i);
	});

	it("keeps already-pending legacy MCP schema approvals resolvable", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("legacy-pending-type");
		const sql = getDb();
		await sql`
			UPDATE runs
			SET action_input = ${sql.json({
				schema_type: "entity_type",
				action: "create",
				args: {
					schema_type: "entity_type",
					action: "create",
					slug: "legacy-pending-type",
					name: "legacy-pending-type",
				},
			})}
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;

		const { response } = await resolveInApp(pending.run_id, "approve");
		expect(response.result?.isError).not.toBe(true);
		expect(await entityTypeExists("legacy-pending-type")).toBe(true);
	});

	it("rolls schema apply and run completion back when the terminal card fails", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("terminal-card-rollback-type");
		const sql = getDb();
		await sql.unsafe(`
			DROP TRIGGER IF EXISTS test_fail_schema_terminal_card_trg ON events;
			CREATE OR REPLACE FUNCTION test_fail_schema_terminal_card() RETURNS trigger AS $fn$
			BEGIN
				IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
					RAISE EXCEPTION 'simulated schema terminal card failure';
				END IF;
				RETURN NEW;
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_schema_terminal_card_trg
				BEFORE INSERT ON events
				FOR EACH ROW EXECUTE FUNCTION test_fail_schema_terminal_card();
		`);
		try {
			const { response } = await resolveInApp(pending.run_id, "approve");
			expect(response.result?.isError).toBe(true);
			expect(response.result?.content?.[0]?.text).toMatch(
				/terminal card failure/i,
			);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_schema_terminal_card_trg ON events;
				DROP FUNCTION IF EXISTS test_fail_schema_terminal_card();
			`);
		}
		expect(await entityTypeExists("terminal-card-rollback-type")).toBe(false);
		const [run] = await sql<
			[{ status: string; approval_status: string }]
		>`SELECT status, approval_status FROM runs WHERE id = ${pending.run_id}`;
		expect(run).toEqual({ status: "pending", approval_status: "pending" });
	});

	it("rolls an immediate schema mutation back when its audit row fails", async () => {
		const sql = getDb();
		await sql.unsafe(`
			DROP TRIGGER IF EXISTS test_fail_entity_type_audit_trg ON entity_type_audit;
			CREATE OR REPLACE FUNCTION test_fail_entity_type_audit() RETURNS trigger AS $fn$
			BEGIN
				RAISE EXCEPTION 'simulated entity type audit failure';
			END;
			$fn$ LANGUAGE plpgsql;
			CREATE TRIGGER test_fail_entity_type_audit_trg
				BEFORE INSERT ON entity_type_audit
				FOR EACH ROW EXECUTE FUNCTION test_fail_entity_type_audit();
		`);
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		try {
			await expect(
				direct.entity_schema.createType({
					slug: "audit-rollback-type",
					name: "Audit rollback type",
				}),
			).rejects.toThrow(/audit failure/i);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS test_fail_entity_type_audit_trg ON entity_type_audit;
				DROP FUNCTION IF EXISTS test_fail_entity_type_audit();
			`);
		}
		expect(await entityTypeExists("audit-rollback-type")).toBe(false);
	});

	it("keeps dry_run preview-only with no durable approval", async () => {
		const [{ count: before }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'
		`;
		const result = await mcpToolsCall<Record<string, unknown>>(
			"run_sdk",
			{
				dry_run: true,
				script:
					"export default async (_ctx, client) => client.entitySchema.createType({ slug: 'dry-run-type', name: 'Dry run type' });",
			},
			{ token: memberToken, orgSlug: org.slug },
		);
		expect(result.side_effect_preview).toEqual(expect.any(Array));
		expect(await entityTypeExists("dry-run-type")).toBe(false);
		const [{ count: after }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'
		`;
		expect(after).toBe(before);
	});

	it("fails a stale duplicate approval without creating another row", async () => {
		await setCreatePolicy("approval");
		const pending = await propose("stale-duplicate-type");
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "stale-duplicate-type",
			name: "Human won the race",
		});

		const { response: resolved } = await resolveInApp(
			pending.run_id,
			"approve",
		);
		expect(resolved.result?.isError).toBe(true);
		expect(resolved.result?.content?.[0]?.text).toMatch(/stale/i);
		const [{ count }] = await getDb()<[{ count: number }]>`
			SELECT count(*)::int AS count FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'stale-duplicate-type'
		`;
		expect(count).toBe(1);
		const [run] = await getDb()<[{ status: string; approval_status: string }]>`
			SELECT status, approval_status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${org.id}
		`;
		expect(run).toEqual({ status: "pending", approval_status: "pending" });
	});

	it("does not let an old update approval overwrite a newer schema edit", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "stale-update-type",
			name: "Original",
		});
		// Pin both versions inside one JavaScript millisecond. PostgreSQL keeps
		// microseconds; stale protection must not round them away through Date.
		await getDb()`
			UPDATE entity_types
			SET updated_at = date_trunc('second', current_timestamp)
				+ interval '123456 microseconds'
			WHERE organization_id = ${org.id}
				AND slug = 'stale-update-type'
		`;
		await setUpdatePolicy("approval");
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => { const { entity_type } = await client.entitySchema.getType('stale-update-type'); return client.entitySchema.updateType({ slug: 'stale-update-type', name: 'Approved old name', expected_revision: entity_type.revision }); };",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.success).toBe(true);
		expect(proposed.return_value.status).toBe("pending_approval");
		const [interaction] = await getDb()<
			[
				{
					interaction_input: Record<string, unknown>;
					current: Record<string, unknown>;
				},
			]
		>`
			SELECT interaction_input, metadata->'current' AS current
			FROM events
			WHERE run_id = ${proposed.return_value.run_id}
				AND interaction_type = 'approval'
				AND interaction_status = 'pending'
		`;
		expect(interaction.interaction_input.expected_revision).toMatch(/^cr1_/);
		expect(interaction.interaction_input).toMatchObject({
			name: "Approved old name",
			slug: "stale-update-type",
		});
		expect(interaction.current).toMatchObject({
			name: "Original",
			slug: "stale-update-type",
		});

		const reviewView = await mcpRequest<any>(
			"tools/call",
			{
				name: "get_approval",
				arguments: { run_id: proposed.return_value.run_id },
			},
			{ token: ownerWriteToken, orgSlug: org.slug },
		);
		const reviewFields = reviewView.result?.structuredContent?.blocks?.find(
			(block: { type?: string }) => block.type === "diff",
		)?.fields;
		expect(reviewFields).toEqual([
			{ label: "Resource", after: "Entity type" },
			{ label: "Name", before: "Original", after: "Approved old name" },
			{
				label: "Slug",
				before: "stale-update-type",
				after: "stale-update-type",
				format: "code",
			},
		]);

		await getDb()`
			UPDATE entity_types
			SET name = 'Newer human name',
				updated_at = updated_at + interval '1 microsecond'
			WHERE organization_id = ${org.id}
				AND slug = 'stale-update-type'
		`;

		const { response, view } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(view.blocks[0]).toEqual({
			type: "diff",
			fields: [
				{ label: "Resource", after: "Entity type" },
				{
					label: "Name",
					before: "Original",
					after: "Approved old name",
				},
				{
					label: "Slug",
					before: "stale-update-type",
					after: "stale-update-type",
					format: "code",
				},
			],
		});
		expect(response.result?.isError).toBe(true);
		expect(response.result?.structuredContent?.error).toMatchObject({ code: "REVISION_CONFLICT", retryable: false });
		expect(response.result?.content?.[0]?.text).toMatch(/stale/i);

		// The failed schema approval remains pending. The human REST approval
		// route must expose the same conflict without losing its in-process code.
		const session = await createTestSession(owner.id);
		const restResponse = await post(`/api/${org.slug}/manage_operations`, {
			cookie: session.cookieHeader,
			body: { action: "approve", run_id: proposed.return_value.run_id },
		});
		expect(restResponse.status).toBe(409);
		expect(await restResponse.json()).toMatchObject({
			error: expect.stringMatching(/stale/i),
			code: "REVISION_CONFLICT",
			retryable: false,
		});
		const [row] = await getDb()<[{ name: string }]>`
			SELECT name FROM entity_types
			WHERE organization_id = ${org.id} AND slug = 'stale-update-type' AND deleted_at IS NULL
		`;
		expect(row.name).toBe("Newer human name");
	});

	it("returns a typed denial without creating a run or schema row", async () => {
		await setCreatePolicy("deny");
		const [{ count: before }] = await getDb()<
			[{ count: number }]
		>`SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'`;
		const denied = await propose("policy-denied-type");
		expect(denied).toMatchObject({
			schema_type: "entity_type",
			action: "create",
			status: "denied",
		});
		expect(await entityTypeExists("policy-denied-type")).toBe(false);
		const [{ count: after }] = await getDb()<
			[{ count: number }]
		>`SELECT count(*)::int AS count FROM runs
			WHERE organization_id = ${org.id} AND action_key = 'manage_entity_schema'`;
		expect(after).toBe(before);
	});

	it("governs relationship type creation through the same approval run", async () => {
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.createRelType({ slug: 'governed-rel', name: 'Governed relation' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.success).toBe(true);
		expect(proposed.return_value.status).toBe("pending_approval");
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'governed-rel' AND deleted_at IS NULL`,
		).toHaveLength(0);
		const { response, view } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(view.blocks[0]).toEqual({
			type: "diff",
			fields: [
				{ label: "Resource", after: "Relationship type" },
				{ label: "Name", after: "Governed relation" },
				{ label: "Slug", after: "governed-rel", format: "code" },
				{
					label: "Metadata schema",
					after: "Any relationship metadata (no schema)",
				},
				{ label: "Direction", after: "Directional" },
				{ label: "Inverse type", after: "None" },
				{ label: "Status", after: "Active" },
			],
		});
		expect(response.result?.isError).not.toBe(true);
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'governed-rel' AND deleted_at IS NULL`,
		).toHaveLength(1);
	});

	it("does not let a held relationship create overwrite a changed inverse", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createRelType({
			slug: "inverse-before",
			name: "Inverse before",
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.createRelType({ slug: 'held-with-inverse', name: 'Held with inverse', inverse_type_slug: 'inverse-before' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.return_value.status).toBe("pending_approval");
		await freshSchemaEditor(direct.entity_schema).updateRelType({
			slug: "inverse-before",
			name: "Inverse changed",
		});

		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(
			/inverse relationship type changed|stale/i,
		);
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id} AND slug = 'held-with-inverse' AND deleted_at IS NULL`,
		).toHaveLength(0);
	});

	it("treats a changed public inverse as a stale relationship create", async () => {
		const publicOrg = await createTestOrganization({
			name: "Public inverse approval catalog",
			visibility: "public",
		});
		await getDb()`
			INSERT INTO entity_relationship_types (
				organization_id, slug, name, status, created_at, updated_at
			) VALUES (
				${publicOrg.id}, 'public-inverse-before', 'Public inverse before',
				'active', current_timestamp, current_timestamp
			)
		`;
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { create_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => client.entitySchema.createRelType({ slug: 'held-with-public-inverse', name: 'Held with public inverse', inverse_type_slug: 'public-inverse-before' });",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.return_value.status).toBe("pending_approval");
		await getDb()`
			UPDATE entity_relationship_types
			SET name = 'Public inverse changed', updated_at = current_timestamp
			WHERE organization_id = ${publicOrg.id}
				AND slug = 'public-inverse-before'
		`;

		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(
			/inverse relationship type changed|stale/i,
		);
		expect(
			await getDb()`SELECT id FROM entity_relationship_types
			WHERE organization_id = ${org.id}
				AND slug = 'held-with-public-inverse'
				AND deleted_at IS NULL`,
		).toHaveLength(0);
	});

	it("does not apply a held relationship update after its chosen inverse changes", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createRelType({
			slug: "held-update-rel",
			name: "Held update relation",
		});
		await direct.entity_schema.createRelType({
			slug: "update-inverse-before",
			name: "Update inverse before",
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { update_relationship_type: "approval" },
		});
		const proposed = await mcpToolsCall<{
			success: boolean;
			return_value: PendingCreate;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => { const { relationship_type } = await client.entitySchema.getRelType('held-update-rel'); return client.entitySchema.updateRelType({ slug: 'held-update-rel', inverse_type_slug: 'update-inverse-before', expected_revision: relationship_type.revision }); };",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(proposed.return_value.status).toBe("pending_approval");
		await freshSchemaEditor(direct.entity_schema).updateRelType({
			slug: "update-inverse-before",
			name: "Update inverse changed",
		});

		const { response } = await resolveInApp(
			proposed.return_value.run_id,
			"approve",
		);
		expect(response.result?.isError).toBe(true);
		expect(response.result?.content?.[0]?.text).toMatch(
			/inverse relationship type changed|stale/i,
		);
		const [target] = await getDb()<[{ inverse_type_id: number | null }]>`
			SELECT inverse_type_id FROM entity_relationship_types
			WHERE organization_id = ${org.id}
				AND slug = 'held-update-rel'
				AND deleted_at IS NULL
		`;
		expect(target.inverse_type_id).toBeNull();
	});

	it("governs relationship rules as relationship-type updates", async () => {
		const direct = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		});
		await direct.entity_schema.createType({
			slug: "rule-source",
			name: "Rule source",
		});
		await direct.entity_schema.createType({
			slug: "rule-target",
			name: "Rule target",
		});
		await direct.entity_schema.createRelType({
			slug: "ruled-rel",
			name: "Ruled relation",
		});
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "entity_schema",
			principalKind: "agent",
			effects: { update_relationship_type: "deny" },
		});
		const denied = await mcpToolsCall<{
			success: boolean;
			return_value: Record<string, unknown>;
		}>(
			"run_sdk",
			{
				script:
					"export default async (_ctx, client) => { const { relationship_type } = await client.entitySchema.getRelType('ruled-rel'); return client.entitySchema.addRule({ slug: 'ruled-rel', source_entity_type_slug: 'rule-source', target_entity_type_slug: 'rule-target', expected_revision: relationship_type.revision }); };",
			},
			{ token: ownerAdminToken, orgSlug: org.slug },
		);
		expect(denied.success).toBe(true);
		expect(denied.return_value.status).toBe("denied");
		expect(
			await getDb()`SELECT r.id FROM entity_relationship_type_rules r
			JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
			WHERE rt.organization_id = ${org.id} AND rt.slug = 'ruled-rel' AND r.deleted_at IS NULL`,
		).toHaveLength(0);
	});
});
