/**
 * An escalated card is ONE unit at propose time, so it must be one unit at
 * apply time too.
 *
 * `updateEntity` defers the WHOLE proposal when a rule escalates — the card
 * comment says so explicitly: "the card carries the entire proposal, so
 * approving it re-runs the whole thing as one legal transition instead of the
 * fragment that could not stand on its own."
 *
 * But the apply path stale-skips per field. So if any single field of an
 * escalated card diverges between propose and approve, that field is dropped
 * and the REST of the card commits — the exact fragment the propose-time
 * comment promised would never exist. The human consented to a coupled
 * transition and got half of it.
 *
 * Sequence under test:
 *   1. an agent proposes `{ amount: 90000, vendor: "ACME" }`
 *   2. the rule escalates `amount`, so the WHOLE write defers as one card
 *   3. a human edits `amount` to a legal value before deciding the card
 *   4. the approver approves the card
 *
 * Correct: nothing commits. The reviewed unit no longer describes the row, so
 * the whole apply rolls back and the run resolves as skipped (stale) — the
 * newer human value stands and no fragment is written.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import {
	applyEntityChangeProposal,
	applyEntityFieldChangeProposal,
	proposeEntityCreate,
	proposeEntityDelete,
} from "../../../tools/admin/entity-field-approval";
import { manageOperations } from "../../../tools/admin/manage_operations";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import { ensureMemberEntityType } from "../../../utils/member-entity-type";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/**
 * Escalates on size alone. No frozen-state loop and no deny, so the residual
 * cannot trip a denial before the escalation under test is reached, and the
 * human's intervening correction to a legal amount applies outright.
 */
const ESCALATE_ON_SIZE_RULE = `
export default (row) => {
  if (row.op === "create") return;
  if (row.next.amount > 50000) {
    row.escalate(["amount"], "an invoice over 50k needs sign-off");
  }
};
`;

/** Escalates on the DELETE itself, so applying the card re-asks the same question. */
const ESCALATE_ON_DELETE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$deleted") && row.next.$deleted) {
    row.escalate(["$deleted"], "deleting an invoice needs sign-off");
  }
};
`;

const DENY_ON_SIZE_RULE = `
export default (row) => {
  if (row.op === "update" && row.next.amount > 50000) {
    row.deny("invoice amount is now blocked");
  }
};
`;

const TEST_ENV = {} as Env;
let escalateOnSizeCompiled: string;
let escalateOnDeleteCompiled: string;
let denyOnSizeCompiled: string;

function ctxFor(
	organizationId: string,
	opts: { userId?: string | null; agentId?: string | null },
): ToolContext {
	return {
		organizationId,
		userId: opts.userId ?? null,
		memberRole: "owner",
		agentId: opts.agentId ?? null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as unknown as ToolContext;
}

async function readMetadata(id: number): Promise<Record<string, unknown>> {
	const sql = getTestDb();
	const rows = await sql<{ metadata: unknown }[]>`
    SELECT metadata FROM entities WHERE id = ${id}
  `;
	const raw = rows[0].metadata;
	return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
		string,
		unknown
	>;
}

async function readName(id: number): Promise<string | null> {
	const sql = getTestDb();
	const rows = await sql<{ name: string | null }[]>`
    SELECT name FROM entities WHERE id = ${id}
  `;
	return rows[0].name;
}

async function seed() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Atomic Apply" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice', ${sql.json({ type: "object" })},
            ${escalateOnSizeCompiled}, current_timestamp, current_timestamp)
  `;
	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-ATOMIC",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", amount: 1000, vendor: null },
	} as Parameters<typeof createEntity>[0]);
	return { org, user, agent, invoice };
}

/** The proposal exactly as the card persisted it — never a hand-built one. */
async function persistedProposal(organizationId: string): Promise<{
	entity_id: number;
	fields: Record<string, unknown>;
	current: Record<string, unknown>;
	escalated_fields?: string[];
}> {
	const sql = getTestDb();
	const [queued] = await sql<{ action_input: unknown }[]>`
    SELECT action_input FROM runs
    WHERE organization_id = ${organizationId}
    ORDER BY id DESC LIMIT 1
  `;
	return (
		typeof queued.action_input === "string"
			? JSON.parse(queued.action_input)
			: queued.action_input
	) as {
		entity_id: number;
		fields: Record<string, unknown>;
		current: Record<string, unknown>;
		escalated_fields?: string[];
	};
}

describe("an escalated card applies atomically or not at all", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		[
			escalateOnSizeCompiled,
			escalateOnDeleteCompiled,
			denyOnSizeCompiled,
		] = await Promise.all([
			compileEntityRule(ESCALATE_ON_SIZE_RULE),
			compileEntityRule(ESCALATE_ON_DELETE_RULE),
			compileEntityRule(DENY_ON_SIZE_RULE),
		]);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("does not commit the rest of the card when one escalated field went stale", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// 1-2. The rule escalates `amount`, so the WHOLE proposal defers.
		const result = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000, vendor: "ACME" } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		// Nothing commits at propose time — that is the invariant being carried.
		const atPropose = await readMetadata(invoice.id);
		expect(atPropose.amount).toBe(1000);
		expect(atPropose.vendor ?? null).toBeNull();

		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		// The card really is the coupled unit, not just the escalated field.
		expect(proposal.fields).toEqual({ amount: 90000, vendor: "ACME" });
		expect(proposal.escalated_fields).toEqual(["amount"]);

		// 3. A human corrects `amount` to a legal value before deciding the card.
		// Under 50k, so the rule does not escalate and this commits outright.
		await updateEntity(
			invoice.id,
			{ metadata: { amount: 40000 } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);
		expect((await readMetadata(invoice.id)).amount).toBe(40000);

		// 4. Approve the card as persisted.
		await getTestDb().begin((tx) =>
			applyEntityFieldChangeProposal(
				proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
				user.id,
				tx,
			),
		);

		const after = await readMetadata(invoice.id);
		// The human's newer value must win — this part already works.
		expect(after.amount).toBe(40000);
		// THE REGRESSION: `vendor` is the other half of a unit the approver
		// consented to as a whole. With `amount` no longer applicable, the unit is
		// not applicable, and the fragment must not commit on its own.
		expect(after.vendor ?? null).toBeNull();
	}, 60_000);

	it("rolls the metadata half back when the card's $name went stale", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// Attribute and metadata staleness must govern the whole approved unit,
		// including when only the name changed after the proposal was queued.
		const result = await updateEntity(
			invoice.id,
			{ name: "INV-RENAMED", metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		expect(proposal.fields).toMatchObject({
			$name: "INV-RENAMED",
			amount: 90000,
		});

		// The human renames the row, so the ATTRIBUTE half is what diverges.
		await updateEntity(
			invoice.id,
			{ name: "INV-HUMAN" },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		await getTestDb().begin((tx) =>
			applyEntityFieldChangeProposal(
				proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
				user.id,
				tx,
			),
		);

		expect(await readName(invoice.id)).toBe("INV-HUMAN");
		// Asserting only the name would pass with the metadata half committed.
		expect((await readMetadata(invoice.id)).amount).toBe(1000);
	}, 60_000);

	it.each([false, true])("validates an approved metadata/name transition together (stale name: %s)", async (stale) => {
		const { org, user, agent, invoice } = await seed();
		const sql = getTestDb();
		const compiled = await compileEntityRule(`export default (row) => {
  if (row.op === "update" && row.changed("vendor")) {
    if (row.next.$name !== row.next.vendor) row.deny("vendor and display name must change together");
    row.escalate(["vendor"], "review the vendor change");
  }
};`);
		await sql`UPDATE entity_types SET rules_compiled = ${compiled}
      WHERE organization_id = ${org.id} AND slug = 'invoice'`;
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const result = await updateEntity(invoice.id, {
			name: "ACME", metadata: { vendor: "ACME" },
		}, TEST_ENV, agentCtx);
		expect(result.deferred).toBeTruthy();
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		expect(proposal.fields).toEqual({ vendor: "ACME", $name: "ACME" });
		if (stale) {
			await updateEntity(invoice.id, { name: "Human label" }, TEST_ENV,
				ctxFor(org.id, { userId: user.id }));
		}
		const applied = await applyEntityFieldChangeProposal(
			proposal as Parameters<typeof applyEntityFieldChangeProposal>[0], user.id,
		);
		expect(await readName(invoice.id)).toBe(stale ? "Human label" : "ACME");
		expect((await readMetadata(invoice.id)).vendor).toBe(stale ? null : "ACME");
		if (stale) {
			expect(applied.changed).toBe(false);
			expect(applied.stale.$name).toBeDefined();
		} else {
			expect(applied.applied.$name).toEqual({ old: "INV-ATOMIC", new: "ACME" });
		}
	}, 60_000);

	it("CONTROL: a hold card with no escalation still applies its live fields", async () => {
		const { org, user, agent, invoice } = await seed();
		const humanCtx = ctxFor(org.id, { userId: user.id });

		// A human owns both fields, so the agent's write is held field by field —
		// no rule escalates (`amount` stays under the threshold). This card carries
		// per-field consent, and atomicity must NOT be imposed on it: the human owns
		// each VALUE, not the row.
		await updateEntity(
			invoice.id,
			{ metadata: { vendor: "OLD", notes: "n0" } },
			TEST_ENV,
			humanCtx,
		);

		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const result = await updateEntity(
			invoice.id,
			{ metadata: { vendor: "ACME", notes: "n1" } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		expect(proposal.escalated_fields ?? []).toEqual([]);
		expect(proposal.fields).toEqual({ vendor: "ACME", notes: "n1" });

		// The human re-edits ONE of the two before deciding the card.
		await updateEntity(
			invoice.id,
			{ metadata: { vendor: "HUMAN" } },
			TEST_ENV,
			humanCtx,
		);

		await applyEntityFieldChangeProposal(
			proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);

		const after = await readMetadata(invoice.id);
		// Stale field skipped, the other one still applies. Widening the atomicity
		// check past escalated cards would strand this card instead.
		expect(after.vendor).toBe("HUMAN");
		expect(after.notes).toBe("n1");
	}, 60_000);

	it("durably audits a rule denial that appears when an approval is applied", async () => {
		const sql = getTestDb();
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const result = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const [queued] = await sql<{ id: number }[]>`
			SELECT id FROM runs
			WHERE organization_id = ${org.id}
			ORDER BY id DESC LIMIT 1
		`;

		// The rule changed after the card was issued. Approval must still fail
		// closed, and the denial must survive the apply transaction's rollback.
		await sql`
			UPDATE entity_types SET rules_compiled = ${denyOnSizeCompiled}
			WHERE organization_id = ${org.id} AND slug = 'invoice'
		`;
		const humanCtx = ctxFor(org.id, { userId: user.id });
		for (let delivery = 0; delivery < 2; delivery += 1) {
			const approval = await manageOperations(
				{ action: "approve", run_id: queued.id },
				TEST_ENV,
				humanCtx,
			);
			expect(approval).toMatchObject({
				error: expect.stringContaining("invoice amount is now blocked"),
			});
		}

		expect((await readMetadata(invoice.id)).amount).toBe(1000);
		const audits = await sql`
			SELECT to_jsonb(entity_ids) AS entity_ids, metadata, payload_type
			FROM events
			WHERE organization_id = ${org.id}
			  AND run_id = ${queued.id}
			  AND semantic_type = 'change'
			  AND metadata->>'category' = 'entity_write_denial'
		`;
		expect(audits).toHaveLength(1);
		expect(audits[0].entity_ids).toEqual([invoice.id]);
		expect(audits[0].payload_type).toBe("empty");
		expect(audits[0].metadata).toMatchObject({
			denial_source: "rule",
			operation: "update",
			reason: "invoice amount is now blocked",
			denied_fields: ["amount"],
			entity_id: invoice.id,
			entity_type: "invoice",
			principal_kind: "user",
			principal_id: user.id,
			run_id: queued.id,
		});
		expect(JSON.stringify(audits)).not.toContain("90000");
	}, 60_000);
});

/**
 * A DELETE card is the same promise as an update card: what the human approved
 * must be what applying it performs.
 *
 * Soft delete is now governed by write rules, so a rule may escalate on
 * `$deleted`. Applying the card re-runs that rule against the same row, so
 * without a grant it escalates a second time and throws — the card is minted, a
 * human approves it, and the delete still never happens. That dead end is what
 * this covers, end to end through the PERSISTED card rather than a hand-built
 * proposal.
 */
describe("an approved DELETE card is honoured despite the rule that escalated it", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("applies the persisted delete card and tombstones the row", async () => {
		const sql = getTestDb();
		const { org, user, invoice } = await seed();

		// The rule escalates on any delete of this type.
		await sql`
      UPDATE entity_types SET rules_compiled = ${escalateOnDeleteCompiled}
      WHERE organization_id = ${org.id} AND slug = 'invoice'
    `;

		const ctx = ctxFor(org.id, { userId: user.id });
		await proposeEntityDelete(ctx, {
			entity_id: invoice.id,
			entity_type: "invoice",
			name: invoice.name,
			force_delete_tree: false,
		} as Parameters<typeof proposeEntityDelete>[1]);

		// Read back what the card actually stored — a hand-built proposal would
		// pass with the propose->persist->apply plumbing severed.
		const [queued] = await sql<{ action_input: unknown }[]>`
      SELECT action_input FROM runs
      WHERE organization_id = ${org.id}
      ORDER BY id DESC LIMIT 1
    `;
		const proposal = (
			typeof queued.action_input === "string"
				? JSON.parse(queued.action_input)
				: queued.action_input
		) as Record<string, unknown>;
		expect(proposal.entity_id).toBe(invoice.id);
		expect(proposal.operation).toBe("delete");

		// Apply INSIDE a transaction, because that is what production does:
		// approvals.ts wraps the whole claim+confirm+apply in `sql.begin` and
		// hands `completeApproval` the tx. Passing the pool here would skip the
		// one shape worth proving — `deleteEntity` opens its OWN transaction on a
		// SECOND pooled connection while this one is still open, and takes
		// `FOR UPDATE` on a row the outer tx has not locked.
		await sql.begin(async (tx) => {
			await applyEntityChangeProposal(proposal as never, ctx, TEST_ENV, tx);
		});

		const [row] = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM entities WHERE id = ${invoice.id}
    `;
		expect(row.deleted_at).not.toBeNull();
	}, 60_000);
});

const FAIL_TERMINAL_ENTITY_APPROVAL = `
CREATE OR REPLACE FUNCTION test_fail_entity_terminal_approval() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
    RAISE EXCEPTION 'simulated entity terminal approval failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_entity_terminal_approval_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_entity_terminal_approval();
`;
const DROP_FAIL_TERMINAL_ENTITY_APPROVAL = `
DROP TRIGGER IF EXISTS test_fail_entity_terminal_approval_trg ON events;
DROP FUNCTION IF EXISTS test_fail_entity_terminal_approval();
`;

async function approveWithTerminalFailure(
	runId: number,
	ctx: ToolContext,
	env: Env = TEST_ENV,
): Promise<void> {
	const sql = getTestDb();
	await sql.unsafe(FAIL_TERMINAL_ENTITY_APPROVAL);
	try {
		const result = await manageOperations(
			{ action: "approve", run_id: runId },
			env,
			ctx,
		);
		expect(result).toMatchObject({
			error: expect.stringMatching(/terminal approval failure/i),
		});
	} finally {
		await sql.unsafe(DROP_FAIL_TERMINAL_ENTITY_APPROVAL);
	}
	const [run] = await sql<{ approval_status: string; status: string }[]>`
		SELECT approval_status, status FROM runs WHERE id = ${runId}
	`;
	expect(run).toEqual({ approval_status: "pending", status: "pending" });
}

describe("entity approval apply shares the terminal approval transaction", () => {
	beforeEach(async () => {
		await getTestDb().unsafe(DROP_FAIL_TERMINAL_ENTITY_APPROVAL);
		await cleanupTestDatabase();
	});

	it("rolls an approved create back when completion persistence fails", async () => {
		const { org, user } = await seed();
		const queued = await proposeEntityCreate(
			ctxFor(org.id, { agentId: "atomic-create-agent" }),
			{
				entity_data: {
					entity_type: "invoice",
					name: "INV-CREATE-ROLLBACK",
					organization_id: org.id,
					created_by: user.id,
					metadata: { amount: 1000 },
				},
				proposal: { entity_type: "invoice", name: "INV-CREATE-ROLLBACK" },
				attribution: "agent",
			},
		);
		await approveWithTerminalFailure(
			queued.runId,
			ctxFor(org.id, { userId: user.id }),
		);
		expect(
			await getTestDb()`SELECT id FROM entities
			WHERE organization_id = ${org.id} AND name = 'INV-CREATE-ROLLBACK'`,
		).toHaveLength(0);
	}, 60_000);

	it("rolls an approved update back when completion persistence fails", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const deferred = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);
		expect(deferred.deferred).toBeTruthy();
		const queued = await deferred.deferred!.queue(agentCtx, TEST_ENV);
		await approveWithTerminalFailure(
			queued.runId,
			ctxFor(org.id, { userId: user.id }),
		);
		expect((await readMetadata(invoice.id)).amount).toBe(1000);
	}, 60_000);

	it("rolls an approved delete back when completion persistence fails", async () => {
		const { org, user, invoice } = await seed();
		const queued = await proposeEntityDelete(
			ctxFor(org.id, { agentId: "atomic-delete-agent" }),
			{
				entity_id: invoice.id,
				force_delete_tree: false,
				current: {
					id: invoice.id,
					entity_type: "invoice",
					name: invoice.name,
					metadata: invoice.metadata,
				},
				attribution: "agent",
			},
		);
		await approveWithTerminalFailure(
			queued.runId,
			ctxFor(org.id, { userId: user.id }),
		);
		const [row] = await getTestDb()<[{ deleted_at: Date | null }]>`
			SELECT deleted_at FROM entities WHERE id = ${invoice.id}
		`;
		expect(row.deleted_at).toBeNull();
	}, 60_000);

	it("rolls a $member entity, invitation, and workspace audit back together", async () => {
		const sql = getTestDb();
		const { org, user } = await seed();
		await ensureMemberEntityType(org.id);
		const email = "atomic-member-create@test.example.com";
		const queued = await proposeEntityCreate(
			ctxFor(org.id, { agentId: "atomic-member-create-agent" }),
			{
				entity_data: {
					entity_type: "$member",
					name: "Atomic Member Create",
					organization_id: org.id,
					created_by: user.id,
					metadata: { email },
				},
				proposal: { entity_type: "$member", name: "Atomic Member Create" },
				attribution: "agent",
			},
		);
		const emailRequest = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "should-not-send" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		let emailRequestCount = 0;
		try {
			await approveWithTerminalFailure(
				queued.runId,
				ctxFor(org.id, { userId: user.id }),
				{ RESEND_API_KEY: "re_test_atomicity" } as Env,
			);
		} finally {
			emailRequestCount = emailRequest.mock.calls.length;
			emailRequest.mockRestore();
		}
		expect(emailRequestCount).toBe(0);

		expect(
			await sql`SELECT id FROM entities
				WHERE organization_id = ${org.id} AND name = 'Atomic Member Create'`,
		).toHaveLength(0);
		expect(
			await sql`SELECT id FROM invitation
				WHERE "organizationId" = ${org.id} AND email = ${email}`,
		).toHaveLength(0);
		expect(
			await sql`SELECT id FROM events
				WHERE organization_id = ${org.id}
					AND metadata->>'category' = 'workspace'
					AND metadata->>'resource_kind' = 'invitation'`,
		).toHaveLength(0);
	}, 60_000);

	it("rolls a $member delete and invitation cancellation back together", async () => {
		const sql = getTestDb();
		const { org, user } = await seed();
		await ensureMemberEntityType(org.id);
		const email = "atomic-member-delete@test.example.com";
		const member = await createEntity({
			entity_type: "$member",
			name: "Atomic Member Delete",
			organization_id: org.id,
			created_by: user.id,
			metadata: { email, status: "invited" },
		});
		const invitationId = "atomic-member-delete-invitation";
		await sql`
			INSERT INTO invitation (
				id, "organizationId", email, role, status,
				"expiresAt", "inviterId", "createdAt"
			) VALUES (
				${invitationId}, ${org.id}, ${email}, 'member', 'pending',
				${new Date(Date.now() + 86_400_000)}, ${user.id}, current_timestamp
			)
		`;
		const queued = await proposeEntityDelete(
			ctxFor(org.id, { agentId: "atomic-member-delete-agent" }),
			{
				entity_id: member.id,
				force_delete_tree: false,
				current: {
					id: member.id,
					entity_type: "$member",
					name: member.name,
					metadata: member.metadata,
				},
				attribution: "agent",
			},
		);
		await approveWithTerminalFailure(
			queued.runId,
			ctxFor(org.id, { userId: user.id }),
		);

		const [entity] = await sql<[{ deleted_at: Date | null }]>`
			SELECT deleted_at FROM entities WHERE id = ${member.id}
		`;
		expect(entity.deleted_at).toBeNull();
		const [invitation] = await sql<[{ status: string }]>`
			SELECT status FROM invitation WHERE id = ${invitationId}
		`;
		expect(invitation.status).toBe("pending");
		expect(
			await sql`SELECT id FROM events
				WHERE organization_id = ${org.id}
					AND metadata->>'category' = 'workspace'
					AND metadata->>'resource_kind' = 'invitation'
					AND metadata->>'resource_id' = ${invitationId}`,
		).toHaveLength(0);
	}, 60_000);
});
