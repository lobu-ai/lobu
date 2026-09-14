/**
 * `formatChatLink` picks a hyperlink spelling per platform. The notice suite
 * covers it end to end; these pin the function's own branches, including the
 * one no chat platform can currently reach.
 */
import { describe, expect, test } from "bun:test";
import { formatChatLink } from "../commands/command-spelling.js";

describe("formatChatLink", () => {
  // Slack mrkdwn and Google Chat `Message.text` share the `<url|label>`
  // spelling, but not the escape: Slack decodes HTML entities, Chat does not.
  test.each([
    ["slack", "<https://x.test|A&amp;B &lt;Co&gt;>"],
    ["gchat", "<https://x.test|A&B Co>"],
  ])("labels the link on %s", (platform, expected) => {
    expect(formatChatLink(platform, "https://x.test", "A&B <Co>")).toBe(
      expected,
    );
  });

  test.each(["telegram", "discord", "teams", "whatsapp"])(
    "falls back to a bare labelled URL on %s",
    (platform) => {
      expect(formatChatLink(platform, "https://x.test", "Planner")).toBe(
        "Planner — https://x.test",
      );
    },
  );

  // The escape table is a Map. As an object literal these keys would resolve a
  // prototype member and then be called as the escape function.
  test.each(["constructor", "toString", "__proto__"])(
    "treats %s as an ordinary unknown platform",
    (platform) => {
      expect(formatChatLink(platform, "https://x.test", "Planner")).toBe(
        "Planner — https://x.test",
      );
    },
  );
});
