import { describe, expect, test } from "bun:test";
import { deriveConnectionHealthSemantics } from "../../connectors/connection-health-semantics";
import {
	deriveFeedHealthSemantics,
	type FeedHealthSemantics,
} from "../../connectors/feed-health-semantics";

/**
 * Feed fixtures go through the REAL feed derivation rather than hand-built
 * verdicts, so a change to feed semantics that would break the connection
 * rollup fails here instead of drifting silently.
 */
const feed = (
	input: Parameters<typeof deriveFeedHealthSemantics>[0],
): FeedHealthSemantics =>
	deriveFeedHealthSemantics({
		operations: ["sync"],
		store: "events",
		...input,
	});

/** A feed that collects on a cron and has synced successfully. */
const healthyFeed = () =>
	feed({
		status: "active",
		schedule: "*/5 * * * *",
		last_sync_status: "success",
		last_sync_at: new Date(),
		next_run_at: new Date(Date.now() + 60_000),
	});

describe("connection attention — the three prod shapes this exists to separate", () => {
	// The abandoned-setup shape: a connection created and never returned to.
	// 0 feeds, 0 runs, status 'active' — connector-health called it healthy.
	test("a connection with no feeds at all reports no_feeds", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(result.attention).toBe("no_feeds");
		expect(result.expectedFeedCount).toBe(0);
	});

	// The all-paused shape: 14 feeds, every one paused with no schedule for two
	// months. Also previously classified healthy.
	test("a connection whose every feed is paused reports paused", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: Array.from({ length: 14 }, () =>
				feed({ status: "paused", schedule: null }),
			),
		});
		expect(result.attention).toBe("paused");
		expect(result.expectedFeedCount).toBe(14);
	});

	// The working shape: verified collecting end-to-end, 6s from inbound message
	// to stored row.
	test("a collecting connection reports healthy", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed()],
		});
		expect(result.attention).toBe("healthy");
	});
});

describe("never_collected", () => {
	test("dispatchable feeds that have never produced an item", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					next_run_at: new Date(Date.now() + 60_000),
				}),
			],
		});
		expect(result.attention).toBe("never_collected");
	});

	test("a feed that syncs successfully but collects nothing is NOT never_collected", () => {
		// "Syncs fine, produces nothing" is routine, not a defect: a mailbox label
		// with no mail collects zero forever. The verdict folds the feed-level
		// never_run, never the item count — same reasoning connector-health.ts
		// applies before it pages a human.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed()],
		});
		expect(result.attention).toBe("healthy");
	});

	test("one feed that has ever collected clears it for the connection", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				healthyFeed(),
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					next_run_at: new Date(Date.now() + 60_000),
				}),
			],
		});
		expect(result.attention).toBe("degraded");
	});
});

describe("verdicts this rollup deliberately does not reach", () => {
	/** Scheduled, synced before, and its next run is two hours late. */
	const overdueFeed = () =>
		feed({
			status: "active",
			schedule: "*/5 * * * *",
			last_sync_status: "success",
			last_sync_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
			next_run_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
		});

	test("the fixture really does derive overdue at the feed level", () => {
		// Without this the two tests below would pass for the wrong reason if the
		// feed-level rule ever stopped firing for this shape.
		expect(overdueFeed().attention).toBe("overdue");
	});

	test("an overdue feed does not drag its connection to degraded", () => {
		// `overdue` is derived from active_runs, which this rollup cannot supply
		// without counting `runs` on a list request path. list_feeds DOES supply
		// it and suppresses overdue while a sync is in flight, so folding it here
		// would let the connection say degraded about a feed the feed page calls
		// healthy. The omission is one-directional by design: understate, never
		// invent. connector-health's no_recent_sync still pages a human.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [overdueFeed()],
		});
		expect(result.attention).toBe("healthy");
	});

	test("an overdue feed alongside a paused one still reports degraded", () => {
		// Ignoring overdue must not swallow a sibling feed's real problem.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [overdueFeed(), feed({ status: "paused", schedule: null })],
		});
		expect(result.attention).toBe("degraded");
	});
});

describe("precedence", () => {
	test("cause before symptom: no_trigger outranks never_collected", () => {
		// A feed with no cron, no webhook and no channel has also never run.
		// Reporting never_collected would name the consequence and hide the cause.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [feed({ status: "active", schedule: null, webhook_driven: false })],
		});
		expect(result.attention).toBe("no_trigger");
	});

	test("a connection blocked on auth outranks anything its feeds say", () => {
		const result = deriveConnectionHealthSemantics({
			status: "pending_auth",
			feeds: [],
		});
		expect(result.attention).toBe("needs_auth");
	});

	test("a revoked auth profile reports needs_auth, not degraded", () => {
		// connections.status records intent and nothing rewrites it, so a profile
		// can go revoked under an 'active' connection. Every feed then derives
		// needs_auth, and calling the connection merely degraded would bury the
		// one state a human can act on.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					auth_profile_status: "revoked",
				}),
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					auth_profile_status: "revoked",
				}),
			],
		});
		expect(result.attention).toBe("needs_auth");
	});

	test("an errored connection reports misconfigured", () => {
		const result = deriveConnectionHealthSemantics({
			status: "error",
			feeds: [healthyFeed()],
		});
		expect(result.attention).toBe("misconfigured");
	});
});

describe("connections that legitimately have no collector feeds", () => {
	test("a chat transport row is not a collector and stays healthy", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			credential_mode: "chat",
			feeds: [],
		});
		expect(result.attention).toBe("healthy");
	});

	test("a consent-only connection is FORBIDDEN feeds, so zero is correct", () => {
		// It holds an OAuth grant for cloud-delegated token fetch; the member's
		// data lives on their local instance and manage_feeds refuses feeds on one.
		// Measured on prod 2026-09-15, all 8 active connections of this shape were
		// already carrying unhealthy_alerted_at — the oldest since 2026-07-09.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			consent_only: true,
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(result.attention).toBe("healthy");
	});

	test("a connector declaring no auto-syncable feeds stays healthy", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: false,
			feeds: [],
		});
		expect(result.attention).toBe("healthy");
	});

	test("an unknown connector fails closed and still reports no_feeds", () => {
		// Undefined means we could not read the definition. Hiding an install
		// problem is worse than a false positive here.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [],
		});
		expect(result.attention).toBe("no_feeds");
	});
});

describe("only collector feeds are folded", () => {
	test("streaming and source_only feeds are excluded from the rollup", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				{
					semantics: deriveFeedHealthSemantics({
						operations: ["sync"],
						store: "channel_messages",
						status: "active",
					}),
				},
				{
					semantics: deriveFeedHealthSemantics({
						operations: ["read"],
						store: "events",
						status: "active",
					}),
				},
			],
		});
		// No collector feeds were supplied, so there is nothing to roll up — and
		// crucially NOT `no_feeds`, because feed rows DO exist. A Slack connection
		// carrying only channel feeds is the common shape here, and flagging it
		// would make this verdict noise on every working chat connection.
		// connector-health.ts draws the same line.
		expect(result.expectedFeedCount).toBe(0);
		expect(result.attention).toBe("healthy");
	});

	test("a chat connection whose channels are its only feeds stays healthy", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			// No credential_mode, and the connector DOES declare an auto-syncable
			// feed elsewhere (Slack's `files`) — so neither existing guard rescues
			// this row. Only counting its actual feed rows does.
			connector_has_auto_syncable_feeds: true,
			feeds: Array.from({ length: 5 }, () => ({
				semantics: deriveFeedHealthSemantics({
					operations: ["sync"],
					store: "channel_messages",
					status: "active",
				}),
			})),
		});
		expect(result.attention).toBe("healthy");
	});

	test("a collector connection with no feed rows at all is still no_feeds", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(result.attention).toBe("no_feeds");
	});
});
