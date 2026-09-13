import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureComponent } from "../../packages/cli/src/internal/runtime-components.js";
import {
  COMPONENTS,
  runtimeVerificationSource,
} from "../runtime-components.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "lobu-entrypoints-"));
  directories.push(directory);
  return directory;
}

async function file(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test("device entries load dependencies from installed packages, not staging copies", async () => {
  const directory = await temporary();
  await file(join(directory, "package.json"), '{"type":"module"}');
  for (const [owner, paths] of [
    [
      "cli",
      [
        "dist/commands/daemon.js",
        "dist/commands/automation.js",
        "dist/commands/connector.js",
      ],
    ],
    ["connector-worker", ["dist/bin.js"]],
  ] as const) {
    const installed = join(directory, "node_modules/@lobu", owner);
    const dependency = join(
      installed,
      "node_modules/@fixture/runtime-dependency"
    );
    await file(
      join(dependency, "package.json"),
      '{"type":"module","exports":"./index.js"}'
    );
    await file(
      join(dependency, "index.js"),
      'export default "installed dependency";'
    );
    for (const path of paths) {
      const source =
        'import value from "@fixture/runtime-dependency"; export default value;';
      await file(join(installed, path), source);
      await file(join(directory, "vendor", owner, path), source);
    }
  }
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      'import { pathToFileURL } from "node:url"; for (const path of process.argv.slice(1)) { const entry = await import(pathToFileURL(path)); if (entry.default !== "installed dependency") throw new Error("Wrong dependency"); }',
      ...Object.values(COMPONENTS.device.entries).map((entry) =>
        join(directory, entry)
      ),
    ],
    { encoding: "utf8", cwd: directory }
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test.each([
  "valid",
  ...Object.keys(COMPONENTS.device.entries),
  "worker-exit",
])("device verification gates cache activation: %s", async (scenario) => {
  const cacheRoot = await temporary();
  const component = {
    ...COMPONENTS.device,
    version: "20.0.0",
    verify: "dist/verify.mjs",
  };
  const installation = ensureComponent(component, {
    cacheRoot,
    fetchArtifact: async (_descriptor, directory) => {
      await file(
        join(directory, "package.json"),
        JSON.stringify({ ...component, type: "module" })
      );
      for (const [name, entry] of Object.entries(component.entries)) {
        let source = "export {};";
        if (name === scenario)
          source = 'import "@fixture/missing-runtime-dependency";';
        else if (name === "worker")
          source =
            scenario === "worker-exit"
              ? "process.exit(17);"
              : 'if (process.argv[2] !== "--help") throw new Error("Expected worker --help"); console.log("fixture worker usage"); process.exit(0);';
        await file(join(directory, entry), source);
      }
      const worker = join(directory, "node_modules/@lobu/connector-worker");
      await file(
        join(worker, "package.json"),
        JSON.stringify({
          type: "module",
          exports: {
            "./daemon": "./dist/daemon.mjs",
            "./executor/runtime": "./dist/executor.mjs",
          },
        })
      );
      await file(join(worker, "dist/daemon.mjs"), "export {};");
      await file(join(worker, "dist/executor.mjs"), "export {};");
      // Keep native verification healthy so only the selected entry can fail.
      for (const name of ["isolated-vm", "isolated-vm-next"]) {
        await file(
          join(directory, "node_modules", name, "package.json"),
          '{"main":"index.cjs"}'
        );
        await file(
          join(directory, "node_modules", name, "index.cjs"),
          "exports.Isolate = class { dispose() {} };"
        );
      }
      await file(
        join(directory, component.verify),
        runtimeVerificationSource("device", component)
      );
    },
    installDependencies: async () => undefined,
  });
  if (scenario === "valid") {
    const installed = await installation;
    for (const runtime of ["node", process.execPath]) {
      const result = spawnSync(runtime, [join(installed, component.verify)], {
        encoding: "utf8",
        cwd: installed,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    }
    await expect(
      ensureComponent(component, { cacheRoot, offline: true })
    ).resolves.toBe(installed);
    return;
  }
  await expect(installation).rejects.toThrow("Runtime verification failed");
  await expect(
    ensureComponent(component, { cacheRoot, offline: true })
  ).rejects.toThrow("not cached");
});
