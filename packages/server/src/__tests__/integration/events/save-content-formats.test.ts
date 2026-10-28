import { beforeAll, describe, expect, it } from 'vitest';
import { saveContent } from '../../../tools/save_content';
import type { ToolContext } from '../../../tools/registry';
import { getConfiguredEmbeddingModel } from '../../../utils/embeddings';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent supported event formats', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Synthetic content formats' });
    user = await createTestUser({ email: 'content-formats@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({
      name: 'Synthetic content entity',
      organization_id: org.id,
    });
    entityId = entity.id;

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      // A direct (non-headless) call echoes the render payload below; only a
      // nested SDK save with `headlessResult` keeps the compact receipt.
    };
  });


  it.each([
    { payload_type: 'json_template', payload_template: { root: { type: 'text', content: 'old' } } },
    { payload_type: 'markdown', content: 'Readable', payload_template: { root: { type: 'text' } } },
    { payload_type: 'json_template', payload_data: { score: 42 } },
  ])('rejects retired presentation input before creating an event: %j', async (input) => {
    const sql = getTestDb();
    const before = await sql`SELECT id FROM events WHERE organization_id = ${org.id} ORDER BY id`;
    await expect(saveContent({ ...input, semantic_type: 'content' } as never, {} as never, ctx))
      .rejects.toThrow();
    const after = await sql`SELECT id FROM events WHERE organization_id = ${org.id} ORDER BY id`;
    expect(after).toEqual(before);
  });

  it('preserves typed data, Markdown, attribution and attachments without a template', async () => {
    const data = { score: 42, approved: false, owners: [{ name: 'Ada' }] };
    const attachments = [{ kind: 'image', url: 'https://example.test/chart.png' }];
    const result = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: '# Report\n\nScore: **42**',
      title: 'Synthetic report', payload_data: data, attachments,
      author: 'Synthetic author', source_url: 'https://example.test/report',
    }, {} as never, ctx);
    expect(result).toMatchObject({
      payload_type: 'markdown', payload_text: '# Report\n\nScore: **42**',
      payload_data: data, attachments, source_url: 'https://example.test/report',
    });
    const [stored] = await getTestDb()`
      SELECT payload_type, payload_text, payload_data, payload_template, attachments, author_name
      FROM events WHERE id = ${result.id}
    `;
    expect(stored).toMatchObject({
      payload_type: 'markdown', payload_data: data, payload_template: null,
      attachments, author_name: 'Synthetic author',
    });
  });

  it.each(['empty', 'media'] as const)('retains a %s event with no text', async (payload_type) => {
    const result = await saveContent({
      semantic_type: 'content', payload_type, payload_data: { score: 0, selected: false },
      attachments: payload_type === 'media'
        ? [{ kind: 'image', url: 'https://example.test/image.png' }] : [],
    }, {} as never, ctx);
    expect(result).toMatchObject({ payload_type, payload_text: null, payload_data: { score: 0, selected: false } });
  });

  it('returns the original persisted content on an idempotent replay', async () => {
    const first = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: 'Original',
      payload_data: { score: 7 }, title: 'Original report', idempotency_key: 'format-replay',
    }, {} as never, ctx);
    const replay = await saveContent({
      semantic_type: 'content', payload_type: 'markdown', content: 'Different retry',
      payload_data: { score: 99 }, title: 'Different retry', idempotency_key: 'format-replay',
    }, {} as never, ctx);
    expect(replay).toMatchObject({
      id: first.id, created: false, title: 'Original report',
      payload_text: 'Original', payload_data: { score: 7 },
    });
  });

  it('persists exactly one event for concurrent saves with the same idempotency key', async () => {
    const input = {
      entity_ids: [entityId],
      content: 'A retry-safe Automation reply.',
      semantic_type: 'note',
      idempotency_key: 'automation:71:source:stable-post-1',
      metadata: { source_origin_id: 'stable-post-1' },
    } as never;

    const results = (await Promise.all(
      Array.from({ length: 6 }, () => saveContent(input, {} as never, ctx))
    )) as Array<{ id: number }>;

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const [count] = await getTestDb()`
      SELECT count(*)::int AS n
      FROM events
      WHERE organization_id = ${org.id}
        AND metadata->>'_lobu_idempotency_key' = 'automation:71:source:stable-post-1'
    `;
    expect(Number(count.n)).toBe(1);
  });

  it('does not let caller metadata set the reserved idempotency key', async () => {
    const metadata = {
      source_origin_id: 'caller-authored-post',
      _lobu_idempotency_key: 'caller-controlled-key',
    };
    const first = (await saveContent(
      { entity_ids: [entityId], content: 'First event with caller-authored metadata.', semantic_type: 'note', metadata } as never,
      {} as never,
      ctx
    )) as { id: number };
    const second = (await saveContent(
      { entity_ids: [entityId], content: 'Second event with the same caller-authored metadata.', semantic_type: 'note', metadata } as never,
      {} as never,
      ctx
    )) as { id: number };

    expect(second.id).not.toBe(first.id);
    const rows = await getTestDb()`
      SELECT metadata FROM events WHERE id IN (${first.id}, ${second.id}) ORDER BY id
    `;
    expect(rows.map((row) => row.metadata)).toEqual([
      { source_origin_id: 'caller-authored-post' },
      { source_origin_id: 'caller-authored-post' },
    ]);
  });

  it('normalizes omitted metadata to {} and keeps supplied metadata', async () => {
    const bare = await saveContent(
      { content: 'a note saved without any metadata', semantic_type: 'content' },
      {} as never,
      ctx
    );
    expect(bare.created).toBe(true);
    expect(bare.metadata).toEqual({});

    const withMetadata = await saveContent(
      {
        content: 'a note saved with metadata',
        semantic_type: 'content',
        metadata: { namespace: 'optional-metadata-test', importance: 'low' },
      },
      {} as never,
      ctx
    );
    expect(withMetadata.metadata).toMatchObject({
      namespace: 'optional-metadata-test',
      importance: 'low',
    });
  });

  describe('occurred_at and reply edges', () => {
    it('defaults occurred_at to now when omitted and preserves an explicit one', async () => {
      const before = Date.now();
      const defaulted = (await saveContent(
        {
          entity_ids: [entityId],
          content: 'A note saved without an explicit occurred_at.',
          semantic_type: 'note',
          metadata: {},
        } as never,
        {} as never,
        ctx
      )) as { id: number };
      const explicit = '2026-01-02T03:04:05.000Z';
      const pinned = (await saveContent(
        {
          entity_ids: [entityId],
          content: 'A note with an explicit occurred_at.',
          semantic_type: 'note',
          occurred_at: explicit,
          metadata: {},
        } as never,
        {} as never,
        ctx
      )) as { id: number };

      const sql = getTestDb();
      const [row] = await sql`SELECT occurred_at FROM events WHERE id = ${defaulted.id}`;
      expect(row.occurred_at).not.toBeNull();
      const occurredMs = new Date(row.occurred_at as string).getTime();
      expect(occurredMs).toBeGreaterThanOrEqual(before - 1000);
      expect(occurredMs).toBeLessThanOrEqual(Date.now() + 1000);

      const [explicitRow] = await sql`SELECT occurred_at FROM events WHERE id = ${pinned.id}`;
      expect(new Date(explicitRow.occurred_at as string).toISOString()).toBe(explicit);
    });

    it('stores a first-class reply edge and inherits the source URL', async () => {
      const parent = (await saveContent(
        {
          entity_ids: [entityId],
          content: 'Original LinkedIn post.',
          semantic_type: 'note',
          source_url: 'https://www.linkedin.com/feed/update/urn:li:activity:123',
          metadata: {},
        } as never,
        {} as never,
        ctx
      )) as { id: number };
      const reply = (await saveContent(
        {
          entity_ids: [entityId],
          content: 'This matters because it is a concrete agent-infrastructure signal.',
          semantic_type: 'note',
          parent_event_id: parent.id,
          metadata: {},
        } as never,
        {} as never,
        ctx
      )) as { id: number };

      const [row] = await getTestDb()`
        SELECT child.origin_parent_id, parent.origin_id AS expected_parent_origin_id,
               child.source_url
        FROM events child
        JOIN events parent ON parent.id = ${parent.id}
        WHERE child.id = ${reply.id}
      `;
      expect(row.origin_parent_id).toBe(row.expected_parent_origin_id);
      expect(row.source_url).toBe('https://www.linkedin.com/feed/update/urn:li:activity:123');
    });
  });

  describe('indexing status receipt (#2051)', () => {
    it('reports durable_at, exact_read and pending/not-searchable when no embedding exists yet', async () => {
      const result = await saveContent(
        {
          content: 'A memory whose embedding the async backfill has not produced yet.',
          semantic_type: 'note',
          title: 'pending-index note',
          metadata: {},
        } as never,
        {} as never,
        ctx
      );

      // Durable storage is synchronous — always reported, always exact-readable.
      expect(result.durable_at).toBeTruthy();
      expect(result.durable_at).toBe(result.created_at);
      // The hint must match knowledge.read's actual arg shape: `content_ids`.
      expect(result.exact_read).toEqual({
        method: 'client.knowledge.read',
        content_ids: [result.id],
      });

      // A direct tool call echoes the persisted row.
      expect(result.payload_type).toBe('text');
      expect(result.payload_text).toBe(
        'A memory whose embedding the async backfill has not produced yet.'
      );
      expect(result.payload_data).toEqual({});
      expect(result.payload_template).toBeNull();
      expect(result.attachments).toEqual([]);
      expect(result.source_url).toBeNull();

      // No current-model embedding was written inline and no embed service ran.
      expect(result.indexing_status).toBe('pending');
      expect(result.searchable).toBe(false);
    });

    it('withholds the payload echo for a headless save; the readiness probe flips once an embedding exists', async () => {
      const result = await saveContent(
        {
          content: 'A memory that will be marked as embedded.',
          semantic_type: 'note',
          title: 'to-be-indexed note',
          metadata: {},
        } as never,
        {} as never,
        { ...ctx, sourceContext: null, headlessResult: true } as ToolContext
      );
      expect(result.indexing_status).toBe('pending');
      // A headless nested SDK save mounts no card, so the payload echo is withheld.
      expect(result.payload_type).toBeUndefined();

      // Simulate the backfill writing the chunk-0 embedding under the configured
      // model; assert the exact predicate the handler uses now reports embedded.
      const sql = getTestDb();
      const model = getConfiguredEmbeddingModel();
      const zeroVec = `[${Array.from({ length: 768 }, () => 0).join(',')}]`;
      await sql`
        INSERT INTO event_embeddings (event_id, chunk_index, embedding, embedding_model)
        VALUES (${result.id}, 0, ${zeroVec}::vector, ${model})
      `;
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

  describe('worker session with a synthetic client id', () => {
    // Worker direct-auth sets `clientId: 'lobu-worker'`, which has no
    // oauth_clients row; storing it on events would trip events_client_id_fkey.
    function workerCtx(): ToolContext {
      return {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'pat',
        clientId: 'lobu-worker',
        scopedToOrg: false,
        allowCrossOrg: false,
        scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
        sourceContext: null,
      } as ToolContext;
    }

    it('saves with a NULL client_id (no events_client_id_fkey)', async () => {
      const result = await saveContent(
        {
          content: 'A memory saved from an automation-window worker session.',
          semantic_type: 'note',
          title: 'worker-session note',
          metadata: {},
        } as never,
        {} as never,
        workerCtx()
      );
      expect(result.durable_at).toBeTruthy();
      const [row] = await getTestDb()<{ client_id: string | null }>`
        SELECT client_id FROM events WHERE id = ${result.id}
      `;
      expect(row.client_id).toBeNull();
    });

    it('supersedes cleanly inside the insert transaction', async () => {
      // `supersedes_event_id` routes insertEvent through `sql.begin`; the FK
      // handling must not abort that transaction.
      const first = (await saveContent(
        { content: 'worker profile v1', semantic_type: 'note', title: 'worker-supersede v1', metadata: {} } as never,
        {} as never,
        workerCtx()
      )) as { id: number };
      const second = (await saveContent(
        {
          content: 'worker profile v2',
          semantic_type: 'note',
          title: 'worker-supersede v2',
          metadata: {},
          supersedes_event_id: first.id,
        } as never,
        {} as never,
        workerCtx()
      )) as { id: number };
      expect(second.id).toBeGreaterThan(first.id);

      const rows = await getTestDb()<{ id: number; client_id: string | null }>`
        SELECT id, client_id FROM events WHERE id IN (${first.id}, ${second.id}) ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.client_id === null)).toBe(true);
    });
  });
});
