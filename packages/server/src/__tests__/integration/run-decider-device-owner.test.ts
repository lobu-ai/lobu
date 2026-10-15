/**
 * A run that executes on a device is decided by that device's owner and nobody
 * else. A run is device-targeted when `runs.target_device_worker_id` is set or
 * its connection is pinned to a device (`connections.device_worker_id`) — the
 * connection's visibility and creator do not matter, so a device pinned into a
 * team workspace is still decided by the member who owns the machine, and a
 * workspace admin who does not own it is refused. Every decision entry (single
 * approve/reject, batch approve, the chat card) and the approval notification
 * read the same `run-decider` helpers. Runs that touch no device keep the
 * admin-or-decider rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveEntityApprovalRun } from "../../gateway/connections/interaction-bridge";
import type { Env } from "../../index";
import { notifyActionApprovalNeeded } from "../../notifications/triggers";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestAutomationSubscription } from "../setup/automation-subscriptions";
import {
	addUserToOrganization,
	createTestAgent,
	createTestConnection,
	createTestConnectorDefinition,
	createTestUser,
	insertChatConnectionRow,
	seedOwnerContext,
} from "../setup/test-fixtures";

/** One connector per device-pinned connection: a device runs one live connection per connector. */
const CONNECTOR_KEY = "demo.device.team";
const NOT_DEVICE_OWNER = /Only the owner of device member-laptop can decide runs on it\./;
const NOT_ADMIN = /requires admin or owner access/;

describe("run decider: a device's runs belong to the device owner", () => {
	let orgId: string;
	let adminCtx: ToolContext;
	let memberCtx: ToolContext;
	let otherCtx: ToolContext;
	let memberDevice: string;
	/** Team connection an admin created and pinned to the member's machine. */
	let teamOnMemberDevice: number;
	/** The member's own private connection on their own machine. */
	let privateOnMemberDevice: number;
	/** Created by the member, but pinned to the admin's machine. */
	let memberConnOnAdminDevice: number;
	/** No device pin at all. */
	let unpinned: number;

	async function device(userId: string, workerId: string, label: string): Promise<string> {
		const [row] = await getTestDb()<{ id: string }>`
			INSERT INTO device_workers (user_id, worker_id, platform, organization_id, label)
			VALUES (${userId}, ${workerId}, 'headless', ${orgId}, ${label})
			RETURNING id
		`;
		return row.id;
	}

	const connectorKeyOf = new Map<number, string>();

	async function connection(opts: {
		connectorKey: string;
		createdBy: string;
		deviceId: string | null;
		visibility: "private" | "org";
	}): Promise<number> {
		const created = await createTestConnection({
			organization_id: orgId,
			connector_key: opts.connectorKey,
			created_by: opts.createdBy,
			visibility: opts.visibility,
			createDefaultFeed: false,
		});
		if (opts.deviceId) {
			await getTestDb()`
				UPDATE connections SET device_worker_id = ${opts.deviceId}::uuid WHERE id = ${created.id}
			`;
		}
		connectorKeyOf.set(created.id, opts.connectorKey);
		return created.id;
	}

	async function pendingRun(connectionId: number, targetDeviceId: string | null = null): Promise<number> {
		const sql = getTestDb();
		const [run] = await sql<{ id: number }>`
			INSERT INTO runs (
				organization_id, run_type, status, approval_status,
				connection_id, connector_key, action_key, policy_principal_kind,
				target_device_worker_id
			) VALUES (
				${orgId}, 'action', 'pending', 'pending',
				${connectionId}, ${connectorKeyOf.get(connectionId)}, 'run', 'user',
				${targetDeviceId}::uuid
			)
			RETURNING id
		`;
		const runId = Number(run.id);
		await sql`
			INSERT INTO events (
				organization_id, origin_id, title, payload_text, run_id,
				semantic_type, interaction_type, interaction_status
			) VALUES (
				${orgId}, ${`run_${runId}_pending`}, 'run — pending approval',
				'Awaiting review', ${runId}, 'operation', 'approval', 'pending'
			)
		`;
		return runId;
	}

	async function runState(runId: number) {
		const [run] = await getTestDb()`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		return run;
	}

	function memberContext(base: ToolContext, userId: string): ToolContext {
		return { ...base, userId, memberRole: "member", scopes: ["mcp:read", "mcp:write"] };
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx } = await seedOwnerContext({ orgName: "Device Decider Team" });
		orgId = org.id;
		adminCtx = ctx;
		const member = await createTestUser({ name: "Device Member" });
		const other = await createTestUser({ name: "Other Member" });
		await addUserToOrganization(member.id, org.id);
		await addUserToOrganization(other.id, org.id);
		memberCtx = memberContext(ctx, member.id);
		otherCtx = memberContext(ctx, other.id);

		memberDevice = await device(member.id, "headless:decider-member", "member-laptop");
		const adminDevice = await device(ctx.userId as string, "headless:decider-admin", "admin-laptop");
		teamOnMemberDevice = await connection({
			connectorKey: CONNECTOR_KEY,
			createdBy: ctx.userId as string,
			deviceId: memberDevice,
			visibility: "org",
		});
		privateOnMemberDevice = await connection({
			connectorKey: "demo.device.private",
			createdBy: member.id,
			deviceId: memberDevice,
			visibility: "private",
		});
		memberConnOnAdminDevice = await connection({
			connectorKey: "demo.device.elsewhere",
			createdBy: member.id,
			deviceId: adminDevice,
			visibility: "org",
		});
		unpinned = await connection({
			connectorKey: "demo.device.unpinned",
			createdBy: ctx.userId as string,
			deviceId: null,
			visibility: "org",
		});

		const sql = getTestDb();
		await createTestConnectorDefinition({
			key: CONNECTOR_KEY,
			name: "Device operation",
			organization_id: orgId,
		});
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({ run: { name: "Run", kind: "write" } })},
				supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR_KEY}
		`;
	});

	afterAll(cleanupTestDatabase);

	it("refuses a workspace admin who does not own the device, for every way a run reaches it", async () => {
		const runs = [
			await pendingRun(teamOnMemberDevice),
			await pendingRun(privateOnMemberDevice),
			// Explicit target on an otherwise unpinned connection.
			await pendingRun(unpinned, memberDevice),
		];
		for (const runId of runs) {
			for (const action of ["approve", "reject"] as const) {
				await expect(
					manageOperations({ action, run_id: runId }, {} as Env, adminCtx),
				).rejects.toThrow(NOT_DEVICE_OWNER);
			}
			expect(await runState(runId)).toMatchObject({ approval_status: "pending", status: "pending" });
		}
	});

	it("refuses a workspace admin's batch approval that includes a run on someone else's device", async () => {
		const runId = await pendingRun(teamOnMemberDevice);
		await expect(
			manageOperations(
				{ action: "approve_batch", scope: { connection_id: teamOnMemberDevice } },
				{} as Env,
				adminCtx,
			),
		).rejects.toThrow(NOT_DEVICE_OWNER);
		expect(await runState(runId)).toMatchObject({ approval_status: "pending" });
		await manageOperations({ action: "reject", run_id: runId }, {} as Env, memberCtx);
	});

	it("lets a plain-member device owner approve and reject runs on their device, whoever created the connection", async () => {
		const approved = await pendingRun(teamOnMemberDevice);
		expect(
			await manageOperations({ action: "approve", run_id: approved }, {} as Env, memberCtx),
		).toMatchObject({ approved: true, run_id: approved });
		expect(await runState(approved)).toMatchObject({ approval_status: "approved", status: "pending" });

		for (const runId of [
			await pendingRun(teamOnMemberDevice),
			await pendingRun(privateOnMemberDevice),
			await pendingRun(unpinned, memberDevice),
		]) {
			const rejected = (await manageOperations(
				{ action: "reject", run_id: runId },
				{} as Env,
				memberCtx,
			)) as { rejected?: boolean; error?: string };
			expect(rejected.error).toBeUndefined();
			expect(rejected.rejected).toBe(true);
		}
	});

	it("lets the device owner batch-approve their device's runs", async () => {
		const runId = await pendingRun(teamOnMemberDevice);
		const result = (await manageOperations(
			{ action: "approve_batch", scope: { connection_id: teamOnMemberDevice } },
			{} as Env,
			memberCtx,
		)) as { approved_count?: number; run_ids?: number[] };
		// The scope also holds runs an earlier test left pending after refusing the admin.
		expect(result.run_ids).toContain(runId);
		expect(result.approved_count).toBe(result.run_ids?.length);
		expect(await runState(runId)).toMatchObject({ approval_status: "approved" });
	});

	it("keeps the human-session floor for the device owner", async () => {
		const runId = await pendingRun(teamOnMemberDevice);
		const result = (await manageOperations(
			{ action: "reject", run_id: runId },
			{} as Env,
			{ ...memberCtx, clientId: "mcp-client" },
		)) as { error?: string };
		expect(result.error).toMatch(/requires a human web session/);
		expect(await runState(runId)).toMatchObject({ approval_status: "pending" });
		await manageOperations({ action: "reject", run_id: runId }, {} as Env, memberCtx);
	});

	it("refuses other members, and the creator of a connection pinned to someone else's device", async () => {
		const onMember = await pendingRun(teamOnMemberDevice);
		await expect(
			manageOperations({ action: "reject", run_id: onMember }, {} as Env, otherCtx),
		).rejects.toThrow(NOT_DEVICE_OWNER);
		await manageOperations({ action: "reject", run_id: onMember }, {} as Env, memberCtx);

		const onAdmin = await pendingRun(memberConnOnAdminDevice);
		await expect(
			manageOperations({ action: "reject", run_id: onAdmin }, {} as Env, memberCtx),
		).rejects.toThrow(/Only the owner of device admin-laptop can decide runs on it\./);
		expect(
			await manageOperations({ action: "reject", run_id: onAdmin }, {} as Env, adminCtx),
		).toMatchObject({ rejected: true });
	});

	it("leaves runs that touch no device with the admins", async () => {
		const runId = await pendingRun(unpinned);
		await expect(
			manageOperations({ action: "reject", run_id: runId }, {} as Env, memberCtx),
		).rejects.toThrow(NOT_ADMIN);
		expect(
			await manageOperations({ action: "reject", run_id: runId }, {} as Env, adminCtx),
		).toMatchObject({ rejected: true });
	});

	it("hands a run back to the admins once its connection is unpinned", async () => {
		const sql = getTestDb();
		const runId = await pendingRun(teamOnMemberDevice);
		try {
			await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${teamOnMemberDevice}`;
			await expect(
				manageOperations({ action: "reject", run_id: runId }, {} as Env, memberCtx),
			).rejects.toThrow(NOT_ADMIN);
			expect(
				await manageOperations({ action: "reject", run_id: runId }, {} as Env, adminCtx),
			).toMatchObject({ rejected: true });
		} finally {
			await sql`
				UPDATE connections SET device_worker_id = ${memberDevice}::uuid WHERE id = ${teamOnMemberDevice}
			`;
		}
	});

	it("names the device owner as the chat card's decider", async () => {
		for (const runId of [
			await pendingRun(teamOnMemberDevice),
			await pendingRun(privateOnMemberDevice),
			await pendingRun(unpinned, memberDevice),
		]) {
			expect(await resolveEntityApprovalRun(runId, orgId)).toEqual({
				state: "pending",
				ownerUserId: memberCtx.userId,
			});
		}
		expect((await resolveEntityApprovalRun(await pendingRun(unpinned), orgId)).ownerUserId).toBeNull();
	});

	it("keeps an explicit target authoritative over a different connection pin and unpinning", async () => {
		const sql = getTestDb();
		try {
			for (const unpin of [false, true]) {
				if (unpin) {
					await sql`UPDATE connections SET device_worker_id = NULL WHERE id = ${teamOnMemberDevice}`;
				}
				const runId = await pendingRun(unpin ? teamOnMemberDevice : memberConnOnAdminDevice, memberDevice);
				expect((await resolveEntityApprovalRun(runId, orgId)).ownerUserId).toBe(memberCtx.userId);
				await expect(
					manageOperations({ action: "reject", run_id: runId }, {} as Env, adminCtx),
				).rejects.toThrow(NOT_DEVICE_OWNER);
				expect(await manageOperations({ action: "reject", run_id: runId }, {} as Env, memberCtx))
					.toMatchObject({ rejected: true });
			}
		} finally {
			await sql`UPDATE connections SET device_worker_id = ${memberDevice}::uuid WHERE id = ${teamOnMemberDevice}`;
		}
	});

	it("keeps device approvals in the owner's inbox when no owner DM resolves", async () => {
		const sql = getTestDb();
		const agent = await createTestAgent({ organizationId: orgId, ownerUserId: adminCtx.userId as string });
		const connectionId = "device-approval-chat";
		const channelId = "slack:C_DEVICE_APPROVAL";
		const teamId = "T_DEVICE_APPROVAL";
		await insertChatConnectionRow({
			id: connectionId, organizationId: orgId, agentId: agent.agentId,
			platform: "slack", status: "active", settings: {}, metadata: {},
		});
		await createTestAutomationSubscription({
			organizationId: orgId, agentId: agent.agentId,
			connectionSlug: `agentconn-${connectionId}`, platform: "slack", channelId, teamId,
			configuredBy: adminCtx.userId as string,
		});
		for (const connection of [teamOnMemberDevice, unpinned]) {
			const runId = await pendingRun(connection);
			const [event] = await sql<{ id: number }>`SELECT id FROM events WHERE run_id = ${runId} ORDER BY id DESC LIMIT 1`;
			await notifyActionApprovalNeeded({
				orgId, runId, eventId: Number(event.id), actionKey: "run",
				connectionId, channelId, teamId, operation: { name: "Run", input: {} },
			});
			const [notification] = await sql<{ request: { ownerDm: unknown; targets: unknown[] } }>`
				SELECT metadata->'delivery_request' AS request FROM events
				WHERE organization_id = ${orgId}
				  AND metadata->'delivery_request'->'context'->>'decisionRunId' = ${String(runId)}
			`;
			expect(notification.request.ownerDm).toBeNull();
			expect(notification.request.targets).toEqual(connection === teamOnMemberDevice ? [] : [{
				connectionId, platform: "slack", channelKey: channelId, teamId,
			}]);
		}
	});

	it("notifies only the device owner for a device run, and the admins otherwise", async () => {
		const sql = getTestDb();
		async function recipientsFor(connectionId: number, target: string | null = null): Promise<string[]> {
			const runId = await pendingRun(connectionId, target);
			const [event] = await sql<{ id: number }>`
				SELECT id FROM events WHERE run_id = ${runId} ORDER BY id DESC LIMIT 1
			`;
			await notifyActionApprovalNeeded({
				orgId,
				runId,
				actionKey: "run",
				connectionName: CONNECTOR_KEY,
				eventId: Number(event.id),
				operation: { name: "Run", input: {} },
			});
			const rows = await sql<{ user_id: string }>`
				SELECT DISTINCT nt.user_id
				FROM notification_targets nt
				JOIN events e ON e.id = nt.event_id
				WHERE e.organization_id = ${orgId}
				  AND (e.metadata->'delivery_request'->'context'->>'decisionRunId')::bigint = ${runId}
			`;
			return rows.map((row) => row.user_id).sort();
		}

		expect(await recipientsFor(teamOnMemberDevice)).toEqual([memberCtx.userId]);
		expect(await recipientsFor(unpinned, memberDevice)).toEqual([memberCtx.userId]);
		expect(await recipientsFor(unpinned)).toEqual([adminCtx.userId]);
	});
});
