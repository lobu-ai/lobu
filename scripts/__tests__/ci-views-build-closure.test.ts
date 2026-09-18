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
});
