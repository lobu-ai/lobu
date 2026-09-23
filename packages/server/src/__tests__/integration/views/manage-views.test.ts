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
import { createHash } from "node:crypto";
import {
  contentHash,
  stableStringify,
} from "@lobu/core/contracts/tools/view-content-hash";
import type { Env } from "../../../index";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { ToolUserError } from "../../../utils/errors";
import { compileView, setView as storeView } from "../../../views/views";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
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

	it("compiles source that imports @lobu/views (the chat-agent path)", async () => {
		const source = `import { defineView, mountView } from "@lobu/views";
export const view = defineView({ key: "pipeline", attach: [] });
export default function V() { return null; }
mountView(view, V);
`;
		const set = await setView(source);
		expect(set.written).toBe(true);
		expect(set.view.compiled_bytes as number).toBeGreaterThan(1_000);
	});

	it("set with compiled_code stores the CLI bundle without compiling", async () => {
		const sentinel = "/*lobu-pr2-sentinel*/console.log(1);";
		const set = await setView(SIMPLE_SOURCE, { compiled_code: sentinel });
		expect(set.written).toBe(true);
		const sql = getTestDb();
		const rows = await sql<{ compiled_code: string }>`
      SELECT compiled_code FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		expect(rows[0].compiled_code).toBe(sentinel);
	});

	it("rejects empty and oversized compiled_code", async () => {
		const empty = await setView(SIMPLE_SOURCE, { compiled_code: "" }).catch(
			(e) => e
		);
		expect(empty).toBeInstanceOf(ToolUserError);
		const big = await setView(SIMPLE_SOURCE, {
			compiled_code: `/*x*/${"x".repeat(2 * 1024 * 1024 + 1)}`,
		}).catch((e) => e);
		expect(big).toBeInstanceOf(ToolUserError);
		expect((big as ToolUserError).httpStatus).toBe(422);
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
		// The shell's peek pane reads peek/peek_* on every page, view paths too.
		await expect(
			setView(SIMPLE_SOURCE, { params: { peek: { type: "string" } } })
		).rejects.toThrow(/reserved/);
		await expect(
			setView(SIMPLE_SOURCE, { params: { peek_entity: { type: "string" } } })
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

	it("rejects uninvokable action names at authoring", async () => {
		for (const actions of [
			{ "": { emits: "deal.won" } },
			{ "mark won": { emits: "deal.won" } },
			{ ["a".repeat(65)]: { emits: "deal.won" } },
		]) {
			const err = await setView(SIMPLE_SOURCE, { actions }).catch((e) => e);
			expect(err).toBeInstanceOf(ToolUserError);
			expect((err as ToolUserError).httpStatus).toBe(400);
			expect((err as ToolUserError).message).toMatch(/must start with a letter/);
		}
		// camelCase stays valid.
		const ok = await setView(SIMPLE_SOURCE, {
			actions: { markWon: { emits: "deal.won" } },
		});
		expect(ok.written).toBe(true);
	});

	it("rejects defaults that contradict their declared type, storing nothing", async () => {
		for (const params of [
			{ by: { type: "string", default: null } },
			{ n: { type: "number", default: "not-a-number" } },
			{ flag: { type: "boolean", default: 42 } },
		]) {
			const err = await setView(SIMPLE_SOURCE, { params }).catch((e) => e);
			expect(err).toBeInstanceOf(ToolUserError);
			expect((err as ToolUserError).httpStatus).toBe(400);
		}
		const get = await executeTool(
			"manage_views",
			{ action: "get", key: "pipeline" },
			TEST_ENV,
			ownerCtx
		).catch((e) => e);
		expect(get).toBeInstanceOf(ToolUserError);
		expect((get as ToolUserError).httpStatus).toBe(404);
	});

	it("round-trips numeric, false, and empty-string defaults without coercion", async () => {
		const params = {
			n: { type: "number", default: 7 },
			flag: { type: "boolean", default: false },
			label: { type: "string", default: "" },
		};
		const set = await setView(SIMPLE_SOURCE, { params });
		expect(set.written).toBe(true);
		// open_view links the view's `deal` tab, so the type has to exist.
		await createTestEntity({
			name: "Acme renewal",
			entity_type: "deal",
			organization_id: orgId,
			created_by: ownerId,
		});
		const opened = (await executeTool(
			"open_view",
			{ key: "pipeline" },
			TEST_ENV,
			ownerCtx
		)) as { params: Record<string, unknown> };
		expect(opened.params).toEqual({ n: 7, flag: false, label: "" });
	});

	it("rejects source that does not compile", async () => {
		const err = await setView(UNRESOLVABLE_SOURCE).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
		expect((err as ToolUserError).message).toMatch(/failed to compile/i);
	});

	it("rejects relative imports reaching for server files", async () => {
		const err = await setView(
			`import pkg from "./package.json";\nexport default function B() { return pkg; }`
		).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
	});

	it("rejects absolute imports reaching for server files", async () => {
		// An existing server-side file: old code bundled it (red), the
		// allowlist rejects it before the filesystem is consulted (green).
		const abs = `${process.cwd()}/package.json`;
		const err = await setView(
			`import pkg from ${JSON.stringify(abs)};\nexport default function B() { return pkg; }`
		).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
	});

	it("rejects bare imports outside the phase-1 allowlist", async () => {
		const err = await setView(
			`import { z } from "zod";\nexport default function B() { return z; }`
		).catch((e) => e);
		expect(err).toBeInstanceOf(ToolUserError);
		expect((err as ToolUserError).httpStatus).toBe(422);
	});

	it("stored bundles never carry server package content", async () => {
		// 'invoke_view_action' names a server tool file; it must never appear
		// in a compiled view bundle, which may only contain the view plus the
		// phase-1 react allowlist.
		const compiled = await compileView(REACT_SOURCE);
		expect(compiled).not.toContain("invoke_view_action");
		expect(compiled).not.toContain("manage_view_templates");
		const set = await setView(REACT_SOURCE);
		expect(set.written).toBe(true);
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

	it("bundle-only change writes; identical bundle stays a no-write (PR2 round-1 F1)", async () => {
		const BUNDLE_A = `globalThis.REVIEW_BUNDLE="A";`;
		const BUNDLE_B = `globalThis.REVIEW_BUNDLE="B";`;
		const first = await setView(SIMPLE_SOURCE, { compiled_code: BUNDLE_A });
		expect(first.written).toBe(true);
		const second = await setView(SIMPLE_SOURCE, { compiled_code: BUNDLE_B });
		expect(second.written).toBe(true);
		expect(second.view.content_hash).not.toBe(first.view.content_hash);
		const sql = getTestDb();
		const stored = await sql<{ compiled_code: string }>`
      SELECT compiled_code FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		expect(stored[0].compiled_code).toBe(BUNDLE_B);
		// Server/contract parity: the stored hash is what the shared function
		// derives from the same source, normalized metadata and artifact bytes.
		expect(second.view.content_hash).toBe(
			contentHash(
				SIMPLE_SOURCE,
				{
					name: "Pipeline",
					description: "",
					attach: [{ type: "deal", placement: "tab" }],
					params: { by: { type: "string", default: "owner" } },
					actions: { markWon: { emits: "deal.won" } },
				},
				BUNDLE_B
			)
		);
		const before = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		const third = await setView(SIMPLE_SOURCE, { compiled_code: BUNDLE_B });
		expect(third.written).toBe(false);
		expect(third.view.content_hash).toBe(second.view.content_hash);
		const after = await sql<{ updated_at: Date }>`
      SELECT updated_at FROM views WHERE organization_id = ${orgId} AND key = 'pipeline'
    `;
		expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime());
	});

	it("legacy source+metadata identity refreshes once, then stays a no-op (PR2 round-1 F1)", async () => {
		const legacyMeta = {
			name: "Pipeline",
			description: "",
			attach: [{ type: "deal", placement: "tab" }],
			params: { by: { type: "string", default: "owner" } },
			actions: { markWon: { emits: "deal.won" } },
		};
		const compiled = await compileView(SIMPLE_SOURCE);
		// The pre-F1 identity: source plus declared metadata only.
		const legacyHash = createHash("sha256")
			.update(SIMPLE_SOURCE)
			.update("\n")
			.update(stableStringify(legacyMeta))
			.digest("hex")
			.slice(0, 16);
		expect(legacyHash).not.toBe(
			contentHash(SIMPLE_SOURCE, legacyMeta, compiled)
		);
		await storeView(orgId, {
			key: "pipeline",
			name: "Pipeline",
			description: "",
			source_code: SIMPLE_SOURCE,
			compiled_code: compiled,
			content_hash: legacyHash,
			attach: [{ type: "deal", placement: "tab" }],
			params: { by: { type: "string", default: "owner" } },
			actions: { markWon: { emits: "deal.won" } },
			last_writer: "migration:view-templates",
		});
		// Same executable content refreshes the stored identity exactly once.
		const refresh = await setView(SIMPLE_SOURCE);
		expect(refresh.written).toBe(true);
		expect(refresh.view.content_hash).toBe(
			contentHash(SIMPLE_SOURCE, legacyMeta, compiled)
		);
		const again = await setView(SIMPLE_SOURCE);
		expect(again.written).toBe(false);
	});
});
