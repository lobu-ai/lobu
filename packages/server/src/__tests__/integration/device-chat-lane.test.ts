import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSessionEntries, verifyWorkerToken } from "@lobu/core";
import { generateSecureToken, hashToken } from "../../auth/oauth/utils";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestAgent } from "../setup/test-fixtures";
import { post } from "../setup/test-helpers";
import { TestWorkspace } from "../setup/test-mcp-client";
import { sweepStaleDeviceChatRuns } from "../../worker-api/device-chat";

async function createWorkerPat(
	userId: string,
	organizationId: string,
	workerId: string | null,
): Promise<string> {
	const sql = getTestDb();
	const token = `owl_pat_${generateSecureToken(24)}`;
	await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${hashToken(token)}, ${token.substring(0, 12)}, ${userId}, ${organizationId},
      ${`Device chat test (${workerId ?? "unbound"})`}, 'device_worker:run', ${workerId},
      NOW(), NOW()
    )
  `;
	return token;
}

async function insertDevice(args: {
	userId: string;
	organizationId: string;
	workerId: string;
	kinds: string[];
}): Promise<{ id: string; token: string }> {
	const sql = getTestDb();
	const [device] = await sql<{ id: string }>`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
    ) VALUES (
      ${args.userId}, ${args.workerId}, 'headless',
      ${sql.json(["automations.execute"])}, ${args.workerId},
      ${args.organizationId}, ${`{${args.kinds.join(",")}}`}::text[]
    )
    RETURNING id
  `;
	return {
		id: device.id,
		token: await createWorkerPat(
			args.userId,
			args.organizationId,
			args.workerId,
		),
	};
}

async function enqueueDeviceChat(args: {
	organizationId: string;
	agentId: string;
	userId: string;
	conversationId: string;
	messageId: string;
	message: string;
	deviceWorkerId: string;
	agentKind: string;
}): Promise<number> {
	const sql = getTestDb();
	const [run] = await sql<{ id: number }>`
    INSERT INTO runs (
      organization_id, run_type, queue_name, status, run_at, action_input
    ) VALUES (
      ${args.organizationId}, 'chat_message', 'messages', 'pending', now(),
      ${sql.json({
				userId: args.userId,
				conversationId: args.conversationId,
				messageId: args.messageId,
				channelId: `api_${args.userId}`,
				teamId: "api",
				agentId: args.agentId,
				organizationId: args.organizationId,
				botId: "lobu-api",
				platform: "api",
				messageText: args.message,
				executionTarget: {
					kind: "device",
					deviceWorkerId: args.deviceWorkerId,
					agentKind: args.agentKind,
				},
				platformMetadata: {
					agentId: args.agentId,
					organizationId: args.organizationId,
					source: "direct-api",
				},
				agentOptions: { model: "test-local-model", effort: "xhigh", timeout_seconds: 17, max_budget_usd: 0.5, permission_mode: "plan", finalize_nudges: 2 },
			})}
    )
    RETURNING id
  `;
	return Number(run.id);
}

async function poll(
	token: string,
	workerId: string,
	kinds: string[],
): Promise<Record<string, unknown>> {
	const response = await post("/api/workers/poll", {
		token,
		body: {
			worker_id: workerId,
			platform: "headless",
			capabilities: { "automations.execute": true },
			agent_kinds: kinds,
		},
	});
	expect(response.status).toBe(200);
	return response.json();
}

describe("device chat execution lane", () => {
	const previousEncryptionKey = process.env.ENCRYPTION_KEY;

	beforeAll(() => {
		process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
	});

	afterAll(() => {
		if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
		else process.env.ENCRYPTION_KEY = previousEncryptionKey;
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("claims only on the selected device/runtime and adapts completion into normal chat history", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({ name: "Device Chat Org" });
		const userId = workspace.users.owner.id;
		const organizationId = workspace.org.id;
		const agent = await createTestAgent({
			organizationId,
			ownerUserId: userId,
			agentId: "device-chat-agent",
			name: "Device Chat Agent",
		});
		await sql`
      UPDATE agents
      SET identity_md = 'A careful local agent', soul_md = 'Prefer evidence'
      WHERE id = ${agent.agentId} AND organization_id = ${organizationId}
    `;
		const selected = await insertDevice({
			userId,
			organizationId,
			workerId: "selected-device",
			kinds: ["pi"],
		});
		const other = await insertDevice({
			userId,
			organizationId,
			workerId: "other-device",
			kinds: ["pi"],
		});
    const conversationId = buildApiConversationId({
      agentId: agent.agentId,
      userId,
      organizationId,
      threadId: "thread-1",
    });
    const priorTimestamp = new Date(Date.now() - 60_000).toISOString();
    const priorSnapshot = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "managed-prior",
      timestamp: priorTimestamp,
      cwd: "/managed",
    })}\n${JSON.stringify({
      type: "message",
      id: "managed-assistant",
      parentId: null,
      timestamp: priorTimestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Existing managed reply." }],
      },
    })}\n`;
    const [priorRun] = await sql<{ id: number }>`
      INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
      VALUES ('chat_message', 'completed', ${organizationId}, ${priorTimestamp}, ${priorTimestamp}, ${priorTimestamp})
      RETURNING id
    `;
    if (!priorRun) throw new Error("Failed to seed prior managed transcript");
    await sql`
      INSERT INTO agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
      VALUES (
        ${organizationId}, ${agent.agentId}, ${conversationId}, ${priorRun.id},
        ${priorSnapshot}, ${Buffer.byteLength(priorSnapshot)}, 'completed', ${priorTimestamp}
      )
    `;
    const runId = await enqueueDeviceChat({
			organizationId,
			agentId: agent.agentId,
			userId,
			conversationId,
			messageId: "message-1",
			message: "What is the latest on Atlas?",
			deviceWorkerId: selected.id,
			agentKind: "pi",
		});

		expect(await poll(other.token, "other-device", ["pi"])).not.toHaveProperty(
			"run_id",
		);
		expect(
			await poll(selected.token, "selected-device", ["codex"]),
		).not.toHaveProperty("run_id");

		const job = await poll(selected.token, "selected-device", ["pi"]);
		expect(job).toMatchObject({ run_id: runId, run_type: "chat_message" });
		const payload = job.payload as {
			chat: {
				agent_kind: string;
				message: string;
				history: unknown[];
				agent: { identity_md?: string };
			};
			context: { agent_session: { token: string; conversation_id: string } };
		};
    expect(payload.chat).toMatchObject({
      agent_kind: "pi",
      execution_config: { model: "test-local-model", effort: "xhigh", timeout_seconds: 17, max_budget_usd: 0.5, permission_mode: "plan" },
      message: "What is the latest on Atlas?",
      history: [{ role: "assistant", content: "Existing managed reply." }],
      agent: { identity_md: "A careful local agent" },
		});
		expect(payload.context.agent_session.conversation_id).toBe(conversationId);
		expect(
			verifyWorkerToken(payload.context.agent_session.token),
		).toMatchObject({
			runId,
			agentId: agent.agentId,
			organizationId,
			conversationId,
			source: "device-chat",
		});

		const secondRunId = await enqueueDeviceChat({
			organizationId,
			agentId: agent.agentId,
			userId,
			conversationId,
			messageId: "message-2",
			message: "What did you just say?",
			deviceWorkerId: selected.id,
			agentKind: "pi",
		});
		expect(
			await poll(selected.token, "selected-device", ["pi"]),
		).not.toHaveProperty("run_id");

		const completionBody = {
			worker_id: "selected-device",
			output: "Atlas shipped its device chat milestone.",
			exit_code: 0,
			exit_reason: "ok",
		};
		const unboundUserPat = await createWorkerPat(userId, organizationId, null);
		const completed = await post(
			`/api/workers/me/runs/${runId}/complete-chat`,
			{
				token: unboundUserPat,
				body: completionBody,
			},
		);
		const completedJson = await completed.json();
		expect(completed.status, JSON.stringify(completedJson)).toBe(200);
		expect(completedJson).toMatchObject({
			ok: true,
			status: "completed",
		});

		const [run] = await sql<{
			status: string;
		}>`SELECT status FROM runs WHERE id = ${runId}`;
		expect(run.status).toBe("completed");
    const [snapshot] = await sql<{ snapshot_jsonl: string }>`
      SELECT snapshot_jsonl FROM agent_transcript_snapshot WHERE run_id = ${runId}
    `;
    expect(JSON.parse(snapshot.snapshot_jsonl.split("\n", 1)[0] ?? "{}")).toMatchObject({
      executionTarget: {
        kind: "device",
        deviceWorkerId: selected.id,
        agentKind: "pi",
      },
    });
    const transcript = parseSessionEntries(snapshot.snapshot_jsonl).entries;
		expect(
			transcript.map((entry) => JSON.stringify(entry.message?.content)),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("What is the latest on Atlas?"),
				expect.stringContaining("Atlas shipped its device chat milestone."),
			]),
		);
		const [reply] = await sql<{ action_input: { finalText?: string } }>`
      SELECT action_input
      FROM runs
      WHERE queue_name = 'thread_response'
        AND action_input->>'messageId' = 'message-1'
      ORDER BY id DESC
      LIMIT 1
    `;
		expect(reply.action_input.finalText).toBe(
			"Atlas shipped its device chat milestone.",
		);

		const duplicate = await post(
			`/api/workers/me/runs/${runId}/complete-chat`,
			{
				token: selected.token,
				body: completionBody,
			},
		);
		await expect(duplicate.json()).resolves.toMatchObject({
			ok: true,
			status: "completed",
			idempotent: true,
		});

		const secondJob = await poll(selected.token, "selected-device", ["pi"]);
		expect(secondJob.run_id).toBe(secondRunId);
    expect(
      (secondJob.payload as { chat: { history: unknown[] } }).chat.history,
    ).toEqual([
      { role: "assistant", content: "Existing managed reply." },
      { role: "user", content: "What is the latest on Atlas?" },
			{
				role: "assistant",
				content: "Atlas shipped its device chat milestone.",
			},
		]);
	});

	it("turns an unclaimed or heartbeat-lost device turn into a visible terminal reply", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Stale Device Chat Org",
		});
		const userId = workspace.users.owner.id;
		const organizationId = workspace.org.id;
		const agent = await createTestAgent({
			organizationId,
			ownerUserId: userId,
			agentId: "stale-device-chat-agent",
			name: "Stale Device Chat Agent",
		});
		const selected = await insertDevice({
			userId,
			organizationId,
			workerId: "stale-device",
			kinds: ["pi"],
		});
		const conversationId = buildApiConversationId({
			agentId: agent.agentId,
			userId,
			organizationId,
			threadId: "stale-thread",
		});
		const pendingId = await enqueueDeviceChat({
			organizationId,
			agentId: agent.agentId,
			userId,
			conversationId,
			messageId: "stale-pending-message",
			message: "Will this be picked up?",
			deviceWorkerId: selected.id,
			agentKind: "pi",
		});
		const runningId = await enqueueDeviceChat({
			organizationId,
			agentId: agent.agentId,
			userId,
			conversationId,
			messageId: "stale-running-message",
			message: "Are you still there?",
			deviceWorkerId: selected.id,
			agentKind: "pi",
		});
		await sql`
      UPDATE runs
      SET created_at = now() - interval '5 minutes'
      WHERE id = ${pendingId}
    `;
		await sql`
      UPDATE runs
      SET status = 'running', claimed_by = 'stale-device',
          claimed_at = now() - interval '5 minutes',
          last_heartbeat_at = now() - interval '5 minutes'
      WHERE id = ${runningId}
    `;

		const genericCompletion = await post("/api/workers/complete", {
			token: selected.token,
			body: {
				run_id: runningId,
				worker_id: "stale-device",
				status: "failed",
				error_message: "old daemon used generic completion",
			},
		});
		expect(genericCompletion.status).toBe(409);
		await expect(genericCompletion.json()).resolves.toEqual({
			error: "Device chat runs must use the complete-chat endpoint",
		});
		const [stillRunning] = await sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${runningId}
    `;
		expect(stillRunning.status).toBe("running");

		expect(await sweepStaleDeviceChatRuns(60)).toBe(2);
		const terminal = await sql<{
			id: number;
			status: string;
			error_message: string;
		}>`
      SELECT id, status, error_message FROM runs WHERE id IN (${pendingId}, ${runningId})
      ORDER BY id
    `;
		expect(terminal).toEqual([
			expect.objectContaining({
				id: pendingId,
				status: "timeout",
				error_message: "worker_claim_timeout",
			}),
			expect.objectContaining({
				id: runningId,
				status: "timeout",
				error_message: "worker_heartbeat_lost",
			}),
		]);
		const replies = await sql<{ message_id: string; error: string }>`
      SELECT action_input->>'messageId' AS message_id,
             action_input->>'error' AS error
      FROM runs
      WHERE queue_name = 'thread_response'
        AND action_input->>'messageId' IN ('stale-pending-message', 'stale-running-message')
      ORDER BY action_input->>'messageId'
    `;
		expect(replies).toEqual([
			{
				message_id: "stale-pending-message",
				error: "The selected device did not pick up this message.",
			},
			{
				message_id: "stale-running-message",
				error: "The selected device stopped responding.",
			},
		]);
		expect(await sweepStaleDeviceChatRuns(60)).toBe(0);
	});
});
