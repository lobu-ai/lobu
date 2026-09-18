/**
 * Dogfood view: provider refusals page for the team workspace.
 *
 * Workspace page at `/pages/provider-refusals`: which Automations are
 * currently sitting on a write-time-classified error outcome
 * (`automation_run_outcome`, materialized by the single classifier in
 * `packages/server/src/runs/run-outcome.ts`), and a per-day chart of
 * non-completed Automation runs in the selected window.
 *
 * Reads go through tools with an `outputSchema` (`manage_automations`,
 * `manage_operations`). The chart groups an already-bounded run page by day
 * for display; it never re-derives failure causes — reasons shown are the
 * server-stored `automation_run_error` / `error_message` text verbatim. The
 * provider-quota vocabulary lives once in
 * `packages/core/src/classify-error.ts`; there is deliberately no copy here.
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
  key: "provider-refusals",
  attach: [{ workspace: true }],
  params: { window: { type: "string", default: "7d" } },
});

const WINDOWS: Record<string, number> = { "7d": 7, "30d": 30 };

interface AutomationRow {
  automation_id?: string | number | null;
  slug?: string | null;
  name?: string | null;
  automation_run_outcome?: string | null;
  last_run_outcome?: string | null;
  automation_run_error?: string | null;
}

interface RunRow {
  id: number;
  status?: string | null;
  error_message?: string | null;
  created_at?: string | null;
}

function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function ProviderRefusals() {
  const [params, setParams] = useParams();
  const { theme } = useHost();
  const windowParam = String(params.window ?? "7d");
  const days = WINDOWS[windowParam] ?? 7;
  // Stable per window value: a fresh timestamp every render would change the
  // query key each time and refetch forever.
  const createdAfter = useMemo(
    () => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString(),
    [days]
  );

  const roster = useQuery<{ automations?: AutomationRow[] }>(
    tool("manage_automations", { action: "list", limit: 100 })
  );
  const history = useQuery<{ runs?: RunRow[] }>(
    tool("manage_operations", {
      action: "list_runs",
      run_types: ["automation"],
      created_after: createdAfter,
      limit: 200,
    })
  );

  const automations: AutomationRow[] = roster.data?.automations ?? [];
  const runs: RunRow[] = history.data?.runs ?? [];
  const errored = automations.filter((a) => {
    const o = a.automation_run_outcome ?? a.last_run_outcome;
    return o === "agent_error" || o === "infra_error";
  });

  const perDay = new Map<string, { failed: number; other: number }>();
  for (const d of lastDays(days)) perDay.set(d, { failed: 0, other: 0 });
  for (const r of runs) {
    const k = dayKey(r.created_at);
    if (!k) continue;
    const cell = perDay.get(k);
    if (!cell) continue;
    if (r.status === "failed" || r.status === "timeout") cell.failed += 1;
    else cell.other += 1;
  }
  const max = Math.max(
    1,
    ...[...perDay.values()].map((c) => c.failed + c.other)
  );
  const barW = 22;
  const gap = 8;
  const height = 96;
  const width = perDay.size * (barW + gap) + gap;

  return (
    <div
      data-testid="provider-refusals"
      data-theme={theme}
      style={{ padding: 12 }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>Provider refusals</strong>
        <span style={{ color: "var(--muted)" }}>
          {errored.length} automation{errored.length === 1 ? "" : "s"} on an
          error outcome · {runs.length} run{runs.length === 1 ? "" : "s"} in
          {windowParam === "7d" ? " 7 days" : " 30 days"}
        </span>
        <label
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 6,
            alignItems: "center",
            color: "var(--muted)",
          }}
        >
          window
          <select
            data-testid="window-select"
            value={windowParam}
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
      </header>

      {roster.error && (
        <div data-testid="roster-error" style={{ color: "var(--bad)" }}>
          {roster.error}
        </div>
      )}
      {!roster.loading && !roster.error && errored.length === 0 && (
        <div style={{ color: "var(--muted)" }}>
          No Automation is on an error outcome right now.
        </div>
      )}
      {errored.map((a) => {
        const id = String(a.automation_id ?? a.slug ?? a.name ?? "unknown");
        return (
          <div
            key={id}
            data-testid="refusal-row"
            style={{
              padding: "6px 0",
              borderTop: "1px solid var(--border)",
              fontSize: 13,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ fontWeight: 500 }}>
                {String(a.name ?? a.slug ?? id)}
              </span>
              <span
                style={{ marginLeft: "auto", color: "var(--bad)" }}
                data-testid="refusal-outcome"
              >
                {String(a.automation_run_outcome ?? a.last_run_outcome ?? "")}
              </span>
            </div>
            {a.automation_run_error && (
              <div
                style={{
                  color: "var(--muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={a.automation_run_error}
              >
                {a.automation_run_error}
              </div>
            )}
          </div>
        );
      })}

      <h3 style={{ fontSize: 13, margin: "14px 0 4px" }}>
        Non-completed runs per day
      </h3>
      {history.loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {history.error && (
        <div data-testid="history-error" style={{ color: "var(--bad)" }}>
          {history.error}
        </div>
      )}
      {!history.loading && !history.error && (
        <svg
          data-testid="refusals-chart"
          width={width}
          height={height + 18}
          role="img"
          aria-label="Failed automation runs per day"
        >
          {[...perDay.entries()].map(([day, cell], i) => {
            const total = cell.failed + cell.other;
            const failedH = Math.round((cell.failed / max) * height);
            const otherH = Math.round((cell.other / max) * height);
            const x = gap + i * (barW + gap);
            return (
              <g key={day}>
                <title>{`${day}: ${cell.failed} failed, ${cell.other} other`}</title>
                <rect
                  x={x}
                  y={height - otherH}
                  width={barW}
                  height={otherH}
                  fill="var(--muted)"
                  opacity={0.45}
                />
                <rect
                  x={x}
                  y={height - otherH - failedH}
                  width={barW}
                  height={failedH}
                  fill="var(--bad)"
                />
                {total > 0 && (
                  <text
                    x={x + barW / 2}
                    y={height - otherH - failedH - 3}
                    textAnchor="middle"
                    fontSize={9}
                    fill="currentColor"
                  >
                    {total}
                  </text>
                )}
                <text
                  x={x + barW / 2}
                  y={height + 13}
                  textAnchor="middle"
                  fontSize={8}
                  fill="var(--muted)"
                >
                  {day.slice(5)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

mountView(view, ProviderRefusals);
