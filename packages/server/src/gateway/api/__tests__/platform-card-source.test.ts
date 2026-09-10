/**
 * F12: the API platform must stamp the headless run origin onto interaction
 * cards so the owner-gate exempts them (a headless turn has no browser SSE on
 * any pod, so an owner-gated card would dead-letter and hang the worker).
 *
 * This drives the REAL InteractionService → ApiPlatform path and captures the
 * payload enqueued onto the thread_response queue.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiPlatform } from "../platform.js";
import { InteractionService } from "../../interactions.js";

function makePlatform() {
  const interactionService = new InteractionService();
  const sends: Array<{ topic: string; payload: any }> = [];
  const queue = {
    send: mock(async (topic: string, payload: any) => {
      sends.push({ topic, payload });
    }),
  };
  const sseManager = {
    broadcast: mock(() => undefined),
    hasActiveConnection: mock(() => false),
  };
  const services = {
    getInteractionService: () => interactionService,
    getQueue: () => queue,
    getSseManager: () => sseManager,
  };
  return { interactionService, sends, services };
}

describe("ApiPlatform interaction-card source stamping (F12)", () => {
  let platform: ApiPlatform;
  let ctx: ReturnType<typeof makePlatform>;

  beforeEach(async () => {
    platform = new ApiPlatform();
    ctx = makePlatform();
    await platform.initialize(ctx.services as never);
  });

  test("stamps platformMetadata.source on a card from a headless turn", async () => {
    await ctx.interactionService.postQuestion(
      "u1",
      "api:conv-1",
      "api:conv-1",
      undefined,
      undefined,
      "api",
      "Proceed?",
      ["yes", "no"],
      "automation-run"
    );

    expect(ctx.sends).toHaveLength(1);
    const { topic, payload } = ctx.sends[0]!;
    expect(topic).toBe("thread_response");
    expect(payload.platformMetadata).toEqual({ source: "automation-run" });
    expect(payload.customEvent?.requireSseOwner).toBe(true);
  });

  test("omits platformMetadata for an interactive (no-source) card", async () => {
    await ctx.interactionService.postQuestion(
      "u1",
      "api:conv-2",
      "api:conv-2",
      undefined,
      undefined,
      "api",
      "Proceed?",
      ["yes", "no"]
      // no source — interactive, browser-driven turn
    );

    expect(ctx.sends).toHaveLength(1);
    expect(ctx.sends[0]!.payload.platformMetadata).toBeUndefined();
    expect(ctx.sends[0]!.payload.customEvent?.requireSseOwner).toBe(true);
  });
});

// Builder gate: a manage_agents write produces a durable (runs/events-backed)
// approval. The worker forwards it as a `tool_approval` interaction card; the
// API platform must enqueue it onto the SAME owner-gated thread_response queue
// as the other cards, with the SSE event name `tool-approval` and a payload
// carrying run_id + action + the proposed-vs-current diff the SPA card reads.
describe("ApiPlatform durable approval card (builder gate)", () => {
  let platform: ApiPlatform;
  let ctx: ReturnType<typeof makePlatform>;

  beforeEach(async () => {
    platform = new ApiPlatform();
    ctx = makePlatform();
    await platform.initialize(ctx.services as never);
  });

  test("enqueues a tool-approval frame carrying run_id + action + diff", async () => {
    await ctx.interactionService.postDurableApprovalCard(
      "u1",
      "api:conv-1",
      "api:conv-1",
      undefined,
      undefined,
      "api",
      42,
      "update",
      { action: "update", agent_id: "support-bot", name: "Support Bot v2" },
      { id: "support-bot", name: "Support Bot" }
      // no source — interactive, browser-driven turn → owner-gated
    );

    expect(ctx.sends).toHaveLength(1);
    const { topic, payload } = ctx.sends[0]!;
    expect(topic).toBe("thread_response");
    // SSE event name the SPA's ToolApprovalPart listens for.
    expect(payload.customEvent?.name).toBe("tool-approval");
    // The exact shape lobu-runtime-provider threads into the card.
    expect(payload.customEvent?.data).toMatchObject({
      type: "tool-approval",
      runId: 42,
      action: "update",
      proposal: { agent_id: "support-bot", name: "Support Bot v2" },
      current: { id: "support-bot", name: "Support Bot" },
      toolName: "manage_agents",
    });
    // Owner-gated like the other API cards (browser SSE lives on one pod).
    expect(payload.customEvent?.requireSseOwner).toBe(true);
    expect(payload.platformMetadata).toBeUndefined();
    expect(payload.conversationId).toBe("api:conv-1");
  });

  test("stamps source so a headless approval card bypasses the owner-gate", async () => {
    await ctx.interactionService.postDurableApprovalCard(
      "u1",
      "api:conv-2",
      "api:conv-2",
      undefined,
      undefined,
      "api",
      7,
      "create",
      { action: "create", agent_id: "new-bot", name: "New Bot" },
      null,
      "internal"
    );

    expect(ctx.sends).toHaveLength(1);
    const { payload } = ctx.sends[0]!;
    expect(payload.platformMetadata).toEqual({ source: "internal" });
    expect(payload.customEvent?.name).toBe("tool-approval");
    expect(payload.customEvent?.data).toMatchObject({
      runId: 7,
      action: "create",
      current: null,
    });
  });

  test("does NOT fan out a non-api durable approval card", async () => {
    await ctx.interactionService.postDurableApprovalCard(
      "u1",
      "slack:conv",
      "slack:conv",
      undefined,
      "conn-1",
      "slack",
      1,
      "delete",
      { action: "delete", agent_id: "x" },
      { id: "x" }
    );

    // ApiPlatform filters on platform === "api"; chat surfaces the durable
    // approval via the agent narration + event-card permalink, not here.
    expect(ctx.sends).toHaveLength(0);
  });
});

test("interaction cards retain request correlation independently of their queue and card IDs", async () => {
  const ctx = makePlatform();
  await new ApiPlatform().initialize(ctx.services as never);
  const svc = ctx.interactionService;
  const route = ["synthetic-user", "synthetic-conversation", "synthetic-channel", undefined, undefined, "api"] as const;
  await svc.postQuestion(...route, "Continue?", ["yes"], undefined, "synthetic-request");
  await svc.postLinkButton(...route, "https://example.test", "Sign in", "oauth", undefined, undefined, "synthetic-request");
  await svc.postSuggestion("synthetic-org", ...route, [{ title: "Next", message: "Continue" }], undefined, "synthetic-request");
  await svc.postDurableApprovalCard(...route, 123, "create", {}, null, undefined, null, null, "agent", "synthetic-request");
  await svc.postToolApproval("synthetic-approval", "synthetic-agent", ...route, "synthetic-mcp", "write", {}, "write", undefined, "synthetic-request");
  expect(ctx.sends).toHaveLength(5);
  for (const { payload } of ctx.sends) {
    expect(payload.messageId).not.toBe("synthetic-request");
    expect(payload.customEvent.data.turnMessageId).toBe("synthetic-request");
  }
  expect(ctx.sends[4]!.payload.customEvent.data.requestId).toBe("synthetic-approval");
});
