/**
 * RFC 8707 resource indicators for the MCP endpoints.
 *
 * MCP clients name the exact protected resource they want a token for; the
 * gateway canonicalizes that value so an audience check is a string compare,
 * and advertises the matching RFC 9728 metadata URL in `WWW-Authenticate`.
 */

import {
  getConfiguredPublicOrigin,
  getConfiguredSubdomainZone,
} from '../../utils/public-origin';
import { resolveBaseUrl, safeParseUrl } from '../base-url';
import { DEFAULT_SCOPES_STRING, getMcpConnectionScopes } from './scopes';

/**
 * The request URL as the client sees it: the serving/forwarded origin when it
 * belongs to the configured public host set, else the configured public origin,
 * plus the request path with any trailing slash removed.
 *
 * Every site in this module — the `WWW-Authenticate` challenge, OAuth resource
 * canonicalization, and the per-request audience check — starts here. The OAuth
 * routes may then accept a resource on another host in the configured zone.
 * Resolving the request origin differently at any site would reject a correctly
 * bound token behind a TLS-terminating proxy.
 */
export function publicMcpRequestUrl(request: Request): string {
  // The MCP protected-resource identifier belongs to the resource server, not
  // the authorization server / general web gateway. In production those are
  // intentionally different (`lobu.ai/mcp` vs `app.lobu.ai`). Prefer the
  // actual serving/forwarded host for the MCP request so RFC 9728 metadata and
  // WWW-Authenticate stay bound to the URL the client called.
  const servingOrigin = resolveBaseUrl({ request, skipEnvOverride: true });
  const configuredOrigin = getConfiguredPublicOrigin();
  const origin =
    forwardedPublicOrigin(request) ??
    (isTrustedPublicOrigin(servingOrigin, configuredOrigin)
      ? servingOrigin
      : (configuredOrigin ?? new URL(request.url).origin));
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  return `${origin}${pathname}`;
}

/**
 * Public origin recovered from `x-forwarded-for-origin`.
 *
 * The `lobu.ai` Cloudflare Pages worker proxies `/mcp` to `app.lobu.ai` and
 * sets `x-forwarded-host` AND this header to the host the client actually
 * called. Traefik in front of the pod then overwrites `x-forwarded-host` with
 * its own request host, so only this header survives the hop. Without reading
 * it, a token bound to `https://lobu.ai/mcp` is audience-checked against
 * `https://app.lobu.ai/mcp` and every MCP call 401s — the failure mode this
 * function exists to prevent.
 *
 * A request that skips the edge can set the header itself, so it is accepted
 * only when it names the apex zone host — the one host the edge worker fronts
 * (`lobu.ai/mcp` -> `app.lobu.ai/mcp`). Admitting the whole zone the way the
 * standard forwarded host does would let any caller reaching the pod directly
 * relocate the MCP resource onto a sibling in-zone host and satisfy the RFC
 * 8707 audience check for a token bound to that host. Tenant orgs are
 * themselves subdomains of this zone, so the apex restriction is what keeps
 * audience binding meaningful between them.
 */
function forwardedPublicOrigin(request: Request): string | null {
  const raw = request.headers.get('x-forwarded-for-origin')?.trim();
  const parsed = raw ? safeParseUrl(raw) : null;
  if (!parsed) return null;
  // Origin only: a path, query, or fragment means this is not a bare origin
  // and we should not guess at what the client called.
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  const zone = getConfiguredSubdomainZone();
  if (!zone || parsed.hostname !== zone) return null;
  return isTrustedPublicOrigin(parsed.origin) ? parsed.origin : null;
}

function isTrustedPublicOrigin(
  candidateOrigin: string,
  configuredOrigin = getConfiguredPublicOrigin()
): boolean {
  // Client-supplied headers reach here: `x-forwarded-proto: file` makes
  // `resolveBaseUrl` return the opaque origin string `null`, which is not a
  // parseable URL. Fail closed instead of throwing a 500 on every such call.
  const candidate = safeParseUrl(candidateOrigin);
  if (!candidate) return false;
  const zone = getConfiguredSubdomainZone();
  if (!configuredOrigin) {
    return !zone || candidate.hostname === zone || candidate.hostname.endsWith(`.${zone}`);
  }
  if (candidateOrigin === configuredOrigin) return true;

  const configured = new URL(configuredOrigin);
  if (!zone || candidate.protocol !== configured.protocol || candidate.port !== configured.port) {
    return false;
  }
  return (
    (candidate.hostname === zone || candidate.hostname.endsWith(`.${zone}`)) &&
    (configured.hostname === zone || configured.hostname.endsWith(`.${zone}`))
  );
}

/** Canonical MCP protected-resource URI accepted for OAuth audience binding. */
export function canonicalizeMcpResource(
  rawResource: string | null | undefined,
  requestUrl: string
): string | null {
  if (!rawResource) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawResource);
  } catch {
    return null;
  }
  // The resource server may intentionally use a sibling/parent host from the
  // authorization server (prod: lobu.ai/mcp vs app.lobu.ai/oauth/*). Accept the
  // exact request origin, plus hosts inside the explicitly configured cookie /
  // workspace zone. Never infer a parent domain from hostname text: without an
  // explicit AUTH_COOKIE_DOMAIN, cross-origin resources stay fail-closed.
  const request = new URL(requestUrl);
  const resourceHost = parsed.hostname;
  const requestHost = request.hostname;
  const zone = getConfiguredSubdomainZone();
  const sameOrigin = parsed.origin === request.origin;
  const sameTransport = parsed.protocol === request.protocol && parsed.port === request.port;
  const requestInConfiguredZone = Boolean(
    zone && requestHost && (requestHost === zone || requestHost.endsWith(`.${zone}`))
  );
  const inConfiguredZone = Boolean(
    sameTransport &&
      requestInConfiguredZone &&
      zone &&
      resourceHost &&
      (resourceHost === zone || resourceHost.endsWith(`.${zone}`))
  );
  if (
    !isTrustedPublicOrigin(request.origin) ||
    (!sameOrigin && !inConfiguredZone) ||
    !resourceHost ||
    !requestHost ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/mcp' && !/^\/mcp\/[^/]+$/.test(path)) return null;
  return `${parsed.origin}${path}`;
}

/** The resource URI the incoming request is addressing, if it is an MCP route. */
export function getMcpResourceForRequest(requestUrl: string): string | null {
  const request = new URL(requestUrl);
  return canonicalizeMcpResource(
    `${request.origin}${request.pathname}`,
    requestUrl
  );
}

/** RFC 9728 metadata URL for the resource the request addresses. */
export function getProtectedResourceMetadataUrl(requestUrl: string): string {
  const publicOrigin = new URL(requestUrl).origin;
  const resource = getMcpResourceForRequest(requestUrl);
  if (!resource) return `${publicOrigin}/.well-known/oauth-protected-resource`;
  return `${publicOrigin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
}

export interface McpBearerChallengeOptions {
  error?: 'invalid_token' | 'insufficient_scope' | string;
  errorDescription?: string;
  scope?: string;
}

function quoteChallengeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMcpBearerChallenge(
  requestUrl: string,
  errorOrOptions?: string | McpBearerChallengeOptions
): string {
  const options: McpBearerChallengeOptions =
    typeof errorOrOptions === 'string' ? { error: errorOrOptions } : (errorOrOptions ?? {});
  const scopes = getMcpConnectionScopes(
    (options.scope ?? DEFAULT_SCOPES_STRING).split(/\s+/).filter(Boolean)
  );
  const params = [
    `resource_metadata=${quoteChallengeValue(getProtectedResourceMetadataUrl(requestUrl))}`,
    `scope=${quoteChallengeValue(scopes.join(' '))}`,
  ];
  if (options.error) params.push(`error=${quoteChallengeValue(options.error)}`);
  if (options.errorDescription) {
    params.push(`error_description=${quoteChallengeValue(options.errorDescription)}`);
  }
  return `Bearer ${params.join(', ')}`;
}
