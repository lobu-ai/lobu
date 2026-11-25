/**
 * The one egress policy grammar for every host-mediated egress path in Lobu.
 *
 * Every place below decides "may this code reach that host?" by evaluating the
 * same configured patterns with the functions in this file:
 *
 *  - the gateway's worker egress proxy (`packages/server/src/gateway/proxy/http-proxy.ts`)
 *  - the per-agent grant store and the judged-domain policy store
 *    (`packages/server/src/gateway/permissions/`)
 *  - the remote runtime provider's sandbox network policy
 *    (`packages/server/src/gateway/runtime/providers/vercel.ts`)
 *  - the connector isolate lane's host capabilities, `fetch` and `socketOpen`
 *    (`IsolateExecutor` in `@lobu/connector-worker`), whose allowlist is
 *    unrestricted by default and closed when empty like everyone else's
 *
 * Pattern grammar (patterns are produced by `@lobu/core`'s
 * `normalizeDomainPattern`, which lowercases, punycodes, and rewrites
 * `*.suffix` to `.suffix`):
 *
 *  - `example.com`   exact host only
 *  - `.example.com`  the apex AND every subdomain (`*.example.com` is accepted
 *                    as the same wildcard so a list that was never normalized
 *                    still reads the way its author meant)
 *  - `*`             unrestricted, only meaningful as the sole allow entry
 *
 * An empty allowlist denies everything. That is the fail-closed default every
 * caller shares; a caller whose configured default is "open" supplies `["*"]`
 * itself, never a special case here.
 *
 * Decision order, shared by every caller that layers tenant and judge inputs on
 * the global lists ({@link decideEgress}):
 *
 *  1. global denylist            → deny
 *  2. tenant deny grant          → deny (authoritative over every allow below)
 *  3. global allowlist           → allow
 *  4. tenant allow grant         → allow
 *  5. LLM egress judge, if a judged-domain rule covers the host → its verdict
 *  6. otherwise                  → deny
 *
 * Pure on purpose: no `node:` import and no `@lobu/core` import, so the same
 * module runs on the Node host, inside a V8 isolate, and on a workerd-class
 * runtime. Only request-time canonicalization and matching live here;
 * configured patterns are normalized once, at write time, by `@lobu/core`.
 */

import { normalizeIpLiteral, stripIpv6Brackets } from './ip-reachability.js';

/** The sole allowlist entry that means "unrestricted". */
const UNRESTRICTED_PATTERN = '*';

/** True when the allowlist is exactly `["*"]`: allow everything the denylist does not name. */
export function isUnrestrictedMode(allowedDomains: readonly string[]): boolean {
  return allowedDomains.length === 1 && allowedDomains[0] === UNRESTRICTED_PATTERN;
}

/**
 * Characters a DNS name (or an IDN label) can be built from. Anything else
 * (`%`, spaces, `/`, `@`, `:`, `[`, ...) is a URL delimiter that `new URL()`
 * would consume or truncate rather than report, so such a host is returned
 * lowercased and unchanged instead: it will match no configured pattern and
 * DNS will refuse it.
 */
const HOST_CHARS = /^[A-Za-z0-9._\-\u0080-\uffff]+$/;

/**
 * Canonicalize a hostname for allow/deny/judge matching.
 *
 * WHATWG URL parsing and a raw CONNECT host parser both preserve a trailing dot
 * (`evil.com.`), which DNS resolves identically to `evil.com` but which no
 * configured pattern carries; without stripping it a trailing-dot host slips
 * past a denylist. Unicode hosts are folded to their `xn--` ASCII form so a
 * CONNECT target typed in Unicode matches the punycode pattern the operator
 * stored. IP literals pass through untouched (brackets kept), so every matcher
 * sees the one name the resolver will ultimately use.
 */
export function canonicalizeHostname(hostname: string): string {
  let end = hostname.length;
  while (end > 0 && hostname.charCodeAt(end - 1) === 0x2e) end -= 1;
  const lower = hostname.slice(0, end).toLowerCase();
  if (lower === '' || !HOST_CHARS.test(lower)) return lower;
  if (normalizeIpLiteral(stripIpv6Brackets(lower)).kind !== 'not-ip') return lower;
  try {
    const ascii = new URL(`http://${lower}`).hostname;
    return ascii === '' ? lower : ascii;
  } catch {
    return lower;
  }
}

export interface PatternMatchOptions {
  /**
   * Whether a `.suffix` wildcard also covers its apex. The proxy's global
   * lists and the judged-domain rules say yes (the default); the per-agent
   * grant store deliberately says no — a grant for `.example.com` covers
   * subdomains only, so the apex needs its own row.
   */
  wildcardCoversRoot?: boolean;
}

/** The suffix a wildcard pattern names, or `null` for an exact pattern. */
function wildcardSuffix(pattern: string): string | null {
  if (pattern.startsWith('.')) return pattern.slice(1);
  if (pattern.startsWith('*.')) return pattern.slice(2);
  return null;
}

/** Whether one configured pattern covers `hostname`. Both are compared lowercased. */
function patternCovers(pattern: string, hostname: string, options?: PatternMatchOptions): boolean {
  const host = hostname.toLowerCase();
  const lower = pattern.toLowerCase();
  const suffix = wildcardSuffix(lower);
  if (suffix === null) return lower === host;
  if (host.endsWith(`.${suffix}`)) return true;
  return (options?.wildcardCoversRoot ?? true) && host === suffix;
}

/** Whether any pattern in the list covers `hostname`. */
export function matchesDomainPattern(
  hostname: string,
  patterns: readonly string[],
  options?: PatternMatchOptions,
): boolean {
  return patterns.some((pattern) => patternCovers(pattern, hostname, options));
}

/**
 * Evaluate a plain allow/deny list pair.
 *  - the denylist always wins;
 *  - `["*"]` allows everything the denylist does not name;
 *  - an empty allowlist denies everything.
 */
function evaluateListPolicy(
  hostname: string,
  allowedDomains: readonly string[],
  deniedDomains: readonly string[],
): boolean {
  if (isUnrestrictedMode(allowedDomains)) {
    return deniedDomains.length === 0 || !matchesDomainPattern(hostname, deniedDomains);
  }
  if (allowedDomains.length === 0) return false;
  if (!matchesDomainPattern(hostname, allowedDomains)) return false;
  return deniedDomains.length === 0 || !matchesDomainPattern(hostname, deniedDomains);
}

/**
 * Wildcard patterns that cover `hostname` under grant semantics: every ancestor
 * suffix, most specific first, in both the normalized `.tail` spelling and the
 * legacy `*.tail` spelling that rows written before write-normalization may
 * still carry. The apex's own wildcard is NOT included (`example.com` yields
 * nothing): a `.example.com` grant covers subdomains only.
 */
export function wildcardParentPatterns(hostname: string): string[] {
  const parts = hostname.split('.');
  const out: string[] = [];
  for (let i = 1; i < parts.length - 1; i++) {
    const tail = parts.slice(i).join('.');
    out.push(`.${tail}`, `*.${tail}`);
  }
  return out;
}

/**
 * Whether an `allow` pattern reaches any host a `covering` pattern covers.
 *
 * Used to refuse an allow entry that would shadow a judged domain, and to
 * subtract a denied pattern from a remote sandbox's allow set (its policy has
 * no deny primitive). The `covering` side is matched with apex-inclusive
 * wildcards, the way judged rules and denylists are enforced; whether the
 * `allow` side's wildcard covers its apex depends on which matcher enforces
 * it, so callers pass {@link PatternMatchOptions.wildcardCoversRoot} for it
 * (default: grant semantics, no). Two wildcards overlap when either suffix
 * sits under the other.
 */
export function patternReaches(covering: string, allow: string, options?: PatternMatchOptions): boolean {
  const c = wildcardSuffix(covering);
  const a = wildcardSuffix(allow);
  const under = (host: string, suffix: string) => host.endsWith(`.${suffix}`);
  if (a === null) {
    if (c === null) return covering === allow;
    return allow === c || under(allow, c);
  }
  if (c === null) return ((options?.wildcardCoversRoot ?? false) && covering === a) || under(covering, a);
  return c === a || under(c, a) || under(a, c);
}

export type EgressDecisionSource = 'global' | 'grant' | 'judge';

/**
 * Outcome of a full access decision. When the judge was consulted, `judge`
 * carries its verdict so the caller can surface the reason and audit it.
 */
export interface EgressDecision<Judge = unknown> {
  allowed: boolean;
  source: EgressDecisionSource;
  judge?: Judge;
}

export interface EgressDecisionInputs<Judge = unknown> {
  /** Raw request hostname; canonicalized here so every step sees one name. */
  hostname: string;
  global: {
    allowedDomains: readonly string[];
    deniedDomains: readonly string[];
  };
  /** Per-tenant grants. Absent when the caller has no tenant context. */
  tenant?: {
    isDenied(hostname: string): Promise<boolean>;
    hasGrant(hostname: string): Promise<boolean>;
  };
  /**
   * The LLM egress judge. Returns `null` when no judged-domain rule covers the
   * host; otherwise its verdict plus whatever the caller wants to audit.
   */
  judge?: (hostname: string) => Promise<{ allowed: boolean; decision: Judge } | null>;
}

/** The shared decision order documented at the top of this file. */
export async function decideEgress<Judge = unknown>(
  inputs: EgressDecisionInputs<Judge>,
): Promise<EgressDecision<Judge>> {
  const hostname = canonicalizeHostname(inputs.hostname);
  const { allowedDomains, deniedDomains } = inputs.global;

  if (deniedDomains.length > 0 && matchesDomainPattern(hostname, deniedDomains)) {
    return { allowed: false, source: 'global' };
  }
  if (inputs.tenant && (await inputs.tenant.isDenied(hostname))) {
    return { allowed: false, source: 'grant' };
  }
  if (evaluateListPolicy(hostname, allowedDomains, deniedDomains)) {
    return { allowed: true, source: 'global' };
  }
  if (inputs.tenant && (await inputs.tenant.hasGrant(hostname))) {
    return { allowed: true, source: 'grant' };
  }
  if (inputs.judge) {
    const verdict = await inputs.judge(hostname);
    if (verdict) return { allowed: verdict.allowed, source: 'judge', judge: verdict.decision };
  }
  return { allowed: false, source: 'global' };
}
