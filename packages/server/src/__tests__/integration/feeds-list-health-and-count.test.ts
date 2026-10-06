/**
 * list_feeds must report the true match count and expose active-but-failing
 * feeds.
 *
 * Two gaps this covers:
 *  - `total` was `rows.length` (the page length), so a 3-feed page reported
 *    total:3 even when more matched — and `total === limit` was
 *    indistinguishable from an exact count. It is now COUNT(*) OVER() across
 *    the whole filtered set, plus a `has_more` flag.
 *  - A feed keeps `status = 'active'` while its syncs fail (until auto-pause
 *    takes over), so the `status` filter can never surface a failing-but-active
 *    feed. The `health` filter matches active feeds on
 *    last_sync_status/consecutive_failures; paused feeds and feeds on paused
 *    connections are lifecycle history, not current health.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

describe("list_feeds health filter and true total", () => {
	let orgId: string;
	let ctx: ToolContext;
	let connectionId: number;
	let pausedConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Feeds Health Org",
		});
		orgId = org.id;
		ctx = ownerCtx;
		await createTestConnectorDefinition({
			key: "hackernews",
			name: "Hacker News",
			organization_id: orgId,
			feeds_schema: Object.fromEntries(
				[
					"h1",
					"h2",
					"h3",
					"bad1",
					"bad2",
					"paused-manual-failed",
					"paused-auto-failed",
					"paused-healthy",
					"paused-connection-failing",
					"paused-connection-healthy",
					"scheduled-overdue",
					"scheduled-active",
					"no-schedule-old",
				].map((feedKey) => [
					feedKey,
					// Everything here except `no-schedule-old` models an unattended
					// EVENT-DRIVEN feed: no cron, but a webhook route that re-arms
					// next_run_at (the github `issue_comments` shape). That keeps this
					// suite's axis sync history + lifecycle, and keeps execution_mode
					// `no_schedule`, without the rows tripping `attention='no_trigger'`
					// — which is what `no-schedule-old` is here to cover.
					feedKey === "no-schedule-old"
						? {}
						: { webhook: { events: ["item"] } },
				]),
			),
		});

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "hackernews",
			createDefaultFeed: false,
		});
		connectionId = conn.id;
		const pausedConn = await createTestConnection({
			organization_id: orgId,
			connector_key: "hackernews",
			status: "paused",
			createDefaultFeed: false,
		});
		pausedConnectionId = pausedConn.id;

		const sql = getTestDb();
		// On the active connection: 3 healthy active, 2 failing active, and 3
		// paused. The paused set covers a feed paused one failure in, one at the
		// default `feedBackoff.pauseThreshold` (20) where auto-pause fires, and one
		// paused while healthy — so both health branches have a paused row they
		// would otherwise have matched.
		const feeds: Array<{
			key: string;
			status: string;
			last: string | null;
			fails: number;
		}> = [
			{ key: "h1", status: "active", last: "success", fails: 0 },
			{ key: "h2", status: "active", last: "success", fails: 0 },
			{ key: "h3", status: "active", last: null, fails: 0 },
			{ key: "bad1", status: "active", last: "failed", fails: 14 },
			{ key: "bad2", status: "active", last: "success", fails: 3 },
			{
				key: "paused-manual-failed",
				status: "paused",
				last: "failed",
				fails: 1,
			},
			{
				key: "paused-auto-failed",
				status: "paused",
				last: "failed",
				fails: 20,
			},
			{ key: "paused-healthy", status: "paused", last: "success", fails: 0 },
		];
		for (const f of feeds) {
			await sql`
				INSERT INTO feeds (
					organization_id, connection_id, feed_key, status,
					last_sync_status, consecutive_failures, entity_ids, created_at, updated_at
				) VALUES (
					${orgId}, ${connectionId}, ${f.key}, ${f.status},
					${f.last}, ${f.fails}, ARRAY[]::bigint[], NOW(), NOW()
				)
			`;
		}
		// The paused parent carries active feeds that would match each health
		// predicate on sync history alone, but derive attention='paused'.
		for (const f of [
			{ key: "paused-connection-failing", last: "failed", fails: 1 },
			{ key: "paused-connection-healthy", last: "success", fails: 0 },
		]) {
			await sql`
				INSERT INTO feeds (
					organization_id, connection_id, feed_key, status,
					last_sync_status, consecutive_failures, entity_ids, created_at, updated_at
				) VALUES (
					${orgId}, ${pausedConnectionId}, ${f.key}, 'active',
					${f.last}, ${f.fails}, ARRAY[]::bigint[], NOW(), NOW()
				)
			`;
		}
	});

	async function runList(args: Record<string, unknown>): Promise<{
		feeds: Array<Record<string, unknown>>;
		total: number;
		has_more: boolean;
	}> {
		return (await manageFeeds(
			{ action: "list_feeds", ...args },
			{} as Env,
			ctx,
		)) as {
			feeds: Array<Record<string, unknown>>;
			total: number;
			has_more: boolean;
		};
	}

	async function list(args: Record<string, unknown>) {
		return runList({ connection_id: connectionId, ...args });
	}

	it("shows observation failures and recovery in both health filters and attention", async () => {
		const sql = getTestDb();
		await createTestConnectorDefinition({ key: "synthetic.observed", name: "Observed", organization_id: orgId,
			feeds_schema: { items: { operations: ["read", "observe"] } } });
		const conn = await createTestConnection({ organization_id: orgId, connector_key: "synthetic.observed", createDefaultFeed: false });
		const [row] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, consecutive_failures, last_sync_status)
			VALUES (${orgId}, ${conn.id}, 'items', 'active', 1, 'failed') RETURNING id`;
		try {
			const failing = await runList({ connection_id: conn.id, health: "failing" });
			expect(failing.feeds).toHaveLength(1);
			expect(failing.feeds[0].attention).toBe("last_attempt_failed");
			expect((await runList({ connection_id: conn.id, health: "healthy" })).feeds).toHaveLength(0);
			await sql`UPDATE feeds SET consecutive_failures = 0 WHERE id = ${row.id}`;
			const healthy = await runList({ connection_id: conn.id, health: "healthy" });
			expect(healthy.feeds).toHaveLength(1);
			expect(healthy.feeds[0].attention).toBe("healthy");
			expect((await runList({ connection_id: conn.id, health: "failing" })).feeds).toHaveLength(0);
		} finally {
			await sql`UPDATE feeds SET deleted_at = now() WHERE id = ${row.id}`;
		}
	});

	it("reports the true total across pages, not the page length, with has_more", async () => {
		const page1 = await list({ limit: 2, offset: 0 });
		expect(page1.feeds).toHaveLength(2);
		expect(page1.total).toBe(8);
		expect(page1.has_more).toBe(true);

		const lastPage = await list({ limit: 2, offset: 6 });
		expect(lastPage.feeds).toHaveLength(2);
		expect(lastPage.total).toBe(8);
		expect(lastPage.has_more).toBe(false);
	});

	it("does not leak the internal count column onto feed rows", async () => {
		const res = await list({ limit: 10 });
		for (const feed of res.feeds) {
			expect(feed).not.toHaveProperty("filtered_total");
		}
	});

	it("health=failing includes only active failing feeds", async () => {
		// The status filter cannot separate them: bad1/bad2 read as 'active'
		// alongside h1-h3.
		const active = await list({ status: "active" });
		expect(active.total).toBe(5);

		const failing = await runList({ health: "failing" });
		const keys = failing.feeds.map((f) => f.feed_key).sort();
		expect(keys).toEqual(["bad1", "bad2"]);
		expect(failing.total).toBe(2);
	});

	it("health=healthy includes only active healthy feeds", async () => {
		const healthy = await runList({ health: "healthy" });
		const keys = healthy.feeds.map((f) => f.feed_key).sort();
		expect(keys).toEqual(["h1", "h2", "h3"]);
		expect(healthy.total).toBe(3);
	});

	it("returns has_more:false and total:0 for an empty filtered set", async () => {
		const none = await list({ health: "failing", feed_ids: [999999999] });
		expect(none.feeds).toHaveLength(0);
		expect(none.total).toBe(0);
		expect(none.has_more).toBe(false);
	});

	it("reports the true total (not 0) for an offset past the last page", async () => {
		// 8 feeds match; an offset beyond them yields an empty page. total must
		// still be the whole-filter count via the overshoot fallback, not 0 read
		// off the empty page's window function.
		const overshoot = await list({ limit: 2, offset: 10 });
		expect(overshoot.feeds).toHaveLength(0);
		expect(overshoot.total).toBe(8);
		expect(overshoot.has_more).toBe(false);
	});

	it("rejects update_feed status:'error' — a runtime state, not a settable one", async () => {
		// 'error' is in the DB CHECK but nothing writes it; a failing feed stays
		// active and is found via health:failing. Letting an agent set it would
		// create a zombie state the list status filter cannot select.
		const [row] = (await getTestDb()`
			SELECT id FROM feeds WHERE organization_id = ${orgId} AND feed_key = 'h1'
		`) as unknown as Array<{ id: number }>;
		await expect(
			manageFeeds(
				{ action: "update_feed", feed_id: Number(row.id), status: "error" },
				{} as Env,
				ctx,
			),
		).rejects.toThrow();
	});

	it("surfaces derived execution_mode / attention without incident_eligible", async () => {
		const res = await list({ limit: 10 });
		const byKey = new Map(
			res.feeds.map((f) => [f.feed_key, f as Record<string, unknown>]),
		);
		// h3 (never synced) carries no cron but IS webhook-driven → no_schedule,
		// never_run. `no_trigger` must not fire for it: a webhook delivery can
		// still make it due.
		const h3 = byKey.get("h3");
		expect(h3?.execution_mode).toBe("no_schedule");
		expect(h3?.attention).toBe("never_run");
		// bad1 is active-but-failing with no cron → no_schedule, last_attempt_failed.
		const bad1 = byKey.get("bad1");
		expect(bad1?.execution_mode).toBe("no_schedule");
		expect(bad1?.attention).toBe("last_attempt_failed");
		// h1/h2 succeeded → healthy.
		expect(byKey.get("h1")?.attention).toBe("healthy");
		expect(byKey.get("h2")?.attention).toBe("healthy");
		// Paused feeds stay lifecycle history regardless of their last outcome.
		expect(byKey.get("paused-manual-failed")?.attention).toBe("paused");
		expect(byKey.get("paused-auto-failed")?.attention).toBe("paused");
		expect(byKey.get("paused-healthy")?.attention).toBe("paused");
		const pausedParent = await runList({
			connection_id: pausedConnectionId,
			limit: 10,
		});
		// Assert the count first: an empty page would make the loop below pass
		// vacuously.
		expect(pausedParent.feeds).toHaveLength(2);
		for (const feed of pausedParent.feeds) {
			expect(feed.status).toBe("active");
			expect(feed.attention).toBe("paused");
		}
		for (const f of res.feeds) {
			expect(f).not.toHaveProperty("incident_eligible");
		}
	});

	it("only a dispatchable webhook route counts as a dispatch path", async () => {
		// loadGithubWebhookRoutes (gateway/routes/public/app-webhooks.ts) routes
		// a delivery only when `webhook.events` is an array holding at least one
		// non-empty string.
		// Anything looser declares nothing the router will ever dispatch, so it
		// must NOT suppress `no_trigger` — otherwise a malformed declaration
		// hides the feed this classification exists to surface. Note `null`:
		// jsonb null is not SQL NULL, so a bare IS NOT NULL check passes it.
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "webhook-shapes",
			createDefaultFeed: false,
		});
		const sql = getTestDb();
		const shapes: Array<[string, unknown, string]> = [
			["wh-real", { events: ["item"] }, "healthy"],
			["wh-empty-object", {}, "no_trigger"],
			["wh-mode-only", { mode: "store" }, "no_trigger"],
			["wh-empty-events", { events: [] }, "no_trigger"],
			["wh-blank-event", { events: [""] }, "no_trigger"],
			["wh-non-string-event", { events: [7] }, "no_trigger"],
			["wh-json-null", null, "no_trigger"],
		];
		await createTestConnectorDefinition({
			key: "webhook-shapes",
			name: "Webhook Shapes",
			organization_id: orgId,
			feeds_schema: Object.fromEntries(
				shapes.map(([feedKey, webhook]) => [
					feedKey,
					{ operations: ["sync"], webhook },
				]),
			),
		});
		for (const [feedKey] of shapes) {
			await sql`
				INSERT INTO feeds (
					organization_id, connection_id, feed_key, status, schedule,
					last_sync_status, last_sync_at, consecutive_failures, entity_ids,
					created_at, updated_at
				) VALUES (
					${orgId}, ${conn.id}, ${feedKey}, 'active', NULL,
					'success', current_timestamp - interval '30 days', 0,
					ARRAY[]::bigint[], NOW(), NOW()
				)
			`;
		}

		const listed = await runList({ connection_id: conn.id, limit: 20 });
		const byKey = new Map(listed.feeds.map((feed) => [feed.feed_key, feed]));
		for (const [feedKey, , expected] of shapes) {
			expect(`${feedKey}=${byKey.get(feedKey)?.attention}`).toBe(
				`${feedKey}=${expected}`,
			);
		}
	});

	it("keeps health filters aligned for overdue, active-run, and manual feeds", async () => {
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "hackernews",
			createDefaultFeed: false,
		});
		const sql = getTestDb();
		await sql`
			INSERT INTO connector_definitions (
				key, name, version, feeds_schema, auth_schema, organization_id,
				status, created_at, updated_at
			) VALUES (
				'hackernews', 'Hacker News', '0.9.0',
				${sql.json({ "pinned-read-only": { operations: ["read"] } })},
				${sql.json({})}, ${orgId}, 'archived', NOW(), NOW()
			)
		`;
		await sql`
			UPDATE connector_definitions
			SET feeds_schema = jsonb_set(
				feeds_schema,
				'{pinned-read-only}',
				${sql.json({ operations: ["sync"] })}::jsonb,
				true
			)
			WHERE organization_id = ${orgId}
				AND key = 'hackernews'
				AND status = 'active'
		`;
		await sql`
			INSERT INTO feeds (
					organization_id, connection_id, feed_key, status, schedule,
				next_run_at, last_sync_status, last_sync_at, consecutive_failures,
				entity_ids, created_at, updated_at
			) VALUES
				(
						${orgId}, ${conn.id}, 'scheduled-overdue', 'active',
					'0 * * * *', current_timestamp - interval '2 hours', 'success',
					current_timestamp - interval '3 hours', 0, ARRAY[]::bigint[], NOW(), NOW()
				),
				(
						${orgId}, ${conn.id}, 'scheduled-active', 'active',
					'0 * * * *', current_timestamp - interval '2 hours', 'success',
					current_timestamp - interval '3 hours', 0, ARRAY[]::bigint[], NOW(), NOW()
				),
				(
						${orgId}, ${conn.id}, 'no-schedule-old', 'active',
					NULL, NULL, 'success', current_timestamp - interval '30 days', 0,
					ARRAY[]::bigint[], NOW(), NOW()
				)
		`;
		await sql`
			INSERT INTO feeds (
				organization_id, connection_id, feed_key, status, schedule,
				next_run_at, last_sync_status, last_sync_at, consecutive_failures,
				entity_ids, pinned_version, created_at, updated_at
			) VALUES (
				${orgId}, ${conn.id}, 'pinned-read-only', 'active',
				'0 * * * *', current_timestamp - interval '2 hours', 'failed',
				current_timestamp - interval '3 hours', 3, ARRAY[]::bigint[],
				'0.9.0', NOW(), NOW()
			)
		`;
		await sql`
			INSERT INTO runs (
				organization_id, run_type, feed_id, status, approval_status, created_at
			)
			SELECT ${orgId}, 'sync', id, 'running', 'auto', current_timestamp
			FROM feeds
			WHERE organization_id = ${orgId}
			  AND connection_id = ${conn.id}
			  AND feed_key = 'scheduled-active'
		`;

		const listed = await runList({ connection_id: conn.id, limit: 10 });
		const byKey = new Map(listed.feeds.map((feed) => [feed.feed_key, feed]));
		expect(byKey.get("scheduled-overdue")?.attention).toBe("overdue");
		expect(byKey.get("scheduled-active")?.attention).toBe("healthy");
		// 30 days since its last (successful) sync, no cron, no webhook — the
		// exact shape that read as healthy while being unreachable.
		expect(byKey.get("no-schedule-old")?.attention).toBe("no_trigger");
		expect(byKey.get("pinned-read-only")?.operations).toEqual(["read"]);
		expect(byKey.get("pinned-read-only")?.attention).toBe("healthy");

		// `health` is a SYNC-health filter and deliberately narrower than
		// `attention`: it mirrors only the paused / failing / overdue portions of
		// deriveFeedHealthSemantics. `no_trigger` is not a sync failure — the feed
		// is unconfigured, not broken — so like needs_auth and device_offline it
		// is not excluded here, and `no-schedule-old` stays in this set.
		const healthy = await runList({
			connection_id: conn.id,
			health: "healthy",
		});
		expect(healthy.feeds.map((feed) => feed.feed_key).sort()).toEqual([
			"no-schedule-old",
			"pinned-read-only",
			"scheduled-active",
		]);

		const failing = await runList({
			connection_id: conn.id,
			health: "failing",
		});
		expect(failing.feeds.map((feed) => feed.feed_key)).toEqual([
			"scheduled-overdue",
		]);
	});
});
