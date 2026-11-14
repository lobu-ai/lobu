/**
 * Org-wide event filter: limit to events linked to entities of given type slugs.
 * A read scoped to one entity already names its record, so the filter is skipped.
 */

import { pgTextArray } from '../../db/client';

export function buildEntityTypesFilterClause(options: {
  entity_types?: string[];
  entity_id?: number | null;
  organization_id?: string;
  baseParamIndex: number;
}): { sql: string; predicate: string; params: unknown[] } {
  if (!options.entity_types?.length || !options.organization_id || options.entity_id != null) {
    return { sql: '', predicate: '', params: [] };
  }

  const orgParam = `$${options.baseParamIndex}::text`;
  const typesParam = `$${options.baseParamIndex + 1}::text[]`;

  const predicate = `f.entity_ids && (
      SELECT COALESCE(array_agg(e.id), ARRAY[]::bigint[])
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${orgParam} AND et.slug = ANY(${typesParam})
    )`;

  return {
    sql: ` AND ${predicate}`,
    predicate,
    params: [options.organization_id, pgTextArray(options.entity_types)],
  };
}