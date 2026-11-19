/**
 * Shopify Connector (V1 runtime)
 *
 * Orders, products and inventory from a Shopify store via the GraphQL Admin
 * API. A workspace connects a store through the hosted Lobu Shopify app: the
 * gateway's generic install engine mounts `/shopify/install?shop=` +
 * `/shopify/oauth_callback` from the `app_installation` method below, exchanges
 * the code for an expiring offline token, and renews it gateway-side. Connector
 * code only ever sees the short-lived access token as `ctx.credentials`, and the
 * claimed connection carries the store host under `config.shop`.
 */

import {
  ConnectorRuntime,
  type EventAttributionRule,
  type EventEnvelope,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const API_VERSION = '2026-07';
const PAGE_SIZE = 50;
const MAX_PAGES_PER_RUN = 10;
const SHOP_SUFFIX = '.myshopify.com';

interface Money {
  shopMoney: { amount: string; currencyCode: string };
}

interface ShopifyOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  updatedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  email: string | null;
  customer: { displayName: string | null; email: string | null } | null;
  subtotalPriceSet: Money;
  totalTaxSet: Money;
  totalPriceSet: Money;
  lineItems: {
    nodes: Array<{ sku: string | null; name: string; quantity: number; originalUnitPriceSet: Money }>;
  };
}

interface ShopifyVariant {
  id: string;
  sku: string | null;
  displayName: string;
  price: string;
  inventoryQuantity: number | null;
  updatedAt: string;
  product: { id: string; legacyResourceId: string; title: string; vendor: string; status: string; handle: string };
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const ORDERS_QUERY = `query Orders($first: Int!, $query: String) {
  orders(first: $first, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id legacyResourceId name createdAt processedAt updatedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus email
      customer { displayName email }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 50) { nodes { sku name quantity originalUnitPriceSet { shopMoney { amount currencyCode } } } }
    }
  }
}`;

const VARIANTS_QUERY = `query Variants($first: Int!, $after: String) {
  productVariants(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku displayName price inventoryQuantity updatedAt
      product { id legacyResourceId title vendor status handle }
    }
  }
}`;

const UNPAID_FINANCIAL_STATUSES = new Set(['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID']);

const ORDER_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: 'about',
    autoCreate: true,
    target: {
      entityType: 'order',
      identities: [{ namespace: 'shopify_order', eventPath: 'metadata.order_key' }],
      titlePath: 'metadata.entity_name',
      createWhen: { path: 'metadata.order_key', exists: true },
    },
    traits: {
      document_no: { eventPath: 'metadata.document_no', mergeStrategy: 'init_only' },
      date: { eventPath: 'metadata.date', mergeStrategy: 'init_only' },
      channel: { eventPath: 'metadata.channel', mergeStrategy: 'init_only' },
      currency: { eventPath: 'metadata.currency', mergeStrategy: 'overwrite' },
      status: { eventPath: 'metadata.status', mergeStrategy: 'overwrite' },
      hold_reason: { eventPath: 'metadata.hold_reason', mergeStrategy: 'overwrite' },
      subtotal: { eventPath: 'metadata.subtotal', mergeStrategy: 'overwrite' },
      vat_total: { eventPath: 'metadata.vat_total', mergeStrategy: 'overwrite' },
      grand_total: { eventPath: 'metadata.grand_total', mergeStrategy: 'overwrite' },
      buyer_name: { eventPath: 'metadata.buyer_name', mergeStrategy: 'prefer_non_empty' },
      buyer_email: { eventPath: 'metadata.buyer_email', mergeStrategy: 'prefer_non_empty' },
      shopify_lines: { eventPath: 'metadata.lines', mergeStrategy: 'overwrite' },
      shopify_url: { eventPath: 'metadata.admin_url', mergeStrategy: 'init_only' },
    },
  },
];

const VARIANT_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: 'about',
    autoCreate: true,
    target: {
      entityType: 'product',
      identities: [{ namespace: 'shopify_sku', eventPath: 'metadata.sku_key' }],
      titlePath: 'metadata.entity_name',
      createWhen: { path: 'metadata.sku_key', exists: true },
    },
    traits: {
      title: { eventPath: 'metadata.title', mergeStrategy: 'init_only' },
      code: { eventPath: 'metadata.sku', mergeStrategy: 'init_only' },
      on_hand: { eventPath: 'metadata.available', mergeStrategy: 'init_only' },
      brand: { eventPath: 'metadata.vendor', mergeStrategy: 'prefer_non_empty' },
      shopify_available: { eventPath: 'metadata.available', mergeStrategy: 'overwrite' },
      shopify_price: { eventPath: 'metadata.price', mergeStrategy: 'overwrite' },
      shopify_status: { eventPath: 'metadata.status', mergeStrategy: 'overwrite' },
      shopify_url: { eventPath: 'metadata.admin_url', mergeStrategy: 'init_only' },
    },
  },
];

export default class ShopifyConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'shopify',
    name: 'Shopify',
    version: '1.0.0',
    description: 'Orders, products and inventory from a Shopify store (GraphQL Admin API).',
    faviconDomain: 'shopify.com',
    authSchema: {
      methods: [
        {
          type: 'app_installation',
          provider: 'shopify',
          providerInstance: 'cloud',
          // Standard Shopify OAuth on the merchant's own host: the generic
          // install engine validates the `shop` query param against `tenant`,
          // renders `{{tenant}}` into both URLs, and exchanges the callback code
          // for an expiring offline token. The gateway renews it with the
          // rotating refresh token; neither the client secret nor the refresh
          // token ever reaches connector code.
          installShape: 'oauth-code-exchange',
          authorizeUrl: 'https://{{tenant}}/admin/oauth/authorize',
          tokenUrl: 'https://{{tenant}}/admin/oauth/access_token',
          tenant: { param: 'shop', pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com$' },
          // The hosted Lobu Shopify app's client, declared as env-var NAMES.
          clientIdKey: 'SHOPIFY_CLIENT_ID',
          clientSecretKey: 'SHOPIFY_CLIENT_SECRET',
          permissions: ['read_orders', 'read_products', 'read_inventory', 'read_customers'],
          required: true,
          description: 'Install the Lobu app on your Shopify store to sync orders, products and inventory.',
        },
      ],
    },
    feeds: {
      orders: {
        key: 'orders',
        name: 'Orders',
        description: 'Orders by last update; each order upserts an order record.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          order: { description: 'A Shopify order, emitted on create and every update.', attributions: ORDER_ATTRIBUTIONS },
        },
        sync: (ctx) => this.syncOrders(ctx),
      },
      products: {
        key: 'products',
        name: 'Products & inventory',
        description: 'Product variants with SKU, price and available inventory.',
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          product_variant: {
            description: 'A Shopify product variant and its available inventory.',
            attributions: VARIANT_ATTRIBUTIONS,
          },
        },
        sync: (ctx) => this.syncVariants(ctx),
      },
    },
  };

  /** The store host the install bound to this connection (`config.shop`). */
  private shop(ctx: SyncContext): string {
    const shop = String(ctx.config.shop ?? '')
      .trim()
      .toLowerCase();
    if (
      !shop.endsWith(SHOP_SUFFIX) ||
      shop.length <= SHOP_SUFFIX.length ||
      shop.includes('/') ||
      shop.includes(':') ||
      shop.includes('@')
    ) {
      throw new Error(`Shopify: connection store must be <name>${SHOP_SUFFIX}, got '${shop}'`);
    }
    return shop;
  }

  private token(ctx: SyncContext): string {
    const token = ctx.credentials?.accessToken;
    if (!token) throw new Error('Shopify requires an installed Lobu Shopify app on this connection.');
    return token;
  }

  private async gql<T>(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const json = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(
        `Shopify GraphQL: ${json.errors
          .map((e) => e.message)
          .join('; ')
          .slice(0, 300)}`
      );
    }
    if (!json.data) throw new Error('Shopify GraphQL returned no data');
    return json.data;
  }

  private async syncOrders(ctx: SyncContext): Promise<SyncResult> {
    const shop = this.shop(ctx);
    const token = this.token(ctx);
    let since = String(
      (ctx.checkpoint as { updated_at_min?: string } | null)?.updated_at_min ?? '1970-01-01T00:00:00Z'
    );

    // Pages walk the updated_at watermark (sorted ascending) rather than a cursor,
    // so each committed page leaves a checkpoint the next run can resume from.
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await this.gql<{ orders: { nodes: ShopifyOrder[] } }>(shop, token, ORDERS_QUERY, {
        first: PAGE_SIZE,
        query: `updated_at:>='${since}'`,
      });
      const orders = data.orders.nodes;
      const events: EventEnvelope[] = orders.map((o) => this.orderEvent(shop, o));
      since = orders.at(-1)?.updatedAt ?? since;
      await ctx.commit(events, { updated_at_min: since });
      if (orders.length < PAGE_SIZE) return { status: 'complete' };
    }
    return { status: 'more' };
  }

  private orderEvent(shop: string, o: ShopifyOrder): EventEnvelope {
    const buyer = o.customer?.displayName || '';
    const total = Number(o.totalPriceSet.shopMoney.amount);
    const currency = o.totalPriceSet.shopMoney.currencyCode;
    const status = o.cancelledAt
      ? 'cancelled'
      : o.displayFulfillmentStatus === 'FULFILLED'
        ? 'shipped'
        : o.displayFulfillmentStatus === 'PARTIALLY_FULFILLED'
          ? 'partially_shipped'
          : 'confirmed';
    const unpaid = !o.cancelledAt && UNPAID_FINANCIAL_STATUSES.has(o.displayFinancialStatus ?? '');
    const lines = o.lineItems.nodes.map((l) => ({
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unit_price: Number(l.originalUnitPriceSet.shopMoney.amount),
    }));
    const adminUrl = `https://${shop}/admin/orders/${o.legacyResourceId}`;
    return {
      origin_id: o.id,
      origin_type: 'order',
      title: `Shopify ${o.name} · ${total.toFixed(2)} ${currency}${buyer ? ` · ${buyer}` : ''}`,
      payload_text: [
        `Shopify order ${o.name} (${status}, payment ${o.displayFinancialStatus ?? 'unknown'}) — ${total.toFixed(2)} ${currency}${buyer ? ` from ${buyer}` : ''}.`,
        ...lines.map((l) => `${l.quantity} × ${l.name}${l.sku ? ` [${l.sku}]` : ''} @ ${l.unit_price.toFixed(2)}`),
      ].join('\n'),
      source_url: adminUrl,
      occurred_at: new Date(o.updatedAt),
      metadata: {
        order_key: `${shop}/${o.legacyResourceId}`,
        entity_name: `${o.name} - ${buyer || 'Shopify customer'}`,
        document_no: o.name,
        date: (o.processedAt ?? o.createdAt).slice(0, 10),
        channel: 'Shopify',
        currency,
        status,
        hold_reason: unpaid ? 'Awaiting payment' : '',
        subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
        vat_total: Number(o.totalTaxSet.shopMoney.amount),
        grand_total: total,
        buyer_name: buyer,
        buyer_email: o.customer?.email ?? o.email ?? '',
        financial_status: o.displayFinancialStatus,
        fulfillment_status: o.displayFulfillmentStatus,
        lines,
        admin_url: adminUrl,
      },
    };
  }

  private async syncVariants(ctx: SyncContext): Promise<SyncResult> {
    const shop = this.shop(ctx);
    const token = this.token(ctx);
    const seen = { ...((ctx.checkpoint as { seen?: Record<string, string> } | null)?.seen ?? {}) };
    let after: string | null = (ctx.checkpoint as { after?: string | null } | null)?.after ?? null;

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await this.gql<{ productVariants: { pageInfo: PageInfo; nodes: ShopifyVariant[] } }>(
        shop,
        token,
        VARIANTS_QUERY,
        { first: PAGE_SIZE, after }
      );
      const events: EventEnvelope[] = [];
      for (const v of data.productVariants.nodes) {
        const available = v.inventoryQuantity ?? 0;
        // Only changed variants emit: the checkpoint remembers each variant's
        // last price/stock/status/SKU fingerprint.
        const fingerprint = `${v.price}|${available}|${v.product.status}|${v.sku ?? ''}`;
        if (seen[v.id] === fingerprint) continue;
        seen[v.id] = fingerprint;
        const sku = (v.sku ?? '').trim();
        const name = v.displayName.endsWith(' - Default Title') ? v.product.title : v.displayName;
        const adminUrl = `https://${shop}/admin/products/${v.product.legacyResourceId}`;
        events.push({
          origin_id: v.id,
          origin_type: 'product_variant',
          title: `${name}${sku ? ` [${sku}]` : ''} · ${available} available`,
          payload_text: `${name} (SKU ${sku || 'none'}) — price ${v.price}, ${available} available, ${v.product.status.toLowerCase()} on Shopify.`,
          source_url: adminUrl,
          occurred_at: new Date(v.updatedAt),
          metadata: {
            ...(sku ? { sku, sku_key: sku } : {}),
            entity_name: name,
            title: name,
            vendor: v.product.vendor,
            price: Number(v.price),
            available,
            status: v.product.status,
            admin_url: adminUrl,
          },
        });
      }
      const pageInfo = data.productVariants.pageInfo;
      const next: string | null = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      await ctx.commit(events, { seen, after: next });
      if (!next) return { status: 'complete' };
      after = next;
    }
    return { status: 'more' };
  }

  async execute() {
    return { success: false, error: 'Shopify connector has no actions' };
  }
}
