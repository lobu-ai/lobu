import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEmbeddedNative } from "@lobu/pgvector-embedded";
import { afterEach, describe, expect, it } from "vitest";

// The installer prepares the @embedded-postgres tree once, as its owner, so a
// later boot never writes into it: #1371 (SONAME links a skipped postinstall
// leaves out) and a read-only install where embedded-postgres' own chmod of
// initdb/postgres crashes with EROFS.
describe("prepareEmbeddedNative", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function fixture(programMode = 0o700): string {
		const root = mkdtempSync(join(tmpdir(), "lobu-pgnative-"));
		dirs.push(root);
		const lib = join(root, "native", "lib");
		const bin = join(root, "native", "bin");
		mkdirSync(lib, { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(lib, "libicuuc.so.60.2"), "x");
		writeFileSync(join(lib, "libpq.so.5.18"), "x");
		writeFileSync(
			join(root, "native", "pg-symlinks.json"),
			JSON.stringify([
				{ source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so.60" },
				{ source: "native/lib/libpq.so.5.18", target: "native/lib/libpq.so.5" },
			]),
		);
		for (const program of ["initdb", "postgres"]) {
			writeFileSync(join(bin, program), "#!/bin/sh\n");
			chmodSync(join(bin, program), programMode);
		}
		writeFileSync(join(bin, "README"), "not a program");
		chmodSync(join(bin, "README"), 0o600);
		return root;
	}

	const mode = (path: string) => statSync(path).mode & 0o777;

	it("creates the missing SONAME symlinks pointing at the bundled libs", () => {
		const root = fixture();
		expect(prepareEmbeddedNative(join(root, "native")).linksCreated).toBe(2);
		const icu = join(root, "native", "lib", "libicuuc.so.60");
		expect(lstatSync(icu).isSymbolicLink()).toBe(true);
		expect(readlinkSync(icu)).toBe("libicuuc.so.60.2");
		expect(readlinkSync(join(root, "native", "lib", "libpq.so.5"))).toBe("libpq.so.5.18");
	});

	it("leaves an already-correct symlink alone and is idempotent", () => {
		const root = fixture();
		symlinkSync("libpq.so.5.18", join(root, "native", "lib", "libpq.so.5"));
		expect(prepareEmbeddedNative(join(root, "native")).linksCreated).toBe(1);
		expect(prepareEmbeddedNative(join(root, "native")).linksCreated).toBe(0);
		expect(readlinkSync(join(root, "native", "lib", "libpq.so.5"))).toBe("libpq.so.5.18");
	});

	it("no-ops on a native dir with nothing to prepare", () => {
		const root = mkdtempSync(join(tmpdir(), "lobu-pgnative-"));
		mkdirSync(join(root, "native", "bin"), { recursive: true });
		dirs.push(root);
		expect(prepareEmbeddedNative(join(root, "native")).linksCreated).toBe(0);
		expect(existsSync(join(root, "native", "lib"))).toBe(false);
	});

	it("grants r-x to all on owner-executable programs installed under umask 077, keeping write bits", () => {
		const root = fixture(0o700);
		prepareEmbeddedNative(join(root, "native"));
		// 0o555 present is embedded-postgres' "already executable" test: it then
		// skips the chmod that crashes a read-only tree with EROFS.
		expect(mode(join(root, "native", "bin", "initdb"))).toBe(0o755);
		expect(mode(join(root, "native", "bin", "postgres"))).toBe(0o755);
		expect(prepareEmbeddedNative(join(root, "native")).linksCreated).toBe(0);
		// A non-executable file is not turned into a program.
		expect(mode(join(root, "native", "bin", "README"))).toBe(0o600);
	});
});
