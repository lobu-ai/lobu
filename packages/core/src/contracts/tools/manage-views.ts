import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";
import { CollectionWhenSchema } from "./collection-selection";
import {
  SourceDependenciesSchema,
  SourceFilesSchema,
} from "./source-files-schema";

// ============================================
// Lobu views: React modules rendered in the sandboxed frame.
// ============================================

// A view key names the module: lowercase, dashes, 1-64 chars. The folder is
// only a convention — the key is the identity (no `custom:<name>` prefix).
export const ViewKeySchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
  minLength: 1,
  maxLength: 64,
  description: "View key, e.g. 'pipeline'.",
});

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
  last_writer: Type.String({
    description: "apply:<apply_id> | <user_id> | migration:view-templates",
  }),
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
    description: "Store a view: compile source_code and upsert by key.",
  }),
  key: ViewKeySchema,
  name: Type.Optional(
    Type.String({
      maxLength: 120,
      description: "[set] Display name; defaults to key.",
    })
  ),
  description: Type.Optional(
    Type.String({ maxLength: 500, description: "[set] What the view shows." })
  ),
  source_code: Type.String({
    minLength: 1,
    maxLength: 1_000_000,
    description: "[set] The view module source (TSX). Compiled server-side.",
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
  attach: Type.Optional(
    Type.Array(ViewAttachmentSchema, {
      description:
        "[set] Where the view appears; extracted from the module by the caller.",
    })
  ),
  params: Type.Optional(
    Type.Record(Type.String(), ViewParamDeclSchema, {
      description: "[set] Declared URL params.",
    })
  ),
  actions: Type.Optional(
    Type.Record(Type.String(), ViewActionDeclSchema, {
      description: "[set] Declared actions and the event kind each emits.",
    })
  ),
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

export const ManageViewsSchema = Type.Union([
  SetViewAction,
  GetViewAction,
  ListViewsAction,
  RemoveViewAction,
]);

export type ManageViewsArgs = Static<typeof ManageViewsSchema>;

export type ViewSetInput = ActionInput<ManageViewsArgs, "set">;
export type ViewGetInput = ActionInput<ManageViewsArgs, "get">;
export type ViewListInput = ActionInput<ManageViewsArgs, "list">;
export type ViewRemoveInput = ActionInput<ManageViewsArgs, "remove">;

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
]);
export type ManageViewsResult = Static<typeof ManageViewsResultSchema>;
