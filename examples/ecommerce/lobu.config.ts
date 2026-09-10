import {
  connectorFromFile,
  defineAgent,
  defineConfig,
  defineSkill,
  defineEntityType,
  defineRelationshipType,
  defineAutomation,
  every,
  secret,
  field,
} from "@lobu/cli/config";
import type EtsyConnector from "./etsy.connector.ts";
import type StripeChargesConnector from "./stripe-charges.connector.ts";

const customerActivityTrackerSkill = defineSkill({
  name: "customer-activity-tracker",
  content:
    "Monitor customers for new orders, subscription changes, delivery requests, and support interactions.\n",
});

const ecommerceOps = defineAgent({
  id: "ecommerce-ops",
  skills: [customerActivityTrackerSkill],
  name: "ecommerce-ops",
  description:
    "Manage subscriptions, process order changes, and resolve customer requests",
  dir: ".",
  providers: [
    {
      id: "anthropic",
      model: "claude/sonnet-4-5",
      key: secret("ANTHROPIC_API_KEY"),
    },
  ],
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

const product = defineEntityType({
  key: "product",
  name: "Product",
  description: "A product in the catalog linked to subscriptions and orders",
  properties: {
    product_name: field("Product", { optional: true }),
    plan_tier: field("Tier", { optional: true }),
    delivery_frequency: field("Delivery", { optional: true }),
    price: field("Price", { optional: true }),
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

const customerActivityTracker = defineAutomation({
  agent: ecommerceOps,
  slug: "customer-activity-tracker",
  name: "Customer activity tracker",
  triggers: [every("0 */6 * * *")],
  tags: ["ecommerce", "customer-ops"],
  minCooldownSeconds: 300,
  skills: ["customer-activity-tracker"],
});

export default defineConfig({
  connectors: [
    connectorFromFile<typeof StripeChargesConnector>(
      "./stripe-charges.connector.ts"
    ),
    connectorFromFile<typeof EtsyConnector>("./etsy.connector.ts"),
  ],
  org: "ecommerce",
  orgName: "Ecommerce",
  orgDescription:
    "Manage subscriptions, process order changes, and resolve customer requests",
  agents: [ecommerceOps],
  entities: [customer, order, product, subscription],
  relationships: [hasPreference, placedOrder, subscribedTo],
  automations: [customerActivityTracker],
});
