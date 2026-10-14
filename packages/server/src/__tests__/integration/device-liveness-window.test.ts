/**
 * A device that stopped polling must be reported offline within the liveness
 * window, and the report must say how stale it is.
 *
 * Measured on prod 2026-08-05: a chrome extension whose poll loop died was
 * reported `readiness: "ready", executable: true` for the full 18 minutes it
 * was dead, because `device_online` was `last_seen_at > now() - 20 minutes`.
 * Every dispatch in that window sat for the 60s queue budget and then failed
 * with "the device may be offline" — a guess the server had the data to
 * answer. The window is now 120s and the staleness is stated, not implied.
 *
 * The fixtures below sit at 5 minutes stale: OFFLINE under the current window,
 * ONLINE under the old one. That gap is the regression this file pins.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import { describeRunDevice } from "../../tools/admin/device-action-wait";
import type { ToolContext } from "../../tools/registry";
import { DEVICE_ONLINE_WINDOW_SECONDS } from "../../utils/device-liveness";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "apple.computer_use";
/** Dead long enough for the current window, alive under the old 20-minute one. */
const STALE_SECONDS = 5 * 60;

describe("device liveness window", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Device Liveness Org",
		});
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Apple Computer Use",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "none" }] },
		});
	});

	async function seedDevice(
		staleSeconds: number,
		label: string,
	): Promise<{ connectionId: number; deviceId: string }> {
		const sql = getTestDb();
		const lastSeen = new Date(Date.now() - staleSeconds * 1000).toISOString();
		const [dw] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
			) VALUES (
				${userId}, ${`wk_${staleSeconds}_${Date.now()}`}, 'macos',
				${sql.json([])}, ${label}, ${orgId}, ${lastSeen}
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
			createDefaultFeed: false,
		});
		await sql`UPDATE connections SET device_worker_id = ${dw.id} WHERE id = ${conn.id}`;
		return { connectionId: conn.id, deviceId: dw.id };
	}

	async function listConnection(connectionId: number) {
		const result = (await manageConnections(
			{ action: "list" },
			{} as Env,
			ctx,
		)) as { connections: Array<Record<string, unknown>> };
		return result.connections.find((c) => c.id === connectionId);
	}

	it("reports a device that stopped polling 5 minutes ago as offline", async () => {
		// Under the old 20-minute window this row came back device_online: true
		// and nothing downstream could tell the device was gone.
		const { connectionId } = await seedDevice(STALE_SECONDS, "Stale Mac");
		const row = await listConnection(connectionId);
		expect(row).toBeDefined();
		expect(row?.device_online).toBe(false);
		expect(row?.device_status).toBe("offline");
	});

	it("still reports a device polling within the window as online", async () => {
		const { connectionId } = await seedDevice(10, "Live Mac");
		const row = await listConnection(connectionId);
		expect(row?.device_online).toBe(true);
		expect(row?.device_status ?? null).toBeNull();
	});

	it("holds the boundary: just inside online, just outside offline", async () => {
		const inside = await seedDevice(DEVICE_ONLINE_WINDOW_SECONDS - 30, "Inside");
		const outside = await seedDevice(DEVICE_ONLINE_WINDOW_SECONDS + 30, "Outside");
		expect((await listConnection(inside.connectionId))?.device_online).toBe(true);
		expect((await listConnection(outside.connectionId))?.device_online).toBe(false);
	});

	it("connections.test explains the staleness rather than just 'offline'", async () => {
		const { connectionId } = await seedDevice(STALE_SECONDS, "Stale Mac 2");
		const result = (await manageConnections(
			{ action: "test", connection_id: connectionId },
			{} as Env,
			ctx,
		)) as Record<string, unknown>;
		expect(result.device_online).toBe(false);
		expect(result.status).toBe("warning");
		expect(String(result.message)).toContain("last polled 5m ago");
	});

	it("names the silent device in the dispatch timeout diagnostic", async () => {
		const sql = getTestDb();
		const { connectionId } = await seedDevice(18 * 60, "Burak's MacBook Chrome");
		const [run] = (await sql`
			INSERT INTO runs (organization_id, connection_id, run_type, status, connector_key)
			VALUES (${orgId}, ${connectionId}, 'action', 'pending', ${CONNECTOR_KEY})
			RETURNING id
		`) as unknown as Array<{ id: number }>;

		const described = (await describeRunDevice(Number(run.id), orgId)).text;
		// The exact sentence an operator reads when a dispatch times out. It has
		// to name the device and the age — "may be offline" is what sent a whole
		// session chasing a server-side fault that did not exist.
		expect(described).toBe(
			`device "Burak's MacBook Chrome" last polled 18m ago`,
		);
	});

	it("degrades to a safe string when the run has no paired device", async () => {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
			createDefaultFeed: false,
		});
		const [run] = (await sql`
			INSERT INTO runs (organization_id, connection_id, run_type, status, connector_key)
			VALUES (${orgId}, ${conn.id}, 'action', 'pending', ${CONNECTOR_KEY})
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		expect((await describeRunDevice(Number(run.id), orgId)).text).toBe(
			"run has no paired device",
		);
	});
});
