import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { createConversationsRoutes } from "../../routes/internal/conversations.js";

const presentStoredEventToConversation = mock(async () => ({
  ok: true as const,
  messageId: "spaces/AAAA/messages/card-1",
  threadId: "gchat:spaces/AAAA:dm",
  fallbackText: "Poll",
}));
const manageSchedules = mock(async () => ({
  schedule: { id: "schedule-1" },
}));

mock.module("../../../notifications/service.js", () => ({
  presentStoredEventToConversation,
}));
mock.module("../../../tools/admin/manage_schedules.js", () => ({
  manageSchedules,
}));

const ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function token(
  overrides: Record<string, unknown> = {},
  conversationId = "gchat:spaces/AAAA:dm"
) {
  return generateWorkerToken(
    "users/owner",
    conversationId,
    "personal-agent-deploy",
    {
      channelId: "spaces/AAAA",
      platform: "gchat",
      agentId: "personal-agent",
      organizationId: "org-event-tools-test",
      connectionId: "567",
      ...overrides,
    }
  );
}

function post(
  router: ReturnType<typeof createConversationsRoutes>,
  path: string,
  workerToken: string,
  body: Record<string, unknown>
) {
  return router.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${workerToken}`,
    },
    body: JSON.stringify(body),
  });
}

describe("active-conversation event tools", () => {
  let originalKey: string | undefined;
  let router: ReturnType<typeof createConversationsRoutes>;

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
    presentStoredEventToConversation.mockClear();
    manageSchedules.mockClear();
    router = createConversationsRoutes();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  test("presents only the event id into the signed source conversation", async () => {
    const response = await post(
      router,
      "/conversations/present-event",
      token({ channelId: "gchat:spaces/AAAA" }),
      { eventId: 42 }
    );

    expect(response.status).toBe(200);
    expect(presentStoredEventToConversation).toHaveBeenCalledWith({
      organizationId: "org-event-tools-test",
      eventId: 42,
      connectionId: "567",
      platform: "gchat",
      channelId: "gchat:spaces/AAAA",
      channelKey: "gchat:spaces/AAAA",
      conversationId: "gchat:spaces/AAAA:dm",
      threadId: "dm",
    });
  });

  test("rejects presentation without signed chat coordinates", async () => {
    const response = await post(
      router,
      "/conversations/present-event",
      token({ connectionId: undefined }),
      { eventId: 42 }
    );
    expect(response.status).toBe(403);
    expect(presentStoredEventToConversation).not.toHaveBeenCalled();
  });

  test("schedules only the signed agent in the signed conversation", async () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const response = await post(
      router,
      "/conversations/schedule-followup",
      token({ runId: 4242 }),
      {
        runAt,
        prompt: "Close event-backed poll entity 77.",
        idempotencyKey: "poll-deadline:77",
      }
    );

    expect(response.status).toBe(200);
    const [args, , context] = manageSchedules.mock.calls[0];
    expect(args).toMatchObject({
      action: "create",
      run_at: runAt,
      payload: {
        type: "wake_agent",
        agent_id: "personal-agent",
        prompt: "Close event-backed poll entity 77.",
      },
    });
    expect(args.idempotency_key).toMatch(/^conversation-followup:[0-9a-f]{64}$/);
    expect(context).toMatchObject({
      organizationId: "org-event-tools-test",
      userId: null,
      agentId: "personal-agent",
      sourceContext: {
        platform: "gchat",
        connectionId: "567",
        channelId: "spaces/AAAA",
        conversationId: "gchat:spaces/AAAA:dm",
        userId: "users/owner",
        // The signed turn run: the follow-up keeps this sender's evidence.
        turnRunId: 4242,
      },
    });

    const second = await post(
      router,
      "/conversations/schedule-followup",
      token({}, "gchat:spaces/AAAA:thread-two"),
      {
        runAt,
        prompt: "Close event-backed poll entity 77.",
        idempotencyKey: "poll-deadline:77",
      }
    );
    expect(second.status).toBe(200);
    expect(manageSchedules.mock.calls[1][0].idempotency_key).not.toBe(
      args.idempotency_key
    );
    expect(manageSchedules.mock.calls[1][0].source_thread_id).toBe(
      "gchat:spaces/AAAA:thread-two"
    );
  });

  test("rejects a past follow-up without touching the scheduler", async () => {
    const response = await post(
      router,
      "/conversations/schedule-followup",
      token(),
      {
        runAt: "2020-01-01T00:00:00.000Z",
        prompt: "too late",
        idempotencyKey: "past",
      }
    );
    expect(response.status).toBe(400);
    expect(manageSchedules).not.toHaveBeenCalled();
  });

  test("rejects a follow-up on a platform without scheduled chat delivery", async () => {
    const response = await post(
      router,
      "/conversations/schedule-followup",
      token({ platform: "discord", channelId: "channel-1" }, "discord:channel-1"),
      {
        runAt: new Date(Date.now() + 60_000).toISOString(),
        prompt: "follow up here",
        idempotencyKey: "unsupported-platform",
      }
    );
    expect(response.status).toBe(422);
    expect(manageSchedules).not.toHaveBeenCalled();
  });
});
