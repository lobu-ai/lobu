/**
 * Workspace deletion as a background purge (docs/design/workspace-deletion.md).
 *
 * `POST /api/auth/organization/delete` records a request, hides the workspace
 * and enqueues one `workspace-purge` task; the task removes every org-scoped
 * row in lease-fenced batches. These tests drive the real endpoint, then run
 * the task the way the queue does: claim its `runs` row, then call the handler.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { materializeDueAutomationRuns } from "../../../automations/automation";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { app, type Env } from "../../../index";
import { resolveDefaultOrgId } from "../../../lobu/gateway";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores";
import { buildPublicPageModel, buildSitemapEntries } from "../../../public-pages";
import { registerScheduledJobsTicker } from "../../../scheduled/scheduled-jobs-service";
import type { TaskScheduler } from "../../../scheduled/task-scheduler";
import { WORKSPACE_PURGE_TASK } from "../../../scheduled/task-definitions";
import { getEnvFromProcess } from "../../../utils/env";
import { initWorkspaceProvider } from "../../../workspace";
import {
	getMembershipRole,
	getOrgBySlug,
	MultiTenantProvider,
} from "../../../workspace/multi-tenant";
import {
	runWorkspacePurgeTask,
	WORKSPACE_PURGE_BATCH_SIZE,
	WORKSPACE_PURGE_UNLINKED_TABLES,
	WorkspacePurgeLeaseLostError,
} from "../../../workspace/purge";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestEvent,
	createTestOrganization,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

const BASE = "http://localhost/api/auth";

/** A bearer token, or `{ cookie }` for a browser session cookie. */
type Credential = string | { cookie: string };

async function call(
	path: string,
	body: Record<string, unknown>,
	credential?: Credential,
): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }> {
	const auth = await createAuth(getEnvFromProcess());
	const res = await auth.handler(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(typeof credential === "string" ? { authorization: `Bearer ${credential}` } : {}),
				...(typeof credential === "object" ? { cookie: credential.cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
	const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	const setCookie = res.headers.get("set-cookie");
	return { status: res.status, body: parsed, cookie: setCookie ? setCookie.split(";")[0] : null };
}

async function get(path: string, token: string): Promise<{ status: number; body: unknown }> {
	const auth = await createAuth(getEnvFromProcess());
	const res = await auth.handler(
		new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } }),
	);
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function signUpOwnerWithWorkspace(label: string) {
	const signUp = await call("/sign-up/email", {
		email: `owner-${label}@workspace-purge.test`,
		password: "ownerpassword99",
		name: `Owner ${label}`,
	});
	expect(signUp.status).toBe(200);
	const token = signUp.body.token as string;
	const userId = (signUp.body.user as { id: string }).id;
	const created = await call(
		"/organization/create",
		{ name: `Purge ${label}`, slug: `purge-${label}` },
		token,
	);
	expect(created.status).toBe(200);
	return {
		token,
		userId,
		organizationId: created.body.id as string,
		slug: created.body.slug as string,
	};
}

/** Every base table with an org-scoping column, read from the live schema. */
async function orgScopedColumns(): Promise<Array<{ table: string; column: string }>> {
	const sql = getTestDb();
	const rows = await sql<{ table_name: string; column_name: string }[]>`
		SELECT c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables t
		  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public'
		  AND t.table_type = 'BASE TABLE'
		  AND c.column_name IN ('organization_id', 'organizationId')
		ORDER BY c.table_name
	`;
	return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

async function rowCountsFor(organizationId: string): Promise<Record<string, number>> {
	const sql = getTestDb();
	const counts: Record<string, number> = {};
	for (const { table, column } of await orgScopedColumns()) {
		const [row] = await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`,
			[organizationId],
		);
		if (row.n > 0) counts[table] = row.n;
	}
	return counts;
}

/** A synthetic value of the column's type; check-constrained enums get a member. */
function syntheticValue(table: string, column: string, udt: string): string {
	if (table === "connect_tokens" && column === "auth_type") return "oauth";
	if (table === "sandboxes" && column === "provider_kind") return "vercel";
	if (udt.startsWith("_")) return "{}";
	switch (udt) {
		case "int2":
		case "int4":
		case "int8":
			return String(Math.floor(Math.random() * 1_000_000_000));
		case "bool":
			return "false";
		case "json":
		case "jsonb":
			return "{}";
		case "uuid":
			return randomUUID();
		case "timestamptz":
		case "timestamp":
			return new Date().toISOString();
		default:
			return `seed-${randomUUID().slice(0, 8)}`;
	}
}

/**
 * One row in each table the organization FK never reaches, built from the live
 * column list so the seed follows the schema. Foreign keys are suspended for
 * the seeding transaction only: the rows exist to prove the purge removes them,
 * not to model a consistent workspace.
 */
async function seedUnlinkedRows(organizationId: string): Promise<void> {
	const sql = getTestDb();
	await sql.begin(async (tx) => {
		await tx`SET LOCAL session_replication_role = replica`;
		for (const table of WORKSPACE_PURGE_UNLINKED_TABLES) {
			const columns = await tx<{ column_name: string; udt_name: string }[]>`
				SELECT column_name, udt_name FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = ${table}
				  AND is_nullable = 'NO' AND column_default IS NULL
				  AND is_generated = 'NEVER' AND is_identity = 'NO'
				  AND column_name <> 'organization_id'
			`;
			const names = ["organization_id", ...columns.map((c) => c.column_name)];
			const types = ["text", ...columns.map((c) => c.udt_name)];
			const values = [
				organizationId,
				...columns.map((c) => syntheticValue(table, c.column_name, c.udt_name)),
			];
			await tx.unsafe(
				`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")})
				 VALUES (${types.map((t, i) => `$${i + 1}::${t}`).join(", ")})`,
				values,
			);
		}
	});
}

/** A realistic workspace body: bulk events with embeddings, an entity tree, runs. */
async function seedWorkspace(organizationId: string, userId: string, events: number) {
	const sql = getTestDb();
	await sql`
		INSERT INTO events (organization_id, title, payload_text, origin_id)
		SELECT ${organizationId}, 'seed ' || g, 'body ' || g, 'seed-' || g
		FROM generate_series(1, ${events}::int) g
	`;
	const parent = await createTestEntity({
		name: "Parent",
		organization_id: organizationId,
		created_by: userId,
	});
	const child = await createTestEntity({
		name: "Child",
		organization_id: organizationId,
		created_by: userId,
		parent_id: parent.id,
	});
	await createTestEntity({
		name: "Grandchild",
		organization_id: organizationId,
		created_by: userId,
		parent_id: child.id,
	});
	// A live identity association and an authorization edge: both are guarded
	// against ordinary deletes, so the purge has to retire/clear them through
	// their sanctioned paths. Seeded with triggers suspended, like any fixture
	// that skips the governed writers.
	await sql.begin(async (tx) => {
		await tx`SET LOCAL session_replication_role = replica`;
		for (const purpose of ["identity", "authorization"]) {
			const [type] = await tx<{ id: number }[]>`
				INSERT INTO entity_relationship_types (slug, name, organization_id, purpose)
				VALUES (${`seed-${purpose}`}, ${purpose}, ${organizationId}, ${purpose})
				RETURNING id
			`;
			await tx`
				INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id, metadata)
				VALUES (${organizationId}, ${parent.id}, ${child.id}, ${type.id},
				        '{"_lobu_claims": {"manual": {}}, "_lobu_identity_decision": {"outcome": "accepted"}}'::jsonb)
			`;
		}
	});
	await createTestEvent({
		organization_id: organizationId,
		entity_id: child.id,
		content: "embedded",
		embedding: Array.from({ length: 768 }, () => 0.1),
	});
	await sql`
		INSERT INTO runs (organization_id, run_type, status)
		SELECT ${organizationId}, 'sync', 'completed' FROM generate_series(1, 3)
	`;
	await seedUnlinkedRows(organizationId);
}

async function pendingPurgeTask(organizationId: string) {
	const sql = getTestDb();
	const rows = await sql<{ id: number; organization_id: string | null }[]>`
		SELECT id, organization_id FROM runs
		WHERE run_type = 'task' AND action_key = ${WORKSPACE_PURGE_TASK}
		  AND action_input->'payload'->>'organizationId' = ${organizationId}
		  AND status = 'pending'
	`;
	return rows;
}

/** Claim the task row exactly as the runs queue does, as holder `owner`. */
async function claimPurgeTask(taskRunId: number, owner: string): Promise<void> {
	const sql = getTestDb();
	await sql`
		UPDATE runs SET status = 'claimed', claimed_at = now(), claimed_by = ${owner}
		WHERE id = ${taskRunId}
	`;
}

describe("workspace purge", () => {
	const originalSecret = process.env.BETTER_AUTH_SECRET;

	// The public-page assertions resolve paths through the workspace provider.
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		process.env.BETTER_AUTH_SECRET = "c".repeat(64);
		clearAuthCacheForTests();
	});

	afterEach(async () => {
		const sql = getTestDb();
		await sql`DROP TRIGGER IF EXISTS test_purge_steal_lease ON events`;
		await sql`DROP FUNCTION IF EXISTS test_purge_steal_lease()`;
		if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
		else process.env.BETTER_AUTH_SECRET = originalSecret;
		clearAuthCacheForTests();
	});

	it("removes every org-scoped row and touches no other workspace", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("target");
		const bystander = await createTestOrganization();
		await addUserToOrganization(target.userId, bystander.id, "owner");
		await seedWorkspace(target.organizationId, target.userId, 50);
		await seedWorkspace(bystander.id, target.userId, 50);
		const bystanderBefore = await rowCountsFor(bystander.id);

		const deleted = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			target.token,
		);
		expect(deleted.status).toBe(200);
		expect(deleted.body.id).toBe(target.organizationId);

		const tasks = await pendingPurgeTask(target.organizationId);
		expect(tasks).toHaveLength(1);
		// The task row must outlive the organization it purges.
		expect(tasks[0].organization_id).toBeNull();
		const before = await rowCountsFor(target.organizationId);
		const eventsBefore = before.events;
		expect(eventsBefore).toBeGreaterThan(50);
		// The seeded tree (parent → child → grandchild) plus any platform rows.
		expect(before.entities).toBeGreaterThanOrEqual(3);
		await claimPurgeTask(tasks[0].id, "test-holder");
		const counts = await runWorkspacePurgeTask(
			{ organizationId: target.organizationId },
			{ taskRunId: tasks[0].id, claimedBy: "test-holder" },
		);
		expect(counts?.events).toBe(eventsBefore);
		expect(counts?.entities).toBe(before.entities);

		expect(await rowCountsFor(target.organizationId)).toEqual({});
		const [org] = await sql`SELECT 1 FROM organization WHERE id = ${target.organizationId}`;
		expect(org).toBeUndefined();
		expect(await rowCountsFor(bystander.id)).toEqual(bystanderBefore);

		const [task] = await sql`SELECT action_output FROM runs WHERE id = ${tasks[0].id}`;
		expect(task.action_output.removed.events).toBe(eventsBefore);
	});

	it("removes other workspaces' edges to its public records, stored and source-backed alike", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("public-catalog");
		const reader = await createTestOrganization();
		await sql`UPDATE organization SET visibility = 'public' WHERE id = ${target.organizationId}`;
		const [sourceType] = await sql<{ id: number }[]>`
			INSERT INTO entity_types (organization_id, slug, name, backing_sql, metadata_schema)
			VALUES (${target.organizationId}, 'catalog-item', 'Catalog item', 'SELECT ''k'' AS id',
			        '{"type": "object", "x-lobu-record-key": "id"}'::jsonb)
			RETURNING id
		`;
		const publicEntity = await createTestEntity({ name: "Public record", organization_id: target.organizationId, created_by: target.userId });
		const own = await createTestEntity({ name: "Reader record", organization_id: reader.id });
		const [relType] = await sql<{ id: number }[]>`
			INSERT INTO entity_relationship_types (slug, name, organization_id)
			VALUES ('cites', 'Cites', ${reader.id}) RETURNING id
		`;
		await sql`
			INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_type_id, to_source_key, relationship_type_id)
			VALUES (${reader.id}, ${own.id}, ${sourceType.id}, 'k', ${relType.id})
		`;
		await sql`
			INSERT INTO entity_relationships (organization_id, from_entity_id, to_entity_id, relationship_type_id)
			VALUES (${reader.id}, ${own.id}, ${publicEntity.id}, ${relType.id})
		`;

		const deleted = await call("/organization/delete", { organizationId: target.organizationId }, target.token);
		expect(deleted.status).toBe(200);
		const [task] = await pendingPurgeTask(target.organizationId);
		await claimPurgeTask(task.id, "test-holder");
		await runWorkspacePurgeTask(
			{ organizationId: target.organizationId },
			{ taskRunId: task.id, claimedBy: "test-holder" },
		);

		expect(await sql`SELECT 1 FROM organization WHERE id = ${target.organizationId}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM entity_relationships WHERE organization_id = ${reader.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM entities WHERE id = ${own.id}`).toHaveLength(1);
	});

	it("resumes after losing its lease mid-batch and completes", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("resume");
		await seedWorkspace(target.organizationId, target.userId, WORKSPACE_PURGE_BATCH_SIZE + 500);

		const deleted = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			target.token,
		);
		expect(deleted.status).toBe(200);
		const [task] = await pendingPurgeTask(target.organizationId);

		// Another holder takes the lease while the first events batch runs: the
		// batch that observed the steal commits, the next one must not.
		await sql.unsafe(`
			CREATE FUNCTION test_purge_steal_lease() RETURNS trigger AS $$
			BEGIN
				UPDATE runs SET claimed_by = 'second-holder' WHERE id = ${task.id};
				RETURN NULL;
			END;
			$$ LANGUAGE plpgsql
		`);
		await sql.unsafe(`
			CREATE TRIGGER test_purge_steal_lease AFTER DELETE ON events
			FOR EACH STATEMENT EXECUTE FUNCTION test_purge_steal_lease()
		`);
		await claimPurgeTask(task.id, "first-holder");
		await expect(
			runWorkspacePurgeTask({ organizationId: target.organizationId }, { taskRunId: task.id, claimedBy: "first-holder" }),
		).rejects.toBeInstanceOf(WorkspacePurgeLeaseLostError);

		const [{ remaining }] = await sql`
			SELECT count(*)::int AS remaining FROM events WHERE organization_id = ${target.organizationId}
		`;
		// Exactly one batch committed before the steal was noticed.
		expect(remaining).toBeGreaterThan(500);
		expect(remaining).toBeLessThan(WORKSPACE_PURGE_BATCH_SIZE);
		await sql`DROP TRIGGER test_purge_steal_lease ON events`;

		// The retry claims the same row again and finishes the job.
		await claimPurgeTask(task.id, "retry-holder");
		const counts = await runWorkspacePurgeTask(
			{ organizationId: target.organizationId },
			{ taskRunId: task.id, claimedBy: "retry-holder" },
		);
		expect(counts?.events).toBe(remaining + WORKSPACE_PURGE_BATCH_SIZE);
		const [progress] = await sql`SELECT action_output FROM runs WHERE id = ${task.id}`;
		expect(progress.action_output.removed.events).toBe(counts?.events);
		expect(await rowCountsFor(target.organizationId)).toEqual({});

		// A further retry after the organization row is gone is a clean no-op.
		await claimPurgeTask(task.id, "late-holder");
		expect(
			await runWorkspacePurgeTask({ organizationId: target.organizationId }, { taskRunId: task.id, claimedBy: "late-holder" }),
		).toEqual(counts);
	});

	it("refuses to purge a workspace nobody asked to delete", async () => {
		const sql = getTestDb();
		const org = await createTestOrganization();
		const [task] = await sql<{ id: number }[]>`
			INSERT INTO runs (run_type, queue_name, action_key, status, claimed_by, claimed_at)
			VALUES ('task', 'task:workspace-purge', ${WORKSPACE_PURGE_TASK}, 'claimed', 'holder', now())
			RETURNING id
		`;
		expect(
			await runWorkspacePurgeTask({ organizationId: org.id }, { taskRunId: task.id, claimedBy: "holder" }),
		).toBeNull();
		const [still] = await sql`SELECT 1 AS ok FROM organization WHERE id = ${org.id}`;
		expect(still.ok).toBe(1);
	});

	it("keeps owner-only and personal-workspace refusals", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("refusals");
		const memberSignUp = await call("/sign-up/email", {
			email: "member-refusals@workspace-purge.test",
			password: "memberpassword99",
			name: "Member",
		});
		const memberId = (memberSignUp.body.user as { id: string }).id;
		await addUserToOrganization(memberId, target.organizationId, "admin");

		const byAdmin = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			memberSignUp.body.token as string,
		);
		expect(byAdmin.status).toBe(403);

		await sql`
			UPDATE organization
			SET metadata = jsonb_build_object('personal_org_for_user_id', ${target.userId}::text)::text
			WHERE id = ${target.organizationId}
		`;
		const personal = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			target.token,
		);
		expect(personal.status).toBe(403);
		expect(personal.body.code).toBe("PERSONAL_ORGANIZATION_CANNOT_BE_DELETED");
		expect(await pendingPurgeTask(target.organizationId)).toHaveLength(0);
	});

	it("refuses a client-supplied deletion marker on create and update", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("injection");
		const adminSignUp = await call("/sign-up/email", {
			email: "admin-injection@workspace-purge.test",
			password: "adminpassword99",
			name: "Admin",
		});
		const adminToken = adminSignUp.body.token as string;
		const adminId = (adminSignUp.body.user as { id: string }).id;
		await addUserToOrganization(adminId, target.organizationId, "admin");

		const refusedDelete = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			adminToken,
		);
		expect(refusedDelete.status).toBe(403);
		const injected = await call(
			"/organization/update",
			{
				organizationId: target.organizationId,
				data: { metadata: { deletion_requested_at: "2026-01-01T00:00:00.000Z" } },
			},
			adminToken,
		);
		expect(injected.status).toBe(400);
		expect(injected.body.code).toBe("ORGANIZATION_METADATA_KEY_RESERVED");
		const injectedBy = await call(
			"/organization/update",
			{
				organizationId: target.organizationId,
				data: { metadata: { deletion_requested_by: adminId } },
			},
			adminToken,
		);
		expect(injectedBy.status).toBe(400);
		const [org] = await sql`
			SELECT metadata FROM organization WHERE id = ${target.organizationId}
		`;
		expect(String(org.metadata ?? "")).not.toContain("deletion_requested");
		expect(await getOrgBySlug(target.slug)).not.toBeNull();

		const created = await call(
			"/organization/create",
			{
				name: "Born deleting",
				slug: "purge-born-deleting",
				metadata: { deletion_requested_at: "2026-01-01T00:00:00.000Z" },
			},
			adminToken,
		);
		expect(created.status).toBe(400);
		const born = await sql`SELECT 1 FROM organization WHERE slug = 'purge-born-deleting'`;
		expect(born).toHaveLength(0);

		// An ordinary metadata update still goes through.
		const ordinary = await call(
			"/organization/update",
			{ organizationId: target.organizationId, data: { metadata: { theme: "dark" } } },
			adminToken,
		);
		expect(ordinary.status).toBe(200);
	});

	it("refuses org-scoped Better Auth endpoints before they mutate anything", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("scoped");
		const live = await createTestOrganization();
		const adminSignUp = await call("/sign-up/email", {
			email: "admin-scoped@workspace-purge.test",
			password: "adminpassword99",
			name: "Admin",
		});
		const adminToken = adminSignUp.body.token as string;
		const adminId = (adminSignUp.body.user as { id: string }).id;
		await addUserToOrganization(adminId, target.organizationId, "admin");
		await addUserToOrganization(adminId, live.id, "member");
		const plainSignUp = await call("/sign-up/email", {
			email: "plain-scoped@workspace-purge.test",
			password: "plainpassword99",
			name: "Plain",
		});
		const plainMemberId = await addUserToOrganization(
			(plainSignUp.body.user as { id: string }).id,
			target.organizationId,
			"member",
		);
		const invitationId = "invitation-workspace-purge-scoped";
		await sql`
			INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
			VALUES (${invitationId}, ${target.organizationId}, 'invitee-scoped@workspace-purge.test',
				'member', 'pending', now() + interval '1 day', ${target.userId})
		`;
		const inviteeSignUp = await call("/sign-up/email", {
			email: "invitee-scoped@workspace-purge.test",
			password: "inviteepassword99",
			name: "Invitee",
		});
		const inviteeToken = inviteeSignUp.body.token as string;
		const inviteeId = (inviteeSignUp.body.user as { id: string }).id;

		const activated = await call(
			"/organization/set-active",
			{ organizationId: target.organizationId },
			adminToken,
		);
		expect(activated.status).toBe(200);
		const deleted = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			target.token,
		);
		expect(deleted.status).toBe(200);
		// The request moved every session off the workspace, not only the owner's.
		const activeOrgs = async () =>
			(
				await sql<{ activeOrganizationId: string | null }[]>`
					SELECT "activeOrganizationId" FROM session WHERE "userId" = ${adminId}
				`
			).map((row) => row.activeOrganizationId);
		expect(await activeOrgs()).toEqual([null]);
		// A session that set the workspace active concurrently with the request
		// can still point at it; every fallback below must refuse it.
		await sql`
			UPDATE session SET "activeOrganizationId" = ${target.organizationId}
			WHERE "userId" = ${adminId}
		`;

		const memberRows = async () =>
			sql<{ userId: string; role: string }[]>`
				SELECT "userId", role FROM member
				WHERE "organizationId" = ${target.organizationId} ORDER BY "userId"
			`;
		const membersBefore = await memberRows();

		// Named by id, by slug, and through the session's active organization.
		expect(
			(await get(`/organization/list-members?organizationId=${target.organizationId}`, adminToken))
				.status,
		).toBe(404);
		expect(
			(await get(`/organization/list-members?organizationSlug=${target.slug}`, adminToken)).status,
		).toBe(404);
		expect((await get("/organization/list-members", adminToken)).status).toBe(404);
		expect((await get("/organization/get-full-organization", adminToken)).status).toBe(404);

		const invite = await call(
			"/organization/invite-member",
			{
				organizationId: target.organizationId,
				email: "late-invitee@workspace-purge.test",
				role: "member",
			},
			adminToken,
		);
		expect(invite.status).toBe(404);
		for (const credential of [adminToken, { cookie: adminSignUp.cookie as string }]) {
			const roleChange = await call(
				"/organization/update-member-role",
				{ memberId: plainMemberId, role: "admin" },
				credential,
			);
			expect(roleChange.status).toBe(404);
		}
		const removal = await call(
			"/organization/remove-member",
			{ memberIdOrEmail: plainMemberId, organizationId: target.organizationId },
			adminToken,
		);
		expect(removal.status).toBe(404);
		const left = await call(
			"/organization/leave",
			{ organizationId: target.organizationId },
			adminToken,
		);
		expect(left.status).toBe(404);
		expect(await memberRows()).toEqual(membersBefore);
		const invitations = await sql`
			SELECT email, status FROM invitation WHERE "organizationId" = ${target.organizationId}
		`;
		expect(invitations).toEqual([
			{ email: "invitee-scoped@workspace-purge.test", status: "pending" },
		]);

		// An invitation into the deleting workspace can be neither read nor accepted.
		expect((await get(`/organization/get-invitation?id=${invitationId}`, inviteeToken)).status).toBe(
			404,
		);
		const accepted = await call("/organization/accept-invitation", { invitationId }, inviteeToken);
		expect(accepted.status).toBe(404);
		const inviteeMembership = await sql`
			SELECT 1 FROM member WHERE "userId" = ${inviteeId}
				AND "organizationId" = ${target.organizationId}
		`;
		expect(inviteeMembership).toHaveLength(0);

		// A selector the endpoint ignores does not hide the active organization
		// it acts on: the update and the email removal both act on it.
		for (const smuggled of [
			{ path: "/organization/update", body: { memberId: plainMemberId } },
			{ path: "/organization/update", body: { organizationSlug: live.slug } },
			{ path: `/organization/update?organizationId=${live.id}`, body: {} },
		]) {
			const smuggledUpdate = await call(
				smuggled.path,
				{ ...smuggled.body, data: { metadata: { theme: "dark" } } },
				adminToken,
			);
			expect(smuggledUpdate.status).toBe(404);
		}
		const removalByEmail = await call(
			"/organization/remove-member",
			{ memberIdOrEmail: "plain-scoped@workspace-purge.test" },
			adminToken,
		);
		expect(removalByEmail.status).toBe(404);
		expect(await memberRows()).toEqual(membersBefore);
		const [marker] = await sql`
			SELECT (metadata)::jsonb ->> 'deletion_requested_at' AS requested_at
			FROM organization WHERE id = ${target.organizationId}
		`;
		expect(marker.requested_at).not.toBeNull();

		// set-active with no target falls back to the deleting workspace too.
		expect((await call("/organization/set-active", {}, adminToken)).status).toBe(404);
		expect(await activeOrgs()).toEqual([target.organizationId]);

		// Switching away and clearing still work; switching back is refused and
		// leaves the session where it was.
		const cleared = await call("/organization/set-active", { organizationId: null }, adminToken);
		expect(cleared.status).toBe(200);
		expect(await activeOrgs()).toEqual([null]);
		const toLive = await call("/organization/set-active", { organizationId: live.id }, adminToken);
		expect(toLive.status).toBe(200);
		const back = await call(
			"/organization/set-active",
			{ organizationId: target.organizationId },
			adminToken,
		);
		expect(back.status).toBe(404);
		expect(await activeOrgs()).toEqual([live.id]);
		expect((await get("/organization/list-members", adminToken)).status).toBe(200);
	});

	it("refuses every Better Auth organization endpoint for a session still on a deleting workspace", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("every-endpoint");
		const adminSignUp = await call("/sign-up/email", {
			email: "admin-every-endpoint@workspace-purge.test",
			password: "adminpassword99",
			name: "Admin",
		});
		const adminToken = adminSignUp.body.token as string;
		const adminId = (adminSignUp.body.user as { id: string }).id;
		await addUserToOrganization(adminId, target.organizationId, "admin");
		expect(
			(
				await call(
					"/organization/delete",
					{ organizationId: target.organizationId },
					target.token,
				)
			).status,
		).toBe(200);
		// A session that set the workspace active concurrently with the request.
		await sql`
			UPDATE session SET "activeOrganizationId" = ${target.organizationId}
			WHERE "userId" = ${adminId}
		`;
		const snapshot = async () => ({
			members: await sql`
				SELECT id, "userId", role FROM member
				WHERE "organizationId" = ${target.organizationId} ORDER BY id
			`,
			invitations: await sql`
				SELECT id, status FROM invitation WHERE "organizationId" = ${target.organizationId}
			`,
			organization: await sql`
				SELECT name, slug, metadata FROM organization WHERE id = ${target.organizationId}
			`,
			sessions: await sql`
				SELECT "activeOrganizationId" FROM session WHERE "userId" = ${adminId}
			`,
		});
		const before = await snapshot();

		// Every organization endpoint Better Auth registers, read off the live
		// auth instance so a new endpoint is covered without editing this test.
		const auth = await createAuth(getEnvFromProcess());
		const endpoints = Object.values(auth.api as Record<string, unknown>)
			.map((endpoint) => endpoint as { path?: unknown; options?: { method?: unknown } })
			.filter(
				(endpoint) =>
					typeof endpoint.path === "string" &&
					endpoint.path.startsWith("/organization/") &&
					endpoint.path !== "/organization/delete",
			);
		expect(endpoints.map((endpoint) => endpoint.path)).toEqual(
			expect.arrayContaining([
				"/organization/set-active",
				"/organization/update",
				"/organization/list",
				"/organization/list-members",
				"/organization/invite-member",
				"/organization/accept-invitation",
				"/organization/update-member-role",
			]),
		);

		const leaks: string[] = [];
		for (const endpoint of endpoints) {
			const path = endpoint.path as string;
			const declared = endpoint.options?.method;
			const method = (Array.isArray(declared) ? declared[0] : declared) === "GET" ? "GET" : "POST";
			const res = await auth.handler(
				new Request(`${BASE}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${adminToken}`,
						...(method === "POST" ? { "content-type": "application/json" } : {}),
					},
					...(method === "POST" ? { body: "{}" } : {}),
				}),
			);
			const text = await res.text();
			if (res.status < 400 || text.includes(target.organizationId)) {
				leaks.push(`${method} ${path} -> ${res.status}`);
			}
		}
		expect(leaks).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});

	it("drops a deleting workspace from cross-workspace invitation listings", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("invitations");
		const live = await createTestOrganization();
		const inviteeEmail = "invitee-listing@workspace-purge.test";
		const inviteeSignUp = await call("/sign-up/email", {
			email: inviteeEmail,
			password: "inviteepassword99",
			name: "Invitee",
		});
		const inviteeToken = inviteeSignUp.body.token as string;
		// Better Auth lists invitations only for a verified email.
		await sql`UPDATE "user" SET "emailVerified" = true WHERE email = ${inviteeEmail}`;
		for (const [id, organizationId] of [
			["invitation-listing-deleting", target.organizationId],
			["invitation-listing-live", live.id],
		]) {
			await sql`
				INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
				VALUES (${id}, ${organizationId}, ${inviteeEmail}, 'member', 'pending',
					now() + interval '1 day', ${target.userId})
			`;
		}
		const preview = async (id: string) =>
			(
				await app.fetch(new Request(`http://localhost/api/invitation-preview?id=${id}`), {
					ENVIRONMENT: "test",
					BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
					RATE_LIMIT_ENABLED: "false",
				} as Env)
			).status;
		const listed = async () => {
			const res = await get("/organization/list-user-invitations", inviteeToken);
			expect(res).toMatchObject({ status: 200 });
			return (res.body as Array<{ organizationId: string }>).map(
				(invitation) => invitation.organizationId,
			);
		};
		expect((await listed()).sort()).toEqual([live.id, target.organizationId].sort());
		expect(await preview("invitation-listing-deleting")).toBe(200);

		expect(
			(
				await call(
					"/organization/delete",
					{ organizationId: target.organizationId },
					target.token,
				)
			).status,
		).toBe(200);
		expect(await listed()).toEqual([live.id]);
		expect(await preview("invitation-listing-deleting")).toBe(404);
		expect(await preview("invitation-listing-live")).toBe(200);
	});

	it("takes a public workspace off every anonymous surface before the purge runs", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("public");
		await sql`UPDATE organization SET visibility = 'public' WHERE id = ${target.organizationId}`;
		const env = {
			ENVIRONMENT: "test",
			BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
			RATE_LIMIT_ENABLED: "false",
		} as Env;
		const publicRest = async () =>
			(
				await app.fetch(
					new Request(`http://localhost/api/${target.slug}/public/organization`),
					env,
				)
			).status;
		const publicPage = () =>
			buildPublicPageModel(`/${target.slug}`, env, `https://example.test/${target.slug}`);
		const sitemapLocs = async () =>
			(await buildSitemapEntries("https://example.test")).map((entry) => entry.loc);

		expect(await publicRest()).toBe(200);
		expect(await publicPage()).not.toBeNull();
		expect((await sitemapLocs()).some((loc) => loc.includes(`/${target.slug}`))).toBe(true);

		expect(
			(
				await call(
					"/organization/delete",
					{ organizationId: target.organizationId },
					target.token,
				)
			).status,
		).toBe(200);
		expect(await pendingPurgeTask(target.organizationId)).toHaveLength(1);
		expect(await publicRest()).toBe(404);
		expect(await publicPage()).toBeNull();
		expect((await sitemapLocs()).some((loc) => loc.includes(`/${target.slug}`))).toBe(false);
	});

	it("stops resolving a deleting or left workspace as the default on the very next request", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("default-org");
		const live = await createTestOrganization();
		const memberSignUp = await call("/sign-up/email", {
			email: "member-default-org@workspace-purge.test",
			password: "memberpassword99",
			name: "Member",
		});
		const memberId = (memberSignUp.body.user as { id: string }).id;
		// Oldest membership wins: the deleting workspace, then the live one,
		// then anything the member joined at sign-up.
		const targetMembership = await addUserToOrganization(memberId, target.organizationId, "member");
		const liveMembership = await addUserToOrganization(memberId, live.id, "member");
		await sql`UPDATE member SET "createdAt" = now() - interval '10 years' WHERE id = ${targetMembership}`;
		await sql`UPDATE member SET "createdAt" = now() - interval '5 years' WHERE id = ${liveMembership}`;

		// Resolved once (a warm cache, if one existed), then deletion requested.
		expect(await resolveDefaultOrgId(memberId)).toBe(target.organizationId);
		expect(
			(
				await call(
					"/organization/delete",
					{ organizationId: target.organizationId },
					target.token,
				)
			).status,
		).toBe(200);
		expect(await resolveDefaultOrgId(memberId)).toBe(live.id);

		// Removed from the live workspace: no longer its default either.
		await sql`DELETE FROM member WHERE id = ${liveMembership}`;
		const after = await resolveDefaultOrgId(memberId);
		expect(after).not.toBe(live.id);
		expect(after).not.toBe(target.organizationId);
	});

	it("hides a requested workspace before the purge runs", async () => {
		const sql = getTestDb();
		const target = await signUpOwnerWithWorkspace("hidden");
		const live = await createTestOrganization();
		await addUserToOrganization(target.userId, live.id, "owner");

		// A due scheduled Automation, a due scheduled job, a chat connection and
		// a queued run in each workspace.
		const seedSchedules = async (organizationId: string) => {
			const agent = await createTestAgent({ organizationId, ownerUserId: target.userId });
			const entity = await createTestEntity({
				name: "Scheduled",
				organization_id: organizationId,
				created_by: target.userId,
			});
			const client = await TestApiClient.for({
				organizationId,
				userId: target.userId,
				memberRole: "owner",
				scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			});
			const created = (await client.automations.create({
				entity_id: entity.id,
				slug: "nightly",
				name: "Nightly",
				prompt: "Summarize {{entities}}.",
				triggers: [{ kind: "schedule", cron: "0 * * * *", execution: "window" }],
				managed_agent_id: agent.agentId,
			})) as { automation_id: string };
			const automation = { id: Number(created.automation_id) };
			await sql`
				UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${automation.id}
			`;
			await sql`
				INSERT INTO scheduled_jobs (organization_id, action_type, action_args, next_run_at, description, created_by_user)
				VALUES (${organizationId}, 'send_notification', '{}'::jsonb, now() - interval '1 minute', 'due', ${target.userId})
			`;
			const connectionId = `chat-${organizationId.slice(-8)}`;
			await insertChatConnectionRow({
				id: connectionId,
				organizationId,
				agentId: agent.agentId,
				platform: "telegram",
			});
			await sql`
				INSERT INTO runs (organization_id, run_type, status) VALUES (${organizationId}, 'sync', 'pending')
			`;
			return { automationId: Number(automation.id), connectionId };
		};
		const hidden = await seedSchedules(target.organizationId);
		const visible = await seedSchedules(live.id);

		const deleted = await call(
			"/organization/delete",
			{ organizationId: target.organizationId },
			target.token,
		);
		expect(deleted.status).toBe(200);

		// Better Auth's own organization endpoints: hidden, and read-only so an
		// owner's metadata update cannot clear the marker mid-purge.
		const baList = await get("/organization/list", target.token);
		expect(baList.status).toBe(200);
		const baIds = (baList.body as Array<{ id: string }>).map((org) => org.id);
		expect(baIds).toContain(live.id);
		expect(baIds).not.toContain(target.organizationId);
		const full = await get(
			`/organization/get-full-organization?organizationId=${target.organizationId}`,
			target.token,
		);
		expect(full.status).toBe(404);
		const update = await call(
			"/organization/update",
			{ organizationId: target.organizationId, data: { metadata: {} } },
			target.token,
		);
		expect(update.status).toBe(404);
		const [marker] = await sql`
			SELECT (metadata)::jsonb ->> 'deletion_requested_at' AS requested_at
			FROM organization WHERE id = ${target.organizationId}
		`;
		expect(marker.requested_at).not.toBeNull();

		// Listings and access.
		const listed = await new MultiTenantProvider().listOrganizations(undefined, target.userId);
		const listedIds = listed.map((org) => org.id);
		expect(listedIds).toContain(live.id);
		expect(listedIds).not.toContain(target.organizationId);
		expect(await getOrgBySlug(target.slug)).toBeNull();
		expect(await getMembershipRole(target.organizationId, target.userId)).toBeNull();
		expect(await getMembershipRole(live.id, target.userId)).toBe("owner");

		// Queued work was dropped; nothing new is materialized.
		const [{ pending }] = await sql`
			SELECT count(*)::int AS pending FROM runs
			WHERE organization_id = ${target.organizationId} AND status = 'pending'
		`;
		expect(pending).toBe(0);
		const env = {} as Env;
		expect((await materializeDueAutomationRuns(env, sql, hidden.automationId)).dueAutomations).toBe(0);
		expect((await materializeDueAutomationRuns(env, sql, visible.automationId)).dueAutomations).toBe(1);

		const spawned: string[] = [];
		let tick: (() => Promise<void>) | null = null;
		const scheduler = {
			register: (_name: string, handler: () => Promise<void>) => {
				tick = handler;
			},
			spawn: async (_name: string, payload: { organizationId?: string }) => {
				spawned.push(String(payload.organizationId ?? ""));
				return "1";
			},
		} as unknown as TaskScheduler;
		registerScheduledJobsTicker(scheduler);
		await (tick as unknown as () => Promise<void>)();
		const [{ due }] = await sql`
			SELECT count(*)::int AS due FROM scheduled_jobs
			WHERE organization_id = ${target.organizationId} AND last_fired_at IS NULL
		`;
		expect(due).toBe(1);
		const [{ fired }] = await sql`
			SELECT count(*)::int AS fired FROM scheduled_jobs
			WHERE organization_id = ${live.id} AND last_fired_at IS NOT NULL
		`;
		expect(fired).toBe(1);

		// Chat routing no longer resolves the workspace's connections.
		const store = createPostgresAgentConnectionStore();
		const routed = (await store.listConnections()).map((c) => c.id);
		expect(routed.some((id) => id.includes(hidden.connectionId))).toBe(false);
		expect(routed.some((id) => id.includes(visible.connectionId))).toBe(true);
	});
});
