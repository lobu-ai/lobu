/**
 * The read-only workspace guardrail library: `GET /api/:org/guardrails[/:id]`
 * and `client.guardrails.list/get`. Readability is the `agent_config` read
 * policy for the workspace: members read, and an agent or app the policy
 * denies is refused.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { upsertEntityApprovalPolicy } from "../../../authz/entity-policy";
import { buildGuardrailsNamespace } from "../../../sandbox/namespaces/guardrails";
import type { AuthContext } from "../../../tools/execute";
import { toToolContext } from "../../../tools/execute";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { get } from "../../setup/test-helpers";
import {
	addUserToOrganization,
	createTestAccessToken,
	createTestAgent,
	createTestOAuthClient,
	createTestOrganization,
	createTestUser,
	createTestWorkspaceGuardrail,
} from "../../setup/test-fixtures";

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

const sdkFor = (ctx: AuthContext) => buildGuardrailsNamespace(toToolContext(ctx));

describe("guardrail library reads", () => {
	let orgId: string;
	let orgSlug: string;
	let memberId: string;
	let memberCtx: AuthContext;
	let deniedAgentCtx: AuthContext;
	let readerAgentCtx: AuthContext;
	let outsiderCtx: AuthContext;
	let judgeId: string;
	let archivedId: string;
	let foreignId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "guardrail reads" });
		orgId = org.id;
		orgSlug = org.slug;
		const member = await createTestUser({ email: "guardrails-member@test.com" });
		memberId = member.id;
		await addUserToOrganization(member.id, org.id, "member");
		memberCtx = ctxFor(org.id, member.id, "member");
		const reader = await createTestAgent({ organizationId: org.id, ownerUserId: member.id });
		const denied = await createTestAgent({ organizationId: org.id, ownerUserId: member.id });
		readerAgentCtx = ctxFor(org.id, member.id, "member", reader.agentId);
		deniedAgentCtx = ctxFor(org.id, member.id, "member", denied.agentId);
		await upsertEntityApprovalPolicy(org.id, {
			resourceClass: "agent_config",
			principalKind: "agent",
			principalId: denied.agentId,
			effects: { read: "deny" },
		});

		await createTestWorkspaceGuardrail({
			organizationId: org.id, name: "secret-scan", config: { builtin: "secret-scan" },
		});
		judgeId = (await createTestWorkspaceGuardrail({
			organizationId: org.id,
			name: "no-refunds",
			config: { kind: "judge", stage: "output", policy: "Never promise refunds." },
			appliesTo: [{ kind: "agent", id: reader.agentId }],
		})).id;
		archivedId = (await createTestWorkspaceGuardrail({
			organizationId: org.id, name: "retired", config: { builtin: "pii-scan" },
		})).id;
		await getTestDb()`UPDATE workspace_guardrails SET archived_at = now() WHERE id = ${archivedId}`;

		const foreignOrg = await createTestOrganization({ name: "foreign guardrails" });
		const outsider = await createTestUser({ email: "guardrails-outsider@test.com" });
		await addUserToOrganization(outsider.id, foreignOrg.id, "owner");
		outsiderCtx = { ...ctxFor(org.id, outsider.id, "owner"), tokenOrganizationId: foreignOrg.id };
		foreignId = (await createTestWorkspaceGuardrail({
			organizationId: foreignOrg.id, name: "no-refunds", config: { builtin: "secret-scan" },
		})).id;
	});

	async function tokenFor(clientName: string): Promise<string> {
		const client = await createTestOAuthClient({ client_name: clientName, redirect_uris: [] });
		return (await createTestAccessToken(memberId, orgId, client.client_id, { scope: "mcp:read" })).token;
	}

	it("lists by name across pages over REST and the SDK, archived only on request", async () => {
		const token = await tokenFor("guardrails-list");
		const first = await get(`/api/${orgSlug}/guardrails?limit=1`, { token });
		expect(first.status).toBe(200);
		const page = await first.json() as { items: Array<{ name: string }>; next_cursor: string | null };
		expect(page.items.map((item) => item.name)).toEqual(["no-refunds"]);
		const rest = await get(`/api/${orgSlug}/guardrails?cursor=${page.next_cursor}`, { token });
		expect((await rest.json() as { items: Array<{ name: string }> }).items.map((item) => item.name)).toEqual(["secret-scan"]);

		const listed = await sdkFor(memberCtx).list({ include_archived: true });
		expect(listed.items.map((item) => [item.name, item.archived])).toEqual([
			["no-refunds", false], ["retired", true], ["secret-scan", false],
		]);
		expect(listed.items[0]).toMatchObject({
			config: { kind: "judge", stage: "output", policy: "Never promise refunds." },
			applies_to: [{ principal_kind: "agent", principal_id: readerAgentCtx.agentId }],
			enabled: true,
			revision: 1,
		});
	});

	it("gets one guardrail by id, archived included, over REST and the SDK", async () => {
		const token = await tokenFor("guardrails-get");
		const rest = await get(`/api/${orgSlug}/guardrails/${judgeId}`, { token });
		expect(rest.status).toBe(200);
		expect(await rest.json()).toMatchObject({ guardrail: { id: judgeId, name: "no-refunds" } });
		expect(await sdkFor(memberCtx).get({ id: archivedId })).toMatchObject({
			guardrail: { name: "retired", archived: true },
		});
	});

	it("answers 404 for a missing guardrail or another workspace's", async () => {
		const token = await tokenFor("guardrails-404");
		for (const id of ["guardrail-missing", foreignId]) {
			expect((await get(`/api/${orgSlug}/guardrails/${id}`, { token })).status).toBe(404);
			await expect(sdkFor(memberCtx).get({ id })).rejects.toMatchObject({ httpStatus: 404 });
		}
	});

	it("answers 422 for a bad limit or cursor", async () => {
		const token = await tokenFor("guardrails-422");
		for (const query of ["limit=0", "limit=101", "cursor=not-a-cursor"]) {
			expect((await get(`/api/${orgSlug}/guardrails?${query}`, { token })).status).toBe(422);
		}
	});

	it("answers 403 to an agent the agent_config read policy denies and to a caller outside the workspace", async () => {
		await expect(sdkFor(deniedAgentCtx).list()).rejects.toMatchObject({ httpStatus: 403 });
		await expect(sdkFor(deniedAgentCtx).get({ id: judgeId })).rejects.toMatchObject({ httpStatus: 403 });
		await expect(sdkFor(outsiderCtx).list()).rejects.toMatchObject({ httpStatus: 403 });
		// The default agent_config read effect lets an agent without a rule read.
		await expect(sdkFor(readerAgentCtx).list()).resolves.toBeDefined();
	});

	it("answers 403 over REST, the library and the agent's installed catalog, to an app the agent_config read policy denies", async () => {
		const token = await tokenFor("guardrails-denied-app");
		const installed = (kinds: string) =>
			get(`/api/${orgSlug}/installed/agents/${readerAgentCtx.agentId}/installed?kinds=${kinds}`, { token });
		expect((await get(`/api/${orgSlug}/guardrails`, { token })).status).toBe(200);
		const before = await installed("guardrails");
		expect(before.status).toBe(200);
		expect(await before.json()).toMatchObject({
			installed: { guardrails: { items: expect.arrayContaining([expect.objectContaining({ id: judgeId })]) } },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "agent_config",
			principalKind: "app",
			principalId: "local:guardrails-denied-app",
			effects: { read: "deny" },
		});
		expect((await get(`/api/${orgSlug}/guardrails`, { token })).status).toBe(403);
		expect((await get(`/api/${orgSlug}/guardrails/${judgeId}`, { token })).status).toBe(403);
		expect((await installed("guardrails")).status).toBe(403);
		expect((await installed("providers")).status).toBe(200);
		// Another app is unaffected.
		const other = await tokenFor("guardrails-other-app");
		expect((await get(`/api/${orgSlug}/guardrails`, { token: other })).status).toBe(200);
	});
});
