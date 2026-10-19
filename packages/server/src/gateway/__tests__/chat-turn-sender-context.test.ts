import { describe, expect, test } from "bun:test";
import { chatTurnContext, chatTurnSenderContext } from "../orchestration/chat-turn-actor.js";

describe("chat turn sender context", () => {
  test.each([
    ["owner", "an owner"],
    ["admin", "an admin"],
    ["member", "a member"],
    ["custom", "a member"],
    ["constructor", "a member"],
    ["toString", "a member"],
    ["__proto__", "a member"],
  ])("describes the %s role", (role, description) => {
    expect(chatTurnSenderContext({ name: "Synthetic Sender", role })).toBe(
      `This message is from "Synthetic Sender", ${description} of this workspace, verified through their linked chat account.`,
    );
  });

  test("preserves the role when the sender has no display name", () => {
    expect(chatTurnSenderContext({ role: "admin" })).toBe(
      "This message is from a person, an admin of this workspace, verified through their linked chat account.",
    );
  });

  test("quotes and bounds user-authored names", () => {
    const name = `Synthetic "Sender"\n${"x".repeat(100)}`;
    expect(chatTurnSenderContext({ name, role: "member" })).toBe(
      `This message is from ${JSON.stringify(name.slice(0, 100))}, a member of this workspace, verified through their linked chat account.`,
    );
  });

  test("adds the sender only when the complete line fits after the preamble", () => {
    const sender = { name: "Synthetic Sender", role: "owner" };
    const context = "Follow these Automation instructions for this turn: reply";
    const combined = `${context}\n\n${chatTurnSenderContext(sender)}`;
    expect(chatTurnContext(sender, context, combined.length)).toBe(combined);
    expect(chatTurnContext(sender, context, combined.length - 1)).toBe(context);
    expect(chatTurnContext(sender, undefined, 1)).toBeUndefined();
    expect(chatTurnContext(undefined, context, 2_048)).toBe(context);
    expect(chatTurnContext(undefined, undefined, 2_048)).toBeUndefined();
  });
});
