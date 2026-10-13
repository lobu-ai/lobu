/**
 * A confined chat turn (reply-only, or a public org's anonymous visitor) is
 * refused, server-side, on every internal route that reaches beyond its own
 * thread: other conversations, media, and remote execution. A linked member's
 * turn, a vouched org-shared turn, and a headless turn keep every route.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ChatTurnAccess, generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { insertChatConnectionRow } from "../../__tests__/setup/test-fixtures.js";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import { __setChatInstanceManagerForTests, getChatInstanceManager } from "../../lobu/gateway.js";
import { persistChannelMessage } from "../connections/channel-transcript.js";
import { resolveAddressableTargets, threadHandleForMessage } from "../conversations/authorization.js";
import { createConversationsRoutes } from "../routes/internal/conversations.js";
import { CHAT_SENDER_NOT_LINKED } from "../orchestration/chat-turn-actor.js";
import { authenticateWorker } from "../routes/internal/middleware.js";
import { ensureDbForGatewayTests, resetTestDatabase, seedAgentRow } from "./helpers/db-setup.js";

const ORG = "org-confined-routes";
const AGENT = "agent-confined-routes";
const TEST_ENCRYPTION_KEY = Buffer.from("12345678901234567890123456789012").toString("base64");
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

/** The production route templates, mounted the way the gateway mounts them. */
function app(): Hono {
  const ok = (c: any) => c.json({ ok: true });
  const internal = new Hono();
  internal.get("/conversations/list", authenticateWorker, ok);
  internal.get("/conversations/read", authenticateWorker, ok);
  internal.post("/conversations/send", authenticateWorker, ok);
  internal.post("/conversations/react", authenticateWorker, ok);
  internal.post("/images/generate", authenticateWorker, ok);
  internal.post("/audio/synthesize", authenticateWorker, ok);
  internal.post("/runtime/exec", authenticateWorker, ok);
  const files = new Hono();
  files.post("/upload", authenticateWorker, ok);
  const root = new Hono();
  root.route("/internal", internal);
  root.route("/internal/files", files);
  return root;
}

function token(claims: { platform: string; chatAccess?: ChatTurnAccess; actorUserId?: string }): string {
  return generateWorkerToken("U0SENDER", "conv-confined", "agent-turn:msg-confined", {
    channelId: "slack:C0CONFINED",
    agentId: AGENT,
    organizationId: ORG,
    ...claims,
  });
}

const DENIED: Array<[string, string]> = [
  ["GET", "/internal/conversations/list"],
  ["GET", "/internal/conversations/read"],
  ["POST", "/internal/conversations/send"],
  ["POST", "/internal/images/generate"],
  ["POST", "/internal/audio/synthesize"],
  ["POST", "/internal/runtime/exec"],
  ["POST", "/internal/files/upload"],
];

async function call(method: string, path: string, bearer: string): Promise<Response> {
  return app().request(path, { method, headers: { authorization: `Bearer ${bearer}` } });
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await resetTestDatabase();
  await seedAgentRow(AGENT, { organizationId: ORG });
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

describe("confined chat turns on internal worker routes", () => {
  test.each(["reply_only", "public_visitor"] as const)("%s message mutations stay in the signed thread", async (access) => {
    const connectionId = "slackinst-confined-mutations";
    await insertChatConnectionRow({ id: connectionId, organizationId: ORG, agentId: AGENT, platform: "slack" });
    await createTestAutomationSubscription({
      organizationId: ORG, agentId: AGENT, connectionSlug: connectionId,
      platform: "slack", channelId: "C0CONFINED", teamId: "T0CONFINED",
    });
    const [target] = await resolveAddressableTargets(AGENT, ORG);
    expect(target).toBeDefined();
    for (const [messageId, root] of [["msg-own", "own"], ["msg-sibling", "sibling"]]) {
      await persistChannelMessage({
        organizationId: ORG, connectionId, platform: "slack", channelId: "C0CONFINED",
        threadId: `slack:C0CONFINED:${root}`, platformMessageId: messageId,
        isBot: true, text: "Synthetic reply", occurredAt: new Date(),
      });
    }
    const bearer = generateWorkerToken("U0SENDER", "slack:C0CONFINED:own", "agent-turn:msg", {
      channelId: "C0CONFINED", platform: "slack", organizationId: ORG, agentId: AGENT,
      connectionId, responseThreadId: "slack:C0CONFINED:own", messageId: "msg-incoming", chatAccess: access,
    });
    const root = new Hono().route("/internal", createConversationsRoutes());
    const previous = getChatInstanceManager();
    const effects: string[] = [];
    __setChatInstanceManagerForTests({
      reactToMessage: async () => { effects.push("react"); },
      editMessage: async () => { effects.push("edit"); },
      deleteMessage: async () => { effects.push("delete"); },
    } as any);
    try {
      for (const action of ["react", "edit", "delete"]) {
        const invoke = (thread: string, message: string) => root.request(`/internal/conversations/${action}`, {
          method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ thread, message, emoji: "eyes", text: "Updated" }),
        });
        const own = threadHandleForMessage(target!, "own");
        expect((await invoke(threadHandleForMessage(target!, "sibling"), "msg-own")).status).toBe(403);
        expect((await invoke(own, "msg-sibling")).status).toBe(403);
        expect((await invoke(own, "msg-missing")).status).toBe(403);
        expect(effects).not.toContain(action);
        expect((await invoke(own, "msg-own")).status).toBe(200);
        expect(effects).toContain(action);
      }
    } finally {
      __setChatInstanceManagerForTests(previous);
    }
  });

  for (const access of ["reply_only", "public_visitor"] as const) {
    test.each(DENIED)(`refuses %s %s for a ${access} turn`, async (method, path) => {
      const response = await call(method, path, token({ platform: "slack", chatAccess: access }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: CHAT_SENDER_NOT_LINKED });
    });

    test(`a ${access} turn keeps its own thread: a reaction is not refused`, async () => {
      const response = await call("POST", "/internal/conversations/react", token({ platform: "slack", chatAccess: access }));
      expect(response.status).toBe(200);
    });
  }

  test.each(DENIED)("allows %s %s for a member, a vouched org-shared sender, and a headless turn", async (method, path) => {
    expect((await call(method, path, token({ platform: "slack", chatAccess: "member", actorUserId: "member-test" }))).status).toBe(200);
    expect((await call(method, path, token({ platform: "slack", chatAccess: "member_shared", actorUserId: "member-test" }))).status).toBe(200);
    expect((await call(method, path, token({ platform: "slack", chatAccess: "org_shared" }))).status).toBe(200);
    expect((await call(method, path, token({ platform: "api" }))).status).toBe(200);
  });
});
