import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIssueRepair } from "../scripts/build-issue-repair";
import trackIssues, {
  type IssueRecord,
  type Occurrence,
  planIssueChanges,
  RULES,
  runIssueTracker,
} from "../issue-tracker.reaction";
import {
  healthProblem,
  planHealthChanges,
  readHealthSnapshot,
  type HealthResource,
} from "../workspace-health";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const ago = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const FP = (n: number) => n.toString(16).padStart(32, "0");

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    fingerprint: FP(1),
    kind: "system",
    source: "server",
    title: "Error: boom",
    culprit: "GET /x",
    message: "boom",
    first_seen: ago(3),
    last_seen: ago(0.1),
    seen_2h: 1,
    seen_24h: RULES.systemMinSeen24h,
    seen_14d: RULES.systemMinSeen24h,
    max_orgs: 1,
    max_users: 1,
    releases_2h: ["rel-b"],
    last_release: "rel-b",
    sample_trace_id: "trace",
    request: "",
    ...overrides,
  };
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 7,
    fingerprint: FP(1),
    status: "ongoing",
    first_seen: ago(24 * 30),
    last_seen: ago(1),
    ...overrides,
  };
}

const plan = (o: Occurrence[], i: IssueRecord[], created = 0) =>
  planIssueChanges(o, i, NOW, created);

describe("issue creation gate", () => {
  test("system errors need three sightings or two workspaces", () => {
    expect(plan([occ({ seen_24h: 2 })], [])).toEqual([]);
    expect(plan([occ({ seen_24h: 1, max_orgs: 2 })], [])[0]?.action).toBe(
      "create"
    );
    const [created] = plan([occ({ max_users: 0, max_orgs: 0 })], []);
    expect(created).toMatchObject({
      action: "create",
      name: "Error: boom",
      metadata: {
        fingerprint: FP(1),
        status: "new",
        kind: "system",
        priority: "medium",
      },
    });
  });

  test("user errors only become issues when they spike", () => {
    expect(plan([occ({ kind: "user", seen_24h: 12 })], [])).toEqual([]);
    expect(
      plan([occ({ kind: "user", seen_24h: RULES.userMinSeen24h })], [])[0]
    ).toMatchObject({
      action: "create",
      metadata: { priority: "low" },
    });
  });

  test("reach makes a system issue high priority; volume alone does not", () => {
    // One crawler walking distinct URLs: a sighting each, nobody attached.
    expect(
      plan([occ({ seen_24h: 500, max_users: 0, max_orgs: 0 })], [])[0]
    ).toMatchObject({
      metadata: { priority: "medium" },
    });
    // One named user the error blocked is reach.
    expect(
      plan(
        [
          occ({
            seen_24h: RULES.systemMinSeen24h,
            max_users: RULES.highMinUsers,
            max_orgs: 0,
          }),
        ],
        []
      )[0]
    ).toMatchObject({
      metadata: { priority: "high" },
    });
    expect(
      plan(
        [
          occ({
            kind: "dependency",
            max_users: 0,
            max_orgs: RULES.highMinOrgs,
          }),
        ],
        []
      )[0]
    ).toMatchObject({
      metadata: { priority: "high" },
    });
  });

  test("a request failing in browsers is an issue only when it spikes", () => {
    const failed = occ({ source: "browser", kind: "dependency" });
    expect(plan([{ ...failed, seen_24h: 500 }], [])).toEqual([]);
    expect(plan([{ ...failed, max_orgs: RULES.highMinOrgs }], [])).toEqual([]);
    const spike = { ...failed, seen_2h: 40, seen_24h: 45, seen_14d: 60 };
    expect(plan([spike], [])[0]).toMatchObject({
      action: "create",
      metadata: { status: "escalating", priority: "high" },
    });
    // A page defect in the browser keeps the system gate.
    expect(plan([occ({ source: "browser" })], [])[0]?.action).toBe("create");
  });

  test("a cross-origin script error carries nothing to fix and is never an issue", () => {
    const opaque = occ({
      source: "browser",
      title: "Error: Script error.",
      message: RULES.opaqueBrowserError,
      seen_24h: 500,
    });
    expect(plan([opaque], [])).toEqual([]);
    expect(plan([{ ...opaque, source: "server" }], [])[0]?.action).toBe(
      "create"
    );
  });

  test("one system error on a sign-in or consent route is a high-priority issue", () => {
    const blocked = occ({
      culprit: "GET /connect/oauth/callback",
      seen_2h: 1,
      seen_24h: 1,
      seen_14d: 1,
      max_orgs: 0,
      max_users: 0,
    });
    expect(plan([blocked], [])[0]).toMatchObject({
      action: "create",
      metadata: { priority: "high" },
    });
    expect(plan([{ ...blocked, kind: "user" }], [])).toEqual([]);
    expect(plan([{ ...blocked, culprit: "GET /x" }], [])).toEqual([]);
    const louder = Array.from({ length: 5 }, (_, n) =>
      occ({ fingerprint: FP(n + 2), seen_24h: 50 })
    );
    const changes = plan([...louder, blocked], [], 1);
    expect(changes.find((c) => c.fingerprint === FP(1))?.action).toBe("create");
  });

  test("a logged error during a sign-in request is a high-priority issue on first sighting", () => {
    const logged = occ({
      culprit: "log lobu-server",
      request: "GET /connect/oauth/callback",
      seen_2h: 1,
      seen_24h: 1,
      seen_14d: 1,
      max_orgs: 0,
      max_users: 0,
    });
    expect(plan([logged], [])[0]).toMatchObject({
      action: "create",
      metadata: { priority: "high", request: "GET /connect/oauth/callback" },
      alert: {
        title:
          "New high-priority issue: Error: boom (GET /connect/oauth/callback)",
      },
    });
    expect(plan([{ ...logged, request: "GET /x" }], [])).toEqual([]);
    expect(plan([{ ...logged, request: "" }], [])).toEqual([]);
  });

  test("a new high-priority issue alerts admins once; medium ones do not", () => {
    const [high] = plan([occ({ max_users: RULES.highMinUsers })], []);
    expect(high).toMatchObject({
      action: "create",
      alert: { kind: "new_high", key: `issue-new:${FP(1)}` },
    });
    expect(high?.alert?.body).toContain("1 user and 1 workspace affected");
    const [medium] = plan([occ({ max_users: 0, max_orgs: 0 })], []);
    expect(medium).toMatchObject({ action: "create" });
    expect(medium).not.toHaveProperty("alert");
  });

  test("an anonymous burst with no user or workspace never alerts", () => {
    // The real case: a crawler walked 221 distinct public pages in seven
    // seconds and source admission refused the reads. Volume was real; reach
    // was zero, and paging on it woke someone for nothing.
    const burst = occ({
      seen_2h: 221,
      seen_24h: 221,
      seen_14d: 221,
      max_users: 0,
      max_orgs: 0,
    });
    const [change] = plan([burst], []);
    expect(change).toMatchObject({
      action: "create",
      metadata: { priority: "medium" },
    });
    expect(change).not.toHaveProperty("alert");
    // It still shows on the board, and an escalation without reach is a
    // status change, not a page.
    const spike = occ({
      seen_2h: 40,
      seen_24h: 45,
      seen_14d: 60,
      max_users: 0,
      max_orgs: 0,
    });
    const [escalated] = plan([spike], [issue()]);
    expect(escalated).toMatchObject({ metadata: { status: "escalating" } });
    expect(escalated).not.toHaveProperty("alert");
  });

  test("the hourly quota defers the quietest new fingerprints", () => {
    const many = Array.from({ length: 7 }, (_, n) =>
      occ({ fingerprint: FP(n + 1), seen_24h: 10 + n })
    );
    const changes = plan(many, [], 3);
    const created = changes
      .filter((c) => c.action === "create")
      .map((c) => c.fingerprint);
    expect(created).toEqual([FP(7), FP(6)]);
    expect(changes.filter((c) => c.action === "defer")).toHaveLength(5);
  });
});

describe("issue lifecycle", () => {
  test("an ongoing issue only gets its counters refreshed", () => {
    const [change] = plan([occ()], [issue()]);
    expect(change).toMatchObject({ action: "update", id: 7 });
    expect(
      change && "metadata" in change && change.metadata.status
    ).toBeUndefined();
  });

  test("a new issue becomes ongoing after a week", () => {
    expect(
      plan([occ()], [issue({ status: "new", first_seen: ago(24 * 6) })])[0]
    ).not.toHaveProperty("metadata.status");
    expect(
      plan([occ()], [issue({ status: "new", first_seen: ago(24 * 8) })])[0]
    ).toMatchObject({
      metadata: { status: "ongoing" },
    });
  });

  test("a resolved issue seen again regresses once per resolution", () => {
    const [change] = plan(
      [occ()],
      [issue({ status: "resolved", resolved_at: ago(2) })]
    );
    expect(change).toMatchObject({
      metadata: { status: "regressed", regressed_at: NOW.toISOString() },
      alert: { kind: "regressed", key: `issue:${FP(1)}:regressed:${ago(2)}` },
    });
  });

  test("a fix release regresses only when that release still emits it", () => {
    const resolved = issue({
      status: "resolved",
      resolved_at: ago(2),
      resolved_in_release: "rel-c",
    });
    expect(
      plan([occ({ releases_2h: ["rel-b"] })], [resolved])[0]
    ).not.toHaveProperty("alert");
    expect(
      plan([occ({ releases_2h: ["rel-b", "rel-c"] })], [resolved])[0]
    ).toMatchObject({
      metadata: { status: "regressed" },
    });
  });

  test("an occurrence from before the resolution is not a regression", () => {
    const [change] = plan(
      [occ({ last_seen: ago(3) })],
      [issue({ status: "resolved", resolved_at: ago(2) })]
    );
    expect(change).not.toHaveProperty("alert");
    expect(change).not.toHaveProperty("metadata.status");
  });

  test("ignored issues stay ignored until ignore_until passes", () => {
    expect(
      plan([occ()], [issue({ status: "ignored", ignore_until: ago(-1) })])[0]
    ).not.toHaveProperty("metadata.status");
    expect(
      plan([occ()], [issue({ status: "ignored", ignore_until: ago(1) })])[0]
    ).toMatchObject({
      metadata: { status: "ongoing" },
    });
  });

  test("a rate far above the baseline escalates and alerts once a day", () => {
    const spike = occ({ seen_2h: 40, seen_24h: 45, seen_14d: 60 });
    const [change] = plan([spike], [issue()]);
    expect(change).toMatchObject({
      metadata: { status: "escalating", escalated_at: NOW.toISOString() },
      alert: { kind: "escalating", key: `issue:${FP(1)}:escalating:first` },
    });
    // A steady high rate is the baseline, not an escalation.
    const steady = occ({ seen_2h: 40, seen_24h: 480, seen_14d: 480 * 14 });
    expect(plan([steady], [issue()])[0]).not.toHaveProperty("alert");
    // Already escalating: no second alert.
    expect(
      plan([spike], [issue({ status: "escalating" })])[0]
    ).not.toHaveProperty("alert");
    // Escalating again within a day of the last alert: status only, and the
    // last alert's time is kept, so repeated flaps cannot postpone the next.
    const flapped = plan([spike], [issue({ escalated_at: ago(5) })])[0];
    expect(flapped).toMatchObject({ metadata: { status: "escalating" } });
    expect(flapped).not.toHaveProperty("alert");
    expect(flapped).not.toHaveProperty("metadata.escalated_at");
    // A later episode is keyed by the escalation it follows, so a retry of
    // the same run, even past midnight, repeats the key instead of a new one.
    const later = issue({ escalated_at: ago(30) });
    expect(plan([spike], [later])[0]).toMatchObject({
      alert: { key: `issue:${FP(1)}:escalating:${ago(30)}` },
    });
    const pastMidnight = new Date(NOW.getTime() + 13 * 3_600_000);
    expect(
      planIssueChanges([spike], [later], pastMidnight, 0)[0]
    ).toMatchObject({
      alert: { key: `issue:${FP(1)}:escalating:${ago(30)}` },
    });
  });

  test("a fingerprint with no history before today is new, never escalating", () => {
    // A steady error seen only since this morning (or regrouped by a release).
    const unseenBefore = occ({ seen_2h: 24, seen_24h: 40, seen_14d: 40 });
    expect(plan([unseenBefore], [])[0]).toMatchObject({
      action: "create",
      metadata: { status: "new" },
    });
    expect(plan([unseenBefore], [issue()])[0]).not.toHaveProperty("alert");
  });

  test("an escalating issue calms down when the rate drops or it goes quiet", () => {
    expect(plan([occ()], [issue({ status: "escalating" })])[0]).toMatchObject({
      metadata: { status: "ongoing" },
    });
    expect(
      plan([], [issue({ status: "escalating", last_seen: ago(5) })])
    ).toEqual([
      {
        action: "update",
        id: 7,
        fingerprint: FP(1),
        metadata: { status: "ongoing" },
      },
    ]);
  });

  test("a quiet issue's 24h count drops to zero a day after its last sighting", () => {
    // Counters refresh only for fingerprints seen in the last two hours, so a
    // quiet issue would keep its last seen_24h and outrank live ones forever.
    expect(plan([], [issue({ last_seen: ago(25), seen_24h: 197 })])).toEqual([
      {
        action: "update",
        id: 7,
        fingerprint: FP(1),
        metadata: { seen_24h: 0 },
      },
    ]);
    expect(plan([], [issue({ last_seen: ago(5), seen_24h: 197 })])).toEqual([]);
    expect(plan([], [issue({ last_seen: ago(25), seen_24h: 0 })])).toEqual([]);
    expect(
      plan(
        [],
        [issue({ status: "escalating", last_seen: ago(25), seen_24h: 40 })]
      )
    ).toEqual([
      {
        action: "update",
        id: 7,
        fingerprint: FP(1),
        metadata: { status: "ongoing", seen_24h: 0 },
      },
    ]);
  });

  test("open issues quiet for two weeks auto-resolve; others are left alone", () => {
    const quiet = ago(24 * RULES.resolveAfterQuietDays);
    expect(
      plan([], [issue({ status: "regressed", last_seen: quiet })])
    ).toEqual([
      {
        action: "update",
        id: 7,
        fingerprint: FP(1),
        metadata: {
          status: "resolved",
          resolved_at: NOW.toISOString(),
          resolution: "auto",
        },
      },
    ]);
    expect(plan([], [issue({ last_seen: ago(24 * 13) })])).toEqual([]);
    expect(plan([], [issue({ status: "ignored", last_seen: quiet })])).toEqual(
      []
    );
    expect(
      plan(
        [],
        [issue({ status: "resolved", last_seen: quiet, resolved_at: quiet })]
      )
    ).toEqual([]);
  });

  test("a board resolution without its time is stamped, then can regress", () => {
    const stamped = { resolved_at: NOW.toISOString() };
    // Resolved on the board: only status changed.
    const [seen] = plan([occ()], [issue({ status: "resolved" })]);
    expect(seen).toMatchObject({ metadata: stamped });
    expect(seen).not.toHaveProperty("alert");
    expect(seen).not.toHaveProperty("metadata.status");
    expect(plan([], [issue({ status: "resolved" })])).toEqual([
      { action: "update", id: 7, fingerprint: FP(1), metadata: stamped },
    ]);
    // Re-resolved after a regression: the old resolved_at is stale.
    const reResolved = issue({
      status: "resolved",
      resolved_at: ago(48),
      regressed_at: ago(24),
    });
    expect(plan([], [reResolved])[0]).toMatchObject({ metadata: stamped });
    // Once stamped, a later occurrence regresses.
    expect(
      plan([occ()], [{ ...reResolved, resolved_at: ago(0.5) }])[0]
    ).toMatchObject({
      metadata: { status: "regressed" },
      alert: { kind: "regressed" },
    });
  });

  test("a deleted issue suppresses its fingerprint", () => {
    const deleted = issue({ deleted: true });
    expect(plan([occ()], [deleted])).toEqual([]);
    expect(
      plan([], [{ ...deleted, status: "regressed", last_seen: ago(24 * 30) }])
    ).toEqual([]);
    // A live record for the same fingerprint wins over a tombstone.
    expect(plan([occ()], [deleted, issue({ id: 8 })])[0]).toMatchObject({
      action: "update",
      id: 8,
    });
  });
});

describe("runIssueTracker", () => {
  test("looks up the request behind a logged error from its sample trace", async () => {
    const trace = "a".repeat(32);
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.includes("issue_occurrences_hourly"))
          return [
            {
              fingerprint: FP(1),
              kind: "system",
              issue_title: "LoggedError: OAuth token exchange failed",
              issue_culprit: "log lobu-server",
              seen_2h: 1,
              seen_24h: 1,
              seen_14d: 1,
              max_orgs: 0,
              max_users: 0,
              releases_2h: [],
              last_release: "rel",
              sample_trace_id: trace,
              first_seen_at: ago(1),
              last_seen_at: ago(0.5),
            },
            {
              fingerprint: FP(2),
              kind: "system",
              issue_title: "LoggedError: unrelated",
              issue_culprit: "log lobu-server",
              seen_2h: 1,
              seen_24h: 1,
              seen_14d: 1,
              max_orgs: 0,
              max_users: 0,
              releases_2h: [],
              last_release: "rel",
              sample_trace_id: "not-a-trace-id'",
              first_seen_at: ago(1),
              last_seen_at: ago(0.5),
            },
            {
              fingerprint: FP(3),
              kind: "dependency",
              issue_source: "browser",
              issue_title: "TypeError: Load failed",
              issue_culprit: "browser GET /api/:s/x",
              seen_2h: 2,
              seen_24h: 25,
              seen_14d: 25,
              max_orgs: 0,
              max_users: 0,
              releases_2h: [],
              last_release: "rel",
              sample_trace_id: "",
              first_seen_at: ago(20),
              last_seen_at: ago(0.5),
            },
          ];
        if (text.includes("otel_traces"))
          return [{ trace_id: trace, request: "GET /connect/oauth/callback" }];
        if (text.includes("count(*)")) return [{ n: 0 }];
        return [];
      },
    };
    const result = (await runIssueTracker(
      { window: { automation_id: 1, run_id: 1 } } as never,
      client as never,
      true
    )) as {
      created: number;
      changes: Array<{
        fingerprint: string;
        metadata?: Record<string, unknown>;
      }>;
    };
    // The browser request failure has volume but no spike, so only FP(1) is new.
    expect(result.created).toBe(1);
    expect(result.changes[0]).toMatchObject({
      fingerprint: FP(1),
      metadata: { priority: "high" },
    });
    // Only well-formed trace ids reach the lookup.
    const lookup = sql.find((text) => text.includes("otel_traces"));
    expect(lookup).toContain(`'${trace}'`);
    expect(lookup).not.toContain("not-a-trace-id");
  });

  test("a failed health sweep never blocks occurrence ingestion", async () => {
    const client = {
      query: async (text: string) => {
        if (text.includes("issue_occurrences_hourly"))
          return [
            {
              fingerprint: FP(1),
              kind: "system",
              issue_title: "Error: boom",
              issue_culprit: "GET /x",
              seen_2h: 1,
              seen_24h: RULES.systemMinSeen24h,
              seen_14d: RULES.systemMinSeen24h,
              max_orgs: 1,
              max_users: 1,
              releases_2h: ["rel-b"],
              last_release: "rel-b",
              sample_trace_id: "",
              first_seen_at: ago(3),
              last_seen_at: ago(0.1),
            },
          ];
        if (text.includes("health_snapshot"))
          throw new Error("health source unavailable");
        if (text.includes("count(*)")) return [{ n: 0 }];
        return [];
      },
    };
    const result = (await runIssueTracker(
      { window: { automation_id: 1, run_id: 1 } } as never,
      client as never,
      true,
      {
        ownerUserId: "synthetic-owner",
        connection: "synthetic",
        workspaces: ["kept"],
      }
    )) as {
      created: number;
      health_error: string | null;
      changes: Array<{ action: string; fingerprint: string }>;
    };
    expect(result.health_error).toContain("health source unavailable");
    expect(result.created).toBe(1);
    expect(result.changes[0]).toMatchObject({
      action: "create",
      fingerprint: FP(1),
    });
  });

  test("the default entrypoint keeps ingesting when the owner lookup fails", async () => {
    const notices: Array<{ title?: string }> = [];
    const created: Array<{ entity_type?: string }> = [];
    const client = {
      query: async (text: string) => {
        if (text.includes("SELECT created_by FROM automations"))
          throw new Error(
            "the source is busy (3 reads running, 4 waiting); retry in 5s"
          );
        if (text.includes("issue_occurrences_hourly"))
          return [
            {
              fingerprint: FP(1),
              kind: "system",
              issue_title: "Error: boom",
              issue_culprit: "GET /x",
              seen_2h: 1,
              seen_24h: RULES.systemMinSeen24h,
              seen_14d: RULES.systemMinSeen24h,
              max_orgs: 1,
              max_users: 1,
              releases_2h: ["rel-b"],
              last_release: "rel-b",
              sample_trace_id: "",
              first_seen_at: ago(3),
              last_seen_at: ago(0.1),
            },
          ];
        if (text.includes("count(*)")) return [{ n: 0 }];
        return [];
      },
      notifications: {
        send: async (input: { title?: string }) => {
          notices.push(input);
          return { delivered: true };
        },
      },
      entities: {
        create: async (input: { entity_type?: string }) => {
          created.push(input);
          return { entity: { id: 1 } };
        },
        update: async () => ({}),
      },
    };
    const result = (await trackIssues(
      {
        window: { automation_id: 1, run_id: 1 },
        organization_id: "synthetic-org",
      } as never,
      client as never,
      { health: { connection: "synthetic", workspaces: ["kept"] } }
    )) as { created: number; health_error: string | null };
    expect(result.health_error).toContain("the source is busy");
    expect(result.created).toBe(1);
    expect(created).toHaveLength(1);
    expect(notices).toContainEqual(
      expect.objectContaining({ title: "Issue tracker health sweep failed" })
    );
  });
});

test("a missing scope workspace is named in the snapshot error", async () => {
  const client = {
    query: async () => [{ workspace: "kept", kind: "scope" }],
  };
  await expect(
    readHealthSnapshot(client as never, {
      ownerUserId: "synthetic-owner",
      connection: "synthetic",
      workspaces: ["kept", "removed"],
    })
  ).rejects.toThrow("Health scope workspaces are no longer owned: removed");
});

describe("workspace health conditions", () => {
  const resource = (
    state: HealthResource["state"],
    kind: HealthResource["kind"] = "automation"
  ): HealthResource => ({
    workspace: "synthetic-owned",
    kind,
    resource_id: "42",
    fingerprint: FP(42),
    name: "Synthetic work",
    state,
  });
  test("detects silent, paused and repeated failures without charging transient retries", () => {
    expect(
      healthProblem(resource({ triggers: [{}], next_run_at: ago(2) }), NOW)
    ).toBe("overdue");
    expect(
      healthProblem(
        resource({ triggers: [{}], next_run_at: ago(0.5), failures: 1 }),
        NOW
      )
    ).toBeNull();
    expect(
      healthProblem(resource({ triggers: [{}], paused_at: ago(2) }), NOW)
    ).toBe("schedule_auto_paused");
    expect(
      healthProblem(resource({ triggers: [], tags: ["manual"] }), NOW)
    ).toBeNull();
    expect(healthProblem(resource({ triggers: [] }), NOW)).toBeNull();
    expect(healthProblem(resource({ triggers: [{}], failures: 3 }), NOW)).toBe(
      "repeated_failures"
    );
    expect(
      healthProblem(resource({ status: "active", failures: 1 }, "feed"), NOW)
    ).toBeNull();
    expect(
      healthProblem(resource({ status: "paused", failures: 3 }, "feed"), NOW)
    ).toBe("paused_after_failures");
    expect(
      healthProblem(resource({ status: "paused", failures: 0 }, "feed"), NOW)
    ).toBeNull();
    expect(
      healthProblem(
        resource({ status: "active", next_run_at: ago(2) }, "feed"),
        NOW
      )
    ).toBeNull();
    expect(
      healthProblem(
        resource(
          { status: "active", schedule: "* * * * *", next_run_at: ago(2) },
          "feed"
        ),
        NOW
      )
    ).toBe("overdue");
    expect(
      healthProblem(
        resource({ status: "active", auth_status: "revoked" }, "connection"),
        NOW
      )
    ).toBe("connection_unavailable");
  });
  test("ignores remain suppressed and telemetry quiet never resolves a health issue", () => {
    const i = issue({
      fingerprint: FP(42),
      status: "ignored",
      culprit: "workspace-health:synthetic-owned:automation:42",
    });
    const [change] = planHealthChanges(
      [resource({ triggers: [], failures: 3 })],
      [i],
      NOW
    );
    expect(change).not.toHaveProperty("metadata.status");
    expect(
      plan([], [{ ...i, status: "ongoing", last_seen: ago(24 * 30) }])
    ).toEqual([]);
    expect(
      planHealthChanges(
        [resource({ triggers: [{}], success_at: ago(2) })],
        [{ ...i, status: "ongoing" }],
        NOW
      )
    ).toEqual([]);
    expect(
      planHealthChanges(
        [resource({ triggers: [{}], success_at: ago(0.1) })],
        [{ ...i, status: "ongoing" }],
        NOW
      )[0]
    ).toMatchObject({ metadata: { status: "resolved" } });
    expect(
      planHealthChanges(
        [resource({ triggers: [] })],
        [{ ...i, deleted: true }],
        NOW
      )
    ).toEqual([]);
  });
});

test("installed bundles are portable across build-machine paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foreign-build-machine-"));
  try {
    const entrypoint = join(directory, "foreign-entry.ts");
    const source = fileURLToPath(
      new URL("../issue-tracker.reaction.ts", import.meta.url)
    );
    await writeFile(entrypoint, `export * from ${JSON.stringify(source)};`);
    const bundle = await buildIssueRepair(
      {
        ownerUserId: "synthetic-owner",
        workspaces: ["synthetic-owned"],
        connection: "synthetic-health",
      },
      entrypoint
    );
    const bytes = JSON.stringify(bundle);
    for (const path of [directory, source]) {
      expect(bytes).not.toContain(path);
      expect(bytes).not.toContain(pathToFileURL(path).href);
      expect(bytes).not.toContain(encodeURIComponent(path));
    }
    expect(bytes).not.toMatch(/foreign-build-machine|\/Users\/|\/home\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
