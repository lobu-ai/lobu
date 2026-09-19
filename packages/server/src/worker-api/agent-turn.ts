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
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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

/**
 * The session the next turn hydrates, bounded to the storage cap.
 *
 * Pi's session log is append-only: compaction appends a summary and removes
 * nothing, so once a conversation has outgrown the cap every later turn would
 * too. Failing the turn here handed the user a raw error and then failed every
 * message after it, since each one re-hydrated the same last stored snapshot
 * and grew it again.
 *
 * Within the cap the snapshot is kept verbatim. Over it, the log is trimmed to
 * what Pi still sends the model: from the newest compaction's first kept entry
 * (re-rooted) through the compaction summary to the end. That is exactly the
 * context `buildSessionContext` derives from the full log — the entries dropped
 * are the ones the summary already replaced. Only when there is no compaction
 * to trim to, or the kept part alone is over the cap, does the session start
 * fresh; the memory hooks hold the long-term record either way.
 */
function boundSnapshot(
	snapshot: TurnSnapshot,
	sessionJsonl: string,
	context: { runId: number; conversationId: string },
): string {
	const byteSize = Buffer.byteLength(sessionJsonl, "utf8");
	if (byteSize <= MAX_SNAPSHOT_BYTES) return sessionJsonl;
	const trimmed = trimToCompaction(snapshot);
	if (trimmed !== null && Buffer.byteLength(trimmed, "utf8") <= MAX_SNAPSHOT_BYTES) {
		logger.info(
			{ ...context, byteSize, trimmedBytes: Buffer.byteLength(trimmed, "utf8"), cap: MAX_SNAPSHOT_BYTES },
			"Agent turn session snapshot exceeds the cap; trimmed to its latest compaction",
		);
		incrementCounter("lobu_agent_turn_snapshot_trimmed_total");
		return trimmed;
	}
	logger.warn(
		{ ...context, byteSize, cap: MAX_SNAPSHOT_BYTES },
		"Agent turn session snapshot exceeds the cap with no compaction to trim to; resetting the conversation's native session",
	);
	incrementCounter("lobu_agent_turn_snapshot_reset_total");
	return "";
}

/**
 * The final branch from the newest compaction's first kept entry onward, the
 * first kept entry re-rooted, or `null` when there is nothing to trim to. The
 * result is re-validated as a snapshot so a dangling reference (a label or
 * branch summary pointing before the cut) reverts to the reset path rather
 * than failing the NEXT turn's completion.
 */
function trimToCompaction(snapshot: TurnSnapshot): string | null {
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	for (let leaf = snapshot.entries.at(-1); leaf; leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined) path.unshift(leaf);
	let compaction: SessionEntry | undefined;
	for (let i = path.length - 1; i >= 0 && !compaction; i--) if (path[i]!.type === "compaction") compaction = path[i];
	if (!compaction || compaction.type !== "compaction") return null;
	const firstKept = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (firstKept <= 0) return null;
	const kept = path.slice(firstKept).map((entry, index) => (index === 0 ? { ...entry, parentId: null } : entry));
	const trimmed = `${[snapshot.header, ...kept].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	return typeof parseTurnSnapshot(trimmed) === "string" ? null : trimmed;
}

/** Persist the turn's bounded snapshot inside the fenced terminal transaction. */
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
 *
 * Keyed and idempotent, not merely client-idempotent: every trace is stored
 * under its canonical (organization, conversation, initiating input message,
 * tool call id) key — derived from the STORED owner/offered rows, never from
 * the worker's body — and the key carries an all-state unique index
 * (`idx_runs_turn_tool_event_uniq`, covering pending/claimed/failed/delivered
 * alike, where the pre-existing `runs_idempotency_key_uniq` only covers live
 * rows). A heartbeat retry of the same trace collides on the key and is
 * recognised as an exact duplicate; a conflicting same-key payload (same key,
 * different trace body) throws, so the `BestEffort` caller answers no ack and
 * the worker keeps the evidence queued instead of retiring it unwritten.
 *
 * Returns how many traces were durably stored, so the heartbeat can answer
 * `turn_tool_ack`: the worker retires only acknowledged traces and re-sends
 * the rest. The count names a fully durably known prefix — every returned
 * trace is newly inserted or an exact duplicate — never a conflicting one.
 * Throws on failure or conflict — the `BestEffort` caller absorbs it into a
 * missing ack, which is what keeps the worker's evidence queued.
 */
async function publishTurnToolEvents(
	runId: number,
	workerId: string,
	events: readonly AgentTurnToolEvent[]
): Promise<number> {
	if (events.length === 0) return 0;
	const sql = getDb();
	const stored = await sql.begin(async (tx) => {
		const owner = await lockAgentTurnRun(tx, runId);
		if (!owner || owner.run_metadata?.cancel_requested_at) return 0;
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
		if (!row) return 0;
		const envelope = row.action_input ?? {};
		const reply = envelope.reply;
		if (!reply) return 0;
		// Route each trace under its initiating input's reply, read off stored
		// pending rows — never off the worker's body. An explicit unknown input
		// is rejected below rather than attributed to an unrelated owner.
		const offered = await pendingAgentTurnInputs(tx, owner);
		const repliesByInputRunId = new Map<number, TurnReply>(
			offered.map((input) => [input.run_id, { ...reply, message_id: input.message_id }]),
		);
		return insertTurnToolEventRows(tx, {
			reply,
			conversationId: String(envelope.turn?.conversation_id ?? ""),
			organizationId: row.organization_id,
			events,
			repliesByInputRunId,
		});
	});
	if (stored) await notifyThreadResponse();
	return stored;
}

/**
 * The canonical key for one tool trace: organization, conversation and
 * initiating input message are the STORED routing (the owner's reply envelope
 * or the offered pending row it resolves to), never caller strings; the tool
 * call id is the event's own identity within that input. Two heartbeats
 * carrying the same trace compute the same key; two different traces for the
 * same call compute the same key with different bodies, which is the conflict
 * the insert path rejects.
 */
function turnToolEventKey(args: {
	organizationId: string | null;
	conversationId: string;
	messageId: string;
	toolCallId: string;
}): string {
	// Hash the length-prefixed JSON tuple instead of concatenating raw values:
	// delimiters may occur inside every identifier, and a raw key can exceed
	// PostgreSQL's btree entry limit. The version prefix keeps future key
	// schemes independently migratable.
	const tuple = JSON.stringify([
		args.organizationId,
		args.conversationId,
		args.messageId,
		args.toolCallId,
	]);
	return `turn-tool:v1:${createHash("sha256").update(tuple).digest("hex")}`;
}

/**
 * Whether a stored `thread_response` row carries exactly the trace `payload`
 * would write. `timestamp` is deliberately excluded: a retry is stamped when
 * it lands, so it can never match, and it says nothing about the trace.
 *
 * `payload` is JSON-normalised before comparing: the driver drops
 * `undefined`-valued keys on the way into the stored row, so a retry whose
 * in-memory object still carries them must not compare as conflicting.
 */
function sameToolTracePayload(stored: unknown, payload: Record<string, unknown>): boolean {
	if (typeof stored !== "object" || stored === null) return false;
	const normalised = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
	const s = stored as Record<string, unknown>;
	return (
		s.messageId === normalised.messageId &&
		s.channelId === normalised.channelId &&
		s.conversationId === normalised.conversationId &&
		s.userId === normalised.userId &&
		s.teamId === normalised.teamId &&
		s.platform === normalised.platform &&
		isDeepStrictEqual(s.platformMetadata ?? null, normalised.platformMetadata ?? null) &&
		isDeepStrictEqual(s.customEvent ?? null, normalised.customEvent ?? null)
	);
}

function isUniqueViolation(err: unknown): boolean {
	return (err as { code?: unknown } | null)?.code === "23505";
}

/**
 * Insert one `tool_use` row per trace, on a transaction the caller already
 * owns — keyed and idempotent.
 *
 * Shared by the heartbeat path above and the completion route, which is the
 * only reason a trace is not lost when a turn's LAST tool finishes: the
 * heartbeat publish is fenced on `runLeaseFence` (`status = 'running'`), and
 * completion sets `status = 'completed'` in its own transaction, so a trace
 * flushed on that final beat matches no row and disappears. A single-tool turn
 * loses its only trace that way every time, not occasionally.
 *
 * One builder rather than two call sites writing the same object: the SPA, the
 * menubar and the promptfoo provider all read this shape, and a second
 * hand-written copy is how the two paths start disagreeing about it.
 *
 * Idempotence is by the canonical key, in order, with no silent cleanup:
 * each trace is preflighted against the stored row for its key across ALL
 * delivery states (the lookup is by the indexed key, never a numeric-ID
 * scan). A missing key is inserted; an exact duplicate is recognised without
 * a second row; a conflicting same-key payload throws, so the caller answers
 * no ack and the worker retries rather than retiring evidence unwritten. The
 * returned count therefore always names a fully durably known prefix. A
 * unique-violation race between two holders of the conversation lock is
 * re-read inside a savepoint and resolved the same way, never swallowed.
 */
async function insertTurnToolEventRows(
	tx: DbClient,
	args: {
		reply: TurnReply;
		conversationId: string;
		organizationId: string | null;
		events: readonly AgentTurnToolEvent[];
		/** Reply envelope by initiating input run id, derived from stored rows. */
		repliesByInputRunId?: ReadonlyMap<number, TurnReply>;
		/** Failed completion may omit an explicitly attributed trace whose input vanished. */
		skipUnknownInput?: boolean;
	}
): Promise<number> {
	let durablyKnown = 0;
	for (const event of args.events) {
		const routed = event.input_run_id !== undefined ? args.repliesByInputRunId?.get(event.input_run_id) : undefined;
		if (event.input_run_id !== undefined && !routed) {
			if (args.skipUnknownInput) continue;
			throw new Error(`agent turn tool trace names unknown input ${event.input_run_id}`);
		}
		// Missing attribution is the legacy worker contract and belongs to the
		// owner. Explicit attribution must resolve above; it never falls back.
		const reply = routed ?? args.reply;
		const payload = {
			messageId: reply.message_id,
			channelId: args.reply.channel_id,
			conversationId: args.conversationId,
			userId: reply.user_id,
			teamId: reply.team_id ?? "api",
			platform: reply.platform,
			organizationId: args.organizationId,
			platformMetadata: reply.platform_metadata,
			customEvent: {
				name: "tool_use",
				data: {
					toolCallId: event.tool_call_id,
					name: event.name,
					// `buildToolUseEventPayload`'s shape: the SPA reads the args here.
					input: event.input ?? null,
					isError: event.is_error,
					// An error's summary is its message; a successful call's is the
					// retrieval evidence the worker summarised from the unclipped
					// result. The promptfoo provider reads `snippets` to build
					// `metadata.retrievedContext`, so dropping it on success left
					// every RAG assertion with nothing to assert against.
					result_summary: event.is_error
						? { error: event.output }
						: event.result_summary,
				},
			},
			timestamp: Date.now(),
		};
		const key = turnToolEventKey({
			organizationId: args.organizationId,
			conversationId: args.conversationId,
			messageId: reply.message_id,
			toolCallId: event.tool_call_id,
		});
		// Preflight across every delivery state: the key's unique index has no
		// status predicate, so a delivered row still collides. Nothing is
		// deleted or updated here — a stored row is either the same trace
		// (recognised, no second row) or a conflicting one (rejected, no ack).
		const existing = (await tx`
      SELECT action_input FROM public.runs WHERE idempotency_key = ${key} LIMIT 1
    `) as unknown as Array<{ action_input: unknown }>;
		if (existing[0]) {
			if (!sameToolTracePayload(existing[0].action_input, payload)) {
				throw new Error(
					`agent turn tool trace ${event.tool_call_id} conflicts with the stored trace for its conversation/input`
				);
			}
			durablyKnown += 1;
			continue;
		}
		const insert = (db: DbClient) =>
			insertThreadResponseRow(db, payload, args.organizationId, { idempotencyKey: key });
		try {
			if (typeof tx.savepoint === "function") await tx.savepoint(insert);
			else await insert(tx);
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			const raced = (await tx`
        SELECT action_input FROM public.runs WHERE idempotency_key = ${key} LIMIT 1
      `) as unknown as Array<{ action_input: unknown }>;
			if (!raced[0] || !sameToolTracePayload(raced[0].action_input, payload)) {
				throw new Error(
					`agent turn tool trace ${event.tool_call_id} conflicts with the stored trace for its conversation/input`
				);
			}
		}
		durablyKnown += 1;
	}
	return durablyKnown;
}

/**
 * Publish an in-flight turn's tool traces, absorbing any failure into a
 * missing acknowledgement.
 *
 * Same contract as the delta path and for the same reason: a view of the turn
 * must never fail the heartbeat that keeps the turn alive. Counted rather than
 * silenced, so a broken trace path is visible. The caller gets `undefined` —
 * no ack — and the worker keeps the traces queued and re-sends them; only a
 * positive `turn_tool_ack` retires them. A liveness-only beat sends no traces
 * and therefore acknowledges none.
 */
export async function publishTurnToolEventsBestEffort(
	runId: number,
	workerId: string,
	events: readonly AgentTurnToolEvent[]
): Promise<number | undefined> {
	try {
		return await publishTurnToolEvents(runId, workerId, events);
	} catch (err) {
		incrementCounter("lobu_turn_tool_event_publish_failed_total");
		logger.debug(
			{ runId, err: errorMessage(err) },
			"Failed to publish agent turn tool traces"
		);
		return undefined;
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

/**
 * Publish a liveness status for an in-flight `agent_turn` whose beat carried
 * nothing to show.
 *
 * The subprocess lane sent an unconditional 20s `status_update`, so a turn that
 * was thinking or running a tool still said so on the wire. The isolate lane
 * beats without one, leaving most of a long turn indistinguishable from a dead
 * worker to anything downstream — the SPA's stream, and the chat platforms'
 * typing indicator, which is driven entirely by this row
 * (`chat-response-bridge.handleStatusUpdate`). This restores the signal on the
 * beat the turn already sends.
 *
 * Only for an otherwise-silent beat: a delta or a tool trace is already proof
 * of progress, and a second signal alongside it would just be write
 * amplification.
 *
 * Routing is read from the run's own row, never the worker's body, exactly as
 * the delta path does. Non-terminal and best-effort — a dropped status costs a
 * stale indicator, never an answer.
 */
async function publishTurnStatus(
	runId: number,
	workerId: string
): Promise<void> {
	const sql = getDb();
	const emitted = await sql.begin(async (tx) => {
		const owner = await lockAgentTurnRun(tx, runId);
		if (!owner || owner.run_metadata?.cancel_requested_at) return false;
		const rows = (await tx`
      SELECT action_input, organization_id, claimed_at
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
			claimed_at: Date | string | null;
		}>;
		const row = rows[0];
		if (!row) return false;
		const envelope = row.action_input ?? {};
		const reply = envelope.reply;
		if (!reply) return false;
		const now = Date.now();
		const claimedAtMs = row.claimed_at ? new Date(row.claimed_at).getTime() : now;
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
				statusUpdate: {
					elapsedSeconds: Math.max(0, Math.round((now - claimedAtMs) / 1000)),
					state: "is working",
				},
				timestamp: now,
			},
			row.organization_id
		);
		return true;
	});
	if (emitted) await notifyThreadResponse();
}

/** Never let a status publish fail the heartbeat that carried it. */
export async function publishTurnStatusBestEffort(
	runId: number,
	workerId: string
): Promise<void> {
	try {
		await publishTurnStatus(runId, workerId);
	} catch (err) {
		incrementCounter("lobu_turn_status_publish_failed_total");
		logger.debug(
			{ runId, err: errorMessage(err) },
			"Failed to publish an agent turn liveness status"
		);
	}
}

/**
 * Canonical JSON: sorted object keys, recursed, so the same semantic
 * completion always hashes the same no matter how the worker ordered its
 * fields. `undefined` stays undefined (dropped by the stringifier exactly as
 * `tx.json` drops it on the way into the stored row); callers normalise
 * absent-vs-empty themselves with explicit `null`.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The stable semantic identity of one agent-turn completion: everything the
 * terminal transition durably records, normalised the way it is stored
 * (`stripNul` on prose, `null` for absent optionals, receipts and traces in
 * order). Transport noise — timestamps, attempt counters — is excluded, so an
 * at-least-once retry of the same completion hashes identically while a
 * rewritten answer, a different receipt set, or a flipped status does not.
 *
 * Persisted on `run_metadata.turn_completion_hash` by the terminal transition
 * below (an existing run row, no new table). A retry that presents the same
 * hash is acknowledged without a second write; one that presents a different
 * hash is rejected without a second terminal. Rows completed before the marker
 * existed carry no hash and keep the legacy accept-any-retry idempotence, so
 * mixed-version claims still drain.
 */
function agentTurnCompletionHash(body: CompleteAgentTurnRequest): string {
  const nul = (value: string | undefined | null): string | null =>
    typeof value === "string" ? stripNul(value) : null;
  const canonical = {
    status: body.status,
    text: nul(body.text ?? null),
    stop_reason: body.stop_reason ?? null,
    usage: body.usage ?? null,
    session_jsonl: typeof body.session_jsonl === "string" ? body.session_jsonl : null,
    consumed_inputs:
      body.consumed_inputs === undefined
        ? null
        : body.consumed_inputs.map((receipt) => ({
            run_id: receipt.run_id,
            session_entry_id: receipt.session_entry_id,
            response_text: nul(receipt.response_text ?? null),
            tools_used: receipt.tools_used ?? null,
            first_error: nul(receipt.first_error ?? null),
          })),
    tools_used: body.tools_used ?? null,
    first_error: nul(body.first_error ?? null),
    replied_in_band: body.replied_in_band ?? null,
    turn_tool_events:
      body.turn_tool_events === undefined
        ? null
        : body.turn_tool_events.map((event) => ({
            tool_call_id: event.tool_call_id,
            name: event.name,
            input_run_id: event.input_run_id ?? null,
            input: event.input ?? null,
            is_error: event.is_error,
            output: event.output,
            result_summary: event.result_summary ?? null,
          })),
    error: nul(typeof body.error === "string" ? body.error : null),
    exit_reason: body.exit_reason ?? null,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
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
  // Per-input attribution is all-or-nothing: a worker that attributes one
  // input must attribute them all, so no reply ever borrows a sibling's text.
  // Receipts without `response_text` are the older single-reply contract those
  // claims were admitted under, delivered as one execution-wide reply.
  const perInput = receipts.some((receipt) => receipt.response_text !== undefined);
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
    if (perInput && !receipt.response_text?.trim()) {
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
      const terminal = run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed';
      // Exact-retry idempotence, checked BEFORE any new-write/seal work: the
      // terminal transition stamped the semantic hash of what it durably
      // recorded, so a retry presenting the same completion is acknowledged
      // without touching anything, while a conflicting one is rejected without
      // a second terminal. Rows completed before the marker existed carry no
      // hash and keep the legacy accept-any-retry idempotence, so
      // mixed-version claims still drain instead of 409ing forever.
      const known = typeof run.run_metadata?.turn_completion_hash === 'string'
        ? run.run_metadata.turn_completion_hash : null;
      if (known === null) return { status: terminal, idempotent: true };
      if (agentTurnCompletionHash(body) === known) return { status: terminal, idempotent: true };
      return { error: 'Agent turn completion conflicts with the stored terminal result', code: 409 as const };
    }
    if (run.status !== 'running' && !(run.status === 'claimed' && run.run_metadata?.cancel_requested_at)) {
      return { error: 'Run is not in progress', code: 409 as const };
    }
    const envelope = run.action_input ?? {};
    if (!envelope.reply) return { error: 'Agent turn has no reply envelope', code: 409 as const };
    const cancelling = !!run.run_metadata?.cancel_requested_at;
    const offered = !cancelling && body.status === 'completed' ? await pendingAgentTurnInputs(tx, run) : [];
    let invalid = typeof snapshot === 'string' ? snapshot
      : !cancelling && body.status === 'completed' && snapshot ? inputReceiptError(run, body, snapshot, offered) : undefined;
    // A follower lost to a cancel/reaper race between admission and this
    // commit fails the turn honestly rather than completing it around a hole:
    // the owner lands `failed` with an error terminal below, the surviving
    // followers stay pending for the next turn, and nothing is delivered for
    // an input the turn can no longer attribute. Rows are locked in receipt
    // (id) order under the conversation lock, so no writer can interleave.
    if (!invalid && !cancelling && body.status === 'completed' && body.consumed_inputs?.length) {
      for (const receipt of body.consumed_inputs) {
        const [follower] = await tx<Pick<NativeTurnRun, 'id' | 'status'>>`
          SELECT id, status FROM runs WHERE id = ${receipt.run_id} FOR UPDATE`;
        if (!follower || follower.status !== 'pending') {
          invalid = 'agent turn lost a consumed input before delivery';
          break;
        }
      }
    }
    const error = cancelling ? 'agent turn cancelled' : invalid ?? (typeof body.error === 'string' ? stripNul(body.error).trim() : '');
    const status = cancelling ? 'cancelled' : body.status === 'failed' || invalid ? 'failed' : 'completed';
    // Rendering needs the code; `classifyRunOutcome` deliberately does NOT get
    // it. It derives the same code from the same message itself, but only
    // AFTER checking the agent-protocol patterns — handing it an explicit code
    // here would short-circuit that ordering and let a protocol violation whose
    // tail quotes a provider limit excuse itself as infra.
    const errorCode = status === 'failed' ? classifyErrorMessage(error) : undefined;
    const consumed = status === 'completed' ? body.consumed_inputs! : [];
    const conversationId = envelope.turn!.conversation_id;
    // What this turn leaves for the next one to hydrate — bounded once, here,
    // so the run row and the snapshot table keep the same thing.
    const stored = status === 'completed' && snapshot && typeof snapshot !== 'string'
      ? boundSnapshot(snapshot, body.session_jsonl!, { runId: body.run_id, conversationId }) : undefined;
    // Stamp the semantic identity of THIS completion on the run row, so an
    // at-least-once retry is answered exactly (same hash) or rejected
    // (conflict) without ever writing a second terminal.
    const completionHash = agentTurnCompletionHash(body);
    await tx`UPDATE runs SET status = ${status}, completed_at = now(),
      outcome = ${classifyRunOutcome({ status, errorMessage: error })},
      error_message = ${status === 'completed' ? null : error || 'agent turn failed'},
      output_tail = ${text ? text.slice(-MAX_OUTPUT_TAIL) : null},
      exit_reason = ${cancelling ? 'cancelled' : invalid ? 'error_message' : body.exit_reason ?? (status === 'completed' ? 'ok' : 'error_message')},
      run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${tx.json({ turn_completion_hash: completionHash })}::jsonb,
      action_input = ${tx.json({ ...envelope, result: {
        text, stop_reason: body.stop_reason ?? null, usage: body.usage ?? null,
        ...(stored !== undefined ? { session_jsonl: stored } : {}),
      } })}
      WHERE id = ${run.id}`;
    // Offered rows are newer than the owner and ordered by ID. The conversation
    // lock prevents another admission/cancel/claim from racing these completions.
    //
    // One terminal outbox row per input, each stamped with its own input's
    // text, tools, and first error — never the execution-wide values, which
    // would attribute a sibling input's work to this reply (#3662). Receipts
    // without `response_text` are the older single-reply contract: one owner
    // row covering every message, exactly as before, so old claims drain
    // under the contract they were admitted with.
    const perInput = status === 'completed' && consumed.some((receipt) => receipt.response_text !== undefined);
    const completedFollowers: NativeTurnRun[] = [];
    for (const receipt of consumed) {
      const responseText = perInput ? stripNul(receipt.response_text ?? '') : text;
      const [follower] = await tx<NativeTurnRun>`UPDATE runs SET status = 'completed', completed_at = now(), outcome = 'scoreable', exit_reason = 'ok',
        output_tail = ${responseText ? responseText.slice(-MAX_OUTPUT_TAIL) : null},
        run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${tx.json({
          consumed_by_run_id: Number(run.id), session_entry_id: receipt.session_entry_id,
        })}::jsonb WHERE id = ${receipt.run_id} AND status = 'pending'
        RETURNING id, organization_id, parent_run_id, status, claimed_by, action_input, run_metadata`;
      // Verified pending above under the same lock, so a miss here is a
      // lock-ordering surprise, not a race: fail closed and roll everything
      // back rather than delivering a partial turn.
      if (!follower) throw new Error('agent turn lost a consumed input before delivery');
      completedFollowers.push(follower);
    }
    await releaseNextAgentTurn(tx, run);
    const reply = envelope.reply!;
    if (stored !== undefined) await persistTurnSnapshot(tx, {
      organizationId: run.organization_id, agentId: envelope.turn!.agent_id, conversationId,
      runId: body.run_id, sessionJsonl: stored,
    });
    // Traces the worker could not get onto a beat, written on the SAME
    // transaction as the answer and BEFORE it, so the client reads the tool
    // rows ahead of the reply they explain. The heartbeat path cannot land
    // these: it fences on `status = 'running'`, which this transaction has
    // already changed.
    //
    // Routed per initiating input off the receipt's `input_run_id`, resolved
    // against the offered rows stored above — never off caller strings. A
    // delayed tool result that landed after a mid-turn follow-up is delivered
    // under the message that initiated it.
    if (body.turn_tool_events?.length) {
      const repliesByInputRunId = new Map<number, TurnReply>(
        offered.slice(0, consumed.length).map((input) => [input.run_id, { ...reply, message_id: input.message_id }]),
      );
      await insertTurnToolEventRows(tx, {
        reply,
        conversationId,
        organizationId: run.organization_id,
        events: body.turn_tool_events,
        repliesByInputRunId,
        // A cancel/reaper can remove an input before a failed completion. Its
        // explicitly attributed trace cannot be routed safely, so quarantine
        // it instead of attaching it to the owner. Healthy completions reject
        // an unknown attribution and roll back.
        ...(status !== 'completed' ? { skipUnknownInput: true } : {}),
      });
    }
    const ownerFirstError = typeof body.first_error === 'string' ? stripNul(body.first_error).trim() : '';
    await insertAgentTurnResponse(tx, run, {
      // `tools_used` is forwarded as sent, NOT defaulted to `[]`. Absent and
      // empty are different claims downstream: `requireTool` passes on absent
      // (it cannot prove a miss) and trips on empty, and the follow-up bridge
      // skips on absent to avoid duplicating a card mid-deployment. Turning a
      // worker that reported nothing into "called nothing" would invent that
      // claim. The guest always sends the array, so absent means a genuinely
      // older worker.
      //
      // Per-input workers scope this ledger to the owner input; each steered
      // input's own ledger rides its receipt below. Stamping one execution-wide
      // union onto every reply is what let a Draft-less turn report a Draft.
      ...(status === 'completed'
        ? {
            finalText: text,
            ...(body.tools_used ? { toolsUsed: body.tools_used } : {}),
            ...(ownerFirstError ? { firstToolError: ownerFirstError } : {}),
            // `replied_in_band` is an execution-wide signal the guest cannot
            // attribute per input, so it stays on the owner's row only:
            // stamping it everywhere would suppress every steered reply on the
            // strength of one in-band post.
            ...(body.replied_in_band ? { repliedInBand: true } : {}),
          }
        : {
            error: error || 'agent turn failed',
            ...(errorCode ? { errorCode, errorContext: envelope.reply!.error_context } : {}),
          }),
      processedMessageIds: perInput ? [reply.message_id] : [reply.message_id, ...offered.slice(0, consumed.length).map((input) => input.message_id)],
    });
    // Each consumed steered input gets its own terminal outbox row, routed by
    // its STORED reply envelope — the trusted scope — carrying its own answer,
    // its own tool ledger, and its own verbatim first error. Committed in the
    // same transaction as the owner row above, so crash recovery reads one
    // terminal per input or none at all. Legacy single-reply receipts write no
    // follower rows at all: the owner's row already covers every message, and
    // an extra row per follower would deliver the same reply N times.
    if (!perInput) return { status, notify: true };
    for (const [index, follower] of completedFollowers.entries()) {
      const receipt = consumed[index]!;
      const followerReply = follower.action_input?.reply;
      const followerResponse = stripNul(receipt.response_text ?? '').trim();
      if (!followerReply || !followerResponse) {
        throw new Error('consumed input has no reply envelope or response');
      }
      await insertAgentTurnResponse(tx, follower, {
        finalText: followerResponse,
        ...(receipt.tools_used ? { toolsUsed: receipt.tools_used } : {}),
        ...(typeof receipt.first_error === 'string' && stripNul(receipt.first_error).trim()
          ? { firstToolError: stripNul(receipt.first_error).trim() } : {}),
        processedMessageIds: [followerReply.message_id],
      });
    }
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
