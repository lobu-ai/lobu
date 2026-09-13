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
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __testing as publisher } from "./publish-packages.mjs";
import { assertPortableArtifact } from "./artifact-portability.mjs";
import {
  COMPONENTS,
  lockRuntimeComponent,
  runtimeCatalog,
  runtimeRoot,
} from "./runtime-components.mjs";
import { x as extract } from "tar";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Usage: pack-cli-smoke.mjs <empty-directory>");
const repository = JSON.parse(
  readFileSync(join(root, "packages/cli/package.json"), "utf8")
).repository;
assert.ok(repository?.url, "CLI source repository metadata is required");
// npm provenance rejects generated artifacts without their source repository.
for (const [key, component] of Object.entries(COMPONENTS)) {
  const pkg = JSON.parse(
    readFileSync(join(runtimeRoot, key, "package.json"), "utf8")
  );
  assert.equal(
    pkg.repository?.url,
    repository.url,
    `${component.name} must declare its source repository for npm provenance`
  );
}
mkdirSync(destination); // Refuse to overwrite an existing installation.
const staging = join(destination, "packages");
mkdirSync(staging);
const tarballs = [];
// Install exactly the CLI's transitive workspace dependency closure. Installing
// the worker or inference package as another root would hide CLI size leaks.
const needed = new Set(["@lobu/cli"]);
const published = publisher.PACKAGES.map((entry) => ({
  ...entry,
  pkg: entry.transform(
    JSON.parse(readFileSync(join(root, entry.dir, "package.json"), "utf8"))
  ),
}));
for (;;) {
  const count = needed.size;
  for (const { pkg } of published) {
    if (!needed.has(pkg.name)) continue;
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }))
      if (name.startsWith("@lobu/")) needed.add(name);
  }
  if (count === needed.size) break;
}
for (const { dir, transform } of publisher.PACKAGES) {
  const source = join(root, dir);
  const pkg = transform(
    JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  );
  if (!needed.has(pkg.name)) continue;
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
  assertPortableArtifact(target, root);
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
  assert.ok(
    !/(?:^|\/)node_modules\/(?:embedded-postgres|@embedded-postgres\/[^/]+|@xenova\/transformers|onnxruntime-[^/]+|playwright(?:-vanilla|-core)?|patchright(?:-core)?|isolated-vm(?:-next)?|@lobu\/(?:connector-worker|embeddings))(?:\/|$)/.test(
      path
    ),
    `${path} leaked into the base CLI installation`
  );
  assert.ok(
    !/(?:^|\/)node_modules\/(?:@anthropic-ai\/claude-agent-sdk(?:-[^/]+)?|@openai\/codex(?:-[^/]+)?|@agentclientprotocol\/(?:claude-agent-acp|codex-acp))(?:\/|$)/.test(
      path
    ),
    `${path} would install an agent engine; ACP adapters must ship as JavaScript bundles`
  );
  if (/(?:^|\/)node_modules\/@lobu\/[^/]+$/.test(path)) {
    assert.ok(
      pkg.resolved?.startsWith("file:"),
      `${path} resolved outside the candidate tarballs`
    );
    assert.notEqual(pkg.link, true, `${path} is a workspace link`);
  }
}

const cliPath = join(destination, "node_modules/@lobu/cli/bin/lobu.js");
const cacheRoot = join(destination, "runtime");
const env = { ...process.env, LOBU_RUNTIME_CACHE_DIR: cacheRoot };
run("node", [cliPath, "--help"], destination, env);
run("node", [cliPath, "daemon", "--help"], destination, env);
assert.equal(existsSync(cacheRoot), false, "help must not install any runtime");

// Install the exact component tarballs into a separate cache, through the
// shipping installer. No workspace resolution or published siblings stand in.
const { ensureComponent } = await import(
  pathToFileURL(
    join(
      destination,
      "node_modules/@lobu/cli/dist/internal/runtime-components.js"
    )
  ).href
);
const catalog = runtimeCatalog();
for (const [key, component] of Object.entries(COMPONENTS)) {
  const source = join(runtimeRoot, key);
  const target = join(staging, component.name.replaceAll("/", "-"));
  cpSync(source, target, { recursive: true });
  lockRuntimeComponent(target);
  // Publish these exact tested locks; do not resolve a newer graph afterwards.
  for (const lock of ["dist/dependencies.bun.lock", "npm-shrinkwrap.json"])
    cpSync(join(target, lock), join(source, lock));
  const tarball = join(destination, `${key}.tgz`);
  assertPortableArtifact(target, root);
  run("bun", ["pm", "pack", "--ignore-scripts", "--filename", tarball], target);
  await ensureComponent(catalog[key], {
    cacheRoot,
    fetchArtifact: async (_descriptor, directory) =>
      extract({ file: tarball, cwd: directory, strip: 1, strict: true }),
  });
}
run("node", [cliPath, "runtime", "install", "--offline"], destination, env);
run(
  "node",
  [cliPath, "connector", "runtime-self-check", "--json"],
  destination,
  env
);
// Exercise the shipping npm fallback with Bun absent from PATH. Native addons
// must work with lifecycle scripts disabled on both supported installers.
if (process.platform !== "win32") {
  const nodeOnlyBin = join(destination, "node-only-bin");
  mkdirSync(nodeOnlyBin);
  symlinkSync(process.execPath, join(nodeOnlyBin, "node"));
  const npm = spawnSync("which", ["npm"], { encoding: "utf8" });
  assert.equal(
    npm.status,
    0,
    "npm must be available for consumer verification"
  );
  symlinkSync(realpathSync(npm.stdout.trim()), join(nodeOnlyBin, "npm"));
  const nodeOnlyEnv = {
    ...env,
    PATH: `${nodeOnlyBin}:/usr/bin:/bin`,
    LOBU_RUNTIME_CACHE_DIR: join(destination, "npm-runtime"),
  };
  const installer = pathToFileURL(
    join(
      destination,
      "node_modules/@lobu/cli/dist/internal/runtime-components.js"
    )
  ).href;
  const script = `
    import { createRequire } from "node:module";
    import { ensureComponent } from ${JSON.stringify(installer)};
    const require = createRequire(${JSON.stringify(pathToFileURL(cliPath).href)});
    const { x: extract } = require("tar");
    for (const [key, component] of Object.entries(${JSON.stringify(catalog)})) {
      await ensureComponent(component, {
        fetchArtifact: (_descriptor, directory) => extract({ file: ${JSON.stringify(destination)} + "/" + key + ".tgz", cwd: directory, strip: 1, strict: true }),
      });
    }
  `;
  run(
    process.execPath,
    ["--input-type=module", "--eval", script],
    destination,
    nodeOnlyEnv
  );
  run(
    process.execPath,
    [cliPath, "connector", "runtime-self-check", "--json"],
    destination,
    nodeOnlyEnv
  );
}
run(
  process.execPath,
  [join(root, "scripts/verify-cli-runtime.mjs"), destination],
  destination
);
run(
  process.execPath,
  [
    join(root, "scripts/daemon-mcp-smoke.mjs"),
    join(destination, "node_modules/.bin/lobu"),
    join(destination, "daemon-mcp-logs"),
    cacheRoot,
  ],
  destination
);
console.log(
  `Candidate CLI: ${join(destination, "node_modules/@lobu/cli/bin/lobu.js")}`
);

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
