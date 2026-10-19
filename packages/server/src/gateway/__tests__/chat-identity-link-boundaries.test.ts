import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { sessionCookieName } from "../../auth/session-cookie-scope.js";
import * as subjectIdentities from "../../auth/subject-identities.js";
import { createChatIdentityRoutes } from "../../connect/chat-identity-routes.js";
import * as dbClient from "../../db/client.js";
import * as memberOrgs from "../../identity/member-orgs.js";
import * as chatLinks from "../../lobu/stores/chat-identity-link.js";
import { getRateLimiter, resetRateLimiterForTests } from "../../utils/rate-limiter.js";
import * as publicJoin from "../../workspace/join-public.js";
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
    admitChatSender(args: Record<string, unknown>): Promise<{ accessNoticePosted: boolean } | null>;
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
  // Admitted, but the turn must not be told a notice it never got was sent.
  expect(admitted).toEqual({ accessNoticePosted: false });
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
  expect(admitted).toEqual({ accessNoticePosted: true });
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
    const { admitted, mint, post } = await offer(actor, isDirect, platform);
    expect(mint).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(admitted).toEqual({ accessNoticePosted: false });
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

test.each(["conflict", "already-owned"] as const)("join completion is disclosed when identity adoption returns %s", async (outcome) => {
  let joined = false;
  const sql = mock(async (parts: TemplateStringsArray) => {
    const query = parts.join("?");
    if (query.includes('FROM "organization"')) {
      return [{ name: "Synthetic Workspace", slug: "synthetic-workspace", visibility: "public" }];
    }
    if (query.includes('FROM "member"')) return joined ? [{ role: "member" }] : [];
    if (query.includes("FROM connections")) return [{}];
    return [];
  });
  spyOn(dbClient, "getDb").mockReturnValue(sql as unknown as dbClient.DbClient);
  spyOn(chatLinks, "readChatIdentityLink").mockResolvedValue({
    organizationId: "org-link-notice", connectionId: "synthetic-chat", platform: "slack",
    teamId: "T_SYNTHETIC", senderId: "U_SYNTHETIC", identityKey: "T_SYNTHETIC:U_SYNTHETIC",
    senderDisplayName: "Synthetic Sender",
  });
  const join = spyOn(publicJoin, "joinPublicOrganization").mockImplementation(async () => {
    joined = true;
    return { status: "joined", organizationId: "org-link-notice", role: "member" };
  });
  spyOn(memberOrgs, "resolveMemberOrgsForUser").mockResolvedValue([
    { tenantOrganizationId: "org-link-notice", memberEntityId: 123 } as never,
  ]);
  spyOn(subjectIdentities, "withChatIdentityLock").mockImplementation(async (_namespace, _key, write) => write(sql as never));
  const adopt = spyOn(subjectIdentities, "adoptChatIdentityOntoMember").mockResolvedValue(outcome);
  const consume = spyOn(chatLinks, "deleteChatIdentityLink").mockResolvedValue(undefined);
  const origin = "https://cloud.example.test";
  const routes = createChatIdentityRoutes({
    session: async () => ({ user: { id: "user-link-notice" } }),
    origin: () => origin,
  });
  const response = await routes.request(`${origin}/connect/chat-identity`, {
    method: "POST",
    headers: { origin, cookie: `${sessionCookieName(true)}=synthetic-session` },
    body: new URLSearchParams({ token: "synthetic-link", join: "1" }),
  });
  expect(response.status).toBe(outcome === "conflict" ? 409 : 200);
  expect(join).toHaveBeenCalledTimes(1);
  expect(adopt).toHaveBeenCalledTimes(1);
  expect(consume).toHaveBeenCalledTimes(outcome === "conflict" ? 0 : 1);
  const html = await response.text();
  expect(html).toContain("You joined");
  expect(html).toContain("Synthetic Workspace");
  expect(html).not.toContain("Nothing was changed");
});
