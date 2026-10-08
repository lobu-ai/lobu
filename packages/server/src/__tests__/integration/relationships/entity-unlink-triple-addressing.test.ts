/**
 * Addressing `unlink` / `update_link` by the relationship triple.
 *
 * `entities.unlink` and `entities.updateLink` are typed as taking
 * `{from_entity_id, to_entity_id, relationship_type_slug}`, but the handlers
 * demanded `relationship_id` and threw a 400 before resolving anything, so
 * every call made as the SDK documents it failed. `entity_relationships` has a
 * unique live-triple index, so the triple addresses at most one edge and the
 * handler can resolve it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

describe('unlink/update_link addressed by relationship triple', () => {
  let workspace: TestWorkspace;
  const slug = 'invoice-customer';
  const symmetricSlug = 'peer-of';

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Triple Addressing Org' });
    await workspace.owner.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
    await workspace.owner.entity_schema.createType({ slug: 'customer', name: 'Customer' });
    await workspace.owner.entity_schema.createRelType({
      slug,
      name: 'Invoice Customer',
    });
    // `createRelType` does not expose is_symmetric, so go through `manage`.
    await workspace.owner.entity_schema.manage({
      schema_type: 'relationship_type',
      action: 'create',
      slug: symmetricSlug,
      name: 'Peer Of',
      is_symmetric: true,
    });
  });

  async function seedEdge(prefix: string, typeSlug = slug) {
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
      relationship_type_slug: typeSlug,
      confidence: 0.5,
    })) as { relationship: { id: number } };
    return {
      fromId: invoice.entity.id,
      toId: customer.entity.id,
      relationshipId: linked.relationship.id,
    };
  }

  async function listLinkIds(entityId: number, typeSlug = slug): Promise<number[]> {
    const listed = (await workspace.owner.entities.listLinks({
      entity_id: entityId,
      relationship_type_slug: typeSlug,
    })) as { relationships: Array<{ id: number }> };
    return listed.relationships.map((r) => Number(r.id));
  }

  it('unlinks by the triple, as the SDK signature documents', async () => {
    const { fromId, toId, relationshipId } = await seedEdge('Unlink');
    expect(await listLinkIds(fromId)).toContain(relationshipId);

    await workspace.owner.entities.unlink({
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: slug,
    });

    expect(await listLinkIds(fromId)).not.toContain(relationshipId);
  });

  it('still unlinks by relationship_id', async () => {
    const { fromId, relationshipId } = await seedEdge('UnlinkById');

    await workspace.owner.entities.unlink({
      relationship_id: relationshipId,
    });

    expect(await listLinkIds(fromId)).not.toContain(relationshipId);
  });

  it('updates a link by the triple, as the SDK signature documents', async () => {
    const { fromId, toId, relationshipId } = await seedEdge('UpdateLink');

    const updated = (await workspace.owner.entities.updateLink({
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: slug,
      metadata: { origin: 'erp' },
    })) as { relationship: { id: number; metadata: Record<string, unknown> } };

    expect(Number(updated.relationship.id)).toBe(relationshipId);
    expect(updated.relationship.metadata).toMatchObject({ origin: 'erp' });
  });

  it('resolves a symmetric edge given the endpoints in either order', async () => {
    const { fromId, toId, relationshipId } = await seedEdge('Symmetric', symmetricSlug);

    // `link` canonicalizes symmetric same-org pairs by id, so the stored row
    // may have the endpoints swapped relative to what the caller passed.
    await workspace.owner.entities.unlink({
      from_entity_id: toId,
      to_entity_id: fromId,
      relationship_type_slug: symmetricSlug,
    });

    expect(await listLinkIds(fromId, symmetricSlug)).not.toContain(relationshipId);
  });

  it('does not resolve a directed edge from its reversed endpoints', async () => {
    // The either-orientation match is gated on `is_symmetric`. A directed type
    // means from → to, so the reverse names no edge and must not delete one.
    const { fromId, toId, relationshipId } = await seedEdge('Directed');

    await expect(
      workspace.owner.entities.unlink({
        from_entity_id: toId,
        to_entity_id: fromId,
        relationship_type_slug: slug,
      })
    ).rejects.toThrow(/no relationship/i);

    expect(await listLinkIds(fromId)).toContain(relationshipId);
  });

  it('reports a missing edge as 404, not as a missing-argument 400', async () => {
    const { fromId, toId } = await seedEdge('Missing');
    await workspace.owner.entities.unlink({
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: slug,
    });

    await expect(
      workspace.owner.entities.unlink({
        from_entity_id: fromId,
        to_entity_id: toId,
        relationship_type_slug: slug,
      })
    ).rejects.toThrow(/no relationship/i);
  });

  it('accepts the id and the triple together when they name the same edge', async () => {
    const { fromId, toId, relationshipId } = await seedEdge('Agreeing');

    await workspace.owner.entities.unlink({
      relationship_id: relationshipId,
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: slug,
    });

    expect(await listLinkIds(fromId)).not.toContain(relationshipId);
  });

  it('refuses an id and a triple that name different edges', async () => {
    // Letting the id quietly win would delete an edge the caller never named.
    const a = await seedEdge('ConflictA');
    const b = await seedEdge('ConflictB');

    await expect(
      workspace.owner.entities.unlink({
        relationship_id: a.relationshipId,
        from_entity_id: b.fromId,
        to_entity_id: b.toId,
        relationship_type_slug: slug,
      })
    ).rejects.toThrow(/pass one or the other/);

    // Neither edge was touched.
    expect(await listLinkIds(a.fromId)).toContain(a.relationshipId);
    expect(await listLinkIds(b.fromId)).toContain(b.relationshipId);
  });

  it('still requires an identifier when neither the id nor the triple is given', async () => {
    await expect(
      workspace.owner.entities.unlink({  })
    ).rejects.toThrow(/relationship_id/);
  });
});
