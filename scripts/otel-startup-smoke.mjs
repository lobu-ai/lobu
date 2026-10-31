#!/usr/bin/env node
// Build first: cd packages/server && bun run build:server
// node scripts/otel-startup-smoke.mjs [disabled|missing-peer|init-failure|outage|shutdown-hang]
// Boot the actual Node bundle against a disposable PostgreSQL database.
// All ports are loopback; developer credentials/configuration are not forwarded.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ensureNativeLibSonames,
  installPgvector,
  resolveEmbeddedNativeDir,
} from "@lobu/pgvector-embedded";
import exitHook from "async-exit-hook";
import EmbeddedPostgres from "embedded-postgres";

// The dependency's hooks can replace failing exit codes and re-raise signals
// before application teardown finishes. This runner owns its database cleanup.
for (const event of ["beforeExit", "exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
  exitHook.unhookEvent(event);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(repo, "packages/server/dist/server.bundle.mjs");
assert.ok(
  existsSync(bundle),
  "Build packages/server with bun run build:server first"
);
const cases = [
  "disabled",
  "missing-peer",
  "init-failure",
  "outage",
  "shutdown-hang",
];
const selected = process.argv[2] ? [process.argv[2]] : cases;
assert.ok(
  selected.every((name) => cases.includes(name)),
  "Unknown startup smoke case"
);
const scratch = mkdtempSync(join(tmpdir(), "lobu-otel-startup-"));
let activeChild;
let activeExit;
let stopping;
let cleaning;
let interrupted = false;
let database;
let databaseStarted = false;
let databaseReady;
let databaseLog = "";

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((err) => (err ? reject(err) : resolve()))
  );
  return port;
}

function stopChild() {
  if (stopping) return stopping;
  if (!activeChild) return Promise.resolve();
  stopping = terminateChild().finally(() => {
    stopping = undefined;
  });
  return stopping;
}

async function terminateChild() {
  const child = activeChild;
  const exited = activeExit;
  activeChild = undefined;
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  let timer;
  let result;
  try {
    result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!result) {
    // This group was created only for this test's server, never an existing
    // service or a process discovered by its listening port.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await exited;
    throw new Error("Server did not shut down within 15 seconds");
  }
  return result;
}

function cleanup() {
  cleaning ??= (async () => {
    const errors = [];
    try {
      await stopChild();
    } catch (error) {
      errors.push(error);
    }
    try {
      await databaseReady?.catch(() => {
        // The startup path reports this failure; cleanup only waits for it to settle.
      });
      if (databaseStarted) {
        // embedded-postgres.stop() waits forever when its child already exited.
        // pg_ctl handles that state and has its own bounded shutdown wait.
        const child = database.process;
        if (child?.exitCode === null && child.signalCode === null) {
          const stopped = spawnSync(
            join(resolveEmbeddedNativeDir(), "bin", "pg_ctl"),
            [
              "stop",
              "-D",
              join(scratch, "pgdata"),
              "-m",
              "fast",
              "-w",
              "-t",
              "5",
            ],
            { stdio: "pipe", timeout: 6000 }
          );
          if (stopped.error || stopped.status !== 0) {
            child.kill("SIGKILL");
            throw new Error("Disposable PostgreSQL did not stop cleanly", {
              cause: stopped.error,
            });
          }
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Startup smoke cleanup failed");
  })();
  return cleaning;
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void cleanup()
      .catch((error) => console.error(error))
      .finally(() => process.exit(exitCode));
  });
}

async function runCase(name, databasePort, password) {
  const port = await unusedPort();
  const unavailablePort = await unusedPort();
  const proxyPort = await unusedPort();
  if (interrupted) return;
  const databaseName = `otel_${name.replaceAll("-", "_")}_test`;
  await database.createDatabase(databaseName);
  if (interrupted) return;
  const marker = join(scratch, `${name}.exporter-loaded`);
  const preload = join(scratch, `${name}.cjs`);
  writeFileSync(
    preload,
    `
const Module = require("node:module");
const { writeFileSync } = require("node:fs");
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const mode = ${JSON.stringify(name)};
  if (mode === "shutdown-hang" && request === "@opentelemetry/sdk-trace-node") {
    const real = load.apply(this, arguments);
    return { ...real, NodeTracerProvider: class extends real.NodeTracerProvider {
      shutdown() {
        writeFileSync(${JSON.stringify(`${marker}.shutdown`)}, "called");
        // Model an exporter retaining a socket/timer while shutdown stalls.
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      }
    }};
  }
  if (request === "@opentelemetry/exporter-trace-otlp-grpc") {
    writeFileSync(${JSON.stringify(marker)}, "loaded");
    if (mode === "disabled" || mode === "missing-peer") {
      const error = new Error("Synthetic missing optional OTLP exporter");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    if (mode === "init-failure") {
      const real = load.apply(this, arguments);
      return { ...real, OTLPTraceExporter: class {
        constructor() { throw new Error("Synthetic OTLP exporter constructor failure"); }
      }};
    }
  }
  return load.apply(this, arguments);
};
`
  );
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_PROXY_PORT: String(proxyPort),
    DATABASE_URL:
      "postgresql://postgres:" +
      password +
      "@127.0.0.1:" +
      databasePort +
      "/" +
      databaseName +
      "?sslmode=disable",
    PGSSLMODE: "disable",
    LOBU_RUN_OWNS_DB: "1",
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    LOBU_CONTEXT: `otel-startup-smoke-${randomBytes(8).toString("hex")}`,
    LOBU_DEV_PROJECT_PATH: repo,
    LOBU_DISABLE_EMBEDDED_WORKER: "1",
    EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${unavailablePort}`,
    HTTP_CLOSE_TIMEOUT_MS: "1000",
    SHUTDOWN_READINESS_DRAIN_MS: "0",
    LOG_LEVEL: "info",
  });
  if (name !== "disabled")
    env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${unavailablePort}`;
  let output = "";
  const started = Date.now();
  activeChild = spawn(process.execPath, ["--require", preload, bundle], {
    cwd: scratch,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = activeChild;
  activeExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-50_000);
    });
  }
  try {
    const deadline = Date.now() + 120_000;
    let healthy = false;
    while (Date.now() < deadline) {
      assert.equal(
        child.exitCode,
        null,
        "Server exited before becoming healthy"
      );
      assert.equal(
        child.signalCode,
        null,
        "Server was terminated before becoming healthy"
      );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.arrayBuffer();
        if (response.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // Connection refusal is expected while the server is still booting.
      }
      await delay(200);
    }
    assert.ok(healthy, "Server never served /api/health");
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      signal: AbortSignal.timeout(3000),
    });
    await ready.arrayBuffer();
    assert.equal(ready.status, 200, "Server did not pass readiness");
    assert.equal(
      existsSync(marker),
      name !== "disabled",
      name === "disabled"
        ? "Disabled tracing loaded the optional exporter"
        : "Fault injection did not reach the exporter"
    );
    const shutdownStarted = Date.now();
    const stopped = await stopChild();
    assert.equal(stopped.code, 0, "Server shutdown failed");
    if (name === "shutdown-hang") {
      assert.ok(
        existsSync(`${marker}.shutdown`),
        "Stalled tracing shutdown was not exercised"
      );
    }
    console.log(
      JSON.stringify({
        case: name,
        health: 200,
        readiness: 200,
        exporterLoaded: existsSync(marker),
        shutdown: "clean",
        shutdownMs: Date.now() - shutdownStarted,
        elapsedMs: Date.now() - started,
      })
    );
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    await stopChild();
  }
}

try {
  ensureNativeLibSonames(resolveEmbeddedNativeDir());
  const { postgresFlags } = installPgvector(join(scratch, "pgvector"));
  const databasePort = await unusedPort();
  if (!interrupted) {
    const password = randomBytes(24).toString("hex");
    database = new EmbeddedPostgres({
      databaseDir: join(scratch, "pgdata"),
      user: "postgres",
      password,
      port: databasePort,
      persistent: false,
      postgresFlags,
      onLog: (message) => {
        databaseLog = (databaseLog + message).slice(-10_000);
      },
    });
    databaseReady = (async () => {
      await database.initialise();
      await database.start();
      databaseStarted = true;
    })();
    await databaseReady;
    for (const name of selected) {
      if (interrupted) break;
      await runCase(name, databasePort, password);
    }
  }
} catch (error) {
  if (!databaseStarted) console.error(databaseLog);
  throw error;
} finally {
  await cleanup();
}
