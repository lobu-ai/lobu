/** Built Node CLI + real package managers, including frozen-lock failure. */
import { expect, test } from "bun:test";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const cli = resolve(import.meta.dir, "../../../../bin/lobu.js");
const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
function snapshot(root: string): string {
  const hash = createHash("sha256");
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest("hex");
}
for (const manager of ["bun", "npm"] as const) {
  test(`built CLI respects ${manager} frozen dependencies and read-only commands`, () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-deps-e2e-"));
    const home = join(root, "cli-state");
    mkdirSync(home);
    const project = join(root, "project");
    mkdirSync(project);
    const env = {
      ...process.env,
      HOME: home,
      LOBU_API_TOKEN: "",
      LOBU_CONTEXT: "local",
      NODE_ENV: "development",
    };
    const manifest = {
      name: "lobu-dependency-fixture",
      private: true,
      dependencies: { "is-number": "7.0.0" },
    };
    const packageFile = join(project, "package.json");
    const lock = join(
      project,
      manager === "bun" ? "bun.lock" : "package-lock.json"
    );
    const call = (...args: string[]) =>
      spawnSync(node, [cli, ...args], {
        cwd: project,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
    try {
      writeFileSync(packageFile, JSON.stringify(manifest));
      writeFileSync(
        join(project, "lobu.config.ts"),
        'import isNumber from "is-number"; if (!isNumber(42)) throw new Error("wrong dependency"); export default {kind:"project",agents:[]};'
      );
      // Lock creation is explicit fixture setup; Lobu execution must preserve it.
      execFileSync(
        manager,
        [
          "install",
          "--ignore-scripts",
          ...(manager === "npm" ? ["--no-audit", "--no-fund"] : []),
        ],
        { cwd: project, env, stdio: "pipe" }
      );
      const locked = readFileSync(lock);
      const beforeRead = snapshot(project);
      const validated = call("validate");
      expect(validated.status, validated.stdout + validated.stderr).toBe(0);
      call(
        "apply",
        "--dry-run",
        "--url",
        "http://127.0.0.1:1",
        "--org",
        "fixture"
      );
      expect(snapshot(project)).toBe(beforeRead);
      rmSync(join(project, "node_modules"), { recursive: true });
      const missing = call("validate");
      expect(missing.status).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain(
        "Missing project dependency"
      );
      expect(existsSync(join(project, "node_modules"))).toBe(false);
      // The endpoint is deliberately unavailable. Dependencies must be installed
      // and config evaluated before any remote apply can begin.
      const started = performance.now();
      const applied = call(
        "apply",
        "--yes",
        "--url",
        "http://127.0.0.1:1",
        "--org",
        "fixture"
      );
      expect(applied.stdout + applied.stderr).toContain("Config:");
      expect(
        JSON.parse(
          readFileSync(
            join(project, "node_modules/is-number/package.json"),
            "utf8"
          )
        ).version
      ).toBe("7.0.0");
      expect(readFileSync(lock).equals(locked)).toBe(true);
      console.log(
        `${manager}: clean built-CLI dependency preparation ${Math.round(performance.now() - started)}ms`
      );
      writeFileSync(
        packageFile,
        JSON.stringify({ ...manifest, dependencies: { "is-number": "6.0.0" } })
      );
      const mismatch = call(
        "apply",
        "--yes",
        "--url",
        "http://127.0.0.1:1",
        "--org",
        "fixture"
      );
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stdout + mismatch.stderr).toContain("failed in");
      expect(mismatch.stdout + mismatch.stderr).not.toContain("Config:");
      expect(readFileSync(lock).equals(locked)).toBe(true);
      expect(existsSync(join(project, "package.json.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}

test("real Bun workspace install uses the root lockfile through a built CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "lobu-workspace-e2e-"));
  const member = join(root, "packages/app");
  mkdirSync(member, { recursive: true });
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] })
    );
    writeFileSync(
      join(member, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        dependencies: { "is-number": "7.0.0" },
      })
    );
    writeFileSync(
      join(member, "lobu.config.ts"),
      'import isNumber from "is-number"; if (!isNumber(42)) throw new Error("wrong dependency"); export default {kind:"project",agents:[]};'
    );
    execFileSync("bun", ["install", "--ignore-scripts"], {
      cwd: root,
      stdio: "pipe",
    });
    const locked = readFileSync(join(root, "bun.lock"));
    const result = spawnSync(
      node,
      [
        cli,
        "apply",
        "--yes",
        "--url",
        "http://127.0.0.1:1",
        "--org",
        "fixture",
      ],
      { cwd: member, encoding: "utf8", timeout: 30_000 }
    );
    expect(result.stdout + result.stderr).toContain("Config:");
    expect(readFileSync(join(root, "bun.lock")).equals(locked)).toBe(true);
    expect(existsSync(join(member, "bun.lock"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test("built apply releases the dependency lock before contacting the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "lobu-deps-lock-e2e-"));
  const heldDuringRequest: boolean[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      heldDuringRequest.push(existsSync(join(root, "package.json.lock")));
      return Response.json(
        { error: "fixture stops remote apply" },
        { status: 401 }
      );
    },
  });
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", private: true })
    );
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "fixture",
        lockfileVersion: 3,
        packages: { "": { name: "fixture" } },
      })
    );
    writeFileSync(
      join(root, "lobu.config.ts"),
      'export default {kind:"project",agents:[]};'
    );
    await promisify(execFile)(
      node,
      [cli, "apply", "--yes", "--url", server.url.origin, "--org", "fixture"],
      {
        cwd: root,
        env: { ...process.env, LOBU_API_TOKEN: "fixture-token" },
        timeout: 30_000,
      }
    ).catch(() => undefined);
    expect(heldDuringRequest.length).toBeGreaterThan(0);
    expect(heldDuringRequest.every((held) => !held)).toBe(true);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
