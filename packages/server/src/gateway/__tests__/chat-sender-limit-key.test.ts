import { describe, expect, test } from "bun:test";
import { chatSenderLimitKey } from "../orchestration/chat-turn-actor.js";

describe("chatSenderLimitKey", () => {
  test("separates senders who share a workspace-local id across two workspaces", () => {
    const base = { organizationId: "org-synthetic", platform: "slack", senderId: "U0SHARED" };
    for (const counter of ["turns", "notice"] as const) {
      expect(chatSenderLimitKey(counter, { ...base, teamId: "T0TEAMA" })).not.toBe(
        chatSenderLimitKey(counter, { ...base, teamId: "T0TEAMB" }),
      );
    }
  });

  test("keeps the turn budget and the notice window apart", () => {
    const sender = { organizationId: "org-synthetic", platform: "gchat", teamId: undefined, senderId: "users/1" };
    expect(chatSenderLimitKey("turns", sender)).not.toBe(chatSenderLimitKey("notice", sender));
  });

  test("cannot be forged by delimiter characters inside an id", () => {
    expect(
      chatSenderLimitKey("turns", { organizationId: "a:b", platform: "slack", teamId: undefined, senderId: "c" }),
    ).not.toBe(chatSenderLimitKey("turns", { organizationId: "a", platform: "b:slack", teamId: undefined, senderId: "c" }));
  });
});
