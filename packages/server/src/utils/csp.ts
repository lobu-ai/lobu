/**
 * CSP frame-ancestor source-expression validator.
 *
 * Accepts host-source (`https://example.com`, `https://*.example.com`, with
 * an optional port) and scheme-source (`https:`, `wss:`). Rejects anything
 * with embedded whitespace, paths, or disallowed characters, so a malformed
 * env entry like `https:// lobu.ai` cannot silently weaken the policy — a
 * browser receiving an unknown token in a directive treats the rest
 * permissively.
 */
export function isValidFrameAncestor(entry: string): boolean {
  if (!entry) return false;
  if (/^[a-z][a-z0-9+\-.]*:$/i.test(entry)) return true;
  return /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(entry);
}
