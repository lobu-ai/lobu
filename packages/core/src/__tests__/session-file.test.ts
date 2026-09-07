/**
 * Tests for utils/session-file.ts.
 *
 * Focus: projecting pi's `bashExecution` (`!command`) records so a `!`-bash
 * turn survives a page reload. pi writes each message wrapped as
 * `{type:"message", message:{...}}` with the bash fields living directly on
 * `message` (not in `message.content`). The parser must keep those fields and
 * project them onto a `bashExecution` ParsedMessage.
 */

import { describe, expect, test } from "bun:test";
import type { BashExecutionContent } from "../utils/session-file";
import { entryToMessage, parseSessionEntries } from "../utils/session-file";

// A session.jsonl blob mixing a normal user turn, an assistant turn, and three
// bashExecution records (exit 0, non-zero+cancelled, and a `!!` excluded one).
const FIXTURE = [
  JSON.stringify({ type: "session", id: "sess-1" }),
  JSON.stringify({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-07-15T02:00:00.000Z",
    message: { role: "user", content: "hi" },
  }),
  JSON.stringify({
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-07-15T02:00:01.000Z",
    message: { role: "assistant", content: "hello" },
  }),
  JSON.stringify({
    type: "message",
    id: "b1",
    parentId: "a1",
    timestamp: "2026-07-15T02:00:02.000Z",
    message: {
      role: "bashExecution",
      command: "ls /workspace",
      output: "file1\nfile2\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      fullOutputPath: "/tmp/x",
      timestamp: 1752547200000,
      excludeFromContext: false,
    },
  }),
  JSON.stringify({
    type: "message",
    id: "b2",
    parentId: "b1",
    timestamp: "2026-07-15T02:00:03.000Z",
    message: {
      role: "bashExecution",
      command: "sleep 100",
      output: "partial",
      exitCode: 130,
      cancelled: true,
      truncated: true,
      timestamp: 1752547201000,
    },
  }),
  JSON.stringify({
    type: "message",
    id: "b3",
    parentId: "b2",
    timestamp: "2026-07-15T02:00:04.000Z",
    message: {
      role: "bashExecution",
      command: "echo secret",
      output: "secret\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1752547202000,
      excludeFromContext: true,
    },
  }),
].join("\n");

describe("parseSessionEntries + entryToMessage — bashExecution projection", () => {
  const { entries, sessionId } = parseSessionEntries(FIXTURE);
  const messages = entries
    .map(entryToMessage)
    .filter((m): m is NonNullable<typeof m> => m !== null);

  test("extracts the leading session id", () => {
    expect(sessionId).toBe("sess-1");
  });

  test("normal user/assistant messages still project unchanged", () => {
    const user = messages.find((m) => m.id === "u1");
    const assistant = messages.find((m) => m.id === "a1");
    expect(user).toMatchObject({
      type: "message",
      role: "user",
      content: "hi",
    });
    expect(assistant).toMatchObject({
      type: "message",
      role: "assistant",
      content: "hello",
    });
  });

  test("exit-0 bashExecution projects all fields with correct type", () => {
    const b1 = messages.find((m) => m.id === "b1");
    expect(b1?.type).toBe("bashExecution");
    expect(b1?.role).toBe("bashExecution");
    // Outer ISO timestamp is preserved, not the inner numeric one.
    expect(b1?.timestamp).toBe("2026-07-15T02:00:02.000Z");
    const content = b1?.content as BashExecutionContent;
    expect(content).toEqual({
      command: "ls /workspace",
      output: "file1\nfile2\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      fullOutputPath: "/tmp/x",
    });
  });

  test("non-zero exit + cancelled bashExecution keeps exitCode/cancelled/truncated", () => {
    const b2 = messages.find((m) => m.id === "b2");
    expect(b2?.type).toBe("bashExecution");
    const content = b2?.content as BashExecutionContent;
    expect(content.exitCode).toBe(130);
    expect(content.cancelled).toBe(true);
    expect(content.truncated).toBe(true);
  });

  test("`!!` (excludeFromContext:true) record is still returned (visible), not verbose", () => {
    const b3 = messages.find((m) => m.id === "b3");
    expect(b3).toBeDefined();
    expect(b3?.isVerbose).toBe(false);
    const content = b3?.content as BashExecutionContent;
    expect(content.excludeFromContext).toBe(true);
  });

  test("all three bashExecution records survive projection (none dropped)", () => {
    const bash = messages.filter((m) => m.type === "bashExecution");
    expect(bash.map((m) => m.id)).toEqual(["b1", "b2", "b3"]);
  });
});

// ---------------------------------------------------------------------------
// replaySessionMessages — pi's buildSessionContext + convertToLlm, replayed
// from the stored entries alone so the isolate lane resumes from the same
// file the subprocess lane wrote.
// ---------------------------------------------------------------------------

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  replaySessionMessages,
} from "../utils/session-file";

const at = "2026-09-07T00:00:00.000Z";
const msg = (
  id: string,
  parentId: string | null,
  message: Record<string, unknown>
) => ({ type: "message", id, parentId, timestamp: at, message });
const text = (m: Record<string, unknown>) =>
  (m.content as Array<{ text: string }>)[0]?.text;

describe("replaySessionMessages", () => {
  test("replays the parent chain from the last entry, not every stored line", () => {
    // `dead` is a branch pi navigated away from: nothing points at it from
    // the leaf, so the model never sees it.
    const entries = parseSessionEntries(
      [
        JSON.stringify(msg("u1", null, { role: "user", content: "hi" })),
        JSON.stringify(
          msg("dead", "u1", {
            role: "assistant",
            content: [{ type: "text", text: "abandoned" }],
          })
        ),
        JSON.stringify(
          msg("a1", "u1", {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          })
        ),
        JSON.stringify(msg("u2", "a1", { role: "user", content: "more" })),
      ].join("\n")
    ).entries;
    const out = replaySessionMessages(entries);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(
      out.map((m) => (typeof m.content === "string" ? m.content : text(m)))
    ).toEqual(["hi", "hello", "more"]);
  });

  test("a compaction replaces the head with pi's summary framing and keeps from firstKeptEntryId", () => {
    const entries = parseSessionEntries(
      [
        JSON.stringify(
          msg("u1", null, { role: "user", content: "old question" })
        ),
        JSON.stringify(
          msg("a1", "u1", {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
          })
        ),
        JSON.stringify(
          msg("u2", "a1", { role: "user", content: "kept question" })
        ),
        JSON.stringify(
          msg("a2", "u2", {
            role: "assistant",
            content: [{ type: "text", text: "kept answer" }],
          })
        ),
        JSON.stringify({
          type: "compaction",
          id: "c1",
          parentId: "a2",
          timestamp: at,
          summary: "They discussed an old question.",
          firstKeptEntryId: "u2",
          tokensBefore: 120000,
        }),
        JSON.stringify(
          msg("u3", "c1", { role: "user", content: "after compaction" })
        ),
      ].join("\n")
    ).entries;
    const out = replaySessionMessages(entries);
    expect(out.map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(text(out[0]!)).toBe(
      `${COMPACTION_SUMMARY_PREFIX}They discussed an old question.${COMPACTION_SUMMARY_SUFFIX}`
    );
    expect(out[1]!.content).toBe("kept question");
    expect(out[3]!.content).toBe("after compaction");
    // The compacted-away turn is gone from the model's view.
    expect(JSON.stringify(out)).not.toContain("old answer");
  });

  test("tool calls and results replay as stored; !-bash records read as pi renders them", () => {
    const entries = parseSessionEntries(
      [
        JSON.stringify(msg("u1", null, { role: "user", content: "count" })),
        JSON.stringify(
          msg("a1", "u1", {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "toolu_1",
                name: "query_sdk",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            usage: { input: 1, output: 1 },
          })
        ),
        JSON.stringify(
          msg("t1", "a1", {
            role: "toolResult",
            toolCallId: "toolu_1",
            toolName: "query_sdk",
            content: [{ type: "text", text: "3" }],
            isError: false,
          })
        ),
        JSON.stringify(
          msg("b1", "t1", {
            role: "bashExecution",
            command: "ls",
            output: "a.txt",
            exitCode: 0,
          })
        ),
        JSON.stringify(
          msg("b2", "b1", {
            role: "bashExecution",
            command: "secret",
            output: "x",
            excludeFromContext: true,
          })
        ),
        JSON.stringify({
          type: "model_change",
          id: "m1",
          parentId: "b2",
          timestamp: at,
          provider: "openai",
          modelId: "gpt-5",
        }),
        JSON.stringify(msg("u2", "m1", { role: "user", content: "thanks" })),
      ].join("\n")
    ).entries;
    const out = replaySessionMessages(entries);
    expect(out.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(out[1]).toMatchObject({
      stopReason: "toolUse",
      usage: { input: 1, output: 1 },
    });
    expect(out[2]).toMatchObject({ toolCallId: "toolu_1", isError: false });
    expect(text(out[3]!)).toBe("Ran `ls`\n```\na.txt\n```");
    // `!!` output is excluded from the model's context; a model_change is not a message.
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  test("an empty file replays nothing; a missing parent continues in file order", () => {
    expect(replaySessionMessages([])).toEqual([]);
    const entries = parseSessionEntries(
      [
        JSON.stringify(
          msg("u1", "missing-parent", { role: "user", content: "continuation" })
        ),
        JSON.stringify(
          msg("a1", "u1", {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          })
        ),
      ].join("\n")
    ).entries;
    expect(replaySessionMessages(entries).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("a flat file whose entries all carry a null parent replays in file order", () => {
    // Lobu's earlier snapshot writers never chained entries; pi would show only
    // the last one, which is not the conversation those files hold.
    const entries = parseSessionEntries(
      [
        JSON.stringify(msg("u1", null, { role: "user", content: "one" })),
        JSON.stringify(
          msg("a1", null, {
            role: "assistant",
            content: [{ type: "text", text: "two" }],
          })
        ),
        JSON.stringify(msg("u2", null, { role: "user", content: "three" })),
      ].join("\n")
    ).entries;
    expect(replaySessionMessages(entries).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});
