import { encrypt, generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../auth/api-auth-middleware.js";
import {
  getRevokedTokenStore,
  RevokedTokenStore,
} from "../auth/revoked-token-store.js";
import { authenticateWorker } from "../routes/internal/middleware.js";
import {
  setRevokedTokenStore,
  verifySettingsSession,
} from "../routes/public/settings-auth.js";
import {
  ensureEncryptionKey,
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("RevokedTokenStore (PG-backed)", () => {
  let store: RevokedTokenStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
    store = new RevokedTokenStore();
  });

  test("unknown jti is not revoked", async () => {
    expect(await store.isRevoked("never-seen")).toBe(false);
    expect(await store.isRevoked("")).toBe(false);
  });

  test("revoke() marks a jti as revoked", async () => {
    await store.revoke("jti-1", Date.now() + 60_000);
    // Fresh store (no cache) so this hits Postgres.
    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("jti-1")).toBe(true);
    expect(await cold.isRevoked("jti-2")).toBe(false);
  });

  test("sweepExpired() removes rows whose expiry has passed", async () => {
    await store.revoke("expired", Date.now() - 1_000);
    await store.revoke("live", Date.now() + 60_000);

    const removed = await store.sweepExpired();
    expect(removed).toBe(1);

    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("expired")).toBe(false);
    expect(await cold.isRevoked("live")).toBe(true);
  });

  test("an already-expired revocation never reports revoked", async () => {
    await store.revoke("stale", Date.now() - 1_000);
    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("stale")).toBe(false);
  });
});

describe("createApiAuthMiddleware — worker token revocation", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", createApiAuthMiddleware({ allowWorkerToken: true }));
    app.get("/ping", (c) => c.json({ ok: true }));
    return app;
  }

  function workerToken() {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "chan-1",
    });
    return token;
  }

  function jtiOf(token: string): string {
    // Re-derive the jti the same way the gateway does.
    const data = verifyWorkerToken(token);
    if (!data?.jti) throw new Error("worker token missing jti");
    return data.jti;
  }

  test("a normal worker token is accepted", async () => {
    const app = makeApp();
    const res = await app.request("/ping", {
      headers: { Authorization: `Bearer ${workerToken()}` },
    });
    expect(res.status).toBe(200);
  });

  test("a worker token whose jti is revoked is rejected with 401", async () => {
    const token = workerToken();
    // Revoke its jti via the same singleton the middleware uses.
    await getRevokedTokenStore().revoke(jtiOf(token), Date.now() + 60_000);

    const app = makeApp();
    const res = await app.request("/ping", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("verifySettingsSession — jti revocation", () => {
  const COOKIE_NAME = "lobu_settings_session";

  function makeSessionCookie(jti: string): string {
    const payload = {
      userId: "user-1",
      platform: "external",
      exp: Date.now() + 60_000,
      jti,
    };
    return encrypt(JSON.stringify(payload));
  }

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
    setRevokedTokenStore(null);
  });

  test("valid cookie with live jti returns session", async () => {
    const jti = "live-jti-abc";
    const cookieVal = makeSessionCookie(jti);

    const app = new Hono();
    app.get("/check", async (c) => {
      const session = await verifySettingsSession(c);
      return c.json({ ok: session !== null });
    });

    const res = await app.request("/check", {
      headers: { cookie: `${COOKIE_NAME}=${cookieVal}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("valid cookie with revoked jti returns null", async () => {
    const jti = "revoked-jti-xyz";
    const cookieVal = makeSessionCookie(jti);

    // Revoke via the process-wide singleton (same store verifySettingsSession uses).
    await getRevokedTokenStore().revoke(jti, Date.now() + 60_000);

    const app = new Hono();
    app.get("/check", async (c) => {
      const session = await verifySettingsSession(c);
      return c.json({ ok: session !== null });
    });

    const res = await app.request("/check", {
      headers: { cookie: `${COOKIE_NAME}=${cookieVal}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("injected store takes precedence over singleton", async () => {
    const jti = "jti-custom-store";
    const cookieVal = makeSessionCookie(jti);

    // Singleton is NOT revoked.
    // Inject a store that says everything is revoked.
    const alwaysRevoked = new RevokedTokenStore();
    await alwaysRevoked.revoke(jti, Date.now() + 60_000);
    setRevokedTokenStore(alwaysRevoked);

    const app = new Hono();
    app.get("/check", async (c) => {
      const session = await verifySettingsSession(c);
      return c.json({ ok: session !== null });
    });

    const res = await app.request("/check", {
      headers: { cookie: `${COOKIE_NAME}=${cookieVal}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });

    setRevokedTokenStore(null);
  });
});

// Routes wired through `authenticateWorker` (internal worker endpoints —
// SSE stream, response post) used to skip the revocation
// check because the verify call wasn't async. The middleware now consults
// the singleton store; this test pins that contract.
describe("authenticateWorker (internal middleware) — revocation reach", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", authenticateWorker);
    app.get("/internal/ping", (c) => c.json({ ok: true }));
    return app;
  }

  function workerToken() {
    return generateWorkerToken("user-internal", "conv-internal", "deploy-internal", {
      channelId: "chan-internal",
    });
  }

  test("valid worker token reaches the handler", async () => {
    const app = makeApp();
    const res = await app.request("/internal/ping", {
      headers: { Authorization: `Bearer ${workerToken()}` },
    });
    expect(res.status).toBe(200);
  });

  test("revoked jti returns 401 from the internal middleware path", async () => {
    const token = workerToken();
    const data = verifyWorkerToken(token);
    if (!data?.jti) throw new Error("worker token missing jti");
    await getRevokedTokenStore().revoke(data.jti, Date.now() + 60_000);

    const app = makeApp();
    const res = await app.request("/internal/ping", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
