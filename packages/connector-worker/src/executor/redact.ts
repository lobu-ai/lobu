/**
 * Redact secrets from connector output before it leaves the worker.
 *
 * Patterns are deliberately broad — false positives are preferred to leaking a
 * real credential into the runs table. Add new patterns here when a connector
 * surfaces a new sensitive shape.
 */

const REDACTED = '[REDACTED]';

// Keep this module dependency-free: it is also bundled into connector isolates.
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret(?:[_-]access)?[_-]?key|private[_-]?key|token|secret|password|passwd|credentials?|authorization|auth|bearer|cookies?|set[_-]cookie|session[_-]?id)s?$/i;

// Consume whole key tokens once, then scan only explicitly assigned secret values.
// A length threshold misses short passwords; unbounded key-search regexes can
// repeatedly rescan long malformed log lines.
function redactAssignments(text: string): string {
  const keys = /[\w.-]+/g;
  const assignment = /(?:\\*["'])?\s*[:=]\s*(\\*["'])?/y;
  const parts: string[] = [];
  let copied = 0;
  let key: RegExpExecArray | null;
  while ((key = keys.exec(text))) {
    const normalized = key[0].replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    if (
      !SECRET_KEY.test(normalized) &&
      !/^AWS_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)$/.test(key[0])
    ) continue;
    assignment.lastIndex = keys.lastIndex;
    const separator = assignment.exec(text);
    if (!separator) continue;
    const start = assignment.lastIndex;
    const delimiter = separator[1];
    let end = start;
    if (delimiter) {
      const quote = delimiter.at(-1);
      const escapes = delimiter.length - 1;
      // JSON embedded in a log may have one or more escaping layers. A quote
      // closes this value only at the same layer as its opening delimiter.
      while (end < text.length) {
        const runStart = end;
        while (text[end] === '\\') end++;
        const slashes = end - runStart;
        if (text[end] === quote && slashes % (2 * (escapes + 1)) === escapes) {
          end -= escapes;
          break;
        }
        if (end < text.length) end++;
      }
    } else {
      if (text.startsWith(REDACTED, start)) {
        keys.lastIndex = start + REDACTED.length;
        continue;
      }
      while (end < text.length && !/[\s,;&}\]"']/.test(text[end])) end++;
    }
    if (end > start) {
      parts.push(text.slice(copied, start), REDACTED);
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

/**
 * Streaming redactor for live tee to parent stdout/stderr. Buffers up to the
 * last newline so that secrets split across stream chunk boundaries — for
 * example "Authorization: Bear" + "er abc..." in two `data` events — still
 * get matched by `redactOutput()`. The persisted `output_tail` already runs
 * `redactOutput()` over the full ring-buffer string and is unaffected; this
 * class exists solely to make the live-forwarded stream as safe as the
 * persisted tail.
 *
 * `flush()` MUST be called on stream end to release any trailing partial
 * line; otherwise its (redacted) content is dropped from the live tee but
 * still appears in the persisted tail.
 */
export class StreamRedactor {
  private carryover = '';
  // Safety cap for input with no newlines at all; emit the prefix and keep
  // a sliding window of the last MAX_BUFFER chars to catch boundary splits
  // up to that length.
  private static readonly MAX_BUFFER = 8192;

  process(chunk: string, emit: (redacted: string) => void): void {
    if (!chunk) return;
    const combined = this.carryover + chunk;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const complete = combined.slice(0, lastNewline + 1);
      this.carryover = combined.slice(lastNewline + 1);
      emit(redactOutput(complete));
      return;
    }
    if (combined.length > StreamRedactor.MAX_BUFFER) {
      // No newline but we have to bound memory. Redact the whole buffer
      // before emitting — slicing would re-introduce a boundary mid-secret.
      // Carryover resets; the next chunk starts fresh, accepting that a
      // secret split across the cap boundary may be redacted twice (safe)
      // but never split within a regex match.
      emit(redactOutput(combined));
      this.carryover = '';
      return;
    }
    this.carryover = combined;
  }

  flush(emit: (redacted: string) => void): void {
    if (this.carryover) {
      emit(redactOutput(this.carryover));
      this.carryover = '';
    }
  }
}
