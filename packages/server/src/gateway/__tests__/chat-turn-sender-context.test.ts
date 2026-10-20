import { describe, expect, test } from "bun:test";
import {
  chatAccessNotice,
  chatTurnAccessInstructions,
  chatTurnContext,
  chatTurnSenderContext,
  chatTurnUnlinkedSenderContext,
} from "../orchestration/chat-turn-actor.js";

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
    expect(chatTurnContext({ sender }, context, combined.length)).toBe(combined);
    expect(chatTurnContext({ sender }, context, combined.length - 1)).toBe(context);
    expect(chatTurnContext({ sender }, undefined, 1)).toBeUndefined();
    expect(chatTurnContext({}, context, 2_048)).toBe(context);
    expect(chatTurnContext({}, undefined, 2_048)).toBeUndefined();
  });

  test("names an unlinked sender by their unverified platform profile name", () => {
    const name = `Synthetic "Visitor"\n${"x".repeat(100)}`;
    expect(chatTurnUnlinkedSenderContext(name)).toBe(
      `This message is from ${JSON.stringify(name.slice(0, 100))} (the name on their chat profile, not verified), who is not a linked member of this workspace.`,
    );
    const context = chatTurnContext({ unlinkedSenderName: "Synthetic Visitor" }, "preamble", 2_048);
    expect(context).toBe(`preamble\n\n${chatTurnUnlinkedSenderContext("Synthetic Visitor")}`);
  });

  test("a linked sender wins over an unlinked name, and a blank name adds nothing", () => {
    const sender = { name: "Synthetic Sender", role: "member" };
    expect(chatTurnContext({ sender, unlinkedSenderName: "Other" }, undefined, 2_048)).toBe(chatTurnSenderContext(sender));
    expect(chatTurnContext({ unlinkedSenderName: "  " }, undefined, 2_048)).toBeUndefined();
  });
});

describe("unlinked sender access", () => {
  test.each(["public_visitor", "reply_only"] as const)(
    "the %s prompt leaves linking and joining to the platform notice",
    (access) => {
      const text = chatTurnAccessInstructions(access);
      expect(text).toContain("do not give linking or joining instructions");
      expect(text).not.toMatch(/tell them/i);
    },
  );

  test("the notice carries one URL: the link when there is one, else the public page", () => {
    const link = "https://lobu.test/connect/chat-identity?token=t";
    const join = "https://lobu.test/acme";
    expect(chatAccessNotice("public_visitor", join, link)).toBe(
      `I can only use this workspace's public knowledge for you. Connect your Lobu account to do more: ${link}`,
    );
    expect(chatAccessNotice("public_visitor", join, null)).toBe(
      `I can only use this workspace's public knowledge for you. Join the workspace to do more: ${join}`,
    );
    expect(chatAccessNotice("public_visitor", null, null)).toBe(
      "I can only use this workspace's public knowledge for you.",
    );
    expect(chatAccessNotice("reply_only", null, link)).toBe(
      `I can't use this workspace's tools for you yet. If you're a member, connect your Lobu account: ${link}`,
    );
    expect(chatAccessNotice("reply_only", null, null)).toBe(
      "I can't use this workspace's tools for you yet. Ask an admin of this workspace to invite you.",
    );
  });
});
