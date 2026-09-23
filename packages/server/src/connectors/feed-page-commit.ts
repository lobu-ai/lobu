/**
 * The transaction one feed page commits in.
 *
 * A page is the unit a connector hands over: some events and, usually, the
 * checkpoint that says those events were consumed. The invariant is the one
 * Automation windows already keep — the cursor moves only in the same
 * transaction that durably stores every event it covers, and only while the
 * run that wrote them still holds its lease. As separate autocommit statements
 * a crash, a failed item, or a reaped run each left a cursor describing events
 * that were never stored, and the next sync resumed past them for good.
 *
 * Everything that must hold for the page's whole write is taken here, before
 * the caller writes anything, in one global order:
 *
 *   organization (KEY SHARE) → connection (SHARE) → run (UPDATE) → feed (UPDATE)
 *   → event dedup identities, sorted by lock key
 *
 * Organization before connection matches connection deletion and relationship
 * claim reconciliation, which take the same two in that order. Deletion then
 * takes the connection FOR UPDATE, so it and a page serialize on that row
 * before either reaches a feed or a run. Run before feed matches the terminal
 * transition in `completeWorkerJob`. The dedup identities come last and sorted
 * so two pages sharing items cannot lock them in opposite orders.
 *
 * Nothing that leaves Postgres may run inside: `created_at` is stamped when the
 * transaction starts but the rows only become visible at commit, and Automation
 * windows trust every event write to commit well inside the arrival settle
 * budget (`intervals.automationArrivalSettleMs`). `transaction_timeout` makes
 * that bound hard rather than hoped for.
 */

import type { DbClient } from '../db/client';
import { runLeaseFence } from '../runs/run-lease';
import { lockEventDedupIdentities } from '../utils/insert-event';
import { isDeadlockDetected } from '../utils/pg-errors';
import { lockOrganizationForRelationshipClaims } from '../utils/relationship-claims';

/**
 * A third of the default arrival settle budget (60s). Fixed rather than
 * derived because tests collapse that budget to zero.
 */
const FEED_PAGE_TRANSACTION_TIMEOUT = '20s';

/** Postgres picks a deadlock victim; its page rolled back whole and can run again. */
const FEED_PAGE_ATTEMPTS = 3;

/** The run lost its lease or its connection/feed was deleted. */
export class FeedPageUnavailableError extends Error {
  constructor(runId: number) {
    super(`Run ${runId} cannot accept another feed page`);
    this.name = 'FeedPageUnavailableError';
  }
}

interface FeedPage {
  runId: number;
  /**
   * The worker holding the lease. Only a trusted worker may omit it
   * (`authorizeRunForWorker` requires it of a user-scoped one); the page is
   * then fenced on the run still running, with no owner to compare.
   */
  workerId: string | null;
  organizationId: string;
  connectionId: number | null;
  feedId: number | null;
  /** Source identities the page will write, locked before page data is written. */
  originIds: readonly string[];
}

/** Take the page's locks and check its live source + lease on `tx`. */
export async function lockFeedPage(tx: DbClient, page: FeedPage): Promise<void> {
  await tx.unsafe(`SET LOCAL transaction_timeout = '${FEED_PAGE_TRANSACTION_TIMEOUT}'`);
  await lockOrganizationForRelationshipClaims(tx, page.organizationId);
  if (page.connectionId != null) {
    const live = await tx`
      SELECT 1 FROM connections
      WHERE id = ${page.connectionId} AND deleted_at IS NULL
      FOR SHARE
    `;
    // Deletion cancels the connection's runs in the transaction that
    // tombstoned it, so a page arriving after it has lost its lease too.
    if (live.length === 0) throw new FeedPageUnavailableError(page.runId);
  }
  const leased = await tx`
    SELECT 1 FROM runs
    WHERE id = ${page.runId}
      ${page.workerId ? runLeaseFence(tx, page.workerId) : tx`AND status = 'running'`}
    FOR UPDATE
  `;
  if (leased.length === 0) throw new FeedPageUnavailableError(page.runId);
  if (page.feedId != null) {
    const live = await tx`
      SELECT 1 FROM feeds
      WHERE id = ${page.feedId} AND deleted_at IS NULL
      FOR UPDATE
    `;
    // Feed deletion and run cancellation are not one transaction on every
    // route. Fence on the feed row too, so that gap cannot accept another page.
    if (live.length === 0) throw new FeedPageUnavailableError(page.runId);
  }
  if (page.connectionId != null && page.originIds.length > 0) {
    await lockEventDedupIdentities(tx, page.connectionId, page.originIds);
  }
}

/**
 * Run `write` in the page's transaction and commit it. Retries a deadlock
 * victim, which rolled back whole; every other failure propagates with nothing
 * written. `write` must keep its state local to one call, since a retry runs
 * it again from the start.
 */
export async function withFeedPageTransaction<T>(
  sql: DbClient,
  page: FeedPage,
  write: (tx: DbClient) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        await lockFeedPage(tx, page);
        return write(tx);
      });
    } catch (error) {
      if (attempt < FEED_PAGE_ATTEMPTS && isDeadlockDetected(error)) continue;
      throw error;
    }
  }
}
