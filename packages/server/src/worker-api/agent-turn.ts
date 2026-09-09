/**
 * Completion for an agent turn run.
 *
 * A turn delivers: it writes the native Pi session the turn produced onto the
 * run row, persists the conversation's snapshot, and publishes the
 * `thread_response` the client is waiting on — all inside the same fenced
 * terminal transition, the way `device-chat.ts` does for the device lane.
 *
 * `sweepStaleAgentTurnRuns` covers the path that never reaches this route: a
 * worker that crashes mid-turn is terminalized by the reaper, which delivers
 * the error the completion route would have.
 */
import {
	AGENT_ERRORS,
	AgentErrorCode,
	classifyErrorMessage,
	createLogger,
} from "@lobu/core";
import {
	type AgentTurnToolEvent,
	type CompleteAgentTurnRequest,
	CompleteAgentTurnRequestSchema,
} from "@lobu/core/contracts/worker/protocol";
import { Value } from "@sinclair/typebox/value";
import { CURRENT_SESSION_VERSION, type SessionEntry, type SessionHeader } from "@mariozechner/pi-coding-agent";
import type { Context } from "hono";
import { type DbClient, getDb } from "../db/client";
import type { TurnReply } from "../gateway/orchestration/agent-turn-producer";
import {
	insertThreadResponseRow,
	notifyThreadResponse,
} from "../gateway/orchestration/turn-liveness";
import { MAX_SNAPSHOT_BYTES, transcriptText } from "../gateway/services/transcript-snapshot";
import type { Env } from "../index";
import { incrementCounter } from "../gateway/metrics/prometheus";
import { runLeaseFence } from "../runs/run-lease";
import { classifyRunOutcome } from "../runs/run-outcome";
import { insertAgentTurnResponse, agentTurnClaimEligible, lockAgentTurnRun, pendingAgentTurnInputs, releaseNextAgentTurn, type NativeTurnRun } from "../runs/agent-turn-inputs";
import { errorMessage } from "../utils/errors";
import { stripNul } from "../utils/strip-nul";
import { authorizeRunForWorker } from "./shared";

const logger = createLogger("agent-turn-worker-api");

/** How much of the turn's own text is kept on the run row. */
const MAX_OUTPUT_TAIL = 2_000;

/** Validate the transport boundary without rebuilding Pi's session state. */
type TurnSnapshot = { header: SessionHeader; entries: SessionEntry[] };
function parseTurnSnapshot(snapshot: string | undefined): TurnSnapshot | string {
	if (!snapshot) return "agent turn completed without a native session snapshot";
	if (Buffer.byteLength(snapshot, "utf8") > MAX_SNAPSHOT_BYTES) {
		return "agent turn session snapshot exceeds the 4 MiB limit";
	}
	if (snapshot.includes("\0")) return "agent turn session snapshot contains a NUL byte";
	try {
		const [header, ...entries] = snapshot.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
		if (!header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION
			|| typeof header.id !== "string" || !header.id || typeof header.cwd !== "string"
			|| typeof header.timestamp !== "string") throw new Error("invalid session header");
		const ids = new Set<string>();
		for (const entry of entries) {
			if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
				|| typeof entry.timestamp !== "string" || typeof entry.type !== "string"
				|| entry.type === "session"
				|| (entry.parentId !== null && !ids.has(entry.parentId))) {
				throw new Error("invalid entry identity or parent");
			}
			if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string")) {
				throw new Error("invalid message entry");
			}
			if (entry.type === "compaction" && (!ids.has(entry.firstKeptEntryId)
				|| typeof entry.summary !== "string" || !Number.isFinite(entry.tokensBefore))) {
				throw new Error("invalid compaction entry");
			}
			if ((entry.type === "branch_summary" && !ids.has(entry.fromId))
				|| (entry.type === "label" && !ids.has(entry.targetId))) {
				throw new Error("invalid entry reference");
			}
			ids.add(entry.id);
		}
		return { header, entries };
	} catch {
		return "agent turn returned an invalid native session snapshot";
	}
}

/** Persist Pi's complete snapshot verbatim inside the fenced terminal transaction. */
async function persistTurnSnapshot(
	tx: DbClient,
	args: { organizationId: string; agentId: string; conversationId: string; runId: number; sessionJsonl: string },
): Promise<void> {
	await tx`
    INSERT INTO public.agent_transcript_snapshot
      (organization_id, agent_id, conversation_id, run_id,
       snapshot_jsonl, byte_size, terminal_status)
    VALUES
      (${args.organizationId}, ${args.agentId}, ${args.conversationId}, ${args.runId},
       ${args.sessionJsonl}, ${Buffer.byteLength(args.sessionJsonl, "utf8")}, 'completed')
    ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
    DO NOTHING
  `;
}

/**
 * The outcome of one delta batch, as the worker needs to hear it.
 *
 * `published` distinguishes "written into the conversation" from "correctly
 * decided not to write" (a sequence already passed). Both retire the batch on
 * the worker; only a THROW leaves it queued for the next beat, which is why
 * this function returns rather than swallowing.
 */
type TurnDeltaOutcome = { published: boolean };

/**
 * Publish the next span of text an in-flight `agent_turn` has written, so the
 * client watching the conversation sees the answer arrive instead of a blank
 * screen for the length of the turn.
 *
 * Called from the heartbeat the turn already sends. Everything about WHERE the
 * text goes is read from the run's own row, never from the worker's body: a
 * worker may be compromised, and this is the same rule `/worker/response`
 * applies when it rebuilds routing from the signed token.
 *
 * The row is an ordinary non-terminal `thread_response`, so every renderer —
 * web, Slack, Telegram — already knows how to present it, and it inherits that
 * queue's multi-replica delivery. It is
 * emphatically not the connector `/stream` events path: a chat delta is not an
 * event to ingest into an org's memory.
 *
 * The text is INCREMENTAL, because that is what those renderers do with it:
 * `ApiResponseRenderer.handleDelta` broadcasts the span verbatim and the SPA
 * appends it. A cumulative snapshot down this same path renders as the reply
 * repeated back to itself.
 *
 * What makes an increment safe under a dropped or retried beat is the pairing
 * of the sequence fence here with the worker's ack-gated cursor: the fence
 * refuses any sequence it has already published, so a retry is a no-op, and
 * the worker re-sends the same sequence until it is acknowledged, so nothing
 * is retired unwritten.
 *
 * Silent no-op for a turn whose sequence has already been passed —
 * `published: false` is an answer rather than a failure.
 */
async function publishTurnDelta(
	runId: number,
	workerId: string,
	delta: { text: string; sequence: number }
): Promise<TurnDeltaOutcome> {
	const sql = getDb();
	const emitted = await sql.begin(async (tx) => {
		const owner = await lockAgentTurnRun(tx, runId);
		if (!owner || owner.run_metadata?.cancel_requested_at) return false;
		// One statement, fenced on the lease, so a run cancelled or re-claimed
		// between the read and the write cannot have a stale worker's text
		// published into its conversation. The sequence is kept on the
		// run row itself: it is per-run state with the same lifetime as the run,
		// and an in-memory counter would be invisible to the other replicas that
		// can serve the next heartbeat.
		//
		// The lease fence already pins `status = 'running'` (`runLeaseFence`), so
		// there is no second status predicate here: one narrower fence, stated
		// once.
		const rows = (await tx`
      UPDATE public.runs
      SET run_metadata = jsonb_set(
            COALESCE(run_metadata, '{}'::jsonb),
            '{turn_delta_sequence}',
            ${sql.json(delta.sequence)}::jsonb,
            true
          )
      WHERE id = ${runId}
        AND run_type = 'agent_turn'
        AND COALESCE((run_metadata->>'turn_delta_sequence')::bigint, -1) < ${delta.sequence}
        ${runLeaseFence(tx, workerId)}
      RETURNING action_input, organization_id
    `) as unknown as Array<{
			action_input: {
				turn?: { conversation_id?: string };
				reply?: TurnReply;
			} | null;
			organization_id: string | null;
		}>;
		const row = rows[0];
		if (!row) return false;
		const envelope = row.action_input ?? {};
		const reply = envelope.reply;
		if (!reply) return false;
		await insertThreadResponseRow(
			tx,
			{
				messageId: reply.message_id,
				channelId: reply.channel_id,
				conversationId: String(envelope.turn?.conversation_id ?? ""),
				userId: reply.user_id,
				teamId: reply.team_id ?? "api",
				platform: reply.platform,
				organizationId: row.organization_id,
				platformMetadata: reply.platform_metadata,
				delta: delta.text,
				// Incremental: this span CONTINUES the reply, it does not restate
				// it. The renderers append.
				isFullReplacement: false,
				timestamp: Date.now(),
			},
			row.organization_id
		);
		return true;
	});
	// Outside the transaction, as the completion route does: the listener must
	// not be woken for a row a rollback would take back.
	if (emitted) await notifyThreadResponse();
	return { published: emitted };
}

/**
 * Publish the tool calls an in-flight `agent_turn` has finished as the
 * established `tool_use` custom event.
 *
 * One shape for both lanes: the SPA, the promptfoo provider and the menubar
 * already subscribe to `tool_use`, so this lane's tools become visible without
 * a second event name or a second consumer.
 *
 * Routing is read from the run's own row, exactly as the delta path does.
 * There is no sequence fence here and none is needed: a trace is idempotent per `toolCallId` from the client's point of
 * view, and unlike the reply it is never reconstructed by appending.
 */
async function publishTurnToolEvents(
	runId: number,
	workerId: string,
	events: readonly AgentTurnToolEvent[]
): Promise<void> {
	if (events.length === 0) return;
	const sql = getDb();
	const emitted = await sql.begin(async (tx) => {
		const owner = await lockAgentTurnRun(tx, runId);
		if (!owner || owner.run_metadata?.cancel_requested_at) return false;
		const rows = (await tx`
      SELECT action_input, organization_id
      FROM public.runs
      WHERE id = ${runId}
        AND run_type = 'agent_turn'
        ${runLeaseFence(tx, workerId)}
      LIMIT 1
    `) as unknown as Array<{
			action_input: {
				turn?: { conversation_id?: string };
				reply?: TurnReply;
			} | null;
			organization_id: string | null;
		}>;
		const row = rows[0];
		if (!row) return false;
		const envelope = row.action_input ?? {};
		const reply = envelope.reply;
		if (!reply) return false;
		for (const event of events) {
			await insertThreadResponseRow(
				tx,
				{
					messageId: reply.message_id,
					channelId: reply.channel_id,
					conversationId: String(envelope.turn?.conversation_id ?? ""),
					userId: reply.user_id,
					teamId: reply.team_id ?? "api",
					platform: reply.platform,
					organizationId: row.organization_id,
					platformMetadata: reply.platform_metadata,
					customEvent: {
						name: "tool_use",
						data: {
							toolCallId: event.tool_call_id,
							name: event.name,
							// `buildToolUseEventPayload`'s shape: the SPA reads the args here.
							input: event.input ?? null,
							isError: event.is_error,
							result_summary: event.is_error
								? { error: event.output }
								: undefined,
						},
					},
					timestamp: Date.now(),
				},
				row.organization_id
			);
		}
		return true;
	});
	if (emitted) await notifyThreadResponse();
}

/**
 * Publish an in-flight turn's tool traces, absorbing any failure.
 *
 * Same contract as the delta path and for the same reason: a view of the turn
 * must never fail the heartbeat that keeps the turn alive. Counted rather than
 * silenced, so a broken trace path is visible.
 */
export async function publishTurnToolEventsBestEffort(
	runId: number,
	workerId: string,
	events: readonly AgentTurnToolEvent[]
): Promise<void> {
	try {
		await publishTurnToolEvents(runId, workerId, events);
	} catch (err) {
		incrementCounter("lobu_turn_tool_event_publish_failed_total");
		logger.debug(
			{ runId, err: errorMessage(err) },
			"Failed to publish agent turn tool traces"
		);
	}
}

/**
 * How often a failing delta publish is allowed to say so in the log, per pod.
 *
 * A turn beats every few seconds, so an unconditional warn on a persistently
 * broken path is thousands of identical lines. Silence is the wrong fix for
 * that — a 100%-failing delta path would be indistinguishable from a working
 * one — so the counter below is unconditional and the PROSE is rate-limited.
 */
const DELTA_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastDeltaFailureLogAt = 0;

/**
 * Publish an in-flight turn's delta, absorbing any failure into the answer.
 *
 * The heartbeat's own job is to prove the turn is alive; a delta is a
 * best-effort passenger on it. Letting a failed publish fail the heartbeat
 * would let a cosmetic path get a live turn reaped by the stale sweep — so the
 * failure is caught here.
 *
 * It is not, however, hidden. The caller gets `undefined` — no ack — and the
 * worker keeps the text queued and re-sends it under the same sequence, and
 * `lobu_turn_delta_publish_failed_total` counts every occurrence so a broken
 * delta path is visible in the same place every other gateway failure is.
 */
export async function publishTurnDeltaBestEffort(
	runId: number,
	workerId: string,
	delta: { text: string; sequence: number }
): Promise<TurnDeltaOutcome | undefined> {
	try {
		return await publishTurnDelta(runId, workerId, delta);
	} catch (err) {
		incrementCounter("lobu_turn_delta_publish_failed_total");
		const now = Date.now();
		if (now - lastDeltaFailureLogAt >= DELTA_FAILURE_LOG_INTERVAL_MS) {
			lastDeltaFailureLogAt = now;
			logger.warn(
				{ runId, sequence: delta.sequence, err: errorMessage(err) },
				"Failed to publish an agent turn delta; the worker will retry the batch"
			);
		}
		return undefined;
	}
}

/** Validate native identities only; Pi owns replay and compaction. */
function inputReceiptError(
  run: NativeTurnRun, body: CompleteAgentTurnRequest, snapshot: TurnSnapshot,
  offered: Awaited<ReturnType<typeof pendingAgentTurnInputs>>,
): string | undefined {
  const receipts = body.consumed_inputs;
  if (!receipts) return "agent turn completed without consumed input receipts";
  if (!receipts.length) return undefined;
  const base = run.run_metadata?.native_session_base;
  if (base === undefined || (base && (base.version !== CURRENT_SESSION_VERSION || base.session_id !== snapshot.header.id))) {
    return "agent turn input receipts have no matching native session base";
  }
  const entries = snapshot.entries;
  const boundary = base?.final_stored_entry_id ? entries.findIndex((entry) => entry.id === base.final_stored_entry_id) : -1;
  if (base?.final_stored_entry_id && boundary < 0) return "agent turn lost its native session base entry";
  // Only entries on the final native branch count. An abandoned branch may
  // contain the same text without having processed this execution's input.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = new Set<string>();
  let leaf = entries.at(-1);
  while (leaf) { branch.add(leaf.id); leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined; }
  let previous = entries.findIndex((entry, index) => index > boundary && branch.has(entry.id)
    && entry.type === 'message' && entry.message.role === 'user'
    && transcriptText(entry.message.content) === run.action_input?.turn?.message_text);
  if (previous < 0) return "agent turn input receipts precede its initial user entry";
  const usedRuns = new Set<number>();
  for (const [index, receipt] of receipts.entries()) {
    const input = offered[index];
    const position = entries.findIndex((entry) => entry.id === receipt.session_entry_id);
    const entry = entries[position];
    if (!input || receipt.run_id !== input.run_id || usedRuns.has(receipt.run_id)
      || position <= previous || !branch.has(receipt.session_entry_id) || entry.type !== 'message'
      || entry.message.role !== 'user' || transcriptText(entry.message.content) !== input.text
      || (Array.isArray(entry.message.content) && entry.message.content.some((part) => part.type !== 'text'))) {
      return "agent turn returned invalid consumed input receipts";
    }
    usedRuns.add(receipt.run_id);
    previous = position;
  }
  return undefined;
}

export async function completeAgentTurnRun(c: Context<{ Bindings: Env }>) {
  let rawBody: unknown;
  try { rawBody = await c.req.json(); }
  catch { return c.json({ error: "Invalid or missing JSON body" }, 400); }
  if (!Value.Check(CompleteAgentTurnRequestSchema, rawBody)) {
    return c.json({ error: "Invalid agent turn completion body" }, 400);
  }
  const body = rawBody as CompleteAgentTurnRequest;
  const denied = await authorizeRunForWorker(c, body.run_id, body.worker_id);
  if (denied) return denied;
  const snapshot = body.status === 'completed' || body.session_jsonl !== undefined
    ? parseTurnSnapshot(body.session_jsonl) : undefined;
  const text = typeof body.text === 'string' ? stripNul(body.text) : '';
  const sql = getDb();
  const result = await sql.begin(async (tx) => {
    const run = await lockAgentTurnRun(tx, body.run_id, true);
    if (!run) return { error: 'Agent turn run not found', code: 404 as const };
    if (run.claimed_by !== body.worker_id) return { error: 'Run is not owned by this worker', code: 409 as const };
    if (!['claimed', 'running', 'pending'].includes(run.status)) {
      return { status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed', idempotent: true };
    }
    if (run.status !== 'running' && !(run.status === 'claimed' && run.run_metadata?.cancel_requested_at)) {
      return { error: 'Run is not in progress', code: 409 as const };
    }
    const envelope = run.action_input ?? {};
    if (!envelope.reply) return { error: 'Agent turn has no reply envelope', code: 409 as const };
    const cancelling = !!run.run_metadata?.cancel_requested_at;
    const offered = !cancelling && body.status === 'completed' ? await pendingAgentTurnInputs(tx, run) : [];
    const invalid = typeof snapshot === 'string' ? snapshot
      : !cancelling && body.status === 'completed' && snapshot ? inputReceiptError(run, body, snapshot, offered) : undefined;
    const error = cancelling ? 'agent turn cancelled' : invalid ?? (typeof body.error === 'string' ? stripNul(body.error).trim() : '');
    const status = cancelling ? 'cancelled' : body.status === 'failed' || invalid ? 'failed' : 'completed';
    const errorCode = status === 'failed' ? classifyErrorMessage(error) : undefined;
    const consumed = status === 'completed' ? body.consumed_inputs! : [];
    await tx`UPDATE runs SET status = ${status}, completed_at = now(),
      outcome = ${classifyRunOutcome({ status, errorMessage: error })},
      error_message = ${status === 'completed' ? null : error || 'agent turn failed'},
      output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
      exit_reason = ${cancelling ? 'cancelled' : invalid ? 'error_message' : body.exit_reason ?? (status === 'completed' ? 'ok' : 'error_message')},
      action_input = ${tx.json({ ...envelope, result: {
        text, stop_reason: body.stop_reason ?? null, usage: body.usage ?? null,
        ...(snapshot && typeof snapshot !== 'string' ? { session_jsonl: body.session_jsonl } : {}),
      } })}
      WHERE id = ${run.id}`;
    // Offered rows are newer than the owner and ordered by ID. The conversation
    // lock prevents another admission/cancel/claim from racing these completions.
    for (const receipt of consumed) {
      await tx`UPDATE runs SET status = 'completed', completed_at = now(), outcome = 'scoreable', exit_reason = 'ok',
        output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
        run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${tx.json({
          consumed_by_run_id: Number(run.id), session_entry_id: receipt.session_entry_id,
        })}::jsonb WHERE id = ${receipt.run_id} AND status = 'pending'`;
    }
    await releaseNextAgentTurn(tx, run);
    const reply = envelope.reply!;
    const conversationId = envelope.turn!.conversation_id;
    if (status === 'completed') await persistTurnSnapshot(tx, {
      organizationId: run.organization_id, agentId: envelope.turn!.agent_id, conversationId,
      runId: body.run_id, sessionJsonl: body.session_jsonl!,
    });
    await insertAgentTurnResponse(tx, run, {
      // `tools_used` is forwarded as sent, NOT defaulted to `[]`. Absent and
      // empty are different claims downstream: `requireTool` passes on absent
      // (it cannot prove a miss) and trips on empty, and the follow-up bridge
      // skips on absent to avoid duplicating a card mid-deployment. Turning a
      // worker that reported nothing into "called nothing" would invent that
      // claim. The guest always sends the array, so absent means a genuinely
      // older worker.
      ...(status === 'completed'
        ? {
            finalText: text,
            ...(body.tools_used ? { toolsUsed: body.tools_used } : {}),
            ...(body.replied_in_band ? { repliedInBand: true } : {}),
          }
        : {
            error: error || 'agent turn failed',
            ...(errorCode ? { errorCode, errorContext: envelope.reply!.error_context } : {}),
          }),
      processedMessageIds: [reply.message_id, ...offered.slice(0, consumed.length).map((input) => input.message_id)],
    });
    return { status, notify: true };
  });
  if ('error' in result) return c.json({ error: result.error }, result.code);
  if (result.notify) await notifyThreadResponse();
  return c.json({ ok: true, status: result.status, ...(result.idempotent ? { idempotent: true } : {}) });
}

/** Reap only ready startup work or expired owners; blocked followers have no startup deadline. */
export async function sweepStaleAgentTurnRuns(thresholdSeconds: number): Promise<{ reaped: number; delivered: number }> {
  const sql = getDb();
  const stale = (tx: DbClient) => tx`r.run_type = 'agent_turn' AND (
    (r.status = 'pending' AND r.approval_status <> 'pending' AND ${agentTurnClaimEligible(tx)}
      AND r.run_at < now() - ${thresholdSeconds} * interval '1 second')
    OR (r.status IN ('claimed', 'running') AND CASE
      WHEN r.run_metadata->>'cancel_requested_at' IS NOT NULL
      THEN (r.run_metadata->>'cancel_requested_at')::timestamptz < now() - ${thresholdSeconds} * interval '1 second'
      ELSE COALESCE(r.last_heartbeat_at, r.claimed_at, r.created_at) < now() - ${thresholdSeconds} * interval '1 second'
    END)
  )`;
  const candidates = await sql<{ id: number }>`SELECT r.id FROM runs r WHERE ${stale(sql)} ORDER BY r.id LIMIT 100`;
  let reaped = 0;
  let delivered = 0;
  for (const candidate of candidates) {
    const result = await sql.begin(async (tx) => {
      const run = await lockAgentTurnRun(tx, Number(candidate.id), true);
      if (!run) return null;
      const cancelled = !!run.run_metadata?.cancel_requested_at;
      const neverClaimed = run.status === 'pending';
      const code = neverClaimed ? AgentErrorCode.WORKER_STARTUP_FAILED : AgentErrorCode.WORKER_DIED;
      const status = cancelled ? 'cancelled' : 'timeout';
      const rows = await tx`UPDATE runs r SET status = ${status}, completed_at = now(),
        outcome = ${classifyRunOutcome({ status })}, exit_reason = ${cancelled ? 'cancelled' : 'timeout'},
        error_message = ${cancelled ? 'agent turn cancelled' : neverClaimed ? 'worker_claim_timeout' : 'worker_heartbeat_lost'}
        WHERE r.id = ${run.id} AND ${stale(tx)} RETURNING r.id`;
      if (!rows.length) return null;
      await releaseNextAgentTurn(tx, run);
      return insertAgentTurnResponse(tx, run, {
        error: cancelled ? 'agent turn cancelled' : AGENT_ERRORS[code].message,
        ...(!cancelled ? { errorCode: code } : {}),
      });
    });
    if (result === null) continue;
    reaped++;
    if (result) delivered++;
  }
  if (delivered) await notifyThreadResponse();
  return { reaped, delivered };
}
