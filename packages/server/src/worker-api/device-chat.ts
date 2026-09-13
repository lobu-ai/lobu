import { type MessagePayload, parseSessionEntries } from "@lobu/core";
import {
	type CompleteDeviceChatRequest,
	CompleteDeviceChatRequestSchema,
} from "@lobu/core/contracts/worker/protocol";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "hono";
import { getDb } from "../db/client";
import { incrementCounter } from "../gateway/metrics/prometheus";
import {
	insertThreadResponseRow,
	notifyThreadResponse,
} from "../gateway/orchestration/turn-liveness";
import { threadIdFromApiConversationId } from "../gateway/services/api-conversation-id";
import {
	classifyConversation,
	upsertConversation,
} from "../gateway/services/conversations-store";
import {
	MAX_SNAPSHOT_BYTES,
	readSnapshotJsonl,
} from "../gateway/services/transcript-snapshot";
import type { Env } from "../index";
import { classifyRunOutcome } from "../runs/run-outcome";
import { stripNul } from "../utils/strip-nul";
import {
	authorizePinnedDeviceForWorker,
	authorizeRunForWorker,
} from "./shared";
import { runLeaseFence } from "../runs/run-lease";

const MAX_REPLY_BYTES = 512 * 1024;

export function boundedReply(value: string): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.byteLength <= MAX_REPLY_BYTES) return value;
	// Back off the cut to a code-point boundary: slicing mid-sequence would
	// render the last character of a truncated reply as U+FFFD.
	let end = MAX_REPLY_BYTES;
	while (end > 0 && (buffer[end] ?? 0) >> 6 === 0b10) end -= 1;
	return `${buffer.subarray(0, end).toString("utf8")}\n\n[Reply truncated by Lobu]`;
}

function deviceSessionHeader(payload: MessagePayload, now: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: `device-chat-${payload.conversationId}`,
		timestamp: now,
		cwd: "/device",
		executionTarget: payload.executionTarget,
	});
}

/** Persist device placement in the durable session header on every turn. */
function stampExecutionTarget(
	previous: string | null,
	payload: MessagePayload,
	now: string,
): string {
	const prefix = previous?.endsWith("\n")
		? previous
		: previous
			? `${previous}\n`
			: "";
	if (!prefix) return `${deviceSessionHeader(payload, now)}\n`;
	const lineEnd = prefix.indexOf("\n");
	try {
		const header = JSON.parse(prefix.slice(0, lineEnd)) as Record<
			string,
			unknown
		>;
		if (header.type === "session") {
			return `${JSON.stringify({ ...header, executionTarget: payload.executionTarget })}${prefix.slice(lineEnd)}`;
		}
	} catch {
		// A malformed legacy prefix remains readable after a fresh session header.
	}
	// Both ways of reaching here — an unparseable first line and a parsed one
	// whose type is not "session" — are the same compat: a stored prefix
	// kept readable under a freshly prepended header. Count the fallback, not
	// just the throwing arm, or the sunset gate reads quiet while the other
	// arm is still being taken.
	incrementCounter("lobu_legacy_compat_hits_total", {
		path: "legacy_session_prefix",
	});
	return `${deviceSessionHeader(payload, now)}\n${prefix}`;
}

function buildSnapshot(
	previous: string | null,
	payload: MessagePayload,
	output: string,
	runId: number,
): string {
	const now = new Date().toISOString();
	const prefix = stampExecutionTarget(previous, payload, now);
	const priorEntries = parseSessionEntries(prefix).entries;
	const parentId = priorEntries[priorEntries.length - 1]?.id ?? null;
	const userId = `device-user-${runId}`;
	const userText = payload.messageText.slice(0, 32_000);
	const buildUser = (parent: string | null) =>
		JSON.stringify({
			type: "message",
			id: userId,
			parentId: parent,
			timestamp: now,
			message: {
				role: "user",
				content: [{ type: "text", text: userText }],
			},
		});
	const user = buildUser(parentId);
	const assistant = JSON.stringify({
		type: "message",
		id: `device-assistant-${runId}`,
		parentId: userId,
		timestamp: now,
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
		},
	});
	const snapshot = `${prefix}${user}\n${assistant}\n`;
	if (Buffer.byteLength(snapshot, "utf8") <= MAX_SNAPSHOT_BYTES)
		return snapshot;
	// A very old/large transcript must not make the current turn fail. Start a
	// compact continuation snapshot; the durable prior run remains queryable.
	const session = `${deviceSessionHeader(payload, now)}\n`;
	return `${session}${buildUser(null)}\n${assistant}\n`;
}

/** Complete a device-placed chat turn and adapt it into the standard chat stores. */
export async function completeDeviceChatRun(c: Context<{ Bindings: Env }>) {
	const runId = Number(c.req.param("runId"));
	if (!Number.isSafeInteger(runId) || runId <= 0) {
		return c.json({ error: "Invalid runId" }, 400);
	}
	let rawBody: unknown;
	try {
		rawBody = await c.req.json();
	} catch {
		return c.json({ error: "Invalid or missing JSON body" }, 400);
	}
	if (!Value.Check(CompleteDeviceChatRequestSchema, rawBody)) {
		return c.json({ error: "Invalid device chat completion body" }, 400);
	}
	const body = rawBody as CompleteDeviceChatRequest;
	const denied = await authorizeRunForWorker(c, runId, body.worker_id, {
		allowTerminal: true,
	});
	if (denied) return denied;

	const sql = getDb();
	const rows = await sql<{
		status: string;
		claimed_by: string | null;
		action_input: MessagePayload | null;
	}>`
    SELECT status, claimed_by, action_input
    FROM public.runs
    WHERE id = ${runId}
      AND run_type = 'chat_message'
      AND queue_name = 'messages'
    LIMIT 1
  `;
	const run = rows[0];
	if (!run?.action_input)
		return c.json({ error: "Device chat run not found" }, 404);
	if (run.claimed_by !== body.worker_id || run.status !== "running") {
		return c.json({
			ok: true,
			status: run.status === "completed" ? "completed" : "failed",
			idempotent: true,
		});
	}
	const payload = run.action_input;
	const target = payload.executionTarget;
	if (target?.kind !== "device") {
		return c.json({ error: "Run is not device-placed" }, 409);
	}
	const deviceDenied = await authorizePinnedDeviceForWorker(
		c,
		body.worker_id,
		target.deviceWorkerId,
	);
	if (deviceDenied) return deviceDenied;

	const output =
		typeof body.output === "string"
			? boundedReply(stripNul(body.output).trim())
			: "";
	const explicitError =
		typeof body.error === "string" ? stripNul(body.error).trim() : "";
	const error =
		explicitError || (!output ? "Device agent returned no reply" : "");
	const { kind, storedPlatform } = classifyConversation(payload.platform);
	await upsertConversation({
		organizationId: payload.organizationId,
		agentId: payload.agentId,
		platform: storedPlatform,
		conversationId: payload.conversationId,
		threadId: threadIdFromApiConversationId({
			conversationId: payload.conversationId,
			agentId: payload.agentId,
			userId: payload.userId,
			organizationId: payload.organizationId,
		}),
		kind,
		userId: payload.userId,
		title: payload.messageText.slice(0, 200) || null,
		lastActivityAt: new Date(),
	});

	const transitioned = await sql.begin(async (tx) => {
		const terminal = await tx`
      UPDATE public.runs
      SET status = ${error ? "failed" : "completed"},
          completed_at = current_timestamp,
          error_message = ${error || null},
          output_tail = ${output ? output.slice(-2000) : null},
          exit_code = ${body.exit_code ?? null},
          exit_signal = ${body.exit_signal ?? null},
          exit_reason = ${body.exit_reason ?? (error ? "error_message" : "ok")}
      WHERE id = ${runId}
        ${runLeaseFence(tx, body.worker_id)}
      RETURNING id
    `;
		if (terminal.length === 0) return false;

		if (!error) {
			const previous = await readSnapshotJsonl({
				organizationId: payload.organizationId,
				agentId: payload.agentId,
				conversationId: payload.conversationId,
				client: tx,
			});
			const snapshot = buildSnapshot(previous, payload, output, runId);
			await tx`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${payload.organizationId}, ${payload.agentId}, ${payload.conversationId}, ${runId},
           ${snapshot}, ${Buffer.byteLength(snapshot, "utf8")}, 'completed')
        ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
        DO NOTHING
      `;
		}

		await insertThreadResponseRow(
			tx,
			{
				messageId: payload.messageId,
				channelId: payload.channelId,
				conversationId: payload.conversationId,
				userId: payload.userId,
				teamId: payload.teamId ?? "api",
				platform: payload.platform,
				organizationId: payload.organizationId,
				platformMetadata: payload.platformMetadata,
				...(error ? { error } : { finalText: output }),
				processedMessageIds: [payload.messageId],
				timestamp: Date.now(),
			},
			payload.organizationId,
		);
		return true;
	});
	if (transitioned) await notifyThreadResponse();
	return c.json({
		ok: true,
		status: error ? "failed" : "completed",
		...(!transitioned ? { idempotent: true } : {}),
	});
}

/**
 * Terminalize device chat rows that were never claimed or stopped heartbeating.
 * The standard thread_response adapter keeps browser SSE delivery identical to
 * managed chat, including a visible terminal error instead of a hanging turn.
 */
export async function sweepStaleDeviceChatRuns(
	thresholdSeconds: number,
): Promise<number> {
	const sql = getDb();
	const candidates = await sql<{
		id: number;
		status: "pending" | "running";
		action_input: MessagePayload;
	}>`
    SELECT id, status, action_input
    FROM public.runs
    WHERE run_type = 'chat_message'
      AND queue_name = 'messages'
      AND status IN ('pending', 'running')
      AND action_input->'executionTarget'->>'kind' = 'device'
      AND (
        (status = 'pending'
          AND created_at < now() - (${thresholdSeconds}::int * interval '1 second'))
        OR
        (status = 'running'
          AND COALESCE(last_heartbeat_at, claimed_at, created_at)
            < now() - (${thresholdSeconds}::int * interval '1 second'))
      )
    ORDER BY id
    LIMIT 100
  `;

	let swept = 0;
	for (const candidate of candidates) {
		const payload = candidate.action_input;
		if (!payload?.messageId || payload.executionTarget?.kind !== "device")
			continue;
		const workerError =
			candidate.status === "pending"
				? "worker_claim_timeout"
				: "worker_heartbeat_lost";
		const clientError =
			candidate.status === "pending"
				? "The selected device did not pick up this message."
				: "The selected device stopped responding.";
		const transitioned = await sql.begin(async (tx) => {
			const rows = await tx`
        UPDATE public.runs
        SET status = 'timeout',
            outcome = ${classifyRunOutcome({ status: "timeout" })},
            completed_at = current_timestamp,
            error_message = ${workerError}
        WHERE id = ${candidate.id}
          AND status = ${candidate.status}
          AND (
            (status = 'pending'
              AND created_at < now() - (${thresholdSeconds}::int * interval '1 second'))
            OR
            (status = 'running'
              AND COALESCE(last_heartbeat_at, claimed_at, created_at)
                < now() - (${thresholdSeconds}::int * interval '1 second'))
          )
        RETURNING id
      `;
			if (rows.length === 0) return false;
			await insertThreadResponseRow(
				tx,
				{
					messageId: payload.messageId,
					channelId: payload.channelId,
					conversationId: payload.conversationId,
					userId: payload.userId,
					teamId: payload.teamId ?? "api",
					platform: payload.platform,
					organizationId: payload.organizationId,
					platformMetadata: payload.platformMetadata,
					error: clientError,
					processedMessageIds: [payload.messageId],
					timestamp: Date.now(),
				},
				payload.organizationId,
			);
			return true;
		});
		if (transitioned) swept += 1;
	}
	if (swept > 0) await notifyThreadResponse();
	return swept;
}
