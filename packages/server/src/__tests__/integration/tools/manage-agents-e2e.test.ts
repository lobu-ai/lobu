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
import { executeTool, toToolContext } from "../../../tools/execute";
import { buildAgentsNamespace } from "../../../sandbox/namespaces/agents";
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


  it("SDK settings and identity round-trip through canonical storage; concurrent patches retain omitted fields", async () => {
    const sdk = buildAgentsNamespace(toToolContext(ownerCtx), TEST_ENV);
    await sdk.create({ agent_id: "settings-bot", name: "Settings" });
    const skillsConfig = { skills: [{ repo: "example/skills", name: "triage", enabled: true, content: "Read the queue before acting." }] };
    await sdk.update({ agent_id: "settings-bot", identity_md: "You triage.", settings: { skillsConfig } });
    await Promise.all([
      sdk.update({ agent_id: "settings-bot", settings: { soulMd: "Be concise." } }),
      sdk.update({ agent_id: "settings-bot", settings: { userMd: "Prefer evidence." } }),
    ]);
    const got = await sdk.get("settings-bot");
    expect(got.settings).toMatchObject({ skillsConfig, identityMd: "You triage.", soulMd: "Be concise.", userMd: "Prefer evidence." });
    expect(got.settings.updatedAt).toBeTypeOf("number");
    const sql = getTestDb();
    const audit = await sql`SELECT payload_data FROM events WHERE organization_id = ${orgId}
      AND metadata->>'resource_kind' = 'agent-settings' AND metadata->>'resource_id' = 'settings-bot' ORDER BY id DESC LIMIT 1`;
    expect(audit[0]?.payload_data.state).toEqual(JSON.parse(JSON.stringify(got.settings)));
  });

  it("rejects malformed and ambiguous settings atomically", async () => {
    const sdk = buildAgentsNamespace(toToolContext(ownerCtx), TEST_ENV);
    await sdk.create({ agent_id: "invalid-settings-bot", name: "Original" });
    const before = await sdk.get("invalid-settings-bot");
    for (const settings of [
      { invented: true }, { identityMd: "duplicate" }, { updatedAt: 0 },
      { skillsConfig: { skills: [{ repo: "example", name: "bad", enabled: "yes" }] } },
      { networkConfig: { allowedDomains: ["invalid host"] } },
      { guardrailsInline: [{ name: "bad", enabled: true, stage: "input" }] },
      { models: ["unconnected/model"] },
    ]) {
      await expect(executeTool("manage_agents", { action: "update", agent_id: "invalid-settings-bot", name: "Changed", settings }, TEST_ENV, ownerCtx)).rejects.toThrow();
    }
    await expect(sdk.update({ agent_id: "invalid-settings-bot", default_model: "", settings: { models: [] } })).rejects.toThrow(/either/);
    await expect(executeTool("manage_agents", { action: "update", agent_id: "invalid-settings-bot", settings: { soulMd: "Denied" } }, TEST_ENV, memberCtx)).rejects.toThrow();
    expect(await sdk.get("invalid-settings-bot")).toEqual(before);
  });

  it("settings follow approval policy and skip only settings changed since proposal", async () => {
    const sdk = buildAgentsNamespace(toToolContext(ownerCtx), TEST_ENV);
    const agentSdk = buildAgentsNamespace(toToolContext(agentCtx), TEST_ENV);
    await sdk.create({ agent_id: "approved-settings-bot", name: "Settings" });
    const proposedSkills = { skills: [{ repo: "example/skills", name: "proposed", enabled: true, content: "Proposed skill." }] };
    const humanSkills = { skills: [{ repo: "example/skills", name: "human", enabled: true, content: "New human skill." }] };
    const pending = await agentSdk.update({ agent_id: "approved-settings-bot", identity_md: "Approved identity", settings: { soulMd: "Proposed", userMd: "Approved preference", skillsConfig: proposedSkills } });
    if (!("status" in pending) || pending.status !== "pending_approval") throw new Error("Expected approval");
    expect((await sdk.get("approved-settings-bot")).settings.soulMd).not.toBe("Proposed");
    await sdk.update({ agent_id: "approved-settings-bot", settings: { soulMd: "New human edit", skillsConfig: humanSkills } });
    await executeTool("manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx);
    expect((await sdk.get("approved-settings-bot")).settings).toMatchObject({ identityMd: "Approved identity", soulMd: "New human edit", userMd: "Approved preference", skillsConfig: humanSkills });
    const sql = getTestDb();
    const [run] = await sql`SELECT action_output FROM runs WHERE id = ${pending.run_id}`;
    expect(run.action_output.skipped_fields).toContain("settings.soulMd");
    expect(run.action_output.skipped_fields).toContain("settings.skillsConfig");
    expect(run.action_output.updated_fields).toContain("settings.userMd");
  });

  it("audit failure rolls back identity, settings and metadata together", async () => {
    const sdk = buildAgentsNamespace(toToolContext(ownerCtx), TEST_ENV);
    await sdk.create({ agent_id: "audit-settings-bot", name: "Original" });
    const before = await sdk.get("audit-settings-bot");
    const sql = getTestDb();
    await sql.unsafe("CREATE FUNCTION reject_settings_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.metadata->>'category' = 'config' AND NEW.metadata->>'resource_kind' = 'agent' THEN RAISE EXCEPTION 'synthetic settings audit failure'; END IF; RETURN NEW; END $$");
    await sql.unsafe("CREATE TRIGGER reject_settings_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_settings_audit()");
    try {
      await expect(sdk.update({ agent_id: "audit-settings-bot", name: "Changed", identity_md: "Changed", settings: { soulMd: "Changed" } })).rejects.toThrow(/synthetic settings audit failure/);
      expect(await sdk.get("audit-settings-bot")).toEqual(before);
    } finally {
      await sql.unsafe("DROP TRIGGER reject_settings_audit ON events");
      await sql.unsafe("DROP FUNCTION reject_settings_audit()");
    }
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
			{ action: "update", agent_id: "human-edit-bot", name: "v2" },
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
			{ action: "delete", agent_id: "human-edit-bot" },
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
			{ action: "delete", agent_id: "policy-bot" },
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
			{ action: "delete", agent_id: "ghost-bot" },
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
			{ action: "update", agent_id: "editable-bot", name: "Editable Bot v2" },
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

	it("a stale approval skips a field another writer already changed", async () => {
		await executeTool(
			"manage_agents",
			{ action: "create", agent_id: "raced-bot", name: "Original" },
			TEST_ENV,
			ownerCtx,
		);
		// Agent proposes name → "Agent Name" (pre-image captured: "Original").
		const upd = (await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;
		expect(upd.status).toBe("pending_approval");

		// Meanwhile a human renames it — pre-image no longer matches.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "raced-bot", name: "Human Name" },
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
			{ action: "update", agent_id: "legacy-bot", name: "Agent Name" },
			TEST_ENV,
			agentCtx,
		)) as PendingApproval;

		const sql = getTestDb();
		// Strip `base` from the queued proposal to mimic a pre-branch legacy run.
		await sql`
			UPDATE runs
			SET action_input = (action_input - 'base')
			WHERE id = ${upd.run_id} AND organization_id = ${orgId}
		`;

		// A human renames it after the (now base-less) proposal was queued.
		await executeTool(
			"manage_agents",
			{ action: "update", agent_id: "legacy-bot", name: "Human Name" },
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
			{ action: "create", agent_id: "system-bot", name: "System Bot" },
			TEST_ENV,
			ownerCtx,
		);

		const got = (await executeTool(
			"manage_agents",
			{ action: "get", agent_id: "system-bot" },
			TEST_ENV,
			ownerCtx,
		)) as { agent?: { id: string } };
		expect(got.agent?.id).toBe("system-bot");

		const list = (await executeTool(
			"manage_agents",
			{ action: "list" },
			TEST_ENV,
			ownerCtx,
		)) as { agents: Array<{ id: string }> };
		const row = list.agents.find((a) => a.id === "system-bot");
		expect(row?.id).toBe("system-bot");
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
			VALUES (${policyRows[0].id}, 'read', 'deny'), (${policyRows[0].id}, 'update', 'deny')
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

    await expect(executeTool("manage_agents", {
      action: "update", agent_id: "hidden-bot", settings: { soulMd: "Denied edit" },
    }, TEST_ENV, agentCtx)).rejects.toThrow(/Policy denies update/);

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
		const sql = getTestDb();
		await sql`UPDATE agents SET models = '["myco/old-primary", "myco/fallback"]'::jsonb
			WHERE organization_id = ${orgId} AND id = 'model-only-bot'`;
		const upd = (await executeTool(
			"manage_agents",
			{
				action: "update",
				agent_id: "model-only-bot",
				default_model: "myco/myco-large",
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields: string[]; model: ModelInfo };
		expect(upd.updated_fields).toContain("default_model");
		expect(upd.model.effective_model).toBe("myco/myco-large");
		expect(upd.model.source).toBe("agent");
		const rows = await sql`SELECT models FROM agents
			WHERE organization_id = ${orgId} AND id = 'model-only-bot'`;
		expect(rows[0]?.models).toEqual(["myco/myco-large", "myco/fallback"]);
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
			{ action: "update", agent_id: "clearable-bot", default_model: "" },
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
