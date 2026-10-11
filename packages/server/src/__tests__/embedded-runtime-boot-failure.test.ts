import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({
	initialise: vi.fn<() => Promise<void>>(),
	start: vi.fn<() => Promise<void>>(),
	stop: vi.fn<() => Promise<void>>(),
	options: [] as Array<{ postgresFlags?: string[] }>,
}));

const PGVECTOR_FLAGS = ["-c", "dynamic_library_path=/staged/lib:$libdir"];
const pgvector = vi.hoisted(() => ({
	installPgvector: vi.fn<(dir: string) => { postgresFlags: string[] }>(),
}));

vi.mock("embedded-postgres", () => ({
	default: class FakeEmbeddedPostgres {
		constructor(options: { postgresFlags?: string[] }) {
			postgres.options.push(options);
		}
		initialise = postgres.initialise;
		start = postgres.start;
		stop = postgres.stop;
	},
}));

vi.mock("@lobu/pgvector-embedded", () => ({
	ensureNativeLibSonames: vi.fn(),
	installPgvector: pgvector.installPgvector,
	resolveEmbeddedNativeDir: () => process.cwd(),
}));

import { startEmbeddedRuntime } from "../embedded-runtime";

describe("startEmbeddedRuntime boot failure cleanup", () => {
	const roots: string[] = [];
	const originalDatabaseUrl = process.env.DATABASE_URL;
	const originalPgSslMode = process.env.PGSSLMODE;
	const originalSingleUser = process.env.LOBU_SINGLE_USER;

	beforeEach(() => {
		postgres.initialise.mockResolvedValue();
		postgres.start.mockRejectedValue(new Error("postgres start failed"));
		postgres.stop.mockImplementation(() => new Promise(() => undefined));
		postgres.options.length = 0;
		pgvector.installPgvector.mockReturnValue({ postgresFlags: PGVECTOR_FLAGS });
		vi.spyOn(process, "getuid").mockReturnValue(501);
		const root = mkdtempSync(join(tmpdir(), "lobu-pg-start-failure-"));
		roots.push(root);
		process.env.DATABASE_URL = `file://${root}`;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		postgres.initialise.mockReset();
		postgres.start.mockReset();
		postgres.stop.mockReset();
		if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = originalDatabaseUrl;
		if (originalPgSslMode === undefined) delete process.env.PGSSLMODE;
		else process.env.PGSSLMODE = originalPgSslMode;
		if (originalSingleUser === undefined) delete process.env.LOBU_SINGLE_USER;
		else process.env.LOBU_SINGLE_USER = originalSingleUser;
		while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
	});

	it("does not call the dependency's hanging stop() after start() rejects", async () => {
		await expect(startEmbeddedRuntime()).rejects.toThrow("postgres start failed");

		expect(postgres.initialise).toHaveBeenCalledOnce();
		expect(postgres.start).toHaveBeenCalledOnce();
		expect(postgres.stop).not.toHaveBeenCalled();
	});

	// A non-owner of the CLI install (multi-user Homebrew, root-owned global
	// npm) cannot write into the installed @embedded-postgres tree, so pgvector
	// is staged under the user's own data root and loaded via postgres flags.
	it("stages pgvector under the data root and hands its flags to postgres", async () => {
		await expect(startEmbeddedRuntime()).rejects.toThrow("postgres start failed");

		const root = roots[roots.length - 1]!;
		expect(pgvector.installPgvector).toHaveBeenCalledWith(
			join(root, ".lobu", "pgvector"),
		);
		expect(postgres.options).toHaveLength(1);
		expect(postgres.options[0]!.postgresFlags).toEqual(PGVECTOR_FLAGS);
	});
});
