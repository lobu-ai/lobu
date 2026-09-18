/**
 * PR4 dogfood coverage: the four shipped example views bundle under the same
 * sandbox rules as production (`bundleViewFromFile`, the apply-time path), so
 * a view that imports a forbidden specifier or leaks the build machine into
 * its bytes fails here, not after deploy.
 *
 * Unlike `view-bundler.test.ts` (inline fixtures), this suite reads the real
 * files the example configs list, pinning each view's key/attach/params/
 * actions contract end to end.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bundleViewFromFile } from "../view-bundler.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
const TEAM_VIEWS = join(REPO_ROOT, "examples", "lobu-team", "views");
const CRM_VIEWS = join(REPO_ROOT, "examples", "lobu-crm", "views");

async function bundle(rel: string, base: string) {
  return bundleViewFromFile(join(base, rel));
}

describe("dogfood views", () => {
  test("connection-health card declares its key, attach, filter and retry", async () => {
    const bundled = await bundle(join("connection", "health.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("connection-health");
    expect(bundled.metadata.attach).toEqual([
      { type: "engineering-task", placement: "overview" },
    ]);
    expect(bundled.metadata.params).toEqual({
      only: { type: "string", default: "all" },
    });
    expect(bundled.metadata.actions).toEqual({
      retry: { emits: "connection.retry_requested" },
    });
  });

  test("automation-runs tab declares its key, attach and status/window params", async () => {
    const bundled = await bundle(join("automation", "runs.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("automation-runs");
    expect(bundled.metadata.attach).toEqual([{ type: "engineering-task" }]);
    expect(bundled.metadata.params).toEqual({
      status: { type: "string", default: "all" },
      window: { type: "string", default: "24h" },
    });
    expect(bundled.metadata.actions ?? {}).toEqual({});
  });

  test("provider-refusals page declares its workspace attach and window param", async () => {
    const bundled = await bundle(join("pages", "refusals.tsx"), TEAM_VIEWS);
    expect(bundled.metadata.key).toBe("provider-refusals");
    expect(bundled.metadata.attach).toEqual([{ workspace: true }]);
    expect(bundled.metadata.params).toEqual({
      window: { type: "string", default: "7d" },
    });
  });

  test("account-360 declares its pilot card+tab attach and no actions", async () => {
    const bundled = await bundle(join("pilot", "account-360.tsx"), CRM_VIEWS);
    expect(bundled.metadata.key).toBe("account-360");
    expect(bundled.metadata.attach).toEqual([
      { type: "pilot", placement: "overview" },
      { type: "pilot", placement: "tab" },
    ]);
    expect(bundled.metadata.actions ?? {}).toEqual({});
  });

  test("every dogfood bundle is self-contained, small and portable", async () => {
    for (const [rel, base] of [
      [join("connection", "health.tsx"), TEAM_VIEWS],
      [join("automation", "runs.tsx"), TEAM_VIEWS],
      [join("pages", "refusals.tsx"), TEAM_VIEWS],
      [join("pilot", "account-360.tsx"), CRM_VIEWS],
    ] as Array<[string, string]>) {
      const bundled = await bundle(rel, base);
      // No guest SDK chain (spike: 378 KB of zod + MCP SDK in the bundle).
      expect(bundled.compiledCode).not.toContain("ext-apps");
      expect(bundled.compiledCode).not.toContain("@modelcontextprotocol");
      // Hand-written bridge + React stay well under the server bundle cap.
      expect(bundled.compiledCode.length).toBeLessThan(300_000);
      // Portable: neither the repo root nor the entry path leaked into bytes.
      expect(bundled.compiledCode).not.toContain(REPO_ROOT);
      expect(bundled.compiledCode).not.toContain(join(base, rel));
    }
  });
});
