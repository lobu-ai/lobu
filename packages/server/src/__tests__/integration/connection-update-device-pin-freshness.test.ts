/**
 * connections.update must not accept a device pin the fleet cannot serve.
 *
 * #3212: `connections.update({ device_worker_id })` accepted a pin to a device
 * that had gone OFFLINE (last_seen_at far outside the freshness window),
 * returned success, and echoed the offline device back as applied.
 *
 * `resolveDeviceBinding` validates existence, ownership, workspace attachment
 * and the advertised capability — but never freshness. Every consumer of the
 * pin (run claiming, feed dispatch, device-connector readiness) treats a device
 * outside `DEVICE_WORKER_FRESH_INTERVAL` as absent, so the write is accepted
 * into a state nothing can execute. The caller's only signal is a run that
 * never gets claimed.
 *
 * The freshness window belongs to the write path for the same reason the
 * capability check does: both are "can this device actually serve this
 * connector", and both are knowable at write time. Rejecting names the reason;
 * accepting silently does not.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageConnections } from "../../tools/admin/manage_connections";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "os.shell";
const REQUIRED_CAPABILITY = "os.shell";
const sql = getTestDb();

describe("connections.update device pin freshness", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Pin Freshness Org",
		});
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;
		await createTestConnectorDefinition({
			organization_id: orgId,
			key: CONNECTOR_KEY,
			name: "OS Shell",
		});
		// The fixture has no `required_capability` argument; this connector is a
		// device connector, which is exactly the class the issue reports.
		await sql`
      UPDATE connector_definitions
      SET required_capability = ${REQUIRED_CAPABILITY}
      WHERE key = ${CONNECTOR_KEY} AND organization_id = ${orgId}
    `;
	});

	/** `staleFor` is a postgres interval expression, e.g. `'20 minutes'`. */
	async function seedDevice(
		label: string,
		staleFor: string | null,
		capabilities: string[] = [REQUIRED_CAPABILITY],
	): Promise<string> {
		const workerId = `dev-${Math.random().toString(36).slice(2, 10)}`;
		const [row] = (await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label,
        organization_id, last_seen_at
      ) VALUES (
        ${userId}, ${workerId}, 'macos', ${sql.json(capabilities)},
        ${label}, ${orgId},
        ${staleFor === null ? sql`NOW()` : sql`NOW() - ${staleFor}::interval`}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
		return String(row.id);
	}

	async function seedConnectionOnDevice(deviceId: string | null): Promise<number> {
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
		});
		if (deviceId) {
			await sql`
        UPDATE connections SET device_worker_id = ${deviceId}::uuid WHERE id = ${conn.id}
      `;
		}
		return conn.id;
	}

	async function update(
		connectionId: number,
		deviceWorkerId: string | null,
	): Promise<Record<string, unknown>> {
		return (await manageConnections(
			{
				action: "update",
				connection_id: connectionId,
				device_worker_id: deviceWorkerId,
			},
			{} as Env,
			ctx,
		)) as Record<string, unknown>;
	}

	async function pinOf(id: number): Promise<string | null> {
		const [row] = (await sql`
      SELECT device_worker_id FROM connections WHERE id = ${id}
    `) as unknown as Array<{ device_worker_id: string | null }>;
		return row?.device_worker_id ?? null;
	}

	it("rejects a pin to a device outside the freshness window", async () => {
		// The reported shape: the device advertises the capability and is owned by
		// the caller in this workspace, but its last heartbeat is well past the
		// 7-day window every execution path uses to decide the fleet can serve it.
		const offline = await seedDevice("Offline Mac mini", "30 days");
		const conn = await seedConnectionOnDevice(null);

		const result = await update(conn, offline);

		// The rejection must name freshness, not just fail — the caller has to be
		// able to tell this from "no such device" or "capability not granted".
		expect(result.error).toBeDefined();
		expect(String(result.error)).toMatch(/offline|not been seen|last seen|fresh/i);

		// And nothing may persist: the bug was the echo-then-revert, so a rejected
		// write must leave the pin exactly as it was.
		expect(await pinOf(conn)).toBeNull();
	});

	it("does not echo the offline device back as applied", async () => {
		// The specific complaint: the response's `connection.device_worker_id` was
		// the offline device, and an immediate read-back agreed, for seconds.
		const offline = await seedDevice("Offline Laptop", "20 days");
		const conn = await seedConnectionOnDevice(null);

		const result = await update(conn, offline);
		const connection = result.connection as
			| { device_worker_id?: string | null }
			| undefined;

		expect(result.error).toBeDefined();
		expect(connection?.device_worker_id ?? null).not.toBe(offline);
	});

	it("lets the more specific rejection win over freshness", async () => {
		// Freshness is the LAST gate. A device that is both stale and missing the
		// capability must be reported for the capability, so the caller fixes the
		// permanent problem rather than waiting for a heartbeat that won't help.
		const staleAndUnable = await seedDevice("Stale No-Shell", "30 days", []);
		const conn = await seedConnectionOnDevice(null);

		const result = await update(conn, staleAndUnable);

		expect(result.error).toBeDefined();
		expect(String(result.error)).toMatch(/permission/i);
		expect(String(result.error)).not.toMatch(/offline/i);
		expect(await pinOf(conn)).toBeNull();
	});

	it("does not reject an update that round-trips the existing pin", async () => {
		// A pin is placement, and only a placement CHANGE is gated. A connection
		// pinned while its device was fresh must still accept an unrelated edit
		// that re-sends the same `device_worker_id` (read-modify-write) after the
		// device has gone quiet — otherwise the rename fails for a device that
		// reconcile repairs on its own.
		const device = await seedDevice("Was Fresh At Pin Time", null);
		const conn = await seedConnectionOnDevice(device);
		await sql`
      UPDATE device_workers SET last_seen_at = NOW() - '8 days'::interval
      WHERE id = ${device}::uuid
    `;

		const result = (await manageConnections(
			{
				action: "update",
				connection_id: conn,
				display_name: "Renamed While Device Idle",
				device_worker_id: device,
			},
			{} as Env,
			ctx,
		)) as Record<string, unknown>;

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBe(device);

		// Moving the SAME connection to a different stale device is a placement
		// change and is still rejected.
		const other = await seedDevice("Other Offline", "30 days");
		const moved = await update(conn, other);
		expect(moved.error).toBeDefined();
		expect(String(moved.error)).toMatch(/offline/i);
		expect(await pinOf(conn)).toBe(device);
	});

	it("round-trips the existing pin regardless of uuid letter case", async () => {
		// Postgres normalizes uuids to lowercase and compares them case-insensitively,
		// so an uppercased id still selects the same device row and clears every
		// other gate. Comparing the caller's raw string against the stored pin
		// would disagree with the database about identity and reject a round-trip
		// that changed no placement at all.
		const device = await seedDevice("Idle Mac", null);
		const conn = await seedConnectionOnDevice(device);
		await sql`
      UPDATE device_workers SET last_seen_at = NOW() - '8 days'::interval
      WHERE id = ${device}::uuid
    `;

		const result = (await manageConnections(
			{
				action: "update",
				connection_id: conn,
				display_name: "Renamed With Upper Case Pin",
				device_worker_id: device.toUpperCase(),
			},
			{} as Env,
			ctx,
		)) as Record<string, unknown>;

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBe(device);
	});

	it("still accepts a pin to a fresh capable device", async () => {
		// The guard must not narrow the supported case: a device seen recently and
		// advertising the capability is still pinnable.
		const fresh = await seedDevice("Fresh Mac mini", null);
		const conn = await seedConnectionOnDevice(null);

		const result = await update(conn, fresh);

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBe(fresh);
	});

	it("rejects the same pin on create, not just update", async () => {
		// `resolveDeviceBinding` is shared by create/connect/update, so the gate
		// applies to all three. Worth pinning down separately: create and connect
		// divert a binding error into a `connect_device` setup continuation when
		// the caller supplied NO device, and a freshness rejection must not be
		// mislabelled as "you forgot to connect a device" — the caller named a
		// device, it is just too stale to serve.
		const offline = await seedDevice("Offline On Create", "30 days");

		const result = (await manageConnections(
			{
				action: "create",
				connector_key: CONNECTOR_KEY,
				display_name: "Pin Freshness Create",
				device_worker_id: offline,
			},
			{} as Env,
			ctx,
		)) as Record<string, unknown>;

		expect(result.error).toBeDefined();
		expect(String(result.error)).toMatch(/offline|not been seen|last seen|fresh/i);
		// A plain error, not a setup continuation prompting a device connect.
		expect(result.setup).toBeUndefined();
	});

	it("still accepts a device seen recently but inside the window", async () => {
		// A laptop closed for an hour is not offline by this definition — the
		// window is 7 days. Rejecting these would break the documented contract
		// that a temporarily asleep device keeps its placement.
		const napping = await seedDevice("Napping Laptop", "2 days");
		const conn = await seedConnectionOnDevice(null);

		const result = await update(conn, napping);

		expect(result.error).toBeUndefined();
		expect(await pinOf(conn)).toBe(napping);
	});
});
