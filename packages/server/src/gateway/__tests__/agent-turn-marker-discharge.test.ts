/**
 * The turn-liveness marker's two obligations on the isolate lane.
 *
 * `MessageConsumer` arms one marker per dispatched turn — the client's only
 * promise of a terminal event — with a fixed `TURN_DEFAULT_DEADLINE_MS` (60s)
 * deadline, and `sweepExpiredTurns` turns a lapsed marker into a terminal
 * WORKER_UNRESPONSIVE. Two things therefore have to happen, and the
 * subprocess lane did both from `/worker/response`, a route this lane never
 * calls:
 *
 *  1. WHILE the turn runs, each heartbeat pushes the deadline forward.
 *     Without it any turn over 60s was failed mid-flight while working.
 *  2. AT terminal delivery, the marker is retired in the reply's own
 *     transaction. Without it heartbeats stop, the deadline lapses, and the
 *     sweep publishes a second, contradictory error to a user who already
 *     saw the reply.
 *
 * Retiring it EARLIER than terminal is a bug in the other direction:
 * `hasLiveTurnForMessage` gates worker token refresh on this marker, so a
 * discharge while the guest is still streaming denies its next refresh and
 * the reply arrives empty. Both `insertAgentTurnResponse` callers set the run
 * terminal in the same transaction first, which is what makes it safe there.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentErrorCode } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  armTurnTimeout,
  sweepExpiredTurns,
} from "../orchestration/turn-liveness.js";
import {
  extendHeartbeatedTurnMarker,
  insertAgentTurnResponse,
} from "../../runs/agent-turn-inputs.js";
import { generateDeploymentName } from "../orchestration/deployment-identity.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const ORG = "org-marker-discharge";
const AGENT = "agent-marker-discharge";
const CHANNEL = "chan-discharge";
const USER = "user-discharge";

let queue: RunsQueue;

/** The identity both the arming and completion sites derive the key from. */
const identity = (conversationId: string) => ({
  organizationId: ORG,
  agentId: AGENT,
  userId: USER,
  platform: "api",
  channelId: CHANNEL,
  conversationId,
});

function nativeRun(conversationId: string, messageId: string) {
  return {
    id: 1,
    organization_id: ORG,
    action_input: {
      turn: {
        agent_id: AGENT,
        conversation_id: conversationId,
        message_id: messageId,
      },
      reply: {
        message_id: messageId,
        channel_id: CHANNEL,
        user_id: USER,
        team_id: "api",
        platform: "api",
        platform_metadata: {},
      },
    },
  };
}

async function armedMarkers(): Promise<number> {
  const rows = await getDb()<{ n: number }>`
    SELECT count(*)::int AS n FROM public.runs
    WHERE status = 'pending'
      AND run_type = 'internal'
      AND queue_name = 'internal:turn_timeout'`;
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
  queue = new RunsQueue();
  await queue.start();
});

beforeEach(async () => {
  await resetTestDatabase();
  await getDb()`
    INSERT INTO public.organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING`;
});

describe("isolate-lane heartbeat vs the turn-liveness marker", () => {
  test("a heartbeating long turn keeps its marker alive past the deadline", async () => {
    const conversationId = "conv-long";
    const messageId = "m-long";
    const deploymentName = generateDeploymentName(identity(conversationId));
    await armTurnTimeout(queue, {
      messageId,
      channelId: CHANNEL,
      conversationId,
      userId: USER,
      platform: "api",
      deploymentName,
      organizationId: ORG,
    });

    // The turn's own run row, as the worker's heartbeat will find it.
    const [row] = await getDb()<{ id: number }>`
      INSERT INTO public.runs (organization_id, run_type, status, queue_name, action_input)
      VALUES (${ORG}, 'agent_turn', 'running', 'agent_turn',
        ${getDb().json({
          turn: { agent_id: AGENT, conversation_id: conversationId, message_id: messageId },
          reply: {
            message_id: messageId, channel_id: CHANNEL, user_id: USER,
            team_id: "api", platform: "api", platform_metadata: {},
          },
        } as never)})
      RETURNING id`;

    // Age the marker past its deadline, as a >60s turn would.
    await getDb()`
      UPDATE public.runs SET run_at = now() - interval '1 minute'
      WHERE status = 'pending' AND run_type = 'internal'
        AND queue_name = 'internal:turn_timeout'`;

    // The heartbeat must push it forward again.
    await extendHeartbeatedTurnMarker(Number(row!.id));

    expect(await sweepExpiredTurns(AgentErrorCode.WORKER_UNRESPONSIVE)).toBe(0);
    expect(await armedMarkers()).toBe(1);
  });

  test("a REPLIED turn emits no second WORKER_UNRESPONSIVE once heartbeats stop", async () => {
    // The turn is over, so heartbeats stop and nothing renews the marker. If
    // terminal delivery does not retire it, its deadline lapses and the sweep
    // publishes a SECOND, contradictory terminal error to a user who already
    // saw the reply.
    const conversationId = "conv-replied";
    const messageId = "m-replied";
    await armTurnTimeout(queue, {
      messageId,
      channelId: CHANNEL,
      conversationId,
      userId: USER,
      platform: "api",
      deploymentName: generateDeploymentName(identity(conversationId)),
      organizationId: ORG,
    });

    await insertAgentTurnResponse(
      getDb() as never,
      {
        id: 1,
        organization_id: ORG,
        action_input: {
          turn: {
            agent_id: AGENT,
            conversation_id: conversationId,
            message_id: messageId,
          },
          reply: {
            message_id: messageId,
            channel_id: CHANNEL,
            user_id: USER,
            team_id: "api",
            platform: "api",
            platform_metadata: {},
          },
        },
      } as never,
      { finalText: "the reply the user already saw" },
    );

    // Retired at delivery, not merely "not yet due".
    expect(await armedMarkers()).toBe(0);

    await getDb()`
      UPDATE public.runs SET run_at = now() - interval '1 minute'
      WHERE status = 'pending' AND run_type = 'internal'
        AND queue_name = 'internal:turn_timeout'`;
    expect(await sweepExpiredTurns(AgentErrorCode.WORKER_UNRESPONSIVE)).toBe(0);

    const errors = await getDb()<{ n: number }>`
      SELECT count(*)::int AS n FROM public.runs
      WHERE run_type = 'chat_message'
        AND action_input::text LIKE ${"%" + AgentErrorCode.WORKER_UNRESPONSIVE + "%"}`;
    expect(errors[0]!.n).toBe(0);
  });
});
