/**
 * Stores the review agent's judgment of new sahibinden listings as `asset`
 * entities. Listing facts (price, location, photos, link) come from the
 * stored `listing.snapshot`, never from the agent; the agent supplies only
 * its reading of the listing. A listing already on an asset updates that
 * asset and leaves its stage alone.
 */
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

const CATEGORIES = new Set(["apartment", "villa", "house", "land", "other"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

interface Snapshot {
  id: number;
  created_at: string;
  metadata: {
    listing_no: string;
    url: string;
    price: { amount: number; currency: string } | null;
    location: Record<string, unknown>;
    photos: string[];
    removed?: boolean;
  };
}

interface Review {
  listing_no: string;
  name: string;
  category: string;
  rooms?: string;
  floor?: string;
  building_age?: number;
  furnished?: boolean;
  area_m2: { net?: number; gross?: number; land?: number; used: string };
  highlights: string[];
  flags: Array<{ kind: string; note: string; severity: string }>;
  corrections: Array<Record<string, string>>;
  unverified_claims: string[];
  photo_findings: string[];
  cover_photo?: string;
  agent_summary: string;
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .slice(0, max)
    : [];

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

export function reviews(value: unknown): Review[] {
  if (!Array.isArray(value)) return [];
  const out: Review[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const listingNo = String(r.listing_no ?? "");
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!listingNo || !name) continue;
    const area = (r.area_m2 ?? {}) as Record<string, unknown>;
    const used = String(area.used ?? "");
    out.push({
      listing_no: listingNo,
      name,
      category: CATEGORIES.has(String(r.category))
        ? String(r.category)
        : "other",
      rooms: typeof r.rooms === "string" ? r.rooms : undefined,
      floor: typeof r.floor === "string" ? r.floor : undefined,
      building_age:
        typeof r.building_age === "number" ? r.building_age : undefined,
      furnished: typeof r.furnished === "boolean" ? r.furnished : undefined,
      area_m2: {
        net: positive(area.net),
        gross: positive(area.gross),
        land: positive(area.land),
        used: ["net", "gross", "land"].includes(used) ? used : "net",
      },
      highlights: strings(r.highlights, 5),
      flags: (Array.isArray(r.flags) ? r.flags : [])
        .filter(
          (f): f is Record<string, unknown> => !!f && typeof f === "object"
        )
        .map((f) => ({
          kind: String(f.kind ?? "other"),
          note: String(f.note ?? ""),
          severity: SEVERITIES.has(String(f.severity))
            ? String(f.severity)
            : "low",
        }))
        .filter((f) => f.note),
      corrections: (Array.isArray(r.corrections) ? r.corrections : [])
        .filter(
          (c): c is Record<string, unknown> => !!c && typeof c === "object"
        )
        .map((c) => ({
          field: String(c.field ?? ""),
          seller_said: String(c.seller_said ?? ""),
          actual: String(c.actual ?? ""),
          evidence: String(c.evidence ?? ""),
        }))
        .filter((c) => c.field && c.actual),
      unverified_claims: strings(r.unverified_claims, 10),
      photo_findings: strings(r.photo_findings, 10),
      cover_photo:
        typeof r.cover_photo === "string" ? r.cover_photo : undefined,
      agent_summary:
        typeof r.agent_summary === "string" ? r.agent_summary.trim() : "",
    });
  }
  return out;
}

/** TL per m² of the area the review chose; null when either side is missing. */
export function pricePerM2(
  price: Snapshot["metadata"]["price"],
  area: Review["area_m2"]
): number | null {
  const size = area[area.used as "net" | "gross" | "land"];
  if (!price || price.currency !== "TRY" || !size) return null;
  return Math.round(price.amount / size);
}

function digits(value: string): boolean {
  return value.length > 0 && [...value].every((c) => c >= "0" && c <= "9");
}

export default async function storeListingReviews(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const items = [
    ...new Map(
      reviews(ctx.extracted_data.assets)
        .filter((r) => digits(r.listing_no))
        .map((r) => [r.listing_no, r])
    ).values(),
  ];
  if (items.length === 0) return;
  const source = {
    automation_id: Number(ctx.window.automation_id),
    run_id: Number(ctx.window.run_id),
  };
  const numbers = items.map((r) => `'${r.listing_no}'`).join(", ");
  const snapshots = (await client.query(
    `SELECT id, created_at, metadata FROM events
     WHERE semantic_type = 'listing.snapshot'
       AND metadata->>'portal' = 'sahibinden'
       AND metadata->>'listing_no' IN (${numbers})
     ORDER BY id DESC`
  )) as Snapshot[];
  const latest = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (!latest.has(s.metadata.listing_no))
      latest.set(s.metadata.listing_no, s);
  }
  type ExistingAsset = {
    id: number;
    listings: Array<Record<string, unknown>> | null;
  };
  const existing = (await client.query(
    `SELECT id, metadata->'listings' AS listings FROM entities
     WHERE entity_type = 'asset' AND deleted_at IS NULL
       AND metadata->>'asset_class' = 'real_estate'`
  )) as ExistingAsset[];
  const assetFor = new Map<string, ExistingAsset>();
  for (const asset of existing) {
    for (const l of asset.listings ?? []) {
      if (l.portal === "sahibinden" && typeof l.listing_no === "string") {
        assetFor.set(l.listing_no, asset);
      }
    }
  }

  for (const review of items) {
    const snapshot = latest.get(review.listing_no);
    if (!snapshot || snapshot.metadata.removed) continue;
    const asset = assetFor.get(review.listing_no);
    const { metadata } = snapshot;
    const seen = snapshot.created_at.slice(0, 10);
    const priceTry =
      metadata.price?.currency === "TRY" ? metadata.price.amount : null;
    const cover =
      review.cover_photo && metadata.photos.includes(review.cover_photo)
        ? review.cover_photo
        : metadata.photos[0];
    const judged = {
      asset_class: "real_estate",
      category: review.category,
      rooms: review.rooms,
      floor: review.floor,
      building_age: review.building_age,
      furnished: review.furnished,
      area_m2: review.area_m2,
      price_try: priceTry,
      price_per_m2: pricePerM2(metadata.price, review.area_m2),
      // The listing's own map pin, when the seller placed one.
      location: {
        ...metadata.location,
        precision:
          metadata.location.lat != null && metadata.location.lng != null
            ? "exact_pin"
            : "approximate",
      },
      highlights: review.highlights,
      flags: review.flags,
      corrections: review.corrections,
      unverified_claims: review.unverified_claims,
      photo_findings: review.photo_findings,
      cover_photo: cover,
      agent_summary: review.agent_summary,
      last_seen: seen,
      listing_event_id: snapshot.id,
      listings: [
        ...(asset?.listings ?? []).filter(
          (l) => l.portal !== "sahibinden" || l.listing_no !== review.listing_no
        ),
        {
          portal: "sahibinden",
          url: metadata.url,
          listing_no: metadata.listing_no,
          price_try: priceTry,
          seen,
        },
      ],
    };
    if (asset) {
      await client.entities.update({
        entity_id: asset.id,
        metadata: judged,
        automation_source: source,
      });
      asset.listings = judged.listings;
    } else {
      await client.entities.create({
        entity_type: "asset",
        name: review.name,
        // Names repeat across listings ("2+1 flat, Andifli – Kaş"); the
        // listing number keeps the slug unique.
        slug: `sahibinden-${review.listing_no}`,
        metadata: {
          ...judged,
          stage: "new",
          stage_at: new Date().toISOString(),
          first_seen: seen,
        },
        automation_source: source,
      });
    }
  }
}
