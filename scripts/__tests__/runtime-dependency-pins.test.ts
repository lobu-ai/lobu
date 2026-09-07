import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

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
