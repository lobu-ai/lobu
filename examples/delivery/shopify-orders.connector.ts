// biome-ignore-all format: stays compact for the landing-page code panel
import { ConnectorRuntime, type SyncContext } from "@lobu/connector-sdk";

export default class ShopifyOrdersConnector extends ConnectorRuntime {
  readonly definition = {
    key: "shopify-orders",
    name: "Shopify orders",
    version: "1.1.0",
    authSchema: { methods: [{ type: "env_keys" as const, fields: [{ key: "access_token", secret: true }] }] },
    feeds: { orders: { key: "orders", name: "Order updates", sync: (ctx: SyncContext) => this.syncFeed(ctx) } },
  };

  private async syncFeed(ctx: SyncContext) {
    const since = (ctx.checkpoint as any)?.updated_at_min ?? "2000-01-01T00:00:00Z";
    const r = await fetch(`https://${ctx.config.shop}/admin/api/2024-10/orders.json?status=any&updated_at_min=${encodeURIComponent(since)}&limit=100`);
    const orders: any[] = ((await r.json() as any).orders ?? []).sort((a: any, b: any) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    await ctx.commit(orders.map((o) => ({
        origin_id: `${o.id}:${o.updated_at}`,
        origin_type: "order_updated",
        title: `Order ${o.name} — ${o.fulfillment_status ?? "unfulfilled"}`,
        payload_text: `Order ${o.name} is ${o.fulfillment_status ?? "unfulfilled"}`,
        source_url: `https://${ctx.config.shop}/admin/orders/${o.id}`,
        occurred_at: new Date(o.updated_at),
      })), { updated_at_min: orders.at(-1)?.updated_at ?? since });
    return { status: 'complete' as const };
  }

  async execute() {
    return { success: false, error: "no actions" };
  }
}
