/**
 * WhatsApp Web adapter: the Chat SDK verbs it translates into connector
 * operations, and the ids it mints. Synthetic ids throughout.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import { Chat, NotImplementedError } from "chat";
import * as operations from "../../../../tools/admin/manage_operations/handlers/execute.js";
import { ChatInstanceManager } from "../../chat-instance-manager.js";
import { ChatResponseBridge } from "../../chat-response-bridge.js";
import { connectionOperationsExecutor, whatsappWebPlatform } from "../whatsapp-web.js";
import {
  WhatsAppWebAdapter,
  type WhatsAppWebMessageRow,
  type WhatsAppWebOperationOutcome,
  type WhatsAppWebOperationRequest,
} from "../whatsapp-web-adapter.js";

const DM_JID = "15550000001@s.whatsapp.net";
const LID_JID = "90000000000001@lid";
const GROUP_JID = "120363000000000001@g.us";

function harness(
  outcomes: Array<WhatsAppWebOperationOutcome | Error> = [
    { status: "completed", output: { sent: true, message_id: "RAWOUT1" } },
  ],
  connectionId = "101",
) {
  const calls: WhatsAppWebOperationRequest[] = [];
  const adapter = new WhatsAppWebAdapter({
    connectionId,
    userName: "bot",
    // Unique across harnesses, like production, so replicas never share one.
    newIdempotencyKey: () => `fresh-${randomUUID()}`,
    execute: async (request) => {
      calls.push(request);
      const next = outcomes.shift();
      if (!next) throw new Error("unexpected extra operation");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { adapter, calls };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

function row(overrides: Partial<WhatsAppWebMessageRow> = {}): WhatsAppWebMessageRow {
  return {
    id: "RAWIN1",
    chat_jid: DM_JID,
    text: "hello",
    occurred_at: "2026-01-01T00:00:00.000Z",
    from_me: false,
    sender_jid: DM_JID,
    push_name: "Sam",
    is_group: false,
    ...overrides,
  };
}

describe("WhatsApp Web adapter outbound", () => {
  test("a post is exactly one send_message to the thread's chat", async () => {
    const { adapter, calls } = harness();
    const sent = await adapter.postMessage(`whatsapp.web:101:${DM_JID}`, {
      markdown: "Hi **there**",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      operationKey: "send_message",
      input: { chat_jid: DM_JID, text: "Hi *there*" },
      idempotencyKey: expect.stringMatching(/^fresh-/),
    });
    expect(sent.id).toBe("101:RAWOUT1");
    expect(sent.threadId).toBe(`whatsapp.web:101:${DM_JID}`);
  });

  test("markdown uses WhatsApp emphasis markers without rewriting code", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage(`whatsapp.web:101:${DM_JID}`, {
      markdown: "**bold** *italic* ~~gone~~ `**literal**`",
    });
    expect(calls[0]?.input.text).toBe("*bold* _italic_ ~gone~ `**literal**`");
  });

  test("headings, rules and tables render as WhatsApp text", async () => {
    const { adapter, calls } = harness();
    await adapter.postMessage(`whatsapp.web:101:${DM_JID}`, {
      markdown: "# Title\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    });
    const text = String(calls[0]?.input.text);
    expect(text.startsWith("*Title*\n\n━━━\n\n```\n")).toBe(true);
    expect(text).toContain("a");
    expect(text).not.toContain("|---");
  });

  test("the reply stays on the addressed thread when the device answers with a LID", async () => {
    const { adapter } = harness([
      { status: "completed", output: { sent: true, chat_jid: LID_JID, message_id: "RAWOUT2" } },
    ]);
    const sent = await adapter.postMessage(`whatsapp.web:101:${DM_JID}`, "ok");
    expect(sent.threadId).toBe(`whatsapp.web:101:${DM_JID}`);
  });

  test("a stream is buffered and sent once with the final text", async () => {
    const { adapter, calls } = harness();
    async function* chunks() {
      yield "Hel";
      yield { type: "markdown_text" as const, text: "lo " };
      yield "world";
    }
    const sent = await adapter.stream(`whatsapp.web:101:${GROUP_JID}`, chunks());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ chat_jid: GROUP_JID, text: "Hello world" });
    expect(sent?.id).toBe("101:RAWOUT1");
  });

  test("an empty stream sends nothing", async () => {
    const { adapter, calls } = harness([]);
    async function* empty() {
      yield "  ";
    }
    expect(await adapter.stream(`whatsapp.web:101:${DM_JID}`, empty())).toBeNull();
    expect(calls).toHaveLength(0);
  });

  for (const outcome of [
    { status: "failed", error: "page said no" },
    { status: "timeout", error: "device did not answer" },
    { status: "pending_approval", error: "awaiting review" },
  ] as const) {
    test(`a ${outcome.status} send throws and is never retried`, async () => {
      const { adapter, calls } = harness([outcome]);
      await expect(
        adapter.postMessage(`whatsapp.web:101:${DM_JID}`, "hi"),
      ).rejects.toThrow(`send_message ${outcome.status}`);
      expect(calls).toHaveLength(1);
    });
  }

  test("an executor error (ambiguous: the page may have sent) is not retried", async () => {
    const { adapter, calls } = harness([new Error("connection reset")]);
    await expect(
      adapter.postMessage(`whatsapp.web:101:${DM_JID}`, "hi"),
    ).rejects.toThrow("connection reset");
    expect(calls).toHaveLength(1);
  });

  test("a completed send without a message id is an error, not a retry", async () => {
    const { adapter, calls } = harness([{ status: "completed", output: { sent: true } }]);
    await expect(
      adapter.postMessage(`whatsapp.web:101:${DM_JID}`, "hi"),
    ).rejects.toThrow("without a message id");
    expect(calls).toHaveLength(1);
  });

  test("unsupported verbs throw NotImplementedError and run no operation", async () => {
    const { adapter, calls } = harness([]);
    const thread = `whatsapp.web:101:${DM_JID}`;
    await expect(adapter.editMessage()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.deleteMessage()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.addReaction()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.removeReaction()).rejects.toBeInstanceOf(NotImplementedError);
    await adapter.startTyping();
    expect((await adapter.fetchMessages()).messages).toEqual([]);
    expect((await adapter.fetchThread(thread)).isDM).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an invalid thread id is refused before any operation", async () => {
    const { adapter, calls } = harness([]);
    await expect(adapter.postMessage("slack:C1", "hi")).rejects.toThrow("Invalid");
    await expect(adapter.postMessage("whatsapp.web:", "hi")).rejects.toThrow("Invalid");
    expect(calls).toHaveLength(0);
  });
});

describe("WhatsApp Web threads", () => {
  test("a 1:1 chat is a DM and a group is not", () => {
    const { adapter } = harness([]);
    expect(adapter.isDM(`whatsapp.web:101:${DM_JID}`)).toBe(true);
    expect(adapter.isDM(`whatsapp.web:101:${LID_JID}`)).toBe(true);
    expect(adapter.isDM("whatsapp.web:101:15550000001@c.us")).toBe(true);
    expect(adapter.isDM(`whatsapp.web:101:${GROUP_JID}`)).toBe(false);
    expect(adapter.isDM("whatsapp.web:101:status@broadcast")).toBe(false);
  });

  test("a thread of another connection is refused before any operation", async () => {
    const { adapter, calls } = harness();
    expect(() => adapter.isDM(`whatsapp.web:202:${DM_JID}`)).toThrow("Invalid WhatsApp Web thread ID");
    await expect(adapter.postMessage(`whatsapp.web:202:${DM_JID}`, "hi")).rejects.toThrow(
      "Invalid WhatsApp Web thread ID",
    );
    expect(calls).toHaveLength(0);
  });

  test("parsed messages land on their chat's thread with the sender as author", () => {
    const { adapter } = harness([]);
    const dm = adapter.parseMessage(row());
    expect(dm.threadId).toBe(`whatsapp.web:101:${DM_JID}`);
    expect(dm.author.userId).toBe(DM_JID);
    expect(dm.author.isMe).toBe(false);

    const group = adapter.parseMessage(
      row({ chat_jid: GROUP_JID, sender_jid: LID_JID, is_group: true }),
    );
    expect(group.threadId).toBe(`whatsapp.web:101:${GROUP_JID}`);
    expect(group.author.userId).toBe(LID_JID);

    expect(adapter.parseMessage(row({ from_me: true })).author.isMe).toBe(true);
  });

  test("openDM only addresses a person", async () => {
    const { adapter } = harness([]);
    expect(await adapter.openDM(LID_JID)).toBe(`whatsapp.web:101:${LID_JID}`);
    await expect(adapter.openDM(GROUP_JID)).rejects.toThrow("Not a WhatsApp person JID");
  });
});

/** Just enough shared state for the Chat SDK's inbound path. */
function sharedState() {
  const values = new Map<string, unknown>();
  // Real exclusion, like Postgres: a held thread lock refuses a second holder.
  const locks = new Set<string>();
  return {
    connect: async () => {},
    disconnect: async () => {},
    get: async (k: string) => (values.get(k) ?? null) as any,
    set: async (k: string, v: unknown) => {
      values.set(k, v);
    },
    delete: async (k: string) => {
      values.delete(k);
    },
    setIfNotExists: async (k: string, v: unknown) => {
      if (values.has(k)) return false;
      values.set(k, v);
      return true;
    },
    isSubscribed: async () => false,
    subscribe: async () => {},
    unsubscribe: async () => {},
    acquireLock: async (threadId: string) => {
      if (locks.has(threadId)) return null;
      locks.add(threadId);
      return { threadId, token: "t", expiresAt: Date.now() + 60_000 };
    },
    releaseLock: async (lock: { threadId: string }) => {
      locks.delete(lock.threadId);
    },
    extendLock: async () => true,
    forceReleaseLock: async () => {},
    appendToList: async () => {},
    getList: async () => [],
    enqueue: async () => 0,
    dequeue: async () => null,
    queueDepth: async () => 0,
  };
}

describe("WhatsApp Web source rows", () => {
  const source = (overrides: Record<string, unknown> = {}) => ({
    ...row(),
    content_kind: "text",
    ...overrides,
  });

  test("an inbound text row is a connection-scoped message on its chat", () => {
    const { adapter } = harness([]);
    const parsed = adapter.parseSourceRow(source());
    expect(parsed?.channelId).toBe(DM_JID);
    expect(parsed?.message.id).toBe("101:RAWIN1");
    expect(parsed?.message.threadId).toBe(`whatsapp.web:101:${DM_JID}`);
    expect(parsed?.message.author.userId).toBe(DM_JID);
    expect(parsed?.message.text).toBe("hello");
  });

  test("a group row carries its sender and the group as its channel", () => {
    const { adapter } = harness([]);
    const parsed = adapter.parseSourceRow(source({ chat_jid: GROUP_JID, is_group: true }));
    expect(parsed?.channelId).toBe(GROUP_JID);
    expect(parsed?.message.author.userId).toBe(DM_JID);
  });

  test("nothing answers our own, unverified, revoked, system, media-only or broadcast rows", () => {
    const { adapter } = harness([]);
    for (const overrides of [
      { from_me: true },
      { from_me: undefined },
      { content_kind: "revoked", text: "[revoked message]" },
      { content_kind: "system", text: "[system event]" },
      { content_kind: "media", text: "[image]" },
      { content_kind: undefined },
      { text: "   " },
      { chat_jid: "status@broadcast" },
      { chat_jid: "120363000000000002@newsletter" },
      { chat_jid: GROUP_JID, is_group: true, sender_jid: null },
    ]) {
      expect(adapter.parseSourceRow(source(overrides))).toBeNull();
    }
  });
});

describe("WhatsApp Web gateway delivery", () => {
  function gateway(outcomes?: Array<WhatsAppWebOperationOutcome | Error>) {
    const { adapter, calls } = harness(outcomes);
    const chat = new Chat({
      userName: "bot",
      adapters: { "whatsapp.web": adapter },
      state: sharedState() as any,
      logger: "error",
    });
    const instance = { connection: { id: "101", platform: "whatsapp.web" }, chat };
    const manager = {
      instances: new Map([["101", instance]]),
      ensureConnectionRunning: async () => true,
      getInstance: () => instance,
    };
    const bridge = new ChatResponseBridge(manager as any);
    return { adapter, calls, bridge, manager };
  }

  const payload = {
    messageId: "turn-1",
    channelId: `whatsapp.web:101:${DM_JID}`,
    conversationId: `whatsapp.web:101:${DM_JID}`,
    userId: "sender",
    teamId: "",
    timestamp: 0,
    platform: "whatsapp.web",
    platformMetadata: { connectionId: "101" },
  };

  test("manager sends a DM through the connection's known adapter", async () => {
    const { manager, calls } = gateway();
    const sent = await ChatInstanceManager.prototype.postDirectMessage.call(
      manager as any, "101", DM_JID, "hello",
    );
    expect(sent.messageId).toBe("101:RAWOUT1");
    expect(calls).toHaveLength(1);
  });

  test("a completion on another replica sends the authoritative text without local deltas", async () => {
    const first = gateway([]);
    const second = gateway();
    await first.bridge.handleDelta({ ...payload, delta: "partial" }, "s");
    expect(first.calls).toHaveLength(0);
    await second.bridge.handleCompletion({ ...payload, finalText: "whole reply" }, "s");
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.input).toEqual({ chat_jid: DM_JID, text: "whole reply" });
  });

  test("ambiguous delivery is not followed by a second send", async () => {
    const { bridge, calls } = gateway([new Error("connection reset")]);
    await bridge.handleDelta({ ...payload, delta: "hello" }, "s");
    await expect(
      bridge.handleCompletion({ ...payload, finalText: "hello" }, "s"),
    ).rejects.toThrow("connection reset");
    expect(calls).toHaveLength(1);
  });

  test("a redelivered terminal row reuses the same durable operation key", async () => {
    const first = gateway();
    const second = gateway();
    await first.bridge.handleCompletion({ ...payload, finalText: "hello" }, "s");
    await second.bridge.handleCompletion({ ...payload, finalText: "hello" }, "s");
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.idempotencyKey).toStartWith("chat-post:101:turn-1:");
    expect(second.calls[0]?.idempotencyKey).toBe(first.calls[0]?.idempotencyKey);
  });

  const settingsNotice = {
    ...payload,
    ephemeral: true,
    content: "Finish setup: [Open settings](https://app.example.test/connect/claim?claim=abc)",
  };

  test("a settings notice is one send carrying its link as text", async () => {
    const { bridge, calls } = gateway();
    await bridge.handleEphemeral(settingsNotice);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input.text)).toContain(
      "Open settings: https://app.example.test/connect/claim?claim=abc",
    );
  });

  test("a failed settings-notice send is not followed by a fallback send", async () => {
    for (const outcome of [
      new Error("timed out"),
      { status: "pending_approval", error: "awaiting approval" } as WhatsAppWebOperationOutcome,
    ]) {
      const { bridge, calls } = gateway([outcome]);
      await bridge.handleEphemeral(settingsNotice);
      expect(calls).toHaveLength(1);
    }
  });

  test("redelivered error and guardrail notices reuse their first operation", async () => {
    const first = gateway();
    const second = gateway();
    for (const { bridge } of [first, second]) {
      (bridge as any).scanTerminalOutput = async () => ({ guardrail: "test", reason: "blocked" });
      await bridge.handleCompletion({ ...payload, finalText: "secret" }, "s");
      (bridge as any).scanTerminalOutput = async () => null;
      await bridge.handleError({ ...payload, error: "backend failed" }, "s");
    }
    expect(first.calls.map((c) => c.input.text)).toEqual([
      "Message blocked by guardrail: blocked",
      "Error: backend failed",
    ]);
    expect(second.calls.map((c) => c.idempotencyKey)).toEqual(
      first.calls.map((c) => c.idempotencyKey),
    );
    expect(new Set(first.calls.map((c) => c.idempotencyKey)).size).toBe(2);
  });

  test("full replacements and in-band replies do not flush partial text", async () => {
    const { bridge, calls } = gateway();
    await bridge.handleDelta({ ...payload, delta: "partial" }, "s");
    await bridge.handleDelta({ ...payload, delta: "replacement", isFullReplacement: true }, "s");
    expect(calls).toHaveLength(0);
    await bridge.handleCompletion({ ...payload, finalText: "replacement", repliedInBand: true }, "s");
    expect(calls).toHaveLength(0);
    await bridge.handleCompletion({ ...payload, finalText: "replacement" }, "s");
    expect(calls[0]?.input.text).toBe("replacement");
  });

  test("a stored connection hydrates through the manager with its owner", async () => {
    const stored = {
      id: "101",
      platform: "whatsapp.web",
      config: {},
      settings: {},
      metadata: {},
      status: "active",
      organizationId: "org-synthetic",
      createdBy: "user-owner",
      createdAt: 0,
      updatedAt: 0,
    };
    const started: unknown[] = [];
    const manager = Object.assign(Object.create(ChatInstanceManager.prototype), {
      instances: new Map(),
      stopInstance: async () => {},
      resolveStored: async () => stored,
      startInstance: async function (this: any, connection: any) {
        started.push(await whatsappWebPlatform.createAdapter({} as any, { connection }));
        this.instances.set(connection.id, { connection });
      },
    });
    await (manager as any).hydrateFromRow(stored);
    expect(started).toHaveLength(1);
  });

  test("a connector transport startup failure reaches the ingress queue for retry", async () => {
    const failure = new Error("synthetic state-store outage");
    let statusWrites = 0;
    const manager = Object.assign(Object.create(ChatInstanceManager.prototype), {
      instances: new Map(),
      resolveStored: async () => ({ id: "101", platform: "whatsapp.web", status: "active" }),
      hydrateFromRow: async () => { throw failure; },
      writeConnectionStatus: async () => { statusWrites++; },
    });
    await expect(manager.warmConnection("101")).rejects.toBe(failure);
    expect(statusWrites).toBe(0);
  });

  test("an ownerless connection cannot dispatch as a system principal", () => {
    expect(() => connectionOperationsExecutor({
      id: "101", organizationId: "test-org", platform: "whatsapp.web",
    } as any)).toThrow("owner");
  });

  test("executor only accepts canonical positive persisted connection ids", () => {
    for (const id of ["0", "-1", "1e2", " 101", "9007199254740992", "agentconn-101"]) {
      expect(() => connectionOperationsExecutor({
        id, organizationId: "test-org", createdBy: "test-owner",
      } as any)).toThrow("persisted connector connection");
    }
    expect(typeof connectionOperationsExecutor({
      id: "101", organizationId: "test-org", createdBy: "test-owner",
    } as any)).toBe("function");
  });

  test("executor preserves operation admission outcomes and the connection's owner", async () => {
    const handleExecute = spyOn(operations, "handleExecute");
    try {
      const execute = connectionOperationsExecutor({
        id: "101", organizationId: "test-org", createdBy: "test-owner",
      } as any);
      const request = {
        operationKey: "send_message", input: { chat_jid: DM_JID, text: "hello" },
        idempotencyKey: "chat-post:101:turn-1:0",
      };
      handleExecute.mockResolvedValue({ action: "execute", run_id: 1,
        status: "completed", output: { message_id: "RAWOUT1" } });
      expect(await execute(request)).toEqual({
        status: "completed", output: { message_id: "RAWOUT1" },
      });
      expect(handleExecute.mock.calls[0]?.[0]).toEqual({
        action: "execute", connection_id: 101, operation_key: "send_message",
        input: request.input, idempotency_key: request.idempotencyKey,
      });
      expect(handleExecute.mock.calls[0]?.[1]).toMatchObject({
        organizationId: "test-org", userId: "test-owner", allowCrossOrg: false,
      });
      for (const status of ["failed", "timeout", "pending_approval", "in_progress"] as const) {
        handleExecute.mockResolvedValue({ action: "execute", run_id: 1, status });
        expect((await execute(request)).status).toBe(status);
      }
      handleExecute.mockResolvedValue({ error: "Policy blocks send_message" });
      expect(await execute(request)).toEqual({
        status: "failed", error: "Policy blocks send_message",
      });
      handleExecute.mockRejectedValue(new Error("admission unavailable"));
      await expect(execute(request)).rejects.toThrow("admission unavailable");
    } finally {
      handleExecute.mockRestore();
    }
  });
});
