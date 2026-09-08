/**
 * Surface B (agent chat) authorizes an ORG MEMBER, not only the agent's owner.
 *
 * Prod repro (org `umit-unal`, agent `nasdaq-tracker`): a fellow member could
 * `GET /api/<org>/agents/<id>/config` → 200 (soulMd, guardrails, tools) but got
 * `POST /lobu/api/v1/agents` → 403, because chat authorized on the per-user
 * `agent_users` ownership mapping while everything else authorized on org
 * membership. The composer rendered anyway, so every send failed.
 *
 * An agent is an org-level object, so a member may USE it. `manage` stays
 * owner/admin on the org-scoped REST routes (`lobu/agent-routes.ts`), and this
 * file pins the two halves that make member-use safe:
 *   1. membership is verified against a PROVEN org (the `x-lobu-org` workspace
 *      the request names, or the existing session's org) — never the caller's
 *      ambient default org, and the agent must exist in that org;
 *   2. a member reaches only their OWN conversation: session keys are guessable
 *      (`agentId_userId_org_thread`) and the `userId` half is caller-supplied,
 *      so without the `createdByUserId` check one member could attach to a
 *      colleague's stream, message into their thread, or clobber it.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import type { SettingsTokenPayload } from "../auth/settings/token-service.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { getDb } from "../../db/client.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { buildApiConversationId } from "../services/api-conversation-id.js";
import { createAgentApi } from "../routes/public/agent.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import type { ThreadSession } from "../session.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
  seedOrgMembership,
} from "./helpers/db-setup.js";

const AGENT_ORG = "org-agent-use-test";
// The SPA pins the ambient org to the caller's DEFAULT org, which is not where
// the agent lives — the workspace comes in as `x-lobu-org`.
const CALLER_DEFAULT_ORG = "org-caller-default-use-test";
const OUTSIDER_ORG = "org-outsider-use-test";

const AGENT_ID = "nasdaq-tracker";
const AGENT_OWNER_ID = "user-agent-owner-use";
const MEMBER_ID = "user-plain-member-use";
const ADMIN_ID = "user-org-admin-use";
const OUTSIDER_ID = "user-outsider-use";

function sessionFor(userId: string): SettingsTokenPayload {
  // Mirrors the embedded authProvider: better-auth user → external identity,
  // no oauthUserId, so the lookup key is `userId`.
  return { userId, platform: "external", exp: Date.now() + 60_000 };
}

function makeSessionManager() {
  const store = new Map<string, ThreadSession>();
  let lastStored: ThreadSession | null = null;
  return {
    mgr: {
      async getSession(key: string) {
        return store.get(key) ?? null;
      },
      async setSession(session: ThreadSession) {
        store.set(session.conversationId, session);
        lastStored = session;
      },
      async touchSession() {},
      async deleteSession(key: string) {
        store.delete(key);
      },
    } as never,
    getStored: () => lastStored,
    store,
  };
}

/**
 * One app instance per test, sharing a session store so a follow-up request can
 * resolve the row an earlier POST created. Reproduces the production ambient
 * org-context (`createLobuOrgContextMiddleware` sets it AND wraps the request
 * in `orgContext.run`).
 */
function makeApp(
  userAgentsStore: UserAgentsStore,
  agentMetadataStore: AgentMetadataStore,
  ambientOrg: string,
  sessions = makeSessionManager(),
  queueProducer = {} as never,
  agentSettingsStore?: Parameters<typeof createAgentApi>[0]["agentSettingsStore"]
) {
  const agentApi = createAgentApi({
    queueProducer,
    agentSettingsStore,
    sessionManager: sessions.mgr,
    sseManager: { hasActiveConnection: () => false } as never,
    publicGatewayUrl: "http://localhost:8787",
    artifactStore: {} as never,
    userAgentsStore,
    agentMetadataStore: agentMetadataStore as never,
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("organizationId", ambientOrg);
    return orgContext.run({ organizationId: ambientOrg }, () => next());
  });
  app.route("/", agentApi);

  return { app, sessions };
}

async function postCreate(
  app: Hono,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request("/api/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ agentId: AGENT_ID, ...body }),
  });
}

function getStatus(app: Hono, sessionKey: string): Promise<Response> {
  return app.request(`/api/v1/agents/${encodeURIComponent(sessionKey)}`, {
    method: "GET",
  });
}

function deleteSession(app: Hono, sessionKey: string): Promise<Response> {
  return app.request(`/api/v1/agents/${encodeURIComponent(sessionKey)}`, {
    method: "DELETE",
  });
}

describe("POST /api/v1/agents — org member using an agent they don't own", () => {
  let userAgentsStore: UserAgentsStore;
  let agentMetadataStore: AgentMetadataStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    const configStore = createPostgresAgentConfigStore();
    agentMetadataStore = new AgentMetadataStore(configStore);
    userAgentsStore = new UserAgentsStore();

    // The agent + its per-user owner mapping live in AGENT_ORG only.
    await orgContext.run({ organizationId: AGENT_ORG }, async () => {
      await seedAgentRow(AGENT_ID, {
        organizationId: AGENT_ORG,
        ownerPlatform: "external",
        ownerUserId: AGENT_OWNER_ID,
      });
      await userAgentsStore.addAgent("external", AGENT_OWNER_ID, AGENT_ID);
    });
    await seedAgentRow("placeholder-default", {
      organizationId: CALLER_DEFAULT_ORG,
    });
    await seedAgentRow("placeholder-outsider", {
      organizationId: OUTSIDER_ORG,
    });
    await seedAgentRow(AGENT_ID, {
      organizationId: OUTSIDER_ORG,
      ownerPlatform: "external",
      ownerUserId: OUTSIDER_ID,
    });

    // The agent's owner is deliberately a plain member: `use` follows
    // membership, `manage` follows role, and the two are independent.
    await seedOrgMembership(AGENT_ORG, AGENT_OWNER_ID, "member");
    await seedOrgMembership(AGENT_ORG, MEMBER_ID, "member");
    await seedOrgMembership(AGENT_ORG, ADMIN_ID, "admin");
    await seedOrgMembership(OUTSIDER_ORG, OUTSIDER_ID, "owner");
    await seedOrgMembership(OUTSIDER_ORG, MEMBER_ID, "member");
  }, 60_000);

  afterEach(() => {
    setAuthProvider(null);
  });

  test("a plain member naming the workspace is authorized (was 403)", async () => {
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    const res = await postCreate(
      app,
      { thread: "member-thread" },
      { "x-lobu-org": AGENT_ORG }
    );

    expect(res.status).toBe(201);
    const expectedKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: MEMBER_ID,
      organizationId: AGENT_ORG,
      threadId: "member-thread",
    });
    expect(((await res.json()) as { agentId: string }).agentId).toBe(
      expectedKey
    );
    const stored = sessions.getStored();
    // Stamped with the AGENT's org (not the caller's ambient default), and with
    // the authenticated human — the field the own-conversation check reads.
    expect(stored?.organizationId).toBe(AGENT_ORG);
    expect(stored?.createdByUserId).toBe(MEMBER_ID);
    expect(stored?.conversationId).toBe(expectedKey);
    expect(sessions.store.get(expectedKey)).toBe(stored);
  });

  for (const source of ["direct-api", "automation_run"] as const) {
    for (const configuredTools of [["/mcp/test-memory/tools/*"], []]) {
      test(`${source} forwards only the workspace agent's configured tool grants (${configuredTools.length})`, async () => {
        const enqueued: Array<Record<string, unknown>> = [];
        const reads: Array<unknown> = [];
        setAuthProvider(() => sessionFor(MEMBER_ID));
        const { app, sessions } = makeApp(
          userAgentsStore,
          agentMetadataStore,
          CALLER_DEFAULT_ORG,
          makeSessionManager(),
          {
            enqueueMessage: async (payload: Record<string, unknown>) => {
              enqueued.push(payload);
              return "tool-grants-job";
            },
          } as never,
          {
            getSettings: async (agentId: string, options: unknown) => {
              reads.push({ agentId, options });
              return { models: ["test-provider/test-model"], preApprovedTools: configuredTools };
            },
          } as never,
        );
        const created = await postCreate(app, { thread: "tool-grants" }, {
          "x-lobu-org": AGENT_ORG,
        });
        expect(created.status).toBe(201);
        const session = sessions.getStored();
        if (!session) throw new Error("Missing tool grants session");
        // Session creation separately verifies Automation intent. Exercise the
        // message route with the resulting persisted intent here.
        if (source === "automation_run") {
          session.intent = { kind: "automation_run", runId: 123, automationId: 456 };
        }
        const sent = await app.request(
          `/api/v1/agents/${encodeURIComponent(session.conversationId)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-lobu-org": AGENT_ORG },
            // A client-supplied grant is passthrough body noise: only the
            // agent's configured grants may reach the worker.
            body: JSON.stringify({
              content: "Use the configured tools",
              ephemeralContext: "Test context",
              preApprovedTools: ["*"],
            }),
          },
        );
        expect(sent.status).toBe(200);
        expect(reads).toContainEqual({ agentId: AGENT_ID, options: { organizationId: AGENT_ORG } });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]?.preApprovedTools).toEqual(configuredTools.length ? configuredTools : undefined);
        expect(enqueued[0]?.agentOptions).not.toHaveProperty("preApprovedTools");
        expect(enqueued[0]?.organizationId).toBe(AGENT_ORG);
      });
    }
  }

  test("device placement is owner-scoped, capability-checked, and retained on resume", async () => {
    const sql = getDb();
    const enqueuedMessages: Array<Record<string, unknown>> = [];
    const queueProducer = {
      enqueueMessage: async (payload: Record<string, unknown>) => {
        enqueuedMessages.push(payload);
        return "device-chat-job";
      },
    } as never;
    const [memberDevice] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
      ) VALUES (
        ${MEMBER_ID}, 'member-device-chat', 'macos', ${sql.json(["automations.execute"])},
        'Member Mac', ${AGENT_ORG}, '{pi}'::text[]
      )
      RETURNING id
    `;
    const [ownerDevice] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
      ) VALUES (
        ${AGENT_OWNER_ID}, 'owner-device-chat', 'macos', ${sql.json(["automations.execute"])},
        'Owner Mac', ${AGENT_ORG}, '{pi}'::text[]
      )
      RETURNING id
    `;
    const [otherMemberDevice] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
      ) VALUES (
        ${MEMBER_ID}, 'member-device-chat-2', 'macos', ${sql.json(["automations.execute"])},
        'Member Mac 2', ${AGENT_ORG}, '{pi}'::text[]
      )
      RETURNING id
    `;
    if (!memberDevice || !ownerDevice || !otherMemberDevice) {
      throw new Error("Failed to seed devices");
    }

    setAuthProvider(() => sessionFor(MEMBER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      makeSessionManager(),
      queueProducer,
    );
    const target = {
      kind: "device" as const,
      deviceWorkerId: memberDevice.id,
      agentKind: "pi",
    };

    const created = await postCreate(
      app,
      { thread: "device-thread", executionTarget: target },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { executionTarget: typeof target })
        .executionTarget,
    ).toEqual(target);
    expect(sessions.getStored()?.executionTarget).toEqual(target);

    const conversationId = sessions.getStored()?.conversationId;
    if (!conversationId) throw new Error("Missing device chat session");
    const sent = await app.request(
      `/api/v1/agents/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lobu-org": AGENT_ORG,
        },
        body: JSON.stringify({ content: "Run this locally" }),
      },
    );
    expect(sent.status).toBe(200);
    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0]).toMatchObject({
      conversationId,
      messageText: "Run this locally",
      executionTarget: target,
    });

    // Refreshing the canonical chat route does not resend placement. The
    // server must retain the target already pinned to the conversation.
    const resumed = await postCreate(
      app,
      { thread: "device-thread" },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(resumed.status).toBe(201);
    expect(
      ((await resumed.json()) as { executionTarget: typeof target })
        .executionTarget,
    ).toEqual(target);

    // Session state expires, while conversation history is durable. Recover
    // placement from the existing transcript rather than silently switching
    // this conversation back to the managed runtime.
    const [historyRun] = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, queue_name, status, run_at, action_input
      ) VALUES (
        ${AGENT_ORG}, 'chat_message', 'messages', 'completed', now(), ${sql.json({})}
      )
      RETURNING id
    `;
    const snapshot = `${JSON.stringify({
      type: "session",
      version: 3,
      id: `device-chat-${conversationId}`,
      timestamp: new Date().toISOString(),
      cwd: "/device",
      executionTarget: target,
    })}\n`;
    await sql`
      INSERT INTO agent_transcript_snapshot (
        organization_id, agent_id, conversation_id, run_id,
        snapshot_jsonl, byte_size, terminal_status
      ) VALUES (
        ${AGENT_ORG}, ${AGENT_ID}, ${conversationId}, ${historyRun.id},
        ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed'
      )
    `;
    sessions.store.clear();
    const recovered = await postCreate(
      app,
      { thread: "device-thread" },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(recovered.status).toBe(201);
    expect(
      ((await recovered.json()) as { executionTarget: typeof target })
        .executionTarget,
    ).toEqual(target);

    // The canonical conversation without a thread suffix has the same durable
    // placement contract. Session expiry must not make it fall back to managed
    // execution merely because the request omits `thread`.
    const noThreadConversationId = buildApiConversationId({
      agentId: AGENT_ID,
      userId: MEMBER_ID,
      organizationId: AGENT_ORG,
    });
    const [noThreadRun] = await sql<{ id: number }>`
      INSERT INTO runs (
        organization_id, run_type, queue_name, status, run_at, action_input
      ) VALUES (
        ${AGENT_ORG}, 'chat_message', 'messages', 'completed', now(), ${sql.json({})}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO agent_transcript_snapshot (
        organization_id, agent_id, conversation_id, run_id,
        snapshot_jsonl, byte_size, terminal_status
      ) VALUES (
        ${AGENT_ORG}, ${AGENT_ID}, ${noThreadConversationId}, ${noThreadRun.id},
        ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed'
      )
    `;
    sessions.store.clear();
    const recoveredWithoutThread = await postCreate(
      app,
      {},
      { "x-lobu-org": AGENT_ORG }
    );
    expect(recoveredWithoutThread.status).toBe(201);
    expect(
      (
        (await recoveredWithoutThread.json()) as {
          executionTarget: typeof target;
        }
      ).executionTarget
    ).toEqual(target);

    // Restore the threaded session cleared by the independent no-thread case
    // before asserting that an existing conversation cannot change placement.
    sessions.store.clear();
    expect(
      (
        await postCreate(
          app,
          { thread: "device-thread" },
          { "x-lobu-org": AGENT_ORG },
        )
      ).status,
    ).toBe(201);

    const changedTarget = await postCreate(
      app,
      {
        thread: "device-thread",
        executionTarget: {
          ...target,
          deviceWorkerId: otherMemberDevice.id,
        },
      },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(changedTarget.status).toBe(409);

    const unsupportedKind = await postCreate(
      app,
      {
        thread: "unsupported-kind",
        executionTarget: { ...target, agentKind: "claude-code" },
      },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(unsupportedKind.status).toBe(400);

    const otherUsersDevice = await postCreate(
      app,
      {
        thread: "other-device",
        executionTarget: { ...target, deviceWorkerId: ownerDevice.id },
      },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(otherUsersDevice.status).toBe(400);

    const malformedDevice = await postCreate(
      app,
      {
        thread: "malformed-device",
        executionTarget: { ...target, deviceWorkerId: "not-a-uuid" },
      },
      { "x-lobu-org": AGENT_ORG },
    );
    expect(malformedDevice.status).toBe(400);
  });

  test("the same agent id remains isolated across organizations", async () => {
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const shared = makeSessionManager();
    const { app } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );

    const inAgentOrg = await postCreate(
      app,
      { thread: "same-thread" },
      { "x-lobu-org": AGENT_ORG }
    );
    const inOutsiderOrg = await postCreate(
      app,
      { thread: "same-thread" },
      { "x-lobu-org": OUTSIDER_ORG }
    );

    expect(inAgentOrg.status).toBe(201);
    expect(inOutsiderOrg.status).toBe(201);
    const agentOrgKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: MEMBER_ID,
      organizationId: AGENT_ORG,
      threadId: "same-thread",
    });
    const outsiderOrgKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: MEMBER_ID,
      organizationId: OUTSIDER_ORG,
      threadId: "same-thread",
    });
    expect(((await inAgentOrg.json()) as { agentId: string }).agentId).toBe(
      agentOrgKey
    );
    expect(((await inOutsiderOrg.json()) as { agentId: string }).agentId).toBe(
      outsiderOrgKey
    );
    expect(shared.store.get(agentOrgKey)?.organizationId).toBe(AGENT_ORG);
    expect(shared.store.get(outsiderOrgKey)?.organizationId).toBe(OUTSIDER_ORG);
    expect(shared.store.size).toBe(2);
  });

  test("the agent's owner is still authorized (regression)", async () => {
    setAuthProvider(() => sessionFor(AGENT_OWNER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    const res = await postCreate(app, { thread: "owner-thread" });

    expect(res.status).toBe(201);
    expect(sessions.getStored()?.organizationId).toBe(AGENT_ORG);
    expect(sessions.getStored()?.createdByUserId).toBe(AGENT_OWNER_ID);
  });

  test("a member is denied without a workspace selector — no proven org", async () => {
    // No `x-lobu-org` and no Bearer: nothing authoritative names the org the
    // membership would be checked against, and the ambient default org is the
    // caller's own, not the agent's. Declining is the only tenant-safe answer.
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    const res = await postCreate(app, { thread: "no-workspace" });

    expect(res.status).toBe(403);
    expect(sessions.getStored()).toBeNull();
  });

  test("a Bearer request cannot borrow a settings cookie's membership", async () => {
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      AGENT_ORG
    );

    const res = await postCreate(
      app,
      { thread: "mixed-auth" },
      {
        "x-lobu-org": AGENT_ORG,
        Authorization: "Bearer pat-or-oauth-token",
      }
    );

    expect(res.status).toBe(403);
    expect(sessions.store.size).toBe(0);
  });

  test("a non-member naming the workspace is still denied", async () => {
    setAuthProvider(() => sessionFor(OUTSIDER_ID));
    const { app, sessions } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      OUTSIDER_ORG
    );

    const res = await postCreate(
      app,
      { thread: "outsider-thread" },
      { "x-lobu-org": AGENT_ORG }
    );

    expect(res.status).toBe(403);
    expect(sessions.getStored()).toBeNull();
  });

  test("a member is denied an agent id that does not exist in the named workspace", async () => {
    // Membership alone must not authorize: the same agent id string can exist
    // in every org, so the row has to be pinned to the named workspace.
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const { app } = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG
    );

    const res = await app.request("/api/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lobu-org": AGENT_ORG },
      body: JSON.stringify({ agentId: "not-in-this-org", thread: "t" }),
    });

    expect(res.status).toBe(403);
  });

  test("a member may drive their OWN session but not another member's", async () => {
    const shared = makeSessionManager();

    // The agent's owner opens a conversation.
    setAuthProvider(() => sessionFor(AGENT_OWNER_ID));
    const owner = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    const ownerCreate = await postCreate(owner.app, { thread: "owners-own" });
    expect(ownerCreate.status).toBe(201);
    const ownerKey = ((await ownerCreate.json()) as { agentId: string }).agentId;

    // The member opens their own conversation with the same agent.
    setAuthProvider(() => sessionFor(MEMBER_ID));
    const member = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    const memberCreate = await postCreate(
      member.app,
      { thread: "members-own" },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(memberCreate.status).toBe(201);
    const memberKey = ((await memberCreate.json()) as { agentId: string })
      .agentId;

    // Their own session: fine.
    expect((await getStatus(member.app, memberKey)).status).toBe(200);

    // The owner's session: denied, even though the member may use the agent.
    expect((await getStatus(member.app, ownerKey)).status).toBe(403);
    expect((await deleteSession(member.app, ownerKey)).status).toBe(403);
    // …and the denial did not delete it.
    expect(shared.store.has(ownerKey)).toBe(true);
  });

  test("a member cannot hijack another member's thread by naming their userId", async () => {
    // `conversationId` is `agentId_userId_org_thread` and the `userId` half
    // comes from the request body, so the session key is forgeable. The
    // createdBy check is what stops a resume (which hands back a worker token
    // scoped to that conversation) and a `forceNew` clobber.
    const shared = makeSessionManager();

    setAuthProvider(() => sessionFor(AGENT_OWNER_ID));
    const owner = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    expect(
      (await postCreate(owner.app, { thread: "shared-thread" })).status
    ).toBe(201);

    setAuthProvider(() => sessionFor(MEMBER_ID));
    const member = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    const resume = await postCreate(
      member.app,
      { userId: AGENT_OWNER_ID, thread: "shared-thread" },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(resume.status).toBe(403);

    const clobber = await postCreate(
      member.app,
      { userId: AGENT_OWNER_ID, thread: "shared-thread", forceNew: true },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(clobber.status).toBe(403);
    const ownerKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: AGENT_OWNER_ID,
      organizationId: AGENT_ORG,
      threadId: "shared-thread",
    });
    // The owner's exact session is untouched.
    expect(shared.store.get(ownerKey)?.createdByUserId).toBe(AGENT_OWNER_ID);
  });

  test("a member cannot resume or replace an unstamped legacy session", async () => {
    const shared = makeSessionManager();
    const legacyKey = buildApiConversationId({
      agentId: AGENT_ID,
      userId: AGENT_OWNER_ID,
      organizationId: AGENT_ORG,
      threadId: "legacy-thread",
    });
    const legacySession: ThreadSession = {
      conversationId: legacyKey,
      channelId: `api_${AGENT_OWNER_ID}`,
      userId: AGENT_OWNER_ID,
      threadCreator: AGENT_OWNER_ID,
      lastActivity: 123,
      createdAt: 100,
      status: "active",
      agentId: AGENT_ID,
      organizationId: AGENT_ORG,
    };
    shared.store.set(legacyKey, legacySession);

    setAuthProvider(() => sessionFor(MEMBER_ID));
    const member = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    const body = { userId: AGENT_OWNER_ID, thread: "legacy-thread" };

    expect(
      (await postCreate(member.app, body, { "x-lobu-org": AGENT_ORG })).status
    ).toBe(403);
    expect(
      (
        await postCreate(
          member.app,
          { ...body, forceNew: true },
          { "x-lobu-org": AGENT_ORG }
        )
      ).status
    ).toBe(403);
    expect(shared.store.get(legacyKey)).toBe(legacySession);
    expect(shared.store.size).toBe(1);
  });

  test("an org admin keeps oversight of a member's session", async () => {
    const sql = getDb();
    const shared = makeSessionManager();
    const [memberDevice] = await sql<{ id: string }>`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
      ) VALUES (
        ${MEMBER_ID}, 'member-admin-oversight-device', 'macos',
        ${sql.json(["automations.execute"])}, 'Member oversight Mac',
        ${AGENT_ORG}, '{pi}'::text[]
      )
      RETURNING id
    `;
    if (!memberDevice) throw new Error("Failed to seed member device");
    const target = {
      kind: "device" as const,
      deviceWorkerId: memberDevice.id,
      agentKind: "pi",
    };

    setAuthProvider(() => sessionFor(MEMBER_ID));
    const member = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );
    const created = await postCreate(
      member.app,
      { thread: "member-thread", executionTarget: target },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(created.status).toBe(201);
    const memberKey = ((await created.json()) as { agentId: string }).agentId;

    setAuthProvider(() => sessionFor(ADMIN_ID));
    const admin = makeApp(
      userAgentsStore,
      agentMetadataStore,
      CALLER_DEFAULT_ORG,
      shared
    );

    expect((await getStatus(admin.app, memberKey)).status).toBe(200);
    const resumed = await postCreate(
      admin.app,
      { userId: MEMBER_ID, thread: "member-thread" },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(resumed.status).toBe(201);
    expect(
      ((await resumed.json()) as { executionTarget: typeof target })
        .executionTarget
    ).toEqual(target);

    const newMemberDeviceSession = await postCreate(
      admin.app,
      {
        userId: MEMBER_ID,
        thread: "admin-created-member-device-thread",
        executionTarget: target,
      },
      { "x-lobu-org": AGENT_ORG }
    );
    expect(newMemberDeviceSession.status).toBe(400);
  });
});
