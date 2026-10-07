import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	normalizeSlackUserId,
	slackAclSource,
	slackChannelsToResources,
} from "@lobu/connectors/slack-identity";
import { Hono } from "hono";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions.js";
import {
	addUserToOrganization,
	createTestEntity,
	createTestUser,
	insertChatConnectionRow,
} from "../../__tests__/setup/test-fixtures.js";
import { buildAccessGraph } from "../../authz/access-graph.js";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { insertEvent } from "../../utils/insert-event.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
	buildApiConversationId,
	threadIdFromApiConversationId,
} from "../services/api-conversation-id.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-history";
const USER_ID = "user-history-1";
const SLACK_TEAM_ID = "T01HISTORY";
const SLACK_CONNECTION_ID = "history-slack";
const SLACK_CHANNEL_ID = "C01HISTORY";

async function insertRun(opts: {
	organizationId: string;
	agentId: string;
	conversationId: string;
	runType?: string;
	status?: string;
	queueName?: string;
	actionInput?: Record<string, unknown>;
}): Promise<number> {
	const sql = getDb();
	const runType = opts.runType ?? "chat_message";
	const status = opts.status ?? "completed";
	const queueName = opts.queueName ?? runType;
	const actionInput = opts.actionInput ?? {
		agentId: opts.agentId,
		conversationId: opts.conversationId,
	};
	const rows = (await sql`
    INSERT INTO public.runs (
      organization_id, run_type, status, action_input,
      queue_name, run_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${runType},
      ${status},
      ${sql.json(actionInput)},
      ${queueName},
      NOW(),
      NOW()
    )
    RETURNING id
  `) as Array<{ id: number }>;
	return rows[0]!.id;
}

describe("agent history routes", () => {
	let agentMetadataStore: AgentMetadataStore;
	let userAgentsStore: UserAgentsStore;

	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		agentMetadataStore = new AgentMetadataStore(
			createPostgresAgentConfigStore(),
		);
		userAgentsStore = new UserAgentsStore();

		await orgContext.run({ organizationId: ORG_ID }, async () => {
			await seedAgentRow("agent-1", {
				organizationId: ORG_ID,
				name: "Agent 1",
				ownerPlatform: "external",
				ownerUserId: USER_ID,
			});
			await userAgentsStore.addAgent("external", USER_ID, "agent-1");
		});
	});

	afterEach(() => {
		setAuthProvider(null);
	});

	function createApp() {
		const app = new Hono();
		app.route(
			"/api/v1/agents/:agentId/history",
			createAgentHistoryRoutes({
				agentConfigStore: {
					getMetadata: (agentId: string) =>
						agentMetadataStore.getMetadata(agentId),
				},
				userAgentsStore,
			}),
		);
		return app;
	}

	async function seedFederatedMember(
		userId: string,
		name: string,
		slackUserId: string,
	) {
		const sql = getDb();
		const memberEntity = await createTestEntity({
			name,
			entity_type: "$member",
			organization_id: ORG_ID,
			created_by: userId,
		});
		const slackIdentity = normalizeSlackUserId(SLACK_TEAM_ID, slackUserId);
		if (!slackIdentity) throw new Error("Invalid Slack test identity");
		await sql`
			INSERT INTO entity_identities (
				organization_id, entity_id, namespace, identifier, source_connector
			) VALUES
				(${ORG_ID}, ${memberEntity.id}, 'auth_user_id', ${userId}, 'auth:signup'),
				(${ORG_ID}, ${memberEntity.id}, 'slack_user_id', ${slackIdentity}, 'connector:slack')
		`;
	}

	async function seedPlatformConversationAcl(opts?: { buildAcl?: boolean }) {
		const sql = getDb();
		await sql`
			INSERT INTO "user" (
				id, email, name, username, "emailVerified", "createdAt", "updatedAt"
			) VALUES (
				${USER_ID}, 'history-owner@test.example.com', 'History Owner',
				'history-owner', true, NOW(), NOW()
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await addUserToOrganization(USER_ID, ORG_ID, "owner");

		const channelMember = await createTestUser({ name: "Channel Member" });
		await addUserToOrganization(channelMember.id, ORG_ID, "member");
		await seedFederatedMember(
			channelMember.id,
			"Channel Member",
			"U01MEMBER",
		);

		await insertChatConnectionRow({
			id: SLACK_CONNECTION_ID,
			organizationId: ORG_ID,
			agentId: "agent-1",
			platform: "slack",
			status: "active",
			metadata: { teamId: SLACK_TEAM_ID },
		});
		await createTestAutomationSubscription({
			organizationId: ORG_ID,
			agentId: "agent-1",
			connectionSlug: `agentconn-${SLACK_CONNECTION_ID}`,
			platform: "slack",
			channelId: SLACK_CHANNEL_ID,
			teamId: SLACK_TEAM_ID,
			configuredBy: USER_ID,
		});
		if (opts?.buildAcl !== false) {
			await buildAccessGraph({
				organizationId: ORG_ID,
				connectionId: SLACK_CONNECTION_ID,
				connectorKey: slackAclSource.key,
				resourceNamespace: slackAclSource.resourceNamespace,
				memberIdentities: slackAclSource.memberIdentities,
				resources: slackChannelsToResources(SLACK_TEAM_ID, [
					{
						channelId: SLACK_CHANNEL_ID,
						name: "history",
						memberSlackUserIds: ["U01MEMBER"],
					},
				]),
			});
		}

		const conversationId = `slack:${SLACK_CHANNEL_ID}:1700000000.123456`;
		const jsonl =
			`{"type":"session","version":3,"id":"s-platform","timestamp":"2026-07-23T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u-platform","parentId":null,"timestamp":"2026-07-23T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Visible through federated ACL"}]}}\n`;
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId: "agent-1",
			conversationId,
		});
		await sql`
			INSERT INTO public.agent_transcript_snapshot
				(organization_id, agent_id, conversation_id, run_id,
				 snapshot_jsonl, byte_size, terminal_status)
			VALUES
				(${ORG_ID}, 'agent-1', ${conversationId}, ${runId},
				 ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
		`;

		return { channelMember, conversationId };
	}

	async function readPlatformTranscript(
		userId: string,
		conversationId: string,
		opts?: { agentBound?: boolean; withOrgContext?: boolean; isAdmin?: boolean },
	): Promise<Response> {
		setAuthProvider(() => ({
			userId,
			platform: "external",
			...(opts?.agentBound ? { agentId: "agent-1" } : {}),
			...(opts?.isAdmin ? { isAdmin: true } : {}),
			exp: Date.now() + 60_000,
		}));
		const request = () =>
			createApp().request(
				`/api/v1/agents/agent-1/history/conversations/${encodeURIComponent(conversationId)}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			);
		return opts?.withOrgContext === false
			? request()
			: orgContext.run({ organizationId: ORG_ID }, request);
	}

	test("replays pending manage_agents approvals as interactions on reload", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-appr";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});

		// A pending builder approval, stamped with the conversationId the way the
		// internal interactions route does, so the history endpoint replays it —
		// the transcript itself carries no interaction parts.
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			runType: "internal",
			status: "pending",
		});
		const proposal = {
			action: "update",
			agent_id: "weekly-digest",
			name: "Weekly Digest",
		};
		const current = { id: "weekly-digest", name: "Old Name" };
		const approvalEvent = await orgContext.run({ organizationId: ORG_ID }, () =>
			insertEvent({
				entityIds: [],
				organizationId: ORG_ID,
				originId: `run_${runId}_pending`,
				title: "update weekly-digest — pending approval",
				content: "Builder requested a change",
				semanticType: "operation",
				runId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInput: proposal,
				metadata: {
					conversationId,
					action: "update",
					proposal,
					current,
					status: "pending_approval",
					run_id: runId,
				},
			}),
		);

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			interactions?: Array<{
				type: string;
				eventId: number;
				runId: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
			}>;
		};
		expect(body.interactions).toHaveLength(1);
		const card = body.interactions?.[0];
		expect(card?.type).toBe("tool-approval");
		expect(card?.eventId).toBe(Number(approvalEvent.id));
		expect(card?.runId).toBe(runId);
		expect(card?.action).toBe("update");
		expect(card?.proposal).toMatchObject({ agent_id: "weekly-digest" });
		expect(card?.current).toMatchObject({ id: "weekly-digest" });
	});

	test("replays a pending entity_field_change approval with fields + attribution", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-efc";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});

		// An agent proposed changing a human-owned field; the worker stamped the
		// conversationId (via /internal/interactions/create) so it replays. The
		// entity_field_change card routes on `fields`, not `proposal`.
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			runType: "internal",
			status: "pending",
		});
		const fields = { "metadata.tier": "enterprise" };
		const current = { "metadata.tier": "free" };
		const reason = "The CRM tier differs from the human-owned value.";
		await orgContext.run({ organizationId: ORG_ID }, () =>
			insertEvent({
				entityIds: [],
				organizationId: ORG_ID,
				originId: `run_${runId}_pending`,
				title: "An agent proposes changing metadata.tier — pending approval",
				content: "An agent proposed updating metadata.tier on this entity.",
				semanticType: "operation",
				runId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInput: { entity_id: 7, fields, current },
				metadata: {
					conversationId,
					tool: "entity_field_change",
					action_key: "entity_field_change",
					entity_id: 7,
					fields,
					current,
					attribution: "agent",
					reason,
					status: "pending_approval",
					run_id: runId,
				},
			}),
		);

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			interactions?: Array<{
				type: string;
				runId: number;
				fields: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				attribution: string | null;
				reason: string | null;
			}>;
		};
		expect(body.interactions).toHaveLength(1);
		const card = body.interactions?.[0];
		expect(card?.type).toBe("tool-approval");
		expect(card?.runId).toBe(runId);
		// The SPA routes on `fields` (non-empty) to the entity-field-change card.
		expect(card?.fields).toMatchObject({ "metadata.tier": "enterprise" });
		expect(card?.current).toMatchObject({ "metadata.tier": "free" });
		expect(card?.attribution).toBe("agent");
		expect(card?.reason).toBe(reason);
	});

	test("replays only the latest terminal agent error and clears it after success", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-error";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});
		const errorRunId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			queueName: "thread_response",
			actionInput: {
				messageId: "m-error",
				channelId: conversationId,
				conversationId,
				userId: USER_ID,
				teamId: "api",
				timestamp: Date.now(),
				error: "429 quota exhausted",
				errorCode: "PROVIDER_QUOTA_EXHAUSTED",
				errorContext: { provider: "z-ai", model: "glm-5.2" },
			},
		});

		const requestHistory = () =>
			orgContext.run({ organizationId: ORG_ID }, () =>
				createApp().request(
					`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
					{ method: "GET", headers: { host: "localhost" } },
				),
			);

		const errorResponse = await requestHistory();
		expect(errorResponse.status).toBe(200);
		const errorBody = (await errorResponse.json()) as {
			interactions: Array<Record<string, unknown>>;
		};
		expect(errorBody.interactions).toContainEqual({
			type: "agent-error",
			runId: errorRunId,
			error: "429 quota exhausted",
			errorCode: "PROVIDER_QUOTA_EXHAUSTED",
			errorContext: { provider: "z-ai", model: "glm-5.2" },
		});

		// A later successful terminal outcome supersedes the stale error.
		await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			queueName: "thread_response",
			actionInput: {
				messageId: "m-success",
				channelId: conversationId,
				conversationId,
				userId: USER_ID,
				teamId: "api",
				timestamp: Date.now() + 1,
				processedMessageIds: ["m-success"],
				finalText: "Recovered",
			},
		});

		const successResponse = await requestHistory();
		const successBody = (await successResponse.json()) as {
			interactions: Array<{ type: string }>;
		};
		expect(
			successBody.interactions.some(
				(interaction) => interaction.type === "agent-error",
			),
		).toBe(false);
	});

	test("returns transcript messages when supplemental error history is malformed", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-malformed-error";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});
		const jsonl =
			`{"type":"session","version":3,"id":"s-malformed","timestamp":"2026-07-11T00:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u-malformed","parentId":null,"timestamp":"2026-07-11T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Keep this message"}]}}\n`;
		const snapshotRunId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
		});
		const sql = getDb();
		await sql`
			INSERT INTO public.agent_transcript_snapshot
				(organization_id, agent_id, conversation_id, run_id,
				 snapshot_jsonl, byte_size, terminal_status)
			VALUES
				(${ORG_ID}, ${agentId}, ${conversationId}, ${snapshotRunId},
				 ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
		`;

		// The history query supports legacy JSON-encoded strings. This scalar is
		// valid jsonb but invalid when decoded and cast back to jsonb, so only the
		// supplementary agent-error lookup fails.
		await sql`
			INSERT INTO public.runs (
				organization_id, run_type, status, action_input,
				queue_name, run_at, created_at
			) VALUES (
				${ORG_ID},
				'chat_message',
				'completed',
				${sql.json("not-json")},
				'thread_response',
				NOW(),
				NOW()
			)
		`;

		const response = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			messages: Array<{ id: string }>;
			interactions: Array<unknown>;
		};
		expect(body.messages.map((message) => message.id)).toEqual(["u-malformed"]);
		expect(body.interactions).toEqual([]);
	});

	test("rejects sessions that do not own the requested agent", async () => {
		setAuthProvider(() => ({
			userId: "u2",
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const response = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request("/api/v1/agents/agent-1/history/threads", {
				headers: {
					host: "localhost",
				},
				method: "GET",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("allows a non-owner org member to read a bound platform transcript through federated ACL", async () => {
		const { channelMember, conversationId } =
			await seedPlatformConversationAcl();
		const response = await readPlatformTranscript(
			channelMember.id,
			conversationId,
			{ agentBound: true },
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			messages: Array<{
				id: string;
				content: Array<{ type: string; text: string }>;
			}>;
		};
		expect(body.messages).toEqual([
			expect.objectContaining({
				id: "u-platform",
				content: [
					{ type: "text", text: "Visible through federated ACL" },
				],
			}),
		]);
	});

	test("lists and reads an unbound DM for an org owner but not a member", async () => {
		const sql = getDb();
		await sql`
			INSERT INTO "user" (
				id, email, name, username, "emailVerified", "createdAt", "updatedAt"
			) VALUES (
				${USER_ID}, 'history-owner@test.example.com', 'History Owner',
				'history-owner', true, NOW(), NOW()
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await addUserToOrganization(USER_ID, ORG_ID, "owner");

		const member = await createTestUser({ name: "DM-hidden member" });
		await addUserToOrganization(member.id, ORG_ID, "member");

		const conversationId = "telegram:6570514069";
		const jsonl =
			`{"type":"session","version":3,"id":"s-dm","timestamp":"2026-07-30T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u-dm","parentId":null,"timestamp":"2026-07-30T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Private DM"}]}}\n`;
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId: "agent-1",
			conversationId,
		});
		await sql`
			INSERT INTO public.agent_transcript_snapshot
				(organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
			VALUES
				(${ORG_ID}, 'agent-1', ${conversationId}, ${runId}, ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
		`;
		await sql`
			INSERT INTO public.conversations
				(organization_id, agent_id, platform, conversation_id, kind, user_id, title, is_direct, last_activity_at)
			VALUES
				(${ORG_ID}, 'agent-1', 'telegram', ${conversationId}, 'platform', '6570514069', 'Private DM', true, now())
		`;

		const requestAs = (
			userId: string,
			path: string,
			opts?: { isAdmin?: boolean },
		) => {
			setAuthProvider(() => ({
				userId,
				platform: "external",
				agentId: "agent-1",
				...(opts?.isAdmin ? { isAdmin: true } : {}),
				exp: Date.now() + 60_000,
			}));
			return orgContext.run({ organizationId: ORG_ID }, () =>
				createApp().request(path, {
					method: "GET",
					headers: { host: "localhost" },
				}),
			);
		};

		const list = await requestAs(
			USER_ID,
			"/api/v1/agents/agent-1/history/threads?scope=all",
		);
		expect(list.status).toBe(200);
		const listBody = (await list.json()) as {
			threads: Array<{ conversationId: string }>;
		};
		expect(listBody.threads.map((thread) => thread.conversationId)).toContain(
			conversationId,
		);

		const ownerRead = await requestAs(
			USER_ID,
			`/api/v1/agents/agent-1/history/conversations/${encodeURIComponent(conversationId)}/messages`,
		);
		expect(ownerRead.status).toBe(200);

		const memberRead = await requestAs(
			member.id,
			`/api/v1/agents/agent-1/history/conversations/${encodeURIComponent(conversationId)}/messages`,
		);
		expect(memberRead.status).toBe(404);

		const platformAdminList = await requestAs(
			member.id,
			"/api/v1/agents/agent-1/history/threads?scope=all",
			{ isAdmin: true },
		);
		expect(platformAdminList.status).toBe(200);
		const platformAdminBody = (await platformAdminList.json()) as {
			threads: Array<{ conversationId: string }>;
		};
		expect(
			platformAdminBody.threads.map((thread) => thread.conversationId),
		).toContain(conversationId);
	});

	test("reads a bound agent's platform conversation in the ambient org, not the ownership-first org", async () => {
		const sql = getDb();
		const SHARED_ORG = "test-org-shared-system-read";
		await seedAgentRow("agent-1", {
			organizationId: SHARED_ORG,
			name: "Builder",
			ownerPlatform: "external",
			ownerUserId: USER_ID,
		});
		await sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (${USER_ID}, 'History User', ${`${USER_ID}@test.example.com`}, true, now(), now())
			ON CONFLICT (id) DO NOTHING
		`;
		await addUserToOrganization(USER_ID, SHARED_ORG, "owner");

		const CHANNEL = "C0SHARED";
		const TEAM = "T0SHARED";
		const SLACK_USER = "U0SHAREDU";
		await insertChatConnectionRow({
			id: "shared-read-conn",
			organizationId: SHARED_ORG,
			agentId: "agent-1",
			platform: "slack",
			status: "active",
			metadata: { teamId: TEAM },
		});
		await createTestAutomationSubscription({
			organizationId: SHARED_ORG,
			agentId: "agent-1",
			connectionSlug: `agentconn-shared-read-conn`,
			platform: "slack",
			channelId: CHANNEL,
			teamId: TEAM,
			configuredBy: USER_ID,
		});
		const member = await createTestEntity({
			name: "History User",
			entity_type: "$member",
			organization_id: SHARED_ORG,
			created_by: USER_ID,
		});
		await sql`
			INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
			VALUES
				(${SHARED_ORG}, ${member.id}, 'auth_user_id', ${USER_ID}, 'auth:signup'),
				(${SHARED_ORG}, ${member.id}, 'slack_user_id', ${normalizeSlackUserId(TEAM, SLACK_USER)}, 'auth:signup')
		`;
		await buildAccessGraph({
			organizationId: SHARED_ORG,
			connectionId: "shared-read-conn",
			connectorKey: slackAclSource.key,
			resourceNamespace: slackAclSource.resourceNamespace,
			memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{
					channelId: CHANNEL,
					name: "shared",
					memberSlackUserIds: [SLACK_USER],
				},
			]),
		});
		const conversationId = `slack:${CHANNEL}:1700000000.123456`;
		const jsonl =
			`{"type":"session","version":3,"id":"s-shared","timestamp":"2026-07-23T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u-shared","parentId":null,"timestamp":"2026-07-23T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Shared org DM"}]}}\n`;
		const runId = await insertRun({
			organizationId: SHARED_ORG,
			agentId: "agent-1",
			conversationId,
		});
		await sql`
			INSERT INTO public.agent_transcript_snapshot
				(organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
			VALUES
				(${SHARED_ORG}, 'agent-1', ${conversationId}, ${runId}, ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
		`;

		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			agentId: "agent-1",
			exp: Date.now() + 60_000,
		}));
		const response = await orgContext.run({ organizationId: SHARED_ORG }, () =>
			createApp().request(
				`/api/v1/agents/agent-1/history/conversations/${encodeURIComponent(conversationId)}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { messages: Array<{ id: string }> };
		expect(body.messages.map((m) => m.id)).toEqual(["u-shared"]);
	});

	test("reads an OWNED conversation by its stored id, and denies a non-owner", async () => {
		// The gap this closes: an owned conversation was listed under its stored id
		// but no handler accepted that id — the read path re-derived one from the
		// caller's own userId, so the id the listing returned resolved to nothing.
		const sql = getDb();
		const conversationId = `agent-1_${USER_ID}_${ORG_ID}_thread-owned-1`;
		const jsonl =
			`{"type":"session","version":3,"id":"s-owned","timestamp":"2026-07-23T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u-owned","parentId":null,"timestamp":"2026-07-23T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Private note"}]}}\n`;
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId: "agent-1",
			conversationId,
		});
		await sql`
			INSERT INTO public.agent_transcript_snapshot
				(organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
			VALUES
				(${ORG_ID}, 'agent-1', ${conversationId}, ${runId}, ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
		`;
		await sql`
			INSERT INTO public.conversations
				(organization_id, agent_id, platform, conversation_id, thread_id, kind, user_id, title)
			VALUES
				(${ORG_ID}, 'agent-1', 'web', ${conversationId}, 'thread-owned-1', 'owned', ${USER_ID}, 'Private note')
			ON CONFLICT DO NOTHING
		`;

		const read = (userId: string) => {
			setAuthProvider(() => ({
				userId,
				platform: "external",
				agentId: "agent-1",
				exp: Date.now() + 60_000,
			}));
			return orgContext.run({ organizationId: ORG_ID }, () =>
				createApp().request(
					`/api/v1/agents/agent-1/history/conversations/${encodeURIComponent(conversationId)}/messages`,
					{ method: "GET", headers: { host: "localhost" } },
				),
			);
		};

		const owner = await read(USER_ID);
		expect(owner.status).toBe(200);
		const body = (await owner.json()) as { messages: Array<{ id: string }> };
		expect(body.messages.map((m) => m.id)).toEqual(["u-owned"]);

		// Another member of the SAME org must not read it. 404, not 403, so an
		// unauthorized id is indistinguishable from one that does not exist.
		const stranger = await read("user-history-stranger");
		expect(stranger.status).toBe(404);
	});

	test("requires an enforced channel ACL for a non-owner org member", async () => {
		const { channelMember, conversationId } =
			await seedPlatformConversationAcl({ buildAcl: false });
		const response = await readPlatformTranscript(
			channelMember.id,
			conversationId,
			{ agentBound: true },
		);

		expect(response.status).toBe(404);
	});

	test("agent ownership does not grant access to a channel without source permissions", async () => {
		const { conversationId } = await seedPlatformConversationAcl({
			buildAcl: false,
		});
		const response = await readPlatformTranscript(USER_ID, conversationId);

		expect(response.status).toBe(404);
	});

	test("connection ownership admits a channel without borrowing agent ownership", async () => {
		const { conversationId } = await seedPlatformConversationAcl({
			buildAcl: false,
		});
		await getDb()`DELETE FROM agent_users WHERE agent_id = 'agent-1'`;
		await getDb()`UPDATE connections SET created_by = ${USER_ID}
			WHERE organization_id = ${ORG_ID} AND slug = ${`agentconn-${SLACK_CONNECTION_ID}`}`;
		expect(
			await orgContext.run({ organizationId: ORG_ID }, () =>
				userAgentsStore.ownsAgent("external", USER_ID, "agent-1", ORG_ID),
			),
		).toBe(false);

		const response = await readPlatformTranscript(USER_ID, conversationId);

		expect(response.status).toBe(200);
	});

	test("platform administration does not grant access to channels with unknown permissions", async () => {
		const { conversationId } = await seedPlatformConversationAcl({
			buildAcl: false,
		});
		const admin = await createTestUser({ name: "Platform Admin" });
		// Ordinary membership mirrors production: the ambient-org middleware only
		// sets x-lobu-org to an org the caller belongs to.
		await addUserToOrganization(admin.id, ORG_ID, "member");
		const response = await readPlatformTranscript(admin.id, conversationId, {
			isAdmin: true,
		});

		expect(response.status).toBe(404);
	});

	test("fails closed when an org member has no federated member projection", async () => {
		const { conversationId } = await seedPlatformConversationAcl();
		const unresolvedMember = await createTestUser({ name: "Unresolved Member" });
		await addUserToOrganization(unresolvedMember.id, ORG_ID, "member");
		const response = await readPlatformTranscript(
			unresolvedMember.id,
			conversationId,
		);

		expect(response.status).toBe(404);
	});

	test("fails closed when a resolved federated member lacks the channel edge", async () => {
		const { conversationId } = await seedPlatformConversationAcl();
		const deniedMember = await createTestUser({ name: "Denied Member" });
		await addUserToOrganization(deniedMember.id, ORG_ID, "member");
		await seedFederatedMember(deniedMember.id, "Denied Member", "U01DENIED");
		const response = await readPlatformTranscript(
			deniedMember.id,
			conversationId,
		);

		expect(response.status).toBe(404);
	});

	test("fails closed when a platform conversation channel is not bound to the agent", async () => {
		const { channelMember } = await seedPlatformConversationAcl();
		const unboundConversationId = "slack:C01UNBOUND:1700000000.123456";
		const response = await readPlatformTranscript(
			channelMember.id,
			unboundConversationId,
		);

		expect(response.status).toBe(404);
	});

	test("fails closed when the platform transcript route has no trusted org context", async () => {
		const { channelMember, conversationId } =
			await seedPlatformConversationAcl();
		const response = await readPlatformTranscript(
			channelMember.id,
			conversationId,
			{ withOrgContext: false },
		);

		expect(response.status).toBe(401);
	});

	test("lists threads and returns per-thread messages from snapshots", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-a";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});
		const jsonl =
			`{"type":"session","version":3,"id":"s1","timestamp":"2026-06-23T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-23T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Hello from server"}]}}\n` +
			`{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-23T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}\n`;

		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			status: "completed",
		});

		const sql = getDb();
		await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${ORG_ID}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;
		// The sidebar listing now reads the `conversations` entity (dual-written on
		// every turn), so materialize its row alongside the transcript.
		await sql`
      INSERT INTO public.conversations
        (organization_id, agent_id, platform, conversation_id,
         kind, user_id, title, last_activity_at)
      VALUES
        (${ORG_ID}, ${agentId}, 'web', ${conversationId},
         'owned', ${USER_ID}, 'Hello from server', now())
    `;

		const threadsRes = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request("/api/v1/agents/agent-1/history/threads", {
				method: "GET",
				headers: { host: "localhost" },
			}),
		);
		expect(threadsRes.status).toBe(200);
		const threadsBody = (await threadsRes.json()) as {
			threads: Array<{ id: string; title: string }>;
		};
		expect(threadsBody.threads).toEqual([
			expect.objectContaining({
				id: threadId,
				title: "Hello from server",
			}),
		]);

		const messagesRes = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/agent-1/history/threads/${threadId}/messages`,
				{
					method: "GET",
					headers: { host: "localhost" },
				},
			),
		);
		expect(messagesRes.status).toBe(200);
		const messagesBody = (await messagesRes.json()) as {
			threadId: string;
			messages: Array<{ role?: string; id: string }>;
		};
		expect(messagesBody.threadId).toBe(threadId);
		expect(messagesBody.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
	});
});

describe("agent history conversation id helpers", () => {
	test("buildApiConversationId packs agent/user/org/thread deterministically", () => {
		const conversationId = buildApiConversationId({
			agentId: "owletto-default",
			userId: "auth-user-1",
			organizationId: "org__abc",
			threadId: "d108bc64-64f",
		});
		expect(conversationId).toBe(
			"owletto-default_auth-user-1_org__abc_d108bc64-64f",
		);
	});

	describe("threadIdFromApiConversationId", () => {
		const owner = {
			agentId: "owletto-default",
			userId: "auth-user-1",
			organizationId: "org__abc",
		};

		test("packed web id → the suffix", () => {
			expect(
				threadIdFromApiConversationId({
					...owner,
					conversationId: "owletto-default_auth-user-1_org__abc_d108bc64-64f",
				}),
			).toBe("d108bc64-64f");
		});

		test("prefix-only default-thread id → null (nothing to route to)", () => {
			expect(
				threadIdFromApiConversationId({
					...owner,
					conversationId: "owletto-default_auth-user-1_org__abc",
				}),
			).toBeNull();
		});

		test("opaque id → null rather than a false web route", () => {
			expect(
				threadIdFromApiConversationId({
					...owner,
					conversationId: "opaque-session-42",
				}),
			).toBeNull();
		});

		test("id packed for a different user is not unpacked as this user's", () => {
			expect(
				threadIdFromApiConversationId({
					...owner,
					conversationId: "owletto-default_auth-user-2_org__abc_other",
				}),
			).toBeNull();
		});
	});
});
