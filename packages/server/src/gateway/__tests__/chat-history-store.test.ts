import { describe, expect, test } from "bun:test";
import {
  ConversationStateStore,
  MAX_HISTORY_MESSAGES,
  historyIndexKey,
} from "../connections/conversation-state-store.js";
import { InMemoryStateAdapter } from "./fixtures/in-memory-state-adapter.js";

function freshStore() {
  const state = new InMemoryStateAdapter();
  const store = new ConversationStateStore(state);
  return { state, store };
}

describe("ConversationStateStore history", () => {
  test("getHistory returns only the last MAX_HISTORY_MESSAGES entries", async () => {
    const { state, store } = freshStore();
    const overflow = MAX_HISTORY_MESSAGES + 3;
    for (let i = 0; i < overflow; i++) {
      await state.appendToList("history:c:ch", {
        role: "user",
        content: `msg-${i}`,
        timestamp: i,
      });
    }
    const history = await store.getHistory("c", "ch");
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]?.content).toBe(`msg-${overflow - MAX_HISTORY_MESSAGES}`);
    expect(history.at(-1)?.content).toBe(`msg-${overflow - 1}`);
  });

  test("clearAllHistory removes all indexed history for a connection", async () => {
    const { state, store } = freshStore();
    await store.appendHistory("c", "ch-1", "ch-1", {
      role: "user",
      content: "x",
      timestamp: 1,
    });
    await store.appendHistory("c", "ch-2", "ch-2", {
      role: "assistant",
      content: "y",
      timestamp: 2,
    });

    expect(await store.clearAllHistory("c")).toBe(2);
    expect(await store.getHistory("c", "ch-1")).toEqual([]);
    expect(await store.getHistory("c", "ch-2")).toEqual([]);
    expect(await state.get(historyIndexKey("c"))).toBeNull();
  });

  test("history is scoped per (connection, channel)", async () => {
    const { store } = freshStore();
    await store.appendHistory("A", "ch-1", "ch-1", {
      role: "user",
      content: "a1",
      timestamp: 1,
    });
    await store.appendHistory("B", "ch-1", "ch-1", {
      role: "user",
      content: "b1",
      timestamp: 2,
    });
    await store.appendHistory("A", "ch-2", "ch-2", {
      role: "user",
      content: "a2",
      timestamp: 3,
    });

    expect((await store.getHistory("A", "ch-1"))[0]?.content).toBe("a1");
    expect((await store.getHistory("B", "ch-1"))[0]?.content).toBe("b1");
    expect((await store.getHistory("A", "ch-2"))[0]?.content).toBe("a2");
  });

  // F12: threads in the SAME channel must not share a sliding window.
  test("history is scoped per thread within a channel (no bleed)", async () => {
    const { store } = freshStore();
    const channel = "C-shared";
    const threadA = "C-shared:1700000000.0001";
    const threadB = "C-shared:1700000000.0002";

    await store.appendHistory("conn", channel, threadA, {
      role: "user",
      content: "thread-A-only",
      timestamp: 1,
    });
    await store.appendHistory("conn", channel, threadB, {
      role: "user",
      content: "thread-B-only",
      timestamp: 2,
    });

    const aHistory = await store.getHistory("conn", channel, threadA);
    const bHistory = await store.getHistory("conn", channel, threadB);

    expect(aHistory.map((m) => m.content)).toEqual(["thread-A-only"]);
    expect(bHistory.map((m) => m.content)).toEqual(["thread-B-only"]);
    // Thread A must NOT see thread B's message and vice versa.
    expect(aHistory.some((m) => m.content === "thread-B-only")).toBe(false);
    expect(bHistory.some((m) => m.content === "thread-A-only")).toBe(false);

    // getEntries returns the thread-scoped sliding history window.
    const aEntries = await store.getEntries("conn", channel, threadA);
    expect(aEntries.map((e) => e.content)).toEqual(["thread-A-only"]);
  });

  // Non-threaded callers (conversationId === channelId) keep the channel-level
  // bucket so DMs/top-level chats are unaffected.
  test("non-threaded scope equals the channel bucket", async () => {
    const { store } = freshStore();
    // Default conversationId (omitted) and explicit conversationId === channel
    // must hit the same bucket.
    await store.appendHistory("conn", "C-dm", "C-dm", {
      role: "user",
      content: "dm-msg",
      timestamp: 1,
    });
    expect((await store.getHistory("conn", "C-dm"))[0]?.content).toBe("dm-msg");
    expect(
      (await store.getHistory("conn", "C-dm", "C-dm"))[0]?.content
    ).toBe("dm-msg");
  });

  // Connection selection ("which connection owns this channel") must still match
  // when the channel's history is split across per-thread scopes.
  test("hasHistoryForChannel matches thread-scoped history", async () => {
    const { store } = freshStore();
    await store.appendHistory("conn", "C-x", "C-x:thread-1", {
      role: "user",
      content: "x",
      timestamp: 1,
    });
    expect(await store.hasHistoryForChannel("conn", "C-x")).toBe(true);
    expect(await store.hasHistoryForChannel("conn", "C-other")).toBe(false);
  });

  // listHistoryChannels collapses per-thread scopes back to distinct channels
  // (used to pick a default post target).
  test("listHistoryChannels dedupes threads back to channels", async () => {
    const { store } = freshStore();
    await store.appendHistory("conn", "C-1", "C-1:t1", {
      role: "user",
      content: "a",
      timestamp: 1,
    });
    await store.appendHistory("conn", "C-1", "C-1:t2", {
      role: "user",
      content: "b",
      timestamp: 2,
    });
    await store.appendHistory("conn", "C-2", "C-2", {
      role: "user",
      content: "c",
      timestamp: 3,
    });

    const channels = (await store.listHistoryChannels("conn")).sort();
    expect(channels).toEqual(["C-1", "C-2"]);
  });
});
