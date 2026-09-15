/**
 * SseManager — owns per-agent Server-Sent Events fan-out.
 *
 * Extracted from `routes/public/agent.ts` so the route handler doesn't have
 * to track in-memory connection maps, TTL-pruned backlogs, and dead-connection
 * sweeps inline. A single instance is created in `core-services.ts` and
 * injected into the agent route and into any component that broadcasts
 * into SSE streams (API platform, response renderer, unified thread
 * consumer).
 *
 * Automation notes:
 *  - Two backlog rings per agentId, both capped at `backlogLimit` most-recent
 *    entries and TTL-pruned lazily on every read AND write: one for stream
 *    events (`output`/`status`, high-volume, evict freely) and one for
 *    everything else (interaction cards, terminal `complete`/`error`). The
 *    split keeps a chatty turn's deltas from evicting an ask_user card before
 *    the client can reconnect and replay it.
 *  - `broadcast` writes to every live connection; a connection is treated as
 *    dead when it reports `closed`/`destroyed`/`writableEnded` OR when a
 *    write throws — dead connections are removed silently (no throw, no log).
 *  - Backlog is ALWAYS remembered (even when no connections are attached) so
 *    a late subscriber can replay recent events.
 *  - Cross-replica: `broadcast` also hands the event to the injected
 *    `SseFanoutPublisher` (see `sse-fanout.ts`), and peer events arrive via
 *    `deliverFromPeer`, which seeds the backlog too — so a client whose SSE
 *    lands on (or fails over to) any pod can replay events produced on
 *    another. Best-effort transport; durable terminal delivery stays on the
 *    thread_response owner-gate in `unified-thread-consumer.ts`.
 */

import { intervals } from "../../config/intervals.js";

export interface SseEvent {
  event: string;
  data: unknown;
  timestamp: number;
  /**
   * Process-local arrival order, assigned by `rememberEvent`. Replay sorts
   * by (timestamp, seq) so events from the two backlog rings interleave
   * deterministically even within the same millisecond.
   */
  seq?: number;
}

/**
 * Sink that fans broadcast events out to peer replicas. Injected by
 * `SseFanout` via `setPublisher`; absent (single-replica / tests) means
 * broadcasts stay local-only. Kept as a plain interface — not a hard
 * dependency on Postgres — so `SseManager` stays a pure in-memory fan-out
 * and the cross-pod transport can be swapped without touching broadcast
 * call sites.
 */
interface SseFanoutPublisher {
  event(agentId: string, entry: SseEvent): void;
  close(agentId: string, reason: string): void;
}

/**
 * High-volume stream events kept in their own backlog ring so they cannot
 * evict interaction cards / terminal events from replay.
 */
const STREAM_EVENTS = new Set(["output", "status"]);

/**
 * Minimal shape of an SSE stream we can write to. Matches Hono's
 * `streamSSE` controller (the `writeSSE` path) and also falls back to a
 * raw Node-style writable for consumers that attach plain response
 * objects. Kept loose on purpose — SseManager doesn't own the connection
 * lifecycle, it just fans events out.
 */
export interface SseConnection {
  closed?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
  writeSSE?(payload: { event: string; data: string; id?: string }): unknown;
  write?(chunk: string): unknown;
}

export class SseManager {
  private readonly connections = new Map<string, Set<SseConnection>>();
  private readonly backlog = new Map<string, SseEvent[]>();
  private readonly streamBacklog = new Map<string, SseEvent[]>();
  private publisher?: SseFanoutPublisher;
  private nextSeq = 0;
  private lastMintedTs = 0;

  constructor(
    private readonly backlogLimit = intervals.sseBacklogLimit,
    private readonly backlogTtlMs = intervals.sseBacklogTtlMs
  ) {}

  /**
   * Append an event to the per-agent backlog (stream ring for high-volume
   * `output`/`status`, main ring for everything else) and prune expired
   * entries.
   *
   * Called from `broadcast` and is safe to call on its own for callers that
   * want to seed the backlog without an active connection.
   */
  rememberEvent(agentId: string, event: SseEvent): void {
    this.pruneExpired(event.timestamp);
    const ring = STREAM_EVENTS.has(event.event)
      ? this.streamBacklog
      : this.backlog;
    const existing = ring.get(agentId) || [];
    const next = existing
      .concat({ ...event, seq: this.nextSeq++ })
      .slice(-this.backlogLimit);
    ring.set(agentId, next);
  }

  /**
   * Return the current fresh backlog for an agent (both rings, merged in
   * timestamp order). Always prunes expired entries first so callers never
   * observe stale events.
   *
   * The optional `since` timestamp filters entries with `timestamp > since`.
   * Without it, the full retained backlog is returned.
   */
  getRecentEvents(agentId: string, since?: number): SseEvent[] {
    this.pruneExpired();
    const merged = (this.backlog.get(agentId) || []).concat(
      this.streamBacklog.get(agentId) || []
    );
    merged.sort(
      (a, b) => a.timestamp - b.timestamp || (a.seq ?? 0) - (b.seq ?? 0)
    );
    if (typeof since === "number") {
      return merged.filter((entry) => entry.timestamp > since);
    }
    return merged;
  }

  /**
   * Remember the event, write it to every live local connection for
   * `agentId`, and fan it out to peer replicas. The SSE connection for
   * `agentId` may live on a different pod than the one producing this event:
   * thread_response rows are claimed by whichever replica is free
   * (SKIP-LOCKED), independent of the ClientIP affinity that pins the
   * client's SSE to one pod. No-op (local-only) when no publisher is wired.
   */
  broadcast(agentId: string, event: string, data: unknown): void {
    const entry: SseEvent = { event, data, timestamp: this.mintTimestamp() };
    this.rememberEvent(agentId, entry);
    this.writeToConnections(agentId, entry);
    this.publisher?.event(agentId, entry);
  }

  /**
   * Deliver an event that originated on a peer replica (via `SseFanout`).
   * ALWAYS seeds the backlog — even with no local connection — so a client
   * that connects late or fails over to this pod (affinity break, pod
   * replacement) can replay events produced elsewhere. Never republishes
   * (that would loop the NOTIFY).
   */
  deliverFromPeer(agentId: string, entry: SseEvent): void {
    this.rememberEvent(agentId, entry);
    this.writeToConnections(agentId, entry);
  }

  /**
   * Apply a peer replica's `closeAgent` so a reconnect landing here cannot
   * replay backlog from a deleted session. Never republishes.
   */
  closeFromPeer(agentId: string, reason: string): void {
    this.closeLocal(agentId, reason);
  }

  /**
   * Register (or clear, with `undefined`) the sink that fans broadcast events
   * out to peer replicas. Called once at startup by `SseFanout`.
   */
  setPublisher(publisher: SseFanoutPublisher | undefined): void {
    this.publisher = publisher;
  }

  /**
   * Mint a strictly increasing timestamp for a locally-broadcast event.
   *
   * The timestamp doubles as the SSE `id:` a client echoes back to resume, and
   * `getRecentEvents` filters it with `timestamp > since`. Two events broadcast
   * in the SAME millisecond would therefore share a cursor, and resuming from
   * the first would silently drop the second — which bites hardest exactly when
   * it matters, because a terminal `complete` routinely lands in the same tick
   * as the delta before it. Bumping to `last + 1` on collision keeps the cursor
   * a total order without changing its type or the filter.
   *
   * Scoped to locally-minted events on purpose: `deliverFromPeer` keeps the
   * originating pod's timestamp, since rewriting it would reorder that pod's
   * events relative to their own cursors.
   */
  private mintTimestamp(): number {
    const now = Date.now();
    this.lastMintedTs = now > this.lastMintedTs ? now : this.lastMintedTs + 1;
    return this.lastMintedTs;
  }

  /** Write an event to every live connection for `agentId`, sweeping dead ones. */
  private writeToConnections(agentId: string, entry: SseEvent): void {
    const connections = this.connections.get(agentId);
    if (!connections || connections.size === 0) return;

    const { event, data } = entry;
    // `id:` is the resume cursor. It MUST be the event's timestamp, because
    // that is the only field comparable across pods — `seq` is a process-local
    // counter, so a reconnect that lands on another replica cannot order by it.
    // `getRecentEvents(agentId, since)` filters on the same field, so the id a
    // client echoes back as `Last-Event-ID` is directly usable as `since`.
    const id = String(entry.timestamp);
    const dead = new Set<SseConnection>();
    for (const res of connections) {
      try {
        if (res.closed || res.destroyed || res.writableEnded) {
          dead.add(res);
          continue;
        }
        if (typeof res.writeSSE === "function") {
          res.writeSSE({ id, event, data: JSON.stringify(data) });
        } else if (typeof res.write === "function") {
          const message = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          res.write(message);
        }
      } catch {
        dead.add(res);
      }
    }

    for (const deadRes of dead) {
      connections.delete(deadRes);
    }
    if (connections.size === 0) {
      this.connections.delete(agentId);
    }
  }

  /**
   * Register a live connection for fan-out. Caller is responsible for calling
   * `removeConnection` on disconnect — `broadcast` will also evict connections
   * it detects as dead during a write.
   */
  addConnection(agentId: string, connection: SseConnection): void {
    let set = this.connections.get(agentId);
    if (!set) {
      set = new Set();
      this.connections.set(agentId, set);
    }
    set.add(connection);
  }

  removeConnection(agentId: string, connection: SseConnection): void {
    const set = this.connections.get(agentId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(agentId);
    }
  }

  /**
   * True if `agentId` has at least one live connection registered.
   * Used by status endpoints that expose `hasActiveConnection`.
   */
  hasActiveConnection(agentId: string): boolean {
    const set = this.connections.get(agentId);
    return !!set && set.size > 0;
  }

  /**
   * Snapshot the number of live connections for an agent. Used for
   * per-agent connection-limit checks.
   */
  connectionCount(agentId: string): number {
    return this.connections.get(agentId)?.size ?? 0;
  }

  /** Total number of live connections across all agents. */
  totalConnections(): number {
    let total = 0;
    for (const set of this.connections.values()) total += set.size;
    return total;
  }

  /**
   * Close every connection for `agentId`, emitting a `closed` event with
   * `reason` first (best-effort — write errors are swallowed, matching the
   * previous inline DELETE /agents implementation). Also drops the backlog so a
   * later connection with the same key cannot replay stale completion
   * events from the deleted session, and tells peer replicas to do the same
   * (their backlogs are seeded by fan-out).
   */
  closeAgent(agentId: string, reason: string): void {
    this.closeLocal(agentId, reason);
    this.publisher?.close(agentId, reason);
  }

  private closeLocal(agentId: string, reason: string): void {
    const connections = this.connections.get(agentId);
    if (connections) {
      for (const connection of connections) {
        try {
          if (typeof connection.writeSSE === "function") {
            connection.writeSSE({
              event: "closed",
              data: JSON.stringify({ reason }),
            });
          } else if (typeof connection.write === "function") {
            connection.write(
              `event: closed\ndata: ${JSON.stringify({ reason })}\n\n`
            );
          }
          (connection as { close?: () => void }).close?.();
          (connection as { end?: () => void }).end?.();
        } catch {
          // Ignore — connection is already dead.
        }
      }
      this.connections.delete(agentId);
    }
    this.backlog.delete(agentId);
    this.streamBacklog.delete(agentId);
  }

  private pruneExpired(now = Date.now()): void {
    for (const ring of [this.backlog, this.streamBacklog]) {
      for (const [agentId, entries] of ring.entries()) {
        const fresh = entries.filter(
          (entry) => now - entry.timestamp <= this.backlogTtlMs
        );
        if (fresh.length === 0) {
          ring.delete(agentId);
          continue;
        }
        ring.set(agentId, fresh);
      }
    }
  }
}
