import { AgentErrorCode } from "@lobu/core";

/**
 * Map an upstream inference HTTP status to a provider-health verdict.
 *
 * Status-only, deliberately. The alternative — matching the provider's prose —
 * needs a new alternate per vendor per phrasing and fails silently when it
 * misses: OpenAI's "You have no credits remaining" and Alibaba's "quota has
 * been exhausted" both went unclassified in prod despite a pattern list built
 * for exactly that purpose. `429` means the same thing from every vendor.
 *
 * The mapping is intentionally narrow. Only statuses that indicate the
 * CREDENTIAL or the ACCOUNT is at fault mark a provider unhealthy — a 400 (bad
 * request) or 404 (unknown model) is the caller's fault and says nothing about
 * provider health. The row drives the settings UI and, via
 * `resolveDispatchModel`, a routing PREFERENCE for a healthy sibling (see
 * `markInferenceProviderUnhealthy`): a false positive would label a healthy
 * provider broken and could move a turn onto another model the agent already
 * lists, but can never strand it. `undefined` means "this status carries no
 * health signal", which is distinct from healthy.
 *
 * Lives in its own module so it can be unit-tested without dragging in the
 * proxy's database and secret-store dependencies.
 */
export function classifyProviderHealthStatus(
  status: number
): AgentErrorCode | undefined {
  if (status === 429 || status === 402)
    return AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED;
  if (status === 401 || status === 403) return AgentErrorCode.PROVIDER_AUTH;
  return undefined;
}

/** Temporary upstream failures explain a failed turn without blaming its credentials. */
export function classifyProviderAvailabilityStatus(
  status: number
): AgentErrorCode | undefined {
  if (status === 502 || status === 503 || status === 504) {
    return AgentErrorCode.PROVIDER_UNAVAILABLE;
  }
  return undefined;
}
