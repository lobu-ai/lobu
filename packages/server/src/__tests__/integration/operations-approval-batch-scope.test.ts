/**
 * Scoped bulk approve/reject over queued connector-operation approvals.
 *
 * `approve_batch` / `reject_batch` already existed for one source run in the
 * Automation-proposal lane (`run_type='internal'`).
 * The lane that actually accumulates undecided rows, queued connector operations
 * (`run_type='action'`), had no bulk action at all: an operator had to decide
 * them one at a time or leave them pending forever.
 *
 * These tests pin the added `scope` target and — more importantly — the guards
 * that keep it safe. Batch APPROVE fires real side effects en masse, so the
 * contract is: it acts on the scoped set ONLY, it refuses to run unscoped, and
 * it inherits the exact same authz as deciding one run.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestSession,
	createTestUser,
	seedOwnerContext,
} from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";

const APPROVAL_CONNECTOR = "demo.batch.approval";

describe("manage_operations batch scope (connector-approval lane)", () => {
	let orgId: string;
	let orgSlug: string;
	let ownerCtx: ToolContext;
	let memberCtx: ToolContext;
	let approvalConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx } = await seedOwnerContext({
			orgName: "Batch Scope Org",
		});
		orgId = org.id;
		orgSlug = org.slug;
		ownerCtx = ctx;
		const member = await createTestUser({ name: "Batch Scope Member" });
		await addUserToOrganization(member.id, org.id);
		memberCtx = {
			...ctx,
			userId: member.id,
			memberRole: "member",
			scopes: ["mcp:read", "mcp:write"],
		};

		await createTestConnectorDefinition({
			key: APPROVAL_CONNECTOR,
			name: "Batch approval connector",
			organization_id: org.id,
		});
		const sql = getTestDb();
		await sql`
      UPDATE connector_definitions
      SET actions_schema = ${sql.json({
				needs_approval: {
					name: "Needs approval",
					kind: "write",
				},
			})}
      WHERE organization_id = ${org.id}
        AND key = ${APPROVAL_CONNECTOR}
    `;
		const connection = await createTestConnection({
			organization_id: org.id,
			connector_key: APPROVAL_CONNECTOR,
			created_by: ctx.userId ?? undefined,
		});
		approvalConnectionId = connection.id;
	});

	beforeEach(async () => {
		const sql = getTestDb();
		await sql`DELETE FROM runs WHERE organization_id = ${orgId}`;
	});

	/** Seed a pending connector-operation approval with the given shape. */
	async function seedPendingAction(opts: {
		connectorKey: string;
		actionKey: string;
		ageDays?: number;
		automationId?: number;
		connectionId?: number;
	}): Promise<number> {
		const sql = getTestDb();
		const rows = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status,
        connection_id, connector_key, action_key, policy_principal_kind,
        policy_principal_id, created_at
      ) VALUES (
        ${orgId}, 'action', 'pending', 'pending',
        ${opts.connectionId ?? null},
        ${opts.connectorKey}, ${opts.actionKey},
        ${opts.automationId === undefined ? "user" : "automation"},
        ${opts.automationId === undefined ? null : `automation:${opts.automationId}`},
        NOW() - (${opts.ageDays ?? 0}::int * interval '1 day')
      )
      RETURNING id
    `;
		const runId = Number(rows[0].id);
		// Production queued approvals always carry their pending card (the #2033
		// queue path writes run + card in one transaction), so a decided run must
		// have one here too — the transition supersedes it.
		const cardTitle = `${opts.actionKey} — pending approval`;
		await sql`
      INSERT INTO events (
        organization_id, origin_id, title, payload_text, run_id,
        semantic_type, interaction_type, interaction_status
      ) VALUES (
        ${orgId}, ${`run_${runId}_pending`}, ${cardTitle},
        'Awaiting review', ${runId}, 'operation', 'approval', 'pending'
      )
    `;
		return runId;
	}

	async function approvalStatusOf(runId: number): Promise<string> {
		const sql = getTestDb();
		const rows = await sql`
      SELECT approval_status FROM runs WHERE id = ${runId}
    `;
		return String(rows[0]?.approval_status ?? "missing");
	}

	it("reject_batch acts on the scoped set ONLY and leaves out-of-scope rows pending", async () => {
		const inScopeA = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});
		const inScopeB = await seedPendingAction({
			connectorKey: "github",
			actionKey: "close_issue",
		});
		// Same org, DIFFERENT connector — must survive a github-scoped batch.
		const otherConnector = await seedPendingAction({
			connectorKey: "linear",
			actionKey: "create_issue",
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				scope: { connector_key: "github" },
				reason: "stale queue",
			},
			{} as Env,
			ownerCtx,
		)) as { action: string; rejected_count: number; run_ids: number[] };

		expect(result.action).toBe("reject_batch");
		expect(result.rejected_count).toBe(2);
		expect(result.run_ids.sort()).toEqual([inScopeA, inScopeB].sort());

		expect(await approvalStatusOf(inScopeA)).toBe("rejected");
		expect(await approvalStatusOf(inScopeB)).toBe("rejected");
		// The out-of-scope row is untouched — this is the whole safety property.
		expect(await approvalStatusOf(otherConnector)).toBe("pending");
	});

	it("action_key narrows within a connector", async () => {
		const target = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});
		const sibling = await seedPendingAction({
			connectorKey: "github",
			actionKey: "close_issue",
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				scope: { connector_key: "github", action_key: "create_issue" },
			},
			{} as Env,
			ownerCtx,
		)) as { rejected_count: number };

		expect(result.rejected_count).toBe(1);
		expect(await approvalStatusOf(target)).toBe("rejected");
		expect(await approvalStatusOf(sibling)).toBe("pending");
	});

	it("approve_batch applies only the connector operations selected by scope", async () => {
		const target = await seedPendingAction({
			connectionId: approvalConnectionId,
			connectorKey: APPROVAL_CONNECTOR,
			actionKey: "needs_approval",
		});
		const sibling = await seedPendingAction({
			connectorKey: APPROVAL_CONNECTOR,
			actionKey: "needs_approval",
		});

		const result = (await manageOperations(
			{
				action: "approve_batch",
				scope: { connection_id: approvalConnectionId },
				run_ids: [target],
			},
			{} as Env,
			ownerCtx,
		)) as {
			approved_count: number;
			failed_count: number;
			run_ids: number[];
		};

		expect(result.approved_count).toBe(1);
		expect(result.failed_count).toBe(0);
		expect(result.run_ids).toEqual([target]);
		expect(await approvalStatusOf(target)).toBe("approved");
		expect(await approvalStatusOf(sibling)).toBe("pending");
	});

	it("automation_id matches the trusted automation principal stored on action runs", async () => {
		const target = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
			automationId: 41,
		});
		const sibling = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
			automationId: 42,
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				scope: { automation_id: 41 },
			},
			{} as Env,
			ownerCtx,
		)) as { rejected_count: number };

		expect(result.rejected_count).toBe(1);
		expect(await approvalStatusOf(target)).toBe("rejected");
		expect(await approvalStatusOf(sibling)).toBe("pending");
	});

	it("older_than_days narrows further and never widens", async () => {
		const old = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
			ageDays: 30,
		});
		const recent = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
			ageDays: 1,
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				scope: { connector_key: "github", older_than_days: 14 },
			},
			{} as Env,
			ownerCtx,
		)) as { rejected_count: number };

		expect(result.rejected_count).toBe(1);
		expect(await approvalStatusOf(old)).toBe("rejected");
		expect(await approvalStatusOf(recent)).toBe("pending");
	});

	it("refuses an UNSCOPED batch — there is no approve-everything", async () => {
		const pending = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});

		// No narrowing filter at all: an empty scope object must be rejected, not
		// silently interpreted as "every pending approval in the organization".
		for (const action of ["approve_batch", "reject_batch"] as const) {
			const result = (await manageOperations(
				{ action, scope: {} },
				{} as Env,
				ownerCtx,
			)) as { error?: string };
			expect(result.error).toContain("must be scoped");
		}

		// Omitting the target entirely is refused too.
		for (const action of ["approve_batch", "reject_batch"] as const) {
			const result = (await manageOperations(
				{ action },
				{} as Env,
				ownerCtx,
			)) as { error?: string };
			expect(result.error).toContain("requires a target");
		}

		expect(await approvalStatusOf(pending)).toBe("pending");
	});

	it("refuses an ambiguous batch carrying both run_id and scope", async () => {
		const pending = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				run_id: 1,
				scope: { connector_key: "github" },
			},
			{} as Env,
			ownerCtx,
		)) as { error?: string };

		expect(result.error).toContain("not both");
		expect(await approvalStatusOf(pending)).toBe("pending");
	});

	it("fails closed when the pending set moved under the reviewer", async () => {
		const shown = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});
		// A second approval arrived after the reviewer loaded the page.
		await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});

		const result = (await manageOperations(
			{
				action: "reject_batch",
				scope: { connector_key: "github" },
				run_ids: [shown],
			},
			{} as Env,
			ownerCtx,
		)) as { error?: string };

		expect(result.error).toContain("changed after this batch was loaded");
		expect(await approvalStatusOf(shown)).toBe("pending");
	});

	it("rejects an unauthorized caller — no agent may bulk-decide", async () => {
		const pending = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});

		// An agent identity on the context is the exact case
		// requireHumanApprovalContext exists to stop: an automation must never be
		// able to approve (let alone bulk-approve) work it queued.
		const agentCtx = {
			...ownerCtx,
			agentId: "agent-1",
		} as ToolContext;

		for (const action of ["approve_batch", "reject_batch"] as const) {
			const result = (await manageOperations(
				{ action, scope: { connector_key: "github" } },
				{} as Env,
				agentCtx,
			)) as { error?: string };
			expect(result.error).toContain("human web session");
		}

		expect(await approvalStatusOf(pending)).toBe("pending");
	});

	it("rejects an otherwise-human caller whose request came through MCP", async () => {
		const mcpCtx = {
			...ownerCtx,
			agentId: null,
			clientId: null,
			mcpSessionId: "unbound-human-session",
			tokenType: "session",
		} as ToolContext;
		const attempts: Array<{ pending: number; result: { error?: string } }> = [];

		for (const action of ["reject_batch", "approve_batch"] as const) {
			const actionKey = `mcp_${action}`;
			const pending = await seedPendingAction({
				connectorKey: "github",
				actionKey,
			});
			const result = (await manageOperations(
				{
					action,
					scope: { connector_key: "github", action_key: actionKey },
				},
				{} as Env,
				mcpCtx,
			)) as { error?: string };
			attempts.push({ pending, result });
		}

		for (const { pending } of attempts) {
			expect(await approvalStatusOf(pending)).toBe("pending");
		}
		for (const { result } of attempts) {
			expect(result.error).toContain("human web session");
		}
	});

	it("keeps credentialed native REST approval working outside MCP", async () => {
		const pending = await seedPendingAction({
			connectionId: approvalConnectionId,
			connectorKey: APPROVAL_CONNECTOR,
			actionKey: "needs_approval",
		});
		const session = await createTestSession(ownerCtx.userId!);

		const response = await post(`/api/${orgSlug}/manage_operations`, {
			body: { action: "approve", run_id: pending },
			cookie: session.cookieHeader,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			action: "approve",
			approved: true,
			run_id: pending,
		});
		expect(await approvalStatusOf(pending)).toBe("approved");
	});

	it("rejects a caller with no verified human identity", async () => {
		const pending = await seedPendingAction({
			connectorKey: "github",
			actionKey: "create_issue",
		});

		const anonCtx = {
			...ownerCtx,
			userId: null,
		} as unknown as ToolContext;

		const result = (await manageOperations(
			{ action: "reject_batch", scope: { connector_key: "github" } },
			{} as Env,
			anonCtx,
		)) as { error?: string };

		expect(result.error).toContain("signed-in user");
		expect(await approvalStatusOf(pending)).toBe("pending");
	});

	it("preflights every run's authority before mutating a source-run batch", async () => {
		const sql = getTestDb();
		const [sourceRun] = await sql<{ id: number }[]>`
			INSERT INTO runs (organization_id, run_type, status)
			VALUES (${orgId}, 'internal', 'completed') RETURNING id
		`;
		const rows = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status,
        action_key, action_input, parent_run_id
      ) VALUES
        (
          ${orgId}, 'internal', 'pending', 'pending',
          'entity_field_change',
          ${sql.json({
						entity_id: 1,
						fields: { priority: "high" },
						owner_user_id: memberCtx.userId,
					})},
          ${sourceRun.id}
        ),
        (
          ${orgId}, 'internal', 'pending', 'pending',
          'entity_field_change',
          ${sql.json({
						entity_id: 2,
						fields: { priority: "high" },
						owner_user_id: "another-user",
					})},
          ${sourceRun.id}
        )
      RETURNING id
    `;
		const runIds = rows.map((row) => Number(row.id));

		await expect(
			manageOperations(
				{
					action: "reject_batch",
					run_id: sourceRun.id,
					run_ids: runIds,
				},
				{} as Env,
				memberCtx,
			),
		).rejects.toThrow("requires admin or owner access");

		for (const runId of runIds) {
			expect(await approvalStatusOf(runId)).toBe("pending");
		}
	});

	it("never crosses the org boundary", async () => {
		const { org: otherOrg } = await seedOwnerContext({
			orgName: "Other Batch Org",
		});
		const sql = getTestDb();
		const rows = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status,
        connector_key, action_key, created_at
      ) VALUES (
        ${otherOrg.id}, 'action', 'pending', 'pending',
        'github', 'create_issue', NOW()
      )
      RETURNING id
    `;
		const foreignRun = Number(rows[0].id);

		const result = (await manageOperations(
			{ action: "reject_batch", scope: { connector_key: "github" } },
			{} as Env,
			ownerCtx,
		)) as { rejected_count: number };

		expect(result.rejected_count).toBe(0);
		expect(await approvalStatusOf(foreignRun)).toBe("pending");

		await sql`DELETE FROM runs WHERE organization_id = ${otherOrg.id}`;
	});

	it("single approve fails closed when the run's connection was deleted", async () => {
		const sql = getTestDb();
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: APPROVAL_CONNECTOR,
			created_by: ownerCtx.userId ?? undefined,
		});
		const target = await seedPendingAction({
			connectionId: conn.id,
			connectorKey: APPROVAL_CONNECTOR,
			actionKey: "needs_approval",
		});
		// Soft-delete the connection: the approval card is unreachable, so
		// approving blind must be refused. getOperationForConnection filters
		// deleted connections, so the run stays pending rather than executing.
		await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${conn.id}`;

		const result = await manageOperations(
			{ action: "approve", run_id: target },
			{} as Env,
			ownerCtx,
		);
		expect("error" in result).toBe(true);
		expect(await approvalStatusOf(target)).toBe("pending");
	});
});
