import { defineView } from "@lobu/views";
import {
  Badge,
  DataTable,
  EntityListPage,
  FilterBar,
  Link,
  SearchField,
  SelectField,
  TruncatedNotice,
} from "@lobu/views/components";
import { useState } from "react";
import {
  formatTime,
  STATE_LABEL,
  type StockLevel,
  useStockLevels,
} from "./store-data.ts";

export const view = defineView({
  key: "stock-watch",
  name: "Stock watch",
  description:
    "Every Shopify variant with its stock state, price and quantity.",
  attach: [{ workspace: true }],
});

const ORDER: StockLevel["stock_state"][] = [
  "sold_out",
  "low_stock",
  "in_stock",
  "not_tracked",
  "inactive",
];

type Row = StockLevel & { observed_at: string };

export default function StockWatch() {
  const levels = useStockLevels();
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");

  const needle = search.trim().toLowerCase();
  const rows = levels.rows
    .filter((r) => !state || r.stock_state === state)
    .filter(
      (r) =>
        !needle ||
        r.title.toLowerCase().includes(needle) ||
        (r.sku ?? "").toLowerCase().includes(needle)
    )
    .sort(
      (a, b) =>
        ORDER.indexOf(a.stock_state) - ORDER.indexOf(b.stock_state) ||
        a.available - b.available ||
        a.title.localeCompare(b.title)
    );
  const threshold = levels.rows[0]?.threshold;

  return (
    <EntityListPage
      title="Stock watch"
      controls={
        <FilterBar>
          <SelectField
            label="Stock state"
            value={state}
            onChange={setState}
            options={ORDER.map((s) => ({ value: s, label: STATE_LABEL[s] }))}
          />
          <SearchField
            label="Search"
            value={search}
            onChange={setSearch}
            placeholder="Variant or SKU"
          />
        </FilterBar>
      }
    >
      <p style={{ margin: "0 0 8px", opacity: 0.75 }}>
        {threshold !== undefined
          ? `Low stock means ${threshold} or fewer units. Gift cards and untracked products are never flagged; draft and archived products are shown as not active.`
          : "Stock levels appear after the inventory observer's first run."}
      </p>
      {levels.truncated ? <TruncatedNotice shown={levels.rows.length} /> : null}
      <DataTable<Row>
        rows={rows}
        keyOf={(r) => r.variant_id}
        loading={levels.loading}
        error={levels.error}
        onRetry={levels.refetch}
        emptyText="No variants match."
        columns={[
          { key: "title", header: "Variant" },
          { key: "sku", header: "SKU", render: (r) => r.sku ?? "—" },
          {
            key: "stock_state",
            header: "State",
            render: (r) => (
              <Badge
                variant={
                  r.stock_state === "sold_out"
                    ? "destructive"
                    : r.stock_state === "low_stock"
                      ? "default"
                      : "outline"
                }
              >
                {STATE_LABEL[r.stock_state]}
              </Badge>
            ),
          },
          { key: "available", header: "Available", align: "right" },
          {
            key: "price",
            header: "Price",
            align: "right",
            render: (r) => r.price.toFixed(2),
          },
          { key: "vendor", header: "Vendor" },
          {
            key: "observed_at",
            header: "Last change",
            render: (r) => formatTime(r.observed_at),
          },
          {
            key: "admin_url",
            header: "Shopify",
            render: (r) => <Link href={r.admin_url}>Open</Link>,
          },
        ]}
      />
    </EntityListPage>
  );
}
