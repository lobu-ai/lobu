/**
 * Completion for an agent turn run.
 *
 * A shadow turn reports what the isolate produced and stops there: the
 * conversation's reply still comes from the subprocess lane, so nothing is
 * delivered. What it writes is the transcript the turn produced, onto the run
 * row, which is how the two lanes are compared while the shadow runs.
 *
 * An authoritative turn additionally delivers: it appends the turn to the
 * conversation's transcript snapshot and publishes the `thread_response` the
 * client is waiting on, both inside the same fenced terminal transition, the
 * way `device-chat.ts` does for the other non-subprocess lane. Which of the
 * two a run is, is the run's own `turn.shadow`, stamped by the producer.
 *
 * `sweepStaleAgentTurnRuns` is the same distinction applied by the stale-run
 * reaper: a worker that crashes mid-turn never reaches this route, so the
 * reaper terminalizes the run and, for an authoritative turn, delivers the
 * error the completion route would have.
 */
import {
	AGENT_ERRORS,
	AgentErrorCode,
	createLogger,
	MEMORY_FLUSH_STATE_CUSTOM_TYPE,
	parseSessionEntries,
} from "@lobu/core";
import {
	type AgentTurnToolEvent,
	type CompleteAgentTurnRequest,
	CompleteAgentTurnRequestSchema,
} from "@lobu/core/contracts/worker/protocol";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "hono";
import { type DbClient, getDb } from "../db/client";
import type { TurnReply } from "../gateway/orchestration/agent-turn-shadow";
import {
	insertThreadResponseRow,
	notifyThreadResponse,
} from "../gateway/orchestration/turn-liveness";
import {
	MAX_SNAPSHOT_BYTES,
	readSnapshotJsonl,
} from "../gateway/services/transcript-snapshot";
import type { Env } from "../index";
import { incrementCounter } from "../gateway/metrics/prometheus";
import { runLeaseFence } from "../runs/run-lease";
import { classifyRunOutcome } from "../runs/run-outcome";
import { buildStaleRunWhereSql } from "../scheduled/stale-run-sweeper";
import { errorMessage } from "../utils/errors";
import { stripNul } from "../utils/strip-nul";
import { authorizeRunForWorker } from "./shared";

const logger = createLogger("agent-turn-worker-api");

/** What of the turn's own text is kept on the run row for the shadow diff. */
const MAX_OUTPUT_TAIL = 2_000;

/**
 * Append this turn to the conversation's transcript snapshot, in the
 * session-jsonl shape `parseSessionEntries` reads back — the same blob the
 * producer replays for history and the subprocess lane's SessionManager reads.
 *
 * The turn is persisted whole and verbatim: every message the guest added to
 * the history it was given — the human's message, the tool calls, their
 * results, the reply, a memory flush's exchange — because the next turn
 * replays them and a provider refuses a tool call without its result. The
 * guest already stores the human's own text in its user message, not the
 * prompt it composed around it. A worker that reports no transcript (an older
 * build, or a turn that failed before producing one) still gets its text pair
 * recorded.
 *
 * Two entries beyond messages, both pi's: a `custom` entry recording a memory
 * flush ran this cycle, placed right after the flush's exchange, and a
 * `compaction` entry closing the turn when the guest compacted, whose
 * `firstKeptEntryId` is resolved from the entry ids the producer sent with
 * the history plus the ones written here.
 *
 * The row is keyed by `run_id`, and the lease fence already refuses a second
 * completion of the same run, so this insert never conflicts in practice —
 * `DO NOTHING` matches `device-chat.ts` and keeps a durable transcript
 * unoverwritable if one ever does.
 */
async function appendTurnSnapshot(
	tx: DbClient,
	args: {
		organizationId: string;
		agentId: string;
		conversationId: string;
		runId: number;
		userText: string;
		assistantText: string;
		/** What the guest returned: the history it was given plus this turn. */
		transcript: Array<Record<string, unknown>>;
		/** How many of those messages were the history it was given. */
		priorCount: number;
		/** The stored entry behind each of those history messages. */
		historyEntryIds: string[];
		compaction?: CompleteAgentTurnRequest["compaction"];
		memoryFlush?: CompleteAgentTurnRequest["memory_flush"];
	},
): Promise<void> {
	if (!args.agentId || !args.conversationId) return;
	const previous = await readSnapshotJsonl({
		organizationId: args.organizationId,
		agentId: args.agentId,
		conversationId: args.conversationId,
		client: tx,
	});
	const now = new Date().toISOString();
	const prior = parseSessionEntries(previous ?? "").entries;

	const priorCount = Math.max(0, args.priorCount);
	let messages: Array<Record<string, unknown>> = args.transcript
		.slice(priorCount)
		.filter((message) => typeof message.role === "string");
	// A guest's transcript opens on a user message — the human's, or the
	// flush prompt's. A worker that reports less than that (none at all, or an
	// older build sending only its reply) still gets the human's message and
	// its answer recorded, but nothing it did not say: its indices do not
	// describe this transcript, so no flush or compaction entry is written.
	let legacyShape = false;
	if (messages[0]?.role !== "user") {
		legacyShape = true;
		const reply =
			messages.length > 0
				? messages
				: args.assistantText
					? [
							{
								role: "assistant",
								content: [{ type: "text", text: args.assistantText }],
							},
						]
					: [];
		messages = [
			...(args.userText
				? [{ role: "user", content: [{ type: "text", text: args.userText }] }]
				: []),
			...reply,
		];
	}
	if (messages.length === 0) return;
	const memoryFlush = legacyShape ? undefined : args.memoryFlush;
	const compaction = legacyShape ? undefined : args.compaction;

	// One entry id per new message, fixed up front so the compaction entry can
	// name the kept one whichever file it lands in.
	const newIds = messages.map((_, index) => `agent-turn-${args.runId}-${index}`);
	const allIds = [...args.historyEntryIds, ...newIds];
	const flushAfter =
		memoryFlush && memoryFlush.after_index >= priorCount
			? memoryFlush.after_index - priorCount
			: null;
	const compactionCount = prior.filter(
		(entry) => entry.type === "compaction",
	).length;

	const render = (base: string, tailId: string | null, continuation: boolean) => {
		let parentId = tailId;
		const lines: string[] = [];
		const line = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify({ ...entry, parentId, timestamp: now }));
			parentId = entry.id as string;
		};
		messages.forEach((message, index) => {
			line({ type: "message", id: newIds[index], message });
			if (flushAfter === index && memoryFlush) {
				line({
					type: "custom",
					id: `agent-turn-${args.runId}-memory-flush`,
					customType: MEMORY_FLUSH_STATE_CUSTOM_TYPE,
					data: {
						compactionCount,
						outcome: memoryFlush.outcome,
						timestamp: Date.now(),
					},
				});
			}
		});
		if (compaction) {
			const firstKeptEntryId = allIds[compaction.first_kept_index];
			// A continuation carries none of the history, so a summary that
			// keeps part of it has nothing to point at; the compaction is
			// dropped rather than written dangling.
			const keptIsPresent =
				firstKeptEntryId !== undefined &&
				(!continuation || newIds.includes(firstKeptEntryId));
			if (keptIsPresent) {
				line({
					type: "compaction",
					id: `agent-turn-${args.runId}-compaction`,
					summary: compaction.summary,
					firstKeptEntryId,
					tokensBefore: compaction.tokens_before,
				});
			}
		}
		return `${base}${lines.join("\n")}\n`;
	};
	const base = previous
		? previous.endsWith("\n")
			? previous
			: `${previous}\n`
		: "";
	let snapshot = render(base, prior[prior.length - 1]?.id ?? null, false);
	if (Buffer.byteLength(snapshot, "utf8") > MAX_SNAPSHOT_BYTES) {
		// A long-running conversation must not make the current turn fail: this
		// insert is inside the terminal transaction, so an oversize row would
		// roll back the completion and the reply and hang the client forever.
		// Start a compact continuation; the prior run's row stays queryable.
		snapshot = render("", null, true);
	}
	await tx`
    INSERT INTO public.agent_transcript_snapshot
      (organization_id, agent_id, conversation_id, run_id,
       snapshot_jsonl, byte_size, terminal_status)
    VALUES
      (${args.organizationId}, ${args.agentId}, ${args.conversationId}, ${args.runId},
       ${snapshot}, ${Buffer.byteLength(snapshot, "utf8")}, 'completed')
    ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
    DO NOTHING
  `;
}

/**
 * The outcome of one delta batch, as the worker needs to hear it.
 *
 * `published` distinguishes "written into the conversation" from "correctly
 * decided not to write" (a shadow turn, or a sequence already passed). Both
 * retire the batch on the worker; only a THROW leaves it queued for the next
 * beat, which is why this function returns rather than swallowing.
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
 * The row is the ordinary non-terminal `thread_response` the subprocess lane's
 * deltas take, so every renderer — web, Slack, Telegram — already knows how to
 * present it, and it inherits that queue's multi-replica delivery. It is
 * emphatically not the connector `/stream` events path: a chat delta is not an
 * event to ingest into an org's memory.
 *
 * The text is INCREMENTAL, because that is what those renderers do with it:
 * `ApiResponseRenderer.handleDelta` broadcasts the span verbatim and the SPA
 * appends it, exactly as the subprocess lane's `sendStreamDelta(delta, false)`
 * intends. A cumulative snapshot down this same path renders as the reply
 * repeated back to itself.
 *
 * What makes an increment safe under a dropped or retried beat is the pairing
 * of the sequence fence here with the worker's ack-gated cursor: the fence
 * refuses any sequence it has already published, so a retry is a no-op, and
 * the worker re-sends the same sequence until it is acknowledged, so nothing
 * is retired unwritten.
 *
 * Silent no-op for a shadow turn (nothing it produces is delivered) and for a
 * turn whose sequence has already been passed — both are `published: false`,
 * an answer rather than a failure.
 */
async function publishTurnDelta(
	runId: number,
	workerId: string,
	delta: { text: string; sequence: number }
): Promise<TurnDeltaOutcome> {
	const sql = getDb();
	const emitted = await sql.begin(async (tx) => {
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
				turn?: { shadow?: boolean; conversation_id?: string };
				reply?: TurnReply;
			} | null;
			organization_id: string | null;
		}>;
		const row = rows[0];
		if (!row) return false;
		const envelope = row.action_input ?? {};
		// A shadow turn delivers nothing, by definition — it exists to be
		// compared against the subprocess lane, not to answer anyone. Same
		// predicate the completion route applies to the same field.
		if (envelope.turn?.shadow === true) return false;
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
 * Publish the tool calls an in-flight `agent_turn` has finished, as the SAME
 * `tool_use` custom event the subprocess lane emits per `tool_execution_end`.
 *
 * One shape for both lanes: the SPA, the promptfoo provider and the menubar
 * already subscribe to `tool_use`, so this lane's tools become visible without
 * a second event name or a second consumer.
 *
 * Routing is read from the run's own row, exactly as the delta path does, and
 * a shadow turn publishes nothing. There is no sequence fence here and none is
 * needed: a trace is idempotent per `toolCallId` from the client's point of
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
		const rows = (await tx`
      SELECT action_input, organization_id
      FROM public.runs
      WHERE id = ${runId}
        AND run_type = 'agent_turn'
        ${runLeaseFence(tx, workerId)}
      LIMIT 1
    `) as unknown as Array<{
			action_input: {
				turn?: { shadow?: boolean; conversation_id?: string };
				reply?: TurnReply;
			} | null;
			organization_id: string | null;
		}>;
		const row = rows[0];
		if (!row) return false;
		const envelope = row.action_input ?? {};
		if (envelope.turn?.shadow === true) return false;
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

export async function completeAgentTurnRun(c: Context<{ Bindings: Env }>) {
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	if (!Value.Check(CompleteAgentTurnRequestSchema, rawBody)) {
		return c.json({ error: "Invalid agent turn completion body" }, 400);
	}
	const body = rawBody as CompleteAgentTurnRequest;
	// Fleet-only lane, so this waves the token through and the run's own
	// claimed_by/status read below is what enforces ownership and idempotency.
	const denied = await authorizeRunForWorker(c, body.run_id, body.worker_id);
	if (denied) return denied;

	const sql = getDb();
	const rows = await sql<{
		status: string;
		claimed_by: string | null;
		organization_id: string;
		action_input: Record<string, unknown> | null;
	}>`
    SELECT status, claimed_by, organization_id, action_input
    FROM public.runs
    WHERE id = ${body.run_id}
      AND run_type = 'agent_turn'
    LIMIT 1
  `;
	const run = rows[0];
	if (!run) return c.json({ error: "Agent turn run not found" }, 404);
	if (run.claimed_by !== body.worker_id || run.status !== "running") {
		return c.json({
			ok: true,
			status: run.status === "completed" ? "completed" : "failed",
			idempotent: true,
		});
	}

	// `turn.shadow` is the run's own statement about what its reply is FOR.
	// A shadow records and stops; an authoritative turn also delivers. The
	// producer stamps it, so a run cannot change its mind here.
	const envelope = (run.action_input ?? {}) as {
		turn?: {
			shadow?: unknown;
			agent_id?: unknown;
			conversation_id?: unknown;
			message_text?: unknown;
			messages?: unknown;
			message_entry_ids?: unknown;
		};
		reply?: TurnReply;
	};
	const isShadow = envelope.turn?.shadow === true;
	// Delivery needs somewhere to deliver TO. A producer that stamped an
	// authoritative turn without a reply envelope would otherwise transition
	// the run to completed and drop the answer, leaving the client waiting
	// forever; refusing keeps the run claimable instead.
	if (!isShadow && !envelope.reply) {
		return c.json(
			{ error: "Authoritative agent turn has no reply envelope" },
			409,
		);
	}

	const organizationId = run.organization_id;
	const failed = body.status === "failed";
	const error =
		typeof body.error === "string" ? stripNul(body.error).trim() : "";
	const text = typeof body.text === "string" ? stripNul(body.text) : "";
	// The turn's own output goes back on the row it came from, so a shadow run
	// is diffable against the subprocess reply without a second table.
	const result = {
		...(run.action_input ?? {}),
		result: {
			text,
			stop_reason: body.stop_reason ?? null,
			usage: body.usage ?? null,
			transcript: body.transcript ?? [],
		},
	};

	// One fenced transition. When the turn is authoritative the snapshot and
	// the thread_response join it inside the same transaction, so a client can
	// never observe a completed run whose answer was not persisted.
	const transitioned = await sql.begin(async (tx) => {
		const terminal = await tx`
      UPDATE public.runs
      SET status = ${failed ? "failed" : "completed"},
          completed_at = current_timestamp,
          error_message = ${failed ? error || "agent turn failed" : null},
          output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
          exit_reason = ${body.exit_reason ?? (failed ? "error_message" : "ok")},
          action_input = ${sql.json(result)}
      WHERE id = ${body.run_id}
        ${runLeaseFence(tx, body.worker_id)}
      RETURNING id
    `;
		if (terminal.length === 0) return false;
		if (isShadow) return true;

		const reply = envelope.reply as TurnReply;
		const agentId = String(envelope.turn?.agent_id ?? "");
		const conversationId = String(envelope.turn?.conversation_id ?? "");
		if (!failed) {
			await appendTurnSnapshot(tx, {
				organizationId,
				agentId,
				conversationId,
				runId: body.run_id,
				userText: String(envelope.turn?.message_text ?? ""),
				assistantText: text,
				transcript: body.transcript ?? [],
				priorCount: Array.isArray(envelope.turn?.messages)
					? envelope.turn.messages.length
					: 0,
				historyEntryIds: Array.isArray(envelope.turn?.message_entry_ids)
					? (envelope.turn.message_entry_ids as unknown[]).filter(
							(id): id is string => typeof id === "string",
						)
					: [],
				compaction: body.compaction,
				memoryFlush: body.memory_flush,
			});
		}
		await insertThreadResponseRow(
			tx,
			{
				messageId: reply.message_id,
				channelId: reply.channel_id,
				conversationId,
				userId: reply.user_id,
				teamId: reply.team_id ?? "api",
				platform: reply.platform,
				organizationId,
				platformMetadata: reply.platform_metadata,
				...(failed
					? { error: error || "agent turn failed" }
					: {
							finalText: text,
							// The turn already posted its answer into this
							// conversation with `send_message`/`present_event`, so
							// `finalText` is a report about a message the user has
							// read and delivering it too is the double-post. The
							// renderers' existing suppression acts on this flag
							// (`chat-response-bridge`); it is set only on the
							// completion row, never on an error row, because an
							// error is not a duplicate of the reply.
							...(body.replied_in_band === true
								? { repliedInBand: true }
								: {}),
						}),
				processedMessageIds: [reply.message_id],
				timestamp: Date.now(),
			},
			organizationId,
		);
		return true;
	});
	if (!transitioned) {
		return c.json({
			ok: true,
			status: failed ? "failed" : "completed",
			idempotent: true,
		});
	}
	// Outside the transaction, as device-chat does: the listener must not be
	// woken for a row a rollback would take back.
	if (!isShadow) await notifyThreadResponse();
	return c.json({ ok: true, status: failed ? "failed" : "completed" });
}

/**
 * Reap stale `agent_turn` runs, delivering the failure where a client is
 * waiting on one.
 *
 * The turn lane shares the connector lanes' claim and heartbeat contract, so
 * the staleness predicate is theirs (`buildStaleRunWhereSql`): a never-claimed
 * `pending` row past the threshold, or a `claimed`/`running` row whose
 * heartbeat lapsed. What differs is what a timeout MEANS. A connector run just
 * ends; an authoritative turn has a client blocked on its reply, and the
 * completion route that would have answered it never fires for a worker that
 * died. Without this the client waits forever with no error ever surfacing.
 *
 * Shape and reason follow `sweepStaleDeviceChatRuns`: candidates are read
 * once, then each is terminalized in its own transaction by an UPDATE that
 * re-asserts the full predicate, so a worker whose heartbeat or completion
 * wins after the candidate read makes this a no-op instead of an overwrite.
 * The `thread_response` joins the same transaction, and the listener is woken
 * only after commit.
 *
 * Delivery follows the run's own envelope, exactly as the completion route
 * does: a shadow turn (`turn.shadow === true`) delivers nothing, and so does a
 * run with no `reply` address — there is nowhere to deliver to, and the row
 * still terminalizes so the lane cannot wedge.
 */
export async function sweepStaleAgentTurnRuns(
	thresholdSeconds: number,
): Promise<{ reaped: number; delivered: number }> {
	const sql = getDb();
	const staleWhereSql = buildStaleRunWhereSql({
		runTypes: ["agent_turn"],
		heartbeatSemantics: "any-heartbeat",
		heartbeatStaleInterval: `${thresholdSeconds} seconds`,
		coarseStaleInterval: `${thresholdSeconds} seconds`,
		includePending: true,
	});
	const candidates = await sql.unsafe<{
		id: number | string;
		status: "pending" | "claimed" | "running";
		organization_id: string;
		action_input: {
			turn?: { shadow?: unknown; conversation_id?: unknown };
			reply?: TurnReply;
		} | null;
	}>(
		`SELECT id, status, organization_id, action_input
     FROM public.runs
     WHERE ${staleWhereSql}
     ORDER BY id
     LIMIT 100`,
	);

	let reaped = 0;
	let delivered = 0;
	for (const candidate of candidates) {
		const runId = Number(candidate.id);
		const neverClaimed = candidate.status === "pending";
		const workerError = neverClaimed
			? "worker_claim_timeout"
			: "worker_heartbeat_lost";
		// The catalog owns the prose, as turn-liveness does for the subprocess
		// lane: a run nobody claimed never started; a lapsed heartbeat is a
		// worker that died mid-turn.
		const code = neverClaimed
			? AgentErrorCode.WORKER_STARTUP_FAILED
			: AgentErrorCode.WORKER_DIED;
		const envelope = candidate.action_input ?? {};
		const reply =
			envelope.turn?.shadow === true ? undefined : envelope.reply;
		const outcome = await sql.begin(async (tx) => {
			const rows = await tx.unsafe<{ id: number | string }>(
				`UPDATE public.runs
         SET status = 'timeout',
             outcome = $2,
             completed_at = current_timestamp,
             error_message = $3
         WHERE id = $1
           AND status = $4
           AND ${staleWhereSql}
         RETURNING id`,
				[
					runId,
					classifyRunOutcome({ status: "timeout" }),
					workerError,
					candidate.status,
				],
			);
			if (rows.length === 0) return "won_by_worker";
			if (!reply) return "reaped";
			await insertThreadResponseRow(
				tx,
				{
					messageId: reply.message_id,
					channelId: reply.channel_id,
					conversationId: String(envelope.turn?.conversation_id ?? ""),
					userId: reply.user_id,
					teamId: reply.team_id ?? "api",
					platform: reply.platform,
					organizationId: candidate.organization_id,
					platformMetadata: reply.platform_metadata,
					error: AGENT_ERRORS[code].message,
					errorCode: code,
					processedMessageIds: [reply.message_id],
					timestamp: Date.now(),
				},
				candidate.organization_id,
			);
			return "delivered";
		});
		if (outcome === "won_by_worker") continue;
		reaped += 1;
		if (outcome === "delivered") delivered += 1;
	}
	// Outside the transaction, as device-chat does: the listener must not be
	// woken for a row a rollback would take back.
	if (delivered > 0) await notifyThreadResponse();
	return { reaped, delivered };
}
