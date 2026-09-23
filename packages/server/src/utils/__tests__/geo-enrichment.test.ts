/**
 * Geo enrichment unit tests.
 *
 * No real Postgres involved — we stub the SQL handle so the helper's logic
 * (probe caching, coordinate validation, distance gate, merge semantics)
 * is exercised in isolation.
 *
 * Integration coverage against a real PostGIS-enabled DB lives upstream in
 * the seed-geo-data.sh smoke test (`SELECT * FROM geo_lookup(41.89, 12.49)`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetGeoEnrichmentProbeForTests,
  lookupGeoEnrichment,
  mergeEnrichedMetadata,
  type GeoEnrichment,
} from '../geo-enrichment';

type Sql = Parameters<typeof lookupGeoEnrichment>[1] extends { sql?: infer T } ? T : never;

/**
 * Build a fake `sql` tagged-template handle that pattern-matches on the
 * SQL text. The real client returns an array of rows; ours does the same.
 * Two named hooks let us flip semantics per test:
 *   - probeAvailability(...) returns the row geo-enrichment.ts uses to
 *     gate enrichment (presence of geo_lookup fn + non-empty geo_places).
 *   - lookupRow(lat, lng) returns the row the geo_lookup() fn would emit.
 */
function makeSqlStub(handlers: {
  probe?: () => Array<{ has_fn: boolean; has_data: boolean }>;
  lookup?: (lat: number, lng: number) => Array<Record<string, unknown>>;
  onProbeQuery?: () => void;
  onLookupQuery?: (lat: number, lng: number) => void;
}): Sql {
  const stub = (strings: TemplateStringsArray, ...args: unknown[]) => {
    const joined = strings.join('').toLowerCase();
    if (joined.includes('pg_proc')) {
      handlers.onProbeQuery?.();
      return Promise.resolve(handlers.probe?.() ?? [{ has_fn: true, has_data: true }]);
    }
    if (joined.includes('from geo_lookup')) {
      const [lat, lng] = args as [number, number];
      handlers.onLookupQuery?.(lat, lng);
      return Promise.resolve(handlers.lookup?.(lat, lng) ?? []);
    }
    throw new Error(`Unexpected SQL in test stub: ${joined}`);
  };
  return stub as unknown as Sql;
}

const SAMPLE_LOOKUP_ROW = {
  place_name: 'Rome',
  place_id: 3169070,
  country_code: 'IT',
  country_name: 'Italy',
  admin1_code: 'IT.07',
  admin1_name: 'Lazio',
  timezone: 'Europe/Rome',
  population: 2873000,
  distance_km: 0.31,
};

const ROME: GeoEnrichment = {
  place_name: 'Rome',
  country: 'Italy',
  country_code: 'IT',
  admin1: 'Lazio',
  admin1_code: 'IT.07',
  timezone: 'Europe/Rome',
  distance_km: 0.31,
};

describe('lookupGeoEnrichment', () => {
  beforeEach(() => {
    _resetGeoEnrichmentProbeForTests();
  });

  it('returns null without ever hitting SQL when metadata has no coords', async () => {
    const sql = makeSqlStub({
      onLookupQuery: () => {
        throw new Error('should not have queried geo_lookup');
      },
      onProbeQuery: () => {
        throw new Error('should not have probed');
      },
    });
    const result = await lookupGeoEnrichment({ semantic_type: 'photo' }, { sql });
    expect(result).toBeNull();
  });

  it('rejects coordinates outside WGS-84 bounds without querying', async () => {
    const sql = makeSqlStub({
      onLookupQuery: () => {
        throw new Error('should not have queried geo_lookup');
      },
    });
    expect(
      await lookupGeoEnrichment({ latitude: 91, longitude: 12 }, { sql })
    ).toBeNull();
    expect(
      await lookupGeoEnrichment({ latitude: 0, longitude: 181 }, { sql })
    ).toBeNull();
    expect(
      await lookupGeoEnrichment(
        { latitude: 'forty-one' as unknown as number, longitude: 12 },
        { sql }
      )
    ).toBeNull();
  });

  it('returns the enrichment when geo_lookup hits a place within the distance gate', async () => {
    const sql = makeSqlStub({
      probe: () => [{ has_fn: true, has_data: true }],
      lookup: () => [SAMPLE_LOOKUP_ROW],
    });
    const result = await lookupGeoEnrichment(
      { latitude: 41.89, longitude: 12.49 },
      { sql }
    );
    expect(result).toEqual(ROME);
  });

  it('returns null when the nearest place is past the distance gate', async () => {
    const sql = makeSqlStub({
      lookup: () => [{ ...SAMPLE_LOOKUP_ROW, distance_km: 750 }],
    });
    // Default gate is 500 km — middle-of-ocean coord should snap to nothing.
    const result = await lookupGeoEnrichment(
      { latitude: 0, longitude: 0 },
      { sql }
    );
    expect(result).toBeNull();
  });

  it('respects an explicit maxDistanceKm override', async () => {
    const sql = makeSqlStub({
      lookup: () => [{ ...SAMPLE_LOOKUP_ROW, distance_km: 100 }],
    });
    expect(
      await lookupGeoEnrichment(
        { latitude: 41.89, longitude: 12.49 },
        { sql, maxDistanceKm: 50 }
      )
    ).toBeNull();
    _resetGeoEnrichmentProbeForTests();
    expect(
      await lookupGeoEnrichment(
        { latitude: 41.89, longitude: 12.49 },
        { sql, maxDistanceKm: 200 }
      )
    ).toEqual({ ...ROME, distance_km: 100 });
  });

  it('returns null and caches the verdict when probe says geo is not set up', async () => {
    const onProbe = vi.fn();
    const onLookup = vi.fn();
    const sql = makeSqlStub({
      probe: () => [{ has_fn: false, has_data: false }],
      onProbeQuery: onProbe,
      onLookupQuery: onLookup,
    });
    expect(
      await lookupGeoEnrichment({ latitude: 41.89, longitude: 12.49 }, { sql })
    ).toBeNull();
    expect(
      await lookupGeoEnrichment({ latitude: 51.5, longitude: -0.12 }, { sql })
    ).toBeNull();
    // Probe runs once; the cached verdict gates every subsequent call.
    expect(onProbe).toHaveBeenCalledTimes(1);
    expect(onLookup).not.toHaveBeenCalled();
  });

  it('fails open if the probe query itself throws', async () => {
    const sql = ((strings: TemplateStringsArray) => {
      if (strings.join('').toLowerCase().includes('pg_proc')) {
        return Promise.reject(new Error('extension postgis does not exist'));
      }
      throw new Error('unexpected sql');
    }) as unknown as Sql;
    const result = await lookupGeoEnrichment(
      { latitude: 41.89, longitude: 12.49 },
      { sql }
    );
    expect(result).toBeNull();
  });

  it('isolates a failed probe in a caller-owned transaction savepoint', async () => {
    const query = vi.fn(() => Promise.reject(new Error('geo schema unavailable')));
    const sql = query as unknown as Sql & {
      savepoint: (fn: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
    };
    sql.savepoint = vi.fn((fn) => fn(sql));

    const result = await lookupGeoEnrichment(
      { latitude: 41.89, longitude: 12.49 },
      { sql }
    );

    expect(result).toBeNull();
    expect(sql.savepoint).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('mergeEnrichedMetadata', () => {
  it('fills empty fields without overwriting existing ones', () => {
    const merged = mergeEnrichedMetadata(
      { latitude: 41.89, longitude: 12.49, place_name: 'Trastevere' },
      ROME
    );
    // Connector wrote place_name itself — we don't clobber it.
    expect(merged?.place_name).toBe('Trastevere');
    // Country wasn't set — we fill it.
    expect(merged?.country).toBe('Italy');
    expect(merged?.country_code).toBe('IT');
    expect(merged?.admin1).toBe('Lazio');
    expect(merged?.timezone).toBe('Europe/Rome');
  });

  it('treats null and empty string as "not set" and fills them', () => {
    const merged = mergeEnrichedMetadata(
      { latitude: 0, longitude: 0, country: '', admin1: null },
      ROME
    );
    expect(merged?.country).toBe('Italy');
    expect(merged?.admin1).toBe('Lazio');
  });

  it('passes metadata through untouched when enrichment is null', () => {
    const input = { latitude: 41.89, longitude: 12.49 };
    expect(mergeEnrichedMetadata(input, null)).toBe(input);
  });

  it('handles undefined metadata input', () => {
    expect(mergeEnrichedMetadata(undefined, ROME)).toMatchObject({
      country: 'Italy',
      place_name: 'Rome',
    });
  });
});
