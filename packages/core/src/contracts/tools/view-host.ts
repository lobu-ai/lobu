import type { CollectionSelection } from "./collection-selection";

/** Browser bridge routing hints, never authority. */
export const VIEW_WORKSPACE_META_KEY = "lobu/view-workspace";
export const VIEW_OPEN_RECORD_METHOD = "lobu/open-record";

/** A mixed read/write tool is admitted only for these fixed read actions.
 * The server still applies the visiting user's authorization and org scope. */
export function isViewRead(
  tool: string,
  args: Record<string, unknown> | undefined
): boolean {
  if (tool === "read_knowledge") return true;
  if (tool === "manage_entity") {
    return (
      args?.action === "list" ||
      args?.action === "get" ||
      args?.action === "list_links"
    );
  }
  if (tool === "manage_automations") return args?.action === "list";
  if (tool === "manage_agents") return args?.action === "get";
  if (tool === "manage_connections") return args?.action === "list";
  if (tool === "manage_catalog") return args?.action === "list_installed";
  return (
    tool === "manage_entity_schema" &&
    args?.schema_type === "entity_type" &&
    (args.action === "list" || args.action === "get")
  );
}

/**
 * Embedded views: a view places another, independently registered view in a
 * slot. The guest only reports where its slots are; the web host mounts each
 * child as its own sandboxed frame over the slot, with the visitor's session,
 * its own view key and its own actions — the parent never hosts the child's
 * code, so it cannot speak for it. A host that does not implement the methods
 * answers -32601 and the guest says so in the slot.
 */
/** guest → host request: the slots on screen now. Answered per slot. */
export const VIEW_EMBEDS_SYNC_METHOD = "lobu/embeds/sync";
/** guest → host request: keyboard focus moves into a slot's child, `{ id,
 *  direction? }`; `direction` says which way the visitor was tabbing. */
export const VIEW_EMBEDS_FOCUS_METHOD = "lobu/embeds/focus";
/** host → guest: a child's height, so the slot reserves its space. */
export const VIEW_EMBED_SIZE_NOTIFICATION = "lobu/notifications/embed-size";
/** host → guest: keyboard focus left a child; continue after or before it. */
export const VIEW_EMBED_FOCUS_NOTIFICATION = "lobu/notifications/embed-focus";
/** host → child guest: keyboard focus entered this embedded view, `{ direction
 *  }`; it lands on the first control going forward, the last going backward,
 *  so entering a child is one Tab, never a stop on its empty document. */
export const VIEW_FOCUS_ENTER_NOTIFICATION = "lobu/notifications/focus-enter";

export type ViewFocusDirection = "forward" | "backward";

/** Child frames one view may show at once. */
export const VIEW_EMBED_MAX_COUNT = 8;
/** Nesting below the page's own view: a child may embed, a grandchild may not. */
export const VIEW_EMBED_MAX_DEPTH = 2;
/** Params one slot may pass to its child. */
export const VIEW_EMBED_MAX_PARAMS = 20;

export type ViewEmbedParams = Record<string, string | number | boolean>;

/** The child's subject, combined by the same rule as `open_view`'s scope
 *  (`viewScopeShapeError`); `entity` may also be a source key, which then
 *  needs `type`. The collection selection is the host-owned list filter —
 *  never one of the child's own params. */
export interface ViewEmbedScope {
  type?: string;
  entity?: number | string;
  event?: number;
  collection?: CollectionSelection;
}

export interface ViewEmbedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One slot as the guest reports it; `rect` is in the guest's viewport.
 *  `rect.clip` is the part of it the guest actually shows — inside every
 *  scrolling or clipping ancestor, and outside any dialog or menu laid over
 *  it — so the host never lets the child cover the parent's own controls.
 *  Absent means all of it; an empty box means none. */
export interface ViewEmbedSlot {
  id: string;
  view: string;
  scope: ViewEmbedScope;
  params: ViewEmbedParams;
  rect: ViewEmbedBox & { clip?: ViewEmbedBox };
}

export type ViewEmbedStatus =
  | { id: string; status: "mounted" }
  | {
      id: string;
      status: "refused";
      reason: "cycle" | "depth" | "limit" | "invalid";
    };
