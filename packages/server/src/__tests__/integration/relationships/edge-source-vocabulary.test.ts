import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';
import {
  EDGE_SOURCE_CONFIG,
  EDGE_SOURCE_MANUAL,
} from '../../../utils/relationship-validation';

describe('relationship source vocabulary', () => {
  let workspace: TestWorkspace;
  let relationshipSlug: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Source Vocab Org' });
    await workspace.owner.entity_schema.createType({ slug: 'doc', name: 'Doc' });
    relationshipSlug = 'doc-doc';
    await workspace.owner.entity_schema.createRelType({
      slug: relationshipSlug,
      name: 'Doc Doc',
    });
  });

  async function seedEdge(
    prefix: string,
    source?: typeof EDGE_SOURCE_CONFIG | typeof EDGE_SOURCE_MANUAL
  ) {
    const a = (await workspace.owner.entities.create({
      entity_type: 'doc',
      name: `${prefix} A`,
    })) as { entity: { id: number } };
    const b = (await workspace.owner.entities.create({
      entity_type: 'doc',
      name: `${prefix} B`,
    })) as { entity: { id: number } };
    const linked = (await workspace.owner.entities.link({
      from_entity_id: a.entity.id,
      to_entity_id: b.entity.id,
      relationship_type_slug: relationshipSlug,
      source: 'api',
    })) as { relationship: { id: number } };

    // Reconciled sources are internal and cannot be set through manage_entity.
    if (source !== undefined) {
      const sql = getTestDb();
      await sql`
        UPDATE entity_relationships
        SET source = ${source},
            metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({
              connection_id: 'test-connection',
              channel_key: prefix,
            })}::jsonb
        WHERE id = ${linked.relationship.id}
      `;
    }
    return linked.relationship.id;
  }

  async function sourceOf(relationshipId: number): Promise<string | null> {
    const sql = getTestDb();
    const [row] = await sql<{ source: string | null }>`
      SELECT source FROM entity_relationships WHERE id = ${relationshipId}
    `;
    return row.source;
  }

  it.each([
    [EDGE_SOURCE_CONFIG, 'api'],
    [EDGE_SOURCE_MANUAL, 'ui'],
  ] as const)(
    'refuses to move a %s-owned edge out of its reconcile scope',
    async (current, next) => {
      const id = await seedEdge(current, current);
      // A caller mistake, not an operational failure: it must carry a 4xx so
      // the tool layer reports it instead of logging it as a fault.
      await expect(
        workspace.owner.entities.updateLink({
          relationship_id: id,
          source: next,
        })
      ).rejects.toMatchObject({
        message: expect.stringMatching(/cannot change source/i),
        httpStatus: 400,
      });
      expect(await sourceOf(id)).toBe(current);
    }
  );

  it.each([EDGE_SOURCE_CONFIG, EDGE_SOURCE_MANUAL] as const)(
    'refuses to mint a new edge directly into the %s reconcile scope',
    async (source) => {
      const a = (await workspace.owner.entities.create({
        entity_type: 'doc',
        name: `Mint ${source} A`,
      })) as { entity: { id: number } };
      const b = (await workspace.owner.entities.create({
        entity_type: 'doc',
        name: `Mint ${source} B`,
      })) as { entity: { id: number } };

      // Stamping a reconciled source at create time would enrol the edge in a
      // sweep that deletes everything it did not put there. Two layers refuse
      // it — the request schema's enum and `validateSource` behind it — and the
      // schema is the one that fires first, so match either.
      await expect(
        workspace.owner.entities.link({
          from_entity_id: a.entity.id,
          to_entity_id: b.entity.id,
          relationship_type_slug: relationshipSlug,
          source,
        })
      ).rejects.toThrow(/invalid source|expected one of/i);
    }
  );

  it('still allows an ordinary source change between authored values', async () => {
    const id = await seedEdge('Plain');
    await workspace.owner.entities.updateLink({
      relationship_id: id,
      source: 'llm',
    });
    expect(await sourceOf(id)).toBe('llm');
  });

  it('refuses to replace metadata that scopes a reconciled edge', async () => {
    const id = await seedEdge('Metadata', EDGE_SOURCE_CONFIG);
    await expect(
      workspace.owner.entities.updateLink({
        relationship_id: id,
        metadata: { connection_id: 'other-connection' },
      })
    ).rejects.toThrow(/cannot change source or metadata/i);

    const sql = getTestDb();
    const [row] = await sql<{ metadata: { connection_id: string } }>`
      SELECT metadata FROM entity_relationships WHERE id = ${id}
    `;
    expect(row.metadata.connection_id).toBe('test-connection');
  });

  it('allows confidence updates with unchanged reconciler metadata', async () => {
    const id = await seedEdge('Confidence', EDGE_SOURCE_CONFIG);
    const result = (await workspace.owner.entities.updateLink({
      relationship_id: id,
      confidence: 0.75,
      metadata: { channel_key: 'Confidence', connection_id: 'test-connection' },
    })) as { relationship: { confidence: number; source: string } };
    expect(result.relationship).toMatchObject({
      confidence: 0.75,
      source: EDGE_SOURCE_CONFIG,
    });
  });
});
