/**
 * Layout pieces shared by the store views. Colours come from the host's
 * theme variables so light and dark both work.
 */
import { useHost } from "@lobu/views";
import { Button } from "@lobu/views/components";
import type { CSSProperties, ReactNode } from "react";

const MUTED = "var(--color-text-secondary, #6b7280)";

export function Page({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{title}</h1>
        {subtitle ? (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: MUTED }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function Grid({
  min = 280,
  children,
}: {
  min?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

type Tone = "neutral" | "warning" | "danger";

const TONE_BAR: Record<Tone, string> = {
  neutral: "transparent",
  warning: "var(--color-text-warning, #d97706)",
  danger: "var(--color-text-danger, #dc2626)",
};

const TILE: CSSProperties = {
  display: "block",
  height: "100%",
  boxSizing: "border-box",
  padding: "12px 14px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 8px)",
  background: "var(--card, transparent)",
  color: "inherit",
  textDecoration: "none",
};

/**
 * One number with its label. With `href` the whole tile is a drilldown into
 * the page that lists exactly what it counts.
 */
export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  href,
  onClick,
  pressed,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  /** Open this workspace page, which lists exactly what the tile counts. */
  href?: string;
  /** Or apply the filter on this page. */
  onClick?: () => void;
  pressed?: boolean;
}) {
  const body = (
    <div
      style={{
        ...TILE,
        borderLeft: `3px solid ${TONE_BAR[tone]}`,
        ...(pressed
          ? { outline: "2px solid var(--ring, #2563eb)", outlineOffset: -1 }
          : null),
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          lineHeight: 1.3,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{hint}</div>
      ) : null}
    </div>
  );
  const { openLink } = useHost();
  if (!href && !onClick) return body;
  return (
    <button
      type="button"
      aria-pressed={onClick ? Boolean(pressed) : undefined}
      onClick={() => {
        if (onClick) return onClick();
        if (href)
          openLink(href).catch((error) =>
            console.error("[store-views] link not opened", error)
          );
      }}
      style={{
        display: "block",
        width: "100%",
        padding: 0,
        border: "none",
        background: "none",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
        borderRadius: "var(--radius, 8px)",
      }}
    >
      {body}
    </button>
  );
}

export interface Segment {
  value: string;
  label: string;
  count?: number;
}

/** A row of toggle buttons that picks one filter value. */
export function Segments({
  label,
  segments,
  value,
  onChange,
}: {
  label: string;
  segments: Segment[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset
      aria-label={label}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        margin: 0,
        padding: 0,
        border: "none",
        minWidth: 0,
      }}
    >
      {segments.map((s) => {
        const active = s.value === value;
        return (
          <Button
            key={s.value}
            size="sm"
            variant={active ? "default" : "outline"}
            aria-pressed={active}
            onClick={() => onChange(s.value)}
          >
            {s.label}
            {s.count !== undefined ? (
              <span style={{ marginLeft: 6, opacity: 0.7 }}>{s.count}</span>
            ) : null}
          </Button>
        );
      })}
    </fieldset>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span style={{ color: MUTED }}>{children}</span>;
}

/** A row's secondary line under its title. */
export function Sub({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{children}</div>
  );
}
