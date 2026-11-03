#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Per-test/per-hook ceiling for the gateway lanes. Must be a CLI flag: Bun's
 * bunfig `[test].timeout` has been unreliable — these lanes carried
 * `timeout = 10000` for a long time and still died at exactly 5000ms, which is
 * why the flake survived every previous encounter looking already-handled.
 *
 * The number is derived, not guessed. Profiled 2026-08-12 on
 * `oauth-state-store.test.ts`: the once-per-lane `beforeAll`
 * (`ensureDbForGatewayTests`) costs ~1.43s — 659ms to spawn embedded Postgres
 * plus 768ms to run every migration — and bun charges it to the FIRST test in
 * the lane, which is why failures always surfaced as `OAuthStateStore >
 * (unnamed)`. The `beforeEach` `resetTestDatabase()` TRUNCATE of all 76 tables
 * is only ~150ms, so it was never the driver.
 *
 * Nothing here is pathologically slow; 1.43s of legitimate setup simply needs
 * more than 5s of headroom once several CI graphs share the machine. 30s keeps
 * ~20x margin over the measured cost while still failing a genuine hang far
 * inside the job's 15-minute limit.
 */
const GATEWAY_TEST_TIMEOUT_MS = 30_000;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = join(repoRoot, "packages/server");
const gatewayRoot = join(serverRoot, "src/gateway/__tests__");
const coverageRoot = join(serverRoot, "coverage");
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--plan") {
    console.error(`Unknown gateway-lane argument: ${arg}`);
    process.exit(2);
  }
}

function collectRootTreeTests(dir, tests = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectRootTreeTests(full, tests);
    else if (entry.endsWith(".test.ts")) tests.push(full);
  }
  return tests;
}

function partitionBySourceSize(files) {
  const lanes = [[], []];
  const bytes = [0, 0];
  // This suite contains a deliberate ~14s retry/ownership case. Source-size
  // balancing cannot see wall-clock sleeps, so pin it opposite the otherwise
  // slower lane using the measured GitHub/local timing rather than adding a
  // third runner or dynamically reshuffling test order.
  const slowOwnershipCase = join(
    gatewayRoot,
    "conversation-owned-elsewhere.test.ts"
  );
  if (files.includes(slowOwnershipCase)) {
    lanes[0].push(slowOwnershipCase);
    bytes[0] += statSync(slowOwnershipCase).size;
  }
  const largestFirst = files
    .filter((file) => file !== slowOwnershipCase)
    .sort((a, b) => {
      const sizeDelta = statSync(b).size - statSync(a).size;
      return sizeDelta || a.localeCompare(b);
    });
  for (const file of largestFirst) {
    const lane = bytes[0] <= bytes[1] ? 0 : 1;
    lanes[lane].push(file);
    bytes[lane] += statSync(file).size;
  }
  for (const lane of lanes) lane.sort();
  return { lanes, bytes };
}

function prefixLines(stream, prefix, output) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => output(`${prefix}${line}`));
  return new Promise((resolve) => lines.on("close", resolve));
}

async function runLane(index, files, databaseUrl) {
  const lane = index + 1;
  const laneCoverage = join(coverageRoot, `gateway-lane-${lane}`);
  rmSync(laneCoverage, { recursive: true, force: true });
  mkdirSync(laneCoverage, { recursive: true });

  const relativeFiles = files.map((file) => relative(serverRoot, file));
  console.log(
    `gateway lane ${lane}: ${relativeFiles.length} files, database ${new URL(databaseUrl).pathname.slice(1)}`
  );
  const child = spawn(
    "bun",
    [
      `--config=./bunfig.gateway-lane-${lane}.toml`,
      "test",
      ...relativeFiles,
      "--coverage",
      "--timeout",
      String(GATEWAY_TEST_TIMEOUT_MS),
    ],
    {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const stdout = prefixLines(
    child.stdout,
    `[gateway lane ${lane}] `,
    console.log
  );
  const stderr = prefixLines(
    child.stderr,
    `[gateway lane ${lane}] `,
    console.error
  );
  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await Promise.all([stdout, stderr]);

  const lcov = join(laneCoverage, "lcov.info");
  if (!result.error && result.code === 0 && !existsSync(lcov)) {
    return { lane, error: new Error(`coverage report missing: ${lcov}`) };
  }
  return { lane, ...result };
}

// Include descendants such as __tests__/routes/*.test.ts. The workflow's
// nested loop selects directories named __tests__, so those child directories
// are not selected there and remain exclusively owned by these lanes.
const files = collectRootTreeTests(gatewayRoot).sort();
if (files.length === 0) {
  console.error(`No gateway tests found under ${gatewayRoot}`);
  process.exit(1);
}

const { lanes, bytes } = partitionBySourceSize(files);
const assigned = new Set(lanes.flat());
if (
  assigned.size !== files.length ||
  lanes[0].some((file) => lanes[1].includes(file)) ||
  files.some((file) => !assigned.has(file))
) {
  console.error("Gateway lane partition is not a disjoint, complete test set");
  process.exit(1);
}

console.log(
  `gateway root partition: ${files.length} files; lane source bytes ${bytes.join(" / ")}`
);
if (args.has("--plan")) {
  for (const [index, lane] of lanes.entries()) {
    console.log(`lane ${index + 1}: ${lane.length} files`);
  }
  process.exit(0);
}

const databaseUrls = [
  process.env.GATEWAY_TEST_DATABASE_URL_1,
  process.env.GATEWAY_TEST_DATABASE_URL_2,
];
if (databaseUrls.some((url) => !url)) {
  console.error(
    "GATEWAY_TEST_DATABASE_URL_1 and GATEWAY_TEST_DATABASE_URL_2 are required"
  );
  process.exit(1);
}
// Gateway setup resets `public`; require an explicit test-name segment and
// never let concurrent lanes share a database target.
const parsedDatabaseUrls = databaseUrls.map((url) => new URL(url));
for (const url of parsedDatabaseUrls) {
  const database = url.pathname.slice(1);
  if (!/(^|[_-])test([_-]|$)/i.test(database)) {
    console.error(`Refusing non-test gateway lane database: ${database}`);
    process.exit(1);
  }
}
const databaseTargets = parsedDatabaseUrls.map(
  (url) => `${url.host}${url.pathname}`
);
if (new Set(databaseTargets).size !== databaseTargets.length) {
  console.error("Gateway lanes require two distinct databases");
  process.exit(1);
}

const results = await Promise.all(
  lanes.map((laneFiles, index) =>
    runLane(index, laneFiles, databaseUrls[index])
  )
);
const failures = results.filter((result) => result.error || result.code !== 0);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      `gateway lane ${failure.lane} failed: ${
        failure.error?.message ??
        `exit ${failure.code ?? "unknown"}${failure.signal ? ` (${failure.signal})` : ""}`
      }`
    );
  }
  process.exitCode = 1;
} else {
  console.log(`gateway lanes passed: ${files.length} files across 2 processes`);
}
