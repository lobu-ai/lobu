/**
 * Tests for SseManager — backlog pruning, dead-connection sweep, and
 * broadcast semantics. Covers logic previously inlined in
 * `routes/public/agent.ts` so we don't regress on extraction.
 */

import { describe, expect, test } from "bun:test";
import { SseManager, type SseConnection } from "../services/sse-manager.js";

function fakeStream(): SseConnection & {
  events: Array<{ event: string; data: string; id?: string }>;
  failOnNextWrite: boolean;
} {
  const events: Array<{ event: string; data: string; id?: string }> = [];
  return {
    events,
    failOnNextWrite: false,
    writeSSE(payload) {
      if ((this as any).failOnNextWrite) {
        (this as any).failOnNextWrite = false;
        throw new Error("boom");
      }
      events.push(payload);
    },
  } as any;
}

describe("SseManager", () => {
  test("broadcast delivers events to all live connections for the agent", () => {
    const mgr = new SseManager();
    const a = fakeStream();
    const b = fakeStream();
    mgr.addConnection("agent-1", a);
    mgr.addConnection("agent-1", b);

    mgr.broadcast("agent-1", "output", { hello: "world" });

    expect(a.events).toHaveLength(1);
    expect(a.events[0]?.event).toBe("output");
    expect(a.events[0]?.data).toBe(JSON.stringify({ hello: "world" }));
    expect(b.events).toHaveLength(1);
  });

  test("broadcast to an agent with no connections still records backlog", () => {
    const mgr = new SseManager();
    mgr.broadcast("agent-2", "output", { n: 1 });

    const stream = fakeStream();
    mgr.addConnection("agent-2", stream);

    const backlog = mgr.getRecentEvents("agent-2");
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.event).toBe("output");
  });

  test("backlog is capped at the configured limit (most-recent wins)", () => {
    const mgr = new SseManager(3);
    for (let i = 0; i < 10; i++) {
      mgr.broadcast("agent", "output", { n: i });
    }

    const backlog = mgr.getRecentEvents("agent");
    expect(backlog).toHaveLength(3);
    const values = backlog.map((e) => (e.data as { n: number }).n);
    expect(values).toEqual([7, 8, 9]);
  });

  test("dead connections are swept on broadcast write failure", () => {
    const mgr = new SseManager();
    const healthy = fakeStream();
    const dying = fakeStream();
    dying.failOnNextWrite = true;
    mgr.addConnection("agent", healthy);
    mgr.addConnection("agent", dying);

    mgr.broadcast("agent", "output", { n: 1 });

    expect(mgr.connectionCount("agent")).toBe(1);
    expect(mgr.hasActiveConnection("agent")).toBe(true);
    // Subsequent broadcast should only reach the healthy stream.
    mgr.broadcast("agent", "output", { n: 2 });
    expect(healthy.events).toHaveLength(2);
    expect(dying.events).toHaveLength(0);
  });

  test("connections reporting closed/destroyed/writableEnded are treated as dead", () => {
    const mgr = new SseManager();
    const closed = fakeStream();
    (closed as any).closed = true;
    mgr.addConnection("agent", closed);

    mgr.broadcast("agent", "output", { n: 1 });

    expect(closed.events).toHaveLength(0);
    expect(mgr.connectionCount("agent")).toBe(0);
    expect(mgr.hasActiveConnection("agent")).toBe(false);
  });

  test("removeConnection cleans up the per-agent set", () => {
    const mgr = new SseManager();
    const stream = fakeStream();
    mgr.addConnection("agent", stream);
    expect(mgr.hasActiveConnection("agent")).toBe(true);
    mgr.removeConnection("agent", stream);
    expect(mgr.hasActiveConnection("agent")).toBe(false);
    expect(mgr.connectionCount("agent")).toBe(0);
  });

  test("totalConnections sums across all agents", () => {
    const mgr = new SseManager();
    mgr.addConnection("a", fakeStream());
    mgr.addConnection("a", fakeStream());
    mgr.addConnection("b", fakeStream());
    expect(mgr.totalConnections()).toBe(3);
  });

  test("closeAgent writes a closed event, clears connections, and drops backlog", () => {
    const mgr = new SseManager();
    const stream = fakeStream();
    mgr.addConnection("agent", stream);
    mgr.broadcast("agent", "output", { n: 1 });

    mgr.closeAgent("agent", "agent_deleted");

    expect(stream.events.at(-1)?.event).toBe("closed");
    expect(stream.events.at(-1)?.data).toBe(
      JSON.stringify({ reason: "agent_deleted" })
    );
    expect(mgr.hasActiveConnection("agent")).toBe(false);
    expect(mgr.getRecentEvents("agent")).toEqual([]);
  });

  test("rememberEvent + getRecentEvents with since filter", () => {
    const mgr = new SseManager();
    const base = Date.now();
    mgr.rememberEvent("agent", { event: "a", data: 1, timestamp: base - 30 });
    mgr.rememberEvent("agent", { event: "b", data: 2, timestamp: base - 20 });
    mgr.rememberEvent("agent", { event: "c", data: 3, timestamp: base - 10 });

    const since = mgr.getRecentEvents("agent", base - 25);
    expect(since.map((e) => e.event)).toEqual(["b", "c"]);
  });

  test("expired backlog entries are pruned on read", () => {
    // 10ms TTL so we can advance past it with a real timestamp.
    const mgr = new SseManager(100, 10);
    mgr.rememberEvent("agent", {
      event: "stale",
      data: null,
      timestamp: Date.now() - 1000,
    });
    // A second read-after-TTL should return nothing.
    expect(mgr.getRecentEvents("agent")).toEqual([]);
  });

  test("stream events cannot evict interaction cards from the backlog", () => {
    // Ring limit 3: a card followed by a flood of deltas must still replay
    // the card — output/status live in their own ring.
    const mgr = new SseManager(3, 60_000);
    mgr.broadcast("agent", "question", { questionId: "q1" });
    for (let i = 0; i < 20; i++) {
      mgr.broadcast("agent", "output", { seq: i });
      mgr.broadcast("agent", "status", { beat: i });
    }
    mgr.broadcast("agent", "complete", { processedMessageIds: ["m1"] });

    const events = mgr.getRecentEvents("agent").map((entry) => entry.event);
    expect(events).toContain("question");
    expect(events).toContain("complete");
    // Stream ring is still capped.
    expect(events.filter((event) => event === "output").length).toBeLessThanOrEqual(3);
  });

  test("broadcast hands every event to the publisher; deliverFromPeer never does", () => {
    const mgr = new SseManager();
    const published: Array<{ agentId: string; event: string }> = [];
    mgr.setPublisher({
      event: (agentId, entry) => published.push({ agentId, event: entry.event }),
      close: (agentId) => published.push({ agentId, event: "__close__" }),
    });

    mgr.broadcast("agent", "output", { n: 1 });
    // Peer delivery must not republish (would loop the NOTIFY) but must seed
    // the backlog so this pod can serve replay.
    mgr.deliverFromPeer("agent", {
      event: "complete",
      data: { n: 2 },
      timestamp: Date.now(),
    });

    expect(published).toEqual([{ agentId: "agent", event: "output" }]);
    // Replay merges both rings in deterministic arrival order — the seq
    // tiebreaker keeps same-millisecond entries in the order they were
    // remembered.
    expect(mgr.getRecentEvents("agent").map((entry) => entry.event)).toEqual([
      "output",
      "complete",
    ]);

    mgr.closeAgent("agent", "done");
    expect(published.at(-1)).toEqual({ agentId: "agent", event: "__close__" });
    expect(mgr.getRecentEvents("agent")).toEqual([]);
  });

  test("closeFromPeer purges without republishing", () => {
    const mgr = new SseManager();
    let closePublishes = 0;
    mgr.setPublisher({
      event: () => undefined,
      close: () => {
        closePublishes += 1;
      },
    });
    mgr.broadcast("agent", "question", { questionId: "q1" });

    mgr.closeFromPeer("agent", "deleted elsewhere");

    expect(mgr.getRecentEvents("agent")).toEqual([]);
    expect(closePublishes).toBe(0);
  });

  /**
   * Resume regression. The client used to hand-roll a dedupe by comparing each
   * payload's timestamp against the newest `connected` stamp, which discarded
   * the ENTIRE replay after any reconnect — including a terminal `complete`
   * that the owner gate had retried specifically to deliver. The fix is the
   * standard SSE primitive: every live write carries `id: <timestamp>`, the
   * client echoes it back, and only the gap is replayed. If `id` stops being
   * written, resume silently degrades to "replay everything" and the client
   * loses its cursor — so assert the cursor itself, not just the payload.
   */
  test("every live write carries a timestamp cursor usable as `since`", () => {
    const mgr = new SseManager();
    const conn = fakeStream();
    mgr.addConnection("agent-resume", conn);

    mgr.broadcast("agent-resume", "output", { content: "first" });
    mgr.broadcast("agent-resume", "complete", { finalText: "done" });

    expect(conn.events).toHaveLength(2);
    for (const event of conn.events) {
      expect(typeof event.id).toBe("string");
      expect(Number.isFinite(Number(event.id))).toBe(true);
    }

    // The cursor a client would echo back after seeing only the first event.
    const cursor = Number(conn.events[0]?.id);
    const replayed = mgr.getRecentEvents("agent-resume", cursor);

    // The gap — and specifically the terminal event — survives; the event the
    // client already saw does not come back.
    expect(replayed.map((e) => e.event)).toEqual(["complete"]);
  });

  test("a resumed client is not handed events it already saw", () => {
    const mgr = new SseManager();
    const conn = fakeStream();
    mgr.addConnection("agent-seen", conn);

    mgr.broadcast("agent-seen", "output", { content: "a" });
    const cursor = Number(conn.events[0]?.id);

    expect(mgr.getRecentEvents("agent-seen", cursor)).toHaveLength(0);
    expect(mgr.getRecentEvents("agent-seen")).toHaveLength(1);
  });
});
