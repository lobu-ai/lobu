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
