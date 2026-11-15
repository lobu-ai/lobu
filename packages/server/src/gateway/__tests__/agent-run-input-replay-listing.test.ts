/**
 * `listPendingAgentRunInputs` against real rows: which turns does a
 * reconnecting worker's `registerWorker` replay re-enqueue?
 *
 * Replay restores missing delivery rows and failed delivery attempts while
 * the worker was offline. Any live receipt — the original job pending a
 * dispatch-gate deferral retry, the gate's own claimed job held across a
 * recycle, or a completed delivery receipt for a turn the reconnecting worker
 * is still running — means the queue owns the turn, and replaying over it
 * delivers the same turn TWICE. The recycle path makes this concrete: it
 * rebuilds the worker while holding its claimed job, so without the queue-row
 * predicate every recycle double-delivers the very turn that triggered it.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import { listPendingAgentRunInputs } from "../orchestration/agent-run-input.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

const DEPLOYMENT = "deploy-replay";
const ORG = "org-replay-listing";

async function seedInput(messageId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, 'Replay Listing', ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  const [run] = await sql<{ id: number }>`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES ('chat_message', 'messages', 'completed', now(), ${sql.json({})})
    RETURNING id
  `;
  await sql`
    INSERT INTO public.agent_run_input (
      organization_id, message_id, agent_id, conversation_id,
      deployment_name, run_id, payload, token_claims
    ) VALUES (
      ${ORG}, ${messageId}, 'agent-1', 'conv-1',
      ${DEPLOYMENT}, ${run?.id ?? null},
      ${sql.json({ messageId })}, ${sql.json({})}
    )
  `;
}

/** Live turn-liveness marker — required for an input to be replay-eligible. */
async function seedMarker(messageId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES (
      'internal', 'internal:turn_timeout', 'pending',
      now() + interval '60 seconds',
      ${sql.json({ deploymentName: DEPLOYMENT, messageId })}
    )
  `;
}

async function seedThreadJob(params: {
  messageId: string;
  status: string;
  deploymentName?: string;
}): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO runs (run_type, queue_name, status, run_at, action_input)
    VALUES (
      'chat_message',
      ${`thread_message_${params.deploymentName ?? DEPLOYMENT}`},
      ${params.status}, now(),
      ${sql.json({ messageId: params.messageId })}
    )
  `;
}

async function listedMessageIds(): Promise<string[]> {
  const rows = await listPendingAgentRunInputs(DEPLOYMENT);
  return rows.map((r) => (r.payload as { messageId?: string }).messageId ?? "");
}

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("listPendingAgentRunInputs queue-row predicate", () => {
  test("an input whose queue row is gone is replayed — the lost-job case", async () => {
    await seedInput("m-lost");
    await seedMarker("m-lost");

    expect(await listedMessageIds()).toEqual(["m-lost"]);
  });

  test("REGRESSION: a pending original job suppresses the replay", async () => {
    // The dispatch gate deferred this turn (threw → the job went back to
    // pending with a retry delay). Replaying it as a second row would deliver
    // the turn twice once the fresh worker connects.
    await seedInput("m-retrying");
    await seedMarker("m-retrying");
    await seedThreadJob({ messageId: "m-retrying", status: "pending" });

    expect(await listedMessageIds()).toEqual([]);
  });

  test("REGRESSION: the claimed job held across a recycle suppresses the replay", async () => {
    // recycleWorkerDeployment runs INSIDE the queue handler that claimed this
    // turn's job; the row stays claimed while the fresh worker registers.
    await seedInput("m-claimed");
    await seedMarker("m-claimed");
    await seedThreadJob({ messageId: "m-claimed", status: "claimed" });

    expect(await listedMessageIds()).toEqual([]);
  });

  test("a delivered turn (completed row) is not replayed onto its live worker", async () => {
    // SSE flap mid-turn: the worker reconnects while RUNNING this turn. Its
    // delivery receipt is the record that the worker already holds it.
    await seedInput("m-running");
    await seedMarker("m-running");
    await seedThreadJob({ messageId: "m-running", status: "completed" });

    expect(await listedMessageIds()).toEqual([]);
  });

  test("REGRESSION: a failed (never-delivered) row does not suppress the replay", async () => {
    // Ack-on-delivery marks delivered rows completed, so `failed` can only
    // mean the retry budget died with the turn never delivered — the queue
    // has given the turn up and no longer owns it. Suppressing here would
    // strand a marker-live turn (never delivered, never terminalized, marker
    // kept fresh by the busy worker's heartbeats) until the sweep.
    await seedInput("m-failed");
    await seedMarker("m-failed");
    await seedThreadJob({ messageId: "m-failed", status: "failed" });

    expect(await listedMessageIds()).toEqual(["m-failed"]);
  });

  test("another deployment's queue row does not suppress OUR replay", async () => {
    // Platform message ids (e.g. Telegram) are only unique per chat; the
    // predicate must be scoped to this deployment's queue.
    await seedInput("m-shared");
    await seedMarker("m-shared");
    await seedThreadJob({
      messageId: "m-shared",
      status: "pending",
      deploymentName: "deploy-somebody-else",
    });

    expect(await listedMessageIds()).toEqual(["m-shared"]);
  });

  test("no live marker means no replay, row or not", async () => {
    // Terminalized/swept turns must stay dead — the marker election already
    // emitted their terminal event.
    await seedInput("m-swept");

    expect(await listedMessageIds()).toEqual([]);
  });
});
