import { afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db/client';
import { getMetricsText } from '../../gateway/metrics/prometheus';
import type { Env } from '../../index';
import * as contentSearch from '../../utils/content-search';
import * as workspace from '../../workspace';
import type { ToolContext } from '../registry';
import { search } from '../search';

describe('search_memory partial coverage guidance', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['events', 'source_feeds', 'both', 'none'] as const)(
    'keeps an empty response consistent when the unavailable source is %s',
    async (unavailable) => {
      const failure = Object.assign(new Error('synthetic database failure'), { code: '57014' });
      const sql = {
        unsafe: vi.fn(async (query: string) => {
          if (query.startsWith('SELECT f.id AS feed_id')) {
            if (unavailable === 'source_feeds' || unavailable === 'both') throw failure;
            return [];
          }
          if (query.includes('WITH candidates AS MATERIALIZED')) return [];
          throw new Error(`Unexpected query: ${query}`);
        }),
      } as unknown as db.DbClient;
      vi.spyOn(db, 'getDb').mockReturnValue(sql);
      vi.spyOn(workspace, 'getWorkspaceProvider').mockReturnValue({
        getOrgSlug: async () => 'synthetic-workspace',
      } as ReturnType<typeof workspace.getWorkspaceProvider>);
      const content = vi.spyOn(contentSearch, 'searchContentByText');
      if (unavailable === 'events' || unavailable === 'both') {
        content.mockRejectedValue(failure);
      } else {
        content.mockResolvedValue({
          content: [],
          total: 0,
          page: { limit: 5, offset: 0, has_more: false },
        });
      }

      const result = await search(
        { query: 'synthetic recall probe', query_embedding: [1, 0, 0] },
        {} as Env,
        {
          organizationId: 'synthetic-org',
          userId: 'synthetic-user',
          tokenType: 'session',
          memberRole: 'owner',
        } as ToolContext
      );

      expect(result.coverage?.status).toBe(unavailable === 'none' ? 'complete' : 'partial');
      expect(result.discovery_status).toBe(unavailable === 'none' ? 'not_found' : 'discovering');
      if (unavailable === 'none') {
        expect(result.suggestion).toContain('entities.create');
      } else {
        expect(result.suggestion).toContain('partial');
        expect(result.suggestion).not.toContain('entities.create');
        expect(result.suggestion).not.toContain('No matches found');
      }
    }
  );
});

describe('search_memory without a query embedding', () => {
  afterEach(() => vi.restoreAllMocks());

  const ctx = {
    organizationId: 'synthetic-org',
    userId: 'synthetic-user',
    tokenType: 'session',
    memberRole: 'owner',
  } as ToolContext;
  const env = { EMBEDDINGS_SERVICE_URL: 'http://embeddings.invalid' } as Env;
  const embeddingFailures = () =>
    Number(getMetricsText().match(/^lobu_recall_query_embedding_failures_total (\d+)$/m)?.[1] ?? 0);

  function mockEmptyDatabase() {
    const sql = {
      unsafe: vi.fn(async () => []),
      begin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sql)),
    } as unknown as db.DbClient;
    vi.spyOn(db, 'getDb').mockReturnValue(sql);
    vi.spyOn(workspace, 'getWorkspaceProvider').mockReturnValue({
      getOrgSlug: async () => 'synthetic-workspace',
    } as ReturnType<typeof workspace.getWorkspaceProvider>);
  }

  it.each(['network', 'http', 'invalid_embedding'] as const)(
    'reports text-only recall as partial coverage after an embedding %s failure',
    async (failure) => {
      mockEmptyDatabase();
      const fetch = vi.spyOn(globalThis, 'fetch');
      if (failure === 'network') {
        fetch.mockRejectedValue(new TypeError('fetch failed'));
      } else if (failure === 'http') {
        fetch.mockResolvedValue(new Response('synthetic outage', { status: 503 }));
      } else {
        fetch.mockResolvedValue(new Response(JSON.stringify({ embeddings: [[]] })));
      }
      const before = embeddingFailures();

      const result = await search({ query: 'synthetic customer meeting' }, env, ctx);

      expect(result.coverage?.status).toBe('partial');
      expect(result.coverage?.reason).toBe('query_embedding_unavailable');
      expect(result.discovery_status).toBe('discovering');
      expect(result.suggestion).toContain('text only');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(embeddingFailures()).toBe(before + 1);
    }
  );

  it('does not report an embedding failure when the caller supplied a vector', async () => {
    mockEmptyDatabase();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const before = embeddingFailures();

    const result = await search(
      { query: 'synthetic customer meeting', query_embedding: new Array(768).fill(0.01) },
      env,
      ctx
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result.coverage?.status).toBe('complete');
    expect(result.coverage?.reason).toBeUndefined();
    expect(embeddingFailures()).toBe(before);
  });

  it('keeps coverage complete when the query embedding is generated', async () => {
    mockEmptyDatabase();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.01)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const before = embeddingFailures();

    const result = await search({ query: 'synthetic customer meeting' }, env, ctx);

    expect(result.coverage?.status).toBe('complete');
    expect(result.coverage?.reason).toBeUndefined();
    expect(embeddingFailures()).toBe(before);
  });
});
