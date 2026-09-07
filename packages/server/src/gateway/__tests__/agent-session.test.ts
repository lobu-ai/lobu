import { describe, expect, test } from 'bun:test';
import { parseSessionEntries, type SessionEntry } from '@lobu/core';
import { replayAgentSession } from '../orchestration/agent-session';

const replay = (entries: SessionEntry[]) => replayAgentSession(entries).replayed.map((entry) => entry.message);

const at = "2026-09-07T00:00:00.000Z";
const msg = (
  id: string,
  parentId: string | null,
  message: Record<string, unknown>
) => ({ type: "message", id, parentId, timestamp: at, message });
const text = (m: Record<string, unknown>) =>
  (m.content as Array<{ text: string }>)[0]?.text;

describe("replay", () => {
  test("compaction preserves source ids for repeated generated messages and hidden bash", () => {
    const entries = parseSessionEntries([
      msg('root', null, { role: 'user', content: 'start' }),
      { type: 'custom_message', id: 'discarded', parentId: 'root', timestamp: at,
        customType: 'notice', content: 'same notice', display: false },
      { type: 'custom_message', id: 'kept', parentId: 'discarded', timestamp: at,
        customType: 'notice', content: 'same notice', display: false },
      { type: 'branch_summary', id: 'branch-summary', parentId: 'kept', timestamp: at,
        fromId: 'other-branch', summary: 'A branch summary.' },
      msg('hidden-bash', 'branch-summary', { role: 'bashExecution', command: 'private', output: 'secret', excludeFromContext: true }),
      { type: 'compaction', id: 'compact', parentId: 'hidden-bash', timestamp: at,
        summary: 'Earlier context.', firstKeptEntryId: 'kept', tokensBefore: 100 },
      { type: 'custom_message', id: 'latest', parentId: 'compact', timestamp: at,
        customType: 'notice', content: 'same notice', display: false },
    ].map((entry) => JSON.stringify(entry)).join('\n')).entries;
    const { replayed } = replayAgentSession(entries);
    expect(replayed.map((entry) => entry.entryId)).toEqual(['compact', 'kept', 'branch-summary', 'latest']);
    expect(replayed.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'user']);
    expect(JSON.stringify(replayed)).not.toContain('secret');
    expect(JSON.stringify(replayed[2]?.message.content)).toContain('A branch summary.');
  });

  test("a new root does not replay the previous branch", () => {
    const entries = parseSessionEntries([
      JSON.stringify(msg("old-root", null, { role: "user", content: "old conversation" })),
      JSON.stringify(msg("new-root", null, { role: "user", content: "new conversation" })),
    ].join("\n")).entries;
    expect(replay(entries).map((m) => m.content)).toEqual(["new conversation"]);
  });

  test("a missing parent does not attach an unrelated earlier branch", () => {
    const entries = parseSessionEntries([
      JSON.stringify(msg("unrelated", null, { role: "user", content: "other branch" })),
      JSON.stringify(msg("continuation", "missing", { role: "user", content: "continued turn" })),
    ].join("\n")).entries;
    expect(replay(entries).map((m) => m.content)).toEqual(["continued turn"]);
  });

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
    const out = replay(entries);
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
    const out = replay(entries);
    expect(out.map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(text(out[0]!)).toBe(
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\nThey discussed an old question.\n</summary>"
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
    const out = replay(entries);
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

  test("an empty file replays nothing; a continuation follows its known parents", () => {
    expect(replay([])).toEqual([]);
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
    expect(replay(entries).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  test("null parents represent independent roots", () => {
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
    expect(replay(entries).map((m) => m.role)).toEqual(["user"]);
    expect(replay(entries)[0]?.content).toBe("three");
  });
});
