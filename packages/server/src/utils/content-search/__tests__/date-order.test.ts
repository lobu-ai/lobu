/**
 * Unit tests for the chronological-feed ordering/cursor helpers in
 * content-search/types.ts.
 *
 * The recency key is the EFFECTIVE occurrence time — COALESCE(occurred_at,
 * created_at) — so a row whose source timestamp was never recorded ranks by
 * its record time (exactly what the API surfaces for such rows) instead of
 * pinning itself to the top of a newest-first feed: Postgres
 * `ORDER BY occurred_at DESC` defaults to NULLS FIRST, which is what put a
 * 9-day-old NULL-timestamp approval card above everything in prod.
 */

import { describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { buildDateCandidateSetSql } from '../list-path';
import { searchContentBySingleQuery } from '../search-path';
import { buildDateCandidateOrderBy, buildDateCursorClause } from '../types';

describe('buildDateCandidateOrderBy', () => {
  it('orders newest-first on the effective occurrence time (desc)', () => {
    expect(buildDateCandidateOrderBy(null, 'f')).toBe(
      'COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC'
    );
  });

  it('orders oldest-first on the effective occurrence time for an after cursor', () => {
    const cursor = { direction: 'after' as const, occurredAtIso: 'x', id: 1 };
    expect(buildDateCandidateOrderBy(cursor, 'fi')).toBe(
      'COALESCE(fi.occurred_at, fi.created_at) ASC, fi.id ASC'
    );
  });
});

describe('buildDateCursorClause', () => {
  const cursor = {
    direction: 'before' as const,
    occurredAtIso: '2026-07-28T03:04:17.894Z',
    id: 4669806,
  };

  it('keyset-comparison uses the effective occurrence time so NULL rows stay reachable', () => {
    const clause = buildDateCursorClause(
      cursor,
      'COALESCE(f.occurred_at, f.created_at)',
      'f.id',
      1
    );
    expect(clause.sql).toBe(
      'AND (COALESCE(f.occurred_at, f.created_at) < $1::timestamptz OR (COALESCE(f.occurred_at, f.created_at) = $1::timestamptz AND f.id < $2::bigint))'
    );
    expect(clause.rangeSql).toBe('AND COALESCE(f.occurred_at, f.created_at) <= $1::timestamptz');
    expect(clause.params).toEqual([cursor.occurredAtIso, cursor.id]);
  });

  it('exposes the index-boundable range the keyset OR implies (after cursor)', () => {
    const clause = buildDateCursorClause(
      { ...cursor, direction: 'after' },
      'COALESCE(f.occurred_at, f.created_at)',
      'f.id',
      3
    );
    expect(clause.sql).toBe(
      'AND (COALESCE(f.occurred_at, f.created_at) > $3::timestamptz OR (COALESCE(f.occurred_at, f.created_at) = $3::timestamptz AND f.id > $4::bigint))'
    );
    expect(clause.rangeSql).toBe('AND COALESCE(f.occurred_at, f.created_at) >= $3::timestamptz');
  });
});

describe('buildDateCandidateSetSql', () => {
  it('is one ordered, LIMITed scan carrying the org-wide range bound', () => {
    const sql = buildDateCandidateSetSql({
      joinSql: '',
      whereExpr: 'TRUE AND f.organization_id = $9::text',
      cursorSql: 'AND x',
      rangeSql: 'AND RANGE_BOUND',
      cursor: null,
      limitParam: '$20',
    });
    expect(sql).not.toContain('UNION');
    expect(sql).toMatch(/WHERE TRUE AND f\.organization_id = \$9::text AND RANGE_BOUND\s+AND x\s/);
    expect(sql).toMatch(/ORDER BY COALESCE\(f\.occurred_at, f\.created_at\) DESC, f\.id DESC\s+LIMIT \$20$/);
  });

  it('sorts ascending for an after cursor', () => {
    const sql = buildDateCandidateSetSql({
      joinSql: '',
      whereExpr: 'TRUE',
      cursorSql: 'AND x',
      rangeSql: '',
      cursor: { direction: 'after', occurredAtIso: '2026-01-01T00:00:00.000Z', id: 1 },
      limitParam: '$20',
    });
    expect(sql).toContain('f.id ASC');
  });
});

// The offset search selects FROM filtered_ids fi; using the hidden CTE name
// in ORDER BY fails in Postgres before either counted or uncounted pages return.
describe('chronological search SQL', () => {
  it.each([
    { includeTotal: true, embedding: false },
    { includeTotal: false, embedding: false },
    { includeTotal: true, embedding: true },
    { includeTotal: false, embedding: true },
  ])('uses the selected alias for $includeTotal totals / $embedding embeddings', async ({ includeTotal, embedding }) => {
    const queries: string[] = [];
    const sql = {
      unsafe: async (query: string) => {
        if (query.startsWith('SET LOCAL ')) return [];
        queries.push(query);
        return [];
      },
      // A bounded read runs in `begin(mode, fn)`; the callback is always last.
      begin: async (...args: unknown[]) => (args.at(-1) as (tx: DbClient) => Promise<unknown>)(sql),
    } as unknown as DbClient;
    await searchContentBySingleQuery(sql, 'fixture marker', {
      organization_id: 'fixture-org',
      sort_by: 'date',
      sort_order: 'asc',
      include_total: includeTotal,
      query_embedding: embedding ? [1, 0, 0] : undefined,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('ORDER BY COALESCE(fi.occurred_at, fi.created_at) ASC, fi.id ASC');
    expect(queries[0]).not.toContain('filtered_ids.occurred_at');
    if (!includeTotal) expect(queries[0]).not.toContain('COUNT(*) as total_count FROM filtered_ids');
  });
});
