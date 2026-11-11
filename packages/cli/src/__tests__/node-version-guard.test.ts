import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { resolveNode26Binary } from "../internal/node-binary.js";
import { checkNodeSupport } from "../internal/node-version.js";

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
  test("classifies the running Node as supported (tests run on 26.x)", () => {
    const support = checkNodeSupport();
    expect(support.ok).toBe(true);
  });
});

describe("resolveNode26Binary", () => {
  const base = {
    execPath: "/usr/local/bin/bun",
    versions: { node: "26.7.0", bun: "1.4.4" },
    platform: "linux" as const,
    env: { PATH: "/fake/bin" },
  };

  test("skips a Bun execPath and uses a verified Node 26 on PATH", () => {
    const binary = resolveNode26Binary({
      ...base,
      run: (command) =>
        command === "/fake/bin/node"
          ? '{"node":"26.7.0","bun":null}'
          : '{"node":"26.3.0","bun":"1.4.4"}',
    });
    expect(binary).toBe("/fake/bin/node");
  });

  test("returns the current process when it is genuinely Node 26", () => {
    const binary = resolveNode26Binary({
      ...base,
      execPath: "/opt/node26/bin/node",
      versions: { node: "26.7.0" },
      run: () => {
        throw new Error("must not probe PATH");
      },
    });
    expect(binary).toBe("/opt/node26/bin/node");
  });

  test("fails fast when PATH has no Node 26 binary", () => {
    expect(() =>
      resolveNode26Binary({
        ...base,
        run: () => '{"node":"24.11.0","bun":null}',
      })
    ).toThrow(/must run on Node\.js 26\.x/);
  });
});

describe("bin/lobu.js Node gate", () => {
  // Spoof process.versions.node via a preload that runs BEFORE the bin body,
  // so we can prove the guard fires on an old Node without needing one
  // installed. defineProperty is required — process.versions.node is read-only.
  const binEntry = join(import.meta.dir, "..", "..", "bin", "lobu.js");

  test("exits non-zero with an explicit message on Node 25", () => {
    const proc = spawnSync(NODE, [binEntry, "--version"], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${spoofPreload("25.9.0")}`,
      },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");

    // The explicit, actionable message — NOT the raw undici crash.
    expect(out).toContain("Node.js 26.x");
    expect(out).toContain("25.9.0");
    expect(out).not.toContain("File is not defined");
    expect(proc.status).not.toBe(0);
  });

  test("does not fire on a supported Node (real runtime, 26.x)", () => {
    // No spoof: the guard must let Node 26 through to normal CLI handling.
    const proc = spawnSync(NODE, [binEntry, "--version"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");
    expect(out).not.toContain("Node.js 26.x");
    expect(proc.status).toBe(0);
  });

  test("bootstraps the backend command from a Bun host onto Node 26", () => {
    // The macOS app still starts `lobu run` under an older Node; a Bun-hosted
    // launch must likewise hand the backend to a real Node 26 binary.
    const proc = spawnSync(process.execPath, [binEntry, "run", "--help"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");
    expect(out).toContain("Usage: lobu run|dev");
    expect(proc.status).toBe(0);
  });
});

describe("bin/lobu.js bootstrap supervision", () => {
  const binEntry = join(import.meta.dir, "..", "..", "bin", "lobu.js");

  async function waitForFile(file: string) {
    const deadline = Date.now() + 5_000;
    while (!existsSync(file)) {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${file}`);
      await Bun.sleep(10);
    }
  }

  function startFixture(host: readonly [string, ...string[]], body: string) {
    const dir = mkdtempSync(join(tmpdir(), "lobu-bootstrap-"));
    temporaryDirs.push(dir);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "dist"));
    copyFileSync(binEntry, join(dir, "bin", "lobu.js"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(dir, "dist", "index.js"),
      `import { existsSync, writeFileSync } from "node:fs";
       import { join } from "node:path";
       export async function runCli() {
         const dir = process.argv[3];
         ${body}
         writeFileSync(join(dir, "ready"), JSON.stringify({
           pid: process.pid, node: process.versions.node,
           bun: process.versions.bun ?? null
         }));
       }`
    );
    const [binary, ...args] = host;
    const launcher = spawn(
      binary,
      [...args, join(dir, "bin", "lobu.js"), "run", dir],
      {
        env: { ...process.env, LOBU_NODE26_BOOTSTRAP: "" },
        stdio: "ignore",
      }
    );
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        launcher.once("error", reject);
        launcher.once("close", (code, signal) => resolve({ code, signal }));
      }
    );
    return {
      dir,
      launcher,
      closed,
      async cleanup() {
        if (existsSync(join(dir, "ready"))) {
          const { pid } = JSON.parse(readFileSync(join(dir, "ready"), "utf8"));
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The fixture already exited.
          }
        }
        launcher.kill("SIGKILL");
        await closed;
      },
    };
  }

  const hosts = [
    { name: "Bun", command: [process.execPath] },
    {
      name: "older Node",
      command: [NODE, "--require", spoofPreload("22.0.0")],
    },
  ] as const;
  for (const host of hosts) {
    test.each([
      "SIGTERM",
      "SIGINT",
      "SIGHUP",
    ] as const)(`${host.name} forwards %s and waits for cleanup`, async (signal) => {
      const fixture = startFixture(
        host.command,
        `
          process.once(${JSON.stringify(signal)}, () => {
            writeFileSync(join(dir, "received"), ${JSON.stringify(signal)});
            setInterval(() => {
              if (!existsSync(join(dir, "finish"))) return;
              writeFileSync(join(dir, "cleaned"), "done");
              process.exit(23);
            }, 10);
          });
          setInterval(() => {}, 1_000);
        `
      );
      try {
        await waitForFile(join(fixture.dir, "ready"));
        const runtime = JSON.parse(
          readFileSync(join(fixture.dir, "ready"), "utf8")
        );
        expect(runtime.node).toMatch(/^26\./);
        expect(runtime.bun).toBeNull();
        fixture.launcher.kill(signal);
        await waitForFile(join(fixture.dir, "received"));
        expect(readFileSync(join(fixture.dir, "received"), "utf8")).toBe(
          signal
        );
        expect(fixture.launcher.exitCode).toBeNull();
        expect(fixture.launcher.signalCode).toBeNull();
        writeFileSync(join(fixture.dir, "finish"), "continue");
        expect(await fixture.closed).toEqual({ code: 23, signal: null });
        expect(existsSync(join(fixture.dir, "cleaned"))).toBe(true);
        expect(() => process.kill(runtime.pid, 0)).toThrow();
      } finally {
        await fixture.cleanup();
      }
    }, 10_000);

    test.each([0, 23])(`${host.name} preserves exit code %i`, async (code) => {
      const fixture = startFixture(host.command, `process.exit(${code});`);
      try {
        expect(await fixture.closed).toEqual({ code, signal: null });
      } finally {
        await fixture.cleanup();
      }
    });

    test(`${host.name} preserves a child's termination signal`, async () => {
      const fixture = startFixture(
        host.command,
        'process.kill(process.pid, "SIGTERM");'
      );
      try {
        expect(await fixture.closed).toEqual({ code: null, signal: "SIGTERM" });
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

describe("lobu run Node gate", () => {
  test("refuses on Node 25 before environment validation", () => {
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

    // A shared shell DATABASE_URL would stop devCommand after its initial
    // validation; the Node gate must fire before that point.
    const proc = spawnSync(process.execPath, ["--eval", script], {
      env: {
        ...process.env,
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/prod",
        NO_COLOR: "1",
      },
      encoding: "utf8",
    });
    const out = (proc.stdout ?? "") + (proc.stderr ?? "");
    const gateFailure = out.indexOf("Lobu needs Node.js 26.x");
    const validationFailure = out.indexOf(
      "DATABASE_URL inherited from shell points at a shared DB"
    );

    expect(proc.status).toBe(1);
    expect(gateFailure).toBeGreaterThanOrEqual(0);
    expect(validationFailure).toBe(-1);
  });
});

describe("server.bundle.mjs Node gate (direct `node bundle` path)", () => {
  // Covers systemd / managed hosts that run the bundle directly, bypassing
  // bin/lobu.js. The build (build-server-bundle.mjs) makes server.bundle.mjs a
  // tiny gate entry that checks the Node version, then dynamically imports the
  // real graph (server-main.bundle.mjs). The split is required: an in-file
  // guard can't beat ESM hoisting of the graph's undici import.
  const bundlePath = join(
    import.meta.dir,
    "..",
    "..",
    "dist",
    "server.bundle.mjs"
  );
  const built = existsSync(bundlePath);

  test.skipIf(!built)(
    "bundle rejects Node 25 with an explicit message, no undici crash",
    () => {
      const proc = spawnSync(NODE, [bundlePath], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require ${spoofPreload("25.9.0")}`,
          DATABASE_URL: join(tmpdir(), "lobu-guard-test-nonexistent"),
        },
        encoding: "utf8",
      });
      const out = (proc.stdout ?? "") + (proc.stderr ?? "");
      expect(out).toContain("Node.js 26.x");
      expect(out).not.toContain("File is not defined");
      expect(proc.status).toBe(1);
    }
  );
});
