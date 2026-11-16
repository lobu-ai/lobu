// Kept free of the schema library so a sandboxed View's fallback can order a
// list exactly as the native collection and the server do.

/** The fixed `manage_entity list` sort keys of a stored entity list. */
export const ENTITY_LIST_SORT_KEYS = [
  "name",
  "domain",
  "created_at",
  "total_content",
  "active_connections",
  "automations_count",
  "children_count",
] as const;

/** `sort_by: "metadata.<field>"` sorts by a declared scalar metadata property. */
export const ENTITY_LIST_METADATA_SORT_PREFIX = "metadata.";

export type EntityMetadataSortType =
  | "timestamptz"
  | "date"
  | "numeric"
  | "boolean"
  | "text";

/**
 * How a declared metadata property orders, or null when it is not a scalar:
 * string (date-time and date formats order as instants and days), number,
 * integer, boolean, or an untyped string enum. A `"null"` member of a type
 * union is ignored; any other union, object, or array is not sortable.
 */
export function entityMetadataSortType(
  property: unknown
): EntityMetadataSortType | null {
  if (!property || typeof property !== "object" || Array.isArray(property))
    return null;
  const { type, format, enum: values } = property as Record<string, unknown>;
  const types = (Array.isArray(type) ? type : [type]).filter(
    (item) => item !== "null"
  );
  const scalar = types.length === 1 ? types[0] : undefined;
  if (scalar === undefined)
    return Array.isArray(values) &&
      values.some((value) => typeof value === "string") &&
      values.every((value) => typeof value === "string" || value === null)
      ? "text"
      : null;
  if (scalar === "number" || scalar === "integer") return "numeric";
  if (scalar === "boolean") return "boolean";
  if (scalar !== "string") return null;
  if (format === "date-time") return "timestamptz";
  if (format === "date") return "date";
  return "text";
}

/**
 * Why a collection table sort field cannot order a stored entity list, or
 * null when it names a built-in sort key or a declared scalar property.
 */
export function collectionSortFieldError(
  field: string,
  properties: Record<string, unknown> | undefined
): string | null {
  if ((ENTITY_LIST_SORT_KEYS as readonly string[]).includes(field)) return null;
  // Own keys only (`Object.keys`: this package targets ES2020, before `Object.hasOwn`).
  if (!properties || !Object.keys(properties).includes(field))
    return `Sort field '${field}' is neither a built-in sort key nor a declared property`;
  return entityMetadataSortType(properties[field])
    ? null
    : `Sort field '${field}' is not a scalar property`;
}
