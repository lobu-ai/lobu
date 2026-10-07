/**
 * search_memory surfaces past chat-channel conversation from `channel_messages`
 * (the consolidation that retires get_channel_history). Two invariants:
 *  - an agent recalls messages in channels it is bound to, via keyword match;
 *  - the recall is fenced to the CALLING agent's own bindings — it never leaks
 *    another agent's channel transcript (channel_messages has no agent_id, so
 *    the binding set IS the tenant boundary).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
} from "../../__tests__/setup/test-fixtures";
import { initWorkspaceProvider } from "../../workspace";
import { search } from "../search";
import { createTestAutomationSubscription } from "../../__tests__/setup/automation-subscriptions";

async function bindChannelWithMessages(opts: {
  organizationId: string;
  agentId: string;
  connectionId: string;
  channelId: string;
  messages: string[];
  createdBy: string;
}): Promise<void> {
  const sql = getTestDb();
  await insertChatConnectionRow({
    id: opts.connectionId,
    agentId: opts.agentId,
		platform: "slack",
    organizationId: opts.organizationId,
		status: "active",
    createdBy: opts.createdBy,
  });
  await createTestAutomationSubscription({
    organizationId: opts.organizationId,
    agentId: opts.agentId,
    connectionSlug: `agentconn-${opts.connectionId}`,
    platform: "slack",
    channelId: opts.channelId,
  });
  for (let i = 0; i < opts.messages.length; i++) {
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, is_bot, text, occurred_at
      ) VALUES (
        ${opts.organizationId}, ${opts.connectionId}, 'slack', ${opts.channelId},
        ${`${opts.connectionId}-${i}`}, 'Alice', false, ${opts.messages[i]}, NOW()
      )
    `;
  }
}

describe("search_memory channel recall", () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

	it("returns past channel messages matching the query for the agent that owns the channel", async () => {
		const org = await createTestOrganization({ name: "Recall Org" });
    const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });

    await bindChannelWithMessages({
      organizationId: org.id,
      createdBy: user.id,
      agentId: agent.agentId,
			connectionId: "conn-recall",
			channelId: "C-RECALL",
      messages: [
				"We discussed the quarterly revenue forecast at length",
				"Lunch options for Friday were debated",
      ],
    });

    const result = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: user.id,
        agentId: agent.agentId,
			} as Parameters<typeof search>[2],
    );

    expect(result.conversation_messages).toBeDefined();
    expect(result.conversation_messages?.every((message) => message.message_id > 0)).toBe(true);
    expect(
      result.conversation_messages?.every((message) => message.workspace_slug === org.slug)
    ).toBe(true);
    const texts = (result.conversation_messages ?? []).map((m) => m.text);
		expect(texts.some((t) => t.includes("quarterly revenue forecast"))).toBe(
			true,
		);
    // The off-topic message in the same channel must not match the query terms.
		expect(texts.some((t) => t.includes("Lunch options"))).toBe(false);
  });

	it("does not leak another agent's channel transcript", async () => {
		const org = await createTestOrganization({ name: "Fence Org" });
    const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
    const mine = await createTestAgent({ organizationId: org.id });
    const other = await createTestAgent({ organizationId: org.id });

    await bindChannelWithMessages({
      organizationId: org.id,
      createdBy: user.id,
      agentId: mine.agentId,
			connectionId: "conn-mine",
			channelId: "C-MINE",
			messages: ["my channel covered the quarterly revenue numbers"],
    });
    await bindChannelWithMessages({
      organizationId: org.id,
      createdBy: user.id,
      agentId: other.agentId,
			connectionId: "conn-other",
			channelId: "C-OTHER",
			messages: ["secret: their channel also mentioned quarterly revenue"],
    });

    const result = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: user.id,
        agentId: mine.agentId,
			} as Parameters<typeof search>[2],
    );

		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(channels).toContain("C-MINE");
		expect(channels).not.toContain("C-OTHER");
  });

  it('falls back to recent messages for a generic "catch me up" prompt', async () => {
		const org = await createTestOrganization({ name: "Recap Org" });
    const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });

    await bindChannelWithMessages({
      organizationId: org.id,
      createdBy: user.id,
      agentId: agent.agentId,
			connectionId: "conn-recap",
			channelId: "C-RECAP",
      messages: [
				"The deploy went out at noon",
				"Sales numbers looked strong on Tuesday",
      ],
    });

    // None of those words appear in the transcript, but the prompt is all generic
    // recall stop-words → the recency fallback returns the channel's messages
    // instead of nothing (the "catch me up" case get_channel_history served).
    const result = await search(
			{ query: "what did we talk about earlier", include_content: true },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: user.id,
        agentId: agent.agentId,
			} as Parameters<typeof search>[2],
    );

    const texts = (result.conversation_messages ?? []).map((m) => m.text);
    expect(texts.length).toBeGreaterThan(0);
		expect(texts.some((t) => t.includes("Sales numbers"))).toBe(true);
  });

	it("tolerates trailing punctuation (tokenizes on word chars, not whitespace)", async () => {
		const org = await createTestOrganization({ name: "Punctuation Org" });
    const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });

    await bindChannelWithMessages({
      organizationId: org.id,
      createdBy: user.id,
      agentId: agent.agentId,
			connectionId: "conn-punct",
			channelId: "C-PUNCT",
			messages: ["We reviewed the quarterly revenue forecast on Tuesday"],
    });
    const ctx = {
      organizationId: org.id,
      userId: user.id,
      agentId: agent.agentId,
    } as Parameters<typeof search>[2];

    // Keyword query ending in '?' still matches 'revenue' (the '?' is stripped).
    const kw = await search(
			{ query: "quarterly revenue?", include_content: true },
      {} as Parameters<typeof search>[1],
			ctx,
    );
    expect(
			(kw.conversation_messages ?? []).some((m) =>
				m.text.includes("quarterly revenue"),
			),
    ).toBe(true);

    // All-stop-word prompt ending in '?' → recency fallback, not empty
    // (without word-char tokenizing, 'earlier?' survived as a dead term).
    const generic = await search(
			{ query: "what did we talk about earlier?", include_content: true },
      {} as Parameters<typeof search>[1],
			ctx,
    );
    expect((generic.conversation_messages ?? []).length).toBeGreaterThan(0);
  });
});
