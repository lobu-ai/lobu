import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, installScaffoldedProjectDeps } from "../../init.js";
import {
  checkProjectDeps,
  type DependencySession,
  installProjectDeps,
  withProjectDependencies,
} from "../ensure-deps-installed.js";

const originalPath = process.env.PATH;
const dirs: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "lobu-deps-"));
  dirs.push(dir);
  return dir;
}
function json(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}
function project(root = temporary()) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "lobu.config.ts"), "export default {}");
  json(join(root, "package.json"), { name: "fixture" });
  json(join(root, "package-lock.json"), {});
  return root;
}
// Only installer mechanics are recorded here. The Node e2e uses real Bun/npm.
function installer(exitCode = 0, version = "11.6.0") {
  const bin = temporary();
  const log = join(bin, "calls");
  const status = join(bin, "status");
  writeFileSync(status, String(exitCode));
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nprintf '%s\\n' "$PWD $*" >> '${log}'\nexit "$(cat '${status}')"\n`
  );
  chmodSync(join(bin, "npm"), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  return {
    log,
    status,
    calls: () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}
const noop = async () => undefined;
const frozen = (
  root: string,
  session: DependencySession = new Map(),
  use = noop
) => withProjectDependencies(root, { session, stdio: "pipe" }, use);
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("project dependency policy", () => {
  test("frozen install runs even when node_modules is newer than the lockfile", async () => {
    const root = project();
    mkdirSync(join(root, "node_modules"));
    const npm = installer();
    await frozen(root);
    expect(npm.calls()).toEqual([
      `${realpathSync(root)} ci --ignore-scripts --no-audit --no-fund --include=dev`,
    ]);
  });
  test("a session reuses source edits, but manifest/lock/config changes reverify", async () => {
    const root = project();
    const npm = installer();
    const session = new Map();
    await frozen(root, session);
    writeFileSync(join(root, "connector.ts"), "export default 42");
    await frozen(root, session);
    expect(npm.calls()).toHaveLength(1);
    json(join(root, "package.json"), { name: "renamed" });
    await frozen(root, session);
    json(join(root, "package-lock.json"), { lockfileVersion: 3 });
    await frozen(root, session);
    writeFileSync(join(root, ".npmrc"), "legacy-peer-deps=true");
    await frozen(root, session);
    expect(npm.calls()).toHaveLength(4);
    await frozen(root);
    expect(npm.calls()).toHaveLength(5);
  });
  test("a failed install never verifies the session or invokes compilation", async () => {
    const root = project();
    const npm = installer(1);
    const session = new Map();
    let compiled = false;
    await expect(
      frozen(root, session, async () => {
        compiled = true;
      })
    ).rejects.toThrow("npm ci");
    expect(compiled).toBe(false);
    expect(session.size).toBe(0);
    writeFileSync(npm.status, "0");
    await frozen(root, session);
    expect(npm.calls()).toHaveLength(2);
    expect(existsSync(join(root, "package.json.lock"))).toBe(false);
  });
  test("a directory without lobu.config.ts is never installed into", async () => {
    const root = project();
    const npm = installer();
    rmSync(join(root, "lobu.config.ts"));
    await frozen(root);
    expect(npm.calls()).toHaveLength(0);
    expect(existsSync(join(root, "package.json.lock"))).toBe(false);
  });
  test("read-only inspection never calls an installer", async () => {
    const root = project();
    const npm = installer();
    await withProjectDependencies(root, { mode: "read" }, noop);
    expect(npm.calls()).toHaveLength(0);
    expect(existsSync(join(root, "package.json.lock"))).toBe(false);
    json(join(root, "package.json"), { dependencies: { absent: "1.0.0" } });
    expect(() => checkProjectDeps(root)).toThrow(
      "Missing project dependency absent"
    );
    expect(npm.calls()).toHaveLength(0);
  });
  test("read-only config inspection preserves zero-install SDK aliases", async () => {
    const root = project();
    const npm = installer();
    rmSync(join(root, "package-lock.json"));
    json(join(root, "package.json"), {
      devDependencies: { "@lobu/cli": "1.0.0", "@lobu/connector-sdk": "1.0.0" },
    });
    await withProjectDependencies(root, { mode: "read" }, noop);
    expect(npm.calls()).toHaveLength(0);
    await expect(frozen(root)).rejects.toThrow("Missing lockfile");
    json(join(root, "package-lock.json"), {});
    await expect(frozen(root)).rejects.toThrow("Installation did not provide");
  });
  test("exact prerelease manager versions are accepted", async () => {
    const root = project();
    const npm = installer(0, "11.6.0-next.1");
    json(join(root, "package.json"), { packageManager: "npm@11.6.0-next.1" });
    await frozen(root);
    expect(npm.calls()).toHaveLength(1);
  });
  test("missing dependency invalidates verified inputs instead of using CLI packages", async () => {
    const root = project();
    const npm = installer();
    const session = new Map();
    json(join(root, "package.json"), { dependencies: { fixture: "1.0.0" } });
    mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
    json(join(root, "node_modules", "fixture", "package.json"), {
      name: "fixture",
      version: "1.0.0",
    });
    await frozen(root, session);
    rmSync(join(root, "node_modules"), { recursive: true });
    await expect(frozen(root, session)).rejects.toThrow(
      "Installation did not provide project dependency"
    );
    expect(npm.calls()).toHaveLength(2);
    expect(session.size).toBe(0);
  });
  test("missing Bun never falls back to the available npm", async () => {
    const root = project();
    const npm = installer();
    rmSync(join(root, "package-lock.json"));
    writeFileSync(join(root, "bun.lock"), "{}");
    await expect(frozen(root)).rejects.toThrow("Install bun");
    expect(npm.calls()).toHaveLength(0);
  });
  test.each([
    "bun.lock",
    "bun.lockb",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
  ])("conflicting %s is refused", async (name) => {
    const root = project();
    const npm = installer();
    writeFileSync(join(root, name), "{}");
    await expect(frozen(root)).rejects.toThrow("Conflicting lockfiles");
    expect(npm.calls()).toHaveLength(0);
  });
  test.each([
    "yarn.lock",
    "pnpm-lock.yaml",
  ])("unsupported manager %s is refused", async (name) => {
    const root = project();
    installer();
    rmSync(join(root, "package-lock.json"));
    writeFileSync(join(root, name), "{}");
    await expect(frozen(root)).rejects.toThrow("supports Bun and npm");
  });
  test("a missing lockfile cannot be created by apply", async () => {
    const root = project();
    const npm = installer();
    rmSync(join(root, "package-lock.json"));
    await expect(frozen(root)).rejects.toThrow("Missing lockfile");
    expect(npm.calls()).toHaveLength(0);
  });
  test.each([
    "bun@1.3.14",
    "yarn@4.0.0",
    "npm@99.0.0",
  ])("manager declaration %s is enforced", async (packageManager) => {
    const root = project();
    const npm = installer();
    json(join(root, "package.json"), { packageManager });
    await expect(frozen(root)).rejects.toThrow();
    expect(npm.calls()).toHaveLength(0);
  });
  test("matching declared npm version is accepted", async () => {
    const root = project();
    const npm = installer();
    json(join(root, "package.json"), { packageManager: "npm@11.6.0" });
    await frozen(root);
    expect(npm.calls()).toHaveLength(1);
  });
  test("the lock covers compilation and releases after compilation fails", async () => {
    const root = project();
    const npm = installer();
    const session = new Map();
    const order: string[] = [];
    const first = frozen(root, session, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      order.push("first-end");
      throw new Error("compile failed");
    });
    const second = frozen(root, session, async () => {
      order.push("second");
    });
    await expect(first).rejects.toThrow("compile failed");
    await second;
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(npm.calls()).toHaveLength(1);
  });
});

describe("workspace ownership", () => {
  test("declared members use their owning lockfile and sibling manifest changes invalidate the session", async () => {
    const root = project();
    const npm = installer();
    const session = new Map();
    json(join(root, "package.json"), { workspaces: ["packages/*"] });
    const member = join(root, "packages", "app");
    const sibling = join(root, "packages", "helper");
    for (const dir of [member, sibling]) {
      mkdirSync(dir, { recursive: true });
      json(join(dir, "package.json"), {
        name: dir === member ? "app" : "helper",
      });
    }
    writeFileSync(join(member, "lobu.config.ts"), "export default {}");
    await frozen(member, session);
    json(join(sibling, "package.json"), { name: "helper", version: "2.0.0" });
    await frozen(member, session);
    expect(npm.calls()).toHaveLength(2);
    expect(
      npm.calls().every((line) => line.startsWith(realpathSync(root)))
    ).toBe(true);
    expect(existsSync(join(member, "package-lock.json"))).toBe(false);
  });
  test("an unrelated ancestor package cannot own a standalone project", async () => {
    const root = project();
    const npm = installer();
    json(join(root, "package.json"), { workspaces: ["packages/*"] });
    const child = project(join(root, "examples", "app"));
    await frozen(child);
    expect(npm.calls()[0]).toStartWith(realpathSync(child));
  });
  test.each([
    "{invalid",
    JSON.stringify({ workspaces: ["../foreign"] }),
  ])("an invalid unrelated ancestor cannot break a standalone project: %s", async (manifest) => {
    const root = project();
    const npm = installer();
    writeFileSync(join(root, "package.json"), manifest);
    const child = project(join(root, "app"));
    await frozen(child);
    expect(npm.calls()[0]).toStartWith(realpathSync(child));
  });
  test("a nested workspace lockfile is rejected rather than rewritten", async () => {
    const root = project();
    installer();
    json(join(root, "package.json"), { workspaces: ["app"] });
    const child = project(join(root, "app"));
    await expect(frozen(child)).rejects.toThrow("has its own lockfile");
  });
});

describe("init owns lockfile creation", () => {
  test("installs without frozen mode", async () => {
    const root = project();
    const npm = installer();
    await installProjectDeps(root, { stdio: "pipe" });
    expect(npm.calls()[0]).toContain(
      "install --ignore-scripts --no-audit --no-fund --include=dev"
    );
  });
  test("returns a warning when installation fails", async () => {
    const root = project();
    installer(1);
    expect(await installScaffoldedProjectDeps(root)).toContain(
      "Could not install"
    );
  });
  test("scaffolding still installs its generated dependencies", async () => {
    const root = temporary();
    json(join(root, "package-lock.json"), {});
    const npm = installer();
    await initCommand(root, undefined, { yes: true, here: true });
    expect(npm.calls()[0]).toContain("install --ignore-scripts");
    expect(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
        .devDependencies["@lobu/connector-sdk"]
    ).toBeDefined();
  });
});
