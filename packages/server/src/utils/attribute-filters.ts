import { type AttributeFilter, parseCollectionSelection } from '@lobu/core/contracts/tools/collection-selection';
import { ToolUserError } from './errors';

/** Validate against the selected type, never interpolate caller field names. */
export function validateAttributeFilters(filters: AttributeFilter[], schema: unknown): void {
  try { parseCollectionSelection({ filters }); }
  catch { throw new ToolUserError('Invalid attribute filters', 400, 'VALIDATION'); }
  const properties = schema && typeof schema === 'object'
    ? (schema as { properties?: Record<string, unknown> }).properties : undefined;
  for (const filter of filters) {
    if (!properties || !Object.hasOwn(properties, filter.field)) {
      throw new ToolUserError(`Unknown attribute '${filter.field}' for this entity type`, 400, 'VALIDATION');
    }
  }
}

/** Postgres JSONB comparisons preserve scalar types; all values are bound. */
export function attributeFilterSql(filters: AttributeFilter[], json: string, params: unknown[]): string[] {
  const operators = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
  return filters.map(filter => {
    const field = `$${params.push(filter.field)}::text`;
    // Bind as text so postgres.js cannot JSON-encode this serialized literal again.
    const value = `$${params.push(JSON.stringify(filter.value))}::text::jsonb`;
    const attribute = `COALESCE(${json}->${field}, 'null'::jsonb)`;
    const comparison = `${attribute} ${operators[filter.op]} ${value}`;
    return filter.op === 'eq' || filter.op === 'neq' ? comparison
      : `(jsonb_typeof(${attribute}) = jsonb_typeof(${value}) AND ${comparison})`;
  });
}
