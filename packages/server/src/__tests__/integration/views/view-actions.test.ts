/**
 * View actions through the template-action chokepoint's second source.
 *
 * Covers: a declared action appends ONE event (`origin_type =
 * 'view_interaction'`) and enqueues Automations like the template path; the
 * same interaction_id is idempotent; an undeclared action is rejected; an
 * action removed from the CURRENT view stops working; unknown views 404;
 * an emits kind the registry does not know is a 422; unauthenticated callers
 * get 401; and every fire emits the `view:<key>` SSE invalidation.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { subscribe } from "../../../events/emitter";
import {
	invokeViewAction,
	type TrustedTemplateActor,
} from "../../../interactions/template-event-actions";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { ToolUserError } from "../../../utils/errors";
import { ensureMemberEntityType } from "../../../utils/member-entity-type";
import { primeMemberEventKinds } from "../../../utils/event-kind-validation";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
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

const VIEW_SOURCE = `export default function Retry() { return null; }
export const view = { attach: [], params: {}, actions: { retry: { emits: "test.poked" } } };
`;

function actor(userId: string): TrustedTemplateActor {
	return { platform: "lobu", platformUserId: userId, userId };
}

describe("view actions", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let memberCtx: AuthContext;
	let readOnlyMemberCtx: AuthContext;

	const baseCtx = (userId: string): AuthContext => ({
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
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
	});

	async function setView(
		key: string,
		source: string,
		actions: Record<string, { emits: string }>
	) {
		return (await executeTool(
			"manage_views",
			{ action: "set", key, source_code: source, actions },
			TEST_ENV,
			ownerCtx
		)) as { written: boolean };
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "view actions e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "view-actions@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(owner.id);
		const member = await createTestUser({ email: "view-actions-member@test.com" });
		await addUserToOrganization(member.id, org.id, "member");
		memberCtx = {
			...baseCtx(member.id),
			memberRole: "member",
			scopes: ["mcp:read", "mcp:write"],
		};
		readOnlyMemberCtx = {
			...baseCtx(member.id),
			memberRole: "member",
			scopes: ["mcp:read"],
		};
		// Declare the kinds under test on the org-wide $member registry so
		// the chokepoint exercises real kind validation, not permissive mode.
		// ensureMemberEntityType primes the pod cache with the DEFAULT kinds,
		// so re-prime with the merged registry after updating the row.
		await ensureMemberEntityType(org.id);
		const viewKinds = {
			"test.poked": { description: "A view action fired" },
		};
		const sql = getTestDb();
		await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json(viewKinds)}
      WHERE slug = '$member' AND organization_id = ${org.id}
    `;
		primeMemberEventKinds(org.id, viewKinds);
	});

	it("appends one view_interaction event for a declared action", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const result = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: { id: 7 },
			interactionId: "click-1",
			surface: "web",
			actor: actor(ownerId),
		});
		expect(result.created).toBe(true);
		expect(result.eventType).toBe("test.poked");

		const sql = getTestDb();
		const rows = await sql`
      SELECT id, origin_type, semantic_type, origin_id, metadata
      FROM events
      WHERE id = ${result.eventId}
    `;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			origin_type: "view_interaction",
			semantic_type: "test.poked",
			origin_id: "view-action:poke-view:web:click-1",
		});
		expect(
			(rows[0].metadata as { interaction: { view: string; action: string } })
				.interaction
		).toMatchObject({ view: "poke-view", action: "retry" });
	});

	it("dedupes a retried interaction_id", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const first = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: null,
			interactionId: "click-9",
			surface: "web",
			actor: actor(ownerId),
		});
		const second = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: null,
			interactionId: "click-9",
			surface: "web",
			actor: actor(ownerId),
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.eventId).toBe(first.eventId);
	});

	it("rejects an undeclared action and an unknown view", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const undeclared = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "launch",
			value: null,
			interactionId: "click-2",
			surface: "web",
			actor: actor(ownerId),
		}).catch((e) => e);
		expect(undeclared).toBeInstanceOf(ToolUserError);
		expect((undeclared as ToolUserError).httpStatus).toBe(403);
		expect((undeclared as ToolUserError).message).toMatch(/does not declare/);

		const unknown = await invokeViewAction({
			organizationId: orgId,
			viewKey: "no-such-view",
			action: "retry",
			value: null,
			interactionId: "click-3",
			surface: "web",
			actor: actor(ownerId),
		}).catch((e) => e);
		expect(unknown).toBeInstanceOf(ToolUserError);
		expect((unknown as ToolUserError).httpStatus).toBe(404);
	});

	it("stops a removed action from working", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const before = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: null,
			interactionId: "click-before",
			surface: "web",
			actor: actor(ownerId),
		});
		expect(before.created).toBe(true);

		// Re-save the same view without the action (edited source so the
		// same-hash short-circuit does not skip the rewrite).
		const resaved = await setView(
			"poke-view",
			`${VIEW_SOURCE}\n// action removed\n`,
			{}
		);
		expect(resaved.written).toBe(true);
		await expect(invokeViewAction({
			organizationId: orgId, viewKey: "poke-view", action: "retry", value: null,
			interactionId: "click-before", surface: "web", actor: actor(ownerId),
		})).resolves.toEqual({ ...before, created: false });

		const after = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: null,
			interactionId: "click-after",
			surface: "web",
			actor: actor(ownerId),
		}).catch((e) => e);
		expect(after).toBeInstanceOf(ToolUserError);
		expect((after as ToolUserError).httpStatus).toBe(403);
	});

	it("rejects an interaction id reused by another actor or for a different value", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const params = { organizationId: orgId, viewKey: "poke-view", action: "retry", value: { id: 7 }, interactionId: "owned-click", surface: "web", actor: actor(ownerId) };
		await invokeViewAction(params);
		await expect(invokeViewAction({ ...params, actor: actor(memberCtx.userId!) })).rejects.toMatchObject({ httpStatus: 409 });
		await expect(invokeViewAction({ ...params, value: { id: 8 } })).rejects.toMatchObject({ httpStatus: 409 });
	});

	it("rejects an emits kind the registry does not know", async () => {
		await setView("poke-view", VIEW_SOURCE, {
			mystery: { emits: "test.never-declared" },
		});
		const err = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "mystery",
			value: null,
			interactionId: "click-4",
			surface: "web",
			actor: actor(ownerId),
		}).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
	});

	it("fires over the MCP tool and emits the view SSE key", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const seen: string[][] = [];
		const unsubscribe = subscribe(orgId, (event) => seen.push(event.keys));
		try {
			const result = (await executeTool(
				"invoke_view_action",
				{ view: "poke-view", action: "retry", interaction_id: "mcp-1" },
				TEST_ENV,
				ownerCtx
			)) as { created: boolean; event_id: number; event_type: string };
			expect(result.created).toBe(true);
			expect(result.event_type).toBe("test.poked");
			expect(result.event_id).toBeGreaterThan(0);
		} finally {
			unsubscribe();
		}
		expect(seen).toContainEqual(["view:poke-view"]);
	});

	it("requires a signed-in caller on the MCP tool", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const anonCtx: AuthContext = {
			...ownerCtx,
			userId: null,
			isAuthenticated: false,
		};
		const err = await executeTool(
			"invoke_view_action",
			{ view: "poke-view", action: "retry", interaction_id: "mcp-2" },
			TEST_ENV,
			anonCtx
		).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(401);
	});

	it("lets a write-scoped member invoke a declared action over the MCP tool (F13)", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const result = (await executeTool(
			"invoke_view_action",
			{
				view: "poke-view",
				action: "retry",
				value: { id: 7 },
				interaction_id: "member-1",
			},
			TEST_ENV,
			memberCtx
		)) as { created: boolean; event_id: number; event_type: string };
		expect(result.created).toBe(true);
		expect(result.event_type).toBe("test.poked");
		expect(result.event_id).toBeGreaterThan(0);

		const sql = getTestDb();
		const rows = await sql`
      SELECT origin_type, semantic_type
      FROM events
      WHERE id = ${result.event_id}
    `;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			origin_type: "view_interaction",
			semantic_type: "test.poked",
		});
	});

	it("rejects a read-only member on the MCP tool without touching events (F13)", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const err = await executeTool(
			"invoke_view_action",
			{ view: "poke-view", action: "retry", interaction_id: "member-readonly-1" },
			TEST_ENV,
			readOnlyMemberCtx
		).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/read-only/i);
	});

	it("rejects undeclared and removed actions for a write-scoped member (F13)", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		// Missing action: never declared on the CURRENT view row.
		const missing = await executeTool(
			"invoke_view_action",
			{ view: "poke-view", action: "launch", interaction_id: "member-missing-1" },
			TEST_ENV,
			memberCtx
		).catch((e) => e);
		expect(missing).toBeInstanceOf(ToolUserError);
		expect((missing as ToolUserError).httpStatus).toBe(403);
		expect((missing as ToolUserError).message).toMatch(/does not declare/);

		// Removed action: declared, then resaved without it.
		const resaved = await setView(
			"poke-view",
			`${VIEW_SOURCE}\n// action removed\n`,
			{}
		);
		expect(resaved.written).toBe(true);
		const removed = await executeTool(
			"invoke_view_action",
			{ view: "poke-view", action: "retry", interaction_id: "member-removed-1" },
			TEST_ENV,
			memberCtx
		).catch((e) => e);
		expect(removed).toBeInstanceOf(ToolUserError);
		expect((removed as ToolUserError).httpStatus).toBe(403);
	});
});
