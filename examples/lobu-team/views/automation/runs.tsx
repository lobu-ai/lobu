/**
 * Dogfood view: automation runs for the team workspace.
 *
 * Tab on the `engineering-task` type page: the Automation roster with its
 * server-classified latest-run outcome (`automation_run_outcome` is
 * materialized at write time by the single classifier in
 * `packages/server/src/runs/run-outcome.ts`), plus the recent run history in
 * a selectable window. `status` filters the history by the run's stored
 * status; `window` bounds it by creation time.
 *
 * Reads go through tools with an `outputSchema` (`manage_automations`,
 * `manage_operations`); rows are wide snapshots, so every field is read
 * defensively. Reasons shown are server-stored text (`error_message`,
 * `health_reasons`) displayed verbatim — this module never classifies.
 */
import { useMemo } from "react";
import {
  defineView,
  mountView,
  tool,
  useHost,
  useParams,
  useQuery,
} from "@lobu/views";

export const view = defineView({
  key: "automation-runs",
  attach: [{ type: "engineering-task" }],
  params: {
    status: { type: "string", default: "all" },
    window: { type: "string", default: "24h" },
  },
});

const WINDOWS: Record<string, number | null> = {
  "24h": 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "30d": 30 * 24 * 3600 * 1000,
};

const STATUSES = [
  "all",
  "completed",
  "failed",
  "timeout",
  "running",
  "pending",
];

interface AutomationRow {
  automation_id?: string | number | null;
  slug?: string | null;
  name?: string | null;
  status?: string | null;
  health?: string | null;
  health_reasons?: string[] | null;
  automation_run_status?: string | null;
  automation_run_outcome?: string | null;
  automation_run_error?: string | null;
  last_run_outcome?: string | null;
}

interface RunRow {
  id: number;
  run_type?: string | null;
  automation_id?: number | null;
  status?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
}

function windowStart(window: unknown): string | null {
  const ms = typeof window === "string" ? WINDOWS[window] : undefined;
  if (ms == null) return null;
  return new Date(Date.now() - ms).toISOString();
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString();
}

function AutomationRuns() {
  const [params, setParams] = useParams();
  const { theme } = useHost();
  const statusParam = String(params.status ?? "all");
  // Stable per window value: a fresh timestamp every render would change the
  // query key each time and refetch forever.
  const createdAfter = useMemo(
    () => windowStart(params.window),
    [params.window]
  );

  const roster = useQuery<{ automations?: AutomationRow[] }>(
    tool("manage_automations", { action: "list", limit: 100 })
  );
  const history = useQuery<{ runs?: RunRow[]; total?: number }>(
    tool("manage_operations", {
      action: "list_runs",
      run_types: ["automation"],
      ...(statusParam !== "all" ? { status: statusParam } : {}),
      ...(createdAfter ? { created_after: createdAfter } : {}),
      limit: 100,
    })
  );

  const automations: AutomationRow[] = roster.data?.automations ?? [];
  const runs: RunRow[] = history.data?.runs ?? [];
  const counts = new Map<string, number>();
  for (const a of automations) {
    const k = String(
      a.automation_run_outcome ?? a.last_run_outcome ?? "unknown"
    );
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  return (
    <div
      data-testid="automation-runs"
      data-theme={theme}
      style={{ padding: 12 }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 14 }}>Automation runs</strong>
        <span style={{ color: "var(--muted)" }}>
          {automations.length} automation{automations.length === 1 ? "" : "s"} ·{" "}
          {runs.length} run{runs.length === 1 ? "" : "s"} in window
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 12,
            alignItems: "center",
            color: "var(--muted)",
          }}
        >
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            status
            <select
              data-testid="status-select"
              value={statusParam}
              onChange={(e) => setParams({ status: e.target.value })}
              style={{
                font: "inherit",
                padding: "2px 4px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "inherit",
              }}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            window
            <select
              data-testid="window-select"
              value={String(params.window ?? "24h")}
              onChange={(e) => setParams({ window: e.target.value })}
              style={{
                font: "inherit",
                padding: "2px 4px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "inherit",
              }}
            >
              {Object.keys(WINDOWS).map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        </span>
      </header>

      {roster.error && (
        <div data-testid="roster-error" style={{ color: "var(--bad)" }}>
          {roster.error}
        </div>
      )}
      {!roster.loading && !roster.error && (
        <table
          data-testid="automation-roster"
          style={{ width: "100%", borderCollapse: "collapse" }}
        >
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>
                Automation
              </th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>State</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Health</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>
                Last outcome
              </th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((a) => {
              const id = String(
                a.automation_id ?? a.slug ?? a.name ?? "unknown"
              );
              const reasons = Array.isArray(a.health_reasons)
                ? a.health_reasons.join("; ")
                : (a.automation_run_error ?? "");
              return (
                <tr
                  key={id}
                  data-testid="automation-row"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "5px 6px", fontWeight: 500 }}>
                    {String(a.name ?? a.slug ?? id)}
                  </td>
                  <td style={{ padding: "5px 6px" }}>{a.status ?? "—"}</td>
                  <td style={{ padding: "5px 6px" }}>{a.health ?? "—"}</td>
                  <td style={{ padding: "5px 6px" }}>
                    {String(
                      a.automation_run_outcome ?? a.last_run_outcome ?? "—"
                    )}
                  </td>
                  <td
                    style={{
                      padding: "5px 6px",
                      color: "var(--muted)",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={reasons}
                  >
                    {reasons || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 style={{ fontSize: 13, margin: "14px 0 4px" }}>Recent runs</h3>
      {history.loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {history.error && (
        <div data-testid="history-error" style={{ color: "var(--bad)" }}>
          {history.error}
        </div>
      )}
      {!history.loading && !history.error && runs.length === 0 && (
        <div style={{ color: "var(--muted)" }}>No runs in this window.</div>
      )}
      {!history.loading &&
        !history.error &&
        runs.map((r) => (
          <div
            key={r.id}
            data-testid="run-row"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              padding: "5px 0",
              borderTop: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums" }}>#{r.id}</span>
            <span style={{ fontWeight: 500 }}>{r.status ?? "—"}</span>
            <span style={{ color: "var(--muted)" }}>
              automation {r.automation_id ?? "—"}
            </span>
            <span
              style={{
                marginLeft: "auto",
                color: "var(--muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 360,
              }}
              title={r.error_message ?? ""}
            >
              {r.error_message ?? fmtTime(r.created_at)}
            </span>
          </div>
        ))}
    </div>
  );
}

mountView(view, AutomationRuns);
