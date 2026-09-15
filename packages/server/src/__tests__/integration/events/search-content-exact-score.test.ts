/**
 * Regression coverage for exact org-wide score searches. The bounded hybrid
 * candidate path is only safe for recall snippets; user-visible get_content
 * searches still need exact title matching, filters, totals, and offsets.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase } from '../../setup/test-db';
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

function axisVec(axis: 0 | 1): number[] {
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
});
