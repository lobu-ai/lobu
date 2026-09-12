/**
 * Approval-run TRANSITION atomicity — a decision's `runs` write and its
 * superseding card event must commit together.
 *
 * #2033 fixed the QUEUE path (run + pending approval event in one tx, see
 * operations-approval-event-atomicity.test.ts). This covers the far end: when
 * a human approves and the operation completes inline, the terminal
 * `runs.status='completed'` write and the 'completed' card supersede must be
 * atomic. Forced failure of the completed-event INSERT must roll the run's
 * terminal state back too — today the runs write commits while the card stays
 * at 'confirmed' (the agent reads `runs.action_output` via get_run; the UI card
 * reads the event; they diverge).
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import type { Env } from "../../index";
import { queueAgentAsk } from "../../notifications/ask";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { createAuthProfile } from "../../utils/auth-profiles";
import { insertEvent } from "../../utils/insert-event";
import { completeActionRun } from "../../worker-api";
import { failClaimedWorkerRun } from "../../worker-api/poll";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	ownerToolContext,
	seedOwnerContext,
} from "../setup/test-fixtures";

// Counts how many times the external POST /items mutation actually ran, so a
// retry that re-executes the mutation is detectable (it must run exactly once).
let postItemsCalls = 0;

/**
 * Runs once, inside the external POST — exactly the window between the gateway
 * taking a run's lease and writing the outcome back. A stale-run reaper, a
 * cancel, or another replica re-claiming all land in this window in
 * production, and it is the only place to hit it deterministically: the
 * gateway holds the lease across the whole call.
 */
let duringExternalCall: (() => Promise<void>) | null = null;
/**
 * Make the external POST THROW rather than answer. A thrown request is the one
 * path that reaches `executeHttpOperation`'s `failRun`; a non-2xx response is
 * handled by the already-fenced error lane instead.
 */
let throwOnPostItems = false;
const THIEF = "some-other-replica";

const CONNECTOR = "demo.ops.transition.atomic";

// Force a REAL failure of ONLY the terminal 'completed' card INSERT. The
// 'confirmed' event (the approval claim) writes `interaction_status='approved'`,
// so it must still succeed — the failure is isolated to the terminal phase, the
// exact divergence the two-phase atomicity fixes. This is a DB-level trigger,
// not a module mock, so it works under this suite's `isolate:false` shared
// registry.
const FAIL_COMPLETED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_terminal_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'completed' THEN
    RAISE EXCEPTION 'simulated terminal approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_terminal_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_terminal_approval_event();
`;
const DROP_FAIL_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_terminal_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_terminal_approval_event();
`;
const FAIL_FAILED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_failed_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'failed' THEN
    RAISE EXCEPTION 'simulated failed approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_failed_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_failed_approval_event();
`;
const DROP_FAIL_FAILED_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_failed_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_failed_approval_event();
`;

// Force the QUEUE-path pending card INSERT to fail so the run INSERT + card
// creation must commit atomically (or not at all).
const FAIL_PENDING_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_pending_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'pending' THEN
    RAISE EXCEPTION 'simulated pending approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_pending_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_pending_approval_event();
`;
const DROP_FAIL_PENDING_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_pending_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_pending_approval_event();
`;

// Hand a builder run's lease to another owner at the exact instant the claim
// commits. `claimBuilderRun` and the 'confirmed' card INSERT share one
// transaction, so a trigger on that INSERT fires INSIDE it and commits with
// it — reproducing "the reaper took this run while `apply` was in flight"
// without a module mock, which this suite's shared registry cannot isolate.
const STEAL_ON_CONFIRMED_TRIGGER = `
CREATE OR REPLACE FUNCTION test_steal_lease_on_confirmed() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' AND NEW.interaction_status = 'approved'
     AND NEW.run_id IS NOT NULL THEN
    UPDATE runs SET claimed_by = 'some-other-replica' WHERE id = NEW.run_id;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_steal_lease_on_confirmed_trg
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_steal_lease_on_confirmed();
`;
const DROP_STEAL_ON_CONFIRMED_TRIGGER = `
DROP TRIGGER IF EXISTS test_steal_lease_on_confirmed_trg ON events;
DROP FUNCTION IF EXISTS test_steal_lease_on_confirmed();
`;

/**
 * Seed a pending agent-ask run + its pending approval card, exactly the shape
 * `queueAgentAsk` produces (legacy ask: no input_schema_validation_version, so
 * approve's validateInput passes without schema enforcement).
 */
async function seedAgentAskRun(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, action_input,
			created_by_user_id, approval_status, status, created_at
		) VALUES (
			${organizationId}, 'internal', 'agent_ask',
			${sql.json({
				question: "Should we ship the staging change?",
				input_schema: { type: "object" },
			})},
			${userId}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_pending`,
		title: "Should we ship the staging change?",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		interactionInputSchema: { type: "object" },
		metadata: {
			tool: "notify",
			action_key: "agent_ask",
			question: "Should we ship the staging change?",
			status: "pending_approval",
			run_id: runId,
		},
		authorName: "agent",
	});
	return runId;
}

/**
 * A pending `manage_agents` builder run whose apply is guaranteed to THROW:
 * the `delete` variant requires `agent_id`, so re-validating the persisted
 * proposal fails, and the family's `isValidProposal` only checks the proposal
 * is non-null — the run claims cleanly and then fails in the out-of-transaction
 * apply, the window `failBuilderRun` writes back into.
 */
async function seedThrowingBuilderRun(
	organizationId: string,
	userId: string,
): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql`
		INSERT INTO runs (
			organization_id, run_type, action_key, action_input,
			created_by_user_id, approval_status, status, created_at
		) VALUES (
			${organizationId}, 'internal', 'manage_agents',
			${sql.json({ action: "delete" })},
			${userId}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`;
	const runId = Number(run.id);
	await insertEvent({
		entityIds: [],
		organizationId,
		originId: `run_${runId}_pending`,
		title: "Agent: delete undefined — pending",
		content: null,
		semanticType: "operation",
		runId,
		interactionType: "approval",
		interactionStatus: "pending",
		metadata: { action_key: "manage_agents", run_id: runId },
		authorName: "agent",
	});
	return runId;
}

/** Minimal worker context for driving the REAL completeActionRun handler. */
function mockWorkerCtx(body: unknown): {
	ctx: Context<{ Bindings: Env }>;
	result: () => { body: unknown; status: number };
} {
	let captured: { body: unknown; status: number } = {
		body: undefined,
		status: 200,
	};
	const ctx = {
		req: { json: async () => body },
		var: {},
		json: (b: unknown, status?: number) => {
			captured = { body: b, status: status ?? 200 };
			return captured as unknown as Response;
		},
	} as unknown as Context<{ Bindings: Env }>;
	return { ctx, result: () => captured };
}

async function currentApprovalCard(
	runId: number,
	organizationId: string,
): Promise<{ interaction_status: string } | undefined> {
	const rows = await getTestDb()<{ interaction_status: string }>`
		SELECT interaction_status FROM current_event_records
		WHERE run_id = ${runId} AND organization_id = ${organizationId}
			AND semantic_type = 'operation' AND interaction_type = 'approval'
	`;
	return rows[0];
}

describe("approval-run transition atomicity", () => {
	let orgId: string;
	let userId: string;
	let humanCtx: ToolContext;
	let connectionId: number;
	// Same connector, `create_item` set to `auto`: `execute` runs the operation
	// inline with no approval round-trip, the other path that takes a lease.
	let autoConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user } = await seedOwnerContext({
			orgName: "Approval Transition Org",
		});
		orgId = org.id;
		userId = user.id;
		humanCtx = ownerToolContext(orgId, userId);
		humanCtx.baseUrl = "https://gateway.test/lobu";

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Approval Transition",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET openapi_config = ${sql.json({
				specUrl: "https://api.example.test/openapi.json",
				serverUrl: "https://api.example.test",
			})}
			WHERE organization_id = ${orgId} AND key = ${CONNECTOR}
		`;

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "approval" } },
		});
		connectionId = conn.id;

		const accountId = `acct_${connectionId}_transition`;
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
			displayName: "transition test OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: userId,
		});
		await sql`
			UPDATE connections
			SET auth_profile_id = ${profile.id}
			WHERE id = ${connectionId}
		`;

		const autoConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "auto" } },
		});
		autoConnectionId = autoConn.id;
		await sql`
			UPDATE connections
			SET auth_profile_id = ${profile.id}
			WHERE id = ${autoConnectionId}
		`;

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					const url = String(input);
					if (url === "https://api.example.test/openapi.json") {
						return new Response(
							JSON.stringify({
								openapi: "3.0.0",
								servers: [{ url: "https://api.example.test" }],
								paths: {
									"/items": {
										post: {
											operationId: "create_item",
											requestBody: {
												content: {
													"application/json": {
														schema: { type: "object" },
													},
												},
											},
											responses: { "200": { description: "ok" } },
										},
									},
								},
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					}
					if (url === "https://api.example.test/items") {
						postItemsCalls += 1;
						if (duringExternalCall) {
							const hook = duringExternalCall;
							duringExternalCall = null;
							await hook();
						}
						if (throwOnPostItems) {
							throwOnPostItems = false;
							throw new Error("upstream socket hang up");
						}
						return new Response(JSON.stringify({ created: true }), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					throw new Error(`Unexpected fetch: ${url}`);
				},
			),
		);
	});

	afterEach(async () => {
		duringExternalCall = null;
		throwOnPostItems = false;
		await getTestDb().unsafe(DROP_STEAL_ON_CONFIRMED_TRIGGER);
		// Always drop the failure triggers so they can't leak into other tests
		// that share this DB under the suite's single-fork registry.
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_PENDING_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	afterAll(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_PENDING_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
		vi.unstubAllGlobals();
	});

	it("terminal event write failure rolls back the run's completed state", async () => {
		const sql = getTestDb();
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "transition-test" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string; event_id: number };
		expect(queued.status).toBe("pending_approval");

		// Before the approve, the card is pending (the queue path is already atomic).
		const before = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(before[0]?.interaction_status).toBe("pending");

		// Force ONLY the terminal 'completed' card INSERT to fail; the 'confirmed'
		// event must still write so the failure is isolated to the terminal phase.
		await sql.unsafe(FAIL_COMPLETED_TRIGGER);

		await expect(
			manageOperations(
				{ action: "approve", run_id: queued.run_id },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		// RED today: the `runs.status='completed'` write commits before the card
		// INSERT throws, so the run is left terminal-completed while the card is
		// stuck at 'confirmed'. GREEN after the fix: both writes share one
		// transaction, so the terminal state rolls back and the run is NOT
		// completed (or failed) — it stays in the approved/running claim state.
		const [run] = await sql`
			SELECT approval_status, status, action_output
			FROM runs
			WHERE id = ${queued.run_id} AND organization_id = ${orgId}
		`;
		expect(run.status).not.toBe("completed");
		expect(run.status).not.toBe("failed");
		expect(run.approval_status).toBe("approved");

		// No completed card was ever written; the card stays at the confirmed
		// claim — consistent with a run that never reached terminal state.
		const [card] = await sql`
			SELECT interaction_status FROM current_event_records
			WHERE run_id = ${queued.run_id} AND organization_id = ${orgId}
				AND semantic_type = 'operation' AND interaction_type = 'approval'
		`;
		expect(card?.interaction_status).toBe("approved");
	});

	it("builder completion card failure does NOT convert a successful apply into a business failure", async () => {
		const sql = getTestDb();
		const runId = await seedAgentAskRun(orgId, userId);

		// Force ONLY the terminal 'completed' card INSERT to fail; the 'confirmed'
		// claim must still succeed so the failure lands in phase 2 (after apply).
		await sql.unsafe(FAIL_COMPLETED_TRIGGER);

		// The apply (agent-ask returns the human's answer) SUCCEEDED — only the
		// terminal card persistence failed. The persistence error must propagate,
		// not be re-recorded as a business 'failed' via failBuilderRun.
		await expect(
			manageOperations(
				{ action: "approve", run_id: runId, input: { decision: "ship it" } },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		const [run] = await sql`
			SELECT approval_status, status, action_output
			FROM runs WHERE id = ${runId} AND organization_id = ${orgId}
		`;
		// The claim committed (approved/running) and phase 2 rolled back: the run
		// is NOT marked 'failed' (a false business failure) and NOT 'completed'.
		expect(run.status).not.toBe("failed");
		expect(run.status).not.toBe("completed");
		expect(run.status).toBe("running");
		expect(run.approval_status).toBe("approved");
		// The successful apply result (the human's ANSWER) is the entire outcome
		// of an agent_ask — it must have been persisted DURABLY before the
		// terminalization attempt, so a failed card write cannot lose it.
		// (RED today: it rolls back with the completed write and reads null.)
		expect(run.action_output).toEqual({ answer: { decision: "ship it" } });

		// Card is still the 'confirmed' claim — no completed card, no failed card.
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("agent_ask: a retry after a card-write failure completes the run without losing the answer", async () => {
		const sql = getTestDb();
		const runId = await seedAgentAskRun(orgId, userId);

		await sql.unsafe(FAIL_COMPLETED_TRIGGER);
		await expect(
			manageOperations(
				{ action: "approve", run_id: runId, input: { decision: "ship it" } },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		// The run is stuck in the claimed state with the answer durably retained.
		const [stuck] = await sql`
			SELECT status, action_output FROM runs WHERE id = ${runId}
		`;
		expect(stuck.status).toBe("running");
		expect(stuck.action_output).toEqual({ answer: { decision: "ship it" } });

		// Drop the failure trigger; a re-approve must RECONCILE the stuck run —
		// terminalize it from the durable output — instead of reporting "not
		// pending approval" (RED today: the run can never be approved again).
		await sql.unsafe(DROP_FAIL_TRIGGER);
		const retried = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };
		expect(retried.error).toBeUndefined();
		expect(retried.approved).toBe(true);

		const [run] = await sql`
			SELECT status, action_output FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("completed");
		expect(run.action_output).toEqual({ answer: { decision: "ship it" } });
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"completed",
		);
	});

	it("inline action: a card-write failure retains the output and a retry completes WITHOUT re-executing the mutation", async () => {
		const sql = getTestDb();
		const postItemsBefore = postItemsCalls;
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "retry-no-rexec" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number };
		expect(queued.status).toBe("pending_approval");

		await sql.unsafe(FAIL_COMPLETED_TRIGGER);
		await expect(
			manageOperations(
				{ action: "approve", run_id: queued.run_id },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/terminal approval-event write failure/);

		// The external POST ran exactly once and its result was retained.
		expect(postItemsCalls).toBe(postItemsBefore + 1);
		const [stuck] = await sql`
			SELECT status, approval_status, action_output FROM runs WHERE id = ${queued.run_id}
		`;
		expect(stuck.status).toBe("running");
		expect(stuck.approval_status).toBe("approved");
		expect(stuck.action_output).toEqual({ body: { created: true } });

		// Re-approve after the trigger is gone: the run completes from the
		// durable output — the external mutation is NOT repeated.
		await sql.unsafe(DROP_FAIL_TRIGGER);
		const retried = (await manageOperations(
			{ action: "approve", run_id: queued.run_id },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };
		expect(retried.error).toBeUndefined();
		expect(retried.approved).toBe(true);

		expect(postItemsCalls).toBe(postItemsBefore + 1);
		const [run] = await sql`
			SELECT status, action_output FROM runs WHERE id = ${queued.run_id}
		`;
		expect(run.status).toBe("completed");
		expect(run.action_output).toEqual({ body: { created: true } });
		expect((await currentApprovalCard(queued.run_id, orgId))?.interaction_status).toBe(
			"completed",
		);
	});

	it("auto-mode execute reports the lost lease instead of overwriting the run", async () => {
		const sql = getTestDb();
		const postItemsBefore = postItemsCalls;
		// An auto-mode `execute` claims the run in the same INSERT that sets it
		// `running`, so the lease is already held when the external call goes
		// out. The run id is not knowable before that INSERT, so the thief
		// targets the connection's one running run.
		duringExternalCall = async () => {
			await sql`
				UPDATE runs SET claimed_by = ${THIEF}
				WHERE connection_id = ${autoConnectionId}
					AND run_type = 'action'
					AND status = 'running'
			`;
		};
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: autoConnectionId,
				operation_key: "create_item",
				input: { body: { value: "auto-stolen-lease" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string; error_message?: string };

		expect(postItemsCalls).toBe(postItemsBefore + 1);
		expect(result.status).toBe("failed");
		expect(result.error_message).toMatch(/lost its run lease/i);

		const [run] = await sql`
			SELECT status, claimed_by, action_output, completed_at
			FROM runs WHERE id = ${result.run_id}
		`;
		expect(run.claimed_by).toBe(THIEF);
		expect(run.status).toBe("running");
		expect(run.action_output).toBeNull();
		expect(run.completed_at).toBeNull();
	});

	it("approve does not overwrite a run whose lease was stolen mid-execution", async () => {
		const sql = getTestDb();
		const postItemsBefore = postItemsCalls;
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "stolen-lease" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number };
		expect(queued.status).toBe("pending_approval");

		// Approve claims the run under a `gateway-inline-<uuid>` owner. The POST
		// then hands it to another owner before the terminal write lands.
		duringExternalCall = async () => {
			await sql`UPDATE runs SET claimed_by = ${THIEF} WHERE id = ${queued.run_id}`;
		};
		const approved = (await manageOperations(
			{ action: "approve", run_id: queued.run_id },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };

		// The external mutation still ran exactly once — the fence guards the
		// WRITE-BACK, not the call.
		expect(postItemsCalls).toBe(postItemsBefore + 1);
		expect(approved.approved).toBeUndefined();
		expect(approved.error).toMatch(/already decided while this request was in flight/i);

		const [run] = await sql`
			SELECT status, claimed_by, action_output, completed_at
			FROM runs WHERE id = ${queued.run_id}
		`;
		// Neither phase wrote: the durable output stays untouched and the run is
		// left to whoever holds it now.
		expect(run.claimed_by).toBe(THIEF);
		expect(run.status).toBe("running");
		expect(run.action_output).toBeNull();
		expect(run.completed_at).toBeNull();
		expect((await currentApprovalCard(queued.run_id, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("a THROWN external call does not overwrite a run whose lease moved", async () => {
		const sql = getTestDb();
		// A thrown request terminalizes through `failRun`, the last unfenced
		// terminal write on the inline path: it fired on id + organization_id
		// alone, so it relabelled whatever the new owner had already recorded.
		throwOnPostItems = true;
		duringExternalCall = async () => {
			await sql`
				UPDATE runs SET claimed_by = ${THIEF}
				WHERE connection_id = ${autoConnectionId}
					AND run_type = 'action'
					AND status = 'running'
			`;
		};
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: autoConnectionId,
				operation_key: "create_item",
				input: { body: { value: "auto-thrown-stolen" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string; error_message?: string };

		expect(result.status).toBe("failed");
		expect(result.error_message).toMatch(/lost its run lease/i);
		const [run] = await sql`
			SELECT status, claimed_by, error_message, completed_at
			FROM runs WHERE id = ${result.run_id}
		`;
		expect(run.claimed_by).toBe(THIEF);
		expect(run.status).toBe("running");
		expect(run.error_message).toBeNull();
		expect(run.completed_at).toBeNull();
	});

	it("a THROWN external call still terminalizes a run its owner still holds", async () => {
		const sql = getTestDb();
		throwOnPostItems = true;
		const result = (await manageOperations(
			{
				action: "execute",
				connection_id: autoConnectionId,
				operation_key: "create_item",
				input: { body: { value: "auto-thrown-kept" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string; error_message?: string };

		// The fence blocks a LOST lease, never the ordinary failure path.
		expect(result.status).toBe("failed");
		expect(result.error_message).toMatch(/socket hang up/i);
		const [run] = await sql`
			SELECT status, error_message FROM runs WHERE id = ${result.run_id}
		`;
		expect(run.status).toBe("failed");
		expect(String(run.error_message)).toMatch(/socket hang up/i);
	});

	it("approve does not record a FAILURE on a run whose lease was stolen", async () => {
		const sql = getTestDb();
		const queued = (await manageOperations(
			{
				action: "execute",
				connection_id: connectionId,
				operation_key: "create_item",
				input: { body: { value: "approve-fail-stolen" } },
			},
			{} as Env,
			humanCtx,
		)) as { run_id: number; status: string };
		expect(queued.status).toBe("pending_approval");

		// deferTerminalWrite means the inline execution wrote nothing, so
		// handleApprove's failure lane is the ONLY terminal write for this run.
		throwOnPostItems = true;
		duringExternalCall = async () => {
			await sql`UPDATE runs SET claimed_by = ${THIEF} WHERE id = ${queued.run_id}`;
		};
		const approved = (await manageOperations(
			{ action: "approve", run_id: queued.run_id },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };

		expect(approved.approved).toBeUndefined();
		expect(approved.error).toMatch(
			/already decided while this request was in flight/i,
		);
		const [run] = await sql`
			SELECT status, claimed_by, error_message, completed_at
			FROM runs WHERE id = ${queued.run_id}
		`;
		expect(run.claimed_by).toBe(THIEF);
		expect(run.status).toBe("running");
		expect(run.error_message).toBeNull();
		expect(run.completed_at).toBeNull();
		// The card must NOT be superseded to 'failed' on a run we no longer own.
		expect(
			(await currentApprovalCard(queued.run_id, orgId))?.interaction_status,
		).toBe("approved");
	});

	it("a failed builder apply does not overwrite a run whose lease was stolen", async () => {
		const sql = getTestDb();
		const runId = await seedThrowingBuilderRun(orgId, userId);
		await sql.unsafe(STEAL_ON_CONFIRMED_TRIGGER);

		const result = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; error?: string };

		expect(result.approved).toBeUndefined();
		expect(result.error).toMatch(
			/already decided while this request was in flight/i,
		);
		const [run] = await sql`
			SELECT status, claimed_by, error_message, completed_at
			FROM runs WHERE id = ${runId}
		`;
		expect(run.claimed_by).toBe(THIEF);
		expect(run.status).toBe("running");
		expect(run.error_message).toBeNull();
		expect(run.completed_at).toBeNull();
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("a failed builder apply terminalizes a run its owner still holds", async () => {
		const sql = getTestDb();
		const runId = await seedThrowingBuilderRun(orgId, userId);

		const result = (await manageOperations(
			{ action: "approve", run_id: runId },
			{} as Env,
			humanCtx,
		)) as { approved?: boolean; message?: string; error?: string };

		expect(result.error).toBeUndefined();
		expect(result.approved).toBe(true);
		expect(result.message).toMatch(/approved but failed/i);
		const [run] = await sql`
			SELECT status, claimed_by, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("failed");
		expect(String(run.claimed_by)).toMatch(/^gateway-inline-/);
		expect(String(run.error_message)).toMatch(/Invalid arguments for manage_agents: .*agent_id/);
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"failed",
		);
	});

	it("queueAgentAsk run + pending card commit atomically (card failure leaves no run)", async () => {
		const sql = getTestDb();
		const runsBefore = await sql`
			SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND run_type = 'internal'
		`;
		const eventsBefore = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId} AND interaction_type = 'approval'
		`;

		await sql.unsafe(FAIL_PENDING_TRIGGER);
		await expect(
			queueAgentAsk({
				ctx: humanCtx,
				question: "Queue-path atomicity check",
				body: null,
				inputSchema: { type: "object" },
			}),
		).rejects.toThrow(/pending approval-event write failure/);

		// The run INSERT shared the rolled-back transaction: no stranded pending
		// run and no orphaned card.
		const runsAfter = await sql`
			SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND run_type = 'internal'
		`;
		expect(runsAfter[0].n).toBe(runsBefore[0].n);
		const eventsAfter = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId} AND interaction_type = 'approval'
		`;
		expect(eventsAfter[0].n).toBe(eventsBefore[0].n);
	});

	it("reject on a run with no approval card fails closed — the cancelled run write rolls back", async () => {
		const sql = getTestDb();
		// Corruption case: a pending connector-operation run whose approval card
		// was never written (bypasses the #2033 atomic queue). The reject must
		// NOT commit the cancelled write without a card.
		const [run] = await sql`
			INSERT INTO runs (
				organization_id, run_type, status, approval_status, action_key, created_at
			) VALUES (
				${orgId}, 'action', 'pending', 'pending', 'create_issue', NOW()
			)
			RETURNING id
		`;
		const runId = Number(run.id);

		await expect(
			manageOperations(
				{ action: "reject", run_id: runId, reason: "no card" },
				{} as Env,
				humanCtx,
			),
		).rejects.toThrow(/approval card is missing/);

		// The cancelled write shared the rolled-back transaction (the guard runs
		// INSIDE it): the run is still pending/pending, not cancelled.
		const [row] = await sql`
			SELECT approval_status, status FROM runs WHERE id = ${runId}
		`;
		expect(row.approval_status).toBe("pending");
		expect(row.status).toBe("pending");
	});

	it("approval queueing is serialized against connection deletion (no approval lands in the gap)", async () => {
		// A delete holds the exclusive connection-row lock across its tombstone +
		// approval-expiry transaction. The queue path must take a SHARE lock on
		// the same row before inserting a pending approval run, so an approval
		// cannot commit into the gap between the delete's expiry scan and its
		// tombstone. (RED today: the queue's run INSERT only serializes via the
		// runs.connection_id FK, which lets the insert commit AFTER the tombstone
		// — a pending approval hidden behind a deleted connection, never expired.)
		const lockConn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
			config: { action_modes: { create_item: "approval" } },
		});

		const locker = postgres(process.env.DATABASE_URL as string, { max: 1 });
		let executePromise: Promise<Record<string, unknown>> | undefined;
		let outcome: Record<string, unknown> | undefined;
		try {
			await locker.begin(async (tx) => {
				// Simulate an in-flight delete holding the exclusive lock.
				await tx`
					SELECT 1 FROM connections
					WHERE id = ${lockConn.id} AND organization_id = ${orgId}
						AND deleted_at IS NULL
					FOR UPDATE
				`;

				// A queue request races the delete. It is NOT awaited inside the
				// delete transaction: its connection-row lock (or the FK's
				// key-share lock) blocks until the delete commits, and the delete
				// must not wait on it or the pair deadlocks.
				executePromise = manageOperations(
					{
						action: "execute",
						connection_id: lockConn.id,
						operation_key: "create_item",
						input: { body: { value: "lock-gap" } },
					},
					{} as Env,
					humanCtx,
				).then(
					(result) => ({ ok: result as Record<string, unknown> }),
					(error) => ({ rejected: String((error as Error).message) }),
				);

				// Let the queue attempt to land while the delete holds its lock.
				await new Promise((resolve) => setTimeout(resolve, 200));

				// The delete commits its tombstone; only then may the queue
				// proceed — and it must be refused because the connection is gone.
				await tx`
					UPDATE connections
					SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
					WHERE id = ${lockConn.id}
				`;
			});
			// locker.begin committed here: the FOR UPDATE is released and the
			// queue either completed (RED) or was refused (GREEN).
			outcome = await executePromise;
		} finally {
			await locker.end();
		}
		// The queue did NOT create a pending approval on the deleted connection:
		// either an error result or a rejection is the accepted outcome.
		const record = (outcome ?? {}) as Record<string, unknown>;
		expect("rejected" in record || "error" in record).toBe(true);

		const runs = await getTestDb()`
			SELECT count(*)::int AS n FROM runs
			WHERE connection_id = ${lockConn.id}
				AND run_type = 'action'
				AND approval_status = 'pending'
		`;
		expect(runs[0].n).toBe(0);
	});
});

describe("worker completeActionRun card atomicity", () => {
	let orgId: string;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "complete action atomicity" });
		orgId = org.id;
		const [conn] = (await getTestDb()`
			INSERT INTO connections (
				organization_id, connector_key, status, visibility, slug,
				created_at, updated_at
			) VALUES (
				${orgId}, 'chrome', 'active', 'org', 'complete-action-test', NOW(), NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		connectionId = Number(conn.id);
	});

	afterEach(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	afterAll(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
		await getTestDb().unsafe(DROP_FAIL_FAILED_TRIGGER);
	});

	async function seedClaimedRun(opts: {
		approvalStatus: string;
		withCard: boolean;
	}): Promise<number> {
		const sql = getTestDb();
		const [run] = (await sql`
			INSERT INTO runs (
				organization_id, run_type, connection_id, connector_key,
				connector_version, action_key, approval_status, status,
				claimed_by, claimed_at, created_at
			) VALUES (
				${orgId}, 'action', ${connectionId}, 'chrome',
				'0.2.0', 'navigate', ${opts.approvalStatus}, 'running',
				'worker-complete-test', NOW(), NOW()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const runId = Number(run.id);
		if (opts.withCard) {
			await insertEvent({
				entityIds: [],
				organizationId: orgId,
				originId: `run_${runId}_confirmed`,
				title: "navigate — executing",
				content: null,
				semanticType: "operation",
				connectorKey: "chrome",
				runId,
				interactionType: "approval",
				interactionStatus: "approved",
				interactionInputSchema: null,
				metadata: {
					action_key: "navigate",
					status: "confirmed",
					run_id: runId,
				},
				authorName: "agent",
			});
		}
		return runId;
	}

	it("auto/no-approval run finalizes normally with no card (worker action preserved)", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "auto",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { success?: boolean }).success).toBe(true);

		const [run] = await getTestDb()`
			SELECT status, action_output FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("completed");
		expect(run.action_output).toEqual({ ok: true });
	});

	it("strips NUL bytes from worker action output before persisting it", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "auto",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: {
				["std\u0000out"]: "before\u0000after",
				nested: ["x\u0000y"],
			},
		});
		await completeActionRun(ctx);
		expect((result().body as { success?: boolean }).success).toBe(true);

		const [run] = await getTestDb()`
			SELECT status, action_output FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("completed");
		expect(run.action_output).toEqual({
			stdout: "beforeafter",
			nested: ["xy"],
		});
	});

	it("strips NUL bytes from worker action errors before persisting them", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "auto",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "failed",
			error_message: "Bad\u0000 file descriptor",
		});
		await completeActionRun(ctx);
		expect((result().body as { success?: boolean }).success).toBe(true);

		const [run] = await getTestDb()`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("failed");
		expect(run.error_message).toBe("Bad file descriptor");
	});

	it("approval run terminal card write failure rolls the terminal state back", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});
		await getTestDb().unsafe(FAIL_COMPLETED_TRIGGER);

		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { error?: string }).error).toMatch(
			/terminal approval-event write failure/,
		);
		expect(result().status).toBe(500);

		// The finalizeRun write shared the rolled-back transaction: the run is
		// still running (not completed) and the card is untouched.
		const [run] = await getTestDb()`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});

	it("approval run with a missing card fails closed (terminal state rolled back)", async () => {
		// Corruption case: approval-gated run whose card was never written or was
		// lost. The completion must NOT commit the terminal state without a card.
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: false,
		});
		const { ctx, result } = mockWorkerCtx({
			run_id: runId,
			worker_id: "worker-complete-test",
			status: "success",
			action_output: { ok: true },
		});
		await completeActionRun(ctx);
		expect((result().body as { error?: string }).error).toMatch(
			/approval card is missing/,
		);
		expect(result().status).toBe(500);

		const [run] = await getTestDb()`
			SELECT status FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
	});

	it("worker pre-dispatch failure supersedes the approved card atomically", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});

		const changed = await failClaimedWorkerRun({
			runId,
			workerId: "worker-complete-test",
			errorMessage: "connector code unavailable",
		});

		expect(changed).toBe(true);
		const [run] = await getTestDb()`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("failed");
		expect(run.error_message).toBe("connector code unavailable");
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"failed",
		);
	});

	it("worker pre-dispatch failure rolls back when the failed card write fails", async () => {
		const runId = await seedClaimedRun({
			approvalStatus: "approved",
			withCard: true,
		});
		await getTestDb().unsafe(FAIL_FAILED_TRIGGER);

		await expect(
			failClaimedWorkerRun({
				runId,
				workerId: "worker-complete-test",
				errorMessage: "connector code unavailable",
			}),
		).rejects.toThrow(/failed approval-event write failure/);

		const [run] = await getTestDb()`
			SELECT status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(run.status).toBe("running");
		expect(run.error_message).toBeNull();
		expect((await currentApprovalCard(runId, orgId))?.interaction_status).toBe(
			"approved",
		);
	});
});
