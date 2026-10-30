/**
 * One open proposal per record field set, and proposers can withdraw.
 *
 * An Automation that re-proposes the same field every run must not stack a new
 * approval card per run: while a card for those fields awaits a decision, every
 * later proposal reuses it. A withdrawn proposal settles as expired, never as a
 * human rejection, and only its proposer or a workspace admin may withdraw it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { proposeEntityFieldChange } from "../../../tools/admin/entity-field-approval";
import { manageOperations } from "../../../tools/admin/manage_operations";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	seedOwnerContext,
} from "../../setup/test-fixtures";

async function fixture() {
	await initWorkspaceProvider();
	const { org, user: owner, ctx: ownerCtx } = await seedOwnerContext({
		orgName: "One Open Proposal Org",
	});
	const proposer = await createTestAgent({ organizationId: org.id });
	const other = await createTestAgent({ organizationId: org.id });
	const entity = await createTestEntity({
		name: "Review the call",
		organization_id: org.id,
		created_by: owner.id,
	});
	const agentCtx = (agentId: string) =>
		({
			organizationId: org.id,
			userId: null,
			agentId,
			memberRole: null,
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
		}) as unknown as ToolContext;
	const propose = (fields: Record<string, unknown>, agentId = proposer.agentId) =>
		proposeEntityFieldChange(agentCtx(agentId), {
			entity_id: entity.id,
			fields,
			current: Object.fromEntries(Object.keys(fields).map((key) => [key, ""])),
			attribution: "agent",
		});
	return { org, entity, proposer, other, agentCtx, ownerCtx, propose };
}

async function pendingCards(organizationId: string) {
	return getTestDb()`
		SELECT run_id FROM current_event_records
		WHERE organization_id = ${organizationId}
		  AND interaction_type = 'approval'
		  AND interaction_status = 'pending'
	`;
}

describe("one open proposal per record field set", () => {
	beforeEach(cleanupTestDatabase);

	it("reuses the open card when the same fields are re-proposed with new wording", async () => {
		const { org, propose } = await fixture();
		const first = await propose({ draft: "Recap v1" });
		const second = await propose({ draft: "Recap v2" });
		const third = await propose({ draft: "Recap v3" });

		expect(second.runId).toBe(first.runId);
		expect(third.runId).toBe(first.runId);
		expect(await pendingCards(org.id)).toHaveLength(1);
	});

	it("opens a separate card for a different field set", async () => {
		const { propose } = await fixture();
		const draft = await propose({ draft: "Recap" });
		const status = await propose({ status: "done" });
		const both = await propose({ draft: "Recap", status: "done" });

		expect(new Set([draft.runId, status.runId, both.runId]).size).toBe(3);
	});

	it("compares field sets independently of JavaScript and database sort order", async () => {
		const { org, propose } = await fixture();
		// UTF-16 sorts the supplementary character before the BMP character;
		// Postgres's UTF-8 byte order sorts them in the opposite order.
		const first = await propose({ "\u{10000}": "first", "\uE000": "first" });
		const next = await propose({ "\uE000": "next", "\u{10000}": "next" });

		expect(next.runId).toBe(first.runId);
		expect(await pendingCards(org.id)).toHaveLength(1);
	});

	it("keeps a separate card per producing run for batched proposals", async () => {
		const { org, entity, proposer, agentCtx } = await fixture();
		const runs = await getTestDb()<{ id: number }[]>`
			INSERT INTO runs (organization_id, run_type, status)
			VALUES (${org.id}, 'automation', 'completed'), (${org.id}, 'automation', 'completed')
			RETURNING id
		`;
		const proposeIn = (parentRunId: number, draft: string) =>
			proposeEntityFieldChange(
				agentCtx(proposer.agentId),
				{ entity_id: entity.id, fields: { draft }, current: { draft: "" }, attribution: "agent" },
				parentRunId,
			);
		const first = await proposeIn(Number(runs[0]?.id), "Recap v1");
		const second = await proposeIn(Number(runs[1]?.id), "Recap v2");

		expect(second.runId).not.toBe(first.runId);
	});

	it("opens a fresh card once the earlier one is decided", async () => {
		const { propose } = await fixture();
		const first = await propose({ draft: "Recap v1" });
		await getTestDb()`
			UPDATE runs SET approval_status = 'rejected', status = 'cancelled'
			WHERE id = ${first.runId}
		`;
		const next = await propose({ draft: "Recap v2" });

		expect(next.runId).not.toBe(first.runId);
	});

	it("collapses concurrent differently worded proposals to one card", async () => {
		const { org, propose } = await fixture();
		const proposals = await Promise.all(
			Array.from({ length: 6 }, (_, i) => propose({ draft: `Recap ${i}` })),
		);

		expect(new Set(proposals.map((p) => p.runId)).size).toBe(1);
		expect(await pendingCards(org.id)).toHaveLength(1);
	});
});

describe("withdrawing a pending proposal", () => {
	beforeEach(cleanupTestDatabase);

	it("lets the proposer withdraw it as expired, not rejected, and records who", async () => {
		const { org, proposer, agentCtx, propose } = await fixture();
		const { runId } = await propose({ draft: "Recap" });

		const result = await manageOperations(
			{ action: "cancel", run_id: runId },
			{} as Env,
			agentCtx(proposer.agentId),
		);

		expect(result).toMatchObject({ status: "cancelled", cancelled: true });
		const [run] = await getTestDb()`
			SELECT status, approval_status FROM runs WHERE id = ${runId}
		`;
		expect(run).toMatchObject({ status: "cancelled", approval_status: "expired" });
		const [card] = await getTestDb()`
			SELECT interaction_status, metadata FROM current_event_records
			WHERE run_id = ${runId} AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("rejected");
		expect(card?.metadata).toMatchObject({
			approval_status: "expired",
			withdrawn_by: { principal_kind: "agent", principal_id: proposer.agentId },
		});
		expect(await pendingCards(org.id)).toHaveLength(0);
	});

	it("refuses another agent and lets a workspace admin withdraw", async () => {
		const { other, agentCtx, ownerCtx, propose } = await fixture();
		const { runId } = await propose({ draft: "Recap" });

		expect(
			await manageOperations(
				{ action: "cancel", run_id: runId },
				{} as Env,
				agentCtx(other.agentId),
			),
		).toHaveProperty("error");
		expect(
			await manageOperations({ action: "cancel", run_id: runId }, {} as Env, ownerCtx),
		).toMatchObject({ status: "cancelled", cancelled: true });
	});

	it("does not withdraw a proposal a human already decided", async () => {
		const { ownerCtx, propose } = await fixture();
		const { runId } = await propose({ draft: "Recap" });
		await getTestDb()`
			UPDATE runs SET approval_status = 'rejected', status = 'cancelled'
			WHERE id = ${runId}
		`;

		expect(
			await manageOperations({ action: "cancel", run_id: runId }, {} as Env, ownerCtx),
		).toHaveProperty("error");
		const [run] = await getTestDb()`SELECT approval_status FROM runs WHERE id = ${runId}`;
		expect(run?.approval_status).toBe("rejected");
	});
});
