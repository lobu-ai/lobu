/**
 * `incrementCounter` / `setGauge` fail SILENTLY: an unregistered name logs a
 * warning and returns, so the metric never reaches /metrics and any alert
 * built on it is dead on arrival. Nothing at build time catches the mismatch —
 * a counter can be incremented on a hot path for months while reading as "no
 * events".
 *
 * This walks every literal `incrementCounter("…")` / `setGauge("…")` call in
 * the server source (either quote style) and matches it against what
 * /metrics exports, in both directions: writing an unregistered name fails
 * here instead of in production silence, and registering a name nothing
 * writes fails instead of exporting a permanently-zero series.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
// Importing the module runs its own initializeMetrics().
import { getMetricsText } from "../prometheus";

const SRC_ROOT = join(import.meta.dir, "../../..");
// Both quote styles: server sources are biome-excluded and mix ' and ", so a
// double-quote-only pattern silently skipped whole files (poll.ts,
// with-retry.ts, task-scheduler.ts, check-stalled-executions.ts).
const CALL_RE =
  /(?:incrementCounter|setGaugeInternal|setGauge)\(\s*["']([a-z_0-9]+)["']/g;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

function writtenMetricNames(): string[] {
  const names = new Set<string>();
  for (const file of walk(SRC_ROOT)) {
    if (file.includes("__tests__")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL_RE)) names.add(m[1]!);
  }
  return [...names].sort();
}

function exportedMetricNames(): string[] {
  return getMetricsText()
    .split("\n")
    .flatMap((line) => {
      const match = /^# HELP (lobu_[a-z_0-9]+) /.exec(line);
      return match ? [match[1]!] : [];
    });
}

describe("prometheus metric registration", () => {
  test("every written metric is registered", () => {
    const exported = getMetricsText();
    const used = writtenMetricNames();

    // Guard the guard: a regex that silently matches nothing would make this
    // test vacuously green.
    expect(used.length).toBeGreaterThan(0);

    const unregistered = used.filter((name) => !exported.includes(name));
    expect(unregistered).toEqual([]);
  });

  // The inverse direction: a registered metric nobody writes still exports a
  // permanently-zero series, which reads as "this never happens" instead of
  // "nothing measures this" — indistinguishable from a healthy signal on a
  // dashboard, and the reason the worker-deployment/message/proxy/queue
  // registrations were deleted.
  test("every registered metric is written somewhere", () => {
    const written = new Set(writtenMetricNames());
    const registered = exportedMetricNames();

    // Guard the guard: a HELP-line parse that matched nothing would make this
    // test vacuously green.
    expect(registered.length).toBeGreaterThan(0);

    const orphaned = registered.filter((name) => !written.has(name));
    expect(orphaned).toEqual([]);
  });
});
