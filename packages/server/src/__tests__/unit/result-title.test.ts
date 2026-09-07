import { describe, expect, it } from 'bun:test';
import { querySqlImpl } from '../../tools/admin/query_sql';
import type { ToolContext } from '../../tools/registry';
import { search } from '../../tools/search';

const ctx = {
  organizationId: '',
  userId: null,
  memberRole: null,
  agentId: null,
  isAuthenticated: false,
  clientId: null,
  scopes: null,
  tokenType: 'anonymous',
  scopedToOrg: false,
} as ToolContext;

describe('tool result titles', () => {
  it('query_sql preserves the caller title on structured errors', async () => {
    const result = await querySqlImpl(
      {
        title: '  Invalid query  ',
        sql: 'SELECT 1 AS row_number',
        sort_by: 'not-valid',
      },
      {},
      ctx
    );

    expect(result.error).toMatch(/Invalid sort_by/);
    expect(result.title).toBe('Invalid query');
  });

  it('search_memory requires a workspace even when a result title is supplied', async () => {
    await expect(search(
      {
        title: '  Missing company  ',
        entity_id: 2_147_483_647,
      },
      {},
      ctx
    )).rejects.toThrow('Select a workspace');
  });
});
