/**
 * THE classifier: a failure's message → a catalog code.
 *
 * Single source of truth for turning a raw provider failure into an
 * `AgentErrorCode`. Every other layer consumes this rather than growing its
 * own regex, and three of them act on the result:
 *
 * - `providerQuotaResetNotBefore` (automations/schedule-cursor.ts) returns
 *   `null` unless the code is `PROVIDER_QUOTA_EXHAUSTED`, so an unclassified
 *   quota trip never parks the Automation until the provider's reset — it
 *   keeps firing on schedule against an exhausted quota.
 * - `response-renderer.ts` and `chat-response-bridge.ts` resolve the code to
 *   a remediation CTA; with none, the user gets the provider's raw prose.
 * - An unclassified failure also misses the `PROVIDER_*` Sentry alerting.
 *
 * Adding a failure mode = one pattern here + one entry in `AGENT_ERRORS`.
 *
 * Each branch below matches a shape a provider has actually returned, and the
 * comments name the incident it came from — that is why the patterns are this
 * specific and why they are worth keeping verbatim rather than generalising.
 */

import { AgentErrorCode, PROVIDER_BALANCE_EXHAUSTED } from "./errors.js";
import { getProviderAuthHintFromError } from "./provider-auth-hints.js";

/**
 * Sentinel for a session that exceeded its time budget. The run is retried
 * automatically, so the timeout must NOT surface to the user as a crash —
 * `response-renderer.ts` and `chat-response-bridge.ts` both suppress it.
 */
const SESSION_TIMEOUT_MESSAGE = "SESSION_TIMEOUT";

/**
 * Classify a failure MESSAGE.
 *
 * Separate from `classifyError` because the two live callers hold different
 * shapes: the turn-completion route receives the failure as a string off the
 * wire (`body.error`), while in-process callers hold a thrown value. Routing
 * a string through the `unknown` overload would hit its `instanceof Error`
 * guard and silently classify nothing — the whole defect this restores.
 */
export function classifyErrorMessage(
  message: string
): AgentErrorCode | undefined {
  if (message === SESSION_TIMEOUT_MESSAGE)
    return AgentErrorCode.SESSION_TIMEOUT;

  // The isolate host's own wall-clock kill (`IsolateHost`, "wall-clock budget
  // of <n>ms exceeded"). Deliberately NOT SESSION_TIMEOUT: that code is
  // `silent` because the old lane's queue retried it automatically, and
  // nothing retries this one — a silenced terminal failure leaves the user
  // with no answer and no reason. WORKER_UNRESPONSIVE already carries the
  // accurate, visible "didn't finish responding in time" message.
  if (/wall-clock budget of \d+ms exceeded/.test(message))
    return AgentErrorCode.WORKER_UNRESPONSIVE;

  // Provider usage/rate limit. Covers "429 Weekly/Monthly Limit
  // Exhausted", generic rate-limit/quota phrasings, and a bare 429. Placed
  // before PROVIDER_AUTH because a rate-limited request can also echo auth-ish
  // words; the quota shape is the more specific, more actionable signal.
  // Billing/credit exhaustion belongs to the same actionable class as a quota
  // trip: the key is VALID, the account just can't spend. Anthropic returns it
  // as a 400 `invalid_request_error` ("Your credit balance is too low…"), which
  // carries none of the quota vocabulary below — so without this clause it fell
  // through to `undefined` and surfaced as a raw `💥 Worker crashed: 400 {…}`
  // JSON blob in the user's chat.
  if (PROVIDER_BALANCE_EXHAUSTED.test(message))
    return AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED;

  if (
    /weekly\/monthly limit exhausted|limit exhausted|rate[-\s]?limit|quota (?:exceeded|exhausted)|too many requests|\b429\b|resource_exhausted/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED;

  // Gemini can end a turn with this provider-side tool-call rejection instead
  // of a usable stop reason. Keep the match specific: other finish reasons can
  // describe different failures and must not inherit this remediation text.
  if (
    /^Provider finish_reason:\s*function_call_filter:\s*MALFORMED_FUNCTION_CALL\b/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_TOOL_CALL_FAILED;

  if (
    message.includes("No model configured") ||
    message.includes("No model selected") ||
    // model-resolver.ts throws "No model resolved for this run…" when no
    // default/per-automation/org model is set. Was previously UNCLASSIFIED — it
    // dodged the catalog and surfaced as a raw "💥 Worker crashed" instead of
    // the actionable "connect a provider" guidance.
    message.includes("No model resolved") ||
    message.includes("No provider specified")
  )
    return AgentErrorCode.NO_MODEL_CONFIGURED;
  // Reuse the canonical provider-auth regex (provider-auth-hints.ts) so the
  // classification matches the same auth-failure strings the worker already
  // detects elsewhere.
  if (getProviderAuthHintFromError(message))
    return AgentErrorCode.PROVIDER_AUTH;
  // The gateway secret-proxy 401s with "No provider credentials configured"
  // (code no_credentials) when every credential tier misses. The live red-test
  // (LOBU-BACKEND-W) landed as `unclassified` because the auth-hint regex
  // doesn't cover this shape — and an unclassified event dodges the
  // PROVIDER_* Sentry alert.
  if (
    /no\s+(provider\s+)?credentials\s+configured|no_credentials/i.test(message)
  )
    return AgentErrorCode.PROVIDER_AUTH;
  // The provider accepted the credential but refuses to USE it: Anthropic 403s
  // subscription-OAuth inference for orgs that disallow it
  // (`oauth_not_allowed_for_organization`). None of the wording above matches —
  // there is no "api key" or "authentication failed" — so it surfaced as a raw
  // `Worker crashed: 403 {…}` blob with no CTA. Seen live on Telegram right
  // after connecting Claude by subscription sign-in. The credential is what the
  // user must change, so this is the auth class: "Reconnect provider".
  if (
    /permission_error|oauth[_\s]not[_\s]allowed|not allowed for this organization/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_AUTH;
  // `worker.ts` throws "Model \"<id>\" not found for provider ..." and pi-ai /
  // upstream surface "<x> is not a valid model"/"unknown model"/"model ... not found".
  //
  // The middle run is lazy and bounded rather than `.*`: a greedy `.*` between
  // two literals backtracks polynomially, so a message of repeated "model "
  // took ~1s at 16k repetitions (CodeQL `js/polynomial-redos`). Error text
  // reaches here from an upstream provider, so its length is not ours to
  // trust. Lazy stops at the first " not found" and the bound caps the walk;
  // spaces stay allowed so a quoted multi-word id still classifies.
  if (
    /not a valid model|unknown model|model [^\n]{0,120}? not found/i.test(
      message
    )
  )
    return AgentErrorCode.PROVIDER_UNKNOWN_MODEL;
  // model-resolver.ts / session-runner.ts throw this when a non-OpenAI
  // provider cannot be routed through the Lobu gateway proxy. This is usually a
  // provider/model configuration issue, not an agent crash.
  if (
    /Could not resolve a base URL for provider/i.test(message) ||
    /provider is not connected to this agent/i.test(message) ||
    /did not receive the gateway routing URL/i.test(message)
  )
    return AgentErrorCode.PROVIDER_BASE_URL_UNRESOLVED;
  return undefined;
}

/**
 * Classify a thrown value, for callers that hold one. Non-`Error` values are
 * unclassified by design: a bare string thrown from unknown provenance is not
 * evidence of a provider failure mode.
 */
export function classifyError(error: unknown): AgentErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  return classifyErrorMessage(error.message);
}
