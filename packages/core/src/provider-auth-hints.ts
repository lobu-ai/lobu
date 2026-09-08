/**
 * Provider auth-failure detection, shared by everything that has to turn a
 * provider's own error prose into a user-facing remediation.
 *
 * Lives in core for the same reason `PROVIDER_BALANCE_EXHAUSTED` does: the
 * classifier that consumes it and the schedule/render paths that act on its
 * result are in different packages, and they must agree on the wording. The
 * regexes are deliberately narrow — each alternate matches a shape a real
 * provider has returned — because a false positive here mislabels an
 * unrelated failure as an auth problem and sends the user to reconnect a
 * credential that was never broken.
 */

const PROVIDER_API_KEY_ENV_VARS: Record<string, string> = {
  "openai-codex": "OPENAI_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

function sanitizeProviderToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function getApiKeyEnvVarForProvider(providerName: string): string {
  const normalizedProvider = providerName.trim().toLowerCase();
  const mapped = PROVIDER_API_KEY_ENV_VARS[normalizedProvider];
  if (mapped) {
    return mapped;
  }

  const sanitized = sanitizeProviderToken(providerName);
  if (!sanitized || sanitized === "provider") {
    return "API_KEY";
  }

  return `${sanitized.toUpperCase()}_API_KEY`;
}

export function getProviderAuthHintFromError(
  errorMessage: string,
  defaultProvider?: string
): { providerName: string; envVar: string } | null {
  const needsAuthSetup =
    /No API key found|Authentication failed|invalid x-api-key|invalid api[-\s]?key|authentication_error|incorrect api key/i.test(
      errorMessage
    );
  if (!needsAuthSetup) {
    return null;
  }

  // Prefer the caller-supplied canonical provider name (e.g. gateway slug)
  // over a name extracted from the error string, because upstream
  // libraries may use internal aliases.
  // Fall back to regex extraction only when the caller has no context.
  const fallbackProvider = defaultProvider?.trim().toLowerCase() || undefined;
  const explicitProviderMatch = errorMessage.match(
    /(?:No API key found for|Authentication failed for)\s+"?([A-Za-z0-9_-]+)/i
  );
  const jsonProviderMatch = errorMessage.match(
    /"provider"\s*:\s*"([A-Za-z0-9._-]+)"/i
  );
  const providerName =
    (fallbackProvider && fallbackProvider !== "undefined"
      ? fallbackProvider
      : undefined) ||
    explicitProviderMatch?.[1]?.toLowerCase() ||
    jsonProviderMatch?.[1]?.toLowerCase() ||
    "provider";

  return {
    providerName,
    envVar: getApiKeyEnvVarForProvider(providerName),
  };
}
