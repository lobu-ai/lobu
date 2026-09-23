/**
 * Feed status that follows a connection's auth readiness.
 *
 * Several writers observe auth readiness: a sync that reports refreshed
 * browser-session state (every cookie rotation), a `manage_auth_profiles`
 * update, and a `manage_connections` update. Implicit propagation resumes only
 * connections that move out of `pending_auth`; routine rotations and metadata
 * edits must not undo manual or failure pauses.
 *
 * Even a real recovery never resumes a feed the failure policy paused
 * (`feedBackoff.pauseThreshold`, #3694, #3700): that pause ends only through
 * an explicit `manage_feeds` resume, which resets the failure episode. A feed
 * with no cron stays manual (#2021): resuming it must not invent a run.
 */

import { feedBackoff } from '../connectors/feed-backoff';
import type { DbClient } from '../db/client';

type FeedScope = { authProfileId: number } | { connectionId: number };

function scopeFilter(sql: DbClient, scope: FeedScope) {
  return 'authProfileId' in scope
    ? sql`f.connection_id IN (
        SELECT id FROM connections
        WHERE auth_profile_id = ${scope.authProfileId} AND deleted_at IS NULL
      )`
    : sql`f.connection_id = ${scope.connectionId}`;
}

/** Pause every live feed whose owning connection cannot currently run. */
export async function pauseFeedsForInactiveConnections(
  sql: DbClient,
  scope: FeedScope
): Promise<void> {
  await sql`
    UPDATE feeds f
    SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
    WHERE ${scopeFilter(sql, scope)}
      AND f.deleted_at IS NULL
  `;
}

/** Resume eligible feeds after their owning connection becomes active. */
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
    WHERE ${scopeFilter(sql, scope)}
      AND f.deleted_at IS NULL
      AND f.status = 'paused'
      AND f.consecutive_failures < ${feedBackoff.pauseThreshold}
  `;
}
