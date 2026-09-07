#!/usr/bin/env node
// Install the candidate package graph outside the workspace, using the same
// manifest transforms as publication. No source-tree resolution or registry
// copies of sibling @lobu packages may stand in for the candidate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __testing as publisher } from "./publish-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Usage: pack-cli-smoke.mjs <empty-directory>");
mkdirSync(destination); // Refuse to overwrite an existing installation.
const staging = join(destination, "packages");
mkdirSync(staging);
const tarballs = [];
for (const { dir, transform } of publisher.PACKAGES) {
  if (dir === "packages/promptfoo-provider") continue;
  const source = join(root, dir);
  const pkg = transform(
    JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  );
  const target = join(staging, pkg.name.replaceAll("/", "-"));
  mkdirSync(target);
  for (const file of [
    ...pkg.files.filter((file) => !file.startsWith("!")),
    "README.md",
    "LICENSE",
  ]) {
    if (!existsSync(join(source, file))) continue;
    cpSync(join(source, file), join(target, file), { recursive: true });
  }
  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`
  );
  const tarball = join(destination, `${pkg.name.replaceAll("/", "-")}.tgz`);
  run("bun", ["pm", "pack", "--filename", tarball], target);
  tarballs.push(tarball);
}
writeFileSync(join(destination, "package.json"), '{"private":true}\n');
// npm is intentional: this tests the consumer installer, including its own
// resolver and lifecycle scripts. Workspace development still uses Bun.
run(
  "npm",
  ["install", "--no-audit", "--no-fund", "--omit=dev", ...tarballs],
  destination
);
const lock = JSON.parse(
  readFileSync(join(destination, "package-lock.json"), "utf8")
);
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (/(?:^|\/)node_modules\/@lobu\/[^/]+$/.test(path)) {
    assert.ok(
      pkg.resolved?.startsWith("file:"),
      `${path} resolved outside the candidate tarballs`
    );
    assert.notEqual(pkg.link, true, `${path} is a workspace link`);
  }
}
console.log(
  `Candidate CLI: ${join(destination, "node_modules/@lobu/cli/bin/lobu.js")}`
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
