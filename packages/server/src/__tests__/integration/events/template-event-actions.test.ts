import { collectTemplateActionInvocations } from "@lobu/core/json-template";
import { __setLocalFrontendForTests } from "../../../utils/public-origin";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	invokeTemplateEventAction,
	templateEventActionId,
} from "../../../interactions/template-event-actions";
import {
	assertTemplateActionCapability,
	MAX_TEMPLATE_ACTION_SOURCE_EVENTS,
	TEMPLATE_ACTION_CAPABILITY_META_KEY,
} from "../../../interactions/template-action-capability";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { refreshInteractiveEventCardTask } from "../../../notifications/service";
import { INTERACTIVE_EVENT_CARD_REFRESH_TASK } from "../../../scheduled/task-definitions";
import { getContent } from "../../../tools/get_content";
import { getMcpResultMeta } from "../../../tools/mcp-result-meta";
import type { ToolContext } from "../../../tools/registry";
import { insertEvent } from "../../../utils/insert-event";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

describe("template event actions", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		__setLocalFrontendForTests(false);
		await cleanupTestDatabase();
	});

	afterEach(() => {
		__setLocalFrontendForTests(undefined);
		__setChatInstanceManagerForTests(null);
	});

	it.each([
		{ name: "ordinary structured payload", payload: { choice: "shown", count: 0, enabled: false }, metadata: { choice: "hidden" }, shown: "shown" },
		{ name: "metadata-only event", payload: {}, metadata: { choice: "shown" }, shown: "shown" },
		{ name: "notification payload", payload: { choice: "shown" }, metadata: { notification_type: "generic", choice: "hidden" }, shown: "shown" },
		{ name: "empty notification payload", payload: {}, metadata: { notification_type: "generic", choice: "hidden" }, shown: null },
	])("validates the choice rendered from $name", async ({ payload, metadata, shown }) => {
		const workspace = await TestWorkspace.create({ name: "Event data agreement" });
		const entity = await createTestEntity({
			name: "Synthetic decision", entity_type: "synthetic-decision",
			organization_id: workspace.org.id, created_by: workspace.users.owner.id,
		});
		const sql = getTestDb();
		await sql`
      UPDATE entity_types SET event_kinds = ${sql.json({
			decision: {
				jsonTemplate: {
					type: "if", condition: "choice",
					then: { type: "button", props: { label: "{{choice}}", value: "{{choice}}", onClick: "@choose" } },
					else: { type: "text", content: "No choice available" },
				},
				interactions: { choose: { emits: "decision_cast" } },
			},
			decision_cast: { description: "A verified decision" },
		})} WHERE organization_id = ${workspace.org.id} AND slug = 'synthetic-decision'
    `;
		const source = await insertEvent({
			entityIds: [entity.id], organizationId: workspace.org.id,
			originId: "synthetic-decision", payloadType: "empty",
			semanticType: "decision", payloadData: payload, metadata,
		});
		const api = await TestApiClient.for({
			organizationId: workspace.org.id, userId: workspace.users.owner.id, memberRole: "owner",
		});
		const read = await api.knowledge.read({ content_ids: [source.id] });
		const item = read.content.find((event) => Number(event.id) === source.id)!;
		const rendered = collectTemplateActionInvocations(
			item.payload_template!.root, item.payload_data ?? {},
		);
		expect(rendered).toEqual(shown === null ? [] : [{ action: "choose", value: shown }]);
		const invoke = (value: string) => invokeTemplateEventAction({
			organizationId: workspace.org.id, sourceEventId: source.id,
			action: "choose", value, interactionId: "choice-" + value, surface: "web",
			actor: { platform: "web", platformUserId: workspace.users.owner.id, userId: workspace.users.owner.id },
		});
		await expect(invoke("hidden")).rejects.toThrow(/not present in the rendered event/i);
		if (shown !== null) {
			const accepted = await invoke(rendered[0].value!);
			expect(accepted).toMatchObject({ created: true, eventType: "decision_cast" });
			const [stored] = await sql`SELECT metadata FROM events WHERE id = ${accepted.eventId}`;
			expect(stored.metadata).toMatchObject({ ...item.payload_data, interaction: { value: shown } });
		}
	});

	it("binds actor + delivery, dedupes retries, and wakes subscribed Automations", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Template Action Org",
		});
		const ownerUserId = workspace.users.owner.id;
		const poll = await createTestEntity({
			name: "Deployment poll",
			entity_type: "poll",
			organization_id: workspace.org.id,
			created_by: ownerUserId,
		});
		const eventKinds = {
			poll_opened: {
				description: "An open poll",
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
					],
				},
				interactions: { vote: { emits: "poll_vote_cast" } },
			},
			poll_vote_cast: { description: "A verified vote interaction" },
			poll_closed: {
				description: "A closed poll",
				jsonTemplate: {
					type: "card",
					children: [
						{ type: "text", content: "Poll closed" },
						{
							type: "button",
							props: { label: "Reopen", onClick: "@reopen" },
						},
					],
				},
				interactions: { reopen: { emits: "poll_reopen_requested" } },
			},
			poll_reopen_requested: { description: "A verified reopen request" },
		};
		await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json(eventKinds)}
      WHERE organization_id = ${workspace.org.id}
        AND slug = 'poll'
    `;

		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId,
			agentId: "poll-reducer",
		});
		const api = await TestApiClient.for({
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
		});
		await api.automations.create({
			slug: "poll-vote-reducer",
			prompt: "Reduce the verified vote event.",
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

		const source = await insertEvent({
			entityIds: [poll.id],
			organizationId: workspace.org.id,
			originId: "poll-opened-1",
			title: "Ship this release?",
			content: "Choose the release outcome.",
			payloadType: "empty",
			payloadData: { poll_id: "poll-1", quorum: 2 },
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				resource_url: "https://app.lobu.ai/template-action-poll",
				delivery: [
					{
						connectionId: "91",
						channelKey: "gchat:spaces/AAA",
						messageId: "spaces/AAA/messages/poll-1",
						threadId: "gchat:spaces/AAA:dm",
					},
				],
			},
		});
		const mcpAppCtx = {
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
			isAuthenticated: true,
			clientId: "poll-mcp-app",
			mcpSessionId: "poll-mcp-session",
			mcpConversationId: "poll-mcp-conversation",
			tokenType: "oauth",
			scopes: ["mcp:read", "mcp:write"],
			scopedToOrg: true,
			allowCrossOrg: false,
		} as ToolContext & {
			userId: string;
			clientId: string;
			mcpSessionId: string;
		};
		const rendered = await getContent(
			{ content_ids: [source.id], limit: 10 },
			{} as never,
			mcpAppCtx,
		);
		const capability = getMcpResultMeta(rendered)?.[
			TEMPLATE_ACTION_CAPABILITY_META_KEY
		];
		expect(typeof capability).toBe("string");
		expect(() =>
			assertTemplateActionCapability(
				capability as string,
				source.id,
				mcpAppCtx,
			),
		).not.toThrow();

		const extraSources = await Promise.all(
			Array.from({ length: MAX_TEMPLATE_ACTION_SOURCE_EVENTS }, (_, index) =>
				insertEvent({
					entityIds: [poll.id],
					organizationId: workspace.org.id,
					originId: `template-action-window-${index}`,
					title: `Release poll ${index}`,
					payloadType: "empty",
					payloadData: { poll_id: `poll-${index + 2}`, quorum: 2 },
					semanticType: "poll_opened",
					metadata: { notification_type: "generic" },
				}),
			),
		);
		const paged = await getContent(
			{
				content_ids: [source.id, ...extraSources.map((item) => item.id)],
				limit: MAX_TEMPLATE_ACTION_SOURCE_EVENTS + 1,
			},
			{} as never,
			mcpAppCtx,
		);
		const pagedCapability =
			getMcpResultMeta(paged)?.[TEMPLATE_ACTION_CAPABILITY_META_KEY];
		expect(typeof pagedCapability).toBe("string");
		const pageEventIds = (paged.content as Array<{ id: number }>).map(
			(item) => item.id,
		);
		const interactivePageIds = (
			paged.content as Array<{
				id: number;
				payload_template?: { interactions?: Record<string, unknown> };
			}>
		)
			.filter((item) =>
				Boolean(Object.keys(item.payload_template?.interactions ?? {}).length),
			)
			.map((item) => item.id);
		expect(interactivePageIds).toHaveLength(
			MAX_TEMPLATE_ACTION_SOURCE_EVENTS + 1,
		);
		expect(paged.hints?.join(" ")).toMatch(/paginate or narrow/i);
		const authorized = pageEventIds.filter((eventId) => {
			try {
				assertTemplateActionCapability(
					pagedCapability as string,
					eventId,
					mcpAppCtx,
				);
				return true;
			} catch {
				return false;
			}
		});
		expect(authorized).toHaveLength(MAX_TEMPLATE_ACTION_SOURCE_EVENTS);
		expect(pageEventIds).toHaveLength(MAX_TEMPLATE_ACTION_SOURCE_EVENTS + 1);

		const invoke = (overrides: Record<string, unknown> = {}) =>
			invokeTemplateEventAction({
				organizationId: workspace.org.id,
				sourceEventId: source.id,
				action: "vote",
				value: "A",
				interactionId: "google-event-1",
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: "users/ada",
					name: "Ada",
				},
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:dm",
				},
				...overrides,
			} as never);

		const first = await invoke();
		expect(first).toMatchObject({ created: true, eventType: "poll_vote_cast" });
		const replay = await invoke();
		expect(replay).toEqual({ ...first, created: false });
		await expect(
			invoke({
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					// Google Chat stores a direct-message delivery under the stable
					// DM conversation id, but its card callback re-encodes the exact
					// message as a message-bound thread id.
					threadId: "gchat:spaces/AAA:c3BhY2VzL0FBQS9tZXNzYWdlcy9wb2xsLTE",
				},
			}),
		).resolves.toEqual({ ...first, created: false });

		const votes = await sql<{
			id: number;
			metadata: {
				poll_id: string;
				interaction: { value: string; actor: { id: string } };
			};
		}>`
      SELECT id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'poll_vote_cast'
      ORDER BY id
    `;
		expect(votes).toHaveLength(1);
		expect(votes[0].metadata).toMatchObject({
			poll_id: "poll-1",
			interaction: { value: "A", actor: { id: "users/ada" } },
		});

		const activations = await sql`
      SELECT id
      FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'task'
        AND action_key = 'activate-workspace-event'
    `;
		expect(activations).toHaveLength(1);

		await expect(
			invoke({ value: "C", interactionId: "forged-value" }),
		).rejects.toThrow(/not present in the rendered event/i);
		// `interactions` is raw JSONB with a live prototype and `constructor`
		// matches the action-name grammar, so a bare index would admit it and
		// then append an event whose semantic type is `undefined`.
		await expect(
			invoke({ action: "constructor", interactionId: "prototype-probe" }),
		).rejects.toThrow(/does not declare that interaction/i);
		await api.knowledge.save({
			entity_ids: [poll.id],
			content: "Poisoned retry key",
			semantic_type: "poll_opened",
			payload_type: "empty",
			metadata: { status: "still-open" },
			idempotency_key: `event-action:${source.id}:gchat:poisoned-click`,
		});
		await expect(
			invoke({ interactionId: "poisoned-click" }),
		).rejects.toThrow();
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${workspace.org.id}
          AND semantic_type = 'poll_vote_cast'
      `,
		).toHaveLength(1);
		await expect(
			invoke({ action: "close", interactionId: "forged-action" }),
		).rejects.toThrow(/does not declare/i);
		await expect(
			invoke({
				interactionId: "wrong-connection",
				source: {
					connectionId: "92",
					messageId: "spaces/AAA/messages/poll-1",
				},
			}),
		).rejects.toThrow(/does not belong to this chat delivery/i);
		await expect(
			invoke({
				interactionId: "wrong-message",
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/another-card",
				},
			}),
		).rejects.toThrow(/does not belong to this chat delivery/i);
		await expect(
			invoke({
				interactionId: "wrong-thread",
				surface: "slack",
				actor: {
					platform: "slack",
					platformUserId: "UADA",
					name: "Ada",
				},
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "slack:C999:1712345678.000001",
				},
			}),
		).rejects.toThrow(/does not belong to this chat delivery/i);

		const otherWorkspace = await TestWorkspace.create({
			name: "Other Template Action Org",
		});
		await expect(
			invoke({
				organizationId: otherWorkspace.org.id,
				interactionId: "wrong-org",
			}),
		).rejects.toThrow(/not found/i);

		const editMessageContent = vi.fn(async () => undefined);
		__setChatInstanceManagerForTests({ editMessageContent });
		await api.knowledge.save({
			entity_ids: [poll.id],
			content: "Closed after quorum was reached.",
			semantic_type: "poll_closed",
			title: "Ship this release? Closed",
			payload_type: "empty",
			metadata: { poll_id: "poll-1", status: "closed" },
			supersedes_event_id: source.id,
			idempotency_key: "poll-close:poll-1",
		});
		const [closedReplacement] = await sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${workspace.org.id}
        AND supersedes_event_id = ${source.id}
      LIMIT 1
		`;
		if (!closedReplacement) throw new Error("Expected poll replacement");
		expect(
			await sql`
        SELECT id FROM runs
        WHERE organization_id = ${workspace.org.id}
          AND action_key = ${INTERACTIVE_EVENT_CARD_REFRESH_TASK}
          AND (action_input->'payload'->>'replacementEventId')::bigint = ${closedReplacement.id}
      `,
		).toHaveLength(1);
		await refreshInteractiveEventCardTask({
			organizationId: workspace.org.id,
			replacementEventId: Number(closedReplacement.id),
		});
		expect(editMessageContent).toHaveBeenCalledTimes(1);
		expect(editMessageContent).toHaveBeenCalledWith("91", {
			threadId: "gchat:spaces/AAA:dm",
			messageId: "spaces/AAA/messages/poll-1",
			content: expect.objectContaining({ card: expect.anything() }),
		});
		const refreshedCard = JSON.stringify(
			editMessageContent.mock.calls[0]?.[1]?.content,
		);
		expect(refreshedCard).toContain("Closed after quorum was reached.");
		expect(refreshedCard).toContain("Open event");
		expect(refreshedCard).toContain("/events/" + closedReplacement.id);
		expect(refreshedCard).not.toContain('"type":"button"');
		const [closed] = await sql<{
			id: number;
			metadata: { delivery?: unknown };
		}>`
      SELECT id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'poll_closed'
      ORDER BY id DESC
		LIMIT 1
    `;
		if (!closed) throw new Error("Expected a poll_closed replacement event");
		await vi.waitFor(async () => {
			const [refreshed] = await sql<{ metadata: { delivery?: unknown } }>`
        SELECT metadata
        FROM events
        WHERE id = ${closed.id}
      `;
			expect(refreshed.metadata.delivery).toEqual([
				{
					connectionId: "91",
					channelKey: "gchat:spaces/AAA",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:dm",
				},
			]);
		});
		await expect(
			invokeTemplateEventAction({
				organizationId: workspace.org.id,
				sourceEventId: closed.id,
				action: "reopen",
				value: null,
				interactionId: "google-reopen-1",
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: "users/ada",
					name: "Ada",
				},
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:dm",
				},
			}),
		).resolves.toMatchObject({
			created: true,
			eventType: "poll_reopen_requested",
		});
		await expect(invoke({ interactionId: "late-click" })).rejects.toThrow(
			/closed|replaced/i,
		);
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${workspace.org.id}
          AND semantic_type = 'poll_vote_cast'
			`,
		).toHaveLength(1);

		// A slow old refresh and a newly queued successor must converge on the
		// newest controls. The task lock spans the physical edit, while each waiter
		// resolves the head only after acquiring it.
		const raceSource = await insertEvent({
			entityIds: [poll.id],
			organizationId: workspace.org.id,
			originId: "poll-opened-refresh-race",
			title: "Race-safe poll",
			payloadType: "empty",
			semanticType: "poll_opened",
			metadata: {
				poll_id: "poll-refresh-race",
				delivery: [
					{
						connectionId: "93",
						messageId: "spaces/AAA/messages/poll-race",
						threadId: "gchat:spaces/AAA:threads/thread-race",
					},
				],
			},
		});
		const firstSuccessor = await api.knowledge.save({
			entity_ids: [poll.id],
			semantic_type: "poll_opened",
			title: "Race-safe poll · one vote",
			payload_type: "empty",
			metadata: { poll_id: "poll-refresh-race", response_count: 1 },
			supersedes_event_id: raceSource.id,
			idempotency_key: "poll-refresh-race:one",
		});
		let releaseFirstEdit = () => {};
		const firstEditRelease = new Promise<void>((resolve) => {
			releaseFirstEdit = resolve;
		});
		let markFirstEditStarted = () => {};
		const firstEditStarted = new Promise<void>((resolve) => {
			markFirstEditStarted = resolve;
		});
		const racingEdit = vi.fn(async () => {
			if (racingEdit.mock.calls.length === 1) {
				markFirstEditStarted();
				await firstEditRelease;
			}
		});
		__setChatInstanceManagerForTests({ editMessageContent: racingEdit });
		const slowOldRefresh = refreshInteractiveEventCardTask({
			organizationId: workspace.org.id,
			replacementEventId: Number(firstSuccessor.id),
		});
		await firstEditStarted;
		const newestSuccessor = await api.knowledge.save({
			entity_ids: [poll.id],
			semantic_type: "poll_opened",
			title: "Race-safe poll · two votes",
			payload_type: "empty",
			metadata: { poll_id: "poll-refresh-race", response_count: 2 },
			supersedes_event_id: Number(firstSuccessor.id),
			idempotency_key: "poll-refresh-race:two",
		});
		const newestRefresh = refreshInteractiveEventCardTask({
			organizationId: workspace.org.id,
			replacementEventId: Number(newestSuccessor.id),
		});
		releaseFirstEdit();
		await Promise.all([slowOldRefresh, newestRefresh]);
		expect(racingEdit).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(racingEdit.mock.calls.at(-1))).toContain(
			"/events/" + newestSuccessor.id,
		);
		expect(JSON.stringify(racingEdit.mock.calls.at(-1))).not.toContain('"type":"button"');
		await expect(
			invokeTemplateEventAction({
				organizationId: workspace.org.id,
				sourceEventId: Number(newestSuccessor.id),
				action: "vote",
				value: "A",
				interactionId: "google-refresh-race-vote",
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: "users/grace",
					name: "Grace",
				},
				source: {
					connectionId: "93",
					messageId: "spaces/AAA/messages/poll-race",
					threadId: "gchat:spaces/AAA:threads/thread-race",
				},
			}),
		).resolves.toMatchObject({ created: true, eventType: "poll_vote_cast" });
		__setChatInstanceManagerForTests({
			editMessageContent: vi.fn(async () => {
				throw new Error("transient edit failure");
			}),
		});
		await expect(
			refreshInteractiveEventCardTask({
				organizationId: workspace.org.id,
				replacementEventId: Number(newestSuccessor.id),
			}),
		).rejects.toThrow("transient edit failure");
	});
});
