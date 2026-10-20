import { getDb } from "../../db/client.js";

/**
 * Sweep expired `public.rate_limits` rows. Safe to call periodically.
 *
 * The `rate_limits` table is a fixed-window counter — one row per key, with
 * `(count, window_started_at, expires_at)`. This helper just drains stale rows
 * so the table doesn't grow unbounded.
 */
export async function sweepExpiredRateLimits(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM rate_limits WHERE expires_at <= now() RETURNING key
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
