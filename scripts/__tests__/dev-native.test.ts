import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-native-test-"));
  roots.push(root);
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  mkdirSync(join(root, "bin"));
  for (const pkg of ["core", "connector-sdk", "owletto"])
    mkdirSync(join(root, `packages/${pkg}/dist`), { recursive: true });
  cpSync(
    resolve(import.meta.dir, "../dev-native.sh"),
    join(root, "scripts/dev-native.sh")
  );
  writeFileSync(
    join(root, "scripts/lib/dev-app-url.sh"),
    "lobu_dev_print_app_url() { :; }\n"
  );
  writeFileSync(join(root, ".env"), "");
  writeFileSync(
    join(root, "bin/node"),
    `#!/bin/sh
case "$1" in
  -p) echo 22 ;;
  scripts/lib/dev-resources.mjs) echo "\${NODE_OPTIONS:-}"; exit "\${RESOURCE_EXIT:-0}" ;;
  scripts/build-packages.mjs) echo "$*" >> calls; exit "\${BUILD_EXIT:-0}" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(root, "bin/bun"),
    `#!/bin/sh
echo "$*" >> "$TEST_ROOT/calls"
if [ "$*" = 'run dev optimize' ]; then exit "\${PREBUNDLE_EXIT:-0}"; fi
`,
    { mode: 0o755 }
  );
  const run = (buildExit: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", "scripts/dev-native.sh"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}/bin:${process.env.PATH}`,
        TEST_ROOT: root,
        BUILD_EXIT: buildExit,
        DATABASE_URL: `file://${root}/data`,
        OPEN: "0",
        NODE_ENV: "development",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  return { root, run };
}

test("retries dependencies after a partial build and never builds production apps", () => {
  const { root, run } = fixture();
  expect(run("37").exitCode).toBe(37);
  expect(readFileSync(join(root, "calls"), "utf8")).toBe(
    "scripts/build-packages.mjs --skip-applications\n"
  );
  expect(run("0").exitCode).toBe(0);
  const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n");
  expect(calls).toEqual([
    "scripts/build-packages.mjs --skip-applications",
    "scripts/build-packages.mjs --skip-applications",
    "run build:mcp-apps",
    "run dev optimize",
    "run --filter @lobu/server dev:local",
  ]);
});

test("does not start the server when dependency pre-bundling fails", () => {
  const { root, run } = fixture();
  expect(run("0", { PREBUNDLE_EXIT: "41" }).exitCode).toBe(41);
  expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toEqual([
    "scripts/build-packages.mjs --skip-applications",
    "run build:mcp-apps",
    "run dev optimize",
  ]);
});

test("stops if resource budgeting fails before builds or after loading env", () => {
  const { root, run } = fixture();
  expect(run("0", { RESOURCE_EXIT: "38" }).exitCode).toBe(38);
  expect(() => readFileSync(join(root, "calls"))).toThrow();

  writeFileSync(join(root, ".env"), "RESOURCE_EXIT=39\n");
  expect(run("0").exitCode).toBe(39);
  expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toEqual([
    "scripts/build-packages.mjs --skip-applications",
    "run build:mcp-apps",
  ]);
});
