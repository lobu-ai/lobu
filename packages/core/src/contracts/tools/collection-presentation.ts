import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AttributeFiltersSchema,
  type CollectionSelection,
  CollectionSelectionSchema,
} from "./collection-selection";

/** Presentation metadata travels through the existing entity schema. */
export const COLLECTION_PRESENTATION_KEY = "x-lobu-collection";
export const COLLECTION_PRESET_QUERY_KEY = "$preset";
export const COLLECTION_TABLE_QUERY_KEY = "$table";
const Field = Type.String({
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  maxLength: 120,
});
const TableSchema = Type.Object(
  {
    columns: Type.Optional(
      Type.Array(Field, { maxItems: 100, uniqueItems: true })
    ),
    sort: Type.Optional(
      Type.Object(
        {
          field: Field,
          order: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);
const PresetSchema = Type.Object(
  {
    key: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    selection: CollectionSelectionSchema,
    table: Type.Optional(TableSchema),
    relativeDate: Type.Optional(
      Type.Object(
        {
          field: Field,
          fromDays: Type.Integer({ minimum: -3660, maximum: 3660 }),
          toDays: Type.Integer({ minimum: -3660, maximum: 3660 }),
          timeZone: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false }
      )
    ),
    /** Adds `{ field, op: "eq", value: <signed-in user's email> }`. Only a
     * filter: read access is still enforced server-side. */
    viewer: Type.Optional(
      Type.Object({ field: Field }, { additionalProperties: false })
    ),
  },
  { additionalProperties: false }
);
export const CollectionPresentationSchema = Type.Object(
  {
    presets: Type.Optional(Type.Array(PresetSchema, { maxItems: 32 })),
    table: Type.Optional(TableSchema),
    /** Read-only SDK script. Receives `input: { field, collection }`; returns
     * { connection, sql } for a bounded query_sql read of { value, count } rows.
     * Both calls run as the viewer; this binding grants no source access. */
    facetQuery: Type.Optional(Type.String({ minLength: 1, maxLength: 64_000 })),
  },
  { additionalProperties: false }
);
export type CollectionPresentation = Static<
  typeof CollectionPresentationSchema
>;
export type CollectionPreset = Static<typeof PresetSchema>;
export type CollectionTable = Static<typeof TableSchema>;

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

const MAX_FILTERS = AttributeFiltersSchema.maxItems ?? 32;

export function parseCollectionPresentation(
  raw: unknown
): CollectionPresentation {
  if (!Value.Check(CollectionPresentationSchema, raw))
    throw new Error("Invalid collection presentation configuration");
  const keys = new Set<string>();
  for (const preset of raw.presets ?? []) {
    if (keys.has(preset.key))
      throw new Error(`Duplicate collection preset: ${preset.key}`);
    keys.add(preset.key);
    // The resolved selection must still fit the selection contract.
    if (
      (preset.selection.filters?.length ?? 0) +
        (preset.viewer ? 1 : 0) +
        (preset.relativeDate ? 2 : 0) >
      MAX_FILTERS
    )
      throw new Error(
        `Collection preset ${preset.key} resolves to more than ${MAX_FILTERS} filters`
      );
    if (preset.relativeDate) {
      if (preset.relativeDate.fromDays > preset.relativeDate.toDays)
        throw new Error("Relative date range is reversed");
      // Intl validates IANA timezone names, including UTC.
      new Intl.DateTimeFormat("en", {
        timeZone: preset.relativeDate.timeZone,
      }).format();
    }
  }
  return raw;
}

/**
 * The preset as a concrete selection. A viewer preset needs the signed-in
 * viewer and throws without one, so it never widens to every row.
 */
export function resolveCollectionPreset(
  preset: CollectionPreset,
  now = new Date(),
  viewer?: { email: string }
): CollectionSelection {
  const selection = structuredClone(preset.selection);
  if (preset.viewer) {
    if (!viewer?.email)
      throw new Error(
        `Collection preset ${preset.key} needs a signed-in viewer`
      );
    selection.filters = [
      ...(selection.filters ?? []),
      {
        field: preset.viewer.field,
        op: "eq",
        value: viewer.email.toLowerCase(),
      },
    ];
  }
  if (!preset.relativeDate) return selection;
  const { field, fromDays, toDays, timeZone } = preset.relativeDate;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (key: string) =>
    Number(parts.find((item) => item.type === key)?.value);
  const day = Date.UTC(part("year"), part("month") - 1, part("day"));
  const date = (offset: number) =>
    new Date(day + offset * 86_400_000).toISOString().slice(0, 10);
  return {
    ...selection,
    filters: [
      ...(selection.filters ?? []),
      { field, op: "gte", value: date(fromDays) },
      { field, op: "lte", value: date(toDays) },
    ],
  };
}
