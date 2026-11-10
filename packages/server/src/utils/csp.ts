/**
 * CSP frame-ancestor source-expression validator.
 *
 * Accepts host-source (`https://example.com`, `https://*.example.com`, with
 * an optional port) and scheme-source (`https:`, `wss:`). Rejects anything
 * with embedded whitespace, paths, or disallowed characters, so a malformed
 * env entry like `https:// lobu.ai` cannot silently weaken the policy — a
 * browser receiving an unknown token in a directive treats the rest
 * permissively.
 *
 * A port wildcard (`http://127.0.0.1:*`) is accepted only for loopback
 * hosts. A desktop host embeds the app from a local port it picks at launch
 * (bb serves from `http://127.0.0.1:<port>`), which a fixed allow-list cannot
 * name. Browsers already treat loopback as this machine, so this does not
 * widen the clickjacking boundary to public origins.
 */
export function isValidFrameAncestor(entry: string): boolean {
  if (!entry) return false;
  if (/^[a-z][a-z0-9+\-.]*:$/i.test(entry)) return true;
  const source = /^https?:\/\/(\*\.)?([a-z0-9.-]+)(?::(\d+|\*))?$/i.exec(entry);
  if (source === null) return false;
  if (source[3] !== '*') return true;
  const host = source[2].toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
}
