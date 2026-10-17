/**
 * Channel feed materialization.
 *
 * A bound chat channel IS a feed. Its rows are not pulled
 * on a schedule; they arrive in real time and live in `channel_messages` (the
 * transcript), never embedded into `events`. Materializing the channel as a
 * `feeds` row is what lets it surface in the ONE unified Feeds list under its
 * connection, instead of a bespoke channel island.
 *
 * The `config.store` marker selects the transcript data plane. It declares no
 * connector `sync` operation, so the scheduler never queues it.
 *
 * Multi-replica safe + idempotent WITHOUT a unique constraint on
 * (connection_id, feed_key): the fast path is a lock-free SELECT (the common
 * case after the first bind); the slow path takes a transaction-scoped advisory
 * lock on the (connection, feed_key) tuple, re-checks, then inserts — so two
 * replicas binding the same channel concurrently can't create duplicates.
 */
import { createLogger } from "@lobu/core";
import { type DbClient, getDb } from "../../db/client.js";

const logger = createLogger("channel-feed");

/** The store a channel feed reads from (its config marker). */
const CHANNEL_FEED_STORE = "channel_messages";

async function findChannelFeedId(
	sql: DbClient,
	connectionId: string | number,
	feedKey: string,
): Promise<number | null> {
	const rows = await sql`
    SELECT id FROM feeds
    WHERE connection_id = ${connectionId}::bigint
      AND feed_key = ${feedKey}
      AND config @> ${sql.json({ store: CHANNEL_FEED_STORE })}::jsonb
      AND deleted_at IS NULL
    LIMIT 1
  `;
	return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Idempotently ensure the feed for a bound channel, returning its id.
 * `channelKey` is the channel id exactly as stored on the binding (may be
 * platform-prefixed, e.g. `slack:C…`) — the feed_key mirrors it for stable,
 * idempotent channel metadata.
 */
export async function ensureChannelFeed(opts: {
	connectionId: string | number;
	organizationId: string;
	/** Channel id as stored on the binding — becomes the feed_key. */
	channelKey: string;
	/** Human label for the feed (channel handle when known; else the id). */
	displayName?: string | null;
	/** Transaction client for callers that need feed materialization rolled back with a larger operation. */
	sql?: DbClient;
}): Promise<number> {
	const sql = opts.sql ?? getDb();
	const { connectionId, organizationId, channelKey } = opts;
	const displayName = opts.displayName ?? channelKey;

	const existing = await findChannelFeedId(sql, connectionId, channelKey);
	if (existing !== null) return existing;

	const insertWithLock = async (tx: DbClient) => {
		await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
			`channel-feed:${connectionId}:${channelKey}`,
		]);
		const again = await findChannelFeedId(tx, connectionId, channelKey);
		if (again !== null) return again;
		const inserted = await tx`
      INSERT INTO feeds (
        organization_id, connection_id, feed_key, display_name,
        status, config
      ) VALUES (
        ${organizationId}, ${connectionId}::bigint, ${channelKey}, ${displayName},
        'active', ${tx.json({ store: CHANNEL_FEED_STORE })}::jsonb
      )
      RETURNING id
    `;
		return Number(inserted[0].id);
	};

	if (opts.sql) return await insertWithLock(sql);
	return await sql.begin(insertWithLock);
}

/** Best-effort resolve/create — never throws. Feed materialization must not
 *  break the bind path; on failure the channel still binds (recall is unaffected)
 *  and the feed is created on the next bind, idempotently. */
export async function resolveChannelFeedId(opts: {
	connectionId: string | number;
	organizationId: string;
	channelKey: string;
	displayName?: string | null;
	sql?: DbClient;
}): Promise<number | null> {
	if (opts.sql) return await ensureChannelFeed(opts);
	try {
		return await ensureChannelFeed(opts);
	} catch (err) {
		logger.warn(
			{
				connectionId: opts.connectionId,
				channelKey: opts.channelKey,
				err: String(err),
			},
			"ensure channel feed failed (non-fatal)",
		);
		return null;
	}
}

/**
 * Soft-delete the feed for an unbound channel. Best-effort: an unbind
 * already removed the binding (the routing contract); a lingering feed row is
 * cosmetic, so a failure here never fails the unbind.
 */
export async function softDeleteChannelFeed(opts: {
	connectionId: string | number;
	channelKey: string;
	sql?: DbClient;
}): Promise<void> {
	const sql = opts.sql ?? getDb();
	if (opts.sql) {
		await sql`
      UPDATE feeds
      SET deleted_at = now(), status = 'paused', updated_at = now()
      WHERE connection_id = ${opts.connectionId}::bigint
        AND feed_key = ${opts.channelKey}
        AND config @> ${sql.json({ store: CHANNEL_FEED_STORE })}::jsonb
        AND deleted_at IS NULL
    `;
		return;
	}
	try {
		await sql`
      UPDATE feeds
      SET deleted_at = now(), status = 'paused', updated_at = now()
      WHERE connection_id = ${opts.connectionId}::bigint
        AND feed_key = ${opts.channelKey}
        AND config @> ${sql.json({ store: CHANNEL_FEED_STORE })}::jsonb
        AND deleted_at IS NULL
    `;
	} catch (err) {
		logger.warn(
			{
				connectionId: opts.connectionId,
				channelKey: opts.channelKey,
				err: String(err),
			},
			"soft-delete channel feed failed (non-fatal)",
		);
	}
}
