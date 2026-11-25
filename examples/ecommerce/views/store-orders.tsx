import { defineView, tool, useQuery } from "@lobu/views";
import {
  Badge,
  Card,
  DataTable,
  EntityListPage,
  ErrorState,
  Link,
} from "@lobu/views/components";
import {
  formatMoney,
  formatTime,
  useLatestBrief,
  useShopifyFeeds,
} from "./store-data.ts";

export const view = defineView({
  key: "store-orders",
  name: "Orders",
  description:
    "Recent Shopify orders, read live from the store. No buyer details are requested.",
  attach: [{ workspace: true }],
});

interface OrderRow {
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

interface FeedReads {
  results: Array<{
    ok: boolean;
    rows?: OrderRow[];
    next_cursor?: string;
    error?: string;
    error_code?: string;
  }>;
}

const label = (status: string) =>
  status.charAt(0) + status.slice(1).toLowerCase().replaceAll("_", " ");

export default function StoreOrders() {
  const feeds = useShopifyFeeds();
  const feedId = feeds.orders?.id ?? null;
  // Orders are read from Shopify on open and on refresh, never stored.
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
  const readError =
    feeds.error ??
    live.error ??
    (result && !result.ok
      ? (result.error ?? "Shopify did not return orders.")
      : null) ??
    (!feeds.loading && !feeds.orders
      ? "This workspace has no Shopify orders feed."
      : null);
  const rows = result?.ok ? (result.rows ?? []) : [];

  return (
    <EntityListPage title="Orders">
      <p style={{ margin: "0 0 8px", opacity: 0.75 }}>
        The 50 most recently updated orders, read live from Shopify when this
        page opens.
      </p>
      {readError ? (
        <BriefFallback message={readError} onRetry={live.refetch} />
      ) : (
        <DataTable<OrderRow>
          rows={rows}
          keyOf={(r) => r.id}
          loading={feeds.loading || live.loading}
          emptyText="No orders yet."
          caption={
            result?.next_cursor ? "More orders exist in Shopify." : undefined
          }
          columns={[
            {
              key: "name",
              header: "Order",
              render: (r) => <Link href={r.url}>{r.name}</Link>,
            },
            {
              key: "processed_at",
              header: "Processed",
              render: (r) => formatTime(r.processed_at),
            },
            {
              key: "total",
              header: "Total",
              align: "right",
              render: (r) => formatMoney(r.total, r.currency),
            },
            {
              key: "financial_status",
              header: "Payment",
              render: (r) =>
                r.cancelled_at ? (
                  <Badge variant="destructive">Cancelled</Badge>
                ) : (
                  <Badge variant="outline">{label(r.financial_status)}</Badge>
                ),
            },
            {
              key: "fulfillment_status",
              header: "Fulfillment",
              render: (r) => (
                <Badge
                  variant={
                    r.fulfillment_status === "FULFILLED"
                      ? "secondary"
                      : "default"
                  }
                >
                  {label(r.fulfillment_status)}
                </Badge>
              ),
            },
            {
              key: "line_items",
              header: "Items",
              render: (r) =>
                r.line_items
                  .map(
                    (l) =>
                      `${l.quantity} × ${l.name}${l.sku ? ` (${l.sku})` : ""}`
                  )
                  .join(", "),
            },
          ]}
        />
      )}
    </EntityListPage>
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
          <p>
            {brief.orders} orders in the 24 hours before the brief
            {brief.totals.length
              ? `: ${brief.totals.map((t) => formatMoney(t.total, t.currency)).join(", ")}`
              : ""}
            .
          </p>
          {brief.unfulfilled_over_48h.length ? (
            <p>
              Paid and unfulfilled for over 48 hours:{" "}
              {brief.unfulfilled_over_48h.map((o) => o.name).join(", ")}
            </p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
