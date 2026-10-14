/**
 * Which runs may be decided from a chat card.
 *
 * `resolveEntityApprovalRun`'s query IS the authorization boundary: the click
 * handler acts on whatever it reports `pending`. Widening it to admit connector
 * operations (`run_type = 'action'`) is what put Approve/Reject on those cards,
 * so the boundary is pinned here directly against a real DB rather than
 * inferred from the handler.
 */

import { afterAll, describe, expect, it } from "vitest";
import { resolveEntityApprovalRun } from "../../../gateway/connections/interaction-bridge";
import { ENTITY_CHANGE_ACTION_KEYS } from "../../../tools/admin/run-decider";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

async function seedRun(opts: {
	organizationId: string;
	runType: string;
	actionKey: string;
	/** Omit for a pending run; pass null to seed a run with NO approval status. */
	approvalStatus?: string | null;
	ownerUserId?: string | null;
}): Promise<number> {
	const sql = getTestDb();
	const approvalStatus =
		"approvalStatus" in opts ? opts.approvalStatus : "pending";
	const actionInput = opts.ownerUserId
		? sql.json({ owner_user_id: opts.ownerUserId })
		: null;
	const [row] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, approval_status, status,
			action_input, created_at
		) VALUES (
			${opts.organizationId}, ${opts.runType}, ${opts.actionKey},
			${approvalStatus}, 'pending',
			${actionInput}, now()
		)
		RETURNING id
	`;
	return Number(row.id);
}

afterAll(async () => {
	await cleanupTestDatabase();
});

describe("runs decidable from a chat card", () => {
	it("admits a connector operation run", async () => {
		const org = await createTestOrganization();
		const runId = await seedRun({
			organizationId: org.id,
			runType: "action",
			actionKey: "os.shell.run",
		});
		expect(await resolveEntityApprovalRun(runId, org.id)).toEqual({
			state: "pending",
			ownerUserId: null,
		});
	});

	it("never reads an approver out of a connector operation's input", async () => {
		// For an action run, action_input IS the agent-authored operation input.
		// An `owner_user_id` planted there must not become a decision grant.
		const org = await createTestOrganization();
		const runId = await seedRun({
			organizationId: org.id,
			runType: "action",
			actionKey: "os.shell.run",
			ownerUserId: "user_planted_by_agent",
		});
		expect(await resolveEntityApprovalRun(runId, org.id)).toEqual({
			state: "pending",
			ownerUserId: null,
		});
	});

	it("still admits an entity-change run", async () => {
		const org = await createTestOrganization();
		const runId = await seedRun({
			organizationId: org.id,
			runType: "internal",
			actionKey: ENTITY_CHANGE_ACTION_KEYS[0] as string,
			ownerUserId: "user_owner_1",
		});
		expect(await resolveEntityApprovalRun(runId, org.id)).toEqual({
			state: "pending",
			ownerUserId: "user_owner_1",
		});
	});

	it("refuses an internal run that is not an entity change", async () => {
		// The widening must not become "any internal run is decidable".
		const org = await createTestOrganization();
		const runId = await seedRun({
			organizationId: org.id,
			runType: "internal",
			actionKey: "some.other.internal.job",
		});
		expect(await resolveEntityApprovalRun(runId, org.id)).toEqual({
			state: "not_found",
			ownerUserId: null,
		});
	});

	it("refuses a run belonging to another organization", async () => {
		const owner = await createTestOrganization();
		const other = await createTestOrganization();
		const runId = await seedRun({
			organizationId: owner.id,
			runType: "action",
			actionKey: "github.create_issue",
		});
		expect(await resolveEntityApprovalRun(runId, other.id)).toEqual({
			state: "not_found",
			ownerUserId: null,
		});
	});

	it("reports an already-decided connector run instead of re-deciding it", async () => {
		const org = await createTestOrganization();
		for (const status of ["approved", "rejected"] as const) {
			const runId = await seedRun({
				organizationId: org.id,
				runType: "action",
				actionKey: "github.create_issue",
				approvalStatus: status,
			});
			expect((await resolveEntityApprovalRun(runId, org.id)).state).toBe(status);
		}
	});

	it("reports a run with no approval status as not_found", async () => {
		const org = await createTestOrganization();
		const runId = await seedRun({
			organizationId: org.id,
			runType: "action",
			actionKey: "github.create_issue",
			approvalStatus: null,
		});
		expect((await resolveEntityApprovalRun(runId, org.id)).state).toBe(
			"not_found",
		);
	});
});
