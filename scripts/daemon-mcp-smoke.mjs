#!/usr/bin/env node
// Real MCP transport -> gateway/Postgres -> installed `lobu daemon` -> shell.
// Owns its gateway, temporary HOME/database, daemon and command files. Every
// command goes through MCP; the plain HTTP requests bootstrap a disposable
// local owner, mint the daemon's device token, list its devices, and set its
// action permissions through the same session-authenticated endpoint as the
// web UI.
//
// Local run against the working tree, before publishing:
//   node scripts/pack-cli-smoke.mjs /tmp/lobu-candidate
// To repeat just this smoke using that candidate's verified runtime cache:
//   node scripts/daemon-mcp-smoke.mjs /tmp/lobu-candidate/node_modules/.bin/lobu /tmp/lobu-candidate/daemon-mcp-logs /tmp/lobu-candidate/runtime
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliPath = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(cliPath)) {
  throw new Error(
    "Usage: daemon-mcp-smoke.mjs <installed-lobu-bin> [failure-log-directory] [candidate-runtime-cache]"
  );
}
const cli = await realpath(cliPath);
// Canonical path: the shell reports its physical cwd, and macOS tmpdirs are
// symlinks.
const work = await realpath(await mkdtemp(join(tmpdir(), "lobu-daemon-mcp-")));
const home = join(work, "home");
const project = join(work, "project");
const commandDir = join(work, "commands with spaces");
for (const dir of [home, project, commandDir]) mkdirSync(dir);
writeFileSync(
  join(project, "lobu.config.ts"),
  "export default { agents: [] };\n"
);
const port = await freePort();
const proxyPort = await freePort();
const origin = `http://127.0.0.1:${port}`;
const env = {
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  HOME: home,
  TMPDIR: work,
  LANG: "C",
  NO_COLOR: "1",
  DATABASE_URL: home,
  HOST: "127.0.0.1",
  PORT: String(port),
  WORKER_PROXY_PORT: String(proxyPort),
  PUBLIC_GATEWAY_URL: origin,
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  LOBU_DISABLE_SYSTEMD_RUN: "1",
};
const children = [];
const clients = [];
const secrets = [env.ENCRYPTION_KEY];
const logs = new Map();
const workerId = `headless:smoke-${randomUUID()}`;
let passes = 0;
let failures = 0;
let connection;
let mcp;
let org;
let daemon;
let serverComponentDirectory;
let failed = false;
const overall = setTimeout(() => {
  console.error("Daemon MCP smoke exceeded its 10 minute deadline");
  process.kill(process.pid, "SIGTERM");
}, 600_000);

function start(name, args, extraEnv = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.name = name;
  logs.set(name, "");
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) =>
      logs.set(name, (logs.get(name) + data).slice(-2_000_000))
    );
  }
  child.on("error", (error) => logs.set(name, logs.get(name) + error.message));
  children.push(child);
  return child;
}

async function stop(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 8_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  )
    await delay(100);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function until(description, probe, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out: ${description}`);
}

async function check(description, action) {
  await action();
  passes++;
  console.log(`[OK] ${description}`);
}

// Once setup succeeds, collect independent failures so a broken burst does
// not hide timeout, credential-isolation or restart regressions in the report.
async function scenario(description, action) {
  try {
    await check(description, action);
  } catch (error) {
    failed = true;
    failures++;
    console.error(`[FAIL] ${description}: ${error.message}`);
  }
}

async function json(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  assert.equal(
    response.ok,
    true,
    `HTTP ${response.status} ${path}: ${JSON.stringify(result)}`
  );
  return result;
}

async function connect(token) {
  // Resolve from the tested artifact, including npm's .bin symlink. New
  // launchers keep the SDK in the server component that this smoke booted;
  // older published releases still keep it in the CLI dependency graph.
  let requireMcp = createRequire(cli);
  const cliDirectory = resolve(dirname(cli), "..");
  const catalogPath = join(cliDirectory, "dist/runtime-components.json");
  if (existsSync(catalogPath)) {
    const { server } = JSON.parse(readFileSync(catalogPath, "utf8"));
    const { ensureComponent } = await import(
      pathToFileURL(join(cliDirectory, "dist/internal/runtime-components.js"))
    );
    const serverDirectory = await ensureComponent(server, {
      cacheRoot: join(home, ".cache", "lobu", "runtime"),
      offline: true,
    });
    serverComponentDirectory = serverDirectory;
    requireMcp = createRequire(join(serverDirectory, "package.json"));
  }
  const { Client } = await import(
    pathToFileURL(
      requireMcp.resolve("@modelcontextprotocol/sdk/client/index.js")
    )
  );
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(
      requireMcp.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
    )
  );
  const client = new Client({ name: "lobu-daemon-smoke", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${org.slug}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

async function sdk(method, args, client = mcp, tool = "run_sdk") {
  const script = `export default async (ctx, client) => client.${method}(${JSON.stringify(args)});`;
  const reply = await client.callTool(
    { name: tool, arguments: { script, timeout_ms: 180_000 } },
    undefined,
    { timeout: 195_000 }
  );
  assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
  const result = reply.structuredContent;
  assert.ok(result, `Missing structured MCP result for ${method}`);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.return_truncated, undefined, "MCP result was truncated");
  return result.return_value;
}

async function execute(command, input = {}, key = randomUUID(), client = mcp) {
  return sdk(
    "operations.execute",
    {
      connection_id: connection.connection_id,
      operation_key: "run",
      input: { command, cwd: commandDir, ...input },
      idempotency_key: key,
    },
    client
  );
}

function completed(result, stdout) {
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.output.success, true, JSON.stringify(result.output));
  assert.equal(result.output.exit_code, 0);
  assert.equal(result.output.stdout, stdout);
  assert.equal(result.output.timed_out, false);
}

async function failedCommand(command, input, expectedError) {
  // The public SDK throws for failed operations; inspect the persisted result
  // through MCP after asserting the caller received the expected error.
  await assert.rejects(() => execute(command, input), expectedError);
  const { runs } = await sdk(
    "operations.listRuns",
    {
      connection_id: connection.connection_id,
      operation_key: "run",
      run_types: ["action"],
      limit: 1,
    },
    mcp,
    "query_sdk"
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].input.command, command);
  const { run } = await sdk("operations.getRun", runs[0].id, mcp, "query_sdk");
  assert.ok(["failed", "timeout"].includes(run.status), JSON.stringify(run));
  return run;
}

async function main() {
  if (process.argv[4]) {
    // Pre-publication candidates are not on npm yet. Copy only an explicitly
    // supplied, already-verified artifact cache into this smoke's private HOME.
    // Published-artifact runs omit this argument and install from the registry.
    await cp(
      resolve(process.argv[4]),
      join(home, ".cache", "lobu", "runtime"),
      {
        recursive: true,
        verbatimSymlinks: true,
      }
    );
  }
  const server = start("gateway", ["run", "--port", String(port)]);
  await check(
    "installed CLI boots an isolated gateway and Postgres",
    async () => {
      await until(
        "gateway readiness",
        async () => {
          assert.equal(
            server.exitCode,
            null,
            "Gateway exited before readiness"
          );
          return fetch(`${origin}/health/ready`, {
            signal: AbortSignal.timeout(2_000),
          })
            .then((response) => response.ok)
            .catch(() => false);
        },
        180_000
      );
    }
  );
  const bootstrapResponse = await fetch(`${origin}/api/local-init`, {
    method: "POST",
    headers: { "x-lobu-client": "daemon-smoke" },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(bootstrapResponse.status, 200, "Local owner bootstrap failed");
  const bootstrap = await bootstrapResponse.json();
  org = bootstrap.organization;
  secrets.push(bootstrap.session_token, bootstrap.device_token);
  const cookie = bootstrapResponse.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${bootstrap.cookie_name}=`))
    ?.split(";")[0];
  assert.ok(cookie, "Local bootstrap must issue a signed owner session cookie");
  secrets.push(cookie);
  const sessionHeaders = { cookie, origin };
  mcp = await connect(bootstrap.device_token);
  await check("MCP handshake, tools discovery and authentication", async () => {
    const { tools } = await mcp.listTools();
    for (const name of ["run_sdk", "query_sdk", "search_sdk"])
      assert.ok(tools.some((tool) => tool.name === name));
    await assert.rejects(() => connect("owl_pat_invalid_smoke_token"));
  });
  const connectorCatalog = await json("/catalog?kinds=connectors");
  const catalogEntries = connectorCatalog.catalogs.connectors.entries;
  await check(
    "public catalog source URI installs its connector from the relocated artifact",
    async () => {
      // Exercise the advertised URI, not connector_id (which bypasses source_uri).
      // This definition-only install belongs to the disposable local owner and
      // makes no provider requests or account connections.
      const entry = catalogEntries.find((entry) => entry.id === "hackernews");
      assert.ok(
        entry?.detail.source_uri,
        "Hacker News catalog source is missing"
      );
      const installed = await json(`/api/${org.slug}/manage_connections`, {
        method: "POST",
        headers: sessionHeaders,
        body: {
          action: "install_connector",
          source_uri: entry.detail.source_uri,
        },
      });
      assert.equal(installed.installed, true, JSON.stringify(installed));
      assert.equal(installed.connector_key, entry.id);
    }
  );
  await check(
    "every public catalog URI resolves inside the installed connector artifact",
    async () => {
      assert.ok(catalogEntries.length > 0);
      for (const entry of catalogEntries) {
        const source = fileURLToPath(entry.detail.source_uri);
        assert.ok(
          existsSync(source),
          `Catalog source is unavailable for ${entry.id}`
        );
        if (serverComponentDirectory) {
          const connectorRoot = await realpath(
            join(serverComponentDirectory, "dist/connectors")
          );
          assert.ok(
            (await realpath(source)).startsWith(`${connectorRoot}${sep}`),
            `Catalog source for ${entry.id} escaped the installed artifact`
          );
          assert.equal(source, join(connectorRoot, entry.detail.source_path));
        }
      }
    }
  );
  const minted = await json("/api/me/devices/mint-child-token", {
    method: "POST",
    headers: { authorization: `Bearer ${bootstrap.device_token}` },
    body: {
      platform: "headless",
      worker_id: workerId,
      label: "Daemon MCP smoke",
    },
  });
  secrets.push(minted.access_token);
  const daemonEnv = {
    WORKER_API_TOKEN: minted.access_token,
    LOBU_ORG: org.slug,
  };
  const daemonArgs = [
    "daemon",
    "--api-url",
    origin,
    "--worker-id",
    workerId,
    "--capabilities",
    "os.shell",
    "--no-interactive-session",
  ];
  daemon = start("daemon", daemonArgs, daemonEnv);
  await check(
    "daemon registers and advertises an executable shell connection",
    async () => {
      connection = await until("os.shell device connection", async () => {
        assert.equal(
          daemon.exitCode,
          null,
          "Daemon exited before advertising shell operations"
        );
        const result = await sdk(
          "operations.listAvailable",
          { connector_key: "os.shell" },
          mcp,
          "query_sdk"
        );
        logs.set("discovery", JSON.stringify(result, null, 2));
        return result.operations
          ?.find((operation) => operation.operation_key === "run")
          ?.execution_targets.find((target) => target.executable);
      });
    }
  );
  await check("startup links to this device's detail page", async () => {
    const expected = `${origin}/${encodeURIComponent(org.slug)}/connectors/device/${encodeURIComponent(workerId)}`;
    assert.ok(
      logs.get("daemon").includes(expected),
      `Missing device URL: ${expected}`
    );
  });
  await check("default approval prevents shell execution", async () => {
    const result = await execute("printf forbidden > approval-marker");
    assert.equal(result.status, "pending_approval", JSON.stringify(result));
    await delay(1_000);
    assert.equal(existsSync(join(commandDir, "approval-marker")), false);
    await assert.rejects(() =>
      sdk("operations.approve", { run_id: result.run_id })
    );
  });
  // A disposable local owner's real web session authorizes subsequent tests.
  // Tokens never change action_modes or approve operations.
  const current = await json(`/api/${org.slug}/manage_connections`, {
    method: "POST",
    headers: sessionHeaders,
    body: { action: "get", connection_id: connection.connection_id },
  });
  await json(`/api/${org.slug}/manage_connections`, {
    method: "POST",
    headers: sessionHeaders,
    body: {
      action: "update",
      connection_id: connection.connection_id,
      config: { ...current.connection.config, action_modes: { run: "auto" } },
    },
  });
  await scenario(
    "stdout, stderr, exit code, cwd and stdin round-trip",
    async () => {
      const result = await execute("pwd; cat; printf smoke-stderr >&2", {
        stdin: "smoke-stdin",
      });
      completed(result, `${commandDir}\nsmoke-stdin`);
      assert.equal(result.output.stderr, "smoke-stderr");
    }
  );
  await scenario(
    "20 sequential commands preserve results and execute once",
    async () => {
      for (let i = 0; i < 20; i++) {
        completed(
          await execute(`printf 'seq-${i}\\n' >> sequential; printf seq-${i}`),
          `seq-${i}`
        );
      }
      assert.deepEqual(
        readFileSync(join(commandDir, "sequential"), "utf8").trim().split("\n"),
        Array.from({ length: 20 }, (_, i) => `seq-${i}`)
      );
    }
  );
  await scenario(
    "10 concurrent MCP requests preserve correlation and execute once",
    async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, async (_, i) => {
          const result = await execute(
            `printf 'parallel-${i}\\n' >> parallel; printf parallel-${i}`
          );
          completed(result, `parallel-${i}`);
          return result.run_id;
        })
      );
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(
        rejected.length,
        0,
        rejected.map((result) => result.reason.message).join("\n")
      );
      assert.equal(new Set(results.map((result) => result.value)).size, 10);
      assert.deepEqual(
        readFileSync(join(commandDir, "parallel"), "utf8")
          .trim()
          .split("\n")
          .sort(),
        Array.from({ length: 10 }, (_, i) => `parallel-${i}`).sort()
      );
    }
  );
  await scenario(
    "idempotent replay returns the original run without re-execution",
    async () => {
      const key = randomUUID();
      const command = "printf 'once\\n' >> replay; printf once";
      const first = await execute(command, {}, key);
      const second = await execute(command, {}, key);
      completed(first, "once");
      completed(second, "once");
      assert.equal(first.run_id, second.run_id);
      assert.equal(readFileSync(join(commandDir, "replay"), "utf8"), "once\n");
    }
  );
  await scenario(
    "failed command is reported and the next command succeeds",
    async () => {
      const run = await failedCommand(
        "printf failure-stderr >&2; exit 7",
        {},
        /Shell command exited with code 7/
      );
      assert.equal(run.output.exit_code, 7, JSON.stringify(run));
      assert.equal(run.output.stderr, "failure-stderr");
      completed(await execute("printf after-failure"), "after-failure");
    }
  );
  await scenario(
    "timeout terminates the command and releases daemon capacity",
    async () => {
      const run = await failedCommand(
        "echo $$ > timeout-pid; sleep 20; printf leaked > timeout-marker",
        { timeout_ms: 1_000 },
        /Shell command timed out/
      );
      assert.equal(run.output.timed_out, true, JSON.stringify(run));
      const pid = Number(
        readFileSync(join(commandDir, "timeout-pid"), "utf8").trim()
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      await until(
        "timed-out shell is reaped",
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        },
        5_000
      );
      completed(await execute("printf after-timeout"), "after-timeout");
      assert.equal(existsSync(join(commandDir, "timeout-marker")), false);
    }
  );
  await scenario(
    "shell commands cannot inherit the daemon credential",
    async () => {
      completed(
        await execute(
          'printf "%s|%s" "${WORKER_API_TOKEN-unset}" "${DATABASE_URL-unset}"'
        ),
        "unset|unset"
      );
    }
  );
  await scenario(
    "daemon restart reconnects the same device and serves another command",
    async () => {
      await stop(daemon);
      daemon = start("daemon-restarted", daemonArgs, daemonEnv);
      completed(await execute("printf after-restart"), "after-restart");
      const devices = await json("/api/me/devices", {
        headers: sessionHeaders,
      });
      assert.equal(
        devices.devices.filter((device) => device.worker_id === workerId)
          .length,
        1
      );
    }
  );
}

async function cleanup() {
  clearTimeout(overall);
  await Promise.allSettled(clients.map((client) => client.close()));
  for (const child of children.toReversed()) await stop(child);
  if (failed) {
    const output = resolve(process.argv[3] ?? "daemon-mcp-smoke-logs");
    mkdirSync(output, { recursive: true });
    for (const [name, raw] of logs) {
      let text = raw;
      for (const secret of secrets.filter(Boolean))
        text = text.replaceAll(secret, "[redacted]");
      text = text
        .replace(/owl_pat_[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(
          /([?&](?:token|session_token|sessionToken)=)[^\s&]+/g,
          "$1[redacted]"
        );
      writeFileSync(join(output, `${name}.log`), text);
    }
    console.error(`Failure logs: ${output}`);
  }
  await rm(work, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    failed = true;
    await cleanup();
    process.exit(1);
  });
}
try {
  await main();
  console.log(`Daemon MCP smoke: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
} catch (error) {
  failed = true;
  console.error(error);
  console.error(`Daemon MCP smoke: ${passes} passed, ${failures + 1} failed`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}
