import { defineView, useParams } from "@lobu/views";
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Link,
  SearchField,
} from "@lobu/views/components";
import { useState } from "react";
import {
  formatMoney,
  formatRelative,
  formatTime,
  type OrderRow,
  type SortDir,
  sortRows,
  statusLabel,
  useLatestBrief,
  useLiveOrders,
} from "./store-data.ts";
import {
  Grid,
  Metric,
  Muted,
  Page,
  PageHeader,
  Segments,
  Sub,
} from "./store-ui.tsx";

export const view = defineView({
  key: "store-orders",
  name: "Orders",
  description:
    "Recent Shopify orders, read live from the store. No buyer details are requested.",
  attach: [{ workspace: true }],
  params: {
    status: { type: "string", default: "all" },
    q: { type: "string", default: "" },
  },
});

/** The daily brief's rule for an overdue order. */
const OVERDUE_MS = 48 * 60 * 60 * 1000;

const isOpen = (o: OrderRow) =>
  !o.cancelled_at &&
  o.financial_status === "PAID" &&
  o.fulfillment_status === "UNFULFILLED";

const FILTERS: Record<string, (o: OrderRow, now: number) => boolean> = {
  all: () => true,
  unfulfilled: (o) => isOpen(o),
  overdue: (o, now) =>
    isOpen(o) && now - new Date(o.processed_at).getTime() > OVERDUE_MS,
  fulfilled: (o) => !o.cancelled_at && o.fulfillment_status === "FULFILLED",
  cancelled: (o) => Boolean(o.cancelled_at),
};

const units = (o: OrderRow) => o.line_items.reduce((n, l) => n + l.quantity, 0);

const sortValue = (o: OrderRow, key: string): string | number => {
  switch (key) {
    case "total":
      return o.total;
    case "items":
      return units(o);
    case "name":
      return o.name;
    default:
      return o.processed_at;
  }
};

export default function StoreOrders() {
  const [params, setParams] = useParams();
  const orders = useLiveOrders();
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({
    key: "processed_at",
    dir: "desc",
  });
  const now = Date.now();

  const status =
    String(params.status) in FILTERS ? String(params.status) : "all";
  const search = String(params.q ?? "");
  const needle = search.trim().toLowerCase();
  const all = orders.rows;
  const count = (s: string) => all.filter((o) => FILTERS[s]?.(o, now)).length;

  // Order value per currency over the orders read, cancelled ones excluded.
  const byCurrency = new Map<string, { total: number; orders: number }>();
  for (const o of all) {
    if (o.cancelled_at) continue;
    const c = byCurrency.get(o.currency) ?? { total: 0, orders: 0 };
    c.total += o.total;
    c.orders += 1;
    byCurrency.set(o.currency, c);
  }
  const currencies = [...byCurrency.entries()];
  const overdue = count("overdue");
  const unfulfilled = count("unfulfilled");

  const rows = sortRows(
    all
      .filter((o) => FILTERS[status]?.(o, now))
      .filter(
        (o) =>
          !needle ||
          o.name.toLowerCase().includes(needle) ||
          o.line_items.some(
            (l) =>
              l.name.toLowerCase().includes(needle) ||
              (l.sku ?? "").toLowerCase().includes(needle)
          )
      ),
    sort.key,
    sort.dir,
    sortValue
  );

  const onSort = (key: string) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" }
    );
  const pick = (next: string) =>
    setParams({ status: next === status ? "all" : next });

  return (
    <Page>
      <PageHeader
        title="Orders"
        subtitle={
          orders.readAt
            ? `${all.length === 1 ? "The most recently updated order" : `The ${all.length} most recently updated orders`}, read live from Shopify ${formatRelative(orders.readAt)}. No buyer details are requested.`
            : "Read live from Shopify when this page opens. No buyer details are requested."
        }
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => orders.refetch()}
            disabled={orders.loading}
          >
            {orders.loading ? "Reading…" : "Refresh"}
          </Button>
        }
      />

      {orders.error ? (
        <BriefFallback message={orders.error} onRetry={orders.refetch} />
      ) : (
        <>
          <Grid min={160}>
            {currencies.length ? (
              currencies.map(([currency, c]) => (
                <Metric
                  key={currency}
                  label={`Order value · ${currency}`}
                  value={formatMoney(c.total, currency)}
                  hint={`${c.orders} ${c.orders === 1 ? "order" : "orders"} · avg ${formatMoney(c.total / c.orders, currency)}`}
                />
              ))
            ) : (
              <Metric
                label="Order value"
                value={orders.loading ? "…" : "—"}
                hint="No paid orders in this read"
              />
            )}
            <Metric
              label="Awaiting fulfillment"
              value={orders.loading ? "…" : unfulfilled}
              hint="Paid, not shipped"
              tone={unfulfilled ? "warning" : "neutral"}
              pressed={status === "unfulfilled"}
              onClick={() => pick("unfulfilled")}
            />
            <Metric
              label="Overdue"
              value={orders.loading ? "…" : overdue}
              hint="Paid and waiting over 48 hours"
              tone={overdue ? "danger" : "neutral"}
              pressed={status === "overdue"}
              onClick={() => pick("overdue")}
            />
            <Metric
              label="Cancelled"
              value={orders.loading ? "…" : count("cancelled")}
              hint="In this read"
              pressed={status === "cancelled"}
              onClick={() => pick("cancelled")}
            />
          </Grid>

          <Card>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <Segments
                label="Order status"
                value={status}
                onChange={(v) => setParams({ status: v })}
                segments={[
                  { value: "all", label: "All", count: all.length },
                  {
                    value: "unfulfilled",
                    label: "Awaiting fulfillment",
                    count: unfulfilled,
                  },
                  { value: "overdue", label: "Overdue", count: overdue },
                  {
                    value: "fulfilled",
                    label: "Fulfilled",
                    count: count("fulfilled"),
                  },
                  {
                    value: "cancelled",
                    label: "Cancelled",
                    count: count("cancelled"),
                  },
                ]}
              />
              <div style={{ minWidth: 220, flex: "0 1 280px" }}>
                <SearchField
                  label="Search orders"
                  value={search}
                  onChange={(q) => setParams({ q })}
                  placeholder="Order #, item or SKU"
                />
              </div>
            </div>
            <DataTable<OrderRow>
              rows={rows}
              keyOf={(o) => o.id}
              loading={orders.loading}
              emptyText={
                needle || status !== "all"
                  ? "No orders match these filters."
                  : "No orders yet."
              }
              caption={
                orders.hasMore
                  ? "Older orders exist in Shopify beyond this read."
                  : undefined
              }
              sort={sort}
              onSort={onSort}
              columns={[
                {
                  key: "name",
                  header: "Order",
                  sortable: true,
                  render: (o) => (
                    <div>
                      <Link href={o.url}>{o.name}</Link>
                      <Sub>
                        <span title={formatTime(o.processed_at)}>
                          {formatRelative(o.processed_at)}
                        </span>
                      </Sub>
                    </div>
                  ),
                },
                {
                  key: "items",
                  header: "Items",
                  sortable: true,
                  render: (o) => <Items order={o} />,
                },
                {
                  key: "total",
                  header: "Total",
                  align: "right",
                  sortable: true,
                  render: (o) => (
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        textDecoration: o.cancelled_at
                          ? "line-through"
                          : undefined,
                      }}
                    >
                      {formatMoney(o.total, o.currency)}
                    </span>
                  ),
                },
                {
                  key: "financial_status",
                  header: "Payment",
                  render: (o) =>
                    o.cancelled_at ? (
                      <Badge variant="destructive">Cancelled</Badge>
                    ) : (
                      <Badge
                        variant={
                          o.financial_status === "PAID"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {statusLabel(o.financial_status)}
                      </Badge>
                    ),
                },
                {
                  key: "fulfillment_status",
                  header: "Fulfillment",
                  render: (o) =>
                    o.cancelled_at ? (
                      <Muted>—</Muted>
                    ) : FILTERS.overdue?.(o, now) ? (
                      <Badge variant="destructive">Overdue</Badge>
                    ) : (
                      <Badge
                        variant={
                          o.fulfillment_status === "FULFILLED"
                            ? "secondary"
                            : "default"
                        }
                      >
                        {statusLabel(o.fulfillment_status)}
                      </Badge>
                    ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </Page>
  );
}

/** The first item in full; the rest expand on click. */
function Items({ order }: { order: OrderRow }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = order.line_items;
  if (!first) return <Muted>No items</Muted>;
  const line = (l: OrderRow["line_items"][number], i: number) => (
    <div key={`${l.sku ?? l.name}:${i}`}>
      {l.quantity} × {l.name}
      {l.sku ? <Muted> · {l.sku}</Muted> : null}
    </div>
  );
  return (
    <div>
      {line(first, 0)}
      {rest.length ? (
        open ? (
          rest.map((l, i) => line(l, i + 1))
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{
              padding: 0,
              border: "none",
              background: "none",
              font: "inherit",
              fontSize: 12,
              color: "var(--color-text-info, #2563eb)",
              cursor: "pointer",
            }}
          >
            +{rest.length} more
          </button>
        )
      ) : null}
    </div>
  );
}

/** When the live read is unavailable, the last daily brief still has totals. */
function BriefFallback({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { brief, savedAt } = useLatestBrief();
  return (
    <>
      <ErrorState
        message={`Live orders unavailable: ${message}`}
        onRetry={onRetry}
      />
      {brief ? (
        <Card
          title={`From the store brief of ${brief.date}`}
          description={`Saved ${formatTime(savedAt)}`}
        >
          <p style={{ margin: 0 }}>
            {brief.orders} orders in the 24 hours before the brief
            {brief.totals.length
              ? `: ${brief.totals.map((t) => formatMoney(t.total, t.currency)).join(", ")}`
              : ""}
            .
          </p>
          {brief.unfulfilled_over_48h.length ? (
            <p style={{ margin: "8px 0 0" }}>
              Paid and unfulfilled for over 48 hours:{" "}
              {brief.unfulfilled_over_48h.map((o) => o.name).join(", ")}
            </p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
