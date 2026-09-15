import { describe, expect, test } from "bun:test";
import {
	type ConnectionFeedRollupInput,
	deriveConnectionHealthSemantics,
} from "../../connectors/connection-health-semantics";
import { deriveFeedHealthSemantics } from "../../connectors/feed-health-semantics";

/**
 * Feed fixtures go through the REAL feed derivation rather than hand-built
 * verdicts, so a change to feed semantics that would break the connection
 * rollup fails here instead of drifting silently.
 */
const feed = (
	input: Parameters<typeof deriveFeedHealthSemantics>[0],
	itemsCollected = 0,
): ConnectionFeedRollupInput => ({
	semantics: deriveFeedHealthSemantics({
		operations: ["sync"],
		store: "events",
		...input,
	}),
	items_collected: itemsCollected,
});

/** A feed that collects on a cron and has produced items. */
const healthyFeed = (itemsCollected = 45_295) =>
	feed(
		{
			status: "active",
			schedule: "*/5 * * * *",
			last_sync_status: "success",
			last_sync_at: new Date(),
			next_run_at: new Date(Date.now() + 60_000),
		},
		itemsCollected,
	);

describe("connection attention — the three prod shapes this exists to separate", () => {
	// conn 623 (whatsapp.web, kshitij-aranke): created 2026-09-14, never touched
	// again. 0 feeds, 0 runs, status 'active'. connector-health called it healthy.
	test("a connection with no feeds at all reports no_feeds", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			connector_has_auto_syncable_feeds: true,
			feeds: [],
		});
		expect(result.attention).toBe("no_feeds");
		expect(result.expectedFeedCount).toBe(0);
	});

	// conn 280 (x, market): 14 feeds, every one paused with no schedule since
	// 2026-07-18. Also previously classified healthy.
	test("a connection whose every feed is paused reports paused", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: Array.from({ length: 14 }, () =>
				feed({ status: "paused", schedule: null }, 5_000),
			),
		});
		expect(result.attention).toBe("paused");
		expect(result.expectedFeedCount).toBe(14);
	});

	// conn 615 (whatsapp.web, lobu-team): verified collecting end-to-end
	// 2026-09-15, 6s from message to stored row.
	test("a collecting connection reports healthy", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed(281)],
		});
		expect(result.attention).toBe("healthy");
		expect(result.itemsCollected).toBe(281);
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
		expect(result.itemsCollected).toBe(0);
	});

	test("a feed that syncs successfully but collects nothing is NOT never_collected", () => {
		// "Syncs fine, produces nothing" is routine, not a defect: a mailbox label
		// with no mail collects zero forever. The verdict folds the feed-level
		// never_run, never the item count — same reasoning connector-health.ts
		// applies before it pages a human.
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [healthyFeed(0)],
		});
		expect(result.attention).toBe("healthy");
		expect(result.itemsCollected).toBe(0);
	});

	test("one feed that has ever collected clears it for the connection", () => {
		const result = deriveConnectionHealthSemantics({
			status: "active",
			feeds: [
				healthyFeed(1),
				feed({
					status: "active",
					schedule: "*/5 * * * *",
					next_run_at: new Date(Date.now() + 60_000),
				}),
			],
		});
		expect(result.attention).toBe("degraded");
		expect(result.itemsCollected).toBe(1);
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
					items_collected: 0,
				},
				{
					semantics: deriveFeedHealthSemantics({
						operations: ["read"],
						store: "events",
						status: "active",
					}),
					items_collected: 0,
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
				items_collected: 0,
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
