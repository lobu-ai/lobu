import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const manifest = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`packages/${name}/package.json`, root), "utf8")
  );

describe("CLI installation boundary", () => {
  test("does not install server, device, Postgres or local inference dependencies", () => {
    const cli = manifest("cli");
    const installed = { ...cli.dependencies, ...cli.optionalDependencies };
    for (const name of [
      "@lobu/connector-worker",
      "@lobu/embeddings",
      "embedded-postgres",
      "playwright",
      "playwright-vanilla",
      "isolated-vm",
      "isolated-vm-next",
      "sharp",
      "jimp",
      "@vercel/sandbox",
      "better-auth",
    ]) {
      expect(installed[name], name).toBeUndefined();
    }
  });

  test("removes the unused Playwright CDP implementation and production alias", () => {
    expect(
      existsSync(
        fileURLToPath(
          new URL("packages/connector-sdk/src/browser/network.ts", root)
        )
      )
    ).toBe(false);
    for (const name of ["cli", "connector-worker", "connector-sdk"]) {
      const pkg = manifest(name);
      expect(pkg.dependencies?.["playwright-vanilla"]).toBeUndefined();
      expect(pkg.peerDependencies?.["playwright-vanilla"]).toBeUndefined();
    }
  });
});
