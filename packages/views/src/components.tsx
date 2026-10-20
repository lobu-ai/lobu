/**
 * `@lobu/views/components` — first-party presentational kit for Lobu views.
 *
 * React-only by design: inline styles, no fetch, no
 * document access. Everything here runs inside the sandboxed MCP Apps frame,
 * where the host (not the view) owns data access. Reads still go through
 * `useQuery`/`tool`/`sql` from `@lobu/views`; these components only render
 * what the host returns, plus the honest states (`QueryState.loading`,
 * `.error`, `.errorCode`, `.truncated`) that `useQuery` reports.
 *
 * Styling follows the shell's theme tokens (`--fg`, `--muted`, `--border`,
 * `--accent`, `--font`, `--radius`, `--radius-lg`), which derive from the
 * host's MCP Apps style variables and flip with its `.dark` class, so kit
 * output takes the host's look without configuration. Theme tokens carry
 * light-mode fallbacks; pie series and error accents use fixed colors.
 *
 * Server-side compile allowlist: this module is pinned beside `react` and
 * `@lobu/views` in the view compiler funds, so MCP/tool-path views may
 * `import { DataTable } from "@lobu/views/components"`. Anything fancier
 * (third-party chart/table libraries, user components in other files) ships
 * through `lobu apply`, which bundles the project's own `node_modules`.
 */

import type { CSSProperties, ReactNode } from "react";
import { useId } from "react";
import { useHost } from "./api.js";

const FONT_STACK =
  'var(--font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';

const INK: CSSProperties = {
  color: "var(--fg, #0a0a0a)",
  fontFamily: FONT_STACK,
  fontSize: 13,
  lineHeight: 1.45,
};

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export interface CardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Section container: title row, optional description and action slot. */
export function Card({ title, description, actions, children }: CardProps) {
  return (
    <section
      style={{
        ...INK,
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: "var(--radius-lg, 8px)",
        padding: "12px 14px",
        background: "transparent",
      }}
    >
      {(title || actions) && (
        <header
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: description || children ? 4 : 0,
          }}
        >
          {title && (
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {title}
            </h3>
          )}
          {actions}
        </header>
      )}
      {description && (
        <p style={{ margin: "0 0 8px", color: "var(--muted, #6b7280)" }}>
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* DataTable                                                           */
/* ------------------------------------------------------------------ */

export interface TableColumn<T> {
  /** Stable key; doubles as the server sort key when `sortable`. */
  key: string;
  header: string;
  align?: "left" | "center" | "right";
  sortable?: boolean;
  /** Custom cell. Defaults to `String(row[key] ?? "")`. */
  render?: (row: T) => ReactNode;
}

export interface TablePagination {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Total rows when known; otherwise a short page disables Next. */
  total?: number;
  onPage: (page: number) => void;
}

export interface TableSort {
  key: string;
  dir: "asc" | "desc";
}

export interface DataTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string | number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: string;
  /** Controlled server-side sort; omit for unsorted data. */
  sort?: TableSort;
  onSort?: (key: string) => void;
  pagination?: TablePagination;
  caption?: string;
}

const CELL: CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  textAlign: "left",
  verticalAlign: "top",
  overflowWrap: "anywhere",
};

/**
 * Server-driven table. The view owns state (page/sort live in `useParams`,
 * rows come from `useQuery`); the table only renders and reports intent.
 * Pass query loading/error state explicitly; render TruncatedNotice beside
 * the table when the query reports partial results.
 */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  loading = false,
  error = null,
  onRetry,
  emptyText = "No rows.",
  sort,
  onSort,
  pagination,
  caption,
}: DataTableProps<T>) {
  const labelId = useId();
  const pageCount =
    pagination && pagination.total != null
      ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize))
      : null;
  return (
    <div style={INK}>
      {caption && (
        <p
          id={labelId}
          style={{ margin: "0 0 6px", color: "var(--muted, #6b7280)" }}
        >
          {caption}
        </p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table
          aria-labelledby={caption ? labelId : undefined}
          style={{ borderCollapse: "collapse", width: "100%" }}
        >
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  aria-sort={
                    sort?.key === col.key
                      ? sort.dir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  style={{
                    ...CELL,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    textAlign: col.align ?? "left",
                  }}
                >
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      title={`Sort by ${col.header}`}
                      style={{
                        border: 0,
                        padding: 0,
                        background: "transparent",
                        font: "inherit",
                        cursor: "pointer",
                        color: "var(--accent, #2563eb)",
                      }}
                    >
                      {col.header}
                      {sort?.key === col.key
                        ? sort.dir === "asc"
                          ? " ▲"
                          : " ▼"
                        : ""}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={keyOf(row, i)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{ ...CELL, textAlign: col.align ?? "left" }}
                  >
                    {col.render
                      ? col.render(row)
                      : String((row as Record<string, unknown>)[col.key] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <LoadingState text="Loading rows…" />}
      {error && !loading && <ErrorState message={error} onRetry={onRetry} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState title={emptyText} />
      )}
      {pagination &&
        (pageCount == null || pageCount > 1 || pagination.page > 1) && (
          <nav
            aria-label="Table pages"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
            }}
          >
            <PageButton
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPage(pagination.page - 1)}
              label="Previous page"
            />
            <span style={{ color: "var(--muted, #6b7280)" }}>
              Page {pagination.page}
              {pageCount != null ? ` of ${pageCount}` : ""}
            </span>
            <PageButton
              disabled={
                pageCount == null
                  ? rows.length < pagination.pageSize
                  : pagination.page >= pageCount
              }
              onClick={() => pagination.onPage(pagination.page + 1)}
              label="Next page"
            />
          </nav>
        )}
    </div>
  );
}

function PageButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      style={{
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: "var(--radius, 6px)",
        background: "transparent",
        color: "var(--fg, #0a0a0a)",
        padding: "2px 10px",
        font: "inherit",
      }}
    >
      {label === "Previous page" ? "‹ Prev" : "Next ›"}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/** Layout row for filter controls; wrap `SearchField`/`SelectField`. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <search
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "end",
        gap: 8,
        marginBottom: 8,
      }}
    >
      {children}
    </search>
  );
}

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--muted, #6b7280)",
  marginBottom: 2,
};

const FIELD_BOX: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 6px)",
  background: "transparent",
  color: "var(--fg, #0a0a0a)",
  padding: "4px 8px",
  font: "inherit",
  maxWidth: "100%",
};

/**
 * Controlled search box. The view owns the value (usually a `useParams`
 * entry); pushing every keystroke into params re-renders the whole view, so
 * debounce at the call site when the backing query is expensive.
 */
export function SearchField({
  label = "Search",
  value,
  onChange,
  placeholder = "",
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <label style={{ ...INK, display: "block" }}>
      <span style={FIELD_LABEL}>{label}</span>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...FIELD_BOX, minWidth: 180 }}
      />
    </label>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Controlled select. `value === ""` means "no filter". */
export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label style={{ ...INK, display: "block" }}>
      <span style={FIELD_LABEL}>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={FIELD_BOX}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Charts (dependency-free SVG)                                         */
/* ------------------------------------------------------------------ */

export interface ChartDatum {
  label: string;
  value: number;
  color?: string;
}

const CHART_BAR = "var(--accent, #2563eb)";
const CHART_GRID = "var(--border, #e5e7eb)";
const CHART_TEXT = "var(--muted, #6b7280)";

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

function ChartFrame({
  title,
  height,
  children,
  labelledBy,
}: {
  title?: string;
  height: number;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <figure style={{ ...INK, margin: 0 }}>
      {title && (
        <figcaption
          id={labelledBy}
          style={{ fontWeight: 600, marginBottom: 4 }}
        >
          {title}
        </figcaption>
      )}
      <svg
        role="img"
        aria-labelledby={title ? labelledBy : undefined}
        aria-label={title ? undefined : "Chart"}
        viewBox={`0 0 320 ${height}`}
        width="100%"
        height={height}
        style={{ display: "block" }}
      >
        {children}
      </svg>
    </figure>
  );
}

/** Vertical bars. Values must already be aggregated — views cannot aggregate history. */
export function BarChart({
  data,
  title,
  height = 180,
  formatValue = (v: number) => String(v),
}: {
  data: ChartDatum[];
  title?: string;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const id = useId();
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const min = Math.min(0, ...data.map((d) => d.value));
  const padL = 44;
  const padB = 22;
  const padT = 6;
  const w = 320 - padL - 8;
  const h = height - padT - padB;
  const y = (value: number) => padT + h - ((value - min) / (max - min)) * h;
  const zero = y(0);
  const slot = data.length > 0 ? w / data.length : w;
  const bw = Math.max(2, Math.min(28, slot * 0.6));
  return (
    <ChartFrame title={title} height={height} labelledBy={id}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + h} stroke={CHART_GRID} />
      <line x1={padL} y1={zero} x2={padL + w} y2={zero} stroke={CHART_GRID} />
      <text
        x={padL - 4}
        y={padT + 8}
        textAnchor="end"
        fontSize={9}
        fill={CHART_TEXT}
      >
        {formatValue(max)}
      </text>
      <text
        x={padL - 4}
        y={padT + h}
        textAnchor="end"
        fontSize={9}
        fill={CHART_TEXT}
      >
        {formatValue(min)}
      </text>
      {data.map((d, i) => {
        const bh = Math.abs(y(d.value) - zero);
        const x = padL + i * slot + (slot - bw) / 2;
        const top = Math.min(y(d.value), zero);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Stateless marks allow repeated labels at different positions.
          <g key={`${d.label}-${i}`}>
            <title>{`${d.label}: ${formatValue(d.value)}`}</title>
            <rect
              x={x}
              y={top}
              width={bw}
              height={bh}
              fill={d.color ?? CHART_BAR}
              rx={2}
            />
            <text
              x={x + bw / 2}
              y={padT + h + 12}
              textAnchor="middle"
              fontSize={9}
              fill={CHART_TEXT}
            >
              {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
            </text>
          </g>
        );
      })}
    </ChartFrame>
  );
}

/** Single-series line over ordered labels. */
export function LineChart({
  data,
  title,
  height = 180,
  formatValue = (v: number) => String(v),
}: {
  data: ChartDatum[];
  title?: string;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const id = useId();
  const values = data.map((d) => d.value);
  const max = niceMax(Math.max(0, ...values));
  const min = Math.min(0, ...values);
  const padL = 44;
  const padB = 22;
  const padT = 6;
  const w = 320 - padL - 8;
  const h = height - padT - padB;
  const span = max - min || 1;
  const x = (i: number) =>
    data.length < 2 ? padL + w / 2 : padL + (i / (data.length - 1)) * w;
  const y = (v: number) => padT + h - ((v - min) / span) * h;
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  return (
    <ChartFrame title={title} height={height} labelledBy={id}>
      <line x1={padL} y1={padT} x2={padL} y2={padT + h} stroke={CHART_GRID} />
      <line
        x1={padL}
        y1={padT + h}
        x2={padL + w}
        y2={padT + h}
        stroke={CHART_GRID}
      />
      <text
        x={padL - 4}
        y={padT + 8}
        textAnchor="end"
        fontSize={9}
        fill={CHART_TEXT}
      >
        {formatValue(max)}
      </text>
      {data.length > 0 && (
        <polyline
          points={points}
          fill="none"
          stroke={CHART_BAR}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
      {data.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Stateless marks allow repeated labels at different positions.
        <g key={`${d.label}-${i}`}>
          <title>{`${d.label}: ${formatValue(d.value)}`}</title>
          <circle cx={x(i)} cy={y(d.value)} r={2.5} fill={CHART_BAR} />
          {data.length <= 8 && (
            <text
              x={x(i)}
              y={padT + h + 12}
              textAnchor="middle"
              fontSize={9}
              fill={CHART_TEXT}
            >
              {d.label.length > 10 ? `${d.label.slice(0, 9)}…` : d.label}
            </text>
          )}
        </g>
      ))}
    </ChartFrame>
  );
}

/** Pie with legend. Cap slices upstream (query limit); the chart renders what it gets. */
export function PieChart({
  data,
  title,
  size = 180,
  formatValue = (v: number) => String(v),
}: {
  data: ChartDatum[];
  title?: string;
  size?: number;
  formatValue?: (v: number) => string;
}) {
  const id = useId();
  const total = data.reduce((s, d) => s + (d.value > 0 ? d.value : 0), 0);
  const palette = [
    "#2563eb",
    "#16a34a",
    "#d97706",
    "#dc2626",
    "#7c3aed",
    "#0891b2",
    "#db2777",
    "#65a30d",
  ];
  const r = Math.max(0, Math.min(70, size / 2 - 2));
  const cx = 80;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const frac = total > 0 ? Math.max(0, d.value) / total : 0;
    const a0 = angle;
    angle += frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    return {
      d,
      i,
      frac,
      path: `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`,
    };
  });
  return (
    <figure style={{ ...INK, margin: 0 }}>
      {title && (
        <figcaption id={id} style={{ fontWeight: 600, marginBottom: 4 }}>
          {title}
        </figcaption>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
        }}
      >
        <svg
          role="img"
          aria-labelledby={title ? id : undefined}
          aria-label={title ? undefined : "Pie chart"}
          viewBox={`0 0 160 ${size}`}
          width={160}
          height={size}
          style={{ flexShrink: 0 }}
        >
          {total === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={CHART_GRID} />
          ) : (
            slices.map((s) =>
              s.frac === 1 ? (
                <circle
                  key={s.i}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={s.d.color ?? palette[s.i % palette.length]}
                >
                  <title>{`${s.d.label}: ${formatValue(s.d.value)}`}</title>
                </circle>
              ) : (
                <path
                  key={s.i}
                  d={s.path}
                  fill={s.d.color ?? palette[s.i % palette.length]}
                >
                  <title>{`${s.d.label}: ${formatValue(s.d.value)}`}</title>
                </path>
              )
            )
          )}
        </svg>
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {data.map((d, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Legend entries follow the stateless slice positions, including repeated labels.
              key={`${d.label}-${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 2,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: d.color ?? palette[i % palette.length],
                  flexShrink: 0,
                }}
              />
              <span>
                {d.label}: {formatValue(d.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/** Single-series inline trend. Purely presentational — no axes. */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const x = (i: number) =>
    values.length < 2 ? width / 2 : (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  return (
    <svg
      role="img"
      aria-label={label ?? "Trend"}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: "block" }}
    >
      {values.length === 1 && (
        <circle cx={x(0)} cy={y(values[0])} r={1.5} fill={CHART_BAR} />
      )}
      {values.length > 1 && (
        <polyline
          points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          fill="none"
          stroke={CHART_BAR}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Link                                                                */
/* ------------------------------------------------------------------ */

/**
 * A link the host opens: `href="flat/moda-3"` opens that record in the app
 * (workspace-relative, see `useHost().openLink`), a full URL opens a new tab.
 * The sandboxed frame cannot navigate itself, so every click goes through the
 * host, modifier clicks included.
 */
export function Link({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const { openLink } = useHost();
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openLink(href).catch((error) =>
          console.error("[lobu-views] link not opened", error)
        );
      }}
      style={{ color: "var(--accent, #2563eb)", textDecoration: "none" }}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Query states — render `useQuery` honestly                            */
/* ------------------------------------------------------------------ */

export function LoadingState({ text = "Loading…" }: { text?: string }) {
  return (
    <p role="status" style={{ ...INK, color: "var(--muted, #6b7280)" }}>
      {text}
    </p>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ ...INK, color: "var(--muted, #6b7280)" }}>
      <p style={{ margin: "4px 0" }}>{title}</p>
      {hint && <p style={{ margin: "0 0 4px", fontSize: 12 }}>{hint}</p>}
    </div>
  );
}

export function ErrorState({
  message,
  errorCode,
  onRetry,
}: {
  message: string;
  /** The server's typed code (e.g. UPSTREAM_TIMEOUT). Shown, never branched on for copy. */
  errorCode?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        ...INK,
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: "var(--radius, 6px)",
        padding: "8px 10px",
      }}
    >
      <p style={{ margin: "0 0 4px" }}>{message}</p>
      {errorCode && (
        <p
          style={{
            margin: "0 0 4px",
            fontSize: 12,
            color: "var(--muted, #6b7280)",
          }}
        >
          Code: {errorCode}
        </p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            cursor: "pointer",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: "var(--radius, 6px)",
            background: "transparent",
            color: "var(--fg, #0a0a0a)",
            padding: "2px 10px",
            font: "inherit",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Honest cap notice: the server answered, but not wholly (`query_sql` 500-row
 * ceiling, `query_sdk` oversized return). Rendered data is partial by
 * construction — narrow the query instead of treating it as complete.
 */
export function TruncatedNotice({
  shown,
  total,
}: {
  shown: number;
  total?: number;
}) {
  return (
    <p style={{ ...INK, color: "var(--muted, #6b7280)", fontSize: 12 }}>
      Showing {shown}
      {total != null ? ` of ${total}` : ""} rows — refine filters to see the
      rest.
    </p>
  );
}

/** Format large counts compactly (1.2K, 3.4M). Plain numbers pass through. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
