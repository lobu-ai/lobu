/**
 * GET /api/v1/agents/:id/events replays only THIS session's backlog.
 *
 * `conversationId` is deterministic (agent + user + org + thread), so
 * `forceNew` mints a fresh session at the key the previous one used — while
 * the SSE backlog ring, keyed on that same string, still holds the old turn
 * for its 2-minute TTL. Replaying the whole ring answered `lobu chat --new`
 * with the PREVIOUS turn's output, delivered before the new message had even
 * been dispatched, so the CLI printed a stale answer and exited.
 *
 * The boundary is `session.createdAt`: a resumed session keeps its original
 * value and still gets its own events back; a replacement session starts
 * after everything the old one emitted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "@lobu/core";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const SESSION_KEY = "agent-1_user-1_org-1";
const SESSION_CREATED_AT = 1_788_893_911_000;

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

/** Captures the `since` bound the route asks the backlog for. */
function makeSseRecorder() {
  const sinceArgs: Array<number | undefined> = [];
  return {
    sinceArgs,
    manager: {
      totalConnections: () => 0,
      connectionCount: () => 0,
      getRecentEvents(_key: string, since?: number) {
        sinceArgs.push(since);
        return [];
      },
      addConnection() {},
      removeConnection() {},
    },
  };
}

function makeApp(sse: ReturnType<typeof makeSseRecorder>) {
  return createAgentApi({
    queueProducer: {} as never,
    sessionManager: {
      async getSession(id: string) {
        if (id !== SESSION_KEY) return null;
        return {
          conversationId: SESSION_KEY,
          channelId: "api_test",
          userId: "user-1",
          agentId: "agent-1",
          lastActivity: SESSION_CREATED_AT,
          createdAt: SESSION_CREATED_AT,
        };
      },
    } as never,
    sseManager: sse.manager as never,
    publicGatewayUrl: "http://localhost:8787",
    artifactStore: {} as never,
    agentMetadataStore: {
      async getMetadata() {
        return { owner: { platform: "external", userId: "user-1" } };
      },
    } as never,
  });
}

const ticket = (userId: string): string =>
  encrypt(
    JSON.stringify({ userId, platform: "external", exp: Date.now() + 60_000 }),
  );

describe("GET /api/v1/agents/:id/events — backlog is scoped to the session", () => {
  test("replay is bounded by session.createdAt, not the whole ring", async () => {
    const sse = makeSseRecorder();
    const app = makeApp(sse);

    // The handler holds the stream open for the life of the connection, so
    // abort once the backlog snapshot has been taken rather than awaiting it.
    const controller = new AbortController();
    const request = app.request(
      `/api/v1/agents/${SESSION_KEY}/events?token=${encodeURIComponent(ticket("user-1"))}`,
      { method: "GET", signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await request.catch(() => undefined);

    expect(sse.sinceArgs).toEqual([SESSION_CREATED_AT]);
    // The regression this pins: an unbounded read returns the previous
    // session's turn as well, because the ring key is the same string.
    expect(sse.sinceArgs[0]).not.toBeUndefined();
  });
});
