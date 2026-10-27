import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { acceptGoogleChatWebhook, googleChatInstallationId, googleChatTransportApp, parkGoogleChatSpace, resetHostedGoogleChatAppForTests, resolveGoogleChatRuntime, routeGoogleChatWebhook } from "../../../gateway/connections/platforms/gchat-installation.js";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { ConnectorWebhookSchema } from "@lobu/connector-sdk";
import GoogleChatConnector from "@lobu/connectors/gchat";
import { createAppWebhookRoutes, createChatWebhookDelivery, createDeclaredAppWebhookProvider } from "../../../gateway/routes/public/app-webhooks.js";
import { appWebhookUrl } from "../../../gateway/routes/public/app-webhook-url.js";
import { cleanupTestDatabase } from "../../setup/test-db.js";
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser } from "../../setup/test-fixtures.js";

beforeEach(async () => { resetHostedGoogleChatAppForTests(); await cleanupTestDatabase(); });

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
  const ref = await parkGoogleChatSpace(googleChatTransportApp(source), space, "users/123456", "Test team space", true);
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
    const refs = await Promise.all([1, 2, 3].map(() => parkGoogleChatSpace(googleChatTransportApp(f.source), f.space, "users/123456", "Test team space", true)));
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
    const ref = await parkGoogleChatSpace(googleChatTransportApp(source), "spaces/test-hosted-space", "users/123456", "Test hosted space", false);
    expect(await resolveClaimContext(f.provider, f.engine, { ...f.input, ref })).toEqual({ status: "not_authorized", code: "not_admin" });
    expect(await parkGoogleChatSpace(googleChatTransportApp(source), "spaces/test-hosted-space", "users/123456", "Test hosted space", true)).toBe(ref);
    expect(await resolveClaimContext(f.provider, f.engine, { ...f.input, ref })).toMatchObject({ status: "ready" });
  });

  it("rejects forged, removed and foreign-org setup", async () => {
    const f = await fixture();
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, ref: "gchatclaim-00000000-0000-0000-0000-000000000000" })).toEqual({ status: "no_pending" });
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, organizationId: "test-foreign-org" })).toEqual({ status: "not_member_of_org" });
    const ref = await parkGoogleChatSpace(googleChatTransportApp(f.source), f.space, "users/123456", "Test team space", true);
    await acceptGoogleChatWebhook(f.source, new Request("https://gateway.test", { method: "POST", body: JSON.stringify({ type: "REMOVED_FROM_SPACE", space: { name: f.space } }) }), f.deps);
    expect(await claimPendingConnection(f.provider, f.engine, { ...f.input, ref })).toEqual({ status: "no_pending" });
  });

  it("fences a move, then moves deliberately and revokes the old projection", async () => {
    const f = await fixture();
    const first = await claimPendingConnection(f.provider, f.engine, f.input);
    if (first.status !== "ok") throw new Error(JSON.stringify(first));
    const ref = await parkGoogleChatSpace(googleChatTransportApp(f.source), f.space, "users/123456", "Test team space", true);
    const move = { ...f.input, ref, organizationId: f.third.slug };
    expect(await claimPendingConnection(f.provider, f.engine, move)).toMatchObject({ status: "already_connected_elsewhere", existing: { orgSlug: f.target.slug } });
    expect(await claimPendingConnection(f.provider, f.engine, { ...move, confirmMove: true })).toMatchObject({ status: "ok", orgSlug: f.third.slug });
    expect((await f.connections.getConnection(first.bindingId))?.status).toBe("stopped");
  });

  it("an installed app removal invalidates every outstanding setup reference", async () => {
    const f = await fixture();
    const first = await claimPendingConnection(f.provider, f.engine, f.input);
    if (first.status !== "ok") throw new Error(JSON.stringify(first));
    const ref = await parkGoogleChatSpace(googleChatTransportApp(f.source), f.space, "users/123456", "Test team space", true);
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

// The hosted Lobu app is configured through the env names `@chat-adapter/gchat`
// already reads. Synthetic project and key; the legacy source models the
// transition where the hosted project still has a BYO row in some other org.
const PLATFORM_PROJECT = "987654321";
const PLATFORM_KEY = "test-platform-key";

function configurePlatform(project: string | null = PLATFORM_PROJECT): void {
  vi.stubEnv("GOOGLE_CHAT_PROJECT_NUMBER", project ?? undefined);
  vi.stubEnv("GOOGLE_CHAT_CREDENTIALS", project
    ? JSON.stringify({ client_email: "platform-bot@example.test", private_key: PLATFORM_KEY })
    : undefined);
  resetHostedGoogleChatAppForTests();
}

async function platformFixture(sourceProject = PLATFORM_PROJECT) {
  const pilot = await createTestOrganization({ slug: "test-pilot-org" });
  const own = await createTestOrganization({ slug: "test-outsider-org" });
  const pilotOwner = await createTestUser();
  await addUserToOrganization(pilotOwner.id, pilot.id, "owner");
  const outsider = await createTestUser();
  await addUserToOrganization(outsider.id, own.id, "owner");
  const sql = getDb();
  await sql`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
    VALUES ('test-outsider-google', '123456', 'google', ${outsider.id}, now(), now())`;
  const source: StoredConnection = {
    id: "test-legacy-google-source", organizationId: pilot.id, platform: "gchat", status: "active", agentId: "test-pilot-agent",
    config: { platform: "gchat", googleChatProjectNumber: sourceProject },
    settings: { allowGroups: true }, metadata: {}, createdAt: 1, updatedAt: 1,
  };
  await sql.begin((tx) => upsertChatConnectionProjection(tx, (value) => sql.json(value as any), source, pilot.id, "byo"));
  const store = createPostgresAppInstallationStore();
  const connections = createPostgresAgentConnectionStore();
  const provider = googleChatClaimProvider({ store, getConnection: (id) => connections.getConnection(id) });
  const engine: ClaimEngineDeps = {
    resolveMemberOrgs: async (uid) => {
      const rows = await sql`SELECT o.id, o.slug, o.name FROM organization o JOIN member m ON m."organizationId" = o.id WHERE m."userId" = ${uid}`;
      return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, isPersonal: false }));
    },
    resolveOrgIfMember: async (uid, org) => {
      const [row] = await sql`SELECT o.id FROM organization o JOIN member m ON m."organizationId" = o.id AND m."userId" = ${uid} WHERE o.slug = ${org}`;
      return row?.id ?? null;
    },
    resolveOrgSlug: async (org) => { const [row] = await sql`SELECT slug FROM organization WHERE id = ${org}`; return row?.slug ?? null; },
  };
  const deps = { publicGatewayUrl: "https://gateway.test/lobu", getConnection: (id: string) => connections.getConnection(id), getAppInstallationStore: () => store, getSecretStore: () => { throw new Error("The hosted app never reads a tenant vault"); }, resolveSecrets: async (connection: StoredConnection) => connection.config };
  const space = "spaces/test-outsider-space";
  const delivery = (body: Record<string, unknown>) => new Request("https://gateway.test", { method: "POST", body: JSON.stringify(body) });
  const added = (spaceName = space, user = "users/123456") => delivery({ type: "ADDED_TO_SPACE", space: { name: spaceName, type: "ROOM", displayName: "Outsider space" }, user: { name: user } });
  const message = (spaceName: string, sender: string, direct = false) => {
    const spaceData = direct ? { name: spaceName, type: "DM", spaceType: "DIRECT_MESSAGE" } : { name: spaceName, type: "ROOM", spaceType: "SPACE", displayName: "Outsider space" };
    return delivery({ type: "MESSAGE", space: spaceData, user: { name: sender }, message: { name: `${spaceName}/messages/test`, sender: { name: sender }, space: spaceData, text: "hello" } });
  };
  const refFrom = async (response: Response | void) => {
    if (!response) throw new Error("Expected a setup reply");
    const text = (await response.json()).text as string;
    const ref = new URL(text.match(/https:\/\/\S+/)![0]).searchParams.get("ref");
    if (!ref) throw new Error(text);
    return ref;
  };
  return { sql, pilot, own, pilotOwner, outsider, source, store, connections, provider, engine, deps, space, delivery, added, message, refFrom };
}

describe("hosted Google Chat app claimed by an outside user", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the verified installer claims into their own org without belonging to the legacy source's org", async () => {
    configurePlatform();
    const f = await platformFixture();
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(), f.deps));
    const input = { userId: f.outsider.id, ref, organizationId: f.own.slug };
    expect(await resolveClaimContext(f.provider, f.engine, input)).toMatchObject({ status: "ready" });
    const result = await claimPendingConnection(f.provider, f.engine, input);
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.bindingId).toBe(googleChatInstallationId(f.own.id, PLATFORM_PROJECT, f.space));
    const [row] = await f.sql`SELECT organization_id, created_by FROM connections WHERE slug = ${runtimeConnectionIdToSlug(result.bindingId)}`;
    expect(row).toMatchObject({ organization_id: f.own.id, created_by: f.outsider.id });
    const [install] = await f.sql`SELECT metadata FROM app_installations WHERE provider = 'gchat' AND status = 'active' AND external_tenant_id = ${f.space}`;
    expect(install.metadata.source_connection_id).toBeUndefined();
    expect(install.metadata.source_organization_id).toBeUndefined();
    // Platform runtime: hosted credentials, never the legacy source's vault.
    const runtime = await resolveGoogleChatRuntime((await f.connections.getConnection(result.bindingId))!, f.deps);
    expect((runtime!.config as any).credentials).toContain(PLATFORM_KEY);
    expect((runtime!.config as any).googleChatProjectNumber).toBe(PLATFORM_PROJECT);
    // A claimed hosted space routes to its own projection.
    expect(await routeGoogleChatWebhook(f.source, f.message(f.space, "users/123456"), f.deps)).toBe(result.bindingId);
    expect(await resolveClaimContext(f.provider, f.engine, input)).toMatchObject({ status: "already_connected", orgSlug: f.own.slug });
  });

  it("a bring-your-own project keeps requiring source-org admin authority", async () => {
    configurePlatform();
    const f = await platformFixture("123456789");
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(), f.deps));
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref, organizationId: f.own.slug }))
      .toEqual({ status: "not_authorized", code: "not_admin" });
  });

  it("with the hosted app unconfigured the same project is an ordinary bring-your-own source", async () => {
    configurePlatform(null);
    const f = await platformFixture();
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(), f.deps));
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref, organizationId: f.own.slug }))
      .toEqual({ status: "not_authorized", code: "not_admin" });
    // Unclaimed spaces of a BYO bot with an agent keep dispatching to it.
    expect(await acceptGoogleChatWebhook(f.source, f.message("spaces/test-other-space", "users/123456", true), f.deps)).toBeUndefined();
  });

  it("demands the installer's own Google identity", async () => {
    configurePlatform();
    const f = await platformFixture();
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(f.space, "users/777777"), f.deps));
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref, organizationId: f.own.slug }))
      .toEqual({ status: "signin_required", signinProvider: "google" });
  });

  it("a named-space message is not installation proof unless an earlier addition covers it", async () => {
    configurePlatform();
    const f = await platformFixture();
    const unverified = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.message(f.space, "users/123456"), f.deps));
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref: unverified, organizationId: f.own.slug }))
      .toMatchObject({ status: "not_authorized" });
    const covered = "spaces/test-covered-space";
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(covered), f.deps));
    // Another member's message inherits the installer of the verified addition.
    expect(await f.refFrom(await acceptGoogleChatWebhook(f.source, f.message(covered, "users/555555"), f.deps))).toBe(ref);
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref, organizationId: f.own.slug }))
      .toMatchObject({ status: "ready" });
  });

  it("a direct message to the bot is verified: its sender is the installer", async () => {
    configurePlatform();
    const f = await platformFixture();
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.message("spaces/test-direct-space", "users/123456", true), f.deps));
    expect(await resolveClaimContext(f.provider, f.engine, { userId: f.outsider.id, ref, organizationId: f.own.slug }))
      .toMatchObject({ status: "ready" });
  });

  it("a removed space has no pending setup, while an old reference never expires", async () => {
    configurePlatform();
    const f = await platformFixture();
    const ref = await f.refFrom(await acceptGoogleChatWebhook(f.source, f.added(), f.deps));
    await f.sql`UPDATE app_installations SET updated_at = now() - interval '30 days' WHERE metadata->>'external_id' = ${ref}`;
    const input = { userId: f.outsider.id, ref, organizationId: f.own.slug };
    expect(await resolveClaimContext(f.provider, f.engine, input)).toMatchObject({ status: "ready" });
    await acceptGoogleChatWebhook(f.source, f.delivery({ type: "REMOVED_FROM_SPACE", space: { name: f.space } }), f.deps);
    expect(await resolveClaimContext(f.provider, f.engine, input)).toEqual({ status: "no_pending" });
  });

  it("an unclaimed hosted space always answers with the claim link and dispatches to no agent", async () => {
    configurePlatform();
    const f = await platformFixture();
    const received: string[] = [];
    const adapter = await gchatPlatform.createAdapter({
      ...f.source.config, credentials: { client_email: "platform-bot@example.test", private_key: PLATFORM_KEY },
    }, { webhookUrl: "https://gateway.test/lobu/api/v1/webhooks/test-legacy-google-source", onWebhookAccepted: (request) => acceptGoogleChatWebhook(f.source, request, f.deps) });
    adapter.verifyProjectNumberToken = async () => false;
    adapter.oauth2Client.verifyIdToken = async () => ({ getPayload: () => ({
      iss: "https://accounts.google.com", aud: "https://gateway.test/lobu/api/v1/webhooks/test-legacy-google-source",
      email: `service-${PLATFORM_PROJECT}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, email_verified: true,
    }) });
    const chat = new Chat({ userName: "lobu", adapters: { gchat: adapter }, state: new InMemoryStateAdapter() });
    chat.onDirectMessage(async () => { received.push("dispatched"); });
    chat.onNewMention(async () => { received.push("dispatched"); });
    const tasks: Promise<unknown>[] = [];
    const user = { name: "users/123456", displayName: "Test outsider", type: "HUMAN" };
    const space = { name: f.space, type: "DM", spaceType: "DIRECT_MESSAGE" };
    const response = await chat.webhooks.gchat(new Request("https://gateway.test/lobu/api/v1/webhooks/test-legacy-google-source", {
      method: "POST", headers: { authorization: "Bearer test-provider-jwt" }, body: JSON.stringify({
        type: "MESSAGE", space, user, message: { name: `${f.space}/messages/test`, sender: user, space, text: "hello", createTime: "2026-01-01T00:00:00Z" },
      }),
    }), { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks);
    expect((await response.json()).text).toContain("/connector/gchat/connection?ref=gchatclaim-");
    expect(received).toEqual([]);
  });
});

// The connector's DECLARED webhook, read off the real definition so the generic
// engine is driven exactly as the bundled declaration drives it.
const GCHAT_WEBHOOK_SCHEMA = new GoogleChatConnector().definition.webhook as ConnectorWebhookSchema;

let googleKeys: Promise<Awaited<ReturnType<typeof generateKeyPair>>[]> | undefined;

describe("hosted Google Chat app through the declared app-webhook engine", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  async function hostedRoute(options: { realInstallation?: boolean } = {}) {
    configurePlatform();
    const f = await platformFixture();
    // Stand in for Google's published key sets; jose fetches them by URL. One
    // key pair per file: the verifier caches key sets across deliveries.
    googleKeys ??= Promise.all([generateKeyPair("RS256"), generateKeyPair("RS256")]);
    const [google, forger] = await googleKeys;
    const jwk = { ...await exportJWK(google.publicKey), kid: "test-google-kid", alg: "RS256", use: "sig" };
    // The same key as the Chat SDK's PEM cert map (kid → certificate).
    const pemCerts = { "test-google-kid": await exportSPKI(google.publicKey) };
    vi.stubGlobal("fetch", async (url: string | URL) => String(url).includes("/service_accounts/v1/metadata/x509/")
      ? Response.json(pemCerts)
      : Response.json({ keys: [jwk] }));
    const endpoint = appWebhookUrl(f.deps.publicGatewayUrl, "gchat");
    const sign = (claims: Record<string, unknown>, options: { issuer: string; audience: string }, key = google.privateKey) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-google-kid" })
        .setIssuer(options.issuer).setAudience(options.audience).setIssuedAt().setExpirationTime("5m").sign(key);
    const projectToken = (audience = PLATFORM_PROJECT, key = google.privateKey) =>
      sign({}, { issuer: "chat@system.gserviceaccount.com", audience }, key);
    const endpointToken = (email = `service-${PLATFORM_PROJECT}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, audience = endpoint) =>
      sign({ email, email_verified: true }, { issuer: "https://accounts.google.com", audience });
    const manager = new ChatInstanceManager() as any;
    manager.connectionStore = f.connections;
    manager.publicGatewayUrl = f.deps.publicGatewayUrl;
    manager.services = {
      getConnectionStore: () => f.connections, getAppInstallationStore: () => f.store,
      getSecretStore: () => { throw new Error("The hosted app never reads a tenant vault"); },
      getCommandRegistry: () => ({ getAll: () => [] }),
      getAutomationSubscriptionService: () => new AutomationSubscriptionService(),
      getArtifactStore: () => ({}), getPublicGatewayUrl: () => manager.publicGatewayUrl,
      getMcpProxy: () => null, getInteractionService: () => new EventEmitter(), getGrantStore: () => ({}),
    };
    manager.createStateAdapter = async () => new InMemoryStateAdapter();
    const delivered: string[] = [];
    if (!options.realInstallation) {
      manager.handleWebhook = async (id: string) => { delivered.push(id); return new Response("delivered by installation"); };
    }
    const router = createAppWebhookRoutes({
      installationStore: f.store,
      providers: [createDeclaredAppWebhookProvider({
        provider: "gchat", appId: PLATFORM_PROJECT, webhookSchema: GCHAT_WEBHOOK_SCHEMA, endpointUrl: endpoint,
        handleDelivery: createChatWebhookDelivery({ handleChatAppWebhook: (request) => manager.handleChatAppWebhook("gchat", request) }),
      })],
      resolveAppWebhookSecret: async () => { throw new Error("A Google-signed delivery needs no shared secret"); },
    });
    // The router is mounted under the gateway base path in production.
    const post = (body: Record<string, unknown>, token?: string) => router.request("/api/v1/app-webhooks/gchat", {
      method: "POST", headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const addedBody = { type: "ADDED_TO_SPACE", space: { name: f.space, type: "ROOM", displayName: "Outsider space" }, user: { name: "users/123456" } };
    const claim = async () => {
      const setup = await post(addedBody, await projectToken());
      const input = { userId: f.outsider.id, ref: await f.refFrom(setup), organizationId: f.own.slug };
      const claimed = await claimPendingConnection(f.provider, f.engine, input);
      if (claimed.status !== "ok") throw new Error(JSON.stringify(claimed));
      return claimed.bindingId;
    };
    return { f, post, addedBody, projectToken, endpointToken, delivered, forger, manager, pemCerts, claim, sign };
  }

  it("rejects missing, forged, wrong-audience and foreign add-on tokens with 401", async () => {
    const r = await hostedRoute();
    expect((await r.post(r.addedBody)).status).toBe(401);
    expect((await r.post(r.addedBody, await r.projectToken(PLATFORM_PROJECT, r.forger.privateKey))).status).toBe(401);
    expect((await r.post(r.addedBody, await r.projectToken("111111111"))).status).toBe(401);
    expect((await r.post(r.addedBody, await r.endpointToken(undefined, "https://gateway.test/lobu/api/v1/webhooks/test-other"))).status).toBe(401);
    expect((await r.post(r.addedBody, await r.endpointToken("service-222222222@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"))).status).toBe(401);
    expect(r.delivered).toEqual([]);
    expect(await r.f.sql`SELECT id FROM app_installations WHERE provider = 'gchat'`).toHaveLength(0);
  });

  it("answers an unclaimed space with the claim link, then routes the claimed space to its installation", async () => {
    const r = await hostedRoute();
    const setup = await r.post(r.addedBody, await r.projectToken());
    expect(setup.status).toBe(200);
    const ref = await r.f.refFrom(setup);
    // An unclaimed DM never dispatches either: same link, no installation.
    const direct = { name: "spaces/test-direct-space", type: "DM", spaceType: "DIRECT_MESSAGE" };
    const dm = await r.post({ type: "MESSAGE", space: direct, user: { name: "users/123456" }, message: { name: `${direct.name}/messages/test`, sender: { name: "users/123456" }, space: direct, text: "hello" } }, await r.endpointToken());
    expect((await dm.clone().json()).text).toContain("/connector/gchat/connection?ref=gchatclaim-");
    expect(r.delivered).toEqual([]);
    const input = { userId: r.f.outsider.id, ref, organizationId: r.f.own.slug };
    expect(await resolveClaimContext(r.f.provider, r.f.engine, input)).toMatchObject({ status: "ready" });
    const claimed = await claimPendingConnection(r.f.provider, r.f.engine, input);
    if (claimed.status !== "ok") throw new Error(JSON.stringify(claimed));
    const message = await r.post({ type: "MESSAGE", space: { name: r.f.space, type: "ROOM" }, user: { name: "users/555555" }, message: { name: `${r.f.space}/messages/after-claim`, sender: { name: "users/555555" }, text: "hello" } }, await r.endpointToken());
    expect(await message.text()).toBe("delivered by installation");
    expect(r.delivered).toEqual([googleChatInstallationId(r.f.own.id, PLATFORM_PROJECT, r.f.space)]);
  });

  it("a claimed space is verified again by its real installation adapter", async () => {
    const r = await hostedRoute({ realInstallation: true });
    const installation = await r.claim();
    // google-auth-library downloads Google's OIDC certs through its own HTTP
    // client, not the global fetch, and the installation's adapter is private
    // to its space-scope wrapper: stand in for that download on the class.
    // Its signature, audience, issuer and signer checks run for real.
    const probe = await gchatPlatform.createAdapter({
      platform: "gchat", googleChatProjectNumber: PLATFORM_PROJECT,
      credentials: { client_email: "platform-bot@example.test", private_key: PLATFORM_KEY },
    }, {});
    const oidcCerts = vi.spyOn(Object.getPrototypeOf(probe.oauth2Client), "getFederatedSignonCertsAsync")
      .mockResolvedValue({ certs: r.pemCerts, format: "PEM" } as never);
    // The space is set up: an Automation listens, so an accepted message dispatches.
    const agent = await createTestAgent({ organizationId: r.f.own.id, agentId: "test-outsider-agent", ownerUserId: r.f.outsider.id });
    const [row] = await r.f.sql`SELECT id FROM connections WHERE slug = ${runtimeConnectionIdToSlug(installation)}`;
    await new AutomationSubscriptionService().createChatAutomation(agent.agentId, "gchat", `gchat:${r.f.space}`, undefined, { organizationId: r.f.own.id, configuredBy: r.f.outsider.id, connectionId: Number(row.id) });
    try {
      expect(await r.manager.warmConnection(installation)).toBe(true);
      const processed: string[] = [];
      r.manager.getInstance(installation).chat.processMessage = (_adapter: unknown, threadId: string) => { processed.push(threadId); };
      // The Workspace Add-on envelope the hosted app receives.
      const space = { name: r.f.space, type: "ROOM", spaceType: "SPACE" };
      const message = (id: string) => ({ chat: {
        user: { name: "users/555555", type: "HUMAN" }, eventTime: "2026-01-01T00:00:00Z",
        messagePayload: { space, message: { name: `${r.f.space}/messages/${id}`, sender: { name: "users/555555", type: "HUMAN" }, space, text: "@lobu hello", createTime: "2026-01-01T00:00:00Z" } },
      } });
      // Both token audiences the engine accepts also pass the installation's
      // own verifier: the project number, and the app-webhook endpoint URL.
      expect((await r.post(message("project-token"), await r.projectToken())).status).toBe(200);
      expect((await r.post(message("endpoint-token"), await r.endpointToken())).status).toBe(200);
      expect(processed).toHaveLength(2);
      // The installation does not trust its caller: a direct delivery with a
      // forged token, or one minted for another endpoint, is refused.
      const direct = async (token: string) => (await r.manager.handleWebhook(installation, new Request(appWebhookUrl(r.f.deps.publicGatewayUrl, "gchat"), {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(message("direct")),
      }))).status;
      expect(await direct(await r.projectToken(PLATFORM_PROJECT, r.forger.privateKey))).toBe(401);
      expect(await direct(await r.endpointToken(undefined, `${r.f.deps.publicGatewayUrl}/api/v1/webhooks/${installation}`))).toBe(401);
      expect(processed).toHaveLength(2);
    } finally {
      oidcCerts.mockRestore();
      await r.manager.shutdown();
    }
  });

  it("logs an unreachable Google key set differently from a rejected token", async () => {
    const r = await hostedRoute();
    const warn = vi.spyOn(console, "warn");
    try {
      const forged = await r.projectToken(PLATFORM_PROJECT, r.forger.privateKey);
      expect((await r.post(r.addedBody, forged)).status).toBe(401);
      // A declared signer whose key set has not been fetched yet, while Google
      // is down: first an HTTP error, then a network failure.
      const addOn = `service-${PLATFORM_PROJECT}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
      const token = await r.sign({}, { issuer: addOn, audience: PLATFORM_PROJECT });
      vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
      expect((await r.post(r.addedBody, token)).status).toBe(401);
      vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
      expect((await r.post(r.addedBody, token)).status).toBe(401);
      const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("Google"));
      expect(logged).toHaveLength(3);
      expect(logged[0]).toContain('"reason":"token_rejected"');
      expect(logged[0]).toContain('"code":"ERR_JWS_SIGNATURE_VERIFICATION_FAILED"');
      expect(logged[1]).toContain('"reason":"key_set_unavailable"');
      expect(logged[1]).toContain('"code":"ERR_JOSE_GENERIC"');
      expect(logged[2]).toContain('"reason":"key_set_unavailable"');
      expect(logged[2]).toContain('"code":"TypeError"');
      for (const line of logged) {
        expect(line).toContain('"audience":"app_id"');
        expect(line).not.toContain(forged.split(".")[1]);
        expect(line).not.toContain(token.split(".")[1]);
      }
      expect(r.delivered).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers 404 while the hosted app is not configured", async () => {
    const r = await hostedRoute();
    configurePlatform(null);
    expect((await r.post(r.addedBody, await r.projectToken())).status).toBe(404);
  });
});
