import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildMcpBearerChallenge,
  canonicalizeMcpResource,
  getMcpResourceForRequest,
  getProtectedResourceMetadataUrl,
  publicMcpRequestUrl,
} from '../../auth/oauth/resource-indicator.js';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin.js';

const originalPublicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;
const originalAuthCookieDomain = process.env.AUTH_COOKIE_DOMAIN;

beforeEach(() => {
  process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
  delete process.env.AUTH_COOKIE_DOMAIN;
  __resetPublicOriginCachesForTests();
});

afterEach(() => {
  if (originalPublicGatewayUrl === undefined) {
    delete process.env.PUBLIC_GATEWAY_URL;
  } else {
    process.env.PUBLIC_GATEWAY_URL = originalPublicGatewayUrl;
  }
  if (originalAuthCookieDomain === undefined) delete process.env.AUTH_COOKIE_DOMAIN;
  else process.env.AUTH_COOKIE_DOMAIN = originalAuthCookieDomain;
  __resetPublicOriginCachesForTests();
});

describe('MCP OAuth resource indicators', () => {
  test('canonicalizes only the root or one org-scoped MCP path', () => {
    const requestUrl = 'https://app.lobu.ai/mcp/acme';

    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme/', requestUrl)).toBe(
      'https://app.lobu.ai/mcp/acme'
    );
    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme/tools', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://evil.example/mcp/acme', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://app.lobu.ai/mcp/acme?admin=1', requestUrl)).toBeNull();
  });

  test('builds an exact path-specific protected-resource challenge', () => {
    const requestUrl = 'https://app.lobu.ai/mcp/acme';

    expect(getProtectedResourceMetadataUrl(requestUrl)).toBe(
      'https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme'
    );
    expect(buildMcpBearerChallenge(requestUrl, 'invalid_token')).toBe(
      'Bearer resource_metadata="https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme", scope="mcp:read mcp:write profile:read", error="invalid_token"'
    );
  });

  test('escapes challenge values and advertises the exact missing scope', () => {
    expect(
      buildMcpBearerChallenge('https://app.lobu.ai/mcp/acme', {
        error: 'insufficient_scope',
        errorDescription: 'Expired "access" \\ token',
        scope: 'mcp:admin',
      })
    ).toBe(
      'Bearer resource_metadata="https://app.lobu.ai/.well-known/oauth-protected-resource/mcp/acme", scope="mcp:admin profile:read", error="insufficient_scope", error_description="Expired \\"access\\" \\\\ token"'
    );
  });


  test('accepts the hosted MCP resource across the explicitly configured Lobu zone', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBe('https://lobu.ai/mcp');
    expect(
      canonicalizeMcpResource('https://acme.lobu.ai/mcp/acme', 'https://app.lobu.ai/oauth/token')
    ).toBe('https://acme.lobu.ai/mcp/acme');
    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://evil.example/oauth/authorize')
    ).toBeNull();
  });

  test('rejects cross-origin MCP resources when no explicit zone authorizes them', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    delete process.env.AUTH_COOKIE_DOMAIN;
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBeNull();
    expect(
      canonicalizeMcpResource('https://evil.example/mcp', 'https://app.lobu.ai/oauth/authorize')
    ).toBeNull();
    expect(
      canonicalizeMcpResource('https://evil.example/mcp', 'https://evil.example/oauth/authorize')
    ).toBeNull();
  });

  test('rejects port, credential, and scheme changes even inside the configured zone', () => {
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();
    const requestUrl = 'https://app.lobu.ai/oauth/authorize';

    expect(canonicalizeMcpResource('https://lobu.ai:444/mcp', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('http://lobu.ai/mcp', requestUrl)).toBeNull();
    expect(canonicalizeMcpResource('https://user@lobu.ai/mcp', requestUrl)).toBeNull();
  });

  test('uses the canonical origin embedded in an already-public request URL', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('https://lobu.ai/mcp/acme', 'https://lobu.ai/mcp/acme')
    ).toBe('https://lobu.ai/mcp/acme');
    expect(getProtectedResourceMetadataUrl('https://lobu.ai/mcp/acme')).toBe(
      'https://lobu.ai/.well-known/oauth-protected-resource/mcp/acme'
    );
  });

  test('accepts same-origin IPv6 resources without treating the port separator as a host delimiter', () => {
    delete process.env.PUBLIC_GATEWAY_URL;
    __resetPublicOriginCachesForTests();

    expect(
      canonicalizeMcpResource('http://[::1]:8787/mcp', 'http://[::1]:8787/oauth/authorize')
    ).toBe('http://[::1]:8787/mcp');
  });

  test('publicMcpRequestUrl prefers the MCP request host over PUBLIC_GATEWAY_URL', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://lobu.ai/mcp', {
      headers: {
        host: 'lobu.ai',
        'x-forwarded-host': 'lobu.ai',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://lobu.ai/mcp');
    expect(buildMcpBearerChallenge(publicMcpRequestUrl(request))).toContain(
      'resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource/mcp"'
    );
  });

  test('publicMcpRequestUrl rejects an unconfigured forwarded host', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://app.lobu.ai/oauth/authorize', {
      headers: {
        host: 'app.lobu.ai',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://app.lobu.ai/oauth/authorize');
  });

  test('publicMcpRequestUrl uses the request origin when only the configured zone is trusted', () => {
    delete process.env.PUBLIC_GATEWAY_URL;
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://lobu.ai/mcp', {
      headers: {
        host: 'lobu.ai',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://lobu.ai/mcp');
  });

  // Prod chain: only `x-forwarded-for-origin` survives the edge → Traefik hop
  // (see `forwardedPublicOrigin`), so the audience check must resolve the same
  // origin the client called — otherwise a token bound to `https://lobu.ai/mcp`
  // is compared against `https://app.lobu.ai/mcp` and every MCP call 401s.
  test('publicMcpRequestUrl honours x-forwarded-for-origin when a proxy rewrote the forwarded host', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://app.lobu.ai/mcp', {
      headers: {
        host: 'app.lobu.ai',
        'x-forwarded-host': 'app.lobu.ai',
        'x-forwarded-for-origin': 'https://lobu.ai',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://lobu.ai/mcp');
    // The resource the audience check compares the token's `resource` against.
    expect(getMcpResourceForRequest(publicMcpRequestUrl(request))).toBe('https://lobu.ai/mcp');
    expect(buildMcpBearerChallenge(publicMcpRequestUrl(request))).toContain(
      'resource_metadata="https://lobu.ai/.well-known/oauth-protected-resource/mcp"'
    );
  });

  test('publicMcpRequestUrl rejects an x-forwarded-for-origin outside the trusted zone', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    // `file:///` parses but yields the opaque origin string `null`, which is
    // not itself a URL — it must be rejected, not thrown on. The trailing four
    // cover the bare-origin guard (path/query/fragment) and the port arm, so
    // removing either check fails here rather than silently widening what the
    // audience comparison will accept.
    for (const spoofed of [
      'https://evil.example',
      'not-a-url',
      'http://lobu.ai',
      'file:///',
      'https://lobu.ai/mcp',
      'https://lobu.ai?x=1',
      'https://lobu.ai#f',
      'https://lobu.ai:444',
    ]) {
      const request = new Request('https://app.lobu.ai/mcp', {
        headers: {
          host: 'app.lobu.ai',
          'x-forwarded-host': 'app.lobu.ai',
          'x-forwarded-for-origin': spoofed,
          'x-forwarded-proto': 'https',
        },
      });
      expect(publicMcpRequestUrl(request)).toBe('https://app.lobu.ai/mcp');
    }
  });

  // Tenant orgs are subdomains of this same zone, so admitting the whole zone
  // would let any caller reaching the pod directly present a sibling org's host
  // and pass the audience check for a token bound to it. Only the apex host the
  // edge worker actually fronts is accepted.
  test('publicMcpRequestUrl rejects an in-zone sibling host in x-forwarded-for-origin', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://app.lobu.ai/mcp', {
      headers: {
        host: 'app.lobu.ai',
        'x-forwarded-for-origin': 'https://buremba.lobu.ai',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://app.lobu.ai/mcp');
  });

  test('publicMcpRequestUrl falls back when a forwarded proto yields an opaque origin', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    process.env.AUTH_COOKIE_DOMAIN = '.lobu.ai';
    __resetPublicOriginCachesForTests();

    const request = new Request('https://app.lobu.ai/mcp', {
      headers: {
        host: 'app.lobu.ai',
        'x-forwarded-host': 'lobu.ai',
        'x-forwarded-proto': 'file',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://app.lobu.ai/mcp');
  });

  test('publicMcpRequestUrl ignores x-forwarded-for-origin when no zone is configured', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://app.lobu.ai/lobu';
    delete process.env.AUTH_COOKIE_DOMAIN;
    __resetPublicOriginCachesForTests();

    const request = new Request('https://app.lobu.ai/mcp', {
      headers: {
        host: 'app.lobu.ai',
        'x-forwarded-host': 'app.lobu.ai',
        'x-forwarded-for-origin': 'https://lobu.ai',
        'x-forwarded-proto': 'https',
      },
    });
    expect(publicMcpRequestUrl(request)).toBe('https://app.lobu.ai/mcp');
  });
});
