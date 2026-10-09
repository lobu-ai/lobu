/**
 * Edge change history.
 *
 * Link, unlink, and update_link used to mutate `entity_relationships` without
 * appending the equivalent relationship audit rows. These tests pin that
 * history while keeping it in the existing `semantic_type='change'` contract.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

type EdgeChangeRow = {
  metadata: {
    category: string;
    op: string;
    relationshipId: string;
    fromEntityId: string;
    toEntityId: string;
    relationshipTypeSlug: string | null;
    changes: Array<{ field: string; old: unknown; new: unknown }>;
  };
  created_by: string | null;
  entity_ids: number[] | null;
};

async function readEdgeChanges(relationshipId: number): Promise<EdgeChangeRow[]> {
  const sql = getTestDb();
  return (await sql`
    -- fetch_types:false hands arrays back as their Postgres literal, so
    -- convert server-side rather than parsing the literal in the test.
    SELECT metadata, created_by, to_jsonb(entity_ids) AS entity_ids
    FROM events
    WHERE semantic_type = 'change'
      AND metadata ? '_lobu_relationship_change'
      AND metadata->>'category' = 'relationship'
      AND metadata->>'relationshipId' = ${String(relationshipId)}
    ORDER BY id ASC
  `) as unknown as EdgeChangeRow[];
}

/** The writer is fire-and-forget, so poll until the expected count lands. */
async function waitForEdgeChanges(
  relationshipId: number,
  count: number
): Promise<EdgeChangeRow[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await readEdgeChanges(relationshipId);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${count} relationship change rows for relationship ${relationshipId}`
  );
}

function changeFor(row: EdgeChangeRow, field: string) {
  return row.metadata.changes.find((c) => c.field === field);
}

describe('edge change history', () => {
  let workspace: TestWorkspace;
  let relationshipSlug: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Edge History Org' });
    await workspace.owner.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
    await workspace.owner.entity_schema.createType({ slug: 'customer', name: 'Customer' });
    relationshipSlug = 'invoice-customer';
    await workspace.owner.entity_schema.createRelType({
      slug: relationshipSlug,
      name: 'Invoice Customer',
    });
  });

  async function seedEdge(prefix: string) {
    const invoice = (await workspace.owner.entities.create({
      entity_type: 'invoice',
      name: `${prefix} Invoice`,
    })) as { entity: { id: number } };
    const customer = (await workspace.owner.entities.create({
      entity_type: 'customer',
      name: `${prefix} Customer`,
    })) as { entity: { id: number } };

    const linked = (await workspace.owner.entities.link({
      from_entity_id: invoice.entity.id,
      to_entity_id: customer.entity.id,
      relationship_type_slug: relationshipSlug,
      source: 'feed',
      confidence: 0.5,
      metadata: { origin: 'erp' },
    })) as { relationship: { id: number } };

    return {
      invoiceId: invoice.entity.id,
      customerId: customer.entity.id,
      relationshipId: linked.relationship.id,
    };
  }

  it('records the link, on both endpoints, with the creating user', async () => {
    const { invoiceId, customerId, relationshipId } = await seedEdge('Link');

    const [row] = await waitForEdgeChanges(relationshipId, 1);
    expect(row.metadata.op).toBe('link');
    expect(row.metadata.relationshipTypeSlug).toBe(relationshipSlug);
    expect(row.metadata.fromEntityId).toBe(String(invoiceId));
    expect(row.metadata.toEntityId).toBe(String(customerId));
    // Both endpoints, so the change shows up on either entity's timeline.
    expect(row.entity_ids?.map(Number).sort((a, b) => a - b)).toEqual(
      [invoiceId, customerId].sort((a, b) => a - b)
    );
    expect(row.created_by).toBe(workspace.users.owner.id);

    expect(changeFor(row, 'exists')).toMatchObject({ old: false, new: true });
    expect(changeFor(row, 'source')).toMatchObject({ old: null, new: 'feed' });
    expect(changeFor(row, 'confidence')).toMatchObject({ old: null, new: 0.5 });
    expect(changeFor(row, 'metadata')?.new).toEqual({ origin: 'erp' });
  });

  it('records only the fields an update actually moved', async () => {
    const { relationshipId } = await seedEdge('Update');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.updateLink({
      relationship_id: relationshipId,
      confidence: 0.9,
    });

    const rows = await waitForEdgeChanges(relationshipId, 2);
    const update = rows[1];
    expect(update.metadata.op).toBe('update_link');
    expect(changeFor(update, 'confidence')).toMatchObject({ old: 0.5, new: 0.9 });
    // `update_link` COALESCEs the args it was not given, so source and metadata
    // did not move and must not appear as changes.
    expect(update.metadata.changes.map((c) => c.field)).toEqual(['confidence']);
  });

  it('records every successive update, not just the first', async () => {
    const { relationshipId } = await seedEdge('Successive');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.updateLink({
      relationship_id: relationshipId,
      confidence: 0.6,
    });
    await waitForEdgeChanges(relationshipId, 2);
    await workspace.owner.entities.updateLink({
      relationship_id: relationshipId,
      confidence: 0.7,
    });

    // Audit rows are idempotency-keyed on originId. Without a per-occurrence
    // discriminator every update on this edge would collapse onto the first
    // one's key and silently vanish.
    const rows = await waitForEdgeChanges(relationshipId, 3);
    expect(rows.map((r) => r.metadata.op)).toEqual(['link', 'update_link', 'update_link']);
    expect(changeFor(rows[1], 'confidence')).toMatchObject({ old: 0.5, new: 0.6 });
    expect(changeFor(rows[2], 'confidence')).toMatchObject({ old: 0.6, new: 0.7 });
  });

  it('serializes concurrent updates so their pre-images form one chain', async () => {
    const { relationshipId } = await seedEdge('Concurrent');
    await waitForEdgeChanges(relationshipId, 1);

    await Promise.all([
      workspace.owner.entities.updateLink({
        relationship_id: relationshipId,
        confidence: 0.6,
      }),
      workspace.owner.entities.updateLink({
        relationship_id: relationshipId,
        confidence: 0.7,
      }),
    ]);

    const rows = await waitForEdgeChanges(relationshipId, 3);
    const transitions = rows
      .filter((row) => row.metadata.op === 'update_link')
      .map((row) => changeFor(row, 'confidence'));
    const first = transitions.find((change) => change?.old === 0.5);
    const second = transitions.find((change) => change?.old === first?.new);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(transitions.map((change) => change?.new).sort()).toEqual([0.6, 0.7]);
  });

  it('does not record an update that changed nothing', async () => {
    const { relationshipId } = await seedEdge('Noop');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.updateLink({
      relationship_id: relationshipId,
      confidence: 0.5, // the value it already has
    });

    // Give the fire-and-forget writer a real chance to append before asserting
    // it did not — otherwise this passes for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rows = await readEdgeChanges(relationshipId);
    expect(rows.map((r) => r.metadata.op)).toEqual(['link']);
  });

  it('records the unlink carrying the pre-image of the removed edge', async () => {
    const { relationshipId } = await seedEdge('Unlink');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.unlink({
      relationship_id: relationshipId,
    });

    const rows = await waitForEdgeChanges(relationshipId, 2);
    const removal = rows[1];
    expect(removal.metadata.op).toBe('unlink');
    expect(changeFor(removal, 'exists')).toMatchObject({ old: true, new: false });
    expect(changeFor(removal, 'source')?.old).toBe('feed');
    expect(changeFor(removal, 'confidence')?.old).toBe(0.5);
    expect(changeFor(removal, 'metadata')?.old).toEqual({ origin: 'erp' });
  });

  it('keeps the full history of one edge across its lifetime', async () => {
    const { relationshipId } = await seedEdge('Lifetime');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.updateLink({
      relationship_id: relationshipId,
      source: 'llm',
    });
    await waitForEdgeChanges(relationshipId, 2);
    await workspace.owner.entities.unlink({
      relationship_id: relationshipId,
    });

    const rows = await waitForEdgeChanges(relationshipId, 3);
    expect(rows.map((r) => r.metadata.op)).toEqual(['link', 'update_link', 'unlink']);
    // The source transition is readable end to end: feed → llm → gone.
    expect(changeFor(rows[1], 'source')).toMatchObject({ old: 'feed', new: 'llm' });
    expect(changeFor(rows[2], 'source')?.old).toBe('llm');
  });

  it('distinguishes relationship changes from entity-field changes', async () => {
    const { invoiceId, relationshipId } = await seedEdge('Separate');
    await waitForEdgeChanges(relationshipId, 1);

    await workspace.owner.entities.update({
      entity_id: invoiceId,
      metadata: { status: 'paid' },
    });

    const sql = getTestDb();
    let rows: Array<{ category: string | null }> = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      rows = (await sql`
        SELECT metadata->>'category' AS category FROM events
        WHERE semantic_type = 'change'
          AND ${invoiceId} = ANY(entity_ids)
        ORDER BY id ASC
      `) as Array<{ category: string | null }>;
      if (rows.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(rows.map((row) => row.category)).toEqual(
      expect.arrayContaining(['relationship', null])
    );
  });
});
