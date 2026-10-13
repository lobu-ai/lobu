/**
 * Org-wide activity feed paging: the disjoint-arm candidate set and the
 * `include_total` opt-out.
 *
 * Under LOBU_LINKED_ORG_SCOPE the date feed no longer scans one OR predicate;
 * it reads the direct-org arm and the linked-org arm as separate ordered,
 * LIMITed scans and merges them. These tests pin that the merge is invisible:
 * every page (first, `before` cursor, `after` cursor) returns exactly the ids
 * and order of one ordered scan over the OR predicate, including linked rows,
 * NULL-occurred_at rows ranked by created_at, and a row that matches BOTH arms
 * (which must appear once).
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
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const HOUR = 3_600_000;

describe('org-wide feed paging (disjoint org-scope arms + include_total)', () => {
  let feedOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let feedUserId: string;
  /** Every id the feed org may see, in feed order (newest effective time first). */
  let expectedDesc: number[];
  let bothArmsId: number;
  let linkedIds: number[];
  const previousFlag = process.env.LOBU_LINKED_ORG_SCOPE;

  beforeAll(async () => {
    process.env.LOBU_LINKED_ORG_SCOPE = '1';
    await initWorkspaceProvider();
    await cleanupTestDatabase();

    feedOrg = await createTestOrganization({ name: 'Feed Paging Org' });
    otherOrg = await createTestOrganization({ name: 'Feed Paging Other Org' });
    const user = await createTestUser({ email: 'feed-paging@example.test' });
    feedUserId = user.id;
    await addUserToOrganization(user.id, feedOrg.id, 'owner');

    const base = Date.now() - 100 * HOUR;
    const sql = getDb();
    // Interleave direct and linked rows on one timeline so a page boundary
    // always splits both arms. Two rows share an occurred_at to exercise the
    // id tiebreaker.
    const plan: Array<{ org: 'feed' | 'other'; linked: boolean; at: number }> = [];
    for (let i = 0; i < 14; i++) {
      plan.push({ org: i % 3 === 0 ? 'other' : 'feed', linked: i % 3 === 0, at: base + i * HOUR });
    }
    plan.push({ org: 'feed', linked: false, at: base + 5 * HOUR });
    // A foreign row with no link: must never appear.
    plan.push({ org: 'other', linked: false, at: base + 7 * HOUR });

    const created: Array<{ id: number; org: 'feed' | 'other'; linked: boolean }> = [];
    for (const [i, row] of plan.entries()) {
      const event = await createTestEvent({
        organization_id: row.org === 'feed' ? feedOrg.id : otherOrg.id,
        content: `feed paging row ${i} searchable-marker`,
        occurred_at: new Date(row.at),
        created_at: new Date(row.at),
      });
      created.push({ id: event.id, org: row.org, linked: row.linked });
    }
    linkedIds = created.filter((r) => r.linked).map((r) => r.id);
    await sql`
      UPDATE events SET linked_org_ids = ARRAY[${feedOrg.id}]::text[]
      WHERE id = ANY(${`{${linkedIds.join(',')}}`}::bigint[])
    `;
    await sql`
      UPDATE events SET linked_org_ids = '{}'::text[]
      WHERE id = ANY(${`{${created.filter((r) => !r.linked).map((r) => r.id).join(',')}}`}::bigint[])
    `;
    // A direct row that ALSO lists its own org as linked: it satisfies both
    // arms and must be returned once.
    bothArmsId = created[1].id;
    await sql`UPDATE events SET linked_org_ids = ARRAY[${feedOrg.id}]::text[] WHERE id = ${bothArmsId}`;
    // A NULL-occurred_at row ranks by created_at (the effective time).
    await sql`UPDATE events SET occurred_at = NULL WHERE id = ${created[4].id}`;

    const rows = await sql`
      SELECT id FROM current_event_records f
      WHERE (f.organization_id = ${feedOrg.id} OR f.linked_org_ids @> ARRAY[${feedOrg.id}]::text[])
        AND (f.occurred_at IS NULL OR f.occurred_at <= now())
      ORDER BY COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC
    `;
    expectedDesc = rows.map((r) => Number(r.id));
  }, 60_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.LOBU_LINKED_ORG_SCOPE;
    else process.env.LOBU_LINKED_ORG_SCOPE = previousFlag;
    await cleanupTestDatabase();
  });

  const feed = (extra: Record<string, unknown> = {}) =>
    searchContentByText(null, { organization_id: feedOrg.id, limit: 4, ...extra });

  const cursorOf = (row: { id: number; occurred_at: string | null; created_at: string }) => ({
    occurred_at: new Date(row.occurred_at ?? row.created_at).toISOString(),
    id: row.id,
  });

  it('fixture covers linked rows, a both-arms row, and excludes foreign rows', () => {
    // 10 direct (one also self-linked) + 5 linked; the unlinked foreign row is out.
    expect(expectedDesc.length).toBe(15);
    for (const id of linkedIds) expect(expectedDesc).toContain(id);
    expect(expectedDesc.filter((id) => id === bothArmsId)).toHaveLength(1);
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

  it('a since window counts both arms exactly once', async () => {
    const sql = getDb();
    const [{ min }] = await sql`
      SELECT MIN(occurred_at) AS min FROM events WHERE id = ANY(${`{${expectedDesc.join(',')}}`}::bigint[])
    `;
    const since = new Date(new Date(min).getTime() + 6.5 * HOUR).toISOString();
    const rows = await sql`
      SELECT id FROM current_event_records f
      WHERE (f.organization_id = ${feedOrg.id} OR f.linked_org_ids @> ARRAY[${feedOrg.id}]::text[])
        AND f.occurred_at <= now() AND f.occurred_at >= ${since}::timestamptz
      ORDER BY COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC
    `;
    const windowed = rows.map((r) => Number(r.id));
    // Keep matches from both arms while excluding part of the history.
    expect(windowed.some((id) => linkedIds.includes(id))).toBe(true);
    expect(windowed.some((id) => !linkedIds.includes(id))).toBe(true);
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
