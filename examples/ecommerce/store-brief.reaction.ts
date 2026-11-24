/**
 * Saves a daily `store.brief`: the last 24 hours of Shopify orders by
 * `processed_at`, read live through the orders feed, plus the stock picture the
 * inventory observer keeps. Code only: no agent turn.
 *
 * Orders are read live and never stored. The brief keeps only counts, totals
 * and order numbers; the orders feed requests no buyer identity, and none is
 * written here.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

const CONNECTOR = "shopify";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A paid order still unfulfilled after this long needs attention. */
const UNFULFILLED_AFTER_MS = 48 * 60 * 60 * 1000;
const READ_PAGE = 250;
const MAX_PAGES = 20;
const NEEDS_ATTENTION = new Set(["low_stock", "sold_out"]);

interface OrderRow {
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

interface FeedRead {
  ok: boolean;
  rows?: OrderRow[];
  next_cursor?: string;
  error?: unknown;
}

interface Feeds {
  list(input: { connection_id: number }): Promise<unknown>;
  readMany(input: {
    reads: Array<{
      feed_id: number;
      query?: string;
      limit?: number;
      cursor?: string;
    }>;
    timeout_ms?: number;
  }): Promise<{ results: FeedRead[] }>;
}

interface StoredEvent {
  id: number;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

/** Shopify search compares whole seconds. */
const shopifyTime = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`;

async function ordersFeedId(client: ReactionClient): Promise<number> {
  const listed = (await client.connections.list({})) as
    | { connections?: Array<{ id: number; connector_key: string }> }
    | Array<{ id: number; connector_key: string }>;
  const rows = Array.isArray(listed) ? listed : (listed.connections ?? []);
  const connection = rows.find((c) => c.connector_key === CONNECTOR);
  if (!connection) throw new Error("No Shopify connection in this workspace");
  const feeds = (client as unknown as { feeds: Feeds }).feeds;
  const listedFeeds = (await feeds.list({ connection_id: connection.id })) as
    | { feeds?: Array<{ id: number; feed_key: string }> }
    | Array<{ id: number; feed_key: string }>;
  const feedRows = Array.isArray(listedFeeds)
    ? listedFeeds
    : (listedFeeds.feeds ?? []);
  const orders = feedRows.find((f) => f.feed_key === "orders");
  if (!orders) throw new Error("The Shopify connection has no orders feed");
  return orders.id;
}

async function readOrders(
  client: ReactionClient,
  feedId: number,
  query: string
): Promise<OrderRow[]> {
  const feeds = (client as unknown as { feeds: Feeds }).feeds;
  const out: OrderRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { results } = await feeds.readMany({
      reads: [
        {
          feed_id: feedId,
          query,
          limit: READ_PAGE,
          ...(cursor ? { cursor } : {}),
        },
      ],
      timeout_ms: 30_000,
    });
    const result = results[0];
    if (!result?.ok)
      throw new Error(
        `Shopify orders read failed: ${JSON.stringify(result?.error ?? null)}`
      );
    out.push(...(result.rows ?? []));
    cursor = result.next_cursor;
    if (!cursor) return out;
  }
  throw new Error(
    `More than ${MAX_PAGES * READ_PAGE} orders matched "${query}"; the brief would be partial`
  );
}

async function readHeads(
  client: ReactionClient,
  semanticType: string,
  limit: number
): Promise<StoredEvent[]> {
  const page = (await client.knowledge.read({
    semantic_type: semanticType,
    sort_by: "date",
    limit,
  })) as { content: StoredEvent[] };
  return page.content;
}

const money = (n: number) => Math.round(n * 100) / 100;

export default async function storeBrief(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<Record<string, unknown>> {
  const end = Date.now();
  const start = end - DAY_MS;
  const feedId = await ordersFeedId(client);

  const recent = (
    await readOrders(client, feedId, `processed_at:>='${shopifyTime(start)}'`)
  ).filter((o) => {
    const at = Date.parse(o.processed_at);
    return at >= start && at < end;
  });

  const totals = new Map<string, { total: number; orders: number }>();
  const units = new Map<
    string,
    { sku: string | null; name: string; units: number }
  >();
  let cancelled = 0;
  for (const order of recent) {
    if (order.cancelled_at) {
      cancelled++;
      continue;
    }
    const t = totals.get(order.currency) ?? { total: 0, orders: 0 };
    t.total += order.total;
    t.orders++;
    totals.set(order.currency, t);
    for (const line of order.line_items) {
      // Some variants have no SKU; their line item name is the stable label.
      const key = line.sku ?? `name:${line.name}`;
      const u = units.get(key) ?? { sku: line.sku, name: line.name, units: 0 };
      u.units += line.quantity;
      units.set(key, u);
    }
  }

  const cutoff = end - UNFULFILLED_AFTER_MS;
  const unfulfilled = (
    await readOrders(
      client,
      feedId,
      `financial_status:paid AND fulfillment_status:unfulfilled AND processed_at:<'${shopifyTime(cutoff)}'`
    )
  )
    .filter(
      (o) =>
        !o.cancelled_at &&
        o.financial_status === "PAID" &&
        o.fulfillment_status === "UNFULFILLED" &&
        Date.parse(o.processed_at) < cutoff
    )
    .map((o) => ({
      name: o.name,
      processed_at: o.processed_at,
      total: o.total,
      currency: o.currency,
      url: o.url,
    }));

  const levels = await readHeads(client, "inventory.level", 2000);
  const attention = levels
    .map((e) => e.metadata)
    .filter((m) => NEEDS_ATTENTION.has(String(m.stock_state)));
  const newAlerts = (await readHeads(client, "inventory.alert", 200))
    .filter((e) => Date.parse(e.occurred_at) >= start)
    .filter((e) => e.metadata.transition !== "recovered")
    .map((e) => ({
      title: String(e.metadata.title),
      ...(typeof e.metadata.sku === "string" ? { sku: e.metadata.sku } : {}),
      transition: String(e.metadata.transition),
      available: Number(e.metadata.available),
      admin_url: String(e.metadata.admin_url),
    }));

  const date = new Date(end).toISOString().slice(0, 10);
  const metadata = {
    date,
    window_start: new Date(start).toISOString(),
    window_end: new Date(end).toISOString(),
    orders: recent.length - cancelled,
    cancelled,
    totals: [...totals].map(([currency, t]) => ({
      currency,
      total: money(t.total),
      orders: t.orders,
    })),
    units: [...units.values()].sort((a, b) => b.units - a.units),
    unfulfilled_over_48h: unfulfilled,
    new_stock_alerts: newAlerts,
    stock: {
      variants: levels.length,
      low_stock: attention.filter((m) => m.stock_state === "low_stock").length,
      sold_out: attention.filter((m) => m.stock_state === "sold_out").length,
    },
  };

  const totalsLine =
    metadata.totals.length > 0
      ? metadata.totals
          .map((t) => `${t.total.toFixed(2)} ${t.currency}`)
          .join(", ")
      : "no sales";
  const lines = [
    `**${metadata.orders} order${metadata.orders === 1 ? "" : "s"}** in the last 24 hours (${totalsLine})${cancelled ? `, ${cancelled} cancelled` : ""}.`,
    ...metadata.units
      .slice(0, 10)
      .map((u) => `- ${u.units} × ${u.name}${u.sku ? ` (${u.sku})` : ""}`),
    unfulfilled.length
      ? `**${unfulfilled.length} paid order${unfulfilled.length === 1 ? "" : "s"} unfulfilled for more than 48 hours:** ${unfulfilled.map((o) => o.name).join(", ")}.`
      : "No paid order has waited more than 48 hours for fulfillment.",
    `Stock: ${metadata.stock.sold_out} sold out, ${metadata.stock.low_stock} low across ${metadata.stock.variants} variants.`,
    ...newAlerts.map(
      (a) =>
        `- New: ${a.title} ${a.transition.replace("_", " ")} (${a.available} left)`
    ),
  ];

  // One brief per day: a rerun on the same day replaces that day's brief.
  const sameDay = (await readHeads(client, "store.brief", 5)).find(
    (e) => e.metadata.date === date
  );
  const saved = await client.knowledge.save({
    semantic_type: "store.brief",
    title: `Store brief · ${date}`,
    content: lines.join("\n"),
    payload_type: "markdown",
    occurred_at: new Date(end).toISOString(),
    idempotency_key: `${ctx.window.run_id}:store-brief`,
    ...(sameDay ? { supersedes_event_id: sameDay.id } : {}),
    metadata,
  });

  return { brief_event_id: saved.id, ...metadata };
}
