/**
 * Suggested prompts — the `{title,message}` chips an agent offers the user.
 *
 * Split out of `types.ts` because this cluster is PURE: no import, no Node
 * builtin, no logger. That is what lets the isolate guest reach it through
 * `@lobu/core/agent-tooling` while `types.ts` itself keeps pulling the rest of
 * core in. Same rule as `shell-safety.ts`: never grow a Node import or a root
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
 * entries, and returns `[]` for any non-array input. Shared by the worker
 * and completion route so the worker (untrusted) and the server enforce one
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
 * The follow-up question asked after a human-facing turn's reply, on the same
 * session and model that wrote it. Asked as a side request — never appended to
 * the conversation — so the model can use the user's language and preferences
 * retained in its current context. Reusing the prefix enables prompt caching.
 */
export const FOLLOW_UP_SUGGESTIONS_PROMPT = [
  "Before the user replies: decide whether your last reply needs follow-up action chips the user can tap.",
  'Default to {"prompts":[]} when your reply leaves nothing open.',
  'If your reply offers concrete next steps ("If you want, I can …", "Want me to …?"), turn up to three distinct offers into chips.',
  "Otherwise offer a chip only for a concrete next step your reply leaves open that would help the user proceed.",
  "Return no suggestions for routine answers, acknowledgements, corrections, a finished request with nothing left open, a question the user must answer in their own words, or a reply that closes the topic, and none at all if the user asked for no suggestions.",
  "Do not invent extra work or add a generic offer to explore further.",
  "When useful next steps remain, return 1-3 distinct actions. A single useful action is enough; never pad the list.",
  "",
  'Each item is {"title","message"}:',
  '- "title": a short tappable label, at most 20 characters.',
  '- "message": the full message sent verbatim AS THE USER if tapped.',
  "",
  "Write both in the language the user writes in. Write `message` in the user's voice, as a request to you:",
  '  good: "Show me the diff"   bad: "I can show you the diff"',
  'Do not call any tool. Reply with STRICT JSON {"prompts":[{"title":"...","message":"..."}]} and nothing else.',
].join("\n");

/**
 * The chips in a reply to {@link FOLLOW_UP_SUGGESTIONS_PROMPT}, sanitized.
 * Tolerates a markdown fence or prose around the object by parsing from the
 * first `{` to the last `}`; anything unparseable is no suggestions.
 */
export function parseFollowUpSuggestions(reply: string): SuggestedPrompt[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return sanitizeSuggestionPrompts((parsed as { prompts?: unknown }).prompts);
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
