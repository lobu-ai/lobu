import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sessionCookieName } from "../../auth/session-cookie-scope.js";
import { createChatIdentityRoutes } from "../../connect/chat-identity-routes.js";
import * as dbClient from "../../db/client.js";
import * as chatLinks from "../../lobu/stores/chat-identity-link.js";
import { getRateLimiter, resetRateLimiterForTests } from "../../utils/rate-limiter.js";
import { MessageHandlerBridge } from "../connections/message-handler-bridge.js";
import { chatSenderLimitKey, type ChatTurnActor } from "../orchestration/chat-turn-actor.js";

afterEach(() => {
  mock.restore();
  resetRateLimiterForTests();
});

async function offer(
  actor: ChatTurnActor,
  isDirect: boolean,
  platform = "slack",
  post = mock(async (_text: string) => undefined),
) {
  spyOn(getRateLimiter(), "consume").mockResolvedValue({
    allowed: true, count: 1, limit: 1, resetInSeconds: 600, windowStart: 0, countedInDb: true,
  });
  const mint = spyOn(chatLinks, "mintChatIdentityLink").mockResolvedValue("synthetic-link");
  const bridge = new MessageHandlerBridge(
    { id: "synthetic-chat", platform } as never,
    { getArtifactStore: () => null, getPublicGatewayUrl: () => "https://cloud.example.test" } as never,
    {} as never,
    undefined, undefined, undefined,
    async () => actor,
  );
  // Exercise the admission boundary without starting a provider or a run queue.
  const admitted = await (bridge as unknown as {
    admitChatSender(args: Record<string, unknown>): Promise<boolean>;
  }).admitChatSender({
    organizationId: "org-link-notice", userId: "U_SYNTHETIC", teamId: "T_SYNTHETIC",
    isDirect, senderVouched: true, thread: { post },
  });
  return { mint, post, admitted };
}

test.each([true, false])("failed notices release their window and still admit the turn (direct=%s)", async (isDirect) => {
  const refund = spyOn(getRateLimiter(), "refund").mockResolvedValue(undefined);
  const failedPost = mock(async (_text: string) => { throw new Error("synthetic send failure"); });
  const { admitted, mint, post } = await offer({ access: "reply_only" }, isDirect, "slack", failedPost);
  expect(admitted).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
  expect(mint).toHaveBeenCalledTimes(isDirect ? 1 : 0);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(refund).toHaveBeenCalledWith(chatSenderLimitKey(isDirect ? "link" : "notice", {
    organizationId: "org-link-notice", platform: "slack", teamId: "T_SYNTHETIC", senderId: "U_SYNTHETIC",
  }), expect.objectContaining({ allowed: true, windowStart: 0, countedInDb: true }));
});

test.each([true, false])("delivered notices keep their window spent (direct=%s)", async (isDirect) => {
  const refund = spyOn(getRateLimiter(), "refund").mockResolvedValue(undefined);
  const { admitted, post } = await offer({ access: "reply_only" }, isDirect);
  expect(admitted).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
  expect(refund).not.toHaveBeenCalled();
});

test("vouched senders (DM or group), linked members and unsupported platforms get no link", async () => {
  // A vouched colleague keeps today's silent handling: no new notice in an
  // existing team workspace. Linking is offered only where the turn is confined.
  for (const [actor, isDirect, platform] of [
    [{ access: "org_shared" }, true, "slack"],
    [{ access: "org_shared" }, false, "slack"],
    [{ access: "member", actorUserId: "user-linked" }, true, "slack"],
    [{ access: "org_shared" }, true, "no-such-platform"],
  ] as const) {
    const { mint, post } = await offer(actor, isDirect, platform);
    expect(mint).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    mock.restore();
    resetRateLimiterForTests();
  }
});

test("the confirmation page preserves form Origin without leaking the token in Referer", async () => {
  const sql = mock()
    .mockResolvedValueOnce([{ payload: {
      organizationId: "org-link-notice", connectionId: "synthetic-chat", platform: "slack",
      teamId: "T_SYNTHETIC", senderId: "U_SYNTHETIC", identityKey: "T_SYNTHETIC:U_SYNTHETIC",
      senderDisplayName: "Synthetic Sender",
    } }])
    .mockResolvedValueOnce([{ name: "Synthetic Workspace" }])
    .mockResolvedValueOnce([{ role: "member" }]);
  spyOn(dbClient, "getDb").mockReturnValue(sql as unknown as dbClient.DbClient);
  const origin = "https://cloud.example.test";
  const routes = createChatIdentityRoutes({
    session: async () => ({ user: { id: "user-link-notice" } }),
    origin: () => origin,
  });
  const response = await routes.request(`${origin}/connect/chat-identity?token=synthetic-link`);
  expect(response.status).toBe(200);
  // Fetch's append-Origin algorithm turns no-referrer into Origin: null for
  // a form navigation. strict-origin keeps Origin and strips path/query from Referer.
  expect(response.headers.get("referrer-policy")).toBe("strict-origin");
  expect(await response.text()).toContain('method="post"');

  const rejected = await routes.request(`${origin}/connect/chat-identity`, {
    method: "POST",
    headers: { origin: "null", cookie: `${sessionCookieName(true)}=synthetic-session` },
    body: new URLSearchParams({ token: "synthetic-link" }),
  });
  expect(rejected.status).toBe(403);
  expect(sql).toHaveBeenCalledTimes(3);
});
