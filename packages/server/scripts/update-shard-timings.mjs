#!/usr/bin/env node
/**
 * Rewrite src/__tests__/setup/shard-timings.json from Vitest JSON reports.
 *
 * CI uploads each integration shard's report as the `vitest-report-<n>`
 * artifact. Pull all shards of one run and feed them in together:
 *
 *   gh run download <run-id> --pattern 'vitest-report-*' --dir /tmp/reports
 *   node packages/server/scripts/update-shard-timings.mjs /tmp/reports/{*}/vitest-report.json
 *
 * Only files at or above MIN_LISTED_MS are listed; everything else weighs the
 * mean of the unlisted files. Durations are rounded to 100ms so a refresh
 * shows only real movement.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_LISTED_MS = 2000;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(PACKAGE_ROOT, "src/__tests__/setup/shard-timings.json");

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error("usage: update-shard-timings.mjs <vitest-report.json>...");
  process.exit(1);
}

/**
 * Report paths are absolute on the machine that ran them. Re-anchor at the
 * repo-level directory the suite includes (`packages/server/` or `examples/`)
 * and key relative to the Vitest root, matching the sequencer's keys.
 */
function keyFor(name) {
  const path = name.split(sep).join("/");
  for (const anchor of ["/packages/server/", "/examples/"]) {
    const at = path.lastIndexOf(anchor);
    if (at >= 0) return posix.relative("packages/server", path.slice(at + 1));
  }
  return relative(PACKAGE_ROOT, name).split(sep).join("/");
}

const durations = new Map();
for (const path of reports) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  for (const file of report.testResults ?? []) {
    if (typeof file.startTime !== "number" || typeof file.endTime !== "number")
      continue;
    durations.set(
      keyFor(file.name),
      Math.max(0, file.endTime - file.startTime)
    );
  }
}
if (durations.size === 0) {
  console.error("no per-file timings found in the given reports");
  process.exit(1);
}

const round = (ms) => Math.round(ms / 100) * 100;
const listed = [...durations]
  .filter(([, ms]) => ms >= MIN_LISTED_MS)
  .sort(([a], [b]) => (a < b ? -1 : 1));
const unlisted = [...durations.values()].filter((ms) => ms < MIN_LISTED_MS);
const defaultMs = round(
  unlisted.reduce((sum, ms) => sum + ms, 0) / Math.max(1, unlisted.length)
);
const files = Object.fromEntries(listed.map(([key, ms]) => [key, round(ms)]));

writeFileSync(OUTPUT, `${JSON.stringify({ defaultMs, files }, null, 2)}\n`);
const total = [...durations.values()].reduce((sum, ms) => sum + ms, 0);
console.log(
  `${durations.size} files, ${(total / 1000).toFixed(0)}s total; listed ${listed.length}, defaultMs ${defaultMs} -> ${relative(process.cwd(), OUTPUT)}`
);
