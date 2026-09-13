#!/usr/bin/env node
// Browser automation remains available to development/E2E tests. Production
// images use the paired extension and must not carry these test packages.
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const browserPackages = new Set([
  "playwright",
  "playwright-core",
  "@playwright/test",
  "@playwright/browser-chromium",
  "@playwright/browser-firefox",
  "@playwright/browser-webkit",
  "patchright",
  "patchright-core",
  "puppeteer",
  "puppeteer-core",
  "@puppeteer/browsers",
]);

function inside(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function inspect(root) {
  const packages = [];
  const links = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          target = resolve(dirname(path), readlinkSync(path));
        }
        links.push({ path, target });
      }
      // Check package identity, not the installed directory name: aliases can
      // hide Playwright behind any name. Physical Bun/pnpm stores and nested
      // node_modules are visited too, without traversing directory symlinks.
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/.test(path)
      ) {
        let manifest;
        try {
          manifest = JSON.parse(
            readFileSync(join(path, "package.json"), "utf8")
          );
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
        if (browserPackages.has(manifest?.name)) {
          packages.push({
            path,
            target: realpathSync(path),
            name: manifest.name,
          });
        }
      }
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(realpathSync(resolve(root)));
  return { packages, links };
}

export function assertNoBrowserTooling(root) {
  const { packages } = inspect(root);
  if (packages.length) {
    throw new Error(
      `Production image contains browser tooling:\n${packages
        .map(({ name, path }) => `  ${name}: ${path}`)
        .join("\n")}`
    );
  }
}

export function pruneBrowserTooling(root) {
  const { packages, links } = inspect(root);
  // Resolve links before deleting anything. This includes .bin executables,
  // npm aliases, and package-local links into an isolated dependency store.
  for (const link of links) {
    if (packages.some((pkg) => inside(link.target, pkg.target))) {
      rmSync(link.path, { force: true });
    }
  }
  for (const pkg of packages.sort((a, b) => b.path.length - a.path.length)) {
    // Only remove paths encountered inside the image. A symlink's external
    // target is never traversed or deleted.
    rmSync(pkg.path, { recursive: true, force: true });
  }
  assertNoBrowserTooling(root);
  return packages.length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, root, ...extra] = process.argv.slice(2);
  if (!["--check", "--prune"].includes(mode) || !root || extra.length) {
    throw new Error(
      "Usage: image-browser-tooling.mjs <--check|--prune> <image-root>"
    );
  }
  // Refuse a file or a symlink as the artifact root before any removal.
  if (!lstatSync(resolve(root)).isDirectory())
    throw new Error("Image root must be a directory");
  if (mode === "--prune") {
    console.log(
      `Removed ${pruneBrowserTooling(root)} browser tooling package installations.`
    );
  } else {
    assertNoBrowserTooling(root);
    console.log("Production image contains no browser tooling packages.");
  }
}
