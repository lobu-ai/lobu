/**
 * manage_skills — reads and writes of the workspace skill library, through the
 * MCP tool and the `client.skills` SDK namespace. Writes are compare-and-set on
 * `revision` and pass the `skill_config` write policy: a human applies, an
 * agent applies, queues an approval, or is refused.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import type { Env } from "../../../index";
import { buildSkillsNamespace } from "../../../sandbox/namespaces/skills";
import type { AuthContext } from "../../../tools/execute";
import { executeTool, toToolContext } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	createTestWorkspaceSkill,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	RATE_LIMIT_ENABLED: "false",
};

interface ListResult {
	items: Array<{ id: string; name: string; sort_order: number; archived: boolean; applies_to: unknown[] }>;
	next_cursor: string | null;
}

const WRITE_SCOPES = ["mcp:read", "mcp:write", "mcp:admin"];

interface SkillResult {
	skill: { id: string; name: string; revision: number; archived: boolean; applies_to: unknown[]; provenance?: string };
}

const ctxFor = (
	orgId: string,
	userId: string,
	memberRole: string,
	agentId: string | null = null,
	scopes: string[] = ["mcp:read"],
): AuthContext => ({
	organizationId: orgId,
	tokenOrganizationId: orgId,
	userId,
	memberRole,
	agentId,
	requestedAgentId: agentId,
	isAuthenticated: true,
	clientId: null,
	scopes,
	tokenType: "oauth",
	requestUrl: `http://localhost/api/${orgId}`,
	baseUrl: "",
	scopedToOrg: true,
	allowCrossOrg: false,
});

describe("manage_skills", () => {
	let orgId: string;
	let memberCtx: AuthContext;
	let agentCtx: AuthContext;
	let deniedAgentCtx: AuthContext;
	let outsiderCtx: AuthContext;
	let ownerCtx: AuthContext;
	let foreignOwnerCtx: AuthContext;
	let proposingAgentCtx: AuthContext;
	let refusedAgentCtx: AuthContext;
	let readerAgentId: string;
	let foreignSkillId: string;
	let archivedId: string;
	let triageId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "manage skills" });
		orgId = org.id;
		const member = await createTestUser({ email: "skills-member@test.com" });
		await addUserToOrganization(member.id, orgId, "member");
		memberCtx = ctxFor(orgId, member.id, "member");
		const agent = await createTestAgent({ organizationId: orgId, ownerUserId: member.id, agentId: "skills-reader" });
		const denied = await createTestAgent({ organizationId: orgId, ownerUserId: member.id, agentId: "skills-denied" });
		agentCtx = ctxFor(orgId, member.id, "member", agent.agentId);
		deniedAgentCtx = ctxFor(orgId, member.id, "member", denied.agentId);
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "skill_config",
			principalKind: "agent",
			principalId: denied.agentId,
			effects: { read: "deny" },
		});
		readerAgentId = agent.agentId;

		const owner = await createTestUser({ email: "skills-owner@test.com" });
		await addUserToOrganization(owner.id, orgId, "owner");
		ownerCtx = ctxFor(orgId, owner.id, "owner", null, WRITE_SCOPES);
		const proposer = await createTestAgent({ organizationId: orgId, ownerUserId: owner.id, agentId: "skills-proposer" });
		const refused = await createTestAgent({ organizationId: orgId, ownerUserId: owner.id, agentId: "skills-refused" });
		proposingAgentCtx = ctxFor(orgId, owner.id, "owner", proposer.agentId, WRITE_SCOPES);
		refusedAgentCtx = ctxFor(orgId, owner.id, "owner", refused.agentId, WRITE_SCOPES);
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "skill_config",
			principalKind: "agent",
			principalId: proposer.agentId,
			effects: { create: "approval", update: "approval", delete: "approval" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "skill_config",
			principalKind: "agent",
			principalId: refused.agentId,
			effects: { create: "deny" },
		});

		// Delivery order is (sort_order, name): beta-1, alpha-2, gamma-2, triage-3.
		await createTestWorkspaceSkill({ organizationId: orgId, name: "gamma", sortOrder: 2 });
		await createTestWorkspaceSkill({ organizationId: orgId, name: "alpha", sortOrder: 2 });
		await createTestWorkspaceSkill({ organizationId: orgId, name: "beta", sortOrder: 1 });
		triageId = (await createTestWorkspaceSkill({
			organizationId: orgId, name: "triage", sortOrder: 3, content: "Label first.",
			appliesTo: [{ kind: "agent", id: agent.agentId }],
		})).id;
		archivedId = (await createTestWorkspaceSkill({ organizationId: orgId, name: "retired", sortOrder: 0 })).id;
		await getTestDb()`UPDATE workspace_skills SET archived_at = now() WHERE id = ${archivedId}`;

		const foreignOrg = await createTestOrganization({ name: "foreign skills" });
		const outsider = await createTestUser({ email: "skills-outsider@test.com" });
		await addUserToOrganization(outsider.id, foreignOrg.id, "owner");
		outsiderCtx = { ...ctxFor(orgId, outsider.id, "owner"), tokenOrganizationId: foreignOrg.id };
		foreignOwnerCtx = ctxFor(foreignOrg.id, outsider.id, "owner", null, WRITE_SCOPES);
		foreignSkillId = (await createTestWorkspaceSkill({ organizationId: foreignOrg.id, name: "triage" })).id;
	});

	it("lists the library in (sort_order, name) order across pages, archived only on request", async () => {
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const page = (await executeTool(
				"manage_skills",
				{ action: "list", limit: 2, ...(cursor ? { cursor } : {}) },
				TEST_ENV,
				memberCtx,
			)) as ListResult;
			names.push(...page.items.map((item) => item.name));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(names).toEqual(["beta", "alpha", "gamma", "triage"]);

		const all = (await executeTool(
			"manage_skills",
			{ action: "list", include_archived: true },
			TEST_ENV,
			memberCtx,
		)) as ListResult;
		expect(all.items.map((item) => [item.name, item.archived])).toEqual([
			["retired", true], ["beta", false], ["alpha", false], ["gamma", false], ["triage", false],
		]);
		expect(all.next_cursor).toBeNull();
	});

	it("gets a skill by id or by name through the tool and the SDK", async () => {
		const sdk = buildSkillsNamespace(toToolContext(agentCtx), TEST_ENV);
		const byName = (await sdk.get({ name: "triage" })) as { skill: Record<string, unknown> };
		expect(byName.skill).toEqual({
			id: triageId,
			name: "triage",
			description: "The triage skill",
			content: "Label first.",
			applies_to: [{ principal_kind: "agent", principal_id: "skills-reader" }],
			enabled: true,
			sort_order: 3,
			revision: 1,
			archived: false,
		});
		expect(await sdk.get({ id: triageId })).toEqual(byName);
		// An archived skill reads by id, never by name.
		expect(await executeTool("manage_skills", { action: "get", id: archivedId }, TEST_ENV, memberCtx))
			.toMatchObject({ skill: { name: "retired", archived: true } });
		await expect(executeTool("manage_skills", { action: "get", name: "retired" }, TEST_ENV, memberCtx))
			.rejects.toMatchObject({ httpStatus: 404 });
		const listed = (await sdk.list({ limit: 1 })) as ListResult;
		expect(listed.items.map((item) => item.name)).toEqual(["beta"]);
	});

	it("answers 404 for a missing or another workspace's skill", async () => {
		for (const args of [{ id: "skill-missing" }, { id: foreignSkillId }, { name: "missing" }]) {
			await expect(executeTool("manage_skills", { action: "get", ...args }, TEST_ENV, memberCtx))
				.rejects.toMatchObject({ httpStatus: 404 });
		}
	});

	it("answers 422 for bad input", async () => {
		for (const args of [
			{ action: "get" },
			{ action: "get", id: triageId, name: "triage" },
			{ action: "list", cursor: "not-a-cursor" },
		]) {
			await expect(executeTool("manage_skills", args, TEST_ENV, memberCtx))
				.rejects.toMatchObject({ httpStatus: 422 });
		}
	});

	it("answers 403 to a denied agent and to a caller outside the workspace", async () => {
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, deniedAgentCtx))
			.rejects.toMatchObject({ httpStatus: 403 });
		await expect(executeTool("manage_skills", { action: "get", name: "triage" }, TEST_ENV, deniedAgentCtx))
			.rejects.toMatchObject({ httpStatus: 403 });
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, outsiderCtx))
			.rejects.toMatchObject({ httpStatus: 403 });
		// The default skill_config read effect is Auto: an agent without a rule reads.
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, agentCtx)).resolves.toBeDefined();
	});

	it.each([
		{ tokenType: "oauth" as const, appPrincipalId: "web:skills-reader.test" },
		{ tokenType: "pat" as const, appPrincipalId: "pat:9001" },
	])("enforces app-specific skill read restrictions for an unbound $tokenType caller", async ({ tokenType, appPrincipalId }) => {
		const appCtx: AuthContext = { ...memberCtx, tokenType, appPrincipalId };
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, appCtx)).resolves.toBeDefined();
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "skill_config",
			principalKind: "app",
			principalId: appPrincipalId,
			effects: { read: "deny" },
		});
		for (const args of [{ action: "list" }, { action: "get", name: "triage" }]) {
			await expect(executeTool("manage_skills", args, TEST_ENV, appCtx))
				.rejects.toMatchObject({ httpStatus: 403 });
		}
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, {
			...appCtx, appPrincipalId: "web:other-skills-reader.test",
		})).resolves.toBeDefined();
		await expect(executeTool("manage_skills", { action: "list" }, TEST_ENV, {
			...memberCtx, tokenType: "session",
		})).resolves.toBeDefined();
	});

	const put = (ctx: AuthContext, args: Record<string, unknown>) =>
		executeTool("manage_skills", { action: "put", ...args }, TEST_ENV, ctx);
	const body = (name: string, extra: Record<string, unknown> = {}) => ({
		name, description: `The ${name} skill`, content: `Follow the ${name} procedure.`, ...extra,
	});

	it("creates, replaces with compare-and-set, and refuses a stale revision", async () => {
		const created = (await put(ownerCtx, { expected_revision: 0, skill: body("escalation") })) as SkillResult;
		expect(created.skill).toMatchObject({
			name: "escalation", revision: 1, archived: false, applies_to: [{ principal_kind: null }],
		});
		const id = created.skill.id;

		const scoped = { applies_to: [{ principal_kind: "agent", principal_id: readerAgentId }] };
		const updated = (await put(ownerCtx, { id, expected_revision: 1, skill: body("escalation", scoped) })) as SkillResult;
		expect(updated.skill).toMatchObject({
			id, revision: 2, applies_to: [{ principal_kind: "agent", principal_id: readerAgentId }],
		});
		// An identical replace is a no-op: the revision stays.
		expect(await put(ownerCtx, { id, expected_revision: 2, skill: body("escalation", scoped) }))
			.toMatchObject({ skill: { revision: 2 } });

		// A writer holding revision 1 lost the race.
		await expect(put(ownerCtx, { id, expected_revision: 1, skill: body("escalation", { content: "Stale." }) }))
			.rejects.toMatchObject({ httpStatus: 409 });
		expect(await executeTool("manage_skills", { action: "get", id }, TEST_ENV, ownerCtx))
			.toMatchObject({ skill: { revision: 2, content: "Follow the escalation procedure." } });

		// A second create of a live name conflicts too.
		await expect(put(ownerCtx, { expected_revision: 0, skill: body("escalation") }))
			.rejects.toMatchObject({ httpStatus: 409 });

		const [change] = await getTestDb()`
			SELECT metadata FROM current_event_records
			WHERE organization_id = ${orgId} AND metadata->>'resource_kind' = 'skill' AND metadata->>'resource_id' = ${id}
			ORDER BY id DESC LIMIT 1
		`;
		expect(change?.metadata).toMatchObject({ resource_kind: "skill", resource_id: id });
	});

	it("archives with compare-and-set and frees the name", async () => {
		const { skill } = (await put(ownerCtx, { expected_revision: 0, skill: body("handoff") })) as SkillResult;
		const archived = (await executeTool(
			"manage_skills", { action: "archive", id: skill.id, expected_revision: 1 }, TEST_ENV, ownerCtx,
		)) as SkillResult;
		expect(archived.skill).toMatchObject({ id: skill.id, archived: true, revision: 2 });
		await expect(executeTool("manage_skills", { action: "archive", id: skill.id, expected_revision: 2 }, TEST_ENV, ownerCtx))
			.rejects.toMatchObject({ httpStatus: 409 });
		await expect(put(ownerCtx, { id: skill.id, expected_revision: 2, skill: body("handoff") }))
			.rejects.toMatchObject({ httpStatus: 409 });

		const recreated = (await put(ownerCtx, { expected_revision: 0, skill: body("handoff") })) as SkillResult;
		expect(recreated.skill.id).not.toBe(skill.id);
		expect(recreated.skill.revision).toBe(1);
	});

	it("installs a catalog skill with its provenance", async () => {
		const sdk = buildSkillsNamespace(toToolContext(ownerCtx), TEST_ENV);
		const installed = (await sdk.installFromCatalog({ catalog_id: "bundled/lobu" })) as SkillResult;
		expect(installed.skill).toMatchObject({ name: "lobu", provenance: "bundled/lobu", revision: 1 });
		await expect(sdk.installFromCatalog({ catalog_id: "bundled/lobu" })).rejects.toMatchObject({ httpStatus: 409 });
		await expect(sdk.installFromCatalog({ catalog_id: "bundled/missing" })).rejects.toMatchObject({ httpStatus: 404 });
	});

	it("writes through the SDK namespace", async () => {
		const sdk = buildSkillsNamespace(toToolContext(ownerCtx), TEST_ENV);
		const created = (await sdk.put({ expected_revision: 0, skill: body("sdk-written", { sort_order: 7 }) })) as SkillResult;
		expect(created.skill).toMatchObject({ name: "sdk-written", revision: 1 });
		expect(await sdk.archive({ id: created.skill.id, expected_revision: 1 }))
			.toMatchObject({ skill: { archived: true } });
	});

	it("answers 422 for a rename, a bad revision pairing and an unaccepted subject", async () => {
		const { skill } = (await put(ownerCtx, { expected_revision: 0, skill: body("fixed-name") })) as SkillResult;
		for (const args of [
			{ id: skill.id, expected_revision: 1, skill: body("renamed") },
			{ expected_revision: 1, skill: body("no-id") },
			{ id: skill.id, expected_revision: 0, skill: body("fixed-name") },
			{ expected_revision: 0, skill: body("Bad Name") },
			{ expected_revision: 0, skill: body("app-scoped", { applies_to: [{ principal_kind: "app", principal_id: "app-1" }] }) },
			{ expected_revision: 0, skill: body("ghost", { applies_to: [{ principal_kind: "agent", principal_id: "no-such-agent" }] }) },
		]) {
			await expect(put(ownerCtx, args)).rejects.toMatchObject({ httpStatus: 422 });
		}
	});

	it("answers 404 when a writer targets another workspace's skill", async () => {
		await expect(put(foreignOwnerCtx, { id: triageId, expected_revision: 1, skill: body("triage") }))
			.rejects.toMatchObject({ httpStatus: 404 });
		await expect(executeTool("manage_skills", { action: "archive", id: triageId, expected_revision: 1 }, TEST_ENV, foreignOwnerCtx))
			.rejects.toMatchObject({ httpStatus: 404 });
		await expect(put(ownerCtx, { id: foreignSkillId, expected_revision: 1, skill: body("triage") }))
			.rejects.toMatchObject({ httpStatus: 404 });
		expect(await executeTool("manage_skills", { action: "get", id: triageId }, TEST_ENV, ownerCtx))
			.toMatchObject({ skill: { revision: 1, archived: false } });
	});

	it("answers 403 to a member and to an agent or app the write policy denies", async () => {
		// The admin tier refuses a member before any policy runs (REST answers 403).
		const memberWriter = { ...memberCtx, scopes: WRITE_SCOPES };
		await expect(put(memberWriter, { expected_revision: 0, skill: body("member-made") }))
			.rejects.toMatchObject({ name: "AccessDeniedError", code: "PERMISSION" });
		await expect(put(refusedAgentCtx, { expected_revision: 0, skill: body("refused-made") }))
			.rejects.toMatchObject({ httpStatus: 403 });		// An unbound OAuth/PAT client is an app principal: its own write rule applies.
		const appWriter: AuthContext = { ...ownerCtx, tokenType: "pat", appPrincipalId: "pat:skills-writer" };
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "skill_config",
			principalKind: "app",
			principalId: "pat:skills-writer",
			effects: { create: "deny" },
		});
		await expect(put(appWriter, { expected_revision: 0, skill: body("app-made") }))
			.rejects.toMatchObject({ httpStatus: 403 });
		await expect(put({ ...appWriter, appPrincipalId: "pat:other-writer" }, { expected_revision: 0, skill: body("other-app-made") }))
			.resolves.toMatchObject({ skill: { name: "other-app-made" } });
	});

	it("queues an agent write for approval and applies it once a human approves", async () => {
		const pending = (await put(proposingAgentCtx, { expected_revision: 0, skill: body("proposed") })) as {
			status: string; run_id: number;
		};
		expect(pending.status).toBe("pending_approval");
		await expect(executeTool("manage_skills", { action: "get", name: "proposed" }, TEST_ENV, ownerCtx))
			.rejects.toMatchObject({ httpStatus: 404 });

		const approved = (await executeTool(
			"manage_operations", { action: "approve", run_id: pending.run_id }, TEST_ENV, ownerCtx,
		)) as { message?: string };
		expect(approved.message).not.toMatch(/failed/i);
		expect(await executeTool("manage_skills", { action: "get", name: "proposed" }, TEST_ENV, ownerCtx))
			.toMatchObject({ skill: { name: "proposed", revision: 1 } });
		const [run] = await getTestDb()`SELECT status FROM runs WHERE id = ${pending.run_id} AND organization_id = ${orgId}`;
		expect(run?.status).toBe("completed");
	});

	it("keeps library bodies out of every event copy and run read a read-denied agent can reach", async () => {
		const secret = "Only skill readers see this body.";
		const created = (await put(ownerCtx, {
			expected_revision: 0, skill: body("guarded", { content: secret }),
		})) as SkillResult;
		await put(ownerCtx, {
			id: created.skill.id, expected_revision: 1, skill: body("guarded", { content: `${secret} Revised.` }),
		});
		// An enabled-only update proposes the library's unchanged body.
		const pendingUpdate = (await put(proposingAgentCtx, {
			id: created.skill.id, expected_revision: 2,
			skill: body("guarded", { content: `${secret} Revised.`, enabled: false }),
		})) as { run_id: number; event_id: number };
		// An approved archive stores its output on the completed card.
		const pendingArchive = (await executeTool("manage_skills", {
			action: "archive", id: created.skill.id, expected_revision: 2,
		}, TEST_ENV, proposingAgentCtx)) as { run_id: number };
		await executeTool("manage_operations", { action: "approve", run_id: pendingArchive.run_id }, TEST_ENV, ownerCtx);

		const events = await getTestDb()<{ id: string }>`
			SELECT id FROM current_event_records
			WHERE organization_id = ${orgId}
				AND (metadata->>'resource_id' = ${created.skill.id}
					OR run_id IN (${pendingUpdate.run_id}, ${pendingArchive.run_id}))
		`;
		const ids = events.map((row) => Number(row.id));
		// Two writes and one archive audited, plus one card per approval.
		expect(ids).toHaveLength(5);
		const readAs = (ctx: AuthContext) => executeTool("read_knowledge", { content_ids: ids }, TEST_ENV, ctx) as Promise<{
			content: Array<{ id: number; run_id?: number | null; interaction_input?: unknown; payload_data?: { state?: unknown } }>;
		}>;
		const denied = await readAs(deniedAgentCtx);
		// Exact-id reads also return each approval card's superseded versions.
		expect(denied.content.map((item) => item.id)).toEqual(expect.arrayContaining(ids));
		expect(JSON.stringify(denied)).not.toContain(secret);
		expect(JSON.stringify(denied)).toMatch(/"content_sha256":"[0-9a-f]{64}"/);
		for (const action of [{ action: "list_runs" }, { action: "get_run", run_id: pendingUpdate.run_id }]) {
			expect(JSON.stringify(await executeTool("manage_operations", action, TEST_ENV, deniedAgentCtx))).not.toContain(secret);
		}

		// The reviewer still sees what it is approving, in the event and on the card.
		const owner = await readAs(ownerCtx);
		const card = owner.content.find((item) => item.id === pendingUpdate.event_id);
		expect(card?.interaction_input).toMatchObject({ write: { skill: { content: `${secret} Revised.`, enabled: false } } });
		expect(JSON.stringify(await executeTool("get_approval", { run_id: pendingUpdate.run_id }, TEST_ENV, ownerCtx)))
			.toContain(`${secret} Revised.`);
	});
});
