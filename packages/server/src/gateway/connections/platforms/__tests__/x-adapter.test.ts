/**
 * X DM adapter: which live rows it answers, the send it issues and the plain
 * text it renders. Synthetic ids throughout.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import type { ConnectorChatOperationRequest } from "../connector-chat.js";
import { XAdapter, type XMessageRow } from "../x-adapter.js";

const DM = "1000000001-1000000002";
const GROUP = "1000000009";

test("x-adapter imports in a fresh process", () => {
  const moduleUrl = new URL("../x-adapter.ts", import.meta.url);
  const result = spawnSync(process.execPath, [
    "--eval", `import ${JSON.stringify(moduleUrl.href)};`,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 20_000);

function harness() {
  const calls: ConnectorChatOperationRequest[] = [];
  const adapter = new XAdapter({
    connectionId: "101",
    userName: "bot",
    newIdempotencyKey: () => "fresh-key",
    execute: async (request) => {
      calls.push(request);
      return { status: "completed", output: { sent: true, message_id: "9001", id: `${DM}:9001` } };
    },
  });
  return { adapter, calls };
}

function row(overrides: Partial<XMessageRow> = {}): Record<string, unknown> {
  return {
    id: `${DM}:5001`,
    message_id: "5001",
    conversation_id: DM,
    sender_id: "1000000002",
    sender_handle: "synthetic_peer",
    sender_name: "Synthetic Peer",
    from_me: false,
    is_group: false,
    is_request: false,
    text: "hello",
    content_kind: "text",
    occurred_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("XAdapter source rows", () => {
  test("answers an inbound text DM in its conversation thread", () => {
    const { adapter } = harness();
    const parsed = adapter.parseSourceRow(row());
    expect(parsed?.channelId).toBe(DM);
    const message = parsed?.message;
    expect(message?.threadId).toBe(`x:101:${DM}`);
    expect(message?.id).toBe(`101:${DM}:5001`);
    expect(message?.author).toMatchObject({ userId: "1000000002", userName: "synthetic_peer", fullName: "Synthetic Peer", isMe: false });
    expect(message?.isMention).toBe(false);
    expect(adapter.isDM(message!.threadId)).toBe(true);
  });

  test("answers a message request", () => {
    const { adapter } = harness();
    expect(adapter.parseSourceRow(row({ is_request: true }))?.message).not.toBeNull();
  });

  test.each([
    ["the account's own message", { from_me: true }],
    ["a media-only message", { text: "", content_kind: "media" }],
    ["a row without a sender", { sender_id: null }],
  ])("refuses %s but keeps its channel", (_, overrides) => {
    const { adapter } = harness();
    expect(adapter.parseSourceRow(row(overrides as Partial<XMessageRow>))).toEqual({ message: null, channelId: DM });
  });

  test("refuses a row that names no conversation", () => {
    const { adapter } = harness();
    expect(adapter.parseSourceRow(row({ conversation_id: "" }))).toBeNull();
    expect(adapter.parseSourceRow(row({ conversation_id: "a:b" }))).toBeNull();
  });

  test("a group conversation is not a DM", () => {
    const { adapter } = harness();
    const message = adapter.parseSourceRow(row({ id: `${GROUP}:5002`, conversation_id: GROUP, is_group: true }))?.message;
    expect(adapter.isDM(message!.threadId)).toBe(false);
  });
});

describe("XAdapter sends", () => {
  test("sends one plain-text send_message keyed on the operation", async () => {
    const { adapter, calls } = harness();
    const sent = await adapter.postMessage(
      `x:101:${DM}`,
      { markdown: "**Hi** see [the docs](https://example.com/docs)\n\n- one\n- two" },
      "op-key-1",
    );
    expect(calls).toEqual([{
      operationKey: "send_message",
      input: {
        conversation_id: DM,
        text: "Hi see the docs (https://example.com/docs)\n\n- one\n- two",
        idempotency_key: "op-key-1",
      },
      idempotencyKey: "op-key-1",
    }]);
    const observed = adapter.parseMessage(row({ id: `${DM}:9001`, message_id: "9001", from_me: true }) as unknown as XMessageRow);
    expect(sent).toMatchObject({ id: observed.id, threadId: observed.threadId, raw: { from_me: true, conversation_id: DM } });
  });

  test("a bare link renders as its URL", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage(`x:101:${DM}`, { markdown: "<https://example.com>" }, "op-key-2");
    expect(calls[0].input.text).toBe("https://example.com");
  });

  test("refuses another connection's thread", async () => {
    const { adapter, calls } = harness();
    await expect(adapter.postMessage(`x:202:${DM}`, "hi", "op-key-3")).rejects.toThrow("Invalid X thread ID");
    expect(calls).toHaveLength(0);
  });
});
