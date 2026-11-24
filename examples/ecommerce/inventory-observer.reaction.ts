/**
 * Keeps one `inventory.level` record per Shopify variant and appends an
 * `inventory.alert` when a variant becomes low on stock, sells out, or
 * recovers. Code only: no agent turn.
 *
 * The current variant state is the Shopify connection's current
 * `product_variant` events (the products feed supersedes a variant's event
 * whenever its price, stock, status or SKU changes). The previous state is this
 * Automation's own `inventory.level` heads, so a transition is emitted once,
 * when the stored state changes, never on every run.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

/** A sellable variant with this many units or fewer is low on stock. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Products whose stock Shopify does not track, so a zero quantity is not a
 * sell-out: the store's gift card and its inventory-not-tracked snowboard.
 * Keyed by the product admin URL because the connector exposes no gift-card or
 * inventory-tracked flag on a variant.
 */
const NOT_STOCK_TRACKED = new Set([
  "https://lobu-sample.myshopify.com/admin/products/11012843962673",
  "https://lobu-sample.myshopify.com/admin/products/11012843995441",
]);

const CONNECTOR = "shopify";
const PAGE = 500;

export type StockState =
  | "in_stock"
  | "low_stock"
  | "sold_out"
  | "inactive"
  | "not_tracked";

type Transition = "low_stock" | "sold_out" | "recovered";

interface StoredEvent {
  id: number;
  origin_id: string | null;
  entity_ids: number[];
  metadata: Record<string, unknown>;
}

export interface Level {
  variant_id: string;
  title: string;
  sku?: string;
  vendor: string;
  price: number;
  available: number;
  product_status: string;
  stock_state: StockState;
  admin_url: string;
}

export function stockState(
  status: string,
  available: number,
  adminUrl: string
): StockState {
  if (status !== "ACTIVE") return "inactive";
  if (NOT_STOCK_TRACKED.has(adminUrl)) return "not_tracked";
  if (available <= 0) return "sold_out";
  if (available <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

/** The alert a state change raises, or null when it is not material. */
export function transition(
  previous: StockState | undefined,
  next: StockState
): Transition | null {
  if (previous === next) return null;
  if (next === "low_stock" || next === "sold_out") return next;
  if (
    next === "in_stock" &&
    (previous === "low_stock" || previous === "sold_out")
  )
    return "recovered";
  return null;
}

function levelOf(event: StoredEvent): Level | null {
  const m = event.metadata;
  if (!event.origin_id || typeof m.admin_url !== "string") return null;
  const available = Number(m.available ?? 0);
  const price = Number(m.price);
  const status = String(m.status ?? "");
  if (!Number.isFinite(available) || !Number.isFinite(price) || !status)
    return null;
  const sku = typeof m.sku === "string" && m.sku.trim() ? m.sku : undefined;
  return {
    variant_id: event.origin_id,
    title: String(m.title ?? m.entity_name ?? event.origin_id),
    ...(sku ? { sku } : {}),
    vendor: String(m.vendor ?? ""),
    price,
    available,
    product_status: status,
    stock_state: stockState(status, available, m.admin_url),
    admin_url: m.admin_url,
  };
}

/** Fields whose change is worth a new stored version. */
function fingerprint(level: Level, entityIds: number[]): string {
  return JSON.stringify([
    level.title,
    level.sku ?? null,
    level.price,
    level.available,
    level.product_status,
    level.stock_state,
    [...entityIds].sort((a, b) => a - b),
  ]);
}

async function readAll(
  client: ReactionClient,
  input: Record<string, unknown>
): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = (await client.knowledge.read({
      ...input,
      limit: PAGE,
      offset,
    })) as {
      content: StoredEvent[];
      page?: { has_more?: boolean };
    };
    out.push(...page.content);
    if (!page.page?.has_more) return out;
  }
}

async function shopifyConnectionIds(client: ReactionClient): Promise<number[]> {
  const listed = (await client.connections.list({})) as
    | { connections?: Array<{ id: number; connector_key: string }> }
    | Array<{ id: number; connector_key: string }>;
  const rows = Array.isArray(listed) ? listed : (listed.connections ?? []);
  return rows.filter((c) => c.connector_key === CONNECTOR).map((c) => c.id);
}

export default async function observeInventory(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<Record<string, unknown>> {
  const runId = ctx.window.run_id;
  const observedAt = new Date().toISOString();
  const connectionIds = await shopifyConnectionIds(client);
  if (connectionIds.length === 0)
    throw new Error("No Shopify connection in this workspace");

  const variants = await readAll(client, {
    connection_ids: connectionIds,
    semantic_type: "product_variant",
  });
  const stored = new Map<string, StoredEvent>();
  for (const event of await readAll(client, {
    semantic_type: "inventory.level",
  })) {
    const id = event.metadata.variant_id;
    if (typeof id === "string") stored.set(id, event);
  }

  const alerts: Array<{ variant: string; transition: Transition }> = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const variant of variants) {
    const level = levelOf(variant);
    if (!level) {
      skipped++;
      continue;
    }
    const previous = stored.get(level.variant_id);
    const previousLevel = previous?.metadata as Partial<Level> | undefined;
    if (
      previous &&
      previousLevel &&
      fingerprint(previousLevel as Level, previous.entity_ids ?? []) ===
        fingerprint(level, variant.entity_ids)
    ) {
      unchanged++;
      continue;
    }

    // The alert is written before the level so a retried run still raises it:
    // the stored level is what marks a transition as already seen.
    const change = transition(previousLevel?.stock_state, level.stock_state);
    if (change) {
      await client.knowledge.save({
        semantic_type: "inventory.alert",
        title: `${level.title}: ${change.replace("_", " ")}`,
        content: `${level.title}${level.sku ? ` (${level.sku})` : ""} is ${change === "recovered" ? "back in stock" : change.replace("_", " ")}: ${level.available} available.`,
        entity_ids: variant.entity_ids,
        source_url: level.admin_url,
        occurred_at: observedAt,
        idempotency_key: `${runId}:alert:${level.variant_id}`,
        metadata: {
          variant_id: level.variant_id,
          title: level.title,
          ...(level.sku ? { sku: level.sku } : {}),
          transition: change,
          ...(previousLevel?.stock_state
            ? { from_state: previousLevel.stock_state }
            : {}),
          to_state: level.stock_state,
          available: level.available,
          ...(typeof previousLevel?.available === "number"
            ? { previous_available: previousLevel.available }
            : {}),
          threshold: LOW_STOCK_THRESHOLD,
          admin_url: level.admin_url,
        },
      });
      alerts.push({ variant: level.title, transition: change });
    }

    await client.knowledge.save({
      semantic_type: "inventory.level",
      title: `${level.title} · ${level.available} available`,
      content: `${level.title}${level.sku ? ` (${level.sku})` : ""}: ${level.available} available at ${level.price}, ${level.stock_state.replace("_", " ")}.`,
      entity_ids: variant.entity_ids,
      source_url: level.admin_url,
      occurred_at: observedAt,
      idempotency_key: `${runId}:level:${level.variant_id}`,
      ...(previous ? { supersedes_event_id: previous.id } : {}),
      metadata: { ...level, threshold: LOW_STOCK_THRESHOLD },
    });
    if (previous) updated++;
    else created++;
  }

  return {
    variants: variants.length,
    created,
    updated,
    unchanged,
    skipped,
    alerts,
  };
}
