/** Browser bridge routing hints, never authority. */
export const VIEW_WORKSPACE_META_KEY = "lobu/view-workspace";
export const VIEW_OPEN_RECORD_METHOD = "lobu/open-record";

/** A mixed read/write tool is admitted only for these fixed read actions.
 * The server still applies the visiting user's authorization and org scope. */
export function isViewRead(
  tool: string,
  args: Record<string, unknown> | undefined
): boolean {
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
