import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import {
  checkNodeSupport,
  sandboxAvailableForNode,
} from "../internal/node-version.js";

// bin/lobu.js runs under Node in production (its shebang is `#!/usr/bin/env
// node`). `process.execPath` here is Bun, so invoke `node` through PATH.
const NODE = "node";
const temporaryDirs: string[] = [];

function spoofPreload(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lobu-nodever-"));
  temporaryDirs.push(dir);
  const file = join(dir, "spoof.cjs");
  writeFileSync(
    file,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(
      version
    )}, configurable: true });\n`
  );
  return file;
}

afterAll(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkNodeSupport", () => {
  test("classifies the running Node as supported (tests run on >=22)", () => {
    const support = checkNodeSupport();
    expect(support.ok).toBe(true);
  });

  test("sandbox availability follows the isolated-vm build matrix", () => {
    // isolated-vm@6 → 22–24; nothing on 25; isolated-vm@7 → 26+.
    expect(sandboxAvailableForNode(22)).toBe(true);
    expect(sandboxAvailableForNode(24)).toBe(true);
    expect(sandboxAvailableForNode(25)).toBe(false);
    expect(sandboxAvailableForNode(26)).toBe(true);
    // Below the floor is not "sandbox unavailable", it's unsupported entirely.
    expect(sandboxAvailableForNode(18)).toBe(false);
  });
});

describe("bin/lobu.js Node gate", () => {
  // Spoof process.versions.node via a preload that runs BEFORE the bin body,
  // so we can prove the guard fires on an old Node without needing one
  // installed. defineProperty is required — process.versions.node is read-only.
  const binEntry = join(import.meta.dir, "..", "..", "bin", "lobu.js");

  test("exits non-zero with an explicit message on Node 18", () => {
    const proc = spawnSync(NODE, [binEntry, "--version"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${spoofPreload("18.19.1")}`,
      },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");

    // The explicit, actionable message — NOT the raw undici crash.
    expect(out).toContain("Node.js 22 or newer");
    expect(out).toContain("18.19.1");
    expect(out).not.toContain("File is not defined");
    expect(proc.status).not.toBe(0);
  });

  test("does not fire on a supported Node (real runtime, >=22)", () => {
    // No spoof: the guard must let a supported Node through to normal CLI
    // handling. `--version` prints and exits 0.
    const proc = spawnSync(NODE, [binEntry, "--version"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");
    expect(out).not.toContain("Node.js 22 or newer");
    expect(proc.status).toBe(0);
  });
});

describe("lobu run Node warning", () => {
  test("warns before environment validation fails on Node 25", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lobu-node25-run-"));
    temporaryDirs.push(cwd);
    const devModule = pathToFileURL(
      join(import.meta.dir, "..", "commands", "dev.ts")
    ).href;
    const script = [
      "Object.defineProperty(process.versions, 'node',",
      "  { value: '25.1.0', configurable: true });",
      `const { devCommand } = await import(${JSON.stringify(devModule)});`,
      `await devCommand(${JSON.stringify(cwd)});`,
    ].join("\n");

    // A shared shell DATABASE_URL makes devCommand stop after its initial
    // validation, without starting the embedded server.
    const proc = spawnSync(process.execPath, ["--eval", script], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/prod",
        NO_COLOR: "1",
      },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");
    const warning = out.indexOf(
      "the agent-code sandbox (query_sdk / run_sdk) is unavailable"
    );
    const validationFailure = out.indexOf(
      "DATABASE_URL inherited from shell points at a shared DB"
    );

    expect(proc.status).toBe(1);
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(validationFailure).toBeGreaterThan(warning);
  });
});

describe("server.bundle.mjs Node gate (direct `node bundle` path)", () => {
  // Covers systemd / managed hosts that run the bundle directly, bypassing
  // bin/lobu.js. The build (build-server-bundle.mjs) makes server.bundle.mjs a
  // tiny gate entry that checks the Node version, then dynamically imports the
  // real graph (server-main.bundle.mjs). The split is required: an in-file
  // guard can't beat ESM hoisting of the graph's undici import,
  // which crashes old Node with `ReferenceError: File is not defined`.
  //
  // NOTE: on this Node 26 host, spoofing only the version STRING can't trigger
  // the real undici crash (the `File` global is genuinely present), so this
  // asserts the version-gate message + clean exit. The gate-runs-before-undici
  // guarantee comes from the two-bundle split, not from this spoof.
  const bundlePath = join(
    import.meta.dir,
    "..",
    "..",
    "dist",
    "server.bundle.mjs"
  );
  const built = existsSync(bundlePath);

  test.skipIf(!built)(
    "bundle rejects Node 18 with an explicit message, no undici crash",
    () => {
      const proc = spawnSync(NODE, [bundlePath], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require ${spoofPreload("18.19.1")}`,
          DATABASE_URL: join(tmpdir(), "lobu-guard-test-nonexistent"),
        },
        encoding: "utf8",
      });
      const out = (proc.stdout ?? "") + (proc.stderr ?? "");
      expect(out).toContain("Node.js 22 or newer");
      expect(out).not.toContain("File is not defined");
      expect(proc.status).toBe(1);
    }
  );
});
