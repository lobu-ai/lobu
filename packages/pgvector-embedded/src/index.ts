/**
 * @lobu/pgvector-embedded
 *
 * `embedded-postgres` ships vanilla PostgreSQL binaries with no pgvector. This
 * package carries small prebuilt pgvector artifacts and injects the host
 * platform's into the live `@embedded-postgres/<platform>/native` tree so
 * `CREATE EXTENSION vector` resolves at runtime.
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
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
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

/**
 * Copy the host platform's prebuilt pgvector files into an embedded-postgres
 * `native` tree so `CREATE EXTENSION vector` works, and hydrate the macOS ICU
 * SONAME symlinks so `initdb` can link. Idempotent — returns early if pgvector
 * is already present in the tree.
 *
 * @param nativeDir absolute path to `.../native`; defaults to the resolved
 *   host-platform `@embedded-postgres` package.
 */
export function injectPgvector(
  nativeDir: string = resolveEmbeddedNativeDir(),
  platform: string = currentPlatformKey()
): void {
  // Always (re)hydrate the dylib SONAME symlinks — needed for initdb to link
  // even when pgvector was already injected on a prior run.
  ensureNativeLibSonames(nativeDir);

  const libDst = join(nativeDir, "lib", "postgresql");
  const extDst = join(nativeDir, "share", "postgresql", "extension");

  // Already injected (or shipped) — nothing to do.
  if (existsSync(join(extDst, "vector.control"))) return;

  if (!hasPrebuilt(platform)) {
    throw new Error(
      `@lobu/pgvector-embedded: no prebuilt pgvector for "${platform}". ` +
        "Run scripts/build.sh for this platform, or set DATABASE_URL to use an external Postgres."
    );
  }

  mkdirSync(libDst, { recursive: true });
  mkdirSync(extDst, { recursive: true });

  // Platform-specific compiled library → lib/postgresql.
  const binDir = prebuiltDir(platform);
  for (const file of readdirSync(binDir)) {
    if (file.endsWith(".so") || file.endsWith(".dylib")) {
      cpSync(join(binDir, file), join(libDst, file));
    }
  }

  // Shared control + version SQL (vendored once at the prebuilt root) →
  // share/postgresql/extension.
  for (const file of readdirSync(PREBUILT_ROOT)) {
    if (
      file === "vector.control" ||
      (file.startsWith("vector--") && file.endsWith(".sql"))
    ) {
      cpSync(join(PREBUILT_ROOT, file), join(extDst, file));
    }
  }
}
