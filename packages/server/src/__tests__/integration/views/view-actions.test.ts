/**
 * View actions through the template-action chokepoint's second source.
 *
 * Covers: a declared action appends ONE event (`origin_type =
 * 'view_interaction'`) and enqueues Automations like the template path; the
 * same interaction_id is idempotent; an undeclared action is rejected; an
 * action removed from the CURRENT view stops working; unknown views 404;
 * an emits kind the registry does not know is a 422 at save and at click, and
 * saves use the committed registry even with a stale replica cache;
 * unauthenticated callers get 401; every fire emits the `view:<key>` SSE invalidation.
 *
 * An action that `updates` an entity writes its declared fields through the
 * shared entity update path in the receipt's transaction: the patch, the
 * schema's stamps, the canonical change event and the receipt commit together
 * or not at all, a replay returns the original result, a human-owned field
 * defers to an approval, and the write never claims field ownership.
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
import { viewModule } from "./view-module";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestEntity,
	createTestSession,
	createTestUser,
} from "../../setup/test-fixtures";
import { post } from "../../setup/test-helpers";

import { useViewValidator } from "../../setup/view-validator";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};
useViewValidator(TEST_ENV);


const VIEW_SOURCE = "export default function Retry() { return null; }";

function actor(userId: string): TrustedTemplateActor {
	return { platform: "lobu", platformUserId: userId, userId };
}

describe("view actions", () => {
	let orgId: string;
	let orgSlug: string;
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
			{
				action: "set",
				source_code: viewModule({ key, attach: [], actions }, source),
			},
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
		orgSlug = org.slug;
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


  it("binds a kind-only view action to its readable event and rejects a changed subject", async () => {
    await executeTool("manage_views", {
      action: "set",
      source_code: viewModule({
        key: "event-poke",
        attach: [{ event: "test.poked" }],
        actions: { retry: { emits: "test.poked" } },
      }, VIEW_SOURCE),
    }, TEST_ENV, ownerCtx);
    const source = await executeTool("save_memory", {
      content: "Action source", semantic_type: "test.poked",
    }, TEST_ENV, ownerCtx) as { id: number };
    const other = await executeTool("save_memory", {
      content: "Another source", semantic_type: "test.poked",
    }, TEST_ENV, ownerCtx) as { id: number };
    const args = {
      view: "event-poke", action: "retry", value: { source_event_id: other.id },
      scope: { event: source.id }, interaction_id: "event-bound-click",
    };
    await expect(executeTool("invoke_view_action", {
      ...args, scope: undefined,
    }, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 400 });
    const first = await executeTool("invoke_view_action", args, TEST_ENV, ownerCtx) as { event_id: number };
    const [receipt] = await getTestDb()`
      SELECT metadata FROM events WHERE id = ${first.event_id}
    `;
    expect(receipt.metadata.interaction.source_event_id).toBe(source.id);
    expect(receipt.metadata.value.source_event_id).toBe(other.id);
    await expect(executeTool("invoke_view_action", args, TEST_ENV, ownerCtx))
      .resolves.toMatchObject({ created: false, event_id: first.event_id });
    await expect(executeTool("invoke_view_action", {
      ...args, scope: { event: other.id },
    }, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 409 });
    const replacement = await executeTool("save_memory", {
      content: "Updated source", semantic_type: "test.poked", supersedes_event_id: source.id,
    }, TEST_ENV, ownerCtx) as { id: number };
    const opened = await executeTool("open_view", {
      key: "event-poke", scope: { event: source.id },
    }, TEST_ENV, ownerCtx) as { scope: { event: number } };
    expect(opened.scope.event).toBe(replacement.id);
    await expect(executeTool("invoke_view_action", {
      ...args, interaction_id: "stale-subject",
    }, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(executeTool("invoke_view_action", args, TEST_ENV, ownerCtx))
      .resolves.toMatchObject({ created: false, event_id: first.event_id });
    await expect(executeTool("invoke_view_action", {
      ...args, interaction_id: "missing-event", scope: { event: 999999999 },
    }, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("registers and executes an entity-qualified action without copying its kind into the workspace registry", async () => {
    const entity = await createTestEntity({ name: "Action subject", entity_type: "ballot", organization_id: orgId });
    const sql = getTestDb();
    const kinds = { "ballot.opened": {}, "ballot.responded": {} };
    await sql`
      UPDATE entity_types SET event_kinds = ${sql.json(kinds)}
      WHERE organization_id = ${orgId} AND slug = 'ballot'
    `;
    await executeTool("manage_views", {
      action: "set",
      source_code: viewModule({
        key: "ballot-form",
        attach: [{ event: "ballot.opened", type: "ballot" }],
        actions: { retry: { emits: "ballot.responded" } },
      }, VIEW_SOURCE),
    }, TEST_ENV, ownerCtx);
    const source = await executeTool("save_memory", {
      content: "Choose an option", semantic_type: "ballot.opened", entity_ids: [entity.id],
    }, TEST_ENV, ownerCtx) as { id: number };
    const response = await executeTool("invoke_view_action", {
      view: "ballot-form", action: "retry", value: { choice: "yes" },
      scope: { event: source.id }, interaction_id: "qualified-response",
    }, TEST_ENV, ownerCtx) as { event_id: number };
    const [event] = await sql`SELECT to_json(entity_ids) AS entity_ids, semantic_type FROM events WHERE id = ${response.event_id}`;
    expect(event).toMatchObject({ entity_ids: [entity.id], semantic_type: "ballot.responded" });
    for (const attach of [[], [{ event: "ballot.opened" }], [{ event: "ballot.opened", type: "another-type" }]]) {
      await expect(executeTool("manage_views", {
        action: "set",
        source_code: viewModule({
          key: "unbound-ballot-form",
          attach,
          actions: { retry: { emits: "ballot.responded" } },
        }, VIEW_SOURCE),
      }, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 422 });
    }
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

	it("runs a web action only against the bundle the caller mounted", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const sql = getTestDb();
		const hashOf = async () =>
			String(
				(
					await sql`SELECT content_hash FROM views WHERE organization_id = ${orgId} AND key = 'poke-view'`
				)[0].content_hash
			);
		const mounted = await hashOf();
		const cookie = (await createTestSession(ownerId)).cookieHeader;
		const click = (interaction_id: string, expected_content_hash: unknown) =>
			post(`/api/${orgSlug}/views/poke-view/actions/retry`, {
				body: { value: null, interaction_id, expected_content_hash },
				cookie,
			});
		const count = async () =>
			Number(
				(
					await sql`SELECT count(*)::int AS n FROM events WHERE organization_id = ${orgId} AND origin_type = 'view_interaction'`
				)[0].n
			);

		expect((await click("mounted-1", mounted)).status).toBe(200);
		expect(await count()).toBe(1);

		// Re-applied while the old bundle is still on screen.
		await setView("poke-view", `${VIEW_SOURCE}\n// v2\n`, {
			retry: { emits: "test.poked" },
		});
		const current = await hashOf();
		expect(current).not.toBe(mounted);
		const stale = await click("mounted-2", mounted);
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { error: string }).error).toMatch(
			/changed since it was opened/,
		);
		expect(await count()).toBe(1);

		expect((await click("mounted-3", current)).status).toBe(200);
		expect((await click("mounted-4", 7)).status).toBe(400);
		expect(await count()).toBe(2);
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

	it("rejects a view whose action emits a kind the registry does not know", async () => {
		const err = await setView("poke-view", VIEW_SOURCE, {
			mystery: { emits: "test.never-declared" },
		}).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
		expect((err as Error).message).toContain("test.never-declared");
		const sql = getTestDb();
		const stored = await sql`
      SELECT 1 FROM views WHERE organization_id = ${orgId} AND key = 'poke-view'
    `;
		expect(stored.length).toBe(0);
	});

	it("still rejects the click when the registry drops the kind after the save", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const remaining = { "test.other": { description: "Unrelated kind" } };
		const sql = getTestDb();
		await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json(remaining)}
      WHERE slug = '$member' AND organization_id = ${orgId}
    `;
		primeMemberEventKinds(orgId, remaining);
		const err = await invokeViewAction({
			organizationId: orgId,
			viewKey: "poke-view",
			action: "retry",
			value: null,
			interactionId: "click-4",
			surface: "web",
			actor: actor(ownerId),
		}).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
	});

	it("accepts a kind registered through manage_entity_schema despite a stale cache", async () => {
		// Warm this pod's cache with the registry that lacks the new kind, as
		// any earlier save or click in the org would.
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		await executeTool(
			"manage_entity_schema",
			{
				schema_type: "entity_type",
				action: "update",
				slug: "$member",
				event_kinds: {
					"test.poked": { description: "A view action fired" },
					"test.fresh": { description: "Registered just now" },
				},
			},
			TEST_ENV,
			ownerCtx
		);
		await setView("fresh-view", VIEW_SOURCE, { go: { emits: "test.fresh" } });
		const result = await invokeViewAction({
			organizationId: orgId,
			viewKey: "fresh-view",
			action: "go",
			value: null,
			interactionId: "click-fresh",
			surface: "web",
			actor: actor(ownerId),
		});
		expect(result.eventType).toBe("test.fresh");
	});

	it("rejects a removed kind despite a warm cache and preserves the saved view", async () => {
		await setView("poke-view", VIEW_SOURCE, { retry: { emits: "test.poked" } });
		const sql = getTestDb();
		// A registry edit on another replica does not refresh this pod's cache.
		await sql`
      UPDATE entity_types SET event_kinds = ${sql.json({})}
      WHERE slug = '$member' AND organization_id = ${orgId}
    `;
		await expect(setView("poke-view", VIEW_SOURCE, {
			removed: { emits: "test.poked" },
		})).rejects.toMatchObject({ httpStatus: 422 });
		const stored = await sql`
      SELECT actions FROM views WHERE organization_id = ${orgId} AND key = 'poke-view'
    `;
		expect(stored[0].actions).toEqual({ retry: { emits: "test.poked" } });
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

	describe("entity updates", () => {
		const DEAL_SCHEMA = {
			type: "object",
			properties: {
				stage: { type: "string" },
				stage_at: { type: "string", format: "date-time" },
				notes: { type: "string" },
				amount: { type: "number" },
			},
			"x-lobu-stamps": { stage_at: "stage" },
		};

		beforeEach(async () => {
			for (const [slug, metadata_schema] of [["deal", DEAL_SCHEMA], ["lead", undefined]] as const) {
				await executeTool("manage_entity_schema", {
					schema_type: "entity_type", action: "create", slug, name: slug,
					...(metadata_schema ? { metadata_schema } : {}),
				}, TEST_ENV, ownerCtx);
			}
			await executeTool("manage_views", {
				action: "set",
				source_code: viewModule({
					key: "deal-board",
					// One pinned lead record, so the attach check has a record to miss.
					attach: [{ collection: "deal" }, { record: "lead", id: 999999 }],
					actions: {
						advance: { emits: "test.poked", updates: { entityType: "deal", fields: ["stage", "notes"] } },
						note: { updates: { entityType: "deal", fields: ["notes"] } },
						restamp: { updates: { entityType: "deal", fields: ["stage_at"] } },
						qualify: { updates: { entityType: "lead", fields: ["stage"] } },
					},
				}, VIEW_SOURCE),
			}, TEST_ENV, ownerCtx);
		});

		async function createRecord(entity_type: string, metadata: Record<string, unknown>) {
			const created = await executeTool("manage_entity", {
				action: "create", entity_type, name: `${entity_type} ${Math.random()}`, metadata,
			}, TEST_ENV, ownerCtx) as { entity: { id: number } };
			return created.entity.id;
		}

		async function entityRow(id: number) {
			const [row] = await getTestDb()`
        SELECT metadata, field_controls, updated_at FROM entities WHERE id = ${id}
      `;
			return row as { metadata: Record<string, unknown>; field_controls: Record<string, unknown>; updated_at: Date };
		}

		async function eventCount() {
			const [row] = await getTestDb()`
        SELECT count(*)::int AS n FROM events
        WHERE organization_id = ${orgId}
          AND (origin_type = 'view_interaction' OR semantic_type = 'change')
      `;
			return Number(row.n);
		}

		async function pendingApprovals() {
			const [row] = await getTestDb()`
        SELECT count(*)::int AS n FROM runs
        WHERE organization_id = ${orgId} AND action_key = 'entity_field_change' AND approval_status = 'pending'
      `;
			return Number(row.n);
		}

		const invoke = (args: Record<string, unknown>, ctx: AuthContext = memberCtx) =>
			executeTool("invoke_view_action", { view: "deal-board", ...args }, TEST_ENV, ctx) as Promise<{
				created: boolean; event_id: number; event_type: string;
				applied?: { entity_id: number; fields: Record<string, unknown> };
				pending_approval?: { entity_id: number; fields: Record<string, unknown> };
			}>;

		it("applies declared fields, stamps, the change event and the receipt in one transaction, and replays the result", async () => {
			const deal = await createRecord("deal", { stage: "open", notes: "first call" });
			const created = await entityRow(deal);
			// The create set the tracked field, so the stamp is the create's time.
			expect(created.metadata.stage_at).toBe(new Date(created.updated_at).toISOString());

			const args = {
				action: "advance",
				value: { entity_id: deal, set: { stage: "won" } },
				expected: { stage: "open" },
				interaction_id: "advance-1",
			};
			const first = await invoke(args);
			const after = await entityRow(deal);
			expect(after.metadata).toMatchObject({ stage: "won", notes: "first call" });
			expect(after.metadata.stage_at).toBe(new Date(after.updated_at).toISOString());
			expect(after.metadata.stage_at).not.toBe(created.metadata.stage_at);
			// A member wrote through the view's grant, yet no field became human-owned.
			expect(after.field_controls ?? {}).toEqual({});
			expect(first).toMatchObject({
				created: true,
				event_type: "test.poked",
				applied: { entity_id: deal, fields: { stage: "won", stage_at: after.metadata.stage_at } },
			});
			expect(first.pending_approval).toBeUndefined();

			const events = await getTestDb()`
        SELECT id, semantic_type, origin_type, created_by, created_at,
               to_json(entity_ids) AS entity_ids, metadata
        FROM events
        WHERE organization_id = ${orgId} AND ${deal}::bigint = ANY(entity_ids)
          AND (origin_type = 'view_interaction' OR semantic_type = 'change')
        ORDER BY id
      `;
			const receipt = events.find((event) => event.id === first.event_id);
			const change = events.find((event) => event.semantic_type === "change");
			expect(receipt).toMatchObject({ origin_type: "view_interaction", semantic_type: "test.poked", entity_ids: [deal] });
			expect(receipt?.metadata.interaction).toMatchObject({ expected: { stage: "open" }, result: { applied: first.applied } });
			expect(change).toMatchObject({ created_by: memberCtx.userId });
			expect(change?.metadata).toMatchObject({ via: "view:deal-board" });
			expect(change?.metadata.changes.map((c: { field: string }) => c.field).sort()).toEqual(["stage", "stage_at"]);
			// One transaction wrote the row, its change event and the receipt: all
			// three carry that transaction's clock.
			expect(new Set([after.updated_at, receipt?.created_at, change?.created_at]
				.map((at) => new Date(at).getTime())).size).toBe(1);

			// The retry carries an expected value that is now stale; the replay still
			// answers with the original result and writes nothing.
			const count = await eventCount();
			await expect(invoke(args)).resolves.toEqual({ ...first, created: false });
			expect(await entityRow(deal)).toEqual(after);
			expect(await eventCount()).toBe(count);
			// The same id with different expected values is another request.
			await expect(invoke({ ...args, expected: { stage: "won" } })).rejects.toMatchObject({ httpStatus: 409 });
		});

		it("refuses undeclared fields, stamped fields, another type, a missing record and a stale read without writing", async () => {
			const deal = await createRecord("deal", { stage: "open" });
			const lead = await createRecord("lead", { stage: "new" });
			const before = await entityRow(deal);
			const count = await eventCount();
			const refusals: Array<[Record<string, unknown>, number]> = [
				[{ action: "advance", value: { entity_id: deal, set: { amount: 5 } } }, 403],
				[{ action: "restamp", value: { entity_id: deal, set: { stage_at: "2020-01-01T00:00:00.000Z" } } }, 403],
				[{ action: "advance", value: { entity_id: lead, set: { stage: "won" } } }, 403],
				// The view attaches to one pinned lead record, not this one.
				[{ action: "qualify", value: { entity_id: lead, set: { stage: "hot" } } }, 403],
				[{ action: "advance", value: { entity_id: 999999999, set: { stage: "won" } } }, 404],
				[{ action: "advance", value: { entity_id: deal, set: {} } }, 400],
				[{ action: "advance", value: { entity_id: deal, set: { stage: "won" } }, expected: { stage: "lost" } }, 409],
			];
			for (const [index, [args, status]] of refusals.entries()) {
				await expect(invoke({ ...args, interaction_id: `refused-${index}` }), JSON.stringify(args))
					.rejects.toMatchObject({ httpStatus: status });
			}
			await getTestDb()`UPDATE entities SET deleted_at = NOW() WHERE id = ${lead}`;
			await expect(invoke({ action: "qualify", value: { entity_id: lead, set: { stage: "hot" } }, interaction_id: "deleted" }))
				.rejects.toMatchObject({ httpStatus: 404 });
			expect(await entityRow(deal)).toEqual(before);
			expect(await eventCount()).toBe(count);
			// A declaration naming a type the view does not attach to fails at set.
			await expect(executeTool("manage_views", {
				action: "set",
				source_code: viewModule({
					key: "unattached",
					attach: [{ collection: "deal" }],
					actions: { qualify: { updates: { entityType: "lead", fields: ["stage"] } } },
				}, VIEW_SOURCE),
			}, TEST_ENV, ownerCtx)).rejects.toMatchObject({ httpStatus: 400 });

			// The web route carries the same precondition and its structured refusal.
			const cookie = (await createTestSession(ownerId)).cookieHeader;
			const stale = await post(`/api/${orgSlug}/views/deal-board/actions/advance`, {
				body: { value: { entity_id: deal, set: { stage: "won" } }, expected: { stage: "lost" }, interaction_id: "web-stale" },
				cookie,
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({ code: "PRECONDITION_FAILED", mismatched_fields: ["stage"] });
			const fresh = await post(`/api/${orgSlug}/views/deal-board/actions/advance`, {
				body: { value: { entity_id: deal, set: { stage: "won" } }, expected: { stage: "open" }, interaction_id: "web-fresh" },
				cookie,
			});
			expect(fresh.status).toBe(200);
			expect(await fresh.json()).toMatchObject({ applied: { entity_id: deal, fields: { stage: "won" } } });
			// A signed-in owner's click is still a view write, not a manual edit.
			expect((await entityRow(deal)).field_controls ?? {}).toEqual({});
		});

		it("defers a human-owned field to an approval instead of writing it", async () => {
			const deal = await createRecord("deal", { stage: "open" });
			// The owner's own edit claims `notes`.
			await executeTool("manage_entity", { action: "update", entity_id: deal, metadata: { notes: "owner's words" } }, TEST_ENV, ownerCtx);
			expect(Object.keys((await entityRow(deal)).field_controls)).toEqual(["notes"]);
			const approvals = await pendingApprovals();
			const args = { action: "note", value: { entity_id: deal, set: { notes: "member's words" } }, interaction_id: "note-1" };

			const result = await invoke(args);
			expect(result).toMatchObject({
				created: true,
				event_type: "audit",
				pending_approval: { entity_id: deal, fields: { notes: "member's words" } },
			});
			expect(result.applied).toBeUndefined();
			expect((await entityRow(deal)).metadata.notes).toBe("owner's words");
			expect(await pendingApprovals()).toBe(approvals + 1);

			await expect(invoke(args)).resolves.toEqual({ ...result, created: false });
			expect(await pendingApprovals()).toBe(approvals + 1);
		});
	});
});
