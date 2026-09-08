#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const knownArgs = new Set(["--skip-applications"]);
const unknownArgs = process.argv.slice(2).filter((arg) => !knownArgs.has(arg));
if (unknownArgs.length > 0) {
  console.error(
    `Unknown build-packages argument(s): ${unknownArgs.join(", ")}`
  );
  process.exit(2);
}
const skipApplications = process.argv.includes("--skip-applications");

function packageBuild(packageName, script = "build") {
  return {
    label: `packages/${packageName}`,
    cwd: fileURLToPath(new URL(`../packages/${packageName}/`, import.meta.url)),
    args: ["run", script],
  };
}

function runBuild(build) {
  console.log(`   📦 Building ${build.label}...`);
  return new Promise((resolve) => {
    const child = spawn("bun", build.args, {
      cwd: build.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", (error) => resolve({ ...build, error }));
    child.on("exit", (code, signal) => resolve({ ...build, code, signal }));
  });
}

async function runLayer(label, builds) {
  console.log(
    `🔹 ${label} (${builds.length} parallel build${builds.length === 1 ? "" : "s"})`
  );
  const results = await Promise.all(builds.map(runBuild));
  const failures = results.filter(
    (result) => result.error || result.code !== 0
  );
  if (failures.length === 0) return;

  for (const failure of failures) {
    const detail =
      failure.error?.message ??
      `exit ${failure.code ?? "unknown"}${failure.signal ? ` (${failure.signal})` : ""}`;
    console.error(`❌ ${failure.label}: ${detail}`);
  }
  throw new Error(
    `${failures.length} package build${failures.length === 1 ? "" : "s"} failed in ${label}`
  );
}

const layers = [
  [
    "foundations",
    [
      "core",
      "plugin-api",
      "pgvector-embedded",
      "client",
      "embeddings",
      "promptfoo-provider",
    ].map((name) => packageBuild(name)),
  ],
  [
    "contracts",
    ["plugin-host", "plugin-toolkit", "connector-sdk"].map((name) =>
      packageBuild(name)
    ),
  ],
  ["device-connectors", [packageBuild("device-connectors")]],
  [
    "plugins",
    ["plugin-memory", "plugin-conversations", "plugin-media", "plugin-mcp"].map(
      (name) => packageBuild(name)
    ),
  ],
  ["runtimes", ["connector-worker"].map((name) => packageBuild(name))],
];

if (!skipApplications) {
  const applications = [packageBuild("server", "build:server")];
  if (
    existsSync(new URL("../packages/owletto/package.json", import.meta.url))
  ) {
    applications.push(packageBuild("owletto"));
  } else {
    console.warn(
      "⚠️  packages/owletto absent — CLI will ship headless (API only)"
    );
  }
  layers.push(["applications", applications]);
} else {
  console.log("⏩ Skipping application bundles (server + Owletto)");
}
layers.push(["distribution", [packageBuild("cli")]]);

console.log("📦 Building TypeScript packages by dependency layer...");
try {
  for (const [label, builds] of layers) await runLayer(label, builds);
  console.log("✅ Package build completed successfully!");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
