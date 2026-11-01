/**
 * manage_agents — end-to-end coverage over the real tool path
 * (`executeTool(name, args, env, authCtx)`), the same entry the REST proxy and
 * an agent's worker use.
 *
 * WRITE actions (create/update/delete) route through the `agent_config`
 * write-gate class. The decision is per-principal:
 *   - A HUMAN member applies immediately — no run, no approval card. Role
 *     restrictions for humans live in the tool-access tier (admin-only).
 *   - An AGENT-driven write follows the org policy (default: create/update queue
 *     a pending `runs` row + approval card, applied on approve / cancelled on
 *     reject; delete is denied). This is the durable runs/events primitive that
 *     manage_operations uses.
 *
 * Covers:
 *   - human owner: create/update/delete apply immediately.
 *   - agent principal create gate: pending run + pending approval event, NO agent yet.
 *   - approve(run_id): agent now exists (owner_platform='external' + the
 *     agent_users ownership mapping), run completed, event superseded.
 *   - reject(run_id): no agent, run cancelled, event superseded 'rejected'.
 *   - agent update gate applies on approve; agent delete is denied outright.
 *   - stale approval: applyUpdate skips a field a newer edit already changed.
 *   - get / list stay immediate.
 *   - access: a non-admin member cannot call the admin-tier actions.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
	evaluateEntityMutation,
	resolveActingPrincipal,
} from "../../../authz/entity-policy";
import type { Env } from "../../../index";
import {
	createInferenceProvider,
	setInferenceProviderDefault,
} from "../../../lobu/stores/provider-secrets";
import { orgContext } from "../../../lobu/stores/org-context";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
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
};

async function agentExists(orgId: string, agentId: string): Promise<boolean> {
	const sql = getTestDb();
	const rows = await sql`
		SELECT 1 FROM agents WHERE organization_id = ${orgId} AND id = ${agentId}
	`;
	return rows.length > 0;
}

async function agentRevision(ctx: AuthContext, agentId: string): Promise<string> {
  const snapshot = await executeTool("manage_agents", { action: "get", agent_id: agentId }, TEST_ENV, ctx) as { agent: { revision: string } };
  return snapshot.agent.revision;
}

describe("manage_agents — builder gate e2e", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentCtx: AuthContext;
	let memberCtx: AuthContext;



	const baseCtx = (
		orgIdValue: string,
		userId: string,
		memberRole: "owner" | "member",
		scopes: string[],
		agentId: string | null = null,
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole,
		agentId,
		requestedAgentId: null,
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

		const org = await createTestOrganization({ name: "manage_agents gate e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ma-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		const member = await createTestUser({ email: "ma-member@test.com" });
		await addUserToOrganization(member.id, org.id, "member");

		ownerCtx = baseCtx(org.id, owner.id, "owner", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);
		// Same owner identity, but acting as an agent (agentId set) — this is the
		// principal the write-gate holds for approval. The prod auth path binds an
		// agentId only after confirming the agent row exists (mcp-handler), so the
		// fixture must create it too — otherwise the gate's existence check (codex-17)
		// correctly denies a bound-but-nonexistent principal.
		await createTestAgent({
			organizationId: org.id,
			agentId: "builder-agent",
			ownerUserId: owner.id,
		});
		agentCtx = baseCtx(
			org.id,
			owner.id,
			"owner",
			["mcp:read", "mcp:write", "mcp:admin"],
			"builder-agent",
		);
		agentCtx.mcpSessionId = "session-manage-agents";
		memberCtx = baseCtx(org.id, member.id, "member", ["mcp:read", "mcp:write"]);
	});

	it("human owner: create applies immediately with no approval run", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "human-bot", name: "Human Bot" },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; created?: boolean; status?: string };
		expect(res.status).toBeUndefined();
		expect(res.created).toBe(true);
		expect(await agentExists(orgId, "human-bot")).toBe(true);

		// No pending manage_agents run was created for this immediate apply.
		const sql = getTestDb();
		const runRows = await sql`
			SELECT 1 FROM runs
			WHERE organization_id = ${orgId} AND action_key = 'manage_agents'
				AND (action_input->>'agent_id') = 'human-bot'
		`;
		expect(runRows.length).toBe(0);
	});

	it("human owner: update and delete apply immediately", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "human-edit-bot", name: "v1" },
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "human-edit-bot", expected_revision: await agentRevision(ownerCtx, "human-edit-bot"), name: "v2" },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; updated_fields?: string[]; status?: string };
		expect(upd.status).toBeUndefined();
		expect(upd.updated_fields).toContain("name");
		const sql = getTestDb();
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'human-edit-bot'
		`;
		expect(nameRows[0]?.name).toBe("v2");

		const del = (await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "human-edit-bot", expected_revision: await agentRevision(ownerCtx, "human-edit-bot") },
			TEST_ENV,
			ownerCtx,
		)) as { action: string; deleted?: boolean; status?: string };
		expect(del.status).toBeUndefined();
		expect(del.deleted).toBe(true);
		expect(await agentExists(orgId, "human-edit-bot")).toBe(false);
	});

	it("deleting an agent CASCADES its write-gate policy rows (codex-15)", async () => {
		const sql = getTestDb();
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "policy-bot", name: "v1" },
			TEST_ENV,
			ownerCtx,
		);
		// Seed an exact-agent policy row for it.
		await sql`
			INSERT INTO write_approval_policies (organization_id, resource_class, principal_kind, principal_id)
			VALUES (${orgId}, 'entity', 'agent', 'policy-bot')
		`;
		const before = await sql`
			SELECT id FROM write_approval_policies
			WHERE organization_id = ${orgId} AND principal_kind = 'agent' AND principal_id = 'policy-bot'
		`;
		expect(before.length).toBe(1);

		await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "policy-bot", expected_revision: await agentRevision(ownerCtx, "policy-bot") },
			TEST_ENV,
			ownerCtx,
		);
		// The agent's policy rows must be gone — else a future 'policy-bot' inherits them.
		const after = await sql`
			SELECT id FROM write_approval_policies
			WHERE organization_id = ${orgId} AND principal_kind = 'agent' AND principal_id = 'policy-bot'
		`;
		expect(after.length).toBe(0);
	});

	it("a deleted agent's still-live session FAILS CLOSED at the gate (codex-17 P1)", async () => {
		const sql = getTestDb();
		// An agent with a live session, then deleted. The deny comes from the existence
		// check (ownerResolved=false), NOT a seeded rule — so no policy row is needed.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "ghost-bot", name: "v1" },
			TEST_ENV,
			ownerCtx,
		);
		// Before deletion the resolver treats the agent as resolved.
		const live = await resolveActingPrincipal(sql, {
			organizationId: orgId,
			agentId: "ghost-bot",
		});
		expect(live.ownerResolved).toBe(true);

		await executeTool(
			"manage_agents",
			{ action: "delete", agent_id: "ghost-bot", expected_revision: await agentRevision(ownerCtx, "ghost-bot") },
			TEST_ENV,
			ownerCtx,
		);

		// The bound session keeps agentId 'ghost-bot'. Without the existence check it
		// would resolve as an agent with no rows → gate falls back to the looser org
		// default. The fix marks it unresolved → every gate denies.
		const stale = await resolveActingPrincipal(sql, {
			organizationId: orgId,
			agentId: "ghost-bot",
		});
		expect(stale.ownerResolved).toBe(false);
		const decision = await evaluateEntityMutation({
			organizationId: orgId,
			principalKind: stale.kind,
			principalId: stale.id,
			ownerAgentId: stale.ownerAgentId,
			ownerResolved: stale.ownerResolved,
			mode: stale.mode,
			action: "create",
			entityTypeSlug: "task",
			sql,
		});
		expect(decision).toBe("deny");
	});

	it("the DB trigger REJECTS an orphan agent-policy insert (codex-17 P2 race backstop)", async () => {
		const sql = getTestDb();
		// A permissions PUT that observed an agent, then the agent was deleted before
		// the policy INSERT committed, must not leave an orphan row a recreated slug
		// would inherit. The trigger rejects the write outright.
		let raised = false;
		try {
			await sql`
				INSERT INTO write_approval_policies (organization_id, resource_class, principal_kind, principal_id)
				VALUES (${orgId}, 'entity', 'agent', 'never-existed-bot')
			`;
		} catch (err) {
			raised = true;
			expect(String(err)).toContain("not found in org");
		}
		expect(raised).toBe(true);
		const rows = await sql`
			SELECT id FROM write_approval_policies
			WHERE organization_id = ${orgId} AND principal_id = 'never-existed-bot'
		`;
		expect(rows.length).toBe(0);
	});

	it("agent create produces a pending run + approval event and does NOT create the agent yet", async () => {
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "support-bot", name: "Support Bot" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;

		expect(res.status).toBe("pending_approval");
		expect(typeof res.run_id).toBe("number");

		const sql = getTestDb();

		// Pending run, run_type='internal', held proposal in action_input.
		const runRows = await sql`
			SELECT run_type, action_key, approval_status, status, action_input,
			       created_by_user_id, initiator_kind, initiator_ref
			FROM runs WHERE id = ${res.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows.length).toBe(1);
		expect(runRows[0]?.run_type).toBe("internal");
		expect(runRows[0]?.action_key).toBe("manage_agents");
		expect(runRows[0]?.approval_status).toBe("pending");
		expect(runRows[0]?.status).toBe("pending");
		expect(runRows[0]?.created_by_user_id).toBe(ownerId);
		expect(runRows[0]?.initiator_kind).toBe("agent_session");
		expect(runRows[0]?.initiator_ref).toMatchObject({
			agent_id: "builder-agent",
			user_id: ownerId,
		});
		const proposal = runRows[0]?.action_input as {
			action: string;
			agent_id: string;
			name?: string;
		};
		expect(proposal.action).toBe("create");
		expect(proposal.agent_id).toBe("support-bot");
		expect(proposal.name).toBe("Support Bot");

		// Pending approval event exists for this run.
		const eventRows = await sql`
			SELECT interaction_type, interaction_status, metadata
			FROM current_event_records
			WHERE run_id = ${res.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(eventRows.length).toBe(1);
		expect(eventRows[0]?.interaction_status).toBe("pending");
		expect(eventRows[0]?.metadata).toMatchObject({
			mcp_session_id: "session-manage-agents",
			approval_context: {
				kind: "agent",
				impact: { level: "normal" },
			},
		});

		// No agent created yet — the gate is the whole point.
		expect(await agentExists(orgId, "support-bot")).toBe(false);
	});

	it("approve applies the held create: agent + ownership mapping exist, run completed, event superseded", async () => {
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "approved-bot", name: "Approved Bot" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");
		expect(await agentExists(orgId, "approved-bot")).toBe(false);

		const approveRes = (await executeTool(
			"manage_operations",
			{ action: "approve", run_id: created.run_id },
			TEST_ENV,
			ownerCtx,
		)) as { approved?: true };
		expect(approveRes.approved).toBe(true);

		const sql = getTestDb();

		// Agent now exists with owner attribution + agent_users mapping.
		const agentRows = await sql`
			SELECT owner_platform, owner_user_id FROM agents
			WHERE organization_id = ${orgId} AND id = 'approved-bot'
		`;
		expect(agentRows.length).toBe(1);
		expect(agentRows[0]?.owner_platform).toBe("external");
		expect(agentRows[0]?.owner_user_id).toBe(ownerId);

		const userRows = await sql`
			SELECT 1 FROM agent_users
			WHERE organization_id = ${orgId} AND agent_id = 'approved-bot'
				AND platform = 'external' AND user_id = ${ownerId}
		`;
		expect(userRows.length).toBe(1);

		// Run completed + approved.
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

	it("reject cancels the held create: no agent, run cancelled, event superseded 'rejected'", async () => {
		const created = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "rejected-bot", name: "Rejected Bot" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(created.status).toBe("pending_approval");

		const rejectRes = (await executeTool(
			"manage_operations",
			{ action: "reject", run_id: created.run_id, reason: "not now" },
			TEST_ENV,
			ownerCtx,
		)) as { rejected?: true };
		expect(rejectRes.rejected).toBe(true);

		// No agent created.
		expect(await agentExists(orgId, "rejected-bot")).toBe(false);

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

	it("agent update gate applies field changes on approve", async () => {
		// Land a base agent immediately as the human owner.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "editable-bot", name: "Editable Bot" },
			TEST_ENV,
			ownerCtx,
		);

		// An agent-driven update is gated.
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "editable-bot", expected_revision: await agentRevision(ownerCtx, "editable-bot"), name: "Editable Bot v2" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(upd.status).toBe("pending_approval");

		const sql = getTestDb();
		// Name not changed until approval.
		let nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'editable-bot'
		`;
		expect(nameRows[0]?.name).toBe("Editable Bot");

		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'editable-bot'
		`;
		expect(nameRows[0]?.name).toBe("Editable Bot v2");
	});

	it("a stale approval rejects the entire configuration after a newer edit", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "raced-bot", name: "Original" },
			TEST_ENV,
			ownerCtx,
		);
		// Agent proposes name → "Agent Name" (pre-image captured: "Original").
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", expected_revision: await agentRevision(ownerCtx, "raced-bot"), name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(upd.status).toBe("pending_approval");

		// Meanwhile a human renames it — pre-image no longer matches.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", expected_revision: await agentRevision(ownerCtx, "raced-bot"), name: "Human Name" },
			TEST_ENV,
			ownerCtx,
		);

		// Approving the stale proposal must NOT clobber the human's newer name.
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		const sql = getTestDb();
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'raced-bot'
		`;
		expect(nameRows[0]?.name).toBe("Human Name");
	});

	it("a legacy pending run with no pre-image fails closed (does NOT clobber)", async () => {
		// Simulates a run queued BEFORE the base-capture branch shipped: its
		// action_input has no `base`. Approving it must skip the field (fail closed),
		// never blind-overwrite a newer human edit (sol review #8).
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "legacy-bot", name: "Original" },
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "legacy-bot", expected_revision: await agentRevision(ownerCtx, "legacy-bot"), name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;

		const sql = getTestDb();
		// Strip `base` from the queued proposal to mimic a pre-branch legacy run.
		await sql`
			UPDATE runs
			SET action_input = (action_input - 'base' - 'expected_revision')
			WHERE id = ${upd.run_id} AND organization_id = ${orgId}
		`;

		// A human renames it after the (now base-less) proposal was queued.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "legacy-bot", expected_revision: await agentRevision(ownerCtx, "legacy-bot"), name: "Human Name" },
			TEST_ENV,
			ownerCtx,
		);

		// Approving the legacy proposal must NOT overwrite the human's newer name.
		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: upd.run_id },
			TEST_ENV,
			ownerCtx,
		);
		const nameRows = await sql`
			SELECT name FROM agents WHERE organization_id = ${orgId} AND id = 'legacy-bot'
		`;
		expect(nameRows[0]?.name).toBe("Human Name");
	});

	it("agent delete is denied outright (a human must delete an agent)", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "protected-bot", name: "Protected Bot" },
			TEST_ENV,
			ownerCtx,
		);
		expect(await agentExists(orgId, "protected-bot")).toBe(true);

		await expect(
			executeTool(
				"manage_agents",
				{ action: "delete", agent_id: "protected-bot" },
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow();
		// The agent survives the denied delete.
		expect(await agentExists(orgId, "protected-bot")).toBe(true);
	});

	it("get / list stay immediate", async () => {
		// Land an agent immediately as the human owner.
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "system-bot", name: "System Bot", identity_md: "Keep the authored identity." },
			TEST_ENV,
			ownerCtx,
		);

		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "system-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { agent?: { id: string; identity_md: string | null } };
		expect(got.agent?.id).toBe("system-bot");
		expect(got.agent?.identity_md).toBe("Keep the authored identity.");

		const list = (await executeTool(
			"manage_agents",
			{ action: "list" },
			TEST_ENV,
			ownerCtx,
		)) as { agents: Array<{ id: string }> };
		const row = list.agents.find((a) => a.id === "system-bot");
		expect(row?.id).toBe("system-bot");
    const sql = getTestDb();
    await sql`UPDATE agents SET identity_md = NULL WHERE organization_id = ${orgId} AND id = 'system-bot'`;
    const cleared = await executeTool("manage_agents", { action: "get", agent_id: "system-bot" }, TEST_ENV, ownerCtx) as { agent: { identity_md: string | null } };
    expect(cleared.agent.identity_md).toBeNull();
	});

	it("agent principal: agent_config read deny filters list and blocks get", async () => {
		const sql = getTestDb();
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "visible-bot", name: "Visible" },
			TEST_ENV,
			ownerCtx,
		);
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "hidden-bot", name: "Hidden" },
			TEST_ENV,
			ownerCtx,
		);

		// Blacklist hidden-bot for builder-agent (default read stays auto).
		const policyRows = await sql<{ id: number }>`
			INSERT INTO write_approval_policies
				(organization_id, resource_class, principal_kind, principal_id, target_agent_id)
			VALUES
				(${orgId}, 'agent_config', 'agent', 'builder-agent', 'hidden-bot')
			RETURNING id
		`;
		await sql`
			INSERT INTO write_policy_action_effects (policy_id, action, effect)
			VALUES (${policyRows[0].id}, 'read', 'deny')
		`;

		const list = (await executeTool(
			"manage_agents",
			{ action: "list" },
			TEST_ENV,
			agentCtx,
		)) as { agents: Array<{ id: string }> };
		const ids = list.agents.map((a) => a.id);
		expect(ids).toContain("visible-bot");
		expect(ids).not.toContain("hidden-bot");

		await expect(
			executeTool(
				"manage_agents",
				{ action: "get", agent_id: "hidden-bot" },
				TEST_ENV,
				agentCtx,
			),
		).rejects.toThrow(/Policy denies reading agent/);

		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "visible-bot" },
			TEST_ENV,
			agentCtx,
		)) as { agent?: { id: string } };
		expect(got.agent?.id).toBe("visible-bot");
	});

	it("a non-admin member cannot call admin-tier write actions", async () => {
		await expect(
			executeTool(
				"manage_agents",
				{ action: "create", agent_id: "member-bot", name: "Member Bot" },
				TEST_ENV,
				memberCtx,
			),
		).rejects.toThrow();
	});
});

/**
 * #2047 — an agent must be runnable after create, and the tool must expose a
 * model-config path. Covers the schema-driven field engine end to end:
 *   - create WITHOUT default_model + no org default ⇒ result reports not_runnable.
 *   - create WITH a valid default_model ⇒ agent pinned, source 'agent', runnable.
 *   - create with an unknown-provider model ⇒ rejected, and NO agent row left.
 *   - get ⇒ returns effective model + inheritance source.
 *   - update setting ONLY default_model ⇒ valid (proves default_model counts as a
 *     field, the whole point of the registry).
 *   - update clearing default_model ('') ⇒ falls back to the org default.
 */
describe("manage_agents — model config (#2047)", () => {
	let orgId: string;
	let ownerCtx: AuthContext;

	const baseCtx = (
		orgIdValue: string,
		userId: string,
	): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	type ModelInfo = {
		effective_model: string | null;
		source: "agent" | "org_default" | "none";
		not_runnable: boolean;
	};

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "manage_agents model e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ma-model-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);
		// An org provider whose slug the model refs resolve against.
		await orgContext.run({ organizationId: org.id }, async () => {
			await createInferenceProvider({
				organizationId: org.id,
				slug: "myco",
				kind: "openai",
				apiKey: "sk-test",
				capabilities: { text: { model: "myco-large" } },
			});
		});
	});

	it("create WITHOUT default_model and no org default ⇒ not_runnable", async () => {
		// Needs an org with NO provider at all: the shared `orgId` has a runnable
		// `myco` row from beforeAll, so it resolves `org_default` rather than
		// `none`.
		const bareOrg = await createTestOrganization({ name: "no provider org" });
		const bareOwner = await createTestUser({ email: "ma-bare-owner@test.com" });
		await addUserToOrganization(bareOwner.id, bareOrg.id, "owner");

		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "no-model-bot", name: "No Model" },
			TEST_ENV,
			baseCtx(bareOrg.id, bareOwner.id),
		)) as { created: boolean; model: ModelInfo };
		expect(res.created).toBe(true);
		expect(res.model.source).toBe("none");
		expect(res.model.not_runnable).toBe(true);
		expect(res.model.effective_model).toBeNull();
	});

	it("create WITHOUT default_model but WITH an org default ⇒ runnable via org_default", async () => {
		// The complement: the shared org has a runnable default provider, so a
		// model-less agent inherits it.
		const res = (await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "inherit-model-bot", name: "Inherit" },
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean; model: ModelInfo };
		expect(res.created).toBe(true);
		expect(res.model.source).toBe("org_default");
		expect(res.model.not_runnable).toBe(false);
		expect(res.model.effective_model).toBe("myco/myco-large");
	});

	it("create WITH a valid default_model ⇒ pinned, runnable, source 'agent'", async () => {
		const res = (await executeTool(
			"manage_agents",
			{
				action: "create",
				agent_id: "pinned-bot",
				name: "Pinned",
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		)) as { created: boolean; model: ModelInfo };
		expect(res.created).toBe(true);
		expect(res.model.effective_model).toBe("myco/myco-large");
		expect(res.model.source).toBe("agent");
		expect(res.model.not_runnable).toBe(false);

		// And it landed in the agents.models column (the single source of truth).
		const sql = getTestDb();
		const rows = await sql`
			SELECT models FROM agents WHERE organization_id = ${orgId} AND id = 'pinned-bot'
		`;
		expect(rows[0]?.models).toEqual(["myco/myco-large"]);
	});

	it("create with an unknown-provider model ⇒ rejected, NO agent row left", async () => {
		await expect(
			executeTool(
				"manage_agents",
				{
					action: "create",
					agent_id: "bad-model-bot",
					name: "Bad",
					default_model: "ghostprovider/x",
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow();
		const sql = getTestDb();
		const rows = await sql`
			SELECT 1 FROM agents WHERE organization_id = ${orgId} AND id = 'bad-model-bot'
		`;
		expect(rows.length).toBe(0);
	});

	it("get ⇒ returns effective model + inheritance source", async () => {
		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "pinned-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { agent: { id: string }; model: ModelInfo };
		expect(got.agent.id).toBe("pinned-bot");
		expect(got.model.effective_model).toBe("myco/myco-large");
		expect(got.model.source).toBe("agent");
	});

	it("update setting ONLY default_model is a valid update", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "model-only-bot", name: "MO" },
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{
				action: "update",
				agent_id: "model-only-bot",
				expected_revision: await agentRevision(ownerCtx, "model-only-bot"),
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[]; model: ModelInfo };
		expect(upd.updated_fields).toContain("default_model");
		expect(upd.model.effective_model).toBe("myco/myco-large");
		expect(upd.model.source).toBe("agent");
	});

	it("update clearing default_model ('') falls back to the org default", async () => {
		// Make myco the org default so a cleared agent inherits it.
		await orgContext.run({ organizationId: orgId }, async () => {
			await setInferenceProviderDefault(orgId, "myco");
		});
		await executeTool(
			"manage_agents",
			{
				action: "create",
				agent_id: "clearable-bot",
				name: "Clear",
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		);
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "clearable-bot", expected_revision: await agentRevision(ownerCtx, "clearable-bot"), default_model: "" },
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[]; model: ModelInfo };
		expect(upd.updated_fields).toContain("default_model");
		// Cleared pin ⇒ inherits the org default (source flips to org_default).
		expect(upd.model.source).toBe("org_default");
		expect(upd.model.not_runnable).toBe(false);
		expect(upd.model.effective_model).toBe("myco/myco-large");
	});
});
