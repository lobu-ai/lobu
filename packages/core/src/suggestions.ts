/**
 * Suggested prompts — the `{title,message}` chips an agent offers the user.
 *
 * Split out of `types.ts` because this cluster is PURE: no import, no Node
 * builtin, no logger. That is what lets the isolate guest reach it through
 * `@lobu/core/agent-tooling` while `types.ts` itself keeps pulling the rest of
 * core in. Same rule as `tool-policy.ts`: never grow a Node import or a root
 * `@lobu/core` import here.
 */

/**
 * Suggested prompt for user
 */
export interface SuggestedPrompt {
  title: string; // Short label shown as chip
  message: string; // Full message sent when clicked
}

/** Limits enforced wherever suggestions enter or leave durable storage.
 * `maxTitleChars` counts UTF-16 code units, matching how Slack measures its
 * 75-char button-text cap (the tightest limit a title reaches on a surface this
 * ships to) — an over-limit title degrades the whole card, not just itself.
 * These are storage-level ceilings, deliberately generous enough for web chips
 * and Slack/Telegram buttons; a surface with a tighter cap than Slack's should
 * shorten in its own renderer rather than clamp what every other surface can
 * show. */
export const SUGGESTION_LIMITS = {
  maxPrompts: 4,
  maxTitleChars: 72,
  maxMessageChars: 2000,
} as const;

/**
 * Normalize an untrusted `prompts` value into at most {@link SUGGESTION_LIMITS}
 * valid `{title,message}` entries. Trims BEFORE capping length (so leading
 * whitespace can't yield an empty displayed title), drops malformed/empty
 * entries, and returns `[]` for any non-array input. Shared by the agent tool
 * and the gateway route so the worker (untrusted) and the server enforce one
 * identical contract.
 */
export function sanitizeSuggestionPrompts(value: unknown): SuggestedPrompt[] {
  if (!Array.isArray(value)) return [];
  const out: SuggestedPrompt[] = [];
  const seen = new Set<string>();
  for (const p of value) {
    if (!p || typeof p !== "object") continue;
    const { title, message } = p as { title?: unknown; message?: unknown };
    if (typeof title !== "string" || typeof message !== "string") continue;
    const t = truncateUtf16(title.trim(), SUGGESTION_LIMITS.maxTitleChars);
    const m = Array.from(message.trim())
      .slice(0, SUGGESTION_LIMITS.maxMessageChars)
      .join("");
    if (t.length === 0 || m.length === 0) continue;
    const key = JSON.stringify([t, m]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: t, message: m });
    if (out.length >= SUGGESTION_LIMITS.maxPrompts) break;
  }
  return out;
}

/**
 * Truncate to at most `maxUnits` UTF-16 code units without splitting a
 * surrogate pair. Counting code POINTS would undercount against platform caps
 * that measure UTF-16 (Slack's is one), letting a 72-emoji title through at 144
 * units and degrading the card it renders in.
 */
function truncateUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let out = "";
  // Iterating a string yields whole code points, so a pair is never severed.
  for (const char of text) {
    if (out.length + char.length > maxUnits) break;
    out += char;
  }
  return out;
}
