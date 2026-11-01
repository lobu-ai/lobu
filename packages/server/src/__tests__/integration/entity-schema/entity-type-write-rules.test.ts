/**
 * `manage_entity_schema` compiles a type's write rules on save, and the write
 * seam enforces what it stored.
 *
 * This is the apply half of the seam: without it a rule is unauthorable and the
 * columns are dead weight. The last case is the one that matters most — it goes
 * from "an author declared a rule" all the way to "a write is rejected", so a
 * break anywhere in between (source not stored, compile silently skipped,
 * compiled artifact not readable by the executor) fails here rather than
 * looking like a working feature that never rejects anything.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "../../../tools/execute";
import type { AuthContext } from "../../../tools/registry";
import type { Env } from "../../../index";
import { createEntity } from "../../../utils/entity-management";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const RULE_SOURCE = `
export default (row) => {
  if (row.op === "create" && row.next.status !== "draft") {
    row.deny("an invoice is created in draft, not " + row.next.status);
  }
};
`;

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
} as Env;

async function seedOrg() {
	const org = await createTestOrganization({ name: "Rules Apply" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const ctx: AuthContext = {
		organizationId: org.id,
		tokenOrganizationId: org.id,
		userId: user.id,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${org.id}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	};
	return { org, user, ctx };
}

async function storedRules(
	organizationId: string,
	slug: string,
): Promise<{ rules_source: string | null; rules_compiled: string | null }> {
	const sql = getTestDb();
	const rows = await sql<
		{ rules_source: string | null; rules_compiled: string | null }[]
	>`
    SELECT rules_source, rules_compiled FROM entity_types
    WHERE organization_id = ${organizationId} AND slug = ${slug}
  `;
	return rows[0];
}

async function manageEntityType(
	ctx: AuthContext,
	args: Record<string, unknown>,
): Promise<unknown> {
	if (args.action === "update" && !Object.hasOwn(args, "expected_revision")) {
		const current = await executeTool("manage_entity_schema", { schema_type: "entity_type", action: "get", slug: args.slug }, TEST_ENV, ctx) as { entity_type: { revision: string } };
		args = { ...args, expected_revision: current.entity_type.revision };
	}
	return executeTool(
		"manage_entity_schema",
		{ schema_type: "entity_type", ...args },
		TEST_ENV,
		ctx,
	);
}

describe("entity type write rules through manage_entity_schema", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		// This suite drives `executeTool` directly rather than the HTTP app, so
		// nothing here boots the server — and the schema-governance path reads the
		// workspace provider. `vitest.config.ts` sets `isolate: false`, so the
		// provider is process-wide: the suite passed only when some other file
		// happened to boot the app first. Initialize it explicitly, as the other
		// tool-level suites do.
		await initWorkspaceProvider();
	});

	it("compiles and stores both columns on create", async () => {
		const { org, ctx } = await seedOrg();

		await manageEntityType(ctx, {
			action: "create",
			slug: "invoice",
			name: "Invoice",
			rules_source: RULE_SOURCE,
		});

		const stored = await storedRules(org.id, "invoice");
		expect(stored.rules_source).toBe(RULE_SOURCE);
		// The compiled artifact is a build output, so assert its shape rather than
		// its bytes: the author's module as an IIFE plus the one ESM runner.
		expect(stored.rules_compiled).toContain("__lobuRuleModule");
		expect(stored.rules_compiled).toContain("export default");
	}, 60_000);

	it("recompiles on update, and clears BOTH columns together on null", async () => {
		const { org, ctx } = await seedOrg();
		await manageEntityType(ctx, {
			action: "create",
			slug: "invoice",
			name: "Invoice",
			rules_source: RULE_SOURCE,
		});

		const revised = `${RULE_SOURCE}\n// revised`;
		await manageEntityType(ctx, {
			action: "update",
			slug: "invoice",
			rules_source: revised,
		});
		const afterUpdate = await storedRules(org.id, "invoice");
		expect(afterUpdate.rules_source).toBe(revised);
		expect(afterUpdate.rules_compiled).toBeTruthy();

		await manageEntityType(ctx, {
			action: "update",
			slug: "invoice",
			rules_source: null,
		});
		const afterClear = await storedRules(org.id, "invoice");
		// A source/compiled pair that drifted apart would run a rule nobody can
		// read, or read one that never runs.
		expect(afterClear.rules_source).toBeNull();
		expect(afterClear.rules_compiled).toBeNull();
	}, 60_000);

	it("leaves rules untouched when the update omits them", async () => {
		const { org, ctx } = await seedOrg();
		await manageEntityType(ctx, {
			action: "create",
			slug: "invoice",
			name: "Invoice",
			rules_source: RULE_SOURCE,
		});

		await manageEntityType(ctx, {
			action: "update",
			slug: "invoice",
			description: "an unrelated edit",
		});

		const stored = await storedRules(org.id, "invoice");
		expect(stored.rules_source).toBe(RULE_SOURCE);
		expect(stored.rules_compiled).toBeTruthy();
	}, 60_000);

	it("rejects a rule that does not compile, at APPLY time", async () => {
		const { org, ctx } = await seedOrg();

		// The author is here now. Storing this and failing closed on every write
		// later would surface the error to whoever happened to write next.
		await expect(
			manageEntityType(ctx, {
				action: "create",
				slug: "invoice",
				name: "Invoice",
				rules_source: "export default (row) => { this is not javascript };",
			}),
		).rejects.toThrow(/invalid_rules/);

		const sql = getTestDb();
		const rows = await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${org.id} AND slug = 'invoice'
    `;
		expect(rows).toHaveLength(0);
	}, 60_000);

	it("enforces the applied rule at the write seam", async () => {
		const { org, user, ctx } = await seedOrg();
		await manageEntityType(ctx, {
			action: "create",
			slug: "invoice",
			name: "Invoice",
			rules_source: RULE_SOURCE,
		});

		await expect(
			createEntity({
				entity_type: "invoice",
				name: "INV-1",
				organization_id: org.id,
				created_by: user.id,
				metadata: { status: "posted" },
			} as Parameters<typeof createEntity>[0]),
		).rejects.toThrow(/an invoice is created in draft, not posted/);

		const legal = await createEntity({
			entity_type: "invoice",
			name: "INV-2",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft" },
		} as Parameters<typeof createEntity>[0]);
		expect(legal.id).toBeGreaterThan(0);
	}, 60_000);
});
