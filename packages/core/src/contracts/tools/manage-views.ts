import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";
import { ViewKeySchema } from "./view-scope";

export { ViewKeySchema, ViewScopeSchema } from "./view-scope";
export type { ViewScopeInput } from "./view-scope";
import {
  NavigationConfigSchema,
  ResolvedNavigationSectionSchema,
} from "./navigation";
import { CollectionWhenSchema } from "./collection-selection";
import {
  SourceDependenciesSchema,
  SourceFilesSchema,
} from "./source-files-schema";

// ============================================
// Lobu views: React modules rendered in the sandboxed frame.
// ============================================

// Where a view appears: one page per entry, named by its key. The attach line
// lives in the module source; there are no attach/detach verbs — changing it
// means re-saving the view. How the view renders there is the view's own
// choice, from the host's display mode (an inline card or fullscreen).
const EntityTypeSlug = (description: string) =>
  Type.String({ minLength: 1, maxLength: 120, description });

export const ViewAttachmentSchema = Type.Union(
  [
    // A record page: an inline card above the record's activity, opening
    // fullscreen in the peek. `id` pins it to one record of the type.
    Type.Object(
      {
        record: EntityTypeSlug(
          "Entity type whose record pages show this view."
        ),
        id: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Show it on this one record of the type only.",
          })
        ),
      },
      { additionalProperties: false }
    ),
    // A type's list page: a tab beside the records, at /<type>/-/views/<key>.
    Type.Object(
      {
        collection: EntityTypeSlug(
          "Entity type whose list page shows this view as a tab."
        ),
        when: Type.Optional(CollectionWhenSchema),
      },
      { additionalProperties: false }
    ),
    // The Data hub: a tab at /data/-/views/<key>.
    Type.Object(
      {
        workspace: Type.Literal(true, {
          description: "A tab on the Data hub, at /data/-/views/<key>.",
        }),
      },
      { additionalProperties: false }
    ),
    // One event's page, /events/<id>/-/views/<key>: matches an event of kind
    // `event`, optionally only when it links an entity of `type`.
    Type.Object(
      {
        event: Type.String({
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
          description:
            "Event kind (semantic_type) this view renders, e.g. 'deal.won'.",
        }),
        type: Type.Optional(
          EntityTypeSlug("Only events linking an entity of this type.")
        ),
      },
      { additionalProperties: false }
    ),
  ],
  {
    description:
      '{ record: "<type>", id?: <entity id> }, { collection: "<type>", when? }, { workspace: true } or { event: "<kind>", type?: "<type>" }',
  }
);
export type ViewAttachment = Static<typeof ViewAttachmentSchema>;

// Declared, typed URL params. Unknown params are ignored; `$collection`,
// `peek` and `peek_*` are reserved for shared selection and the peek pane.
export const ViewParamDeclSchema = Type.Object({
  type: Type.Union(
    [Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")],
    { description: "Param type used to validate the URL value." }
  ),
  default: Type.Optional(
    Type.Unknown({ description: "Default when the URL omits the param." })
  ),
  description: Type.Optional(Type.String()),
  filter: Type.Optional(
    Type.Object(
      {
        label: Type.String({ minLength: 1, maxLength: 60 }),
        options: Type.Optional(
          Type.Array(
            Type.Object(
              {
                value: Type.Union([
                  Type.String({ maxLength: 200 }),
                  Type.Number(),
                  Type.Boolean(),
                ]),
                label: Type.String({ minLength: 1, maxLength: 120 }),
              },
              { additionalProperties: false }
            ),
            { minItems: 1, maxItems: 100 }
          )
        ),
      },
      {
        additionalProperties: false,
        description:
          "Offer this param in the host's filter bar: an applied value shows as a chip above the view. Options make it a pick list; without them the host asks for a value of the param's type.",
      }
    )
  ),
});
export type ViewParamDecl = Static<typeof ViewParamDeclSchema>;

// Actions a view declares as metadata; each emits an event kind through the
// template-action chokepoint. A removed action stops working on the next read
// because the check runs against the CURRENT view row.
export const ViewActionDeclSchema = Type.Object({
  emits: Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Event kind appended when the action fires, e.g. 'deal.won'.",
  }),
});
export type ViewActionDecl = Static<typeof ViewActionDeclSchema>;

// Everything a view declares about itself, read from its module's
// `export const view = defineView({...})`. The module is the only place these
// live: `set` takes the source and the server reads this out of it.
export const ViewDefinitionSchema = Type.Object(
  {
    key: ViewKeySchema,
    name: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Display name; defaults to the key.",
      })
    ),
    description: Type.Optional(
      Type.String({ maxLength: 500, description: "What the view shows." })
    ),
    attach: Type.Array(ViewAttachmentSchema, {
      description: "Where the view appears.",
    }),
    params: Type.Optional(
      Type.Record(Type.String(), ViewParamDeclSchema, {
        description: "Declared URL params.",
      })
    ),
    actions: Type.Optional(
      Type.Record(Type.String(), ViewActionDeclSchema, {
        description: "Declared actions and the event kind each emits.",
      })
    ),
  },
  { additionalProperties: false }
);
export type ViewDefinitionDecl = Static<typeof ViewDefinitionSchema>;

// Public projection of a stored view: metadata only, never the bundle. The
// bundle travels over the view resource / shell route; the source over get.
export const ViewRowSchema = Type.Object({
  key: ViewKeySchema,
  name: Type.String(),
  description: Type.String(),
  content_hash: Type.String({
    description:
      "First 16 hex of sha256(source, declared metadata, compiled artifact digest, retained source files and dependencies). Identical content means no write.",
  }),
  attach: Type.Array(ViewAttachmentSchema),
  params: Type.Record(Type.String(), ViewParamDeclSchema),
  actions: Type.Record(Type.String(), ViewActionDeclSchema),
  // Optional because a reader outside the workspace (a public workspace's
  // visitor) gets the list without anyone's user id in it.
  last_writer: Type.Optional(
    Type.String({
      description:
        "apply:<apply_id> | <user_id> | migration:view-templates. Omitted for readers outside the workspace.",
    })
  ),
  updated_at: Type.String(),
  compiled_bytes: Type.Integer(),
  source_bytes: Type.Integer(),
});
export type ViewRow = Static<typeof ViewRowSchema>;

// ============================================
// Input Schema (union of per-action variants)
// ============================================
//
// The wire schema flattens this union into ONE MCP object and merges duplicate
// properties first-occurrence-wins, so a property carried by more than one
// variant must read true for every one of them.

export const SetViewAction = Type.Object({
  action: Type.Literal("set", {
    description:
      "Store a view: read its key, name, description, attach, params and actions from the module's `export const view = defineView({...})`, compile it, and upsert by that key.",
  }),
  source_code: Type.String({
    minLength: 1,
    maxLength: 1_000_000,
    description:
      "[set] The view module source (TSX). Its `defineView({...})` argument must be a literal; it is the only place the view's key, name, description, attach, params and actions are declared.",
  }),
  compiled_code: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "[set] CLI-bundled browser bundle for the source (relative files and npm deps resolved where node_modules exists). When present the server stores it after the size check instead of compiling; when absent the server compiles source_code itself (the chat-agent path).",
    })
  ),
  source_files: Type.Optional(SourceFilesSchema),
  dependencies: Type.Optional(SourceDependenciesSchema),
  last_writer: Type.Optional(
    Type.String({
      maxLength: 200,
      description: "[set] Provenance; defaults to the caller.",
    })
  ),
});

export const GetViewAction = Type.Object({
  action: Type.Literal("get", {
    description: "Fetch one view's metadata + source.",
  }),
  key: ViewKeySchema,
});

export const ListViewsAction = Type.Object({
  action: Type.Literal("list", {
    description: "List every view's metadata (never bundles).",
  }),
});

export const RemoveViewAction = Type.Object({
  action: Type.Literal("remove", {
    description: "Delete a view by key.",
  }),
  key: ViewKeySchema,
});

// The workspace's sidebar navigation (see ./navigation). One versioned
// document per workspace; `set_navigation` replaces it whole, and only when
// `expected_revision` is still the stored revision (409 otherwise).
export const GetNavigationAction = Type.Object({
  action: Type.Literal("get_navigation", {
    description:
      "Read the workspace navigation: { revision, config, sections }. config is the stored document (null = automatic defaults; members only), sections what the sidebar renders for the caller.",
  }),
});

export const SetNavigationAction = Type.Object({
  action: Type.Literal("set_navigation", {
    description:
      "Replace the workspace navigation document. Fails with 409 when expected_revision is stale.",
  }),
  expected_revision: Type.Integer({
    minimum: 0,
    description:
      "[set_navigation] The revision get_navigation returned; the write applies only if it is still current.",
  }),
  config: Type.Union([NavigationConfigSchema, Type.Null()], {
    description:
      "[set_navigation] The whole navigation document, or null to return to the automatic defaults.",
  }),
});

export const ManageViewsSchema = Type.Union([
  SetViewAction,
  GetViewAction,
  ListViewsAction,
  RemoveViewAction,
  GetNavigationAction,
  SetNavigationAction,
]);

export type ManageViewsArgs = Static<typeof ManageViewsSchema>;

export type ViewSetInput = ActionInput<ManageViewsArgs, "set">;
export type ViewGetInput = ActionInput<ManageViewsArgs, "get">;
export type ViewListInput = ActionInput<ManageViewsArgs, "list">;
export type ViewRemoveInput = ActionInput<ManageViewsArgs, "remove">;
export type NavigationGetInput = ActionInput<ManageViewsArgs, "get_navigation">;
export type NavigationSetInput = ActionInput<ManageViewsArgs, "set_navigation">;

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_views` — discriminated union keyed on `action`.
 * TypeBox-first: `Static<>` derives the TS type from the same schema exposed as
 * the tool's `outputSchema`.
 */
export const ManageViewsResultSchema = Type.Union([
  Type.Object({
    action: Type.Literal("set"),
    view: ViewRowSchema,
    written: Type.Boolean({
      description:
        "False when the same source, retained files, dependencies, metadata and executable artifact were already stored (no write).",
    }),
  }),
  Type.Object({
    action: Type.Literal("get"),
    view: ViewRowSchema,
    source_code: Type.String(),
    source_files: Type.Union([SourceFilesSchema, Type.Null()]),
    dependencies: Type.Union([SourceDependenciesSchema, Type.Null()]),
    source_complete: Type.Boolean(),
  }),
  Type.Object({
    action: Type.Literal("list"),
    views: Type.Array(ViewRowSchema),
  }),
  Type.Object({
    action: Type.Literal("remove"),
    key: Type.String(),
    removed: Type.Boolean(),
  }),
  Type.Object({
    action: Type.Literal("get_navigation"),
    revision: Type.Integer(),
    config: Type.Optional(Type.Union([NavigationConfigSchema, Type.Null()])),
    sections: Type.Array(ResolvedNavigationSectionSchema),
  }),
  Type.Object({
    action: Type.Literal("set_navigation"),
    revision: Type.Integer(),
    config: Type.Union([NavigationConfigSchema, Type.Null()]),
  }),
]);
export type ManageViewsResult = Static<typeof ManageViewsResultSchema>;
