/**
 * Assembled-path guard for cross-replica Slack reply delivery (#1087/#1099).
 *
 * Under N>1 app replicas the pod that drains a terminal `thread_response` row
 * is usually NOT the pod that ran the worker, so it holds no local stream
 * buffer. PR #1087 made the worker's authoritative full text ride the row as
 * `finalText`; #1099 fixed an earlier version that delivered a garbled/stale
 * buffer instead. These tests drive the REAL SlackResponseStrategy completion
 * path and fake only the outbound Slack HTTP boundary
 * (slackClient.chat.postMessage), so a regression that reintroduces
 * buffer-over-finalText (or drops the cross-pod case) fails here.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ThreadResponsePayload } from "@lobu/core";
import { getResponseStrategy } from "../connections/platform-strategies/index.js";
import type {
  StrategyContext,
  StreamState,
} from "../connections/platform-strategies/index.js";

function fakeInstanceWithSlackSpy() {
  const postMessage = mock(async () => ({ ok: true }));
  const instance = {
    chat: {
      getAdapter: (platform: string) =>
        platform === "slack" ? { client: { chat: { postMessage } } } : undefined,
    },
  };
  return { instance, postMessage };
}

function ctx(instance: unknown, channelId = "slack:C0123ABCD"): StrategyContext {
  return { connectionId: "conn-1", instance, channelId, platform: "slack" };
}

function payload(extra: Partial<ThreadResponsePayload>): ThreadResponsePayload {
  return {
    messageId: "m1",
    channelId: "slack:C0123ABCD",
    conversationId: "slack:C0123ABCD",
    userId: "U1",
    teamId: "T1",
    platform: "slack",
    timestamp: 1,
    ...extra,
  };
}

describe("Slack completion delivery (cross-replica #1087/#1099)", () => {
  const strategy = getResponseStrategy("slack");

  test("delivers finalText when this replica has no stream buffer (cross-pod drain)", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({ finalText: "Hello **world**" }),
      stream: null, // delivering pod never ran the worker — no local buffer
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C0123ABCD",
      markdown_text: "Hello **world**",
    });
  });

  test("prefers finalText over a stale local buffer (#1099 regression guard)", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    const staleStream = {
      buffer: "partial garbled delta fragment",
      streamFailed: true,
      wasFullyReplaced: false,
      target: { post: mock(async () => undefined) },
    } as unknown as StreamState;
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({ finalText: "the authoritative final answer" }),
      stream: staleStream,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].markdown_text).toBe("the authoritative final answer");
  });

  test("falls back to the local buffer only when finalText is absent (pre-finalText worker)", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    const stream = {
      buffer: "legacy buffered text",
      streamFailed: true,
      wasFullyReplaced: false,
      target: { post: mock(async () => undefined) },
    } as unknown as StreamState;
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({}),
      stream,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].markdown_text).toBe("legacy buffered text");
  });

  test("does not post when there is neither finalText nor buffer", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({ finalText: "   " }),
      stream: null,
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("routes a threaded reply to thread_ts parsed from conversationId", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({
        finalText: "threaded reply",
        conversationId: "slack:C0123ABCD:1700000000.123456",
      }),
      stream: null,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C0123ABCD",
      thread_ts: "1700000000.123456",
      markdown_text: "threaded reply",
    });
  });

  test("a channel-level reply posts exactly one unthreaded markdown message with unfurls off", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({ finalText: "top-level answer" }),
      stream: null,
    });
    // Exact request shape: no thread_ts key at all for a channel-level
    // conversation, and the `markdown_text` field (never `text`).
    expect(postMessage.mock.calls).toEqual([
      [
        {
          channel: "C0123ABCD",
          markdown_text: "top-level answer",
          unfurl_links: false,
          unfurl_media: false,
        },
      ],
    ]);
  });

  test("an oversized paragraph splits on lines, then hard-slices, in order and without loss", async () => {
    const { instance, postMessage } = fakeInstanceWithSlackSpy();
    const longLine = "y".repeat(25_000);
    const lines = `${"a".repeat(6_000)}\n${"b".repeat(6_000)}`;
    const body = `${lines}\n\n${longLine}`;
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({
        finalText: body,
        conversationId: "slack:C0123ABCD:1700000000.123456",
      }),
      stream: null,
    });
    const posted = postMessage.mock.calls.map(
      (call: any[]) => call[0] as { markdown_text: string; thread_ts?: string },
    );
    expect(posted.map((p) => p.markdown_text.length)).toEqual([
      6_000, 6_000, 11_000, 11_000, 3_000,
    ]);
    // Every chunk stays in the same thread.
    for (const p of posted) expect(p.thread_ts).toBe("1700000000.123456");
    expect(posted.slice(2).map((p) => p.markdown_text).join("")).toBe(longLine);
  });

  test("without a Slack Web API client the reply falls back to the SDK target, cleaned", async () => {
    const target = { post: mock(async () => undefined) };
    await strategy.handleCompletion({
      ctx: ctx({ chat: { getAdapter: () => undefined } }),
      payload: payload({ finalText: "&lt;b&gt; [cite]() done" }),
      stream: {
        buffer: "",
        streamFailed: true,
        wasFullyReplaced: false,
        target,
      } as unknown as StreamState,
    });
    expect(target.post.mock.calls).toEqual([["<b> cite done"]]);
  });

  // CURRENT (known gap): chunk posts carry no receipts and failure is not
  // per-chunk. When a later chunk fails, the strategy re-posts the WHOLE
  // cleaned body through the SDK target, so the chunks that already landed are
  // duplicated. The Adapter-delivery PR (native posting bypass at
  // platform-strategies/slack.ts) must make chunk delivery resumable.
  test("a failure after the first chunk re-posts the entire body through the SDK", async () => {
    let calls = 0;
    const postMessage = mock(async () => {
      calls += 1;
      if (calls === 2) throw new Error("ratelimited");
      return { ok: true };
    });
    const instance = {
      chat: { getAdapter: () => ({ client: { chat: { postMessage } } }) },
    };
    const target = { post: mock(async () => undefined) };
    const para = "z".repeat(6_000);
    const body = `${para}\n\n${para}`;
    await strategy.handleCompletion({
      ctx: ctx(instance),
      payload: payload({ finalText: body }),
      stream: {
        buffer: "",
        streamFailed: true,
        wasFullyReplaced: false,
        target,
      } as unknown as StreamState,
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect((postMessage.mock.calls[0] as any[])[0].markdown_text).toBe(para);
    // The first chunk already reached Slack, yet the fallback sends all of it again.
    expect(target.post.mock.calls).toEqual([[body]]);
  });
});
