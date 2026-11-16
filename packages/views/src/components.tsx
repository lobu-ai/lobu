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
 * Styling follows the shell's theme tokens (shadcn names: `--foreground`,
 * `--muted-foreground` for secondary text, `--muted`/`--accent` for surfaces,
 * `--border`, `--primary`, `--font-sans`, `--radius`, `--radius-lg`), which
 * derive from the host's MCP Apps style variables and flip with its `.dark`
 * class, so kit output takes the host's look without configuration. Theme tokens carry
 * light-mode fallbacks; pie series and error accents use fixed colors.
 *
 * Server-side compile allowlist: this module is pinned beside `react` and
 * `@lobu/views` in the view compiler funds, so MCP/tool-path views may
 * `import { DataTable } from "@lobu/views/components"`. Anything fancier
 * (third-party chart/table libraries, user components in other files) ships
 * through `lobu apply`, which bundles the project's own `node_modules`.
 */

import type { CollectionSelection } from "@lobu/core/contracts/tools/collection-selection";
import type {
  ComponentType,
  CSSProperties,
  MouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { createElement, useEffect, useId, useRef, useState } from "react";
import { resolveViewHref, tool, useHost, useQuery } from "./api.js";
import {
  type EntityCollectionProps,
  NATIVE_COMPONENT_GLOBAL,
  type ViewEntity,
} from "./native.js";

const FONT_STACK =
  'var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';

const INK: CSSProperties = {
  color: "var(--foreground, #0a0a0a)",
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
        <p
          style={{
            margin: "0 0 8px",
            color: "var(--color-text-secondary, #6b7280)",
          }}
        >
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
          style={{
            margin: "0 0 6px",
            color: "var(--color-text-secondary, #6b7280)",
          }}
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
                        color: "var(--color-text-info, #2563eb)",
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
            <span style={{ color: "var(--color-text-secondary, #6b7280)" }}>
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
        color: "var(--foreground, #0a0a0a)",
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
  color: "var(--color-text-secondary, #6b7280)",
  marginBottom: 2,
};

const FIELD_BOX: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 6px)",
  background: "transparent",
  color: "var(--foreground, #0a0a0a)",
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

const CHART_BAR = "var(--color-text-info, #2563eb)";
const CHART_GRID = "var(--border, #e5e7eb)";
const CHART_TEXT = "var(--color-text-secondary, #6b7280)";

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

const CHART_FALLBACK_WIDTH = 320;

/** Width of the chart's own box, so the SVG draws at its real size instead of
 *  letterboxing a fixed viewBox inside a wider card. */
function useChartWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(CHART_FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function ChartFrame({
  title,
  width,
  height,
  frameRef,
  children,
  labelledBy,
}: {
  title?: string;
  width: number;
  height: number;
  frameRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <figure ref={frameRef} style={{ ...INK, margin: 0 }}>
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
        viewBox={`0 0 ${width} ${height}`}
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
  const [frameRef, width] = useChartWidth();
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const min = Math.min(0, ...data.map((d) => d.value));
  const padL = 44;
  const padB = 22;
  const padT = 6;
  const w = width - padL - 8;
  const h = height - padT - padB;
  const y = (value: number) => padT + h - ((value - min) / (max - min)) * h;
  const zero = y(0);
  const slot = data.length > 0 ? w / data.length : w;
  const bw = Math.max(2, Math.min(28, slot * 0.6));
  return (
    <ChartFrame
      title={title}
      width={width}
      height={height}
      frameRef={frameRef}
      labelledBy={id}
    >
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

/** Y-axis bounds for a line: include zero by default; `auto` fits the data's
 *  own range, for a series whose movement is small next to its level. */
function lineBounds(
  values: number[],
  baseline: "zero" | "auto"
): { min: number; max: number } {
  if (baseline === "zero" || values.length === 0) {
    return {
      min: Math.min(0, ...values),
      max: niceMax(Math.max(0, ...values)),
    };
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 1;
  return { min: lo - pad, max: hi + pad };
}

/** The end points sit on the plot's edges, so a centred label there spills
 *  past the frame; anchor the first and last labels inward instead. */
function edgeAnchor(i: number, count: number): "start" | "middle" | "end" {
  if (count < 2) return "middle";
  if (i === 0) return "start";
  return i === count - 1 ? "end" : "middle";
}

/** Single-series line over ordered labels. */
export function LineChart({
  data,
  title,
  height = 180,
  baseline = "zero",
  formatValue = (v: number) => String(v),
}: {
  data: ChartDatum[];
  title?: string;
  height?: number;
  /** `zero` (default) includes 0; `auto` fits the data's range. */
  baseline?: "zero" | "auto";
  formatValue?: (v: number) => string;
}) {
  const id = useId();
  const [frameRef, width] = useChartWidth();
  const values = data.map((d) => d.value);
  const { min, max } = lineBounds(values, baseline);
  const padL = 44;
  const padB = 22;
  const padT = 6;
  const w = width - padL - 8;
  const h = height - padT - padB;
  const span = max - min || 1;
  const x = (i: number) =>
    data.length < 2 ? padL + w / 2 : padL + (i / (data.length - 1)) * w;
  const y = (v: number) => padT + h - ((v - min) / span) * h;
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  return (
    <ChartFrame
      title={title}
      width={width}
      height={height}
      frameRef={frameRef}
      labelledBy={id}
    >
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
      {min !== 0 && (
        <text
          x={padL - 4}
          y={padT + h}
          textAnchor="end"
          fontSize={9}
          fill={CHART_TEXT}
        >
          {formatValue(min)}
        </text>
      )}
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
              textAnchor={edgeAnchor(i, data.length)}
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
 * A link the host opens: `href="deal/acme-renewal"` opens that record
 * (relative links resolve against the workspace root, see
 * `useHost().openLink`). On Lobu hosts, supported same-workspace links open
 * the peek pane; other app links navigate normally and external URLs open a new
 * tab. The sandboxed frame cannot navigate itself, so every click goes through the host, modifier
 * clicks included; the anchor still shows the resolved address on hover.
 */
export function Link({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const { openLink } = useHost();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openLink(href).catch((error) =>
      console.error("[lobu-views] link not opened", error)
    );
  };
  return (
    <a
      href={resolveViewHref(href)}
      onClick={open}
      onAuxClick={(event) => {
        if (event.button === 1) open(event);
      }}
      style={{
        color: "var(--color-text-info, #2563eb)",
        textDecoration: "none",
      }}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Query states — render `useQuery` honestly                            */
/* ------------------------------------------------------------------ */

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/** Pulse an element while it is mounted, unless the reader asked for less
 *  motion. The kit ships no stylesheet, so the animation runs from script. */
function usePulse(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const pulse = el.animate(
      [{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }],
      {
        duration: 1600,
        iterations: Number.POSITIVE_INFINITY,
        easing: "ease-in-out",
      }
    );
    return () => pulse.cancel();
  }, [ref]);
}

export interface SkeletonProps {
  /** CSS width; default the full width. */
  width?: number | string;
  /** CSS height; default one line of text. */
  height?: number | string;
  /** Corner radius; default the host's. */
  radius?: number | string;
}

/**
 * A placeholder shaped like what is loading: a pulsing block in the host's
 * muted surface colour. Size it like the content it stands for (a figure,
 * a row, a chart) so the page does not jump when the data lands. Purely
 * visual; announce the wait with `LoadingState` or your own `role="status"`.
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius,
}: SkeletonProps) {
  const ref = useRef<HTMLSpanElement>(null);
  usePulse(ref);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius ?? "var(--radius, 6px)",
        background: "var(--muted, #f3f4f6)",
      }}
    />
  );
}

/**
 * A query's loading state, as skeleton lines in the host's style. `text` is
 * what assistive technology announces; `lines` sets how many lines stand in
 * for the content (default 3).
 */
export function LoadingState({
  text = "Loading…",
  lines = 3,
}: {
  text?: string;
  lines?: number;
}) {
  const widths = ["72%", "94%", "56%", "84%", "64%"];
  // Fixed placeholder lines: each keeps its position for the whole wait.
  const placeholders = Array.from(
    { length: Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : 3 },
    (_, i) => ({ id: `line-${i}`, width: widths[i % widths.length] })
  );
  return (
    <div role="status" style={{ display: "grid", gap: 8, padding: "4px 0" }}>
      {/* Live regions announce their content, not their name: keep the
          text in the region, visible only to assistive technology. */}
      <span style={VISUALLY_HIDDEN}>{text}</span>
      {placeholders.map((line) => (
        <Skeleton key={line.id} width={line.width} height={12} />
      ))}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ ...INK, color: "var(--color-text-secondary, #6b7280)" }}>
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
            color: "var(--color-text-secondary, #6b7280)",
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
            color: "var(--foreground, #0a0a0a)",
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
    <p
      style={{
        ...INK,
        color: "var(--color-text-secondary, #6b7280)",
        fontSize: 12,
      }}
    >
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

/* ------------------------------------------------------------------ */
/* EntityCollection                                                    */
/* ------------------------------------------------------------------ */

/**
 * The native collection where the host supplies native components; anywhere
 * else a plain table over the same `manage_entity_schema get` and
 * `manage_entity list` reads. See `EntityCollectionProps`.
 */
export function EntityCollection(props: EntityCollectionProps) {
  const native = (
    globalThis as unknown as Record<
      string,
      Partial<Record<string, ComponentType<EntityCollectionProps>>> | undefined
    >
  )[NATIVE_COMPONENT_GLOBAL]?.EntityCollection;
  if (native) return createElement(native, props);
  // A new selection starts the fallback table at its first page.
  const key = JSON.stringify([
    props.entityType,
    props.preset,
    props.selection ?? props.defaultSelection,
  ]);
  return createElement(CollectionTable, { ...props, key });
}

// The fallback checks core's CollectionSelectionSchema by hand, bounds
// included: the schema library behind it would add ~227 KB to every view's
// runtime. A malformed selection must fail closed, never widen the read.
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,119}$/;
const MAX_PAGE_SIZE = 500;
const MAX_FILTERS = 32;
const MAX_VALUE = 2000;
// The fixed sorts a stored entity list accepts; anything else lists newest first.
const STORED_SORTS = new Set([
  "name",
  "created_at",
  "total_content",
  "active_connections",
  "automations_count",
  "children_count",
]);

function plainValue(value: unknown, nullable: boolean): boolean {
  if (typeof value === "string") return value.length <= MAX_VALUE;
  if (typeof value === "number") return Number.isFinite(value);
  return nullable && (value === null || typeof value === "boolean");
}

function plainFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== "object") return false;
  const { field, op, value, ...rest } = filter as Record<string, unknown>;
  if (
    Object.keys(rest).length ||
    typeof field !== "string" ||
    !FIELD.test(field)
  )
    return false;
  if (op === "eq" || op === "neq") return plainValue(value, true);
  return (
    (op === "lt" || op === "lte" || op === "gt" || op === "gte") &&
    plainValue(value, false)
  );
}

function boundedString(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function plainSelection(raw: unknown): CollectionSelection {
  const valid =
    !!raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.entries(raw).every(([key, value]) =>
      key === "filters"
        ? Array.isArray(value) &&
          value.length <= MAX_FILTERS &&
          value.every(plainFilter)
        : key === "search"
          ? boundedString(value, 0, 512)
          : key === "segment" && boundedString(value, 1, 120)
    );
  if (!valid) throw new Error("Invalid collection selection");
  return raw as CollectionSelection;
}

interface FallbackTable {
  columns?: string[];
  sort?: { field: string; order: "asc" | "desc" };
}

function plainTable(raw: unknown): FallbackTable {
  const table = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const sort = table.sort as Record<string, unknown> | undefined;
  return {
    columns: Array.isArray(table.columns)
      ? table.columns.filter((c): c is string => typeof c === "string")
      : undefined,
    sort:
      sort &&
      typeof sort.field === "string" &&
      FIELD.test(sort.field) &&
      (sort.order === "asc" || sort.order === "desc")
        ? { field: sort.field, order: sort.order }
        : undefined,
  };
}

/** What a fallback table reads and shows: the preset's selection and table
 *  (or the type's default table). A saved filter it cannot resolve on its
 *  own (a viewer or relative-date preset) is an error, never every row. */
function fallbackCollection(
  schema: Record<string, unknown> | undefined,
  preset: string | undefined,
  selection: CollectionSelection | undefined
): { selection: CollectionSelection; table: FallbackTable } {
  const presentation = schema?.["x-lobu-collection"] as
    | { presets?: unknown; table?: unknown }
    | undefined;
  if (preset === undefined)
    return {
      selection: plainSelection(selection ?? {}),
      table: plainTable(presentation?.table),
    };
  const presets = presentation?.presets;
  const found = Array.isArray(presets)
    ? (presets as Array<Record<string, unknown>>).find(
        (item) => item?.key === preset
      )
    : undefined;
  if (!found || found.viewer !== undefined)
    throw new Error("This saved filter is unavailable. Choose another filter.");
  if (selection === undefined && found.relativeDate !== undefined)
    throw new Error("This saved filter needs the native collection.");
  return {
    selection: plainSelection(selection ?? found.selection ?? {}),
    table: plainTable(found.table ?? presentation?.table),
  };
}

function CollectionTable(props: EntityCollectionProps) {
  const host = useHost();
  const [page, setPage] = useState(1);
  const type = useQuery<{
    entity_type?: {
      name?: string;
      metadata_schema?: Record<string, unknown> | string | null;
      backing_sql?: string | null;
    } | null;
  }>(
    tool("manage_entity_schema", {
      schema_type: "entity_type",
      action: "get",
      slug: props.entityType,
    })
  );
  const rawSchema = type.data?.entity_type?.metadata_schema;
  let schema: Record<string, unknown> | undefined;
  let selection: CollectionSelection | undefined;
  let table: FallbackTable = {};
  let invalid: string | undefined;
  try {
    schema =
      typeof rawSchema === "string"
        ? JSON.parse(rawSchema)
        : (rawSchema ?? undefined);
    ({ selection, table } = fallbackCollection(
      schema,
      props.preset,
      props.selection ?? props.defaultSelection
    ));
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  const pageSize = Math.min(
    Math.max(1, Math.floor(props.pageSize ?? 50) || 50),
    MAX_PAGE_SIZE
  );
  const ready = !!type.data?.entity_type && !invalid;
  // The native collection's order: a derived type sorts by its own columns; a
  // stored type takes only the fixed sorts and otherwise lists newest first.
  const sort = type.data?.entity_type?.backing_sql
    ? table.sort
    : table.sort && STORED_SORTS.has(table.sort.field)
      ? table.sort
      : { field: "created_at", order: "desc" as const };
  const list = useQuery<{
    entities: ViewEntity[];
    metadata?: { has_more?: boolean; total_count?: number };
  }>(
    ready
      ? tool("manage_entity", {
          action: "list",
          entity_type: props.entityType,
          search: selection?.search?.trim() || undefined,
          filters: selection?.filters?.length ? selection.filters : undefined,
          segment: selection?.segment,
          sort_by: sort?.field,
          sort_order: sort?.order,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        })
      : null
  );
  const properties =
    (schema?.properties as
      | Record<string, Record<string, unknown> | undefined>
      | undefined) ?? {};
  const columns: TableColumn<ViewEntity>[] = [
    {
      key: "name",
      header: "Name",
      render: (entity) => (
        <button
          type="button"
          onClick={() =>
            props.onOpenRecord
              ? props.onOpenRecord(entity)
              : void host
                  .openRecord(
                    {
                      entity_id: entity.id ?? entity.slug,
                      entity_type: entity.entity_type,
                    },
                    { mode: "peek" }
                  )
                  .catch((error) =>
                    console.error("[lobu-views] record not opened", error)
                  )
          }
          style={{
            border: 0,
            padding: 0,
            background: "transparent",
            font: "inherit",
            cursor: "pointer",
            textAlign: "left",
            color: "var(--color-text-info, #2563eb)",
          }}
        >
          {entity.name}
        </button>
      ),
    },
    ...Object.entries(properties)
      .filter(
        ([key, prop]) =>
          prop?.["x-table-column"] === true &&
          (!table.columns || table.columns.includes(key))
      )
      .map(([key, prop]) => ({
        key,
        header: String(prop?.["x-table-label"] ?? prop?.title ?? key),
        render: (entity: ViewEntity) => {
          const value = entity.metadata?.[key];
          return value === null || value === undefined
            ? ""
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
        },
      })),
  ];
  const error =
    invalid ??
    type.error ??
    (type.data && !type.data.entity_type ? "Entity type not found." : null) ??
    list.error;
  const rows = list.data?.entities ?? [];
  return (
    <section style={INK} aria-label={props.entityType}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>
          {props.title ?? type.data?.entity_type?.name ?? props.entityType}
        </h2>
        {props.actions}
      </div>
      {error ? (
        <ErrorState
          message={error}
          onRetry={
            invalid
              ? undefined
              : () => (type.error ? type.refetch() : list.refetch())
          }
        />
      ) : !list.loading && list.data && rows.length === 0 && props.empty ? (
        props.empty
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(entity, index) => String(entity.id ?? entity.slug ?? index)}
          loading={type.loading || list.loading || !list.data}
          emptyText="No records."
          pagination={{
            page,
            pageSize,
            total: list.data?.metadata?.total_count,
            onPage: setPage,
          }}
        />
      )}
    </section>
  );
}

export * from "./native.js";
