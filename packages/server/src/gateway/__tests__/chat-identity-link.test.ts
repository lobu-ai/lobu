/**
 * One-click chat identity linking, end to end.
 *
 * The routes are the production Hono routes with only the session reader and
 * origin injected; claims, membership and the identity graph are real
 * Postgres. The end-to-end cases drive a real Google Chat webhook through the
 * assembled bridge (`helpers/chat-bridge-harness.ts`), follow the link the
 * bot posted, and mint the next turn's worker token through the production
 * producer. Every id here is synthetic.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  setDefaultTimeout,
  test,
} from "bun:test";
import { verifyWorkerToken } from "@lobu/core";
import { Chat, type StateAdapter } from "chat";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import {
  addUserToOrganization,
  createTestUser,
  insertChatConnectionRow,
  linkChatIdentityInGraph,
  type TestUser,
} from "../../__tests__/setup/test-fixtures.js";
import { sessionCookieName } from "../../auth/session-cookie-scope.js";
import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import {
  adoptChatIdentityOntoMember,
  persistLoginChatIdentity,
  provisionMemberAndCoreIdentities,
  withChatIdentityLock,
} from "../../auth/subject-identities.js";
import { createChatIdentityRoutes } from "../../connect/chat-identity-routes.js";
import { getDb } from "../../db/client.js";
import {
  resolveChatSenderMember,
  resolveChatUserIdentity,
  resolveChatUserIdForUser,
} from "../../lobu/stores/chat-identity.js";
import { CHAT_IDENTITY_LINK_SCOPE, CHAT_IDENTITY_LINK_TTL_SECONDS, mintChatIdentityLink } from "../../lobu/stores/chat-identity-link.js";
import { resolveMemberOrgsForUser } from "../../identity/member-orgs.js";
import { resetRateLimiterForTests } from "../../utils/rate-limiter.js";
import { gchatPlatform } from "../connections/platforms/gchat.js";
import { resolveClaimingUserSlackIdentities } from "../connections/slack-claim-identities.js";
import { createConnectedGatewayStateAdapter } from "../connections/state-adapter.js";
import type { PlatformConnection } from "../connections/types.js";
import { mintTurnToken } from "../orchestration/agent-turn-producer.js";
import { type AssembledChatBridge, startAssembledChatBridge, waitFor } from "./helpers/chat-bridge-harness.js";
import { ensureDbForGatewayTests, resetTestDatabase, seedAgentRow } from "./helpers/db-setup.js";

setDefaultTimeout(30_000);

const ORG_A = "org-chat-link-a";
const ORG_B = "org-chat-link-b";
const AGENT_ID = "agent-chat-link";
const RUNTIME_CONNECTION_ID = "gchat-chat-link";
const DM_SPACE = "spaces/DDDD-chat-link-dm";
const SPACE = "spaces/AAAA-chat-link-room";
const ORIGIN = "https://cloud.example.test";
const SENDER = {
  name: "users/100000000000000000011",
  displayName: "Link Sender",
  email: "link.sender@example.test",
  type: "HUMAN",
};
const TEST_ENCRYPTION_KEY = Buffer.from("12345678901234567890123456789012").toString("base64");
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

const browser = {
  origin: ORIGIN,
  cookie: `${sessionCookieName(true)}=synthetic-session`,
  "content-type": "application/x-www-form-urlencoded",
};

/** The production routes, signed in as `user` (or signed out for null). */
function routesAs(user: TestUser | null) {
  return createChatIdentityRoutes({
    session: async () => (user ? { user: { id: user.id, email: user.email, name: user.name } } : null),
    origin: () => ORIGIN,
  });
}

const pageUrl = (token: string) => `${ORIGIN}/connect/chat-identity?token=${encodeURIComponent(token)}`;

function submit(user: TestUser | null, token: string, headers: Record<string, string> = browser) {
  return routesAs(user).request(`${ORIGIN}/connect/chat-identity`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ token }).toString(),
  });
}

function mint(organizationId = ORG_A, senderId = SENDER.name, platform = "gchat") {
  return mintChatIdentityLink({
    organizationId,
    connectionId: RUNTIME_CONNECTION_ID,
    platform,
    teamId: undefined,
    senderId,
    senderDisplayName: SENDER.displayName,
  });
}

async function claimCount(): Promise<number> {
  const rows = await getDb()`SELECT id FROM oauth_states WHERE scope = ${CHAT_IDENTITY_LINK_SCOPE}`;
  return rows.length;
}

async function identityRows(organizationId: string) {
  return getDb()`
    SELECT entity_id FROM entity_identities
    WHERE organization_id = ${organizationId} AND namespace = 'google_user_id' AND deleted_at IS NULL
  `;
}

async function seedOrgs(): Promise<void> {
  const sql = getDb();
  await sql`INSERT INTO organization (id, name, slug, visibility) VALUES (${ORG_A}, 'Acme Synthetic', 'acme-synthetic', 'private')`;
  await sql`INSERT INTO organization (id, name, slug, visibility) VALUES (${ORG_B}, 'Bravo Synthetic', 'bravo-synthetic', 'private')`;
  await seedAgentRow(AGENT_ID, { organizationId: ORG_A });
  await insertChatConnectionRow({
    id: RUNTIME_CONNECTION_ID,
    organizationId: ORG_A,
    platform: "gchat",
    agentId: AGENT_ID,
    settings: { allowGroups: true },
  });
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await ensureDbForGatewayTests();
});

afterAll(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

describe("chat identity link routes", () => {
  let member: TestUser;

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrgs();
    // A plain better-auth membership with no `$member` entity yet: the
    // redemption provisions it.
    member = await createTestUser({});
    await addUserToOrganization(member.id, ORG_A, "member");
  });

  test("a platform with no identity registry entry gets no link", async () => {
    expect(await mint(ORG_A, "someone", "no-such-platform")).toBeNull();
    expect(await claimCount()).toBe(0);
  });

  test("GET shows both accounts and the org, and never mutates", async () => {
    const token = (await mint())!;
    const res = await routesAs(member).request(pageUrl(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    const html = await res.text();
    expect(html).toContain("Acme Synthetic");
    expect(html).toContain(member.email);
    expect(html).toContain("bot will then act as you in <strong>Acme Synthetic</strong>");
    expect(html).not.toContain("any workspace");
    expect(html).toContain("Group messages will continue to use only shared workspace access");
    expect(html).toContain(`gchat: ${SENDER.displayName} (${SENDER.name})`);
    expect(html).toContain('method="post"');
    expect(await claimCount()).toBe(1);
    expect(await identityRows(ORG_A)).toHaveLength(0);
  });

  test("GET signed out goes through login and comes back to the same link", async () => {
    const token = (await mint())!;
    const res = await routesAs(null).request(pageUrl(token));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/auth/login?callbackUrl=")).toBe(true);
    expect(decodeURIComponent(location)).toContain(pageUrl(token));
    expect(await claimCount()).toBe(1);
  });

  test("POST without the same-origin browser session is refused and links nothing", async () => {
    const token = (await mint())!;
    for (const headers of [
      { ...browser, origin: "https://evil.example" },
      { ...browser, origin: "null" },
      { cookie: browser.cookie, "content-type": browser["content-type"] },
      { ...browser, cookie: "" },
      { ...browser, authorization: "Bearer synthetic-token" },
    ]) {
      expect((await submit(member, token, headers)).status).toBe(403);
    }
    expect(await claimCount()).toBe(1);
    expect(await identityRows(ORG_A)).toHaveLength(0);
  });

  test("a member's POST links the identity and burns the link", async () => {
    const token = (await mint())!;
    const res = await submit(member, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    expect(await res.text()).toContain("Chat account linked");
    expect(await resolveChatSenderMember("gchat", undefined, SENDER.name, ORG_A)).toEqual({
      userId: member.id,
      role: "member",
    });
    expect(await claimCount()).toBe(0);

    const replay = await submit(member, token);
    expect(replay.status).toBe(410);
    expect(await replay.text()).toContain("expired or was already used");
  });

  test("an expired link is refused on GET and POST", async () => {
    const token = (await mint())!;
    await getDb()`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE scope = ${CHAT_IDENTITY_LINK_SCOPE}`;
    expect((await routesAs(member).request(pageUrl(token))).status).toBe(410);
    expect((await submit(member, token)).status).toBe(410);
    expect(await identityRows(ORG_A)).toHaveLength(0);
  });

  test("a disabled connection or a data connection cannot redeem a chat link", async () => {
    const token = (await mint())!;
    await getDb()`UPDATE connections SET status = 'paused' WHERE organization_id = ${ORG_A}`;
    expect((await submit(member, token)).status).toBe(410);
    await getDb()`UPDATE connections SET status = 'active', credential_mode = NULL WHERE organization_id = ${ORG_A}`;
    expect((await submit(member, token)).status).toBe(410);
    expect(await identityRows(ORG_A)).toHaveLength(0);
    expect(await claimCount()).toBe(1);
  });

  test("a WhatsApp Web device connection redeems its link by its numeric runtime id", async () => {
    // Connector-transport chat runs under `connections.id` and holds no
    // credential of its own.
    const [row] = await getDb()`INSERT INTO connections (organization_id, connector_key, slug, status, visibility)
      VALUES (${ORG_A}, 'whatsapp.web', 'whatsapp-web', 'active', 'private') RETURNING id`;
    const senderJid = "15550001111@s.whatsapp.net";
    const token = (await mintChatIdentityLink({
      organizationId: ORG_A,
      connectionId: String(row.id),
      platform: "whatsapp.web",
      teamId: undefined,
      senderId: senderJid,
      senderDisplayName: "WhatsApp Sender",
    }))!;
    expect((await submit(member, token)).status).toBe(200);
    expect(await resolveChatSenderMember("whatsapp.web", undefined, senderJid, ORG_A)).toEqual({
      userId: member.id,
      role: "member",
    });
  });

  test("concurrent redemptions of one token succeed only once", async () => {
    await provisionMemberAndCoreIdentities(ORG_A, { userId: member.id, email: member.email, role: "member" });
    const token = (await mint())!;
    const responses = await Promise.all([submit(member, token), submit(member, token)]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 410]);
    expect(await claimCount()).toBe(0);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name, ORG_A)).toBe(member.id);
  });

  test("a link-proven identity is trusted only in the org whose connection offered it", async () => {
    // A BYO or device connection's owner can report any sender, so a redeemed
    // link proves the identity only inside that connection's organization.
    const token = (await mint(ORG_A))!;
    expect((await submit(member, token)).status).toBe(200);
    await addUserToOrganization(member.id, ORG_B, "member");
    expect(await resolveChatSenderMember("gchat", undefined, SENDER.name, ORG_A)).toEqual({
      userId: member.id,
      role: "member",
    });
    expect(await resolveChatSenderMember("gchat", undefined, SENDER.name, ORG_B)).toBeNull();
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBeNull();
  });

  test("links redeemed in two orgs by two users each stay inside their own org", async () => {
    const other = await createTestUser({});
    await addUserToOrganization(other.id, ORG_B, "member");
    for (const [user, org] of [[member, ORG_A], [other, ORG_B]] as const) {
      await provisionMemberAndCoreIdentities(org, { userId: user.id, email: user.email, role: "member" });
    }
    const tokenA = (await mint(ORG_A))!;
    const tokenB = (await mint(ORG_B))!;
    const responses = await Promise.all([submit(member, tokenA), submit(other, tokenB)]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name, ORG_A)).toBe(member.id);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name, ORG_B)).toBe(other.id);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBeNull();
  });

  test("a link squatted in one org never blocks the provider-proven owner elsewhere", async () => {
    const token = (await mint())!;
    expect((await submit(member, token)).status).toBe(200);
    const owner = await createTestUser({});
    await addUserToOrganization(owner.id, ORG_B, "member");
    await provisionMemberAndCoreIdentities(ORG_B, { userId: owner.id, email: owner.email, role: "member" });
    await persistLoginChatIdentity(
      { providerId: "google", userId: owner.id, accountId: SENDER.name.slice("users/".length) },
      {
        resolveMemberOrgsForUser,
        getEnabledLoginProviderConfigs: async () => [],
        fetchUserInfoWithRaw: async () => ({ raw: null, normalized: null }),
      },
    );
    expect(await identityRows(ORG_B)).toHaveLength(1);
    // Provider proof is global; the org holding the link fails closed.
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBe(owner.id);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name, ORG_B)).toBe(owner.id);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name, ORG_A)).toBeNull();
  });

  test("a redeemed link addresses owner DMs only for the org that offered it", async () => {
    const token = (await mint(ORG_A))!;
    expect((await submit(member, token)).status).toBe(200);
    await addUserToOrganization(member.id, ORG_B, "member");
    expect(await resolveChatUserIdForUser(member.id, "gchat", null, ORG_A)).not.toBeNull();
    expect(await resolveChatUserIdForUser(member.id, "gchat", null, ORG_B)).toBeNull();
  });

  test("a redeemed link is never provider proof for a Slack installation claim", async () => {
    const { memberEntityId } = await provisionMemberAndCoreIdentities(ORG_A, {
      userId: member.id,
      email: member.email,
      role: "member",
    });
    const adopt = (key: string, proof: "provider" | "link") =>
      withChatIdentityLock(SLACK_IDENTITY.USER_ID, key, (tx) =>
        adoptChatIdentityOntoMember(tx, ORG_A, memberEntityId, SLACK_IDENTITY.USER_ID, key, member.id, proof),
      );
    expect(await adopt("TLINKTEAM:ULINKUSER", "link")).toBe("created");
    expect(await resolveClaimingUserSlackIdentities(member.id)).toEqual([]);
    expect(await adopt("TSIGNTEAM:USIGNUSER", "provider")).toBe("created");
    expect(await resolveClaimingUserSlackIdentities(member.id)).toEqual([
      { teamId: "TSIGNTEAM", slackUserId: "USIGNUSER" },
    ]);
  });

  test("a non-member is told to ask an admin and nothing is linked", async () => {
    const outsider = await createTestUser({});
    const token = (await mint())!;
    const page = await routesAs(outsider).request(pageUrl(token));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("Ask an admin of Acme Synthetic to invite you");
    const res = await submit(outsider, token);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Ask an admin of Acme Synthetic to invite you");
    expect(await identityRows(ORG_A)).toHaveLength(0);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBeNull();
  });

  test("an identity already linked to another member is refused and the original link stays", async () => {
    const owner = await createTestUser({});
    await addUserToOrganization(owner.id, ORG_A, "member");
    await linkChatIdentityInGraph({ organizationId: ORG_A, userId: owner.id, platform: "gchat", platformUserId: SENDER.name });
    const token = (await mint())!;
    const res = await submit(member, token);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("already linked to a different Lobu account");
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBe(owner.id);
    expect(await identityRows(ORG_A)).toHaveLength(1);
  });

  test("an identity another user holds in a different org is refused too", async () => {
    const owner = await createTestUser({});
    await addUserToOrganization(owner.id, ORG_B, "member");
    await linkChatIdentityInGraph({ organizationId: ORG_B, userId: owner.id, platform: "gchat", platformUserId: SENDER.name });
    const token = (await mint())!;
    expect((await submit(member, token)).status).toBe(409);
    expect(await identityRows(ORG_A)).toHaveLength(0);
    expect(await resolveChatUserIdentity("gchat", undefined, SENDER.name)).toBe(owner.id);
  });

  test("a link offered in org A never links into org B", async () => {
    const bOnly = await createTestUser({});
    await addUserToOrganization(bOnly.id, ORG_B, "member");
    const token = (await mint(ORG_A))!;
    expect((await submit(bOnly, token)).status).toBe(403);
    expect(await identityRows(ORG_A)).toHaveLength(0);
    expect(await identityRows(ORG_B)).toHaveLength(0);

    // A member of both orgs links only where the link was offered.
    await addUserToOrganization(member.id, ORG_B, "member");
    expect((await submit(member, token)).status).toBe(200);
    expect(await identityRows(ORG_A)).toHaveLength(1);
    expect(await identityRows(ORG_B)).toHaveLength(0);
  });
});

describe("Google Chat DM -> chat identity link -> member turn", () => {
  let chat: Chat;
  let state: StateAdapter;
  let bridge: AssembledChatBridge;
  let created: Array<Record<string, any>>;
  let member: TestUser;

  async function deliver(body: Record<string, unknown>): Promise<number> {
    const tasks: Promise<unknown>[] = [];
    const response = await chat.webhooks.gchat(
      new Request(`https://gateway.example.test/api/v1/webhooks/${RUNTIME_CONNECTION_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { waitUntil: (task) => tasks.push(task) },
    );
    await Promise.all(tasks);
    return response.status;
  }

  function directMessage(messageId: string, text: string): Record<string, unknown> {
    const space = { name: DM_SPACE, type: "DM", spaceType: "DIRECT_MESSAGE" };
    return {
      type: "MESSAGE",
      eventTime: "2026-10-13T12:00:00Z",
      space,
      user: SENDER,
      message: { name: `${DM_SPACE}/messages/${messageId}`, createTime: "2026-10-13T12:00:00Z", text, sender: SENDER, space },
    };
  }

  function spaceMention(messageId: string, text: string): Record<string, unknown> {
    const space = { name: SPACE, type: "ROOM", spaceType: "SPACE" };
    return {
      type: "MESSAGE",
      eventTime: "2026-10-13T12:00:00Z",
      space,
      user: SENDER,
      message: {
        name: `${SPACE}/messages/${messageId}`,
        createTime: "2026-10-13T12:00:00Z",
        text: `@Lobu ${text}`,
        argumentText: ` ${text}`,
        sender: SENDER,
        space,
        thread: { name: `${SPACE}/threads/t1` },
        annotations: [
          {
            type: "USER_MENTION",
            startIndex: 0,
            length: 5,
            userMention: { user: { name: "users/lobu-bot", displayName: "Lobu", type: "BOT" }, type: "MENTION" },
          },
        ],
      },
    };
  }

  /** The worker token the production producer mints for the newest queued turn. */
  async function mintNewestTurn() {
    const [row] = await getDb()<{ id: number; action_input: Record<string, any> }[]>`
      SELECT id, action_input FROM runs WHERE run_type = 'chat_message' ORDER BY id DESC LIMIT 1
    `;
    if (!row) throw new Error("no queued chat turn");
    return verifyWorkerToken(await mintTurnToken(row.action_input as never, Number(row.id)));
  }

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrgs();
    member = await createTestUser({});
    await addUserToOrganization(member.id, ORG_A, "member");

    state = await createConnectedGatewayStateAdapter();
    const adapter: any = await gchatPlatform.createAdapter({
      credentials: JSON.stringify({
        client_email: "lobu-chat@example.iam.gserviceaccount.com",
        private_key: "not-used-by-the-inbound-webhook-test",
        project_id: "lobu-chat-test",
      }),
      disableSignatureVerification: true,
      userName: "lobu",
    });
    created = [];
    resetRateLimiterForTests();
    adapter.chatApi.spaces.messages.create = mock(async (request: Record<string, any>) => {
      created.push(request);
      return { data: { name: `${request.parent}/messages/bot-${created.length}` } };
    });
    adapter.chatApi.spaces.messages.update = mock(async (request: Record<string, any>) => ({ data: { name: request.name } }));
    adapter.fetchMessages = mock(async () => ({ messages: [] }));
    adapter.startTyping = mock(async () => undefined);
    chat = new Chat({ userName: "lobu", adapters: { gchat: adapter }, state, logger: "silent" });
    const connection: PlatformConnection = {
      id: RUNTIME_CONNECTION_ID,
      platform: "gchat",
      organizationId: ORG_A,
      agentId: AGENT_ID,
      config: { platform: "gchat", disableSignatureVerification: true },
      settings: { allowGroups: true },
      metadata: {},
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    };
    bridge = await startAssembledChatBridge(chat, state, connection);
  });

  afterEach(async () => {
    await bridge?.stop();
  });

  test("an unlinked member follows the DM notice's link and their next DM turn runs as the member", async () => {
    expect(await deliver(directMessage("dm-1", "hello?"))).toBe(200);
    await waitFor(() => expect(created).toHaveLength(1));
    const notice = String(created[0]?.requestBody?.text);
    expect(notice).toContain("Ask an admin of this workspace to invite you");
    const match = notice.match(/https:\/\/gateway\.example\.test\/connect\/chat-identity\?token=([^\s]+)/);
    expect(match).not.toBeNull();
    const token = decodeURIComponent(match![1]!);

    // Before linking, the DM turn is reply-only.
    await waitFor(async () => {
      expect(await getDb()`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(1);
    });
    expect(await mintNewestTurn()).toMatchObject({ chatAccess: "reply_only" });

    expect((await routesAs(member).request(pageUrl(token))).status).toBe(200);
    expect((await submit(member, token)).status).toBe(200);

    expect(await deliver(directMessage("dm-2", "now what's on my plate?"))).toBe(200);
    await waitFor(async () => {
      expect(await getDb()`SELECT id FROM runs WHERE run_type = 'chat_message'`).toHaveLength(2);
    });
    expect(await mintNewestTurn()).toMatchObject({ chatAccess: "member", actorUserId: member.id });
    // A linked member gets no further notices.
    expect(created).toHaveLength(1);
  });

  test("a group notice contains no link and does not suppress the next DM link", async () => {
    const [conn] = await getDb()<{ id: number }[]>`
      SELECT id FROM connections WHERE organization_id = ${ORG_A} AND connector_key = 'gchat'
    `;
    await createTestAutomationSubscription({
      organizationId: ORG_A,
      agentId: AGENT_ID,
      connectionId: Number(conn!.id),
      platform: "gchat",
      channelId: SPACE,
    });
    expect(await deliver(spaceMention("space-1", "status?"))).toBe(200);
    await waitFor(() => expect(created).toHaveLength(1));
    const notice = String(created[0]?.requestBody?.text);
    expect(notice).toContain("Ask an admin of this workspace to invite you");
    expect(notice).not.toContain("/connect/chat-identity");
    expect(await claimCount()).toBe(0);
    expect(await deliver(directMessage("dm-after-group", "link me"))).toBe(200);
    await waitFor(() => expect(created).toHaveLength(2));
    expect(String(created[1]?.requestBody?.text)).toContain("/connect/chat-identity");
    expect(await claimCount()).toBe(1);
  });

  test("a DM after the link expiry window gets a replacement link", async () => {
    expect(await deliver(directMessage("dm-expiry-1", "hello"))).toBe(200);
    await waitFor(() => expect(created).toHaveLength(1));
    const first = String(created[0]?.requestBody?.text);
    expect(await deliver(directMessage("dm-expiry-2", "hello again"))).toBe(200);
    expect(created).toHaveLength(1);
    const realNow = Date.now;
    const clock = spyOn(Date, "now").mockImplementation(
      () => realNow() + (CHAT_IDENTITY_LINK_TTL_SECONDS + 1) * 1000,
    );
    try {
      expect(await deliver(directMessage("dm-expiry-3", "new link please"))).toBe(200);
      await waitFor(() => expect(created).toHaveLength(2));
      const replacement = String(created[1]?.requestBody?.text);
      expect(replacement).toContain("/connect/chat-identity");
      expect(replacement).not.toBe(first);
    } finally {
      clock.mockRestore();
    }
  });
});
