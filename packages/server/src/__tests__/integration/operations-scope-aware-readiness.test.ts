/** Active connections still need per-action OAuth scope readiness. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { buildConnectionsNamespace } from "../../sandbox/namespaces/connections";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";

const CONNECTOR_KEY = "demo.scope.calendar";
const READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const ACTIONS_SCHEMA = {
	create_event: {
		key: "create_event",
		name: "Create Event",
		kind: "write",
		requiresApproval: true,
		requiredScopes: [WRITE_SCOPE],
	},
	update_event: {
		key: "update_event",
		name: "Update Event",
		kind: "write",
		requiresApproval: true,
		requiredScopes: [WRITE_SCOPE],
	},
	delete_event: {
		key: "delete_event",
		name: "Delete Event",
		kind: "write",
		requiresApproval: true,
		requiredScopes: [WRITE_SCOPE],
	},
	get_event: {
		key: "get_event",
		name: "Get Event",
		kind: "read",
		requiresApproval: false,
	},
};

describe("operation readiness respects OAuth scopes", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let readonlyConnId: number;
	let writableConnId: number;

	async function seedScopedConnection(grantedScopes?: string[]): Promise<{
		connectionId: number;
		profileSlug: string;
	}> {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR_KEY,
			created_by: userId,
			visibility: "private",
		});
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: CONNECTOR_KEY,
			displayName: `${CONNECTOR_KEY} OAuth ${conn.id}`,
			profileKind: "oauth_account",
			provider: "test",
			status: "active",
			createdBy: userId,
			authData:
				grantedScopes === undefined
					? {}
					: {
							requested_scopes: [READONLY_SCOPE],
							granted_scopes: grantedScopes,
						},
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}`;
		return { connectionId: conn.id, profileSlug: profile.slug };
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({
			orgName: "Scope Readiness Org",
		});
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		const sql = getTestDb();
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Scope Calendar",
			organization_id: orgId,
			auth_schema: {
				methods: [
					{
						type: "oauth",
						provider: "test",
						requiredScopes: [READONLY_SCOPE],
						optionalScopes: [WRITE_SCOPE],
					},
				],
			},
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json(ACTIONS_SCHEMA)},
			    supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`class R { async sync(){return {items:[]};} async execute(ctx){return {success:true,output:{operation_key:ctx.actionKey}};} } module.exports = { default: R, R };`}
			WHERE connector_key = ${CONNECTOR_KEY}
		`;

		readonlyConnId = (
			await seedScopedConnection([READONLY_SCOPE])
		).connectionId;
		writableConnId = (
			await seedScopedConnection([READONLY_SCOPE, WRITE_SCOPE])
		).connectionId;
	});

	async function listOp(
		operationKey: string,
		connectionId: number,
	): Promise<{
		readiness: string;
		executable: boolean;
		next_action?: Record<string, unknown>;
		execution_targets: Array<{
			connection_id: number;
			status: string;
			executable: boolean;
			reason: string;
		}>;
	}> {
		const listed = (await manageOperations(
			{ action: "list_available", connection_id: connectionId },
			{} as Env,
			ctx,
		)) as {
			operations: Array<{
				operation_key: string;
				readiness: string;
				executable: boolean;
				next_action?: Record<string, unknown>;
				execution_targets: Array<{
					connection_id: number;
					status: string;
					executable: boolean;
					reason: string;
				}>;
			}>;
		};
		const op = listed.operations.find((o) => o.operation_key === operationKey);
		if (!op)
			throw new Error(`${operationKey} not listed for conn ${connectionId}`);
		return op;
	}

	it("marks a write action not-executable when its required scope is missing", async () => {
		const op = await listOp("create_event", readonlyConnId);
		expect(op.executable).toBe(false);
		expect(op.readiness).toBe("scope_upgrade_required");
		const target = op.execution_targets.find(
			(t) => t.connection_id === readonlyConnId,
		);
		expect(target?.executable).toBe(false);
		expect(target?.status).toBe("scope_upgrade_required");
		expect(target?.reason).toContain(WRITE_SCOPE);
	});

	it("surfaces a reauthorize next_action naming exactly the missing scope", async () => {
		const op = await listOp("create_event", readonlyConnId);
		expect(op.next_action?.action).toBe("reauthorize");
		expect(op.next_action?.connection_id).toBe(readonlyConnId);
		expect(op.next_action?.requested_scopes).toEqual([WRITE_SCOPE]);
	});

	it("provides an invokable next_action without changing the current grant", async () => {
		const seeded = await seedScopedConnection([READONLY_SCOPE]);
		const op = await listOp("create_event", seeded.connectionId);
		expect(op.next_action).toMatchObject({
			sdk_method: "connections.reauthenticate",
			arguments: [seeded.connectionId, { requested_scopes: [READONLY_SCOPE, WRITE_SCOPE] }],
		});
		expect(op.next_action?.view_url).toContain(`/${seeded.connectionId}?settings=true#connection-auth`);
		const client = buildConnectionsNamespace({ ...ctx, scopes: ["mcp:read", "mcp:write"] }, {} as Env);
		const result = await client.reauthenticate(seeded.connectionId, { requested_scopes: [WRITE_SCOPE] });
		expect(result).toMatchObject({ action: "reauthenticate", connect_url: expect.any(String) });
		const [stored] = await getTestDb()`SELECT auth_data FROM auth_profiles
			WHERE organization_id = ${orgId} AND slug = ${seeded.profileSlug}`;
		expect(stored?.auth_data).toMatchObject({ requested_scopes: [READONLY_SCOPE], granted_scopes: [READONLY_SCOPE] });
		const [pending] = await getTestDb()`SELECT auth_config FROM connect_tokens
			WHERE connection_id = ${seeded.connectionId} ORDER BY id DESC LIMIT 1`;
		expect(pending.auth_config.requestedScopes).toEqual([READONLY_SCOPE, WRITE_SCOPE]);
	});

	it("rejects direct execution with retry-after-consent guidance before creating a run", async () => {
		const before = await getTestDb()`
			SELECT COUNT(*)::integer AS count
			FROM runs
			WHERE organization_id = ${orgId}
			  AND connection_id = ${readonlyConnId}
			  AND run_type = 'action'
		`;
		const result = await manageOperations(
			{
				action: "execute",
				connection_id: readonlyConnId,
				operation_key: "create_event",
				input: {},
			},
			{} as Env,
			ctx,
		);
		expect(result).toEqual({
			error: expect.stringContaining(WRITE_SCOPE),
		});
		expect(result).toMatchObject({
			error: expect.stringMatching(/complete.*consent.*then retry.*operations\.execute/i),
		});
		expect(result).toMatchObject({
			error: expect.stringMatching(/will not resume automatically/i),
		});
		const after = await getTestDb()`
			SELECT COUNT(*)::integer AS count
			FROM runs
			WHERE organization_id = ${orgId}
			  AND connection_id = ${readonlyConnId}
			  AND run_type = 'action'
		`;
		expect(after[0]?.count).toBe(before[0]?.count);
	});

	it("keeps read actions on the same connection executable", async () => {
		const op = await listOp("get_event", readonlyConnId);
		expect(op.executable).toBe(true);
		expect(op.readiness).toBe("ready");
	});

	it("marks the write action executable when the write scope IS granted", async () => {
		const op = await listOp("create_event", writableConnId);
		expect(op.executable).toBe(true);
		expect(op.readiness).toBe("ready");
	});

	it("keeps Calendar mutations approval-gated while get_event executes as a read", async () => {
		for (const operationKey of [
			"create_event",
			"update_event",
			"delete_event",
		]) {
			const result = await manageOperations(
				{
					action: "execute",
					connection_id: writableConnId,
					operation_key: operationKey,
					input: {},
				},
				{} as Env,
				ctx,
			);
			expect(result).toMatchObject({
				action: "execute",
				status: "pending_approval",
			});
		}

		const read = await manageOperations(
			{
				action: "execute",
				connection_id: writableConnId,
				operation_key: "get_event",
				input: {},
			},
			{} as Env,
			ctx,
		);
		expect(read).toMatchObject({
			action: "execute",
			status: "completed",
			output: { operation_key: "get_event" },
		});
	});

	it("does not gate a legacy connection whose grant scopes were not recorded", async () => {
		const legacy = await seedScopedConnection();
		const op = await listOp("create_event", legacy.connectionId);
		expect(op.readiness).toBe("ready");
		expect(op.executable).toBe(true);
	});

	it("gates a known empty grant instead of treating it as legacy data", async () => {
		const knownEmpty = await seedScopedConnection([]);
		const op = await listOp("create_event", knownEmpty.connectionId);
		expect(op.readiness).toBe("scope_upgrade_required");
		expect(op.executable).toBe(false);
	});
});
