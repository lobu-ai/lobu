import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
  applyEntityChangeProposal,
  type EntityChangeProposal,
  proposeEntityChange,
} from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { addUserToOrganization, createTestEntity, createTestOrganization, createTestUser } from "../../setup/test-fixtures";

async function fixture() {
  await initWorkspaceProvider();
  const org = await createTestOrganization({ name: "Retired mutation approval" });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, "owner");
  const from = await createTestEntity({ name: "Source", entity_type: "contact", organization_id: org.id, created_by: user.id });
  const to = await createTestEntity({ name: "Target", entity_type: "contact", organization_id: org.id, created_by: user.id });
  const ctx = { organizationId: org.id, userId: user.id, memberRole: "owner", isAuthenticated: true } as ToolContext;
  const proposal = {
    operation: "merge", entity_id: from.id, entity_ids: [from.id], winner_entity_id: to.id,
    current: { loser: { id: from.id, name: from.name }, winner: { id: to.id, name: to.name } },
  } as unknown as EntityChangeProposal;
  return { ctx, proposal, from, to };
}

describe("retired entity change operations", () => {
  beforeEach(cleanupTestDatabase);

  it("cannot apply a stored physical merge proposal", async () => {
    const { ctx, proposal, from, to } = await fixture();
    const db = getTestDb();
    await expect(db.begin(tx => applyEntityChangeProposal(proposal, ctx, {} as Env, tx)))
      .rejects.toThrow("Unsupported entity change operation");
    const records = await db`SELECT id, deleted_at FROM entities WHERE id IN (${from.id}, ${to.id})`;
    expect(records).toHaveLength(2);
    expect(records.every(record => record.deleted_at === null)).toBe(true);
    expect(await db`SELECT id FROM entity_merge_operations WHERE organization_id = ${ctx.organizationId}`).toHaveLength(0);
  });

  it("cannot queue a physical merge proposal", async () => {
    const { ctx, proposal } = await fixture();
    await expect(proposeEntityChange(ctx, proposal)).rejects.toThrow("Unsupported entity change operation");
    const db = getTestDb();
    expect(await db`SELECT id FROM runs WHERE organization_id = ${ctx.organizationId}`).toHaveLength(0);
  });
});


describe("schema metadata is the only entity field input", () => {
  beforeEach(cleanupTestDatabase);

  it("preserves explicit empty and null metadata instead of applying old shortcuts", async () => {
    const { ctx } = await fixture();
    const metadata = { domain: "", category: null, external_ids: { provider: "canonical" } };
    const entity = await createEntity({
      entity_type: "contact", name: "Metadata authority", organization_id: ctx.organizationId,
      created_by: ctx.userId, metadata,
      domain: "legacy.example", category: "legacy", external_ids: { provider: "legacy" },
    } as Parameters<typeof createEntity>[0]);
    expect(entity.metadata).toEqual(metadata);
  });

  it("updates metadata without flattening external IDs or reviving top-level aliases", async () => {
    const { ctx, from } = await fixture();
    await updateEntity(from.id, { metadata: { domain: "before.example" } }, {} as Env, ctx);
    const metadata = { domain: null, category: "", external_ids: { provider: "canonical" } };
    const entity = await updateEntity(from.id, {
      metadata, domain: "legacy.example", category: "legacy", external_ids: { provider: "legacy" },
    } as Parameters<typeof updateEntity>[1], {} as Env, ctx);
    expect(entity.metadata).toEqual(metadata);
  });
});
