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
/** guest → host request: keyboard focus moves into a slot's child. */
export const VIEW_EMBEDS_FOCUS_METHOD = "lobu/embeds/focus";
/** host → guest: a child's height, so the slot reserves its space. */
export const VIEW_EMBED_SIZE_NOTIFICATION = "lobu/notifications/embed-size";
/** host → guest: keyboard focus left a child; continue after or before it. */
export const VIEW_EMBED_FOCUS_NOTIFICATION = "lobu/notifications/embed-focus";

/** Child frames one view may show at once. */
export const VIEW_EMBED_MAX_COUNT = 8;
/** Nesting below the page's own view: a child may embed, a grandchild may not. */
export const VIEW_EMBED_MAX_DEPTH = 2;
/** Params one slot may pass to its child. */
export const VIEW_EMBED_MAX_PARAMS = 20;

export type ViewEmbedParams = Record<string, string | number | boolean>;

export interface ViewEmbedScope {
  type?: string;
  entity?: number | string;
  event?: number;
}

/** One slot as the guest reports it; `rect` is in the guest's viewport. */
export interface ViewEmbedSlot {
  id: string;
  view: string;
  scope: ViewEmbedScope;
  params: ViewEmbedParams;
  rect: { x: number; y: number; width: number; height: number };
}

export type ViewEmbedStatus =
  | { id: string; status: "mounted" }
  | {
      id: string;
      status: "refused";
      reason: "cycle" | "depth" | "limit" | "invalid";
    };
