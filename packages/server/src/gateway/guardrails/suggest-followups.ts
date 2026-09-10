/**
 * `suggest-followups` — output-stage **enrichment** guardrail.
 *
 * Not a safety trip: it never blocks a reply. When an agent enables it via
 * `guardrails: ["suggest-followups"]` and a turn ends without the agent calling
 * `suggest_actions`, the gateway may derive useful optional follow-up chips
 * from the reply and post them as their own platform card. An empty set is the
 * default: a complete answer needs no suggestions. Chat surfaces only — the
 * API/web path deliberately skips enrichment (see unified-thread-consumer).
 * Chat platforms retain the cards; the interaction bridge persists click routing.
 *
 * Ordering (critical): enrichment runs ONLY after blocking output guardrails
 * (`secret-scan`, `pii-scan`, …) have passed on the terminal text. The
 * output-scan path partitions enrichment names out of the blocking race so a
 * secret-bearing reply never reaches this LLM call. See
 * {@link isEnrichmentGuardrail}.
 *
 * Transport: the shared {@link gatewayCompletion} client, resolving an
 * org-owned OpenAI-compatible provider key. OAuth-only and non-OpenAI
 * providers are not callable through this transport. An unsupported provider,
 * unresolvable model, or any failure fails open (no chips).
 */

import {
  createLogger,
  getErrorMessage,
  sanitizeSuggestionPrompts,
  type Guardrail,
  type SuggestedPrompt,
} from "@lobu/core";
import {
  gatewayCompletion,
  resolveCompletionTarget,
} from "../inference/gateway-completion.js";

const logger = createLogger("suggest-followups");

/** Guardrail name operators put in `settings.guardrails`. */
export const SUGGEST_FOLLOWUPS_NAME = "suggest-followups";

/**
 * Output-stage instances that enrich rather than block. Partitioned out of the
 * parallel blocking race so they never run (or see the reply) before safety
 * scans pass, and so enabling only enrichment does not withhold streaming.
 * Track identity rather than name so a malformed/out-of-band inline guardrail
 * that collides with a built-in name keeps its own blocking semantics.
 */
const ENRICHMENT_GUARDRAILS = new WeakSet<Guardrail>();

export function isEnrichmentGuardrail(guardrail: Guardrail): boolean {
  return ENRICHMENT_GUARDRAILS.has(guardrail);
}

/** The tail of a reply carries the "what now" better than its opening. */
const MAX_INPUT_CHARS = 6_000;
/**
 * Generation is dispatched fire-and-forget (see ChatResponseBridge), so nothing
 * waits on this — the timeout only bounds a leaked request, it does not protect
 * turn latency. Sized like the other provider calls in the gateway
 * (MCP_PROXY_FETCH_TIMEOUT_MS, TRANSCRIPTION_FETCH_TIMEOUT_MS) rather than like
 * the blocking judges, which fail fast because a turn is stalled behind them.
 *
 * Do not trim this without measuring the org's model: reasoning-tier models are
 * slow here (glm-4.7 measured 19-26s, glm-4.6 16.7s, glm-4.5-air 21.9s on
 * 2026-07-28), and a timeout below the model's real latency yields zero chips
 * on every turn while still paying for the call. Since the model comes from the
 * org's provider row it can be ANY tier, so sizing for the slow end is the safe
 * default.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_REPLY_CHARS = 40;

const SYSTEM_PROMPT = [
  "You decide whether an assistant's reply needs optional follow-up action chips.",
  'Default to {"prompts":[]}. A complete answer does not need suggestions.',
  "Only offer a concrete next step the reply itself leaves open and that would help the user proceed.",
  "Return no suggestions for routine answers, acknowledgements, corrections, status updates, completed requests, or a reply that closes the topic.",
  "Do not invent extra work or add a generic offer to explore further.",
  "When useful next steps remain, return 1-3 distinct actions. A single useful action is enough; never pad the list.",
  "",
  'Each item is {"title","message"}:',
  '- "title": a short tappable label, at most 20 characters.',
  '- "message": the full message sent verbatim AS THE USER if tapped.',
  "",
  "Write `message` in the user's voice, as a request to the assistant:",
  '  good: "Show me the diff"   bad: "I can show you the diff"',
  "Make them specific to THIS reply — reference what was actually discussed.",
  "Do not offer an action the assistant already completed in the reply.",
  'Return STRICT JSON {"prompts":[{"title":"...","message":"..."}]} only.',
].join("\n");

/**
 * Built-in registration stub. The actual generation runs out-of-band after
 * blocking output scans pass ({@link generateSuggestFollowups}); including
 * this instance in the parallel race would either waste a model call on a
 * reply that is about to be blocked, or re-introduce the pre-scan egress
 * bug. `run` is therefore a pure no-op pass.
 */
export function createSuggestFollowupsGuardrail(): Guardrail<"output"> {
  const guardrail: Guardrail<"output"> = {
    name: SUGGEST_FOLLOWUPS_NAME,
    stage: "output",
    async run() {
      return { tripped: false };
    },
  };
  ENRICHMENT_GUARDRAILS.add(guardrail);
  return guardrail;
}

/** Per-guardrail overrides, from the agent's `suggest-followups` entry. */
interface SuggestFollowupsOptions {
  /**
   * `model` on the guardrail entry. Wins over the org default — the one knob
   * worth varying, since a slow reasoning model yields nothing under any sane
   * timeout and chip quality differs sharply by tier. Mirrors how a judge
   * guardrail's `model` field already works.
   *
   * Accepts EITHER form. `<slug>/<model>` routes to that provider row;
   * anything else is treated as a bare model id and runs on the org's default
   * provider — which is what this field always meant before credentials moved
   * to `inference_providers`, so existing values keep working. See
   * {@link resolveCompletionTarget}.
   */
  model?: string;
  /** Abort budget; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Test seam for target resolution, which otherwise reads Postgres. Injected
   * rather than mocked because Bun's `mock.module` is process-global and
   * corrupts sibling suites (see connector-discovery.test.ts).
   */
  resolveTarget?: typeof resolveCompletionTarget;
}

/**
 * Derive follow-up chips from the (already scanned) agent reply. Returns []
 * when no model resolves for the org, on short replies, or on any failure —
 * this guardrail never blocks a turn, so every path fails open.
 */
export async function generateSuggestFollowups(
  replyText: string,
  organizationId: string,
  options: SuggestFollowupsOptions = {}
): Promise<SuggestedPrompt[]> {
  const trimmed = replyText.trim();
  // A one-word reply ("Done.") gives the model no material and yields filler.
  if (trimmed.length < MIN_REPLY_CHARS) return [];

  const input =
    trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

  try {
    const resolve = options.resolveTarget ?? resolveCompletionTarget;
    const target = await resolve(organizationId, options.model);
    // No supported target means enrichment stays off for this turn.
    if (!target) return [];

    const content = await gatewayCompletion({
      target,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: input,
      temperature: 0.3,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return parsePrompts(content);
  } catch (error) {
    logger.warn(
      { error: getErrorMessage(error) },
      "suggest-followups generation failed; turn ends without chips"
    );
    return [];
  }
}

/**
 * Parse the model's `{"prompts":[...]}` JSON (tolerating markdown code fences).
 * Output is untrusted — the same sanitizer the tool path uses shapes/caps it.
 */
function parsePrompts(raw: string): SuggestedPrompt[] {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return sanitizeSuggestionPrompts((parsed as { prompts?: unknown }).prompts);
}

function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.match(fence);
  return match?.[1] ?? text;
}
