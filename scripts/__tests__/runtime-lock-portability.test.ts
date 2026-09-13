import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockRuntimeComponent } from "../runtime-components.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("frozen runtime locks retain local package identities across installers", () => {
  const directory = mkdtempSync(join(tmpdir(), "lobu-lock-test-"));
  directories.push(directory);
  for (const name of ["dist", "vendor/example", "vendor/consumer"])
    mkdirSync(join(directory, name), { recursive: true });
  const writeJson = (path: string, value: unknown) =>
    writeFileSync(join(directory, path), JSON.stringify(value));
  writeJson("package.json", {
    name: "runtime-fixture",
    version: "1.0.0",
    dependencies: {
      example: "file:vendor/example",
      "@fixture/consumer": "file:vendor/consumer",
    },
  });
  // npm omits the name when it equals the directory basename. Bun 1.3's
  // migration then invents /example, which newer Bun correctly rejects.
  writeJson("vendor/example/package.json", {
    name: "example",
    version: "1.0.0",
    main: "index.js",
  });
  writeFileSync(
    join(directory, "vendor/example/index.js"),
    "module.exports = 42;"
  );
  writeJson("vendor/consumer/package.json", {
    name: "@fixture/consumer",
    version: "1.0.0",
    main: "index.js",
    dependencies: { example: "file:../example" },
  });
  writeFileSync(
    join(directory, "vendor/consumer/index.js"),
    'module.exports = require("example");'
  );

  lockRuntimeComponent(directory);
  const npmLock = JSON.parse(
    readFileSync(join(directory, "npm-shrinkwrap.json"), "utf8")
  );
  expect(npmLock.packages["vendor/example"]).toMatchObject({
    name: "example",
    version: "1.0.0",
  });
  expect(npmLock.packages["vendor/consumer"].name).toBe("@fixture/consumer");
  const bunLock = readFileSync(
    join(directory, "dist/dependencies.bun.lock"),
    "utf8"
  );
  expect(bunLock).toContain('"example@file:vendor/example"');
  expect(bunLock).not.toContain('"/example@');
  writeFileSync(join(directory, "bun.lock"), bunLock);

  for (const [command, args] of [
    [
      "bun",
      ["install", "--frozen-lockfile", "--ignore-scripts", "--linker=isolated"],
    ],
    ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
  ] as const) {
    const installed = spawnSync(command, [...args], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);
    const loaded = spawnSync(
      "node",
      [
        "-e",
        'if (require("example") !== 42 || require("@fixture/consumer") !== 42) process.exit(1)',
      ],
      {
        cwd: directory,
        encoding: "utf8",
      }
    );
    expect(loaded.status, loaded.stderr).toBe(0);
    rmSync(join(directory, "node_modules"), { recursive: true, force: true });
  }
}, 30_000);
