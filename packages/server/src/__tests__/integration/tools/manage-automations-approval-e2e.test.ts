/**
 * manage_automations — builder-gate approval queue (agent_config write class).
 *
 * WRITE definition actions (create/update/delete/create_version/…) route through
 * the same `agent_config` write-gate class as manage_agents:
 *   - A HUMAN member applies immediately — no run, no approval card.
 *   - An AGENT-driven write follows the org policy (default: create/update queue
 *     a pending `runs` row + approval event; delete is denied). Approving via
 *     manage_operations applies the held mutation and supersedes the pending card.
 *
 * Covers:
 *   - agent create → pending_approval (NOT 403), no automation row yet
 *   - approve → automation exists, run completed, event superseded 'completed'
 *   - reject → no automation, run cancelled, event superseded 'rejected'
 *   - human create still applies immediately
 *   - foreign-owner escalation still 403s before queueing
 */

import { beforeAll, describe, expect, it } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
	addUserToOrganization,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

type PendingApproval = {
	status: "pending_approval";
	run_id: number;
	event_id?: number;
	action: string;
	proposal?: { args?: { action?: string; slug?: string } };
	current?: Record<string, unknown> | null;
};

async function automationExists(orgId: string, slug: string): Promise<boolean> {
	const sql = getTestDb();
	const rows = await sql`
		SELECT 1 FROM automations WHERE organization_id = ${orgId} AND slug = ${slug}
	`;
	return rows.length > 0;
}

describe("manage_automations — builder gate e2e", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentCtx: AuthContext;
	let agentId: string;
	let otherAgentId: string;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
		memberRole: "owner" | "member",
		scopes: string[],
		boundAgentId: string | null = null
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole,
		agentId: boundAgentId,
		requestedAgentId: boundAgentId,
		isAuthenticated: true,
		clientId: null,
		scopes,
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({
			name: "manage_automations gate e2e",
		});
		orgId = org.id;
		const owner = await createTestUser({ email: "mw-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");

		ownerCtx = baseCtx(org.id, owner.id, "owner", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);

		const builder = await createTestAgent({
			organizationId: org.id,
			agentId: "builder-agent",
			ownerUserId: owner.id,
		});
		agentId = builder.agentId;
		const other = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
		});
		otherAgentId = other.agentId;
		const sql = getTestDb();
		await sql`
			UPDATE agents
			SET skills_config = ${sql.json({
				skills: [
					{
						repo: "file/approval-runbook",
						name: "approval-runbook",
						enabled: true,
						content: "Run the approved workflow.",
					},
				],
			})}
			WHERE id = ${agentId} AND organization_id = ${orgId}
		`;

		// Same owner identity, but acting as an agent — principal the
		// agent_config write-gate holds for approval.
		agentCtx = baseCtx(
			org.id,
			owner.id,
			"owner",
			["mcp:read", "mcp:write", "mcp:admin"],
			agentId
		);
		agentCtx.mcpSessionId = "session-manage-automations";
	});

	it.each([
		{ label: "web session", slug: "human-automation", context: {} },
		{
			label: "delegated OAuth",
			slug: "delegated-automation",
			context: { clientId: "test-oauth-client", tokenType: "oauth" as const },
		},
	])("owner authority through $label creates an Automation with no approval run", async ({ slug, context }) => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug,
				name: "Human Automation",
				prompt: "Track things.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			{ ...ownerCtx, ...context }
		)) as { action: string; automation_id?: string; status?: string };
		// Immediate apply returns the automation status ('active'), not pending_approval.
		expect(res.status).not.toBe("pending_approval");
		expect(res.automation_id).toBeDefined();
		expect(await automationExists(orgId, slug)).toBe(true);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_automations'
				AND approval_status = 'pending'
		`;
		expect(runRows.length).toBe(0);
	});

	it("agent create produces a pending run + approval event and does NOT create the automation yet", async () => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "agent-proposed-automation",
				name: "Agent Proposed",
				prompt: "Track launches.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;

		expect(res.status).toBe("pending_approval");
		expect(typeof res.run_id).toBe("number");
		expect(res.action).toBe("create");
		expect(res.proposal?.args?.slug).toBe("agent-proposed-automation");

		const sql = getTestDb();
		const runRows = await sql`
			SELECT run_type, action_key, approval_status, status, action_input,
			       created_by_user_id, initiator_kind, initiator_ref
			FROM runs WHERE id = ${res.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows.length).toBe(1);
		expect(runRows[0]?.run_type).toBe("internal");
		expect(runRows[0]?.action_key).toBe("manage_automations");
		expect(runRows[0]?.approval_status).toBe("pending");
		expect(runRows[0]?.status).toBe("pending");
		expect(runRows[0]?.created_by_user_id).toBe(ownerId);
		expect(runRows[0]?.initiator_kind).toBe("agent_session");
		expect(runRows[0]?.initiator_ref).toMatchObject({
			agent_id: agentId,
			user_id: ownerId,
		});

		const eventRows = await sql`
			SELECT interaction_type, interaction_status, metadata
			FROM current_event_records
			WHERE run_id = ${res.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows.length).toBe(1);
		expect(eventRows[0]?.interaction_status).toBe("pending");
		expect(eventRows[0]?.metadata).toMatchObject({
			mcp_session_id: "session-manage-automations",
			approval_context: {
				kind: "automation",
				impact: { level: "normal" },
			},
		});
		expect(
			(eventRows[0]?.metadata as { initiator?: Record<string, unknown> })
				?.initiator
		).toMatchObject({
			kind: "agent_session",
			agent_id: agentId,
			user_id: ownerId,
		});

		expect(await automationExists(orgId, "agent-proposed-automation")).toBe(false);
	});

	it("agent can propose a skills-only Automation without failing approval preflight", async () => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "agent-proposed-skills-only",
				name: "Agent Proposed Skills Only",
				managed_agent_id: agentId,
				skills: [
					{
						name: "approval-runbook",
						content: "Run the approved workflow.",
					},
				],
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;

		expect(res.status).toBe("pending_approval");
		expect(res.proposal?.args?.slug).toBe("agent-proposed-skills-only");
		expect(await automationExists(orgId, "agent-proposed-skills-only")).toBe(false);
	});

	it("includes the existing delivery target in an update approval snapshot", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "delivery-target-approval",
				name: "Delivery Target Approval",
				prompt: "Track routed notifications.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const automationId = created.automation_id!;
		const sql = getTestDb();
		await sql`
			UPDATE automations
			SET delivery_target = ${sql.json({
				connection_id: 541,
				channel_id: "slack:C_TASKS",
			})}
			WHERE organization_id = ${orgId} AND id = ${Number(automationId)}
		`;

		const pending = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: automationId,
				tags: ["routed"],
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;

		expect(pending.status).toBe("pending_approval");
		expect(pending.current?.delivery_target).toEqual({
			connection_id: 541,
			channel_id: "slack:C_TASKS",
		});
	});

	it("approve applies the held create: automation exists, run completed, event superseded", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "approved-automation",
				name: "Approved Automation",
				prompt: "Track approved items.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");
		expect(await automationExists(orgId, "approved-automation")).toBe(false);

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx
		)) as { approved?: true };
		expect(approveRes.approved).toBe(true);

		expect(await automationExists(orgId, "approved-automation")).toBe(true);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status FROM runs
			WHERE id = ${created.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("approved");
		expect(runRows[0]?.status).toBe("completed");

		// Current event for the run is now 'completed' (the pending card was superseded).
		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${created.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("completed");
	});

	it("approve from a write-scoped human session (no mcp:admin) still applies the held mutation", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "write-scope-approved",
				name: "Write Scope Approved",
				prompt: "Track write-scope approvals.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");

		// resolve_approval intentionally requires only mcp:write. After validating
		// its app capability, it calls manage_operations with a human context that
		// preserves those scopes. The owner's role authorizes the decision; applying
		// it must not re-enter the fresh-call mcp:admin gate.
		const writeScopedOwnerCtx = baseCtx(orgId, ownerId, "owner", [
			"mcp:read",
			"mcp:write",
		]);
		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			writeScopedOwnerCtx
		)) as { approved?: true; error?: string };
		expect(approveRes.error).toBeUndefined();
		expect(approveRes.approved).toBe(true);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status, error_message FROM runs
			WHERE id = ${created.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("approved");
		expect(runRows[0]?.error_message).toBeNull();
		expect(runRows[0]?.status).toBe("completed");

		expect(await automationExists(orgId, "write-scope-approved")).toBe(true);
	});

	it("reject cancels the held create: no automation, run cancelled, event superseded 'rejected'", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "rejected-automation",
				name: "Rejected Automation",
				prompt: "Track rejected items.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");

		const rejectRes = (await executeTool(
			"manage_operations",
			{ action: "reject", run_id: created.run_id, reason: "not now" },
			TEST_ENV,
			ownerCtx
		)) as { rejected?: true };
		expect(rejectRes.rejected).toBe(true);

		expect(await automationExists(orgId, "rejected-automation")).toBe(false);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status FROM runs
			WHERE id = ${created.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("rejected");
		expect(runRows[0]?.status).toBe("cancelled");

		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${created.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("rejected");
	});

	it("foreign-owner create still 403s and does not queue a pending run", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "foreign-owned",
					name: "Foreign Owned",
					prompt: "Should not queue.",
					managed_agent_id: otherAgentId,
				},
				TEST_ENV,
				agentCtx
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_automations'
				AND approval_status = 'pending'
				AND action_input::text LIKE '%foreign-owned%'
		`;
		expect(runRows.length).toBe(0);
	});

	it("approve of update with invalid timezone marks run failed (not completed)", async () => {
		// Seed an automation via the human path so there is a target to update.
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "tz-fail-automation",
				name: "TZ Fail Automation",
				prompt: "Track timezone failures.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string; status?: string };
		expect(created.automation_id).toBeDefined();
		const automationId = created.automation_id!;

		// Agent proposes an update with a bad timezone — queues for approval.
		// handleUpdate returns `{ error }` (does not throw); the apply boundary
		// must treat that as failure so we never mark the run completed.
		const pending = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: automationId,
				triggers: [
					{
						kind: "schedule",
						cron: "0 9 * * *",
						timezone: "Not/A_Real_Zone",
					},
				],
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;
		expect(pending.status).toBe("pending_approval");
		expect(typeof pending.run_id).toBe("number");

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: pending.run_id },
			TEST_ENV,
			ownerCtx
		)) as { approved?: true; message?: string };
		expect(approveRes.approved).toBe(true);
		expect(approveRes.message).toMatch(/failed/i);
		expect(approveRes.message).not.toMatch(/applied/i);

		const sql = getTestDb();
		const runRows = await sql`
			SELECT approval_status, status, error_message FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.approval_status).toBe("approved");
		expect(runRows[0]?.status).toBe("failed");
		expect(String(runRows[0]?.error_message ?? "")).toMatch(/timezone|IANA/i);

		const eventRows = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${pending.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows[0]?.interaction_status).toBe("failed");
	});

	it("rejects a no-op update (only automation_id, no patch fields)", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "noop-update-target",
				name: "Noop target",
				prompt: "Target.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const automationId = created.automation_id!;
		await expect(
			executeTool(
				"manage_automations",
				{ action: "update", automation_id: automationId },
				TEST_ENV,
				agentCtx
			)
		).rejects.toThrow(/runtime config only|at least one such field/i);
	});

	it("rejects set_reaction_script with no reaction_script (would silently clear)", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "reaction-target",
				name: "Reaction target",
				prompt: "Target.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const automationId = created.automation_id!;
		await expect(
			executeTool(
				"manage_automations",
				{ action: "set_reaction_script", automation_id: automationId },
				TEST_ENV,
				agentCtx
			)
		).rejects.toThrow(/reaction_script is required/i);
	});

	it("stale cross-owner approval is rejected on apply after the automation is reassigned", async () => {
		// Agent A creates an automation it owns (queue + approve so A is the owner).
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "a-owned-then-reassigned",
				name: "A owned",
				prompt: "Owned by agent A at queue time.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const automationId = created.automation_id!;
		expect(automationId).toBeDefined();

		// Agent A queues an update. The proposal captures A as the acting agent.
		const pending = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: automationId,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			agentCtx
		)) as PendingApproval;
		expect(pending.status).toBe("pending_approval");

		// Race: the automation is reassigned to agent B while the approval is pending.
		const sql = getTestDb();
		await sql`
			UPDATE automations SET managed_agent_id = ${otherAgentId}
			WHERE id = ${automationId} AND organization_id = ${orgId}
		`;

		// Approving must NOT apply A's held mutation to B-owned automation: the
		// apply path re-checks ownership against the persisted acting agent under
		// the group lock and fails closed.
		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: pending.run_id },
			TEST_ENV,
			ownerCtx
		)) as { approved?: true; message?: string };
		expect(approveRes.message).toMatch(/failed/i);
		expect(approveRes.message).not.toMatch(/applied/i);

		// The held edit was NOT applied.
		const automationRows = await sql`
			SELECT schedule FROM automations
			WHERE id = ${automationId} AND organization_id = ${orgId}
		`;
		expect(automationRows[0]?.schedule).not.toBe("0 9 * * *");

		// Run marked failed; card superseded to failed.
		const runRows = await sql`
			SELECT status FROM runs
			WHERE id = ${pending.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows[0]?.status).toBe("failed");
	});
	it.each(["update", "create_version", "set_reaction_script", "delete"] as const)(
		"rejects stale %s approval after a same-owner configuration edit",
		async (action) => {
			if (action === "delete") await upsertEntityApprovalPolicy(orgId, {
				resourceClass: "agent_config", principalKind: "agent", principalId: agentId,
				effects: { delete: "approval" },
			});
			const created = await executeTool("manage_automations", {
				action: "create", slug: `stale-${action}`, name: "Before",
				prompt: "Original prompt", managed_agent_id: agentId,
			}, TEST_ENV, ownerCtx) as { automation_id: string };
			const automationId = created.automation_id;
			const pending = await executeTool("manage_automations", {
				action,
				...(action === "delete" ? { automation_ids: [automationId] } : { automation_id: automationId }),
				...(action === "update" ? { tags: ["proposed"] } : {}),
				...(action === "create_version" ? { prompt: "Proposed prompt", set_as_current: true } : {}),
				...(action === "set_reaction_script" ? { reaction_script: "export default async () => {};" } : {}),
			}, TEST_ENV, agentCtx) as PendingApproval;
			expect(pending.status).toBe("pending_approval");
			await executeTool("manage_automations", {
				action: "update", automation_id: automationId, tags: ["newer"],
			}, TEST_ENV, ownerCtx);
			await executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
			const sql = getTestDb();
			const [run] = await sql`SELECT status FROM runs WHERE id = ${pending.run_id}`;
			expect(run.status).toBe("failed");
			const [row] = await sql`SELECT status, reaction_script, to_jsonb(tags) AS tags,
				(SELECT prompt FROM automation_versions WHERE id = a.current_version_id) AS prompt
				FROM automations a WHERE id = ${automationId} AND organization_id = ${orgId}`;
			expect(row.status).not.toBe("archived");
			expect(row.tags).toEqual(["newer"]);
			expect(row.prompt).toBe("Original prompt");
			expect(row.reaction_script).toBeNull();
		},
	);

	it("applies an approved delete whose target configuration is unchanged", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "agent_config", principalKind: "agent", principalId: agentId,
			effects: { delete: "approval" },
		});
		const created = await executeTool("manage_automations", {
			action: "create", slug: "approved-delete", prompt: "Original", managed_agent_id: agentId,
		}, TEST_ENV, ownerCtx) as { automation_id: string };
		const pending = await executeTool("manage_automations", {
			action: "delete", automation_ids: [created.automation_id],
		}, TEST_ENV, agentCtx) as PendingApproval;
		expect(pending.status).toBe("pending_approval");
		await executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
		const sql = getTestDb();
		const [run] = await sql`SELECT status FROM runs WHERE id = ${pending.run_id}`;
		expect(run.status).toBe("completed");
		const [row] = await sql`SELECT status FROM automations WHERE id = ${created.automation_id}`;
		expect(row.status).toBe("archived");
	});

	it.each(["unrelated target IDs", "non-current version", "legacy proposal"])(
		"rejects an approval with %s instead of overwriting unseen configuration",
		async (scenario) => {
			const created = await executeTool("manage_automations", {
				action: "create", slug: `approval-base-${scenario.replaceAll(" ", "-")}`,
				prompt: "Original", managed_agent_id: agentId,
			}, TEST_ENV, ownerCtx) as { automation_id: string };
			const other = await executeTool("manage_automations", {
				action: "create", slug: `approval-other-${scenario.replaceAll(" ", "-")}`,
				prompt: "Other", managed_agent_id: agentId,
			}, TEST_ENV, ownerCtx) as { automation_id: string };
			const pending = await executeTool("manage_automations", {
				action: scenario === "non-current version" ? "create_version" : "update",
				automation_id: created.automation_id,
				...(scenario === "unrelated target IDs" ? { automation_ids: [other.automation_id] } : {}),
				...(scenario === "non-current version" ? { name: "Proposed" } : { tags: ["proposed"] }),
			}, TEST_ENV, agentCtx) as PendingApproval;
			expect(pending.status).toBe("pending_approval");
			const sql = getTestDb();
			if (scenario === "legacy proposal") {
				await sql`UPDATE runs SET action_input = action_input - 'base' WHERE id = ${pending.run_id}`;
			} else if (scenario === "non-current version") {
				await executeTool("manage_automations", {
					action: "create_version", automation_id: created.automation_id,
					prompt: "Unseen draft", set_as_current: false,
				}, TEST_ENV, ownerCtx);
			} else {
				await executeTool("manage_automations", {
					action: "update", automation_id: created.automation_id, tags: ["newer"],
				}, TEST_ENV, ownerCtx);
			}
			await executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
			const [run] = await sql`SELECT status FROM runs WHERE id = ${pending.run_id}`;
			expect(run.status).toBe("failed");
			const [row] = await sql`SELECT to_jsonb(tags) AS tags,
				(SELECT prompt FROM automation_versions WHERE id = a.current_version_id) AS prompt
				FROM automations a WHERE id = ${created.automation_id}`;
			expect(row.tags).not.toContain("proposed");
			expect(row.prompt).toBe("Original");
		},
	);

	it.each([
		{ action: "update", label: "runtime update", patch: { tags: ["proposed"] } },
		{ action: "create_version", label: "version", patch: { prompt: "Proposed" } },
		{ action: "create_version", label: "version sibling", patch: { prompt: "Proposed" } },
		{ action: "set_reaction_script", label: "reaction", patch: { reaction_script: "export default async () => {};" } },
		{ action: "set_reaction_script", label: "reaction clear", patch: { reaction_script: "" } },
	])("rechecks $label after waiting for a concurrent archive's row lock", async ({ action, label, patch }) => {
		const created = await executeTool("manage_automations", {
			action: "create", slug: `row-lock-${label.replaceAll(" ", "-")}`,
			prompt: "Original", managed_agent_id: agentId,
		}, TEST_ENV, ownerCtx) as { automation_id: string };
		const sql = getTestDb();
		let lockedId = created.automation_id;
		const originalReaction = label === "reaction clear" ? "export default async () => {};" : null;
		if (originalReaction) await executeTool("manage_automations", {
			action: "set_reaction_script", automation_id: created.automation_id, reaction_script: originalReaction,
		}, TEST_ENV, ownerCtx);
		if (label === "version sibling") {
			const sibling = await executeTool("manage_automations", {
				action: "create", slug: "row-lock-sibling", prompt: "Original", managed_agent_id: agentId,
			}, TEST_ENV, ownerCtx) as { automation_id: string };
			lockedId = sibling.automation_id;
			await sql`UPDATE automations SET automation_group_id = ${created.automation_id},
				current_version_id = (SELECT current_version_id FROM automations WHERE id = ${created.automation_id})
				WHERE id = ${lockedId}`;
		}
		const pending = await executeTool("manage_automations", {
			action, automation_id: created.automation_id, ...patch,
		}, TEST_ENV, agentCtx) as PendingApproval;
		expect(pending.status).toBe("pending_approval");
		let approval: Promise<unknown> | undefined;
		try {
			await sql.begin(async (tx) => {
				await tx`SELECT id FROM automations WHERE id = ${lockedId} FOR UPDATE`;
				const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
				approval = executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
				let blocked = false;
				for (let i = 0; i < 250; i++) {
					const waiters = await sql`SELECT 1 FROM pg_stat_activity
						WHERE ${Number(holder.pid)}::integer = ANY(pg_blocking_pids(pid))
						AND query ILIKE '%automations%' LIMIT 1`;
					if (waiters.length) { blocked = true; break; }
					await new Promise(resolve => setTimeout(resolve, 20));
				}
				expect(blocked).toBe(true);
				// Commit the competing archive only AFTER approval reached its mutation lock.
				await tx`UPDATE automations SET status = 'archived' WHERE id = ${lockedId}`;
			});
		} finally {
			await approval;
		}
		const [run] = await sql`SELECT status FROM runs WHERE id = ${pending.run_id}`;
		expect(run.status).toBe("failed");
		const [row] = await sql`SELECT status, reaction_script, to_jsonb(tags) AS tags,
			(SELECT prompt FROM automation_versions WHERE id = a.current_version_id) AS prompt
			FROM automations a WHERE id = ${created.automation_id}`;
		expect(row.status).toBe(label === "version sibling" ? "active" : "archived");
		expect(row.tags).not.toContain("proposed");
		expect(row.prompt).toBe("Original");
		expect(row.reaction_script).toBe(originalReaction);
	});

	it("execution bookkeeping does not invalidate a pending configuration edit", async () => {
		const created = await executeTool("manage_automations", {
			action: "create", slug: "approval-runtime-bookkeeping", prompt: "Original",
			managed_agent_id: agentId,
		}, TEST_ENV, ownerCtx) as { automation_id: string };
		const pending = await executeTool("manage_automations", {
			action: "update", automation_id: created.automation_id, tags: ["approved"],
		}, TEST_ENV, agentCtx) as PendingApproval;
		const sql = getTestDb();
		await sql`UPDATE automations SET next_run_at = NOW(), consecutive_scheduled_failures = 1,
			updated_at = NOW() WHERE id = ${created.automation_id} AND organization_id = ${orgId}`;
		await executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
		const [run] = await sql`SELECT status FROM runs WHERE id = ${pending.run_id}`;
		expect(run.status).toBe("completed");
		const [row] = await sql`SELECT to_jsonb(tags) AS tags FROM automations WHERE id = ${created.automation_id}`;
		expect(row.tags).toEqual(["approved"]);
	});

});
