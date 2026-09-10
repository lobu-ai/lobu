/**
 * manage_automations `update` — version-owned fields must not be silently dropped.
 *
 * Bug (red→fix→green): `AUTOMATION_UPDATE_PATCH_KEYS` advertised `name`,
 * `description`, `prompt`, `sources`, and `entity_ids` as valid
 * `update` patch fields, but `handleUpdate`'s UPDATE SET clause writes none of
 * them — `name`/`description`/`prompt`/`sources` are version-owned (live in
 * `automation_versions`; the automations-row `name` is cascaded by version
 * activation), `entity_ids` is `create_from_version`-only. (`status` was also
 * listed but isn't on `ManageAutomationsArgs` — it's a `list` filter; the entry
 * was dead.) So an `update` carrying any of them passed validation and
 * returned success with `updated_fields: []` — a silent no-op the caller
 * believed applied.
 *
 * Contract intent (packages/core/src/contracts/tools/manage-automations.ts):
 *   name/description/prompt → "[create/create_version]"
 *   sources                 → "[create/create_version]" (update was a doc lie)
 *   entity_ids              → "[create_from_version]"
 *
 * Fix: drop those keys from `AUTOMATION_UPDATE_PATCH_KEYS` AND explicitly reject
 * them on `update` with a pointer to `create_version`, so a caller can never
 * believe a version-owned change applied.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

describe("manage_automations update — version-owned fields are not silently dropped", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentId: string;
	let automationId: string;
	const previewConnectionId = "preview-update-version";
	let previewUpdate: { automationId: string; triggers: AutomationTrigger[] };
	let previewVersion: { automationId: string; triggers: AutomationTrigger[] };

	const baseCtx = (orgIdValue: string, userId: string): AuthContext => ({
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

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({ name: "automation update fields" });
		orgId = org.id;
		const owner = await createTestUser({ email: "wu-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);

		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "wu-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;

		const previewHostOrg = await createTestOrganization({
			name: "Automation update preview host",
		});
		const previewHostAgent = await createTestAgent({
			organizationId: previewHostOrg.id,
			agentId: "automation-update-preview-host",
		});
		await insertChatConnectionRow({
			id: previewConnectionId,
			organizationId: previewHostOrg.id,
			agentId: previewHostAgent.agentId,
			platform: "slack",
			settings: { previewMode: true },
		});
		previewUpdate = await createCrossOrgPreviewAutomation("update");
		previewVersion = await createCrossOrgPreviewAutomation("version");

		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "wu-target",
				name: "Original",
				prompt: "Original prompt.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		automationId = created.automation_id!;
	});

	async function fetchAutomationName(): Promise<string> {
		const sql = getTestDb();
		const rows = await sql`SELECT name FROM automations WHERE id = ${automationId}`;
		return (rows[0] as { name: string }).name;
	}

	async function createCrossOrgPreviewAutomation(suffix: string): Promise<{
		automationId: string;
		triggers: AutomationTrigger[];
	}> {
		const sql = getTestDb();
		await createTestAutomationSubscription({
			organizationId: orgId,
			agentId,
			connectionSlug: `agentconn-${previewConnectionId}`,
			platform: "slack",
			channelId: `slack:C-${suffix}`,
			configuredBy: ownerId,
		});
		const [automation] = await sql<{
			id: number;
			triggers: AutomationTrigger[];
		}>`
			SELECT id, triggers
			FROM automations
			WHERE organization_id = ${orgId}
			  AND managed_agent_id = ${agentId}
			  AND tags @> ARRAY['system:chat-link']::text[]
			ORDER BY id DESC
			LIMIT 1
		`;
		return { automationId: String(automation.id), triggers: automation.triggers };
	}

	it("returns saved execution settings in Automation detail and preserves an explicit clear", async () => {
		const execution_config = { effort: "xhigh", timeout_seconds: 17 };
		await executeTool("manage_automations", {
			action: "update", automation_id: automationId, execution_config,
		}, TEST_ENV, ownerCtx);
		const detail = await executeTool("get_automation", {
			automation_id: automationId,
		}, TEST_ENV, ownerCtx) as { automation?: { execution_config?: unknown } };
		expect(detail.automation?.execution_config).toEqual(execution_config);
		await executeTool("manage_automations", {
			action: "update", automation_id: automationId, execution_config: null,
		}, TEST_ENV, ownerCtx);
		const cleared = await executeTool("get_automation", {
			automation_id: automationId,
		}, TEST_ENV, ownerCtx) as { automation?: { execution_config?: unknown } };
		expect(cleared.automation?.execution_config).toBeNull();
	});

	it("rejects `update` with name only (version-owned) — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{ action: "update", automation_id: automationId, name: "Renamed" },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
		// Name unchanged — no silent partial apply.
		expect(await fetchAutomationName()).toBe("Original");
	});

	it("rejects `update` with description only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{ action: "update", automation_id: automationId, description: "New desc" },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with prompt only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{ action: "update", automation_id: automationId, prompt: "New prompt" },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with sources only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: automationId,
					sources: [{ name: "content", query: "SELECT id FROM events" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with name even when a real patch field is also present (no silent drop)", async () => {
		// name + triggers: triggers are valid, but name must NOT be silently
		// dropped — the whole call must reject so the caller learns name needs
		// create_version.
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: automationId,
					name: "Should Not Apply",
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
		expect(await fetchAutomationName()).toBe("Original");
	});

	it("still applies legitimate triggers without name", async () => {
		// Control: the reject path must not break real updates.
		const res = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: automationId,
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { updated_fields?: string[] };
		expect(res.updated_fields).toContain("triggers");
	});

	it("create_version with a new name cascades to the automations row", async () => {
		// Positive path: the documented way to rename an automation.
		await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				name: "Renamed Via Version",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		);
		expect(await fetchAutomationName()).toBe("Renamed Via Version");
	});

	it("updates metadata when a cross-org preview trigger is resent unchanged", async () => {
		const result = (await executeTool(
			"manage_automations",
			{
				action: "update",
				automation_id: previewUpdate.automationId,
				triggers: previewUpdate.triggers,
				tags: ["system:chat-link", "edited"],
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields?: string[] };
		expect(result.updated_fields).toContain("tags");

		const changedTriggers = previewUpdate.triggers.map((trigger) =>
			trigger.kind === "event"
				? {
						...trigger,
						match: { ...trigger.match, channel_id: "C-DIFFERENT" },
					}
				: trigger,
		);
		await expect(
			executeTool(
				"manage_automations",
				{
					action: "update",
					automation_id: previewUpdate.automationId,
					triggers: changedTriggers,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow("was not found in this organization");
	});

	it("creates a prompt-only version for a cross-org preview Automation", async () => {
		const result = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: previewVersion.automationId,
				prompt: "Updated preview response instructions.",
			},
			TEST_ENV,
			ownerCtx,
		)) as { version?: number };
		expect(result.version).toBe(2);
		const [stored] = await getTestDb()<{ prompt: string }>`
			SELECT prompt
			FROM automation_versions
			WHERE automation_id = ${previewVersion.automationId}
			  AND version = 2
		`;
		expect(stored.prompt).toBe("Updated preview response instructions.");
	});
});

/**
 * #2048 — create_version source semantics: explicit-set REPLACES (even []),
 * omitting INHERITS, and edits to source-token prompts derive from those tokens.
 * The bug was that `sources: []` (or a different list) passed WITHOUT a prompt
 * edit was conflated with "omitted" and silently re-inherited the stored sources.
 *
 * red→green: before the fix, "explicitly clears" and "explicitly replaces" both
 * inherited the original sources; after, the passed list is authoritative.
 */
describe("manage_automations create_version — source replacement semantics (#2048)", () => {
	let ownerCtx: AuthContext;
	let automationId: string;

	const baseCtx = (orgIdValue: string, userId: string): AuthContext => ({
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

	// Sources live on the per-assignment automations.sources column.
	async function fetchSources(): Promise<Array<{ name: string; query: string }>> {
		const sql = getTestDb();
		const rows = await sql`SELECT sources FROM automations WHERE id = ${automationId}`;
		const raw = (rows[0] as { sources: unknown }).sources;
		return (raw ?? []) as Array<{ name: string; query: string }>;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "cv sources #2048" });
		const owner = await createTestUser({ email: "cv-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);
		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "cv-agent",
			ownerUserId: owner.id,
		});
		// Create an automation with two explicit sources and a prompt WITHOUT @-chips,
		// so the derive-from-prompt path is not what supplies sources here.
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug: "cv-target",
				name: "CV Target",
				prompt: "Analyze the data.",
				managed_agent_id: agent.agentId,
				sources: [
					{ name: "alpha", query: "SELECT id FROM events" },
					{ name: "beta", query: "SELECT id FROM events WHERE 1=1" },
				],
			},
			TEST_ENV,
			ownerCtx,
		)) as { automation_id?: string };
		automationId = created.automation_id!;
	});

	it("baseline: the created automation has the two explicit sources", async () => {
		const names = (await fetchSources()).map((s) => s.name).sort();
		expect(names).toEqual(["alpha", "beta"]);
	});

	it("preserves stored sources when only plain prompt text changes", async () => {
		const result = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				prompt: "Analyze the data concisely.",
			},
			TEST_ENV,
			ownerCtx,
		)) as { source_count?: number; removed_sources?: string[] };

		expect(result.source_count).toBe(2);
		expect(result.removed_sources).toBeUndefined();
		expect((await fetchSources()).map((source) => source.name).sort()).toEqual([
			"alpha",
			"beta",
		]);
	});

	it("omitting sources on a metadata-only bump INHERITS the stored sources", async () => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				change_notes: "metadata only",
			},
			TEST_ENV,
			ownerCtx,
		)) as { source_count?: number; removed_sources?: string[] };
		expect(res.source_count).toBe(2);
		expect(res.removed_sources).toBeUndefined();
		const names = (await fetchSources()).map((s) => s.name).sort();
		expect(names).toEqual(["alpha", "beta"]);
	});

	it("passing a NEW source list REPLACES (drops the ones not listed)", async () => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				sources: [{ name: "alpha", query: "SELECT id FROM events" }],
			},
			TEST_ENV,
			ownerCtx,
		)) as { source_count?: number; removed_sources?: string[] };
		expect(res.source_count).toBe(1);
		expect(res.removed_sources).toEqual(["beta"]);
		const names = (await fetchSources()).map((s) => s.name);
		expect(names).toEqual(["alpha"]);
	});

	it("passing [] CLEARS all sources (the #2048 fix — no silent inherit)", async () => {
		const res = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				sources: [],
			},
			TEST_ENV,
			ownerCtx,
		)) as { source_count?: number; removed_sources?: string[] };
		expect(res.source_count).toBe(0);
		// Only "alpha" remained from the prior version; it is now removed.
		expect(res.removed_sources).toEqual(["alpha"]);
		expect(await fetchSources()).toEqual([]);
	});

	it("a chip in the prompt does not author sources — only `sources` does", async () => {
		// `prompt` is compiled skill text since #2331 (issue #2320 must-fix 2).
		// The block above left this Automation sourceless; give it one back.
		await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				sources: [{ name: "alpha", query: "SELECT id FROM events" }],
			},
			TEST_ENV,
			ownerCtx,
		);

		const chip = `@[sql:s1:Recent](#sql=${encodeURIComponent("SELECT id FROM events WHERE 1=0")})`;
		await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				prompt: `Look at ${chip} closely.`,
			},
			TEST_ENV,
			ownerCtx,
		);
		expect((await fetchSources()).map((s) => s.name)).toEqual(["alpha"]);

		// Clearing is an explicit act, not a side effect of editing text.
		const cleared = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				prompt: "Look at nothing in particular.",
				sources: [],
			},
			TEST_ENV,
			ownerCtx,
		)) as { source_count?: number; removed_sources?: string[] };
		expect(cleared.source_count).toBe(0);
		expect(cleared.removed_sources).toEqual(["alpha"]);
		expect(await fetchSources()).toEqual([]);
	});
});
