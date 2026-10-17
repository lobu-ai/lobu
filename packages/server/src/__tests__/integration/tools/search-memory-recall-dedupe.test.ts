/**
 * Recall collapses rows whose title and text are identical.
 *
 * A source that emits the same notice or page visit many times (distinct
 * origin ids, identical content) used to fill every recall slot with copies
 * of one row. Recall over-fetches a bounded window, keeps the best-ranked row
 * per identical title+text, and fills the limit when that window permits. Rows
 * that share a title but differ in text are distinct content and both stay.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { searchContentByText } from '../../../utils/content-search';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
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

describe('search_memory recall collapses identical content', () => {
  let orgId: string;
  let entityId: number;
  let connectionId: number;
  let ctx: ToolContext;
  let originalModel: string | undefined;
  const ids: Record<string, number> = {};
  const repeatedIds: number[] = [];

  async function seed(key: string, title: string | null, content: string | null, embedding: number[]) {
    const inserted = await insertEvent(
      {
        entityIds: [entityId],
        organizationId: orgId,
        originId: `recall-dedupe-${key}`,
        title,
        content,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        semanticType: 'content',
        originType: 'content',
        connectorKey: 'recall-dedupe-connector',
        connectionId,
        embedding,
        embeddingModel: MODEL,
      },
      { onConflictUpdate: true }
    );
    ids[key] = inserted.id;
    return inserted.id;
  }

  beforeAll(async () => {
    originalModel = process.env.EMBEDDINGS_MODEL;
    process.env.EMBEDDINGS_MODEL = MODEL;

    await cleanupTestDatabase();
    await initWorkspaceProvider();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Recall Dedupe Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'recall-dedupe@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      tokenType: 'session',
    } as ToolContext;
    const entity = await createTestEntity({ name: 'Recall Dedupe Target', organization_id: org.id });
    entityId = entity.id;
    await createTestConnectorDefinition({
      key: 'recall-dedupe-connector',
      name: 'Recall Dedupe',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-dedupe-connector',
      entity_ids: [entity.id],
    });
    connectionId = connection.id;

    // Eight copies of one notice, each its own source item, all the best match.
    for (let i = 0; i < 8; i++) {
      repeatedIds.push(
        await seed(`repeated-${i}`, 'Repeated notice', 'Corvidane sync paused after failures.', vec({ 0: 1 }))
      );
    }
    // Same title, different text: distinct content that must both survive.
    await seed('reply-a', 'Typed reply', 'Corvidane rollout starts on Monday.', vec({ 0: 0.9, 1: Math.sqrt(0.19) }));
    await seed('reply-b', 'Typed reply', 'Corvidane rollout moved to Tuesday.', vec({ 0: 0.9, 1: Math.sqrt(0.19) }));
    await seed('other-1', 'Corvidane design', 'Corvidane design review notes.', vec({ 0: 0.8, 2: 0.6 }));
    await seed('other-2', 'Corvidane budget', 'Corvidane budget for next quarter.', vec({ 0: 0.8, 3: 0.6 }));
  });

  afterAll(() => {
    if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = originalModel;
  });

  function expectDistinctTop(resultIds: number[]) {
    expect(resultIds).toHaveLength(5);
    expect(new Set(resultIds).size).toBe(5);
    // Exactly one representative of the identical notice, and it leads.
    expect(resultIds.filter((id) => repeatedIds.includes(id))).toHaveLength(1);
    expect(repeatedIds).toContain(resultIds[0]);
    // Same title with different text is not a duplicate.
    expect(resultIds).toContain(ids['reply-a']);
    expect(resultIds).toContain(ids['reply-b']);
  }

  it('search_memory returns limit distinct items', async () => {
    const result = await search(
      {
        query: 'corvidane',
        query_embedding: vec({ 0: 1 }),
        content_limit: 5,
        include_connections: false,
        include_public_catalogs: false,
      },
      {} as Parameters<typeof search>[1],
      ctx
    );
    expectDistinctTop((result.content ?? []).map((item) => item.id));
  });

  it.each([
    { withEmbedding: true, includeTotal: true },
    { withEmbedding: true, includeTotal: false },
    { withEmbedding: false, includeTotal: true },
    { withEmbedding: false, includeTotal: false },
  ])('collapses identical content with %j', async ({ withEmbedding, includeTotal }) => {
    const result = await searchContentByText('corvidane', {
      organization_id: orgId,
      sort_by: 'score',
      limit: 5,
      approximate_candidate_search: true,
      collapse_identical_content: true,
      include_total: includeTotal,
      ...(withEmbedding && { query_embedding: vec({ 0: 1 }) }),
    });
    expect(result.total).toBe(includeTotal ? 12 : null);
    const resultIds = result.content.map((row) => Number(row.id));
    if (withEmbedding) {
      expectDistinctTop(resultIds);
    } else {
      // Text-only rank ties the copies, so only distinctness is asserted.
      expect(resultIds).toHaveLength(5);
      expect(resultIds.filter((id) => repeatedIds.includes(id))).toHaveLength(1);
    }
  });

  it('leaves non-recall search uncollapsed', async () => {
    const result = await searchContentByText('corvidane', {
      organization_id: orgId,
      query_embedding: vec({ 0: 1 }),
      sort_by: 'score',
      limit: 5,
    });
    const resultIds = result.content.map((row) => Number(row.id));
    expect(resultIds.every((id) => repeatedIds.includes(id))).toBe(true);
  });

  it('keeps distinct title/text pairs even when they contain the old separator', async () => {
    const first = await seed('separator-a', 'Quetzal\u001falpha', 'beta', vec({ 4: 1 }));
    const second = await seed('separator-b', 'Quetzal', 'alpha\u001fbeta', vec({ 4: 1 }));
    const result = await searchContentByText('quetzal', {
      organization_id: orgId,
      sort_by: 'score',
      collapse_identical_content: true,
      limit: 5,
    });
    expect(result.content.map((row) => Number(row.id)).sort()).toEqual([first, second].sort());
  });

  it('keeps the highest-scoring copy', async () => {
    await seed('weaker-copy', 'Osprey', 'Osprey release notes.', vec({ 6: 0.5, 7: Math.sqrt(0.75) }));
    const best = await seed('stronger-copy', 'Osprey', 'Osprey release notes.', vec({ 6: 1 }));
    const result = await searchContentByText('osprey', {
      organization_id: orgId,
      query_embedding: vec({ 6: 1 }),
      sort_by: 'score',
      approximate_candidate_search: true,
      collapse_identical_content: true,
      limit: 5,
    });
    expect(result.content.map((row) => Number(row.id))).toEqual([best]);
  });

  it('keeps null and empty titles distinct and never collapses missing text', async () => {
    const expectedIds = await Promise.all([
      seed('null-title', null, 'Kestrel note', vec({ 5: 1 })),
      seed('empty-title', '', 'Kestrel note', vec({ 5: 1 })),
      seed('null-text-a', 'Kestrel', null, vec({ 5: 1 })),
      seed('null-text-b', 'Kestrel', null, vec({ 5: 1 })),
      seed('empty-text-a', 'Kestrel', '', vec({ 5: 1 })),
      seed('empty-text-b', 'Kestrel', '', vec({ 5: 1 })),
    ]);
    const result = await searchContentByText('kestrel', {
      organization_id: orgId,
      sort_by: 'score',
      collapse_identical_content: true,
      limit: 10,
    });
    expect(result.content.map((row) => Number(row.id)).sort()).toEqual(expectedIds.sort());
  });

  it.each([
    { sort_by: 'date' as const, sort_order: 'desc' as const },
    { sort_by: 'date' as const, sort_order: 'asc' as const },
    { sort_by: 'score' as const, offset: 1 },
  ])('preserves pagination for %j', async (options) => {
    const common = {
      organization_id: orgId,
      limit: 5,
      include_total: false,
      ...options,
    };
    const original = await searchContentByText('corvidane', common);
    const collapsed = await searchContentByText('corvidane', {
      ...common,
      collapse_identical_content: true,
    });
    expect(collapsed.content.map((row) => row.id)).toEqual(original.content.map((row) => row.id));
    expect(collapsed.page).toEqual(original.page);
  });
});
