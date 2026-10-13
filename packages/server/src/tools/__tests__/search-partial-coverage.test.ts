import { afterEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../db/client';
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
