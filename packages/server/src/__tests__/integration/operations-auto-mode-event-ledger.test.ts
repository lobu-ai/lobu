/**
 * An operation that runs under an Auto policy must leave a trace in the
 * event ledger.
 *
 * Before this suite the `semantic_type='operation'` card was written ONLY on
 * the approval-queued branch, so an organization whose operations all resolve
 * to `auto` had a completely empty operation audit trail: the only path that
 * recorded anything was the one a human had already seen.
 *
 * The contract exercised here:
 *   - a non-queued (inline) run writes its dispatch card in the SAME
 *     transaction as the run row, so a run can never exist without its card;
 *   - the terminal outcome supersedes that card, so the ledger records what
 *     actually happened, not just that something was attempted;
 *   - a failed run records the failure the same way;
 *   - the approval path still writes exactly ONE pending card (no double-write).
 */

import { qualifiedOperationKey } from "../../tools/admin/manage_operations/handlers/shared";
import { upsertEntityApprovalPolicy } from "../../authz/entity-policy";
import { encodeExternalAutomationClaimOwner } from "../../automations/external-claim-owner";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestPAT,
	createTestUser,
	createTestConnection,
	createTestConnectorDefinition,
	seedOwnerContext,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";
import { TestApiClient } from "../setup/test-mcp-client";
import { reapStaleRuns } from "../../scheduled/check-stalled-executions";

const CONNECTOR = "demo.ops.auto.ledger";

type LedgerRow = {
	id: string;
	origin_id: string;
	title: string;
	semantic_type: string;
	interaction_type: string;
	interaction_status: string | null;
	interaction_input: Record<string, unknown> | null;
	interaction_output: Record<string, unknown> | null;
	interaction_error: string | null;
	supersedes_event_id: string | null;
	superseded_by: string | null;
	connection_id: string | null;
	metadata: Record<string, unknown>;
};

async function operationLedger(
	orgId: string,
	runId: number,
): Promise<LedgerRow[]> {
	const sql = getTestDb();
	return (await sql`
		SELECT id, origin_id, title, semantic_type, interaction_type, interaction_status,
		       interaction_input, interaction_output, interaction_error,
		       supersedes_event_id, superseded_by, connection_id, metadata
		FROM events
		WHERE organization_id = ${orgId}
		  AND run_id = ${runId}
		  AND semantic_type = 'operation'
		ORDER BY id ASC
	`) as unknown as LedgerRow[];
}

describe("operation ledger under Auto policy", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const {
			org,
			user,
			ctx: ownerCtx,
		} = await seedOwnerContext({ orgName: "Auto Ledger Org" });
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Auto Ledger",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				echo: {
					name: "Echo",
					kind: "write",
					input_schema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
				needs_approval: {
					name: "Needs approval",
					kind: "write",
				},
			})},
			supports_execute = true
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;
		await sql`
			UPDATE connector_versions
			SET compiled_code = ${`
				class ConnectorRuntime {
					async sync() { return { items: [] }; }
					async execute(ctx) {
						if (ctx.input.value === 'boom') throw new Error('connector exploded');
						return { success: true, output: { value: ctx.input.value ?? null } };
					}
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${CONNECTOR}
		`;

		// The organization explicitly permits every operation on this connection.
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		connectionId = conn.id;
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: connectionId,
			effects: { execute: "auto" },
		});

		const accountId = `acct_${connectionId}_auto_ledger`;
		await sql`
			INSERT INTO "account" (
			  id, "accountId", "providerId", "userId",
			  "accessToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
			) VALUES (
			  ${accountId}, ${accountId}, 'test', ${userId},
			  'tok', ${new Date(Date.now() + 3_600_000).toISOString()}, 'read write', NOW(), NOW()
			)
		`;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: CONNECTOR,
			displayName: "auto ledger OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: userId,
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connectionId}`;
	});

	it("records a completed auto run in the operation ledger", async () => {
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "auto-ok" },
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(result.status).toBe("completed");

		const rows = await operationLedger(orgId, result.run_id);
		// Two durable versions: the dispatch card and the terminal outcome that
		// supersedes it. `events` is append-only, so the chain is the history.
		expect(rows).toHaveLength(2);

		const [dispatched, terminal] = rows;
		expect(dispatched).toMatchObject({
			origin_id: `run_${result.run_id}_auto`,
			interaction_status: "approved",
			interaction_input: { value: "auto-ok" },
		});
		expect(Number(dispatched.connection_id)).toBe(connectionId);
		expect(dispatched.metadata.operation_key).toBe("echo");
		// The card names who the policy decided for, so its rule buttons can act for that caller.
		const decided = { effect: "auto", principal: { kind: "user", id: null, label: null } };
		expect(dispatched.metadata.policy).toMatchObject(decided);
		expect(dispatched.superseded_by).not.toBeNull();

		expect(terminal).toMatchObject({
			interaction_status: "completed",
			interaction_output: { value: "auto-ok" },
			superseded_by: null,
		});
		expect(terminal.metadata.policy).toMatchObject(decided);
		// Every version is titled by the operation's name, not its raw key: an
		// agent reading the ledger sees titles without the structured fields.
		expect(dispatched.title).toBe("Echo — dispatched");
		expect(terminal.title).toBe("Echo — completed");
		expect(Number(terminal.supersedes_event_id)).toBe(Number(dispatched.id));
	});

	it("records a failed auto run in the operation ledger", async () => {
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "echo",
				input: { value: "boom" },
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(result.status).toBe("failed");

		const rows = await operationLedger(orgId, result.run_id);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			interaction_status: "failed",
			superseded_by: null,
		});
		expect(rows[1].interaction_error).toContain("connector exploded");
	});

	it("binds the dispatch card to the run row: no run without its card", async () => {
		const sql = getTestDb();
		const runs = (await sql`
			SELECT r.id
			FROM runs r
			WHERE r.organization_id = ${orgId}
			  AND r.run_type = 'action'
			  AND r.connector_key = ${CONNECTOR}
			  AND NOT EXISTS (
			    SELECT 1 FROM events e
			    WHERE e.organization_id = r.organization_id
			      AND e.run_id = r.id
			      AND e.semantic_type = 'operation'
			  )
		`) as unknown as Array<{ id: string }>;
		expect(runs).toEqual([]);
	});

	async function backgroundDevice() {
		delete process.env.WORKER_API_TOKEN;
		const sql = getTestDb();
		const workerId = `background-device-${Date.now()}`;
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, app_version, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Auto Ledger Device',
				${orgId}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const deviceConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: deviceConn.id,
			effects: { execute: "auto" },
		});
		await sql`
			UPDATE connections SET device_worker_id = ${String(device.id)}::uuid
			WHERE id = ${deviceConn.id}
		`;

		return { deviceConn, workerId };
	}

	it("background device work survives caller abort and completes through the worker API", async () => {
		const { deviceConn, workerId } = await backgroundDevice();
		const abort = new AbortController();
		const request = { action: "execute" as const, connection_id: deviceConn.id,
			operation_key: "echo", input: { value: "background" },
			idempotency_key: "synthetic-background-completion", background: true };
		const queued = await manageOperations(request, {} as Env, { ...ctx, abortSignal: abort.signal }) as { status: string; run_id: number };
		expect(queued.status).toBe("in_progress");
		abort.abort();
		expect(await manageOperations(request, {} as Env, ctx)).toMatchObject({ run_id: queued.run_id, status: "in_progress" });
		const claimed = await post("/api/workers/poll", { body: { worker_id: workerId, platform: "macos", app_version: "0.1.0", label: workerId, capabilities: {} } });
		expect(await claimed.json()).toMatchObject({ run_id: queued.run_id });
		const complete = await post("/api/workers/complete-action", { body: { run_id: queued.run_id, worker_id: workerId, status: "success", action_output: { value: "background-done" } } });
		expect(complete.status).toBe(200);
		expect(await manageOperations({ action: "get_run", run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ run: { status: "completed", output: { value: "background-done" } } });
		expect((await operationLedger(orgId, queued.run_id)).at(-1)).toMatchObject({ interaction_status: "completed" });
		expect(await manageOperations({ action: "cancel", run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ status: "completed", cancelled: false });
	});

	it("cancellation is durable, idempotent, and rejects late worker completion", async () => {
		const { deviceConn, workerId } = await backgroundDevice();
		const queued = await manageOperations({ action: "execute", connection_id: deviceConn.id, operation_key: "echo", input: { value: "cancel" }, background: true }, {} as Env, ctx) as { run_id: number };
		const claimed = await post("/api/workers/poll", { body: { worker_id: workerId, platform: "macos", app_version: "0.1.0", label: workerId, capabilities: {} } });
		expect(await claimed.json()).toMatchObject({ run_id: queued.run_id });
		const cancel = { action: "cancel" as const, run_id: queued.run_id };
		expect(await manageOperations(cancel, {} as Env, { ...ctx, organizationId: "synthetic-other-org" })).toHaveProperty("error");
		expect(await manageOperations(cancel, {} as Env, { ...ctx, userId: null, agentId: null })).toHaveProperty("error");
		expect(await manageOperations(cancel, {} as Env, ctx)).toMatchObject({ status: "cancelled", cancelled: true });
		expect(await manageOperations(cancel, {} as Env, ctx)).toMatchObject({ status: "cancelled", cancelled: false });
		expect((await post("/api/workers/complete-action", { body: { run_id: queued.run_id, worker_id: workerId, status: "success", action_output: { wrong: true } } })).status).toBe(200);
		expect(await manageOperations({ action: "get_run", run_id: queued.run_id }, {} as Env, ctx)).toMatchObject({ run: { status: "cancelled", output: null } });
		expect((await post("/api/workers/heartbeat", { body: { run_id: queued.run_id, worker_id: workerId } })).status).toBe(409);
		expect((await operationLedger(orgId, queued.run_id)).at(-1)?.metadata).toMatchObject({ run_status: "cancelled" });
	});

	it("background approval stays pending and only its requester can cancel it", async () => {
		const { deviceConn, workerId } = await backgroundDevice();
		await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectionId: deviceConn.id, effects: { execute: "approval" } });
		const queued = await manageOperations({ action: "execute", connection_id: deviceConn.id, operation_key: "echo", input: { value: "approval" }, background: true }, {} as Env, ctx) as { status: string; run_id: number };
		expect(queued.status).toBe("pending_approval");
		const member = await createTestUser({ name: "Other operation member" });
		await addUserToOrganization(member.id, orgId);
		const memberCtx = { ...ctx, userId: member.id };
		expect(await manageOperations({ action: "cancel", run_id: queued.run_id }, {} as Env, memberCtx)).toHaveProperty("error");
		expect(await manageOperations({ action: "cancel", run_id: queued.run_id }, {} as Env, { ...ctx, agentId: "synthetic-foreign-agent" })).toHaveProperty("error");
		// Exercise the non-admin requester branch, independent of admin privilege.
		await getTestDb()`UPDATE runs SET created_by_user_id = ${member.id} WHERE id = ${queued.run_id}`;
		expect(await manageOperations({ action: "cancel", run_id: queued.run_id }, {} as Env, memberCtx)).toMatchObject({ status: "cancelled", cancelled: true });
		// A withdrawn approval must leave every reviewer surface, not stay pending.
		const [settled] = await getTestDb()`SELECT approval_status FROM runs WHERE id = ${queued.run_id}`;
		expect(settled.approval_status).toBe("withdrawn");
		expect((await operationLedger(orgId, queued.run_id)).at(-1)).toMatchObject({ interaction_status: "rejected", metadata: { approval_status: "withdrawn" } });
		expect(await manageOperations({ action: "reject", run_id: queued.run_id }, {} as Env, ctx)).toHaveProperty("error");
		const polled = await post("/api/workers/poll", { body: { worker_id: workerId, platform: "macos", app_version: "0.1.0", label: workerId, capabilities: {} } });
		expect(await polled.json()).not.toHaveProperty("run_id", queued.run_id);
	});

	it("a Check holds an agent's write until that agent confirms it, then records the statement", async () => {
		const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId, name: "Check fixture agent" });
		const agentCtx: ToolContext = { ...ctx, agentId: agent.agentId };
		const sql = getTestDb();
		const checkConn = await createTestConnection({ organization_id: orgId, connector_key: CONNECTOR, created_by: userId, visibility: "private" });
		await sql`UPDATE connections SET auth_profile_id = (SELECT auth_profile_id FROM connections WHERE id = ${connectionId}) WHERE id = ${checkConn.id}`;
		await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectionId: checkConn.id, effects: { execute: "auto" } });
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", connectionId: checkConn.id, kind: "guardrail",
			principalKind: "agent", principalId: agent.agentId, note: "Only echo values the user asked for", effects: { execute: "check" },
		});
		const execute = (value: string) => manageOperations({ action: "execute", connection_id: checkConn.id, operation_key: "echo", input: { value } }, {} as Env, agentCtx) as Promise<Record<string, unknown> & { run_id: number }>;
		const confirm = (runId: number, as: ToolContext = agentCtx) => manageOperations({ action: "confirm", run_id: runId, statement: "The user asked for this value." }, {} as Env, as) as Promise<Record<string, unknown>>;

		// The person running the same write is outside the agent's guardrail.
		expect(await manageOperations({ action: "execute", connection_id: checkConn.id, operation_key: "echo", input: { value: "person" } }, {} as Env, ctx)).toMatchObject({ status: "completed" });

		const held = await execute("checked");
		expect(held).toMatchObject({ status: "pending_check", policy: {
			reason: "guardrail", rules: [{ note: "Only echo values the user asked for" }],
			principal: { kind: "agent", id: agent.agentId, label: "Check fixture agent" },
		} });
		expect(await operationLedger(orgId, held.run_id)).toEqual([]);
		// Neither the person nor another agent can confirm the agent's own judgment.
		expect(await confirm(held.run_id, ctx)).toHaveProperty("error");
		expect(await confirm(held.run_id, { ...ctx, agentId: "synthetic-other-agent" })).toHaveProperty("error");
		// A human approval is not a path around the check either.
		expect(await manageOperations({ action: "approve", run_id: held.run_id }, {} as Env, ctx)).toHaveProperty("error");

		expect(await confirm(held.run_id)).toMatchObject({ run_id: held.run_id, status: "completed" });
		const [run] = await sql`SELECT approval_status, run_metadata FROM runs WHERE id = ${held.run_id}`;
		expect(run.approval_status).toBe("auto");
		expect(run.run_metadata.policy_check).toMatchObject({ statement: "The user asked for this value." });
		const ledger = await operationLedger(orgId, held.run_id);
		expect(ledger.map((row) => row.interaction_status)).toEqual(["approved", "completed"]);
		expect(ledger[0].metadata.policy).toMatchObject({
			check: { statement: "The user asked for this value." },
			principal: { kind: "agent", id: agent.agentId, label: "Check fixture agent" },
		});
		expect(await confirm(held.run_id)).toMatchObject({ reason: "not_pending_check" });

		// Cancel withdraws a held check without leaving a card behind.
		const withdrawn = await execute("withdraw");
		expect(await manageOperations({ action: "cancel", run_id: withdrawn.run_id }, {} as Env, agentCtx)).toMatchObject({ cancelled: true });
		expect((await sql`SELECT approval_status FROM runs WHERE id = ${withdrawn.run_id}`)[0].approval_status).toBe("withdrawn");
		expect(await operationLedger(orgId, withdrawn.run_id)).toEqual([]);

		// An unconfirmed check expires and the reaper times it out without a card.
		const expired = await execute("expire");
		await sql`UPDATE runs SET expires_at = NOW() - interval '1 second' WHERE id = ${expired.run_id}`;
		expect(await confirm(expired.run_id)).toMatchObject({ reason: "check_expired" });
		await reapStaleRuns();
		expect((await sql`SELECT status, error_message FROM runs WHERE id = ${expired.run_id}`)[0]).toMatchObject({ status: "timeout", error_message: "policy_check_not_confirmed" });
		expect(await operationLedger(orgId, expired.run_id)).toEqual([]);

		// A rule tightened while the run was held wins at confirm.
		const pendingAtDelete = await execute("delete-connection");
		expect(pendingAtDelete.status).toBe("pending_check");
		const tightened = await execute("tighten");
		await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectionId: checkConn.id, kind: "guardrail", effects: { execute: "approval" } });
		expect(await confirm(tightened.run_id)).toMatchObject({ reason: "policy_changed" });
		expect((await sql`SELECT approval_status, status FROM runs WHERE id = ${tightened.run_id}`)[0]).toMatchObject({ approval_status: "withdrawn", status: "cancelled" });
		// Deleting the connection settles the remaining Check without a card.
		const owner = await TestApiClient.for({ organizationId: orgId, userId, memberRole: "owner" });
		expect(await owner.connections.delete(checkConn.id)).toMatchObject({ deleted: true });
		const [deletedCheck] = await sql`
			SELECT approval_status, status, completed_at FROM runs WHERE id = ${pendingAtDelete.run_id}
		`;
		expect(deletedCheck).toMatchObject({ approval_status: "withdrawn", status: "cancelled" });
		expect(deletedCheck.completed_at).not.toBeNull();
		expect(await confirm(pendingAtDelete.run_id)).toMatchObject({ reason: "not_pending_check" });
		expect(await operationLedger(orgId, pendingAtDelete.run_id)).toEqual([]);
		expect((await sql`SELECT status FROM runs WHERE id = ${expired.run_id}`)[0].status).toBe("timeout");
	});

	it("an external runner settles its Automation's Check only while it holds the window lease", async () => {
		const sql = getTestDb();
		const runner = await createTestUser({ name: "External runner member" });
		await addUserToOrganization(runner.id, orgId);
		const runnerCtx: ToolContext = { ...ctx, userId: runner.id, memberRole: "member", appPrincipalId: "web:external-runner.test" };
		const checkConn = await createTestConnection({ organization_id: orgId, connector_key: CONNECTOR, created_by: runner.id, visibility: "private" });
		await sql`UPDATE connections SET auth_profile_id = (SELECT auth_profile_id FROM connections WHERE id = ${connectionId}) WHERE id = ${checkConn.id}`;
		// An external Automation that runs an agent is held for a Check, which its
		// processor must be able to settle.
		const agent = await createTestAgent({ organizationId: orgId, ownerUserId: runner.id, name: "External runner agent" });
		const automationId = 7101;
		await sql`INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, execution_config, created_by, name, slug)
			VALUES (${automationId}, ${automationId}, ${orgId}, ${agent.agentId}, ${sql.json({ executor: { kind: "external" } })},
				${runner.id}, 'External runner fixture', 'external-runner-fixture')`;
		await upsertEntityApprovalPolicy(orgId, { resourceClass: "connector_action", connectionId: checkConn.id, effects: { execute: "auto" } });
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", connectionId: checkConn.id, kind: "guardrail",
			principalKind: "automation", principalId: `automation:${automationId}`, note: "Only echo values from the window", effects: { execute: "check" },
		});
		const [window] = await sql<{ id: number }>`INSERT INTO runs (organization_id, run_type, automation_id, status)
			VALUES (${orgId}, 'automation', ${automationId}, 'running') RETURNING id`;
		const lease = (claimedBy: string, seconds: number) => sql`UPDATE runs
			SET claimed_by = ${claimedBy}, expires_at = now() + make_interval(secs => ${seconds}) WHERE id = ${window.id}`;
		const ownLease = encodeExternalAutomationClaimOwner(runnerCtx);
		const otherLease = encodeExternalAutomationClaimOwner({ userId: "synthetic-other-runner" });
		await lease(ownLease, 300);
		const execute = async (value: string, as: ToolContext = runnerCtx) => {
			const held = await manageOperations({
				action: "execute", connection_id: checkConn.id, operation_key: "echo", input: { value },
				automation_source: { automation_id: automationId, run_id: Number(window.id) },
			}, {} as Env, as) as Record<string, unknown> & { run_id: number };
			expect(held).toMatchObject({ status: "pending_check", policy: { principal: { kind: "automation", id: `automation:${automationId}` } } });
			return held.run_id;
		};
		const confirm = (runId: number, as: ToolContext = runnerCtx) => manageOperations({ action: "confirm", run_id: runId, statement: "The window asked for this value." }, {} as Env, as) as Promise<Record<string, unknown>>;
		const cancel = (runId: number) => manageOperations({ action: "cancel", run_id: runId }, {} as Env, runnerCtx) as Promise<Record<string, unknown>>;

		// Someone else's lease or a lapsed one does not make the caller the Automation.
		const confirmed = await execute("confirmed");
		const withdrawn = await execute("withdrawn");
		for (const [claimedBy, seconds] of [[otherLease, 300], [ownLease, -1]] as const) {
			await lease(claimedBy, seconds);
			expect(await confirm(confirmed), `${claimedBy} ${seconds}`).toHaveProperty("error");
			expect(await cancel(withdrawn), `${claimedBy} ${seconds}`).toHaveProperty("error");
		}

		await lease(ownLease, 300);
		expect(await confirm(confirmed)).toMatchObject({ run_id: confirmed, status: "completed" });
		expect((await sql`SELECT run_metadata FROM runs WHERE id = ${confirmed}`)[0].run_metadata.policy_check)
			.toMatchObject({ statement: "The window asked for this value." });
		expect(await cancel(withdrawn)).toMatchObject({ cancelled: true });
		expect((await sql`SELECT approval_status FROM runs WHERE id = ${withdrawn}`)[0].approval_status).toBe("withdrawn");

		// A replacement processor's PAT can be stricter than the PAT that held
		// the Check, even when both act as the same Automation in later windows.
		const originalPat = await createTestPAT(runner.id, orgId);
		const replacementPat = await createTestPAT(runner.id, orgId);
		const patCtx = (id: number): ToolContext => ({ ...runnerCtx, clientId: `pat_${id}`, appPrincipalId: `pat:${id}` });
		const originalCtx = patCtx(originalPat.id);
		const replacementCtx = patCtx(replacementPat.id);
		const setAllowance = (id: number, operationKey: string, effect: "auto" | "approval") => sql`
			INSERT INTO caller_action_allowlists (organization_id, subject_kind, subject_id, entries)
			VALUES (${orgId}, 'pat', ${String(id)}, ${sql.json([
				{ action: "connector.execute", connection_id: checkConn.id, operation_key: operationKey, effect },
			])})
			ON CONFLICT (organization_id, subject_kind, subject_id) DO UPDATE SET entries = EXCLUDED.entries`;
		await setAllowance(originalPat.id, "echo", "auto");
		await lease(encodeExternalAutomationClaimOwner(originalCtx), 300);
		const excluded = await execute("excluded by replacement", originalCtx);
		const asks = await execute("replacement needs approval", originalCtx);
		const allowed = await execute("allowed replacement", originalCtx);
		const originalRestricted = await execute("original PAT tightened", originalCtx);
		await sql`UPDATE runs SET status = 'completed' WHERE id = ${window.id}`;
		await sql`INSERT INTO runs (organization_id, run_type, automation_id, status, claimed_by, expires_at)
			VALUES (${orgId}, 'automation', ${automationId}, 'running',
				${encodeExternalAutomationClaimOwner(replacementCtx)}, now() + interval '5 minutes')`;

		await setAllowance(replacementPat.id, "needs_approval", "auto");
		expect(await confirm(excluded, replacementCtx)).toMatchObject({
			error: "'echo' isn't on this caller's allowed actions list.",
			policy: { reason: "allowlist" },
		});
		expect((await sql`SELECT status, approval_status FROM runs WHERE id = ${excluded}`)[0])
			.toMatchObject({ status: "cancelled", approval_status: "rejected" });
		expect(await operationLedger(orgId, excluded)).toHaveLength(0);

		await setAllowance(replacementPat.id, "echo", "approval");
		expect(await confirm(asks, replacementCtx)).toMatchObject({ reason: "policy_changed", policy: { reason: "allowlist" } });
		expect((await sql`SELECT status, approval_status FROM runs WHERE id = ${asks}`)[0])
			.toMatchObject({ status: "cancelled", approval_status: "withdrawn" });
		expect(await operationLedger(orgId, asks)).toHaveLength(0);

		await setAllowance(replacementPat.id, "echo", "auto");
		expect(await confirm(allowed, replacementCtx)).toMatchObject({ run_id: allowed, status: "completed", output: { value: "allowed replacement" } });
		// Keeping the new PAT permissive must not discard the original PAT's list.
		await setAllowance(originalPat.id, "needs_approval", "auto");
		expect(await confirm(originalRestricted, replacementCtx)).toMatchObject({
			error: "'echo' isn't on this caller's allowed actions list.",
			policy: { reason: "allowlist" },
		});
		expect(await operationLedger(orgId, originalRestricted)).toHaveLength(0);
	});

	it("a background device Check is not claimable until the agent confirms it", async () => {
		const { deviceConn, workerId } = await backgroundDevice();
		const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
		const agentCtx: ToolContext = { ...ctx, agentId: agent.agentId };
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action", connectionId: deviceConn.id, kind: "guardrail",
			principalKind: "agent", principalId: agent.agentId, effects: { execute: "check" },
		});
		const held = await manageOperations({ action: "execute", connection_id: deviceConn.id, operation_key: "echo", input: { value: "device-check" }, background: true }, {} as Env, agentCtx) as { status: string; run_id: number };
		expect(held.status).toBe("pending_check");
		const poll = () => post("/api/workers/poll", { body: { worker_id: workerId, platform: "macos", app_version: "0.1.0", label: workerId, capabilities: {} } });
		expect(await (await poll()).json()).not.toHaveProperty("run_id", held.run_id);
		expect(await manageOperations({ action: "confirm", run_id: held.run_id, statement: "Requested by the user." }, {} as Env, agentCtx)).toMatchObject({ run_id: held.run_id, status: "in_progress" });
		expect(await (await poll()).json()).toMatchObject({ run_id: held.run_id });
	});

	it("refuses background mode for inline operations before creating a run", async () => {
		await expect(manageOperations({ action: "execute", connection_id: connectionId, operation_key: "echo", input: { value: "inline" }, background: true }, {} as Env, ctx)).rejects.toThrow(/background.*device/i);
	});

	it("records a device-executed auto run when the worker reports completion", async () => {
		delete process.env.WORKER_API_TOKEN;
		const sql = getTestDb();
		const workerId = `auto-ledger-device-${Date.now()}`;
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, app_version, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Auto Ledger Device',
				${orgId}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const deviceConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: deviceConn.id,
			effects: { execute: "auto" },
		});
		await sql`
			UPDATE connections SET device_worker_id = ${String(device.id)}::uuid
			WHERE id = ${deviceConn.id}
		`;
		const idempotencyKey = `auto-ledger:device:${Date.now()}`;
		const execution = manageOperations(
			{
				action: "execute",
				connection_id: deviceConn.id,
				operation_key: "echo",
				input: { value: "device-ok" },
				idempotency_key: idempotencyKey,
			},
			{} as Env,
			ctx,
		) as Promise<{ status: string; run_id: number }>;

		const deadline = Date.now() + 5_000;
		let runId = 0;
		while (Date.now() < deadline && runId === 0) {
			const rows = (await sql`
				SELECT id FROM runs
				WHERE connection_id = ${deviceConn.id}
				  AND run_type = 'action'
				  AND action_idempotency_key = ${idempotencyKey}
				LIMIT 1
			`) as unknown as Array<{ id: number }>;
			if (rows[0]) runId = Number(rows[0].id);
			else await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runId).toBeGreaterThan(0);

		// The card exists the moment the run does — before any worker touches it.
		const dispatched = await operationLedger(orgId, runId);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].interaction_status).toBe("approved");

		const claim = (await (
			await post("/api/workers/poll", {
				body: {
					worker_id: workerId,
					platform: "macos",
					app_version: "0.1.0",
					label: workerId,
					capabilities: {},
				},
			})
		).json()) as { run_id?: number };
		expect(claim.run_id).toBe(runId);
		const completed = await post("/api/workers/complete-action", {
			body: {
				run_id: runId,
				worker_id: workerId,
				status: "success",
				action_output: { value: "device-ok" },
			},
		});
		expect(completed.status).toBe(200);
		expect(await execution).toMatchObject({ status: "completed" });

		const rows = await operationLedger(orgId, runId);
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			interaction_status: "completed",
			superseded_by: null,
		});
		expect(Number(rows[1].supersedes_event_id)).toBe(Number(rows[0].id));
	});

	it("still writes exactly one pending card on the approval path", async () => {
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: connectionId,
			operationKey: qualifiedOperationKey(CONNECTOR, "needs_approval"),
			effects: { execute: "approval" },
		});
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "needs_approval",
				input: {},
			},
			{} as Env,
			ctx,
		)) as { status: string; run_id: number };
		expect(queued.status).toBe("pending_approval");

		const rows = await operationLedger(orgId, queued.run_id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			origin_id: `run_${queued.run_id}_pending`,
			interaction_type: "approval",
			interaction_status: "pending",
		});
	});

	it("supersedes the dispatch card when the reaper times out an auto run", async () => {
		// A run the executor never finished is the one case where nothing on the
		// request path can close its card: the gateway call is gone. The reaper
		// terminalizes the run, so it must terminalize the ledger with it — or
		// the card reads "dispatched" forever and the audit trail lies about an
		// operation that actually timed out.
		delete process.env.WORKER_API_TOKEN;
		const sql = getTestDb();
		const workerId = `auto-ledger-reap-${Date.now()}`;
		const [device] = (await sql`
			INSERT INTO device_workers (
				user_id, worker_id, platform, app_version, capabilities, label,
				organization_id, last_seen_at
			) VALUES (
				${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Auto Ledger Reap',
				${orgId}, NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: string }>;
		const deviceConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "connector_action",
			connectionId: deviceConn.id,
			effects: { execute: "auto" },
		});
		await sql`
			UPDATE connections SET device_worker_id = ${String(device.id)}::uuid
			WHERE id = ${deviceConn.id}
		`;
		const idempotencyKey = `auto-ledger:reap:${Date.now()}`;
		// Never awaited to completion before the reap: this run is abandoned on
		// purpose. The rejection is swallowed so an abandoned wait cannot fail
		// the suite on an unhandled rejection.
		const execution = (
			manageOperations(
				{
					action: "execute",
					connection_id: deviceConn.id,
					operation_key: "echo",
					input: { value: "reap-me" },
					idempotency_key: idempotencyKey,
				},
				{} as Env,
				ctx,
			) as Promise<{ status: string; run_id: number }>
		).catch(() => ({ status: "failed", run_id: 0 }));

		const deadline = Date.now() + 5_000;
		let runId = 0;
		while (Date.now() < deadline && runId === 0) {
			const rows = (await sql`
				SELECT id FROM runs
				WHERE connection_id = ${deviceConn.id}
				  AND run_type = 'action'
				  AND action_idempotency_key = ${idempotencyKey}
				LIMIT 1
			`) as unknown as Array<{ id: number }>;
			if (rows[0]) runId = Number(rows[0].id);
			else await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runId).toBeGreaterThan(0);

		const beforeReap = await operationLedger(orgId, runId);
		expect(beforeReap).toHaveLength(1);
		expect(beforeReap[0].interaction_status).toBe("approved");
		expect(beforeReap[0].superseded_by).toBeNull();

		// Expire the run's authoritative claim horizon. `approval_status` stays 'auto',
		// which is what keeps it inside the bulk sweep — the approval lane is
		// excluded from it by predicate.
		await sql`
			UPDATE runs
			SET created_at = NOW() - INTERVAL '2 hours',
			    expires_at = NOW() - INTERVAL '1 second',
			    claimed_at = NULL,
			    last_heartbeat_at = NULL
			WHERE id = ${runId}
		`;

		const result = await reapStaleRuns();
		expect(result.acquired).toBe(true);
		expect(result.reaped).toBeGreaterThan(0);

		const [runRow] = (await sql`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`) as unknown as Array<{ status: string; error_message: string | null }>;
		expect(runRow.status).toBe("timeout");
		// This run was never claimed (claimed_at NULL), so the reaper classifies
		// it as a claim timeout rather than a lost heartbeat.
		expect(runRow.error_message).toBe("worker_claim_timeout");

		const rows = await operationLedger(orgId, runId);
		expect(rows).toHaveLength(2);
		expect(rows[0].superseded_by).not.toBeNull();
		expect(rows[1]).toMatchObject({
			interaction_status: "failed",
			superseded_by: null,
		});
		expect(Number(rows[1].supersedes_event_id)).toBe(Number(rows[0].id));
		expect(rows[1].metadata.run_status).toBe("timeout");
		// The card must record the SAME cause the run row got. Hardcoding one of
		// the two reaper causes here made the ledger contradict the run it
		// describes, which is exactly the contract this test exists to hold.
		expect(rows[1].metadata.error_message).toBe(runRow.error_message);
		await execution;
	});

});
