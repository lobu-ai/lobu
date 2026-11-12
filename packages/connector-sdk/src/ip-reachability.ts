/**
 * Canonical IP-literal classifier shared by every Lobu egress guard.
 *
 * Two call sites need the same answer to "is this host an internal
 * address?", and both read it through this one classifier:
 *
 *  - `packages/connector-worker/src/egress/transport.ts` — the Node egress
 *    transport: resolves DNS, applies an {@link EgressAddressPolicy} to every
 *    answer, and pins the socket to a validated address. The gateway and the
 *    connector isolate lane (`fetch` and `socketOpen`) both dial through it.
 *  - `./url-guards.ts` — connector-authored URL check, applied at the
 *    trust boundary before a connector fetches an operator-supplied URL.
 *
 * The address POLICY lives here too ({@link isBlockedIp}): which reserved
 * ranges `allow-private` (self-hosted) still refuses and which
 * `block-private` (untrusted cloud) refuses on top. Forced TLS for database
 * URLs is the one policy piece that stays connector-side
 * (`packages/connectors/src/db-egress-guard.ts`): nothing on the wire tells
 * the host that a socket carries database credentials.
 *
 * Keeping the classifier here rather than in each consumer is deliberate:
 * `@lobu/connector-sdk` is the only package every consumer can import (the
 * server package is not reachable from a bundled connector, and `@lobu/core`
 * pulls OpenTelemetry and winston, which connectors intentionally
 * avoid).
 *
 * The matcher collapses the spellings an attacker can use to dress up an
 * internal address so `net.BlockList` won't recognise it: IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` / `::ffff:7f00:1`), IPv4-compatible IPv6 (`::7f00:1`),
 * the NAT64 well-known prefix (`64:ff9b::/96`), zone IDs (`fe80::1%eth0`), and
 * the `0.0.0.0/8` / `::` unspecified ranges. Anything that looks like an IP but
 * will not parse fails closed.
 *
 * This is the UNION of the two classifiers it replaces, not either one: the
 * database guard unwrapped IPv4-compatible IPv6 and the gateway guard did not,
 * so `::a9fe:a9fe` (cloud metadata) reached the gateway unblocked. Consolidating
 * on the stricter copy closes that gap for every consumer at once.
 */

/**
 * IP-literal family test with `node:net`'s exact semantics, expressed as the
 * same regular expressions Node uses (`lib/internal/net.js`). Pure JS on
 * purpose: this module is part of the package root, which must stay loadable
 * inside a V8 isolate where no `node:` module exists. Returns 4, 6 or 0.
 */
const V4_SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4_RE = new RegExp(`^${V4_STR}$`);
const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const IPV6_RE = new RegExp(
  '^(?:' +
    `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|` +
    `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|` +
    `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|` +
    `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|` +
    `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|` +
    `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|` +
    `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$',
);

export function ipFamily(address: string): 0 | 4 | 6 {
  if (IPV4_RE.test(address)) return 4;
  if (IPV6_RE.test(address)) return 6;
  return 0;
}

/**
 * One entry of an IANA special-purpose address registry: a prefix and whether
 * addresses inside it are globally reachable.
 *
 * Evaluation is longest-prefix-wins, which is load-bearing rather than a
 * nicety: several non-global ranges contain globally reachable exceptions
 * (`192.0.0.0/24` holds the PCP and TURN anycast /32s), and a flat
 * "any match means blocked" list cannot express that.
 */
type ReachabilityRule = readonly [
  base: string,
  prefix: number,
  globallyReachable: boolean,
];

/**
 * IANA IPv4 Special-Purpose Address Registry, last reviewed 2025-10-09.
 *
 * Multicast and the reserved `240/4` block live in separate IANA registries
 * but are included here as non-unicast routing boundaries.
 */
const IPV4_REACHABILITY_RULES: readonly ReachabilityRule[] = [
  ['0.0.0.0', 8, false], // "this network"
  ['10.0.0.0', 8, false], // RFC1918
  ['100.64.0.0', 10, false], // CGNAT
  ['127.0.0.0', 8, false], // loopback
  ['169.254.0.0', 16, false], // link-local + cloud metadata
  ['172.16.0.0', 12, false], // RFC1918
  ['192.0.0.0', 24, false], // IETF protocol assignments
  ['192.0.0.0', 29, false], // DS-Lite
  ['192.0.0.8', 32, false], // IPv4 dummy address
  ['192.0.0.9', 32, true], // PCP anycast
  ['192.0.0.10', 32, true], // TURN anycast
  ['192.0.0.170', 32, false], // NAT64/DNS64 discovery
  ['192.0.0.171', 32, false], // NAT64/DNS64 discovery
  ['192.0.2.0', 24, false], // TEST-NET-1
  ['192.31.196.0', 24, true], // AS112-v4
  ['192.52.193.0', 24, true], // AMT
  ['192.88.99.0', 24, false], // deprecated 6to4 relay anycast
  ['192.88.99.2', 32, false],
  ['192.168.0.0', 16, false], // RFC1918
  ['192.175.48.0', 24, true], // direct delegation AS112
  ['198.18.0.0', 15, false], // benchmarking
  ['198.51.100.0', 24, false], // TEST-NET-2
  ['203.0.113.0', 24, false], // TEST-NET-3
  ['224.0.0.0', 4, false], // multicast
  ['240.0.0.0', 4, false], // reserved
  ['255.255.255.255', 32, false], // limited broadcast
];

/**
 * IANA IPv6 Special-Purpose Address Registry, last reviewed 2025-10-09.
 *
 * `2000::/3` is IANA's allocated global-unicast envelope. Anything outside it
 * is unallocated and fails closed, so the IPv6 default is the opposite of the
 * IPv4 default — see {@link ipv6IsGloballyReachable}.
 */
const IPV6_REACHABILITY_RULES: readonly ReachabilityRule[] = [
  ['::', 128, false], // unspecified
  ['::1', 128, false], // loopback
  ['::ffff:0:0', 96, false], // IPv4-mapped (unwrapped before this table)
  ['64:ff9b::', 96, true], // NAT64 well-known (v4 suffix checked separately)
  ['64:ff9b:1::', 48, false], // local-use NAT64
  ['100::', 64, false], // discard-only
  ['100:0:0:1::', 64, false], // dummy prefix
  ['2000::', 3, true], // global unicast
  ['2001::', 23, false], // IETF protocol assignments
  ['2001::', 32, false], // TEREDO — registry says N/A; fail closed
  ['2001:1::1', 128, true], // PCP anycast
  ['2001:1::2', 128, true], // TURN anycast
  ['2001:1::3', 128, true], // DNS-SD service registration
  ['2001:2::', 48, false], // benchmarking
  ['2001:3::', 32, true], // AMT
  ['2001:4:112::', 48, true], // AS112-v6
  ['2001:10::', 28, false], // deprecated ORCHID
  ['2001:20::', 28, true], // ORCHIDv2
  ['2001:30::', 28, true], // DRIP
  ['2001:db8::', 32, false], // documentation
  ['2002::', 16, false], // 6to4 — registry says N/A; fail closed
  ['2620:4f:8000::', 48, true], // direct delegation AS112
  ['3fff::', 20, false], // documentation
  ['5f00::', 16, false], // SRv6 SIDs
  ['fc00::', 7, false], // unique local (ULA)
  ['fec0::', 10, false], // deprecated site-local (RFC 3879)
  ['fe80::', 10, false], // link-local
  ['ff00::', 8, false], // multicast
];
/** Pack two 16-bit hextets into the dotted-quad IPv4 they encode. */
function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Whether `address` falls inside `base/prefix`.
 *
 * An unparseable address matches every prefix. That is deliberate: every
 * caller uses a match to mean "blocked", so a malformed value fails closed.
 */
export function matchesIpv4Prefix(
  address: string,
  base: string,
  prefix: number,
): boolean {
  const addressValue = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (addressValue === undefined || baseValue === undefined) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

/** Expand a valid (ipFamily===6) IPv6 string into 8 unsigned 16-bit hextets. */
function expandIpv6ToHextets(addr: string): number[] {
  const lower = addr.toLowerCase();
  let hexPart = lower;
  let ipv4Suffix: number[] = [];
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx !== -1) {
    const colonBeforeDot = lower.lastIndexOf(':', dotIdx);
    const dotted = lower.slice(colonBeforeDot + 1);
    hexPart = lower.slice(0, colonBeforeDot + 1);
    const octets = dotted.split('.').map((o) => Number.parseInt(o, 10));
    ipv4Suffix = [
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)) >>> 0,
      (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0,
    ];
    if (hexPart.endsWith(':') && !hexPart.endsWith('::')) {
      hexPart = hexPart.slice(0, -1);
    }
  }
  const halves = hexPart.split('::');
  const left = halves[0]
    ? halves[0].split(':').map((h) => Number.parseInt(h, 16))
    : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(':').map((h) => Number.parseInt(h, 16))
      : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

function ipv6ToBigInt(address: string): bigint {
  return expandIpv6ToHextets(address).reduce(
    (acc, hextet) => (acc << 16n) | BigInt(hextet),
    0n,
  );
}

/** Whether `address` falls inside the IPv6 network `base/prefix`. */
export function matchesIpv6Prefix(
  address: string,
  base: string,
  prefix: number,
): boolean {
  const shift = 128n - BigInt(prefix);
  return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift;
}

/**
 * Result of running a host literal through {@link normalizeIpLiteral}.
 *  - `ipv4`     — the value is (or decodes to) a bare IPv4 address.
 *  - `ipv6`     — a genuine IPv6 address that doesn't embed an IPv4.
 *  - `not-ip`   — not an IP literal at all (a DNS name); caller should resolve.
 *  - `invalid`  — looks like an IP literal but doesn't cleanly parse → reject.
 */
export type NormalizedHost =
  | { kind: 'ipv4'; value: string }
  | { kind: 'ipv6'; value: string }
  | { kind: 'not-ip' }
  | { kind: 'invalid' };

/**
 * Collapse an IP literal to its canonical IPv4/IPv6 form (or not-ip/invalid).
 *
 * Single funnel for every host literal that reaches a blocklist check —
 * resolved DNS results and CONNECT/forward targets alike. Collapses the
 * forms an attacker can use to dress up an internal address as something
 * `net.BlockList` won't recognise:
 *   - IPv4-mapped IPv6, dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`)
 *   - NAT64 well-known prefix `64:ff9b::/96` (last 32 bits are an IPv4)
 *   - zone IDs (`fe80::1%eth0` → strip `%eth0`)
 *   - compressed / uppercase forms (handled by `ipFamily`)
 * Anything that looks like an IP but doesn't parse returns `invalid` so the
 * caller fails closed rather than falling through to a DNS lookup.
 */
export function normalizeIpLiteral(host: string): NormalizedHost {
  const zoneSplit = host.indexOf('%');
  const bare = (zoneSplit === -1 ? host : host.slice(0, zoneSplit)).trim();
  if (bare.length === 0) {
    return zoneSplit === -1 ? { kind: 'not-ip' } : { kind: 'invalid' };
  }

  const family = ipFamily(bare);
  if (family === 4) return { kind: 'ipv4', value: bare };
  if (family === 0) {
    return bare.includes(':') ? { kind: 'invalid' } : { kind: 'not-ip' };
  }

  const lower = bare.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (mapped.includes('.')) {
      return ipFamily(mapped) === 4
        ? { kind: 'ipv4', value: mapped }
        : { kind: 'invalid' };
    }
    const parts = mapped.split(':');
    if (parts.length !== 2) return { kind: 'invalid' };
    const high = Number.parseInt(parts[0] || '', 16);
    const low = Number.parseInt(parts[1] || '', 16);
    if (
      !Number.isInteger(high) ||
      !Number.isInteger(low) ||
      high < 0 ||
      high > 0xffff ||
      low < 0 ||
      low > 0xffff
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'ipv4', value: hextetsToIpv4(high, low) };
  }

  const hextets = expandIpv6ToHextets(bare);
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    return { kind: 'ipv4', value: hextetsToIpv4(hextets[6] ?? 0, hextets[7] ?? 0) };
  }

  // IPv4-compatible IPv6 (`::a.b.c.d`, e.g. `::7f00:1` = 127.0.0.1): the first 96
  // bits are zero with a non-trivial v4 suffix. Unwrap so the v4 blocklist
  // applies — otherwise swapping `::ffff:` for `::` evades the guard. `::` and
  // `::1` keep their explicit blocklist entries (suffix 0 or 1).
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    (hextets[6] !== 0 || (hextets[7] ?? 0) > 1)
  ) {
    return { kind: 'ipv4', value: hextetsToIpv4(hextets[6] ?? 0, hextets[7] ?? 0) };
  }

  return { kind: 'ipv6', value: bare };
}

/**
 * Strip surrounding brackets from an IPv6 literal so `ipFamily()` can
 * recognise it. WHATWG URL parsing returns `parsedUrl.hostname` with
 * brackets for IPv6 (e.g. `[::1]`), and `ipFamily("[::1]")` returns 0,
 * which would cause the IP-blocklist check to be skipped and the value
 * to fall through to a DNS lookup — bypassing the loopback/private-IP
 * guards. Normalising to the bare address closes that hole.
 */
export function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Longest-prefix lookup over an IANA registry table.
 *
 * `fallback` is the answer when no rule matches: IPv4 space is globally
 * reachable apart from the carve-outs above, while IPv6 space is mostly
 * unallocated, so an unmatched IPv6 address is treated as unreachable.
 */
function isGloballyReachable(
  address: string,
  rules: readonly ReachabilityRule[],
  matches: (address: string, base: string, prefix: number) => boolean,
  fallback: boolean,
): boolean {
  let decision = fallback;
  let longestPrefix = -1;
  for (const [base, prefix, globallyReachable] of rules) {
    if (prefix > longestPrefix && matches(address, base, prefix)) {
      decision = globallyReachable;
      longestPrefix = prefix;
    }
  }
  return decision;
}

/**
 * Whether a canonical IPv4 address is in a reserved (non-global) range.
 *
 * Unparseable input is blocked explicitly rather than relying on
 * {@link matchesIpv4Prefix}'s match-everything fallback: under longest-prefix
 * evaluation that fallback would resolve to whichever rule happens to carry the
 * longest prefix, so reordering two `/32` entries could silently turn a
 * malformed address from blocked into allowed.
 */
export function isReservedIpv4(address: string): boolean {
  if (ipv4ToNumber(address) === undefined) return true;
  return !isGloballyReachable(
    address,
    IPV4_REACHABILITY_RULES,
    matchesIpv4Prefix,
    true,
  );
}

/**
 * Whether a canonical IPv6 address is in a reserved (non-global) range.
 * Unparseable input fails closed, for the reason on {@link isReservedIpv4}.
 */
export function isReservedIpv6(address: string): boolean {
  if (ipFamily(address) !== 6) return true;
  return !isGloballyReachable(
    address,
    IPV6_REACHABILITY_RULES,
    matchesIpv6Prefix,
    false,
  );
}

/**
 * Whether an IP literal (in any spelling) belongs to a reserved/internal range.
 * A value that looks like an IP but won't parse fails closed (blocked); a
 * non-IP hostname returns false (the caller resolves it and re-checks).
 *
 * Pass a bare address: this does NOT strip brackets, because a bracketed
 * literal is indistinguishable from a malformed one here and would fail
 * closed. Callers holding a WHATWG `url.hostname` run it through
 * {@link stripIpv6Brackets} first.
 */
export function isReservedIp(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case 'ipv4':
      return isReservedIpv4(normalized.value);
    case 'ipv6':
      return isReservedIpv6(normalized.value);
    case 'invalid':
      return true;
    case 'not-ip':
      return false;
  }
}

/**
 * Which reserved address space an egress path may dial.
 *
 *  - `block-private` (untrusted cloud, the transport's default): every
 *    non-global address is refused — the full {@link isReservedIp} set.
 *  - `allow-private` (self-hosted / first-party): loopback, RFC1918, CGNAT
 *    and ULA are legitimate destinations (`make dev` reaches localhost, the
 *    dogfood reaches Lobu's own private Postgres), but link-local / cloud
 *    metadata, multicast, the reserved and broadcast range, and the
 *    unspecified address stay refused: no real endpoint lives there, so this
 *    is cheap defence in depth.
 *
 * Cloud-metadata endpoints that sit INSIDE a range `allow-private` permits
 * are pinned individually and refused under both policies, so lowering a host
 * to the `allow-private` floor (an operator exemption) never exposes them.
 */
export type EgressAddressPolicy = 'block-private' | 'allow-private';

/**
 * The subset blocked even under `allow-private`. Loopback, RFC1918, CGNAT and
 * ULA are deliberately ABSENT.
 */
const ALLOW_PRIVATE_BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const ALLOW_PRIVATE_BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ['fe80::', 10],
  ['ff00::', 8],
];

/**
 * Cloud-metadata endpoints OUTSIDE the ranges the `allow-private` floor already
 * denies, listed individually so they stay blocked under every policy and even
 * for an explicitly exempted host. Each sits in a range `allow-private`
 * deliberately permits: Alibaba's is in CGNAT `100.64.0.0/10` — exactly the
 * range a Tailscale exemption targets — and AWS's IPv6 IMDS is in ULA
 * `fc00::/7`, where a self-hoster's database legitimately lives. Kept
 * metadata-only so ordinary CGNAT and ULA hosts stay reachable.
 * (169.254.169.254 and 169.254.170.2 need no entry: link-local is already
 * denied at the floor.)
 */
const METADATA_V4: ReadonlyArray<readonly [string, number]> = [
  ['100.100.100.200', 32], // Alibaba Cloud metadata (inside CGNAT)
  ['192.0.0.192', 32], // Oracle Cloud metadata (IETF protocol assignments)
];

const METADATA_V6: ReadonlyArray<readonly [string, number]> = [
  ['fd00:ec2::254', 128], // AWS IMDS over IPv6 (inside ULA)
];

function isBlockedIpv4(address: string, policy: EgressAddressPolicy): boolean {
  if (METADATA_V4.some(([base, prefix]) => matchesIpv4Prefix(address, base, prefix))) return true;
  if (policy === 'block-private') return isReservedIpv4(address);
  return ALLOW_PRIVATE_BLOCKED_V4.some(([base, prefix]) => matchesIpv4Prefix(address, base, prefix));
}

function isBlockedIpv6(address: string, policy: EgressAddressPolicy): boolean {
  if (METADATA_V6.some(([base, prefix]) => matchesIpv6Prefix(address, base, prefix))) return true;
  if (matchesIpv6Prefix(address, '::', 128)) return true;
  if (policy === 'block-private') return isReservedIpv6(address);
  return ALLOW_PRIVATE_BLOCKED_V6.some(([base, prefix]) => matchesIpv6Prefix(address, base, prefix));
}

/**
 * Whether an IP literal (in any spelling) may NOT be dialled under `policy`.
 * Under `block-private` this is exactly {@link isReservedIp}; under
 * `allow-private` it drops to the floor documented on
 * {@link EgressAddressPolicy}. A literal that looks like an IP but won't parse
 * fails closed; a non-IP hostname returns false (the caller resolves it and
 * re-checks every answer). Bare address in, as for {@link isReservedIp}.
 */
export function isBlockedIp(ip: string, policy: EgressAddressPolicy): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case 'ipv4':
      return isBlockedIpv4(normalized.value, policy);
    case 'ipv6':
      return isBlockedIpv6(normalized.value, policy);
    case 'invalid':
      return true;
    case 'not-ip':
      return false;
  }
}
