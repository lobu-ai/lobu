/**
 * @lobu/pgvector-embedded
 *
 * `embedded-postgres` ships vanilla PostgreSQL binaries with no pgvector. This
 * package carries small prebuilt pgvector artifacts and stages the host
 * platform's into a caller-owned directory, returning the PostgreSQL search-path
 * flags that make `CREATE EXTENSION vector` resolve from there. The installed
 * `@embedded-postgres` package is never written to (see `installPgvector`).
 *
 * Layout: the compiled library is platform-specific (`prebuilt/<platform>/
 * vector.{so,dylib}`); `vector.control` + `vector--<version>.sql` are
 * byte-identical across platforms, so they're vendored ONCE at the prebuilt
 * root (`prebuilt/vector.control`, `prebuilt/vector--<version>.sql`) rather
 * than copied into each platform dir.
 *
 * Artifacts are built by `scripts/build.sh` (one platform per CI matrix cell)
 * against a same-major PostgreSQL — the extension ABI is stable within a major,
 * so a library built against PG 18.x loads into `embedded-postgres`'s PG 18.x.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREBUILT_ROOT = join(PACKAGE_ROOT, "prebuilt");

/** Platform key matching `embedded-postgres`'s package suffixes (`darwin-arm64`, `linux-x64`, …). */
export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Directory holding the platform-specific prebuilt pgvector library. */
export function prebuiltDir(platform: string = currentPlatformKey()): string {
  return join(PREBUILT_ROOT, platform);
}

/** True if the platform library file (vector.so / vector.dylib) is present. */
function hasPrebuiltLibrary(platform: string): boolean {
  const dir = prebuiltDir(platform);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (f) => f.startsWith("vector") && (f.endsWith(".so") || f.endsWith(".dylib"))
  );
}

/** Whether a usable prebuilt pgvector artifact exists for the platform. */
export function hasPrebuilt(platform: string = currentPlatformKey()): boolean {
  // Platform-specific library + the shared control file (vendored once at root).
  return (
    hasPrebuiltLibrary(platform) &&
    existsSync(join(PREBUILT_ROOT, "vector.control"))
  );
}

/**
 * Resolve the `native` directory of the installed `@embedded-postgres/<platform>`
 * package (the one that holds `bin/`, `lib/`, `share/`). Throws with an
 * actionable message if the platform binary package isn't installed.
 */
export function resolveEmbeddedNativeDir(
  platform: string = currentPlatformKey()
): string {
  let entry: string;
  try {
    // Resolve from the package that owns these optional dependencies. An
    // isolated installation does not hoist its binaries into our graph.
    // The platform package exports its JS entry; native lives beside dist.
    const postgresRequire = createRequire(require.resolve("embedded-postgres"));
    entry = postgresRequire.resolve(`@embedded-postgres/${platform}`);
  } catch {
    throw new Error(
      `@lobu/pgvector-embedded: @embedded-postgres/${platform} is not installed. ` +
        "Install embedded-postgres so its host-platform binary package is present."
    );
  }
  return join(dirname(entry), "..", "native");
}

/**
 * embedded-postgres' macOS native libs ship only as the fully-versioned
 * `lib<name>.<major>.<minor>.dylib`, but the Postgres binaries link against both
 * the major SONAME (`lib<name>.<major>.dylib`) and the unversioned linker name
 * (`lib<name>.dylib`, e.g. postgres' `@loader_path/../lib/libicui18n.dylib`) —
 * and the @embedded-postgres/darwin-* packages omit those symlinks. Without them
 * `initdb`/`postgres` abort with `Library not loaded`. Recreate both link levels
 * idempotently, pointing at the real versioned file. No-op off macOS (Linux ships
 * the `.so.<major>` links) and when a link already exists.
 */
export function ensureNativeLibSonames(
  nativeDir: string = resolveEmbeddedNativeDir()
): void {
  if (process.platform !== "darwin") return;
  const libDir = join(nativeDir, "lib");
  if (!existsSync(libDir)) return;
  for (const file of readdirSync(libDir)) {
    // lib<base>.<major>.<minor>.dylib → { lib<base>.<major>.dylib, lib<base>.dylib }
    const match = file.match(/^(lib.+?)\.(\d+)\.\d+\.dylib$/);
    if (!match) continue;
    const [, base, major] = match;
    for (const soname of [`${base}.${major}.dylib`, `${base}.dylib`]) {
      const link = join(libDir, soname);
      if (existsSync(link)) continue;
      try {
        symlinkSync(file, link); // relative target within libDir
      } catch {
        // Best-effort: a race or perms issue surfaces as the real initdb error.
      }
    }
  }
}

/** Result of `installPgvector`. */
export interface PgvectorInstall {
  /**
   * `postgres` argv that prepends the staged dirs to the compiled-in search
   * paths: `<target>/share` to `extension_control_path` (PostgreSQL appends
   * `/extension`) and `<target>/lib` to `dynamic_library_path`.
   */
  postgresFlags: string[];
}

function isPgvectorLibrary(file: string): boolean {
  return file === "vector.so" || file === "vector.dylib";
}

function isPgvectorExtensionFile(file: string): boolean {
  return (
    file === "vector.control" ||
    (file.startsWith("vector--") && file.endsWith(".sql"))
  );
}

/** Copy `src` to `dst` unless `dst` already holds the same bytes; atomic via rename. */
function syncFile(src: string, dst: string): void {
  const bytes = readFileSync(src);
  if (existsSync(dst) && readFileSync(dst).equals(bytes)) return;
  const tmp = `${dst}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o644 });
  renameSync(tmp, dst);
}

/** Make `dir` exist with world-traversable mode (root boots drop to a `postgres` user). */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
}

/**
 * Stage the host platform's prebuilt pgvector under `targetDir` (a directory the
 * current user owns, e.g. the embedded cluster's data root) and return the
 * PostgreSQL flags that make `CREATE EXTENSION vector` resolve from there.
 *
 * Never writes into the installed `@embedded-postgres` package: that tree
 * belongs to whoever installed the CLI (multi-user Homebrew, root-owned global
 * npm, a read-only app bundle), so a runtime copy into it fails with EACCES for
 * every other user. PostgreSQL 18 searches `extension_control_path` for control
 * files and `dynamic_library_path` for the module — it strips the `$libdir/`
 * prefix from `module_pathname`/`probin`, so clusters created when pgvector was
 * injected into the package tree (probin `$libdir/vector`) keep loading too.
 *
 * Idempotent: unchanged files are left alone, changed ones are replaced, and
 * stale pgvector files from another version are removed.
 */
export function installPgvector(
  targetDir: string,
  platform: string = currentPlatformKey()
): PgvectorInstall {
  if (!hasPrebuilt(platform)) {
    throw new Error(
      `@lobu/pgvector-embedded: no prebuilt pgvector for "${platform}". ` +
        "Run scripts/build.sh for this platform, or set DATABASE_URL to use an external Postgres."
    );
  }
  // Both settings are colon-separated search paths.
  if (targetDir.includes(":")) {
    throw new Error(
      `@lobu/pgvector-embedded: cannot stage pgvector under "${targetDir}": ` +
        "PostgreSQL search paths are colon-separated, so the path must not contain ':'."
    );
  }

  const libDir = join(targetDir, "lib");
  const shareDir = join(targetDir, "share");
  const extDir = join(shareDir, "extension");
  for (const dir of [targetDir, libDir, shareDir, extDir]) ensureDir(dir);

  const binDir = prebuiltDir(platform);
  const libFiles = readdirSync(binDir).filter(isPgvectorLibrary);
  const extFiles = readdirSync(PREBUILT_ROOT).filter(isPgvectorExtensionFile);
  for (const file of libFiles) syncFile(join(binDir, file), join(libDir, file));
  for (const file of extFiles)
    syncFile(join(PREBUILT_ROOT, file), join(extDir, file));

  // Drop pgvector files a previous version staged (old upgrade scripts, a
  // renamed library) so the search paths only ever see this version. Only
  // pgvector-shaped names are touched — never another boot's in-flight `.tmp`.
  for (const [dir, keep, isOurs] of [
    [libDir, libFiles, isPgvectorLibrary],
    [extDir, extFiles, isPgvectorExtensionFile],
  ] as const) {
    for (const file of readdirSync(dir)) {
      if (isOurs(file) && !keep.includes(file))
        rmSync(join(dir, file), { force: true });
    }
  }

  return {
    postgresFlags: [
      "-c",
      `extension_control_path=${shareDir}:$system`,
      "-c",
      `dynamic_library_path=${libDir}:$libdir`,
    ],
  };
}
