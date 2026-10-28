/**
 * Regression: active create approvals must only collapse true replays.
 *
 * Create proposals have no entity_id, so the approval dedupe query must compare
 * the proposed entity payload. Otherwise every distinct pending create in an org
 * reuses the first pending create run.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
	applyEntityChangeProposal,
	applyEntityFieldChangeProposal,
	type EntityChangeProposal,
	type EntityCreateProposal,
	proposeEntityChange,
	proposeEntityCreate,
} from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

function createProposal(name: string): Omit<EntityCreateProposal, "operation"> {
	return {
		entity_data: {
			entity_type: "task",
			name,
			metadata: { title: name },
		},
		proposal: {
			entity_type: "task",
			name,
			metadata: { title: name },
		},
		attribution: "agent",
		reason: `Create ${name}`,
	};
}

describe("entity create approval dedupe", () => {
	let ctx: ToolContext;

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
		const org = await createTestOrganization({
			name: "Entity Create Approval Dedupe Org",
		});
		ctx = {
			organizationId: org.id,
			agentId: "agent-create-approval-test",
			memberRole: "member",
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
		} as ToolContext;
	});

	it("separates distinct creates and reuses pending or in-flight replays", async () => {
		const first = await proposeEntityCreate(ctx, createProposal("Call Alice"));
		const replay = await proposeEntityCreate(ctx, createProposal("Call Alice"));
		const sql = getTestDb();
		await sql`
			UPDATE runs
			SET approval_status = 'approved', status = 'running'
			WHERE id = ${first.runId}
		`;
		const inFlightReplay = await proposeEntityCreate(
			ctx,
			createProposal("Call Alice"),
		);
		const second = await proposeEntityCreate(ctx, createProposal("Call Bob"));

		expect(replay.runId).toBe(first.runId);
		expect(inFlightReplay.runId).toBe(first.runId);
		expect(second.runId).not.toBe(first.runId);
	});

	it("serializes concurrent replicas to one run and approval event", async () => {
		const name = "Call Concurrent";
		const proposals = await Promise.all(
			Array.from({ length: 8 }, () =>
				proposeEntityCreate(ctx, createProposal(name)),
			),
		);
		const runIds = new Set(proposals.map((proposal) => proposal.runId));
		expect(runIds.size).toBe(1);

		const runId = proposals[0]?.runId;
		expect(runId).toBeDefined();
		const sql = getTestDb();
		const activeRuns = await sql`
			SELECT id
			FROM runs
			WHERE organization_id = ${ctx.organizationId}
			  AND action_input->'entity_data'->>'name' = ${name}
			  AND status IN ('pending', 'claimed', 'running')
		`;
		expect(activeRuns).toHaveLength(1);

		const currentEvents = await sql`
			SELECT id, metadata
			FROM current_event_records
			WHERE run_id = ${runId}
			  AND interaction_type = 'approval'
		`;
		expect(currentEvents).toHaveLength(1);
		expect(currentEvents[0]?.metadata).toMatchObject({
			approval_context: {
				kind: "entity",
				impact: { level: "normal" },
			},
		});
	});
});

async function ownerFixture() {
	const org = await createTestOrganization({ name: "Entity change approval" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const from = await createTestEntity({ name: "Source", entity_type: "contact", organization_id: org.id, created_by: user.id });
	const to = await createTestEntity({ name: "Target", entity_type: "contact", organization_id: org.id, created_by: user.id });
	const ctx = { organizationId: org.id, userId: user.id, memberRole: "owner", isAuthenticated: true } as ToolContext;
	// The stored shape of a retired physical-merge proposal.
	const mergeProposal = {
		operation: "merge", entity_id: from.id, entity_ids: [from.id], winner_entity_id: to.id,
		current: { loser: { id: from.id, name: from.name }, winner: { id: to.id, name: to.name } },
	} as unknown as EntityChangeProposal;
	return { ctx, mergeProposal, from, to, user };
}

describe("entity change approval apply", () => {
	beforeEach(cleanupTestDatabase);

	it("fails closed on a stored physical merge proposal: neither applies nor queues", async () => {
		const { ctx, mergeProposal, from, to } = await ownerFixture();
		const db = getTestDb();
		await expect(db.begin((tx) => applyEntityChangeProposal(mergeProposal, ctx, {} as Env, tx)))
			.rejects.toThrow("Unsupported entity change operation");
		const records = await db`SELECT id, deleted_at FROM entities WHERE id IN (${from.id}, ${to.id})`;
		expect(records).toHaveLength(2);
		expect(records.every((record) => record.deleted_at === null)).toBe(true);
		expect(await db`SELECT id FROM entity_merge_operations WHERE organization_id = ${ctx.organizationId}`).toHaveLength(0);

		await expect(proposeEntityChange(ctx, mergeProposal)).rejects.toThrow("Unsupported entity change operation");
		expect(await db`SELECT id FROM runs WHERE organization_id = ${ctx.organizationId}`).toHaveLength(0);
	});

	it("treats schema metadata as the only field input on create and update", async () => {
		const { ctx, from } = await ownerFixture();
		const createMetadata = { domain: "", category: null, external_ids: { provider: "canonical" } };
		const created = await createEntity({
			entity_type: "contact", name: "Metadata authority", organization_id: ctx.organizationId,
			created_by: ctx.userId, metadata: createMetadata,
			domain: "legacy.example", category: "legacy", external_ids: { provider: "legacy" },
		} as Parameters<typeof createEntity>[0]);
		expect(created.metadata).toEqual(createMetadata);

		await updateEntity(from.id, { metadata: { domain: "before.example" } }, {} as Env, ctx);
		const updateMetadata = { domain: null, category: "", external_ids: { provider: "canonical" } };
		const updated = await updateEntity(from.id, {
			metadata: updateMetadata, domain: "legacy.example", category: "legacy", external_ids: { provider: "legacy" },
		} as Parameters<typeof updateEntity>[1], {} as Env, ctx);
		expect(updated.metadata).toEqual(updateMetadata);
	});

	it("applies approved metadata and $-attributes through one transaction without re-slugging", async () => {
		const { ctx, user } = await ownerFixture();
		const sql = getTestDb();
		const parent = await createTestEntity({ name: "Approved parent", organization_id: ctx.organizationId, created_by: user.id });
		const entity = await createTestEntity({ name: "Original name", organization_id: ctx.organizationId, created_by: user.id });
		await sql`
			UPDATE entities SET metadata = ${sql.json({ status: "pending" })}, content = 'draft'
			WHERE id = ${entity.id}
		`;

		const result = await applyEntityFieldChangeProposal(
			{
				entity_id: entity.id,
				fields: { status: "approved", $name: "Approved name", $parent_id: parent.id, $content: null },
				current: { status: "pending", $name: "Original name", $parent_id: null, $content: "draft" },
				reason: "Human approved the proposed entity changes",
			},
			{ userId: user.id },
		);

		expect(Object.keys(result.applied).sort()).toEqual(["$content", "$name", "$parent_id", "status"]);
		const [row] = await sql<{
			name: string; slug: string; parent_id: number; content: string | null;
			metadata: Record<string, unknown>; field_controls: Record<string, { set_by?: string | null }>;
		}>`
			SELECT name, slug, parent_id, content, metadata, field_controls FROM entities WHERE id = ${entity.id}
		`;
		expect(row).toMatchObject({
			name: "Approved name",
			slug: "original-name",
			parent_id: parent.id,
			content: null,
			metadata: { status: "approved" },
		});
		expect(row.field_controls.status?.set_by).toBe(user.id);
	});
});
