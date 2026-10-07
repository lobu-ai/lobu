import { cardToBlockKit } from "@chat-adapter/slack";
import type { CardElement } from "chat";
import { __setLocalFrontendForTests } from "../../../utils/public-origin";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { presentStoredEventToConversation } from "../../../notifications/service";
import { insertEvent } from "../../../utils/insert-event";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { TestWorkspace } from "../../setup/test-mcp-client";

describe("stored event summary delivery", () => {
  beforeAll(initWorkspaceProvider);
  beforeEach(async () => { await cleanupTestDatabase(); __setLocalFrontendForTests(false); });
  afterEach(() => { __setChatInstanceManagerForTests(null); __setLocalFrontendForTests(undefined); });

  it("keeps escaped summary text within the actual Slack section budget", async () => {
    const workspace = await TestWorkspace.create({ name: "Synthetic escaped summary" });
    const event = await insertEvent({
      organizationId: workspace.org.id, entityIds: [],
      originId: "synthetic-escaped-summary", semanticType: "synthetic.report",
      payloadType: "markdown", title: "Escaped summary",
      content: "& ".repeat(600),
    });
    const sections: string[] = [];
    __setChatInstanceManagerForTests({
      postToConversation: async (_connection, request) => {
        const blocks = cardToBlockKit((request.content as { card: CardElement }).card);
        for (const block of blocks) {
          if (block.type === "section" && "text" in block && block.text &&
              typeof block.text === "object" && "text" in block.text) {
            sections.push(String(block.text.text));
          }
        }
        return { messageId: "synthetic-budget-message", threadId: "synthetic-thread" };
      },
    });
    await expect(presentStoredEventToConversation({
      organizationId: workspace.org.id, eventId: event.id,
      connectionId: "synthetic-connection", platform: "slack",
      channelId: "synthetic-channel", channelKey: "slack:synthetic-channel",
      conversationId: "synthetic-conversation",
    })).resolves.toMatchObject({ ok: true });
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(3000);
      expect(section).not.toMatch(/&(amp?|lt?|gt?)?…$/);
    }
    expect(sections.join("")).toContain("&amp;");
  });

  it("delivers ordinary content and its canonical event link once across concurrent retries", async () => {
    const workspace = await TestWorkspace.create({ name: "Synthetic event presentation" });
    const event = await insertEvent({
      organizationId: workspace.org.id, entityIds: [],
      originId: "synthetic-summary-event", semanticType: "synthetic.report",
      payloadType: "markdown", title: "Release ballot",
      content: "Choose **A** or **B**.\n\nQuorum 3.",
      sourceUrl: "https://source.example/unrelated",
      metadata: { resource_url: "https://source.example/also-unrelated" },
    });
    const postToConversation = vi.fn(async () => ({ messageId: "synthetic-message", threadId: "synthetic-thread" }));
    __setChatInstanceManagerForTests({ postToConversation });
    const input = {
      organizationId: workspace.org.id, eventId: event.id,
      connectionId: "synthetic-connection", platform: "gchat",
      channelId: "synthetic-channel", channelKey: "gchat:synthetic-channel",
      conversationId: "synthetic-conversation",
    };
    const results = await Promise.all([
      presentStoredEventToConversation(input),
      presentStoredEventToConversation(input),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, messageId: "synthetic-message" }),
      expect.objectContaining({ ok: true, messageId: "synthetic-message" }),
    ]);
    expect(postToConversation).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(postToConversation.mock.calls);
    expect(sent).toContain("Choose A or B");
    expect(sent).toContain("Open event");
    expect(sent).toContain(`/events/${event.id}`);
    expect(sent).not.toContain("source.example");
    expect(sent).not.toContain("template-event:");
    const [stored] = await getTestDb()`SELECT metadata, payload_text FROM events WHERE id = ${event.id}`;
    expect(stored.metadata.delivery).toHaveLength(1);
    expect(stored.payload_text).toContain("**A**");
    const other = await TestWorkspace.create({ name: "Another synthetic workspace" });
    await expect(presentStoredEventToConversation({ ...input, organizationId: other.org.id }))
      .resolves.toEqual({ ok: false, reason: "not_found" });
    expect(postToConversation).toHaveBeenCalledTimes(1);
  });
});
