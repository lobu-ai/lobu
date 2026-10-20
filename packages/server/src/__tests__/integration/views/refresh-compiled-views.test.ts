/**
 * Deploy convergence for compiled views: a server-compiled view's stored
 * bundle is rebuilt with the running process's runtime, its declaration is
 * kept as stored, and views the server cannot rebuild are left alone.
 */
import type { SourceFiles } from "@lobu/core/contracts/tools/source-files";
import { contentHash } from "@lobu/core/contracts/tools/view-content-hash";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refreshCompiledViews } from "../../../scheduled/refresh-compiled-views";
import { compileView, getView, readViewModule, setView, viewSourceDependencies } from "../../../views/views";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";
import { viewModule } from "./view-module";

// A stored row from before a declaration-shape change: the source no longer
// validates, but the row retains its migrated declaration.
const SOURCE = viewModule(
	{ key: "board", attach: [{ type: "deal", surface: "record" }] },
	"export default function Board() { return null; }"
);
const MIGRATED_ATTACH = [{ record: "deal" }];

function single(source: string) {
	return { entrypoint: "index.tsx", files: { "index.tsx": source } };
}

describe("refreshCompiledViews", () => {
	let orgId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		orgId = (await createTestOrganization({ name: "view refresh" })).id;
	});

	async function store(
		key: string,
		source: string,
		sourceFiles: SourceFiles,
		compiled = "stale-bundle",
		lastWriter = "author"
	) {
		await setView(orgId, {
			key,
			name: key,
			description: "",
			source_code: source,
			compiled_code: compiled,
			content_hash: `old-${key}`,
			source_files: sourceFiles,
			dependencies: viewSourceDependencies(),
			source_complete: true,
			attach: MIGRATED_ATTACH,
			params: {},
			actions: {},
			last_writer: lastWriter,
		});
	}

	it("rebuilds a stale server-compiled bundle and keeps the stored declaration", async () => {
		await expect(readViewModule(SOURCE)).rejects.toThrow();
		await store("board", SOURCE, single(SOURCE));

		const result = await refreshCompiledViews();

		expect(result).toEqual({ scanned: 1, refreshed: 1, errored: 0 });
		const view = await getView(orgId, "board");
		const compiled = await compileView(SOURCE);
		const dependencies = viewSourceDependencies();
		expect(view?.compiled_code).toBe(compiled);
		expect(view?.content_hash).toBe(contentHash(SOURCE, {
			name: "board", description: "", attach: MIGRATED_ATTACH, params: {}, actions: {},
		}, compiled, { sourceFiles: single(SOURCE), dependencies }));
		expect(view?.dependencies).toEqual(dependencies);
		expect(view?.attach).toEqual(MIGRATED_ATTACH);
		expect(view?.last_writer).toBe("author");
	});

	it("is a no-op once the bundle is current", async () => {
		await store("board", SOURCE, single(SOURCE));
		await refreshCompiledViews();
		const before = await getView(orgId, "board");

		const again = await refreshCompiledViews();

		expect(again).toEqual({ scanned: 1, refreshed: 0, errored: 0 });
		const after = await getView(orgId, "board");
		expect(after?.updated_at).toBe(before?.updated_at);
		expect(after?.content_hash).toBe(before?.content_hash);
	});

	it("leaves multi-file project bundles and unbuildable sources in place", async () => {
		// A CLI project: more than one file, built with its own dependencies.
		await store("project", SOURCE, {
			entrypoint: "index.tsx",
			files: { "index.tsx": SOURCE, "chart.tsx": "export const x = 1;" },
		});
		const broken = 'import { wat } from "no-such-package-xyz";\nexport default function B() { return wat; }\n';
		await store("broken", broken, single(broken));

		const result = await refreshCompiledViews();

		expect(result).toEqual({ scanned: 1, refreshed: 0, errored: 1 });
		expect((await getView(orgId, "project"))?.compiled_code).toBe("stale-bundle");
		expect((await getView(orgId, "broken"))?.compiled_code).toBe("stale-bundle");
	});

	it("leaves a single-file lobu apply bundle as the CLI built it", async () => {
		await store("applied", SOURCE, single(SOURCE), "cli-bundle", "apply:01JABCDEFGHJKMNPQRSTVWXYZ");

		const result = await refreshCompiledViews();

		expect(result).toEqual({ scanned: 0, refreshed: 0, errored: 0 });
		expect((await getView(orgId, "applied"))?.compiled_code).toBe("cli-bundle");
	});
});
