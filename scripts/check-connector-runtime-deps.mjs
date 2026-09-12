#!/usr/bin/env node
/**
 * Tripwire: assert that every dep declared in RUNTIME_PROVIDED_PACKAGES is
 * present in the worker package.json. The isolate compiler needs the SDK
 * for inlining; its externalized native imports are unsupported and are not
 * installation requirements.
 *
 * Run in CI; exits non-zero on drift.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const runtimeDepsSource = readFileSync(
  join(repoRoot, "packages/connector-worker/src/runtime-deps.ts"),
  "utf-8"
);

const sdkMatch = runtimeDepsSource.match(
  /CONNECTOR_SDK_RUNTIME_DEP\s*=\s*['"]([^'"]+)['"]\s*as\s+const/
);
const providedMatch = runtimeDepsSource.match(
  /RUNTIME_PROVIDED_PACKAGES\s*=\s*\[\s*CONNECTOR_SDK_RUNTIME_DEP\s*,?\s*\]\s*as\s+const/
);
if (!sdkMatch || !providedMatch) {
  console.error(
    "Compiler dependency list changed; update this packaging check"
  );
  process.exit(2);
}
const declared = [sdkMatch[1]];

const workerPkg = JSON.parse(
  readFileSync(
    join(repoRoot, "packages/connector-worker/package.json"),
    "utf-8"
  )
);
const installedDeps = new Set(Object.keys(workerPkg.dependencies ?? {}));

const missing = declared.filter((dep) => !installedDeps.has(dep));

if (missing.length > 0) {
  console.error(
    `❌ RUNTIME_PROVIDED_PACKAGES includes deps that are NOT in packages/connector-worker/package.json:\n` +
      missing.map((d) => `  - ${d}`).join("\n") +
      `\n\nDeclare compiler dependencies in the worker package\n` +
      `(packages/connector-worker/src/runtime-deps.ts).`
  );
  process.exit(1);
}

console.log(
  `✅ RUNTIME_PROVIDED_PACKAGES (${declared.join(", ")}) all installed in worker package.json`
);
