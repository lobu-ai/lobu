/**
 * The slice of core a gateway TOOL needs, and nothing else.
 *
 * `plugin-toolkit` and the plugins built on it run on two lanes now: in the
 * agent worker's Node process, and inside the connector isolate that runs an
 * `agent_turn`. The isolate bundle cannot contain a Node builtin, and the root
 * `@lobu/core` barrel reaches winston through `createLogger` — so a tool
 * importing the barrel is what made those packages unbundleable, not anything
 * in the tools themselves.
 *
 * Everything re-exported here is pure. Same standing rule as `tool-policy.ts`:
 * never grow a Node import or a root `@lobu/core` import in this module or the
 * modules it names, or the isolate lane loses its gateway tools with no
 * compile error to say so — `assertIsolateEligible` catches it at run time.
 */

export {
  CUSTOM_TOOL_METADATA,
  type CustomToolMetadata,
  getCustomToolDescription,
  renderAlwaysOnToolPolicyRulesFor,
} from "./agent-policy";
export {
  sanitizeSuggestionPrompts,
  SUGGESTION_LIMITS,
  type SuggestedPrompt,
} from "./suggestions";

/**
 * What a tool logs, without saying how. The worker lane passes core's winston
 * logger; the isolate guest passes its own console-backed one. Structurally
 * identical to `Logger` in `logger.ts`, restated rather than imported for the
 * one reason this module exists: that import would pull winston back in.
 */
export interface ToolLogger {
  error: (message: unknown, ...args: unknown[]) => void;
  warn: (message: unknown, ...args: unknown[]) => void;
  info: (message: unknown, ...args: unknown[]) => void;
  debug: (message: unknown, ...args: unknown[]) => void;
}
