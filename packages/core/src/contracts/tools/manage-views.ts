import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

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

// Where a view appears. The attach line lives in the module source; there are
// no attach/detach verbs — changing placement means re-saving the view.
const ViewPlacementSchema = Type.Optional(
  Type.Union([Type.Literal("tab"), Type.Literal("overview")], {
    description:
      "Type-attached views render as a full tab or an Overview card.",
  })
);

export const ViewAttachmentSchema = Type.Union([
  Type.Object({
    type: Type.String({
      minLength: 1,
      maxLength: 120,
      description: "Entity-type slug this view attaches to.",
    }),
    placement: ViewPlacementSchema,
  }),
  Type.Object({
    entity: Type.Union([Type.Integer(), Type.String()], {
      description: "Entity id (number) or slug (string) this view attaches to.",
    }),
    placement: ViewPlacementSchema,
  }),
  Type.Object({
    workspace: Type.Literal(true, {
      description: "A tab on the Data hub, at /data/-/views/<key>.",
    }),
    placement: ViewPlacementSchema,
  }),
]);
export type ViewAttachment = Static<typeof ViewAttachmentSchema>;

// Declared, typed URL params. Unknown params are ignored; `peek` and `peek_*`
// are reserved (the web shell's peek pane reads them on every page).
export const ViewParamDeclSchema = Type.Object({
  type: Type.Union(
    [Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")],
    { description: "Param type used to validate the URL value." }
  ),
  default: Type.Optional(
    Type.Unknown({ description: "Default when the URL omits the param." })
  ),
  description: Type.Optional(Type.String()),
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
      "First 16 hex of sha256(source, declared metadata, compiled artifact digest). Same executable artifact and same metadata means no write.",
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
        "False when the same executable artifact was already stored (no write).",
    }),
  }),
  Type.Object({
    action: Type.Literal("get"),
    view: ViewRowSchema,
    source_code: Type.String(),
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
