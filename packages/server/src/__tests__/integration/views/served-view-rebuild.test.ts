/**
 * Serving a view rebuilds a bundle the server compiled under an older
 * compiler, and nothing else: a caller-supplied bundle and a row saved before
 * compiler provenance existed are served as stored, a rebuild that fails keeps
 * the stored bundle without retrying per request, and a save that lands while
 * a rebuild is in flight is never overwritten.
 */
import postgres from "postgres";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../index";
import { executeTool, type AuthContext } from "../../../tools/execute";
import logger from "../../../utils/logger";
import {
	compileView,
	getServedView,
	getView,
	readViewModule,
	serverCompileStamp,
	servedContentHash,
} from "../../../views/views";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { addUserToOrganization, createTestOrganization, createTestUser } from "../../setup/test-fixtures";
import { viewModule } from "./view-module";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

const BODY = "export default function Board() { return null; }";
const SOURCE = viewModule({ key: "board", attach: [] }, BODY);
const UNRESOLVABLE = viewModule(
	{ key: "board", attach: [] },
	'import { wat } from "no-such-package-xyz";\nexport default function Board() { return wat; }'
);

describe("getServedView", () => {
	let orgId: string;
	let ctx: AuthContext;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		orgId = (await createTestOrganization({ name: "served view rebuild" })).id;
		const owner = await createTestUser({ email: "served-view-owner@test.com" });
		await addUserToOrganization(owner.id, orgId, "owner");
		ctx = {
			organizationId: orgId,
			tokenOrganizationId: orgId,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${orgId}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function set(args: Record<string, unknown>) {
		const definition = await readViewModule(String(args.source_code));
		const current = await getView(orgId, definition.key);
		await executeTool("manage_views", { action: "set", expected_revision: current?.revision, ...args }, TEST_ENV, ctx);
	}

	/** Make the stored bundle look like an older server compiler built it. */
	async function makeStale(sourceCode?: string) {
		const sql = getTestDb();
		await sql`
			UPDATE views SET compiled_code = '/*stale-bundle*/',
				compile_config_hash = ${serverCompileStamp("/*stale-bundle*/", "older-compiler")},
				source_code = COALESCE(${sourceCode ?? null}, source_code),
				source_files = CASE WHEN ${sourceCode ?? null}::text IS NULL THEN source_files
					ELSE jsonb_build_object('entrypoint', 'index.tsx', 'files', jsonb_build_object('index.tsx', ${sourceCode ?? null}::text)) END
			WHERE organization_id = ${orgId} AND key = 'board'
		`;
	}

	it("stamps the compiler only on bundles the server compiled", async () => {
		await set({ source_code: SOURCE });
		const built = await getView(orgId, "board");
		expect(built?.compile_config_hash).toBe(serverCompileStamp(built?.compiled_code ?? ""));

		await set({ source_code: SOURCE, compiled_code: "/*client-bundle*/console.log(1);" });
		expect((await getView(orgId, "board"))?.compile_config_hash).toBeNull();
	});

	it("clears the stamp when a caller supplies the exact bytes the server built", async () => {
		await set({ source_code: SOURCE });
		const built = await getView(orgId, "board");

		await set({ source_code: SOURCE, compiled_code: built?.compiled_code });

		expect((await getView(orgId, "board"))?.compile_config_hash).toBeNull();
	});

	it("serves a fresh server build without rewriting it", async () => {
		await set({ source_code: SOURCE });
		const before = await getView(orgId, "board");

		const served = await getServedView(orgId, "board");

		expect(served?.updated_at).toBe(before?.updated_at);
		expect(served?.compiled_code).toBe(before?.compiled_code);
	});

	it("never rebuilds a caller-supplied bundle", async () => {
		const files = { entrypoint: "index.tsx", files: { "index.tsx": SOURCE } };
		await set({ source_code: SOURCE, compiled_code: "/*client-bundle*/console.log(1);", source_files: files, dependencies: {} });

		const served = await getServedView(orgId, "board");

		expect(served?.compiled_code).toBe("/*client-bundle*/console.log(1);");
		expect(served?.compile_config_hash).toBeNull();
		expect(served && servedContentHash(served)).toBe(served?.content_hash);
	});

	it("never rebuilds a row saved before compiler provenance existed", async () => {
		await set({ source_code: SOURCE });
		const sql = getTestDb();
		await sql`
			UPDATE views SET compiled_code = '/*legacy-bundle*/', compile_config_hash = NULL
			WHERE organization_id = ${orgId} AND key = 'board'
		`;

		const served = await getServedView(orgId, "board");
		expect(served?.compiled_code).toBe("/*legacy-bundle*/");
		expect(served && servedContentHash(served)).toBe(served?.content_hash);
	});

	it("never rebuilds a bundle an older writer replaced without restamping", async () => {
		await set({ source_code: SOURCE });
		const built = await getView(orgId, "board");
		const sql = getTestDb();
		// Code from before the column upserts a CLI bundle and leaves the stamp;
		// the compiler has since changed.
		await sql`
			UPDATE views SET compiled_code = '/*cli-bundle*/',
				compile_config_hash = ${serverCompileStamp(built?.compiled_code ?? "", "older-compiler")}
			WHERE organization_id = ${orgId} AND key = 'board'
		`;

		const served = await getServedView(orgId, "board");

		expect(served?.compiled_code).toBe("/*cli-bundle*/");
		expect(served && servedContentHash(served)).toBe(served?.content_hash);
	});

	it("rebuilds a stale server build from all of its retained source files", async () => {
		const files = {
			entrypoint: "views/board.tsx",
			files: {
				"views/board.tsx": viewModule(
					{ key: "board", attach: [] },
					'import { label } from "../lib/label";\nexport default function Board() { return label; }'
				),
				"lib/label.ts": 'export const label = "won";\n',
			},
		};
		await set({ source_code: files.files["views/board.tsx"], source_files: files, dependencies: {} });
		await makeStale();

		const served = await getServedView(orgId, "board");

		expect(served?.compiled_code).toBe(await compileView(files));
		expect(served?.compiled_code).toContain("__lobuViews");
		expect(served?.compile_config_hash).toBe(serverCompileStamp(served?.compiled_code ?? ""));
		expect(served && servedContentHash(served)).toBe(served?.content_hash);
	});

	it("keeps the stored bundle when the rebuild fails, and does not retry it per request", async () => {
		await set({ source_code: SOURCE });
		await makeStale(UNRESOLVABLE);
		const warn = vi.spyOn(logger, "warn");

		const first = await getServedView(orgId, "board");
		const second = await getServedView(orgId, "board");

		expect(first?.compiled_code).toBe("/*stale-bundle*/");
		expect(second?.compiled_code).toBe("/*stale-bundle*/");
		expect((await getView(orgId, "board"))?.compile_config_hash).toBe(
			serverCompileStamp("/*stale-bundle*/", "older-compiler")
		);
		expect(warn.mock.calls.filter(([, message]) => String(message).includes("failed to rebuild"))).toHaveLength(1);
	});

	it("serves the same rebuilt content to concurrent requests for one stale view", async () => {
		await set({ source_code: SOURCE });
		await makeStale();

		const [a, b] = await Promise.all([getServedView(orgId, "board"), getServedView(orgId, "board")]);

		expect(a).toEqual(b);
		expect(a?.compile_config_hash).toBe(serverCompileStamp(a?.compiled_code ?? ""));
	});

	it("never overwrites a save that lands while a rebuild is in flight", async () => {
		await set({ source_code: SOURCE });
		await makeStale();
		const blocker = postgres(process.env.DATABASE_URL as string, { max: 1 });
		try {
			const { serving } = await blocker.begin(async (tx) => {
				await tx`SELECT id FROM views WHERE organization_id = ${orgId} AND key = 'board' FOR UPDATE`;
				const serving = getServedView(orgId, "board");
				const deadline = Date.now() + 15_000;
				for (;;) {
					const [{ c }] = await tx<{ c: number }[]>`
						SELECT count(*)::int AS c FROM pg_stat_activity
						WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
					`;
					if (c > 0) break;
					if (Date.now() > deadline) throw new Error("rebuild never blocked on the locked row");
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				await tx`
					UPDATE views SET compiled_code = '/*concurrent-save*/', content_hash = 'concurrent'
					WHERE organization_id = ${orgId} AND key = 'board'
				`;
				return { serving };
			});

			const served = await serving;

			expect(served?.compiled_code).toBe("/*concurrent-save*/");
			expect((await getView(orgId, "board"))?.content_hash).toBe("concurrent");
		} finally {
			await blocker.end({ timeout: 5 });
		}
	}, 30_000);
});
