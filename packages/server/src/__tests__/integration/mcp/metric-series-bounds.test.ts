/**
 * metric_series — bounded time range + invalid-timestamp reporting (#2051).
 *
 * A production run of a basic time-bucketed count returned a NULL bucket, a
 * 1970 epoch bucket, and future buckets through 2056 with no warning. The tool
 * must surface data quality (null / out-of-range bucket counts against a
 * bounded default range) and offer exclude_invalid_timestamps + strict modes.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { metricSeries } from "../../../tools/admin/metric_series";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestConnection,
	createTestEvent,
	createTestOrganization,
} from "../../setup/test-fixtures";

const BUCKET_SQL =
	"SELECT date_trunc('day', occurred_at) AS bucket, COUNT(*)::int AS n FROM events GROUP BY 1 ORDER BY 1";

describe("metric_series — bounds + data quality (#2051)", () => {
	let orgId: string;

	const ctx = (): ToolContext => ({
		organizationId: orgId,
		userId: "metric-bounds-user",
		memberRole: "owner",
		isAuthenticated: true,
		tokenType: "oauth",
		scopedToOrg: false,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Metric Bounds" });
		orgId = org.id;
		const db = getTestDb();

		const seed = async (occurredAt: string | null) => {
			const ev = await createTestEvent({
				organization_id: orgId,
				content: `bucket-${occurredAt ?? "null"}`,
			});
			await db`UPDATE events SET occurred_at = ${occurredAt} WHERE id = ${ev.id}`;
		};

		await seed(null); // null timestamp
		await seed("1970-01-01T00:00:00Z"); // epoch outlier (before range floor)
		await seed("2056-01-01T00:00:00Z"); // future outlier (past range ceiling)
		await seed(new Date().toISOString()); // valid, today
		await seed(new Date().toISOString()); // valid, today (same bucket)
	});

	it("reports null and out-of-range buckets without dropping rows by default", async () => {
		const res = await metricSeries({ sql: BUCKET_SQL }, {}, ctx());
		expect(res.columns).toEqual(["bucket", "n"]);
		// All 4 buckets still returned (null, 1970, 2056, today).
		expect(res.rows.length).toBe(4);
		expect(res.data_quality).toBeDefined();
		expect(res.data_quality?.time_column).toBe("bucket");
		expect(res.data_quality?.null_timestamps).toBe(1);
		expect(res.data_quality?.out_of_range).toBe(2);
		expect(res.data_quality?.excluded).toBe(false);
		expect(res.data_quality?.range?.start).toBeTruthy();
		expect(res.data_quality?.range?.end).toBeTruthy();
	});

	it("exclude_invalid_timestamps drops null + out-of-range buckets", async () => {
		const res = await metricSeries(
			{ sql: BUCKET_SQL, exclude_invalid_timestamps: true },
			{},
			ctx(),
		);
		expect(res.rows.length).toBe(1); // only today's bucket survives
		expect(res.rows[0]?.[1]).toBe(2); // both valid events counted
		expect(res.data_quality?.excluded).toBe(true);
		expect(res.data_quality?.null_timestamps).toBe(1);
		expect(res.data_quality?.out_of_range).toBe(2);
	});

	it("strict mode fails the call when invalid timestamps exist", async () => {
		await expect(
			metricSeries({ sql: BUCKET_SQL, strict: true }, {}, ctx()),
		).rejects.toThrow(/invalid|out-of-range/i);
	});

	it("caller-supplied start/end bounds narrow the valid range", async () => {
		// A range in 2055 makes even today's bucket out-of-range.
		const res = await metricSeries(
			{
				sql: BUCKET_SQL,
				start: "2055-01-01T00:00:00Z",
				end: "2057-01-01T00:00:00Z",
				exclude_invalid_timestamps: true,
			},
			{},
			ctx(),
		);
		expect(res.rows.length).toBe(1); // only the 2056 bucket is in range now
		expect(res.data_quality?.out_of_range).toBe(2); // 1970 + today
	});

	it("rejects an unknown explicit time_column", async () => {
		await expect(
			metricSeries({ sql: BUCKET_SQL, time_column: "nope" }, {}, ctx()),
		).rejects.toThrow(/time_column/i);
	});

	it("returns no data-quality flags for a series without a time column", async () => {
		const res = await metricSeries(
			{ sql: "SELECT COUNT(*)::int AS n FROM events" },
			{},
			ctx(),
		);
		expect(res.rows.length).toBe(1);
		expect(res.data_quality?.time_column).toBeNull();
		expect(res.data_quality?.null_timestamps).toBe(0);
		expect(res.data_quality?.out_of_range).toBe(0);
	});
});

describe("metric_series — member read-tier safety", () => {
	let orgId: string;

	const memberCtx = (): ToolContext => ({
		organizationId: orgId,
		userId: "metric-member",
		memberRole: "member",
		isAuthenticated: true,
		tokenType: "oauth",
		scopedToOrg: false,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		const org = await createTestOrganization({ name: "Metric Column Safety" });
		orgId = org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "slack",
		});
		// A secret in the withheld column makes a leak unmistakable.
		const db = getTestDb();
		await db`UPDATE connections SET credentials = ${db.json({ access_token: "SECRET-TOKEN" })} WHERE id = ${conn.id}`;
	});

	it("does not expose the credentials column via `SELECT * FROM connections`", async () => {
		const res = await metricSeries({ sql: "SELECT * FROM connections" }, {}, memberCtx());
		expect(res.columns).not.toContain("credentials");
		expect(JSON.stringify(res.rows)).not.toContain("SECRET-TOKEN");
		// The scope worked rather than returning nothing.
		expect(res.columns).toContain("connector_key");
	});

	it("refuses a data-modifying CTE (read-only transaction)", async () => {
		// A data-modifying WITH passes the SELECT/WITH guard, so the read-only
		// transaction is what must stop it.
		const db = getTestDb();
		const ev = await createTestEvent({ organization_id: orgId, content: "keep-me" });
		await expect(
			metricSeries(
				{ sql: "WITH x AS (DELETE FROM events RETURNING id) SELECT count(*) AS n FROM x" },
				{},
				memberCtx(),
			),
		).rejects.toThrow(/read-only|read only|cannot execute/i);
		const [row] = await db`SELECT id FROM events WHERE id = ${ev.id}`;
		expect(row?.id).toBeDefined();
	});
});
