/**
 * Explicit connection lifecycle changes retain their existing feed cascade.
 * Implicit auth loss/recovery changes only connection readiness, never feeds.
 * Failure-paused feeds still need an explicit feed resume, and no-cron feeds
 * must not gain a new run when a connection is resumed.
 */

import { feedBackoff } from '../connectors/feed-backoff';
import type { DbClient } from '../db/client';

type FeedScope = { connectionId: number };

/** Pause live feeds for an explicit connection lifecycle change. */
export async function pauseFeedsForInactiveConnections(
  sql: DbClient,
  scope: FeedScope
): Promise<void> {
  await sql`
    UPDATE feeds f
    SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
    WHERE f.connection_id = ${scope.connectionId}
      AND f.deleted_at IS NULL
  `;
}

/** Resume eligible feeds when the operator explicitly resumes a connection. */
export async function resumeFeedsForRecoveredConnections(
  sql: DbClient,
  scope: FeedScope
): Promise<void> {
  await sql`
    UPDATE feeds f
    SET status = 'active',
        next_run_at = CASE WHEN f.schedule IS NULL THEN f.next_run_at
                           ELSE COALESCE(f.next_run_at, NOW()) END,
        updated_at = current_timestamp
    WHERE f.connection_id = ${scope.connectionId}
      AND f.deleted_at IS NULL
      AND f.status = 'paused'
      AND f.consecutive_failures < ${feedBackoff.pauseThreshold}
  `;
}
