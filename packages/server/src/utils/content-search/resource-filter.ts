/** Exact resource scopes shared by every Events read path. */
interface EventResourceFilters {
  event_category?: string;
  resource_kind?: string;
  resource_id?: string;
}

/**
 * Equality predicates on `metadata` for the supplied filters, numbered from
 * `baseParamIndex`. Callers that assemble a condition list take
 * `conditions`; callers that splice into a WHERE string take `sql`
 * (empty, or `AND …` for each predicate).
 */
export function buildEventResourceFilterClause(
  filters: EventResourceFilters,
  baseParamIndex: number,
  alias: 'f' | 'e' = 'f'
): { sql: string; conditions: string[]; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  for (const [field, value] of [
    ['category', filters.event_category],
    ['resource_kind', filters.resource_kind],
    ['resource_id', filters.resource_id],
  ] as const) {
    if (value === undefined) continue;
    params.push(value);
    conditions.push(`${alias}.metadata->>'${field}' = $${baseParamIndex + params.length - 1}::text`);
  }
  return {
    sql: conditions.map((condition) => `AND ${condition}`).join(' '),
    conditions,
    params,
  };
}
