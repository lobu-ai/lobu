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
import { DEFAULT_AUTOMATION_SOURCE_QUERY } from "../../../automations/source-refs";
import { initWorkspaceProvider } from "../../../workspace";
import { createTestAutomationSubscription } from "../../setup/automation-subscriptions";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
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

// Each test reads the shared fixture before planning its edit. Sequential writes
// within one test advance only from their own successful mutation receipts.
async function readRevision(automationId: string, ctx: AuthContext): Promise<string> {
	const detail = await executeTool("get_automation", {
		automation_id: automationId,
	}, TEST_ENV, ctx) as { automation?: { revision?: unknown } };
	if (typeof detail.automation?.revision !== "string") {
		throw new Error("Automation fixture did not return its revision");
	}
	return detail.automation.revision;
}

describe("manage_automations update — version-owned fields are not silently dropped", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let agentId: string;
	let automationId: string;
	const previewConnectionId = "preview-update-version";
	let previewUpdate: { automationId: string; triggers: AutomationTrigger[] };
	let previewVersion: { automationId: string; triggers: AutomationTrigger[] };

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
		const updated = await executeTool("manage_automations", {
			action: "update", automation_id: automationId, expected_revision: await readRevision(automationId, ownerCtx), execution_config,
		}, TEST_ENV, ownerCtx) as { revision: string };
		const detail = await executeTool("get_automation", {
			automation_id: automationId,
		}, TEST_ENV, ownerCtx) as { automation?: { execution_config?: unknown } };
		expect(detail.automation?.execution_config).toEqual(execution_config);
		await executeTool("manage_automations", {
			action: "update", automation_id: automationId, expected_revision: updated.revision, execution_config: null,
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
				{ action: "update", automation_id: automationId, expected_revision: await readRevision(automationId, ownerCtx), name: "Renamed" },
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
				{ action: "update", automation_id: automationId, expected_revision: await readRevision(automationId, ownerCtx), description: "New desc" },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/create_version/i);
	});

	it("rejects `update` with prompt only — points to create_version", async () => {
		await expect(
			executeTool(
				"manage_automations",
				{ action: "update", automation_id: automationId, expected_revision: await readRevision(automationId, ownerCtx), prompt: "New prompt" },
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
					expected_revision: await readRevision(automationId, ownerCtx),
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
					expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(previewUpdate.automationId, ownerCtx),
				triggers: previewUpdate.triggers,
				tags: ["system:chat-link", "edited"],
			},
			TEST_ENV,
			ownerCtx,
		)) as { updated_fields?: string[]; revision: string };
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
					expected_revision: result.revision,
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
				expected_revision: await readRevision(previewVersion.automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
				expected_revision: await readRevision(automationId, ownerCtx),
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
		const restored = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				expected_revision: await readRevision(automationId, ownerCtx),
				sources: [{ name: "alpha", query: "SELECT id FROM events" }],
			},
			TEST_ENV,
			ownerCtx,
		)) as { revision: string };

		const chip = `@[sql:s1:Recent](#sql=${encodeURIComponent("SELECT id FROM events WHERE 1=0")})`;
		const reworded = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				expected_revision: restored.revision,
				prompt: `Look at ${chip} closely.`,
			},
			TEST_ENV,
			ownerCtx,
		)) as { revision: string };
		expect((await fetchSources()).map((s) => s.name)).toEqual(["alpha"]);

		// Clearing is an explicit act, not a side effect of editing text.
		const cleared = (await executeTool(
			"manage_automations",
			{
				action: "create_version",
				automation_id: automationId,
				expected_revision: reworded.revision,
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

/**
 * Sources are Automation-authored and per-assignment (#2320 must-fix 2), so
 * version reads must report them from the assignment and resolve versions on
 * the group root, or an assignment lists a version it then cannot fetch.
 */
describe("manage_automations — version reads report assignment-owned sources", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	let agentId: string;
	const RECENT_QUERY = "SELECT id FROM events ORDER BY occurred_at DESC";

	const call = (args: Record<string, unknown>) =>
		executeTool("manage_automations", args, TEST_ENV, ownerCtx);

	async function createAutomation(slug: string): Promise<{ automation_id: string; revision: string }> {
		return (await call({
			action: "create",
			slug,
			name: "Digest",
			prompt: "Write the digest.",
			managed_agent_id: agentId,
		})) as { automation_id: string; revision: string };
	}

	async function expectEveryListedVersionResolves(automationId: string) {
		const listed = (await call({ action: "get_versions", automation_id: automationId })) as {
			versions: Array<{ version: number }>;
		};
		expect(listed.versions.length).toBeGreaterThan(0);
		for (const { version } of listed.versions) {
			const details = (await call({
				action: "get_version_details",
				automation_id: automationId,
				version,
			})) as { version: number };
			expect(details.version).toBe(version);
		}
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "automation source honesty" });
		orgId = org.id;
		const owner = await createTestUser({ email: "bsh-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);
		agentId = (
			await createTestAgent({ organizationId: org.id, agentId: "bsh-agent", ownerUserId: owner.id })
		).agentId;
	});

	it("defaults to the content source and get_version_details reports the stored sources", async () => {
		const { automation_id: automationId, revision } = await createAutomation("bsh-digest");
		const [created] = await getTestDb()`SELECT sources FROM automations WHERE id = ${automationId}`;
		expect(created.sources).toEqual([{ name: "content", query: DEFAULT_AUTOMATION_SOURCE_QUERY }]);

		await call({
			action: "create_version",
			automation_id: automationId,
			expected_revision: revision,
			sources: [{ name: "recent", query: RECENT_QUERY }],
		});
		const details = (await call({ action: "get_version_details", automation_id: automationId })) as {
			version: number;
			sources: Array<{ name: string; query: string }>;
		};
		expect(details.version).toBeGreaterThan(1);
		expect(details.sources).toEqual([{ name: "recent", query: RECENT_QUERY }]);
		await expectEveryListedVersionResolves(automationId);
	});

	it("gets group-root versions through an assignment id", async () => {
		const { automation_id: automationId, revision } = await createAutomation("bsh-assignment");
		await call({ action: "create_version", automation_id: automationId, expected_revision: revision, prompt: "Write the digest, briefly." });
		const entity = await createTestEntity({ name: "Source Honesty Co", organization_id: orgId });
		const [root] = await getTestDb()<{ current_version_id: number }>`
			SELECT current_version_id FROM automations WHERE id = ${automationId}
		`;
		const assigned = (await call({
			action: "create_from_version",
			version_id: String(root.current_version_id),
			entity_ids: [entity.id],
		})) as { created: Array<{ automation_id: string }> };
		const assignmentId = assigned.created[0].automation_id;
		expect(assignmentId).not.toBe(automationId);

		await expectEveryListedVersionResolves(assignmentId);
	});
});
