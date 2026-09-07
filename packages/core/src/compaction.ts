/**
 * Context compaction, as pi does it, over the messages a turn holds.
 *
 * A port of pi-coding-agent's `core/compaction` for a runtime that has the
 * messages but no SessionManager: the isolate guest sees the conversation as
 * `replaySessionMessages` rebuilt it, decides here whether it has outgrown the
 * model's window, plans what to summarise and what to keep, and asks the model
 * for the summary through the same stream it answers with. The prompts, the
 * token estimates, the cut-point rules and the summary framing are pi's, kept
 * verbatim, so a conversation compacted on this lane reads to pi exactly like
 * one it compacted itself.
 *
 * Everything here is pure and Node-free: the model call is the caller's.
 */

import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type SessionMessage,
} from "./utils/session-summary";

export type { SessionMessage } from "./utils/session-summary";

export interface CompactionSettings {
  enabled: boolean;
  /** Tokens kept free below the window; compaction triggers past it. */
  reserveTokens: number;
  /** Roughly how many recent tokens survive a compaction verbatim. */
  keepRecentTokens: number;
}

/** pi's `DEFAULT_COMPACTION_SETTINGS`. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/** pi's `calculateContextTokens`. */
export function contextTokensFromUsage(usage: Usage): number {
  return (
    usage.totalTokens ||
    (usage.input ?? 0) +
      (usage.output ?? 0) +
      (usage.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0)
  );
}

function assistantUsage(message: SessionMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const stop = message.stopReason;
  if (stop === "aborted" || stop === "error") return undefined;
  const usage = message.usage;
  return usage && typeof usage === "object" ? (usage as Usage) : undefined;
}

/** pi's `estimateTokens`: a chars/4 estimate of one message. */
export function estimateMessageTokens(message: SessionMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(textOf(message.content).length / 4);
    case "assistant": {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          chars += block.text.length;
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars +=
            String(block.name ?? "").length +
            JSON.stringify(block.arguments ?? {}).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            chars += block.text.length;
          }
          // pi estimates an image as 4000 chars, or 1200 tokens.
          if (block.type === "image") chars += 4800;
        }
      }
      return Math.ceil(chars / 4);
    }
    default:
      return 0;
  }
}

export interface ContextUsageEstimate {
  /** The best estimate of what the next request will carry. */
  tokens: number;
  /** What the last successful assistant message reported. */
  usageTokens: number;
  /** Estimated tokens of the messages after that report. */
  trailingTokens: number;
  lastUsageIndex: number | null;
}

/**
 * pi's `estimateContextTokens`: the last assistant usage, plus an estimate of
 * everything after it; a pure estimate when no usage has been reported yet.
 */
export function estimateContextTokens(
  messages: readonly SessionMessage[]
): ContextUsageEstimate {
  let lastUsageIndex = -1;
  let usage: Usage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = assistantUsage(messages[i] as SessionMessage);
    if (found) {
      usage = found;
      lastUsageIndex = i;
      break;
    }
  }
  if (!usage) {
    let estimated = 0;
    for (const message of messages) estimated += estimateMessageTokens(message);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }
  const usageTokens = contextTokensFromUsage(usage);
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    trailingTokens += estimateMessageTokens(messages[i] as SessionMessage);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

/** pi's `shouldCompact`. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// Planning: what to summarise, what to keep
// ---------------------------------------------------------------------------

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** pi's `extractFileOpsFromMessage`: the paths an assistant's file tools touched. */
export function collectFileOperations(
  message: SessionMessage,
  ops: FileOperations
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (!block || block.type !== "toolCall") continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case "read":
        ops.read.add(path);
        break;
      case "write":
        ops.written.add(path);
        break;
      case "edit":
        ops.edited.add(path);
        break;
      default:
        break;
    }
  }
}

/**
 * The file lists a previous summary carried, read back out of the framing
 * `formatFileOperations` appends. pi carries them as entry `details`; the
 * message view has only the text, which holds the same lists.
 */
function fileOperationsFromSummary(summary: string, ops: FileOperations): void {
  const read = /<read-files>\n([\s\S]*?)\n<\/read-files>/.exec(summary);
  const modified = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/.exec(
    summary
  );
  for (const path of read?.[1]?.split("\n") ?? []) if (path) ops.read.add(path);
  for (const path of modified?.[1]?.split("\n") ?? [])
    if (path) ops.edited.add(path);
}

/** pi's `computeFileLists` + `formatFileOperations`. */
export function formatFileOperations(ops: FileOperations): string {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readFiles = [...ops.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`
    );
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/** The summary text a replayed compaction message carries, if it is one. */
export function previousCompactionSummary(
  message: SessionMessage | undefined
): string | undefined {
  if (!message || message.role !== "user") return undefined;
  const text = textOf(message.content);
  if (
    !text.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    !text.endsWith(COMPACTION_SUMMARY_SUFFIX)
  ) {
    return undefined;
  }
  return text.slice(
    COMPACTION_SUMMARY_PREFIX.length,
    text.length - COMPACTION_SUMMARY_SUFFIX.length
  );
}

export interface CompactionPlan {
  /** Index into the input messages of the first message kept verbatim. */
  firstKeptIndex: number;
  messagesToSummarize: SessionMessage[];
  /** When the cut lands inside a turn: that turn's messages before the cut. */
  turnPrefixMessages: SessionMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/**
 * pi's `findCutPoint`, over messages: walk back from the newest accumulating
 * estimated size until `keepRecentTokens` is reached, then cut at the nearest
 * user or assistant message at or after that point — never at a tool result,
 * which must follow its call.
 */
function findCutPoint(
  messages: readonly SessionMessage[],
  start: number,
  end: number,
  keepRecentTokens: number
): { firstKeptIndex: number; turnStartIndex: number; isSplitTurn: boolean } {
  const cutPoints: number[] = [];
  for (let i = start; i < end; i++) {
    const role = messages[i]?.role;
    if (role === "user" || role === "assistant") cutPoints.push(i);
  }
  if (cutPoints.length === 0) {
    return { firstKeptIndex: start, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulated = 0;
  let cutIndex = cutPoints[0] as number;
  for (let i = end - 1; i >= start; i--) {
    accumulated += estimateMessageTokens(messages[i] as SessionMessage);
    if (accumulated >= keepRecentTokens) {
      for (const candidate of cutPoints) {
        if (candidate >= i) {
          cutIndex = candidate;
          break;
        }
      }
      break;
    }
  }
  const isUser = messages[cutIndex]?.role === "user";
  let turnStartIndex = -1;
  if (!isUser) {
    for (let i = cutIndex; i >= start; i--) {
      if (messages[i]?.role === "user") {
        turnStartIndex = i;
        break;
      }
    }
  }
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUser && turnStartIndex !== -1,
  };
}

/**
 * pi's `prepareCompaction`, over messages. `undefined` when there is nothing
 * to compact: no messages, or a previous summary with nothing after it.
 */
export function planCompaction(
  messages: readonly SessionMessage[],
  settings: CompactionSettings
): CompactionPlan | undefined {
  if (messages.length === 0) return undefined;
  const previousSummary = previousCompactionSummary(messages[0]);
  const start = previousSummary === undefined ? 0 : 1;
  const end = messages.length;
  if (start >= end) return undefined;

  const tokensBefore = estimateContextTokens(messages).tokens;
  const cut = findCutPoint(messages, start, end, settings.keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;

  const messagesToSummarize = messages.slice(start, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex)
    : [];

  const fileOps: FileOperations = {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
  if (previousSummary) fileOperationsFromSummary(previousSummary, fileOps);
  for (const message of messagesToSummarize)
    collectFileOperations(message, fileOps);
  for (const message of turnPrefixMessages)
    collectFileOperations(message, fileOps);

  return {
    firstKeptIndex: cut.firstKeptIndex,
    messagesToSummarize: [...messagesToSummarize],
    turnPrefixMessages: [...turnPrefixMessages],
    isSplitTurn: cut.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Summarisation requests: pi's prompts, verbatim
// ---------------------------------------------------------------------------

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** pi's `TOOL_RESULT_MAX_CHARS`. */
const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/**
 * pi's `serializeConversation`: the messages as labelled text, so the model
 * summarises them instead of continuing them.
 */
export function serializeConversation(
  messages: readonly SessionMessage[]
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = textOf(message.content);
      if (content) parts.push(`[User]: ${content}`);
    } else if (message.role === "assistant") {
      const texts: string[] = [];
      const thinking: string[] = [];
      const calls: string[] = [];
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thinking.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = Object.entries(
            (block.arguments as Record<string, unknown>) ?? {}
          )
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          calls.push(`${String(block.name)}(${args})`);
        }
      }
      if (thinking.length > 0) {
        parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      }
      if (texts.length > 0) parts.push(`[Assistant]: ${texts.join("\n")}`);
      if (calls.length > 0) {
        parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
      }
    } else if (message.role === "toolResult") {
      const content = textOf(message.content);
      if (content) {
        parts.push(
          `[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`
        );
      }
    }
  }
  return parts.join("\n\n");
}

export interface SummaryRequest {
  systemPrompt: string;
  /** The single user message to send. */
  prompt: string;
  maxTokens: number;
}

/**
 * The model requests a plan needs — pi's `generateSummary` and
 * `generateTurnPrefixSummary` up to the call itself. `history` may be absent
 * for a split turn whose only compacted content is the turn's own prefix.
 */
export function summaryRequests(
  plan: CompactionPlan,
  customInstructions?: string
): { history?: SummaryRequest; turnPrefix?: SummaryRequest } {
  const requests: { history?: SummaryRequest; turnPrefix?: SummaryRequest } =
    {};
  if (plan.messagesToSummarize.length > 0 || !plan.isSplitTurn) {
    let basePrompt = plan.previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
    if (customInstructions) {
      basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }
    let prompt = `<conversation>\n${serializeConversation(plan.messagesToSummarize)}\n</conversation>\n\n`;
    if (plan.previousSummary) {
      prompt += `<previous-summary>\n${plan.previousSummary}\n</previous-summary>\n\n`;
    }
    prompt += basePrompt;
    requests.history = {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      prompt,
      maxTokens: Math.floor(0.8 * plan.settings.reserveTokens),
    };
  }
  if (plan.isSplitTurn && plan.turnPrefixMessages.length > 0) {
    requests.turnPrefix = {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      prompt: `<conversation>\n${serializeConversation(plan.turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
      maxTokens: Math.floor(0.5 * plan.settings.reserveTokens),
    };
  }
  return requests;
}

export interface CompactionResult {
  summary: string;
  firstKeptIndex: number;
  tokensBefore: number;
}

/**
 * pi's `compact`, after the model has answered: merge the summaries as pi
 * does and append the file lists.
 */
export function finishCompaction(
  plan: CompactionPlan,
  historySummary: string | undefined,
  turnPrefixSummary: string | undefined
): CompactionResult {
  let summary: string;
  if (plan.isSplitTurn && turnPrefixSummary !== undefined) {
    summary = `${historySummary ?? "No prior history."}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
  } else {
    summary = historySummary ?? "";
  }
  summary += formatFileOperations(plan.fileOps);
  return {
    summary,
    firstKeptIndex: plan.firstKeptIndex,
    tokensBefore: plan.tokensBefore,
  };
}

// ---------------------------------------------------------------------------
// Pre-compaction memory flush: Lobu's own step, run once per compaction cycle
// ---------------------------------------------------------------------------

/**
 * The session entry that records a flush ran. `data.compactionCount` is the
 * number of compactions on the branch at the time, so the next turn can tell
 * whether the current cycle already flushed.
 */
export const MEMORY_FLUSH_STATE_CUSTOM_TYPE = "lobu.memory_flush_state";

export interface ResolvedMemoryFlushConfig {
  enabled: boolean;
  /** How far below the compaction threshold the flush fires. */
  softThresholdTokens: number;
  systemPrompt: string;
  prompt: string;
}

const DEFAULT_MEMORY_FLUSH_CONFIG: ResolvedMemoryFlushConfig = {
  enabled: true,
  softThresholdTokens: 4000,
  systemPrompt: "Session nearing compaction. Store durable memories now.",
  prompt:
    "Write any lasting notes to memory using available memory tools. Reply with NO_REPLY if nothing to store.",
};

const APPROX_IMAGE_TOKENS = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function readNonNegativeNumberOrFallback(
  value: unknown,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** The agent's `compaction.memoryFlush` options, with Lobu's defaults filled in. */
export function resolveMemoryFlushConfig(
  rawOptions: Record<string, unknown>
): ResolvedMemoryFlushConfig {
  const compaction = isRecord(rawOptions.compaction)
    ? rawOptions.compaction
    : undefined;
  const memoryFlush =
    compaction && isRecord(compaction.memoryFlush)
      ? compaction.memoryFlush
      : undefined;
  return {
    enabled:
      typeof memoryFlush?.enabled === "boolean"
        ? memoryFlush.enabled
        : DEFAULT_MEMORY_FLUSH_CONFIG.enabled,
    softThresholdTokens: readNonNegativeNumberOrFallback(
      memoryFlush?.softThresholdTokens,
      DEFAULT_MEMORY_FLUSH_CONFIG.softThresholdTokens
    ),
    systemPrompt: readStringOrFallback(
      memoryFlush?.systemPrompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.systemPrompt
    ),
    prompt: readStringOrFallback(
      memoryFlush?.prompt,
      DEFAULT_MEMORY_FLUSH_CONFIG.prompt
    ),
  };
}

/** A chars/4 estimate of an incoming prompt, with pi's per-image allowance. */
export function estimatePromptTokenCost(
  promptText: string,
  imageCount: number
): number {
  return (
    Math.ceil(promptText.length / 4) +
    Math.max(0, imageCount) * APPROX_IMAGE_TOKENS
  );
}

/**
 * Whether a flush is due: one flush per compaction cycle, so it is due until a
 * `lobu.memory_flush_state` entry on the branch records the current count.
 */
export function memoryFlushDue(
  branch: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
  }>
): { due: boolean; compactionCount: number } {
  let compactionCount = 0;
  for (const entry of branch)
    if (entry.type === "compaction") compactionCount++;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== MEMORY_FLUSH_STATE_CUSTOM_TYPE) continue;
    const count = isRecord(entry.data) ? entry.data.compactionCount : undefined;
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      return { due: count !== compactionCount, compactionCount };
    }
  }
  return { due: true, compactionCount };
}
