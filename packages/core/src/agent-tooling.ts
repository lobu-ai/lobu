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

import { Type } from "@sinclair/typebox";

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

const fileToolSchemas = {
  read: Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    offset: Type.Optional(
      Type.Number({ description: "Start reading at this byte offset" })
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum bytes to read" })),
  }),
  write: Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    content: Type.String({ description: "Content to write" }),
  }),
  edit: Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    old_string: Type.String({ description: "Text to replace" }),
    new_string: Type.String({ description: "Replacement text" }),
  }),
};

/** The same model-facing file parameters on the Node and isolate runtimes. */
export function withLobuFileParameters<
  T extends {
    parameters: unknown;
    description: string;
    execute: (...args: any[]) => any;
  },
>(tool: T, kind: keyof typeof fileToolSchemas): T {
  return {
    ...tool,
    parameters: fileToolSchemas[kind],
    ...(kind === "edit"
      ? {
          description:
            "Edit a file by replacing old_string with new_string. The text to replace must match a unique region of the file. Use an empty new_string to delete text.",
        }
      : {}),
    execute: (id, rawParams, signal, onUpdate) => {
      const params =
        rawParams && typeof rawParams === "object" ? rawParams : {};
      const required =
        kind === "edit"
          ? ["file_path", "old_string", "new_string"]
          : kind === "write"
            ? ["file_path", "content"]
            : ["file_path"];
      for (const key of required) {
        // Empty replacement/content is meaningful: deleting text or clearing a file.
        if (
          typeof params[key] !== "string" ||
          (key === "file_path" && !params[key].trim())
        ) {
          throw new Error(`Missing required parameter: ${key}`);
        }
      }
      const { file_path, old_string, new_string, ...rest } = params;
      // The agent loop runs Pi's own prepareArguments (spread in above) first;
      // on this snake_case input it is a no-op, so the translation to Pi's
      // current edits[] contract happens here, not through its retired aliases.
      const normalized =
        kind === "edit"
          ? {
              path: file_path,
              edits: [{ oldText: old_string, newText: new_string }],
            }
          : { ...rest, path: file_path };
      return tool.execute(id, normalized, signal, onUpdate);
    },
  };
}
