/**
 * Geo enrichment — reverse-geocode an event's lat/lng into city / admin1 /
 * country at insert time. Called once per event before INSERT (see
 * insert-event.ts), so every downstream surface (search, recall, UI) sees
 * the enriched metadata immediately.
 *
 * The actual work lives in the `geo_lookup(lat, lng)` SQL function the
 * 20260515150000_geo_enrichment.sql migration installs. This module:
 *
 *   - Reads metadata.latitude / metadata.longitude
 *   - Calls geo_lookup() once
 *   - Merges country_code/country_name/admin1/place_name back into metadata
 *     ONLY when the keys aren't already set — connectors that source these
 *     fields directly (osxphotos-style direct Photos.sqlite reads) win
 *     over our nearest-neighbour fallback
 *
 * Designed to fail open: if PostGIS isn't installed, the function doesn't
 * exist, or the geo_places table is empty, enrichment is a silent no-op.
 * That keeps self-hosted installs that haven't run scripts/seed-geo-data.sh
 * fully functional — they just don't get the enriched fields until they
 * seed.
 */

import { type DbClient, getDb } from '../db/client';
import logger from './logger';

// Fields the lookup populates. Lined up with the apple.photos event schema.
const GEO_FIELDS = [
  'place_name',
  'country',
  'country_code',
  'admin1',
  'admin1_code',
  'timezone',
] as const;

type GeoField = (typeof GEO_FIELDS)[number];

interface GeoLookupRow {
  place_name: string | null;
  place_id: number | null;
  country_code: string | null;
  country_name: string | null;
  admin1_code: string | null;
  admin1_name: string | null;
  timezone: string | null;
  population: number | null;
  distance_km: number | null;
}

/**
 * Reverse-geocoded coordinates from a lookup. Returned as a snapshot so
 * callers can decide what to merge / log without re-querying.
 */
export interface GeoEnrichment {
  place_name: string;
  country: string;
  country_code: string;
  admin1: string | null;
  admin1_code: string | null;
  timezone: string | null;
  distance_km: number;
}

// One-shot guard. The first geo_lookup() call after process start checks
// whether PostGIS + the function + a non-empty geo_places table are all
// present. Subsequent calls skip the probe. The flag is sticky for the
// process lifetime; restart the server to re-probe after seeding.
let enrichmentAvailable: boolean | undefined;

/** Keep a fail-open query from aborting a caller-owned transaction. */
function runIsolatedQuery<T>(sql: DbClient, query: (db: DbClient) => Promise<T>): Promise<T> {
  return typeof sql.savepoint === 'function' ? sql.savepoint(query) : query(sql);
}

async function probeAvailability(sql: DbClient): Promise<boolean> {
  try {
    const probe = await runIsolatedQuery(
      sql,
      async (db) =>
        (await db`
          SELECT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'geo_lookup' AND n.nspname = 'public'
          ) AS has_fn,
          (SELECT COUNT(*) > 0 FROM geo_places LIMIT 1) AS has_data
        `) as Array<{ has_fn: boolean; has_data: boolean }>
    );
    const [row] = probe;
    return !!row && row.has_fn && row.has_data;
  } catch {
    // Catches missing extension, missing table, permission errors — all of
    // which mean "geo is not set up here." Fail open.
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractCoordinates(
  metadata: Record<string, unknown> | undefined
): { lat: number; lng: number } | null {
  if (!metadata) return null;
  const lat = metadata.latitude;
  const lng = metadata.longitude;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  // Coordinate-validity sanity: WGS-84 latitudes are [-90, 90] and
  // longitudes [-180, 180]. Outside that we have bad data — don't waste
  // a SQL roundtrip on it.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * If `metadata` carries WGS-84 coordinates, return an enrichment record;
 * otherwise return `null`. Never throws — geo enrichment is an additive
 * convenience, not a precondition for inserting an event.
 *
 * The optional `sql` arg lets the caller bind the lookup to an in-flight
 * transaction (insertEvent already supports this). Without it the lookup
 * runs on the singleton pool.
 */
export async function lookupGeoEnrichment(
  metadata: Record<string, unknown> | undefined,
  options?: {
    sql?: ReturnType<typeof getDb>;
    /**
     * Reject the lookup if the nearest known place is further than this.
     * Default 500 km — covers oceans/deserts where snapping to the
     * closest coastal city is more misleading than returning nothing.
     */
    maxDistanceKm?: number;
  }
): Promise<GeoEnrichment | null> {
  const coords = extractCoordinates(metadata);
  if (!coords) return null;

  const sql = options?.sql ?? getDb();
  // Sanitise the override: anything that's not a finite, non-negative
  // number (NaN, Infinity, accidental negatives) falls back to the
  // 500 km default rather than silently disabling the gate.
  const maxKmCandidate = options?.maxDistanceKm;
  const maxKm =
    typeof maxKmCandidate === 'number' &&
    Number.isFinite(maxKmCandidate) &&
    maxKmCandidate >= 0
      ? maxKmCandidate
      : 500;

  if (enrichmentAvailable === undefined) {
    enrichmentAvailable = await probeAvailability(sql);
    if (!enrichmentAvailable) {
      logger.debug(
        '[geo-enrichment] geo_lookup unavailable (extension/function/seed missing) — skipping all enrichment for this process'
      );
    }
  }
  if (!enrichmentAvailable) return null;

  try {
    const rows = await runIsolatedQuery(
      sql,
      async (db) =>
        (await db`
          SELECT place_name, place_id, country_code, country_name,
                 admin1_code, admin1_name, timezone, population, distance_km
          FROM geo_lookup(${coords.lat}, ${coords.lng})
        `) as GeoLookupRow[]
    );
    const [row] = rows;
    if (!row || !row.place_name || !row.country_code || !row.country_name) {
      return null;
    }
    if (row.distance_km !== null && row.distance_km > maxKm) {
      return null;
    }
    return {
      place_name: row.place_name,
      country: row.country_name,
      country_code: row.country_code,
      admin1: row.admin1_name,
      admin1_code: row.admin1_code,
      timezone: row.timezone,
      distance_km: row.distance_km ?? 0,
    };
  } catch (error) {
    logger.warn({ err: error }, '[geo-enrichment] geo_lookup query failed');
    return null;
  }
}

/**
 * Merge an enrichment into a metadata object **without overwriting fields
 * the caller already set**. Returns a new object; the input is not mutated.
 *
 * Connectors that source these fields directly (e.g. an osxphotos-style
 * direct Photos.sqlite reader on macOS) win — our nearest-neighbour
 * fallback only fills the gaps.
 */
export function mergeEnrichedMetadata(
  metadata: Record<string, unknown> | undefined,
  enrichment: GeoEnrichment | null
): Record<string, unknown> | undefined {
  if (!enrichment) return metadata;
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  const fillIfEmpty = (key: GeoField, value: unknown) => {
    if (value === null || value === undefined) return;
    if (next[key] !== undefined && next[key] !== null && next[key] !== '') return;
    next[key] = value;
  };
  fillIfEmpty('place_name', enrichment.place_name);
  fillIfEmpty('country', enrichment.country);
  fillIfEmpty('country_code', enrichment.country_code);
  fillIfEmpty('admin1', enrichment.admin1);
  fillIfEmpty('admin1_code', enrichment.admin1_code);
  fillIfEmpty('timezone', enrichment.timezone);
  return next;
}

/**
 * Reset the availability cache. Test-only — production code relies on the
 * one-shot probe, but tests need to flip the toggle between scenarios
 * without restarting the process.
 */
export function _resetGeoEnrichmentProbeForTests(): void {
  enrichmentAvailable = undefined;
}
