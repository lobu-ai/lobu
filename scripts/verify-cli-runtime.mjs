#!/usr/bin/env node
// Exercise the installed launcher and native components outside the checkout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const destination = resolve(process.argv[2]);
const cli = join(destination, "node_modules/@lobu/cli");
const { runtimePlatformKey } = await import(
  pathToFileURL(join(cli, "dist/internal/runtime-components.js"))
);
const catalog = JSON.parse(
  await readFile(join(cli, "dist/runtime-components.json"), "utf8")
);
const cache = join(destination, "runtime");
const home = await mkdtemp(join(destination, "synthetic-home-"));
const project = await mkdtemp(join(destination, "synthetic-project-"));
const [
  port,
  pgPort,
  embeddingsPort,
  externalPort,
  proxyPort,
  externalProxyPort,
] = await Promise.all(Array.from({ length: 6 }, freePort));
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: "production",
  ENCRYPTION_KEY: "a".repeat(64),
  LOBU_RUNTIME_CACHE_DIR: cache,
  DATABASE_URL: project,
  LOBU_PG_PORT: String(pgPort),
  WORKER_PROXY_PORT: String(proxyPort),
  EMBEDDINGS_PORT: String(embeddingsPort),
  TRANSFORMERS_CACHE: join(destination, "model-cache"),
  HOST: "127.0.0.1",
  LOG_LEVEL: "warn",
};
const running = [];
const servicePorts = [];
try {
  const embedded = start(port, env);
  await healthy(embedded, port);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /<html/);
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset, "the installed server must serve its bundled web UI");
  assert.equal((await fetch(`http://127.0.0.1:${port}${asset}`)).status, 200);
  const embeddingHealth = await fetch(
    `http://127.0.0.1:${embeddingsPort}/health`
  );
  assert.equal((await embeddingHealth.json()).backend, "local");

  // Reuse only the synthetic DB/service above. This cache exposes the server
  // alone, so a mistaken PG/ONNX selection cannot hide behind a warm install.
  const remoteCache = await mkdtemp(join(destination, "remote-runtime-"));
  const versionDirectory = join(
    "v1",
    catalog.server.version,
    runtimePlatformKey()
  );
  await mkdir(join(remoteCache, versionDirectory), { recursive: true });
  await symlink(
    join(cache, versionDirectory, "server"),
    join(remoteCache, versionDirectory, "server"),
    "dir"
  );
  const external = start(
    externalPort,
    {
      ...env,
      LOBU_RUNTIME_CACHE_DIR: remoteCache,
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
      EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${embeddingsPort}`,
      WORKER_PROXY_PORT: String(externalProxyPort),
    },
    ["--unsafe-shared-db"]
  );
  await healthy(external, externalPort);
  await stop(external);
  for (const backend of ["openai", "local"]) {
    // The OpenAI service wrapper needs no local inference package. The local
    // variant adds exactly that component while continuing to use external PG.
    if (backend === "local")
      await symlink(
        join(cache, versionDirectory, "embeddings"),
        join(remoteCache, versionDirectory, "embeddings"),
        "dir"
      );
    const servicePort = await freePort();
    servicePorts.push(servicePort);
    const owned = start(
      externalPort,
      {
        ...env,
        LOBU_RUNTIME_CACHE_DIR: remoteCache,
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
        EMBEDDINGS_BACKEND: backend,
        EMBEDDINGS_PORT: String(servicePort),
        WORKER_PROXY_PORT: String(externalProxyPort),
      },
      ["--unsafe-shared-db"]
    );
    await healthy(owned, externalPort);
    const health = await fetch(`http://127.0.0.1:${servicePort}/health`);
    assert.equal((await health.json()).backend, backend);
    await stop(owned);
  }
  console.log(
    "Packed runtime: embedded PG/pgvector, migrations, web UI, local embedding service, and external DB/remote embeddings boot passed."
  );
} finally {
  for (const child of running.reverse()) await stop(child);
}
for (const value of [
  port,
  pgPort,
  embeddingsPort,
  externalPort,
  proxyPort,
  externalProxyPort,
  ...servicePorts,
]) {
  const server = createServer();
  server.listen(value, "127.0.0.1");
  await once(server, "listening");
  await new Promise((done) => server.close(done));
}
console.log("Packed runtime: all owned service ports released after shutdown.");

function start(port, environment, args = []) {
  const child = spawn(
    process.execPath,
    [
      join(cli, "bin/lobu.js"),
      "run",
      "--quiet",
      "--port",
      String(port),
      ...args,
    ],
    { cwd: project, env: environment, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      child.output = (child.output + data).slice(-20000);
    });
  child.on("error", (error) => {
    child.failure = error;
  });
  running.push(child);
  return child;
}
async function healthy(child, port) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.failure || child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Packed server exited: ${child.failure ?? child.exitCode}\n${child.output}`
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // The socket is unavailable until the child finishes bootstrapping.
    }
    await delay(250);
  }
  throw new Error(`Packed server did not become ready:\n${child.output}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
