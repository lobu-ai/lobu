#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGES } from "./publish-packages.mjs";
import { parseStableVersion } from "./release-provenance.mjs";

const CANARY = /^\d+\.\d+\.\d+-canary\.[1-9]\d*\.g([a-f0-9]{40})$/;

export function canaryVersion(base, timestamp, sha) {
  parseStableVersion(base);
  if (!/^[1-9]\d*$/.test(timestamp) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("Canary requires a commit timestamp and full SHA");
  }
  return `${base}-canary.${timestamp}.g${sha}`;
}

export function prepareManifests(manifests, version) {
  if (!CANARY.test(version)) throw new Error("Invalid canary version");
  const names = new Set(manifests.map((pkg) => pkg.name));
  return manifests.map((manifest) => {
    const pkg = structuredClone(manifest);
    pkg.version = version;
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        if (names.has(name)) pkg[section][name] = version;
      }
    }
    return pkg;
  });
}

export function promotionAllowed(current, candidate, isAncestor) {
  const sha = CANARY.exec(candidate)?.[1];
  if (!sha) throw new Error("Invalid candidate version");
  if (current === undefined || current === candidate) return true;
  const previous = CANARY.exec(current)?.[1];
  if (!previous) throw new Error(`Unrecognized canary tag: ${current}`);
  return isAncestor(previous, sha);
}

function command(bin, args) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function main() {
  const [operation, version] = process.argv.slice(2);
  const files = PACKAGES.map(({ dir }) => `${dir}/package.json`);
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const manifests = files.map(read);
  if (operation === "prepare") {
    const sha = command("git", ["rev-parse", "HEAD"]);
    const timestamp = command("git", ["show", "-s", "--format=%ct", "HEAD"]);
    const root = read("package.json");
    const candidate = canaryVersion(root.version, timestamp, sha);
    const prepared = prepareManifests(manifests, candidate);
    for (const [index, file] of files.entries()) {
      writeFileSync(file, `${JSON.stringify(prepared[index], null, 2)}\n`);
    }
    root.version = candidate;
    writeFileSync("package.json", `${JSON.stringify(root, null, 2)}\n`);
    console.log(candidate);
    return;
  }
  if (operation !== "promote" || !CANARY.test(version ?? "")) {
    throw new Error(
      "Usage: canary-publish.mjs prepare | promote <exact-version>"
    );
  }
  const sha = CANARY.exec(version)[1];
  if (command("git", ["rev-parse", "HEAD"]) !== sha)
    throw new Error("Candidate does not match checkout");
  const isAncestor = (from, to) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", from, to]);
    if (result.status !== 0 && result.status !== 1)
      throw new Error("Cannot establish canary ancestry");
    return result.status === 0;
  };
  command("git", ["fetch", "origin", "main"]);
  if (!isAncestor(sha, "origin/main")) throw new Error("Candidate left main");
  // Validate the entire fleet before changing any tag. npm has no atomic
  // multi-package tag update; exact internal versions keep installs coherent.
  // CLI is last so its opt-in entry point advances only after its dependencies.
  const names = manifests
    .map((pkg) => pkg.name)
    .sort((a, b) =>
      a === "@lobu/cli" ? 1 : b === "@lobu/cli" ? -1 : a.localeCompare(b)
    );
  for (const name of names) {
    const tags = JSON.parse(
      command("npm", ["view", name, "dist-tags", "--json"])
    );
    if (!tags || typeof tags !== "object" || Array.isArray(tags))
      throw new Error("Invalid registry tags");
    if (!promotionAllowed(tags.canary, version, isAncestor)) {
      console.log(
        `Skipping older candidate ${version}; ${name} already has ${tags.canary}`
      );
      return;
    }
    const published = command("npm", ["view", `${name}@${version}`, "version"]);
    if (published !== version)
      throw new Error(`Missing candidate ${name}@${version}`);
  }
  for (const name of names) {
    command("npm", ["dist-tag", "add", `${name}@${version}`, "canary"]);
  }
  console.log(`Promoted ${version}: bunx @lobu/cli@canary --help`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
