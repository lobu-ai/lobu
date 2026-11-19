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

import { createHash } from 'node:crypto';
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
  legacyResourceId: string;
  sku: string | null;
  displayName: string;
  price: string;
  inventoryQuantity: number | null;
  updatedAt: string;
  product: { id: string; legacyResourceId: string; title: string; vendor: string; status: string; handle: string };
}

interface OrdersCheckpoint {
  updated_at_min?: string;
  after?: string | null;
  high_water?: string;
}

/**
 * `seen` maps each variant's legacy id to a short hash of its fingerprint as of
 * the last COMPLETE catalog walk; `walk` collects the same for the walk in
 * progress and replaces `seen` when that walk ends, so variants deleted from
 * the store drop out and the checkpoint stays bounded by the catalog size.
 */
interface VariantsCheckpoint {
  seen?: Record<string, string>;
  walk?: Record<string, string>;
  after?: string | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
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
      id legacyResourceId sku displayName price inventoryQuantity updatedAt
      product { id legacyResourceId title vendor status handle }
    }
  }
}`;

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
    // Traits use Shopify's own field names; a workspace maps them onto its own
    // schema in its config, never here.
    traits: {
      name: { eventPath: 'metadata.name', mergeStrategy: 'init_only' },
      processed_at: { eventPath: 'metadata.processed_at', mergeStrategy: 'init_only' },
      currency: { eventPath: 'metadata.currency', mergeStrategy: 'overwrite' },
      financial_status: { eventPath: 'metadata.financial_status', mergeStrategy: 'overwrite' },
      fulfillment_status: { eventPath: 'metadata.fulfillment_status', mergeStrategy: 'overwrite' },
      cancelled_at: { eventPath: 'metadata.cancelled_at', mergeStrategy: 'overwrite' },
      subtotal: { eventPath: 'metadata.subtotal', mergeStrategy: 'overwrite' },
      total_tax: { eventPath: 'metadata.total_tax', mergeStrategy: 'overwrite' },
      total: { eventPath: 'metadata.total', mergeStrategy: 'overwrite' },
      customer_name: { eventPath: 'metadata.customer_name', mergeStrategy: 'prefer_non_empty' },
      customer_email: { eventPath: 'metadata.customer_email', mergeStrategy: 'prefer_non_empty' },
      line_items: { eventPath: 'metadata.line_items', mergeStrategy: 'overwrite' },
      admin_url: { eventPath: 'metadata.admin_url', mergeStrategy: 'init_only' },
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
      title: { eventPath: 'metadata.title', mergeStrategy: 'overwrite' },
      sku: { eventPath: 'metadata.sku', mergeStrategy: 'init_only' },
      vendor: { eventPath: 'metadata.vendor', mergeStrategy: 'prefer_non_empty' },
      available: { eventPath: 'metadata.available', mergeStrategy: 'overwrite' },
      price: { eventPath: 'metadata.price', mergeStrategy: 'overwrite' },
      status: { eventPath: 'metadata.status', mergeStrategy: 'overwrite' },
      admin_url: { eventPath: 'metadata.admin_url', mergeStrategy: 'init_only' },
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
          // checks the callback's `hmac` signature, renders `{{tenant}}` into
          // both URLs, and exchanges the callback code for an expiring offline
          // token (`expiring=1`). The gateway renews it with the rotating
          // refresh token; neither the client secret nor the refresh token ever
          // reaches connector code.
          installShape: 'oauth-code-exchange',
          authorizeUrl: 'https://{{tenant}}/admin/oauth/authorize',
          tokenUrl: 'https://{{tenant}}/admin/oauth/access_token',
          tenant: {
            param: 'shop',
            pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*\\.myshopify\\.com$',
            callbackHmacParam: 'hmac',
          },
          codeExchangeParams: { expiring: '1' },
          // The hosted Lobu Shopify app's client, declared as env-var NAMES.
          // Shopify signs app webhooks with the client secret.
          clientIdKey: 'SHOPIFY_CLIENT_ID',
          clientSecretKey: 'SHOPIFY_CLIENT_SECRET',
          webhookSecretKey: 'SHOPIFY_CLIENT_SECRET',
          permissions: ['read_orders', 'read_products', 'read_inventory', 'read_customers'],
          required: true,
          description: 'Install the Lobu app on your Shopify store to sync orders, products and inventory.',
        },
      ],
    },
    // App-level webhooks configured once on the Lobu Shopify app arrive at
    // `/api/v1/app-webhooks/shopify`, signed with base64 HMAC-SHA256 over the
    // raw body and routed by the shop domain header to the shop's install.
    // `app/uninstalled` revokes the install: feeds stop, history is kept.
    webhook: {
      delivery: 'app_installation',
      signatureHeader: 'x-shopify-hmac-sha256',
      algorithm: 'sha256',
      signatureEncoding: 'base64',
      dedupeHeader: 'x-shopify-webhook-id',
      eventType: { header: 'x-shopify-topic' },
      routingKeyHeader: 'x-shopify-shop-domain',
      uninstallEvents: ['app/uninstalled'],
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
    const checkpoint = ctx.checkpoint as OrdersCheckpoint | null;
    // One walk pages a fixed `updated_at >= since` query by cursor, so orders
    // sharing an updatedAt second never stall it. The cursor is only valid for
    // that query, so it is persisted together with `since`; the watermark moves
    // to the highest updatedAt seen once the walk reaches its last page.
    const since = checkpoint?.updated_at_min ?? '1970-01-01T00:00:00Z';
    let after = checkpoint?.after ?? null;
    let highWater = checkpoint?.high_water ?? since;

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const data = await this.gql<{ orders: { pageInfo: PageInfo; nodes: ShopifyOrder[] } }>(
        shop,
        token,
        ORDERS_QUERY,
        { first: PAGE_SIZE, after, query: `updated_at:>='${since}'` }
      );
      const orders = data.orders.nodes;
      const events: EventEnvelope[] = orders.map((o) => this.orderEvent(shop, o));
      for (const o of orders) if (o.updatedAt > highWater) highWater = o.updatedAt;
      const { hasNextPage, endCursor } = data.orders.pageInfo;
      if (!hasNextPage || !endCursor) {
        await ctx.commit(events, { updated_at_min: highWater });
        return { status: 'complete' };
      }
      after = endCursor;
      await ctx.commit(events, { updated_at_min: since, after, high_water: highWater });
    }
    return { status: 'more' };
  }

  private orderEvent(shop: string, o: ShopifyOrder): EventEnvelope {
    const buyer = o.customer?.displayName || '';
    const total = Number(o.totalPriceSet.shopMoney.amount);
    const currency = o.totalPriceSet.shopMoney.currencyCode;
    const status = o.cancelledAt ? 'cancelled' : (o.displayFulfillmentStatus ?? 'unknown').toLowerCase();
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
        name: o.name,
        processed_at: o.processedAt ?? o.createdAt,
        currency,
        financial_status: o.displayFinancialStatus,
        fulfillment_status: o.displayFulfillmentStatus,
        cancelled_at: o.cancelledAt,
        subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
        total_tax: Number(o.totalTaxSet.shopMoney.amount),
        total,
        customer_name: buyer,
        customer_email: o.customer?.email ?? o.email ?? '',
        line_items: lines,
        admin_url: adminUrl,
      },
    };
  }

  private async syncVariants(ctx: SyncContext): Promise<SyncResult> {
    const shop = this.shop(ctx);
    const token = this.token(ctx);
    const checkpoint = ctx.checkpoint as VariantsCheckpoint | null;
    // Change detection compares against the last complete walk; a resumed walk
    // keeps what it already collected.
    const seen = checkpoint?.seen ?? {};
    let after: string | null = checkpoint?.after ?? null;
    const walk: Record<string, string> = after ? { ...(checkpoint?.walk ?? {}) } : {};

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
        // Only changed variants emit: the checkpoint remembers a short hash of
        // each variant's last price/stock/status/SKU fingerprint.
        const fingerprint = createHash('sha256')
          .update(`${v.price}|${available}|${v.product.status}|${v.sku ?? ''}`)
          .digest('hex')
          .slice(0, 12);
        const previous = walk[v.legacyResourceId] ?? seen[v.legacyResourceId];
        walk[v.legacyResourceId] = fingerprint;
        if (previous === fingerprint) continue;
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
      if (!next) {
        await ctx.commit(events, { seen: walk, after: null });
        return { status: 'complete' };
      }
      await ctx.commit(events, { seen, walk, after: next });
      after = next;
    }
    return { status: 'more' };
  }

  async execute() {
    return { success: false, error: 'Shopify connector has no actions' };
  }
}
