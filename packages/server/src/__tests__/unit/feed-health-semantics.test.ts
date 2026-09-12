import { describe, expect, test } from "bun:test";
import { deriveFeedHealthSemantics } from "../../connectors/feed-health-semantics";

const syncFeed = (
  input: Parameters<typeof deriveFeedHealthSemantics>[0],
  now?: number,
) => deriveFeedHealthSemantics({ operations: ["sync"], store: "events", ...input }, now);

describe("feed execution mode", () => {
  test("delivery feeds remain streaming while exposing ingestion failures", () => {
    expect(deriveFeedHealthSemantics({
      operations: ['delivery', 'read'], store: 'events', status: 'active',
      webhook_driven: true, last_sync_status: 'failed',
    })).toEqual({ executionMode: 'streaming', attention: 'last_attempt_failed' });
    expect(deriveFeedHealthSemantics({
      operations: ['delivery'], store: 'events', status: 'active',
      webhook_driven: true, last_sync_status: 'success',
    })).toEqual({ executionMode: 'streaming', attention: 'healthy' });
  });

  test("a read-only feed is source_only", () => {
    expect(
      deriveFeedHealthSemantics({ operations: ["read"], store: "events", status: "active" }),
    ).toEqual({ executionMode: "source_only", attention: "healthy" });
  });

  test("a hybrid feed uses its sync schedule", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["sync", "read"],
        store: "events",
        schedule: "0 */6 * * *",
        status: "active",
      }).executionMode,
    ).toBe("scheduled");
  });

  test("a sync feed without a schedule is no_schedule", () => {
    expect(syncFeed({ schedule: null, status: "active" }).executionMode).toBe("no_schedule");
    expect(syncFeed({ schedule: "", status: "active" }).executionMode).toBe("no_schedule");
  });

  test("channel storage is streaming regardless of connector operations", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["read"],
        store: "channel_messages",
        status: "active",
      }),
    ).toEqual({ executionMode: "streaming", attention: "healthy" });
  });
});

describe("feed attention", () => {
  test("canonical setup overrides auto-pause but never overrides an execution pin", () => {
    expect(
      syncFeed({
        status: "paused",
        device_worker_id: "dw-1",
        device_online: true,
        device_connector_readiness: "setup_required",
      }).attention,
    ).toBe("setup_required");
    expect(
      syncFeed({
        status: "active",
        device_worker_id: "dw-stale",
        device_online: false,
        device_connector_readiness: "ready",
      }).attention,
    ).toBe("device_offline");
  });

  test("lifecycle, auth, configuration, and device failures have precedence", () => {
    expect(syncFeed({ status: "paused", last_sync_status: "failed" }).attention).toBe("paused");
    expect(syncFeed({ status: "active", connection_status: "paused" }).attention).toBe("paused");
    expect(syncFeed({ status: "active", connection_status: "pending_auth" }).attention).toBe(
      "needs_auth",
    );
    expect(syncFeed({ status: "active", auth_profile_status: "revoked" }).attention).toBe(
      "needs_auth",
    );
    expect(syncFeed({ status: "active", connection_status: "error" }).attention).toBe(
      "misconfigured",
    );
    expect(
      syncFeed({ status: "active", device_worker_id: "dw-1", device_online: false }).attention,
    ).toBe("device_offline");
  });

  test("sync failure, never-run, and success states remain distinct", () => {
    expect(syncFeed({ status: "active", last_sync_status: "failed" }).attention).toBe(
      "last_attempt_failed",
    );
    expect(syncFeed({ status: "active", consecutive_failures: 1 }).attention).toBe(
      "last_attempt_failed",
    );
    // Both carry a dispatch path so they isolate sync HISTORY: without one the
    // row would classify on the dispatch gap instead, which the no_trigger
    // tests below cover separately.
    expect(
      syncFeed({ status: "active", schedule: "0 * * * *", last_sync_at: null }).attention,
    ).toBe("never_run");
    expect(
      syncFeed({
        status: "active",
        webhook_driven: true,
        last_sync_status: "success",
        last_sync_at: null,
      }).attention,
    ).toBe("healthy");
  });

  test("a scheduled feed becomes overdue only after the one-hour margin", () => {
    const now = Date.parse("2026-08-21T12:00:00Z");
    expect(
      syncFeed(
        {
          schedule: "0 * * * *",
          status: "active",
          last_sync_status: "success",
          next_run_at: "2026-08-21T10:00:00Z",
          active_runs: 0,
        },
        now,
      ).attention,
    ).toBe("overdue");
    // A webhook-driven feed legitimately carries no cron: the delivery re-arms
    // next_run_at, so `overdue` (which is measured against the cron) must not
    // fire for it however old the last sync is.
    expect(
      syncFeed(
        {
          schedule: null,
          webhook_driven: true,
          status: "active",
          last_sync_status: "success",
          last_sync_at: "2026-01-01T00:00:00Z",
        },
        now,
      ).attention,
    ).toBe("healthy");
  });

  test("a sync feed with no cron and no webhook has no dispatch path", () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    // The exact shape of the 78 feeds left dormant by #2021: active, syncable,
    // last run succeeded, zero failures — and unreachable, because
    // CheckDueFeeds selects on `next_run_at <= now` and nothing re-arms it.
    expect(
      syncFeed(
        {
          schedule: null,
          webhook_driven: false,
          status: "active",
          last_sync_status: "success",
          last_sync_at: "2026-07-18T00:00:00Z",
          consecutive_failures: 0,
        },
        now,
      ).attention,
    ).toBe("no_trigger");
  });

  test("no_trigger yields to states the operator must act on first", () => {
    const base = {
      schedule: null,
      webhook_driven: false,
      status: "active",
      last_sync_at: "2026-07-18T00:00:00Z",
    } as const;
    expect(syncFeed({ ...base, connection_status: "revoked" }).attention).toBe("needs_auth");
    expect(syncFeed({ ...base, status: "paused" }).attention).toBe("paused");
    expect(syncFeed({ ...base, last_sync_status: "failed" }).attention).toBe(
      "last_attempt_failed",
    );
  });

  test("no_trigger explains a feed that has never run", () => {
    // Precedence matters: `never_run` states the symptom, `no_trigger` states
    // the cause, and only the cause tells the operator what to do about it.
    expect(
      syncFeed({
        schedule: null,
        webhook_driven: false,
        status: "active",
        last_sync_at: null,
        last_sync_status: null,
      }).attention,
    ).toBe("no_trigger");
  });

  test("a streaming or read-only feed is never no_trigger", () => {
    // Neither runs a sync lifecycle, so "no cron" carries no meaning for them.
    expect(
      deriveFeedHealthSemantics({
        operations: [],
        store: "channel_messages",
        status: "active",
        schedule: null,
      }).attention,
    ).toBe("healthy");
    expect(
      deriveFeedHealthSemantics({
        operations: ["read"],
        store: "events",
        status: "active",
        schedule: null,
      }).attention,
    ).toBe("healthy");
  });

  test("source-only and channel-message feeds ignore sync history but keep operational attention", () => {
    expect(
      deriveFeedHealthSemantics({
        operations: ["read"],
        store: "events",
        status: "active",
        last_sync_status: "failed",
      }).attention,
    ).toBe("healthy");
    expect(
      deriveFeedHealthSemantics({
        operations: [],
        store: "channel_messages",
        status: "active",
        connection_status: "pending_auth",
      }).attention,
    ).toBe("needs_auth");
  });
});
