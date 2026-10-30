/**
 * Redact secrets from connector output before it leaves the worker.
 *
 * Patterns are deliberately broad — false positives are preferred to leaking a
 * real credential into the runs table. Add new patterns here when a connector
 * surfaces a new sensitive shape.
 */

const REDACTED = '[REDACTED]';

// Keep this module dependency-free: it is also bundled into connector isolates.
// Match credential suffixes even in concatenated names such as PGPASSWORD.
// The token scanner bounds the work; requiring a prefix delimiter loses secrets.
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret(?:[_-]access)?[_-]?key|private[_-]?key|token|secret|password|passwd|credentials?|authorization|auth|bearer|cookies?|set[_-]cookie|session[_-]?id)s?$/i;

export function isSecretOutputKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_KEY.test(key) || SECRET_KEY.test(normalized) ||
    (key.toUpperCase().includes('AWS_') && /(?:KEY|TOKEN|SECRET)$/i.test(key));
}

function quotedValueEnd(text: string, start: number, delimiter: string): number {
  const quote = delimiter.at(-1);
  const escapes = delimiter.length - 1;
  // A quote closes embedded JSON only at the opening delimiter's escaping layer.
  let end = start;
  while (end < text.length) {
    const runStart = end;
    while (text[end] === '\\') end++;
    if (text[end] === quote && (end - runStart) % (2 * (escapes + 1)) === escapes) {
      return end - escapes;
    }
    if (end < text.length) end++;
  }
  return end;
}

// Consume whole key tokens once, then scan only explicitly assigned secret values.
// A length threshold misses short passwords; unbounded key-search regexes can
// repeatedly rescan long malformed log lines.
function redactAssignments(text: string): string {
  const keys = /[\w.-]+/g;
  const assignment = /(\\*["'])?\s*[:=]\s*(\\*["'])?/y;
  const authScheme = /(?:Bearer|Basic)\s+/iy;
  const parts: string[] = [];
  let copied = 0;
  let key: RegExpExecArray | null;
  while ((key = keys.exec(text))) {
    if (!isSecretOutputKey(key[0])) continue;
    assignment.lastIndex = keys.lastIndex;
    const separator = assignment.exec(text);
    if (!separator) continue;
    const start = assignment.lastIndex;
    const delimiter = separator[2];
    let end = start;
    let replacement = REDACTED;
    if (!delimiter && text.startsWith(REDACTED, start)) {
      keys.lastIndex = start + REDACTED.length;
      continue;
    }
    if (delimiter) {
      end = quotedValueEnd(text, start, delimiter);
    } else if (text[start] === '{' || text[start] === '[') {
      // Secret containers hide every descendant, even those with ordinary keys.
      let depth = 0;
      do {
        const quoteStart = end;
        while (text[end] === '\\') end++;
        if (text[end] === '"' || text[end] === "'") {
          const quote = text.slice(quoteStart, end + 1);
          end = quotedValueEnd(text, end + 1, quote) + quote.length;
          continue;
        }
        if (text[end] === '{' || text[end] === '[') depth++;
        if (text[end] === '}' || text[end] === ']') depth--;
        end++;
      } while (depth > 0 && end < text.length);
      const quote = separator[1] ?? '"';
      replacement = `${quote}${REDACTED}${quote}`;
    } else {
      // An unquoted authentication value includes its scheme and credential.
      // Removing only the scheme would hide it from later token redaction.
      authScheme.lastIndex = start;
      if (authScheme.test(text)) end = authScheme.lastIndex;
      while (end < text.length && !/[\s,;&}\]"']/.test(text[end])) end++;
    }
    if (end > start) {
      parts.push(text.slice(copied, start), replacement);
      copied = end;
    }
    keys.lastIndex = end;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // HTTP Authorization header (e.g. "Authorization: Bearer abc...") — match
  // the rest of the line so multi-token schemes like "Bearer xxx" get caught.
  { regex: /Authorization:[^\r\n]+/gi, replacement: `Authorization: ${REDACTED}` },

  // Cookie / Set-Cookie header — same line-eating shape.
  { regex: /(Set-)?Cookie:[^\r\n]+/gi, replacement: `$1Cookie: ${REDACTED}` },

  // Bearer tokens anywhere (URL-safe-base64 style values)
  { regex: /Bearer\s+[\w\-.~+/=]+/gi, replacement: `Bearer ${REDACTED}` },

  // JWT shape (eyJ...header.payload.sig)
  { regex: /eyJ[\w\-]+\.[\w\-]+\.[\w\-]+/g, replacement: REDACTED },

  // Google OAuth access token shape (ya29.<varies>) — high-confidence.
  { regex: /ya29\.[\w\-.]{20,}/g, replacement: REDACTED },
  // Bound the scheme search so a long non-URI token is not rescanned at every
  // character. Retain the scheme, username and host for diagnostics.
  {
    regex: /([a-z][a-z0-9+.-]{0,63}:\/\/[^:/\s]+):([^@/\s]+)@/gi,
    replacement: `$1:${REDACTED}@`,
  },
];

export function redactOutput(text: string): string {
  if (!text) return text;
  let result = redactAssignments(text);
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}
