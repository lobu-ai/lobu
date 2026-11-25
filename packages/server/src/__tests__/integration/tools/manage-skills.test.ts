/**
 * manage_skills — reads of the workspace skill library, through the MCP tool
 * and the `client.skills` SDK namespace.
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

const ctxFor = (orgId: string, userId: string, memberRole: string, agentId: string | null = null): AuthContext => ({
	organizationId: orgId,
	tokenOrganizationId: orgId,
	userId,
	memberRole,
	agentId,
	requestedAgentId: agentId,
	isAuthenticated: true,
	clientId: null,
	scopes: ["mcp:read"],
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
});
