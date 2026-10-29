/**
 * The server component freezes its dependency graph from this source manifest.
 * Caret ranges let Better Auth, core, passkey, and the Kysely adapter drift onto
 * different releases. Exact, identical pins in the owning manifest keep one
 * Better Auth tree in the installed runtime.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("published auth dependency stability", () => {
  it("pins Better Auth packages exactly and consistently", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/server/package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    const betterAuth = manifest.dependencies?.["better-auth"];
    const core = manifest.dependencies?.["@better-auth/core"];
    const passkey = manifest.dependencies?.["@better-auth/passkey"];
    const adapter = manifest.dependencies?.["@better-auth/kysely-adapter"];
    expect(betterAuth).toMatch(/^\d+\.\d+\.\d+$/);
    expect(core).toBe(betterAuth);
    expect(passkey).toBe(betterAuth);
    expect(adapter).toBe(betterAuth);
    const cli = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")
    );
    for (const name of [
      "better-auth",
      "@better-auth/core",
      "@better-auth/passkey",
      "@better-auth/kysely-adapter",
    ])
      expect(cli.dependencies?.[name]).toBeUndefined();
  });
});
