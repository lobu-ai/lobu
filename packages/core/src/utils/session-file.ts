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
    /**
     * `bashExecution` messages (pi's `!command` records) carry their payload
     * directly on `message` rather than in `content` — see pi's
     * `BashExecutionMessage` / `recordBashResult`. These fields are only
     * present when `role === "bashExecution"`.
     */
    command?: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string;
    excludeFromContext?: boolean;
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

import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type SessionMessage,
} from "./session-summary";

export {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type SessionMessage,
};

function userText(text: string, timestamp: string): SessionMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: new Date(timestamp).getTime(),
  };
}

/** pi's `bashExecutionToText`: how a `!command` record reads to the model. */
function bashExecutionText(
  message: NonNullable<SessionEntry["message"]>
): string {
  let text = `Ran \`${message.command ?? ""}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (
    message.exitCode !== null &&
    message.exitCode !== undefined &&
    message.exitCode !== 0
  ) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

/** One entry as the model sees it, or nothing for entries it never sees. */
function entryToModelMessage(entry: SessionEntry): SessionMessage | null {
  if (entry.type === "message" && entry.message) {
    const message = entry.message;
    if (message.role === "bashExecution") {
      if (message.excludeFromContext) return null;
      return userText(bashExecutionText(message), entry.timestamp);
    }
    if (
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult"
    ) {
      return message as SessionMessage;
    }
    return null;
  }
  if (entry.type === "custom_message") {
    const content =
      typeof entry.content === "string"
        ? [{ type: "text", text: entry.content }]
        : entry.content;
    return {
      role: "user",
      content,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return userText(
      BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX,
      entry.timestamp
    );
  }
  return null;
}

/**
 * The session's current branch: the parent chain walked back from the last
 * entry, oldest first, so entries off the branch (pi's tree navigation) are
 * left out. pi chains every entry to its parent, so a parent that is null or
 * unknown only ever occurs on a file's first entry; Lobu's own writers have
 * also emitted flat files whose entries all carry a null parent, and those
 * continue in file order, which is the only branch a flat file has.
 *
 * `replaySessionMessages` turns the branch into the messages the model is
 * shown — pi's `buildSessionContext` followed by its `convertToLlm`, without
 * a SessionManager or a filesystem. When the branch carries a `compaction`
 * entry, the model sees the summary first, then the entries kept verbatim
 * from `firstKeptEntryId` up to the compaction, then everything after it —
 * exactly the context pi would rebuild from the same file, which is what lets
 * one snapshot serve both lanes.
 */
export function sessionBranch(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  const position = new Map<SessionEntry, number>();
  entries.forEach((entry, index) => {
    byId.set(entry.id, entry);
    position.set(entry, index);
  });
  const leaf = entries[entries.length - 1];
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    const parent: SessionEntry | undefined = current.parentId
      ? byId.get(current.parentId)
      : undefined;
    if (parent) {
      current = parent;
      continue;
    }
    const index: number = position.get(current) ?? 0;
    current = index > 0 ? entries[index - 1] : undefined;
  }
  return path;
}

/** A replayed message with the entry it came from. */
export interface ReplayedMessage {
  entryId: string;
  message: SessionMessage;
}

/**
 * `replaySessionMessages`, keeping each message's source entry id — so a
 * compaction planned over the messages by index can be written back as pi's
 * `firstKeptEntryId`. The compaction summary itself maps to its entry.
 */
export function replaySessionEntries(
  entries: SessionEntry[]
): ReplayedMessage[] {
  const path = sessionBranch(entries);
  if (path.length === 0) return [];

  let compactionIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]?.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  const messages: ReplayedMessage[] = [];
  const append = (entry: SessionEntry) => {
    const message = entryToModelMessage(entry);
    if (message) messages.push({ entryId: entry.id, message });
  };
  if (compactionIndex < 0) {
    for (const entry of path) append(entry);
    return messages;
  }

  const compaction = path[compactionIndex] as SessionEntry;
  messages.push({
    entryId: compaction.id,
    message: userText(
      COMPACTION_SUMMARY_PREFIX +
        (compaction.summary ?? "") +
        COMPACTION_SUMMARY_SUFFIX,
      compaction.timestamp
    ),
  });
  let keeping = false;
  for (let i = 0; i < compactionIndex; i++) {
    const entry = path[i] as SessionEntry;
    if (entry.id === compaction.firstKeptEntryId) keeping = true;
    if (keeping) append(entry);
  }
  for (let i = compactionIndex + 1; i < path.length; i++) {
    append(path[i] as SessionEntry);
  }
  return messages;
}

export function replaySessionMessages(
  entries: SessionEntry[]
): SessionMessage[] {
  return replaySessionEntries(entries).map((replayed) => replayed.message);
}

/**
 * The set of `type` discriminants a {@link ParsedMessage} can carry. Kept as a
 * closed union so API consumers (and the typed client) can exhaustively switch
 * on it. `bashExecution` projects pi's `!command` records — the command and its
 * output, so a `!`-bash turn survives a page reload.
 */
export type ParsedMessageType =
  | "message"
  | "compaction"
  | "model_change"
  | "custom_message"
  | "bashExecution";

/**
 * Structured `content` for a `bashExecution` {@link ParsedMessage}. `exitCode`
 * is `undefined` while a command is still running / was cancelled before exit.
 * `excludeFromContext` mirrors pi's `!!` (hidden-from-model) flag — it does NOT
 * hide the record from the transcript.
 */
export interface BashExecutionContent {
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext?: boolean;
  fullOutputPath?: string;
}

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
 * A `message` entry whose inner `role` is `bashExecution` (pi's `!command`
 * record) is projected as a `bashExecution` message with a structured
 * {@link BashExecutionContent} payload, so a `!`-bash turn survives reload.
 *
 * `isVerbose` marks entries the UI hides behind a "verbose" toggle —
 * tool results, compaction/model-change markers, custom system events
 * that aren't explicitly displayed. A `bashExecution` record is never
 * verbose: even `!!` (`excludeFromContext: true`) is hidden only from the
 * model's context, not from the transcript.
 */
export function entryToMessage(entry: SessionEntry): ParsedMessage | null {
  if (entry.type === "message" && entry.message?.role === "bashExecution") {
    const m = entry.message;
    const content: BashExecutionContent = {
      command: m.command ?? "",
      output: m.output ?? "",
      exitCode: m.exitCode,
      cancelled: m.cancelled ?? false,
      truncated: m.truncated ?? false,
      excludeFromContext: m.excludeFromContext,
      fullOutputPath: m.fullOutputPath,
    };
    return {
      id: entry.id,
      type: "bashExecution",
      role: "bashExecution",
      content,
      timestamp: entry.timestamp,
      isVerbose: false,
    };
  }
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
