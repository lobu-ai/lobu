/**
 * Retry for an agent turn that ended on a worker failure.
 *
 * When a worker dies or wedges after its turn already ran a tool, the reaper
 * (or the turn-liveness marker) ends the turn with a WORKER_* error instead of
 * re-running it, because the re-run could repeat a side effect. The user gets
 * a Retry action on that error. Pressing it admits the SAME message again
 * through the normal `messages` queue, so the turn is produced exactly as the
 * original was (marker, model policy, producer) and keeps the original input
 * message id. Turn-scoped write receipts key on that id, so a write the failed
 * attempt already made is replayed rather than repeated.
 *
 * When the failed attempt(s) did run tools, the new turn's transient context
 * (`ephemeralContext`) starts with a note listing them, built from the stored
 * tool traces plus the gateway's started stamps for calls whose trace never
 * arrived, so the model continues instead of starting over.
 */

import { AgentErrorCode, type MessagePayload } from "@lobu/core";
import { type DbClient, getDb, pgTextArray } from "../../db/client.js";
import {
  AGENT_TURN_TOOL_LOG_MAX,
  lockAgentTurnRun,
  type NativeTurnRun,
} from "../../runs/agent-turn-inputs.js";
import { turnToolEventKey } from "../../worker-api/agent-turn.js";
import { messagesJobOptions } from "../infrastructure/queue/queue-producer.js";
import { insertQueueJob } from "../infrastructure/queue/runs-queue.js";

/** The worker failures a user may retry: the turn did not finish because its worker did not. */
const RETRYABLE_TURN_ERROR_CODES: ReadonlySet<string> = new Set([
  AgentErrorCode.WORKER_DIED,
  AgentErrorCode.WORKER_UNRESPONSIVE,
  AgentErrorCode.WORKER_STARTUP_FAILED,
]);

export function isRetryableTurnError(code: unknown): boolean {
  return typeof code === "string" && RETRYABLE_TURN_ERROR_CODES.has(code);
}

/**
 * The failed turn a retry admission answers, carried on the retried message's
 * `platformMetadata` (and so on its turn's reply envelope). A retry of a retry
 * walks this link back through a bounded number of failed attempts at the
 * same message.
 */
const RETRY_OF_TURN_RUN_ID = "retryOfTurnRunId";
// Strip the generated prefix before rebuilding it when a retry itself fails.
const RETRY_NOTE_LENGTH = "retryNoteLength";

/** Chat action id of the Retry button on a worker-failure error. */
const TURN_RETRY_ACTION_PREFIX = "turn-retry:";

export function turnRetryActionId(turnRunId: number): string {
  return `${TURN_RETRY_ACTION_PREFIX}${turnRunId}`;
}

export function parseTurnRetryActionId(actionId: string): number | undefined {
  if (!actionId.startsWith(TURN_RETRY_ACTION_PREFIX)) return undefined;
  const raw = actionId.slice(TURN_RETRY_ACTION_PREFIX.length);
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && String(id) === raw ? id : undefined;
}

export type AgentTurnRetryOutcome =
  | { status: "started"; retryRunId: number; note?: string }
  | { status: "already_retried"; retryRunId: number }
  | { status: "forbidden" }
  | { status: "not_retryable" }
  | { status: "not_found" };

/** What the person who pressed Retry is told when nothing new started. */
export function turnRetryRefusal(outcome: AgentTurnRetryOutcome): string | undefined {
  switch (outcome.status) {
    case "started":
      return undefined;
    case "already_retried":
      return "This message is already being retried.";
    case "forbidden":
      return "Only the person who sent this message can retry it.";
    case "not_retryable":
      return "This message can't be retried any more. Send it again instead.";
    case "not_found":
      return "I couldn't find that message to retry.";
  }
}

/** Failed attempts this far back are still named in the note. */
const RETRY_CHAIN_MAX = 4;
/** Longest one line of the note may be. */
const NOTE_LINE_CHARS = 240;
/**
 * The note's whole budget. The turn's transient context is capped at
 * `CHAT_TURN_CONTEXT_CHARS` (2,048 characters) and the note comes first, leaving
 * room for the sender line and caller context behind it.
 */
const NOTE_BUDGET_CHARS = 1_200;

function clip(text: string, max: number): string {
  const flat = text.replaceAll("\r", " ").replaceAll("\n", " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function retryOf(run: Pick<NativeTurnRun, "action_input">): number | undefined {
  const value = run.action_input?.reply?.platform_metadata?.[RETRY_OF_TURN_RUN_ID];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** `run` and the failed attempts it retried, oldest first, by primary key. */
async function failedAttempts(sql: DbClient, run: NativeTurnRun): Promise<NativeTurnRun[]> {
  const chain = [run];
  let previous = retryOf(run);
  while (previous !== undefined && chain.length < RETRY_CHAIN_MAX) {
    const [row] = await sql<NativeTurnRun>`
      SELECT id, organization_id, parent_run_id, status, claimed_by, action_input, run_metadata
      FROM runs
      WHERE id = ${previous} AND run_type = 'agent_turn' AND organization_id = ${run.organization_id}
        AND action_input->'turn'->>'message_id' = ${run.action_input?.turn?.message_id ?? null}
    `;
    if (!row) break;
    chain.unshift(row);
    previous = retryOf(row);
  }
  return chain;
}

interface StoredToolTrace {
  name?: unknown;
  input?: unknown;
  isError?: unknown;
  result_summary?: { error?: unknown; snippets?: Array<{ text?: unknown }> } | null;
}

function tracedLine(trace: StoredToolTrace): string {
  const name = typeof trace.name === "string" ? trace.name : "tool";
  const args = trace.input === undefined || trace.input === null ? "" : clip(JSON.stringify(trace.input), 120);
  const summary = trace.result_summary;
  const outcome = trace.isError === true
    ? `error: ${clip(typeof summary?.error === "string" ? summary.error : "failed", 100)}`
    : typeof summary?.snippets?.[0]?.text === "string"
      ? `ok: ${clip(summary.snippets[0].text, 80)}`
      : "ok";
  return clip(`- ${name}(${args}) → ${outcome}`, NOTE_LINE_CHARS);
}

/**
 * Summarize recorded tool activity for a retry, warning when history is incomplete.
 *
 * Per attempt, oldest first: its stored traces in the order they were stored,
 * then every call the gateway recorded as started that no trace accounts for
 * (matched by tool name), as "started, outcome unknown". Clipped per line and
 * to {@link NOTE_BUDGET_CHARS} overall.
 */
export async function buildInterruptedTurnNote(sql: DbClient, run: NativeTurnRun): Promise<string | undefined> {
  const lines: string[] = [];
  const attempts = await failedAttempts(sql, run);
  if (retryOf(attempts[0]!) !== undefined || attempts.some((attempt) =>
    (attempt.run_metadata?.turn_tool_call_ids?.length ?? 0) >= AGENT_TURN_TOOL_LOG_MAX
    || (attempt.run_metadata?.turn_started_tools?.length ?? 0) >= AGENT_TURN_TOOL_LOG_MAX)) {
    lines.push("- Earlier or additional tool activity may be omitted; check for effects before repeating it.");
  }
  for (const attempt of attempts) {
    const messageId = attempt.action_input?.reply?.message_id;
    const callIds = attempt.run_metadata?.turn_tool_call_ids ?? [];
    const keys = messageId
      ? callIds.map((toolCallId) => turnToolEventKey({
          organizationId: attempt.organization_id,
          conversationId: String(attempt.action_input?.turn?.conversation_id ?? ""),
          messageId,
          toolCallId,
        }))
      : [];
    const rows = keys.length
      ? await sql<{ idempotency_key: string; data: StoredToolTrace | null }>`
          SELECT idempotency_key, action_input->'customEvent'->'data' AS data
          FROM runs
          WHERE queue_name = 'thread_response'
            AND action_input->'customEvent'->>'name' = 'tool_use'
            AND idempotency_key = ANY(${pgTextArray(keys)}::text[])
        `
      : [];
    const byKey = new Map(rows.map((row) => [row.idempotency_key, row.data ?? {}]));
    const traced = keys.flatMap((key) => {
      const trace = byKey.get(key);
      return trace ? [trace] : [];
    });
    const unmatched = new Map<string, number>();
    for (const trace of traced) {
      lines.push(tracedLine(trace));
      const name = typeof trace.name === "string" ? trace.name : "";
      unmatched.set(name, (unmatched.get(name) ?? 0) + 1);
    }
    for (const name of attempt.run_metadata?.turn_started_tools ?? []) {
      const left = unmatched.get(name) ?? 0;
      if (left > 0) unmatched.set(name, left - 1);
      else lines.push(clip(`- ${name}: started, outcome unknown`, NOTE_LINE_CHARS));
    }
    if (keys.length > traced.length || (attempt.run_metadata?.turn_tool_started === true
      && !traced.length && !attempt.run_metadata.turn_started_tools?.length)) {
      lines.push("- Tool activity was recorded, but its details are unavailable; check for effects before repeating it.");
    }
  }
  if (!lines.length) return undefined;
  const head = "A previous attempt at this message was interrupted after it already did:";
  const tail = "Don't repeat these; continue from here.";
  const kept: string[] = [];
  let size = head.length + tail.length + 2;
  for (const [index, line] of lines.entries()) {
    const more = `- …and ${lines.length - index} more`;
    const reserve = index < lines.length - 1 ? more.length + 1 : 0;
    if (size + line.length + 1 + reserve > NOTE_BUDGET_CHARS) {
      kept.push(more);
      break;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return [head, ...kept, tail].join("\n");
}

/**
 * Start a new turn for the message whose turn `turnRunId` ended on a worker
 * failure.
 *
 * Only the message's sender may retry it (`actorUserId` in the reply's own id
 * space: the platform user on chat, the Lobu user on the API), only for a
 * turn the reaper or the liveness marker closed with a retryable worker
 * failure, and only once per failed turn. The failed run is row-locked under
 * its conversation lock and stamped with the admitted run in the same
 * transaction, so a double press admits one turn.
 *
 * `connectionId`, when given, must be the connection the message arrived on.
 */
export async function retryInterruptedAgentTurn(input: {
  organizationId: string;
  turnRunId: number;
  actorUserId: string;
  connectionId?: string;
}): Promise<AgentTurnRetryOutcome> {
  return getDb().begin(async (tx: DbClient): Promise<AgentTurnRetryOutcome> => {
    const run = await lockAgentTurnRun(tx, input.turnRunId);
    const reply = run?.action_input?.reply;
    if (!run || !reply || run.organization_id !== input.organizationId
      || (input.connectionId !== undefined && reply.platform_metadata?.connectionId !== input.connectionId)) {
      return { status: "not_found" };
    }
    if (reply.user_id !== input.actorUserId) return { status: "forbidden" };
    const retried = run.run_metadata?.turn_retry_run_id;
    if (typeof retried === "number") return { status: "already_retried", retryRunId: retried };
    if (run.status !== "timeout" || !isRetryableTurnError(run.run_metadata?.turn_error_code)) {
      return { status: "not_retryable" };
    }
    const [source] = await tx<{ action_input: MessagePayload | null }>`
      SELECT action_input FROM runs
      WHERE id = ${run.parent_run_id} AND organization_id = ${run.organization_id}
        AND run_type = 'chat_message' AND queue_name = 'messages'
        AND action_input->>'messageId' = ${reply.message_id}
    `;
    // The admitted message is pruned with the runs retention; nothing is left to re-admit.
    if (!source?.action_input) return { status: "not_retryable" };
    const note = await buildInterruptedTurnNote(tx, run);
    // Re-admitted as a new `messages` run: the consumer binds its own run id and mints its own token.
    const original: MessagePayload = { ...source.action_input };
    delete original.runId;
    delete original.runJobToken;
    const priorNoteLength = original.platformMetadata?.[RETRY_NOTE_LENGTH];
    const originalContext = retryOf(run) !== undefined && typeof priorNoteLength === "number"
      ? original.ephemeralContext?.slice(priorNoteLength) : original.ephemeralContext;
    const ephemeralContext = [note, originalContext?.trim()].filter(Boolean).join("\n\n");
    const payload: MessagePayload = {
      ...original,
      ephemeralContext: ephemeralContext || undefined,
      platformMetadata: {
        ...original.platformMetadata,
        [RETRY_OF_TURN_RUN_ID]: Number(run.id),
        [RETRY_NOTE_LENGTH]: note?.length ?? 0,
      },
    };
    const admitted = Number(await insertQueueJob(tx, "messages", payload, messagesJobOptions(payload)));
    if (!Number.isSafeInteger(admitted) || admitted <= 0) {
      throw new Error("Retry could not admit the message");
    }
    await tx`UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb)
        || ${tx.json({ turn_retry_run_id: admitted })}::jsonb
      WHERE id = ${run.id}`;
    return { status: "started", retryRunId: admitted, ...(note ? { note } : {}) };
  });
}
