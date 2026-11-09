import { describe, expect, test } from "bun:test";
import {
  type IssueRecord,
  type Occurrence,
  planIssueChanges,
  RULES,
} from "../issue-tracker.reaction";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const ago = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const FP = (n: number) => n.toString(16).padStart(32, "0");

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    fingerprint: FP(1),
    kind: "system",
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
    const [created] = plan([occ()], []);
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

  test("volume or reach makes a system issue high priority", () => {
    expect(
      plan([occ({ seen_24h: RULES.highMinSeen24h })], [])[0]
    ).toMatchObject({
      metadata: { priority: "high" },
    });
    expect(
      plan([occ({ kind: "dependency", max_orgs: RULES.highMinOrgs })], [])[0]
    ).toMatchObject({
      metadata: { priority: "high" },
    });
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
