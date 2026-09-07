/**
 * The published @lobu/cli tarball installs its dependencies from the registry,
 * not from bun.lock, so caret ranges let better-auth, @better-auth/core, and
 * @better-auth/passkey drift onto different releases. Exact, identical pins in
 * every publishing manifest keep one Better Auth tree in the installed CLI.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("published auth dependency stability", () => {
  it("pins Better Auth packages exactly and consistently", () => {
    const versions = ["packages/cli", "packages/server"].map((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")
      ) as { dependencies?: Record<string, string> };
      const betterAuth = manifest.dependencies?.["better-auth"];
      const core = manifest.dependencies?.["@better-auth/core"];
      const passkey = manifest.dependencies?.["@better-auth/passkey"];
      expect(betterAuth).toMatch(/^\d+\.\d+\.\d+$/);
      expect(core).toBe(betterAuth);
      expect(passkey).toBe(betterAuth);
      return betterAuth;
    });
    expect(new Set(versions).size).toBe(1);
  });
});
