/**
 * `allowSettingsQueryToken` on createApiAuthMiddleware — the embedded panel's
 * agent SSE stream uses EventSource (no Authorization header) and authenticates
 * with an encrypted `?token=` ticket. The gate must accept that ticket, but
 * ONLY for the opted-in GET stream route, so a leaked URL ticket can't drive
 * headerless mutations or unrelated GET routes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetEncryptionKeyCacheForTests, encrypt } from "@lobu/core";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../api-auth-middleware.js";
import { createAgentApi } from "../../routes/public/agent.js";
import { setAuthProvider } from "../../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
  // encrypt() memoizes the key; clear so this file reads TEST_KEY even when a
  // co-running suite left a different key in the process-wide cache.
  __resetEncryptionKeyCacheForTests();
  setAuthProvider(null); // no injected provider + no cookie → force the ticket path
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  __resetEncryptionKeyCacheForTests();
  setAuthProvider(null);
});

function app() {
  const a = new Hono();
  a.use(
    "*",
    createApiAuthMiddleware({
      allowSettingsSession: true,
      allowSettingsQueryToken: (c) => c.req.path === "/r/events",
      allowWorkerToken: false,
    }),
  );
  const handler = (c: { get: (k: string) => { userId?: string } | undefined; json: (o: unknown) => Response }) =>
    c.json({ userId: c.get("authContext")?.userId ?? null });
  a.get("/r", handler as never);
  a.get("/r/events", handler as never);
  a.post("/r/events", handler as never);
  return a;
}

const ticket = (userId: string, exp = Date.now() + 60_000): string =>
  encrypt(JSON.stringify({ userId, platform: "external", exp }));

const qTicket = (userId: string, exp?: number) =>
  `?token=${encodeURIComponent(ticket(userId, exp))}`;

describe("createApiAuthMiddleware allowSettingsQueryToken", () => {
  test("GET with a valid ?token= ticket authenticates on the opted-in EventSource path", async () => {
    const res = await app().request(`/r/events${qTicket("user-1")}`, { method: "GET" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { userId: string }).toEqual({ userId: "user-1" });
  });

  test("POST with the same valid ticket is rejected — mutations need a header", async () => {
    const res = await app().request(`/r/events${qTicket("user-1")}`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("GET with the same valid ticket on an unrelated route is rejected", async () => {
    const res = await app().request(`/r${qTicket("user-1")}`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("GET with no auth at all → 401", async () => {
    expect((await app().request("/r/events", { method: "GET" })).status).toBe(401);
  });

  test("GET with a tampered/garbage ticket → 401", async () => {
    const res = await app().request("/r/events?token=not-a-real-ticket", { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("GET with an expired ticket → 401", async () => {
    const res = await app().request(`/r/events${qTicket("user-1", Date.now() - 1000)}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
});

// The real Agent API router, served both at the origin (standalone gateway) and
// under `/lobu` (embedded server). The session lookup finds nothing, so 404
// proves the ticket got through auth and 401 proves it did not.
describe("Agent API events stream ticket auth across gateway mounts", () => {
  function agentApi(mount: string) {
    const api = createAgentApi({
      sessionManager: { getSession: async () => null },
    } as unknown as Parameters<typeof createAgentApi>[0]);
    const root = new Hono();
    root.route(mount, api);
    return root;
  }

  for (const mount of ["", "/lobu"]) {
    test(`GET ${mount}/api/v1/agents/:id/events accepts a ?token= ticket`, async () => {
      const res = await agentApi(mount).request(
        `${mount}/api/v1/agents/session-1/events${qTicket("user-1")}`,
        { method: "GET" },
      );
      expect(res.status).toBe(404);
    });

    test(`GET ${mount}/api/v1/agents/:id rejects the same ticket`, async () => {
      const res = await agentApi(mount).request(
        `${mount}/api/v1/agents/session-1${qTicket("user-1")}`,
        { method: "GET" },
      );
      expect(res.status).toBe(401);
    });
  }
});
