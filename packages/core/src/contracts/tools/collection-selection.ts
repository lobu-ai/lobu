import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const COLLECTION_QUERY_KEY = "$collection";

const Field = Type.String({
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  maxLength: 120,
});
const AttributeValueSchema = Type.Union([
  Type.String({ maxLength: 2000 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export type AttributeValue = Static<typeof AttributeValueSchema>;

/** Conjunction only. Fields are schema attributes, never SQL expressions. */
const AttributeFilterSchema = Type.Union([
  Type.Object(
    {
      field: Field,
      op: Type.Union([Type.Literal("eq"), Type.Literal("neq")]),
      value: AttributeValueSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      field: Field,
      op: Type.Union([
        Type.Literal("lt"),
        Type.Literal("lte"),
        Type.Literal("gt"),
        Type.Literal("gte"),
      ]),
      value: Type.Union([Type.String({ maxLength: 2000 }), Type.Number()]),
    },
    { additionalProperties: false }
  ),
]);
export type AttributeFilter = Static<typeof AttributeFilterSchema>;
export const AttributeFiltersSchema = Type.Array(AttributeFilterSchema, {
  maxItems: 32,
});

/** Host-owned selection, independent of a view's sorting/layout parameters. */
export const CollectionSelectionSchema = Type.Object(
  {
    search: Type.Optional(Type.String({ maxLength: 512 })),
    filters: Type.Optional(AttributeFiltersSchema),
    segment: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false }
);
export type CollectionSelection = Static<typeof CollectionSelectionSchema>;

export const CollectionWhenSchema = Type.Record(Field, AttributeValueSchema, {
  maxProperties: 32,
  additionalProperties: false,
});
type CollectionWhen = Static<typeof CollectionWhenSchema>;

/** Malformed URL/host input must never silently become an unfiltered read. */
export function parseCollectionSelection(raw: unknown): CollectionSelection {
  if (raw === undefined) return {};
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > 80_000)
      throw new Error("Collection selection is too large");
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Invalid collection selection JSON");
    }
  }
  if (!Value.Check(CollectionSelectionSchema, value)) {
    throw new Error(
      "Invalid collection selection: use search and typed attribute filters"
    );
  }
  return value;
}

/** Tab applicability is descriptive, never an authorization boundary. */
export function selectionImplies(
  selection: CollectionSelection,
  when: CollectionWhen
): boolean {
  return Object.entries(when).every(([field, value]) =>
    selection.filters?.some(
      (filter) =>
        filter.field === field && filter.op === "eq" && filter.value === value
    )
  );
}
