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
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(attention).toBe("no_feeds");
	});

	// The all-paused shape: 14 feeds, every one paused with no schedule for two
	// months. Also previously classified healthy.
	test("a connection whose every feed is paused reports paused", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: Array.from({ length: 14 }, () =>
				feed({ status: "paused", schedule: null }),
			),
		});
		expect(attention).toBe("paused");
	});

	// The working shape: verified collecting end-to-end, 6s from inbound message
	// to stored row.
	test("a collecting connection reports healthy", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed()],
		});
		expect(attention).toBe("healthy");
	});
});

describe("never_collected", () => {
	test("dispatchable feeds that have never produced an item", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					next_run_at: new Date(Date.now() + 60_000),
				}),
			],
		});
		expect(attention).toBe("never_collected");
	});

	test("a feed that syncs successfully but collects nothing is NOT never_collected", () => {
		// "Syncs fine, produces nothing" is routine, not a defect: a mailbox label
		// with no mail collects zero forever. The verdict folds the feed-level
		// never_run, never the item count — same reasoning connector-health.ts
		// applies before it pages a human.
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed()],
		});
		expect(attention).toBe("healthy");
	});

	test("one feed that has ever collected clears it for the connection", () => {
		const attention = deriveConnectionHealthSemantics({
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
		expect(attention).toBe("degraded");
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
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [overdueFeed()],
		});
		expect(attention).toBe("healthy");
	});

	test("an overdue feed alongside a paused one still reports degraded", () => {
		// Ignoring overdue must not swallow a sibling feed's real problem.
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [overdueFeed(), feed({ status: "paused", schedule: null })],
		});
		expect(attention).toBe("degraded");
	});
});

describe("precedence", () => {
	test("cause before symptom: no_trigger outranks never_collected", () => {
		// A feed with no cron, no webhook and no channel has also never run.
		// Reporting never_collected would name the consequence and hide the cause.
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [feed({ status: "active", schedule: null, webhook_driven: false })],
		});
		expect(attention).toBe("no_trigger");
	});

	test("a connection blocked on auth outranks anything its feeds say", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "pending_auth",
			feeds: [],
		});
		expect(attention).toBe("needs_auth");
	});

	test("a revoked auth profile reports needs_auth, not degraded", () => {
		// connections.status records intent and nothing rewrites it, so a profile
		// can go revoked under an 'active' connection. Every feed then derives
		// needs_auth, and calling the connection merely degraded would bury the
		// one state a human can act on.
		const attention = deriveConnectionHealthSemantics({
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
		expect(attention).toBe("needs_auth");
	});

	test("an operator-paused connection reads the same with or without feeds", () => {
		// Both shapes are the same intent, so they must not read two ways. With
		// feeds every feed derives paused from connection_status and the fold says
		// paused; with none it used to fall through to the zero-feed branch and
		// report no_feeds, which describes a setup problem the operator does not
		// have.
		const withFeeds = deriveConnectionHealthSemantics({
			status: "paused",
			connector_has_auto_syncable_feeds: true,
			feeds: [feed({ status: "active", schedule: "*/5 * * * *" })],
		});
		const withoutFeeds = deriveConnectionHealthSemantics({
			status: "paused",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(withFeeds).toBe("paused");
		expect(withoutFeeds).toBe("paused");
	});

	test("an errored connection reports misconfigured", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "error",
			feeds: [healthyFeed()],
		});
		expect(attention).toBe("misconfigured");
	});
});

describe("connections that legitimately have no collector feeds", () => {
	test("a chat transport row is not a collector and stays healthy", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			credential_mode: "chat",
			feeds: [],
		});
		expect(attention).toBe("healthy");
	});

	test("a consent-only connection is FORBIDDEN feeds, so zero is correct", () => {
		// It holds an OAuth grant for cloud-delegated token fetch; the member's
		// data lives on their local instance and manage_feeds refuses feeds on one.
		// Measured on prod 2026-09-15, all 8 active connections of this shape were
		// already carrying unhealthy_alerted_at — the oldest since 2026-07-09.
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			consent_only: true,
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(attention).toBe("healthy");
	});

	test("a connector declaring no auto-syncable feeds stays healthy", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: false,
			feeds: [],
		});
		expect(attention).toBe("healthy");
	});

	test("an unknown connector fails closed and still reports no_feeds", () => {
		// Undefined means we could not read the definition. Hiding an install
		// problem is worse than a false positive here.
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [],
		});
		expect(attention).toBe("no_feeds");
	});
});

describe("only collector feeds are folded", () => {
	test("streaming and source_only feeds are excluded from the rollup", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				feed({ store: "channel_messages", status: "active" }),
				feed({ operations: ["read"], status: "active" }),
			],
		});
		// The fixtures must really be non-collectors, or this test would pass for
		// any shape isCollector happens to reject — which is how it read before:
		// it passed hand-built objects carrying no executionMode at all.
		expect(
			feed({ store: "channel_messages", status: "active" }).executionMode,
		).toBe("streaming");
		expect(feed({ operations: ["read"], status: "active" }).executionMode).toBe(
			"source_only",
		);
		// No collector feeds were supplied, so there is nothing to roll up — and
		// crucially NOT `no_feeds`, because feed rows DO exist. A Slack connection
		// carrying only channel feeds is the common shape here, and flagging it
		// would make this verdict noise on every working chat connection.
		// connector-health.ts draws the same line.
		expect(attention).toBe("healthy");
	});

	test("a chat connection whose channels are its only feeds stays healthy", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			// No credential_mode, and the connector DOES declare an auto-syncable
			// feed elsewhere (Slack's `files`) — so neither existing guard rescues
			// this row. Only counting its actual feed rows does.
			connector_has_auto_syncable_feeds: true,
			feeds: Array.from({ length: 5 }, () =>
				feed({ store: "channel_messages", status: "active" }),
			),
		});
		expect(attention).toBe("healthy");
	});

	test("a collector connection with no feed rows at all is still no_feeds", () => {
		const attention = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(attention).toBe("no_feeds");
	});
});
