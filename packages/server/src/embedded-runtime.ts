/**
 * Embedded-PostgreSQL runtime — lazy-loaded by `server.ts` ONLY when
 * `DATABASE_URL` is a path / `file://` (local `lobu run`, the Mac app, tests).
 *
 * Everything heavy (the `embedded-postgres` binary, the pgvector injector) is
 * pulled in via `await import(...)` inside `startEmbeddedRuntime`, so the
 * external-Postgres path (prod) never resolves or loads them even though they
 * sit in node_modules. Returns the mode-specific lifecycle hooks that
 * `server.ts` hands to the shared `createServerLifecycle()` spine.
 */

import { execFileSync, fork } from "node:child_process";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import {
	executeMigrationSection,
	listMigrationFiles,
	loadMigrationUp,
} from "./db/migration-loader";
import { buildLocalBootstrapHooks } from "./local-bootstrap";
import logger from "./utils/logger";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * Load `@lobu/pgvector-embedded`. It is a `private` package that is never
 * published to npm. In the monorepo / dev it resolves from `node_modules`
 * (workspace dev-dependency), but the published `@lobu/cli` ships it vendored
 * under the server bundle's `dist/vendor/` (copied by the CLI `build.cjs`)
 * because esbuild can't inline its prebuilt native binaries. Try the bare
 * specifier first; on failure (the published CLI, where it isn't in
 * node_modules) load the vendored copy by path relative to this bundle.
 *
 * AGENTS.md dynamic-import allow-list: `embedded-runtime.ts` already lazy-loads
 * `@lobu/pgvector-embedded`; the vendored-path fallback below loads the SAME
 * dependency from the CLI tarball instead of node_modules — no new dependency,
 * same lazy-on-embedded-path cost profile.
 */
async function importPgvectorEmbedded(): Promise<
	typeof import("@lobu/pgvector-embedded")
> {
	try {
		return await import("@lobu/pgvector-embedded");
	} catch {
		const vendored = new URL(
			"./vendor/pgvector-embedded/dist/index.js",
			import.meta.url
		).href;
		return (await import(
			vendored
		)) as typeof import("@lobu/pgvector-embedded");
	}
}

export interface EmbeddedRuntime {
	/** TCP URL of the spawned cluster; already written to process.env.DATABASE_URL. */
	databaseUrl: string;
	/** Cluster datadir, for the boot log. */
	dataDir: string;
	databaseReadiness: () => Promise<void>;
	preListenHooks: Array<() => Promise<void> | void>;
	extraTeardown: Array<() => Promise<void> | void>;
}

/**
 * Resolve the embedded data root from `DATABASE_URL` (a `file://` / path value;
 * the CLI / Mac app inject it). The cluster lives at `<root>/.lobu/pgdata`.
 * A leading `~` is expanded. `DATABASE_URL` is the single source of truth — a
 * postgres:// URL routes to the external path before this is ever called.
 */
function resolveDataRoot(): string {
	const dbUrl = process.env.DATABASE_URL?.trim();
	if (!dbUrl) {
		throw new Error(
			"DATABASE_URL is required: a file:// path for embedded Postgres " +
				"(e.g. file://~/.lobu) or a postgres:// URL for an external database.",
		);
	}
	let p = dbUrl.replace(/^file:(\/\/)?/i, "");
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return p;
}

function resolveExistingPath(
	...candidates: Array<string | undefined>
): string | null {
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = http.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/**
 * Build the EmbeddedPostgres constructor options.
 *
 * `initdbFlags` pins the cluster to the always-present C locale with UTF-8
 * encoding. Otherwise initdb inherits the host locale (e.g. LANG=en_GB.UTF-8)
 * and aborts on a minimal box where that locale isn't generated — only C/POSIX
 * exist — killing `lobu run` on first boot. C never needs generation; the
 * explicit UTF8 encoding keeps Unicode storage (C alone would default to
 * SQL_ASCII). initdb only runs on first cluster init (guarded by the caller), so
 * existing clusters keep their original locale/encoding.
 */
export function embeddedPgOptions(databaseDir: string, port: number) {
	return {
		databaseDir,
		user: "postgres",
		password: "postgres",
		port,
		persistent: true,
		initdbFlags: ["--locale=C", "--encoding=UTF8"],
		createPostgresUser: runningAsRoot(),
	};
}

/**
 * True only when the process is genuinely uid 0.
 *
 * `createPostgresUser` MUST be conditional, not always-on. Postgres refuses to
 * run as root, so a root shell — the default on a VPS, in WSL, in an LXC
 * container, and in most Docker images — dies on first boot with:
 *
 *   You are running this script as root. Postgres does not support running as
 *   root. ... set the `createPostgresUser` option to true.
 *
 * That killed `lobu run`, the landing page's own quickstart, for those users.
 * With the flag set, embedded-postgres creates a `postgres` user/group and
 * chowns the data dir to it.
 *
 * But turning it on unconditionally breaks everyone else. When not root,
 * embedded-postgres's `getUidAndGid()` short-circuits to `{}`, so the
 * "no uid and no gid" branch fires and it runs `groupadd`/`useradd` anyway —
 * which fails on macOS (no such commands) and as an unprivileged Linux user
 * (EPERM), turning a working boot into "Failed to create and initialize a new
 * user on this system." So gate on the actual uid.
 *
 * `process.getuid` is undefined on Windows; absent means "not root".
 */
function runningAsRoot(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

export interface EmbeddedPostgresIdentity {
	uid: number;
	gid: number;
	groups: Set<number>;
}

export type IdentityCommand = (command: string, args: string[]) => string;

const runIdentityCommand: IdentityCommand = (command, args) =>
	execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

function parseIdentityNumber(value: string, label: string): number {
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid ${label} returned for the postgres user: ${value}`);
	}
	return parsed;
}

function readPostgresIdentity(run: IdentityCommand): EmbeddedPostgresIdentity {
	const uid = parseIdentityNumber(run("id", ["-u", "postgres"]), "uid");
	const gid = parseIdentityNumber(run("id", ["-g", "postgres"]), "gid");
	const groups = new Set(
		run("id", ["-G", "postgres"])
			.split(/\s+/)
			.filter(Boolean)
			.map((value) => parseIdentityNumber(value, "supplementary gid")),
	);
	groups.add(gid);
	return { uid, gid, groups };
}

const ROOT_POSTGRES_IDENTITY_ERROR =
	"The postgres OS user unexpectedly resolves to uid 0";

function requireNonRootPostgresIdentity(
	identity: EmbeddedPostgresIdentity,
): EmbeddedPostgresIdentity {
	if (identity.uid === 0) throw new Error(ROOT_POSTGRES_IDENTITY_ERROR);
	return identity;
}

/**
 * Resolve the non-root OS identity used by embedded-postgres, creating it on a
 * fresh root-only Linux host before we need to grant it directory traversal.
 *
 * embedded-postgres performs the same groupadd/useradd bootstrap inside
 * initialise(), but that is too late to establish narrowly-scoped access to
 * its bundled binaries. Doing it here lets Lobu grant the postgres group (and
 * only that group) execute access instead of making `/root` world-traversable.
 */
export function ensureEmbeddedPostgresIdentity(
	run: IdentityCommand = runIdentityCommand,
): EmbeddedPostgresIdentity {
	try {
		return requireNonRootPostgresIdentity(readPostgresIdentity(run));
	} catch (initialError) {
		if (
			initialError instanceof Error &&
			initialError.message === ROOT_POSTGRES_IDENTITY_ERROR
		) {
			throw initialError;
		}
		try {
			// `-f` makes an already-existing group a success, including a race with
			// another Lobu process performing the same first-boot bootstrap.
			run("groupadd", ["-f", "postgres"]);
			try {
				run("useradd", ["-g", "postgres", "postgres"]);
			} catch {
				// A concurrent creator may have won after our first `id`; the read
				// below is the authority and still fails closed if no user exists.
			}
			return requireNonRootPostgresIdentity(readPostgresIdentity(run));
		} catch (cause) {
			if (
				cause instanceof Error &&
				cause.message === ROOT_POSTGRES_IDENTITY_ERROR
			) {
				throw cause;
			}
			throw new Error(
				"Root-mode embedded PostgreSQL requires a non-root 'postgres' OS user, " +
					"but Lobu could not resolve or create it with groupadd/useradd.",
				{ cause: cause ?? initialError },
			);
		}
	}
}

export interface TraversalMutation {
	chmod: typeof chmodSync;
	chown: typeof chownSync;
}

interface TraversalGrant {
	dir: string;
	uid: number;
	gid: number;
	mode: number;
	groupChanged: boolean;
}

export interface EmbeddedPgTraversalLease {
	granted: string[];
	restore: () => void;
}

function postgresCanTraverse(
	stat: Stats,
	identity: EmbeddedPostgresIdentity,
): boolean {
	if (stat.uid === identity.uid) return (stat.mode & 0o100) !== 0;
	if (identity.groups.has(stat.gid)) return (stat.mode & 0o010) !== 0;
	return (stat.mode & 0o001) !== 0;
}

function traversalModeGrant(
	stat: Stats,
	identity: EmbeddedPostgresIdentity,
): { bit: number; groupChanged: boolean } {
	if (stat.uid === identity.uid) return { bit: 0o100, groupChanged: false };
	if (identity.groups.has(stat.gid)) {
		return { bit: 0o010, groupChanged: false };
	}
	return { bit: 0o010, groupChanged: stat.gid !== identity.gid };
}

function restoreTraversalGrants(
	grants: TraversalGrant[],
	mutation: TraversalMutation,
): void {
	const failures: string[] = [];
	for (const grant of [...grants].reverse()) {
		try {
			if (grant.groupChanged) {
				// Strip the temporary group's permissions before returning ownership;
				// otherwise the original group bits briefly apply to postgres.
				mutation.chmod(grant.dir, grant.mode & ~0o070);
				mutation.chown(grant.dir, grant.uid, grant.gid);
			}
			mutation.chmod(grant.dir, grant.mode);
		} catch (err) {
			failures.push(
				`${grant.dir}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`Could not restore embedded PostgreSQL traversal permissions:\n${failures.join("\n")}`,
		);
	}
}

/**
 * Make every lexical and resolved ancestor of `paths` traversable by the
 * postgres OS identity that a root boot drops the embedded cluster to.
 *
 * With `createPostgresUser` (see `embeddedPgOptions`), embedded-postgres runs
 * initdb/postgres setuid'd to a `postgres` user it creates. That child must be
 * able to *traverse* each directory on the paths it touches, or the spawn dies
 * with `EACCES` before exec — and the dependency's spawn has no `'error'`
 * handler, so an unhandled `'error'` event takes down the whole process with
 * the misleading `Emitted 'error' event on ChildProcess instance` crash. The
 * realistic triggers, both seen on the landing-page quickstart:
 *
 *   - the native binaries live in the npx cache under `/root`, which is `0700`
 *     on `node:` images, so `npx @lobu/cli` installs them exactly where the
 *     dropped user cannot reach them;
 *   - `<root>/.lobu` is created root-owned and stays `0700` under a `0077`
 *     umask, so the child cannot traverse into the `pgdata` leaf (which
 *     embedded-postgres chowns to it).
 *
 * Grant only the matching identity class traverse access (`u+x` when postgres
 * owns the directory, otherwise `g+x`) on exactly the directories that lack
 * it. When the directory's group must be temporarily changed to postgres, mask
 * group read/write so the reassignment cannot expose directory contents. This
 * avoids making `/root` or an arbitrary user-selected data ancestor
 * traversable by every local account.
 * The returned lease restores every original uid/gid/mode after PostgreSQL
 * stops; a failed partial grant is rolled back before the error propagates. A
 * SIGKILLed process cannot restore, and the grant then persists: the next boot
 * sees the ancestor as already traversable, so it grants — and therefore
 * records — nothing to undo. Root embedded mode is single-instance per host;
 * two concurrent root processes could otherwise share an ancestor lease and
 * let the first teardown revoke traversal from the second.
 *
 * Targets are made absolute before walking, so the documented `file://.` data
 * root cannot stop at lexical `.`. Existing symlinks contribute both their
 * lexical path and real target path, since the child must traverse both.
 */
export function ensureEmbeddedPgTraversal(
	paths: string[],
	identity: EmbeddedPostgresIdentity,
	mutation: TraversalMutation = { chmod: chmodSync, chown: chownSync },
): EmbeddedPgTraversalLease {
	const grants: TraversalGrant[] = [];
	const visited = new Set<string>();
	let restored = false;
	try {
		for (const target of paths) {
			const absolute = resolve(target);
			if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true });
			const walks = new Set([absolute, realpathSync(absolute)]);
			for (const walk of walks) {
				for (let dir = walk; ; ) {
					if (!visited.has(dir)) {
						visited.add(dir);
						const stat = lstatSync(dir);
						if (stat.isDirectory() && !postgresCanTraverse(stat, identity)) {
							const modeGrant = traversalModeGrant(stat, identity);
							const grant: TraversalGrant = {
								dir,
								uid: stat.uid,
								gid: stat.gid,
								mode: stat.mode & 0o7777,
								groupChanged: modeGrant.groupChanged,
							};
							grants.push(grant);
							if (grant.groupChanged) {
								// Remove the old group's permissions before assigning the
								// postgres group, then add back traverse-only below.
								mutation.chmod(dir, grant.mode & ~0o070);
								mutation.chown(dir, stat.uid, identity.gid);
							}
							const grantedMode = grant.groupChanged
								? (grant.mode & ~0o060) | modeGrant.bit
								: grant.mode | modeGrant.bit;
							mutation.chmod(dir, grantedMode);
							const updated = lstatSync(dir);
							if (!postgresCanTraverse(updated, identity)) {
								throw new Error("permission update did not grant traversal");
							}
						}
					}
					const parent = dirname(dir);
					if (parent === dir) break;
					dir = parent;
				}
			}
		}
	} catch (cause) {
		try {
			restoreTraversalGrants(grants, mutation);
		} catch (rollbackError) {
			throw new AggregateError(
				[cause, rollbackError],
				"Embedded PostgreSQL traversal grant failed and could not be fully rolled back",
			);
		}
		throw new Error(
			"Could not grant the postgres OS user traversal to the embedded PostgreSQL binaries/data directory.",
			{ cause },
		);
	}
	if (grants.length > 0) {
		logger.info(
			{ dirs: grants.map(({ dir }) => dir), gid: identity.gid },
			"Granted postgres identity traversal on embedded PostgreSQL ancestors",
		);
	}
	return {
		granted: grants.map(({ dir }) => dir),
		restore: () => {
			if (restored) return;
			restoreTraversalGrants(grants, mutation);
			restored = true;
		},
	};
}

/**
 * Ensure the @embedded-postgres platform binary's SONAME symlinks exist.
 *
 * Each `@embedded-postgres/<platform>` package ships its shared libs (ICU, libpq)
 * under `native/lib` as versioned files (`libicuuc.so.60.2`, …) plus a
 * `pg-symlinks.json` manifest; its `postinstall` (hydrate-symlinks) creates the
 * SONAME symlinks (`libicuuc.so.60` → `…60.2`) that the binary's
 * `RUNPATH=$ORIGIN/../lib` resolves. npm/npx run that postinstall, but
 * `bun install` (no `trustedDependencies`) and some installs skip it — leaving
 * the binary unable to load on a host without those exact old system libs
 * (e.g. ICU 60 on modern Linux), so `lobu run` dies at initdb with
 * "error while loading shared libraries: libicuuc.so.60". Recreate the symlinks
 * idempotently at boot so embedded Postgres works regardless of installer.
 */
export function hydrateEmbeddedPgSymlinks(nativeDir: string): void {
	const manifest = join(nativeDir, "pg-symlinks.json");
	if (!existsSync(manifest)) return;
	let entries: Array<{ source: string; target: string }>;
	try {
		entries = JSON.parse(readFileSync(manifest, "utf8"));
	} catch {
		return;
	}
	const pkgRoot = dirname(nativeDir);
	let created = 0;
	for (const { source, target } of entries) {
		const targetPath = join(pkgRoot, target);
		if (existsSync(targetPath)) continue; // already hydrated (e.g. by npm postinstall)
		const rel = relative(dirname(targetPath), join(pkgRoot, source));
		try {
			symlinkSync(rel, targetPath);
			created++;
		} catch {
			// best-effort — a race or read-only fs must not crash boot
		}
	}
	if (created > 0) {
		logger.info(
			{ nativeDir, created },
			"Hydrated embedded Postgres library symlinks"
		);
	}
}

/**
 * Spawn an embedded PostgreSQL (injecting pgvector), set process.env.DATABASE_URL
 * to its TCP URL, fork the embeddings child, and return the lifecycle hooks.
 */
export async function startEmbeddedRuntime(): Promise<EmbeddedRuntime> {
	const dataRoot = resolveDataRoot();
	const pgDataDir = join(dataRoot, ".lobu", "pgdata");

	// Embedded-only env defaults. Single-user mode: the embedded runner spawns
	// its own DB, seeds one bootstrap user, and is used by exactly one operator
	// on one machine — block extra /sign-up forks unless LOBU_SINGLE_USER=0.
	process.env.PGSSLMODE = "disable";
	if (process.env.LOBU_SINGLE_USER === undefined) {
		process.env.LOBU_SINGLE_USER = "1";
	}

	// Heavy deps stay behind dynamic import so the external/prod path never
	// loads the embedded-postgres binary resolution or the pgvector injector.
	const componentEntry = process.env.LOBU_RUNTIME_POSTGRES_ENTRY;
	// The launcher installs PG only for an embedded DATABASE_URL. Loading its
	// entry by absolute URL keeps native package resolution inside that cache.
	const component = componentEntry ? await import(pathToFileURL(componentEntry).href) : null;
	const { default: EmbeddedPostgres } = component ?? await import("embedded-postgres");
	const { injectPgvector, resolveEmbeddedNativeDir } = component ?? await importPgvectorEmbedded();
	const nativeDir = resolveEmbeddedNativeDir();

	// The bundled Postgres binary needs its SONAME symlinks in place before it can
	// load (the postinstall that creates them is skipped by bun / some installers).
	hydrateEmbeddedPgSymlinks(nativeDir);

	// embedded-postgres bundles pg_trgm but not pgvector — inject the host
	// platform's prebuilt vector library into the binary tree before boot
	// (idempotent). cube + earthdistance are already in the stock binary.
	injectPgvector(nativeDir);

	const pgPort =
		parseInt(process.env.LOBU_PG_PORT || "", 10) || (await findFreePort());

	// Root mode drops the cluster to a `postgres` user (see runningAsRoot). Give
	// only that OS identity traversal through restrictive binary/datadir ancestors;
	// retain the lease for rollback on boot failure and restoration after stop.
	const traversalLease = runningAsRoot()
		? ensureEmbeddedPgTraversal(
				[nativeDir, join(dataRoot, ".lobu")],
				ensureEmbeddedPostgresIdentity(),
			)
		: null;
	let exitRestore: (() => void) | null = null;
	const restoreTraversal = () => {
		if (!traversalLease) return;
		// Restore BEFORE detaching the exit hook: the lifecycle wraps every
		// teardown step in `safe()`, which swallows a throw, so the hook is the
		// only retry left if this partially fails. `restore()` is idempotent once
		// it succeeds, so keeping the hook attached on failure is safe.
		traversalLease.restore();
		if (exitRestore) {
			process.off("exit", exitRestore);
			exitRestore = null;
		}
	};
	if (traversalLease) {
		// Boot can still fail later in migrations/bootstrap, before the shared
		// lifecycle registers signal teardown. `reportBootFailure()` exits
		// synchronously, so retain a synchronous last-resort restoration hook.
		exitRestore = () => {
			try {
				traversalLease.restore();
			} catch (error) {
				process.stderr.write(
					`Failed to restore embedded PostgreSQL traversal permissions on exit: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		};
		process.once("exit", exitRestore);
	}
	const pg = new EmbeddedPostgres(embeddedPgOptions(pgDataDir, pgPort));

	let embeddingsChild: Awaited<ReturnType<typeof startEmbeddings>> | null = null;
	let postgresStarted = false;
	try {
		// initdb refuses a non-empty datadir; skip it when the cluster already
		// exists so restarts reuse the same data instead of erroring.
		if (!existsSync(join(pgDataDir, "PG_VERSION"))) {
			logger.info({ pgDataDir }, "Initialising embedded PostgreSQL cluster");
			await pg.initialise();
		}
		await pg.start();
		postgresStarted = true;

		const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
		process.env.DATABASE_URL = databaseUrl;
		logger.info({ port: pgPort }, "Embedded PostgreSQL ready");

		embeddingsChild = await startEmbeddings();

		return {
			databaseUrl,
			dataDir: pgDataDir,
			databaseReadiness: () => runMigrations(databaseUrl),
			// Install-operator provisioning, shared with the external-DB
			// `lobu run` path (see local-bootstrap.ts).
			preListenHooks: buildLocalBootstrapHooks(),
			// Runs after stopLobuGateway + closeDbSingleton so gateway connections
			// release before the embeddings child + PG child are stopped. Restore
			// ancestor ownership/modes only after postgres no longer needs them.
			extraTeardown: [
				() => {
					embeddingsChild?.kill();
				},
				() => pg.stop(),
				() => restoreTraversal(),
			],
		};
	} catch (error) {
		embeddingsChild?.kill();
		const cleanupErrors: unknown[] = [];
		// embedded-postgres leaves its process field set when start() rejects,
		// even though the child has already closed. Calling stop() then waits for
		// a second exit event that can never arrive and hangs boot cleanup forever.
		if (postgresStarted) {
			try {
				await pg.stop();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		try {
			restoreTraversal();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[error, ...cleanupErrors],
				"Embedded PostgreSQL boot failed and cleanup was incomplete",
			);
		}
		throw error;
	}
}

/**
 * Locate the bundled `db/migrations` directory. The published `@lobu/cli`
 * copies migrations next to the server bundle (`dist/db/migrations`); a
 * monorepo checkout finds them at the repo root; running from a project
 * subdir falls back to cwd-relative candidates. Returns null when nothing
 * exists (the callers decide whether that's fatal). Used by `runMigrations`
 * AND by `server.ts`'s boot-time schema-version check, which previously
 * resolved a bundle-relative `../../../db/migrations` that lands on
 * `node_modules/db/migrations` (ENOENT) in the published CLI.
 */
export function resolveMigrationsDir(): string | null {
	return resolveExistingPath(
		// Published @lobu/cli copies migrations next to the bundle under dist/db/migrations.
		join(fileURLToPath(new URL(".", import.meta.url)), "db", "migrations"),
		join(APP_ROOT, "db", "migrations"),
		join(APP_ROOT, "..", "..", "db", "migrations"),
		join(process.cwd(), "db", "migrations"),
		join(process.cwd(), "..", "..", "db", "migrations"),
	);
}

/**
 * Apply `db/migrations/*.sql` (the same set the production runner applies) against
 * `databaseUrl`. Idempotent: the squashed baseline is gated by the
 * `schema_migrations` ledger (with a duplicate-object fallback) and forward
 * deltas use `IF NOT EXISTS`, so replaying against an already-migrated DB is a
 * no-op. Used by the embedded runtime AND by the external-DATABASE_URL `lobu
 * run` path (`server.ts`), which owns the local DB lifecycle. Prod never calls
 * this — the production migration Job applies migrations separately.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
	// Same migrations the production runner uses, applied unconditionally. The dir is
	// a single squashed baseline + forward deltas; both replay idempotently
	// (baseline gated by the schema_migrations ledger, deltas use IF NOT EXISTS).
	const sql = postgres(databaseUrl, { max: 1 });
	let migrationLockHeld = false;

	try {
		const migrationsDir = resolveMigrationsDir();
		if (!migrationsDir) throw new Error("Migrations directory not found.");

		await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version character varying(128) NOT NULL PRIMARY KEY
      )
    `);
		await sql.unsafe(`SELECT pg_advisory_lock(hashtext('lobu_migrate_up'))`);
		migrationLockHeld = true;

		const appliedRows = (await sql.unsafe(
			`SELECT version FROM public.schema_migrations`,
		)) as Array<{ version: string }>;
		const applied = new Set(appliedRows.map((r) => r.version));

		// The squashed baseline uses plain CREATE TABLE/FUNCTION, so replaying it
		// against an already-migrated DB raises duplicate-object SQLSTATEs; treat
		// those as the no-op success case for the baseline only. Forward deltas
		// must use IF NOT EXISTS rather than relying on this fallback.
		const IDEMPOTENT_BASELINE_VERSIONS = new Set(["00000000000000"]);

		logger.info("Running migrations...");
		for (const file of listMigrationFiles(migrationsDir)) {
			const version = file.split("_")[0] ?? "";
			if (applied.has(version)) continue;
			const up = loadMigrationUp(migrationsDir, file);
			if (!up.sql) continue;

			await sql.unsafe("SET search_path TO public");
			try {
				if (up.transaction) {
					await sql.begin(async (tx) => {
						await executeMigrationSection(
							(statement) => tx.unsafe(statement),
							up,
						);
						await tx`
              INSERT INTO public.schema_migrations (version) VALUES (${version})
              ON CONFLICT DO NOTHING
            `;
					});
				} else {
					// CONCURRENTLY sections cannot include the ledger write in one
					// transaction, so execute their top-level statements separately.
					await executeMigrationSection(
						(statement) => sql.unsafe(statement),
						up,
					);
					await sql`
              INSERT INTO public.schema_migrations (version) VALUES (${version})
              ON CONFLICT DO NOTHING
            `;
				}
			} catch (err) {
				const code = (err as { code?: string } | null)?.code;
				const isDuplicateObject =
					code === "42723" || code === "42P07" || code === "42710";
				if (!isDuplicateObject || !IDEMPOTENT_BASELINE_VERSIONS.has(version)) {
					throw err;
				}
				logger.info(
					{ migration: file, version, pgErrorCode: code },
					"Migration already applied (idempotent skip)",
				);
				await sql`
          INSERT INTO public.schema_migrations (version) VALUES (${version})
          ON CONFLICT DO NOTHING
        `;
			}
		}
		logger.info("Migrations complete");
	} finally {
		if (migrationLockHeld) {
			await sql
				.unsafe(`SELECT pg_advisory_unlock(hashtext('lobu_migrate_up'))`)
				.catch(() => undefined);
		}
		await sql.end();
	}
}

export async function startEmbeddings(): Promise<ReturnType<typeof fork> | null> {
	if (process.env.EMBEDDINGS_SERVICE_URL?.trim()) return null;
	const embeddingsPort = parseInt(process.env.EMBEDDINGS_PORT || "0", 10);
	const publishedServerPath = (() => {
		try {
			return fileURLToPath(import.meta.resolve("@lobu/embeddings/server"));
		} catch {
			return null;
		}
	})();
	const serverPath = resolveExistingPath(
		...(process.env.LOBU_RUNTIME_EMBEDDINGS_SERVER ? [process.env.LOBU_RUNTIME_EMBEDDINGS_SERVER] : []),
		join(APP_ROOT, "packages", "embeddings", "src", "server.ts"),
		join(process.cwd(), "packages", "embeddings", "src", "server.ts"),
		...(publishedServerPath ? [publishedServerPath] : []),
	);
	if (!serverPath) {
		logger.warn(
			"Embeddings service not found — embedding generation will not be available",
		);
		return null;
	}

	const port = embeddingsPort || (await findFreePort());
	let execArgv: string[] = [];
	if (serverPath.endsWith(".ts")) {
		const tsxPackageJson = require.resolve("tsx/package.json");
		execArgv = ["--import", join(dirname(tsxPackageJson), "dist", "loader.mjs")];
	}

	const child = fork(serverPath, [], {
		execArgv,
		env: { ...process.env, PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	process.env.EMBEDDINGS_SERVICE_URL = `http://127.0.0.1:${port}`;

	child.stdout?.on("data", (data: Buffer) => {
		const msg = data.toString().trim();
		if (msg) logger.info({ service: "embeddings" }, msg);
	});
	child.stderr?.on("data", (data: Buffer) => {
		const msg = data.toString().trim();
		if (msg) logger.warn({ service: "embeddings" }, msg);
	});
	child.on("exit", (code) => {
		if (code !== 0 && code !== null) {
			logger.warn({ code }, "Embeddings service exited");
		}
	});
	return child;
}
