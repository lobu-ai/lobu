/**
 * Entity relationship contract coverage.
 *
 * Replaces the old exhaustive relationship suite with stable high-value
 * invariants: create/list links, duplicate/self-edge validation, and org
 * isolation for cross-workspace entity IDs.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

type SeededGraph = {
  workspace: TestWorkspace;
  companyId: number;
  productId: number;
  relationshipSlug: string;
};

async function seedGraph(workspace: TestWorkspace, prefix: string): Promise<SeededGraph> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES
      (${workspace.org.id}, 'company', 'Company', NOW(), NOW()),
      (${workspace.org.id}, 'product', 'Product', NOW(), NOW())
  `;
  const relationshipSlug = `${prefix.toLowerCase()}-owns-product`;
  await workspace.owner.entity_schema.createRelType({
    slug: relationshipSlug,
    name: 'Owns Product',
  });

  const company = (await workspace.owner.entities.create({
    entity_type: 'company',
    name: `${prefix} Company`,
  })) as { entity: { id: number } };
  const product = (await workspace.owner.entities.create({
    entity_type: 'product',
    name: `${prefix} Product`,
  })) as { entity: { id: number } };

  return {
    workspace,
    companyId: company.entity.id,
    productId: product.entity.id,
    relationshipSlug,
  };
}

describe('entity relationship contract', () => {
  let graphA: SeededGraph;
  let graphB: SeededGraph;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const { a, b } = await TestWorkspace.pair();
    graphA = await seedGraph(a, 'A');
    graphB = await seedGraph(b, 'B');
  });

  it('creates and lists relationships inside a workspace', async () => {
    const linked = (await graphA.workspace.owner.entities.link({
      from_entity_id: graphA.companyId,
      to_entity_id: graphA.productId,
      relationship_type_slug: graphA.relationshipSlug,
      metadata: { source: 'contract-test' },
    })) as { relationship?: { id: number; relationship_type_slug: string } };

    expect(linked.relationship?.id).toBeGreaterThan(0);
    expect(linked.relationship?.relationship_type_slug).toBe(graphA.relationshipSlug);

    const links = (await graphA.workspace.owner.entities.listLinks({
      entity_id: graphA.companyId,
      relationship_type_slug: graphA.relationshipSlug,
    })) as { relationships?: Array<{ id: number }> };
    expect(links.relationships?.some((r) => r.id === linked.relationship?.id)).toBe(true);
  });

  it('rejects duplicate and self-referential relationships', async () => {
    await expect(
      graphA.workspace.owner.entities.link({
        from_entity_id: graphA.companyId,
        to_entity_id: graphA.productId,
        relationship_type_slug: graphA.relationshipSlug,
      })
    ).rejects.toThrow(/already exists|duplicate/i);

    await expect(
      graphA.workspace.owner.entities.link({
        from_entity_id: graphA.companyId,
        to_entity_id: graphA.companyId,
        relationship_type_slug: graphA.relationshipSlug,
      })
    ).rejects.toThrow(/self|same entity|itself/i);
  });

  it('does not allow links to entities in another private workspace', async () => {
    await expect(
      graphA.workspace.owner.entities.link({
        from_entity_id: graphA.companyId,
        to_entity_id: graphB.productId,
        relationship_type_slug: graphA.relationshipSlug,
      })
    ).rejects.toThrow(/access|organization|scope|not found/i);

    const linksB = (await graphB.workspace.owner.entities.listLinks({
      entity_id: graphB.productId,
      relationship_type_slug: graphA.relationshipSlug,
    })) as { relationships?: unknown[] };
    expect(linksB.relationships ?? []).toHaveLength(0);
  });
});
