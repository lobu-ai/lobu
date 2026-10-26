import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MessagePayload } from "@lobu/core";
import { getDb } from "../../db/client";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup";
import type { CoreServices } from "../../gateway/services/core-services";
import {
  createThreadForAgent,
  enqueueAgentMessage,
} from "../../gateway/services/agent-threads";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection";
import { runWakeAgentTask, type WakeAgentTaskPayload } from "../jobs";

const ORG = "org-wake-delivery";
const AGENT = "agent-wake-delivery";
const USER = "user-wake-delivery";

/**
 * Drive the real `wake_agent` handler against the live test DB. The queue
 * producer is captured; the session manager throws on any access so a fall
 * through to the api-platform path (createThreadForAgent / enqueueAgentMessage)
 * is observable as a rejection rather than silently running the legacy path.
 */
function fakeCoreServices(enqueued: MessagePayload[]): CoreServices {
  const sessionManager = new Proxy(
    {},
    {
      get() {
        throw new Error("API_PATH_REACHED");
      },
    }
  );
  return {
    getQueueProducer: () => ({
      enqueueMessage: async (payload: MessagePayload) => {
        enqueued.push(payload);
        return "queued";
      },
    }),
    getSessionManager: () => sessionManager,
  } as unknown as CoreServices;
}

async function seedChatConnection(params: {
  id: string;
  platform?: string;
  agentId?: string | null;
  status?: string;
  externalTenantId?: string | null;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO connections (
      organization_id, connector_key, external_tenant_id, agent_id,
      display_name, status, config, credential_mode, slug, visibility
    ) VALUES (
      ${ORG}, ${params.platform ?? "slack"}, ${params.externalTenantId ?? null},
      ${params.agentId === undefined ? AGENT : params.agentId}, 'Test chat', ${params.status ?? "active"},
      ${sql.json({})}, 'byo', ${runtimeConnectionIdToSlug(params.id)}, 'org'
    )
  `;
}

function payload(
  deliveryContext: unknown,
  overrides?: Partial<WakeAgentTaskPayload>
): WakeAgentTaskPayload {
  return {
    __organization_id: ORG,
    __created_by_user: USER,
    __scheduled_job_id: "job-1",
    __delivery_context: deliveryContext,
    agent_id: AGENT,
    prompt: "wake up",
    ...overrides,
  };
}

describe("runWakeAgentTask chat delivery dispatch", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase();
    await seedAgentRow(AGENT, { organizationId: ORG, ownerUserId: USER });
  }, 60_000);

  test("posts back to the channel when delivery context is authorized (a pre-evidence chat row)", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: null,
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    const msg = enqueued[0];
    expect(msg.platform).toBe("slack");
    expect(msg.channelId).toBe("C-real");
    expect(msg.conversationId).toBe("slack:C-real:123");
    expect(msg.messageText).toBe("wake up");
    // teamId omitted (not stamped with the platform name) when delivery has none.
    expect(msg.teamId).toBeUndefined();
    expect(msg.platformMetadata.connectionId).toBe("conn-real");
    expect(msg.platformMetadata.teamId).toBeUndefined();
    // A chat-delivered wake is a follow-up decided by its sender; a context
    // stored without sender evidence decides as "no evidence" (fails closed).
    expect(msg.platformMetadata.source).toBe("followup");
    expect(msg.platformMetadata.isDirect).toBe(false);
    expect(msg.platformMetadata.senderVouched).toBe(false);
  });

  test("posts a one-shot wake back to Google Chat", async () => {
    await seedChatConnection({ id: "gchat-real", platform: "gchat" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "gchat",
        connectionId: "gchat-real",
        channelId: "spaces/AAAA-test",
        conversationId: "gchat:spaces/AAAA-test:dm",
        teamId: null,
        userId: "users/clicker-a",
        senderEvidence: { isDirectMessage: true, senderVouched: true },
      })
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      platform: "gchat",
      userId: "users/clicker-a",
      channelId: "spaces/AAAA-test",
      conversationId: "gchat:spaces/AAAA-test:dm",
      messageText: "wake up",
    });
    expect(enqueued[0].platformMetadata).toMatchObject({
      connectionId: "gchat-real",
      senderId: "users/clicker-a",
      source: "followup",
      isDirect: true,
      senderVouched: true,
    });
  });

  test("injects the per-schedule model override into agentOptions", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload(
        {
          platform: "slack",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "slack:C-real:123",
          teamId: null,
          userId: USER,
        },
        { model: "openai/gpt-5" }
      )
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agentOptions).toEqual({ model: "openai/gpt-5" });
  });

  test("leaves agentOptions empty when no per-schedule model is set", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: null,
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].agentOptions).toEqual({});
  });

  test("forwards a real teamId through to the message payload", async () => {
    await seedChatConnection({ id: "conn-real", externalTenantId: "T-real" });
    const enqueued: MessagePayload[] = [];

    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: "T-real",
        userId: USER,
      })
    );

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].teamId).toBe("T-real");
    expect(enqueued[0].platformMetadata.teamId).toBe("T-real");
  });

  test("rejects a follow-up when its connection is no longer active", async () => {
    await seedChatConnection({ id: "conn-real", status: "paused" });
    const enqueued: MessagePayload[] = [];

    // A revoked chat target must not turn the sender's request into an
    // owner-authorized API turn. The session manager throws if reached.
    await expect(
      runWakeAgentTask(
        fakeCoreServices(enqueued),
        payload({
          platform: "slack",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "slack:C-real:123",
          teamId: null,
          userId: USER,
        })
      )
    ).rejects.toThrow("Cannot dispatch scheduled chat delivery: connection-inactive");
    expect(enqueued).toHaveLength(0);
  });

  test("rejects a follow-up for a non-deliverable platform", async () => {
    await seedChatConnection({ id: "conn-real", platform: "discord" });
    const enqueued: MessagePayload[] = [];

    await expect(
      runWakeAgentTask(
        fakeCoreServices(enqueued),
        payload({
          platform: "discord",
          connectionId: "conn-real",
          channelId: "C-real",
          conversationId: "discord:C-real:123",
          teamId: null,
          userId: USER,
        })
      )
    ).rejects.toThrow("Cannot dispatch scheduled chat delivery: invalid delivery context");
    expect(enqueued).toHaveLength(0);
  });

  test("rejects malformed stored delivery instead of changing authority", async () => {
    const enqueued: MessagePayload[] = [];
    await expect(
      runWakeAgentTask(fakeCoreServices(enqueued), payload({ userId: USER }))
    ).rejects.toThrow("Cannot dispatch scheduled chat delivery: invalid delivery context");
    expect(enqueued).toHaveLength(0);
  });

  test("keeps a platform-CLI origin's wake headless, as before follow-ups carried a sender", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];
    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
        teamId: null,
        // A Lobu user id: the CLI speaks for the user, not a Slack sender.
        userId: USER,
        originSource: "platform-cli",
      })
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].platformMetadata.source).toBe("scheduled-job");
  });

  test("keeps a chat delivery without a sender headless", async () => {
    await seedChatConnection({ id: "conn-real" });
    const enqueued: MessagePayload[] = [];
    await runWakeAgentTask(
      fakeCoreServices(enqueued),
      payload({
        platform: "slack",
        connectionId: "conn-real",
        channelId: "C-real",
        conversationId: "slack:C-real:123",
      })
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].platformMetadata.source).toBe("scheduled-job");
  });

  test.each([null, undefined])("uses the API path when delivery context is %s", async (delivery) => {
    const enqueued: MessagePayload[] = [];
    await expect(
      runWakeAgentTask(fakeCoreServices(enqueued), payload(delivery))
    ).rejects.toThrow("API_PATH_REACHED");
    expect(enqueued).toHaveLength(0);
  });
});

test("internal API-thread dispatch forwards a supplied model in agentOptions", async () => {
  const enqueued: MessagePayload[] = [];
  const deps = {
    sessionManager: {
      getSession: async () => ({
        userId: USER,
        conversationId: "thread-1",
        agentId: AGENT,
        organizationId: ORG,
        provider: "claude",
        model: "claude/claude-sonnet-4-5",
      }),
      touchSession: async () => {},
    },
    queueProducer: {
      enqueueMessage: async (message: MessagePayload) => {
        enqueued.push(message);
        return "queued";
      },
    },
  } as unknown as Parameters<typeof enqueueAgentMessage>[0];

  await enqueueAgentMessage(
    deps,
    {
      threadId: "thread-1",
      messageText: "wake up",
      model: "z-ai/glm-5.2",
    }
  );

  expect(enqueued[0].agentOptions).toMatchObject({ model: "z-ai/glm-5.2" });
});

test("#2: createThreadForAgent STORES organizationId on the session", async () => {
  let stored: { organizationId?: string } | undefined;
  const deps = {
    sessionManager: {
      setSession: async (s: { organizationId?: string }) => {
        stored = s;
      },
    },
  } as unknown as Parameters<typeof createThreadForAgent>[0];

  await createThreadForAgent(deps, {
    agentId: AGENT,
    organizationId: "org-B",
    userId: USER,
  });

  // The session (read at enqueue by internal threads) carries the org, not just
  // the token.
  expect(stored?.organizationId).toBe("org-B");
});

test("#2: enqueueAgentMessage threads the session's organizationId to the TOP-LEVEL payload", async () => {
  // The enqueue-time model gate reads payload.organizationId. An internal
  // scheduled/repair thread must carry the RIGHT org top-level, or the gate
  // queries the agent id across orgs (declared agents exist in every org) and
  // enforces another tenant's policy. Cross-tenant leak.
  const enqueued: MessagePayload[] = [];
  const deps = {
    sessionManager: {
      getSession: async () => ({
        userId: USER,
        conversationId: "thread-2",
        agentId: AGENT,
        provider: "claude",
        organizationId: "org-B",
      }),
      touchSession: async () => {},
    },
    queueProducer: {
      enqueueMessage: async (message: MessagePayload) => {
        enqueued.push(message);
        return "queued";
      },
    },
  } as unknown as Parameters<typeof enqueueAgentMessage>[0];

  await enqueueAgentMessage(deps, {
    threadId: "thread-2",
    messageText: "wake up",
  });

  // Top-level org (not just platformMetadata) so the gate resolves org-B, not
  // an id-only cross-org read.
  expect(enqueued[0].organizationId).toBe("org-B");
});
