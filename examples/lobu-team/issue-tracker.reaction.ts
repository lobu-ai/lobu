import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
/** Explicit installation inputs, stored on the Automation, never shared IDs. */
export interface HealthScope {
  ownerUserId: string;
  workspaces: string[];
  connection: string;
}

export const HEALTH_PREFIX = "workspace-health:";
const CAP = 5000;
const GRACE = 45 * 60_000;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Bounded configuration snapshots only; no run/event history scans. Ownership
 * is rechecked on every sweep. The allowlist comes from the installing caller's
 * authorized workspaces, not every org visible through the production source. */
export function healthSnapshotSql(scope: HealthScope): string {
  if (
    !scope.ownerUserId ||
    !scope.connection ||
    !scope.workspaces.length ||
    scope.workspaces.length > 100
  )
    throw new Error(
      "Health scope requires an owner, source and 1–100 workspaces"
    );
  return `SELECT * FROM (
WITH owned AS (
  SELECT o.id, o.slug FROM organization o JOIN member m ON m."organizationId" = o.id
  WHERE m."userId" = ${quote(scope.ownerUserId)} AND m.role = 'owner'
    AND o.slug IN (${scope.workspaces.map(quote).join(",")})
), resources AS (
  SELECT o.slug AS workspace, o.id AS org_id, 'scope' AS kind, o.id AS resource_id,
    o.slug AS name, '{}'::jsonb AS state FROM owned o
  UNION ALL
  SELECT o.slug, o.id, 'automation', a.id::text, a.name,
    jsonb_build_object('status', a.status, 'triggers', a.triggers, 'tags', a.tags,
      'paused_at', a.schedule_auto_paused_at, 'failures', a.consecutive_scheduled_failures,
      'next_run_at', a.next_run_at, 'success_at', a.last_run_completed_at,
      'executor', a.execution_config->'executor'->>'kind')
  FROM automations a JOIN owned o ON o.id = a.organization_id WHERE a.status = 'active'
  UNION ALL
  SELECT o.slug, o.id, 'feed', f.id::text, COALESCE(f.display_name, f.feed_key),
    jsonb_build_object('status', f.status, 'schedule', f.schedule,
      'failures', f.consecutive_failures, 'next_run_at', f.next_run_at,
      'connection_status', c.status, 'last_sync_status', f.last_sync_status,
      'success_at', CASE WHEN f.last_sync_status = 'success' THEN f.last_sync_at END)
  FROM feeds f JOIN owned o ON o.id = f.organization_id
    JOIN connections c ON c.id = f.connection_id AND c.organization_id = f.organization_id
  WHERE f.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status <> 'paused'
    AND (c.visibility = 'org' OR c.created_by = ${quote(scope.ownerUserId)})
  UNION ALL
  SELECT o.slug, o.id, 'connection', c.id::text, COALESCE(c.display_name, c.slug),
    jsonb_build_object('status', c.status, 'auth_status', p.status)
  FROM connections c JOIN owned o ON o.id = c.organization_id
    LEFT JOIN auth_profiles p ON p.id = c.auth_profile_id AND p.organization_id = c.organization_id
  WHERE c.deleted_at IS NULL AND c.status <> 'paused'
    AND (c.visibility = 'org' OR c.created_by = ${quote(scope.ownerUserId)})
    AND EXISTS (SELECT 1 FROM feeds f WHERE f.connection_id = c.id
      AND f.organization_id = c.organization_id AND f.deleted_at IS NULL
      -- Auth propagation can pause feeds without incrementing failures.
      AND (f.status IN ('active', 'paused') OR f.consecutive_failures >= 3))
)
SELECT workspace, kind, resource_id, name, state,
  md5('workspace-health:v1:' || org_id || ':' || kind || ':' || resource_id) AS fingerprint
FROM resources ORDER BY workspace, kind, resource_id LIMIT ${CAP}
) health_snapshot`;
}

export interface HealthResource {
  workspace: string;
  kind: "scope" | "automation" | "feed" | "connection";
  resource_id: string;
  fingerprint: string;
  name: string;
  state: {
    status?: string;
    triggers?: unknown[];
    tags?: string[];
    paused_at?: string;
    failures?: number;
    next_run_at?: string;
    success_at?: string;
    schedule?: string;
    connection_status?: string;
    auth_status?: string;
    last_sync_status?: string;
    executor?: string;
  };
}

export function healthProblem(r: HealthResource, now: Date): string | null {
  const s = r.state;
  const overdue = now.getTime() - Date.parse(s.next_run_at ?? "") > GRACE;
  if (r.kind === "automation") {
    if (s.paused_at) return "schedule_auto_paused";
    // Triggerless Automations are valid manual jobs. Absence of a schedule is
    // not enough to infer an outage or invent a schedule for its owner.
    if (overdue) return "overdue";
    if ((s.failures ?? 0) >= 3) return "repeated_failures";
  } else if (r.kind === "feed") {
    if ((s.failures ?? 0) >= 3)
      return s.status === "paused"
        ? "paused_after_failures"
        : "repeated_failures";
    if (s.status === "active" && s.schedule && overdue) return "overdue";
    if (s.status === "error") return "error";
  } else if (r.kind === "connection") {
    if (
      ["pending_auth", "revoked", "error"].includes(s.status ?? "") ||
      (s.auth_status && s.auth_status !== "active")
    )
      return "connection_unavailable";
  }
  return null;
}

/** A quiet log or changed schedule is not recovery. Connection readiness alone
 * likewise cannot prove a feed read; its issues stay open for human/agent proof. */
export function planHealthChanges(
  resources: HealthResource[],
  issues: IssueRecord[],
  now: Date
): IssueChange[] {
  const changes: IssueChange[] = [];
  const byFingerprint = new Map(issues.map((i) => [i.fingerprint, i]));
  for (const r of resources) {
    if (r.kind === "scope") continue;
    const issue = byFingerprint.get(r.fingerprint);
    if (issue?.deleted) continue;
    const problem = healthProblem(r, now);
    const culprit = `${HEALTH_PREFIX}${r.workspace}:${r.kind}:${r.resource_id}`;
    const message = JSON.stringify({
      workspace: r.workspace,
      resource: r.kind,
      id: r.resource_id,
      problem,
      ...r.state,
    });
    if (problem) {
      const metadata: Record<string, unknown> = {
        culprit,
        message,
        observed_at: now.toISOString(),
        last_seen: now.toISOString(),
      };
      if (!issue) {
        changes.push({
          action: "create",
          fingerprint: r.fingerprint,
          name: `${r.workspace}: ${r.name} (${problem})`.slice(0, 200),
          metadata: {
            ...metadata,
            fingerprint: r.fingerprint,
            status: "new",
            kind: "system",
            priority: "medium",
            first_seen: now.toISOString(),
            affected_orgs: 1,
          },
        });
      } else {
        if (issue.status === "resolved") {
          metadata.status = "regressed";
          metadata.regressed_at = now.toISOString();
        } else if (
          issue.status === "ignored" &&
          issue.ignore_until &&
          Date.parse(issue.ignore_until) <= now.getTime()
        )
          metadata.status = "ongoing";
        else if (
          issue.status === "new" &&
          now.getTime() - Date.parse(issue.first_seen ?? "") >= 7 * 86_400_000
        )
          metadata.status = "ongoing";
        changes.push({
          action: "update",
          id: issue.id,
          fingerprint: r.fingerprint,
          metadata,
          expected: { status: issue.status },
        });
      }
    } else if (
      issue &&
      !["resolved", "ignored"].includes(issue.status) &&
      Date.parse(r.state.success_at ?? "") >
        Date.parse(issue.last_seen ?? issue.first_seen ?? "")
    ) {
      changes.push({
        action: "update",
        id: issue.id,
        fingerprint: r.fingerprint,
        expected: { status: issue.status },
        metadata: {
          status: "resolved",
          resolution: "auto",
          resolved_at: now.toISOString(),
          observed_at: now.toISOString(),
          message,
        },
      });
    }
  }
  return changes;
}

export async function readHealthSnapshot(
  client: ReactionClient,
  scope: HealthScope
): Promise<HealthResource[]> {
  const rows = (await client.query(healthSnapshotSql(scope), {
    connection: scope.connection,
  })) as HealthResource[];
  if (rows.length >= CAP)
    throw new Error(
      "Health scope snapshot reached its cap; narrow scope before retrying"
    );
  const owned = new Set(
    rows.filter((r) => r.kind === "scope").map((r) => r.workspace)
  );
  const missing = scope.workspaces.filter((s) => !owned.has(s));
  if (missing.length > 0)
    throw new Error(
      `Health scope workspaces are no longer owned: ${missing.join(", ")}`
    );
  return rows;
}

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
/**
 * Cloudflare's own 5xx are recorded per zone, not per namespace: the product's
 * zone is the one a visitor of this environment reaches.
 */
const EDGE_ZONE = "lobu.ai";

export const RULES = {
  /** system/dependency: sightings in 24h, or distinct orgs in one hour. */
  systemMinSeen24h: 3,
  systemMinOrgs: 2,
  /** user errors are usually correct rejections: only a spike is an issue. */
  userMinSeen24h: 20,
  userMinOrgs: 3,
  /** New issues per hour; the rest wait for a later run. */
  maxNewPerHour: 5,
  /**
   * High priority — the only level that notifies — is earned by reach: two
   * named users in an hour (a tenth of daily actives), or enough workspaces
   * to be systemic. Sightings alone never qualify: one caller retrying or a
   * crawler walking distinct URLs mints an occurrence per request with no
   * user attached. Sign-in failures page on the first sighting.
   */
  highMinUsers: 2,
  highMinOrgs: 3,
  /**
   * A 5xx the gateway answered itself never reached the server, so no user or
   * workspace is attached and volume is the only reach there is. An origin
   * refusing the odd request runs at a few an hour; an outage at hundreds.
   */
  edgeBurstMin2h: 20,
  /**
   * Sign-in and consent requests. A failure here locks a user out before they
   * reach the product, often once per person, so one sighting is an issue.
   * Matched against the culprit, and for a logged error against the request
   * its sample trace served.
   */
  signInRequest: /^[A-Z]+ \/(connect|oauth|api\/auth)(\/|$)/,
  newForDays: 7,
  resolveAfterQuietDays: 14,
  /** escalating: the last two hours' hourly rate vs the prior 13 days. */
  escalateMinPerHour: 10,
  escalateFactor: 5,
  /**
   * The browser's whole report for an error thrown by a script from another
   * origin: no type, message or stack survives, so it is never an issue.
   */
  opaqueBrowserError: "Script error.",
} as const;

export type IssueStatus =
  | "new"
  | "ongoing"
  | "escalating"
  | "regressed"
  | "resolved"
  | "ignored";
export type ErrorKind = "system" | "user" | "dependency";
/**
 * Where the occurrences were recorded: the server, a visitor's browser, or a
 * gateway (Traefik or Cloudflare) that answered a request with a 5xx itself.
 */
export type ErrorSource = "server" | "browser" | "edge";

/** One fingerprint seen in the last two hours, with its trailing stats. */
export interface Occurrence {
  fingerprint: string;
  kind: ErrorKind;
  source: ErrorSource;
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
  /** For a logged error, the request its sample trace served; otherwise "". */
  request: string;
}

export interface IssueRecord {
  id: number;
  fingerprint: string;
  status: IssueStatus;
  culprit?: string;
  first_seen?: string;
  last_seen?: string;
  resolved_at?: string;
  regressed_at?: string;
  escalated_at?: string;
  resolved_in_release?: string;
  ignore_until?: string;
  /** The stored 24h count, which only refreshes while the fingerprint is active. */
  seen_24h?: number;
  /** Soft-deleted: its slug stays taken, so the fingerprint stays suppressed. */
  deleted?: boolean;
}

export type Alert = "new_high" | "regressed" | "escalating";
type AlertNotice = { kind: Alert; key: string; title: string; body: string };

/** What a paged human needs first: how many people and workspaces it hit. */
function alertBody(o: Occurrence): string {
  if (o.source === "edge")
    return `Fingerprint ${o.fingerprint}. ${o.seen_2h} gateway errors in the last 2 hours, ${o.seen_24h} in 24h. The requests never reached the server, so no user or workspace is attached. Open the issue record for occurrences and linked tasks.`;
  const users = o.max_users === 1 ? "1 user" : `${o.max_users} users`;
  const orgs = o.max_orgs === 1 ? "1 workspace" : `${o.max_orgs} workspaces`;
  return `Fingerprint ${o.fingerprint}. ${o.seen_24h} sightings in 24h, ${users} and ${orgs} affected. Open the issue record for occurrences and linked tasks.`;
}

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
      expected?: Record<string, string | number | boolean | null>;
      alert?: AlertNotice;
    }
  | { action: "defer"; fingerprint: string; reason: "hourly_quota" };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

const blocksSignIn = (o: Occurrence) =>
  o.kind !== "user" &&
  (RULES.signInRequest.test(o.culprit) || RULES.signInRequest.test(o.request));

function passesGate(o: Occurrence): boolean {
  if (o.source === "browser") {
    if (o.message === RULES.opaqueBrowserError) return false;
    // A request that failed in a browser is usually the visitor's network,
    // and the server records its own failures. Only a spike, the shape of an
    // outage the server cannot see, is an issue.
    if (o.kind === "dependency") return isEscalating(o);
  }
  if (blocksSignIn(o)) return true;
  return o.kind === "user"
    ? o.seen_24h >= RULES.userMinSeen24h || o.max_orgs >= RULES.userMinOrgs
    : o.seen_24h >= RULES.systemMinSeen24h || o.max_orgs >= RULES.systemMinOrgs;
}

/**
 * Priority ranks impact, never volume. `seen_24h` counts requests: one person
 * retrying, or a crawler walking distinct URLs, inflates it with nobody
 * attached. A named user or enough workspaces is someone actually blocked.
 */
function priority(o: Occurrence): "high" | "medium" | "low" {
  if (o.kind === "user") return "low";
  if (o.source === "edge")
    return o.seen_2h >= RULES.edgeBurstMin2h ? "high" : "medium";
  return blocksSignIn(o) ||
    o.max_users >= RULES.highMinUsers ||
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

/**
 * Fields this job owns: counters and the priority derived from them, which
 * follows current reach so a stale high cannot keep paging. Triage and agent
 * fields are never written here.
 */
function snapshot(o: Occurrence, now: Date): Record<string, unknown> {
  return {
    priority: priority(o),
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
    // Current health has an explicit recovery proof, never a log-quiet timeout.
    if (i.culprit?.startsWith(HEALTH_PREFIX)) continue;
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
          culprit: o.culprit,
          ...(o.request ? { request: o.request } : {}),
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
                // An edge culprit repeats the title; its sample request is new.
                title: `New high-priority issue: ${o.title} (${o.request || (o.source === "edge" ? o.message : o.culprit)})`,
                body: alertBody(o),
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
        if (priority(o) === "high")
          alert = {
            kind: "regressed",
            key: `issue:${o.fingerprint}:regressed:${issue.resolved_at}`,
            title: `Issue regressed: ${o.title}`,
            body: alertBody(o),
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
        if (
          priority(o) === "high" &&
          (Number.isNaN(sinceLast) || sinceLast >= DAY)
        ) {
          metadata.escalated_at = now.toISOString();
          alert = {
            kind: "escalating",
            key: `issue:${o.fingerprint}:escalating:${issue.escalated_at ?? "first"}`,
            title: `Issue escalating: ${o.title}`,
            body: alertBody(o),
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
    const quietFor = now.getTime() - ms(issue.last_seen);
    // Counters only refresh while a fingerprint is active (seen in the last two
    // hours). Once a day has passed with no sighting the 24h count is exactly
    // zero, so clear it once instead of letting the last value rank it forever.
    const counts =
      (issue.seen_24h ?? 0) > 0 && quietFor >= DAY ? { seen_24h: 0 } : {};
    let metadata: Record<string, unknown> | null = null;
    const stamp = stampResolution(issue, now);
    if (stamp) {
      metadata = stamp;
    } else if (
      ["new", "ongoing", "escalating", "regressed"].includes(issue.status) &&
      quietFor >= RULES.resolveAfterQuietDays * DAY
    ) {
      metadata = {
        status: "resolved",
        resolved_at: now.toISOString(),
        resolution: "auto",
      };
    } else if (issue.status === "escalating") {
      metadata = { status: ageStatus(issue, now) };
    }
    if (metadata || Object.keys(counts).length > 0) {
      changes.push({
        action: "update",
        id: issue.id,
        fingerprint: issue.fingerprint,
        metadata: { ...metadata, ...counts },
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
  argMax(source, last_seen) AS issue_source,
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
  AND (environment = '${ENVIRONMENT}' OR (source = 'edge' AND environment = '${EDGE_ZONE}'))
GROUP BY fingerprint
HAVING max(last_seen) >= now() - INTERVAL 2 HOUR
ORDER BY seen_24h DESC, fingerprint
LIMIT 400`;

const TRACE_ID = /^[0-9a-f]{32}$/;

/**
 * A logged error's culprit names the logger, not the request. Its sample
 * trace's server span does. Only well-formed trace ids are inlined.
 */
function requestsSql(traceIds: string[]): string {
  return `
SELECT TraceId AS trace_id, any(SpanName) AS request
FROM observability.otel_traces
WHERE Timestamp >= now() - INTERVAL 1 DAY
  AND SpanKind = 'Server'
  AND TraceId IN (${traceIds.map((id) => `'${id}'`).join(", ")})
GROUP BY TraceId`;
}

async function attachRequests(
  occurrences: Occurrence[],
  client: ReactionClient
): Promise<void> {
  const logged = occurrences.filter(
    (o) =>
      o.kind !== "user" &&
      o.culprit.startsWith("log ") &&
      TRACE_ID.test(o.sample_trace_id)
  );
  if (logged.length === 0) return;
  const rows = (await client.query(
    requestsSql([...new Set(logged.map((o) => o.sample_trace_id))]),
    { connection: CONNECTION }
  )) as Array<{ trace_id: string; request: string }>;
  const byTrace = new Map(rows.map((r) => [r.trace_id, str(r.request)]));
  for (const o of logged) o.request = byTrace.get(o.sample_trace_id) ?? "";
}

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
    source:
      row.issue_source === "browser" || row.issue_source === "edge"
        ? row.issue_source
        : "server",
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
    request: "",
  };
}

function toIssue(row: Record<string, unknown>): IssueRecord | null {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const fingerprint = str(m.fingerprint);
  if (!fingerprint) return null;
  return {
    id: num(row.id),
    fingerprint,
    culprit: str(m.culprit),
    status: (str(m.status) || "ongoing") as IssueStatus,
    first_seen: str(m.first_seen) || undefined,
    last_seen: str(m.last_seen) || undefined,
    resolved_at: str(m.resolved_at) || undefined,
    regressed_at: str(m.regressed_at) || undefined,
    escalated_at: str(m.escalated_at) || undefined,
    resolved_in_release: str(m.resolved_in_release) || undefined,
    ignore_until: str(m.ignore_until) || undefined,
    seen_24h: m.seen_24h === undefined ? undefined : num(m.seen_24h),
    deleted: row.deleted === true,
  };
}

/** Stable, short key for notification dedupe; the sandbox has no crypto module. */
function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++)
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/** Source errors embed retry counts and seconds; those are not a new cause. */
function healthErrorKey(error: string): string {
  return error.replace(/\d+/g, "#");
}

export async function runIssueTracker(
  ctx: Pick<ReactionContext, "window">,
  client: ReactionClient,
  dryRun: boolean,
  healthScope?: HealthScope,
  initialHealthError?: string | null
): Promise<Record<string, unknown>> {
  const now = new Date();
  const occurrences = (
    (await client.query(OCCURRENCES_SQL, { connection: CONNECTION })) as Record<
      string,
      unknown
    >[]
  ).map(toOccurrence);
  await attachRequests(occurrences, client);
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

  // Finish all reads before writing: source/ownership failures cannot close issues.
  // The health sweep is supplementary. A failed or partial snapshot contributes
  // zero health findings — it must never abort occurrence ingestion, and missing
  // rows must never auto-resolve a health issue. Surface it once per day instead.
  let health: HealthResource[] = [];
  let healthError: string | null = initialHealthError ?? null;
  if (healthScope) {
    try {
      health = await readHealthSnapshot(client, healthScope);
    } catch (error) {
      healthError = error instanceof Error ? error.message : String(error);
    }
  }
  const changes = [
    ...planIssueChanges(occurrences, issues, now, createdLastHour),
    ...planHealthChanges(health, issues, now),
  ];
  const summary = {
    dry_run: dryRun,
    health_error: healthError,
    fingerprints: occurrences.length,
    health_resources: health.filter((r) => r.kind !== "scope").length,
    health_workspaces: health
      .filter((r) => r.kind === "scope")
      .map((r) => r.workspace),
    issues: issues.filter((i) => !i.deleted).length,
    created: changes.filter((c) => c.action === "create").length,
    updated: changes.filter((c) => c.action === "update").length,
    deferred: changes.filter((c) => c.action === "defer").length,
    alerts: changes.filter((c) => c.action !== "defer" && c.alert).length,
  };
  if (dryRun) return { ...summary, changes: changes.slice(0, 50) };

  if (healthError) {
    try {
      await client.notifications.send({
        title: "Issue tracker health sweep failed",
        body: `Occurrence ingestion continued. ${healthError}`.slice(0, 1000),
        recipients: "admins",
        // One notice per distinct failure per day, not one per 15-minute run.
        idempotency_key: `issue-tracker-health:${ctx.window.automation_id}:${stableHash(healthErrorKey(healthError))}:${now.toISOString().slice(0, 10)}`,
        automation_source: {
          automation_id: ctx.window.automation_id,
          run_id: ctx.window.run_id,
        },
      });
    } catch {
      // Delivery is best effort; the run summary still carries health_error.
    }
  }

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
      body: change.alert.body,
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
      ...(change.expected ? { expected: change.expected } : {}),
      automation_source: source,
    });
  }
}

export default async function trackIssues(
  ctx: ReactionContext,
  client: ReactionClient,
  params?: { health?: Omit<HealthScope, "ownerUserId"> }
): Promise<Record<string, unknown>> {
  let health: HealthScope | undefined;
  let healthError: string | null = null;
  if (params?.health) {
    // The owner lookup uses the same health source as the snapshot. It is
    // part of the supplementary path: a revoked/unavailable source must not
    // prevent occurrence ingestion, so both are guarded together.
    try {
      const id = Number(ctx.window.automation_id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("Invalid tracker identity");
      const org = ctx.organization_id.replaceAll("'", "''");
      const rows = (await client.query(
        `SELECT created_by FROM automations WHERE id = ${id} AND organization_id = '${org}'`,
        { connection: params.health.connection }
      )) as Array<{ created_by: string }>;
      if (rows.length !== 1 || !rows[0]?.created_by)
        throw new Error("Tracker owner unavailable");
      health = { ...params.health, ownerUserId: rows[0].created_by };
    } catch (error) {
      healthError = error instanceof Error ? error.message : String(error);
    }
  }
  return runIssueTracker(ctx, client, DRY_RUN, health, healthError);
}
