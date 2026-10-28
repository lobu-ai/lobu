import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sessionCookieName } from "../../auth/session-cookie-scope.js";
import * as subjectIdentities from "../../auth/subject-identities.js";
import { createChatIdentityRoutes } from "../../connect/chat-identity-routes.js";
import * as dbClient from "../../db/client.js";
import * as chatLinks from "../../lobu/stores/chat-identity-link.js";
import { getRateLimiter, resetRateLimiterForTests } from "../../utils/rate-limiter.js";
import { MessageHandlerBridge } from "../connections/message-handler-bridge.js";
import type { ChatTurnActor } from "../orchestration/chat-turn-actor.js";

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
    organizationId: "org-link-notice", channelId: "slack:D_SYNTHETIC", userId: "U_SYNTHETIC", teamId: "T_SYNTHETIC",
    isDirect, senderVouched: true, thread: { id: "slack:D_SYNTHETIC:1.0", post },
  });
  return { mint, post, admitted };
}

test("vouched senders (DM or group), linked members and unsupported platforms get no link", async () => {
  // A vouched colleague keeps today's silent handling: no new notice in an
  // existing team workspace. Linking is offered only where the turn is confined.
  for (const [actor, isDirect, platform] of [
    [{ access: "org_shared" }, true, "slack"],
    [{ access: "org_shared" }, false, "slack"],
    [{ access: "member", actorUserId: "user-linked" }, true, "slack"],
    [{ access: "org_shared" }, true, "no-such-platform"],
  ] as const) {
    const { admitted, mint, post } = await offer(actor, isDirect, platform);
    expect(mint).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(admitted).toBe(true);
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
    .mockResolvedValueOnce([{ role: "member" }])
    // The org's installed connector definition, for the platform's name.
    .mockResolvedValueOnce([]);
  spyOn(dbClient, "getDb").mockReturnValue(sql as unknown as dbClient.DbClient);
  spyOn(subjectIdentities, "signInProvesChatIdentity").mockResolvedValue(true);
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
  expect(sql).toHaveBeenCalledTimes(4);
});

test("failed account switching offers recovery without consuming the link", async () => {
  const sql = mock();
  spyOn(dbClient, "getDb").mockReturnValue(sql as unknown as dbClient.DbClient);
  spyOn(chatLinks, "readChatIdentityLink").mockResolvedValue({
    organizationId: "org-link-notice", connectionId: "synthetic-chat", platform: "slack",
    teamId: "T_SYNTHETIC", senderId: "U_SYNTHETIC", identityKey: "T_SYNTHETIC:U_SYNTHETIC",
  });
  const consume = spyOn(chatLinks, "deleteChatIdentityLink").mockResolvedValue(undefined);
  const adopt = spyOn(subjectIdentities, "adoptChatIdentityOntoMember").mockResolvedValue("already-owned");
  const signOut = mock(async () => { throw new Error("synthetic sign-out failure"); });
  const origin = "https://cloud.example.test";
  const routes = createChatIdentityRoutes({ signOut, origin: () => origin });
  const response = await routes.request(`${origin}/connect/chat-identity`, {
    method: "POST",
    headers: { origin, cookie: `${sessionCookieName(true)}=synthetic-session` },
    body: new URLSearchParams({ token: "synthetic-link", switch_account: "1" }),
  });
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
  const html = await response.text();
  expect(html).toContain("Could not switch accounts");
  expect(html).toContain('href="/"');
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(consume).not.toHaveBeenCalled();
  expect(adopt).not.toHaveBeenCalled();
  expect(sql).not.toHaveBeenCalled();
});
