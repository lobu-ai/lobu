/**
 * Reads shared by the store views. Every read is a public read tool, so a
 * signed-out visitor of the public workspace sees the same pages.
 */
import { tool, useQuery } from "@lobu/views";

export interface StockLevel {
  variant_id: string;
  title: string;
  sku?: string;
  vendor: string;
  price: number;
  available: number;
  product_status: string;
  stock_state:
    | "in_stock"
    | "low_stock"
    | "sold_out"
    | "inactive"
    | "not_tracked";
  admin_url: string;
  threshold: number;
}

export interface StoreBrief {
  date: string;
  window_start: string;
  window_end: string;
  orders: number;
  cancelled: number;
  totals: Array<{ currency: string; total: number; orders: number }>;
  units: Array<{ sku: string | null; name: string; units: number }>;
  unfulfilled_over_48h: Array<{
    name: string;
    processed_at: string;
    total: number;
    currency: string;
    url: string;
  }>;
  new_stock_alerts: Array<{
    title: string;
    sku?: string;
    transition: string;
    available: number;
    admin_url: string;
  }>;
  stock: { variants: number; low_stock: number; sold_out: number };
}

interface KnowledgeEvent<M> {
  id: number;
  occurred_at: string;
  created_at: string;
  metadata: M;
}

interface KnowledgePage<M> {
  content: KnowledgeEvent<M>[];
  total?: number;
  page?: { has_more?: boolean };
}

export interface Feed {
  id: number;
  feed_key: string;
  connector_key: string;
  display_name: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  next_run_at: string | null;
  schedule: string | null;
}

export const STATE_LABEL: Record<StockLevel["stock_state"], string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  sold_out: "Sold out",
  inactive: "Not active",
  not_tracked: "Not tracked",
};

/** Current `inventory.level` records, one per variant. */
export function useStockLevels() {
  const q = useQuery<KnowledgePage<StockLevel>>(
    tool("read_knowledge", { semantic_type: "inventory.level", limit: 2000 })
  );
  return {
    ...q,
    rows: (q.data?.content ?? []).map((e) => ({
      ...e.metadata,
      observed_at: e.occurred_at,
    })),
    truncated: q.truncated || Boolean(q.data?.page?.has_more),
  };
}

/** The newest `store.brief`. */
export function useLatestBrief() {
  const q = useQuery<KnowledgePage<StoreBrief>>(
    tool("read_knowledge", {
      semantic_type: "store.brief",
      sort_by: "date",
      limit: 1,
    })
  );
  const event = q.data?.content?.[0] ?? null;
  return {
    ...q,
    brief: event?.metadata ?? null,
    savedAt: event?.created_at ?? null,
  };
}

/** The workspace's Shopify feeds, keyed by feed key. */
export function useShopifyFeeds() {
  const q = useQuery<{ feeds: Feed[] }>(
    tool("manage_feeds", { action: "list_feeds", limit: 100 })
  );
  const feeds = (q.data?.feeds ?? []).filter(
    (f) => f.connector_key === "shopify"
  );
  return {
    ...q,
    products: feeds.find((f) => f.feed_key === "products") ?? null,
    orders: feeds.find((f) => f.feed_key === "orders") ?? null,
  };
}

export const formatTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

export const formatMoney = (amount: number, currency?: string) =>
  currency
    ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
        amount
      )
    : amount.toFixed(2);
