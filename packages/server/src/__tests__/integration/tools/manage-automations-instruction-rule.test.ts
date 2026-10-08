/**
 * manage_automations — instruction-presence rule (issue #2320, thin Automations).
 *
 * An Automation needs at least one instruction source (`prompt`, pinned skills,
 * or a reaction script) only for trigger shapes that run on it alone: schedule
 * triggers, event triggers with execution "window", and no triggers (manual).
 * An event trigger with execution "turn" carries its own content and may omit
 * all three.
 *
 * create_version and set_reaction_script enforce the same rule when they mutate
 * instruction sources: a version bump is validated against the group's
 * reaction, and clearing a sole-source reaction is rejected.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { getTestDb } from "../../setup/test-db";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

const TURN_TRIGGER = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
	execution: "turn",
	output: "reply_to_source",
};

describe("manage_automations — instruction-presence rule", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	let agentId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "instruction rule" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ir-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = {
			organizationId: orgId,
			tokenOrganizationId: orgId,
			userId: owner.id,
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
		const agent = await createTestAgent({
			organizationId: orgId,
			agentId: "ir-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;
		const sql = getTestDb();
		await sql`
			UPDATE agents
			SET skills_config = ${sql.json({
				skills: [
					{
						repo: "file/ir-runbook",
						name: "ir-runbook",
						enabled: true,
						content: "Run the instruction-rule workflow.",
					},
				],
			})}
			WHERE id = ${agentId} AND organization_id = ${orgId}
		`;
	});

	it("creates an event-turn Automation with NO prompt (built-in default applies)", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-listen",
				managed_agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		expect(created.automation_id).toBeTruthy();
	});

	it("rejects a schedule Automation with no prompt", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create",
					slug: "ir-sched",
					managed_agent_id: agentId,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("rejects a manual (no-trigger) Automation with no prompt", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{ action: "create", slug: "ir-manual", managed_agent_id: agentId },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("creates and versions a schedule Automation from pinned skills without a prompt", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-skills-only",
				managed_agent_id: agentId,
				skills: [
					{
						name: "ir-runbook",
						content: "Run the instruction-rule workflow.",
					},
				],
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		expect(created.automation_id).toBeTruthy();

		const sql = getTestDb();
		const [v1] = await sql`
			SELECT version.prompt, version.skills
			FROM automations automation
			JOIN automation_versions version ON version.id = automation.current_version_id
			WHERE automation.id = ${Number(created.automation_id)}
		`;
		expect(v1.prompt).toBe("");
		expect(v1.skills).toEqual([
			{
				name: "ir-runbook",
				content: "Run the instruction-rule workflow.",
			},
		]);

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: created.automation_id!,
				name: "Skills-only renamed",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);

		const [v2] = await sql`
			SELECT version.prompt, version.skills
			FROM automations automation
			JOIN automation_versions version ON version.id = automation.current_version_id
			WHERE automation.id = ${Number(created.automation_id)}
		`;
		expect(v2.prompt).toBe("");
		expect(v2.skills).toEqual(v1.skills);
	});

	const REACTION_SCRIPT = `export const input = {
	type: "object",
	properties: { summary: { type: "string" } },
	required: ["summary"],
	additionalProperties: false,
};

export default async function reaction(ctx, client) {
	await client.entities.discoverDuplicates({ entity_type: "contact-record" });
}`;

	it("creates a schedule Automation from a reaction script without a prompt", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-only",
				managed_agent_id: agentId,
				reaction_script: REACTION_SCRIPT,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		expect(created.automation_id).toBeTruthy();

		const sql = getTestDb();
		const [row] = await sql`
			SELECT automation.reaction_script, automation.reaction_input_schema,
			       version.prompt
			FROM automations automation
			JOIN automation_versions version ON version.id = automation.current_version_id
			WHERE automation.id = ${Number(created.automation_id)}
		`;
		expect(row.prompt).toBe("");
		expect(row.reaction_script).toContain("discoverDuplicates");
		expect(row.reaction_input_schema).toEqual({
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
			additionalProperties: false,
		});
	});

	it("create_version keeps a reaction-only schedule Automation valid when it blanks the prompt", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-versioned",
				managed_agent_id: agentId,
				reaction_script: REACTION_SCRIPT,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: created.automation_id!,
				prompt: "",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("update accepts a reaction-only Automation when its trigger becomes a schedule", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-updated",
				managed_agent_id: agentId,
				reaction_script: REACTION_SCRIPT,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id!,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).resolves.toBeTruthy();
	});

	it("create_from_version preserves a reaction-only schedule Automation", async () => {
		const rootEntity = await createTestEntity({
			name: "IR Reaction Root",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});
		const siblingEntity = await createTestEntity({
			name: "IR Reaction Sibling",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-cloned",
				managed_agent_id: agentId,
				entity_id: rootEntity.id,
				reaction_script: REACTION_SCRIPT,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const sql = getTestDb();
		const [root] = await sql`
			SELECT current_version_id FROM automations
			WHERE id = ${Number(created.automation_id)}
		`;
		const cloned = (await executeTool(
			"manage_automations",
			{
				action: "create_from_version",
				version_id: String(root.current_version_id),
				entity_ids: [siblingEntity.id],
			},
			TEST_ENV,
			ownerCtx
		)) as { created?: Array<{ automation_id: string }> };

		expect(cloned.created?.[0]?.automation_id).toBeTruthy();
		const siblingId = Number(cloned.created?.[0]?.automation_id);
		const [sibling] = await sql`
			SELECT reaction_script FROM automations WHERE id = ${siblingId}
		`;
		expect(sibling.reaction_script).toContain("discoverDuplicates");
	});

	it("rejects clearing the reaction script that was the sole instruction source", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-cleared",
				managed_agent_id: agentId,
				reaction_script: REACTION_SCRIPT,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "set_reaction_script",
					automation_id: created.automation_id!,
					reaction_script: "",
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);

		const sql = getTestDb();
		const [row] = await sql`
			SELECT reaction_script
			FROM automations
			WHERE id = ${Number(created.automation_id)}
		`;
		expect(row.reaction_script).toContain("discoverDuplicates");
	});

	it("allows clearing a reaction when the prompt alone satisfies the rule", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-reaction-cleared-with-prompt",
				managed_agent_id: agentId,
				prompt: "Daily digest instructions.",
				reaction_script: REACTION_SCRIPT,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const cleared = (await executeTool(
			"manage_automations",
			{
				action: "set_reaction_script",
				automation_id: created.automation_id!,
				reaction_script: "",
			},
			TEST_ENV,
			ownerCtx
		)) as { has_script?: boolean };
		expect(cleared.has_script).toBe(false);

		const sql = getTestDb();
		const [row] = await sql`
			SELECT reaction_script
			FROM automations
			WHERE id = ${Number(created.automation_id)}
		`;
		expect(row.reaction_script).toBeNull();
	});

	it("create_version rejects blanking instructions on a schedule Automation, accepts real text", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-sched-ok",
				managed_agent_id: agentId,
				prompt: "Daily digest instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const automationId = created.automation_id!;

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create_version",
					automation_id: automationId,
					prompt: "   ",
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				prompt: "Updated digest instructions.",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("create_version allows writing empty instructions on an event-turn Automation", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-listen-v",
				managed_agent_id: agentId,
				prompt: "Initial listen guidance.",
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: created.automation_id!,
				prompt: "",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("rejects event-turn → schedule via update when the current prompt is empty", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-turn-to-sched-update",
				managed_agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: created.automation_id!,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("rejects event-turn → schedule via create_version when prompt stays empty", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-turn-to-sched-cv",
				managed_agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create_version",
					automation_id: created.automation_id!,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("create_version accepts event-turn → schedule with instructions in one call", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-turn-to-sched-ok",
				managed_agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: created.automation_id!,
				prompt: "Now scheduled digest instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("create_version accepts schedule → event-turn with an explicit empty prompt", async () => {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-sched-to-turn",
				managed_agent_id: agentId,
				prompt: "Scheduled instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };

		const versioned = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: created.automation_id!,
				prompt: "",
				triggers: [TURN_TRIGGER],
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("rejects blanking a group-shared prompt while a schedule sibling still needs it", async () => {
		const sql = getTestDb();
		const rootEntity = await createTestEntity({
			name: "IR Group Root Entity",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});
		const siblingEntity = await createTestEntity({
			name: "IR Group Sibling Entity",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});

		// Root assignment: schedule + shared instructions (entity-bound so
		// create_from_version can fan out another assignment in the group).
		const root = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "ir-group-root",
				managed_agent_id: agentId,
				entity_id: rootEntity.id,
				prompt: "Shared scheduled instructions.",
				triggers: [{ kind: "schedule", cron: "0 10 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		const rootId = root.automation_id!;

		const [rootRow] = await sql`
			SELECT current_version_id, automation_group_id FROM automations WHERE id = ${Number(rootId)}
		`;
		const versionId = Number(rootRow.current_version_id);

		// Real second assignment in the same group — keeps schedule triggers
		// and shares the version/prompt with the root.
		const cloned = (await executeTool(
			"manage_automations",
			{
				action: "create_from_version",
				version_id: String(versionId),
				entity_ids: [siblingEntity.id],
			},
			TEST_ENV,
			ownerCtx
		)) as { created?: Array<{ automation_id: string }> };
		expect(cloned.created?.[0]?.automation_id).toBeTruthy();
		const siblingId = Number(cloned.created![0].automation_id);

		const siblings = await sql`
			SELECT id, triggers FROM automations
			WHERE automation_group_id = ${Number(rootRow.automation_group_id)}
			ORDER BY id
		`;
		expect(siblings).toHaveLength(2);

		// Switch ONLY the targeted root to event-turn with a blank prompt.
		// The sibling still has schedule triggers → group-shared blank prompt
		// must be rejected (incoming triggers on the target do not exempt siblings).
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "create_version",
					automation_id: rootId,
					prompt: "",
					triggers: [TURN_TRIGGER],
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);

		// Sibling still scheduled after the rejected write.
		const [siblingAfter] = await sql`
			SELECT triggers FROM automations WHERE id = ${siblingId}
		`;
		const siblingTriggers = siblingAfter.triggers as Array<{ kind: string }>;
		expect(siblingTriggers.some((t) => t.kind === "schedule")).toBe(true);
	});
});
