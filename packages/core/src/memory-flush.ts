/** Lobu memory-flush policy; Pi owns session compaction and its entries. */

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
