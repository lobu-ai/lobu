import {
  type ActionContext,
  type ActionResult,
  ConnectorRuntime,
  type FeedReadContext,
  type RuntimeConnectorDefinition,
  type SyncContext,
  type SyncResult,
  sleep,
  withHttpRetry,
} from "@lobu/connector-sdk";

type Context = Pick<FeedReadContext, "credentials" | "config">;
// Request schemas extracted from Etsy Open API v3. check-etsy-drift.ts verifies
// these against the provider spec; startup does not fetch or interpret a spec.
export const writeContracts = {
  create_draft_listing: {
    operationId: "createDraftListing",
    path: "shops/{shop_id}/listings",
    method: "POST",
    media: "application/x-www-form-urlencoded",
    scope: "listings_w",
    schema: {
      type: "object",
      required: [
        "quantity",
        "title",
        "description",
        "price",
        "who_made",
        "when_made",
        "taxonomy_id",
      ],
      properties: {
        quantity: {
          type: "integer",
        },
        title: {
          type: "string",
        },
        description: {
          type: "string",
        },
        price: {
          type: "number",
        },
        who_made: {
          type: "string",
          enum: ["i_did", "someone_else", "collective"],
        },
        when_made: {
          type: "string",
          enum: [
            "made_to_order",
            "2020_2026",
            "2010_2019",
            "2007_2009",
            "before_2007",
            "2000_2006",
            "1990s",
            "1980s",
            "1970s",
            "1960s",
            "1950s",
            "1940s",
            "1930s",
            "1920s",
            "1910s",
            "1900s",
            "1800s",
            "1700s",
            "before_1700",
          ],
        },
        taxonomy_id: {
          type: "integer",
          minimum: 1,
        },
        shipping_profile_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        return_policy_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        materials: {
          type: "array",
          nullable: true,
          items: {
            type: "string",
          },
        },
        shop_section_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        processing_min: {
          type: "integer",
          nullable: true,
        },
        processing_max: {
          type: "integer",
          nullable: true,
        },
        readiness_state_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        tags: {
          type: "array",
          nullable: true,
          items: {
            type: "string",
          },
        },
        styles: {
          type: "array",
          nullable: true,
          items: {
            type: "string",
          },
        },
        item_weight: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_length: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_width: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_height: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_weight_unit: {
          type: "string",
          nullable: true,
          enum: ["oz", "lb", "g", "kg"],
        },
        item_dimensions_unit: {
          type: "string",
          nullable: true,
          enum: ["in", "ft", "mm", "cm", "m", "yd", "inches"],
        },
        production_partner_ids: {
          type: "array",
          nullable: true,
          items: {
            type: "integer",
            minimum: 1,
          },
        },
        image_ids: {
          type: "array",
          nullable: true,
          items: {
            type: "integer",
            minimum: 1,
          },
        },
        is_supply: {
          type: "boolean",
        },
        is_customizable: {
          type: "boolean",
        },
        should_auto_renew: {
          type: "boolean",
        },
        is_taxable: {
          type: "boolean",
        },
        type: {
          type: "string",
          enum: ["physical", "download", "both"],
        },
      },
    },
  },
  replace_inventory: {
    operationId: "updateListingInventory",
    path: "listings/{listing_id}/inventory",
    method: "PUT",
    media: "application/json",
    scope: "listings_w",
    schema: {
      type: "object",
      required: ["products"],
      properties: {
        products: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: {
                type: "string",
                nullable: true,
              },
              property_values: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    property_id: {
                      type: "integer",
                      minimum: 1,
                    },
                    value_ids: {
                      type: "array",
                      items: {
                        type: "integer",
                        minimum: 1,
                      },
                    },
                    scale_id: {
                      type: "integer",
                      nullable: true,
                      minimum: 1,
                    },
                    property_name: {
                      type: "string",
                    },
                    values: {
                      type: "array",
                      items: {
                        type: "string",
                      },
                    },
                  },
                  required: ["property_id", "value_ids", "values"],
                },
              },
              offerings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    price: {
                      type: "number",
                    },
                    quantity: {
                      type: "integer",
                    },
                    is_enabled: {
                      type: "boolean",
                    },
                    readiness_state_id: {
                      type: "integer",
                      nullable: true,
                      minimum: 1,
                    },
                  },
                  required: [
                    "price",
                    "quantity",
                    "is_enabled",
                    "readiness_state_id",
                  ],
                },
              },
            },
            required: ["offerings"],
          },
        },
        price_on_property: {
          type: "array",
          items: {
            type: "integer",
          },
        },
        quantity_on_property: {
          type: "array",
          items: {
            type: "integer",
          },
        },
        sku_on_property: {
          type: "array",
          items: {
            type: "integer",
          },
        },
        readiness_state_on_property: {
          type: "array",
          nullable: true,
          items: {
            type: "integer",
            minimum: 1,
          },
        },
      },
    },
  },
  update_listing: {
    operationId: "updateListing",
    path: "shops/{shop_id}/listings/{listing_id}",
    method: "PATCH",
    media: "application/x-www-form-urlencoded",
    scope: "listings_w",
    schema: {
      type: "object",
      properties: {
        image_ids: {
          type: "array",
          items: {
            type: "integer",
            minimum: 1,
          },
        },
        title: {
          type: "string",
        },
        description: {
          type: "string",
        },
        materials: {
          type: "array",
          nullable: true,
          items: {
            type: "string",
          },
        },
        should_auto_renew: {
          type: "boolean",
        },
        shipping_profile_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        return_policy_id: {
          type: "integer",
          nullable: true,
          minimum: 1,
        },
        shop_section_id: {
          type: "integer",
          nullable: true,
        },
        item_weight: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_length: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_width: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_height: {
          type: "number",
          nullable: true,
          minimum: 0,
          maximum: 1.79769313486e308,
        },
        item_weight_unit: {
          type: "string",
          nullable: true,
          enum: ["", "oz", "lb", "g", "kg"],
        },
        item_dimensions_unit: {
          type: "string",
          nullable: true,
          enum: ["", "in", "ft", "mm", "cm", "m", "yd", "inches"],
        },
        is_taxable: {
          type: "boolean",
        },
        taxonomy_id: {
          type: "integer",
          minimum: 1,
        },
        tags: {
          type: "array",
          nullable: true,
          items: {
            type: "string",
          },
        },
        who_made: {
          type: "string",
          enum: ["i_did", "someone_else", "collective"],
        },
        when_made: {
          type: "string",
          enum: [
            "made_to_order",
            "2020_2026",
            "2010_2019",
            "2007_2009",
            "before_2007",
            "2000_2006",
            "1990s",
            "1980s",
            "1970s",
            "1960s",
            "1950s",
            "1940s",
            "1930s",
            "1920s",
            "1910s",
            "1900s",
            "1800s",
            "1700s",
            "before_1700",
          ],
        },
        featured_rank: {
          type: "integer",
          nullable: true,
        },
        state: {
          type: "string",
          enum: ["active", "inactive"],
        },
        is_supply: {
          type: "boolean",
        },
        production_partner_ids: {
          type: "array",
          nullable: true,
          items: {
            type: "integer",
            minimum: 1,
          },
        },
        type: {
          type: "string",
          nullable: true,
          enum: ["physical", "download", "both"],
        },
      },
    },
  },
  update_order: {
    operationId: "updateShopReceipt",
    path: "shops/{shop_id}/receipts/{receipt_id}",
    method: "PUT",
    media: "application/x-www-form-urlencoded",
    scope: "transactions_w",
    schema: {
      type: "object",
      properties: {
        was_shipped: {
          type: "boolean",
          nullable: true,
        },
        was_paid: {
          type: "boolean",
          nullable: true,
        },
      },
    },
  },
  add_tracking: {
    operationId: "createReceiptShipment",
    path: "shops/{shop_id}/receipts/{receipt_id}/tracking",
    method: "POST",
    media: "application/json",
    scope: "transactions_w",
    schema: {
      type: "object",
      properties: {
        tracking_code: {
          type: "string",
        },
        carrier_name: {
          type: "string",
        },
        send_bcc: {
          type: "boolean",
        },
        note_to_buyer: {
          type: "string",
        },
        mail_class: {
          type: "string",
          nullable: true,
        },
        weight: {
          type: "number",
          nullable: true,
        },
        weight_units: {
          type: "string",
          nullable: true,
        },
        length: {
          type: "number",
          nullable: true,
        },
        width: {
          type: "number",
          nullable: true,
        },
        height: {
          type: "number",
          nullable: true,
        },
        dimension_units: {
          type: "string",
          nullable: true,
        },
        shipping_label_cost: {
          type: "number",
          nullable: true,
        },
        shipping_label_currency: {
          type: "string",
          nullable: true,
        },
        revenue_eligibility: {
          type: "string",
          nullable: true,
        },
        ship_from_country: {
          type: "string",
          nullable: true,
        },
        ship_to_country: {
          type: "string",
          nullable: true,
        },
        incoterm: {
          type: "string",
          nullable: true,
        },
        customs_data: {
          type: "array",
          nullable: true,
          items: {
            type: "object",
            properties: {
              country_of_origin: {
                type: "string",
                nullable: true,
              },
              declared_value: {
                type: "number",
                nullable: true,
              },
              HS_code: {
                type: "string",
                nullable: true,
              },
            },
            required: ["country_of_origin", "declared_value", "HS_code"],
          },
        },
        duty_amount: {
          type: "number",
          nullable: true,
        },
        duty_currency: {
          type: "string",
          nullable: true,
        },
        ship_date: {
          type: "string",
          nullable: true,
        },
      },
    },
  },
} as const;

const specs = {
  listings: { name: "Listings", path: "listings", scope: "listings_r" },
  reviews: { name: "Customer reviews", path: "reviews", scope: "shops_r" },
  orders: {
    name: "Orders and fulfillment",
    path: "receipts",
    scope: "transactions_r",
  },
  ledger: {
    name: "Payment account ledger",
    path: "payment-account/ledger-entries",
    scope: "transactions_r",
  },
  transactions: {
    name: "Order items",
    path: "transactions",
    scope: "transactions_r",
  },
} as const;
function positive(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Error(`${label} must be a positive integer`);
  return n;
}
function scope(ctx: Context, required: string) {
  if (!ctx.credentials?.accessToken)
    throw new Error("Connect your Etsy account first.");
  const granted = ctx.credentials.scope;
  if (granted && !granted.split(/\s+/).includes(required))
    throw new Error(`Reconnect Etsy and grant ${required} to read this data.`);
}
async function get(
  ctx: Context,
  path: string,
  params: Record<string, string> = {}
) {
  scope(ctx, "shops_r");
  const id = ctx.config.ETSY_CLIENT_ID;
  const secret = ctx.config.ETSY_CLIENT_SECRET;
  if (!id || !secret)
    throw new Error(
      "The Etsy app profile needs its keystring and shared secret."
    );
  const url = new URL(`https://api.etsy.com/v3/application/${path}`);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  // Classify retries by status only: provider bodies and numeric resource IDs
  // may contain strings such as "404" that are not this request's HTTP status.
  // The timeout is per attempt: one signal shared across the retry loop would
  // abort every later attempt before it was sent.
  const response = await withHttpRetry(
    async () => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.credentials!.accessToken}`,
          "x-api-key": `${id}:${secret}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        await response.text();
        const retryAfter = response.headers.get("Retry-After");
        if (response.status === 429 && retryAfter) {
          const seconds = Number(retryAfter);
          const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(delay) && delay > 0)
            await sleep(Math.min(delay, 30000));
        }
        throw new Error(
          `Etsy request failed (HTTP ${response.status}). Try again later.`
        );
      }
      return response;
    },
    { operation: "Etsy read" }
  );
  if (!response.ok) {
    if (response.status === 401)
      throw new Error(
        "Etsy authentication failed. Reconnect your Etsy account."
      );
    if (response.status === 403)
      throw new Error(
        "Etsy denied access. Check the app permissions and reconnect with the required scope."
      );
    if (response.status === 429)
      throw new Error("Etsy rate limit reached. Try again later.");
    throw new Error(`Etsy request failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as Record<string, any>;
}
async function shop(ctx: Context) {
  const me = await get(ctx, "users/me");
  if (me.shop_id) return get(ctx, `shops/${positive(me.shop_id, "shop_id")}`);
  return get(ctx, `users/${positive(me.user_id, "user_id")}/shops`);
}
function requireFeedScope(ctx: Context & { feedKey: string }) {
  const spec = specs[ctx.feedKey as keyof typeof specs];
  if (!spec) throw new Error("Unsupported feed");
  scope(ctx, spec.scope);
  return spec;
}
// `knownShopId` lets a paged sync resolve the shop once instead of spending two
// extra requests per page against Etsy's rate limit.
async function read(ctx: FeedReadContext, knownShopId?: number) {
  const spec = requireFeedScope(ctx);
  if (ctx.query || ctx.sort)
    throw new Error(
      "Use the feed configuration filters; arbitrary query and sorting are not supported."
    );
  const shopId = knownShopId ?? positive((await shop(ctx)).shop_id, "shop_id");
  const limit = Math.min(100, positive(ctx.limit ?? 25, "limit"));
  let ledgerCursor:
    | { offset: number; min_created: number; max_created: number }
    | undefined;
  if (ctx.feedKey === "ledger" && ctx.cursor?.startsWith("{")) {
    try {
      ledgerCursor = JSON.parse(ctx.cursor);
    } catch {
      throw new Error("Invalid ledger cursor");
    }
    if (!ledgerCursor || typeof ledgerCursor !== "object")
      throw new Error("Invalid ledger cursor");
  }
  const offset = Number(ledgerCursor?.offset ?? ctx.cursor ?? ctx.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid page cursor");
  const params: Record<string, string> = {
    limit: String(limit),
    offset: String(offset),
  };
  if (ctx.feedKey === "listings") {
    const state = String(ctx.config.state ?? "active");
    if (!["active", "inactive", "sold_out", "draft", "expired"].includes(state))
      throw new Error("Invalid listing state");
    params.state = state;
  }
  if (ctx.feedKey === "ledger") {
    const end = positive(
      ledgerCursor?.max_created ??
        ctx.config.max_created ??
        Math.floor(Date.now() / 1000),
      "max_created"
    );
    const start = positive(
      ledgerCursor?.min_created ?? ctx.config.min_created ?? end - 30 * 86400,
      "min_created"
    );
    if (
      ledgerCursor &&
      ((ctx.config.min_created !== undefined &&
        Number(ctx.config.min_created) !== start) ||
        (ctx.config.max_created !== undefined &&
          Number(ctx.config.max_created) !== end))
    )
      throw new Error("Ledger filters changed; restart pagination");
    if (start < 946684800 || start > end)
      throw new Error("Invalid ledger date range");
    params.min_created = String(start);
    params.max_created = String(end);
  }
  const result = await get(ctx, `shops/${shopId}/${spec.path}`, params);
  if (!Array.isArray(result.results))
    throw new Error("Etsy returned an unexpected page format");
  const total = typeof result.count === "number" ? result.count : undefined;
  if (result.results.length === 0 && total !== undefined && total > offset)
    throw new Error(
      "Etsy returned an empty page before the reported end; retry the read"
    );
  const hasMore =
    result.results.length > 0 &&
    (total === undefined
      ? result.results.length === limit
      : offset + result.results.length < total);
  return {
    rows: result.results,
    total,
    hasMore,
    nextCursor: hasMore
      ? ctx.feedKey === "ledger"
        ? JSON.stringify({
            offset: offset + result.results.length,
            min_created: Number(params.min_created),
            max_created: Number(params.max_created),
          })
        : String(offset + result.results.length)
      : undefined,
  };
}
export default class EtsyConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: "etsy",
    name: "Etsy",
    version: "0.4.1",
    faviconDomain: "etsy.com",
    description:
      "Read your Etsy shop, listings, customer reviews, orders and payments. Sync store activity and manage listings and fulfillment with approval. Direct messages are unavailable in the Etsy API.",
    authSchema: {
      methods: [
        {
          type: "oauth",
          provider: "etsy",
          requiredScopes: ["shops_r", "listings_r", "listings_w"],
          optionalScopes: ["transactions_r", "transactions_w"],
          clientIdKey: "ETSY_CLIENT_ID",
          clientSecretKey: "ETSY_CLIENT_SECRET",
          authorizationUrl: "https://www.etsy.com/oauth/connect",
          tokenUrl: "https://api.etsy.com/v3/public/oauth/token",
          tokenEndpointAuthMethod: "none",
          usePkce: true,
          required: true,
          description:
            "Read your shop and listings. Enable transactions_r for orders and payments.",
          setupInstructions:
            "Set the Etsy app redirect URL to {{redirect_uri}}, then enter its keystring and shared secret. Seller apps may only authorize their owner.",
        },
      ],
    },
    feeds: Object.fromEntries(
      Object.entries(specs).map(([key, spec]) => [
        key,
        {
          key,
          name: spec.name,
          description:
            key === "ledger"
              ? "Payment ledger, fees, balances and adjustments. Dates are Unix seconds; default range is the last 30 days. Sync continues from its last successful checkpoint."
              : `Live ${spec.name.toLowerCase()} from the authenticated seller shop.`,
          requiredScopes: [spec.scope],
          read,
          sync: syncFeed,
          eventKinds: {
            [key]: { description: `Etsy ${spec.name.toLowerCase()}` },
          },
          configSchema: {
            type: "object",
            properties:
              key === "listings"
                ? {
                    state: {
                      type: "string",
                      enum: [
                        "active",
                        "inactive",
                        "sold_out",
                        "draft",
                        "expired",
                      ],
                      default: "active",
                    },
                  }
                : key === "ledger"
                  ? {
                      min_created: { type: "integer", minimum: 946684800 },
                      max_created: { type: "integer", minimum: 946684800 },
                    }
                  : {},
            additionalProperties: false,
          },
        },
      ])
    ),
    actions: {
      ...writeActions(),
      ...Object.fromEntries(
        [
          ["get_shop", "Get my shop", "shops_r", {}],
          [
            "get_listing",
            "Get listing details",
            "listings_r",
            { listing_id: { type: "integer", minimum: 1 } },
          ],
          [
            "get_inventory",
            "Get listing inventory",
            "listings_r",
            { listing_id: { type: "integer", minimum: 1 } },
          ],
          [
            "get_order",
            "Get order and fulfillment",
            "transactions_r",
            { receipt_id: { type: "integer", minimum: 1 } },
          ],
          [
            "get_payment",
            "Get order payment",
            "transactions_r",
            { receipt_id: { type: "integer", minimum: 1 } },
          ],
        ].map(([key, name, requiredScope, properties]) => [
          key,
          {
            key,
            name,
            kind: "read",
            requiresApproval: false,
            requiredScopes: [requiredScope],
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
            inputSchema: {
              type: "object",
              properties,
              required: Object.keys(properties as object),
              additionalProperties: false,
            },
          },
        ])
      ),
    } as RuntimeConnectorDefinition["actions"],
  };
  async execute(ctx: ActionContext): Promise<ActionResult> {
    try {
      if (
        !this.definition.actions ||
        !Object.hasOwn(this.definition.actions, ctx.actionKey)
      )
        throw new Error("Unknown Etsy action");
      if (Object.hasOwn(writeContracts, ctx.actionKey)) return await write(ctx);
      scope(
        ctx,
        ctx.actionKey === "get_order" || ctx.actionKey === "get_payment"
          ? "transactions_r"
          : ctx.actionKey === "get_shop"
            ? "shops_r"
            : "listings_r"
      );
      const ownShop = await shop(ctx);
      const sid = positive(ownShop.shop_id, "shop_id");
      if (ctx.actionKey === "get_shop")
        return { success: true, output: ownShop };
      if (
        ctx.actionKey === "get_listing" ||
        ctx.actionKey === "get_inventory"
      ) {
        const lid = positive(ctx.input.listing_id, "listing_id");
        const listing = await get(ctx, `listings/${lid}`);
        if (Number(listing.shop_id) !== sid)
          throw new Error(
            "This listing does not belong to your connected shop."
          );
        return {
          success: true,
          output:
            ctx.actionKey === "get_listing"
              ? listing
              : await get(ctx, `listings/${lid}/inventory`),
        };
      }
      const rid = positive(ctx.input.receipt_id, "receipt_id");
      return {
        success: true,
        output: await get(
          ctx,
          `shops/${sid}/receipts/${rid}${ctx.actionKey === "get_payment" ? "/payments" : ""}`
        ),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Etsy read failed",
      };
    }
  }
}

function writeActions() {
  return Object.fromEntries(
    Object.entries(writeContracts).map(([key, contract]) => {
      const ids = ["listing_id", "receipt_id"].filter((id) =>
        contract.path.includes(`{${id}}`)
      );
      return [
        key,
        {
          key,
          name: key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()),
          kind: "write",
          requiresApproval: true,
          requiredScopes: [contract.scope],
          description:
            key === "replace_inventory"
              ? "Replace the entire inventory. Read current inventory first and preserve all unchanged products, variations, offerings and processing profiles."
              : key === "add_tracking"
                ? "Add shipment tracking and send Etsy notification to the buyer. Check the order before retrying an uncertain result."
                : key === "update_order"
                  ? "Mark the order paid or shipped. Marking an order shipped may notify the buyer; check the order before retrying an uncertain result."
                  : "Change the listings on your connected Etsy shop. Publishing or renewing a listing may incur fees. Check current state before retrying an uncertain result.",
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
          inputSchema: {
            type: "object",
            properties: {
              ...Object.fromEntries(
                ids.map((id) => [id, { type: "integer", minimum: 1 }])
              ),
              body: { ...contract.schema, additionalProperties: false },
            },
            required: [...ids, "body"],
            additionalProperties: false,
          },
        },
      ];
    })
  );
}

// Validate at the connector boundary as well as the platform action schema.
function validate(value: unknown, schema: any, path = "body"): void {
  if (value === null && schema.nullable) return;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in object)) throw new Error(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(object)) {
      if (!schema.properties?.[key])
        throw new Error(`Unsupported field ${path}.${key}`);
      validate(item, schema.properties[key], `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    for (const item of value) validate(item, schema.items, path);
  } else {
    const expected = schema.type === "integer" ? "number" : schema.type;
    if (typeof value !== expected)
      throw new Error(`${path} must be ${schema.type}`);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isSafeInteger(value)) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum))
    )
      throw new Error(`${path} is out of range`);
    if (schema.enum && !schema.enum.includes(value))
      throw new Error(`${path} is not an allowed value`);
  }
}

async function write(ctx: ActionContext): Promise<ActionResult> {
  const contract = writeContracts[ctx.actionKey as keyof typeof writeContracts];
  scope(ctx, contract.scope);
  const body = ctx.input.body as Record<string, unknown>;
  validate(body, contract.schema);
  if (!Object.keys(body).length) throw new Error("Provide at least one change");
  if (ctx.actionKey === "create_draft_listing") {
    positive(body.quantity, "quantity");
    if (Number(body.price) <= 0) throw new Error("price must be positive");
  }
  // Etsy documents these conditional requirements outside the OpenAPI required list:
  // https://developers.etsy.com/documentation/tutorials/listings/
  if (ctx.actionKey === "create_draft_listing" && body.type !== "download") {
    positive(
      body.shipping_profile_id,
      "shipping_profile_id for a physical draft"
    );
    positive(
      body.readiness_state_id,
      "readiness_state_id for a physical draft"
    );
  }
  if (
    ctx.actionKey === "replace_inventory" &&
    !(body.products as unknown[]).length
  )
    throw new Error("Inventory must contain at least one product");
  if (
    ctx.actionKey === "add_tracking" &&
    (!body.tracking_code || !body.carrier_name)
  )
    throw new Error("Tracking code and carrier name are required");
  const ownShop = await shop(ctx);
  const sid = positive(ownShop.shop_id, "shop_id");
  let path: string = contract.path.replace("{shop_id}", String(sid));
  if (path.includes("{listing_id}")) {
    const lid = positive(ctx.input.listing_id, "listing_id");
    const listing = await get(ctx, `listings/${lid}`);
    if (Number(listing.shop_id) !== sid)
      throw new Error("This listing does not belong to your connected shop.");
    path = path.replace("{listing_id}", String(lid));
  }
  if (path.includes("{receipt_id}")) {
    const rid = positive(ctx.input.receipt_id, "receipt_id");
    await get(ctx, `shops/${sid}/receipts/${rid}`);
    path = path.replace("{receipt_id}", String(rid));
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body))
    form.set(
      key,
      value === null
        ? ""
        : Array.isArray(value)
          ? value.join(",")
          : String(value)
    );
  // Never automatically retry writes: Etsy supplies no idempotency key here.
  let response: Response;
  try {
    response = await fetch(`https://api.etsy.com/v3/application/${path}`, {
      method: contract.method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${ctx.credentials!.accessToken}`,
        "x-api-key": `${ctx.config.ETSY_CLIENT_ID}:${ctx.config.ETSY_CLIENT_SECRET}`,
        "Content-Type": contract.media,
        Accept: "application/json",
      },
      body:
        contract.media === "application/json"
          ? JSON.stringify(body)
          : form.toString(),
    });
  } catch {
    throw new Error(
      "Etsy write outcome is unknown. Read the listing or order before retrying."
    );
  }
  if (!response.ok) {
    await response.text();
    throw new Error(
      `Etsy write returned HTTP ${response.status}. ${response.status >= 500 ? "Outcome may be unknown; inspect current state before retrying." : "Check input and granted permissions before retrying."}`
    );
  }
  try {
    const text = await response.text();
    return {
      success: true,
      output: text ? JSON.parse(text) : { updated: true },
    };
  } catch {
    throw new Error(
      "Etsy accepted the write but its response could not be read. Inspect current state before retrying."
    );
  }
}

function activity(key: string, id: number, row: Record<string, any>) {
  const label =
    key === "listings" || key === "transactions"
      ? row.title
      : key === "ledger"
        ? row.description
        : key === "reviews"
          ? `${row.rating}/5 review`
          : `Order ${id}: ${row.status ?? "updated"}`;
  const title = `Etsy ${label || `${key} ${id}`}`;
  const summary =
    key === "listings"
      ? {
          description: row.description,
          state: row.state,
          quantity: row.quantity,
          price: row.price,
        }
      : key === "reviews"
        ? { review: row.review, listing_id: row.listing_id, rating: row.rating }
        : key === "orders"
          ? {
              status: row.status,
              is_paid: row.is_paid,
              is_shipped: row.is_shipped,
              total: row.grandtotal,
              message_from_buyer: row.message_from_buyer,
              message_from_seller: row.message_from_seller,
              shipments: row.shipments,
            }
          : key === "ledger"
            ? {
                amount: row.amount,
                currency: row.currency,
                balance: row.balance,
                ledger_type: row.ledger_type,
                reference_type: row.reference_type,
                reference_id: row.reference_id,
                payment_adjustments: row.payment_adjustments,
              }
            : {
                quantity: row.quantity,
                price: row.price,
                receipt_id: row.receipt_id,
                variations: row.variations,
              };
  return { title, payload_text: `${title}\n${JSON.stringify(summary)}` };
}

async function syncFeed(ctx: SyncContext): Promise<SyncResult> {
  // Reject an unsupported feed or an ungranted scope before any request.
  requireFeedScope(ctx);
  const end = Math.floor(Date.now() / 1000);
  const config = { ...ctx.config };
  if (ctx.feedKey === "ledger") {
    config.min_created =
      ctx.config.min_created ??
      Math.max(
        946684800,
        Number(ctx.checkpoint?.through ?? end - 30 * 86400) - 3600
      );
    config.max_created = ctx.config.max_created ?? end;
  }
  const events: SyncResult["events"] = [];
  let cursor: string | undefined;
  const shopId = positive((await shop(ctx)).shop_id, "shop_id");
  // Other resources are reconciled completely, including edits to old orders.
  // Fail without advancing the checkpoint if a shop exceeds this bounded run.
  for (let page = 0; page < 100; page++) {
    const result = await read(
      {
        ...ctx,
        config,
        cursor,
        limit: 100,
      } as FeedReadContext,
      shopId
    );
    for (const row of result.rows) {
      const id = positive(
        row[
          ctx.feedKey === "listings"
            ? "listing_id"
            : ctx.feedKey === "orders"
              ? "receipt_id"
              : ctx.feedKey === "ledger"
                ? "entry_id"
                : "transaction_id"
        ],
        "source id"
      );
      const timestamp = Number(
        row.updated_timestamp ??
          row.update_timestamp ??
          row.created_timestamp ??
          row.create_timestamp ??
          row.created ??
          0
      );
      if (!Number.isFinite(timestamp) || timestamp <= 0)
        throw new Error("Etsy returned an invalid event timestamp");
      events.push({
        origin_id: `etsy:${ctx.feedKey}:${id}`,
        origin_type: ctx.feedKey,
        ...activity(ctx.feedKey, id, row),
        payload_data: row,
        occurred_at: new Date(timestamp * 1000),
      });
    }
    if (!result.hasMore)
      return {
        events,
        checkpoint: { through: end },
        metadata: { items_found: events.length },
      };
    cursor = result.nextCursor;
  }
  throw new Error(
    "Etsy sync exceeded 100 pages; checkpoint unchanged. Narrow the configured date range or listing state."
  );
}
