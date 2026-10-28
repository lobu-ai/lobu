/**
 * Regression coverage for exact org-wide score searches. The bounded hybrid
 * candidate path is only safe for recall snippets; user-visible get_content
 * searches still need exact title matching, filters, totals, and offsets.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import type { DbClient } from '../../../db/client';
import { searchContentBySingleQuery } from '../../../utils/content-search/search-path';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;

function axisVec(axis: 0 | 1 | 2): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

async function createOrgFixture(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser({ email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@example.com` });
  await addUserToOrganization(user.id, org.id, 'owner');
  const entity = await createTestEntity({ name: `${name} Entity`, organization_id: org.id });
  await createTestConnectorDefinition({
    key: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-connector`,
    name: `${name} Connector`,
    organization_id: org.id,
  });
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-connector`,
    entity_ids: [entity.id],
  });
  return { org, entity, connection };
}

describe('searchContentByText > exact org-wide score semantics', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
  });

  it('scores each event embedding once while preserving exact semantic totals', async () => {
    const { org, entity, connection } = await createOrgFixture('Single Semantic Score Org');
    const sql = getTestDb();
    for (let i = 0; i < 24; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        organization_id: org.id,
        content: `synthetic vector record ${i}`,
        embedding: axisVec(0),
      });
    }
    // Capture the search statement as it runs inside the bounded read-only
    // transaction so EXPLAIN ANALYZE can count per-event embedding lookups.
    let captured: { query: string; params: unknown[] } | undefined;
    const wrap = (db: DbClient): DbClient =>
      new Proxy(db, {
        get(target, key) {
          if (key === 'begin') {
            return (...args: any[]) => {
              const callback = args.pop();
              return (target.begin as any)(...args, (tx: DbClient) => callback(wrap(tx)));
            };
          }
          if (key === 'unsafe') {
            return (query: string, params: unknown[]) => {
              if (query.includes('filtered_ids AS')) captured = { query, params };
              return target.unsafe(query, params);
            };
          }
          return Reflect.get(target, key);
        },
      });
    const result = await searchContentBySingleQuery(wrap(sql), 'unmatchedsyntheticneedle', {
      organization_id: org.id,
      query_embedding: axisVec(0),
      min_similarity: 0.9,
      limit: 5,
      sort_by: 'score',
    });
    expect(result.total).toBe(24);
    expect(result.content).toHaveLength(5);
    if (!captured) throw new Error('search statement was not captured');

    type PlanNode = { 'Relation Name'?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const plan = await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured.query}`, captured.params);
    let embeddingLookups = 0;
    const visit = (node: PlanNode) => {
      if (node['Relation Name'] === 'event_embeddings') embeddingLookups += node['Actual Loops'];
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan[0]['QUERY PLAN'][0].Plan);
    const [count] = await sql`SELECT COUNT(*)::int AS n FROM current_event_records WHERE organization_id = ${org.id}`;
    // One best-chunk aggregate per scoped event; the WHERE/SELECT scalar
    // subquery pair scored every event twice (2N lookups).
    expect(embeddingLookups).toBeGreaterThan(0);
    expect(embeddingLookups).toBeLessThanOrEqual(Number(count.n));
  });

  it('keeps exact title-only matches on the default path', async () => {
    const { org, entity, connection } = await createOrgFixture('Exact Title Search Org');
    const titleOnly = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      title: 'Project Moonbase final decision',
      content: 'The body intentionally does not contain the lookup word.',
      organization_id: org.id,
    });

    const result = await searchContentByText('moonbase', {
      organization_id: org.id,
      limit: 10,
      sort_by: 'score',
    });

    expect(result.content.map((c) => c.id)).toContain(titleOnly.id);
  });

  it('keeps exact totals and offsets beyond the recall candidate cap', async () => {
    const { org, entity, connection } = await createOrgFixture('Exact Pagination Org');

    for (let i = 0; i < 205; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: `pagerneedle item ${i}`,
        occurred_at: new Date(`2025-04-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`),
        organization_id: org.id,
      });
    }

    const result = await searchContentByText('pagerneedle', {
      organization_id: org.id,
      limit: 10,
      offset: 200,
      sort_by: 'score',
    });

    expect(result.total).toBe(205);
    expect(result.content).toHaveLength(5);
    expect(result.page.has_more).toBe(false);

    const emptyLaterPage = await searchContentByText('pagerneedle', {
      organization_id: org.id,
      limit: 10,
      offset: 300,
      sort_by: 'score',
    });
    expect(emptyLaterPage.total).toBe(205);
    expect(emptyLaterPage.content).toHaveLength(0);
    expect(emptyLaterPage.page.has_more).toBe(false);
  });

  it('applies filters before the opt-in recall candidate limit', async () => {
    const { org, entity, connection: decoyConnection } = await createOrgFixture(
      'Approx Candidate Filter Org'
    );
    const targetConnection = await createTestConnection({
      organization_id: org.id,
      connector_key: decoyConnection.connector_key,
      entity_ids: [entity.id],
    });

    for (let i = 0; i < 205; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: decoyConnection.id,
        content: `vector decoy ${i}`,
        occurred_at: new Date(`2025-05-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`),
        organization_id: org.id,
        embedding: axisVec(0),
      });
    }

    const target = await createTestEvent({
      entity_id: entity.id,
      connection_id: targetConnection.id,
      content: 'filtered vector target',
      occurred_at: new Date('2025-06-01T10:00:00Z'),
      organization_id: org.id,
      embedding: axisVec(0),
    });
    await createTestEvent({
      entity_id: entity.id,
      connection_id: targetConnection.id,
      content: 'orthogonal filtered decoy',
      occurred_at: new Date('2025-06-02T10:00:00Z'),
      organization_id: org.id,
      embedding: axisVec(1),
    });

    const result = await searchContentByText(null, {
      organization_id: org.id,
      connection_ids: [targetConnection.id],
      limit: 10,
      min_similarity: 0.9,
      query_embedding: axisVec(0),
      sort_by: 'score',
      approximate_candidate_search: true,
    });

    expect(result.content.map((c) => c.id)).toEqual([target.id]);
  });

  it('does not truncate a stronger FTS hit behind 200 unordered candidates', async () => {
    const { org, entity, connection } = await createOrgFixture('Approx Candidate FTS Rank Org');
    for (let i = 0; i < 205; i++) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content: `rankneedle weak filler ${i}`,
        organization_id: org.id,
        embedding: axisVec(1),
      });
    }
    const strongest = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      title: 'rankneedle rankneedle rankneedle rankneedle',
      content: 'rankneedle rankneedle rankneedle rankneedle decisive target',
      organization_id: org.id,
      embedding: axisVec(1),
    });
    const result = await searchContentByText('rankneedle', {
      organization_id: org.id,
      limit: 10,
      min_similarity: 0.99,
      query_embedding: axisVec(0),
      sort_by: 'score',
      approximate_candidate_search: true,
    });
    expect(result.content.map((c) => c.id)).toContain(strongest.id);
  });

  it('ranks by cosine when only query_embedding is supplied and never degenerates to match-all', async () => {
    const { org, entity, connection } = await createOrgFixture('Embedding Only Search Org');
    const ids: number[] = [];
    for (const [axis, content] of [
      [0, 'Quarterly revenue review and forecasts'],
      [1, 'Totally unrelated topic about weather'],
      [2, 'Another unrelated message'],
    ] as const) {
      const event = await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        content,
        organization_id: org.id,
        embedding: axisVec(axis),
      });
      ids.push(event.id);
    }

    // With an empty text query the LENGTH($1) > 0 guards must fire; otherwise
    // ILIKE '%%' would match the orthogonal decoys too.
    const result = await searchContentByText(null, {
      organization_id: org.id,
      limit: 10,
      min_similarity: 0.3,
      query_embedding: axisVec(0),
      sort_by: 'score',
    });
    expect(result.content.map((c) => c.id)).toEqual([ids[0]]);
    expect(result.content[0].similarity).toBeCloseTo(1, 5);
  });

  it('routes one- and two-character queries to ranked search, excluding non-matches', async () => {
    // Short queries used to fall through to an unfiltered chronological
    // listing; decoys share neither "zx" nor any "q".
    const { org, entity, connection } = await createOrgFixture('Short Query Org');
    const bigramMatch = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      organization_id: org.id,
      content: 'The zx probe fired at dawn over the calm water',
    });
    const singleMatch = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      organization_id: org.id,
      content: 'A quirky brown fox naps at noon',
    });
    for (const content of [
      'Alpha beta gamma delta epsilon',
      'Plain harbor morning summary',
      'Nothing to note here today',
    ]) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        organization_id: org.id,
        content,
      });
    }

    const bigram = await searchContentByText('zx', { organization_id: org.id, limit: 50 });
    expect(bigram.content.map((item) => item.id)).toEqual([bigramMatch.id]);
    expect(bigram.total).toBe(1);

    const single = await searchContentByText('q', { organization_id: org.id, limit: 50 });
    expect(single.content.map((item) => item.id)).toEqual([singleMatch.id]);
    expect(single.total).toBe(1);
  });

  it('lists everything when there is neither a text query nor an embedding', async () => {
    const { org, entity, connection } = await createOrgFixture('Blank Query Org');
    for (const content of ['First blank-listed row', 'Second blank-listed row']) {
      await createTestEvent({
        entity_id: entity.id,
        connection_id: connection.id,
        organization_id: org.id,
        content,
      });
    }

    for (const query of [null, '', '   ']) {
      const result = await searchContentByText(query, { organization_id: org.id, limit: 50 });
      expect(result.total).toBe(2);
      expect(result.content).toHaveLength(2);
    }
  });
});
