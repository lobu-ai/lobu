/**
 * Structured, tool-specific metadata that rides a tool trace to SSE clients.
 *
 * A trace's `output` is a clipped string meant for display, so it cannot be
 * the source of this: `search_memory` over a handful of events exceeds the
 * clip, and a truncated JSON body parses to nothing. The summary is therefore
 * built where the UNCLIPPED result exists — in the worker, at the moment the
 * tool returns — and travels as its own field.
 *
 * Pure by construction: no Node builtin, no `@lobu/core` barrel import. The
 * isolate lane bundles this into its guest, under the same standing rule as
 * `agent-tooling.ts` and `tool-policy.ts`.
 */

/** Retrieval evidence a client can join back to the agent's answer. */
export interface ToolTraceSummary {
  /** Event ids the tool matched. */
  event_ids?: number[];
  /**
   * Snippet text keyed by event id. The promptfoo provider joins these into
   * `metadata.retrievedContext` for its RAG assertions (`context-recall`,
   * `context-faithfulness`), so a turn with no snippets has no retrieval
   * evidence to assert against.
   */
  snippets?: Array<{ id: number; text: string }>;
}

/**
 * Retrieval tools, by the names the gateway publishes them under. The set is
 * the reason this module exists rather than a generic shape sniff: only a
 * retrieval tool's result carries evidence, and guessing from shape would
 * summarise any tool that happened to return `{content:[{id}]}`.
 */
const RETRIEVAL_TOOL_NAMES = new Set(["search_memory", "lobu_search_memory"]);

/**
 * Whether a tool's result should be requested as JSON (`x-mcp-format: json`)
 * so `summarizeToolTrace` has a structured body to read. The gateway renders
 * every tool result as markdown unless the caller asks, and markdown parses to
 * nothing here.
 */
export function isRetrievalTool(toolName: string): boolean {
  return RETRIEVAL_TOOL_NAMES.has(toolName);
}

/** How many snippets one trace may carry, and how much text each keeps. */
const MAX_SNIPPETS = 16;
const MAX_SNIPPET_CHARS = 2_000;

/**
 * Summarise a finished tool call, or `null` when there is nothing to say.
 *
 * Best-effort by contract, like the trace it rides with: a parse failure
 * returns `null` rather than throwing, because a tool trace is a VIEW of the
 * turn and must never be able to fail the turn.
 */
export function summarizeToolTrace(
  toolName: string,
  result: unknown
): ToolTraceSummary | null {
  if (!RETRIEVAL_TOOL_NAMES.has(toolName)) return null;
  let body: unknown;
  try {
    body = extractStructuredBody(result);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;

  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;

  const eventIds: number[] = [];
  const snippets: Array<{ id: number; text: string }> = [];
  for (const entry of content) {
    if (snippets.length >= MAX_SNIPPETS) break;
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "number") continue;
    eventIds.push(id);
    const text = (entry as { text_content?: unknown }).text_content;
    if (typeof text === "string" && text.length > 0) {
      snippets.push({ id, text: text.slice(0, MAX_SNIPPET_CHARS) });
    }
  }

  const summary: ToolTraceSummary = {
    ...(eventIds.length > 0 ? { event_ids: eventIds } : {}),
    ...(snippets.length > 0 ? { snippets } : {}),
  };
  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * An MCP tool result arrives from the gateway proxy as
 * `{ content: [{ type: 'text', text: '<json>' }] }`, while an in-process tool
 * may pass its object straight through. Both shapes reach here.
 */
function extractStructuredBody(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;
  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: unknown }).type !== "text") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      try {
        return JSON.parse(text);
      } catch {
        // A plain-text result: nothing structured to summarise.
        return null;
      }
    }
  }
  return raw;
}
