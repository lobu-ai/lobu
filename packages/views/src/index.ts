/**
 * `@lobu/views` — authoring runtime for Lobu views.
 *
 * A view is an ordinary React module rendered in the sandboxed MCP Apps
 * frame. The module declares itself with `defineView` and mounts once with
 * `mountView`; hooks bridge params, scope, reads and actions to the host.
 */
export { ViewBridge } from "./bridge.js";
export type { BridgeOptions, HostContext, ToolResult } from "./bridge.js";
export {
  coerceParams,
  defaultsFor,
  defineView,
  escapeLiteral,
  mintInteractionId,
  mountView,
  sql,
  tool,
  useAction,
  useHost,
  useParams,
  useQuery,
  useScope,
} from "./api.js";
export type {
  ActionResult,
  Attachment,
  MountOptions,
  ParamDef,
  Params,
  ParamValue,
  QueryState,
  Scope,
  SqlQuery,
  ToolQuery,
  ViewDefinition,
} from "./api.js";
