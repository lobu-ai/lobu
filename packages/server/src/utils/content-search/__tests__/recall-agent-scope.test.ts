/**
 * Agent-scoped recall uses the exact search path while retaining the recall
 * timeout and propagating failures for partial-coverage handling.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../../db/client';
import { CANDIDATE_QUERY_TIMEOUT_MS } from '../fts';
import { searchContentBySingleQuery } from '../search-path';

function capturingSql(queries: string[]): DbClient {
  const tx = {
    unsafe: async (query: string) => {
      queries.push(query);
      return [];
    },
  } as unknown as DbClient;
  return {
    begin: async (fn: (tx: DbClient) => Promise<unknown>) => fn(tx),
  } as unknown as DbClient;
}

async function recallQuery(agentId?: string): Promise<string> {
  const queries: string[] = [];
  await searchContentBySingleQuery(capturingSql(queries), 'fixture recall', {
    organization_id: 'fixture-org',
    query_embedding: [1, 0, 0],
    sort_by: 'score',
    approximate_candidate_search: true,
    agent_id: agentId,
  });
  const search = queries.find((query) => query.includes('WITH RECURSIVE'));
  expect(search).toBeDefined();
  return search!;
}

describe('recall candidate routing', () => {
  it('uses the candidate path for workspace-wide recall', async () => {
    expect(await recallQuery()).toContain('search_candidates AS');
  });

  it('uses the exact path for agent-scoped recall', async () => {
    const query = await recallQuery('fixture-agent');
    expect(query).not.toContain('search_candidates AS');
    expect(query).toContain("f.metadata->>'agent_id' = $11::text");
  });

  it('still bounds agent-scoped recall by the recall timeout', async () => {
    const queries: string[] = [];
    await searchContentBySingleQuery(capturingSql(queries), 'fixture recall', {
      organization_id: 'fixture-org',
      query_embedding: [1, 0, 0],
      sort_by: 'score',
      approximate_candidate_search: true,
      agent_id: 'fixture-agent',
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(`SET LOCAL statement_timeout = ${CANDIDATE_QUERY_TIMEOUT_MS}`);
    expect(queries[1]).toContain('WITH RECURSIVE');
  });

  it('propagates agent-scoped query failures instead of returning empty results', async () => {
    const timeout = Object.assign(new Error('query canceled'), { code: '57014' });
    const tx = {
      unsafe: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(timeout),
    } as unknown as DbClient;
    const sql = {
      begin: async (fn: (tx: DbClient) => Promise<unknown>) => fn(tx),
    } as unknown as DbClient;
    await expect(searchContentBySingleQuery(sql, 'fixture recall', {
      organization_id: 'fixture-org',
      query_embedding: [1, 0, 0],
      sort_by: 'score',
      approximate_candidate_search: true,
      agent_id: 'fixture-agent',
    })).rejects.toBe(timeout);
  });
});
