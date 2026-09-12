/**
 * #2033 item 16 — cross-org approval event never persisted → stranded pending run.
 *
 * The queued approval path must write the run and its pending approval EVENT in
 * ONE transaction. If the event write fails, the run must NOT exist (no stranded
 * pending run that the events-only /memory page can never surface). The happy
 * path must durably create both and the event must be readable by run id.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
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

const CONNECTOR = "demo.ops.approval.atomic";

// Force a REAL failure of the approval-event INSERT from inside the tx by
// installing a BEFORE INSERT trigger on `events` that raises. This exercises
// the exact atomicity path (insertEvent throws inside sql.begin) without module
// mocking — which is unsafe under this suite's `isolate:false` shared registry.
const FAIL_TRIGGER = `
CREATE OR REPLACE FUNCTION test_fail_approval_event() RETURNS trigger AS $fn$
BEGIN
  IF NEW.interaction_type = 'approval' THEN
    RAISE EXCEPTION 'simulated approval-event write failure';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER test_fail_approval_event_trg
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION test_fail_approval_event();
`;
const DROP_FAIL_TRIGGER = `
DROP TRIGGER IF EXISTS test_fail_approval_event_trg ON events;
DROP FUNCTION IF EXISTS test_fail_approval_event();
`;

describe("approval-event atomicity (item 16)", () => {
	let orgId: string;
	let userId: string;
	let ctx: ToolContext;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, user, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Approval Atomicity Org",
		});
		ownerCtx.baseUrl = "https://gateway.test/lobu";
		ownerCtx.mcpSessionId = "session-approval-atomicity";
		orgId = org.id;
		userId = user.id;
		ctx = ownerCtx;

		await createTestConnectorDefinition({
			key: CONNECTOR,
			name: "Approval Atomic",
			organization_id: orgId,
			auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
		});

		const sql = getTestDb();
		await sql`
			UPDATE connector_definitions
			SET actions_schema = ${sql.json({
				needs_approval: {
					name: "Needs approval",
					kind: "write",
					requiresApproval: true,
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
					async execute(ctx) { return { success: true, output: {} }; }
				}
				module.exports = { ConnectorRuntime };
			`}
			WHERE connector_key = ${CONNECTOR}
		`;

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: CONNECTOR,
			created_by: userId,
			visibility: "private",
		});
		connectionId = conn.id;

		const accountId = `acct_${connectionId}_approval`;
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
			displayName: "approval test OAuth",
			profileKind: "oauth_account",
			provider: "test",
			accountId,
			status: "active",
			createdBy: userId,
		});
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connectionId}`;
	});

	afterEach(async () => {
		// Always drop the failure trigger so it can't leak into other tests that
		// share this DB under the suite's single-fork registry.
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
	});

	afterAll(async () => {
		await getTestDb().unsafe(DROP_FAIL_TRIGGER);
	});

	it("happy path: run + approval event committed atomically and event is readable by run id", async () => {
		const sql = getTestDb();
		const before = await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR}`;

		const result = (await manageOperations(
			{ action: "execute", connection_id: connectionId, operation_key: "needs_approval", input: {} },
			{} as Env,
			ctx,
		)) as { status: string; run_id: number; event_id: number; approval_url?: string };

		expect(result.status).toBe("pending_approval");
		expect(result.run_id).toBeGreaterThan(0);
		expect(result.event_id).toBeGreaterThan(0);
		expect(result.approval_url).toBeTruthy();

		// The run exists and is pending.
		const runRows = await sql`
			SELECT status, approval_status, created_by_user_id
			FROM runs
			WHERE id = ${result.run_id} AND organization_id = ${orgId}
		`;
		expect(runRows).toHaveLength(1);
		expect(runRows[0].status).toBe("pending");
		expect(runRows[0].approval_status).toBe("pending");
		expect(runRows[0].created_by_user_id).toBe(userId);

		// The approval event exists, is org-scoped, and joins to the run — this is
		// what the /memory?run_ids= page reads. A stranded run would have none.
		const eventRows = await sql`
			SELECT id, interaction_type, interaction_status, organization_id, metadata
			FROM events
			WHERE run_id = ${result.run_id} AND organization_id = ${orgId}
		`;
		expect(eventRows).toHaveLength(1);
		expect(eventRows[0].id).toBe(result.event_id);
		expect(eventRows[0].interaction_type).toBe("approval");
		expect(eventRows[0].interaction_status).toBe("pending");
		expect(eventRows[0].organization_id).toBe(orgId);
		expect(eventRows[0].metadata).toMatchObject({
			mcp_session_id: "session-approval-atomicity",
			initiator: { kind: "user", user_id: userId },
		});

		const after = await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR}`;
		expect(after[0].n).toBe(before[0].n + 1);
	});

	it("event write failure rolls back the run — no orphaned pending run, no event", async () => {
		const sql = getTestDb();
		const before = await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR}`;
		const eventsBefore = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'approval'
			  AND connector_key = ${CONNECTOR}
		`;

		await sql.unsafe(FAIL_TRIGGER);
		await expect(
			manageOperations(
				{ action: "execute", connection_id: connectionId, operation_key: "needs_approval", input: {} },
				{} as Env,
				ctx,
			),
		).rejects.toThrow(/approval-event write failure/);

		// The run INSERT shared the rolled-back transaction: no new run row.
		const after = await sql`SELECT count(*)::int AS n FROM runs WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR}`;
		expect(after[0].n).toBe(before[0].n);

		// And NO new approval event was written (the failed insert rolled back with
		// the run; the only pre-existing one is the happy-path event from test 1).
		const eventsAfter = await sql`
			SELECT count(*)::int AS n FROM events
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'approval'
			  AND connector_key = ${CONNECTOR}
		`;
		expect(eventsAfter[0].n).toBe(eventsBefore[0].n);
	});
});
