import type { ConversationRecord } from "@lobu/core/contracts/tools/manage-conversations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ConversationUpsert,
	upsertConversation,
} from "../../gateway/services/conversations-store";
import type { Env } from "../../index";
import { buildConversationsNamespace } from "../../sandbox/namespaces/conversations";
import { manageConversations } from "../../tools/admin/manage_conversations";
import type { ToolContext } from "../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const AGENT = "conversation-lookup-agent";
const env = { ENVIRONMENT: "test" } as Env;

describe("conversations list/get platform resolution", () => {
	let ctx: ToolContext;

	beforeAll(async () => {
		const org = await createTestOrganization();
		const user = await createTestUser();
		await createTestAgent({ organizationId: org.id, agentId: AGENT, ownerUserId: user.id });
		ctx = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopes: ["*"],
			scopedToOrg: false,
			allowCrossOrg: false,
		};
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	async function materialize(
		conversationId: string,
		platform: string,
		overrides: Partial<ConversationUpsert> = {},
	) {
		await upsertConversation({
			organizationId: ctx.organizationId,
			agentId: AGENT,
			platform,
			conversationId,
			threadId: null,
			kind: "platform",
			title: "Synthetic conversation",
			lastActivityAt: new Date(),
			...overrides,
		});
	}

	it("SDK get without platform reads the WhatsApp conversation returned by list", async () => {
		const conversationId = "whatsapp.web:70001:15555550100@s.whatsapp.net";
		await materialize(conversationId, "whatsapp.web");
		const conversations = buildConversationsNamespace(ctx, env);
		const listed = await conversations.list({ agent_id: AGENT }) as { conversations: ConversationRecord[] };
		const row = listed.conversations.find((r) => r.conversation_id === conversationId);
		expect(row).toMatchObject({ platform: "whatsapp.web", conversation_id: conversationId });
		await expect(conversations.get({
			agent_id: AGENT,
			conversation_id: row!.conversation_id,
		})).resolves.toEqual({ action: "get", conversation: row });
	});

	it("the tool resolves an opaque id without parsing a platform from it", async () => {
		await materialize("opaque-conversation", "slack");
		await expect(manageConversations({
			action: "get", agent_id: AGENT, conversation_id: "opaque-conversation",
		}, env, ctx)).resolves.toMatchObject({
			conversation: { platform: "slack", conversation_id: "opaque-conversation" },
		});
	});

	it("rejects an ambiguous id even when one matching platform is web", async () => {
		await materialize("ambiguous-conversation", "web", { kind: "owned", userId: ctx.userId });
		await materialize("ambiguous-conversation", "slack");
		const conversations = buildConversationsNamespace(ctx, env);
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "ambiguous-conversation",
		})).rejects.toMatchObject({
			httpStatus: 404,
			message: `Conversation "ambiguous-conversation" not found for agent "${AGENT}"`,
		});
		// Explicit platform still disambiguates, including case normalization.
		for (const platform of ["web", "slack", "SLACK"]) {
			await expect(conversations.get({
				agent_id: AGENT, conversation_id: "ambiguous-conversation", platform,
			})).resolves.toMatchObject({ conversation: { platform: platform.toLowerCase() } });
		}
	});

	it.each(["whatsapp.web", "WHATSAPP.WEB"])("preserves explicit platform %s", async (platform) => {
		await materialize("explicit-conversation", "whatsapp.web");
		const conversations = buildConversationsNamespace(ctx, env);
		const listed = await conversations.list({ agent_id: AGENT }) as { conversations: ConversationRecord[] };
		const row = listed.conversations.find((r) => r.conversation_id === "explicit-conversation");
		expect(row).toBeDefined();
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "explicit-conversation", platform,
		})).resolves.toEqual({ action: "get", conversation: row });
	});

	it.each(["web", ""])("does not fall back when explicit platform %j misses", async (platform) => {
		await materialize("explicit-mismatch", "whatsapp.web");
		await expect(buildConversationsNamespace(ctx, env).get({
			agent_id: AGENT, conversation_id: "explicit-mismatch", platform,
		})).rejects.toMatchObject({ httpStatus: 404 });
	});

	it("ignores archived matches and rejects a missing id", async () => {
		await materialize("archived-twin", "web");
		await materialize("archived-twin", "slack");
		const sql = getTestDb();
		await sql`UPDATE conversations SET archived_at = now()
			WHERE organization_id = ${ctx.organizationId} AND agent_id = ${AGENT}
				AND conversation_id = 'archived-twin' AND platform = 'web'`;
		const conversations = buildConversationsNamespace(ctx, env);
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "archived-twin",
		})).resolves.toMatchObject({ conversation: { platform: "slack" } });
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "missing-conversation",
		})).rejects.toMatchObject({ httpStatus: 404 });
	});

	it("retains member ownership and authentication fences", async () => {
		await materialize("member-owned", "web", { kind: "owned", userId: ctx.userId });
		await materialize("other-owned", "web", { kind: "owned", userId: "synthetic-other-user" });
		await materialize("member-platform", "slack");
		const conversations = buildConversationsNamespace({ ...ctx, memberRole: "member" }, env);
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "member-owned",
		})).resolves.toMatchObject({ conversation: { kind: "owned", user_id: ctx.userId } });
		for (const conversation_id of ["other-owned", "member-platform"]) {
			await expect(conversations.get({ agent_id: AGENT, conversation_id })).rejects.toMatchObject({ httpStatus: 404 });
		}
		await expect(buildConversationsNamespace({ ...ctx, userId: null }, env).get({
			agent_id: AGENT, conversation_id: "member-owned",
		})).rejects.toMatchObject({ httpStatus: 401 });
	});

	it("scopes uniqueness to the requested organization and agent", async () => {
		const otherOrg = await createTestOrganization();
		await createTestAgent({ organizationId: otherOrg.id, agentId: AGENT });
		await createTestAgent({ organizationId: ctx.organizationId, agentId: "other-agent" });
		await materialize("scoped-conversation", "slack");
		await materialize("scoped-conversation", "slack", { organizationId: otherOrg.id });
		await materialize("scoped-conversation", "slack", { agentId: "other-agent" });
		const conversations = buildConversationsNamespace(ctx, env);
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "scoped-conversation",
		})).resolves.toMatchObject({ conversation: { platform: "slack" } });
		await materialize("foreign-conversation", "slack", { organizationId: otherOrg.id });
		await materialize("foreign-conversation", "slack", { agentId: "other-agent" });
		await expect(conversations.get({
			agent_id: AGENT, conversation_id: "foreign-conversation",
		})).rejects.toMatchObject({ httpStatus: 404 });
	});
});
