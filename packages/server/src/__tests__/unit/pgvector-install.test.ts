import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hasPrebuilt, installPgvector } from "@lobu/pgvector-embedded";

// `lobu run` used to copy pgvector into the installed @embedded-postgres tree
// at boot, which crashed with EACCES for anyone but the install's owner
// (multi-user Homebrew, root-owned global npm, read-only bundles). pgvector is
// now staged into a caller-owned dir and loaded through PostgreSQL 18's
// extension_control_path / dynamic_library_path.
const PLATFORM = "linux-x64"; // any vendored platform; staging is platform-agnostic
const LIBRARY = "vector.so";

describe("installPgvector", () => {
	const dirs: string[] = [];
	const target = () => {
		const dir = mkdtempSync(join(tmpdir(), "lobu-pgvector-install-"));
		dirs.push(dir);
		return join(dir, "pgvector");
	};
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("vendors a prebuilt for the test platform", () => {
		expect(hasPrebuilt(PLATFORM)).toBe(true);
	});

	it("stages the library and extension files and returns search-path flags", () => {
		const dir = target();
		const { postgresFlags } = installPgvector(dir, PLATFORM);

		expect(readdirSync(join(dir, "lib"))).toEqual([LIBRARY]);
		const ext = readdirSync(join(dir, "share", "extension"));
		expect(ext).toContain("vector.control");
		expect(ext.some((f) => f.startsWith("vector--") && f.endsWith(".sql"))).toBe(
			true,
		);
		expect(postgresFlags).toEqual([
			"-c",
			`extension_control_path=${join(dir, "share")}:$system`,
			"-c",
			`dynamic_library_path=${join(dir, "lib")}:$libdir`,
		]);
		// Readable/traversable by the `postgres` user a root boot drops to.
		expect(statSync(join(dir, "lib")).mode & 0o777).toBe(0o755);
		expect(statSync(join(dir, "lib", LIBRARY)).mode & 0o777).toBe(0o644);
	});

	it("is idempotent: a second run leaves unchanged files alone", () => {
		const dir = target();
		installPgvector(dir, PLATFORM);
		const lib = join(dir, "lib", LIBRARY);
		const before = statSync(lib).ino;
		installPgvector(dir, PLATFORM);
		expect(statSync(lib).ino).toBe(before);
	});

	it("replaces drifted files and drops stale pgvector versions only", () => {
		const dir = target();
		installPgvector(dir, PLATFORM);
		const control = join(dir, "share", "extension", "vector.control");
		const pristine = readFileSync(control);
		writeFileSync(control, "tampered");
		const stale = join(dir, "share", "extension", "vector--0.0.1.sql");
		writeFileSync(stale, "-- old");
		const inFlight = join(dir, "lib", `${LIBRARY}.999.tmp`);
		writeFileSync(inFlight, "x");

		installPgvector(dir, PLATFORM);

		expect(readFileSync(control).equals(pristine)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(inFlight)).toBe(true);
	});

	it("keeps staged files readable by the postgres user under a restrictive umask", () => {
		const dir = target();
		const previous = process.umask(0o077);
		try {
			installPgvector(dir, PLATFORM);
		} finally {
			process.umask(previous);
		}
		expect(statSync(join(dir, "lib")).mode & 0o777).toBe(0o755);
		expect(statSync(join(dir, "lib", LIBRARY)).mode & 0o777).toBe(0o644);
		expect(
			statSync(join(dir, "share", "extension", "vector.control")).mode & 0o777,
		).toBe(0o644);
	});

	it("returns absolute search paths for a relative target", () => {
		const dir = target();
		const previous = process.cwd();
		process.chdir(dirname(dir));
		try {
			const { postgresFlags } = installPgvector(basename(dir), PLATFORM);
			expect(postgresFlags).toEqual([
				"-c",
				`extension_control_path=${join(realpathSync(dirname(dir)), basename(dir), "share")}:$system`,
				"-c",
				`dynamic_library_path=${join(realpathSync(dirname(dir)), basename(dir), "lib")}:$libdir`,
			]);
		} finally {
			process.chdir(previous);
		}
	});

	it("rejects a target the colon-separated search paths cannot express", () => {
		expect(() => installPgvector(join(tmpdir(), "a:b"), PLATFORM)).toThrow(
			"must not contain ':'",
		);
	});

	it("rejects a platform with no prebuilt", () => {
		expect(() => installPgvector(target(), "plan9-mips")).toThrow(
			'no prebuilt pgvector for "plan9-mips"',
		);
	});
});
