import {
  connectorFromFile,
  context,
  defineAgent,
  defineAutomation,
  defineConfig,
  defineConnection,
  defineEntityType,
  defineRelationshipType,
  every,
  field,
  reactionFromFile,
  Type,
  viewFromFile,
} from "@lobu/cli/config";
import type InventoryObserver from "./inventory-observer.reaction.ts";
import type StoreBrief from "./store-brief.reaction.ts";
import type StripeChargesConnector from "./stripe-charges.connector.ts";

// Metadata only: no model provider, so applying this example needs no secret.
// The store Automations below are code and run without an agent turn; the
// agent is their owner and permission principal.
const ecommerceOps = defineAgent({
  id: "ecommerce-ops",
  name: "ecommerce-ops",
  description:
    "Manage subscriptions, process order changes, and resolve customer requests",
  dir: ".",
  network: {
    allowed: [
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "registry.npmjs.org",
      ".npmjs.org",
    ],
  },
});

const customer = defineEntityType({
  key: "customer",
  name: "Customer",
  description:
    "A customer with subscriptions, orders, and communication preferences",
  properties: {
    full_name: field("Name", { optional: true }),
    status: field("Status", { optional: true }),
    plan: field("Plan", { optional: true }),
    communication_preference: field("Preference", { optional: true }),
  },
});

const order = defineEntityType({
  key: "order",
  name: "Order",
  description: "A customer order with fulfillment status and delivery details",
  properties: {
    order_number: field("Order", { optional: true }),
    product: field("Product", { optional: true }),
    fulfillment_status: field("Status", { optional: true }),
    customer: field("Customer", { optional: true }),
  },
});

const column = (schema: Record<string, unknown>) =>
  Type.Optional(Type.Unsafe({ ...schema, "x-table-column": true }));

// Fields match the Shopify connector's product traits, so the record page
// shows what the products feed writes.
const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "A product in the catalog linked to subscriptions and orders",
  properties: {
    title: column({ type: "string", title: "Title" }),
    sku: column({ type: "string", title: "SKU" }),
    vendor: column({ type: "string", title: "Vendor" }),
    price: column({ type: "number", title: "Price" }),
    available: column({ type: "integer", title: "Available" }),
    status: column({
      type: "string",
      title: "Shopify status",
      enum: ["ACTIVE", "DRAFT", "ARCHIVED"],
    }),
    admin_url: column({
      type: "string",
      format: "uri",
      title: "Shopify admin",
    }),
  },
});

const subscription = defineEntityType({
  key: "subscription",
  name: "Subscription",
  description:
    "A recurring subscription plan with billing cycle and pending changes",
  properties: {
    plan_name: field("Plan", { optional: true }),
    frequency: field("Frequency", { optional: true }),
    status: field("Status", { optional: true }),
    pending_changes: field("Pending", { optional: true }),
  },
});

const hasPreference = defineRelationshipType({
  key: "has-preference",
  name: "Has Preference",
  description:
    "Persist communication and delivery preferences across interactions.",
});

const placedOrder = defineRelationshipType({
  key: "placed-order",
  name: "Placed Order",
  description: "Link orders to customers so purchase history stays queryable.",
});

const subscribedTo = defineRelationshipType({
  key: "subscribed-to",
  name: "Subscribed To",
  description: "Track which plans and products each customer subscribes to.",
});

// The Lobu Shopify app links the store through its app installation, so this
// declaration leaves `config` unset: apply keeps the stored shop and
// installation link instead of replacing them.
const shopify = defineConnection({
  slug: "shopify-lobu-sample-myshopify-com",
  connector: "shopify",
  name: "Shopify (lobu-sample.myshopify.com)",
  feeds: [
    // Orders are read live from Shopify and never stored, so no schedule.
    { feed: "orders", name: "Orders" },
    { feed: "products", name: "Products & inventory", schedule: "0 */6 * * *" },
  ],
});

const stockState = {
  enum: ["in_stock", "low_stock", "sold_out", "inactive", "not_tracked"],
  description:
    "in_stock, low_stock (at or under the threshold), sold_out, inactive (draft or archived product) or not_tracked (Shopify does not track its stock).",
};

const orderTotals = {
  type: "array",
  items: {
    type: "object",
    properties: {
      currency: { type: "string", title: "Currency" },
      total: { type: "number", title: "Total" },
      orders: { type: "integer", title: "Orders" },
    },
    required: ["currency", "total", "orders"],
  },
};

// Kinds the store Automations write. `$member` is shared, and apply upserts
// only the kinds this config declares.
const storeEventKinds = defineEntityType({
  key: "$member",
  // The live display fields, restated so apply changes only the event kinds.
  name: "Member",
  description: "Organization member",
  eventKinds: {
    "inventory.level": {
      description:
        "Current stock of one Shopify variant. One current record per variant; a new version supersedes it only when stock, price, status or SKU changes.",
      metadataSchema: {
        type: "object",
        properties: {
          variant_id: { type: "string", title: "Variant" },
          title: { type: "string", title: "Title" },
          sku: { type: "string", title: "SKU" },
          vendor: { type: "string", title: "Vendor" },
          price: { type: "number", title: "Price" },
          available: { type: "integer", title: "Available" },
          product_status: { type: "string", title: "Shopify status" },
          stock_state: { ...stockState, title: "Stock state" },
          admin_url: { type: "string", format: "uri", title: "Shopify admin" },
          threshold: { type: "integer", title: "Low-stock threshold" },
        },
        required: [
          "variant_id",
          "title",
          "price",
          "available",
          "product_status",
          "stock_state",
          "admin_url",
        ],
      },
    },
    "inventory.alert": {
      description:
        "A Shopify variant became low on stock, sold out, or recovered. Written once per change.",
      metadataSchema: {
        type: "object",
        properties: {
          variant_id: { type: "string", title: "Variant" },
          title: { type: "string", title: "Title" },
          sku: { type: "string", title: "SKU" },
          transition: {
            enum: ["low_stock", "sold_out", "recovered"],
            title: "Change",
          },
          from_state: { ...stockState, title: "From" },
          to_state: { ...stockState, title: "To" },
          available: { type: "integer", title: "Available" },
          previous_available: { type: "integer", title: "Previously" },
          threshold: { type: "integer", title: "Low-stock threshold" },
          admin_url: { type: "string", format: "uri", title: "Shopify admin" },
        },
        required: [
          "variant_id",
          "title",
          "transition",
          "to_state",
          "available",
        ],
      },
    },
    "store.brief": {
      description:
        "Daily store summary from live Shopify orders and the stock records. Counts, totals and order numbers only; no buyer details.",
      metadataSchema: {
        type: "object",
        properties: {
          date: { type: "string", format: "date", title: "Date" },
          window_start: { type: "string", format: "date-time", title: "From" },
          window_end: { type: "string", format: "date-time", title: "To" },
          orders: { type: "integer", title: "Orders" },
          cancelled: { type: "integer", title: "Cancelled" },
          totals: { ...orderTotals, title: "Sales by currency" },
          units: {
            type: "array",
            title: "Units sold",
            items: {
              type: "object",
              properties: {
                sku: { type: ["string", "null"], title: "SKU" },
                name: { type: "string", title: "Item" },
                units: { type: "integer", title: "Units" },
              },
              required: ["name", "units"],
            },
          },
          unfulfilled_over_48h: {
            type: "array",
            title: "Paid, unfulfilled over 48 hours",
            items: {
              type: "object",
              properties: {
                name: { type: "string", title: "Order" },
                processed_at: { type: "string", title: "Processed" },
                total: { type: "number", title: "Total" },
                currency: { type: "string", title: "Currency" },
                url: { type: "string", format: "uri", title: "Shopify" },
              },
              required: ["name", "processed_at", "url"],
            },
          },
          new_stock_alerts: {
            type: "array",
            title: "New stock alerts",
            items: {
              type: "object",
              properties: {
                title: { type: "string", title: "Variant" },
                sku: { type: "string", title: "SKU" },
                transition: { type: "string", title: "Change" },
                available: { type: "integer", title: "Available" },
                admin_url: { type: "string", title: "Shopify admin" },
              },
              required: ["title", "transition"],
            },
          },
          stock: {
            type: "object",
            title: "Stock",
            properties: {
              variants: { type: "integer", title: "Variants" },
              low_stock: { type: "integer", title: "Low stock" },
              sold_out: { type: "integer", title: "Sold out" },
            },
          },
        },
        required: ["date", "window_start", "window_end", "orders", "totals"],
      },
    },
  },
});

// Code-only Automations: no prompt, skills or outputs, so no agent turn and no
// model provider. Each reads its own inputs; a context-only source keeps event
// arrivals from pacing the schedule.
const inventoryObserver = defineAutomation({
  agent: ecommerceOps,
  slug: "inventory-observer",
  name: "Inventory observer",
  description:
    "Keeps one stock record per Shopify variant and records low-stock, sold-out and recovered changes.",
  // Ten minutes after each products feed sync (0 */6 * * *).
  triggers: [every("10 */6 * * *", { skip_if_unchanged: false })],
  tags: ["ecommerce", "inventory"],
  sources: { clock: context("SELECT CURRENT_TIMESTAMP AS observed_at") },
  reaction: reactionFromFile<typeof InventoryObserver>(
    "./inventory-observer.reaction.ts"
  ),
});

const storeBrief = defineAutomation({
  agent: ecommerceOps,
  slug: "store-brief",
  name: "Daily store brief",
  description:
    "Summarises the last 24 hours of Shopify orders and the stock picture, without buyer details.",
  triggers: [every("0 7 * * *", { skip_if_unchanged: false })],
  tags: ["ecommerce", "orders"],
  sources: { clock: context("SELECT CURRENT_TIMESTAMP AS observed_at") },
  reaction: reactionFromFile<typeof StoreBrief>("./store-brief.reaction.ts"),
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof StripeChargesConnector>(
      "./stripe-charges.connector.ts"
    ),
  ],
  org: "ecommerce",
  orgName: "Ecommerce",
  orgDescription:
    "Manage subscriptions, process order changes, and resolve customer requests",
  agents: [ecommerceOps],
  connections: [shopify],
  entities: [customer, order, product, subscription, storeEventKinds],
  relationships: [hasPreference, placedOrder, subscribedTo],
  automations: [inventoryObserver, storeBrief],
  views: [
    viewFromFile("./views/store-today.tsx"),
    viewFromFile("./views/stock-watch.tsx"),
    viewFromFile("./views/store-orders.tsx"),
  ],
  navigation: {
    schemaVersion: 1,
    sections: [
      {
        id: "store-operations",
        label: "Store operations",
        items: [
          {
            id: "store-today",
            label: "Today",
            icon: "sun",
            target: { kind: "view", key: "store-today" },
          },
          {
            id: "stock-watch",
            label: "Stock watch",
            icon: "package",
            target: { kind: "view", key: "stock-watch" },
          },
          {
            id: "store-orders",
            label: "Orders",
            icon: "receipt",
            target: { kind: "view", key: "store-orders" },
          },
          {
            id: "shopify",
            label: "Shopify",
            icon: "shopping-bag",
            target: { kind: "link", href: "connectors/shopify" },
          },
        ],
      },
    ],
  },
});
