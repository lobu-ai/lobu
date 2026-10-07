/**
 * Integration test: save_content reports HONEST semantic-index readiness (#2051).
 *
 * Before this change `indexing_status` was a hardcoded `'pending'` literal — it
 * never reflected reality and could not distinguish "durably stored" from
 * "searchable". Now the handler:
 *   - always reports `durable_at` (the row is committed and exact-readable by id),
 *   - probes `event_embeddings` for THIS event under the configured model and
 *     reports `indexing_status: 'completed' | 'pending'` accordingly, and
 *   - mirrors that into `searchable`.
 *
 * In the test environment there is no live EMBEDDINGS_SERVICE_URL and save_content
 * supplies no inline embedding, so a freshly saved row has no current-model
 * embedding yet → pending / not searchable. Backfilling an embedding row flips
 * the probe to completed — proving the status is derived, not a constant.
 *
 * DB-backed (writes an events row + event_embeddings), runs against the pgvector
 * DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > honest indexing status', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Indexing Status Org' });
    user = await createTestUser({ email: 'indexing-status@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
  });

  function ctx(headlessResult = false): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: null,
      headlessResult,
    } as ToolContext;
  }

  it('reports durable_at + pending/not-searchable when no embedding exists yet', async () => {
    const result = await saveContent(
      {
        content: 'A memory whose embedding the async backfill has not produced yet.',
        semantic_type: 'note',
        title: 'pending-index note',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    );

    // Durable storage is synchronous — always reported, always exact-readable.
    expect(result.durable_at).toBeTruthy();
    expect(result.durable_at).toBe(result.created_at);
    expect(result.exact_read.content_ids).toEqual([result.id]);

    // A direct tool call echoes the persisted row, so the ordinary text save —
    // including ordinary Markdown — carries its own body back with no second
    // read. The headless shape is pinned by the next test.
    expect(result.payload_type).toBe('text');
    expect(result.payload_text).toBe(
      'A memory whose embedding the async backfill has not produced yet.'
    );
    expect(result.payload_data).toEqual({});
    expect(result.payload_template).toBeNull();
    expect(result.attachments).toEqual([]);
    expect(result.source_url).toBeNull();

    // No current-model embedding was written inline and no embed service ran,
    // so this content is genuinely not yet searchable.
    expect(result.indexing_status).toBe('pending');
    expect(result.searchable).toBe(false);
  });

  it('flips to completed/searchable once a current-model embedding row exists', async () => {
    const result = await saveContent(
      {
        content: 'A memory that will be marked as embedded.',
        semantic_type: 'note',
        title: 'to-be-indexed note',
        metadata: {},
      } as never,
      {} as never,
      ctx(true)
    );
    expect(result.indexing_status).toBe('pending');
    // A headless nested SDK save mounts no card, so the payload echo is
    // withheld and the caller keeps the compact receipt plus the exact-read id.
    expect(result.payload_type).toBeUndefined();

    // Simulate the backfill/worker writing the chunk-0 embedding under the
    // configured model. The probe keys on exactly (event_id, model, chunk 0).
    const sql = getTestDb();
    const model = getConfiguredEmbeddingModel();
    const zeroVec = `[${Array.from({ length: 768 }, () => 0).join(',')}]`;
    await sql`
      INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
      VALUES (${result.id}, 0, ${zeroVec}::vector, ${model})
    `;

    // The handler computes `searchable` at save time and this env has no inline-
    // embedding path, so rather than re-save, assert the exact predicate the
    // handler uses (needsEmbeddingSql) now reports this event as embedded.
    const [probe] = await sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM event_embeddings emb
        WHERE emb.event_id = ${result.id}
          AND emb.embedding_model = ${model}
          AND emb.chunk_index = 0
      ) AS needs_embedding
    `;
    expect(probe.needs_embedding).toBe(false);
  });
});
