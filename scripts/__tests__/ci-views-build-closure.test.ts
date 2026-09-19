import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CI views build closure (PR #3649 run 35400662185): the server integration
 * jobs build workspace dists from an inline list that drifted from
 * scripts/build-packages.mjs — `packages/views` was missing, so
 * `require.resolve("@lobu/views")` in packages/server/src/views/views.ts
 * settled nowhere and every source-view compile failed in CI with
 * `Could not resolve "@lobu/views"` (23 tests across manage-views,
 * loader, resources, actions and all-tools) while workspace checkouts
 * kept passing on their stale local dist.
 *
 * These pin the closure: every inline "Build packages server depends on"
 * block must compile @lobu/views before the vitest shards run.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");

describe("ci views build closure", () => {
  it("builds @lobu/views in every inline server-depends-on block", () => {
    const yml = readFileSync(CI_YML, "utf8");
    const blocks = yml.split("Build packages server depends on");
    // Header + one block per integration job using the inline list.
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks.slice(1)) {
      // The first block carries the long dependency-order comment, so the
      // window must cover the whole inline run list (not just its header).
      const section = block.slice(0, 3500);
      expect(section).toContain("cd packages/views && bun run build");
    }
  });

  it("builds the server bundle before the repo-scripts artifact test", () => {
    // scripts/__tests__/server-views-vendor.test.ts throws "missing build
    // prerequisite packages/server/dist/server.bundle.mjs" unless the bundle
    // exists, but the unit job's graph build uses --skip-applications (PR
    // #3649 run 35402512013: green locally on a stale dist, red in CI on a
    // clean cache). The unit job must therefore build the server bundle
    // between the graph build and `bun test scripts`.
    const yml = readFileSync(CI_YML, "utf8");
    const graphAt = yml.indexOf(
      "node scripts/build-packages.mjs --skip-applications"
    );
    const scriptsAt = yml.indexOf("bun test scripts --coverage");
    expect(graphAt).toBeGreaterThanOrEqual(0);
    expect(scriptsAt).toBeGreaterThan(graphAt);
    const section = yml.slice(graphAt, scriptsAt);
    expect(section).toContain("build:server");
    expect(section).toContain("packages/server/dist/server.bundle.mjs");
  });

  it("executes the views guest suite in its own failing-closed unit step", () => {
    // F15 (round 10): the 29-test packages/views guest suite (F10/F14) was
    // built but never selected by any CI `bun test` invocation. This pins
    // the separate `views guest runtime` step immediately after core/cli so
    // the guest DOM globals stay out of the core/CLI process, and pins
    // fail-closed execution (no continue-on-error, no opt-in condition, no
    // failure-swallowing suffix).
    const yml = readFileSync(CI_YML, "utf8");
    const coreAt = yml.indexOf("- name: core / cli (bun:test)");
    const viewsAt = yml.indexOf("- name: views guest runtime (bun:test)");
    const scriptsAt = yml.indexOf("- name: repo scripts (bun:test)");
    expect(coreAt).toBeGreaterThanOrEqual(0);
    expect(viewsAt).toBeGreaterThan(coreAt);
    expect(scriptsAt).toBeGreaterThan(viewsAt);
    const nextStepAt = yml.indexOf("- name:", viewsAt + 1);
    expect(nextStepAt).toBeGreaterThan(viewsAt);
    const step = yml.slice(viewsAt, nextStepAt);
    expect(step).toContain(
      "bun test packages/views/src --coverage --timeout 30000"
    );
    expect(step).toContain("mv coverage/lcov.info coverage/views.lcov.info");
    // Separate process: the core/cli invocation must not absorb views, and
    // the views invocation must not absorb core/cli.
    const coreStep = yml.slice(coreAt, viewsAt);
    expect(coreStep).not.toContain("packages/views");
    expect(step).not.toContain("packages/core");
    expect(step).not.toContain("packages/cli");
    // Fail closed: no continue-on-error, no conditional run, no swallowed exit.
    expect(step).not.toContain("continue-on-error");
    expect(step).not.toContain("if:");
    expect(step).not.toContain("|| true");
    expect(step).not.toContain("|| :");
    expect(step).not.toContain("; exit 0");
  });

  it("uploads the views guest coverage artifact", () => {
    // The unit Upload coverage step uses an explicit `files:` list; an
    // omitted entry silently drops the artifact. This pins
    // coverage/views.lcov.info alongside the other unit reports.
    const yml = readFileSync(CI_YML, "utf8");
    const uploadAt = yml.indexOf("- name: Upload coverage");
    expect(uploadAt).toBeGreaterThanOrEqual(0);
    const section = yml.slice(uploadAt, uploadAt + 1200);
    expect(section).toContain("coverage/views.lcov.info");
  });
});
