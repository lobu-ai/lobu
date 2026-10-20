/**
 * Daily sahibinden alert ingest.
 *
 * sahibinden emails a "(kk) Favori Arama için Sonuçlar" alert when the saved
 * search has new listings. This reads those alerts live from Gmail, opens each
 * listing it has not stored yet through the sahibinden connector, and saves one
 * `listing.snapshot` event per listing. Judging the listing is the review
 * Automation's job; this script stores what the seller published.
 */
import type {
  AutomationScriptContext,
  ReactionClient,
} from "@lobu/connector-sdk";

// Retry a week of alerts after a missed run; reads remain bounded below.
const ALERT_QUERY = "from:info@sahibinden.com newer_than:7d";
const LISTING_PREFIX = "https://www.sahibinden.com/ilan/";
// Each read opens a scratch tab in the user's Chrome; keep a run short.
const MAX_LISTINGS_PER_RUN = 10;

interface ListingLink {
  url: string;
  listing_no: string;
  email_message_id: string;
}

type Source = { automation_id: number; run_id: number };

/**
 * Listing links in an alert body, by listing number. Mirrors the connector's
 * `parseListingUrl`; the stored event is keyed by the number the connector
 * returns, so a disagreement only costs a repeated read.
 */
export function listingLinks(
  body: string,
  emailMessageId: string
): ListingLink[] {
  const byNumber = new Map<string, ListingLink>();
  for (const chunk of body.split(LISTING_PREFIX).slice(1)) {
    const end = chunk.indexOf("/detay");
    if (end <= 0) continue;
    const slug = chunk.slice(0, end);
    if (slug.includes("/") || slug.includes(" ")) continue;
    const listingNo = slug.slice(slug.lastIndexOf("-") + 1);
    if (!listingNo || ![...listingNo].every((c) => c >= "0" && c <= "9")) {
      continue;
    }
    byNumber.set(listingNo, {
      url: `${LISTING_PREFIX}${slug}/detay`,
      listing_no: listingNo,
      email_message_id: emailMessageId,
    });
  }
  return [...byNumber.values()];
}

function connectionIds(value: unknown, connectorKey: string): number[] {
  const rows = (value as { connections?: Array<Record<string, unknown>> })
    ?.connections;
  return (rows ?? [])
    .filter((c) => c.connector_key === connectorKey && c.status === "active")
    .map((c) => Number(c.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function operation(
  client: ReactionClient,
  source: Source,
  connectionId: number,
  operationKey: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const run = await client.operations.execute({
    connection_id: connectionId,
    operation_key: operationKey,
    input,
    automation_source: source,
  });
  if (run.status !== "completed") {
    throw new Error(
      `${operationKey} did not complete (${run.status ?? "unknown"}): ${run.error_message ?? "no error detail"}`
    );
  }
  if (
    !run.output ||
    typeof run.output !== "object" ||
    Array.isArray(run.output)
  ) {
    throw new Error(`${operationKey} completed without an output object`);
  }
  return run.output as Record<string, unknown>;
}

async function alertLinks(
  client: ReactionClient,
  source: Source,
  gmailIds: number[]
): Promise<ListingLink[]> {
  const links = new Map<string, ListingLink>();
  for (const gmail of gmailIds) {
    const search = await operation(client, source, gmail, "search", {
      query: ALERT_QUERY,
      max_results: 20,
    });
    if (!Array.isArray(search.messages)) {
      throw new Error("Gmail search completed without messages");
    }
    const messages = search.messages as Array<Record<string, unknown>>;
    const threads = new Set(messages.map((m) => String(m.thread_id)));
    for (const threadId of threads) {
      const thread = await operation(client, source, gmail, "get_thread", {
        thread_id: threadId,
      });
      if (!Array.isArray(thread.messages)) {
        throw new Error("Gmail get_thread completed without messages");
      }
      for (const message of thread.messages as Array<Record<string, unknown>>) {
        for (const link of listingLinks(
          String(message.body ?? ""),
          String(message.id)
        )) {
          links.set(link.listing_no, link);
        }
      }
    }
  }
  return [...links.values()];
}

async function storedListingNumbers(
  client: ReactionClient,
  numbers: string[]
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  // Numbers are digit-only (listingLinks), so they are safe as literals.
  const rows = (await client.query(
    `SELECT metadata->>'listing_no' AS listing_no FROM events
     WHERE semantic_type = 'listing.snapshot'
       AND metadata->>'portal' = 'sahibinden'
       AND metadata->>'listing_no' IN (${numbers.map((n) => `'${n}'`).join(", ")})`
  )) as Array<{ listing_no: string }>;
  return new Set(rows.map((r) => r.listing_no));
}

function digest(read: Record<string, unknown>): string {
  if (read.removed === true)
    return `sahibinden #${read.listing_no} is no longer published.`;
  const location = (read.location ?? {}) as Record<string, unknown>;
  const attributes = (read.attributes ?? {}) as Record<string, string>;
  return [
    String(read.title ?? ""),
    `${read.price_text ?? ""} · ${[location.quarter, location.district, location.city].filter(Boolean).join(", ")}`,
    ...Object.entries(attributes).map(([k, v]) => `${k}: ${v}`),
    "",
    String(read.description ?? ""),
  ].join("\n");
}

export default async function ingestSahibindenAlerts(
  ctx: AutomationScriptContext,
  client: ReactionClient
): Promise<void> {
  const source = {
    automation_id: ctx.automation.id,
    run_id: ctx.window.run_id,
  };
  const connections = await client.connections.list({});
  const gmailIds = connectionIds(connections, "google.gmail");
  const [sahibinden] = connectionIds(connections, "sahibinden");
  if (gmailIds.length === 0 || !sahibinden) {
    throw new Error(
      "An active Gmail connection and an active sahibinden connection are required."
    );
  }

  const links = await alertLinks(client, source, gmailIds);
  const stored = await storedListingNumbers(
    client,
    links.map((l) => l.listing_no)
  );
  const fresh = links.filter((l) => !stored.has(l.listing_no));

  for (const link of fresh.slice(0, MAX_LISTINGS_PER_RUN)) {
    const read = await operation(client, source, sahibinden, "read_listing", {
      url: link.url,
    });
    const listingNo = String(read.listing_no);
    await client.knowledge.save({
      content: digest(read),
      semantic_type: "listing.snapshot",
      title: String(read.title || `sahibinden #${listingNo}`),
      source_url: String(read.url),
      metadata: {
        ...read,
        portal: "sahibinden",
        found_via: {
          kind: "email_alert",
          email_message_id: link.email_message_id,
        },
      },
      idempotency_key: `sahibinden:listing.snapshot:${listingNo}`,
      automation_source: source,
    });
  }
}
