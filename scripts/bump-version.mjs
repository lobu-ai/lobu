#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PACKAGES = [
  "packages/core",
  "packages/plugin-api",
  "packages/plugin-host",
  "packages/cli",
  "packages/connector-sdk",
  "packages/client",
  "packages/connector-worker",
  "packages/embeddings",
];

async function main() {
  const bump = process.argv[2]; // "patch", "minor", "major", or explicit like "3.1.0"
  const root = process.cwd();
  const rootPkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  let version = rootPkg.version;

  if (bump) {
    const [major, minor, patch] = version.split(".").map(Number);
    if (bump === "patch") version = `${major}.${minor}.${patch + 1}`;
    else if (bump === "minor") version = `${major}.${minor + 1}.0`;
    else if (bump === "major") version = `${major + 1}.0.0`;
    else {
      // Explicit version — validate before writing. Anything unrecognized used
      // to be accepted verbatim, so a stray flag (`--help`) or a typo silently
      // rewrote every package.json in the workspace to a nonsense version.
      //
      // This is the official SemVer 2.0.0 pattern (semver.org), not a loose
      // \d+\.\d+\.\d+ approximation: the loose one accepted `01.2.3`,
      // `1.2.3-01` and `1.2.3-..`, all of which npm rejects at publish time —
      // so a bad version would still have been written across every manifest
      // and only failed much later.
      if (
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(
          bump
        )
      ) {
        throw new Error(
          `Invalid version "${bump}". Expected patch | minor | major, or an explicit semver like 3.1.0 / 3.1.0-beta.1.`
        );
      }
      version = bump;
    }
  }

  // Update root
  rootPkg.version = version;
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(rootPkg, null, 2)}\n`
  );
  console.log(`root: ${version}`);

  // Update all workspace packages
  for (const pkg of PACKAGES) {
    const pkgPath = path.join(root, pkg, "package.json");
    const pkgJson = JSON.parse(await readFile(pkgPath, "utf8"));
    pkgJson.version = version;
    await writeFile(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(`${pkg}: ${version}`);
  }

  console.log(`\nAll packages bumped to ${version}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
