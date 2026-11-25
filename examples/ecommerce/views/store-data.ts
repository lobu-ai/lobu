/**
 * Reads shared by the store views. Every read is a public read tool, so a
 * signed-out visitor of the public workspace sees the same pages.
 */
import { tool, useQuery } from "@lobu/views";
import { useEffect, useState } from "react";

export type StockState =
  | "in_stock"
  | "low_stock"
  | "sold_out"
  | "inactive"
  | "not_tracked";

export interface StockLevel {
  variant_id: string;
  title: string;
  sku?: string;
  vendor: string;
  price: number;
  available: number;
  product_status: string;
  stock_state: StockState;
  admin_url: string;
  threshold: number;
}

export interface StockAlert {
  variant_id: string;
  title: string;
  sku?: string;
  transition: string;
  to_state?: StockState;
  available: number;
  threshold: number;
  admin_url: string;
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

export interface OrderRow {
  id: string;
  name: string;
  processed_at: string;
  cancelled_at: string | null;
  financial_status: string;
  fulfillment_status: string;
  currency: string;
  total: number;
  line_items: Array<{ sku: string | null; name: string; quantity: number }>;
  url: string;
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

interface ProductEntity {
  id: number;
  entity_type: string;
  metadata: { admin_url?: string };
}

export const STATE_ORDER: StockState[] = [
  "sold_out",
  "low_stock",
  "in_stock",
  "not_tracked",
  "inactive",
];

export const STATE_LABEL: Record<StockState, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  sold_out: "Sold out",
  inactive: "Not active",
  not_tracked: "Not tracked",
};

export const STATE_BADGE: Record<
  StockState,
  "default" | "secondary" | "destructive" | "outline"
> = {
  sold_out: "destructive",
  low_stock: "default",
  in_stock: "secondary",
  not_tracked: "outline",
  inactive: "outline",
};

export const needsAttention = (s: StockState) =>
  s === "sold_out" || s === "low_stock";

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

/** The newest stock transitions, newest first. */
export function useStockAlerts(limit = 10) {
  const q = useQuery<KnowledgePage<StockAlert>>(
    tool("read_knowledge", { semantic_type: "inventory.alert", limit })
  );
  return {
    ...q,
    alerts: (q.data?.content ?? [])
      .map((e) => ({ ...e.metadata, id: e.id, occurred_at: e.occurred_at }))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
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

/**
 * Product records keyed by their Shopify admin URL, so a stock row can open
 * the product's record peek. A variant without a matching record keeps its
 * Shopify link.
 */
export function useProductIndex() {
  const q = useQuery<{ entities?: ProductEntity[] }>(
    tool("manage_entity", {
      action: "list",
      entity_type: "product",
      limit: 500,
    })
  );
  const byAdminUrl = new Map<string, number>();
  for (const e of q.data?.entities ?? []) {
    if (e.metadata?.admin_url) byAdminUrl.set(e.metadata.admin_url, e.id);
  }
  return byAdminUrl;
}

interface FeedReads {
  results: Array<{
    ok: boolean;
    rows?: OrderRow[];
    next_cursor?: string;
    error?: string;
  }>;
}

/**
 * The 50 most recently updated orders, read from Shopify on open and on
 * refresh, never stored.
 */
export function useLiveOrders() {
  const feeds = useShopifyFeeds();
  const feedId = feeds.orders?.id ?? null;
  const live = useQuery<FeedReads>(
    feedId
      ? tool("manage_feeds", {
          action: "read_feeds",
          reads: [{ feed_id: feedId, limit: 50 }],
          timeout_ms: 15000,
        })
      : null,
    { live: false }
  );
  const result = live.data?.results?.[0];
  // The read carries no timestamp, so note when each answer arrived.
  const [readAt, setReadAt] = useState<string | null>(null);
  useEffect(() => {
    if (live.data) setReadAt(new Date().toISOString());
  }, [live.data]);
  const error =
    feeds.error ??
    live.error ??
    (result && !result.ok
      ? (result.error ?? "Shopify did not return orders.")
      : null) ??
    (!feeds.loading && !feeds.orders
      ? "This workspace has no Shopify orders feed."
      : null);
  return {
    loading: feeds.loading || live.loading,
    error,
    refetch: live.refetch,
    rows: result?.ok ? (result.rows ?? []) : [],
    hasMore: Boolean(result?.ok && result.next_cursor),
    readAt,
  };
}

export type SortDir = "asc" | "desc";

/** Client-side sort for rows already in the view; the reads are bounded. */
export function sortRows<T>(
  rows: T[],
  key: string,
  dir: SortDir,
  value: (row: T, key: string) => string | number
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a, key);
    const y = value(b, key);
    return (
      sign *
      (typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true }))
    );
  });
}

export const formatTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

export const formatRelative = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Math.abs(minutes) < 1) return "just now";
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return fmt.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return fmt.format(-hours, "hour");
  return fmt.format(-Math.round(hours / 24), "day");
};

export const formatMoney = (amount: number, currency?: string) =>
  currency
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: amount >= 1000 ? 0 : 2,
      }).format(amount)
    : amount.toFixed(2);

export const statusLabel = (status: string) =>
  status.charAt(0) + status.slice(1).toLowerCase().replaceAll("_", " ");
