/**
 * LinkedIn adapter: which live rows it answers, the ids it mints, and the
 * `send_message` input it hands the connector. Synthetic ids throughout.
 */

import { describe, expect, test } from "bun:test";
import { NotImplementedError } from "chat";
import { type ConnectorChatOperationRequest, splitText } from "../connector-chat.js";
import { LinkedInAdapter } from "../linkedin-adapter.js";

const THREAD = "2-c3ludGhldGljLWRt==";

function harness() {
  const calls: ConnectorChatOperationRequest[] = [];
  const adapter = new LinkedInAdapter({
    connectionId: "101",
    userName: "bot",
    newIdempotencyKey: () => "fresh-key",
    execute: async (request) => {
      calls.push(request);
      return {
        status: "completed",
        output: { sent: true, message_id: "urn:li:msg_message:(urn:li:fsd_profile:ACoAASelf,sent-1)" },
      };
    },
  });
  return { adapter, calls };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "urn:li:msg_message:(urn:li:fsd_profile:ACoAASelf,in-1)",
    thread_id: THREAD,
    text: "hello",
    content_kind: "text",
    is_group: false,
    from_me: false,
    sender_member_id: "ACoAASyntheticPeer",
    sender_slug: "synthetic-peer",
    sender_name: "Synthetic Peer",
    occurred_at: "2026-10-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("LinkedIn adapter", () => {
  test("answers only a 1:1 text message from someone else", () => {
    const { adapter } = harness();
    const parsed = adapter.parseSourceRow(row());
    expect(parsed?.channelId).toBe(THREAD);
    expect(parsed?.message).toMatchObject({
      threadId: `linkedin:101:${THREAD}`,
      isMention: false,
      author: { userId: "ACoAASyntheticPeer", userName: "synthetic-peer", fullName: "Synthetic Peer", isMe: false },
    });
    for (const overrides of [
      { from_me: true },
      { from_me: null },
      { is_group: true },
      { is_group: null },
      { content_kind: "media" },
      { content_kind: "revoked", text: "" },
      { text: "   " },
      { sender_member_id: "urn:li:fsd_company:99" },
    ]) {
      const refused = adapter.parseSourceRow(row(overrides));
      expect(refused?.channelId).toBe(THREAD);
      expect(refused?.message).toBeNull();
    }
    expect(adapter.parseSourceRow(row({ thread_id: "a:b" }))).toBeNull();
    expect(adapter.parseSourceRow(row({ id: "" }))).toBeNull();
  });

  test("sends plain text with the operation's idempotency key and scopes the sent id", async () => {
    const { adapter, calls } = harness();
    const sent = await adapter.postMessage(
      `linkedin:101:${THREAD}`,
      { markdown: "**Yes** — see [the doc](https://example.test/doc)\n\n- one\n- two" },
      "chat-post:101:m1:hash",
    );
    expect(calls).toEqual([{
      operationKey: "send_message",
      input: {
        conversation_id: THREAD,
        text: expect.stringContaining("Yes — see the doc (https://example.test/doc)"),
        idempotency_key: "chat-post:101:m1:hash",
      },
      idempotencyKey: "chat-post:101:m1:hash",
    }]);
    expect(String(calls[0].input.text)).toContain("- one");
    expect(String(calls[0].input.text)).not.toContain("**");
    expect(sent).toMatchObject({
      id: "101:urn:li:msg_message:(urn:li:fsd_profile:ACoAASelf,sent-1)",
      threadId: `linkedin:101:${THREAD}`,
      raw: { thread_id: THREAD, from_me: true, is_group: false },
    });
  });

  test("refuses another connection's thread and never opens a new conversation", async () => {
    const { adapter, calls } = harness();
    await expect(adapter.postMessage(`linkedin:202:${THREAD}`, "hi")).rejects.toThrow("Invalid LinkedIn thread ID");
    await expect(adapter.openDM()).rejects.toBeInstanceOf(NotImplementedError);
    expect(calls).toHaveLength(0);
  });

  test("a reply over LinkedIn's 3000-character limit goes out as ordered parts with derived keys", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage(`linkedin:101:${THREAD}`, "a".repeat(3000), "reply-key");
    expect(calls.map((call) => call.idempotencyKey)).toEqual(["reply-key"]);

    calls.length = 0;
    const first = `${"a".repeat(2000)}\n\n${"b".repeat(998)}`;
    const second = "c".repeat(1500);
    await adapter.postMessage(`linkedin:101:${THREAD}`, `${first}\n\n${second}`, "reply-key");
    expect(calls.map((call) => [call.input.text, call.idempotencyKey, call.input.idempotency_key])).toEqual([
      [first, "reply-key", "reply-key"],
      [second, "reply-key:1", "reply-key:1"],
    ]);
    for (const call of calls) expect(String(call.input.text).length).toBeLessThanOrEqual(3000);
  });

  test("a redelivery after a partial send reuses every part's key", async () => {
    const calls: ConnectorChatOperationRequest[] = [];
    let failSecond = true;
    const adapter = new LinkedInAdapter({
      connectionId: "101",
      userName: "bot",
      newIdempotencyKey: () => "fresh-key",
      execute: async (request) => {
        calls.push(request);
        if (request.idempotencyKey.endsWith(":1") && failSecond) {
          failSecond = false;
          return { status: "timeout", error: "page did not confirm" };
        }
        return { status: "completed", output: { sent: true, message_id: `sent-${request.idempotencyKey}` } };
      },
    });
    const text = `${"a".repeat(2999)} ${"b".repeat(10)}`;
    await expect(adapter.postMessage(`linkedin:101:${THREAD}`, text, "reply-key")).rejects.toThrow("timeout");
    const sent = await adapter.postMessage(`linkedin:101:${THREAD}`, text, "reply-key");
    expect(calls.map((call) => call.idempotencyKey)).toEqual(["reply-key", "reply-key:1", "reply-key", "reply-key:1"]);
    expect(sent.id).toBe("101:sent-reply-key:1");
  });
});

describe("splitText", () => {
  test("breaks at the last paragraph, line or space break and hard-cuts only without one", () => {
    expect(splitText("short", 10)).toEqual(["short"]);
    expect(splitText("aaaa\n\nbbbb cc", 10)).toEqual(["aaaa", "bbbb cc"]);
    expect(splitText("aaaa\nbbbb cccc", 10)).toEqual(["aaaa", "bbbb cccc"]);
    expect(splitText("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"]);
    expect(splitText("abcdefghijklmnop", 10)).toEqual(["abcdefghij", "klmnop"]);
    // A surrogate pair straddling the hard cut stays whole.
    const parts = splitText(`${"a".repeat(9)}😀b`, 10);
    expect(parts).toEqual(["a".repeat(9), "😀b"]);
    expect(parts.join("")).toBe(`${"a".repeat(9)}😀b`);
  });
});
