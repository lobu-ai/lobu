/**
 * A heartbeating isolate turn must keep its turn-liveness marker alive.
 *
 * `MessageConsumer` arms a marker per dispatched turn with a fixed
 * `TURN_DEFAULT_DEADLINE_MS` (60s) deadline. The isolate lane's heartbeat
 * refreshes `runs.last_heartbeat_at`, which the RUN reaper reads — but the
 * marker carries its OWN `run_at`, and the subprocess lane was the only thing
 * that pushed it forward (`extendTurnDeadlines` from `/worker/response`, a
 * route the isolate lane never calls). Without an extension every turn longer
 * than 60s collected a spurious `WORKER_UNRESPONSIVE` while it was still
 * working.
 *
 * The marker is deliberately NOT discharged at terminal delivery on this lane:
 * `hasLiveTurnForMessage` gates worker token refresh on it, so retiring it
 * inside `insertAgentTurnResponse` cuts off a turn that is still streaming.
 * See the note on `dischargeTurnMarkers`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentErrorCode } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import {
  armTurnTimeout,
  sweepExpiredTurns,
} from "../orchestration/turn-liveness.js";
import { extendHeartbeatedTurnMarker } from "../../runs/agent-turn-inputs.js";
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
});
