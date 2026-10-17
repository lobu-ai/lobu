/**
 * Content ranking bounds text rank to [0, 1] before blending it with cosine similarity.
 *
 * combined_score weights text 0.4 and similarity 0.6. ts_rank_cd is unbounded,
 * so a term repeated through a long body used to outscore a strong semantic
 * match, and a row with no embedding used to fall back to the UNWEIGHTED text
 * score and outrank an embedded row with the same text match. Both the exact
 * and the recall candidate paths share the scoring expression.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { searchContentByText } from '../../../utils/content-search';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;
const MODEL = 'Xenova/bge-base-en-v1.5';

function vec(entries: Record<number, number>): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  for (const [i, value] of Object.entries(entries)) v[Number(i)] = value;
  return v;
}

describe('content search ranking scale', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;
  let ctx: ToolContext;
  let originalModel: string | undefined;
  const ids: Record<string, number> = {};

  async function seed(key: string, title: string, content: string, embedding?: number[]) {
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `ranking-scale-${key}`,
        title,
        content,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'ranking-scale-connector',
        connectionId,
        ...(embedding && { embedding, embeddingModel: MODEL }),
      },
      { onConflictUpdate: true }
    );
    ids[key] = inserted.id;
  }

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await initWorkspaceProvider();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Ranking Scale Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'ranking-scale@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      tokenType: 'session',
    } as ToolContext;
    const entity = await createTestEntity({ name: 'Ranking Target', organization_id: org.id });
    entityId = entity.id;
    await createTestConnectorDefinition({
      key: 'ranking-scale-connector',
      name: 'Ranking Scale',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'ranking-scale-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    // Semantic match: same direction as the query vector, one mention of the term.
    await seed('semantic', 'Semantic note', 'Planning notes that mention zephyrine once.', vec({ 0: 1 }));
    // Keyword stuffing: unrelated vector, the term repeated through the body.
    await seed(
      'repeated',
      'Repeated keyword',
      Array.from({ length: 30 }, () => 'zephyrine filler').join(' '),
      vec({ 1: 1 })
    );
    // Equal text match, one embedded (similarity 0.5) and one without a vector.
    const sameText = 'Status update about quillback.';
    await seed('embedded', 'Embedded update', sameText, vec({ 2: 0.5, 3: Math.sqrt(0.75) }));
    await seed('unembedded', 'Unembedded update', sameText);
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });

  async function rank(query: string, queryEmbedding: number[], candidate: boolean) {
    const res = await searchContentByText(query, {
      organization_id: orgId,
      query_embedding: queryEmbedding,
      sort_by: 'score',
      limit: 10,
      ...(candidate && { approximate_candidate_search: true }),
    });
    return res.content;
  }

  it.each([false, true])(
    'a strong semantic match outranks a repeated keyword (candidate=%s)',
    async (candidate) => {
      const rows = await rank('zephyrine', vec({ 0: 1 }), candidate);
      const order = rows.map((r) => Number(r.id));
      expect(order).toContain(ids.semantic);
      expect(order).toContain(ids.repeated);
      expect(order.indexOf(ids.semantic!)).toBeLessThan(order.indexOf(ids.repeated!));
      for (const row of rows) {
        expect(Number(row.combined_score)).toBeLessThanOrEqual(1);
        expect(Number(row.text_rank)).toBeLessThanOrEqual(1);
      }
    }
  );

  it.each([false, true])(
    'a row without an embedding does not outrank an embedded row with equal text (candidate=%s)',
    async (candidate) => {
      const rows = await rank('quillback', vec({ 2: 1 }), candidate);
      const order = rows.map((r) => Number(r.id));
      expect(order).toContain(ids.embedded);
      expect(order).toContain(ids.unembedded);
      expect(order.indexOf(ids.embedded!)).toBeLessThan(order.indexOf(ids.unembedded!));
      const byId = new Map(rows.map((r) => [Number(r.id), r]));
      expect(Number(byId.get(ids.unembedded!)!.text_rank)).toBeCloseTo(
        Number(byId.get(ids.embedded!)!.text_rank),
        6
      );
    }
  );

  it('keeps text-only results ranked when no query embedding is available', async () => {
    const result = await searchContentByText('zephyrine', {
      organization_id: orgId,
      sort_by: 'score',
      limit: 10,
    });
    expect(result.content.map((row) => Number(row.id))).toEqual([
      ids.repeated,
      ids.semantic,
    ]);
    for (const row of result.content) {
      expect(Number(row.text_rank)).toBeGreaterThan(0);
      expect(Number(row.text_rank)).toBeLessThanOrEqual(1);
      expect(Number(row.combined_score)).toBe(Number(row.text_rank));
    }
  });

  it.each([false, true])(
    'vector-only weighting gives unembedded text matches no bonus (candidate=%s)',
    async (candidate) => {
      const result = await searchContentByText('quillback', {
        organization_id: orgId,
        query_embedding: vec({ 2: 1 }),
        vector_weight: 1,
        sort_by: 'score',
        limit: 10,
        approximate_candidate_search: candidate,
      });
      const embedded = result.content.find((row) => Number(row.id) === ids.embedded);
      const unembedded = result.content.find((row) => Number(row.id) === ids.unembedded);
      expect(embedded).toBeDefined();
      expect(unembedded).toBeDefined();
      expect(Number(embedded!.combined_score)).toBeCloseTo(0.5, 6);
      expect(Number(unembedded!.combined_score)).toBe(0);
    }
  );

  it('entity search ranks a semantic match above repeated keywords', async () => {
    const semantic = await createTestEntity({ name: 'Semantic profile', organization_id: orgId });
    const repeated = await createTestEntity({ name: 'Repeated profile', organization_id: orgId });
    const sql = getTestDb();
    await sql`
      UPDATE entities SET content = 'A kestrelmark reference.',
        embedding = ${JSON.stringify(vec({ 0: 1 }))}::vector
      WHERE id = ${semantic.id}
    `;
    await sql`
      UPDATE entities SET content = ${'kestrelmark filler '.repeat(40)},
        embedding = ${JSON.stringify(vec({ 1: 1 }))}::vector
      WHERE id = ${repeated.id}
    `;
    const result = await search(
      {
        query: 'kestrelmark',
        query_embedding: vec({ 0: 1 }),
        include_content: false,
        include_connections: false,
        include_public_catalogs: false,
      },
      {} as Parameters<typeof search>[1],
      ctx
    );
    expect(result.matches.map((match) => match.id)).toEqual([semantic.id, repeated.id]);
    for (const match of result.matches) {
      expect(match.match_score).toBeGreaterThan(0);
      expect(match.match_score).toBeLessThanOrEqual(1);
    }
  });
});
