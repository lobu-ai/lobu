import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedPgOptions } from "../embedded-runtime";

// #1364: embedded Postgres must initdb with an always-present locale so `lobu run`
// boots on a minimal Linux box where the host locale (e.g. LANG=en_GB.UTF-8) is
// set but not generated.
describe("embeddedPgOptions", () => {
	it("pins initdb to the C locale with UTF-8 encoding", () => {
		const opts = embeddedPgOptions("/tmp/pgdata", 5599);
		expect(opts.initdbFlags).toEqual(["--locale=C", "--encoding=UTF8"]);
	});

	it("passes through the data dir and port", () => {
		const opts = embeddedPgOptions("/var/lib/lobu/pg", 6123);
		expect(opts.databaseDir).toBe("/var/lib/lobu/pg");
		expect(opts.port).toBe(6123);
		expect(opts.persistent).toBe(true);
	});

	it("passes postgres flags through (pgvector search paths)", () => {
		const flags = ["-c", "dynamic_library_path=/data/.lobu/pgvector/lib:$libdir"];
		expect(embeddedPgOptions("/tmp/pgdata", 5599, flags).postgresFlags).toEqual(
			flags,
		);
		expect(embeddedPgOptions("/tmp/pgdata", 5599).postgresFlags).toEqual([]);
	});
});

// Postgres refuses to run as root, so `lobu run` died on first boot for anyone
// in a root shell — the default on a VPS, in WSL, in LXC, and in most Docker
// images. `createPostgresUser` lets embedded-postgres create a `postgres` user
// to drop into. It has to be conditional in BOTH directions: off as root is the
// original crash, on as non-root makes embedded-postgres shell out to
// `groupadd`/`useradd` regardless (its uid lookup returns `{}` when not root),
// which fails on macOS and as an unprivileged Linux user.
describe("embeddedPgOptions createPostgresUser (root boot)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates a postgres user when running as root", () => {
		vi.spyOn(process, "getuid").mockReturnValue(0);
		expect(embeddedPgOptions("/tmp/pgdata", 5599).createPostgresUser).toBe(
			true,
		);
	});

	it("does NOT create a postgres user when running unprivileged", () => {
		vi.spyOn(process, "getuid").mockReturnValue(501);
		expect(embeddedPgOptions("/tmp/pgdata", 5599).createPostgresUser).toBe(
			false,
		);
	});

	it("treats a missing getuid (Windows) as not-root", () => {
		const original = process.getuid;
		// biome-ignore lint/performance/noDelete: emulating the Windows shape,
		// where `process.getuid` is genuinely absent rather than undefined.
		delete (process as { getuid?: unknown }).getuid;
		try {
			expect(embeddedPgOptions("/tmp/pgdata", 5599).createPostgresUser).toBe(
				false,
			);
		} finally {
			process.getuid = original;
		}
	});
});
