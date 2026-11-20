/**
 * Recall's bounded query budget. Recall without a query embedding must stay
 * under the same statement timeout as the candidate path, so a slow scan
 * degrades to partial coverage instead of a long wait.
 */

import postgres from 'postgres';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DbClient, getDb, PROD_PG_VALUE_OPTIONS } from '../../../db/client';
import { getMetricsText } from '../../../gateway/metrics/prometheus';
import { search } from '../../../tools/search';
import { searchContentByText } from '../../../utils/content-search';
import {
  CANDIDATE_IVFFLAT_PROBES,
  CANDIDATE_QUERY_TIMEOUT_MS,
} from '../../../utils/content-search/fts';
import {
  runBoundedRecallQuery,
  selectQueryTsqueries,
} from '../../../utils/content-search/search-path';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

/**
 * Read the serialized log stream the way the issue tracker does: an error-level
 * record that carries a fingerprint is one occurrence of an issue.
 */
function trackIssues(): () => Array<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
    lines.push(String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) queueMicrotask(done);
    return true;
  });
  return () =>
    lines
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter((record) => record.level === 'error' && typeof record.error_fingerprint === 'string');
}

describe('recall query budget', () => {
  let releaseLock: (() => void) | null = null;
  let lockTx: Promise<void> | null = null;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    releaseLock?.();
    try {
      await lockTx;
    } finally {
      releaseLock = null;
      lockTx = null;
    }
  });

  it('applies the recall budget only inside its own transaction', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1, ...PROD_PG_VALUE_OPTIONS });
    const settingsSql = `SELECT pg_backend_pid() AS pid,
              current_setting('ivfflat.probes') AS probes,
              current_setting('ivfflat.iterative_scan') AS iterative_scan,
              current_setting('statement_timeout') AS statement_timeout`;
    try {
      // Load pgvector, then use nondefault settings to prove overrides and restoration.
      await sql.unsafe("SELECT '[1]'::vector");
      await sql.unsafe('SET statement_timeout = 11000');
      await sql.unsafe('SET ivfflat.probes = 7');
      await sql.unsafe('SET ivfflat.iterative_scan = relaxed_order');
      const [before] = await sql.unsafe(settingsSql);
      const [row] = await runBoundedRecallQuery(sql as unknown as DbClient, settingsSql, []);
      expect(row).toEqual({
        pid: before.pid,
        probes: String(CANDIDATE_IVFFLAT_PROBES),
        iterative_scan: 'off',
        statement_timeout: `${CANDIDATE_QUERY_TIMEOUT_MS / 1000}s`,
      });

      // Check the same connection after both commit and rollback.
      expect((await sql.unsafe(settingsSql))[0]).toEqual(before);
      await expect(
        runBoundedRecallQuery(sql as unknown as DbClient, 'SELECT 1 / 0', [])
      ).rejects.toMatchObject({ code: '22012' });
      expect((await sql.unsafe(settingsSql))[0]).toEqual(before);
    } finally {
      await sql.end();
    }
  });

  it('cuts the fulltext candidate words to the match budget from the column statistics', async () => {
    const org = await createTestOrganization({ name: 'Recall Words Org' });
    const occurredAt = new Date('2026-01-01T00:00:00Z');
    const seed = (key: string, content: string) =>
      insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: `recall-words-${key}`,
        title: `Recall words ${key}`,
        content,
        occurredAt,
        semanticType: 'content',
        originType: 'content',
      });
    for (let i = 0; i < 60; i++) await seed(`common-${i}`, 'zephyrcommon routine status');
    await seed('rare', 'zephyrcommon quillrare finding');
    // The planner's statistics, which the lookup reads, exist once analyzed.
    await getDb().unsafe('ANALYZE events');

    const sql = getDb();
    const words = async (query: string, budget: number) =>
      (
        await selectQueryTsqueries(query, {
          candidateArm: true,
          budget,
          read: (text, params) => runBoundedRecallQuery(sql, text, params),
        })
      ).candidates;
    // Both words fit a generous budget, in query order.
    expect(await words('zephyrcommon quillrare', 1_000_000)).toBe('zephyrcommon | quillrare');
    // 'zephyrcommon' is in nearly every row, too many to rank under a budget of
    // ten; the rare word alone remains.
    expect(await words('zephyrcommon quillrare', 10)).toBe('quillrare');
    // Nothing fits, so the fulltext arm does not run.
    expect(await words('zephyrcommon', 10)).toBeNull();
    // Stopwords alone leave nothing to search for.
    expect(await words('the of a', 1_000_000)).toBeNull();
    // Unlisted lexemes use half the minimum frequency, not the last listed
    // lexeme's frequency (zephyrcommon is both last and common in this fixture).
    expect.soft(await words('unlistedlexeme', 10)).toBe('unlistedlexeme');
    // Production returns text[] as raw array literals. Distinct anagrams must
    // survive deduplication, while empty and equivalent lexemes still collapse.
    expect.soft(await words('cat act', 1_000_000)).toBe('cat | act');
    expect.soft(await words('and', 1_000_000)).toBeNull();
    expect(await words('running runs run', 1_000_000)).toBe('running');
  });

  it(
    'ranks a prompt-length recall query by its rarest words within the budget',
    async () => {
      // Pre-turn recall sends the whole prompt, so an event turn can search with
      // kilobytes of text. Every row is ranked against the query's words, and
      // that ranking must not grow with the prompt.
      const org = await createTestOrganization({ name: 'Recall Long Query Org' });
      const fillers = Array.from({ length: 200 }, (_, i) => `fillerword${i}`);
      const occurredAt = new Date('2026-01-01T00:00:00Z');
      const seed = (key: string, content: string) =>
        insertEvent({
          entityIds: [],
          organizationId: org.id,
          originId: `recall-long-${key}`,
          title: `Recall long ${key}`,
          content,
          occurredAt,
          semanticType: 'content',
          originType: 'content',
        });
      for (let i = 0; i < 300; i++) await seed(`common-${i}`, fillers.join(' '));
      await seed('rare', `${fillers.join(' ')} quillrarefinding`);
      await getDb().unsafe('ANALYZE events');

      // The rare word comes last, after the prompt's repeated boilerplate.
      const prompt = `${Array.from({ length: 16 }, () => fillers.join(' ')).join('\n')} quillrarefinding`;
      // Recall and exact search each read the word statistics under their own bound.
      for (const recall of [true, false]) {
        const result = await searchContentByText(prompt, {
          organization_id: org.id,
          limit: 5,
          sort_by: 'score',
          approximate_candidate_search: recall,
          include_total: false,
        });
        expect(result.content[0]?.origin_id).toBe('recall-long-rare');
      }
    },
    CANDIDATE_QUERY_TIMEOUT_MS * 5
  );

  it(
    'reports partial coverage when embedding-less recall exceeds the budget',
    async () => {
      const org = await createTestOrganization({ name: 'Recall Budget Org' });
      const user = await createTestUser({ email: 'recall-budget@example.com' });
      await addUserToOrganization(user.id, org.id, 'owner');
      await createTestEntity({ name: 'Recall Budget Entity', organization_id: org.id });

      // Hold a lock that blocks every read of `events` for longer than the
      // budget. Without a bound the recall query waits for the release.
      let lockHeld!: () => void;
      const acquired = new Promise<void>((resolve) => {
        lockHeld = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holdMs = CANDIDATE_QUERY_TIMEOUT_MS * 3;
      lockTx = getDb().begin(async (tx) => {
        await tx.unsafe('LOCK TABLE events IN ACCESS EXCLUSIVE MODE');
        lockHeld();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([released, new Promise((resolve) => {
            timer = setTimeout(resolve, holdMs);
          })]);
        } finally {
          clearTimeout(timer);
        }
      });
      await Promise.race([acquired, lockTx]);

      const timeoutFailures = () => Number(getMetricsText().match(
        /^lobu_recall_query_failures_total\{sqlstate="57014"\} (\d+)$/m
      )?.[1] ?? 0);
      const failuresBefore = timeoutFailures();
      const direct = searchContentByText('budget probe', {
        organization_id: org.id,
        limit: 5,
        sort_by: 'score',
        approximate_candidate_search: true,
      });
      const timeout = (await direct.catch((error: unknown) => error)) as Error;
      expect(timeout).toMatchObject({ code: '57014' });
      expect(timeoutFailures()).toBe(failuresBefore + 1);

      const issues = trackIssues();
      const startedAt = Date.now();
      const result = await search(
        { query: 'budget probe', include_content: true },
        {} as Parameters<typeof search>[1],
        { organizationId: org.id, userId: user.id, memberRole: 'owner' } as Parameters<
          typeof search
        >[2]
      );
      expect(Date.now() - startedAt).toBeLessThan(holdMs);
      expect(result.coverage?.status).toBe('partial');
      expect(result.coverage?.local_sources).not.toContain('events');
      expect(timeoutFailures()).toBe(failuresBefore + 2);

      // The search answered, so nothing threw to a span: the lost recall has
      // to reach the issue tracker as its own record. A statement timeout is
      // the database refusing the work, so it is a dependency failure.
      const recorded = issues();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        error_kind: 'dependency',
        error_code: '57014',
        organization_id: org.id,
      });
      // One issue however Postgres words it, for any query in any workspace:
      // nothing that varies per occurrence is part of what gets hashed.
      for (const varying of [timeout.message, 'budget probe', org.id, org.slug]) {
        expect(recorded[0].error_grouping).not.toContain(varying);
      }
    },
    CANDIDATE_QUERY_TIMEOUT_MS * 5
  );
});
