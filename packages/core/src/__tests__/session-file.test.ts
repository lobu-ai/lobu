/**
 * Tests for utils/session-file.ts.
 *
 * Focus: parsing pi's session.jsonl and projecting its entries onto the
 * `ParsedMessage` display shape. pi writes each message wrapped as
 * `{type:"message", message:{...}}`, with the leading `session` entry
 * carrying the session id.
 */

import { describe, expect, test } from "bun:test";
import { entryToMessage, parseSessionEntries } from "../utils/session-file";

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
].join("\n");

describe("parseSessionEntries + entryToMessage", () => {
  const { entries, sessionId } = parseSessionEntries(FIXTURE);
  const messages = entries
    .map(entryToMessage)
    .filter((m): m is NonNullable<typeof m> => m !== null);

  test("extracts the leading session id", () => {
    expect(sessionId).toBe("sess-1");
  });

  test("normal user/assistant messages project unchanged", () => {
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
});
