import { isSecretKey, redactUriCredentials } from "./secret-redaction";

/**
 * Secret as a QUERY PARAMETER name, and only there. `code` is an OAuth
 * authorization code in `?code=…` but a Node/Postgres error code
 * (`ECONNREFUSED`, `23505`) as an object key; `state` and `key` are the same
 * story. Context decides, so this stays separate from the shared key denylist
 * rather than widening it — redacting these as object keys would blank the
 * fields triage actually reads.
 */
const SECRET_QUERY_PARAMS = new Set(["state", "code", "key"]);
/**
 * Credential key names the shared config denylist has no reason to carry:
 * request signatures reach telemetry (webhook headers, presigned URLs) but
 * never appear in connector config, and that denylist also feeds the CLI's
 * deployment manifest hash — widening it there would change hashes.
 */
const SECRET_KEY_SEGMENTS = new Set(["signature", "sig"]);
/**
 * Whole (squashed) key names the shared denylist does not classify. Carried
 * over from the bespoke sanitizer this module replaced: `verifier` and `state`
 * are far too broad as segments (`freshness_state`, `run_state`), so these two
 * are matched only as complete names. `authorizationheader` is the same story:
 * HTTP client options carry it camel-cased (`authorizationHeader`), which the
 * shared suffix denylist never sees, while `authorization` alone as a segment
 * would sweep up `authorization_mode` and `authorization_policy`.
 * `authorizationcode` is the OAuth code in any casing or separator style.
 */
const SECRET_KEY_EXACT = new Set([
  "codeverifier",
  "sessionstate",
  "authorizationheader",
  "authorizationcode",
]);

/**
 * Concatenated credential names the separator-based rules never see:
 * `PGPASSWORD`, `clientsecret`, `customapikey`, `myauthtoken` (the shared
 * denylist has no `auth_?token` form), `idtoken`, and any other bare
 * `*token` compound (`csrftoken`, `githubtoken`). Matched as a bare ending
 * (case-insensitive, separator-free) so `tokenizer` and `keyboard` stay
 * readable. Bare `token_count`-style usage keys stay readable because the
 * benign-usage exemption runs before every classification below.
 */
const BARE_CREDENTIAL_SUFFIXES = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "token",
  "authtoken",
  "idtoken",
];

function hasBareCredentialSuffix(key: string, allowEqual = false): boolean {
  const flat = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return BARE_CREDENTIAL_SUFFIXES.some(
    (suffix) =>
      flat.endsWith(suffix) && (allowEqual || flat.length > suffix.length)
  );
}

/**
 * Split-form credential names the whole/suffix rules miss. Case boundaries
 * are split before lowercasing (mirroring `normalizeKey` in secret-redaction,
 * including its acronym run), so camelCase compounds pin correctly.
 * Separator-less all-lowercase compounds fall through to the bare-suffix
 * rule above.
 */
function splitKeySegments(key: string): string[] {
  return key
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .split("_")
    .filter((segment) => segment.length > 0);
}

/**
 * An `authorization` segment anywhere near the front names a header or an
 * auth credential (`x-authorization`, `requestAuthorizationValue`,
 * `proxy_authorization_value`, `authorizationJson`): trailing (after an
 * optional `header`/`headers`) it is a header and collapses; followed by
 * anything but pure config qualifiers it is a credential container;
 * followed only by config qualifiers (`authorization_mode`,
 * `authorization_policy`) it stays readable.
 *
 * A leading credential run names a credential CONTAINER
 * (`credentials_json`, `credentialsByName`, `password_confirmation`,
 * `secret_value`, `oauthCredentialsJson`, `token_value`,
 * `accessTokenValue`, `api_key_value`, `authtoken`, `csrftoken`,
 * `githubtoken`, `clientsecretvalue`). The head must classify under the
 * shared suffix rules, read as a suffix term, or end with a bare credential
 * term the shared rules miss — a whole-name exact match never seeds one
 * (`cookie`, `authorization`, `auth`, `bearer`), so `cookie-policy` stays
 * readable. A two-segment usage metric (`token_count`, `token_total`,
 * `max_tokens`, `totalTokens`) is exempt everywhere: usage metadata stays
 * readable per the logger contract. Only the leading run (bounded below)
 * is scanned, so pathological keys stay linear. Container semantics live in
 * the walk: a scalar beneath one IS the serialized credential and collapses,
 * while a structured value beneath one recurses with every descendant
 * treated as credential-adjacent (a map's leaves cannot be trusted by key
 * name alone — `credentialsByName.github` proves it).
 */

/** Qualifiers that mark a key as usage metadata, never a credential. */
const BENIGN_COUNT_QUALIFIERS = new Set([
  "count",
  "counts",
  "total",
  "totals",
  "used",
  "usage",
  "remaining",
  "limit",
  "limits",
  "max",
  "quota",
  "quotas",
]);

/** Config qualifiers that keep an `authorization` key readable. */
const AUTH_CONFIG_QUALIFIERS = new Set(["mode", "modes", "policy", "policies"]);

/**
 * Whether a key segment run reads as a credential SUFFIX term rather than
 * merely a whole name: `x_token` still classifies, so `token` seeds
 * compounds, while `x_cookie`, `x_auth` and `x_bearer` have no credential
 * reading, so those whole names never seed one.
 */
function isSuffixTerm(head: string): boolean {
  return isSecretKey(`x_${head}`) || isSecretKey(squashKey(`x_${head}`));
}

/**
 * Whether a head classifies solely as a whole name (the shared exact set:
 * `cookie`, `authorization`, `auth`, `bearer`) rather than as a suffix term
 * or bare compound. Whole-name heads never seed a compound.
 */
function isWholeNameOnly(head: string): boolean {
  const whole = isSecretKey(head) || isSecretKey(squashKey(head));
  if (!whole) return false;
  return !isSuffixTerm(head) && !hasBareCredentialSuffix(head, true);
}

/** Two-segment usage metrics (`token_count`, `max_tokens`, `totalTokens`). */
function isBenignUsageKey(key: string): boolean {
  const segments = splitKeySegments(key);
  if (segments.length !== 2) return false;
  const [first, second] = segments as [string, string];
  const isTokenWord = (segment: string) =>
    segment === "token" || segment === "tokens";
  return (
    (isTokenWord(first) && BENIGN_COUNT_QUALIFIERS.has(second)) ||
    (BENIGN_COUNT_QUALIFIERS.has(first) && isTokenWord(second))
  );
}

/** Longest credential-name prefix worth testing; real compounds are short. */
const MAX_CREDENTIAL_PREFIX_PARTS = 8;

function classifyAuthorization(key: string): "strong" | "container" | null {
  const segments = splitKeySegments(key);
  const limit = Math.min(segments.length, MAX_CREDENTIAL_PREFIX_PARTS);
  for (let index = 0; index < limit; index++) {
    if (segments[index] !== "authorization") continue;
    const tail = segments
      .slice(index + 1)
      .filter((segment) => segment !== "header" && segment !== "headers");
    if (tail.length === 0) return "strong";
    if (tail.every((segment) => AUTH_CONFIG_QUALIFIERS.has(segment))) continue;
    return "container";
  }
  return null;
}

function hasCredentialSegment(key: string): boolean {
  if (isBenignUsageKey(key)) return false;
  if (classifyAuthorization(key) === "container") return true;
  const segments = splitKeySegments(key);
  // Bounded lookahead: real credential compounds are short
  // (`access_token`, `oauth_credentials`); scanning an unbounded prefix run
  // turns a pathological key into quadratic work.
  const end = Math.min(segments.length, MAX_CREDENTIAL_PREFIX_PARTS);
  for (let length = 1; length <= end; length++) {
    const head = segments.slice(0, length).join("_");
    if (isWholeNameOnly(head)) continue;
    const qualifies =
      isSecretKey(head) ||
      isSecretKey(squashKey(head)) ||
      hasBareCredentialSuffix(head, true);
    if (!qualifies) continue;
    return true;
  }
  // Separator-free compounds with the credential term in the middle
  // (`clientsecretvalue`): the shared rules and split segment tests never
  // see them. `token` and bare `key` stay out here — `tokenizer`,
  // `keyboard` and usage counters stay readable.
  const flat = squashKey(key);
  return SUBSTRING_CREDENTIALS.some((term) => flat.includes(term));
}

/** Credential terms matched as substrings of separator-free compounds. */
const SUBSTRING_CREDENTIALS = [
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "apikey",
];

/** Bound recursive work on diagnostic values. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1000;

/** Separator/case-squashed form, for keys core's camel-case split can't read. */
function squashKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Object and header keys. Core's normalizer splits on case boundaries, so an
 * arbitrarily-cased header (`CoOkIe`) normalizes to `co_ok_ie` and misses;
 * test the squashed form too.
 */
function isSecretObjectKey(key: string): boolean {
  if (isBenignUsageKey(key)) return false;
  return isStrongSecretKey(key) || hasCredentialSegment(key);
}

/**
 * The collapsing half of key classification: a key whose NAME alone proves
 * the value is a credential, so the whole value is replaced without
 * inspection. Credential CONTAINERS (`hasCredentialSegment`) are deliberately
 * excluded — their collapse rule depends on the value type (see the walk),
 * and collapsing a map parent would destroy surviving key names the Loki
 * connector pre-redacted.
 */
function isStrongSecretKey(key: string): boolean {
  if (isBenignUsageKey(key)) return false;
  if (isSecretKey(key)) return true;
  if (isSecretKey(squashKey(key))) return true;
  if (SECRET_KEY_EXACT.has(squashKey(key))) return true;
  if (classifyAuthorization(key) === "strong") return true;
  if (hasBareCredentialSuffix(key)) return true;
  // Matched per separated segment, not against the squashed whole:
  // `X-Hub-Signature-256` squashes to `xhubsignature256`, which no exact set
  // can ever hold, so every real signature header would slip through.
  // Segment-matched signature headers collapse like any other proven key.
  return key
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .split("_")
    .some((segment) => SECRET_KEY_SEGMENTS.has(segment));
}
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
/**
 * A relative URL (`/api/v1/files/a?token=…`) and a raw
 * `request.query_string` (`token=…`, no scheme and no path) never match
 * URL_PATTERN, so the signed-download token would survive a URL-only scrub.
 * The separator absorbs trailing whitespace because cookie serialization is
 * `a=b; c=d`: without it every pair after the first space goes unredacted.
 */
const QUERY_PAIR_PATTERN =
  /([?&;]\s*|^)([A-Za-z0-9_.\-%[\]]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&;\s"'<>]*)/g;

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isSecretQueryParam(name: string): boolean {
  const key = decodeKey(name);
  return isSecretObjectKey(key) || SECRET_QUERY_PARAMS.has(squashKey(key));
}

/**
 * Object keys are data too: attribution and cache maps keyed by URL or raw
 * `name=value` diagnostics carry credentials in the KEY text, where
 * value-side redaction never reaches. Redact the secret portion while keeping
 * the key identifiable. Clean keys (the common case) return untouched; two
 * distinct keys that scrub identically collapse, last wins.
 */
function scrubKey(key: string): string {
  if (
    !key.includes("?") &&
    !key.includes(";") &&
    !key.includes("=") &&
    !key.includes("://")
  ) {
    return key;
  }
  return scrubString(key);
}

function scrubString(value: string): string {
  // `postgres://user:pa55@host/db` carries its credential in the userinfo, not
  // in a query pair or a secret-named key, so neither pass below would see it.
  const withoutUriCredentials = redactUriCredentials(value);
  // Scrub quoted query values before URL matching stops at their opening quote
  // and removes the key that identifies the remaining text as a credential.
  const withoutQueries = withoutUriCredentials.replace(
    QUERY_PAIR_PATTERN,
    (match, lead: string, name: string, raw: string) =>
      isSecretQueryParam(name)
        ? `${lead}${name}=[REDACTED]${raw.match(/[),.;]+$/)?.[0] ?? ""}`
        : match
  );
  const withoutUrlQueries = withoutQueries.replace(URL_PATTERN, (candidate) => {
    // Trailing sentence punctuation is not part of the URL, but it is part of
    // the message: strip it to parse, then put it back.
    const trailing = candidate.match(/[),.;]+$/)?.[0] ?? "";
    const bare = trailing ? candidate.slice(0, -trailing.length) : candidate;
    try {
      const url = new URL(bare);
      return `${url.origin}${url.pathname}${trailing}`;
    } catch {
      return candidate;
    }
  });
  // Error messages can embed key=value diagnostics outside a URL. Keep codes
  // and states useful there; only credential-named assignments are sensitive.
  return withoutUrlQueries.replace(
    /(\s)([A-Za-z0-9_.%-]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&;\s"'<>]*)/g,
    (match, lead: string, name: string) =>
      isSecretObjectKey(decodeKey(name)) ? `${lead}${name}=[REDACTED]` : match
  );
}

/**
 * Recursively remove credential material from diagnostic values.
 * This is deliberately defensive: telemetry must never make an unusual
 * application value or a circular error object throw another error.
 */
export function scrubDiagnosticValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function scrub(
    current: unknown,
    depth = 0,
    underCredentialContainer = false
  ): unknown {
    if (typeof current === "string")
      return underCredentialContainer ? "[REDACTED]" : scrubString(current);
    // A copied toJSON hook could reintroduce secrets after this walk finishes.
    if (typeof current === "function") return "[Function]";
    if (current === null || typeof current !== "object")
      return underCredentialContainer ? "[REDACTED]" : current;
    if (seen.has(current)) return "[CIRCULAR]";
    // Bound deeply nested values before cloning them on the logging hot path.
    if (depth >= MAX_DEPTH) return "[TRUNCATED]";
    // Tracks the current PATH, not every node ever visited. Two siblings may
    // legitimately hold the same reference, and reporting the second one as
    // [CIRCULAR] would corrupt the event; only an ancestor is a real cycle.
    seen.add(current);
    try {
      return walk(current, depth, underCredentialContainer);
    } finally {
      seen.delete(current);
    }
  }

  function walk(
    current: object,
    depth: number,
    underCredentialContainer: boolean
  ): unknown {
    // An Error carries name/message/stack on its prototype, so Object.keys
    // returns nothing and a plain walk would flatten it to `{}` — discarding
    // the only part of the event worth reading.
    if (current instanceof Error) {
      // message/stack are scrubbed as text; under a credential container
      // they ARE the credential and collapse instead. The name always gets
      // text scrubbing but stays readable: a custom (even non-enumerable)
      // name can carry `password=...`, which key-based redaction never sees,
      // while the error class itself is triage payload.
      const serialized: Record<string, unknown> = {
        name: scrubString(String(current.name ?? "")),
        message: underCredentialContainer
          ? "[REDACTED]"
          : scrubString(current.message),
      };
      if (current.stack)
        serialized.stack = underCredentialContainer
          ? "[REDACTED]"
          : scrubString(current.stack);
      if (current.cause !== undefined)
        serialized.cause = scrub(
          current.cause,
          depth + 1,
          underCredentialContainer
        );
      // AggregateError.errors is non-enumerable, just like cause and stack.
      // Reuse the same walk so nested failures keep their codes without
      // bypassing credential redaction, depth limits, or cycle detection.
      if ("errors" in current && Array.isArray(current.errors))
        serialized.errors = scrub(
          current.errors,
          depth + 1,
          underCredentialContainer
        );
      for (const key of Object.keys(current)) {
        const outKey = scrubKey(key);
        if (isStrongSecretKey(key)) {
          serialized[outKey] = "[REDACTED]";
          continue;
        }
        // Container adjacency propagates: scalars beneath one collapse,
        // structured values recurse with the flag set. Usage-metric keys
        // never start adjacency themselves (an inherited flag still applies).
        const childContainer =
          underCredentialContainer ||
          (!isBenignUsageKey(key) && hasCredentialSegment(key));
        const value = (current as unknown as Record<string, unknown>)[key];
        serialized[outKey] = scrub(value, depth + 1, childContainer);
      }
      return serialized;
    }

    // Built-ins whose state is not enumerable: walking them as plain objects
    // yields `{}` (Date, Map, Set, RegExp) or one key per byte (Buffer). A
    // readable summary costs less payload and tells triage strictly more.
    // A RegExp source can itself embed a credential (`/password=.../`),
    // so it takes the same string scrubbing as any other message text.
    if (current instanceof Date) return current.toISOString();
    if (current instanceof RegExp)
      return underCredentialContainer
        ? "[REDACTED]"
        : scrubString(String(current));
    if (ArrayBuffer.isView(current)) {
      return `[${current.constructor.name} ${current.byteLength} bytes]`;
    }
    if (current instanceof Map) return `[Map ${current.size} entries]`;
    if (current instanceof Set) return `[Set ${current.size} items]`;

    if (Array.isArray(current)) {
      return current
        .slice(0, MAX_ENTRIES)
        .map((item) => scrub(item, depth + 1, underCredentialContainer));
    }

    const result: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(current).slice(0, MAX_ENTRIES)) {
        const outKey = scrubKey(key);
        if (isStrongSecretKey(key)) {
          result[outKey] = "[REDACTED]";
          continue;
        }
        const childContainer =
          underCredentialContainer ||
          (!isBenignUsageKey(key) && hasCredentialSegment(key));
        try {
          result[outKey] = scrub(
            (current as Record<string, unknown>)[key],
            depth + 1,
            childContainer
          );
        } catch {
          result[outKey] = "[UNREADABLE]";
        }
      }
    } catch {
      return "[UNREADABLE]";
    }
    return result;
  }

  return scrub(value);
}
