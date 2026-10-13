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
import { buildDateCandidateSetSql } from '../list-path';
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
  const linkedScope = {
    sql: 'AND (f.organization_id = $9::text OR f.linked_org_ids @> ARRAY[$9::text]::text[])',
    params: ['org'],
    branches: {
      direct: 'f.organization_id = $9::text',
      linked: 'f.linked_org_ids @> ARRAY[$9::text]::text[] AND f.organization_id IS DISTINCT FROM $9::text',
    },
  };

  it('splits a branchable org scope into two ordered, LIMITed arms merged under the same order', () => {
    const sql = buildDateCandidateSetSql({
      joinSql: '',
      whereExpr: 'TRUE',
      orgScope: linkedScope,
      cursorSql: '',
      linkedCursorSql: '',
      directArmRangeSql: 'AND DIRECT_ONLY_BOUND',
      cursor: null,
      limitParam: '$20',
    });
    expect(sql).toContain('UNION ALL');
    // The redundant index bound reaches the direct arm and nowhere else.
    expect(sql.match(/DIRECT_ONLY_BOUND/g)).toHaveLength(1);
    expect(sql.indexOf('DIRECT_ONLY_BOUND')).toBeLessThan(sql.indexOf('UNION ALL'));
    expect(sql).toMatch(/WHERE TRUE AND f\.organization_id = \$9::text AND DIRECT_ONLY_BOUND\s/);
    expect(sql).toContain('AND f.organization_id IS DISTINCT FROM $9::text');
    expect(sql).not.toContain(' OR f.linked_org_ids');
    expect(sql.match(/LIMIT \$20/g)).toHaveLength(3);
    expect(sql.match(/ORDER BY COALESCE\(f\.occurred_at, f\.created_at\) DESC, f\.id DESC/g)).toHaveLength(1);
    expect(sql.match(/ORDER BY COALESCE\(l\.occurred_at, l\.created_at\) DESC, l\.id DESC/g)).toHaveLength(1);
    // The linked arm is fenced so cursor quals cannot reach its index scan.
    expect(sql).toMatch(/AND f\.linked_org_ids @> ARRAY\[\$9::text\]::text\[\] AND f\.organization_id IS DISTINCT FROM \$9::text\s+OFFSET 0\s+\) l/);
    expect(sql).toMatch(/\) u\s+ORDER BY COALESCE\(u\.occurred_at, u\.created_at\) DESC, u\.id DESC\s+LIMIT \$20$/);
  });

  it('after cursors sort each arm and the merge ascending', () => {
    const sql = buildDateCandidateSetSql({
      joinSql: '',
      whereExpr: 'TRUE',
      orgScope: linkedScope,
      cursorSql: 'AND x',
      linkedCursorSql: 'AND lx',
      directArmRangeSql: '',
      cursor: { direction: 'after', occurredAtIso: '2026-01-01T00:00:00.000Z', id: 1 },
      limitParam: '$20',
    });
    expect(sql.match(/f\.id ASC/g)).toHaveLength(1);
    expect(sql).toContain('l.id ASC');
    expect(sql).toContain('u.id ASC');
    expect(sql.match(/AND x\b/g)).toHaveLength(1);
    expect(sql).toContain('WHERE TRUE AND lx');
  });

  it('keeps one scan with the combined predicate when the scope cannot split', () => {
    const sql = buildDateCandidateSetSql({
      joinSql: '',
      whereExpr: 'TRUE',
      orgScope: { ...linkedScope, branches: null },
      cursorSql: '',
      linkedCursorSql: '',
      directArmRangeSql: 'AND DIRECT_ONLY_BOUND',
      cursor: null,
      limitParam: '$20',
    });
    expect(sql).not.toContain('UNION ALL');
    expect(sql).toContain(linkedScope.sql);
    expect(sql).not.toContain('DIRECT_ONLY_BOUND');
  });
});
