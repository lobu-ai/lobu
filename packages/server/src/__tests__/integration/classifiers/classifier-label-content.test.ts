import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { manageClassifiers } from '../../../tools/admin/manage_classifiers';
import type { ToolContext } from '../../../tools/registry';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const DIM = 768;
function basisVector(slot: number): number[] {
  const vector = new Array<number>(DIM).fill(0);
  vector[slot] = 1;
  return vector;
}

async function createOwner(name: string, email: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser({ email });
  await addUserToOrganization(user.id, org.id, 'owner');
  return {
    org,
    ctx: {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: false,
      scopes: ['mcp:admin'],
    } as ToolContext,
  };
}

async function withStubEmbeddingsService(
  run: (env: Env, capturedTexts: string[]) => Promise<void>
): Promise<void> {
  const capturedTexts: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { texts, model } = JSON.parse(body) as { texts: string[]; model: string };
      capturedTexts.push(...texts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          embeddings: texts.map((_, index) => basisVector(index)),
          dimensions: DIM,
          model,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run({ EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${port}` } as Env, capturedTexts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(async () => {
  await cleanupTestDatabase();
  await seedSystemEntityTypes();
});

afterEach(async () => {
  await cleanupTestDatabase();
});

describe('classifier label embedding content', () => {
  it('embeds descriptions and examples on create and stores vectors under their label keys', async () => {
    const { org, ctx } = await createOwner('Label Content Org', 'label-content@test.example.com');
    const attributeValues = {
      lbl_x1: {
        description: 'Refund requests and duplicate-charge billing problems',
        examples: ['I was charged twice for my subscription', 'Please refund this payment'],
      },
      lbl_cached: {
        description: 'Account access problems',
        examples: ['I cannot sign in'],
        embedding: basisVector(2),
      },
      lbl_x2: {
        description: 'Delivery delays and missing packages',
        examples: [],
      },
    };

    await withStubEmbeddingsService(async (env, capturedTexts) => {
      const created = await manageClassifiers(
        {
          action: 'create',
          slug: 'label-content',
          name: 'Label Content',
          attribute_key: 'topic',
          attribute_values: attributeValues,
        },
        env,
        ctx
      );
      expect(created.success).toBe(true);
      expect(capturedTexts).toEqual([
        [
          'lbl_x1',
          attributeValues.lbl_x1.description,
          ...attributeValues.lbl_x1.examples,
        ].join('\n'),
        ['lbl_x2', attributeValues.lbl_x2.description].join('\n'),
      ]);

      const sql = getTestDb();
      const [row] = await sql`
        SELECT attribute_values FROM classify_facet
        WHERE organization_id = ${org.id} AND slug = 'label-content'
      `;
      const model = getConfiguredEmbeddingModel();
      expect(row.attribute_values).toEqual({
        lbl_x1: { ...attributeValues.lbl_x1, embedding: basisVector(0), embedding_model: model },
        lbl_cached: { ...attributeValues.lbl_cached, embedding_model: model },
        lbl_x2: { ...attributeValues.lbl_x2, embedding: basisVector(1), embedding_model: model },
      });
    });
  });

  it('regenerates migration-repaired entries with optional fields', async () => {
    const { org, ctx } = await createOwner('Repaired Shape Org', 'repaired-shape@test.example.com');

    await withStubEmbeddingsService(async (env, capturedTexts) => {
      const created = await manageClassifiers(
        {
          action: 'create',
          slug: 'repaired-shape',
          name: 'Repaired Shape',
          attribute_key: 'topic',
          attribute_values: { seed: { description: 'Seed label', examples: ['seed example'] } },
        },
        env,
        ctx
      );
      expect(created.success).toBe(true);

      const sql = getTestDb();
      const [facet] = await sql`
        SELECT id FROM classify_facet
        WHERE organization_id = ${org.id} AND slug = 'repaired-shape'
      `;
      const classifierId = Number(facet.id);

      // Migration 20260720120000 rebuilds the map with
      // `elem - 'value' - 'embedding'`, so an element that held only `{value}`
      // becomes a bare `{}`. `stripEmbeddingsFromAttributeValues` also
      // round-trips scalar entries untouched, and `generate_embeddings` reads
      // `attribute_values` straight off the row, so a plain string reaches the
      // embedding builder too.
      await sql`
        UPDATE classify_facet
        SET attribute_values = ${sql.json({
          repaired_empty: {},
          described_only: { description: 'Has a description but no examples' },
          examples_only: { examples: ['example without a description'] },
          scalar_entry: 'plain string label',
        })}
        WHERE id = ${classifierId}
      `;

      capturedTexts.length = 0;
      const regenerated = await manageClassifiers(
        { action: 'generate_embeddings', classifier_id: classifierId, force_regenerate: true },
        env,
        ctx
      );

      expect(regenerated.success).toBe(true);
      expect([...capturedTexts].sort()).toEqual(
        [
          'repaired_empty',
          'described_only\nHas a description but no examples',
          'examples_only\nexample without a description',
          'scalar_entry',
        ].sort()
      );
    });
  });
});
