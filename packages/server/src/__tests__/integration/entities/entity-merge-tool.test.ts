/**
 * manage_entity `merge` action — the tool surface an automation's agent (or an admin)
 * calls to fuse two entities. Covers the gate (admin/owner only), the org fence
 * (no cross-tenant / deleted target), and the happy path delegating to applyMerge.
 * The fusion mechanics themselves are proven in events/entity-merge.test.ts.
 */

import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import { PROD_PG_VALUE_OPTIONS } from "../../../db/client";
import {
	assessEntityResolution,
	RESOLUTION_FINGERPRINT_VERSION,
} from "../../../entity-resolution/policy";
import { lockResolutionCandidate } from "../../../entity-resolution/rejection";
import { assertResolutionFingerprintCurrent } from "../../../entity-resolution/staleness";
import type { Env } from "../../../index";
import { manageEntity } from "../../../tools/admin/manage_entity";
import { manageOperations } from "../../../tools/admin/manage_operations";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const env = {} as Env;

function ctx(orgId: string, userId: string, memberRole: string): ToolContext {
	// Full MCP scopes so the action-router's scope gate passes; the test asserts
	// the ROLE gate (admin/owner) inside the handler, not the scope tier.
	return {
		organizationId: orgId,
		userId,
		memberRole,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
	} as ToolContext;
}

describe("manage_entity merge action", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	async function twoEntities(orgId: string, userId: string) {
		const winner = await createTestEntity({
			name: "Winner",
			entity_type: "person",
			organization_id: orgId,
			created_by: userId,
		});
		const loser = await createTestEntity({
			name: "Loser",
			entity_type: "person",
			organization_id: orgId,
			created_by: userId,
		});
		return { winner, loser };
	}

	it("an owner merges the loser into the winner (loser tombstoned + forwarded)", async () => {
		const org = await createTestOrganization({ name: "Merge Tool Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);

		const res = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			ctx(org.id, user.id, "owner"),
		)) as {
			action: string;
			success: boolean;
			winner_entity_id: number;
			loser_entity_id: number;
		};

		expect(res.action).toBe("merge");
		expect(res.success).toBe(true);
		expect(res.winner_entity_id).toBe(winner.id);
		expect(res.loser_entity_id).toBe(loser.id);

		const sql = getTestDb();
		const [row] = (await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `) as Array<{ merged_into: number | null; deleted_at: string | null }>;
		expect(Number(row.merged_into)).toBe(winner.id);
		expect(row.deleted_at).not.toBeNull();
	});

	/**
	 * A merged record has to stay deletable. `entity_merge_operations` holds the
	 * undo ledger with ON DELETE RESTRICT on BOTH participants, and
	 * `entities_merged_into_fkey` refuses to let the winner go while the loser's
	 * redirect points at it — so before this was handled, merging two records
	 * made the survivor permanently undeletable and the caller saw a raw Postgres
	 * constraint message instead of an answer.
	 */
	it("force-deletes a merge winner, taking its redirects and ledger with it", async () => {
		const org = await createTestOrganization({ name: "Delete Merged Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const toolCtx = ctx(org.id, user.id, "owner");

		await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			toolCtx,
		);

		const sql = getTestDb();
		const ledgerBefore = (await sql`
      SELECT count(*)::int AS n FROM entity_merge_operations
      WHERE winner_entity_id = ${winner.id}
    `) as Array<{ n: number }>;
		// Guard: without a ledger row the test would pass for the wrong reason.
		expect(ledgerBefore[0].n).toBe(1);

		const res = (await manageEntity(
			{ action: "delete", entity_id: winner.id, force_delete_tree: true },
			env,
			toolCtx,
		)) as { success: boolean; deleted_count: number };

		expect(res.success).toBe(true);
		// BOTH rows go: the loser is a redirect to the winner, not a record of its
		// own, so leaving it behind would strand a tombstone pointing at nothing.
		expect(res.deleted_count).toBe(2);

		const rows = (await sql`
      SELECT id FROM entities WHERE id IN (${winner.id}, ${loser.id})
    `) as Array<{ id: number }>;
		expect(rows).toHaveLength(0);

		const ledgerAfter = (await sql`
      SELECT count(*)::int AS n FROM entity_merge_operations
      WHERE winner_entity_id = ${winner.id} OR loser_entity_id = ${loser.id}
    `) as Array<{ n: number }>;
		expect(ledgerAfter[0].n).toBe(0);
	});

	/** The redirect walk must not drag in a row that merged somewhere ELSE. */
	it("leaves an unrelated merge pair untouched", async () => {
		const org = await createTestOrganization({ name: "Unrelated Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		// Distinct names: entity slugs are unique per parent, so a second
		// Winner/Loser pair from `twoEntities` would collide on insert.
		const mk = async (label: string) => ({
			winner: await createTestEntity({
				name: `Winner ${label}`,
				entity_type: "person",
				organization_id: org.id,
				created_by: user.id,
			}),
			loser: await createTestEntity({
				name: `Loser ${label}`,
				entity_type: "person",
				organization_id: org.id,
				created_by: user.id,
			}),
		});
		const doomed = await mk("A");
		const bystander = await mk("B");
		const toolCtx = ctx(org.id, user.id, "owner");

		for (const pair of [doomed, bystander]) {
			await manageEntity(
				{
					action: "merge",
					entity_id: pair.loser.id,
					winner_entity_id: pair.winner.id,
				},
				env,
				toolCtx,
			);
		}

		await manageEntity(
			{ action: "delete", entity_id: doomed.winner.id, force_delete_tree: true },
			env,
			toolCtx,
		);

		const sql = getTestDb();
		const survivors = (await sql`
      SELECT id FROM entities
      WHERE id IN (${bystander.winner.id}, ${bystander.loser.id})
      ORDER BY id
    `) as Array<{ id: number }>;
		expect(survivors).toHaveLength(2);

		const ledger = (await sql`
      SELECT count(*)::int AS n FROM entity_merge_operations
      WHERE winner_entity_id = ${bystander.winner.id}
    `) as Array<{ n: number }>;
		expect(ledger[0].n).toBe(1);
	});

	/**
	 * The shape that makes `UNION` (not `UNION ALL`) load-bearing in
	 * `loadEntityTreeIds`: fold a parent into its own child and the two edges
	 * close a cycle — B.parent_id = A via the parent edge, A.merged_into = B via
	 * the redirect edge. `UNION ALL` would recurse forever and hang the delete.
	 */
	it("force-deletes a parent that was merged into its own child", async () => {
		const org = await createTestOrganization({ name: "Cycle Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const toolCtx = ctx(org.id, user.id, "owner");

		const parent = await createTestEntity({
			name: "Parent",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const child = await createTestEntity({
			name: "Child",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
			parent_id: parent.id,
		});

		await manageEntity(
			{ action: "merge", entity_id: parent.id, winner_entity_id: child.id },
			env,
			toolCtx,
		);

		const sql = getTestDb();
		const [edges] = (await sql`
      SELECT
        (SELECT parent_id FROM entities WHERE id = ${child.id}) AS child_parent,
        (SELECT merged_into FROM entities WHERE id = ${parent.id}) AS parent_merged
    `) as Array<{ child_parent: number | null; parent_merged: number | null }>;
		// Guard: if the merge path ever refuses this, the cycle is unreachable and
		// the UNION rationale above needs revisiting — fail here rather than let
		// the test pass vacuously.
		expect(Number(edges.child_parent)).toBe(parent.id);
		expect(Number(edges.parent_merged)).toBe(child.id);

		// Target the CHILD: it is the surviving record, and the merged-away parent
		// is soft-deleted so the delete action would 404 on it. Walking out from
		// the child is also the direction that closes the cycle — child → parent
		// (redirect) → child (parent edge).
		const res = (await manageEntity(
			{ action: "delete", entity_id: child.id, force_delete_tree: true },
			env,
			toolCtx,
		)) as { success: boolean; deleted_count: number };

		expect(res.success).toBe(true);
		expect(res.deleted_count).toBe(2);
		const rows = (await sql`
      SELECT id FROM entities WHERE id IN (${parent.id}, ${child.id})
    `) as Array<{ id: number }>;
		expect(rows).toHaveLength(0);
	}, 30_000);

	it("rejects a non-admin member (403)", async () => {
		const org = await createTestOrganization({ name: "Gate Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "member");
		const { winner, loser } = await twoEntities(org.id, user.id);

		await expect(
			manageEntity(
				{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
				env,
				ctx(org.id, user.id, "member"),
			),
		).rejects.toThrow(/admin or owner/i);
	});

	it("rejects a cross-type merge before queuing approval", async () => {
		const org = await createTestOrganization({ name: "Cross Type Tool Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const person = await createTestEntity({
			name: "Person",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const company = await createTestEntity({
			name: "Company",
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});

		await expect(
			manageEntity(
				{
					action: "merge",
					entity_id: person.id,
					winner_entity_id: company.id,
				},
				env,
				ctx(org.id, user.id, "owner"),
			),
		).rejects.toThrow(/same entity type/i);
	});

	it("rejects a winner from another org (org fence, 404)", async () => {
		const orgA = await createTestOrganization({ name: "Org A" });
		const orgB = await createTestOrganization({ name: "Org B" });
		const userA = await createTestUser();
		const userB = await createTestUser();
		await addUserToOrganization(userA.id, orgA.id, "owner");
		await addUserToOrganization(userB.id, orgB.id, "owner");
		const loser = await createTestEntity({
			name: "A-loser",
			entity_type: "person",
			organization_id: orgA.id,
			created_by: userA.id,
		});
		const foreignWinner = await createTestEntity({
			name: "B-winner",
			entity_type: "person",
			organization_id: orgB.id,
			created_by: userB.id,
		});

		await expect(
			manageEntity(
				{
					action: "merge",
					entity_id: loser.id,
					winner_entity_id: foreignWinner.id,
				},
				env,
				ctx(orgA.id, userA.id, "owner"),
			),
		).rejects.toThrow(/not found in this workspace/i);
	});

	it("queues an automation merge for human approval and applies it only after approval", async () => {
		const org = await createTestOrganization({
			name: "Automation Merge Approval Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6001, ${org.id}, 'personal-agent', ${user.id}, 6001, 'Duplicate merge',
         'active', 0, now(), now())
    `;

		const automationCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
			actingAutomationId: 6001,
			mcpSessionId: "session-entity-merge",
		} as ToolContext;
		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		expect(queued.approval_queued).toBe(true);
		const [before] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(before.merged_into).toBeNull();
		expect(before.deleted_at).toBeNull();
		const [pending] = await sql`
      SELECT automation_id, approval_status, action_input FROM runs WHERE id = ${queued.approval_run_id}
    `;
		expect(Number(pending.automation_id)).toBe(6001);
		expect(pending.approval_status).toBe("pending");
		expect((pending.action_input as Record<string, unknown>).operation).toBe(
			"merge",
		);
		const [approvalEvent] = await sql`
			SELECT title, metadata FROM current_event_records
			WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
		`;
		expect(approvalEvent.title).toBe(
			"Merge Loser into Winner — pending approval",
		);
		expect(approvalEvent.metadata).toMatchObject({
			mcp_session_id: "session-entity-merge",
		});

		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(true);

		const [after] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(Number(after.merged_into)).toBe(winner.id);
		expect(after.deleted_at).not.toBeNull();
		const [completedRun] = await sql`
			SELECT status, approval_status FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(completedRun).toMatchObject({
			status: "completed",
			approval_status: "approved",
		});
		const [completedEvent] = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(completedEvent.interaction_status).toBe("completed");
	});

	it("re-presents a merge whose fingerprint predates the current format instead of dead-ending it", async () => {
		// Replicates an unversioned proposal minted before #2152 added
		// entity_identities to the hashed inputs. Before this fix every approval
		// bounced the run back to pending with a mismatch the reviewer could not
		// clear.
		const org = await createTestOrganization({ name: "Stranded Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const automationCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
		} as ToolContext;
		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };
		expect(queued.approval_queued).toBe(true);

		// Rewrite the stored proposal into the pre-#2152 shape: a digest from the
		// old input set and no version stamp at all.
		const [minted] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		const stale = {
			...(minted.action_input as Record<string, unknown>),
			resolution_fingerprint: "0".repeat(64),
		};
		delete stale.resolution_fingerprint_version;
		await sql`
			UPDATE runs SET action_input = ${sql.json(stale)}
			WHERE id = ${queued.approval_run_id}
		`;

		// These two entities share nothing, so re-assessment proves no more than
		// the reviewer saw. An unverifiable fingerprint with no gain in evidence is
		// re-presented, not applied.
		const refreshed = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("error" in refreshed && refreshed.error).toMatch(
			/re-checked.*approve again to apply/i,
		);
		// The reviewer-facing text must not leak fingerprint-format vocabulary:
		// this string is what the approval card renders.
		expect("error" in refreshed && refreshed.error).not.toMatch(
			/fingerprint|resolution format|matching format/i,
		);

		const [untouched] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(untouched.merged_into).toBeNull();
		expect(untouched.deleted_at).toBeNull();

		// ...but the proposal is now approvable: pending, restamped, and carrying
		// a fingerprint the server can actually check.
		const [reset] = await sql`
			SELECT approval_status, status, action_input, error_message FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(reset).toMatchObject({
			approval_status: "pending",
			status: "pending",
		});
		// error_message is the column the card reads, so it carries the reviewer
		// message rather than the internal exception text.
		expect(reset.error_message).toMatch(/approve again to apply/i);
		expect(reset.error_message).not.toMatch(/resolution format/i);
		const resetInput = reset.action_input as Record<string, unknown>;
		expect(resetInput.resolution_fingerprint_version).toBe(
			RESOLUTION_FINGERPRINT_VERSION,
		);
		expect(resetInput.resolution_fingerprint).not.toBe("0".repeat(64));
		expect(resetInput.evidence_change).toEqual({
			dropped: [],
			gained: [],
		});

		const [recheckedEvent] = await sql`
			SELECT title, interaction_status, interaction_input, metadata
			FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(recheckedEvent.title).toBe(
			"entity_merge — evidence re-checked, still pending",
		);
		expect(recheckedEvent.interaction_input).toEqual(resetInput);
		expect(recheckedEvent.metadata).toMatchObject({
			current: resetInput.current,
			proposal: {
				evidence: resetInput.evidence,
				evidence_change: resetInput.evidence_change,
			},
			reason: resetInput.reason,
		});

		// Approving the re-presented card applies, ending the dead end.
		const applied = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in applied && applied.approved).toBe(true);
		const [merged] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(Number(merged.merged_into)).toBe(winner.id);
		expect(merged.deleted_at).not.toBeNull();
	});

	it("applies a legacy merge in one approval when re-assessment proves more", async () => {
		// A legacy proposal can have an unstamped fingerprint, evidence [] at
		// review time, and a phone both sides actually share.
		// Re-assessment gains that phone and drops nothing, so the reviewer's
		// approval already covers this merge and must not be asked for twice.
		const org = await createTestOrganization({ name: "Strengthened Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
			VALUES
				(${org.id}, ${winner.id}, 'phone', '+44 7700 900 123'),
				(${org.id}, ${loser.id}, 'phone', '447700900123')
		`;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };
		expect(queued.approval_queued).toBe(true);

		// Strip the evidence and version stamp to reproduce the legacy shape: the
		// reviewer saw no recorded proof and the digest cannot be compared.
		const [minted] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		const stale = {
			...(minted.action_input as Record<string, unknown>),
			resolution_fingerprint: "0".repeat(64),
			evidence: [],
		};
		delete stale.resolution_fingerprint_version;
		await sql`
			UPDATE runs SET action_input = ${sql.json(stale)}
			WHERE id = ${queued.approval_run_id}
		`;

		const applied = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in applied && applied.approved).toBe(true);

		const [merged] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(Number(merged.merged_into)).toBe(winner.id);
		expect(merged.deleted_at).not.toBeNull();
	});

	it("re-presents when new matching proof arrives with unmatched identity changes", async () => {
		const org = await createTestOrganization({ name: "Mixed Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		// The shared phone strengthens the proof, but the two different emails are
		// also new. Evidence lists matches only, so an evidence-only comparison
		// would hide the unmatched changes and apply a materially different merge.
		await sql`
			INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
			VALUES
				(${org.id}, ${winner.id}, 'phone', '+44 7700 900 123'),
				(${org.id}, ${loser.id}, 'phone', '447700900123'),
				(${org.id}, ${winner.id}, 'email', 'winner@example.com'),
				(${org.id}, ${loser.id}, 'email', 'loser@example.com')
		`;

		const refused = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("error" in refused && refused.error).toMatch(
			/re-checked.*approve again to apply/i,
		);
		const [refreshedRun] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(
			(refreshedRun.action_input as Record<string, unknown>).evidence_change,
		).toEqual({
			dropped: [],
			gained: [{ kind: "phone", identifier: "447700900123" }],
		});

		const [untouched] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(untouched.merged_into).toBeNull();
		expect(untouched.deleted_at).toBeNull();
	});

	it("re-presents a merge whose reviewed evidence no longer holds", async () => {
		// The case a second look can actually catch: the reviewer approved on a
		// shared phone, and that phone is gone by the time they clicked.
		const org = await createTestOrganization({ name: "Weakened Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
			VALUES
				(${org.id}, ${winner.id}, 'phone', '+44 7700 900 123'),
				(${org.id}, ${loser.id}, 'phone', '447700900123')
		`;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };
		const [minted] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(
			(minted.action_input as { evidence: unknown[] }).evidence.length,
		).toBeGreaterThan(0);

		// The phone that justified the merge is corrected away after review.
		await sql`
			UPDATE entity_identities SET deleted_at = now()
			WHERE organization_id = ${org.id} AND entity_id = ${loser.id}
		`;

		const refused = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("error" in refused && refused.error).toMatch(
			/no longer supports what you reviewed/i,
		);
		// The message must name the specific proof that stopped holding.
		expect("error" in refused && refused.error).toMatch(/447700900123/);

		// The card renders the delta from evidence_change, so the refreshed proposal
		// must carry it — naming the proof that was lost, and gaining nothing.
		const [refreshedRun] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(
			(refreshedRun.action_input as Record<string, unknown>).evidence_change,
		).toEqual({
			dropped: [{ kind: "phone", identifier: "447700900123" }],
			gained: [],
		});

		const [untouched] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(untouched.merged_into).toBeNull();
		expect(untouched.deleted_at).toBeNull();

		const [card] = await sql`
			SELECT title, metadata
			FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(card.title).toBe(
			"entity_merge — evidence no longer supports the merge",
		);
		expect(card.metadata).toMatchObject({
			proposal: {
				evidence_change: {
					dropped: [{ kind: "phone", identifier: "447700900123" }],
					gained: [],
				},
			},
		});
	});

	it("does not downgrade a merge fingerprint from a newer format", async () => {
		const org = await createTestOrganization({ name: "Future Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };
		expect(queued.approval_queued).toBe(true);

		const [minted] = await sql`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		const future = {
			...(minted.action_input as Record<string, unknown>),
			resolution_fingerprint_version: RESOLUTION_FINGERPRINT_VERSION + 1,
		};
		await sql`
			UPDATE runs SET action_input = ${sql.json(future)}
			WHERE id = ${queued.approval_run_id}
		`;

		const result = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("error" in result && result.error).toMatch(
			/newer resolution format/i,
		);
		const [reset] = await sql`
			SELECT approval_status, status, action_input
			FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(reset).toMatchObject({
			approval_status: "pending",
			status: "pending",
		});
		expect(reset.action_input).toEqual(future);
		const [untouched] =
			await sql`SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}`;
		expect(untouched.merged_into).toBeNull();
		expect(untouched.deleted_at).toBeNull();
	});

	it("queues review evidence for a phone shared only through entity_identities", async () => {
		const org = await createTestOrganization({ name: "Identity Evidence Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES
        (${org.id}, ${winner.id}, 'phone', '+44 7700 900 123'),
        (${org.id}, ${loser.id}, 'phone', '447700900123'),
        (${org.id}, ${loser.id}, 'wa_jid', '447700900123@s.whatsapp.net')
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as {
			approval_queued: boolean;
			resolution: {
				decision: string;
				evidence: Array<{ kind: string; identifier: string }>;
			};
		};

		expect(queued.approval_queued).toBe(true);
		expect(queued.resolution.decision).toBe("review");
		expect(queued.resolution.evidence).toContainEqual({
			kind: "phone",
			identifier: "447700900123",
		});
	});

	it("records the matching values that justify the merge on both sides of the snapshot", async () => {
		const org = await createTestOrganization({ name: "Snapshot Evidence Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      UPDATE entities SET metadata = jsonb_build_object('phone', '+90 539 510 22 40')
      WHERE id = ${winner.id} AND organization_id = ${org.id}
    `;
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES
        (${org.id}, ${loser.id}, 'phone', '905395102240'),
        (${org.id}, ${loser.id}, 'wa_jid', '905395102240@s.whatsapp.net')
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		expect(queued.approval_queued).toBe(true);
		const [run] = await sql<{ action_input: Record<string, unknown> }[]>`
			SELECT action_input FROM runs WHERE id = ${queued.approval_run_id}
		`;
		const current = (run.action_input as { current: Record<string, unknown> })
			.current as {
			winner: { resolution_keys?: Record<string, string[]> };
			duplicates: Array<{ resolution_keys?: Record<string, string[]> }>;
		};
		expect(current.winner.resolution_keys).toEqual({
			phone: ["905395102240"],
		});
		expect(current.duplicates[0]?.resolution_keys).toEqual({
			phone: ["905395102240"],
		});
		// Persist normalized policy values without copying arbitrary entity metadata.
		expect(current.winner).not.toHaveProperty("metadata");
	});

	it("records the agent session that proposed the merge, not an orphan run", async () => {
		const org = await createTestOrganization({ name: "Initiator Agent Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				agentId: "personal-agent",
				clientId: "claude-ai",
				sourceContext: { platform: "mcp", conversationId: "conv-abc" },
			} as ToolContext,
		)) as unknown as { approval_queued: boolean; approval_run_id: number };

		expect(queued.approval_queued).toBe(true);
		const [run] = await sql`
			SELECT initiator_kind, initiator_ref, created_by_user_id, automation_id
			FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("agent_session");
		expect(run.initiator_ref).toMatchObject({
			agent_id: "personal-agent",
			client_id: "claude-ai",
			conversation_id: "conv-abc",
		});
		expect(run.created_by_user_id).toBe(user.id);
		expect(run.automation_id).toBeNull();
	});

	it("keeps an automation initiator's drill-down link when another caller reuses the run", async () => {
		const org = await createTestOrganization({
			name: "Initiator Automation Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6021, ${org.id}, 'personal-agent', ${user.id}, 6021, 'Initiator automation',
         'active', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				actingAutomationId: 6021,
				baseUrl: "https://app.lobu.test",
			} as ToolContext,
		)) as unknown as {
			approval_queued: boolean;
			approval_run_id: number;
			approval_url: string;
		};

		const [run] = await sql`
			SELECT initiator_kind, initiator_ref, automation_id
			FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("automation");
		expect((run.initiator_ref as { automation_id: number }).automation_id).toBe(6021);
		expect(Number(run.automation_id)).toBe(6021);
		const expectedUrl = `https://app.lobu.test/${org.slug}/events?agent=personal-agent&automation=6021&run_ids=${queued.approval_run_id}`;
		expect(queued.approval_url).toBe(expectedUrl);

		const replay = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				agentId: "personal-agent",
				baseUrl: "https://app.lobu.test",
			} as ToolContext,
		)) as unknown as { approval_run_id: number; approval_url: string };
		expect(replay.approval_run_id).toBe(queued.approval_run_id);
		expect(replay.approval_url).toBe(expectedUrl);
	});

	it("does not let a caller-supplied automation_source forge the initiator", async () => {
		const org = await createTestOrganization({ name: "Initiator Spoof Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6022, ${org.id}, 'other-agent', ${user.id}, 6022, 'Someone elses automation',
         'active', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				automation_source: { automation_id: 6022, run_id: 1 },
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				agentId: "personal-agent",
				clientId: "claude-ai",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		const [run] = await sql`
			SELECT initiator_kind, initiator_ref FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(run.initiator_kind).toBe("agent_session");
		expect((run.initiator_ref as { agent_id: string }).agent_id).toBe(
			"personal-agent",
		);
	});

	it("carries the proposer's rationale to the card without letting it prove the merge", async () => {
		const org = await createTestOrganization({ name: "Rationale Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		const agentCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
		} as ToolContext;
		const queued = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				merge_rationale: "  Same phone digits; shell is their WhatsApp handle.  ",
			},
			env,
			agentCtx,
		)) as unknown as {
			approval_queued: boolean;
			approval_run_id: number;
			resolution: { decision: string; evidence: unknown[] };
		};

		// The rationale must not make the merge look proven: no shared email or
		// phone exists, so the decision stays review and the evidence stays empty.
		expect(queued.approval_queued).toBe(true);
		expect(queued.resolution.decision).toBe("review");
		expect(queued.resolution.evidence).toEqual([]);

		const [approvalEvent] = await sql`
			SELECT metadata FROM current_event_records
			WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
		`;
		const metadata = approvalEvent.metadata as Record<string, unknown>;
		expect(metadata.proposer_rationale).toBe(
			"Same phone digits; shell is their WhatsApp handle.",
		);
		// The policy verdict is stored separately and is not the proposer's text.
		expect(metadata.reason).not.toBe(metadata.proposer_rationale);
		expect(String(metadata.reason)).toContain("needs your judgement");
	});

	it("auto-merges an exact configured email match without human approval", async () => {
		const org = await createTestOrganization({
			name: "Strict Email Merge Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				properties: {
					email: { type: "string" },
					phone: { type: "string" },
				},
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["email"],
							normalizer: "email",
							onMatch: "auto_merge",
						},
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'Person@Example.com')
			WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'person@example.com')
			WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status, min_cooldown_seconds,
			   created_at, updated_at)
			VALUES
			  (6009, ${org.id}, 'personal-agent', ${user.id}, 6009,
			   'Strict duplicate resolution', 'active', 0,
			   now(), now())
		`;
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org.id}, 6009, 'auto', now(), now())
			RETURNING id
		`;

		const result = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				merge_evidence: [{ kind: "email", identifier: "person@example.com" }],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6009,
				actingRunId: automationRun.id,
			} as ToolContext,
		)) as unknown as {
			action: string;
			success: boolean;
			approval_queued?: boolean;
			resolution: { decision: string };
		};

		expect(result.success).toBe(true);
		expect(result.approval_queued).toBeUndefined();
		expect(result.resolution.decision).toBe("auto_merge");
		const [merged] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(Number(merged.merged_into)).toBe(winner.id);
		expect(merged.deleted_at).not.toBeNull();
		const [operation] = await sql`
			SELECT decision, source_run_id, status
			FROM entity_merge_operations
			WHERE organization_id = ${org.id}
		`;
		expect(operation).toMatchObject({
			decision: "auto_merge",
			source_run_id: automationRun.id,
			status: "active",
		});
	});

	/**
	 * A certain-identity merge by a non-user actor, on a type whose write rule
	 * has the given verdict. Returns the ctx and ids so a caller can drive the
	 * merge and read back what did (or did not) happen.
	 */
	async function autoMergeCandidateWithRule(
		orgName: string,
		ruleSource: string,
		seed: number,
	) {
		const org = await createTestOrganization({ name: orgName });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();

		// The identity rule is certain (exact email) — policy alone would auto-merge.
		await sql`
			UPDATE entity_types
			SET rules_compiled = ${await compileEntityRule(ruleSource)},
			    metadata_schema = ${sql.json({
						type: "object",
						properties: { email: { type: "string" }, status: { type: "string" } },
						"x-lobu-resolution": {
							rules: [
								{
									fields: ["email"],
									normalizer: "email",
									onMatch: "auto_merge",
								},
							],
						},
					})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'Person@Example.com', 'status', 'open')
			WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('email', 'person@example.com', 'status', 'open')
			WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status, min_cooldown_seconds,
			   created_at, updated_at)
			VALUES
			  (${seed}, ${org.id}, 'personal-agent', ${user.id}, ${seed},
			   'Escalating duplicate resolution', 'active', 0,
			   now(), now())
		`;
		const [automationRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, automation_id,
			   approval_status, created_at, completed_at)
			VALUES
			  ('automation', 'completed', ${org.id}, ${seed}, 'auto', now(), now())
			RETURNING id
		`;
		const agentCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
			actingAutomationId: seed,
			actingRunId: automationRun.id,
		} as ToolContext;
		return { org, user, sql, winner, loser, agentCtx };
	}

	const ESCALATE_MERGE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.escalate(["$merged_into"], "a merge needs a second pair of eyes");
  }
};
`;

	async function countRuns(orgId: string): Promise<number> {
		const sql = getTestDb();
		const rows = await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM runs
			WHERE organization_id = ${orgId} AND action_key IS NOT NULL
		`;
		return Number(rows[0]?.n ?? 0);
	}

	/**
	 * The case the escalate-to-card work deliberately left uncovered: a NON-USER
	 * actor whose deterministic identity rule says `auto_merge`, on a type whose
	 * write rule escalates `$merged_into`.
	 *
	 * Resolution policy and the type's write rule answer different questions.
	 * Policy asks "is this the same record?" — the identity rule is certain, so it
	 * says merge without asking. The write rule asks "may this record be merged
	 * away?" — and an escalate is the tenant saying "not without a human". The
	 * second must win: certainty about identity is not consent to the write.
	 *
	 * Failing closed with a 409 is the wrong shape for that. It is the same
	 * verdict the delete path used to produce before it minted a card, and it
	 * leaves an automation with no path forward — the merge can never happen, and
	 * no human is ever asked. The escalate already names exactly the field the
	 * merge card's replay grants, so the card can carry it.
	 */
	it("cards an auto_merge whose write rule escalates, instead of failing it closed", async () => {
		const { org, user, sql, winner, loser, agentCtx } =
			await autoMergeCandidateWithRule(
				"Escalating Merge Org",
				ESCALATE_MERGE_RULE,
				6011,
			);

		const result = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
			},
			env,
			agentCtx,
		)) as unknown as {
			success?: boolean;
			approval_queued?: boolean;
			approval_run_id?: number;
			resolution?: { decision: string; reason: string };
		};

		// Carded, not applied and not thrown.
		expect(result.success).toBeUndefined();
		expect(result.approval_queued).toBe(true);
		expect(result.approval_run_id).toEqual(expect.any(Number));
		// The card says WHY it is waiting: the rule's words, not the policy's.
		expect(result.resolution?.reason).toMatch(/second pair of eyes/);

		// Nothing moved while the card waits.
		const [after] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).toBeNull();

		// The persisted card is a merge proposal for exactly this pair.
		const [run] = await sql<{ action_input: Record<string, unknown> }[]>`
			SELECT action_input FROM runs WHERE id = ${result.approval_run_id}
		`;
		expect(run.action_input.operation).toBe("merge");
		expect(run.action_input.winner_entity_id).toBe(winner.id);
		expect(run.action_input.entity_ids).toEqual([loser.id]);

		// And the card is REPLAYABLE: approving it grants `$merged_into`, so the
		// rule that escalated does not escalate the very merge it asked for. A
		// card a human approves and that then throws would be worse than the 409.
		const approved = await manageOperations(
			{ action: "approve", run_id: result.approval_run_id as number },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(true);
		const [applied] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(Number(applied.merged_into)).toBe(winner.id);
		expect(applied.deleted_at).not.toBeNull();
	});

	/**
	 * The gates that keep the card honest, and the reason the routing is narrow.
	 * A merge card's replay grants exactly `[$merged_into]` — a hardcoded literal
	 * at the apply site. Minting a card for any other verdict produces one that
	 * throws the moment a reviewer approves it, spending a human decision on a
	 * write that was never going to land. A deny is not a request for review at
	 * all, and approval must never launder one into a merge.
	 */
	it("does NOT card a merge the write rule DENIES", async () => {
		const { org, sql, winner, loser, agentCtx } =
			await autoMergeCandidateWithRule(
				"Denying Merge Org",
				`
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.deny("a posted record cannot be merged away");
  }
};
`,
				6021,
			);
		const before = await countRuns(org.id);

		await expect(
			manageEntity(
				{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
				env,
				agentCtx,
			),
		).rejects.toThrow(/cannot be merged away/);

		const [after] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).toBeNull();
		expect(await countRuns(org.id)).toBe(before);
	});

	it("does NOT card an escalate naming a field the merge card cannot grant", async () => {
		// `$merged_into` ALONGSIDE a field the card never grants: the dangerous
		// shape, because a guard that merely looks for `$merged_into` in the list
		// would card it, and the replay re-escalates on `status` the moment a
		// reviewer approves.
		const { org, sql, winner, loser, agentCtx } =
			await autoMergeCandidateWithRule(
				"Escalates Elsewhere Merge Org",
				`
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.escalate(["$merged_into", "status"], "a reviewer must confirm the status first");
  }
};
`,
				6031,
			);
		const before = await countRuns(org.id);

		await expect(
			manageEntity(
				{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
				env,
				agentCtx,
			),
		).rejects.toThrow(/status/);

		const [after] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).toBeNull();
		expect(await countRuns(org.id)).toBe(before);
	});

	it("does NOT card an escalation that names no fields at all", async () => {
		// An empty field list grants nothing, so the replay re-escalates forever.
		// The guard must test the list's CONTENTS, not just that every member is
		// `$merged_into` — `[].every(...)` is vacuously true.
		const { org, sql, winner, loser, agentCtx } =
			await autoMergeCandidateWithRule(
				"Escalates Nothing Merge Org",
				`
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.escalate([], "somebody should look at this");
  }
};
`,
				6041,
			);
		const before = await countRuns(org.id);

		await expect(
			manageEntity(
				{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
				env,
				agentCtx,
			),
		).rejects.toThrow(/approval required/);

		const [after] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).toBeNull();
		expect(await countRuns(org.id)).toBe(before);
	});

	it("discovers duplicate groups server-side from candidate IDs", async () => {
		const org = await createTestOrganization({
			name: "Duplicate Discovery Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["email"],
							normalizer: "email",
							onMatch: "auto_merge",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities SET metadata = ${sql.json({
				email: "same@example.com",
				title: "Canonical",
			})} WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities SET metadata = ${sql.json({
				email: " SAME@example.com ",
			})} WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6010, ${org.id}, 'personal-agent', ${user.id}, 6010,
			   'Duplicate discovery', 'active', 0, now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6010,
			} as ToolContext,
		);
		expect(result).toMatchObject({
			action: "resolve_duplicates",
			candidates_scanned: 2,
			groups_found: 1,
			auto_merged: 1,
			approvals_queued: 0,
		});
		const [merged] = await sql`
			SELECT merged_into FROM entities WHERE id = ${loser.id}
		`;
		expect(Number(merged.merged_into)).toBe(winner.id);
	});

	it("discovers review-only person duplicates without a schema extension", async () => {
		const org = await createTestOrganization({
			name: "Default Person Resolution Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: "same@example.com" })}
			WHERE id = ${winner.id}
		`;
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: " SAME@example.com " })}
			WHERE id = ${loser.id}
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6013, ${org.id}, 'personal-agent', ${user.id}, 6013,
			   'Default person resolution', 'active', 0,
			   now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6013,
			} as ToolContext,
		);

		expect(result).toMatchObject({
			action: "resolve_duplicates",
			groups_found: 1,
			auto_merged: 0,
			approvals_queued: 1,
		});
		const [pending] = await sql`
			SELECT approval_status, action_input
			FROM runs
			WHERE organization_id = ${org.id}
			  AND automation_id = 6013
			  AND run_type = 'internal'
		`;
		expect(pending.approval_status).toBe("pending");
		expect(pending.action_input).toMatchObject({
			operation: "merge",
			winner_entity_id: winner.id,
			entity_ids: [loser.id],
		});
	});

	it("queues one review item per duplicate discovered in the same component", async () => {
		const org = await createTestOrganization({
			name: "Individual Duplicate Review Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const secondLoser = await createTestEntity({
			name: "Second Loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ phone: "+44 123 456 789" })}
			WHERE id IN (${winner.id}, ${loser.id}, ${secondLoser.id})
		`;
		await sql`
			UPDATE entities
			SET metadata = metadata || ${sql.json({ title: "Canonical" })}
			WHERE id = ${winner.id}
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6012, ${org.id}, 'personal-agent', ${user.id}, 6012,
			   'Individual duplicate review', 'active', 0,
			   now(), now())
		`;

		const result = await manageEntity(
			{
				action: "resolve_duplicates",
				candidate_entity_ids: [winner.id, loser.id, secondLoser.id],
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6012,
			} as ToolContext,
		);
		expect(result).toMatchObject({
			action: "resolve_duplicates",
			groups_found: 1,
			auto_merged: 0,
			approvals_queued: 2,
		});
		const pending = await sql<{ action_input: Record<string, unknown> }[]>`
			SELECT action_input
			FROM runs
			WHERE organization_id = ${org.id}
			  AND automation_id = 6012
			  AND run_type = 'internal'
			  AND approval_status = 'pending'
			ORDER BY id
		`;
		expect(pending).toHaveLength(2);
		expect(pending.map((row) => row.action_input.entity_ids)).toEqual(
			expect.arrayContaining([[loser.id], [secondLoser.id]]),
		);
	});

	it("suppresses a rejected candidate until its policy or evidence changes", async () => {
		const org = await createTestOrganization({
			name: "Rejected Resolution Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6011, ${org.id}, 'personal-agent', ${user.id}, 6011,
			   'Rejected resolution', 'active', 0, now(), now())
		`;
		const automationCtx = {
			...ctx(org.id, user.id, "owner"),
			userId: null,
			agentId: "personal-agent",
			actingAutomationId: 6011,
		} as ToolContext;
		const first = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx,
		)) as unknown as { approval_run_id: number };
		await manageOperations(
			{ action: "reject", run_id: first.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);

		const unchanged = await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx,
		);
		expect(unchanged).toMatchObject({
			action: "merge",
			approval_suppressed: true,
		});

		await sql`
			UPDATE entities
			SET metadata = jsonb_build_object('phone', '+44 123 456 789')
			WHERE id IN (${winner.id}, ${loser.id})
		`;
		await sql`
			UPDATE entity_types
			SET metadata_schema = ${sql.json({
				type: "object",
				"x-lobu-resolution": {
					rules: [
						{
							fields: ["phone"],
							normalizer: "phone",
							onMatch: "review",
						},
					],
				},
			})}
			WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${winner.id})
		`;
		const changed = await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx,
		);
		expect(changed).toMatchObject({
			action: "merge",
			approval_queued: true,
		});
	});

	it("does not apply an identical pending proposal after another run rejects it", async () => {
		const org = await createTestOrganization({
			name: "Cross Window Rejection Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ email: "same@example.com" })}
			WHERE id IN (${winner.id}, ${loser.id})
		`;
		await sql`
			INSERT INTO automations
			  (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
			   status,
			   min_cooldown_seconds, created_at, updated_at)
			VALUES
			  (6014, ${org.id}, 'personal-agent', ${user.id}, 6014,
			   'Cross-window resolution', 'active', 0,
			   now(), now())
		`;
		const sourceRuns = await sql<{ id: number }[]>`
			INSERT INTO runs (organization_id, automation_id, run_type, status)
			VALUES
				(${org.id}, 6014, 'automation', 'completed'),
				(${org.id}, 6014, 'automation', 'completed')
			RETURNING id
		`;
		const automationCtx = (runId: number) =>
			({
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6014,
				actingRunId: runId,
			}) as ToolContext;
		const first = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx(sourceRuns[0].id),
		)) as unknown as { approval_run_id: number };
		const second = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			automationCtx(sourceRuns[1].id),
		)) as unknown as { approval_run_id: number };
		expect(second.approval_run_id).not.toBe(first.approval_run_id);

		// Make the second run look legacy. Its stored fingerprint differs from the
		// current candidate, so approval must check rejection memory against both
		// the reviewed and re-assessed fingerprints.
		const [secondRun] = await sql`
			SELECT action_input FROM runs WHERE id = ${second.approval_run_id}
		`;
		const legacySecond = {
			...(secondRun.action_input as Record<string, unknown>),
			resolution_fingerprint: "0".repeat(64),
			evidence: [],
		};
		delete legacySecond.resolution_fingerprint_version;
		await sql`
			UPDATE runs SET action_input = ${sql.json(legacySecond)}
			WHERE id = ${second.approval_run_id}
		`;

		await manageOperations(
			{ action: "reject", run_id: first.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		const approval = await manageOperations(
			{ action: "approve", run_id: second.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect(approval).toMatchObject({
			error: expect.stringContaining("already rejected"),
		});

		const [entity] = await sql`
			SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
		`;
		expect(entity.merged_into).toBeNull();
		expect(entity.deleted_at).toBeNull();
		const decisions = await sql`
			SELECT id, approval_status, status
			FROM runs
			WHERE id IN (${first.approval_run_id}, ${second.approval_run_id})
			ORDER BY id
		`;
		expect(decisions).toEqual([
			expect.objectContaining({ approval_status: "rejected", status: "cancelled" }),
			expect.objectContaining({ approval_status: "rejected", status: "cancelled" }),
		]);
	});

	it("repairs a legacy pending run that has no approval event", async () => {
		const org = await createTestOrganization({ name: "Orphan Approval Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		const [orphan] = await sql<{ id: number }[]>`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input,
				approval_status, status
			) VALUES (
				${org.id}, 'internal', 'entity_change',
				${sql.json({
					operation: "merge",
					entity_id: loser.id,
					entity_ids: [loser.id],
					winner_entity_id: winner.id,
					current: { loser: {}, duplicates: [{}], winner: {} },
				})},
				'pending', 'pending'
			)
			RETURNING id
		`;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		expect(queued.approval_run_id).toBe(Number(orphan.id));
		const [repaired] = await sql`
			SELECT idempotency_key,
			       (SELECT count(*)::int FROM current_event_records e
			        WHERE e.run_id = runs.id AND e.interaction_status = 'pending') AS event_count
			FROM runs
			WHERE id = ${orphan.id}
		`;
		expect(repaired.idempotency_key).toMatch(/^entity-change:/);
		expect(Number(repaired.event_count)).toBe(1);
	});

	it("queues one atomic automation approval for a duplicate group", async () => {
		const org = await createTestOrganization({
			name: "Group Merge Approval Org",
		});
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const secondLoser = await createTestEntity({
			name: "Second loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: "google-contacts",
			display_name: "Personal Google Contacts",
			created_by: user.id,
			createDefaultFeed: false,
		});
		await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, source_connector, connection_id)
      VALUES
        (${org.id}, ${loser.id}, 'email', 'duplicate@example.com',
         'connector:google-contacts', ${connection.id})
    `;
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6003, ${org.id}, 'personal-agent', ${user.id}, 6003, 'Group duplicate merge',
         'active', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{
				action: "merge",
				duplicate_entity_ids: [loser.id, secondLoser.id],
				winner_entity_id: winner.id,
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6003,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		const [pending] = await sql`
			SELECT action_input, idempotency_key FROM runs WHERE id = ${queued.approval_run_id}
		`;
		expect(pending.action_input).toMatchObject({
			operation: "merge",
			entity_ids: [loser.id, secondLoser.id],
			winner_entity_id: winner.id,
		});
		expect(pending.idempotency_key).toMatch(/^entity-change:/);
		const [approvalEvent] = await sql`
      SELECT title, metadata FROM current_event_records
      WHERE run_id = ${queued.approval_run_id} AND interaction_status = 'pending'
    `;
		expect(approvalEvent.title).toBe(
			"Merge 2 person duplicates into Winner — pending approval",
		);
		const current = (approvalEvent.metadata as Record<string, unknown>)
			.current as {
			duplicates: Array<{
				href: string;
				identities: Array<Record<string, unknown>>;
			}>;
		};
		expect(current.duplicates[0]?.href).toContain("/person/");
		expect(current.duplicates[0]).not.toHaveProperty("metadata");
		expect(current.duplicates[0]?.identities[0]).toMatchObject({
			identifier: "duplicate@example.com",
			connection_id: connection.id,
			connection_name: "Personal Google Contacts",
			connector_key: "google-contacts",
		});
		expect(current.duplicates[0]?.identities[0]?.connection_href).toContain(
			`/connectors/google-contacts/${connection.id}`,
		);

		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(true);
		const rows = await sql`
      SELECT id, merged_into, deleted_at
      FROM entities
      WHERE id IN (${loser.id}, ${secondLoser.id})
      ORDER BY id
    `;
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => Number(row.merged_into) === winner.id)).toBe(
			true,
		);
		expect(rows.every((row) => row.deleted_at !== null)).toBe(true);
	});

	it("rolls back the whole duplicate group when one member is stale", async () => {
		const org = await createTestOrganization({ name: "Stale Group Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const staleLoser = await createTestEntity({
			name: "Stale loser",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6004, ${org.id}, 'personal-agent', ${user.id}, 6004, 'Stale group merge',
         'active', 0, now(), now())
    `;
		const queued = (await manageEntity(
			{
				action: "merge",
				duplicate_entity_ids: [loser.id, staleLoser.id],
				winner_entity_id: winner.id,
			},
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6004,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`UPDATE entities SET deleted_at = now() WHERE id = ${staleLoser.id}`;
		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);
		expect("approved" in approved && approved.approved).toBe(false);
		const [first] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
		expect(first.merged_into).toBeNull();
		expect(first.deleted_at).toBeNull();
		const [run] = await sql`
			SELECT approval_status, status
			FROM runs
			WHERE id = ${queued.approval_run_id}
		`;
		expect(run).toMatchObject({
			approval_status: "pending",
			status: "pending",
		});
		const [approvalEvent] = await sql`
			SELECT interaction_status
			FROM current_event_records
			WHERE run_id = ${queued.approval_run_id}
		`;
		expect(approvalEvent.interaction_status).toBe("pending");
	});

	it("does not apply an approved merge when an identity row appeared after proposal", async () => {
		const org = await createTestOrganization({ name: "Identity Staleness Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6015, ${org.id}, 'personal-agent', ${user.id}, 6015, 'Identity staleness',
         'active', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6015,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${loser.id}, 'phone', '447700900123')
    `;
		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);

		expect("approved" in approved && approved.approved).toBe(false);
		const [after] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).toBeNull();
	});

	it("locks identity evidence until the staleness-checked transaction finishes", async () => {
		const org = await createTestOrganization({ name: "Identity Lock Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
			INSERT INTO entity_identities
			  (organization_id, entity_id, namespace, identifier)
			VALUES (${org.id}, ${loser.id}, 'phone', '447700900123')
		`;
		const assessment = assessEntityResolution({
			metadataSchema: { type: "object" },
			entityTypeSlug: "person",
			winner: { id: winner.id, metadata: {} },
			losers: [
				{
					id: loser.id,
					metadata: {},
					identities: [{ namespace: "phone", identifier: "447700900123" }],
				},
			],
		});
		const writer = postgres(process.env.DATABASE_URL as string, {
			max: 1,
			onnotice: () => {},
			...PROD_PG_VALUE_OPTIONS,
		});
		try {
			await sql.begin(async (tx) => {
				await assertResolutionFingerprintCurrent(tx, {
					organizationId: org.id,
					winnerId: winner.id,
					loserIds: [loser.id],
					expectedFingerprint: assessment.fingerprint,
					expectedVersion: RESOLUTION_FINGERPRINT_VERSION,
				});
				await expect(
					writer.begin(async (writerTx) => {
						await writerTx`SET LOCAL lock_timeout = '100ms'`;
						await writerTx`
							UPDATE entity_identities
							SET identifier = '447700900124'
							WHERE organization_id = ${org.id}
							  AND entity_id = ${loser.id}
							  AND deleted_at IS NULL
						`;
					}),
				).rejects.toMatchObject({ code: "55P03" });
			});
		} finally {
			await writer.end();
		}
	});

	it("serializes decisions for one entity group across differing fingerprints", async () => {
		// The lock used to be keyed on the resolution fingerprint. Refresh rotates
		// that fingerprint, so two reviewers holding different reviewed digests for
		// the SAME pair took two different locks and could race past each other's
		// rejection memory. Keying on the entity group is what makes them contend.
		const org = await createTestOrganization({ name: "Candidate Lock Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const other = await createTestEntity({
			name: "Unrelated",
			entity_type: "person",
			organization_id: org.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		const contender = postgres(process.env.DATABASE_URL as string, {
			max: 1,
			onnotice: () => {},
			...PROD_PG_VALUE_OPTIONS,
		});
		try {
			await sql.begin(async (tx) => {
				await lockResolutionCandidate(tx, {
					organizationId: org.id,
					winnerId: winner.id,
					loserIds: [loser.id],
				});

				// Same pair, and the caller need not even know the fingerprint: it is
				// no longer part of the key, so this must block.
				await expect(
					contender.begin(async (contenderTx) => {
						await contenderTx`SET LOCAL lock_timeout = '150ms'`;
						await lockResolutionCandidate(contenderTx, {
							organizationId: org.id,
							winnerId: winner.id,
							loserIds: [loser.id],
						});
					}),
				).rejects.toMatchObject({ code: "55P03" });

				// Order must not matter either — the key is the sorted group, so the
				// same pair with winner and loser swapped is the same candidate.
				await expect(
					contender.begin(async (contenderTx) => {
						await contenderTx`SET LOCAL lock_timeout = '150ms'`;
						await lockResolutionCandidate(contenderTx, {
							organizationId: org.id,
							winnerId: loser.id,
							loserIds: [winner.id],
						});
					}),
				).rejects.toMatchObject({ code: "55P03" });

				// ...but an unrelated candidate must NOT be serialized, or every merge
				// in the workspace would queue behind one review.
				await expect(
					contender.begin(async (contenderTx) => {
						await contenderTx`SET LOCAL lock_timeout = '150ms'`;
						await lockResolutionCandidate(contenderTx, {
							organizationId: org.id,
							winnerId: winner.id,
							loserIds: [other.id],
						});
						return "acquired";
					}),
				).resolves.toBe("acquired");
			});
		} finally {
			await contender.end();
		}
	});

	it("does not apply an approved automation merge when the loser was deleted after proposal", async () => {
		const org = await createTestOrganization({ name: "Stale Merge Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const { winner, loser } = await twoEntities(org.id, user.id);
		const sql = getTestDb();
		await sql`
      INSERT INTO automations
        (id, organization_id, managed_agent_id, created_by, automation_group_id, name,
         status, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (6002, ${org.id}, 'personal-agent', ${user.id}, 6002, 'Stale duplicate merge',
         'active', 0, now(), now())
    `;

		const queued = (await manageEntity(
			{ action: "merge", entity_id: loser.id, winner_entity_id: winner.id },
			env,
			{
				...ctx(org.id, user.id, "owner"),
				userId: null,
				agentId: "personal-agent",
				actingAutomationId: 6002,
			} as ToolContext,
		)) as unknown as { approval_run_id: number };

		await sql`UPDATE entities SET deleted_at = now() WHERE id = ${loser.id}`;
		const approved = await manageOperations(
			{ action: "approve", run_id: queued.approval_run_id },
			env,
			ctx(org.id, user.id, "owner"),
		);

		expect("approved" in approved && approved.approved).toBe(false);
		const [after] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
		expect(after.merged_into).toBeNull();
		expect(after.deleted_at).not.toBeNull();
	});
});
