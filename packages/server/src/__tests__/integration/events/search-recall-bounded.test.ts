/**
 * Recall's bounded query budget. Recall without a query embedding must stay
 * under the same statement timeout as the candidate path, so a slow scan
 * degrades to partial coverage instead of a long wait.
 */

import postgres from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type DbClient, getDb, PROD_PG_VALUE_OPTIONS } from '../../../db/client';
import { getMetricsText } from '../../../gateway/metrics/prometheus';
import { search } from '../../../tools/search';
import { searchContentByText } from '../../../utils/content-search';
import {
  CANDIDATE_IVFFLAT_PROBES,
  CANDIDATE_QUERY_TIMEOUT_MS,
} from '../../../utils/content-search/fts';
import { runBoundedRecallQuery } from '../../../utils/content-search/search-path';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('recall query budget', () => {
  let releaseLock: (() => void) | null = null;
  let lockTx: Promise<void> | null = null;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();
  });

  afterEach(async () => {
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
      await expect(direct).rejects.toMatchObject({ code: '57014' });
      expect(timeoutFailures()).toBe(failuresBefore + 1);

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
    },
    CANDIDATE_QUERY_TIMEOUT_MS * 5
  );
});
