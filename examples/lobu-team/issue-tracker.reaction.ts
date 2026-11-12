import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

/**
 * Promotes ClickHouse error fingerprints into `issue` records and runs their
 * lifecycle, with no agent turn. ClickHouse keeps every occurrence; only a
 * fingerprint past a noise gate becomes an issue. External agents triage
 * issues and link the `task` that tracks a fix.
 *
 * Set DRY_RUN to true to have the job write nothing and return the planned
 * changes as its run result, for reviewing a rule change before it applies.
 */
export const DRY_RUN = false;

const CONNECTION = "lobu-analytics";
/** The client.query row cap for Postgres reads. */
const MAX_ISSUE_ROWS = 5000;
const ENVIRONMENT = "summaries-prod";

export const RULES = {
  /** system/dependency: sightings in 24h, or distinct orgs in one hour. */
  systemMinSeen24h: 3,
  systemMinOrgs: 2,
  /** user errors are usually correct rejections: only a spike is an issue. */
  userMinSeen24h: 20,
  userMinOrgs: 3,
  /** New issues per hour; the rest wait for a later run. */
  maxNewPerHour: 5,
  /** high priority for a system/dependency issue at this volume or reach. */
  highMinSeen24h: 20,
  highMinOrgs: 3,
  /**
   * Sign-in and consent routes. A failure here locks a user out before they
   * reach the product, often once per person, so one sighting is an issue.
   */
  blockingCulprit: /^[A-Z]+ \/(connect|oauth|api\/auth)(\/|$)/,
  newForDays: 7,
  resolveAfterQuietDays: 14,
  /** escalating: the last two hours' hourly rate vs the prior 13 days. */
  escalateMinPerHour: 10,
  escalateFactor: 5,
} as const;

export type IssueStatus =
  | "new"
  | "ongoing"
  | "escalating"
  | "regressed"
  | "resolved"
  | "ignored";
export type ErrorKind = "system" | "user" | "dependency";

/** One fingerprint seen in the last two hours, with its trailing stats. */
export interface Occurrence {
  fingerprint: string;
  kind: ErrorKind;
  title: string;
  culprit: string;
  message: string;
  first_seen: string;
  last_seen: string;
  seen_2h: number;
  seen_24h: number;
  seen_14d: number;
  max_orgs: number;
  max_users: number;
  releases_2h: string[];
  last_release: string;
  sample_trace_id: string;
}

export interface IssueRecord {
  id: number;
  fingerprint: string;
  status: IssueStatus;
  first_seen?: string;
  last_seen?: string;
  resolved_at?: string;
  regressed_at?: string;
  escalated_at?: string;
  resolved_in_release?: string;
  ignore_until?: string;
  /** Soft-deleted: its slug stays taken, so the fingerprint stays suppressed. */
  deleted?: boolean;
}

export type Alert = "new_high" | "regressed" | "escalating";
type AlertNotice = { kind: Alert; key: string; title: string };

export type IssueChange =
  | {
      action: "create";
      fingerprint: string;
      name: string;
      metadata: Record<string, unknown>;
      alert?: AlertNotice;
    }
  | {
      action: "update";
      id: number;
      fingerprint: string;
      metadata: Record<string, unknown>;
      alert?: AlertNotice;
    }
  | { action: "defer"; fingerprint: string; reason: "hourly_quota" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

const blocksSignIn = (o: Occurrence) =>
  o.kind !== "user" && RULES.blockingCulprit.test(o.culprit);

function passesGate(o: Occurrence): boolean {
  if (blocksSignIn(o)) return true;
  return o.kind === "user"
    ? o.seen_24h >= RULES.userMinSeen24h || o.max_orgs >= RULES.userMinOrgs
    : o.seen_24h >= RULES.systemMinSeen24h || o.max_orgs >= RULES.systemMinOrgs;
}

function priority(o: Occurrence): "high" | "medium" | "low" {
  if (o.kind === "user") return "low";
  return blocksSignIn(o) ||
    o.seen_24h >= RULES.highMinSeen24h ||
    o.max_orgs >= RULES.highMinOrgs
    ? "high"
    : "medium";
}

function isEscalating(o: Occurrence): boolean {
  // No sightings before the last day means no baseline to rise above: a
  // fingerprint first seen today (or regrouped by a release) is new.
  if (o.seen_14d <= o.seen_24h) return false;
  const rate = o.seen_2h / 2;
  const baseline = Math.max(1, (o.seen_14d - o.seen_24h) / (13 * 24));
  return (
    rate >= RULES.escalateMinPerHour && rate >= RULES.escalateFactor * baseline
  );
}

/** Fields this job owns; triage and agent fields are never written here. */
function snapshot(o: Occurrence, now: Date): Record<string, unknown> {
  return {
    last_seen: o.last_seen,
    seen_24h: o.seen_24h,
    seen_14d: o.seen_14d,
    affected_orgs: o.max_orgs,
    affected_users: o.max_users,
    last_release: o.last_release,
    sample_trace_id: o.sample_trace_id,
    observed_at: now.toISOString(),
  };
}

function ageStatus(issue: IssueRecord, now: Date): "new" | "ongoing" {
  const first = ms(issue.first_seen);
  return Number.isFinite(first) &&
    now.getTime() - first < RULES.newForDays * DAY
    ? "new"
    : "ongoing";
}

/**
 * When the current resolution happened, or NaN if unknown. Moving a card to
 * `resolved` on the board sets only status, so resolved_at is missing, or
 * still names the resolution before the last regression.
 */
function resolutionTime(issue: IssueRecord): number {
  const resolved = ms(issue.resolved_at);
  const regressed = ms(issue.regressed_at);
  return Number.isFinite(regressed) && !(resolved > regressed)
    ? Number.NaN
    : resolved;
}

/** A resolved issue with no usable resolved_at is resolved as of this run. */
function stampResolution(issue: IssueRecord, now: Date) {
  return issue.status === "resolved" && !Number.isFinite(resolutionTime(issue))
    ? { resolved_at: now.toISOString() }
    : null;
}

/**
 * Decide every create, update and alert for one run. Pure: the same inputs
 * always give the same plan. `createdLastHour` counts issues already created
 * in the trailing hour, so the quota holds across runs.
 */
export function planIssueChanges(
  occurrences: Occurrence[],
  issues: IssueRecord[],
  now: Date,
  createdLastHour: number
): IssueChange[] {
  const byFingerprint = new Map<string, IssueRecord>();
  for (const i of issues) {
    const held = byFingerprint.get(i.fingerprint);
    if (!held || (held.deleted && !i.deleted))
      byFingerprint.set(i.fingerprint, i);
  }
  const seen = new Set<string>();
  const changes: IssueChange[] = [];
  let quota = Math.max(0, RULES.maxNewPerHour - createdLastHour);
  // Sign-in failures first, so a busy hour cannot defer them past the quota.
  const ordered = [...occurrences].sort(
    (a, b) =>
      Number(blocksSignIn(b)) - Number(blocksSignIn(a)) ||
      b.seen_24h - a.seen_24h ||
      a.fingerprint.localeCompare(b.fingerprint)
  );

  for (const o of ordered) {
    seen.add(o.fingerprint);
    const issue = byFingerprint.get(o.fingerprint);
    if (issue?.deleted) continue;
    if (!issue) {
      if (!passesGate(o)) continue;
      if (quota === 0) {
        changes.push({
          action: "defer",
          fingerprint: o.fingerprint,
          reason: "hourly_quota",
        });
        continue;
      }
      quota--;
      const level = priority(o);
      changes.push({
        action: "create",
        fingerprint: o.fingerprint,
        name: o.title,
        metadata: {
          fingerprint: o.fingerprint,
          status: isEscalating(o) ? "escalating" : "new",
          kind: o.kind,
          priority: level,
          culprit: o.culprit,
          message: o.message,
          first_seen: o.first_seen,
          first_release: o.last_release,
          ...snapshot(o, now),
        },
        ...(level === "high"
          ? {
              alert: {
                kind: "new_high" as const,
                key: `issue-new:${o.fingerprint}`,
                title: `New high-priority issue: ${o.title} (${o.culprit})`,
              },
            }
          : {}),
      });
      continue;
    }

    const metadata = snapshot(o, now);
    let alert: AlertNotice | undefined;
    const set = (status: IssueStatus) => {
      if (status !== issue.status) metadata.status = status;
    };

    if (issue.status === "ignored") {
      if (issue.ignore_until && ms(issue.ignore_until) <= now.getTime())
        set(ageStatus(issue, now));
    } else if (issue.status === "resolved") {
      const stamp = stampResolution(issue, now);
      // A fix release names where the error must stop. Until it is deployed,
      // the old release still emitting it is expected, not a regression.
      const after = ms(o.last_seen) > resolutionTime(issue);
      const regressed = issue.resolved_in_release
        ? after && o.releases_2h.includes(issue.resolved_in_release)
        : after;
      if (stamp) {
        Object.assign(metadata, stamp);
      } else if (regressed) {
        set("regressed");
        metadata.regressed_at = now.toISOString();
        alert = {
          kind: "regressed",
          key: `issue:${o.fingerprint}:regressed:${issue.resolved_at}`,
          title: `Issue regressed: ${o.title}`,
        };
      }
    } else if (isEscalating(o)) {
      if (issue.status !== "escalating") {
        set("escalating");
        // At most one alert a day, counted from the last alert: escalated_at
        // moves only when one is sent, so flapping cannot postpone the next.
        // The key is the stored escalation it follows, so a retry after a
        // failed write repeats the same key.
        const sinceLast = now.getTime() - ms(issue.escalated_at);
        if (Number.isNaN(sinceLast) || sinceLast >= DAY) {
          metadata.escalated_at = now.toISOString();
          alert = {
            kind: "escalating",
            key: `issue:${o.fingerprint}:escalating:${issue.escalated_at ?? "first"}`,
            title: `Issue escalating: ${o.title}`,
          };
        }
      }
    } else if (issue.status === "escalating" || issue.status === "new") {
      set(ageStatus(issue, now));
    }

    changes.push({
      action: "update",
      id: issue.id,
      fingerprint: o.fingerprint,
      metadata,
      ...(alert ? { alert } : {}),
    });
  }

  for (const issue of byFingerprint.values()) {
    if (seen.has(issue.fingerprint) || issue.deleted) continue;
    const stamp = stampResolution(issue, now);
    if (stamp) {
      changes.push({
        action: "update",
        id: issue.id,
        fingerprint: issue.fingerprint,
        metadata: stamp,
      });
      continue;
    }
    const quietFor = now.getTime() - ms(issue.last_seen);
    if (
      ["new", "ongoing", "escalating", "regressed"].includes(issue.status) &&
      quietFor >= RULES.resolveAfterQuietDays * DAY
    ) {
      changes.push({
        action: "update",
        id: issue.id,
        fingerprint: issue.fingerprint,
        metadata: {
          status: "resolved",
          resolved_at: now.toISOString(),
          resolution: "auto",
        },
      });
    } else if (issue.status === "escalating") {
      changes.push({
        action: "update",
        id: issue.id,
        fingerprint: issue.fingerprint,
        metadata: { status: ageStatus(issue, now) },
      });
    }
  }
  return changes;
}

// Aliases must not reuse a column name: ClickHouse would substitute the
// aggregate into the other aggregates that read that column.
const OCCURRENCES_SQL = `
SELECT
  fingerprint,
  argMax(error_kind, last_seen) AS kind,
  argMax(title, last_seen) AS issue_title,
  argMax(culprit, last_seen) AS issue_culprit,
  argMax(sample_message, last_seen) AS message,
  formatDateTime(min(first_seen), '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS first_seen_at,
  formatDateTime(max(last_seen), '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS last_seen_at,
  toUInt64(sumIf(occurrences, hour >= now() - INTERVAL 2 HOUR)) AS seen_2h,
  toUInt64(sumIf(occurrences, hour >= now() - INTERVAL 24 HOUR)) AS seen_24h,
  toUInt64(sum(occurrences)) AS seen_14d,
  toUInt64(maxIf(affected_orgs, hour >= now() - INTERVAL 24 HOUR)) AS max_orgs,
  toUInt64(maxIf(affected_users, hour >= now() - INTERVAL 24 HOUR)) AS max_users,
  groupUniqArrayIf(10)(release, hour >= now() - INTERVAL 2 HOUR) AS releases_2h,
  argMax(release, last_seen) AS last_release,
  argMax(sample_trace_ids[1], last_seen) AS sample_trace_id
FROM observability.issue_occurrences_hourly FINAL
WHERE hour >= now() - INTERVAL 14 DAY
  AND environment = '${ENVIRONMENT}'
GROUP BY fingerprint
HAVING max(last_seen) >= now() - INTERVAL 2 HOUR
ORDER BY seen_24h DESC, fingerprint
LIMIT 400`;

// Tombstones included: a deleted issue still holds its slug.
const ISSUES_SQL = `
SELECT id, metadata, deleted_at IS NOT NULL AS deleted
FROM entities
WHERE entity_type = 'issue'`;

const CREATED_LAST_HOUR_SQL = `
SELECT count(*)::int AS n
FROM entities
WHERE entity_type = 'issue' AND created_at >= NOW() - INTERVAL '1 hour'`;

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function toOccurrence(row: Record<string, unknown>): Occurrence {
  const kind = str(row.kind);
  return {
    fingerprint: str(row.fingerprint),
    kind: kind === "user" || kind === "dependency" ? kind : "system",
    title: str(row.issue_title).slice(0, 200) || "Untitled error",
    culprit: str(row.issue_culprit),
    message: str(row.message).slice(0, 1000),
    first_seen: str(row.first_seen_at),
    last_seen: str(row.last_seen_at),
    seen_2h: num(row.seen_2h),
    seen_24h: num(row.seen_24h),
    seen_14d: num(row.seen_14d),
    max_orgs: num(row.max_orgs),
    max_users: num(row.max_users),
    releases_2h: Array.isArray(row.releases_2h)
      ? row.releases_2h.map(String)
      : [],
    last_release: str(row.last_release),
    sample_trace_id: str(row.sample_trace_id),
  };
}

function toIssue(row: Record<string, unknown>): IssueRecord | null {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const fingerprint = str(m.fingerprint);
  if (!fingerprint) return null;
  return {
    id: num(row.id),
    fingerprint,
    status: (str(m.status) || "ongoing") as IssueStatus,
    first_seen: str(m.first_seen) || undefined,
    last_seen: str(m.last_seen) || undefined,
    resolved_at: str(m.resolved_at) || undefined,
    regressed_at: str(m.regressed_at) || undefined,
    escalated_at: str(m.escalated_at) || undefined,
    resolved_in_release: str(m.resolved_in_release) || undefined,
    ignore_until: str(m.ignore_until) || undefined,
    deleted: row.deleted === true,
  };
}

export async function runIssueTracker(
  ctx: Pick<ReactionContext, "window">,
  client: ReactionClient,
  dryRun: boolean
): Promise<Record<string, unknown>> {
  const now = new Date();
  const occurrences = (
    (await client.query(OCCURRENCES_SQL, { connection: CONNECTION })) as Record<
      string,
      unknown
    >[]
  ).map(toOccurrence);
  const issueRows = (await client.query(ISSUES_SQL)) as Record<
    string,
    unknown
  >[];
  // client.query caps Postgres reads without an error. A truncated read would
  // make existing fingerprints look new, so stop instead of guessing.
  if (issueRows.length >= MAX_ISSUE_ROWS)
    throw new Error(
      `Read ${issueRows.length} issue records, the client.query cap; archive or delete old issues before the tracker can run`
    );
  const issues = issueRows
    .map(toIssue)
    .filter((i): i is IssueRecord => i !== null);
  const [{ n: createdLastHour } = { n: 0 }] = (await client.query(
    CREATED_LAST_HOUR_SQL
  )) as Array<{ n: number }>;

  const changes = planIssueChanges(occurrences, issues, now, createdLastHour);
  const summary = {
    dry_run: dryRun,
    fingerprints: occurrences.length,
    issues: issues.filter((i) => !i.deleted).length,
    created: changes.filter((c) => c.action === "create").length,
    updated: changes.filter((c) => c.action === "update").length,
    deferred: changes.filter((c) => c.action === "defer").length,
    alerts: changes.filter((c) => c.action !== "defer" && c.alert).length,
  };
  if (dryRun) return { ...summary, changes: changes.slice(0, 50) };

  const source = {
    automation_id: ctx.window.automation_id,
    run_id: ctx.window.run_id,
  };
  // Each change stands alone: one failed write must not hold back the rest.
  // The run still fails afterwards, so the task retries and the error shows.
  const failures: string[] = [];
  for (const change of changes) {
    try {
      await applyChange(change, client, source);
    } catch (error) {
      failures.push(
        `${change.action} ${change.fingerprint}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (failures.length)
    throw new Error(
      `${failures.length} of ${changes.length} issue changes failed: ${failures.slice(0, 5).join("; ")}`
    );
  return summary;
}

async function applyChange(
  change: IssueChange,
  client: ReactionClient,
  source: { automation_id: number; run_id: number }
): Promise<void> {
  // Alert before the write: once the record exists the planner never builds
  // this alert again, so a send that failed after the write would be lost.
  // The idempotency key collapses a repeat send.
  if (change.action !== "defer" && change.alert)
    await client.notifications.send({
      title: change.alert.title.slice(0, 160),
      body: `Fingerprint ${change.fingerprint}. Open the issue record for its occurrences and linked tasks.`,
      recipients: "admins",
      idempotency_key: change.alert.key,
      automation_source: source,
    });
  if (change.action === "create") {
    await client.entities.create({
      entity_type: "issue",
      name: change.name,
      slug: `issue-${change.fingerprint}`,
      metadata: change.metadata,
      automation_source: source,
    });
  } else if (change.action === "update") {
    await client.entities.update({
      entity_id: change.id,
      metadata: change.metadata,
      automation_source: source,
    });
  }
}

export default async function trackIssues(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<Record<string, unknown>> {
  return runIssueTracker(ctx, client, DRY_RUN);
}
