/**
 * Cross-pod fan-out for CHAT-PLATFORM interaction cards — the most faithful
 * single-process seam test of the multi-replica delivery path.
 *
 * The production bug: a worker posts an `ask_user`/approval/link-button card
 * into ITS pod's `InteractionService`, but under N>1 replicas (Slack webhooks
 * don't pin to the connection's pod) that pod rarely owns the connection's
 * in-process interaction bridge — so the card was silently lost.
 *
 * This test stands up BOTH sides of the seam in one process:
 *
 *   - COLD replica: a real `InteractionService` with the real fan-out producer
 *     (`registerChatInteractionFanout`) wired as NOT-warm-locally, so a posted
 *     card is enqueued onto the (stubbed) `thread_response` queue instead of
 *     rendered locally — exactly what the worker's pod does.
 *
 *   - WARM replica: a real `InteractionService` with the REAL interaction
 *     bridge (`registerInteractionBridge`) registered for the connection, plus a
 *     real `UnifiedThreadResponseConsumer` whose `ensureDeliverable` returns
 *     true (this replica owns the connection). The consumer claims the enqueued
 *     row and re-emits the card onto the warm `InteractionService`, which the
 *     real bridge renders.
 *
 * WHAT THIS COVERS (real, not mocked):
 *   - real fan-out producer + envelope construction
 *   - real consumer branch (`handleChatInteraction`) incl. connectionId guard
 *   - the REAL `registerInteractionBridge` rendering path: it writes a real
 *     `pending_interactions` row (real Postgres) and posts exactly one card
 *   - the bridge's per-connection `handledEvents` dedup across a queue re-claim
 *
 * WHAT THIS DOES NOT COVER (still owed):
 *   - the Postgres `thread_response` queue itself (single-claim/SKIP-LOCKED,
 *     re-queue-on-throw) — stubbed here; verified by the queue's own tests
 *   - two genuinely separate OS processes/pods and ClientIP affinity
 *   - the real Chat SDK platform post to Slack (the `thread.post` is a mock)
 *
 * A live two-pod e2e (or a post-deploy live Slack `ask_user` round-trip) is
 * still the owed hard gate per AGENTS.md.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createChildSpan,
  createRootSpan,
  generateWorkerToken,
  getTraceparent,
  initTracing,
  shutdownTracing,
} from "@lobu/core";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { agentTurnTokenScope } from "../orchestration/deployment-identity.js";
import { createInteractionRoutes } from "../routes/internal/interactions.js";
import { getDb } from "../../db/client.js";
import { registerInteractionBridge } from "../connections/interaction-bridge.js";
import type { PlatformConnection } from "../connections/types.js";
import { InteractionService, type PostedQuestion } from "../interactions.js";
import {
  registerChatInteractionFanout,
  UnifiedThreadResponseConsumer,
} from "../platform/unified-thread-consumer.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const ORG = "test-org-fanout";
const CONN = "conn-slack-fanout";
const USER = "U_FANOUT";
const CHANNEL = "slack:D095";

/**
 * Poll `check` until it returns true or `timeoutMs` elapses, throwing on
 * timeout. Replaces fixed sleeps so the bridge's async render (resolveThread →
 * import("chat") → post) is awaited by CONDITION, not a guessed duration — the
 * 50ms fixed sleep flaked on a cold run under CI/SHMMNI pressure.
 */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
  pollMs = 5
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Assert a NO-OP negative: that `value()` stays equal to `expected` across a
 * short stable window. Used for the dedup / "no additional render" checks where
 * the absence of an event can't be polled-for positively. The window is short
 * because the dedup path is synchronous (handledEvents is checked before any
 * await), so a re-render, if it happened, would already be in flight.
 */
async function expectStable<T>(
  value: () => T,
  expected: T,
  label: string,
  windowMs = 100,
  pollMs = 5
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (value() !== expected) {
      throw new Error(
        `expectStable: ${label} changed from ${String(expected)} to ${String(
          value()
        )}`
      );
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function seedOrg(id: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${id}, ${id}, ${id})
    ON CONFLICT (id) DO NOTHING
  `;
}

function makeConnection(): PlatformConnection {
  return {
    id: CONN,
    organizationId: ORG,
    platform: "slack",
    config: { platform: "slack" } as any,
    settings: {},
    metadata: {},
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Minimal chat stub the real bridge needs to resolve a DM thread and post. */
function makeChat(threadPost: ReturnType<typeof mock>) {
  return {
    onAction: mock((_handler: any) => undefined),
    // DM path: conversationId === channelId → bridge calls chat.channel().
    // Worker-token routing carries the canonical platform-prefixed channel id.
    // The Chat SDK expects that exact key; a double prefix is unroutable.
    channel: mock((key: string) =>
      key === CHANNEL ? { post: threadPost } : null
    ),
    getAdapter: mock((_platform: string) => null),
    createThread: null,
  };
}

/** Manager stub that reports the connection warm with the given chat. */
function makeManager(instanceChat: any) {
  const connection = makeConnection();
  const instance = {
    connection,
    chat: instanceChat,
    messageBridge: { ingestClick: mock(async () => undefined) },
    conversationState: {},
  };
  return {
    has: (id: string) => id === CONN,
    getInstance: (id: string) => (id === CONN ? instance : undefined),
  };
}

const slackQuestion: PostedQuestion = {
  id: "q_fanout_1",
  userId: USER,
  // DM: conversationId === channelId so resolveThread takes the channel path.
  conversationId: CHANNEL,
  channelId: CHANNEL,
  teamId: "T1",
  connectionId: CONN,
  platform: "slack",
  question: "Proceed with the cross-pod card?",
  options: ["Yes", "No"],
};

describe("chat interaction card cross-pod fan-out (faithful seam, real bridge + real DB)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG);
  });

  afterEach(async () => {
    await shutdownTracing();
  });

  test("authenticated card crosses replicas once and keeps its stored turn trace", async () => {
    await shutdownTracing();
    const finished: ReadableSpan[] = [];
    const processor: SpanProcessor = {
      onStart() {},
      onEnd(span) { finished.push(span); },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    initTracing({ serviceName: "interaction-fanout-test", spanProcessors: [processor] });
    const root = createRootSpan("message_received");
    const queueSpan = createChildSpan("queue_processing", root.traceparent);
    const traceparent = getTraceparent(queueSpan);
    expect(root.span).not.toBeNull();
    expect(queueSpan).not.toBeNull();
    const traceId = root.span!.spanContext().traceId;
    root.span!.end();
    queueSpan!.end();

    const sql = getDb();
    const [allocated] = await sql<{ id: number }>`
      SELECT nextval(pg_get_serial_sequence('runs', 'id')) AS id
    `;
    const runId = Number(allocated!.id);
    const messageId = "message-traced-fanout";
    const agentId = "agent-traced-fanout";
    const credential = generateWorkerToken(USER, CHANNEL, agentTurnTokenScope(messageId), {
      organizationId: ORG,
      agentId,
      platform: "slack",
      channelId: CHANNEL,
      connectionId: CONN,
      teamId: "T1",
      messageId,
      runId,
    });
    await sql`
      INSERT INTO runs (id, organization_id, run_type, status, action_input)
      VALUES (${runId}, ${ORG}, 'agent_turn', 'running', ${sql.json({
        credential,
        turn: { agent_id: agentId, conversation_id: CHANNEL, message_id: messageId },
        reply: {
          message_id: messageId, channel_id: CHANNEL, user_id: USER, platform: "slack",
          platform_metadata: { connectionId: CONN, traceparent },
        },
      })})
    `;
    // --- COLD replica: producer enqueues instead of rendering ----------------
    const coldSvc = new InteractionService();
    const enqueued: any[] = [];
    const coldQueue = {
      send: mock(async (_name: string, data: any) => {
        enqueued.push(JSON.parse(JSON.stringify(data)));
        return "job-id";
      }),
    } as any;
    // Not warm locally → producer must enqueue (the worker-pod case).
    const coldCleanup = registerChatInteractionFanout(
      coldSvc,
      coldQueue,
      (_id: string) => false
    );

    const router = createInteractionRoutes(coldSvc);
    const response = await router.request("/internal/interactions/create", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        // The caller's header must never choose the originating turn's trace.
        traceparent: `00-${"ff".repeat(16)}-${"ee".repeat(8)}-01`,
      },
      body: JSON.stringify({ question: slackQuestion.question, options: slackQuestion.options }),
    });
    expect(response.status).toBe(200);
    const posted = await response.json() as { id: string };
    expect(posted.id).toBeTruthy();
    expect(enqueued.length).toBe(1);
    const row = enqueued[0];
    expect(row.platformMetadata.connectionId).toBe(CONN);
    expect(row.customEvent.name).toBe("chat-interaction");

    // --- WARM replica: real bridge + real consumer ---------------------------
    const warmSvc = new InteractionService();
    const threadPost = mock(async () => ({ edit: mock(async () => undefined) }));
    const instanceChat = makeChat(threadPost);
    const manager = makeManager(instanceChat);
    const actionChat = makeChat(threadPost);

    const bridgeCleanup = registerInteractionBridge(
      warmSvc,
      manager as any,
      makeConnection(),
      actionChat as any
    );

    const consumer = new UnifiedThreadResponseConsumer(
      { send: mock(async () => "id") } as any,
      { get: mock(() => undefined) } as any,
      { broadcast: mock(() => undefined) } as any
    ) as any;
    // This replica OWNS the connection → ensureDeliverable true.
    consumer.setChatResponseBridge({
      ensureDeliverable: mock(async () => true),
      handleCompletion: mock(async () => undefined),
      handleError: mock(async () => undefined),
    });
    // Wire re-emit onto the warm InteractionService (warm-locally guard true so
    // its own producer never re-enqueues).
    consumer.setInteractionService(warmSvc, (_id: string) => true);

    // The COLD replica's enqueued row is claimed here.
    await consumer.handleThreadResponse({ id: "job-1", data: row });
    // Bridge render is async (resolveThread → import("chat") → post). Wait on
    // the CONDITION (one post) rather than a fixed sleep.
    await waitFor(
      () => threadPost.mock.calls.length === 1,
      "warm-replica bridge posts the card exactly once"
    );

    // Exactly ONE platform card posted.
    expect(threadPost).toHaveBeenCalledTimes(1);

    // Exactly ONE pending_interactions row written (real DB). The bridge
    // persists the row before posting, so once the post is observed the row is
    // already durable; poll defensively to absorb any commit lag.
    const countPendingRows = async (): Promise<number> => {
      const rows = await sql<{ id: string }>`
        SELECT id FROM pending_interactions WHERE id = ${posted.id}
      `;
      return rows.length;
    };
    await waitFor(
      async () => (await countPendingRows()) === 1,
      "exactly one pending_interactions row written"
    );

    // --- Re-claim the SAME row (queue retry) — must NOT double-render --------
    await consumer.handleThreadResponse({ id: "job-1-retry", data: row });

    // Still exactly one card and one pending row — the bridge's handledEvents
    // dedup (same id) makes the re-emit a no-op. Assert STABILITY (the count
    // does not climb to 2) across a short window rather than a fixed sleep.
    await expectStable(
      () => threadPost.mock.calls.length,
      1,
      "card post count stays at 1 after queue re-claim"
    );
    expect(await countPendingRows()).toBe(1);

    const deliveries = finished.filter((span) =>
      span.name === "response_delivery" && span.attributes["lobu.message_id"] === posted.id
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((span) => span.spanContext().traceId)).toEqual([traceId, traceId]);
    const queuedParent = row.platformMetadata.traceparent as string;
    expect(queuedParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(deliveries.map((span) => span.parentSpanContext?.spanId)).toEqual([
      queuedParent.split("-")[2], queuedParent.split("-")[2],
    ]);

    coldCleanup();
    bridgeCleanup();
  });

  test("N=1 / worker-pod == owner-pod: producer skips the queue, local bridge renders once", async () => {
    // Single replica: the same InteractionService backs both the worker post
    // and the warm bridge. The producer's warm-locally guard short-circuits the
    // enqueue, and the local bridge renders directly.
    const svc = new InteractionService();
    const threadPost = mock(async () => ({ edit: mock(async () => undefined) }));
    const instanceChat = makeChat(threadPost);
    const manager = makeManager(instanceChat);
    const actionChat = makeChat(threadPost);

    const bridgeCleanup = registerInteractionBridge(
      svc,
      manager as any,
      makeConnection(),
      actionChat as any
    );

    const queue = { send: mock(async () => "id") } as any;
    // Warm locally → producer must NOT enqueue.
    const fanoutCleanup = registerChatInteractionFanout(
      svc,
      queue,
      (_id: string) => true
    );

    svc.emit("question:created", slackQuestion);
    // Wait on the render CONDITION rather than a fixed sleep.
    await waitFor(
      () => threadPost.mock.calls.length === 1,
      "local bridge renders the card once (N=1)"
    );

    // No queue traffic, exactly one local render.
    expect(queue.send).not.toHaveBeenCalled();
    expect(threadPost).toHaveBeenCalledTimes(1);

    const sql = getDb();
    const rows = await sql<{ id: string }>`
      SELECT id FROM pending_interactions WHERE id = ${slackQuestion.id}
    `;
    expect(rows.length).toBe(1);

    fanoutCleanup();
    bridgeCleanup();
  });

	test("a one-shot question settles the original card through the click adapter", async () => {
		const sentEdit = mock(async () => undefined);
		const threadPost = mock(async () => ({ edit: sentEdit }));
		const thread = { id: CHANNEL, post: threadPost };
		let actionHandler: ((event: any) => Promise<void>) | undefined;
		const chat = {
			onAction: mock((handler: (event: any) => Promise<void>) => {
				actionHandler = handler;
			}),
			channel: mock((key: string) => (key === CHANNEL ? thread : null)),
			getAdapter: mock((_platform: string) => null),
			createThread: null,
		};
		const ingestClick = mock(async () => undefined);
		const instance = {
			connection: makeConnection(),
			chat,
			messageBridge: { ingestClick },
			conversationState: {},
		};
		const manager = {
			has: (id: string) => id === CONN,
			getInstance: (id: string) => (id === CONN ? instance : undefined),
		};
		const service = new InteractionService();
		const cleanup = registerInteractionBridge(
			service,
			manager as any,
			makeConnection(),
			chat as any,
		);

		service.emit("question:created", slackQuestion);
		await waitFor(
			() => threadPost.mock.calls.length === 1,
			"question card is posted",
		);
		if (!actionHandler) throw new Error("question action handler was not registered");
		const editMessage = mock(async () => undefined);
		await actionHandler({
			actionId: `question:${slackQuestion.id}:0`,
			value: "Yes",
			thread,
			threadId: CHANNEL,
			messageId: "1700000000.000700",
			adapter: { editMessage },
			user: {
				userId: USER,
				userName: "ada",
				fullName: "Ada Reviewer",
			},
		});
		await waitFor(
			() => editMessage.mock.calls.length === 1 && ingestClick.mock.calls.length === 1,
			"question card settles and click reaches worker",
		);

		expect(threadPost).toHaveBeenCalledTimes(1);
		expect(sentEdit).not.toHaveBeenCalled();
		const settledJson = JSON.stringify(editMessage.mock.calls[0]?.[2]);
		expect(settledJson).toContain("*Answered*");
		expect(settledJson).toContain("Ada Reviewer");
		expect(settledJson).toContain("Conversation: Slack conversation");
		expect(settledJson).not.toContain('\"type\":\"button\"');

		cleanup();
	});
});
