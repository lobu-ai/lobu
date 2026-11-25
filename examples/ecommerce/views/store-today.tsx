import { defineView, useHost } from "@lobu/views";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Link,
  LoadingState,
} from "@lobu/views/components";
import type { ReactNode } from "react";
import {
  formatMoney,
  formatRelative,
  formatTime,
  needsAttention,
  STATE_BADGE,
  STATE_LABEL,
  type StoreBrief,
  useLatestBrief,
  useProductIndex,
  useShopifyFeeds,
  useStockAlerts,
  useStockLevels,
} from "./store-data.ts";
import { Grid, Metric, Muted, Page, PageHeader, Sub } from "./store-ui.tsx";

export const view = defineView({
  key: "store-today",
  name: "Today",
  description:
    "The latest daily store brief, what needs attention now, and how fresh the data is.",
  attach: [{ workspace: true }],
});

const TRANSITION_LABEL: Record<string, string> = {
  sold_out: "Sold out",
  low_stock: "Low stock",
  recovered: "Back in stock",
};

type StoreBriefUnits = StoreBrief["units"];

interface Task {
  key: string;
  rank: number;
  title: string;
  detail: string;
  badge: ReactNode;
  url: string;
  entityId?: number;
}

const ROW = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 0",
  borderTop: "1px solid var(--border, #e5e7eb)",
} as const;

export default function StoreToday() {
  const host = useHost();
  const brief = useLatestBrief();
  const levels = useStockLevels();
  const alerts = useStockAlerts(8);
  const feeds = useShopifyFeeds();
  const products = useProductIndex();
  const b = brief.brief;

  const soldOut = levels.rows.filter((l) => l.stock_state === "sold_out");
  const low = levels.rows.filter((l) => l.stock_state === "low_stock");

  // Overdue orders first, then sold out, then low stock by fewest units.
  const tasks: Task[] = [
    ...(b?.unfulfilled_over_48h ?? []).map((o) => ({
      key: o.url,
      rank: 0,
      title: `Order ${o.name}`,
      detail: `${formatMoney(o.total, o.currency)} · paid ${formatRelative(o.processed_at)}, not fulfilled`,
      badge: <Badge variant="destructive">Overdue</Badge>,
      url: o.url,
    })),
    ...levels.rows
      .filter((l) => needsAttention(l.stock_state))
      .map((l) => ({
        key: l.variant_id,
        rank: l.stock_state === "sold_out" ? 1 : 2,
        title: l.title,
        detail: `${l.available} left${l.sku ? ` · ${l.sku}` : ""}`,
        badge: (
          <Badge variant={STATE_BADGE[l.stock_state]}>
            {STATE_LABEL[l.stock_state]}
          </Badge>
        ),
        url: l.admin_url,
        entityId: products.get(l.admin_url),
        available: l.available,
      }))
      .sort((x, y) => x.available - y.available),
  ].sort((x, y) => x.rank - y.rank);

  const sales = b?.totals ?? [];
  const lastStockChange = levels.rows.reduce<string | null>(
    (latest, r) => (!latest || r.observed_at > latest ? r.observed_at : latest),
    null
  );

  const refresh = () => {
    brief.refetch();
    levels.refetch();
    alerts.refetch();
    feeds.refetch();
  };

  return (
    <Page>
      <PageHeader
        title={b ? `Today · ${b.date}` : "Today"}
        subtitle={
          b
            ? `Brief covers orders processed ${formatTime(b.window_start)} – ${formatTime(b.window_end)}. Stock is current.`
            : "The daily store brief runs every morning at 07:00 UTC."
        }
        actions={
          <Button size="sm" variant="outline" onClick={refresh}>
            Refresh
          </Button>
        }
      />

      <Grid min={170}>
        <Metric
          label="Orders"
          value={brief.loading ? "…" : (b?.orders ?? "—")}
          hint={
            sales.length
              ? sales.map((t) => formatMoney(t.total, t.currency)).join(" · ")
              : b
                ? "No sales in the brief window"
                : "Waiting for the first brief"
          }
          href="store-orders"
        />
        <Metric
          label="Overdue orders"
          value={brief.loading ? "…" : (b?.unfulfilled_over_48h.length ?? "—")}
          hint="Paid, unfulfilled over 48h at the brief"
          tone={b?.unfulfilled_over_48h.length ? "danger" : "neutral"}
          href="store-orders?status=overdue"
        />
        <Metric
          label="Sold out"
          value={levels.loading ? "…" : soldOut.length}
          hint="Active variants with none left"
          tone={soldOut.length ? "danger" : "neutral"}
          href="stock-watch?state=sold_out"
        />
        <Metric
          label="Low stock"
          value={levels.loading ? "…" : low.length}
          hint={
            levels.rows[0]
              ? `At or under ${levels.rows[0].threshold} units`
              : "At or under the threshold"
          }
          tone={low.length ? "warning" : "neutral"}
          href="stock-watch?state=low_stock"
        />
      </Grid>

      <Grid min={420}>
        <Card
          title="Needs attention"
          description="Overdue orders from the last brief, then stock that is out or running low now."
        >
          {levels.loading || brief.loading ? (
            <LoadingState />
          ) : levels.error ? (
            <ErrorState message={levels.error} onRetry={levels.refetch} />
          ) : tasks.length === 0 ? (
            <EmptyState
              title="All clear"
              hint="No overdue orders and nothing low on stock."
            />
          ) : (
            <div>
              {tasks.map((t) => (
                <div key={t.key} style={ROW}>
                  <div style={{ flex: "0 0 92px" }}>{t.badge}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{t.title}</div>
                    <Sub>{t.detail}</Sub>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {t.entityId ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          host
                            .openRecord(
                              {
                                entity_id: t.entityId as number,
                                entity_type: "product",
                              },
                              { mode: "peek" }
                            )
                            .catch((error) =>
                              console.error("[store-today] peek failed", error)
                            )
                        }
                      >
                        Record
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => host.openLink(t.url)}
                    >
                      Shopify ↗
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Sold in the brief window"
          description={b ? `Units per item, ${b.date}` : undefined}
        >
          {brief.loading ? (
            <LoadingState />
          ) : brief.error ? (
            <ErrorState message={brief.error} onRetry={brief.refetch} />
          ) : !b ? (
            <EmptyState
              title="No brief yet"
              hint="The daily store brief runs every morning at 07:00 UTC."
            />
          ) : b.units.length === 0 ? (
            <EmptyState
              title="Nothing sold"
              hint={`${b.orders} orders, ${b.cancelled} cancelled in this window.`}
            />
          ) : (
            <UnitsSold units={b.units} />
          )}
        </Card>

        <Card
          title="Recent stock changes"
          description="Each time a variant sold out, ran low or came back."
          actions={<Link href="stock-watch">Stock watch →</Link>}
        >
          {alerts.loading ? (
            <LoadingState />
          ) : alerts.error ? (
            <ErrorState message={alerts.error} onRetry={alerts.refetch} />
          ) : alerts.alerts.length === 0 ? (
            <EmptyState
              title="No changes yet"
              hint="The inventory observer records transitions after each products sync."
            />
          ) : (
            <div>
              {alerts.alerts.map((a) => (
                <div key={a.id} style={ROW}>
                  <div style={{ flex: "0 0 92px" }}>
                    <Badge
                      variant={
                        a.transition === "recovered"
                          ? "secondary"
                          : a.transition === "sold_out"
                            ? "destructive"
                            : "default"
                      }
                    >
                      {TRANSITION_LABEL[a.transition] ?? a.transition}
                    </Badge>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={a.admin_url}>{a.title}</Link>
                    <Sub>{a.available} available</Sub>
                  </div>
                  <Muted>
                    <span title={formatTime(a.occurred_at)}>
                      {formatRelative(a.occurred_at)}
                    </span>
                  </Muted>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Data freshness"
          description="When each source was last read."
          actions={<Link href="connectors/shopify">Shopify connection →</Link>}
        >
          {feeds.error ? (
            <ErrorState message={feeds.error} onRetry={feeds.refetch} />
          ) : (
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "8px 16px",
              }}
            >
              <Fresh label="Products & inventory">
                {feeds.loading
                  ? "…"
                  : feeds.products
                    ? `Synced ${formatRelative(feeds.products.last_sync_at)} · next ${formatTime(feeds.products.next_run_at)}`
                    : "No products feed"}
              </Fresh>
              <Fresh label="Stock levels">
                {levels.loading
                  ? "…"
                  : `${levels.rows.length} variants · last change ${formatRelative(lastStockChange)}`}
              </Fresh>
              <Fresh label="Orders">
                {feeds.loading
                  ? "…"
                  : feeds.orders
                    ? "Read live on the Orders page"
                    : "No orders feed"}
              </Fresh>
              <Fresh label="Store brief">
                {brief.loading
                  ? "…"
                  : brief.savedAt
                    ? `Saved ${formatRelative(brief.savedAt)} · daily at 07:00 UTC`
                    : "Not run yet · daily at 07:00 UTC"}
              </Fresh>
            </dl>
          )}
        </Card>
      </Grid>
    </Page>
  );
}

/** Items ranked by units, each with a bar scaled to the best seller. */
function UnitsSold({ units }: { units: StoreBriefUnits }) {
  const ranked = [...units].sort((x, y) => y.units - x.units).slice(0, 8);
  const max = ranked[0]?.units || 1;
  return (
    <div>
      {ranked.map((u) => (
        <div key={u.sku ?? u.name} style={{ ...ROW, display: "block" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 6,
            }}
          >
            <span style={{ minWidth: 0 }}>
              {u.name}
              {u.sku ? <Muted> · {u.sku}</Muted> : null}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {u.units} {u.units === 1 ? "unit" : "units"}
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              background: "var(--muted, rgba(127,127,127,0.15))",
            }}
          >
            <div
              style={{
                width: `${(u.units / max) * 100}%`,
                height: "100%",
                borderRadius: 3,
                background: "var(--color-text-info, #2563eb)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Fresh({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ fontWeight: 500 }}>{label}</dt>
      <dd style={{ margin: 0 }}>
        <Muted>{children}</Muted>
      </dd>
    </>
  );
}
