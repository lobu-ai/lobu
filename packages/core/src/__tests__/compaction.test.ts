/**
 * Tests for compaction.ts — pi's compaction over messages.
 *
 * The fixtures are the shapes `replaySessionMessages` produces: pi's own
 * user/assistant/toolResult messages, with a previous compaction already
 * folded into a framed user message at index 0.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateMessageTokens,
  finishCompaction,
  planCompaction,
  previousCompactionSummary,
  serializeConversation,
  shouldCompact,
  summaryRequests,
} from "../compaction";
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type SessionMessage,
} from "../utils/session-file";

const user = (text: string): SessionMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 1,
});
const assistant = (
  text: string,
  extra: Record<string, unknown> = {}
): SessionMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: 1,
  ...extra,
});
const usage = (totalTokens: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
});

describe("token accounting", () => {
  test("estimates chars/4 per role and 1200 tokens per tool-result image", () => {
    expect(estimateMessageTokens(user("x".repeat(400)))).toBe(100);
    expect(
      estimateMessageTokens({
        role: "assistant",
        content: [
          { type: "text", text: "x".repeat(40) },
          {
            type: "toolCall",
            id: "t",
            name: "read",
            arguments: { path: "/a" },
          },
        ],
      })
    ).toBe(Math.ceil((40 + 4 + JSON.stringify({ path: "/a" }).length) / 4));
    expect(
      estimateMessageTokens({
        role: "toolResult",
        toolCallId: "t",
        content: [{ type: "image", data: "", mimeType: "image/png" }],
      })
    ).toBe(1200);
  });

  test("uses the last successful assistant usage plus an estimate of what follows", () => {
    const messages = [
      user("a"),
      assistant("b", { usage: usage(5000) }),
      user("x".repeat(400)),
      assistant("aborted", { stopReason: "aborted", usage: usage(999999) }),
    ];
    const estimate = estimateContextTokens(messages);
    expect(estimate.usageTokens).toBe(5000);
    expect(estimate.lastUsageIndex).toBe(1);
    // The 400-char user message and the aborted reply's text, never its usage.
    expect(estimate.trailingTokens).toBe(100 + Math.ceil("aborted".length / 4));
    expect(estimate.tokens).toBe(5000 + estimate.trailingTokens);
  });

  test("shouldCompact triggers past window minus reserve, and never when disabled", () => {
    expect(
      shouldCompact(200_000 - 16384, 200_000, DEFAULT_COMPACTION_SETTINGS)
    ).toBe(false);
    expect(
      shouldCompact(200_000 - 16383, 200_000, DEFAULT_COMPACTION_SETTINGS)
    ).toBe(true);
    expect(
      shouldCompact(1_000_000, 200_000, {
        ...DEFAULT_COMPACTION_SETTINGS,
        enabled: false,
      })
    ).toBe(false);
  });
});

describe("planCompaction", () => {
  const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 60 };

  test("keeps roughly keepRecentTokens of the newest messages and summarises the rest", () => {
    // Six 100-char messages ≈ 25 tokens each; 60 tokens back from the end
    // lands inside the fifth, so the cut is the nearest user/assistant at or
    // after it.
    const messages = [
      user("q1".padEnd(100, ".")),
      assistant("a1".padEnd(100, ".")),
      user("q2".padEnd(100, ".")),
      assistant("a2".padEnd(100, ".")),
      user("q3".padEnd(100, ".")),
      assistant("a3".padEnd(100, "."), { usage: usage(900) }),
    ];
    const plan = planCompaction(messages, settings);
    expect(plan).toBeDefined();
    expect(plan!.tokensBefore).toBe(900);
    expect(plan!.firstKeptIndex).toBe(3);
    // The cut is on an assistant message, so the turn it belongs to is split.
    expect(plan!.isSplitTurn).toBe(true);
    expect(plan!.messagesToSummarize).toHaveLength(2);
    expect(plan!.turnPrefixMessages).toHaveLength(1);
    expect(plan!.previousSummary).toBeUndefined();
  });

  test("never cuts at a tool result", () => {
    const messages = [
      user("q1".padEnd(100, ".")),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "/notes.md" },
          },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      } as SessionMessage,
      {
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "x".repeat(300) }],
      } as SessionMessage,
      assistant("done".padEnd(100, ".")),
    ];
    const plan = planCompaction(messages, {
      ...settings,
      keepRecentTokens: 30,
    })!;
    expect(messages[plan.firstKeptIndex]!.role).not.toBe("toolResult");
    // The file the summarised turn read is carried into the summary.
    expect(
      plan.fileOps.read.has("/notes.md") || plan.turnPrefixMessages.length > 0
    ).toBe(true);
  });

  test("a previous summary is updated, not restarted, and its file lists carried", () => {
    const previous = `${COMPACTION_SUMMARY_PREFIX}## Goal\nOld goal\n\n<read-files>\n/a.ts\n</read-files>${COMPACTION_SUMMARY_SUFFIX}`;
    const messages = [
      user(previous),
      user("q".padEnd(100, ".")),
      assistant("a".padEnd(100, ".")),
      user("q2".padEnd(100, ".")),
      assistant("a2".padEnd(100, ".")),
    ];
    expect(previousCompactionSummary(messages[0])).toContain("Old goal");
    // 30 tokens back from the end is the last exchange, so the cut lands on
    // the second user message and the first exchange is what gets summarised.
    const plan = planCompaction(messages, {
      ...settings,
      keepRecentTokens: 30,
    })!;
    expect(plan.firstKeptIndex).toBe(3);
    expect(plan.isSplitTurn).toBe(false);
    expect(plan.previousSummary).toContain("Old goal");
    // The framed summary itself is never re-summarised.
    expect(plan.messagesToSummarize[0]).toBe(messages[1]);
    expect(plan.fileOps.read.has("/a.ts")).toBe(true);
    const requests = summaryRequests(plan);
    expect(requests.history!.prompt).toContain("<previous-summary>");
    expect(requests.history!.prompt).toContain("NEW conversation messages");
    expect(requests.history!.maxTokens).toBe(80);
  });

  test("returns nothing for an empty conversation or a summary with nothing after it", () => {
    expect(planCompaction([], settings)).toBeUndefined();
    expect(
      planCompaction(
        [user(`${COMPACTION_SUMMARY_PREFIX}s${COMPACTION_SUMMARY_SUFFIX}`)],
        settings
      )
    ).toBeUndefined();
  });
});

describe("summaries", () => {
  test("serialises as labelled text with tool results truncated", () => {
    const text = serializeConversation([
      user("hello"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "hi" },
          {
            type: "toolCall",
            id: "t",
            name: "read",
            arguments: { path: "/a" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "t",
        content: [{ type: "text", text: "y".repeat(2500) }],
      },
    ]);
    expect(text).toContain("[User]: hello");
    expect(text).toContain("[Assistant thinking]: hm");
    expect(text).toContain("[Assistant]: hi");
    expect(text).toContain('[Assistant tool calls]: read(path="/a")');
    expect(text).toContain("[... 500 more characters truncated]");
  });

  test("finishCompaction merges a split turn as pi does and appends the file lists", () => {
    const plan = planCompaction(
      [
        user("q1".padEnd(100, ".")),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "t1",
              name: "edit",
              arguments: { path: "/b.ts" },
            },
          ],
          stopReason: "toolUse",
        } as SessionMessage,
        {
          role: "toolResult",
          toolCallId: "t1",
          content: [{ type: "text", text: "ok" }],
        } as SessionMessage,
        assistant("mid".padEnd(100, ".")),
        assistant("end".padEnd(100, ".")),
      ],
      { enabled: true, reserveTokens: 100, keepRecentTokens: 30 }
    )!;
    const result = finishCompaction(
      plan,
      "HISTORY",
      plan.isSplitTurn ? "PREFIX" : undefined
    );
    if (plan.isSplitTurn) {
      expect(result.summary).toContain(
        "HISTORY\n\n---\n\n**Turn Context (split turn):**\n\nPREFIX"
      );
    } else {
      expect(result.summary.startsWith("HISTORY")).toBe(true);
    }
    expect(result.summary).toContain(
      "<modified-files>\n/b.ts\n</modified-files>"
    );
    expect(result.firstKeptIndex).toBe(plan.firstKeptIndex);
  });
});
