import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { PollResponse } from "@lobu/core/contracts/worker/protocol";
import { Agent } from "undici";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Env } from "../../../packages/server/src/index";
import {
  cleanupTestDatabase,
  getTestDb,
} from "../../../packages/server/src/__tests__/setup/test-db";
import LokiActivityConnector from "../loki-activity.connector";

const credential = "Basic synthetic-loki-query-credential";
const workerId = "synthetic-loki-worker";
const workerToken = "synthetic-fleet-token";
const windowMs = 20 * 60 * 1000;
let upstream: Server;
let gateway: ReturnType<typeof serve>;
let dispatcher: Agent;
let certDir: string;
let origin: string;
let requests = 0;
const headers: Array<string | undefined> = [];

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), "lobu-loki-https-"));
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "pipe" }
  );
  const cert = readFileSync(certPath);
  upstream = createServer({ key: readFileSync(keyPath), cert }, (req, res) => {
    headers.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== credential) {
      res.writeHead(401).end();
      return;
    }
    // Fail the next window after one full window was committed.
    if (++requests === 3) {
      res.writeHead(503).end();
      return;
    }
    const path = new URL(req.url!, origin).pathname;
    if (path === "/loki/api/v1/query") {
      res.end(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [{ metric: { level: "error" }, value: [0, "2"] }],
          },
        })
      );
    } else if (path === "/loki/api/v1/query_range") {
      res.end(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "streams",
            result: [
              {
                stream: { pod: "synthetic-pod" },
                values: [
                  ["1", '{"level":"error","message":"synthetic failure"}'],
                ],
              },
            ],
          },
        })
      );
    } else {
      res.writeHead(404).end();
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TLS port");
  origin = `https://localhost:${address.port}`;
  dispatcher = new Agent({ connect: { ca: cert } });
  vi.resetModules();
  // Only the fixture's loopback admission is replaced. Requests still cross
  // real TLS, using a verified test CA; production private-address refusal is
  // covered by the gateway HTTP-auth suite. No production bypass is added.
  vi.doMock("@lobu/connector-worker/egress", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchCredentialedPublicUrl: (url: string | URL, init: RequestInit) => {
      if (new URL(url).origin !== origin)
        throw new Error("Unexpected fixture destination");
      return fetch(url, { ...init, dispatcher } as RequestInit);
    },
  }));
});

afterAll(async () => {
  vi.doUnmock("@lobu/connector-worker/egress");
  vi.resetModules();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
  await dispatcher?.close();
  if (upstream)
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

it("syncs the real Loki connector through gateway auth and resumes from durable coverage", async () => {
  await cleanupTestDatabase();
  const {
    seedOwnerContext,
    createTestConnection,
    createTestConnectorDefinition,
  } = await import(
    "../../../packages/server/src/__tests__/setup/test-fixtures"
  );
  const { createAuthProfile, updateAuthProfile } = await import(
    "../../../packages/server/src/utils/auth-profiles"
  );
  const { resolveExecutionAuth } = await import(
    "../../../packages/server/src/utils/execution-context"
  );
  const { app } = await import("../../../packages/server/src/index");
  const { WorkerClient, executeRun } = await import(
    "@lobu/connector-worker/daemon"
  );
  const { createIsolateConnectorCompiler } = await import(
    "@lobu/connector-worker/compile"
  );
  const sql = getTestDb();
  const { org } = await seedOwnerContext({
    orgName: "Synthetic Loki workspace",
  });
  const { definition } = new LokiActivityConnector();
  await createTestConnectorDefinition({
    key: definition.key,
    name: definition.name,
    version: definition.version,
    organization_id: org.id,
    feeds_schema: definition.feeds,
    auth_schema: definition.authSchema,
  });
  const config = { LOKI_URL: origin, namespace: "synthetic" };
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: definition.key,
    config,
    createDefaultFeed: false,
  });
  const profile = await createAuthProfile({
    organizationId: org.id,
    connectorKey: definition.key,
    displayName: "Synthetic HTTP profile",
    profileKind: "env",
    authData: { AUTHORIZATION: credential },
    http: { origin, headers: { authorization: "AUTHORIZATION" } },
  });
  await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${connection.id}`;
  const latestEnd =
    Math.floor((Date.now() - 2 * 60 * 1000) / windowMs) * windowMs;
  const initialCheckpoint = {
    window_end: new Date(latestEnd - 2 * windowMs).toISOString(),
  };
  const [feed] =
    await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, checkpoint)
    VALUES (${org.id}, ${connection.id}, 'activity', 'active', ${sql.json(initialCheckpoint)}) RETURNING id`;
  const code =
    await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(
      fileURLToPath(new URL("../loki-activity.connector.ts", import.meta.url))
    );
  gateway = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      app.fetch(req, {
        WORKER_API_TOKEN: workerToken,
        ENVIRONMENT: "test",
      } as Env),
  });
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string")
    throw new Error("Missing gateway port");
  const client = new WorkerClient({
    apiUrl: `http://127.0.0.1:${gatewayAddress.port}`,
    workerId,
    authToken: workerToken,
    capabilities: {},
  });
  const sync = async () => {
    const [stored] =
      await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
    const [run] = await sql`INSERT INTO runs (
      organization_id, connection_id, connector_key, connector_version, feed_id,
      run_type, status, approval_status, claimed_by, claimed_at, last_heartbeat_at
    ) VALUES (${org.id}, ${connection.id}, ${definition.key}, ${definition.version}, ${feed.id},
      'sync', 'running', 'auto', ${workerId}, NOW(), NOW()) RETURNING id`;
    const auth = await resolveExecutionAuth({
      organizationId: org.id,
      connectionId: connection.id,
      authProfileId: profile.id,
      credentialDb: sql,
    });
    const job = {
      run_id: Number(run.id),
      run_type: "sync",
      connector_key: definition.key,
      compiled_code: code,
      feed_id: Number(feed.id),
      feed_key: "activity",
      config,
      checkpoint: stored.checkpoint,
      connection_credentials: auth.connectionCredentials,
      credentials: auth.credentials,
      http_auth: auth.httpAuth,
    } as PollResponse;
    expect(JSON.stringify(job)).not.toContain(credential);
    return executeRun(
      client,
      job,
      {},
      { generateEmbeddings: false, timeoutMs: 15_000 }
    );
  };
  expect(await sync()).toMatchObject({
    itemsCollected: 1,
    error: expect.stringContaining("503"),
  });
  const [partial] =
    await sql`SELECT checkpoint FROM feeds WHERE id = ${feed.id}`;
  expect(partial.checkpoint).toEqual({
    window_end: new Date(latestEnd - windowMs).toISOString(),
  });
  expect(await sync()).toEqual({ itemsCollected: 1 });
  const rows = await sql`SELECT origin_id, metadata FROM events
    WHERE connection_id = ${connection.id} AND superseded_by IS NULL ORDER BY origin_id`;
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.origin_id)).toEqual([
    new Date(latestEnd - windowMs).toISOString(),
    new Date(latestEnd).toISOString(),
  ]);
  expect(rows[1].metadata).toMatchObject({
    errors: 2,
    error_samples: ["[synthetic-pod] synthetic failure"],
  });
  const [complete] =
    await sql`SELECT checkpoint, last_sync_status FROM feeds WHERE id = ${feed.id}`;
  expect(complete).toMatchObject({
    checkpoint: { window_end: new Date(latestEnd).toISOString() },
    last_sync_status: "success",
  });
  expect(headers).toEqual(Array(5).fill(credential));
  expect(JSON.stringify(rows)).not.toContain(credential);
  await updateAuthProfile({
    organizationId: org.id,
    slug: profile.slug,
    status: "revoked",
  });
  await expect(sync()).rejects.toThrow("unavailable");
  expect(requests).toBe(5);
}, 30_000);
