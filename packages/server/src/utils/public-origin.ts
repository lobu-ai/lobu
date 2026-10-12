/**
 * Canonical public URL resolution. PUBLIC_GATEWAY_URL is the single override for
 * the externally reachable gateway base (origin or origin + /lobu mount).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTED_UI_FALLBACK_ORIGIN = 'https://app.lobu.ai';
const DEFAULT_GATEWAY_MOUNT = '/lobu';

/** Normalize PUBLIC_GATEWAY_URL to a gateway base ending in /lobu. */
export function normalizePublicGatewayUrl(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, '') || '';
  if (!path || path === '/') {
    url.pathname = DEFAULT_GATEWAY_MOUNT;
  }
  return url.toString().replace(/\/+$/, '');
}

// PUBLIC_GATEWAY_URL is immutable post-boot; parse it once. `null` sentinel marks
// "computed and absent" so we don't re-parse on every auth resolution.
const UNRESOLVED = Symbol('unresolved');
let configuredPublicGatewayUrlCache: string | undefined | typeof UNRESOLVED =
  UNRESOLVED;

export function getConfiguredPublicGatewayUrl(): string | undefined {
  if (configuredPublicGatewayUrlCache !== UNRESOLVED) {
    return configuredPublicGatewayUrlCache;
  }
  const raw = process.env.PUBLIC_GATEWAY_URL?.trim();
  if (!raw) {
    configuredPublicGatewayUrlCache = undefined;
    return undefined;
  }
  try {
    configuredPublicGatewayUrlCache = normalizePublicGatewayUrl(raw);
  } catch {
    configuredPublicGatewayUrlCache = undefined;
  }
  return configuredPublicGatewayUrlCache;
}

export function getConfiguredPublicOrigin(): string | undefined {
  const gatewayUrl = getConfiguredPublicGatewayUrl();
  if (!gatewayUrl) return undefined;
  return new URL(gatewayUrl).origin;
}

/**
 * Public-facing origin for a request: the configured `PUBLIC_GATEWAY_URL`
 * override when set, otherwise the actual serving origin derived from the
 * request URL. Single source for every "what origin should we stamp here?"
 * call site (OAuth metadata, MCP view-resource domain, reauth links).
 *
 * `requestUrl` is required: it is the fallback when no override is configured,
 * and every caller has a `req.url` to pass. An optional param invited a
 * `new URL('')` that throws `TypeError: Invalid URL` — a trap, not a default.
 */
export function resolvePublicOrigin(requestUrl: string): string {
  return getConfiguredPublicOrigin() ?? new URL(requestUrl).origin;
}

/** Configured gateway base, or loopback default for embedded/local boot. */
export function resolvePublicGatewayUrl(): string {
  const configured = getConfiguredPublicGatewayUrl();
  if (configured) return configured;
  const port = process.env.PORT || process.env.GATEWAY_PORT || '8787';
  return normalizePublicGatewayUrl(`http://localhost:${port}`);
}

/** Test-only: clear memoized origin/local-frontend caches. */
export function __resetPublicOriginCachesForTests(): void {
  configuredPublicGatewayUrlCache = UNRESOLVED;
  localFrontendCache = undefined;
}

/**
 * Test-only: pin `hasLocalFrontend()` so tests asserting the backend-only
 * fallback don't depend on whether a frontend bundle happens to exist on the
 * machine — `packages/owletto/dist/index.html` is present after any owletto
 * build (e.g. `make review`), absent in CI and fresh checkouts.
 */
export function __setLocalFrontendForTests(value: boolean | undefined): void {
  localFrontendCache = value;
}

const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

let localFrontendCache: boolean | undefined;

/**
 * Sync check for a locally available frontend. Used by MCP URL builders to
 * decide whether to return the hosted UI fallback when PUBLIC_GATEWAY_URL is not
 * configured.
 *
 * Always matches a built bundle (`packages/owletto/dist/index.html`). In
 * development it additionally matches a source checkout
 * (`packages/owletto/index.html`), which is what the Vite middleware serves —
 * gated on NODE_ENV so a stray source tree in a production image does not
 * cause request-origin links to leak out.
 */
export function hasLocalFrontend(): boolean {
  if (localFrontendCache !== undefined) return localFrontendCache;

  const envDist = process.env.WEB_DIST_DIR?.trim();
  const isDevelopment = process.env.NODE_ENV === 'development';
  // Sibling-walk candidates must go through `../owletto/`, not
  // `../packages/owletto/` (resolves to `packages/packages/owletto/`).
  // `../web/...` is a leftover from the packages/web → packages/owletto
  // rename in #817.
  const candidates = [
    envDist ? path.join(envDist, 'index.html') : undefined,
    path.resolve(APP_ROOT, 'packages/owletto/dist/index.html'),
    path.resolve(APP_ROOT, '../owletto/dist/index.html'),
    path.resolve(process.cwd(), 'packages/owletto/dist/index.html'),
    path.resolve(process.cwd(), '../owletto/dist/index.html'),
    isDevelopment ? path.resolve(APP_ROOT, 'packages/owletto/index.html') : undefined,
    isDevelopment ? path.resolve(APP_ROOT, '../owletto/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), 'packages/owletto/index.html') : undefined,
    isDevelopment ? path.resolve(process.cwd(), '../owletto/index.html') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        localFrontendCache = true;
        return true;
      }
    } catch {
      // Try next candidate.
    }
  }

  localFrontendCache = false;
  return false;
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Normalize a host or DNS zone for comparison:
 *   - strip port / leading-dot / trailing-dot / surrounding whitespace
 *   - convert IDN labels (e.g. `müller.lobu.ai`) to ASCII punycode
 *   - lowercase
 *
 * Returns null when the input cannot be parsed as a hostname. Use this on
 * both sides of any zone/host comparison so IDN-encoded requests still match
 * the canonical ASCII zone configured in env.
 */
export function normalizeHost(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const stripped = value
    .split(':')[0]
    ?.trim()
    .replace(/^\./, '')
    .replace(/\.$/, '');
  if (!stripped) return null;
  try {
    // new URL() performs IDN → punycode conversion and lowercasing.
    return new URL(`https://${stripped}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns a canonical redirect URL when browser traffic lands on a non-canonical
 * host while a public origin is configured. Subdomains of the canonical host are
 * preserved so workspace routing keeps working. When AUTH_COOKIE_DOMAIN is set
 * (e.g. ".lobu.ai") sibling subdomains of that zone are also preserved so
 * per-org subdomains like acme.lobu.ai are not bounced to app.lobu.ai.
 */
export function getCanonicalRedirectUrl(
  requestUrl: string,
  configuredOrigin = getConfiguredPublicOrigin(),
  cookieDomain = process.env.AUTH_COOKIE_DOMAIN
): string | null {
  if (!configuredOrigin) return null;

  let request: URL;
  let canonical: URL;

  try {
    request = new URL(requestUrl);
    canonical = new URL(configuredOrigin);
  } catch {
    return null;
  }

  // URL already lowercases + punycodes hostnames, so both sides are comparable.
  const requestHost = request.hostname;
  const canonicalHost = canonical.hostname;

  // Never force-redirect TO loopback. Local PUBLIC_GATEWAY_URL (127.0.0.1 /
  // localhost) is for on-box dev; bouncing Tailscale/LAN hosts there breaks
  // every other machine (the client's localhost is not this server).
  if (LOCALHOST_HOSTNAMES.has(canonicalHost)) return null;
  // On-box loopback traffic is already on the right host — leave it alone.
  if (LOCALHOST_HOSTNAMES.has(requestHost)) return null;
  if (request.origin === canonical.origin) return null;
  if (requestHost === canonicalHost || requestHost.endsWith(`.${canonicalHost}`)) {
    return null;
  }

  const cookieZone = normalizeHost(cookieDomain);
  if (cookieZone && (requestHost === cookieZone || requestHost.endsWith(`.${cookieZone}`))) {
    return null;
  }

  return `${canonical.origin}${request.pathname}${request.search}`;
}

/**
 * Returns the DNS zone used to map `{sub}.{zone}` hostnames to an organization
 * slug. Prefers AUTH_COOKIE_DOMAIN (e.g. `.lobu.ai`) so per-org subdomains like
 * `acme.lobu.ai` resolve even when PUBLIC_GATEWAY_URL points at a non-apex canonical
 * host like `app.lobu.ai`. Falls back to the configured origin's hostname so
 * deployments without a cookie zone still get subdomain extraction for
 * `{sub}.{canonicalHost}`.
 */
export function getSubdomainZone(
  configuredOrigin = getConfiguredPublicOrigin(),
  cookieDomain = process.env.AUTH_COOKIE_DOMAIN
): string | null {
  const cookieZone = normalizeHost(cookieDomain);
  if (cookieZone) return cookieZone;

  if (!configuredOrigin) return null;
  try {
    return normalizeHost(new URL(configuredOrigin).hostname);
  } catch {
    return null;
  }
}

/**
 * Returns the zone explicitly configured for cross-host organization routing.
 * Unlike getSubdomainZone(), this never falls back to PUBLIC_GATEWAY_URL:
 * path-based deployments also configure a public origin.
 */
export function getConfiguredSubdomainZone(
  cookieDomain = process.env.AUTH_COOKIE_DOMAIN
): string | null {
  const zone = normalizeHost(cookieDomain);
  return zone && isSubdomainCapableHost(zone) ? zone : null;
}

/** False for loopback names and IP literals, which cannot carry subdomains. */
function isSubdomainCapableHost(host: string): boolean {
  if (LOCALHOST_HOSTNAMES.has(host)) return false;
  // IPv4 dotted-quad, or the bracketed/colon forms of IPv6.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':') || host.startsWith('[')) return false;
  return true;
}

/**
 * Subdomains that are infrastructure, never organization slugs. Single
 * canonical list shared by the gateway middleware and auth org resolution;
 * the SPA carries its own copy, kept in sync by
 * subdomain-reserved-parity.test.ts. Additions here must land there too.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'mcp',
  'static',
  'assets',
  'cdn',
  'docs',
  'mail',
]);

/**
 * Extracts the org slug from a Host header for `{org}.{zone}` requests.
 * Reserved subdomains (www, api, app, etc.) are skipped so infra hostnames are
 * not mistaken for org slugs. Returns null when the host does not belong to the
 * zone, is the bare zone, or is a reserved/multi-label subdomain.
 */
export function extractSubdomainOrg(
  host: string | undefined | null,
  zone: string | null | undefined,
  reservedSubdomains: ReadonlySet<string>
): string | null {
  const normalizedHost = normalizeHost(host);
  const normalizedZone = normalizeHost(zone);
  if (!normalizedHost || !normalizedZone) return null;
  if (!normalizedHost.endsWith(`.${normalizedZone}`)) return null;

  const sub = normalizedHost.slice(0, -(normalizedZone.length + 1));
  if (!sub || sub.includes('.') || reservedSubdomains.has(sub)) return null;
  return sub;
}
