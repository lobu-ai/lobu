/**
 * End-to-end tests for the worker-response liveness signals (#12 / #14) against
 * a real Postgres (embedded PG18 in CI). Drives the gateway's
 * `POST /worker/response` handler the way a real worker subprocess does and
 * asserts the two liveness clocks it must refresh:
 *
 *  - #14: a 20s `status_update` (NO `received` flag) must push the turn-liveness
 *    marker's `run_at` deadline forward. Before the fix only the 30s SSE-ping
 *    ACK extended it, so a live worker emitting status updates every 20s could
 *    still lapse the 60s deadline on ~2 missed ping ACKs and be falsely failed.
 *
 *  - #12: every worker-driven response must refresh the DEPLOYMENT manager's
 *    idle clock (`updateDeploymentActivity`), not just the connection manager's
 *    stale-SSE clock — otherwise the idle reaper scales a long-running worker to
 *    0 mid-turn. Asserted via a stub tracker injected with
 *    `setDeploymentActivityTracker`.
 *
 * Inference-provider health used to be written here from terminal rows; it is
 * now decided in the secret proxy on the upstream HTTP status — the
 * status→verdict map and its tests live in `provider-health-status.ts`.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { generateDeploymentName } from "../orchestration/deployment-identity.js";
import { armTurnTimeout } from "../orchestration/turn-liveness.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";
/** The turn's routing identity. */
const TURN = {
  organizationId: "org-1",
  agentId: "agent-1",
  userId: "user-1",
  platform: "slack",
  channelId: "chan-1",
  conversationId: "conv-1",
};

/**
 * This route serves a DEPLOYMENT-scoped credential, whose `deploymentName` is
 * the conversation deployment — so here the credential scope and the marker key
 * are the same string. They are still both produced by `generateDeploymentName`
 * rather than written as a literal: the handler derives the marker key from the
 * token's claims, and a hand-picked literal would only agree with it by
 * accident.
 */
const DEPLOYMENT = generateDeploymentName(TURN);

let queue: RunsQueue;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await resetTestDatabase();
  // The runs FK requires the organization to exist before arming a marker.
  await seedAgentRow("agent-1", { organizationId: "org-1" });
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  await queue.stop();
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

function makeGateway(): WorkerGateway {
  return new WorkerGateway(
    queue as any,
    "https://gateway.example.com",
    { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
    {
      getSessionContext: async () => ({
        agentLayers: {
          identityMd: "",
          soulMd: "",
          userMd: "",
          unconfiguredNotice: "",
        },
        platformInstructions: "",
        networkInstructions: "",
        skillsInstructions: "",
        mcpStatus: [],
      }),
    } as any
  );
}

function mintToken(opts?: {
  omitOrganizationId?: boolean;
  omitConnectionId?: boolean;
  omitResponseThreadId?: boolean;
  omitAgentId?: boolean;
  runId?: number;
}): string {
  return generateWorkerToken("user-1", "conv-1", DEPLOYMENT, {
    channelId: "chan-1",
    teamId: "team-1",
    ...(opts?.omitAgentId ? {} : { agentId: "agent-1" }),
    ...(opts?.omitOrganizationId ? {} : { organizationId: "org-1" }),
    ...(opts?.omitConnectionId ? {} : { connectionId: "connection-1" }),
    platform: "slack",
    source: "automation-run",
    ...(opts?.omitResponseThreadId
      ? {}
      : { responseThreadId: "slack:chan-1:conv-1" }),
    runId: opts?.runId ?? 1,
    messageId: "m1",
  });
}

function armLiveTurn(messageId = "m1"): Promise<void> {
  return armTurnTimeout(queue, {
    messageId,
    channelId: "chan-1",
    conversationId: "conv-1",
    userId: "user-1",
    platform: TURN.platform,
    deploymentName: DEPLOYMENT,
    organizationId: "org-1",
  });
}

/** Post a body to `/worker/response` through the real Hono handler. */
async function postWorkerResponse(
  body: unknown,
  opts?: {
    tracker?: { updateDeploymentActivity: (d: string) => Promise<void> };
    omitTokenOrganizationId?: boolean;
    omitTokenAgentId?: boolean;
    omitTokenConnectionId?: boolean;
    omitTokenResponseThreadId?: boolean;
    tokenRunId?: number;
  }
): Promise<Response> {
  const gateway = makeGateway();
  if (opts?.tracker) gateway.setDeploymentActivityTracker(opts.tracker);
  return await gateway.getApp().request("/response", {
    method: "POST",
    headers: {
      authorization: `Bearer ${mintToken({
        omitOrganizationId: opts?.omitTokenOrganizationId,
        omitAgentId: opts?.omitTokenAgentId,
        omitConnectionId: opts?.omitTokenConnectionId,
        omitResponseThreadId: opts?.omitTokenResponseThreadId,
        runId: opts?.tokenRunId,
      })}`,
      host: "gateway.example.com",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface StoredThreadResponse {
  conversationId?: string;
  userId?: string;
  channelId?: string;
  teamId?: string;
  platform?: string;
  organizationId?: string;
  platformMetadata?: Record<string, unknown>;
  customEvent?: { data?: { event?: Record<string, unknown> } };
}

/** How many live turn markers exist for the test deployment. */
async function liveMarkerCount(): Promise<number> {
  const rows = await getDb()<{ n: string }>`
    SELECT count(*)::text AS n FROM public.runs
    WHERE queue_name = 'internal:turn_timeout'
      AND status = 'pending'
      AND action_input->>'deploymentName' = ${DEPLOYMENT}
  `;
  return Number(rows[0]?.n ?? "0");
}

async function latestThreadResponse(): Promise<{
  input: StoredThreadResponse;
  organizationId: string | null;
}> {
  const rows = await getDb()<{
    action_input: StoredThreadResponse;
    organization_id: string | null;
  }>`
    SELECT action_input, organization_id
    FROM public.runs
    WHERE queue_name = 'thread_response'
    ORDER BY id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error("thread_response row not found");
  return { input: row.action_input, organizationId: row.organization_id };
}

/** Read the marker's `run_at` (epoch ms) for the live turn, or null if gone. */
async function markerRunAtMs(): Promise<number | null> {
  const rows = await getDb()<{ run_at: Date }>`
    SELECT run_at FROM public.runs
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
      AND action_input->>'deploymentName' = ${DEPLOYMENT}
      AND action_input->>'messageId' = 'm1'
    LIMIT 1`;
  return rows[0] ? new Date(rows[0].run_at).getTime() : null;
}

/** Force the marker's deadline to a known PAST instant so any extend is
 *  observable as a forward jump (and so the marker counts as lapsed). */
async function expireMarker(): Promise<number> {
  await getDb()`
    UPDATE public.runs SET run_at = now() - interval '5 minutes'
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}`;
  const at = await markerRunAtMs();
  if (at === null) throw new Error("marker missing after expire");
  return at;
}

describe("POST /worker/response — authoritative tenant", () => {
  test("the authenticated worker token overrides spoofed body routing identity", async () => {
    const res = await postWorkerResponse({
      messageId: "m1",
      conversationId: "conv-spoofed",
      userId: "user-spoofed",
      channelId: "chan-spoofed",
      teamId: "team-spoofed",
      platform: "telegram",
      delta: "hello",
      organizationId: "org-spoofed",
      platformMetadata: {
        connectionId: "connection-spoofed",
        agentId: "agent-spoofed",
        organizationId: "org-spoofed",
        chatId: "chat-spoofed",
        responseChannel: "response-spoofed",
        responseThreadId: "thread-spoofed",
        teamId: "team-spoofed",
        source: "interactive-spoofed",
        senderId: "sender-spoofed",
      },
      customEvent: {
        name: "chat-interaction",
        data: {
          eventName: "question:created",
          event: {
            id: "q-1",
            userId: "user-spoofed",
            conversationId: "conv-spoofed",
            channelId: "chan-spoofed",
            teamId: "team-spoofed",
            platform: "telegram",
            connectionId: "connection-spoofed",
            agentId: "agent-spoofed",
            organizationId: "org-spoofed",
            source: "interactive-spoofed",
            question: "Proceed?",
          },
        },
      },
    });
    expect(res.status).toBe(200);

    const { input } = await latestThreadResponse();
    expect(input.organizationId).toBe("org-1");
    expect(input).toMatchObject({
      conversationId: "conv-1",
      userId: "user-1",
      channelId: "chan-1",
      teamId: "team-1",
      platform: "slack",
    });
    expect(input.platformMetadata).toMatchObject({
      connectionId: "connection-1",
      agentId: "agent-1",
      organizationId: "org-1",
      chatId: "chan-1",
      responseChannel: "chan-1",
      responseThreadId: "slack:chan-1:conv-1",
      teamId: "team-1",
      source: "automation-run",
      senderId: "user-1",
    });
    expect(input.customEvent?.data?.event).toMatchObject({
      id: "q-1",
      userId: "user-1",
      conversationId: "conv-1",
      channelId: "chan-1",
      teamId: "team-1",
      platform: "slack",
      connectionId: "connection-1",
      agentId: "agent-1",
      organizationId: "org-1",
      source: "automation-run",
      question: "Proceed?",
    });
  });

  test("binds reply Automation routing to the signed turn row, not worker metadata", async () => {
    await armLiveTurn("m1");
    const trustedRunId = Number(
      await queue.send(`thread_message_${DEPLOYMENT}`, {
        userId: "user-1",
        conversationId: "conv-1",
        messageId: "m1",
        channelId: "chan-1",
        teamId: "team-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "slack",
        platformMetadata: { automationId: 41 },
      })
    );

    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-spoofed",
        error: "429 Limit Exhausted. Your limit will reset at 2026-08-04 06:00:00",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        platformMetadata: { automationId: 99 },
      },
      { tokenRunId: trustedRunId }
    );
    expect(res.status).toBe(200);

    const { input } = await latestThreadResponse();
    expect(input.platformMetadata?.automationId).toBe(41);
  });

  test("drops reply Automation routing when the signed turn row has no Automation", async () => {
    await armLiveTurn("m1");
    const trustedRunId = Number(
      await queue.send(`thread_message_${DEPLOYMENT}`, {
        userId: "user-1",
        conversationId: "conv-1",
        messageId: "m1",
        channelId: "chan-1",
        teamId: "team-1",
        agentId: "agent-1",
        organizationId: "org-1",
        platform: "slack",
        platformMetadata: {},
      })
    );

    const res = await postWorkerResponse(
      {
        messageId: "m1",
        error: "429 Limit Exhausted. Your limit will reset at 2026-08-04 06:00:00",
        errorCode: "PROVIDER_QUOTA_EXHAUSTED",
        platformMetadata: { automationId: 99 },
      },
      { tokenRunId: trustedRunId }
    );
    expect(res.status).toBe(200);

    const { input } = await latestThreadResponse();
    expect(input.platformMetadata?.automationId).toBeUndefined();
  });

  test("a terminal reply whose token carries no turn identity discharges nothing", async () => {
    // The marker is addressed by a DERIVED name, so a token missing any part of
    // the turn identity yields none — and `commitTerminalReply` gates delivery
    // on deleting that marker. Assert the reply is not committed rather than
    // committed against some other namespace: the discharge race is what stops
    // a second terminal event for the same turn.
    await armLiveTurn("m1");
    const res = await postWorkerResponse(
      { messageId: "m1", conversationId: "conv-1", error: "boom" },
      { omitTokenAgentId: true }
    );
    expect(res.status).toBe(200);
    await expect(latestThreadResponse()).rejects.toThrow(
      "thread_response row not found"
    );
    // And the marker is still live, so the sweep — not this reply — remains the
    // one thing that can terminalize the turn.
    expect(await liveMarkerCount()).toBe(1);
  });

  test("an orgless worker token cannot inject a body organization id", async () => {
    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        delta: "hello",
        organizationId: "org-spoofed",
      },
      { omitTokenOrganizationId: true }
    );
    expect(res.status).toBe(200);

    const row = await latestThreadResponse();
    expect(row.input.organizationId).toBeUndefined();
    expect(row.organizationId).toBeNull();
  });

  test("a token without a connection cannot inject chat routing metadata", async () => {
    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        delta: "hello",
        platformMetadata: {
          connectionId: "connection-spoofed",
          agentId: "agent-spoofed",
          organizationId: "org-spoofed",
          chatId: "C-SPOOFED",
          responseThreadId: "thread-spoofed",
          senderId: "sender-spoofed",
          automationId: 99,
        },
        customEvent: {
          name: "chat-interaction",
          data: {
            eventName: "question:created",
            event: {
              id: "q-2",
              connectionId: "connection-spoofed",
              channelId: "chan-spoofed",
              conversationId: "conv-spoofed",
              userId: "user-spoofed",
            },
          },
        },
      },
      { omitTokenConnectionId: true, omitTokenResponseThreadId: true }
    );
    expect(res.status).toBe(200);

    const { input } = await latestThreadResponse();
    expect(input.platformMetadata).toEqual({
      agentId: "agent-1",
      organizationId: "org-1",
      chatId: "chan-1",
      responseChannel: "chan-1",
      teamId: "team-1",
      source: "automation-run",
      senderId: "user-1",
    });
    expect(
      input.customEvent?.data?.event?.connectionId
    ).toBeUndefined();
    expect(input.customEvent?.data?.event).toMatchObject({
      id: "q-2",
      userId: "user-1",
      conversationId: "conv-1",
      channelId: "chan-1",
      teamId: "team-1",
      platform: "slack",
      agentId: "agent-1",
      organizationId: "org-1",
      source: "automation-run",
    });
  });
});

describe("POST /worker/response — turn-liveness deadline (#14)", () => {
  test("a 20s status_update (no `received`) extends the deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();
    expect(lapsedAt).toBeLessThan(Date.now()); // sanity: deadline is in the past

    // A status_update response carries `statusUpdate` and NO `received` flag —
    // exactly what GatewayIntegration.sendStatusUpdate emits every 20s.
    const res = await postWorkerResponse({
      messageId: "m1",
      conversationId: "conv-1",
      statusUpdate: { elapsedSeconds: 40, state: "working" },
    });
    expect(res.status).toBe(200);

    // The extend is best-effort/fire-and-forget; poll briefly for the UPDATE to
    // land rather than racing it.
    let after: number | null = null;
    for (let i = 0; i < 50; i++) {
      after = await markerRunAtMs();
      if (after !== null && after > lapsedAt + 1000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(after).not.toBeNull();
    // The deadline must have jumped forward into the FUTURE — before the fix a
    // status_update never extended, so run_at would stay at `lapsedAt` (past).
    expect(after!).toBeGreaterThan(Date.now());
    expect(after!).toBeGreaterThan(lapsedAt);
  });

  test("a delivery/heartbeat ACK (`received`) still extends the deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();

    const res = await postWorkerResponse({ received: true, heartbeat: true });
    expect(res.status).toBe(200);

    let after: number | null = null;
    for (let i = 0; i < 50; i++) {
      after = await markerRunAtMs();
      if (after !== null && after > lapsedAt + 1000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(after!).toBeGreaterThan(Date.now());
  });
});

describe("POST /worker/response — deployment idle clock (#12)", () => {
  test("a status_update refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (d: string) => {
        touched.push(d);
      },
    };

    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        statusUpdate: { elapsedSeconds: 40, state: "working" },
      },
      { tracker }
    );
    expect(res.status).toBe(200);

    // The handler awaits nothing on the tracker (fire-and-forget); give the
    // microtask a tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(touched).toContain(DEPLOYMENT);
  });

  test("a delivery ACK (not a heartbeat) refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (d: string) => {
        touched.push(d);
      },
    };

    // A delivery receipt (received, no `heartbeat` flag) is real worker
    // progress and must still refresh the idle clock — only pure heartbeats
    // are excluded.
    const res = await postWorkerResponse({ received: true }, { tracker });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 20));
    expect(touched).toContain(DEPLOYMENT);
  });

  test("heartbeat-only ACK does not refresh the idle clock; real work does", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (d: string) => {
        touched.push(d);
      },
    };

    // A pure heartbeat ACK must not pin the deployment as active — otherwise
    // WORKER_IDLE_CLEANUP_MINUTES never reaps a warm idle child.
    const heartbeatRes = await postWorkerResponse(
      { received: true, heartbeat: true },
      { tracker }
    );
    expect(heartbeatRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(touched).not.toContain(DEPLOYMENT);

    // Non-heartbeat work still refreshes the idle clock (mid-turn safety).
    const statusRes = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        statusUpdate: { elapsedSeconds: 40, state: "working" },
      },
      { tracker }
    );
    expect(statusRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(touched).toContain(DEPLOYMENT);
  });
});
