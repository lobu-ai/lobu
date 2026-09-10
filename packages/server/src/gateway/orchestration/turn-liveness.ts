/**
 * Turn liveness — surfaces a terminal error to the client when a worker fails
 * to produce a reply (crash, hang, or pod death), so the SSE/CLI never hangs
 * forever and never receives a silent `complete`.
 *
 * ## The obligation, as a durable election record
 *
 * Every dispatched turn owes the client exactly one terminal event for its
 * `messageId`. Between delivery-receipt (when the `thread_message` run already
 * completes) and the worker's reply there is otherwise NO durable record that
 * the turn is still owed an answer — that gap is what lets a dead worker hang
 * the stream. We close it by writing a **passive marker row** into `public.runs`
 * on a queue with NO consumer (`internal:turn_timeout`): it is never claimed as
 * a job, so the RunsQueue status machinery never touches it. The marker's
 * EXISTENCE is the obligation; deleting it (`DELETE … RETURNING`) is a
 * first-writer-wins election — a row can be deleted exactly once, and the
 * deleter emits the terminal `error` in the SAME transaction, so the emit is
 * atomic and crash-safe (the marker survives a mid-emit crash and a later sweep
 * retries).
 *
 * ## Detection (two paths, one emit)
 *  - Fast path (instant): the owning pod observes `child.once("exit"/"error")`
 *    and calls {@link failTurnsForDeployment}. Covers the common case (bad
 *    provider key, OOM, `exit 1`).
 *  - Backstop (deadline): {@link sweepExpiredTurns} runs periodically on every
 *    replica and fails markers whose deadline has lapsed. Covers a hung worker
 *    (alive, never replies) and a worker-pod death (the marker outlives the pod
 *    and another replica sweeps it). The deadline is pushed forward
 *    ({@link extendTurnDeadlines}) by any worker-driven liveness signal —
 *    primarily the worker's 20s status_update, plus the 30s SSE-ping ACK and
 *    delivery receipts — so a live-but-slow worker is never falsely failed,
 *    while a silent one lapses.
 *
 *    That status_update proves the process is ALIVE, not that the turn is
 *    PROGRESSING (it is an unconditional `setInterval` in `session-runner.ts`),
 *    so on its own it did NOT cover the hung-but-heartbeating worker this
 *    backstop names: a turn wedged after a terminal provider error renewed its
 *    own deadline every 20s and hung the client indefinitely. The gap is closed
 *    by {@link markTurnProviderFailed}, which withdraws the extension once the
 *    proxy has seen the provider answer that turn terminally.
 *
 * ## Multi-replica
 * Arming/extending/discharging all happen on the worker's owning pod (worker
 * child, dispatch, and `handleWorkerResponse` are co-located there). The marker
 * + emit live in shared Postgres, so any replica can sweep, and the emitted
 * `thread_response{error}` is owner-gated in `routeToRenderer` to reach the pod
 * that holds the client's SSE.
 */

import {
	AGENT_ERRORS,
	AgentErrorCode,
	createLogger,
	getErrorMessage,
} from "@lobu/core";
import { intervals } from "../../config/intervals.js";
import { getDb, type DbClient } from "../../db/client.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import { TERMINAL_DELIVERY_SEND_OPTS } from "../infrastructure/queue/index.js";
import { completeAgentRunInputs } from "./agent-run-input.js";

const logger = createLogger("turn-liveness");

/** Queue name for the passive marker rows. Has NO registered consumer — the
 *  rows are never claimed as jobs; they are swept directly by this module. The
 *  `internal:` prefix maps to run_type `internal` (classifyQueue), keeping them
 *  out of the chat_message lane's stats/sweeps. */
const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

/** thread_response NOTIFY channel — must match RunsQueue's `runs_lobu:<queue>`
 *  so the UnifiedThreadResponseConsumer wakes immediately on an emitted error. */
const THREAD_RESPONSE_CHANNEL = "runs_lobu:thread_response";

// The execution deadline and sweep cadence live in config/intervals.ts
// (`turnDefaultDeadlineMs` / `turnLivenessSweepIntervalMs`), env-overridable.
// A turn that has not started yet carries the worker-claim horizon on top —
// see {@link admissionDeadlineMs}.

/** Routing needed to build the terminal `thread_response{error}` for a turn,
 *  stored as the marker's `action_input`. */
export interface TurnRouting {
  messageId: string;
  channelId?: string;
  conversationId?: string;
  userId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  deploymentName: string;
  organizationId?: string;
}

/**
 * Narrow a JSONB `action_input` read back from Postgres (typed `unknown` at the
 * DB boundary) to {@link TurnRouting}. `armTurnTimeout` is the only writer of
 * these rows, but the value is still `unknown` on the way out — validate rather
 * than blind-cast so a malformed row is skipped, never used to build a
 * `thread_response` with `undefined` fields. `messageId` is the load-bearing
 * field (discharge key + `processedMessageIds`), so it gates the narrow.
 */
function asTurnRouting(value: unknown): TurnRouting | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.messageId !== "string" || v.messageId.length === 0) return null;
  if (typeof v.deploymentName !== "string") return null;
  return v as unknown as TurnRouting;
}

/** The marker's `action_input` as the sweep reads it back. */
type TurnMarkerInput = unknown;

/**
 * The provider-failure code recorded on a marker by {@link markTurnProviderFailed},
 * or null when this turn was not ended by a provider answer.
 *
 * Validated against the `AgentErrorCode` enum rather than cast: the value is a
 * jsonb field on a `runs` row, so it is DATA, and a bad one must degrade to the
 * caller's default rather than reach `AGENT_ERRORS[code]` and render a broken
 * (or attacker-chosen) CTA.
 */
function providerFailureCode(value: TurnMarkerInput): AgentErrorCode | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>).providerFailedCode;
  if (typeof raw !== "string") return null;
  return (Object.values(AgentErrorCode) as string[]).includes(raw)
    ? (raw as AgentErrorCode)
    : null;
}

/**
 * Build the marker's globally-unique key. `messageId` alone is NOT global —
 * platform message IDs (e.g. Telegram) are per-chat and API callers can supply
 * their own — so two concurrent turns in different conversations could collide
 * (one suppresses the other's marker, or a discharge hits the wrong turn).
 * `deploymentName` is unique per conversation, so `deploymentName:messageId` is
 * globally unique.
 */
function turnMarkerKey(deploymentName: string, messageId: string): string {
  return `${deploymentName}:${messageId}`;
}

/**
 * Marker deadline for a turn that has not started executing yet: the reaper's
 * claim horizon plus one execution window.
 *
 * Arming happens BEFORE admission, and a run still waiting for a worker slot
 * has nothing that could heartbeat it — so on the bare execution deadline a
 * turn queued behind a busy worker was failed as WORKER_UNRESPONSIVE before any
 * worker had looked at it. That wait is already bounded elsewhere:
 * `sweepStaleAgentTurnRuns` terminalizes a claim-eligible `agent_turn` still
 * `pending` after `runsReaperStaleAfterSeconds` as WORKER_STARTUP_FAILED, and
 * that delivery discharges this marker. So the marker only has to outlast that
 * claim horizon by one execution window to stay the backstop instead of the
 * first thing to fire — and the client gets the precise "never started" code
 * rather than the generic unresponsive-worker one. Once the worker heartbeats,
 * {@link extendTurnDeadlines} drops the marker to the shorter execution
 * deadline.
 */
function admissionDeadlineMs(): number {
  return (
    intervals.runsReaperStaleAfterSeconds * 1000 + intervals.turnDefaultDeadlineMs
  );
}

/**
 * Arm the turn-liveness marker at dispatch. Idempotent per (deployment,
 * messageId) via the partial-unique `idempotency_key`, so a re-dispatched
 * message doesn't double-arm.
 *
 * **Fail-closed:** throws if the marker can't be persisted. The marker is the
 * ONLY durable record that this turn owes the client a terminal event — if it's
 * missing, a later worker crash/hang falls back to the silent hang this module
 * exists to prevent. The caller arms before enqueueing to the worker, so a
 * throw aborts dispatch and the `messages` run retries the whole turn (the arm
 * is idempotent), rather than dispatching an unprotected turn.
 */
export async function armTurnTimeout(
  queue: IMessageQueue,
  routing: TurnRouting,
  deadlineMs: number = admissionDeadlineMs()
): Promise<void> {
  await queue.createQueue(TURN_TIMEOUT_QUEUE);
  await queue.send(TURN_TIMEOUT_QUEUE, routing, {
    delayMs: deadlineMs,
    singletonKey: turnMarkerKey(routing.deploymentName, routing.messageId),
  });
}

/**
 * Restart a released follower's admission clock, in the same transaction as the
 * queue handoff that made it claimable (`releaseNextAgentTurn`).
 *
 * A queued follower shares its deployment with the owner blocking it, so every
 * owner heartbeat collapsed its marker to the execution deadline. That is
 * harmless while the owner keeps beating, but it leaves the follower only that
 * window to be claimed once the owner is gone — and a blocked follower is not
 * claim-eligible, so `sweepStaleAgentTurnRuns` never covered it either.
 */
export async function resetTurnAdmissionDeadline(
  sql: DbClient,
  deploymentName: string,
  messageId: string
): Promise<void> {
  const deadlineSec = Math.ceil(admissionDeadlineMs() / 1000);
  await sql`UPDATE public.runs
    SET run_at = now() + (${deadlineSec}::int * interval '1 second')
    WHERE idempotency_key = ${turnMarkerKey(deploymentName, messageId)}
      AND status = 'pending' AND run_type = 'internal'
      AND queue_name = ${TURN_TIMEOUT_QUEUE}`;
}

/**
 * Push the deadline forward for all in-flight turns of a deployment. Called on
 * any worker-driven liveness signal — primarily the worker's 20s status_update,
 * plus the 30s SSE-ping ACK and delivery receipts — so a live but slow worker
 * keeps its markers fresh while a silent one lapses.
 */
export async function extendTurnDeadlines(
  deploymentName: string,
  deadlineMs: number = intervals.turnDefaultDeadlineMs
): Promise<void> {
  try {
    const sql = getDb();
    const deadlineSec = Math.ceil(deadlineMs / 1000);
    // status + run_type match the partial predicate of `runs_lobu_claim_idx`
    // (WHERE status='pending' AND run_type IN (…)) and its leading column, so
    // this uses the index (run_type, queue_name, …) rather than scanning runs.
    await sql`
      UPDATE public.runs
      SET run_at = now() + (${deadlineSec}::int * interval '1 second')
      WHERE status = 'pending'
        AND run_type = 'internal'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
        -- A turn whose provider call terminally failed no longer earns an
        -- extension. Its worker is still heartbeating (the 20s status_update is
        -- an unconditional setInterval, not a progress signal), so without this
        -- predicate the wedged turn renews its own deadline forever and the
        -- sweep -- the very backstop for "alive, never replies" -- can never
        -- fire. See markTurnProviderFailed.
        AND NOT COALESCE((action_input->>'providerFailed')::boolean, false)
    `;
  } catch (err) {
    // Non-throwing by design (a heartbeat ACK must never fail the worker),
    // but loud: if extends keep failing, the markers' deadlines lapse and the
    // sweep emits a terminal error for a turn whose worker is still alive.
    // Log everything needed to tie a later spurious "worker stopped
    // responding" back to this failure.
    logger.error(
      {
        deploymentName,
        deadlineMs,
        queue: TURN_TIMEOUT_QUEUE,
        err: getErrorMessage(err),
      },
      "Failed to extend turn-timeout deadline — in-flight turns for this deployment may be falsely failed by the sweep if extends keep failing"
    );
  }
}

/**
 * Stop a deployment's in-flight turns from renewing their own deadlines, after
 * the gateway proxy has seen the provider answer that turn terminally
 * (quota/auth — see `classifyProviderHealthStatus`).
 *
 * **Why this exists.** `pi-ai` collapses a provider failure before the worker
 * runtime sees a status, and in the wedged case the turn never terminalizes at
 * all: exactly one upstream request, a 429, and then the session sits emitting
 * its 20s `status_update` forever. That status_update is an unconditional
 * `setInterval` in `session-runner.ts` — it means "the process is alive", NOT
 * "the turn is progressing" — but `extendTurnDeadlines` treated it as liveness,
 * so the turn pushed its own 60s deadline out indefinitely and the client hung
 * with no terminal event. Reproduced in prod: 240s and 12 heartbeats after a
 * single 429, still no answer.
 *
 * **Why a flag and not a kill.** The proxy cannot know whether the SDK will
 * recover: the OpenAI client retries (default `maxRetries: 2`, honouring
 * `Retry-After`) and a later attempt on the same turn may well succeed. Failing
 * the turn here would kill turns that were about to work. Instead we only
 * withdraw the *extension* — the turn keeps whatever deadline it already had
 * (at most `turnDefaultDeadlineMs` from its last extension, or the longer
 * arming deadline when no extension has landed yet), which normally
 * outlasts the SDK's short `Retry-After` backoff. If a retry succeeds the
 * worker resumes real progress and {@link clearTurnProviderFailed} re-arms
 * extension; if none does, the marker lapses and `sweepExpiredTurns` emits a
 * terminal error carrying `code` — so the client is told the PROVIDER failed
 * (e.g. `PROVIDER_QUOTA_EXHAUSTED`, which resolves to a real CTA) rather than
 * the generic `WORKER_UNRESPONSIVE` it would get for a merely silent worker.
 * `reason` rides along on the marker (`providerFailedReason`) for diagnosis.
 *
 * Best-effort and non-throwing, like `extendTurnDeadlines`: this must never fail
 * a user's inference call. Losing the write costs only the prompt failure — the
 * turn reverts to the pre-existing hang, never to a wrongly-killed turn.
 */
export async function markTurnProviderFailed(
  deploymentName: string,
  code: AgentErrorCode,
  reason: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET action_input = action_input
        || jsonb_build_object(
             'providerFailed', true,
             'providerFailedCode', ${code}::text,
             'providerFailedReason', ${reason}::text
           )
      WHERE status = 'pending'
        AND run_type = 'internal'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
        AND NOT COALESCE((action_input->>'providerFailed')::boolean, false)
    `;
  } catch (err) {
    logger.error(
      {
        deploymentName,
        reason,
        queue: TURN_TIMEOUT_QUEUE,
        err: getErrorMessage(err),
      },
      "Failed to mark turn provider-failed — a wedged turn on this deployment may keep extending its own deadline and hang the client"
    );
  }
}

/**
 * Re-arm deadline extension for a deployment's in-flight turns, called when a
 * proxied request to the same provider succeeds again. This is what makes
 * {@link markTurnProviderFailed} safe against the SDK's own retries: a 429
 * followed by a successful retry clears the flag, so a turn that recovers
 * before its deadline lapses is not failed for an error it got past.
 */
export async function clearTurnProviderFailed(
  deploymentName: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET action_input = ((action_input - 'providerFailed')
        - 'providerFailedCode') - 'providerFailedReason'
      WHERE status = 'pending'
        AND run_type = 'internal'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
        AND COALESCE((action_input->>'providerFailed')::boolean, false)
    `;
  } catch (err) {
    logger.error(
      {
        deploymentName,
        queue: TURN_TIMEOUT_QUEUE,
        err: getErrorMessage(err),
      },
      "Failed to clear turn provider-failed flag — a recovered turn may be failed by the sweep despite the provider working again"
    );
  }
}

/**
 * Is the SPECIFIC turn `(deploymentName, messageId)` still in-flight?
 *
 * The `internal:turn_timeout` marker (a pending `public.runs` row, armed at
 * dispatch keyed on `deploymentName:messageId`) is the authoritative cross-pod
 * record that a turn is live: every terminalization path deletes it
 * transactionally (first-writer-wins), and any worker-driven liveness signal
 * (primarily the worker's 20s status_update) pushes its `run_at` deadline
 * forward while the turn legitimately runs long — so any replica reads the true
 * state from shared `public.runs`.
 *
 * This is the liveness gate for worker-token refresh. The marker and the per-run
 * token are minted in the same dispatch (MessageConsumer.handleMessage) with the
 * same `messageId`, so a token refreshes only while ITS OWN turn is live — not
 * merely any turn on the deployment. Once the turn terminalizes the marker is
 * gone and refresh is denied: that deletion IS the revocation path, bounding the
 * leak window to how long the turn actually runs rather than an unbounded refresh
 * chain. It is deliberately NOT gated on the dispatching `runs.id` the token was
 * minted for — that `messages`-queue run completes the moment `handleMessage`
 * enqueues, long before the turn finishes.
 *
 * The `run_at > now()` predicate (not a bare `status = 'pending'`) excludes a
 * marker whose deadline has lapsed but which the periodic sweep hasn't deleted
 * yet — otherwise a hung/dead worker's turn would keep authorizing refreshes in
 * that gap, widening the leak past the deadline the heartbeat was meant to hold.
 */
export async function hasLiveTurnForMessage(
  deploymentName: string,
  messageId: string
): Promise<boolean> {
  const sql = getDb();
  // status + run_type + queue_name match the partial predicate / leading column
  // of `runs_lobu_claim_idx`, so this is an index probe, not a scan of the
  // 30-day `runs` retention. `run_at > now()` excludes lapsed-but-unswept
  // markers (see the deadline-predicate note above).
  const rows = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM public.runs
    WHERE status = 'pending'
      AND run_type = 'internal'
      AND queue_name = ${TURN_TIMEOUT_QUEUE}
      AND action_input->>'deploymentName' = ${deploymentName}
      AND action_input->>'messageId' = ${messageId}
      AND run_at > now()
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * True when ANY turn is still in flight on `deploymentName`.
 *
 * Deployment-scoped sibling of {@link hasLiveTurnForMessage}, for callers that
 * are about to tear a worker down and must not interrupt a turn already
 * running on it — recycling a deployment for a stale credential must never
 * SIGTERM a live run and cost the user a reply.
 *
 * Postgres-backed rather than pod-local, so it is correct with N replicas: the
 * turn may have been started by a different pod than the one deciding to
 * recycle.
 *
 * Same index probe and same `run_at > now()` deadline predicate as
 * {@link hasLiveTurnForMessage} — a lapsed-but-unswept marker is a dead worker,
 * not a live turn, and must not block a recycle forever.
 *
 * "In flight" here means a turn the worker has actually RECEIVED, and the
 * delivery receipt — a COMPLETED `thread_message_*` job row for the marker's
 * messageId (ack-on-delivery; retained ~30 days, far beyond any turn) — is the
 * only evidence consulted. A marker is armed at dispatch, BEFORE delivery, so
 * an armed-but-still-queued turn has a live marker with no completed row: not
 * in flight (the recycle gate runs while holding one such claimed job, and two
 * queued turns would otherwise each read the other's marker as "a running
 * turn" and defer each other forever). The absence of pending/claimed rows
 * must NOT be read as delivery instead: an SSE reconnect replays the durable
 * input of a still-RUNNING turn onto the queue (`registerWorker`), and that
 * pending replay row would masquerade as "undelivered" and let a recycle
 * SIGTERM the active worker.
 */
export async function hasLiveTurnForDeployment(
  deploymentName: string
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM public.runs m
    WHERE m.status = 'pending'
      AND m.run_type = 'internal'
      AND m.queue_name = ${TURN_TIMEOUT_QUEUE}
      AND m.action_input->>'deploymentName' = ${deploymentName}
      AND m.run_at > now()
      AND EXISTS (
        SELECT 1 FROM public.runs q
        WHERE q.status = 'completed'
          AND q.run_type = 'chat_message'
          AND q.queue_name = ${`thread_message_${deploymentName}`}
          AND q.action_input->>'messageId' = m.action_input->>'messageId'
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Is a sibling job that OUTRANKS `jobRunId` in claim order still pending on
 * the same queue?
 *
 * FIFO fence for the dispatch gate. `claimOne` orders claims by
 * (priority DESC, run_at ASC, id ASC), and a deferral retry pushes `run_at`
 * into the future — so after a recycle, the recycled head job re-enters the
 * queue BEHIND a younger sibling that kept its original `run_at`, and two
 * back-to-back user messages would reach the fresh worker in reversed order.
 * The fence re-derives claim rank from the columns that don't move: a sibling
 * at higher priority, or at the same priority with a smaller id (= enqueued
 * earlier), would have been claimed first were it not sitting out a retry
 * delay, so this job must defer to it. The top-ranked pending job never has
 * such a sibling, so the lane always makes progress.
 *
 * `expires_at` mirrors `claimOne`'s eligibility exactly: an expired row will
 * never be claimed again (the expired-pending cleanup deletes it and the
 * durable-input replay re-enqueues the turn), so it must not fence its
 * siblings forever.
 */
export async function hasOlderQueuedTurn(jobRunId: number): Promise<boolean> {
  const sql = getDb();
  // `me` is a primary-key probe; `sib` matches the partial predicate and
  // leading columns of `runs_lobu_claim_idx` (status='pending', run_type,
  // queue_name), so this never scans the 30-day runs retention.
  const rows = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM public.runs me
    JOIN public.runs sib ON sib.queue_name = me.queue_name
    WHERE me.id = ${jobRunId}
      AND sib.run_type = 'chat_message'
      AND sib.status = 'pending'
      AND (sib.expires_at IS NULL OR sib.expires_at > now())
      AND (
        sib.priority > me.priority
        OR (sib.priority = me.priority AND sib.id < me.id)
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Fast path: fail every in-flight turn of a deployment whose worker has just
 * died unexpectedly. Atomic per the `DELETE … RETURNING` election — only this
 * caller gets the rows, and the terminal error is enqueued in the same
 * transaction.
 *
 * @returns the number of turns failed (0 if the worker already replied / was a
 *          deliberate stop with nothing in flight).
 */
export async function failTurnsForDeployment(
  deploymentName: string,
  code: AgentErrorCode
): Promise<number> {
  try {
    const sql = getDb();
    const failed = await sql.begin(async (tx: DbClient) => {
      const rows = await tx<{ action_input: unknown }>`
        DELETE FROM public.runs
        WHERE status = 'pending'
          AND run_type = 'internal'
          AND queue_name = ${TURN_TIMEOUT_QUEUE}
          AND action_input->>'deploymentName' = ${deploymentName}
        RETURNING action_input
      `;
      let emitted = 0;
      for (const row of rows) {
        const routing = asTurnRouting(row.action_input);
        if (!routing) {
          // Unreachable for markers we write (arm always supplies messageId +
          // deploymentName). A row that fails this validation lacks the fields
          // needed to route a terminal event, so it's undeliverable — deleting
          // it (vs leaving it) is correct; leaving it would re-loop the sweep
          // forever. Logged at error so a real schema drift is noticed.
          logger.error("Dropping unroutable turn-timeout marker (fast path)");
          continue;
        }
        // A marker flagged by the proxy knows WHICH provider failure ended
        // this turn, so relay that instead of the generic worker verdict —
        // "quota exhausted on qwen" is actionable, "worker unresponsive" sends
        // the operator looking at the wrong subsystem. Falls back to `code`
        // for a genuinely silent/dead worker, and for any unrecognised value
        // (the column is data, never a code path).
        await enqueueTerminalError(
          tx,
          routing,
          providerFailureCode(row.action_input) ?? code
        );
        emitted += 1;
      }
      return emitted;
    });
    if (failed > 0) {
      await notifyThreadResponse();
      logger.info(
        { deploymentName, failed },
        "Worker died unexpectedly — emitted terminal error for in-flight turn(s)"
      );
    }
    return failed;
  } catch (err) {
    logger.error(
      { deploymentName, err: String(err) },
      "Failed to fail turns for dead deployment"
    );
    return 0;
  }
}

/**
 * Deadline backstop: fail markers whose deadline has lapsed. Runs on every
 * replica; `FOR UPDATE SKIP LOCKED` + `DELETE … RETURNING` make it exactly-once
 * across replicas. Covers a hung worker and a worker-pod death (the marker
 * outlives the pod that armed it).
 */
export async function sweepExpiredTurns(
  code: AgentErrorCode = AgentErrorCode.WORKER_UNRESPONSIVE
): Promise<number> {
  try {
    const sql = getDb();
    const failed = await sql.begin(async (tx: DbClient) => {
      const rows = await tx.unsafe<{ action_input: TurnMarkerInput }>(
        // status + run_type match the partial predicate and leading column of
        // `runs_lobu_claim_idx`, so the inner SELECT is an index range scan
        // (run_type, queue_name, …, run_at) — not a full scan of `runs` (which
        // retains 30 days of completed rows).
        `DELETE FROM public.runs
         WHERE id IN (
           SELECT id FROM public.runs
           WHERE status = 'pending'
             AND run_type = 'internal'
             AND queue_name = 'internal:turn_timeout'
             AND run_at < now()
           FOR UPDATE SKIP LOCKED
           LIMIT 200
         )
         RETURNING action_input`
      );
      let emitted = 0;
      for (const row of rows) {
        const routing = asTurnRouting(row.action_input);
        if (!routing) {
          // See the fast-path note: unroutable (missing messageId/deployment),
          // so undeliverable — deleting clears it; keeping would re-loop forever.
          logger.error("Dropping unroutable turn-timeout marker (sweep)");
          continue;
        }
        // Same relay as the fast path: a marker the proxy flagged carries the
        // classified provider failure, which is what actually ended this turn.
        await enqueueTerminalError(
          tx,
          routing,
          providerFailureCode(row.action_input) ?? code
        );
        emitted += 1;
      }
      return emitted;
    });
    if (failed > 0) {
      await notifyThreadResponse();
      logger.warn(
        { failed },
        "Turn-liveness sweep failed lapsed turn(s) (hung worker or pod death)"
      );
    }
    return failed;
  } catch (err) {
    logger.warn({ err: String(err) }, "Turn-liveness sweep failed");
    return 0;
  }
}

/**
 * Insert one terminal `thread_response` row in the caller's transaction.
 * Mirrors RunsQueue.send's row shape for `thread_response` (run_type
 * chat_message), with the elevated retry budget terminal rows need to survive
 * the owner-gate re-queue (see TERMINAL_DELIVERY_SEND_OPTS). The caller does the
 * `pg_notify` after the transaction commits.
 */
export async function insertThreadResponseRow(
  tx: DbClient,
  payload: unknown,
  organizationId: string | null
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO public.runs (
       run_type, queue_name, action_input, status, run_at,
       max_attempts, attempts, priority, retry_delay_seconds, organization_id
     ) VALUES (
       'chat_message', 'thread_response', $1, 'pending', now(),
       $2, 0, 0, $3, $4
     )`,
    [
      tx.json(payload),
      TERMINAL_DELIVERY_SEND_OPTS.retryLimit ?? 30,
      TERMINAL_DELIVERY_SEND_OPTS.retryDelay ?? 1,
      organizationId,
    ]
  );
}

/** Build the terminal `thread_response{error}` payload for a turn. `platform`
 *  always carries an explicit value (defaults to "api") — gateway routing and
 *  platform isolation require it; never emit `platform: undefined`.
 *
 *  Carries the `AgentErrorCode` so the gateway renderers present it through the
 *  shared `renderAgentError` catalog like any other agent error. `error` is the
 *  catalog's own fallback text for that code (for any consumer that reads
 *  `error` instead of rendering from the code) — NOT a caller-supplied string,
 *  so there is exactly one place this prose lives: AGENT_ERRORS. */
function buildTerminalErrorPayload(
  routing: TurnRouting,
  code: AgentErrorCode
) {
  return {
    messageId: routing.messageId,
    channelId: routing.channelId,
    conversationId: routing.conversationId,
    userId: routing.userId,
    teamId: routing.platform ?? "api",
    platform: routing.platform ?? "api",
    platformMetadata: routing.platformMetadata,
    // Sweep/dispatch codes are always worker-family, which carry catalog text
    // (there's no provider message to relay when the worker never replied).
    error: AGENT_ERRORS[code].message ?? "The agent didn't finish responding.",
    errorCode: code,
    processedMessageIds: [routing.messageId],
    timestamp: Date.now(),
  };
}

/** Insert a terminal `thread_response{error}` for a turn, in the caller's tx. */
async function enqueueTerminalError(
  tx: DbClient,
  routing: TurnRouting,
  code: AgentErrorCode
): Promise<void> {
  await insertThreadResponseRow(
    tx,
    buildTerminalErrorPayload(routing, code),
    routing.organizationId ?? null
  );
  await completeAgentRunInputs(
    tx,
    routing.organizationId ?? null,
    routing.deploymentName,
    [routing.messageId]
  );
}

/**
 * Election-gated terminal error for a SINGLE turn, used by pre-spawn deployment
 * failures (`trackFailedDeployment`). Atomically deletes the marker for
 * (deploymentName, messageId) and — only if it won the delete (the turn wasn't
 * already answered by a worker that raced) — emits the terminal error in the
 * same transaction. Returns whether it emitted.
 *
 * This is the first-writer-wins guarantee for the startup-failure path: if a
 * still-attached worker already produced a terminal reply (which discharged the
 * marker), this no-ops instead of double-signalling the client.
 *
 * `false` means exactly "election lost — the turn was already terminalized".
 * Infrastructure failures THROW instead of returning false: the dispatch gate
 * completes a held job on the strength of this call, and a swallowed DB error
 * here would let it drop a turn that never got its terminal event. Callers for
 * whom this is best-effort (trackFailedDeployment) catch at their call site.
 */
export async function failTurnIfPending(
  deploymentName: string,
  messageId: string,
  code: AgentErrorCode
): Promise<boolean> {
  const key = turnMarkerKey(deploymentName, messageId);
  const sql = getDb();
  const emitted = await sql.begin(async (tx: DbClient) => {
    const rows = await tx<{ action_input: unknown }>`
      DELETE FROM public.runs
      WHERE idempotency_key = ${key}
        AND status = 'pending'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
      RETURNING action_input
    `;
    const routing = rows[0] ? asTurnRouting(rows[0].action_input) : null;
    if (!routing) return false;
    await enqueueTerminalError(tx, routing, code);
    return true;
  });
  if (emitted) await notifyThreadResponse();
  return emitted;
}

/**
 * Retire the turn-liveness markers for `messageIds` inside the caller's
 * transaction, and complete their durable inputs.
 *
 * For the isolate lane's TERMINAL delivery only. The marker doubles as the
 * turn's liveness signal for worker token refresh (`hasLiveTurnForMessage`
 * gates `/worker/token/refresh` on it), so it must NOT be retired while a
 * guest is still streaming — doing that denies the refresh mid-turn and the
 * client's reply arrives empty. Both callers of `insertAgentTurnResponse`
 * transition the run to a terminal status in the SAME transaction first, so by
 * the time this runs there is no guest left to refresh.
 *
 * Unlike `commitTerminalReply` this does not gate delivery on winning the
 * race: the caller already committed its reply in this transaction, so zero
 * deleted just means a sweep or cancel terminalized the turn first.
 */
export async function dischargeTurnMarkers(
  tx: DbClient,
  deploymentName: string,
  messageIds: readonly string[],
  organizationId: string | null
): Promise<number> {
  let deleted = 0;
  for (const messageId of messageIds) {
    const rows = await tx<{ id: string }>`
      DELETE FROM public.runs
      WHERE idempotency_key = ${turnMarkerKey(deploymentName, messageId)}
        AND status = 'pending'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
      RETURNING id
    `;
    deleted += rows.length;
  }
  await completeAgentRunInputs(tx, organizationId, deploymentName, [
    ...messageIds,
  ]);
  return deleted;
}

export async function commitTerminalReply(
  deploymentName: string,
  messageIds: string[],
  replyPayload: unknown,
  organizationId: string | null
): Promise<boolean> {
  const sql = getDb();
  const emitted = await sql.begin(async (tx: DbClient) => {
    let deleted = 0;
    for (const messageId of messageIds) {
      const rows = await tx<{ id: string }>`
        DELETE FROM public.runs
        WHERE idempotency_key = ${turnMarkerKey(deploymentName, messageId)}
          AND status = 'pending'
          AND queue_name = ${TURN_TIMEOUT_QUEUE}
        RETURNING id
      `;
      deleted += rows.length;
    }
    if (deleted === 0) return false; // already terminalized — drop the late reply
    await completeAgentRunInputs(
      tx,
      organizationId,
      deploymentName,
      messageIds
    );
    await insertThreadResponseRow(tx, replyPayload, organizationId);
    return true;
  });
  if (emitted) await notifyThreadResponse();
  return emitted;
}

/** Wake thread_response consumers immediately after committing an emit. */
export async function notifyThreadResponse(): Promise<void> {
  try {
    const sql = getDb();
    await sql`SELECT pg_notify(${THREAD_RESPONSE_CHANNEL}, 'thread_response')`;
  } catch {
    // Non-fatal: consumers poll on their own interval and will pick it up.
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/** Start the periodic deadline backstop sweep. Idempotent. */
export function startTurnTimeoutSweep(): void {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      await sweepExpiredTurns();
    } finally {
      sweepInFlight = false;
    }
  };
  void tick();
  sweepTimer = setInterval(tick, intervals.turnLivenessSweepIntervalMs);
  sweepTimer.unref?.();
}

/** Stop the periodic sweep (graceful shutdown / tests). */
export function stopTurnTimeoutSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
