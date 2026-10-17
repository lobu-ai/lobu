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
 * `PGPASSWORD`, `clientsecret`, `customapikey`. Matched as a bare ending
 * (case-insensitive, separator-free) so `tokenizer` and `keyboard` stay
 * readable. `token` is deliberately absent: bare token endings collide with
 * usage counts (`token_count`-style keys stay preserved per the logger
 * contract), while password/secret/apikey endings have no benign reading.
 */
const BARE_CREDENTIAL_SUFFIXES = ["password", "passwd", "secret", "apikey"];

function hasConcatenatedCredentialSuffix(key: string): boolean {
  const flat = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return BARE_CREDENTIAL_SUFFIXES.some(
    (suffix) => flat.length > suffix.length && flat.endsWith(suffix)
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
 * A TRAILING `authorization` segment is a (possibly vendor-prefixed)
 * authorization header (`x-authorization`, `xAuthorization`). Headers are
 * scalar-or-list carriers, never credential maps, so this classifies as a
 * strong secret key regardless of value type.
 */
function hasTrailingAuthorizationSegment(key: string): boolean {
  const segments = splitKeySegments(key);
  return (
    segments.length > 0 && segments[segments.length - 1] === "authorization"
  );
}

/**
 * A `credential`/`credentials` segment anywhere in the key names a
 * credential CONTAINER (`credentials_json`, `credentialsJson`,
 * `oauthCredentialsJson`, `credentialsByName`). Container semantics live in
 * the walk: a scalar beneath one IS the serialized credential and collapses,
 * while a structured value beneath one recurses with every descendant
 * treated as credential-adjacent (a map's leaves cannot be trusted by key
 * name alone — `credentialsByName.github` proves it).
 */
function hasCredentialSegment(key: string): boolean {
  return splitKeySegments(key).some(
    (segment) => segment === "credential" || segment === "credentials"
  );
}

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
  if (isSecretKey(key)) return true;
  if (isSecretKey(squashKey(key))) return true;
  if (SECRET_KEY_EXACT.has(squashKey(key))) return true;
  if (hasTrailingAuthorizationSegment(key)) return true;
  if (hasConcatenatedCredentialSuffix(key)) return true;
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
      const serialized: Record<string, unknown> = {
        name: current.name,
        message: scrubString(current.message),
      };
      if (current.stack) serialized.stack = scrubString(current.stack);
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
        // A strong-secret key collapses wholesale; its readable name is kept
        // while any query pair embedded in the key text itself is redacted
        // (value-side redaction never reaches key text).
        const outKey = scrubKey(key);
        if (isStrongSecretKey(key)) {
          serialized[outKey] = "[REDACTED]";
          continue;
        }
        // A credential container propagates credential-adjacency to its whole
        // subtree: scalars beneath one collapse, structured values recurse.
        const childContainer =
          underCredentialContainer || hasCredentialSegment(key);
        const value = (current as unknown as Record<string, unknown>)[key];
        serialized[outKey] = scrub(value, depth + 1, childContainer);
      }
      return serialized;
    }

    // Built-ins whose state is not enumerable: walking them as plain objects
    // yields `{}` (Date, Map, Set, RegExp) or one key per byte (Buffer). A
    // readable summary costs less payload and tells triage strictly more.
    if (current instanceof Date) return current.toISOString();
    if (current instanceof RegExp) return String(current);
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
        // A strong-secret key collapses wholesale; its readable name is kept
        // while any query pair embedded in the key text itself is redacted.
        const outKey = scrubKey(key);
        if (isStrongSecretKey(key)) {
          result[outKey] = "[REDACTED]";
          continue;
        }
        // A credential container propagates credential-adjacency to its whole
        // subtree (scalars collapse, structured values recurse); anything
        // else scrubs normally. A URL or `name=value` diagnostic used as a
        // key carries its secret in the key text, past value-side redaction.
        const childContainer =
          underCredentialContainer || hasCredentialSegment(key);
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
