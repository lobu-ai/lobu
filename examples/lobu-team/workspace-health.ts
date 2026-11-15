import type { ReactionClient } from "@lobu/connector-sdk";
import type { IssueChange, IssueRecord } from "./issue-tracker.reaction";

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
  if (scope.workspaces.some((s) => !owned.has(s)))
    throw new Error("Health scope ownership changed or snapshot is incomplete");
  return rows;
}
