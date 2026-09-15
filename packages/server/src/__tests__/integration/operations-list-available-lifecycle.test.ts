/**
 * `operations.listAvailable` — connector-capability discovery contract.
 *
 * The list must be a PUBLIC DTO (no backend_config leaked), keep capabilities
 * discoverable even when no connection exists, and distinguish DECLARED
 * capabilities from EXECUTABLE targets using per-connection readiness —
 * including inactive and offline-device cases — WITHOUT leaking private
 * connection ids for non-usable connections. Each operation carries a
 * machine-readable next_action, and `query` searches across connector name/key,
 * operation name/key, description, and schema terms.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pgTextArray } from "../../db/client";
import {
	deviceManifestHash,
	type DeviceConnectorManifest,
} from "../../worker-api/device-manifests";
import { manageConnections } from "../../tools/admin/manage_connections";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
	ownerToolContext,
	seedOwnerContext,
} from "../setup/test-fixtures";

async function createOfflineDeviceWorker(
	userId: string,
	orgId: string,
): Promise<string> {
	const sql = getTestDb();
	const workerId = `ext-${Math.random().toString(36).slice(2, 10)}`;
	const lastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago → offline
	const [row] = (await sql`
		INSERT INTO device_workers (
			user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
		) VALUES (
			${userId}, ${workerId}, 'chrome-extension',
			${sql.json([])}, 'Test Ext', ${orgId}, ${lastSeen}
		)
		RETURNING id
	`) as unknown as Array<{ id: string }>;
	return String(row.id);
}

function ctxFor(organizationId: string, userId: string): ToolContext {
	const ctx = ownerToolContext(organizationId, userId);
	ctx.baseUrl = "https://gateway.test/lobu";
	return ctx;
}

async function setupOwner(orgName: string) {
	const seeded = await seedOwnerContext({ orgName });
	seeded.ctx.baseUrl = "https://gateway.test/lobu";
	return seeded;
}

const KEY_READY = "demo.ops.ready";
const KEY_DISCONNECTED = "demo.ops.disconnected";
const KEY_INACTIVE = "demo.ops.inactive";
const KEY_DEVICE = "demo.ops.device";
const KEY_DEVICE_SETUP = "chrome.test_readiness";
const KEY_COMPILED_LEGACY = "demo.ops.compiled";

const ACTIONS_SCHEMA = {
	create_issue: {
		name: "Create issue",
		description: "Create an issue in the tracker with a title and body.",
		kind: "write",
		input_schema: {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		},
	},
	list_issues: {
		name: "List issues",
		description: "List open issues.",
		kind: "read",
	},
};

async function seedConnector(
	organizationId: string,
	key: string,
	name: string,
): Promise<void> {
	await createTestConnectorDefinition({
		key,
		name,
		organization_id: organizationId,
		auth_schema: { methods: [{ type: "none" }] },
	});
	// actions_schema is a column on connector_definitions; update it directly so
	// the operation is a declared local_action capability.
	const sql = getTestDb();
	await sql`UPDATE connector_definitions SET actions_schema = ${sql.json(ACTIONS_SCHEMA)} WHERE key = ${key} AND organization_id = ${organizationId}`;
}

async function purge(organizationId: string): Promise<void> {
	const sql = getTestDb();
	const keys = [
		KEY_READY,
		KEY_DISCONNECTED,
		KEY_INACTIVE,
		KEY_DEVICE,
		KEY_DEVICE_SETUP,
		KEY_COMPILED_LEGACY,
	];
	await sql`DELETE FROM feeds WHERE connection_id IN (SELECT id FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId})`;
	await sql`DELETE FROM connections WHERE connector_key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
	await sql`DELETE FROM connector_definitions WHERE key = ANY(${pgTextArray(keys)}::text[]) AND organization_id = ${organizationId}`;
}

type AvailOp = Record<string, unknown> & {
	connector_key: string;
	operation_key: string;
	executable: boolean;
	readiness: string;
	connection_count: number;
	execution_targets: Array<{
		connection_id: number;
		status: string;
		executable: boolean;
		reason: string;
	}>;
	next_action: {
		action: string;
		sdk_method?: string;
		arguments?: unknown[];
		requires_input?: boolean;
		input_schema?: Record<string, unknown>;
		manual?: boolean;
		view_url?: string;
	};
};

async function listAll(
	orgId: string,
	userId: string,
	args: Record<string, unknown> = {},
): Promise<{ operations: AvailOp[]; total: number }> {
	const res = (await manageOperations(
		{ action: "list_available", ...args } as never,
		TEST_ENV(),
		ctxFor(orgId, userId),
	)) as { operations: AvailOp[]; total: number };
	return res;
}

function getOperation(operations: AvailOp[], operationKey: string): AvailOp {
	const operation = operations.find(
		(candidate) => candidate.operation_key === operationKey,
	);
	if (!operation) throw new Error(`Missing operation ${operationKey}`);
	return operation;
}

function TEST_ENV() {
	return {} as never;
}

describe("operations.listAvailable — capability discovery DTO", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	afterEach(async () => {
		const sql = getTestDb();
		const orgs = await sql`SELECT id FROM "organization"`;
		for (const org of orgs) await purge(org.id as string);
	});

	it("returns a PUBLIC DTO: no operation leaks backend_config", async () => {
		const { org, user } = await setupOwner("Ops DTO Org");
		await seedConnector(org.id, KEY_READY, "Ready Connector");
		await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "active",
		});

		const { operations } = await listAll(org.id, user.id);

		expect(operations.length).toBeGreaterThan(0);
		for (const op of operations) {
			expect(op).not.toHaveProperty("backend_config");
		}
	});

	it("keeps disconnected capabilities discoverable with a connect next_action and no connection_id", async () => {
		const { org, user } = await setupOwner("Ops Disc Org");
		await seedConnector(org.id, KEY_DISCONNECTED, "Disconnected Connector");

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_DISCONNECTED,
		});

		expect(operations.length).toBe(2);
		const create = getOperation(operations, "create_issue");
		expect(create.executable).toBe(false);
		expect(create.readiness).toBe("disconnected");
		expect(create.connection_count).toBe(0);
		expect(create.execution_targets).toEqual([]);
		expect(create.next_action.sdk_method).toBe("connections.connect");
		expect(create.next_action.arguments).toEqual([
			{ connector_key: KEY_DISCONNECTED },
		]);
	});

	it("requires schema-valid input before advertising execute, while parameterless operations remain directly executable", async () => {
		const { org, user } = await setupOwner("Ops Ready Org");
		await seedConnector(org.id, KEY_READY, "Ready Connector");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "active",
		});

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_READY,
		});

		const create = getOperation(operations, "create_issue");
		expect(create.executable).toBe(true);
		expect(create.readiness).toBe("ready");
		expect(create.connection_count).toBe(1);
		expect(create.execution_targets).toMatchObject([
			{ connection_id: conn.id, status: "ready", executable: true },
		]);
		expect(create.next_action).toMatchObject({
			action: "provide_input",
			sdk_method: "operations.execute",
			requires_input: true,
			input_schema: create.input_schema,
			arguments: [{ connection_id: conn.id, operation_key: "create_issue" }],
		});
		expect(JSON.stringify(create.next_action)).not.toContain('"input":{}');

		const list = getOperation(operations, "list_issues");
		expect(list.next_action).toEqual({
			action: "execute",
			sdk_method: "operations.execute",
			arguments: [
				{
					connection_id: conn.id,
					operation_key: "list_issues",
					input: {},
				},
			],
		});
	});

	it("preserves pending_auth and returns an absolute manual setup continuation instead of a get no-op", async () => {
		const { org, user } = await setupOwner("Ops Inactive Org");
		await seedConnector(org.id, KEY_INACTIVE, "Inactive Connector");
		await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "pending_auth",
			createDefaultFeed: false,
		});

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_INACTIVE,
		});

		const create = getOperation(operations, "create_issue");
		expect(create.executable).toBe(false);
		expect(create.readiness).toBe("pending_auth");
		expect(create.connection_count).toBe(1);
		expect(create.execution_targets).toMatchObject([
			{ status: "pending_auth", executable: false },
		]);
		expect(create.next_action).toMatchObject({
			action: "open_setup",
			manual: true,
		});
		expect(create.next_action.sdk_method).toBeUndefined();
		expect(new URL(create.next_action.view_url!).origin).toBe(
			"https://gateway.test",
		);
	});

	it("resumes a paused connection through the returned SDK call and becomes ready", async () => {
		const { org, user } = await setupOwner("Ops Paused Org");
		await seedConnector(org.id, KEY_INACTIVE, "Paused Connector");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "paused",
			createDefaultFeed: false,
		});

		const before = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		const create = getOperation(before.operations, "create_issue");
		expect(create).toMatchObject({
			readiness: "paused",
			execution_targets: [
				{ connection_id: conn.id, status: "paused", executable: false },
			],
			next_action: {
				action: "resume_connection",
				sdk_method: "connections.update",
				arguments: [{ connection_id: conn.id, status: "active" }],
			},
		});

		const [updateInput] = create.next_action.arguments as Array<
			Record<string, unknown>
		>;
		await expect(
			manageConnections(
				{ action: "update", ...updateInput } as never,
				TEST_ENV(),
				ctxFor(org.id, user.id),
			),
		).resolves.toMatchObject({ action: "update" });

		const after = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		expect(getOperation(after.operations, "create_issue")).toMatchObject({
			readiness: "ready",
			executable: true,
		});
	});

	it("offers and invokes reauthenticate for an interactive auth profile", async () => {
		const { org, user } = await setupOwner("Ops Interactive Org");
		await seedConnector(org.id, KEY_INACTIVE, "Interactive Connector");
		const profile = await createAuthProfile({
			organizationId: org.id,
			connectorKey: KEY_INACTIVE,
			displayName: "Interactive repair",
			profileKind: "interactive",
			status: "pending_auth",
			createdBy: user.id,
		});
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "error",
			created_by: user.id,
			createDefaultFeed: false,
		});
		await getTestDb()`
			UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}
		`;

		const { operations } = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		const create = getOperation(operations, "create_issue");
		expect(create.next_action).toMatchObject({
			action: "reauthenticate",
			sdk_method: "connections.reauthenticate",
			arguments: [conn.id],
		});
		expect(new URL(create.next_action.view_url!).origin).toBe(
			"https://gateway.test",
		);

		const [connectionId] = create.next_action.arguments as [number];
		const repaired = await manageConnections(
			{ action: "reauthenticate", connection_id: connectionId },
			TEST_ENV(),
			ctxFor(org.id, user.id),
		);
		expect(repaired).toMatchObject({
			action: "reauthenticate",
			connection_id: conn.id,
			auth_run_id: expect.any(Number),
		});
	});

	it("offers and invokes reauthenticate for an OAuth account profile", async () => {
		const { org, user } = await setupOwner("Ops OAuth Org");
		await seedConnector(org.id, KEY_INACTIVE, "OAuth Connector");
		await getTestDb()`
			UPDATE connector_definitions
			SET auth_schema = ${getTestDb().json({
				methods: [
					{
						type: "oauth",
						provider: "demo",
						requiredScopes: ["read"],
						clientIdKey: "DEMO_CLIENT_ID",
						clientSecretKey: "DEMO_CLIENT_SECRET",
					},
				],
			})}
			WHERE organization_id = ${org.id} AND key = ${KEY_INACTIVE}
		`;
		const profile = await createAuthProfile({
			organizationId: org.id,
			connectorKey: KEY_INACTIVE,
			displayName: "OAuth repair",
			profileKind: "oauth_account",
			provider: "demo",
			status: "pending_auth",
			createdBy: user.id,
		});
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "error",
			created_by: user.id,
			visibility: "private",
			createDefaultFeed: false,
		});
		await getTestDb()`
			UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}
		`;

		const { operations } = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		const create = getOperation(operations, "create_issue");
		expect(create.next_action).toMatchObject({
			action: "reauthenticate",
			sdk_method: "connections.reauthenticate",
			arguments: [conn.id],
		});

		const repaired = await manageConnections(
			{ action: "reauthenticate", connection_id: conn.id },
			TEST_ENV(),
			ctxFor(org.id, user.id),
		);
		expect(repaired).toMatchObject({
			action: "reauthenticate",
			connection_id: conn.id,
			auth_profile_slug: profile.slug,
			connect_url: expect.stringMatching(
				/^https:\/\/gateway\.test\/lobu\/connect\/[A-Za-z0-9_-]+\/oauth\/start$/,
			),
			expires_at: expect.any(String),
		});
	});

	it.each([
		"error",
		"revoked",
	])("preserves %s and returns an absolute manual repair continuation", async (status) => {
		const { org, user } = await setupOwner(`Ops ${status} Org`);
		await seedConnector(org.id, KEY_INACTIVE, `${status} Connector`);
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status,
			createDefaultFeed: false,
		});

		const { operations } = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		const create = getOperation(operations, "create_issue");
		expect(create.readiness).toBe(status);
		expect(create.execution_targets).toContainEqual(
			expect.objectContaining({ status }),
		);
		expect(create.next_action).toMatchObject({
			action: "open_setup",
			manual: true,
		});
		expect(create.next_action.sdk_method).toBeUndefined();
		expect(new URL(create.next_action.view_url!).origin).toBe(
			"https://gateway.test",
		);
	});

	it("device-bound connection whose device is offline: device_offline readiness, not executable", async () => {
		const { org, user } = await setupOwner("Ops Device Org");
		await seedConnector(org.id, KEY_DEVICE, "Device Connector");
		const workerId = await createOfflineDeviceWorker(user.id, org.id);
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_DEVICE,
			status: "active",
		});
		// Pin the connection to the offline device (the authoritative column).
		await getTestDb()`UPDATE connections SET device_worker_id = ${workerId} WHERE id = ${conn.id}`;

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_DEVICE,
		});

		const create = getOperation(operations, "create_issue");
		expect(create.executable).toBe(false);
		expect(create.readiness).toBe("device_offline");
		expect(create.execution_targets).toMatchObject([
			{ connection_id: conn.id, status: "device_offline", executable: false },
		]);
		expect(create.next_action).toMatchObject({
			action: "bring_device_online",
			manual: true,
		});
		expect(create.next_action.sdk_method).toBeUndefined();
		expect(new URL(create.next_action.view_url!).origin).toBe(
			"https://gateway.test",
		);
		expect(JSON.stringify(create)).not.toContain(workerId);
	});

	it("uses the manifest snapshot to report setup_required for an online device", async () => {
		const { org, user } = await setupOwner("Ops Device Setup Org");
		await seedConnector(org.id, KEY_DEVICE_SETUP, "Device Setup Connector");
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET runtime = ${sql.json({ platforms: ["chrome-extension"] })},
			    required_capability = 'browser.debugger'
			WHERE organization_id = ${org.id} AND key = ${KEY_DEVICE_SETUP}
		`;
		const manifest = {
			key: KEY_DEVICE_SETUP,
			version: "1.0.0",
			name: "Device Setup Connector",
			required_capability: "browser.debugger",
			runtime: { platforms: ["chrome-extension"] },
			auth_schema: { methods: [{ type: "none" }] },
			feeds_schema: {},
			actions_schema: ACTIONS_SCHEMA,
		};
		const manifestHash = deviceManifestHash(manifest as DeviceConnectorManifest);
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, connector_manifests,
				label, organization_id, last_seen_at
			) VALUES (
				${user.id}, ${`ext-${Math.random().toString(36).slice(2, 10)}`},
				'chrome-extension', ${sql.json(["browser.scripting"])},
				${sql.json({
					[KEY_DEVICE_SETUP]: {
						manifest,
						manifest_hash: manifestHash,
						received_at: new Date().toISOString(),
					},
				})},
				'Test Ext', ${org.id}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_DEVICE_SETUP,
			status: "active",
			createDefaultFeed: false,
		});
		await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${conn.id}`;
		const [feed] = (await sql`
			INSERT INTO feeds (
				organization_id, connection_id, feed_key, display_name, status
			) VALUES (${org.id}, ${conn.id}, 'items', 'Items', 'paused')
			RETURNING id
		`) as unknown as Array<{ id: number }>;

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_DEVICE_SETUP,
		});
		const create = getOperation(operations, "create_issue");
		expect(create).toMatchObject({
			executable: false,
			readiness: "setup_required",
			execution_targets: [
				{ connection_id: conn.id, status: "setup_required", executable: false },
			],
			next_action: { action: "open_setup", manual: true },
		});
		expect(create.execution_targets[0]?.reason).toMatch(
			/browser\.debugger.*finish setup.*retry/i,
		);

		const listed = (await manageFeeds(
			{ action: "list_feeds", connection_id: conn.id },
			TEST_ENV(),
			ctxFor(org.id, user.id),
		)) as { feeds: Array<Record<string, unknown>> };
		expect(listed.feeds).toContainEqual(
			expect.objectContaining({
				id: feed.id,
				attention: "setup_required",
				attention_reason: expect.stringMatching(
					/browser\.debugger.*finish setup.*retry/i,
				),
			}),
		);
		expect(listed.feeds[0]).not.toHaveProperty("device_owner_user_id");
		expect(listed.feeds[0]).not.toHaveProperty("required_capability");

		await sql`
			UPDATE device_workers
			SET last_seen_at = NOW() - INTERVAL '10 minutes'
			WHERE id = ${device.id}::uuid
		`;
		await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, connector_manifests,
				label, organization_id, last_seen_at
			) VALUES (
				${user.id}, ${`ext-${Math.random().toString(36).slice(2, 10)}`},
				'chrome-extension', ${sql.json(["browser.debugger"])},
				${sql.json({
					[KEY_DEVICE_SETUP]: {
						manifest,
						manifest_hash: manifestHash,
						received_at: new Date().toISOString(),
					},
				})},
				'Other Ready Ext', ${org.id}, NOW()
			)
		`;
		const afterPinnedDeviceGoesOffline = await listAll(org.id, user.id, {
			connector_key: KEY_DEVICE_SETUP,
		});
		expect(getOperation(afterPinnedDeviceGoesOffline.operations, "create_issue")).toMatchObject({
			executable: false,
			readiness: "device_offline",
			execution_targets: [
				{ connection_id: conn.id, status: "device_offline", executable: false },
			],
		});
	});

	it("does not apply newer device inventory to a compiled legacy connector", async () => {
		const { org, user } = await setupOwner("Ops Compiled Legacy Org");
		await seedConnector(org.id, KEY_COMPILED_LEGACY, "Compiled Legacy Connector");
		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET runtime = ${sql.json({ platforms: ["chrome-extension"] })},
			    required_capability = 'browser.scripting'
			WHERE organization_id = ${org.id} AND key = ${KEY_COMPILED_LEGACY}
		`;
		const inventoryManifest = {
			key: KEY_COMPILED_LEGACY,
			version: "2.0.0",
			name: "Compiled Legacy Connector",
			required_capability: "browser.debugger",
			runtime: { platforms: ["chrome-extension"] },
			auth_schema: { methods: [{ type: "none" }] },
			feeds_schema: {},
			actions_schema: ACTIONS_SCHEMA,
		};
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, capabilities, connector_manifests,
				label, organization_id, last_seen_at
			) VALUES (
				${user.id}, ${`ext-${Math.random().toString(36).slice(2, 10)}`},
				'chrome-extension', ${sql.json(["browser.scripting"])},
				${sql.json({
					[KEY_COMPILED_LEGACY]: {
						manifest: inventoryManifest,
						manifest_hash: deviceManifestHash(
							inventoryManifest as DeviceConnectorManifest,
						),
						received_at: new Date().toISOString(),
					},
				})},
				'Compiled Test Ext', ${org.id}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_COMPILED_LEGACY,
			status: "active",
			createDefaultFeed: false,
		});
		await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${conn.id}`;
		await sql`
			INSERT INTO feeds (
				organization_id, connection_id, feed_key, display_name, status
			) VALUES (${org.id}, ${conn.id}, 'items', 'Items', 'paused')
		`;

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_COMPILED_LEGACY,
		});
		expect(getOperation(operations, "create_issue")).toMatchObject({
			executable: true,
			readiness: "ready",
			execution_targets: [
				{ connection_id: conn.id, status: "ready", executable: true },
			],
		});

		const listed = (await manageFeeds(
			{ action: "list_feeds", connection_id: conn.id },
			TEST_ENV(),
			ctxFor(org.id, user.id),
		)) as { feeds: Array<Record<string, unknown>> };
		expect(listed.feeds).toContainEqual(
			expect.objectContaining({ attention: "paused" }),
		);
		expect(listed.feeds[0]).not.toHaveProperty("attention_reason");
	});

	it("query search matches connector name + operation name across disconnected connectors", async () => {
		const { org, user } = await setupOwner("Ops Search Org");
		await seedConnector(org.id, KEY_DISCONNECTED, "AcmeTracker");

		const { operations } = await listAll(org.id, user.id, {
			query: "acme create issue",
		});

		const keys = operations.map((o) => o.operation_key);
		expect(keys).toContain("create_issue");
		// Match should be on the AcmeTracker connector, not unrelated ones.
		expect(operations.every((o) => o.connector_key === KEY_DISCONNECTED)).toBe(
			true,
		);
	});

	it("include_disconnected=false hides capabilities with no ready connection", async () => {
		const { org, user } = await setupOwner("Ops Hide Disc Org");
		await seedConnector(org.id, KEY_DISCONNECTED, "Hidden Disconnected");

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_DISCONNECTED,
			include_disconnected: false,
		});
		expect(operations).toHaveLength(0);
	});

	it("marks an operation disabled when every visible connection disables it", async () => {
		const { org, user } = await setupOwner("Ops Disabled Org");
		await seedConnector(org.id, KEY_READY, "Disabled Action Connector");
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "active",
		});
		const sql = getTestDb();
		await sql`UPDATE connections SET config = ${sql.json({ action_modes: { create_issue: "disabled", list_issues: "approval" }, preserved: true })} WHERE id = ${conn.id}`;

		const { operations } = await listAll(org.id, user.id, {
			connector_key: KEY_READY,
		});
		const create = getOperation(operations, "create_issue");
		const list = getOperation(operations, "list_issues");

		expect(create).toMatchObject({
			executable: false,
			readiness: "disabled",
			next_action: {
				action: "enable_operation",
				sdk_method: "connections.update",
				arguments: [
					{
						connection_id: conn.id,
						config: {
							action_modes: {
								create_issue: "approval",
								list_issues: "approval",
							},
						},
					},
				],
			},
		});
		expect(create.execution_targets).toMatchObject([
			{ connection_id: conn.id, status: "disabled", executable: false },
		]);
		expect(list).toMatchObject({ executable: true, readiness: "ready" });

		const scoped = await listAll(org.id, user.id, { connection_id: conn.id });
		expect(getOperation(scoped.operations, "create_issue")).toMatchObject({
			executable: false,
			readiness: "disabled",
			next_action: {
				action: "enable_operation",
				sdk_method: "connections.update",
			},
		});

		const [updateInput] = create.next_action.arguments as Array<
			Record<string, unknown>
		>;
		const updated = await manageConnections(
			{ action: "update", ...updateInput } as never,
			TEST_ENV(),
			ctxFor(org.id, user.id),
		);
		expect(updated).toMatchObject({ action: "update" });

		const [stored] =
			await sql`SELECT config FROM connections WHERE id = ${conn.id}`;
		expect(stored.config).toMatchObject({
			preserved: true,
			action_modes: {
				create_issue: "approval",
				list_issues: "approval",
			},
		});
		const afterEnable = await listAll(org.id, user.id, {
			connection_id: conn.id,
		});
		expect(getOperation(afterEnable.operations, "create_issue")).toMatchObject({
			executable: true,
			readiness: "ready",
		});
	});

	it("points remediation at a target whose status matches mixed-target readiness", async () => {
		const { org, user } = await setupOwner("Ops Mixed Targets Org");
		await Promise.all([
			seedConnector(org.id, KEY_DEVICE, "Mixed Offline Connector"),
			seedConnector(org.id, KEY_INACTIVE, "Mixed Inactive Connector"),
			seedConnector(org.id, KEY_READY, "All Disabled Connector"),
		]);
		const sql = getTestDb();
		const disabledConfig = { action_modes: { create_issue: "disabled" } };

		const disabledBeforeOffline = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_DEVICE,
			status: "active",
		});
		await sql`UPDATE connections SET config = ${sql.json(disabledConfig)} WHERE id = ${disabledBeforeOffline.id}`;
		const offline = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_DEVICE,
			status: "active",
		});
		const workerId = await createOfflineDeviceWorker(user.id, org.id);
		await sql`UPDATE connections SET device_worker_id = ${workerId} WHERE id = ${offline.id}`;

		const disabledBeforeInactive = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "active",
		});
		await sql`UPDATE connections SET config = ${sql.json(disabledConfig)} WHERE id = ${disabledBeforeInactive.id}`;
		const inactive = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_INACTIVE,
			status: "pending_auth",
			createDefaultFeed: false,
		});

		const disabled = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "active",
		});
		await sql`UPDATE connections SET config = ${sql.json(disabledConfig)} WHERE id = ${disabled.id}`;

		for (const expected of [
			{ connectorKey: KEY_DEVICE, readiness: "device_offline", id: offline.id },
			{
				connectorKey: KEY_INACTIVE,
				readiness: "pending_auth",
				id: inactive.id,
			},
			{ connectorKey: KEY_READY, readiness: "disabled", id: disabled.id },
		]) {
			const { operations } = await listAll(org.id, user.id, {
				connector_key: expected.connectorKey,
			});
			const create = getOperation(operations, "create_issue");
			expect(create.readiness).toBe(expected.readiness);
			expect(create.next_action.arguments).toEqual(
				expected.readiness === "disabled"
					? [
							{
								connection_id: expected.id,
								config: { action_modes: { create_issue: "approval" } },
							},
						]
					: undefined,
			);
			expect(create.execution_targets).toContainEqual(
				expect.objectContaining({
					connection_id: expected.id,
					status: expected.readiness,
				}),
			);
		}
	});

	it("cross-org fence: another org's connectors/connections are invisible", async () => {
		const { org: orgA, user: userA } = await setupOwner("Ops Fence A");
		const orgB = await createTestOrganization({ name: "Ops Fence B" });
		await seedConnector(orgA.id, KEY_READY, "Fence A Connector");
		await createTestConnection({
			organization_id: orgA.id,
			connector_key: KEY_READY,
			status: "active",
		});
		// org B has nothing.

		const { operations } = await listAll(orgB.id, userA.id);
		expect(operations.every((o) => o.connector_key !== KEY_READY)).toBe(true);
	});

	it("preserves every visible target and excludes another member's private connection", async () => {
		const { org, user: owner } = await setupOwner("Ops Private Targets Org");
		const other = await createTestUser();
		await addUserToOrganization(other.id, org.id, "member");
		await seedConnector(org.id, KEY_READY, "Private Targets Connector");
		const ownPrivate = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			created_by: owner.id,
			visibility: "private",
		});
		const orgVisible = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			created_by: other.id,
			visibility: "org",
		});
		const hiddenPrivate = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			created_by: other.id,
			visibility: "private",
		});

		const { operations } = await listAll(org.id, owner.id, {
			connector_key: KEY_READY,
		});
		const create = getOperation(operations, "create_issue");
		expect(
			create.execution_targets.map((target) => target.connection_id),
		).toEqual([ownPrivate.id, orgVisible.id]);
		expect(create.connection_count).toBe(2);
		expect(create.execution_targets).toHaveLength(2);

		// A hidden connection must fail LOUDLY with execute's exact error — a
		// silent `{operations: [], total: 0}` is indistinguishable from "this
		// connection declares no operations", so the caller debugs the filter
		// instead of its access. Same message as execute, so no extra existence
		// information leaks through the catalog.
		const hidden = await manageOperations(
			{ action: "list_available", connection_id: hiddenPrivate.id } as never,
			TEST_ENV(),
			ctxFor(org.id, owner.id),
		);
		expect(hidden).toEqual({
			error: "Connection not found or not visible.",
		});
		// The visibility check is independent of secondary filters: a hidden id
		// errors even when connector_key/entity_id are also supplied.
		const hiddenCompound = await manageOperations(
			{
				action: "list_available",
				connection_id: hiddenPrivate.id,
				connector_key: KEY_READY,
			} as never,
			TEST_ENV(),
			ctxFor(org.id, owner.id),
		);
		expect(hiddenCompound).toEqual({
			error: "Connection not found or not visible.",
		});

		const executed = await manageOperations(
			{
				action: "execute",
				connection_id: hiddenPrivate.id,
				operation_key: "create_issue",
				input: { title: "must stay private" },
			},
			TEST_ENV(),
			ctxFor(org.id, owner.id),
		);
		expect(executed).toEqual({
			error: "Connection not found or not visible.",
		});
		const runRows = await getTestDb()`
			SELECT id FROM runs WHERE connection_id = ${hiddenPrivate.id}
		`;
		expect(runRows).toHaveLength(0);
	});

	it("an unowned private connection is fail-closed: management list may show it, operations never do", async () => {
		const { org, user: owner } = await setupOwner("Ops Orphaned Org");
		const member = await createTestUser();
		await addUserToOrganization(member.id, org.id, "member");
		await seedConnector(org.id, KEY_READY, "Orphaned Connector");
		// A private connection with no creator — the pre-backfill legacy shape,
		// or a future row orphaned by a hard-deleted owner. There is no admin
		// arm anymore, so operations must treat it like any other row it cannot
		// prove the caller may touch.
		const unowned = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			visibility: "private",
		});

		// The admin management list (a deliberate broader surface for
		// owners/admins) may still surface the row…
		const ownerList = (await manageConnections(
			{ action: "list", connector_key: KEY_READY } as never,
			TEST_ENV(),
			ctxFor(org.id, owner.id),
		)) as { connections?: Array<{ id: number }> };
		expect((ownerList.connections ?? []).map((c) => Number(c.id))).toContain(
			unowned.id,
		);

		// …but operations must NOT expose it: no executable target, no
		// connection_count, and execute rejects exactly like an invisible row.
		const { operations } = await listAll(org.id, owner.id, {
			connector_key: KEY_READY,
		});
		const create = getOperation(operations, "create_issue");
		expect(create.readiness).toBe("disconnected");
		expect(create.connection_count).toBe(0);
		expect(create.execution_targets).toEqual([]);

		const ownerExec = (await manageOperations(
			{
				action: "execute",
				connection_id: unowned.id,
				operation_key: "create_issue",
				input: { title: "orphaned row must stay unusable" },
			},
			TEST_ENV(),
			ctxFor(org.id, owner.id),
		).catch((err) => ({ error: String(err) }))) as { error?: string };
		expect(ownerExec.error).toBe("Connection not found or not visible.");

		// Fail-closed: a plain member sees the row NOWHERE — list and
		// operations agree for them too.
		const memberList = (await manageConnections(
			{ action: "list", connector_key: KEY_READY } as never,
			TEST_ENV(),
			ctxFor(org.id, member.id),
		)) as { connections?: Array<{ id: number }> };
		expect(
			(memberList.connections ?? []).map((c) => Number(c.id)),
		).not.toContain(unowned.id);

		const memberAvail = await listAll(org.id, member.id, {
			connector_key: KEY_READY,
		});
		const memberCreate = getOperation(memberAvail.operations, "create_issue");
		expect(memberCreate.readiness).toBe("disconnected");
		expect(memberCreate.connection_count).toBe(0);

		const memberExec = await manageOperations(
			{
				action: "execute",
				connection_id: unowned.id,
				operation_key: "create_issue",
				input: { title: "must stay hidden" },
			},
			TEST_ENV(),
			ctxFor(org.id, member.id),
		);
		expect(memberExec).toEqual({
			error: "Connection not found or not visible.",
		});
	});

	it("connection_id filter returns exactly that connection's ops; a nonexistent id errors like execute", async () => {
		const { org, user } = await setupOwner("Ops ConnId Filter Org");
		await seedConnector(org.id, KEY_READY, "ConnId Filter Connector");
		const target = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "active",
		});
		const sibling = await createTestConnection({
			organization_id: org.id,
			connector_key: KEY_READY,
			status: "paused",
			createDefaultFeed: false,
		});

		const { operations, total } = await listAll(org.id, user.id, {
			connection_id: target.id,
		});
		expect(total).toBe(2);
		expect(operations.map((op) => op.operation_key).sort()).toEqual([
			"create_issue",
			"list_issues",
		]);
		// Only the requested connection appears as an execution target — the
		// sibling paused connection of the same connector is filtered out, and
		// readiness reflects the requested target alone.
		for (const op of operations) {
			expect(op.execution_targets).toMatchObject([
				{ connection_id: target.id, status: "ready", executable: true },
			]);
			expect(op.readiness).toBe("ready");
		}
		expect(sibling.status).toBe("paused");

		const missing = await manageOperations(
			{ action: "list_available", connection_id: 999_999_999 } as never,
			TEST_ENV(),
			ctxFor(org.id, user.id),
		);
		expect(missing).toEqual({
			error: "Connection not found or not visible.",
		});

		// A COMPOUND filter that excludes a visible connection is a normal empty
		// match, not an authorization failure — only a bare connection_id asserts
		// existence/visibility.
		const mismatch = await listAll(org.id, user.id, {
			connection_id: target.id,
			connector_key: KEY_DISCONNECTED,
		});
		expect(mismatch).toMatchObject({ operations: [], total: 0 });
	});

	it("rejects unknown arguments with the shared validator error, like sibling methods", async () => {
		const { org, user } = await setupOwner("Ops Unknown Arg Org");
		await expect(
			manageOperations(
				{ action: "list_available", connectionid: 1 } as never,
				TEST_ENV(),
				ctxFor(org.id, user.id),
			),
		).rejects.toThrow(
			/unknown argument\(s\): connectionid — valid arguments.*connection_id/,
		);
	});
});

it("fails closed when a declared write action omits requiresApproval", async () => {
	const { org, user } = await setupOwner("Ops Missing Approval Metadata Org");
	await seedConnector(org.id, KEY_READY, "Missing Approval Metadata Connector");
	await createTestConnection({
		organization_id: org.id,
		connector_key: KEY_READY,
		status: "active",
	});
	const { operations } = await listAll(org.id, user.id, {
		connector_key: KEY_READY,
	});
	expect(getOperation(operations, "create_issue").requires_approval).toBe(true);
});
