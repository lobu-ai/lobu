/**
 * Dogfood view: connection health card for the team workspace.
 *
 * Overview card on every `engineering-task` record: one row per health rule
 * from #3617 (`attention` on `manage_connections` list), an all/attention
 * filter param, and a Retry button per unhealthy connection. The button emits
 * the declared `retry` action through `invoke_view_action`, which appends one
 * `connection.retry_requested` event through the template-action chokepoint.
 *
 * Reads go through the tool with an `outputSchema` (`manage_connections`);
 * `connections` rows are wide snapshots, so every field is read defensively.
 * Failure classification stays server-side: this module never parses error
 * text, it only displays what the tool returned.
 */
import { useState } from "react";
import {
  defineView,
  mountView,
  tool,
  useAction,
  useHost,
  useParams,
  useQuery,
  useScope,
} from "@lobu/views";

export const view = defineView({
  key: "connection-health",
  attach: [{ type: "engineering-task", placement: "overview" }],
  params: { only: { type: "string", default: "all" } },
  actions: { retry: { emits: "connection.retry_requested" } },
});

type Tone = "ok" | "warn" | "bad" | "muted";

const RULES: Array<{ id: string; label: string; hint: string; tone: Tone }> = [
  {
    id: "healthy",
    label: "Healthy",
    hint: "Every collector feed is running on schedule.",
    tone: "ok",
  },
  {
    id: "paused",
    label: "Paused",
    hint: "Every collector feed is paused; nothing runs until resumed.",
    tone: "muted",
  },
  {
    id: "needs_auth",
    label: "Needs auth",
    hint: "Credentials expired or were revoked; reconnect.",
    tone: "bad",
  },
  {
    id: "no_feeds",
    label: "No feeds",
    hint: "Connector can sync but no feed was created.",
    tone: "warn",
  },
  {
    id: "no_trigger",
    label: "No trigger",
    hint: "Feeds exist but none has a schedule or webhook.",
    tone: "warn",
  },
  {
    id: "never_collected",
    label: "Never collected",
    hint: "Feeds exist and can run, none has ever finished a sync.",
    tone: "warn",
  },
  {
    id: "degraded",
    label: "Degraded",
    hint: "At least one feed needs attention.",
    tone: "bad",
  },
  {
    id: "misconfigured",
    label: "Misconfigured",
    hint: "The connection row itself is in an error state.",
    tone: "bad",
  },
];

interface ConnectionRow {
  id: number;
  name?: string | null;
  slug?: string | null;
  connector_key?: string | null;
  status?: string | null;
  attention?: string | null;
}

function toneColor(tone: Tone): string {
  return tone === "ok"
    ? "var(--ok)"
    : tone === "warn"
      ? "var(--warn)"
      : tone === "bad"
        ? "var(--bad)"
        : "var(--muted)";
}

function ConnectionHealth() {
  const scope = useScope();
  const [params, setParams] = useParams();
  const { connected, theme } = useHost();
  const entityId =
    typeof scope.entity === "number" ? scope.entity : Number(scope.entity);
  const scoped = Number.isFinite(entityId) && entityId > 0;
  // The host seeds scope + params on the first tool-input; useQuery parks
  // until then, so the read below never runs against defaults.
  const q = useQuery<{ connections?: ConnectionRow[] }>(
    tool(
      "manage_connections",
      scoped
        ? { action: "list", entity_id: entityId, limit: 50 }
        : { action: "list", limit: 50 }
    )
  );
  const retry = useAction("retry");
  const [actionLog, setActionLog] = useState<string[]>([]);

  const rows: ConnectionRow[] = q.data?.connections ?? [];
  const onlyAttention = params.only === "attention";
  const visible = onlyAttention
    ? rows.filter((r) => r.attention && r.attention !== "healthy")
    : rows;
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.attention ?? "unknown");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  async function onRetry(row: ConnectionRow) {
    const res = await retry({ connection_id: row.id });
    setActionLog((l) =>
      [
        `${new Date().toLocaleTimeString()} retry #${row.id}: ${res.ok ? "ok" : `error: ${res.error}`}`,
        ...l.slice(0, 4),
      ].slice(0, 5)
    );
    q.refetch();
  }

  return (
    <div
      data-testid="connection-health"
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
        <strong style={{ fontSize: 14 }}>Connection health</strong>
        <span style={{ color: "var(--muted)" }}>
          {scoped ? `record #${entityId}` : "workspace"} · {rows.length}{" "}
          connection{rows.length === 1 ? "" : "s"}
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
          show
          <select
            data-testid="only-select"
            value={String(params.only ?? "all")}
            onChange={(e) => setParams({ only: e.target.value })}
            style={{
              font: "inherit",
              padding: "2px 4px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "inherit",
            }}
          >
            <option value="all">all</option>
            <option value="attention">needs attention</option>
          </select>
        </label>
      </header>

      <table
        style={{ width: "100%", borderCollapse: "collapse" }}
        data-testid="rules"
      >
        <tbody>
          {RULES.map((rule) => {
            const n = counts.get(rule.id) ?? 0;
            if (onlyAttention && rule.id === "healthy") return null;
            return (
              <tr
                key={rule.id}
                data-rule={rule.id}
                style={{
                  borderTop: "1px solid var(--border)",
                  opacity: n === 0 ? 0.55 : 1,
                }}
              >
                <td style={{ padding: "5px 0", width: 14 }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: toneColor(rule.tone),
                    }}
                  />
                </td>
                <td
                  style={{
                    padding: "5px 6px",
                    whiteSpace: "nowrap",
                    fontWeight: 500,
                  }}
                >
                  {rule.label}
                </td>
                <td style={{ padding: "5px 6px", color: "var(--muted)" }}>
                  {rule.hint}
                </td>
                <td
                  data-testid={`count-${rule.id}`}
                  style={{
                    padding: "5px 0",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {n}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10 }}>
        {q.loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
        {q.error && (
          <div data-testid="query-error" style={{ color: "var(--bad)" }}>
            {q.error}
          </div>
        )}
        {!q.loading && !q.error && visible.length === 0 && (
          <div style={{ color: "var(--muted)" }}>
            {onlyAttention ? "Nothing needs attention." : "No connections."}
          </div>
        )}
        {visible.map((row) => {
          const rule = RULES.find((r) => r.id === row.attention);
          return (
            <div
              key={row.id}
              data-testid="connection-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: toneColor(rule?.tone ?? "muted"),
                }}
              />
              <span style={{ fontWeight: 500 }}>
                {row.name ?? row.slug ?? `#${row.id}`}
              </span>
              <span style={{ color: "var(--muted)" }}>{row.connector_key}</span>
              <span
                style={{
                  marginLeft: "auto",
                  color: toneColor(rule?.tone ?? "muted"),
                }}
              >
                {rule?.label ?? row.attention ?? "unknown"}
              </span>
              {row.attention !== "healthy" && (
                <button
                  type="button"
                  data-testid={`retry-${row.id}`}
                  onClick={() => void onRetry(row)}
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--accent)",
                    cursor: "pointer",
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          );
        })}
      </div>

      {actionLog.length > 0 && (
        <pre
          data-testid="action-log"
          style={{
            marginTop: 8,
            padding: 8,
            fontSize: 11,
            background: "color-mix(in srgb, var(--muted) 12%, transparent)",
            borderRadius: 6,
            whiteSpace: "pre-wrap",
          }}
        >
          {actionLog.join("\n")}
        </pre>
      )}
      <footer style={{ marginTop: 8, color: "var(--muted)", fontSize: 11 }}>
        scope {JSON.stringify(scope)} · params {JSON.stringify(params)} ·{" "}
        {connected ? "connected" : "connecting…"}
      </footer>
    </div>
  );
}

mountView(view, ConnectionHealth);
