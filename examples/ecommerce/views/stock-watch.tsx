import { defineView, useHost, useParams } from "@lobu/views";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Link,
  SearchField,
  TruncatedNotice,
} from "@lobu/views/components";
import { useState } from "react";
import {
  formatMoney,
  formatRelative,
  formatTime,
  needsAttention,
  STATE_BADGE,
  STATE_LABEL,
  STATE_ORDER,
  type SortDir,
  type StockLevel,
  sortRows,
  useLatestBrief,
  useProductIndex,
  useStockLevels,
} from "./store-data.ts";
import { Grid, Metric, Page, PageHeader, Segments, Sub } from "./store-ui.tsx";

export const view = defineView({
  key: "stock-watch",
  name: "Stock watch",
  description:
    "Every Shopify variant with its stock state, price and quantity.",
  attach: [{ workspace: true }],
  params: {
    state: { type: "string", default: "all" },
    q: { type: "string", default: "" },
  },
});

type Row = StockLevel & { observed_at: string };

/** States that hold countable stock; untracked and inactive variants don't. */
const TRACKED = new Set(["in_stock", "low_stock", "sold_out"]);
const FILTERS = ["all", "attention", ...STATE_ORDER] as const;

const matchesState = (row: Row, state: string) =>
  state === "all"
    ? true
    : state === "attention"
      ? needsAttention(row.stock_state)
      : row.stock_state === state;

const sortValue = (row: Row, key: string): string | number => {
  switch (key) {
    case "title":
      return row.title.toLowerCase();
    case "available":
      return row.available;
    case "price":
      return row.price;
    case "value":
      return TRACKED.has(row.stock_state) ? row.price * row.available : -1;
    case "observed_at":
      return row.observed_at;
    default:
      // Most urgent first: state, then fewest units.
      return STATE_ORDER.indexOf(row.stock_state) * 1e9 + row.available;
  }
};

export default function StockWatch() {
  const [params, setParams] = useParams();
  const host = useHost();
  const levels = useStockLevels();
  const products = useProductIndex();
  const { brief } = useLatestBrief();
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({
    key: "urgency",
    dir: "asc",
  });

  const state = FILTERS.includes(String(params.state) as never)
    ? String(params.state)
    : "all";
  const search = String(params.q ?? "");
  const needle = search.trim().toLowerCase();
  const currency =
    brief?.totals.length === 1 ? brief.totals[0]?.currency : undefined;

  const all = levels.rows;
  const count = (s: string) => all.filter((r) => matchesState(r, s)).length;
  const tracked = all.filter((r) => TRACKED.has(r.stock_state));
  const units = tracked.reduce((n, r) => n + r.available, 0);
  const value = tracked.reduce((n, r) => n + r.price * r.available, 0);
  const soldOut = count("sold_out");
  const low = count("low_stock");
  const threshold = all[0]?.threshold;

  const rows = sortRows(
    all
      .filter((r) => matchesState(r, state))
      .filter(
        (r) =>
          !needle ||
          r.title.toLowerCase().includes(needle) ||
          (r.sku ?? "").toLowerCase().includes(needle) ||
          r.vendor.toLowerCase().includes(needle)
      ),
    sort.key,
    sort.dir,
    sortValue
  );

  const onSort = (key: string) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "title" ? "asc" : "desc" }
    );

  const setState = (next: string) =>
    setParams({ state: next === state && next !== "all" ? "all" : next });

  const openProduct = (row: Row) => {
    const id = products.get(row.admin_url);
    if (id)
      host
        .openRecord({ entity_id: id, entity_type: "product" }, { mode: "peek" })
        .catch((error) => console.error("[stock-watch] peek failed", error));
    else host.openLink(row.admin_url);
  };

  return (
    <Page>
      <PageHeader
        title="Stock watch"
        subtitle={
          threshold !== undefined
            ? `${all.length} variants · low stock is ${threshold} or fewer units · updated ${formatRelative(
                all.reduce(
                  (m, r) => (r.observed_at > m ? r.observed_at : m),
                  ""
                ) || null
              )}`
            : "Stock appears after the inventory observer's first run."
        }
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => levels.refetch()}
            disabled={levels.loading}
          >
            Refresh
          </Button>
        }
      />

      <Grid min={160}>
        <Metric
          label="Sold out"
          value={levels.loading ? "…" : soldOut}
          hint="Tracked, active, none left"
          tone={soldOut ? "danger" : "neutral"}
          pressed={state === "sold_out"}
          onClick={() => setState("sold_out")}
        />
        <Metric
          label="Low stock"
          value={levels.loading ? "…" : low}
          hint={
            threshold !== undefined
              ? `${threshold} or fewer units`
              : "At or under threshold"
          }
          tone={low ? "warning" : "neutral"}
          pressed={state === "low_stock"}
          onClick={() => setState("low_stock")}
        />
        <Metric
          label="Units on hand"
          value={levels.loading ? "…" : units.toLocaleString()}
          hint={`Across ${tracked.length} tracked variants`}
        />
        <Metric
          label="Retail value"
          value={levels.loading ? "…" : formatMoney(value, currency)}
          hint="Price × units on hand"
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
            label="Stock state"
            value={state}
            onChange={(v) => setParams({ state: v })}
            segments={[
              { value: "all", label: "All", count: all.length },
              {
                value: "attention",
                label: "Needs attention",
                count: count("attention"),
              },
              ...STATE_ORDER.map((s) => ({
                value: s,
                label: STATE_LABEL[s],
                count: count(s),
              })),
            ]}
          />
          <div style={{ minWidth: 220, flex: "0 1 280px" }}>
            <SearchField
              label="Search variants"
              value={search}
              onChange={(q) => setParams({ q })}
              placeholder="Name, SKU or vendor"
            />
          </div>
        </div>
        {levels.truncated ? <TruncatedNotice shown={all.length} /> : null}
        <DataTable<Row>
          rows={rows}
          keyOf={(r) => r.variant_id}
          loading={levels.loading}
          error={levels.error}
          onRetry={levels.refetch}
          emptyText={
            needle || state !== "all"
              ? "No variants match these filters."
              : "No stock records yet."
          }
          sort={sort}
          onSort={onSort}
          columns={[
            {
              key: "title",
              header: "Variant",
              sortable: true,
              render: (r) => (
                <div>
                  <button
                    type="button"
                    onClick={() => openProduct(r)}
                    title={
                      products.has(r.admin_url)
                        ? "Open product record"
                        : "Open in Shopify admin"
                    }
                    style={{
                      padding: 0,
                      border: "none",
                      background: "none",
                      font: "inherit",
                      fontWeight: 500,
                      textAlign: "left",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {r.title}
                  </button>
                  <Sub>{[r.sku, r.vendor].filter(Boolean).join(" · ")}</Sub>
                </div>
              ),
            },
            {
              key: "stock_state",
              header: "State",
              render: (r) => (
                <Badge variant={STATE_BADGE[r.stock_state]}>
                  {STATE_LABEL[r.stock_state]}
                </Badge>
              ),
            },
            {
              key: "available",
              header: "Available",
              align: "right",
              sortable: true,
              render: (r) =>
                TRACKED.has(r.stock_state) ? (
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {r.available.toLocaleString()}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "price",
              header: "Price",
              align: "right",
              sortable: true,
              render: (r) => formatMoney(r.price, currency),
            },
            {
              key: "value",
              header: "Retail value",
              align: "right",
              sortable: true,
              render: (r) =>
                TRACKED.has(r.stock_state)
                  ? formatMoney(r.price * r.available, currency)
                  : "—",
            },
            {
              key: "observed_at",
              header: "Last change",
              sortable: true,
              render: (r) => (
                <span title={formatTime(r.observed_at)}>
                  {formatRelative(r.observed_at)}
                </span>
              ),
            },
            {
              key: "admin_url",
              header: "",
              align: "right",
              render: (r) => <Link href={r.admin_url}>Shopify ↗</Link>,
            },
          ]}
        />
      </Card>
    </Page>
  );
}
