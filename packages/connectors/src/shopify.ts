/**
 * Shopify Connector (V1 runtime)
 *
 * Orders, products and inventory from a Shopify store via the GraphQL Admin
 * API. Orders are read live from Shopify and never stored, and the order query
 * requests no buyer identity (name, email, phone, address), so the app stays at
 * Level 1 protected customer data and redaction requests have nothing to erase;
 * products and inventory sync into memory. A workspace connects a store through the hosted Lobu Shopify app: the
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
  type FeedReadContext,
  type FeedReadResult,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const API_VERSION = '2026-07';

/**
 * A Shopify failure carrying the HTTP status the runtime classifies it by
 * (`status` crosses the isolate boundary as `httpStatus`).
 */
class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

/**
 * GraphQL Admin API answers most failures with HTTP 200 and an `errors[]` entry
 * whose `extensions.code` names the HTTP status it stands for. ACCESS_DENIED
 * arrives with a working token whose app lacks a scope or protected customer
 * data approval, so it is a 403: permanent, and no token refresh can fix it.
 */
const GRAPHQL_ERROR_STATUS = new Map<unknown, number>([
  ['ACCESS_DENIED', 403],
  ['THROTTLED', 429],
  ['INTERNAL_SERVER_ERROR', 500],
]);

const PAGE_SIZE = 50;
/** Shopify's connection page-size ceiling. */
const MAX_READ_PAGE = 250;
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
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt processedAt updatedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus
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

const ORDER_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'updated_at', type: 'timestamp' },
  { name: 'processed_at', type: 'timestamp' },
  { name: 'cancelled_at', type: 'timestamp' },
  { name: 'financial_status', type: 'string' },
  { name: 'fulfillment_status', type: 'string' },
  { name: 'currency', type: 'string' },
  { name: 'subtotal', type: 'number' },
  { name: 'total_tax', type: 'number' },
  { name: 'total', type: 'number' },
  { name: 'line_items', type: 'json' },
  { name: 'url', type: 'string' },
];

const VARIANT_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: 'about',
    autoCreate: true,
    target: {
      entityType: 'product',
      // The variant id names every variant, including the many stores' variants
      // that have no SKU; the SKU also matches order line items. Neither is
      // primary, so a product first keyed by SKU alone gains the variant id
      // instead of being duplicated.
      identities: [
        { namespace: 'shopify_variant', eventPath: 'metadata.variant_key' },
        { namespace: 'shopify_sku', eventPath: 'metadata.sku_key' },
      ],
      titlePath: 'metadata.entity_name',
      createWhen: { path: 'metadata.variant_key', exists: true },
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
    version: '3.0.0',
    description: 'Reads orders live and syncs products and inventory from a Shopify store (GraphQL Admin API).',
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
          permissions: ['read_orders', 'read_products', 'read_inventory'],
          required: true,
          description: 'Install the Lobu app on your Shopify store to read orders and sync products and inventory.',
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
        description: 'Orders read live from Shopify, newest update first. Orders are never stored in memory.',
        configSchema: { type: 'object', properties: {} },
        read: (ctx) => this.readOrders(ctx),
        readWindowAxis: 'updated_at',
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
  private shop(ctx: Pick<SyncContext, 'config'>): string {
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

  private token(ctx: Pick<SyncContext, 'credentials'>): string {
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
    if (!r.ok) throw new ShopifyApiError(`Shopify GraphQL ${r.status}: ${(await r.text()).slice(0, 300)}`, r.status);
    const json = (await r.json()) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: unknown } }>;
    };
    if (json.errors?.length) {
      const message = `Shopify GraphQL: ${json.errors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 300)}`;
      const status = json.errors
        .map((e) => GRAPHQL_ERROR_STATUS.get(e.extensions?.code))
        .find((s) => s !== undefined);
      throw status === undefined ? new Error(message) : new ShopifyApiError(message, status);
    }
    if (!json.data) throw new Error('Shopify GraphQL returned no data');
    return json.data;
  }

  /**
   * One page of orders straight from Shopify. Nothing is persisted, and no buyer
   * identity is requested.
   */
  private async readOrders(ctx: FeedReadContext): Promise<FeedReadResult> {
    if (ctx.sort) throw new Error('Shopify orders are read newest update first; caller-defined sort is not supported.');
    if ((ctx.offset ?? 0) > 0) throw new Error('Shopify orders paginate with the returned cursor, not an offset.');
    const shop = this.shop(ctx);
    const token = this.token(ctx);
    const first = Math.min(Math.max(Math.trunc(ctx.limit ?? PAGE_SIZE), 1), MAX_READ_PAGE);

    // Shopify's search compares whole seconds, so the query widens the window
    // to whole seconds and the rows are cut back to the exact [start, end).
    const terms: string[] = [];
    const window = ctx.window ? { start: Date.parse(ctx.window.start), end: Date.parse(ctx.window.end) } : null;
    if (window) {
      const second = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
      terms.push(`updated_at:>='${second(Math.floor(window.start / 1000) * 1000)}'`);
      terms.push(`updated_at:<'${second(Math.ceil(window.end / 1000) * 1000)}'`);
    }
    if (ctx.query?.trim()) terms.push(`(${ctx.query.trim()})`);

    const data = await this.gql<{ orders: { pageInfo: PageInfo; nodes: ShopifyOrder[] } }>(shop, token, ORDERS_QUERY, {
      first,
      after: ctx.cursor ?? null,
      query: terms.length ? terms.join(' AND ') : null,
    });
    const { pageInfo, nodes } = data.orders ?? {};
    if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== 'boolean' || (pageInfo.hasNextPage && !pageInfo.endCursor)) {
      throw new Error('Shopify did not return a valid page cursor/exhaustion state.');
    }
    let orders = nodes;
    if (window) {
      if (orders.some((o) => !Number.isFinite(Date.parse(o.updatedAt)))) {
        throw new Error('Shopify returned an order without a valid updated timestamp.');
      }
      orders = orders.filter((o) => {
        const at = Date.parse(o.updatedAt);
        return at >= window.start && at < window.end;
      });
    }
    const nextCursor = pageInfo.hasNextPage ? (pageInfo.endCursor ?? undefined) : undefined;
    return {
      rows: orders.map((o) => this.orderRow(shop, o)),
      columns: ORDER_COLUMNS,
      ...(ctx.window ? { window: { ...ctx.window, axis: 'updated_at' } } : {}),
      nextCursor,
      hasMore: Boolean(nextCursor),
    };
  }

  private orderRow(shop: string, o: ShopifyOrder): Record<string, unknown> {
    return {
      id: o.id,
      name: o.name,
      updated_at: o.updatedAt,
      processed_at: o.processedAt ?? o.createdAt,
      cancelled_at: o.cancelledAt,
      financial_status: o.displayFinancialStatus,
      fulfillment_status: o.displayFulfillmentStatus,
      currency: o.totalPriceSet.shopMoney.currencyCode,
      subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
      total_tax: Number(o.totalTaxSet.shopMoney.amount),
      total: Number(o.totalPriceSet.shopMoney.amount),
      line_items: o.lineItems.nodes.map((l) => ({
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        unit_price: Number(l.originalUnitPriceSet.shopMoney.amount),
      })),
      url: `https://${shop}/admin/orders/${o.legacyResourceId}`,
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
        // each variant's last name/vendor/price/stock/status/SKU fingerprint,
        // so every field the product record carries reaches it.
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([v.displayName, v.product.vendor, v.price, available, v.product.status, v.sku ?? ''])
          )
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
            variant_key: v.id,
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
