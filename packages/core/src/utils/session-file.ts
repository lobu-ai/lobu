/**
 * Shared parser for Lobu runtime `session.jsonl` files.
 *
 * Two HTTP surfaces read these files: the worker's `/session/messages` /
 * `/session/stats` endpoints (rooted at the worker's own `WORKSPACE_DIR`)
 * and the gateway's `/session/messages` / `/session/stats` REST endpoints
 * (rooted at the gateway's `workspaces/<agentId>` tree, queried when the
 * worker is offline). The gateway proxies to the worker when it's online
 * and falls back to its own copy otherwise — so the two parsers must
 * agree, and historically they had drifted (different fields kept on
 * `SessionEntry`, different `JSON.parse` error handling, the same logic
 * copy-pasted twice).
 *
 * Anything path-policy related (where to *look* for the file) stays at
 * the call site — the worker scans one level under `WORKSPACE_DIR`; the
 * gateway scans up to three levels under the per-agent workspace dir
 * with a `SAFE_AGENT_ID` regex guarding the join. Those are intentionally
 * different and must not be collapsed without an operator decision.
 */

import { safeJsonParse } from "./json";

/**
 * Raw entry shape as written to `session.jsonl` by the worker.
 *
 * `tokensBefore` / `firstKeptEntryId` (worker memory-flush bookkeeping)
 * are not read by either parser today — left off this canonical shape on
 * purpose; reintroduce when a consumer actually needs them.
 */
export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** `custom` entries: the recorder's own payload. */
  data?: unknown;
  message?: {
    role: string;
    content?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  summary?: string;
  provider?: string;
  modelId?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  /** `compaction` entries: the first entry kept verbatim after the summary. */
  firstKeptEntryId?: string;
  /** `compaction` entries: context size the summary replaced. */
  tokensBefore?: number;
  /** `branch_summary` entries: the branch the summary came back from. */
  fromId?: string;
}

/**
 * The set of `type` discriminants a {@link ParsedMessage} can carry. Kept as a
 * closed union so API consumers (and the typed client) can exhaustively switch
 * on it.
 */
export type ParsedMessageType =
  | "message"
  | "compaction"
  | "model_change"
  | "custom_message";

/** Display-friendly projection emitted to API consumers (`/session/messages`). */
export interface ParsedMessage {
  id: string;
  type: ParsedMessageType;
  role?: string;
  content: unknown;
  model?: string;
  timestamp: string;
  isVerbose?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Parse a session.jsonl blob into entries + the synthetic session id
 * found on the leading `{type: "session", id}` line.
 *
 * - Splits on `\n` and skips blank lines (same as both pre-existing copies).
 * - Uses {@link safeJsonParse} so malformed lines are skipped quietly with
 *   a debug log (debug-only because production sessions occasionally
 *   contain partial writes after crash/kill).
 * - The leading `session` entry is extracted, not pushed into `entries`.
 */
export function parseSessionEntries(content: string): {
  entries: SessionEntry[];
  sessionId?: string;
} {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: SessionEntry[] = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    const parsed = safeJsonParse<SessionEntry & { id: string }>(line);
    if (!parsed) continue;
    if (parsed.type === "session") {
      sessionId = parsed.id;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, sessionId };
}

/**
 * Project a single {@link SessionEntry} into the {@link ParsedMessage}
 * display shape, or `null` for entry kinds that don't surface as
 * user-visible messages (everything other than `message`, `compaction`,
 * `model_change`, `custom_message`).
 *
 * `isVerbose` marks entries the UI hides behind a "verbose" toggle —
 * tool results, compaction/model-change markers, custom system events
 * that aren't explicitly displayed.
 */
export function entryToMessage(entry: SessionEntry): ParsedMessage | null {
  if (entry.type === "message" && entry.message) {
    return {
      id: entry.id,
      type: "message",
      role: entry.message.role,
      content: entry.message.content,
      timestamp: entry.timestamp,
      isVerbose: entry.message.role === "toolResult",
      usage: entry.message.usage,
    };
  }
  if (entry.type === "compaction") {
    return {
      id: entry.id,
      type: "compaction",
      content: entry.summary || "",
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "model_change") {
    return {
      id: entry.id,
      type: "model_change",
      content: `${entry.provider}/${entry.modelId}`,
      model: `${entry.provider}/${entry.modelId}`,
      timestamp: entry.timestamp,
      isVerbose: true,
    };
  }
  if (entry.type === "custom_message") {
    return {
      id: entry.id,
      type: "custom_message",
      role: "user",
      content: entry.content,
      timestamp: entry.timestamp,
      isVerbose: !entry.display,
    };
  }
  return null;
}

/**
 * Thread list title: first user message text, truncated. No LLM inference —
 * the UI shows this until/unless we add an explicit title field on write.
 */
export function titleFromSessionJsonl(
  jsonl: string,
  fallback: string,
  maxLen = 42
): string {
  const { entries } = parseSessionEntries(jsonl);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: string }).text === "string"
        ) {
          text = (part as { text: string }).text;
          break;
        }
      }
    }
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    return normalized.length > maxLen
      ? `${normalized.slice(0, maxLen)}…`
      : normalized;
  }
  return fallback;
}
