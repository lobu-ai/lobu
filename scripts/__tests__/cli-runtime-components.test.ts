import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const manifest = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`packages/${name}/package.json`, root), "utf8")
  );

describe("CLI installation boundary", () => {
  test("built compiler retains source when loaded by Node", () => {
    const compiler = new URL(
      "packages/cli/dist/internal/connector-compiler.js",
      root
    );
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { createIsolateConnectorCompiler } from ${JSON.stringify(compiler.href)};
const source = 'export default class Probe { definition = { key: "test.probe", version: "1.0.0" }; }';
const artifact = await createIsolateConnectorCompiler().compileConnectorArtifactFromSource(source);
if (!artifact.compiledCode || artifact.sourceFiles.files[artifact.sourceFiles.entrypoint] !== source) {
  throw new Error('Compiled artifact did not retain its author source');
}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

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
