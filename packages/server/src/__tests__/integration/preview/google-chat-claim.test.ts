import { beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { StoredConnection } from "@lobu/core";
import { Chat } from "chat";
import { InMemoryStateAdapter } from "../../../gateway/__tests__/fixtures/in-memory-state-adapter.js";
import { gchatPlatform } from "../../../gateway/connections/platforms/gchat.js";
import { ChatInstanceManager } from "../../../gateway/connections/chat-instance-manager.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
import { AutomationSubscriptionService } from "../../../gateway/channels/automation-subscription-service.js";
import { resolveAgentId } from "../../../gateway/services/platform-helpers.js";
import { getDb } from "../../../db/client.js";
import { createPostgresAppInstallationStore } from "../../../lobu/stores/app-installation-store.js";
import { createPostgresAgentConnectionStore } from "../../../lobu/stores/postgres-stores.js";
import { runtimeConnectionIdToSlug, upsertChatConnectionProjection } from "../../../lobu/stores/connections-projection.js";
import { googleChatClaimProvider } from "../../../gateway/connections/gchat-claim.js";
import { claimPendingConnection, resolveClaimContext, type ClaimEngineDeps } from "../../../gateway/connections/connection-claim.js";
import { acceptGoogleChatWebhook, parkGoogleChatSpace, routeGoogleChatWebhook } from "../../../gateway/connections/platforms/gchat-installation.js";
import { cleanupTestDatabase } from "../../setup/test-db.js";
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser } from "../../setup/test-fixtures.js";

beforeEach(async () => { await cleanupTestDatabase(); });

async function fixture() {
  const owner = await createTestOrganization({ slug: "test-source-org" });
  const target = await createTestOrganization({ slug: "test-team-org" });
  const third = await createTestOrganization({ slug: "test-third-org" });
  const user = await createTestUser();
  await addUserToOrganization(user.id, owner.id, "owner");
  await addUserToOrganization(user.id, target.id, "owner");
  await addUserToOrganization(user.id, third.id, "owner");
  const sql = getDb();
  await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
    VALUES ('test-google-account', '123456', 'google', ${user.id}, now(), now())`;
  const source: StoredConnection = {
    id: "test-google-source", organizationId: owner.id, platform: "gchat", status: "active",
    config: { platform: "gchat", googleChatProjectNumber: "123456789" },
    settings: { allowGroups: true }, metadata: {}, createdAt: 1, updatedAt: 1,
  };
  await sql.begin((tx) => upsertChatConnectionProjection(tx, (value) => sql.json(value as any), source, owner.id, "byo"));
  const store = createPostgresAppInstallationStore();
  const connections = createPostgresAgentConnectionStore();
  const provider = googleChatClaimProvider({ store, getConnection: (id) => connections.getConnection(id) });
  const engine: ClaimEngineDeps = {
    resolveMemberOrgs: async () => [owner, target, third].map((org) => ({ ...org, isPersonal: org.id === owner.id })),
    resolveOrgIfMember: async (uid, org) => {
      const [row] = await sql`SELECT o.id FROM organization o JOIN member m ON m."organizationId" = o.id AND m."userId" = ${uid} WHERE o.slug = ${org}`;
      return row?.id ?? null;
    },
    resolveOrgSlug: async (org) => { const [row] = await sql`SELECT slug FROM organization WHERE id = ${org}`; return row?.slug ?? null; },
  };
  const space = "spaces/test-team-space";
  const ref = await parkGoogleChatSpace(source, space, "users/123456", "Test team space", true);
  const input = { userId: user.id, ref, organizationId: target.slug };
  const deps = { publicGatewayUrl: "https://gateway.test/lobu", getConnection: (id: string) => connections.getConnection(id), getAppInstallationStore: () => store, getSecretStore: () => { throw new Error("No secrets are needed to claim"); }, resolveSecrets: async (connection: StoredConnection) => connection.config };
  return { sql, owner, target, third, user, source, space, ref, provider, engine, input, connections, store, deps };
}

describe("Google Chat shared claim flow", () => {
  it("records the verified claimant as the new connection creator", async () => {
    const f = await fixture();
    const result = await claimPendingConnection(f.provider, f.engine, f.input);
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    const [row] = await f.sql`SELECT created_by FROM connections
      WHERE organization_id = ${f.target.id} AND slug = ${runtimeConnectionIdToSlug(result.bindingId)}`;
    expect(row.created_by).toBe(f.user.id);
  });

  it.each(["active", "error"])("the real manager accepts verified setup after %s startup and durable updates", async (status) => {
    const f = await fixture();
    await orgContext.run({ organizationId: f.owner.id }, () => f.connections.saveConnection({
      ...f.source, status: status as StoredConnection["status"],
      config: { ...f.source.config, credentials: { client_email: "test-bot@example.test", private_key: "test-inbound-only-key" } },
    }));
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = f.connections;
    manager.publicGatewayUrl = "https://gateway.test/lobu";
    manager.services = {
      getConnectionStore: () => f.connections, getAppInstallationStore: () => f.store,
      getSecretStore: () => ({}), getCommandRegistry: () => ({ getAll: () => [] }),
      getAutomationSubscriptionService: () => new AutomationSubscriptionService(),
      getArtifactStore: () => ({}), getPublicGatewayUrl: () => manager.publicGatewayUrl,
      getMcpProxy: () => null, getInteractionService: () => new EventEmitter(), getGrantStore: () => ({}),
    };
    manager.createStateAdapter = async () => new InMemoryStateAdapter();
    try {
      expect(await manager.warmConnection(f.source.id)).toBe(true);
      const adapter = manager.getInstance(f.source.id).chat.getAdapter("gchat");
      adapter.verifyProjectNumberToken = async () => false;
      adapter.oauth2Client.verifyIdToken = async () => ({ getPayload: () => ({
        iss: "https://accounts.google.com", aud: "https://gateway.test/lobu/api/v1/webhooks/test-google-source",
        email: "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com", email_verified: true,
      }) });
      const deliver = () => manager.handleWebhook(f.source.id, new Request("https://gateway.test/lobu/api/v1/webhooks/test-google-source", {
        method: "POST", headers: { authorization: "Bearer test-provider-jwt" },
        body: JSON.stringify({ type: "ADDED_TO_SPACE", space: { name: f.space, type: "ROOM" }, user: { name: "users/123456" } }),
      }));
      const first = await deliver();
      expect(first.status).toBe(200);
      expect((await first.json()).text).toContain(f.ref);
      expect((await deliver()).status).toBe(200);
      await orgContext.run({ organizationId: f.owner.id }, () => manager.updateConnection(f.source.id, { settings: { allowGroups: true } }));
      expect((await deliver()).status).toBe(200);
      expect(manager.getInstance(f.source.id).chat.getAdapter("gchat")).toBe(adapter);
      expect((await f.connections.getConnection(f.source.id))?.status).toBe("active");
    } finally {
      await manager.shutdown();
    }
  });
  it("verifies a Google delivery, claims the team, and dispatches its normal Automation reply", async () => {
    const f = await fixture();
    const received: string[] = [];
    const posted: Array<{ space: string; text: string }> = [];
    const sourceAdapter = await gchatPlatform.createAdapter({
      ...f.source.config, credentials: { client_email: "test-bot@example.test", private_key: "test-inbound-only-key" },
    }, { webhookUrl: "https://gateway.test/lobu/api/v1/webhooks/test-google-source", onWebhookAccepted: (request) => acceptGoogleChatWebhook(f.source, request, f.deps) });
    // Replace only the external Google trust service; exercise the SDK's real
    // audience/signer checks, event parser, dispatch gate and reply serializer.
    sourceAdapter.verifyProjectNumberToken = async () => false;
    sourceAdapter.oauth2Client.verifyIdToken = async () => ({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "https://gateway.test/lobu/api/v1/webhooks/test-google-source",
      email: "service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com", email_verified: true,
    }) });
    sourceAdapter.chatApi.spaces.messages.create = async (args: any) => {
      posted.push({ space: args.parent, text: args.requestBody.text });
      return { data: { name: `${args.parent}/messages/test-reply`, text: args.requestBody.text } };
    };
    const chat = new Chat({ userName: "lobu", adapters: { gchat: sourceAdapter }, state: new InMemoryStateAdapter() });
    const subscriptions = new AutomationSubscriptionService();
    chat.onDirectMessage(async () => { received.push("unclaimed"); });
    const deliver = async (id: string) => {
      const tasks: Promise<unknown>[] = [];
      const user = { name: "users/123456", displayName: "Test installer", type: "HUMAN" };
      const space = { name: f.space, type: "DM", spaceType: "DIRECT_MESSAGE" };
      const response = await chat.webhooks.gchat(new Request("https://gateway.test/lobu/api/v1/webhooks/test-google-source", {
        method: "POST", headers: { authorization: "Bearer test-provider-jwt" }, body: JSON.stringify({
          type: "MESSAGE", space, user, message: { name: `${f.space}/messages/${id}`, sender: user, space, text: "hello", createTime: "2026-01-01T00:00:00Z" },
        }),
      }), { waitUntil: (task) => tasks.push(task) });
      await Promise.all(tasks);
      return response;
    };
    expect((await (await deliver("before-claim")).json()).text).toContain("/connector/gchat/connection?ref=");
    expect(received).toEqual([]);
    const result = await claimPendingConnection(f.provider, f.engine, f.input);
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    const installedId = result.bindingId;
    const agent = await createTestAgent({ organizationId: f.target.id, agentId: "test-pilot", ownerUserId: f.user.id });
    const [row] = await f.sql`SELECT id FROM connections WHERE slug = ${runtimeConnectionIdToSlug(installedId)}`;
    await subscriptions.createChatAutomation(agent.agentId, "gchat", `gchat:${f.space}`, undefined, { organizationId: f.target.id, configuredBy: f.user.id, connectionId: Number(row.id) });
    // Subsequent delivery uses the claimed installation's provider hook; the
    // raw Google transport remains the same source-owned external API client.
    const installed = (await f.connections.getConnection(installedId))!;
    const claimedAdapter = await gchatPlatform.createAdapter({ ...f.source.config, credentials: { client_email: "test-bot@example.test", private_key: "test-inbound-only-key" } }, {
      webhookUrl: "https://gateway.test/lobu/api/v1/webhooks/test-google-source", onWebhookAccepted: (request) => acceptGoogleChatWebhook(installed, request, f.deps),
    });
    claimedAdapter.verifyProjectNumberToken = sourceAdapter.verifyProjectNumberToken;
    claimedAdapter.oauth2Client.verifyIdToken = sourceAdapter.oauth2Client.verifyIdToken;
    claimedAdapter.chatApi.spaces.messages.create = sourceAdapter.chatApi.spaces.messages.create;
    const claimed = new Chat({ userName: "lobu", adapters: { gchat: claimedAdapter }, state: new InMemoryStateAdapter() });
    claimed.onDirectMessage(async (thread) => {
      const resolved = await resolveAgentId({ platform: "gchat", connectionId: installedId, channelId: `gchat:${f.space}`, organizationId: f.target.id, automationSubscriptionService: subscriptions });
      if (!resolved) throw new Error("Missing Automation");
      received.push(`${resolved.organizationId}:${resolved.agentId}`);
      await thread.post(`Reply from ${resolved.agentId}`);
    });
    // Deliver again through the SDK using the installation selected by the
    // production webhook router, with the persisted Automation resolving it.
    expect(await routeGoogleChatWebhook(f.source, new Request("https://gateway.test", { method: "POST", body: JSON.stringify({ space: { name: f.space } }) }), f.deps)).toBe(installedId);
    const tasks: Promise<unknown>[] = [];
    const response = await claimed.webhooks.gchat(new Request("https://gateway.test/lobu/api/v1/webhooks/test-google-source", {
      method: "POST", headers: { authorization: "Bearer test-provider-jwt" }, body: JSON.stringify({ type: "MESSAGE", space: { name: f.space, type: "DM" }, user: { name: "users/123456" }, message: { name: `${f.space}/messages/after-claim`, sender: { name: "users/123456", type: "HUMAN" }, text: "hello", createTime: "2026-01-01T00:00:01Z" } }),
    }), { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks);
    expect(response.status).toBe(200);
    expect(received).toEqual([`${f.target.id}:test-pilot`]);
    expect(posted).toEqual([{ space: f.space, text: "Reply from test-pilot" }]);
  });
  it("claims only the explicitly selected org and prefills its normal Automation", async () => {
    const f = await fixture();
    expect(await claimPendingConnection(f.provider, f.engine, { userId: f.user.id, ref: f.ref })).toEqual({ status: "invalid_request" });
    const context = await resolveClaimContext(f.provider, f.engine, f.input);
    expect(context.status).toBe("ready");
    const result = await claimPendingConnection(f.provider, f.engine, f.input);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    const connection = await f.connections.getConnection(result.bindingId);
    expect(connection?.organizationId).toBe(f.target.id);
    expect(connection?.config.credentials).toBeUndefined();
    const next = new URL(result.nextUrl!, "https://gateway.test");
    expect(next.pathname).toBe(`/${f.target.slug}/automations/new`);
    expect(next.searchParams.get("connection")).toBe(runtimeConnectionIdToSlug(result.bindingId));
    expect(next.searchParams.get("listen")).toBe(`gchat:${f.space}`);
    expect((await f.connections.getConnection(f.source.id))?.organizationId).toBe(f.owner.id);
    expect(await resolveClaimContext(f.provider, f.engine, f.input)).toMatchObject({ status: "already_connected", nextUrl: result.nextUrl });
  });

  it("concurrent pending and repeated claims converge across database sessions", async () => {
    const f = await fixture();
    const refs = await Promise.all([1, 2, 3].map(() => parkGoogleChatSpace(f.source, f.space, "users/123456", "Test team space", true)));
    expect(refs).toEqual([f.ref, f.ref, f.ref]);
    const results = await Promise.all([1, 2, 3].map(() => claimPendingConnection(f.provider, f.engine, f.input)));
    expect(results.every((result) => result.status === "ok")).toBe(true);
    const installs = await f.store.listByProviderAndOrg("gchat", f.target.id);
    expect(installs.filter((install) => install.status === "active")).toHaveLength(1);
  });

  it("uses Google login for unauthenticated setup and demands the verified installer identity", async () => {
    const f = await fixture();
    expect(await resolveClaimContext(f.provider, f.engine, { userId: null, ref: f.ref })).toEqual({ status: "unauthenticated", signinProvider: "google" });
    const wrong = await createTestUser();
    await addUserToOrganization(wrong.id, f.owner.id, "owner");
    expect(await resolveClaimContext(f.provider, f.engine, { userId: wrong.id, ref: f.ref })).toEqual({ status: "signin_required", signinProvider: "google" });
    await f.sql`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('test-wrong-google', '999999', 'google', ${wrong.id}, now(), now())`;
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, userId: wrong.id })).toEqual({ status: "signin_required", signinProvider: "google" });
  });

  it("does not let a verified Google participant claim a private source they do not administer", async () => {
    const f = await fixture();
    await f.sql`UPDATE member SET role = 'member' WHERE "userId" = ${f.user.id} AND "organizationId" = ${f.owner.id}`;
    expect(await resolveClaimContext(f.provider, f.engine, f.input)).toEqual({ status: "not_authorized", code: "not_admin" });
  });

  it("explicit hosted access still requires a verified app addition, and upgrades a prior message ref", async () => {
    const f = await fixture();
    const source = { ...f.source, settings: { ...f.source.settings, previewMode: true } };
    await f.sql.begin((tx) => upsertChatConnectionProjection(tx, (value) => f.sql.json(value as any), source, f.owner.id, "byo"));
    await f.sql`UPDATE member SET role = 'member' WHERE "userId" = ${f.user.id} AND "organizationId" = ${f.owner.id}`;
    const ref = await parkGoogleChatSpace(source, "spaces/test-hosted-space", "users/123456", "Test hosted space", false);
    expect(await resolveClaimContext(f.provider, f.engine, { ...f.input, ref })).toEqual({ status: "not_authorized", code: "not_admin" });
    expect(await parkGoogleChatSpace(source, "spaces/test-hosted-space", "users/123456", "Test hosted space", true)).toBe(ref);
    expect(await resolveClaimContext(f.provider, f.engine, { ...f.input, ref })).toMatchObject({ status: "ready" });
  });

  it("rejects forged, expired, removed and foreign-org setup", async () => {
    const f = await fixture();
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, ref: "gchatclaim-00000000-0000-0000-0000-000000000000" })).toEqual({ status: "no_pending" });
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, organizationId: "test-foreign-org" })).toEqual({ status: "not_member_of_org" });
    await f.sql`UPDATE app_installations SET updated_at = now() - interval '25 hours' WHERE metadata->>'external_id' = ${f.ref}`;
    expect(await resolveClaimContext(f.provider, f.engine, f.input)).toEqual({ status: "no_pending" });
    const ref = await parkGoogleChatSpace(f.source, f.space, "users/123456", "Test team space", true);
    await acceptGoogleChatWebhook(f.source, new Request("https://gateway.test", { method: "POST", body: JSON.stringify({ type: "REMOVED_FROM_SPACE", space: { name: f.space } }) }), f.deps);
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, ref })).toEqual({ status: "no_pending" });
  });

  it("fences a move, then moves deliberately and revokes the old projection", async () => {
    const f = await fixture();
    const first = await claimPendingConnection(f.provider, f.engine, f.input);
    if (first.status !== "ok") throw new Error(JSON.stringify(first));
    const ref = await parkGoogleChatSpace(f.source, f.space, "users/123456", "Test team space", true);
    const move = { ...f.input, ref, organizationId: f.third.slug };
    expect(await claimPendingConnection(f.provider, f.engine, move)).toMatchObject({ status: "already_connected_elsewhere", existing: { orgSlug: f.target.slug } });
    expect(await claimPendingConnection(f.provider, f.engine, { ...move, confirmMove: true })).toMatchObject({ status: "ok", orgSlug: f.third.slug });
    expect((await f.connections.getConnection(first.bindingId))?.status).toBe("stopped");
  });

  it("an installed app removal invalidates every outstanding setup reference", async () => {
    const f = await fixture();
    const first = await claimPendingConnection(f.provider, f.engine, f.input);
    if (first.status !== "ok") throw new Error(JSON.stringify(first));
    const ref = await parkGoogleChatSpace(f.source, f.space, "users/123456", "Test team space", true);
    const installed = (await f.connections.getConnection(first.bindingId))!;
    await acceptGoogleChatWebhook(installed, new Request("https://gateway.test", { method: "POST", body: JSON.stringify({ type: "REMOVED_FROM_SPACE", space: { name: f.space } }) }), f.deps);
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, ref })).toEqual({ status: "no_pending" });
    expect(await resolveClaimContext(f.provider, f.engine, f.input)).toEqual({ status: "no_pending" });
  });

  it("returns a provider-specific setup response for verified existing unbound spaces", async () => {
    const f = await fixture();
    const body = { type: "MESSAGE", space: { name: "spaces/test-other-space", displayName: "Other test space" }, user: { name: "users/123456" } };
    const request = () => new Request("https://gateway.test", { method: "POST", body: JSON.stringify(body) });
    const response = await acceptGoogleChatWebhook(f.source, request(), f.deps);
    expect(response?.status).toBe(200);
    expect((await response!.json()).text).toContain("/connector/gchat/connection?ref=gchatclaim-");
    expect(await routeGoogleChatWebhook(f.source, request(), f.deps)).toBeUndefined();
    const [row] = await f.sql`SELECT metadata FROM app_installations WHERE external_tenant_id = ${body.space.name}`;
    expect(row.metadata.installer_id).toBe("users/123456");
    expect(row.metadata.verified_added).toBe(false);
  });
});
