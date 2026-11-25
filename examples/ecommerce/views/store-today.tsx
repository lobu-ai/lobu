import { defineView } from "@lobu/views";
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Link,
  LoadingState,
} from "@lobu/views/components";
import {
  formatMoney,
  formatTime,
  STATE_LABEL,
  type StockLevel,
  useLatestBrief,
  useShopifyFeeds,
  useStockLevels,
} from "./store-data.ts";

export const view = defineView({
  key: "store-today",
  name: "Today",
  description:
    "The latest daily store brief, what needs attention now, and how fresh the data is.",
  attach: [{ workspace: true }],
});

type Attention =
  | { kind: "stock"; key: string; level: StockLevel }
  | {
      kind: "order";
      key: string;
      order: {
        name: string;
        processed_at: string;
        url: string;
        total: number;
        currency: string;
      };
    };

const GRID = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
};
const STATS = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  margin: "0 0 12px",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default function StoreToday() {
  const brief = useLatestBrief();
  const levels = useStockLevels();
  const feeds = useShopifyFeeds();
  const b = brief.brief;

  const attention: Attention[] = [
    ...levels.rows
      .filter(
        (l) => l.stock_state === "sold_out" || l.stock_state === "low_stock"
      )
      .sort((x, y) => x.available - y.available)
      .map((level) => ({
        kind: "stock" as const,
        key: level.variant_id,
        level,
      })),
    ...(b?.unfulfilled_over_48h ?? []).map((order) => ({
      kind: "order" as const,
      key: order.url,
      order,
    })),
  ];
  const lastStockChange = levels.rows.reduce<string | null>(
    (latest, r) => (!latest || r.observed_at > latest ? r.observed_at : latest),
    null
  );

  return (
    <div style={GRID}>
      <Card
        title={b ? `Store brief · ${b.date}` : "Store brief"}
        description={
          b
            ? `Orders processed ${formatTime(b.window_start)} – ${formatTime(b.window_end)}`
            : undefined
        }
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
        ) : (
          <>
            <div style={STATS}>
              <Stat label="Orders" value={String(b.orders)} />
              {b.totals.length ? (
                b.totals.map((t) => (
                  <Stat
                    key={t.currency}
                    label={`Sales (${t.currency})`}
                    value={formatMoney(t.total, t.currency)}
                  />
                ))
              ) : (
                <Stat label="Sales" value="—" />
              )}
              <Stat label="Cancelled" value={String(b.cancelled)} />
            </div>
            <DataTable
              rows={b.units}
              keyOf={(u) => u.sku ?? u.name}
              emptyText="Nothing sold in this window."
              caption="Units sold"
              columns={[
                { key: "name", header: "Item" },
                { key: "sku", header: "SKU", render: (u) => u.sku ?? "—" },
                { key: "units", header: "Units", align: "right" },
              ]}
            />
          </>
        )}
      </Card>

      <Card
        title="Needs attention"
        description="Sold-out and low-stock variants now, and paid orders unfulfilled for over 48 hours at the last brief."
      >
        <DataTable<Attention>
          rows={attention}
          keyOf={(a) => a.key}
          loading={levels.loading || brief.loading}
          error={levels.error}
          onRetry={levels.refetch}
          emptyText="Nothing needs attention."
          columns={[
            {
              key: "what",
              header: "Item",
              render: (a) =>
                a.kind === "stock" ? (
                  <Link href={a.level.admin_url}>{a.level.title}</Link>
                ) : (
                  <Link href={a.order.url}>Order {a.order.name}</Link>
                ),
            },
            {
              key: "issue",
              header: "Issue",
              render: (a) =>
                a.kind === "stock" ? (
                  <Badge
                    variant={
                      a.level.stock_state === "sold_out"
                        ? "destructive"
                        : "default"
                    }
                  >
                    {STATE_LABEL[a.level.stock_state]}
                  </Badge>
                ) : (
                  <Badge variant="default">Unfulfilled</Badge>
                ),
            },
            {
              key: "detail",
              header: "Detail",
              render: (a) =>
                a.kind === "stock"
                  ? `${a.level.available} available`
                  : `${formatMoney(a.order.total, a.order.currency)}, processed ${formatTime(a.order.processed_at)}`,
            },
          ]}
        />
      </Card>

      <Card title="Freshness" description="When each source was last read.">
        {feeds.error ? (
          <ErrorState message={feeds.error} onRetry={feeds.refetch} />
        ) : (
          <dl
            style={{
              margin: 0,
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "6px 12px",
            }}
          >
            <dt>Products & inventory</dt>
            <dd style={{ margin: 0 }}>
              {feeds.loading
                ? "…"
                : feeds.products
                  ? `Synced ${formatTime(feeds.products.last_sync_at)} (${feeds.products.last_sync_status ?? "never"}), next ${formatTime(feeds.products.next_run_at)}`
                  : "No products feed"}
            </dd>
            <dt>Stock levels</dt>
            <dd style={{ margin: 0 }}>
              {levels.loading
                ? "…"
                : `${levels.rows.length} variants, last change ${formatTime(lastStockChange)}`}
            </dd>
            <dt>Orders</dt>
            <dd style={{ margin: 0 }}>
              {feeds.loading
                ? "…"
                : feeds.orders
                  ? "Read live from Shopify on the Orders page"
                  : "No orders feed"}
            </dd>
            <dt>Store brief</dt>
            <dd style={{ margin: 0 }}>
              {brief.loading ? "…" : formatTime(brief.savedAt)}
            </dd>
          </dl>
        )}
      </Card>
    </div>
  );
}
