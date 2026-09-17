/**
 * manage_views over the real tool path (`executeTool`), the same entry the
 * REST proxy and an agent's worker use.
 *
 * Covers: set compiles + stores (written:true), get returns source, list
 * returns metadata only, same-source set is a no-write (written:false,
 * updated_at untouched), edit rewrites with a new hash, remove deletes,
 * validation rejects bad keys/metadata/uncompilable sources, the bundle cap
 * is enforced, and members can read but not write.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { ToolUserError } from "../../../utils/errors";
import { compileView } from "../../../views/views";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

const SIMPLE_SOURCE = `export default function Board() { return null; }
export const view = { attach: [{ type: "deal", placement: "tab" }], params: {}, actions: {} };
`;

const REACT_SOURCE = `import React from "react";
export default function Board() { return React.createElement("div", null, "hi"); }
`;

const UNRESOLVABLE_SOURCE = `import { wat } from "no-such-package-xyz";
export default function Board() { return wat; }
`;

const baseCtx = (
	orgIdValue: string,
	userId: string,
	memberRole: "owner" | "member",
	scopes: string[]
): AuthContext => ({
	organizationId: orgIdValue,
	tokenOrganizationId: orgIdValue,
	userId,
	memberRole,
	agentId: null,
	requestedAgentId: null,
	isAuthenticated: true,
	clientId: null,
	scopes,
	tokenType: "oauth",
	requestUrl: `http://localhost/api/${orgIdValue}`,
	baseUrl: "",
	scopedToOrg: true,
	allowCrossOrg: false,
});

describe("manage_views", () => {
	let orgId: string;
	let ownerId: string;
	let ownerCtx: AuthContext;
	let memberCtx: AuthContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "manage views e2e" });
		orgId = org.id;
		const owner = await createTestUser({ email: "views-owner@test.com" });
		ownerId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		const member = await createTestUser({ email: "views-member@test.com" });
		await addUserToOrganization(member.id, org.id, "member");
		ownerCtx = baseCtx(org.id, owner.id, "owner", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);
		memberCtx = baseCtx(org.id, member.id, "member", [
			"mcp:read",
			"mcp:write",
		]);
	});

	async function setView(
		source: string,
		extra: Record<string, unknown> = {},
		ctx: AuthContext = ownerCtx
	) {
		return (await executeTool(
			"manage_views",
			{
				action: "set",
				key: "pipeline",
				name: "Pipeline",
				source_code: source,
				attach: [{ type: "deal", placement: "tab" }],
				params: { by: { type: "string", default: "owner" } },
				actions: { markWon: { emits: "deal.won" } },
				...extra,
			},
			TEST_ENV,
			ctx
		)) as {
			action: string;
			written: boolean;
			view: Record<string, unknown>;
		};
	}

	it("set compiles and stores; get returns source; list returns metadata only", async () => {
		const set = await setView(SIMPLE_SOURCE);
		expect(set.action).toBe("set");
		expect(set.written).toBe(true);
		expect(set.view.key).toBe("pipeline");
		expect(set.view.name).toBe("Pipeline");
		expect(typeof set.view.content_hash).toBe("string");
		expect((set.view.content_hash as string).length).toBe(16);
		expect(set.view.attach).toEqual([{ type: "deal", placement: "tab" }]);
		expect(set.view.actions).toEqual({ markWon: { emits: "deal.won" } });
		expect(set.view.last_writer).toBe(ownerId);
		expect(set.view).not.toHaveProperty("source_code");
		expect(set.view).not.toHaveProperty("compiled_code");
		expect(set.view.compiled_bytes as number).toBeGreaterThan(0);

		const get = (await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { action: string; view: Record<string, unknown>; source_code: string };
		expect(get.view.key).toBe("pipeline");
		expect(get.source_code).toBe(SIMPLE_SOURCE);

		const list = (await executeTool(
			"manage_views",
			{ action: "list" },
			TEST_ENV,
			ownerCtx
		)) as { action: string; views: Record<string, unknown>[] };
		expect(list.views).toHaveLength(1);
		expect(list.views[0].key).toBe("pipeline");
		expect(list.views[0]).not.toHaveProperty("source_code");
		expect(list.views[0]).not.toHaveProperty("compiled_code");
	});

	it("bundles react for modules that import it", async () => {
		const set = await setView(REACT_SOURCE);
		expect(set.written).toBe(true);
		expect(set.view.compiled_bytes as number).toBeGreaterThan(1_000);
	});

	it("same source is a no-write with updated_at untouched", async () => {
		await setView(SIMPLE_SOURCE);
		const sql = getTestDb();
		const before = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		const again = await setView(SIMPLE_SOURCE);
		expect(again.written).toBe(false);
		const after = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime());
	});

	it("edited source rewrites with a new hash", async () => {
		const first = await setView(SIMPLE_SOURCE);
		const second = await setView(`${SIMPLE_SOURCE}\n// second cut\n`);
		expect(second.written).toBe(true);
		expect(second.view.content_hash).not.toBe(first.view.content_hash);
	});

	it("fixed source with changed attach rewrites with written:true", async () => {
		await setView(SIMPLE_SOURCE);
		const changed = await setView(SIMPLE_SOURCE, {
			attach: [{ type: "deal", placement: "overview" }],
		});
		expect(changed.written).toBe(true);
		const get = (await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { view: Record<string, unknown> };
		expect(get.view.attach).toEqual([{ type: "deal", placement: "overview" }]);
		// Same source AND same metadata is still a no-op.
		const again = await setView(SIMPLE_SOURCE, {
			attach: [{ type: "deal", placement: "overview" }],
		});
		expect(again.written).toBe(false);
	});

	it("fixed source with changed actions rewrites with written:true", async () => {
		await setView(SIMPLE_SOURCE);
		const changed = await setView(SIMPLE_SOURCE, {
			actions: { retry: { emits: "test.poked" } },
		});
		expect(changed.written).toBe(true);
		const get = (await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { view: Record<string, unknown> };
		expect(get.view.actions).toEqual({ retry: { emits: "test.poked" } });
	});

	it("fixed source with changed params rewrites with written:true", async () => {
		await setView(SIMPLE_SOURCE);
		const changed = await setView(SIMPLE_SOURCE, {
			params: { by: { type: "string", default: "stage" } },
		});
		expect(changed.written).toBe(true);
		const get = (await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { view: Record<string, unknown> };
		expect(get.view.params).toEqual({ by: { type: "string", default: "stage" } });
	});

	it("remove deletes; second remove reports removed:false; get 404s", async () => {
		await setView(SIMPLE_SOURCE);
		const removed = (await executeTool(
			"manage_views",
			{ action: "remove", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { removed: boolean };
		expect(removed.removed).toBe(true);
		const again = (await executeTool(
			"manage_views",
			{ action: "remove", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { removed: boolean };
		expect(again.removed).toBe(false);
		const err = await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(404);
	});

	it("rejects bad keys, reserved params, malformed attach and bad emits", async () => {
		await expect(
			setView(SIMPLE_SOURCE, { key: "Custom:Name" })
		).rejects.toThrow(/key/i);
		await expect(
			setView(SIMPLE_SOURCE, { params: { view: { type: "string" } } })
		).rejects.toThrow(/reserved/);
		await expect(
			setView(SIMPLE_SOURCE, {
				attach: [{ type: "deal", entity: 1 }],
			})
		).rejects.toThrow(/exactly one/);
		await expect(
			setView(SIMPLE_SOURCE, { actions: { go: { emits: "not a kind!" } } })
		).rejects.toThrow(/emits/);
	});

	it("rejects source that does not compile", async () => {
		const err = await setView(UNRESOLVABLE_SOURCE).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
		expect((err as ToolUserError).message).toMatch(/failed to compile/i);
	});

	it("rejects oversized source and enforces the compiled bundle cap", async () => {
		const tooBig = `export const blob = "x";\n// ${"x".repeat(1_000_001)}\n`;
		const err = await setView(tooBig).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).message).toMatch(/1000000|length|cap|exceeds/i);

		// The enforcement branch itself, through the real compiler: a tiny
		// maxBytes rejects an ordinary bundle for the claimed reason.
		await expect(compileView(SIMPLE_SOURCE, { maxBytes: 10 })).rejects.toThrow(
			/over the 10 byte cap/
		);
		// …and the default cap accepts it.
		const compiled = await compileView(SIMPLE_SOURCE);
		expect(compiled.length).toBeGreaterThan(0);
	});

	it("members read but cannot write", async () => {
		await setView(SIMPLE_SOURCE);
		const list = (await executeTool(
			"manage_views",
			{ action: "list" },
			TEST_ENV,
			memberCtx
		)) as { views: unknown[] };
		expect(list.views).toHaveLength(1);
		const err = await setView(SIMPLE_SOURCE, {}, memberCtx).catch((e) => e);
		// Access denials surface as plain Errors carrying the policy message
		// (same shape as every other admin tool's denial).
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/requires admin or owner access/);
	});
});
