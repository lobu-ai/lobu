import { describe, expect, test } from "bun:test";
import { createConversationTools } from "../index";

const TOOLS = [
  "list_conversations",
  "read_conversation",
  "send_message",
  "present_event",
  "schedule_followup",
  "react",
  "edit_message",
  "delete_message",
  "ask_user",
];

const params = {
  gatewayUrl: "http://gateway",
  workerToken: "token",
  channelId: "channel",
  conversationId: "conversation",
  onAskUserPosted: () => undefined,
};

describe("conversation plugin", () => {
  test("owns the complete conversation and interaction tool set", () => {
    const tools = createConversationTools({ ...params, platform: "api" });
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS);
  });

  test("offers no model-callable suggestion tool on any platform", () => {
    // Follow-up chips are asked of the model after it answers (the agent-turn
    // guest), so the model is never handed a tool it would have to choose.
    for (const platform of ["api", "slack", "telegram", undefined]) {
      const tools = createConversationTools({ ...params, platform });
      expect(tools.map((tool) => tool.name)).toEqual(TOOLS);
    }
  });
});
