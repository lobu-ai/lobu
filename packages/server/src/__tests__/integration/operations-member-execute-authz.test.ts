/**
 * Member execution authorization for connector operations (`operations.execute`).
 *
 * Regression contract for the prod-readiness finding: an MCP session was told
 * an operation was "ready/executable" (list_available) and then DENIED at
 * execute with a hard admin-scope denial. Three properties
 * must hold:
 *
 *  1. `execute` is member-write, not owner-admin — a member (or an owner whose
 *     token carries `mcp:read mcp:write` but not `mcp:admin`) can invoke it.
 *     Readiness advertising "ready" must not be a lie.
 *  2. The handler STILL enforces per-principal connection visibility — a member
 *     cannot execute on a connection they cannot see. This is the security
 *     property that makes "member can execute" safe.
 *  3. `list_available` is principal-aware: a read-only session sees every op
 *     as not-executable with a session-scope elevation next_action instead of
 *     "ready → execute → denied".
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { routeAction } from "../../tools/admin/action-router";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	addUserToOrganization,
	createTestConnection,
	createTestConnectorDefinition,
	createTestUser,
	seedOwnerContext,
} from "../setup/test-fixtures";

const MEMBER_CONNECTOR = "demo.member.execute";

describe("manage_operations.execute member authorization", () => {
	let orgId: string;
	let ownerCtx: ToolContext;
	let memberCtx: ToolContext;
	let readOnlyCtx: ToolContext;
	let orgConnectionId: number;
	let privateConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx } = await seedOwnerContext({
			orgName: "Member Execute Authz Org",
		});
		orgId = org.id;
		ownerCtx = ctx;

		await createTestConnectorDefinition({
			key: MEMBER_CONNECTOR,
			name: "Member execute connector",
			organization_id: org.id,
		});
		await getTestDb()`
      UPDATE connector_definitions
      SET actions_schema = ${getTestDb().json({
				run: { name: "Run", kind: "write" },
			})}
      WHERE organization_id = ${org.id}
        AND key = ${MEMBER_CONNECTOR}
    `;

		// Org-visible connection: every member may see (and now execute) it.
		const orgConn = await createTestConnection({
			organization_id: org.id,
			connector_key: MEMBER_CONNECTOR,
			created_by: ctx.userId ?? undefined,
			visibility: "org",
		});
		orgConnectionId = orgConn.id;
		// Private connection owned by the owner: NOT visible to a plain member.
		const privateConn = await createTestConnection({
			organization_id: org.id,
			connector_key: MEMBER_CONNECTOR,
			created_by: ctx.userId ?? undefined,
			visibility: "private",
		});
		privateConnectionId = privateConn.id;

		const member = await createTestUser({ name: "Member Execute Member" });
		await addUserToOrganization(member.id, org.id);
		memberCtx = {
			...ctx,
			userId: member.id,
			memberRole: "member",
			scopes: ["mcp:read", "mcp:write"],
		};
		readOnlyCtx = { ...memberCtx, scopes: ["mcp:read"] };
	});

	describe("routeAction enforcement seam (the tier that changed)", () => {
		const stub = { execute: async () => ({ ok: true }) };

		it("member with mcp:write can execute", async () => {
			await expect(
				routeAction("manage_operations", "execute", memberCtx, stub),
			).resolves.toEqual({ ok: true });
		});

		it("owner with mcp:read+mcp:write (no mcp:admin) can execute — the prod-readiness scenario", async () => {
			// The review session had admin/owner ROLE but a token minted without
			// mcp:admin. Execute must not require the admin scope.
			await expect(
				routeAction(
					"manage_operations",
					"execute",
					{ ...ownerCtx, scopes: ["mcp:read", "mcp:write"] },
					stub,
				),
			).resolves.toEqual({ ok: true });
		});

		it("member with only mcp:read is denied with a write-access message", async () => {
			await expect(
				routeAction("manage_operations", "execute", readOnlyCtx, stub),
			).rejects.toThrow(
				/manage_operations\.execute needs write access\. .* was approved read-only.*'Read and make changes'/i,
			);
		});
	});

	describe("handler-level per-principal visibility (still enforced)", () => {
		it("member cannot execute on another member's private connection", async () => {
			const res = await manageOperations(
				{
					action: "execute",
					connection_id: privateConnectionId,
					operation_key: "run",
					input: {},
				},
				{} as Env,
				memberCtx,
			);
			expect(res).toMatchObject({
				error: "Connection not found or not visible.",
			});
		});

		it("member is not denied at authz or visibility on a visible org connection", async () => {
			// Reaching operation resolution (past the authz + visibility gates)
			// proves the member is authorized; any backend execution outcome is
			// out of scope for this authz test.
			let outcome: unknown;
			try {
				outcome = await manageOperations(
					{
						action: "execute",
						connection_id: orgConnectionId,
						operation_key: "run",
						input: {},
					},
					{} as Env,
					memberCtx,
				);
			} catch (err) {
				outcome = err instanceof Error ? err.message : String(err);
			}
			const text =
				typeof outcome === "string"
					? outcome
					: JSON.stringify(outcome ?? null);
			expect(text).not.toMatch(
				/requires (an MCP session with )?(admin|write) access|admin or owner|Connection not found or not visible/i,
			);
		});
	});

	describe("list_available is principal-aware", () => {
		async function findRun(ctx: ToolContext) {
			const res = await manageOperations(
				{ action: "list_available", connector_key: MEMBER_CONNECTOR },
				{} as Env,
				ctx,
			);
			expect(res).not.toHaveProperty("error");
			const op = (res as { operations: Array<Record<string, unknown>> })
				.operations.find((o) => o.operation_key === "run");
			expect(op, "run op should be listed").toBeDefined();
			return op as Record<string, unknown>;
		}

		it("write-tier caller sees the op as executable and ready", async () => {
			const op = await findRun(memberCtx);
			expect(op.executable).toBe(true);
			expect(op.readiness).toBe("ready");
		});

		it("read-only caller sees the op as NOT executable with a scope-elevation next_action", async () => {
			const op = await findRun(readOnlyCtx);
			expect(op.executable).toBe(false);
			expect(op.readiness).toBe("session_scope_required");
			expect(op.reason).toMatch(/operations\.execute needs write access/i);
			expect(op.reason).toContain("'Read and make changes'");
			const next = op.next_action as Record<string, unknown>;
			expect(next.action).toBe("elevate_session_scope");
			expect(next.reason).toBe(op.reason);
			// Per-target rows must not contradict the top-level verdict.
			const targets = op.execution_targets as Array<Record<string, unknown>>;
			expect(targets.length).toBeGreaterThan(0);
			for (const target of targets) {
				expect(target.executable).toBe(false);
				expect(target.status).toBe("session_scope_required");
			}
		});

		it("system/reaction context (bypasses role+scope at routeAction) still sees ready ops as executable", async () => {
			// Automation reactions run with userId=null + memberRole=null; routeAction
			// bypasses the tier for them, so list_available must NOT downgrade a
			// genuinely executable target to session_scope_required.
			const systemCtx: ToolContext = {
				organizationId: orgId,
				userId: null,
				memberRole: null,
				isAuthenticated: true,
				scopes: ["*"],
			};
			const op = await findRun(systemCtx);
			expect(op.executable).toBe(true);
			expect(op.readiness).toBe("ready");
		});

		it("authenticated NON-member with mcp:write sees membership_required, not scope elevation", async () => {
			// A PAT/token caller not in the org has memberRole null: execute is
			// denied for missing workspace membership, so readiness must point at
			// joining the org — telling them to elevate scope would mislead.
			const nonMemberCtx: ToolContext = {
				organizationId: orgId,
				userId: "user-not-a-member",
				memberRole: null,
				isAuthenticated: true,
				scopes: ["mcp:read", "mcp:write"],
			};
			const op = await findRun(nonMemberCtx);
			expect(op.executable).toBe(false);
			expect(op.readiness).toBe("membership_required");
			expect(op.reason).toMatch(/membership/i);
			const next = op.next_action as Record<string, unknown>;
			expect(next.action).toBe("request_membership");
			const targets = op.execution_targets as Array<Record<string, unknown>>;
			expect(targets.length).toBeGreaterThan(0);
			for (const target of targets) {
				expect(target.executable).toBe(false);
				expect(target.status).toBe("membership_required");
			}
		});
	});
});

describe("caller override never replaces a target-state verdict", () => {
	// An operation that is not executable for its OWN reasons (connector code
	// lacks execute()) must keep its "unsupported" verdict for every caller —
	// the caller-scope downgrade only applies to ops whose target was ready.
	let orgId: string;
	let readOnlyCtx: ToolContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx } = await seedOwnerContext({
			orgName: "Member Execute Unsupported Org",
		});
		orgId = org.id;

		await createTestConnectorDefinition({
			key: "demo.member.unsupported",
			name: "Member execute unsupported connector",
			organization_id: org.id,
		});
		await getTestDb()`
      UPDATE connector_definitions
      SET actions_schema = ${getTestDb().json({
				nope: { name: "Nope", kind: "write" },
			})},
          supports_execute = false
      WHERE organization_id = ${org.id}
        AND key = 'demo.member.unsupported'
    `;
		await createTestConnection({
			organization_id: org.id,
			connector_key: "demo.member.unsupported",
			created_by: ctx.userId ?? undefined,
			visibility: "org",
		});

		const member = await createTestUser({ name: "Unsupported Member" });
		await addUserToOrganization(member.id, org.id);
		readOnlyCtx = {
			...ctx,
			userId: member.id,
			memberRole: "member",
			scopes: ["mcp:read"],
		};
	});

	it("read-only caller sees an unsupported op as unsupported, not session_scope_required", async () => {
		const res = await manageOperations(
			{ action: "list_available", connector_key: "demo.member.unsupported" },
			{} as Env,
			readOnlyCtx,
		);
		expect(res).not.toHaveProperty("error");
		const op = (res as { operations: Array<Record<string, unknown>> })
			.operations.find((o) => o.operation_key === "nope");
		expect(op, "nope op should be listed").toBeDefined();
		expect(op?.executable).toBe(false);
		expect(op?.readiness).toBe("unsupported");
		expect(op?.reason).toMatch(/not implement|unsupported/i);
	});
});
