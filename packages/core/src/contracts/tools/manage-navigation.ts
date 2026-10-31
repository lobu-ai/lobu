import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ActionInput } from "./action-input";
import { COLLECTION_PRESET_QUERY_KEY } from "./collection-presentation";
import { ViewKeySchema } from "./manage-views";
import { viewPathSuffix } from "./view-path";

const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" });
const Label = Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" });
const EntityType = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,119}$" });
const Preset = Type.String({
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 120,
});

export const NavigationTargetSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("collection"),
      entity_type: EntityType,
      preset: Type.Optional(Preset),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal("view"),
      key: ViewKeySchema,
      entity_type: Type.Optional(EntityType),
      preset: Type.Optional(Preset),
    },
    { additionalProperties: false }
  ),
]);
export type NavigationTarget = Static<typeof NavigationTargetSchema>;

const LeafProperties = { id: Id, label: Label, target: NavigationTargetSchema };
const NavigationLeafSchema = Type.Object(LeafProperties, {
  additionalProperties: false,
});
export const NavigationItemSchema = Type.Object(
  {
    ...LeafProperties,
    children: Type.Optional(Type.Array(NavigationLeafSchema, { maxItems: 32 })),
  },
  { additionalProperties: false }
);
export type NavigationItem = Static<typeof NavigationItemSchema>;

export const NavigationDocumentSchema = Type.Object(
  {
    sections: Type.Array(
      Type.Object(
        {
          id: Id,
          label: Type.Optional(Label),
          items: Type.Array(NavigationItemSchema, { maxItems: 32 }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
  },
  { additionalProperties: false }
);
export type NavigationDocument = Static<typeof NavigationDocumentSchema>;

/** The tree is deliberately shallow; IDs are unique across the whole document. */
export function validateNavigationDocument(value: unknown): NavigationDocument {
  if (!Value.Check(NavigationDocumentSchema, value))
    throw new Error(
      "Invalid navigation document: use sections and at most two levels of links"
    );
  const ids = new Set<string>();
  let count = 0;
  const unique = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate navigation ID: ${id}`);
    ids.add(id);
  };
  for (const section of value.sections) {
    unique(section.id);
    for (const item of section.items) {
      for (const node of [item, ...(item.children ?? [])]) {
        unique(node.id);
        if (++count > 256)
          throw new Error("Navigation supports at most 256 links");
        if (
          node.target.type === "view" &&
          node.target.preset &&
          !node.target.entity_type
        )
          throw new Error("A view preset requires an entity_type");
      }
    }
  }
  return value;
}

/** Shared destination construction for links and active-state comparisons. */
export function navigationTargetLocation(target: NavigationTarget): {
  path: string;
  search: Record<string, string>;
} {
  const host = target.entity_type
    ? encodeURIComponent(target.entity_type)
    : "data";
  return {
    path: `/${host}${target.type === "view" ? viewPathSuffix(target.key) : ""}`,
    search: target.preset
      ? { [COLLECTION_PRESET_QUERY_KEY]: target.preset }
      : {},
  };
}

export function navigationTargetIsActive(
  target: NavigationTarget,
  relativePath: string,
  search: Record<string, unknown>
): boolean {
  return (
    relativePath.replace(/\/$/, "") === navigationTargetLocation(target).path &&
    (search[COLLECTION_PRESET_QUERY_KEY] ?? undefined) === target.preset
  );
}

export const GetNavigationAction = Type.Object(
  {
    action: Type.Literal("get"),
    projection: Type.Optional(
      Type.Literal("display", {
        description:
          "Hide unavailable targets for rendering. Owner/admin reads otherwise preserve the editable document.",
      })
    ),
  },
  { additionalProperties: false }
);
export const SetNavigationAction = Type.Object(
  {
    action: Type.Literal("set"),
    document: Type.Union([NavigationDocumentSchema, Type.Null()], {
      description:
        "Workspace sidebar sections and links. Null restores the default navigation.",
    }),
    expected_revision: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description:
          "The revision returned by the read used to prepare this edit.",
      })
    ),
  },
  { additionalProperties: false }
);
export const ManageNavigationSchema = Type.Union([
  GetNavigationAction,
  SetNavigationAction,
]);
export const ManageNavigationResultSchema = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
  document: Type.Union([NavigationDocumentSchema, Type.Null()]),
  revision: Type.String(),
  written: Type.Optional(Type.Boolean()),
});
export type ManageNavigationResult = Static<
  typeof ManageNavigationResultSchema
>;
export type NavigationGetInput = ActionInput<
  Static<typeof ManageNavigationSchema>,
  "get"
>;
export type NavigationSetInput = ActionInput<
  Static<typeof ManageNavigationSchema>,
  "set"
> & {
  expected_revision: string;
};
