import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoBrowserTooling,
  pruneBrowserTooling,
} from "../image-browser-tooling.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lobu-image-browser-"));
  roots.push(root);
  return root;
}
function install(root: string, path: string, name: string) {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "0.0.0" })
  );
  writeFileSync(join(directory, "cli.js"), "// synthetic executable\n");
  return directory;
}
function link(root: string, path: string, target: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(relative(dirname(file), target), file);
  return file;
}

describe("production image browser tooling", () => {
  it.each([
    "playwright",
    "playwright-core",
    "@playwright/test",
    "@playwright/browser-chromium",
    "patchright",
    "patchright-core",
    "puppeteer",
    "puppeteer-core",
    "@puppeteer/browsers",
  ])("finds %s by manifest identity through an unrelated installation alias", (name) => {
    const root = fixture();
    const browser = install(root, "node_modules/synthetic-alias", name);
    expect(() => assertNoBrowserTooling(root)).toThrow(name);
    pruneBrowserTooling(root);
    expect(existsSync(browser)).toBe(false);
    expect(() => assertNoBrowserTooling(root)).not.toThrow();
  });

  it("removes flat packages and executable links while preserving runtime dependencies", () => {
    const root = fixture();
    const browser = install(
      root,
      "node_modules/playwright-vanilla",
      "playwright"
    );
    const core = install(
      root,
      "node_modules/playwright-core",
      "playwright-core"
    );
    const runtime = install(root, "node_modules/dotenv", "dotenv");
    const bin = link(
      root,
      "node_modules/.bin/playwright",
      join(browser, "cli.js")
    );
    const retainedBin = link(
      root,
      "node_modules/.bin/synthetic-runtime",
      join(runtime, "cli.js")
    );
    expect(pruneBrowserTooling(root)).toBe(2);
    expect(existsSync(browser)).toBe(false);
    expect(existsSync(core)).toBe(false);
    expect(() => lstatSync(bin)).toThrow();
    expect(existsSync(retainedBin)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).name
    ).toBe("dotenv");
    expect(pruneBrowserTooling(root)).toBe(0);
  });

  it("handles nested dependencies and isolated stores without deleting their owners", () => {
    const root = fixture();
    const owner = install(
      root,
      "packages/server/node_modules/synthetic-owner",
      "synthetic-owner"
    );
    const nested = install(
      root,
      "packages/server/node_modules/synthetic-owner/node_modules/alias",
      "puppeteer"
    );
    const stored = install(
      root,
      "node_modules/.bun/synthetic-store/node_modules/alias",
      "playwright"
    );
    const alias = link(root, "node_modules/browser-alias", stored);
    const nestedLink = link(
      root,
      "packages/server/node_modules/browser-alias",
      stored
    );
    const bin = link(root, "node_modules/.bin/browser", join(stored, "cli.js"));
    pruneBrowserTooling(root);
    expect(existsSync(owner)).toBe(true);
    for (const path of [nested, stored, alias, nestedLink, bin]) {
      expect(() => lstatSync(path)).toThrow();
    }
  });

  it("unlinks external browser aliases without modifying their targets", () => {
    const root = fixture();
    const outside = fixture();
    const browser = install(outside, "browser", "playwright");
    const alias = link(root, "node_modules/alias", browser);
    const bin = link(
      root,
      "node_modules/.bin/browser",
      join(browser, "cli.js")
    );
    pruneBrowserTooling(root);
    expect(existsSync(browser)).toBe(true);
    expect(() => lstatSync(alias)).toThrow();
    expect(() => lstatSync(bin)).toThrow();
  });

  it("preserves development declarations, similarly named packages, and unrelated links", () => {
    const root = fixture();
    const runtime = install(
      root,
      "node_modules/playwright-utils",
      "synthetic-runtime"
    );
    const owner = install(root, "packages/server", "synthetic-server");
    writeFileSync(
      join(owner, "package.json"),
      JSON.stringify({
        name: "synthetic-server",
        devDependencies: { "playwright-vanilla": "npm:playwright@1.0.0" },
      })
    );
    const before = readFileSync(join(owner, "package.json"), "utf8");
    const retained = link(root, "node_modules/synthetic-server", owner);
    const dangling = link(
      root,
      "node_modules/.bin/unrelated-missing",
      join(root, "missing/cli.js")
    );
    pruneBrowserTooling(root);
    expect(existsSync(runtime)).toBe(true);
    expect(existsSync(retained)).toBe(true);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(owner, "package.json"), "utf8")).toBe(before);
  });

  it("fails inspection before removing packages if an installed manifest is malformed", () => {
    const root = fixture();
    const browser = install(root, "node_modules/alias", "playwright");
    const malformed = install(
      root,
      "node_modules/synthetic-broken",
      "synthetic-broken"
    );
    writeFileSync(join(malformed, "package.json"), "{");
    expect(() => pruneBrowserTooling(root)).toThrow();
    expect(existsSync(browser)).toBe(true);
  });

  it("exposes a failing read-only image check and an idempotent prune command", () => {
    const root = fixture();
    install(root, "node_modules/alias", "playwright");
    const script = fileURLToPath(
      new URL("../image-browser-tooling.mjs", import.meta.url)
    );
    const run = (mode: string) =>
      spawnSync("node", [script, mode, root], { encoding: "utf8" });
    const red = run("--check");
    expect(red.status).toBe(1);
    expect(red.stderr).toContain("Production image contains browser tooling");
    expect(run("--prune").status).toBe(0);
    expect(run("--check").status).toBe(0);
    expect(run("--prune").stdout).toContain("Removed 0");
  });
});
