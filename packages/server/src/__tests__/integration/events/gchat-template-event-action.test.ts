import { __setLocalFrontendForTests } from "../../../utils/public-origin";
import { Chat } from "chat";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { activateWorkspaceEventTask } from "../../../automations/workspace-event.js";
import type { WorkspaceEventActivationTaskPayload } from "../../../automations/workspace-event-contract.js";
import type { DbClient } from "../../../db/client.js";
import { getDb } from "../../../db/client.js";
import { InMemoryStateAdapter } from "../../../gateway/__tests__/fixtures/in-memory-state-adapter.js";
import {
	interactionDeliveryId,
	registerActionHandlers,
} from "../../../gateway/connections/interaction-bridge.js";
import { gchatPlatform } from "../../../gateway/connections/platforms/gchat.js";
import type { PlatformConnection } from "../../../gateway/connections/types.js";
import {
	invokeTemplateEventAction,
	templateEventActionId,
} from "../../../interactions/template-event-actions.js";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway.js";
import { runtimeConnectionIdToSlug } from "../../../lobu/stores/connections-projection.js";
import {
	presentStoredEventToConversation,
	refreshInteractiveEventCardTask,
} from "../../../notifications/service.js";
import { registerScheduledJobsTicker } from "../../../scheduled/scheduled-jobs-service.js";
import { manageSchedules } from "../../../tools/admin/manage_schedules.js";
import type { ToolContext } from "../../../tools/registry.js";
import { insertEvent } from "../../../utils/insert-event.js";
import { initWorkspaceProvider } from "../../../workspace/index.js";
import { cleanupTestDatabase } from "../../setup/test-db.js";
import {
	createTestAgent,
	createTestEntity,
} from "../../setup/test-fixtures.js";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client.js";

const CONNECTION_ID = "gchat-poll-connection";
const SPACE_NAME = "spaces/AAAA-poll";
const MESSAGE_NAME = `${SPACE_NAME}/messages/poll-card`;

function cardClick(params: {
	actionId: string;
	actorId: string;
	actorName: string;
	value: "A" | "B" | "C";
	eventTime: string;
}): Request {
	const space = { name: SPACE_NAME, type: "ROOM", spaceType: "SPACE" };
	return new Request("https://gateway.test/api/v1/webhooks/gchat-poll", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "CARD_CLICKED",
			eventTime: params.eventTime,
			space,
			user: {
				name: params.actorId,
				displayName: params.actorName,
				type: "HUMAN",
			},
			message: {
				name: MESSAGE_NAME,
				createTime: "2026-08-24T12:00:00Z",
				sender: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
				space,
			},
			common: { parameters: {} },
			action: {
				actionMethodName: params.actionId,
				parameters: [{ key: "value", value: params.value }],
			},
		}),
	});
}

async function dispatchAndWait(
	chat: Chat,
	request: Request,
): Promise<Response> {
	const tasks: Promise<unknown>[] = [];
	const response = await chat.webhooks.gchat(request, {
		waitUntil: (task) => tasks.push(task),
	});
	await Promise.all(tasks);
	return response;
}

async function createGoogleChatHarness(organizationId: string) {
	const adapter = await gchatPlatform.createAdapter({
		credentials: JSON.stringify({
			client_email: "lobu-chat@example.iam.gserviceaccount.com",
			private_key: "not-used-by-the-inbound-webhook-test",
			project_id: "lobu-chat-test",
		}),
		disableSignatureVerification: true,
		userName: "lobu",
	});
	const postMessage = vi.fn(async (threadId: string) => ({
		id: `${MESSAGE_NAME}-receipt`,
		threadId,
		raw: {},
	}));
	adapter.postMessage = postMessage;
	const chat = new Chat({
		userName: "lobu",
		adapters: { gchat: adapter },
		state: new InMemoryStateAdapter(),
	});
	const threadId = adapter.encodeThreadId({
		spaceName: SPACE_NAME,
		threadName: MESSAGE_NAME,
	});

	registerActionHandlers(
		chat,
		{
			id: CONNECTION_ID,
			platform: "gchat",
			organizationId,
		} as PlatformConnection,
		undefined,
		undefined,
		async (sourceEventId, action, value, actionEvent) =>
			invokeTemplateEventAction({
				organizationId,
				sourceEventId,
				action,
				value,
				interactionId: interactionDeliveryId(actionEvent),
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: actionEvent.user.userId,
					name: actionEvent.user.fullName,
				},
				source: {
					connectionId: CONNECTION_ID,
					messageId: actionEvent.messageId,
					threadId: actionEvent.threadId,
				},
			}),
	);

	return { chat, postMessage, threadId };
}

async function activateVoteRun(
	sql: DbClient,
	organizationId: string,
	automationId: number,
	eventId: number,
	claimedBy: string,
): Promise<number> {
	const [task] = await sql<{
		action_input: { payload: WorkspaceEventActivationTaskPayload };
	}>`
    SELECT action_input
    FROM runs
    WHERE organization_id = ${organizationId}
      AND run_type = 'task'
      AND action_key = 'activate-workspace-event'
      AND (action_input->'payload'->>'eventId')::bigint = ${eventId}
    LIMIT 1
  `;
	if (!task) throw new Error(`No activation task for vote event ${eventId}`);
	const activated = await activateWorkspaceEventTask(
		task.action_input.payload,
		sql,
	);
	expect(activated).toMatchObject({ matched: 1, queued: 1 });

	const [run] = await sql<{ id: number }>`
    SELECT id
    FROM runs
    WHERE organization_id = ${organizationId}
      AND automation_id = ${automationId}
      AND run_type = 'automation'
      AND (approved_input->'trigger_signal'->>'event_id')::bigint = ${eventId}
    LIMIT 1
  `;
	if (!run) throw new Error(`No Automation run for vote event ${eventId}`);
	await sql`
		UPDATE runs
		SET status = 'running', claimed_at = NOW(), claimed_by = ${claimedBy}
		WHERE id = ${run.id}
	`;
	return Number(run.id);
}

async function completeAutomationRun(
	api: TestApiClient,
	automationId: number,
	runId: number,
	extractedData: Record<string, unknown>,
): Promise<void> {
	const window = (await api.knowledge.read({
		automation_id: automationId,
		run_id: runId,
		limit: 100,
	})) as { window_token?: string };
	if (!window.window_token) {
		throw new Error(`Automation run ${runId} returned no window token`);
	}
	await api.automations.completeWindow({
		automation_id: String(automationId),
		run_id: runId,
		window_token: window.window_token,
		extracted_data: extractedData,
	});
}

describe("Google Chat declared event action adapter", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		__setLocalFrontendForTests(false);
	});

	afterEach(() => {
		__setChatInstanceManagerForTests(null);
		__setLocalFrontendForTests(undefined);
	});

	test("materializes multi-user voting, quorum, deadline, and card settlement", async () => {
		const sql = getDb();
		const workspace = await TestWorkspace.create({
			name: "GChat Poll E2E Org",
		});
		const ownerUserId = workspace.users.owner.id;
		const board = await createTestEntity({
			name: "Poll board",
			entity_type: "poll-board",
			organization_id: workspace.org.id,
			created_by: ownerUserId,
		});
		const pollSchema = {
			type: "object",
			properties: {
				poll_id: { type: "string" },
				question: { type: "string" },
				options: { type: "array", items: { type: "string" } },
				status: { enum: ["open", "closed"] },
				quorum: { type: "integer" },
				closes_at: { type: "string" },
				tally: {
					type: "object",
					properties: {
						A: { type: "integer" },
						B: { type: "integer" },
						C: { type: "integer" },
					},
					required: ["A", "B", "C"],
					additionalProperties: false,
				},
				response_count: { type: "integer" },
				close_reason: { type: "string" },
			},
			required: [
				"poll_id",
				"question",
				"options",
				"status",
				"quorum",
				"closes_at",
				"tally",
				"response_count",
			],
			additionalProperties: false,
		};
		await workspace.owner.entity_schema.createType({
			slug: "poll",
			name: "Poll",
			metadata_schema: pollSchema,
			event_kinds: {
				poll_opened: {
					description: "An open multi-user poll",
					jsonTemplate: {
						type: "card",
						children: [
							{
								type: "button",
								props: { label: "A", onClick: "@vote", value: "A" },
							},
							{
								type: "button",
								props: { label: "B", onClick: "@vote", value: "B" },
							},
							{
								type: "button",
								props: { label: "C", onClick: "@vote", value: "C" },
							},
						],
					},
					interactions: { vote: { emits: "poll_vote_cast" } },
				},
				poll_vote_cast: { description: "A verified vote or vote change" },
				poll_closed: {
					description: "A closed poll",
					jsonTemplate: {
						type: "card",
						children: [
							{ type: "text", content: "Poll closed: {{close_reason}}" },
							{
								type: "text",
								content: "A={{tally.A}} B={{tally.B}} C={{tally.C}}",
							},
						],
					},
				},
			},
		});
		await workspace.owner.entity_schema.createType({
			slug: "poll-response",
			name: "Poll response",
			metadata_schema: {
				type: "object",
				properties: {
					poll_id: { type: "string" },
					platform: { type: "string" },
					actor_id: { type: "string" },
					actor_name: { type: "string" },
					choice: { enum: ["A", "B", "C"] },
					updated_at: { type: "string" },
				},
				required: [
					"poll_id",
					"platform",
					"actor_id",
					"actor_name",
					"choice",
					"updated_at",
				],
				additionalProperties: false,
			},
		});

		const automation = (await workspace.owner.automations.create({
			entity_id: board.id,
			slug: "poll-vote-reducer",
			name: "Poll vote reducer",
			prompt: "Materialize the verified vote event and close at quorum.",
			outputs: {
				polls: { entity: "poll", key: ["poll_id"], name: ["question"] },
				responses: {
					entity: "poll-response",
					key: ["poll_id", "platform", "actor_id"],
					name: ["actor_name"],
				},
			},
			managed_agent_id: null,
		})) as { automation_id: string };
		const automationId = Number(automation.automation_id);
		const pollId = "release-2026-08-28";
		const question = "Which release lane should ship?";
		const closesAt = new Date(Date.now() - 60_000).toISOString();
		const beforeDeadline = (minutes: number) =>
			new Date(Date.parse(closesAt) - minutes * 60_000).toISOString();
		const initialPoll = {
			poll_id: pollId,
			question,
			options: ["A", "B", "C"],
			status: "open",
			quorum: 2,
			closes_at: closesAt,
			tally: { A: 0, B: 0, C: 0 },
			response_count: 0,
		};
		const initialRun = (await workspace.owner.automations.trigger({
			automation_id: automation.automation_id,
		})) as { run_id: number };
		await completeAutomationRun(
			workspace.owner,
			automationId,
			initialRun.run_id,
			{
				polls: [initialPoll],
				responses: [],
			},
		);

		const [poll] = await sql<{ id: number; metadata: typeof initialPoll }>`
			SELECT e.id, e.metadata
			FROM entities e
			JOIN entity_types et ON et.id = e.entity_type_id
			WHERE e.organization_id = ${workspace.org.id}
			  AND et.slug = 'poll'
			  AND e.metadata->>'poll_id' = ${pollId}
		`;
		if (!poll) throw new Error("Initial poll entity was not materialized");
		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId,
			agentId: "gchat-poll-reducer",
		});
		await workspace.owner.automations.update({
			automation_id: automation.automation_id,
			managed_agent_id: agent.agentId,
			triggers: [
				{
					kind: "event",
					source: "workspace",
					event_types: ["poll_vote_cast"],
					execution: "window",
					active_run: "queue",
				},
			],
		});
		const agentApi = await TestApiClient.for({
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
			agentId: agent.agentId,
		});

		const { chat, postMessage, threadId } = await createGoogleChatHarness(
			workspace.org.id,
		);
		const editMessageContent = vi.fn(async () => undefined);
		const postToConversation = vi.fn(
			async (
				_connectionId: string,
				request: { channelId: string; threadId?: string },
			) => ({
				messageId:
					request.channelId !== SPACE_NAME
						? `${request.channelId}/messages/poll-card`
						: request.threadId === "thread-two"
							? `${SPACE_NAME}/messages/poll-card-thread-two`
							: MESSAGE_NAME,
				threadId: request.threadId ?? threadId,
			}),
		);
		__setChatInstanceManagerForTests({
			postToConversation,
			editMessageContent,
		});
		const source = await insertEvent({
			entityIds: [board.id, poll.id],
			organizationId: workspace.org.id,
			originId: `poll-opened:${pollId}`,
			title: question,
			payloadType: "empty",
			semanticType: "poll_opened",
			metadata: initialPoll,
		});
		const actionId = templateEventActionId(source.id, "vote");
		const presentations = await Promise.all([
			presentStoredEventToConversation({
				organizationId: workspace.org.id,
				eventId: source.id,
				connectionId: CONNECTION_ID,
				platform: "gchat",
				channelId: SPACE_NAME,
				channelKey: `gchat:${SPACE_NAME}`,
				conversationId: `gchat:${SPACE_NAME}:${threadId}`,
				threadId,
			}),
			presentStoredEventToConversation({
				organizationId: workspace.org.id,
				eventId: source.id,
				connectionId: CONNECTION_ID,
				platform: "gchat",
				channelId: SPACE_NAME,
				channelKey: `gchat:${SPACE_NAME}`,
				conversationId: `gchat:${SPACE_NAME}:${threadId}`,
				threadId,
			}),
		]);
		expect(presentations).toEqual([
			expect.objectContaining({ ok: true, messageId: MESSAGE_NAME }),
			expect.objectContaining({ ok: true, messageId: MESSAGE_NAME }),
		]);
		expect(JSON.stringify(postToConversation.mock.calls)).not.toContain(actionId);
		expect(JSON.stringify(postToConversation.mock.calls)).toContain("Open event");
		expect(postToConversation).toHaveBeenCalledTimes(1);
		expect(
			await presentStoredEventToConversation({
				organizationId: workspace.org.id,
				eventId: source.id,
				connectionId: CONNECTION_ID,
				platform: "gchat",
				channelId: SPACE_NAME,
				channelKey: `gchat:${SPACE_NAME}`,
				conversationId: `gchat:${SPACE_NAME}:thread-two`,
				threadId: "thread-two",
			}),
		).toMatchObject({
			ok: true,
			messageId: `${SPACE_NAME}/messages/poll-card-thread-two`,
		});
		expect(
			await presentStoredEventToConversation({
				organizationId: workspace.org.id,
				eventId: source.id,
				connectionId: CONNECTION_ID,
				platform: "gchat",
				channelId: `${SPACE_NAME}/secondary`,
				channelKey: `gchat:${SPACE_NAME}/secondary`,
				conversationId: `gchat:${SPACE_NAME}/secondary:${threadId}`,
				threadId,
			}),
		).toMatchObject({
			ok: true,
			messageId: `${SPACE_NAME}/secondary/messages/poll-card`,
		});
		expect(
			await presentStoredEventToConversation({
				organizationId: workspace.org.id,
				eventId: source.id,
				connectionId: CONNECTION_ID,
				platform: "gchat",
				channelId: SPACE_NAME,
				channelKey: `gchat:${SPACE_NAME}`,
				conversationId: `gchat:${SPACE_NAME}:${threadId}`,
				threadId,
			}),
		).toMatchObject({ ok: true, messageId: MESSAGE_NAME });
		expect(postToConversation).toHaveBeenCalledTimes(3);
		expect(
			(await sql<{ metadata: { delivery: unknown[] } }>`
				SELECT metadata FROM events WHERE id = ${source.id}
			`)[0]?.metadata.delivery,
		).toHaveLength(3);
		const reduceVote = async (voteEventId: number) => {
			const [vote] = await sql<{
				metadata: {
					interaction: {
						value: "A" | "B" | "C";
						actor: { platform: string; id: string; name: string };
					};
				};
			}>`SELECT metadata FROM events WHERE id = ${voteEventId}`;
			const runId = await activateVoteRun(
				sql as DbClient,
				workspace.org.id,
				automationId,
				voteEventId,
				`lobu:${agent.agentId}`,
			);
			const responseRows = await sql<{
				metadata: {
					poll_id: string;
					platform: string;
					actor_id: string;
					actor_name: string;
					choice: "A" | "B" | "C";
					updated_at: string;
				};
			}>`
				SELECT e.metadata
				FROM entities e
				JOIN entity_types et ON et.id = e.entity_type_id
				WHERE e.organization_id = ${workspace.org.id}
				  AND et.slug = 'poll-response'
				  AND e.metadata->>'poll_id' = ${pollId}
			`;
			const actor = vote.metadata.interaction.actor;
			const response = {
				poll_id: pollId,
				platform: actor.platform,
				actor_id: actor.id,
				actor_name: actor.name,
				choice: vote.metadata.interaction.value,
				updated_at: new Date().toISOString(),
			};
			const responses = new Map(
				responseRows.map((row) => [
					`${row.metadata.platform}:${row.metadata.actor_id}`,
					row.metadata,
				]),
			);
			responses.set(`${response.platform}:${response.actor_id}`, response);
			const tally = { A: 0, B: 0, C: 0 };
			for (const current of responses.values()) tally[current.choice] += 1;
			const winningChoice = Object.entries(tally).find(
				([, count]) => count >= 2,
			)?.[0];
			const reachedQuorum = winningChoice !== undefined;
			const pollOutput = {
				...initialPoll,
				status: reachedQuorum ? "closed" : "open",
				tally,
				response_count: responses.size,
				...(reachedQuorum ? { close_reason: "quorum" } : {}),
			};
			await completeAutomationRun(agentApi, automationId, runId, {
				polls: [pollOutput],
				responses: [response],
			});
			if (reachedQuorum) {
				const successor = await agentApi.knowledge.save({
					entity_ids: [board.id, poll.id],
					content: `Poll closed after ${winningChoice} reached quorum 2.`,
					title: `${question} — closed`,
					semantic_type: "poll_closed",
					payload_type: "empty",
					metadata: pollOutput,
					supersedes_event_id: source.id,
					idempotency_key: `poll-close:${pollId}`,
				});
				await refreshInteractiveEventCardTask({
					organizationId: workspace.org.id,
					replacementEventId: Number(successor.id),
				});
			}
			return pollOutput;
		};

		const adaA = cardClick({
			actionId,
			actorId: "users/ada",
			actorName: "Ada",
			value: "A",
			eventTime: beforeDeadline(4),
		});
		expect((await dispatchAndWait(chat, adaA.clone())).status).toBe(200);
		expect((await dispatchAndWait(chat, adaA.clone())).status).toBe(200);
		let votes = await sql<{ id: number }>`
			SELECT id FROM events
			WHERE organization_id = ${workspace.org.id}
			  AND semantic_type = 'poll_vote_cast'
			ORDER BY id
		`;
		expect(votes).toHaveLength(1);
		expect(
			await sql`
				SELECT id FROM runs
				WHERE organization_id = ${workspace.org.id}
				  AND run_type = 'task'
				  AND action_key = 'activate-workspace-event'
				  AND (action_input->'payload'->>'eventId')::bigint = ${votes[0].id}
			`,
		).toHaveLength(1);
		expect(await reduceVote(Number(votes[0].id))).toMatchObject({
			status: "open",
			tally: { A: 1, B: 0, C: 0 },
			response_count: 1,
		});

		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						actionId,
						actorId: "users/grace",
						actorName: "Grace",
						value: "B",
						eventTime: beforeDeadline(3),
					}),
				)
			).status,
		).toBe(200);
		votes = await sql<{ id: number }>`
			SELECT id FROM events
			WHERE organization_id = ${workspace.org.id}
			  AND semantic_type = 'poll_vote_cast'
			ORDER BY id
		`;
		expect(votes).toHaveLength(2);
		expect(await reduceVote(Number(votes[1].id))).toMatchObject({
			status: "open",
			tally: { A: 1, B: 1, C: 0 },
			response_count: 2,
		});

		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						actionId,
						actorId: "users/ada",
						actorName: "Ada",
						value: "B",
						eventTime: beforeDeadline(2),
					}),
				)
			).status,
		).toBe(200);
		votes = await sql<{ id: number }>`
			SELECT id FROM events
			WHERE organization_id = ${workspace.org.id}
			  AND semantic_type = 'poll_vote_cast'
			ORDER BY id
		`;
		expect(votes).toHaveLength(3);
		const voteHistory = await sql<{
			metadata: {
				interaction: { value: string; actor: { id: string } };
			};
		}>`
			SELECT metadata FROM events
			WHERE organization_id = ${workspace.org.id}
			  AND semantic_type = 'poll_vote_cast'
			ORDER BY id
		`;
		expect(
			voteHistory.map(({ metadata }) => metadata.interaction),
		).toMatchObject([
			{ value: "A", actor: { id: "users/ada" } },
			{ value: "B", actor: { id: "users/grace" } },
			{ value: "B", actor: { id: "users/ada" } },
		]);
		expect(await reduceVote(Number(votes[2].id))).toMatchObject({
			status: "closed",
			tally: { A: 0, B: 2, C: 0 },
			response_count: 2,
			close_reason: "quorum",
		});

		await vi.waitFor(() => expect(editMessageContent).toHaveBeenCalledTimes(3));
		const responses = await sql<{
			metadata: { actor_id: string; choice: string };
		}>`
			SELECT e.metadata
			FROM entities e
			JOIN entity_types et ON et.id = e.entity_type_id
			WHERE e.organization_id = ${workspace.org.id}
			  AND et.slug = 'poll-response'
			ORDER BY e.metadata->>'actor_id'
		`;
		expect(responses.map((row) => row.metadata)).toMatchObject([
			{ actor_id: "users/ada", choice: "B" },
			{ actor_id: "users/grace", choice: "B" },
		]);
		const [closedPoll] = await sql<{ metadata: typeof initialPoll }>`
			SELECT metadata FROM entities
			WHERE organization_id = ${workspace.org.id} AND id = ${poll.id}
		`;
		expect(closedPoll.metadata).toMatchObject({
			status: "closed",
			tally: { A: 0, B: 2, C: 0 },
			response_count: 2,
			close_reason: "quorum",
		});
		expect(
			await sql`
				SELECT id FROM events
				WHERE organization_id = ${workspace.org.id}
				  AND semantic_type = 'poll_closed'
			`,
		).toHaveLength(1);

		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						actionId,
						actorId: "users/linus",
						actorName: "Linus",
						value: "C",
						eventTime: beforeDeadline(1),
					}),
				)
			).status,
		).toBe(200);
		expect(
			await sql`
				SELECT id FROM events
				WHERE organization_id = ${workspace.org.id}
				  AND semantic_type = 'poll_vote_cast'
			`,
		).toHaveLength(3);
		expect(editMessageContent).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(postMessage.mock.calls)).toContain(
			"This interaction is closed or has been replaced.",
		);

		const deadlinePoll = {
			...initialPoll,
			poll_id: "release-deadline",
			question: "Which lane should ship tomorrow?",
			closes_at: closesAt,
		};
		const createdDeadlinePoll = (await workspace.owner.entities.create({
			type: "poll",
			name: deadlinePoll.question,
			metadata: deadlinePoll,
		})) as { entity: { id: number } };
		const deadlineMessage = `${SPACE_NAME}/messages/deadline-poll`;
		const deadlineSource = await insertEvent({
			entityIds: [board.id, createdDeadlinePoll.entity.id],
			organizationId: workspace.org.id,
			originId: `poll-opened:${deadlinePoll.poll_id}`,
			title: deadlinePoll.question,
			payloadType: "empty",
			payloadData: deadlinePoll,
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				delivery: [
					{
						connectionId: CONNECTION_ID,
						messageId: deadlineMessage,
						threadId,
					},
				],
			},
		});
		await sql`
			INSERT INTO connections (
				organization_id, connector_key, agent_id, display_name, status,
				config, credential_mode, slug, visibility, created_at, updated_at
			) VALUES (
				${workspace.org.id}, 'gchat', ${agent.agentId}, 'Poll room', 'active',
				${sql.json({})}, 'byo', ${runtimeConnectionIdToSlug(CONNECTION_ID)},
				'org', NOW(), NOW()
			)
		`;
		const scheduleCtx = {
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
			agentId: agent.agentId,
			sourceContext: {
				platform: "gchat",
				connectionId: CONNECTION_ID,
				channelId: SPACE_NAME,
				conversationId: threadId,
				userId: "users/poll-owner",
			},
			isAuthenticated: true,
			clientId: "lobu-worker",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "pat",
			scopedToOrg: true,
			allowCrossOrg: false,
		} satisfies ToolContext;
		for (const scheduledPoll of [
			{ id: pollId, sourceEventId: source.id },
			{ id: deadlinePoll.poll_id, sourceEventId: deadlineSource.id },
		]) {
			const scheduled = await manageSchedules(
				{
					action: "create",
					description: `Close poll ${scheduledPoll.id}`,
					run_at: closesAt,
					idempotency_key: `poll-deadline:${scheduledPoll.id}`,
					source_event_id: scheduledPoll.sourceEventId,
					payload: {
						type: "wake_agent",
						agent_id: agent.agentId,
						prompt: `Close poll ${scheduledPoll.id} if it is still open.`,
					},
				},
				{} as never,
				scheduleCtx,
			);
			expect(scheduled.error).toBeUndefined();
		}
		const spawned: Array<{ payload: { prompt: string } }> = [];
		const handlers = new Map<
			string,
			(context: { payload: unknown; taskRunId: number }) => Promise<void>
		>();
		registerScheduledJobsTicker({
			register: (name: string, handler: never) =>
				handlers.set(name, handler as never),
			spawn: async (_name: string, payload: { prompt: string }) => {
				spawned.push({ payload });
				return "spawned-poll-deadline";
			},
		} as never);
		await handlers.get("scheduled-jobs-tick")?.({ payload: {}, taskRunId: 1 });
		expect(spawned.map((item) => item.payload.prompt).sort()).toEqual(
			[
				`Close poll ${pollId} if it is still open.`,
				`Close poll ${deadlinePoll.poll_id} if it is still open.`,
			].sort(),
		);

		const closeAtDeadline = async (params: {
			entityId: number;
			sourceEventId: number;
			state: typeof deadlinePoll;
		}) => {
			const [current] = await sql<{
				metadata: typeof deadlinePoll & { close_reason?: string };
			}>`
				SELECT metadata FROM entities
				WHERE organization_id = ${workspace.org.id}
				  AND id = ${params.entityId}
			`;
			const [sourceState] = await sql<{ superseded_by: number | null }>`
				SELECT superseded_by FROM events
				WHERE organization_id = ${workspace.org.id}
				  AND id = ${params.sourceEventId}
			`;
			if (current.metadata.status === "closed" && sourceState.superseded_by) {
				return false;
			}
			const closed =
				current.metadata.status === "closed"
					? current.metadata
					: {
							...params.state,
							status: "closed",
							close_reason: "deadline",
						};
			if (current.metadata.status !== "closed") {
				await agentApi.entities.update({
					entity_id: params.entityId,
					metadata: closed,
				});
			}
			const successor = await agentApi.knowledge.save({
				entity_ids: [board.id, params.entityId],
				content: `Poll closed by ${closed.close_reason}.`,
				title: `${params.state.question} — closed`,
				semantic_type: "poll_closed",
				payload_type: "empty",
				metadata: closed,
				supersedes_event_id: params.sourceEventId,
				idempotency_key: `poll-close:${params.state.poll_id}`,
			});
			await refreshInteractiveEventCardTask({
				organizationId: workspace.org.id,
				replacementEventId: Number(successor.id),
			});
			return true;
		};
		const wakeResults: Array<{ pollId: string; closed: boolean }> = [];
		for (const wake of spawned) {
			const targetsDeadlinePoll = wake.payload.prompt.includes(
				deadlinePoll.poll_id,
			);
			wakeResults.push({
				pollId: targetsDeadlinePoll ? deadlinePoll.poll_id : pollId,
				closed: await closeAtDeadline(
					targetsDeadlinePoll
						? {
								entityId: createdDeadlinePoll.entity.id,
								sourceEventId: deadlineSource.id,
								state: deadlinePoll,
							}
						: {
								entityId: poll.id,
								sourceEventId: source.id,
								state: initialPoll,
							},
				),
			});
		}
		expect(
			wakeResults.sort((a, b) => a.pollId.localeCompare(b.pollId)),
		).toEqual(
			[
				{ pollId, closed: false },
				{ pollId: deadlinePoll.poll_id, closed: true },
			].sort((a, b) => a.pollId.localeCompare(b.pollId)),
		);
		expect(editMessageContent).toHaveBeenCalledTimes(4);
		const [deadlineClosed] = await sql<{ metadata: typeof deadlinePoll }>`
			SELECT metadata FROM entities
			WHERE organization_id = ${workspace.org.id}
			  AND id = ${createdDeadlinePoll.entity.id}
		`;
		expect(deadlineClosed.metadata).toMatchObject({
			status: "closed",
			close_reason: "deadline",
			tally: { A: 0, B: 0, C: 0 },
		});
		expect(
			await sql`
				SELECT id FROM events
				WHERE organization_id = ${workspace.org.id}
				  AND semantic_type = 'poll_closed'
			`,
		).toHaveLength(2);
	});
});
