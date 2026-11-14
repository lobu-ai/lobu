/**
 * Org-wide activity feed paging and the `include_total` opt-out.
 *
 * The feed shows the events its organization owns and nothing else: another
 * organization's rows on the same timeline never appear, including one that
 * tags a record of the feed organization. Every page (first, `before` cursor,
 * `after` cursor) returns exactly the ids and order of one ordered scan,
 * including NULL-occurred_at rows ranked by created_at.
 *
 * They also pin `include_total`: omitted keeps the exact total; `false`
 * returns `total: null` with a has_more that is still right on the date feed,
 * on offset pagination, and on the text-search path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { searchContentByText } from '../../../utils/content-search';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const HOUR = 3_600_000;

describe('org-wide feed paging (owner-only scope + include_total)', () => {
  let feedOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let feedUserId: string;
  /** Every id the feed org may see, in feed order (newest effective time first). */
  let expectedDesc: number[];

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();

    feedOrg = await createTestOrganization({ name: 'Feed Paging Org' });
    otherOrg = await createTestOrganization({ name: 'Feed Paging Other Org' });
    const user = await createTestUser({ email: 'feed-paging@example.test' });
    feedUserId = user.id;
    await addUserToOrganization(user.id, feedOrg.id, 'owner');

    const base = Date.now() - 100 * HOUR;
    const sql = getDb();
    // Two rows share an occurred_at to exercise the id tiebreaker.
    const plan: Array<{ org: 'feed' | 'other'; at: number; entity_id?: number }> = [];
    for (let i = 0; i < 14; i++) plan.push({ org: 'feed', at: base + i * HOUR });
    plan.push({ org: 'feed', at: base + 5 * HOUR });
    // Another organization's rows on the same timeline must never appear, not
    // even one that tags a record of the feed organization.
    for (const i of [0, 3, 7, 12]) plan.push({ org: 'other', at: base + i * HOUR });
    const feedEntity = await createTestEntity({ name: 'Feed Paging Record', organization_id: feedOrg.id });
    plan.push({ org: 'other', at: base + 9 * HOUR, entity_id: feedEntity.id });

    const created: Array<{ id: number; org: 'feed' | 'other' }> = [];
    for (const [i, row] of plan.entries()) {
      const event = await createTestEvent({
        organization_id: row.org === 'feed' ? feedOrg.id : otherOrg.id,
        ...(row.entity_id ? { entity_id: row.entity_id } : {}),
        content: `feed paging row ${i} searchable-marker`,
        occurred_at: new Date(row.at),
        created_at: new Date(row.at),
      });
      created.push({ id: event.id, org: row.org });
    }
    // A NULL-occurred_at row ranks by created_at (the effective time).
    await sql`UPDATE events SET occurred_at = NULL WHERE id = ${created[4].id}`;

    const rows = await sql`
      SELECT id FROM current_event_records f
      WHERE f.organization_id = ${feedOrg.id}
        AND (f.occurred_at IS NULL OR f.occurred_at <= now())
      ORDER BY COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC
    `;
    expectedDesc = rows.map((r) => Number(r.id));
  }, 60_000);

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  const feed = (extra: Record<string, unknown> = {}) =>
    searchContentByText(null, { organization_id: feedOrg.id, limit: 4, ...extra });

  const cursorOf = (row: { id: number; occurred_at: string | null; created_at: string }) => ({
    occurred_at: new Date(row.occurred_at ?? row.created_at).toISOString(),
    id: row.id,
  });

  it('fixture holds the fifteen rows the feed organization owns', () => {
    expect(expectedDesc.length).toBe(15);
  });

  it('walks every before-cursor page in exactly the single-scan order', async () => {
    const seen: number[] = [];
    let page = await feed();
    expect(page.total).toBe(expectedDesc.length);
    seen.push(...page.content.map((c) => c.id));
    while (page.page.has_older) {
      const last = page.content[page.content.length - 1];
      const cursor = cursorOf(last);
      page = await feed({ before_occurred_at: cursor.occurred_at, before_id: cursor.id });
      // Default (omitted include_total) keeps the exact total on cursor pages.
      expect(page.total).toBe(expectedDesc.length);
      seen.push(...page.content.map((c) => c.id));
    }
    expect(seen).toEqual(expectedDesc);
  });

  it('a since window keeps the exact total', async () => {
    const sql = getDb();
    const [{ min }] = await sql`
      SELECT MIN(occurred_at) AS min FROM events WHERE id = ANY(${`{${expectedDesc.join(',')}}`}::bigint[])
    `;
    const since = new Date(new Date(min).getTime() + 6.5 * HOUR).toISOString();
    const rows = await sql`
      SELECT id FROM current_event_records f
      WHERE f.organization_id = ${feedOrg.id}
        AND f.occurred_at <= now() AND f.occurred_at >= ${since}::timestamptz
      ORDER BY COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC
    `;
    const windowed = rows.map((r) => Number(r.id));
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(expectedDesc.length);

    const page = await feed({ since, limit: 50 });
    expect(page.total).toBe(windowed.length);
    expect(page.content.map((c) => c.id)).toEqual(windowed);
  });

  it('an after cursor returns the next-newer rows, presented newest-first', async () => {
    const anchorIndex = 9;
    const anchor = (await feed({ limit: 50 })).content[anchorIndex];
    const cursor = cursorOf(anchor);
    const page = await feed({ after_occurred_at: cursor.occurred_at, after_id: cursor.id });
    expect(page.content.map((c) => c.id)).toEqual(
      expectedDesc.slice(anchorIndex - 4, anchorIndex)
    );
    expect(page.page.has_newer).toBe(true);
    expect(page.page.has_older).toBe(true);
  });

  it('include_total=false: total is null and has_more still tracks the date feed', async () => {
    const seen: number[] = [];
    let page = await feed({ include_total: false });
    const hasMoreFlags: boolean[] = [page.page.has_more];
    expect(page.total).toBeNull();
    seen.push(...page.content.map((c) => c.id));
    while (page.page.has_more) {
      const cursor = cursorOf(page.content[page.content.length - 1]);
      page = await feed({
        include_total: false,
        before_occurred_at: cursor.occurred_at,
        before_id: cursor.id,
      });
      expect(page.total).toBeNull();
      hasMoreFlags.push(page.page.has_more);
      seen.push(...page.content.map((c) => c.id));
    }
    expect(seen).toEqual(expectedDesc);
    // 15 rows / 4 per page: three full pages with more, then the last.
    expect(hasMoreFlags).toEqual([true, true, true, false]);
  });

  it('include_total=false on offset pagination: has_more from the overfetch sentinel', async () => {
    const expectedAsc = [...expectedDesc].reverse();
    const pages: Array<{ ids: number[]; hasMore: boolean; total: number | null }> = [];
    for (let offset = 0; offset < expectedAsc.length + 4; offset += 4) {
      const page = await feed({ sort_order: 'asc', offset, include_total: false });
      pages.push({
        ids: page.content.map((c) => c.id),
        hasMore: page.page.has_more,
        total: page.total,
      });
    }
    expect(pages.flatMap((p) => p.ids)).toEqual(expectedAsc);
    expect(pages.map((p) => p.ids.length)).toEqual([4, 4, 4, 3, 0]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, true, false, false]);
    expect(pages.every((p) => p.total === null)).toBe(true);

    // Exactly-full last page: the sentinel must not report a phantom page.
    const exact = await feed({ sort_order: 'asc', offset: 8, limit: 7, include_total: false });
    expect(exact.content).toHaveLength(7);
    expect(exact.page.has_more).toBe(false);

    // Omitted keeps the exact total and the count-derived has_more.
    const counted = await feed({ sort_order: 'asc', offset: 4 });
    expect(counted.total).toBe(expectedDesc.length);
    expect(counted.page.has_more).toBe(true);
  });

  it('include_total=false on the text-search path returns total null with a correct has_more', async () => {
    const first = await searchContentByText('searchable-marker', {
      organization_id: feedOrg.id,
      limit: 10,
      sort_by: 'score',
      include_total: false,
    });
    expect(first.total).toBeNull();
    expect(first.content).toHaveLength(10);
    expect(first.page.has_more).toBe(true);

    const last = await searchContentByText('searchable-marker', {
      organization_id: feedOrg.id,
      limit: 10,
      offset: 10,
      sort_by: 'score',
      include_total: false,
    });
    expect(last.total).toBeNull();
    expect(last.content).toHaveLength(5);
    expect(last.page.has_more).toBe(false);

    const counted = await searchContentByText('searchable-marker', {
      organization_id: feedOrg.id,
      limit: 10,
      sort_by: 'score',
    });
    expect(counted.total).toBe(expectedDesc.length);
  });

  it.each([true, false])('paginates oldest-first text search with include_total=%s', async (includeTotal) => {
    const expectedAsc = [...expectedDesc].reverse();
    const seen: number[] = [];
    for (let offset = 0; offset < expectedAsc.length + 4; offset += 4) {
      const page = await searchContentByText('searchable-marker', {
        organization_id: feedOrg.id,
        sort_by: 'date',
        sort_order: 'asc',
        limit: 4,
        offset,
        include_total: includeTotal,
      });
      expect(page.content.map((row) => row.id)).toEqual(expectedAsc.slice(offset, offset + 4));
      expect(page.total).toBe(includeTotal ? expectedAsc.length : null);
      expect(page.page.has_more).toBe(offset + 4 < expectedAsc.length);
      seen.push(...page.content.map((row) => row.id));
    }
    expect(seen).toEqual(expectedAsc);
  });

  it.each([true, false])('paginates text search with cursors and include_total=%s', async (includeTotal) => {
    const options = {
      organization_id: feedOrg.id,
      sort_by: 'date' as const,
      limit: 4,
      include_total: includeTotal,
    };
    const seen: number[] = [];
    let page = await searchContentByText('searchable-marker', options);
    // Bound the walk so a repeated cursor fails without hanging the suite.
    for (let offset = 0; offset < expectedDesc.length; offset += options.limit) {
      expect(page.content.map((row) => row.id)).toEqual(expectedDesc.slice(offset, offset + options.limit));
      expect(page.total).toBe(includeTotal ? expectedDesc.length : null);
      expect(page.page.has_more).toBe(offset + options.limit < expectedDesc.length);
      seen.push(...page.content.map((row) => row.id));
      if (!page.page.has_more) break;
      const cursor = cursorOf(page.content[page.content.length - 1]);
      page = await searchContentByText('searchable-marker', {
        ...options,
        before_occurred_at: cursor.occurred_at,
        before_id: cursor.id,
      });
    }
    expect(seen).toEqual(expectedDesc);

    const cursor = cursorOf(page.content[0]);
    const newer = await searchContentByText('searchable-marker', {
      ...options,
      after_occurred_at: cursor.occurred_at,
      after_id: cursor.id,
    });
    const anchorIndex = expectedDesc.indexOf(cursor.id);
    expect(newer.content.map((row) => row.id)).toEqual(expectedDesc.slice(anchorIndex - options.limit, anchorIndex));
    expect(newer.total).toBe(includeTotal ? expectedDesc.length : null);
    expect(newer.page.has_newer).toBe(true);
  });

  it('keeps the exact search total on an empty offset page', async () => {
    const page = await searchContentByText('searchable-marker', {
      organization_id: feedOrg.id,
      sort_by: 'score',
      limit: 4,
      offset: expectedDesc.length + 1,
    });
    expect(page.content).toHaveLength(0);
    expect(page.total).toBe(expectedDesc.length);
    expect(page.page.has_more).toBe(false);
  });

  it('read_knowledge: include_total=false surfaces total null; omitted stays exact', async () => {
    const ctx: ToolContext = {
      organizationId: feedOrg.id,
      userId: feedUserId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
    const optedOut = await getContent(
      { limit: 4, sort_by: 'date', sort_order: 'desc', include_total: false } as never,
      {} as never,
      ctx
    );
    expect(optedOut.total).toBeNull();
    expect(optedOut.page.has_more).toBe(true);
    expect(optedOut.hints).toContain('More results available.');

    const counted = await getContent(
      { limit: 4, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );
    expect(counted.total).toBe(expectedDesc.length);
    expect(counted.hints).toContain(`${expectedDesc.length - 4} more results available.`);
  });
});
