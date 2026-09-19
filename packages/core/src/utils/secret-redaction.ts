/**
 * Shared secret redaction for config audit + serialization surfaces.
 *
 * One denylist shared across TypeScript config exposures:
 *  - the server redacts config-change audit snapshots before persisting them
 *    (`packages/server/src/utils/config-redaction.ts`),
 *  - the server redacts `connections.config` before it is serialized to any
 *    caller (`packages/server/src/utils/connection-config-redaction.ts`), and
 *  - the CLI strips secret values out of the desired state before hashing it
 *    into a deployment's `manifest_hash` (`_lib/apply/deployment.ts`), while
 *    setup continuations use the same classification when omitting credentials.
 *
 * A key classified here is therefore omitted or redacted consistently across
 * persistence, API responses, setup continuations, and deployment hashes.
 */

/**
 * Placeholder written in place of a redacted value (never dropped): the
 * future `lobu apply --from-revision` fold uses it to know which paths the
 * CLI must re-resolve from the local environment.
 */
export const REDACTED_SENTINEL = "__LOBU_REDACTED__";

/**
 * Key-name denylist. After camel-case and separator normalization, matches the
 * whole key or an `_`-separated suffix, singular or plural, any case: `token`,
 * `apiKey`, `X-Api-Key`, `refresh_tokens`, `clientSecret`, ...
 *
 * Anchoring on a `_`-separated SUFFIX (not a substring) is deliberate: it is
 * what keeps `tokenizer`, `keyboard`, and `secretsPolicy` out of the denylist.
 * Add a term here only if its suffix form is unambiguously a credential.
 *
 * `authorization` / `cookie` / `session_id` / `*_url`-style connection strings
 * are NOT key-suffix matches on their own — they are covered below by
 * {@link isSecretKey}'s exact-name set and by {@link redactUriCredentials}.
 */
const SECRET_KEY_RE =
  /(^|_)(token|secret|password|passwd|api_?key|secret_?(?:access_?)?key|credential|private_?key|refresh_?token|access_?token|client_?secret|session_?id|auth_?header)s?$/i;

/**
 * Exact key names (case-insensitive, after key normalization) that are
 * credentials but do not end in a denylisted suffix. Kept separate from the
 * suffix regex so a future `cookie_policy` or `authorization_mode` key isn't
 * swept up by accident.
 */
const SECRET_EXACT_KEYS = new Set([
  "authorization",
  "auth",
  "bearer",
  "cookie",
  "cookies",
  "set_cookie",
  "proxy_authorization",
  "database_url",
  "db_url",
  "connection_string",
  "dsn",
  // Fully capitalized acronym runs have no case boundary for `normalizeKey`
  // to split, so they need explicit entries.
  "dburl",
  "databaseurl",
  "connectionstring",
]);

/** Normalize camelCase and separators so config keys and HTTP headers agree. */
function normalizeKey(key: string): string {
  return (
    key
      // Split an acronym run from a following word ("APIKey" -> "API_Key").
      // A fixed-width lookahead (never a greedy `[A-Z]+` that overlaps the next
      // `[A-Z]`) keeps this linear: a long uppercase run like "AAAA..." can't
      // trigger quadratic backtracking (CodeQL polynomial-ReDoS).
      .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1_")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
  );
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_EXACT_KEYS.has(normalized) || SECRET_KEY_RE.test(normalized);
}

/**
 * `scheme://user:password@host/...` — the credential lives in the userinfo
 * component, so the value is secret even when the KEY name is innocuous
 * (`host`, `endpoint`, `primary`). Only the userinfo is replaced: the scheme
 * and host stay readable so a UI can still show which database is wired up.
 */
// The scheme repetition is bounded ({0,63}, i.e. schemes up to 64 chars — far
// longer than any real URI scheme) rather than `*`: an unbounded quantifier
// re-scans at every start offset on adversarial input (e.g. a long run of 'a's
// with no `://`), which is a polynomial-ReDoS shape. A constant bound keeps the
// per-offset work constant, so matching stays linear on untrusted config values.
const URI_CREDENTIAL_RE = /([a-z][a-z0-9+.-]{0,63}:\/\/)([^/\s@]+)@/gi;

/**
 * Replace the `user:password@` userinfo of any URI inside a string with the
 * sentinel. Non-string input and strings with no credential-bearing URI pass
 * through unchanged (identity), so this is safe to apply to every string.
 */
export function redactUriCredentials(value: string): string {
  return value.replace(
    URI_CREDENTIAL_RE,
    (match, scheme: string, userinfo: string) =>
      // A bare `host@` with no `:password` is not a credential (e.g. an email-ish
      // path segment); only redact when a password component is present.
      userinfo.includes(":") ? `${scheme}${REDACTED_SENTINEL}@` : match
  );
}

/**
 * Deep-walk a JSON-ish value, replacing every non-null value under a
 * denylisted key with REDACTED_SENTINEL. Arrays and nested objects are
 * walked; string primitives additionally have any embedded URI credential
 * stripped, so a `postgres://u:pw@host/db` never survives under a
 * non-denylisted key.
 */
export function deepRedactSecrets(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(deepRedactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        isSecretKey(key) && v != null
          ? REDACTED_SENTINEL
          : deepRedactSecrets(v);
    }
    return out;
  }
  if (typeof value === "string") return redactUriCredentials(value);
  return value;
}
