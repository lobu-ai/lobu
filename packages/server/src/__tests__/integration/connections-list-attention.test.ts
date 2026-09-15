/**
 * `manage_connections.list` / `.get` surface a DERIVED connection verdict.
 *
 * This is the end-to-end proof for `deriveConnectionHealthFromRow`: the unit
 * suite pins the fold, and this pins the part the fold cannot see — that the
 * `feed_health` jsonb the query aggregates actually carries the columns the
 * derivation reads, under the real definition join. A typo in that aggregate
 * would still typecheck and would silently report every connection healthy.
 *
 * The three seeded shapes are the prod connections the module exists to
 * separate: one abandoned mid-setup, one whose feeds are all paused, and one
 * genuinely collecting.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
} from "../setup/test-fixtures";
import { TestWorkspace } from "../setup/test-mcp-client";

type ConnectionRow = { id: number; attention?: string };
type ListResult = { connections?: ConnectionRow[] };
type GetResult = { connection?: ConnectionRow };

async function seedFeed(opts: {
	orgId: string;
	connectionId: number;
	feedKey: string;
	status?: string;
	schedule?: string | null;
	lastSyncStatus?: string | null;
	lastSyncAt?: Date | null;
	nextRunAt?: Date | null;
	itemsCollected?: number;
}): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, config,
      schedule, last_sync_status, last_sync_at, next_run_at,
      items_collected, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectionId}, ${opts.feedKey},
      ${opts.status ?? "active"}, ${sql.json({ store: "events" })},
      ${opts.schedule ?? null}, ${opts.lastSyncStatus ?? null},
      ${opts.lastSyncAt ?? null}, ${opts.nextRunAt ?? null},
      ${opts.itemsCollected ?? 0}, NOW(), NOW()
    )
  `;
}

describe("manage_connections surfaces derived connection health", () => {
	let workspace: TestWorkspace;
	let noFeedsId: number;
	let pausedId: number;
	let healthyId: number;
	let neverCollectedId: number;
	let userManagedOnlyId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({ name: "Connection Attention Org" });
		const orgId = workspace.org.id;

		await createTestConnectorDefinition({
			key: "collector",
			name: "Collector",
			organization_id: orgId,
			feeds_schema: {
				main: { key: "main", operations: ["sync"] },
				second: { key: "second", operations: ["sync"] },
			},
		});

		const make = async (displayName: string) =>
			Number(
				(
					await createTestConnection({
						organization_id: orgId,
						connector_key: "collector",
						display_name: displayName,
						created_by: workspace.users.owner.id,
						// Every shape below seeds the feeds it needs explicitly; the
						// fixture's scheduleless 'default' feed would otherwise add an
						// untriggerable collector to all four.
						createDefaultFeed: false,
					})
				).id,
			);

		// Created and abandoned before any feed existed.
		noFeedsId = await make("Abandoned mid-setup");

		// Every collector feed paused — running nothing until someone resumes it.
		pausedId = await make("All feeds paused");
		await seedFeed({
			orgId,
			connectionId: pausedId,
			feedKey: "main",
			status: "paused",
			itemsCollected: 5_000,
		});

		// Collecting on a cron, with a recent success.
		healthyId = await make("Collecting");
		await seedFeed({
			orgId,
			connectionId: healthyId,
			feedKey: "main",
			schedule: "*/5 * * * *",
			lastSyncStatus: "success",
			lastSyncAt: new Date(),
			nextRunAt: new Date(Date.now() + 60_000),
			itemsCollected: 281,
		});

		// Dispatchable, but not one feed has ever completed a sync.
		neverCollectedId = await make("Never started");
		await seedFeed({
			orgId,
			connectionId: neverCollectedId,
			feedKey: "main",
			schedule: "*/5 * * * *",
			nextRunAt: new Date(Date.now() + 60_000),
		});

		// A connector whose only declared sync feed needs per-instance config the
		// create flow cannot supply. Zero feeds is the CORRECT resting state here,
		// so neither read path may call it no_feeds — and the flag that says so is
		// computed from the definition join, not from the connection row.
		await createTestConnectorDefinition({
			key: "user-managed-only",
			name: "User Managed Only",
			organization_id: orgId,
			feeds_schema: {
				main: { key: "main", operations: ["sync"], userManaged: true },
			},
		});
		userManagedOnlyId = Number(
			(
				await createTestConnection({
					organization_id: orgId,
					connector_key: "user-managed-only",
					display_name: "Nothing to auto-provision",
					created_by: workspace.users.owner.id,
					createDefaultFeed: false,
				})
			).id,
		);
	});

	it("reports each connection's observed state, not just its status", async () => {
		const result = (await workspace.owner.connections.list({
			limit: 50,
		})) as ListResult;
		const attention = new Map(
			(result.connections ?? []).map((row) => [Number(row.id), row.attention]),
		);

		// All four are status='active'. Before this derivation existed they were
		// indistinguishable from each other on every read path.
		expect(attention.get(noFeedsId)).toBe("no_feeds");
		expect(attention.get(pausedId)).toBe("paused");
		expect(attention.get(healthyId)).toBe("healthy");
		expect(attention.get(neverCollectedId)).toBe("never_collected");
	});

	it("does not flag a connector that declares no auto-provisionable feed", () => {
		// Regression: has_auto_syncable_feeds is the fail-closed guard that keeps
		// this row out of no_feeds, and it is computed per read path. list once
		// computed it in the definition lateral but never projected it, so the
		// derivation read undefined, failed closed, and reported no_feeds here
		// while get reported healthy for the same row. Asserting BOTH paths is
		// what makes a projection gap visible; the shapes above all sit on a
		// connector that DOES declare one, where the flag never matters.
		return Promise.all([
			workspace.owner.connections
				.list({ limit: 50 })
				.then((result) =>
					expect(
						((result as ListResult).connections ?? []).find(
							(row) => Number(row.id) === userManagedOnlyId,
						)?.attention,
					).toBe("healthy"),
				),
			workspace.owner.connections
				.get(userManagedOnlyId)
				.then((result) =>
					expect((result as GetResult).connection?.attention).toBe("healthy"),
				),
		]);
	});

	it("does not leak the derivation input onto the response", async () => {
		const result = (await workspace.owner.connections.list({
			limit: 50,
		})) as ListResult;
		for (const row of result.connections ?? []) {
			expect(row).not.toHaveProperty("feed_health");
			expect(row).not.toHaveProperty("has_auto_syncable_feeds");
		}
	});

	it("get agrees with list for the same connection", async () => {
		for (const [id, expected] of [
			[noFeedsId, "no_feeds"],
			[pausedId, "paused"],
			[healthyId, "healthy"],
			[neverCollectedId, "never_collected"],
			[userManagedOnlyId, "healthy"],
		] as const) {
			const result = (await workspace.owner.connections.get(id)) as GetResult;
			expect(result.connection?.attention).toBe(expected);
			expect(result.connection).not.toHaveProperty("feed_health");
		}
	});

	it("treats a non-boolean userManaged as user-managed rather than raising", async () => {
		// feeds_schema comes from a connector definition a tenant can author, so
		// the declared value is not guaranteed to be a JSON boolean. A ::boolean
		// cast of "yes" raises and would take down this read path AND the global
		// health scan that shares the fragment. Anything that is not explicitly
		// JSON false counts as user-managed, which is the fail-safe direction:
		// the connection is merely ineligible for no_feeds rather than being
		// handed a problem it does not have.
		const orgId = workspace.org.id;
		await createTestConnectorDefinition({
			key: "odd-user-managed",
			name: "Odd User Managed",
			organization_id: orgId,
			feeds_schema: {
				main: { key: "main", operations: ["sync"], userManaged: "yes" },
				other: { key: "other", operations: ["sync"], userManaged: { on: 1 } },
			},
		});
		const odd = Number(
			(
				await createTestConnection({
					organization_id: orgId,
					connector_key: "odd-user-managed",
					display_name: "Malformed userManaged",
					created_by: workspace.users.owner.id,
					createDefaultFeed: false,
				})
			).id,
		);

		const result = (await workspace.owner.connections.get(odd)) as GetResult;
		expect(result.connection?.attention).toBe("healthy");
	});

	it("a partially working connection reports degraded, not its worst feed", async () => {
		const orgId = workspace.org.id;
		const mixed = Number(
			(
				await createTestConnection({
					organization_id: orgId,
					connector_key: "collector",
					display_name: "One good one bad",
					created_by: workspace.users.owner.id,
					createDefaultFeed: false,
				})
			).id,
		);
		await seedFeed({
			orgId,
			connectionId: mixed,
			feedKey: "main",
			schedule: "*/5 * * * *",
			lastSyncStatus: "success",
			lastSyncAt: new Date(),
			nextRunAt: new Date(Date.now() + 60_000),
			itemsCollected: 10,
		});
		await seedFeed({
			orgId,
			connectionId: mixed,
			feedKey: "second",
			status: "paused",
		});

		const result = (await workspace.owner.connections.get(mixed)) as GetResult;
		expect(result.connection?.attention).toBe("degraded");
	});
});
