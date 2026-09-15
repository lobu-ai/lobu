/**
 * End-to-end-ish proof on the REAL agent API route (no server boot): the
 * embedded panel opens GET /api/v1/agents/:id/events with EventSource (no
 * Authorization header) and a `?token=` ticket. This must get PAST the outer
 * auth gate (createApiAuthMiddleware) — the bug that shipped in #1340 was that
 * the gate 401'd it before the handler ran.
 *
 * The events handler returns 404 ("Agent not found") once auth passes and the
 * session lookup misses. So with a stub sessionManager that returns null:
 *   - auth REJECTED  → 401 (outer gate)
 *   - auth ACCEPTED  → 404 (past the gate, into the handler)
 * That 401-vs-404 split is the auth proof, without a live agent runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "@lobu/core";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
  setAuthProvider(null);
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  setAuthProvider(null);
});

function makeApp() {
  return createAgentApi({
    queueProducer: {} as never,
    // getSession returns null → the handler answers 404 once auth has passed.
    sessionManager: { async getSession() { return null; } } as never,
    sseManager: {} as never,
    publicGatewayUrl: "http://localhost:8787",
    artifactStore: {} as never,
  });
}

const ticket = (userId: string, exp = Date.now() + 60_000): string =>
  encrypt(JSON.stringify({ userId, platform: "external", exp }));

const eventsStatus = async (query: string): Promise<number> => {
  const res = await makeApp().request(`/api/v1/agents/some-session/events${query}`, {
    method: "GET",
  });
  return res.status;
};

describe("GET /api/v1/agents/:id/events — embedded SSE ticket auth", () => {
  test("a valid ?token= ticket gets past the outer auth gate (404, not 401)", async () => {
    // 404 = auth passed, session-lookup missed. The point is it is NOT 401.
    expect(await eventsStatus(`?token=${encodeURIComponent(ticket("u1"))}`)).toBe(404);
  });

  test("no token / no Authorization header is rejected at the gate (401)", async () => {
    expect(await eventsStatus("")).toBe(401);
  });

  test("a tampered ticket is rejected at the gate (401)", async () => {
    expect(await eventsStatus("?token=not-a-real-ticket")).toBe(401);
  });

  test("an expired ticket is rejected at the gate (401)", async () => {
    expect(await eventsStatus(`?token=${encodeURIComponent(ticket("u1", Date.now() - 1000))}`)).toBe(
      401,
    );
  });

  // The route declares `since` and `token` so both are discoverable in the
  // OpenAPI document. Declaring a query schema at all is the risk: if it ever
  // rejected an unlisted or absent parameter, every embedded stream would 400
  // at the validator, BEFORE the auth gate these tests pin. 401/404 both prove
  // the request reached the gate; a 400 anywhere here is the regression.
  test("a resume cursor reaches the auth gate rather than the validator", async () => {
    expect(await eventsStatus("?since=1700000000001")).toBe(401);
    expect(
      await eventsStatus(`?since=1700000000001&token=${encodeURIComponent(ticket("u1"))}`),
    ).toBe(404);
  });
});
