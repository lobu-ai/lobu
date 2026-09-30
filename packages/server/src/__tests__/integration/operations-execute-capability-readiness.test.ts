/**
 * #2033 item 2 — operations readiness must use the SAME capability signal as
 * execution. A local_action op whose compiled runtime does NOT override
 * execute() would report "ready" then throw "Actions not supported". The install
 * pipeline now computes `supportsExecute` at compile time and readiness reads it.
 *
 * Part A proves the compile-time probe (does the class override execute()?).
 * Part B proves readiness maps supports_execute=false → "unsupported" and
 * true → "ready".
 */

import { upsertEntityApprovalPolicy } from "../../authz/entity-policy";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import {
	compileConnectorSource,
	extractConnectorMetadata,
} from "../../utils/connector-compiler";
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

const WITH_EXECUTE = "demo.cap.with_execute";
const WITHOUT_EXECUTE = "demo.cap.no_execute";

// A runtime that OVERRIDES execute().
const SOURCE_WITH_EXECUTE = `
export class MyConnector {
  definition = { key: '${WITH_EXECUTE}', name: 'With Execute', version: '1.0.0', actions: { doit: { name: 'Do it', kind: 'write' } } };
  async sync() { return { items: [] }; }
  async execute(ctx) { return { success: true, output: {} }; }
}
`;

// A runtime that declares actions but does NOT override execute() — it inherits
// the base default and would throw "Actions not supported" at runtime.
const SOURCE_WITHOUT_EXECUTE = `
class Base {
  async execute(ctx) { return { success: false, error: 'Actions not supported' }; }
}
export class MyConnector extends Base {
  definition = { key: '${WITHOUT_EXECUTE}', name: 'No Execute', version: '1.0.0', actions: { doit: { name: 'Do it', kind: 'write' } } };
  async sync() { return { items: [] }; }
}
`;

describe("execute capability readiness (item 2)", () => {
	describe("compile-time capability probe", () => {
		it("detects an overridden execute() as supportsExecute=true", async () => {
			const compiled = await compileConnectorSource(SOURCE_WITH_EXECUTE);
			const metadata = await extractConnectorMetadata(compiled.compiledCode);
			expect(metadata.supportsExecute).toBe(true);
		});

		it("detects an inherited (non-overridden) execute() as supportsExecute=false", async () => {
			const compiled = await compileConnectorSource(SOURCE_WITHOUT_EXECUTE);
			const metadata = await extractConnectorMetadata(compiled.compiledCode);
			expect(metadata.supportsExecute).toBe(false);
		});
	});

	describe("readiness reflects the capability flag", () => {
		let orgId: string;
		let userId: string;
		let ctx: ToolContext;

		beforeAll(async () => {
			await cleanupTestDatabase();
			await initWorkspaceProvider();
			const { org, user, ctx: ownerCtx } = await seedOwnerContext({
				orgName: "Capability Readiness Org",
			});
			ownerCtx.baseUrl = "https://gateway.test/lobu";
			orgId = org.id;
			userId = user.id;
			ctx = ownerCtx;

			const sql = getTestDb();
			for (const [key, name, supports] of [
				[WITH_EXECUTE, "With Execute", true],
				[WITHOUT_EXECUTE, "No Execute", false],
			] as const) {
				await createTestConnectorDefinition({
					key,
					name,
					organization_id: orgId,
					auth_schema: { methods: [{ type: "oauth", provider: "test" }] },
				});
				await sql`
					UPDATE connector_definitions
					SET actions_schema = ${sql.json({ doit: { name: "Do it", kind: "write" } })},
					    supports_execute = ${supports}
					WHERE organization_id = ${orgId} AND key = ${key}
				`;
				await sql`
					UPDATE connector_versions
					SET compiled_code = ${`class R { async sync(){return {items:[]};} async execute(ctx){return {success:true,output:{}};} } export { R };`}
					WHERE connector_key = ${key}
				`;

				// Wire an active, authenticated connection so status readiness would
				// otherwise be "ready" — isolating the capability signal.
				const conn = await createTestConnection({
					organization_id: orgId,
					connector_key: key,
					created_by: userId,
					visibility: "private",
				});
				await upsertEntityApprovalPolicy(orgId, {
					resourceClass: "connector_action",
					connectionId: conn.id,
					effects: { execute: "auto" },
				});
				const accountId = `acct_${conn.id}_${key}`;
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
					connectorKey: key,
					displayName: `${key} OAuth`,
					profileKind: "oauth_account",
					provider: "test",
					accountId,
					status: "active",
					createdBy: userId,
				});
				await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}`;
			}
		});

		async function readiness(connectorKey: string): Promise<{ readiness: string; executable: boolean }> {
			const listed = (await manageOperations(
				{ action: "list_available", connector_key: connectorKey },
				{} as Env,
				ctx,
			)) as { operations: Array<{ operation_key: string; readiness: string; executable: boolean }> };
			const op = listed.operations.find((o) => o.operation_key === "doit");
			if (!op) throw new Error(`doit op not listed for ${connectorKey}`);
			return { readiness: op.readiness, executable: op.executable };
		}

		it("reports 'ready' when the runtime supports execute()", async () => {
			const r = await readiness(WITH_EXECUTE);
			expect(r.readiness).toBe("ready");
			expect(r.executable).toBe(true);
		});

		it("reports 'unsupported' when the runtime lacks execute()", async () => {
			const r = await readiness(WITHOUT_EXECUTE);
			expect(r.readiness).toBe("unsupported");
			expect(r.executable).toBe(false);
		});
	});
});
