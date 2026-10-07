import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
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
    if (preset.relativeDate) {
      if ((preset.selection.filters?.length ?? 0) > 30)
        throw new Error(
          "Relative date presets support at most 30 other filters"
        );
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

export function resolveCollectionPreset(
  preset: CollectionPreset,
  now = new Date()
): CollectionSelection {
  const selection = structuredClone(preset.selection);
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
