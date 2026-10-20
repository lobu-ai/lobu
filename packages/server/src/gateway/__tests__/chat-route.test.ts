import { describe, expect, test } from "bun:test";
import { matchingAutomationTriggers } from "../../automations/event-trigger.js";
import {
  chatMessageSignal,
  resolveChatRoute,
} from "../connections/chat-route.js";

// The thread a Slack assistant panel opens, and the DM that later arrives on it.
const thread = {
  platform: "slack",
  connectionId: "conn-1",
  channelId: "slack:D123",
  conversationId: "slack:D123:1700.1",
  teamId: "T1",
  userId: "U1",
};
const realDm = chatMessageSignal({
  ...thread,
  messageId: "m1",
  text: "Plan this week's videos",
  isMention: false,
  occurredAt: "2026-10-20T00:00:00.000Z",
});
const threadStart = chatMessageSignal({
  ...thread,
  messageId: "assistant-thread:slack:D123:1700.1",
  text: "",
  isMention: false,
  occurredAt: "2026-10-20T00:00:00.000Z",
});

const linkedDmTrigger = {
  kind: "event",
  connector_key: "slack",
  event_types: ["message.created"],
  match: { channel_id: "D123", team_id: "T1" },
} as any;

describe("chat route", () => {
  test("a thread-start signal matches the same Automation as the DM that follows", () => {
    expect(matchingAutomationTriggers([linkedDmTrigger], threadStart)).toEqual(
      matchingAutomationTriggers([linkedDmTrigger], realDm),
    );
    expect(matchingAutomationTriggers([linkedDmTrigger], threadStart)).toHaveLength(1);
  });

  test("a planned Automation's agent wins over the connection's agent", async () => {
    const route = await resolveChatRoute({
      plan: {
        signal: threadStart,
        replyTargets: [],
        backgroundTargets: [
          {
            automationId: 7,
            organizationId: "org-2",
            agentId: "linked-agent",
            model: null,
            instructions: "",
          } as any,
        ],
      },
      platform: "slack",
      channelId: thread.channelId,
      connection: { agentId: "fallback-agent", organizationId: "org-1" },
    });
    expect(route).toMatchObject({
      agentId: "linked-agent",
      organizationId: "org-2",
    });
  });

  test("without a planned Automation the connection's agent answers", async () => {
    const route = await resolveChatRoute({
      plan: { signal: threadStart, replyTargets: [], backgroundTargets: [] },
      platform: "slack",
      channelId: thread.channelId,
      connection: { agentId: "fallback-agent", organizationId: "org-1" },
    });
    expect(route).toMatchObject({
      agentId: "fallback-agent",
      source: "connection",
    });
  });
});
