#!/usr/bin/env node

// Bumps version, builds, and publishes all @lobu packages to npm.
//
// Usage: node scripts/publish-packages.mjs [patch|minor|major|<explicit-version>]
//
// Publishes directly from each package directory. Per-package in-place
// package.json transforms are applied before `npm publish` and reverted
// immediately after in a try/finally, so a crashed publish never leaves the
// working tree dirty. Already-published versions are skipped so a partial
// failure can be retried without bumping the version.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Anchored to this file, not process.cwd(), so the manifest reads below resolve
// the same way whether the script is run from the repo root or imported by a
// test running from another directory.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const PACKAGES = [
  { dir: "packages/core", transform: transformCorePublish },
  // @lobu/plugin-api and @lobu/plugin-host are NOT published. Every package
  // that depends on them at RUNTIME is `private: true` (plugin-conversations,
  // plugin-mcp, plugin-media, plugin-memory), and @lobu/connector-worker —
  // which is published — declares them only in devDependencies, which
  // `rewriteWorkspaceRefs` exempts because a consumer never installs those.
  // So nothing on npm can resolve them, and nothing needs to. They sat in
  // this list without ever existing on the registry, which made every release
  // report a first-publish failure (npm returns E404 when the CI granular
  // token cannot name a package that does not exist yet) even though every
  // package a consumer actually installs published fine.
  { dir: "packages/connector-sdk", transform: rewriteWorkspaceRefs },
  { dir: "packages/client", transform: rewriteWorkspaceRefs },
  { dir: "packages/embeddings", transform: rewriteWorkspaceRefs },
  // @lobu/pgvector-embedded is NOT published: it's `private` and ships its
  // prebuilt native binaries inside the @lobu/cli tarball (build.cjs copies it
  // to dist/vendor/pgvector-embedded), so the bundled server resolves it at
  // runtime without a registry fetch. esbuild can't inline the native
  // binaries, hence it stays a runtime sidecar rather than part of
  // server.bundle.mjs.
  // connector-worker precedes cli: @lobu/cli depends on it at runtime, and the
  // blocked-dependency skip below relies on a dependency always being attempted
  // before its dependents. A guard test asserts this ordering holds.
  { dir: "packages/connector-worker", transform: rewriteWorkspaceRefs },
  { dir: "packages/cli", transform: rewriteWorkspaceRefs },
  { dir: "packages/promptfoo-provider", transform: rewriteWorkspaceRefs },
];

// Published package names that don't use the @lobu/ scope. The unscoped
// `lobu` package was retired when the CLI merged into @lobu/cli; the
// allow-list stays in case another unscoped package ever gets added.
const UNSCOPED_ALLOWED_PUBLISHED_NAMES = new Set();

/**
 * Names this script actually publishes, derived from PACKAGES so the two can
 * never drift. A `runtime` dependency on anything outside this set cannot be
 * satisfied by an external consumer.
 */
let cachedPublishedNames;
function publishedPackageNames() {
  if (!cachedPublishedNames) {
    cachedPublishedNames = new Set();
    for (const { dir } of PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
      );
      if (!pkg.name || pkg.private) {
        throw new Error(
          `${dir} must have a public package name before it can be added to PACKAGES`
        );
      }
      cachedPublishedNames.add(pkg.name);
    }
  }
  return cachedPublishedNames;
}

/**
 * `workspace:*` / `workspace:^` / `workspace:~` references are a Bun/Yarn
 * dev-time feature — they point at the sibling package's current version so
 * we never have to hand-edit versions across packages. npm does not natively
 * rewrite them at publish time, so we do it explicitly here before `npm
 * publish` runs and restore the original package.json afterwards.
 *
 * Consumer-installed sections are additionally gated on the target actually
 * being published: without that gate this rewrote a private package's `0.0.0`
 * placeholder into a public manifest, a constraint no release can satisfy
 * (#2186). devDependencies are exempt — consumers never install them.
 */
function rewriteWorkspaceRefs(pkg) {
  const rewriteSection = (deps, section) => {
    if (!deps) return;
    for (const [name, spec] of Object.entries(deps)) {
      if (
        section !== "devDependencies" &&
        name.startsWith("@lobu/") &&
        !publishedPackageNames().has(name)
      ) {
        throw new Error(
          `${pkg.name} declares ${name} in "${section}", but this script does not publish it.\n` +
            `  An external consumer cannot install ${name}, so the published ${pkg.name} would be broken.\n` +
            "  Fix by either:\n" +
            `    - adding ${name} to PACKAGES (and making it non-private), or\n` +
            `    - bundling ${name} into ${pkg.name}'s build output and removing it from "${section}".`
        );
      }
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
      if (
        !name.startsWith("@lobu/") &&
        !UNSCOPED_ALLOWED_PUBLISHED_NAMES.has(name)
      ) {
        throw new Error(
          `Unexpected workspace ref outside @lobu scope: ${name}@${spec}`
        );
      }
      deps[name] = workspacePackageVersion(name);
    }
  };
  rewriteSection(pkg.dependencies, "dependencies");
  rewriteSection(pkg.optionalDependencies, "optionalDependencies");
  rewriteSection(pkg.devDependencies, "devDependencies");
  rewriteSection(pkg.peerDependencies, "peerDependencies");
  stripUnpublishableScripts(pkg);
  return pkg;
}

/**
 * Drop scripts that cannot run from the published tarball.
 *
 * Every manifest here carries dev-loop scripts (`build`, `dev`, `typecheck`,
 * `test`, `clean`) needing `src/`, `tsc` or `scripts/` — none of which ship.
 * Shipping them is not merely dead weight: a `start` script pointing at a
 * path excluded from `files` makes `npm start` on an installed copy die with
 * MODULE_NOT_FOUND — the same defect class as #2186, a published manifest
 * naming something the consumer cannot get.
 *
 * Runnability is decided by `files`, not by a name allowlist: a script whose
 * referenced paths all ship is kept (@lobu/connector-worker's
 * `start: node dist/bin.js` is real and still works), and one that reaches
 * outside `files` is dropped. Lifecycle scripts are kept unconditionally —
 * npm runs those itself on install, so dropping one changes install semantics.
 */
const PUBLISHED_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
]);

/** Paths a script command references, e.g. `node dist/bin.js` → ["dist/bin.js"]. */
const SCRIPT_PATH_REF = /(?:\.\/)?(?:src|dist|scripts|bin)\/[\w./-]+/g;

/** A tool that must be a devDependency, so it cannot exist in a consumer install. */
const DEV_TOOL =
  /^(?:tsc|tsx|bun|biome|vitest|jest|esbuild|rimraf|openapi-ts)\b/;

/**
 * `clean: rm -rf dist` passes the path check — dist IS shipped — but running it
 * in an installed package deletes the package's own code. Runnable is not the
 * same as safe to expose, so drop the dev-loop names outright.
 */
const DEV_ONLY_SCRIPT_NAMES = new Set(["clean", "dev", "watch"]);

function scriptRunsFromTarball(command, files, name) {
  // No `files` means npm ships the whole directory — everything resolves.
  const included = files?.filter((f) => !f.startsWith("!"));
  if (DEV_ONLY_SCRIPT_NAMES.has(name)) return false;
  if (DEV_TOOL.test(command.trim())) return false;
  if (!included || included.length === 0) return true;
  for (const ref of command.match(SCRIPT_PATH_REF) ?? []) {
    const normalized = ref.replace(/^\.\//, "");
    const shipped = included.some(
      (f) => normalized === f || normalized.startsWith(`${f}/`)
    );
    if (!shipped) return false;
  }
  return true;
}

function stripUnpublishableScripts(pkg) {
  if (!pkg.scripts) return pkg;
  const kept = {};
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (
      PUBLISHED_LIFECYCLE_SCRIPTS.has(name) ||
      scriptRunsFromTarball(command, pkg.files, name)
    ) {
      kept[name] = command;
    }
  }
  if (Object.keys(kept).length > 0) pkg.scripts = kept;
  else delete pkg.scripts;
  return pkg;
}

let cachedRootVersion;
function rootVersion() {
  if (!cachedRootVersion) {
    const rootPkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    cachedRootVersion = rootPkg.version;
  }
  return cachedRootVersion;
}

let cachedWorkspaceVersions;
function workspaceVersions() {
  if (!cachedWorkspaceVersions) {
    cachedWorkspaceVersions = new Map();
    const packagesDir = path.join(REPO_ROOT, "packages");
    for (const dir of readdirSync(packagesDir)) {
      const pkgPath = path.join(packagesDir, dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.version) {
          cachedWorkspaceVersions.set(pkg.name, pkg.version);
        }
      } catch {
        // Not a workspace package.
      }
    }
  }
  return cachedWorkspaceVersions;
}

function workspacePackageVersion(name) {
  const version = workspaceVersions().get(name);
  if (!version) {
    throw new Error(`No workspace package found for ${name}`);
  }
  return version;
}

// Strip the `.bun` export conditionals that point at `./src/...`. They exist
// only for in-monorepo dev ergonomics (bun resolves source directly), and
// would 404 in the published tarball since `src/` is not shipped. Also
// rewrites any workspace refs (no-op today, defensive for future additions).
function transformCorePublish(pkg) {
  const exports = pkg.exports;
  if (exports && typeof exports === "object") {
    for (const entry of Object.values(exports)) {
      if (entry && typeof entry === "object" && "bun" in entry) {
        delete entry.bun;
      }
    }
  }
  return rewriteWorkspaceRefs(pkg);
}

function packageNameFor(dir) {
  try {
    return (
      JSON.parse(
        readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
      ).name ?? dir
    );
  } catch {
    return dir;
  }
}

/**
 * @lobu runtime and peer dependency names a workspace package will PUBLISH.
 *
 * The publish transform is applied first, because the transformed manifest is
 * what npm receives and therefore what a consumer has to be able to install.
 * Reading the raw on-disk manifest instead would make a package wait on an
 * @lobu dependency its transform deletes — the bootstrap wait this avoids.
 *
 * Callers may omit `transform` to ask what the package declares on disk.
 */
function lobuRuntimeDeps(dir, transform) {
  let pkg;
  try {
    pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, dir, "package.json"), "utf8")
    );
  } catch {
    return [];
  }
  // Deliberately outside the catch: the transform runs `rewriteWorkspaceRefs`,
  // which throws when a package declares an @lobu dependency this script does
  // not publish. That is a release-stopping contract break, and swallowing it
  // into an empty list would report the package as depending on nothing —
  // publishing the exact broken manifest the guard exists to stop.
  if (transform) pkg = transform(pkg);
  return [
    ...new Set(
      [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ].filter((name) => name.startsWith("@lobu/"))
    ),
  ];
}

function markUnavailablePackage(name, dependencies, unavailableNames) {
  const missingDeps = dependencies.filter((dependency) =>
    unavailableNames.has(dependency)
  );
  if (missingDeps.length === 0) return;
  unavailableNames.add(name);
  return { name, missingDeps };
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")} (exit ${result.status})`
    );
  }
}

/**
 * Marker error for a package npm won't let us create. On the very first
 * publish of a scoped package, npm returns `E404 / PUT ... Not found` (it
 * masks 403 as 404 for scoped names). This happens when the CI npm token is a
 * granular access token whose package allow-list can't cover a name that does
 * not exist yet — a chicken-and-egg the token cannot break on its own. We
 * collect these and fail once at the end with the manual-bootstrap steps,
 * rather than aborting mid-loop and hiding the other new packages.
 */
class FirstPublishBlockedError extends Error {
  constructor(name, dir) {
    super(name);
    this.name = "FirstPublishBlockedError";
    this.pkgName = name;
    this.dir = dir;
  }
}

/**
 * Publish a package, capturing output so we can classify a first-publish 404.
 * Non-404 failures still hard-fail (real errors must stop the release). The
 * package's source dir is carried on the marker error so the bootstrap message
 * prints the real path — package dir and npm name diverge (e.g. dir
 * a directory's published name can differ from its directory name).
 */
function runPublish(name, dir, args, opts = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(combined);
  if (result.status === 0) return;

  const is404 =
    /\bE404\b/.test(combined) ||
    /\b404 Not Found - PUT\b/.test(combined) ||
    /could not be found or you do not have permission/.test(combined);
  if (is404) {
    throw new FirstPublishBlockedError(name, dir);
  }
  throw new Error(
    `Command failed: npm ${args.join(" ")} (exit ${result.status})`
  );
}

function isVersionPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function publishArgs(otp, tag, version) {
  if (tag !== "latest" && tag !== "canary-candidate") {
    throw new Error(
      "Publish only to latest or canary-candidate; promotion owns canary"
    );
  }
  if (
    (tag === "latest" && version.includes("-")) ||
    (tag === "canary-candidate" && !version.includes("-canary."))
  ) {
    throw new Error(`Version ${version} cannot publish under ${tag}`);
  }
  const args = ["publish", "--access", "public", "--tag", tag];
  if (otp) args.push(`--otp=${otp}`);
  return args;
}

async function publishPackage({ dir, transform }, otp, tag) {
  const absDir = path.join(REPO_ROOT, dir);
  const pkgPath = path.join(absDir, "package.json");
  const originalText = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(originalText);

  const args = publishArgs(otp, tag, pkg.version);
  if (isVersionPublished(pkg.name, pkg.version)) {
    console.log(`  → ${pkg.name}@${pkg.version} already on npm, skipping`);
    return;
  }

  let mutated = false;
  try {
    if (transform) {
      const transformed = transform(JSON.parse(originalText));
      await writeFile(
        pkgPath,
        `${JSON.stringify(transformed, null, 2)}\n`,
        "utf8"
      );
      mutated = true;
    }

    console.log(`  → publishing ${pkg.name}@${pkg.version}`);
    runPublish(pkg.name, dir, args, { cwd: absDir });
  } finally {
    if (mutated) {
      await writeFile(pkgPath, originalText, "utf8");
    }
  }
}

function parseArgs(argv) {
  // Positional bump: patch | minor | major | <explicit-version> | skip
  // Flags: --otp=<code>, --skip-build, --skip-bump
  const positional = [];
  const flags = {
    otp: process.env.NPM_OTP,
    skipBuild: false,
    skipBump: false,
    tag: "latest",
  };
  for (const arg of argv) {
    if (arg.startsWith("--otp=")) {
      flags.otp = arg.slice("--otp=".length);
    } else if (arg.startsWith("--tag=")) {
      flags.tag = arg.slice("--tag=".length);
    } else if (arg === "--skip-build") {
      flags.skipBuild = true;
    } else if (arg === "--skip-bump") {
      flags.skipBump = true;
    } else {
      positional.push(arg);
    }
  }
  return { bump: positional[0] ?? "patch", ...flags };
}

async function main() {
  const { bump, otp, skipBuild, skipBump, tag } = parseArgs(
    process.argv.slice(2)
  );

  if (skipBump) {
    console.log("\n[1/4] Skipping version bump (--skip-bump)");
  } else {
    console.log(`\n[1/4] Bumping version (${bump})`);
    run("node", ["scripts/bump-version.mjs", bump]);
  }

  if (skipBuild) {
    console.log("\n[2/4] Skipping build (--skip-build)");
  } else {
    console.log("\n[2/4] Building packages");
    run("bun", ["run", "build:packages"]);
    run("bun", ["run", "build:lobu"]);
  }

  console.log("\n[3/4] Publishing to npm");
  if (otp) {
    console.log("  (using --otp from command line or $NPM_OTP)");
  }
  // Collect packages npm refuses to create on their first publish so the whole
  // fleet still gets attempted; a single new package must not hide the others.
  //
  // A package whose own @lobu dependency was blocked is SKIPPED rather than
  // published: shipping it would put a manifest on the registry pointing at a
  // version that does not exist. PACKAGES is in dependency order, so a blocked
  // dependency is always seen before its dependents.
  const blocked = [];
  const unavailableNames = new Set();
  const skipped = [];
  for (const pkg of PACKAGES) {
    const skippedPackage = markUnavailablePackage(
      packageNameFor(pkg.dir),
      lobuRuntimeDeps(pkg.dir, pkg.transform),
      unavailableNames
    );
    if (skippedPackage) {
      skipped.push(skippedPackage);
      console.error(
        `  ✗ ${skippedPackage.name}: skipped — depends on unpublished ${skippedPackage.missingDeps.join(", ")}`
      );
      continue;
    }
    try {
      await publishPackage(pkg, otp, tag);
    } catch (error) {
      if (error instanceof FirstPublishBlockedError) {
        blocked.push(error);
        unavailableNames.add(error.pkgName);
        console.error(
          `  ✗ ${error.pkgName}: never-published; needs a one-time bootstrap (see below)`
        );
        continue;
      }
      throw error;
    }
  }

  if (skipped.length > 0) {
    console.error(
      [
        "",
        `Skipped ${skipped.length} package(s) whose dependencies were not published:`,
        ...skipped.map(
          (s) => `  - ${s.name} (needs ${s.missingDeps.join(", ")})`
        ),
        "",
        "These were NOT published on purpose. An unavailable @lobu runtime or",
        "peer dependency leaves external installs broken or incomplete (issue",
        "#2186). Bootstrap the blocked packages below, then re-run; this release",
        "is incomplete until then.",
      ].join("\n")
    );
  }

  if (blocked.length > 0) {
    console.error(
      [
        "",
        `\nnpm refused the first publish of ${blocked.length} new package(s):`,
        ...blocked.map((e) => `  - ${e.pkgName}`),
        "",
        "npm returns E404 on the first publish of a scoped package when the CI",
        "NPM_TOKEN is a granular access token: its package allow-list cannot name",
        "a package that does not exist yet. Break the chicken-and-egg with a",
        "one-time manual bootstrap by an npm org owner, then CI takes over:",
        "",
        "  1. Locally, authenticated as an @lobu owner (classic automation token",
        "     or an interactive login with 2FA — NOT the CI granular token):",
        ...blocked.map(
          (e) =>
            `       (cd packages/${e.dir.replace(/^packages\//, "")} && npm publish --access public)`
        ),
        "  2. Add each newly-created package to the CI granular token's",
        "     allow-list (npmjs.com → Access Tokens), OR register it as a",
        "     Trusted Publisher (npmjs.com → package → Settings → Publishing",
        "     access → GitHub Actions: .github/workflows/publish-packages.yml).",
        "  3. Re-run this workflow; the package now exists and CI publishes it.",
        "",
        "Until then these packages are absent from npm, so any published package",
        "that depends on them will",
        "fail `npm install` for external consumers.",
      ].join("\n")
    );
  }

  if (blocked.length > 0 || skipped.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log("\nDone.");
}

// Only run when invoked as a script. Without this guard, importing the module
// (as the guard tests do) would start a real publish.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { PACKAGES, rewriteWorkspaceRefs };

/** Internals exposed for the guard tests; not part of any published surface. */
export const __testing = {
  PACKAGES,
  publishArgs,
  lobuRuntimeDeps,
  markUnavailablePackage,
  packageNameFor,
};
