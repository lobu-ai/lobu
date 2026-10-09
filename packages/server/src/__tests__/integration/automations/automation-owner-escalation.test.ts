/**
 * Escalation guard on manage_automations (codex review 9, P1).
 *
 * An automation's `managed_agent_id` IS its policy principal — every write the automation performs
 * folds that agent's envelope. So a NON-HUMAN caller must not be able to set/change
 * an automation's managed_agent_id to a DIFFERENT agent: agent A (with a deny envelope) could
 * otherwise mint/reassign an automation owned by looser agent B and route its writes
 * through B, side-stepping A's rules. Humans are ungoverned and may assign freely.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent } from "../../setup/test-fixtures";
import { TestWorkspace } from "../../setup/test-mcp-client";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
};

/** Agent-attributed auth context (a non-human principal). */
function agentCtx(orgId: string, userId: string, agentId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId,
		requestedAgentId: agentId,
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

async function createAutomationAs(
	ctx: AuthContext,
	agentIdForAutomation: string,
	slug: string
) {
	return executeTool(
		"manage_automations",
		{
			action: "create",
			slug,
			name: slug,
			prompt: "Track things.",
			managed_agent_id: agentIdForAutomation,
		},
		TEST_ENV,
		ctx
	);
}

describe("manage_automations owner-escalation guard", () => {
	let workspace: TestWorkspace;
	let agentA: string;
	let agentB: string;

	beforeEach(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create();
		const a = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		const b = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId: workspace.users.owner.id,
		});
		agentA = a.agentId;
		agentB = b.agentId;
	});

	it("blocks agent A from creating an automation owned by agent B (no principal reassignment)", async () => {
		await expect(
			createAutomationAs(
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA),
				agentB,
				"escalation-attempt"
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});

	it("blocks agent A from creating an agentless Automation", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "agentless-escalation-attempt",
					name: "agentless-escalation-attempt",
					prompt: "Track things.",
					managed_agent_id: null,
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});

	it("blocks agent A from explicitly clearing its own Automation owner", async () => {
		const owned = (await workspace.owner.automations.create({
			slug: "agent-a-owned-before-clear",
			name: "agent-a-owned-before-clear",
			prompt: "Track things.",
			managed_agent_id: agentA,
		})) as { automation_id: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: owned.automation_id,
					managed_agent_id: null,
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);

		const [row] = await getTestDb()<{ managed_agent_id: string | null }>`
			SELECT managed_agent_id FROM automations
			WHERE id = ${Number(owned.automation_id)}
		`;
		expect(row.managed_agent_id).toBe(agentA);
	});

	it("a HUMAN may assign an automation to any agent (ungoverned)", async () => {
		const created = (await workspace.owner.automations.create({
			slug: "human-assigns-b",
			name: "human-assigns-b",
			prompt: "Track things.",
			managed_agent_id: agentB,
		})) as { automation_id: string };
		expect(created.automation_id).toBeDefined();
	});

	it("blocks agent A from CLONING agent B's automation via create_from_version (inherited owner)", async () => {
		// A human seeds an automation owned by B; its v1 version_id is the clone source.
		await workspace.owner.entity_schema.createType({
			slug: "company",
			name: "Company",
		});
		const target = (await workspace.owner.entities.create({
			entity_type: "company",
			name: "Clone Target",
		})) as { entity: { id: number } };
		const bAutomation = (await workspace.owner.automations.create({
			slug: "b-owned-source",
			name: "b-owned-source",
			prompt: "Track things.",
			managed_agent_id: agentB,
		})) as { automation_id: string };
		const [ver] = await getTestDb()<{ id: number }>`
      SELECT id FROM automation_versions WHERE automation_id = ${Number(bAutomation.automation_id)} ORDER BY id ASC LIMIT 1
    `;
		// Agent A clones it WITHOUT supplying managed_agent_id — the clone would inherit B's
		// owner. The guard resolves the effective (inherited) owner and blocks it.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create_from_version",
					version_id: String(ver.id),
					entity_ids: [target.entity.id],
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});

	it("blocks agent A from EDITING agent B's automation (preserved owner, no managed_agent_id)", async () => {
		const bAutomation = (await workspace.owner.automations.create({
			slug: "b-owned-edit",
			name: "b-owned-edit",
			prompt: "Track things.",
			managed_agent_id: agentB,
		})) as { automation_id: string };
		// Agent A updates it WITHOUT managed_agent_id — ownership stays B. Blocked because the
		// preserved effective owner (B) isn't A.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: bAutomation.automation_id,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});

	it("create_from_version STILL blocked when A passes managed_agent_id=A (handler ignores it, clone inherits B) (codex-12)", async () => {
		await workspace.owner.entity_schema.createType({
			slug: "company",
			name: "Company",
		});
		const target = (await workspace.owner.entities.create({
			entity_type: "company",
			name: "Clone Target 2",
		})) as { entity: { id: number } };
		const bAutomation = (await workspace.owner.automations.create({
			slug: "b-owned-source-2",
			name: "b-owned-source-2",
			prompt: "Track things.",
			managed_agent_id: agentB,
		})) as { automation_id: string };
		const [ver] = await getTestDb()<{ id: number }>`
      SELECT id FROM automation_versions WHERE automation_id = ${Number(bAutomation.automation_id)} ORDER BY id ASC LIMIT 1
    `;
		// A supplies managed_agent_id=A to try to satisfy the guard — but handleCreateFromVersion
		// IGNORES it and clones B's owner, so the guard must resolve the SOURCE owner.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create_from_version",
					version_id: String(ver.id),
					entity_ids: [target.entity.id],
					managed_agent_id: agentA,
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});

	it("set_reaction_script on A's own automation is blocked when its GROUP also contains a B-owned assignment (codex-12)", async () => {
		// A owns automation wA; a human adds a SECOND assignment owned by B into wA's group
		// (same automation_group_id). set_reaction_script writes group-wide → it would
		// rewrite B's reaction code too. A editing "its own" automation must be blocked.
		const wA = (await workspace.owner.automations.create({
			slug: "a-owned-grouproot",
			name: "a-owned-grouproot",
			prompt: "Track things.",
			managed_agent_id: agentA,
		})) as { automation_id: string };
		// Add a B-owned sibling into wA's group. Create it via the normal CRUD path
		// (so all its rows/triggers are consistent), then move it into wA's group with
		// a direct UPDATE — a raw automation INSERT trips unrelated sequence collisions.
		const bSibling = (await workspace.owner.automations.create({
			slug: "b-sibling",
			name: "b-sibling",
			prompt: "Track things.",
			managed_agent_id: agentB,
		})) as { automation_id: string };
		const [grp] = await getTestDb()<{ automation_group_id: number }>`
      SELECT automation_group_id FROM automations WHERE id = ${Number(wA.automation_id)} LIMIT 1
    `;
		await getTestDb()`
      UPDATE automations SET automation_group_id = ${Number(grp.automation_group_id)}
      WHERE id = ${Number(bSibling.automation_id)}
    `;
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "set_reaction_script",
					automation_id: wA.automation_id,
					reaction_script: "export default async () => {};",
				},
				TEST_ENV,
				agentCtx(workspace.org.id, workspace.users.owner.id, agentA)
			)
		).rejects.toThrow(
			/cannot install an Automation owned by another agent/i
		);
	});
});
