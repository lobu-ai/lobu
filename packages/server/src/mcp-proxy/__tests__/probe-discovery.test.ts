import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
  addUserToOrganization,
  seedSystemEntityTypes,
} from '../../__tests__/setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { installConnectorFromMcpUrl } from '../../catalog/connector-definitions';
import { createAuthProfile } from '../../utils/auth-profiles';
import { resolveCredentialsByConnectionId } from '../credential-resolver';

import {
  callTool,
  discoverTools,
  probeMcpServer,
  registerMcpOAuthClient,
} from '../client';
import { MCP_REQUEST_BODY_LIMIT } from '../http-response';

const jsonResponse = (body: unknown, sessionId?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
  });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function createMcpTestConnection(connectorKey: string): Promise<{
  connectionId: number;
  organizationId: string;
}> {
  const organization = await createTestOrganization();
  await createTestConnectorDefinition({
    key: connectorKey,
    name: `MCP test ${connectorKey}`,
    organization_id: organization.id,
  });
  const connection = await createTestConnection({
    organization_id: organization.id,
    connector_key: connectorKey,
    createDefaultFeed: false,
  });
  return { connectionId: connection.id, organizationId: organization.id };
}

const OPTIONAL_OAUTH_UPSTREAM = 'https://mcp.example.com/mcp';

/**
 * A remote MCP server that answers initialize anonymously (a free tier) while
 * publishing RFC 9728 protected-resource metadata for signed-in access.
 */
function mockOptionalOAuthServer(options?: {
  pathMetadata?: boolean;
  rootMetadata?: boolean;
  resource?: string;
  tokenEndpointAuthMethods?: string[];
}): typeof fetch {
  const resourceMetadata = {
    resource: options?.resource ?? OPTIONAL_OAUTH_UPSTREAM,
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['mcp:tools'],
    bearer_methods_supported: ['header'],
  };
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href === OPTIONAL_OAUTH_UPSTREAM) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'optional-oauth', version: '1.0.0' },
            },
          },
          'anon-session'
        );
      }
      if (body.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [{ name: 'web_search', inputSchema: { type: 'object' } }] },
        });
      }
      return new Response(null, { status: 202 });
    }
    if (href === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
      return options?.pathMetadata === false
        ? new Response('not found', { status: 404 })
        : jsonResponse(resourceMetadata);
    }
    if (href === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
      return options?.rootMetadata === false
        ? new Response('<html>not found</html>', { status: 404 })
        : jsonResponse(resourceMetadata);
    }
    if (href === 'https://auth.example.com/.well-known/oauth-authorization-server') {
      return jsonResponse({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        registration_endpoint: 'https://auth.example.com/oauth/register',
        token_endpoint_auth_methods_supported: options?.tokenEndpointAuthMethods ?? ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:tools'],
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('installConnectorFromMcpUrl auth schema', () => {
  it('offers optional OAuth beside anonymous access when the server advertises it', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = mockOptionalOAuthServer();
    const organization = await createTestOrganization();

    const installed = await installConnectorFromMcpUrl({
      organizationId: organization.id,
      mcpUrl: OPTIONAL_OAUTH_UPSTREAM,
    });

    expect(installed.authSchema).toEqual({
      methods: [
        expect.objectContaining({
          type: 'oauth',
          provider: 'mcp.optional-oauth',
          required: false,
          requiredScopes: ['mcp:tools'],
          authorizationUrl: 'https://auth.example.com/oauth/authorize',
          tokenUrl: 'https://auth.example.com/oauth/token',
          tokenEndpointAuthMethod: 'none',
          usePkce: true,
          resource: OPTIONAL_OAUTH_UPSTREAM,
        }),
        { type: 'none' },
      ],
    });
    expect(installed.mcpOAuth?.registrationUrl).toBe('https://auth.example.com/oauth/register');
  });

  it('keeps OAuth required when initialize demands it', async () => {
    const upstreamUrl = 'https://mcp.example.com/locked';
    const resourceMetadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/locked';
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === upstreamUrl) {
        return new Response('{}', {
          status: 401,
          headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` },
        });
      }
      if (href === resourceMetadataUrl) {
        return jsonResponse({
          resource: upstreamUrl,
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['mcp:tools'],
        });
      }
      if (href === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const organization = await createTestOrganization();

    const installed = await installConnectorFromMcpUrl({
      organizationId: organization.id,
      mcpUrl: upstreamUrl,
    });

    expect(installed.authSchema).toEqual({
      methods: [expect.objectContaining({ type: 'oauth', required: true })],
    });
  });
});

describe('probeMcpServer capability discovery', () => {
  it('blocks a hostname that resolves to loopback before opening an upstream socket', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);

    await expect(probeMcpServer('https://rebind.example/rpc')).rejects.toThrow(
      /private\/internal address/i
    );
  });

  it('fails closed when any address in a DNS answer set is private', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);

    await expect(probeMcpServer('https://mixed-dns.example/rpc')).rejects.toThrow(
      /private\/internal address/i
    );
  });

  it('discovers OAuth metadata when initialize returns a protected-resource challenge', async () => {
    const upstreamUrl = 'https://mcp.example.com/rpc';
    const resourceMetadataUrl =
      'https://mcp.example.com/.well-known/oauth-protected-resource/rpc';
    const authorizationServer = 'https://auth.example.com/tenant';
    const authorizationMetadataUrl =
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant';

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === upstreamUrl) {
        return new Response(
          JSON.stringify({ error: 'invalid_token' }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}", scope="read:issues write:issues", error="invalid_token"`,
            },
          }
        );
      }
      if (href === resourceMetadataUrl) {
        return jsonResponse({
          resource: upstreamUrl,
          authorization_servers: [authorizationServer],
          scopes_supported: ['read:issues', 'write:issues', 'offline_access'],
        });
      }
      if (href === authorizationMetadataUrl) {
        return jsonResponse({
          issuer: authorizationServer,
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const result = await probeMcpServer(upstreamUrl);
    expect(result).toMatchObject({
      serverInfo: { name: 'mcp.example.com', version: '0.0.0' },
      tools: [],
      oauth: {
        resource: upstreamUrl,
        resourceMetadataUrl,
        authorizationServer,
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        registrationUrl: 'https://auth.example.com/register',
        challengeScopes: ['read:issues', 'write:issues'],
        scopesSupported: ['read:issues', 'write:issues', 'offline_access'],
        tokenEndpointAuthMethodsSupported: ['none'],
        codeChallengeMethodsSupported: ['S256'],
      },
    });
  });

  it('discovers advertised OAuth on a server that also answers anonymously', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = mockOptionalOAuthServer();

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.anonymousAccess).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(['web_search']);
    expect(result.oauth).toMatchObject({
      resource: OPTIONAL_OAUTH_UPSTREAM,
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      authorizationServer: 'https://auth.example.com',
      authorizationUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      registrationUrl: 'https://auth.example.com/oauth/register',
      scopesSupported: ['mcp:tools'],
    });
  });

  it('falls back to the root protected-resource metadata URL', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = mockOptionalOAuthServer({ pathMetadata: false });

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.oauth?.resourceMetadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource'
    );
  });

  it.each(['/mcp/', '/mcp?tenant=test', '/?tenant=test'])(
    'preserves the resource path and query in discovery for %s',
    async (suffix) => {
      const upstreamUrl = `https://mcp.example.com${suffix}`;
      const metadataSuffix = suffix.startsWith('/?') ? suffix.slice(1) : suffix;
      const metadataUrl = `https://mcp.example.com/.well-known/oauth-protected-resource${metadataSuffix}`;
      const optionalServer = mockOptionalOAuthServer({ resource: upstreamUrl });
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === upstreamUrl) return optionalServer(OPTIONAL_OAUTH_UPSTREAM, init);
        if (String(url) === metadataUrl) {
          return optionalServer('https://mcp.example.com/.well-known/oauth-protected-resource/mcp', init);
        }
        if (new URL(String(url)).hostname === 'mcp.example.com') {
          return new Response('not found', { status: 404 });
        }
        return optionalServer(url, init);
      }) as typeof fetch;

      const result = await probeMcpServer(upstreamUrl);

      expect(result.oauth?.resourceMetadataUrl).toBe(metadataUrl);
      expect(result.anonymousAccess).toBe(true);
    }
  );

  it('keeps anonymous access when advertised OAuth has no supported client authentication', async () => {
    globalThis.fetch = mockOptionalOAuthServer({ tokenEndpointAuthMethods: ['private_key_jwt'] });

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.oauth).toBeUndefined();
    expect(result.anonymousAccess).toBe(true);
    expect(result.tools.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('keeps an anonymous server without protected-resource metadata OAuth-free', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = mockOptionalOAuthServer({ pathMetadata: false, rootMetadata: false });

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.anonymousAccess).toBe(true);
    expect(result.oauth).toBeUndefined();
    expect(result.tools.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('falls back to root metadata when a catch-all route returns HTML', async () => {
    const optionalServer = mockOptionalOAuthServer();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
        ? new Response('<html>home</html>', { headers: { 'Content-Type': 'text/html' } })
        : optionalServer(url, init)) as typeof fetch;

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.oauth?.resourceMetadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource'
    );
  });

  it('finds well-known metadata for a 401 challenge that omits resource_metadata', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    const optionalServer = mockOptionalOAuthServer();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === OPTIONAL_OAUTH_UPSTREAM
        ? new Response('{}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
        : optionalServer(url, init)) as typeof fetch;

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.anonymousAccess).toBe(false);
    expect(result.oauth?.resourceMetadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('ignores advertised metadata whose resource names a different server', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as Awaited<ReturnType<typeof dns.lookup>>);
    globalThis.fetch = mockOptionalOAuthServer({ resource: 'https://other.example.com/mcp' });

    const result = await probeMcpServer(OPTIONAL_OAUTH_UPSTREAM);

    expect(result.oauth).toBeUndefined();
    expect(result.tools.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('accepts SSE JSON-RPC responses and an empty 202 initialized notification', async () => {
    const requests: Array<{ accept: string | null; method: unknown }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        accept: new Headers(init?.headers).get('accept'),
        method: body.method,
      });
      if (body.method === 'initialize') {
        return new Response(
          [
            'event: message',
            'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
            '',
            'event: message',
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'sse-server', version: '1.0.0' },
              },
            })}`,
            '',
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Mcp-Session-Id': 'sse-session',
            },
          }
        );
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (body.method === 'tools/list') {
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'read_issue', inputSchema: { type: 'object' } }] },
          })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      throw new Error(`Unexpected method: ${String(body.method)}`);
    }) as typeof fetch;

    const result = await probeMcpServer('https://mcp.example.com/rpc');

    expect(result.tools.map((tool) => tool.name)).toEqual(['read_issue']);
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(requests.every((request) => request.accept === 'application/json, text/event-stream')).toBe(
      true
    );
  });

  it('accepts a truly toolless server without calling tools/list', async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ headers: new Headers(init?.headers), body });
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { resources: {} },
              serverInfo: { name: 'toolless', version: '1.0.0' },
            },
          },
          'session-1'
        );
      }
      return jsonResponse({});
    }) as typeof fetch;

    const result = await probeMcpServer('https://mcp.example.com/rpc');
    expect(result.tools).toEqual([]);
    expect(requests.map((request) => request.body.method)).not.toContain('tools/list');
    expect(requests[1]?.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL_VERSION);
  });

  it('fails closed when a server advertises tools but tools/list fails', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'broken-tools', version: '1.0.0' },
            },
          },
          'session-2'
        );
      }
      if (body.method === 'tools/list') {
        return new Response('upstream unavailable', { status: 503 });
      }
      return jsonResponse({});
    }) as typeof fetch;

    await expect(probeMcpServer('https://mcp.example.com/rpc')).rejects.toThrow(
      /MCP server returned 503/
    );
  });

  it('fails closed when a server advertises tools but omits the tools array', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'malformed-tools', version: '1.0.0' },
            },
          },
          'session-3'
        );
      }
      if (body.method === 'tools/list') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
      }
      return jsonResponse({});
    }) as typeof fetch;

    await expect(probeMcpServer('https://mcp.example.com/rpc')).rejects.toThrow(
      /MCP tools\/list response omitted tools/
    );
  });
});

describe('MCP OAuth dynamic client registration', () => {
  const metadata = {
    resource: 'https://mcp.example.com/rpc',
    resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/rpc',
    authorizationServer: 'https://auth.example.com/tenant',
    authorizationUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    registrationUrl: 'https://auth.example.com/register',
    scopesSupported: ['read:issues', 'write:issues', 'offline_access'],
    tokenEndpointAuthMethodsSupported: ['none'],
    codeChallengeMethodsSupported: ['S256'],
  };

  it('registers a public PKCE client with the Lobu callback', async () => {
    let registrationBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        client_id: 'registered-client',
        token_endpoint_auth_method: 'none',
      });
    }) as typeof fetch;

    await expect(
      registerMcpOAuthClient({
        metadata,
        redirectUris: ['http://127.0.0.1:8787/connect/oauth/callback'],
        clientName: 'Lobu',
      })
    ).resolves.toEqual({
      clientId: 'registered-client',
      tokenEndpointAuthMethod: 'none',
    });
    expect(registrationBody).toEqual({
      client_name: 'Lobu',
      redirect_uris: ['http://127.0.0.1:8787/connect/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read:issues write:issues offline_access',
    });
  });

  it('prefers the authorization challenge scope over the server-wide catalog', async () => {
    let registrationBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        client_id: 'least-privilege-client',
        token_endpoint_auth_method: 'none',
      });
    }) as typeof fetch;

    await registerMcpOAuthClient({
      metadata: { ...metadata, challengeScopes: ['read:issues'] },
      redirectUris: ['https://lobu.example.com/connect/oauth/callback'],
      clientName: 'Lobu',
    });

    expect(registrationBody).toMatchObject({ scope: 'read:issues' });
  });

  it('rejects a non-HTTPS callback that is not loopback before registration', async () => {
    globalThis.fetch = vi.fn();

    await expect(
      registerMcpOAuthClient({
        metadata,
        redirectUris: ['http://lobu.example.com/connect/oauth/callback'],
        clientName: 'Lobu',
      })
    ).rejects.toThrow(/HTTPS or HTTP on a loopback host/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized generated DCR body before fetch', async () => {
    globalThis.fetch = vi.fn();

    await expect(
      registerMcpOAuthClient({
        metadata,
        redirectUris: ['https://lobu.example.com/connect/oauth/callback'],
        clientName: 'x'.repeat(MCP_REQUEST_BODY_LIMIT),
      }),
    ).rejects.toMatchObject({ kind: 'oversized_request' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('discoverTools capability discovery', () => {
  it('fails closed when an installed connector omits the negotiated tools array', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          },
          'session-4'
        );
      }
      if (body.method === 'tools/list') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    await expect(
      discoverTools(
        'malformed-tools-array',
        {
          upstream_url: 'https://mcp.example.com/rpc',
          tool_prefix: 'malformed',
        },
        'test-org-malformed-tools'
      )
    ).rejects.toThrow(/MCP tools\/list response omitted tools/);
  });

  it('isolates discovery sessions and caches by connection', async () => {
    const organization = await createTestOrganization();
    await createTestConnectorDefinition({
      key: 'account-scoped',
      name: 'Account-scoped MCP test',
      organization_id: organization.id,
    });
    const firstConnection = await createTestConnection({
      organization_id: organization.id,
      connector_key: 'account-scoped',
      createDefaultFeed: false,
    });
    const secondConnection = await createTestConnection({
      organization_id: organization.id,
      connector_key: 'account-scoped',
      createDefaultFeed: false,
    });
    let issuedSessions = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      if (body.method === 'initialize') {
        issuedSessions += 1;
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          },
          `account-session-${issuedSessions}`
        );
      }
      if (body.method === 'tools/list') {
        const sessionId = headers.get('mcp-session-id') ?? 'missing-session';
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [{ name: sessionId.replace(/\W+/g, '_'), inputSchema: { type: 'object' } }],
          },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const config = {
      upstream_url: 'https://mcp.example.com/account-scoped',
      tool_prefix: 'account',
    };
    const first = await discoverTools(
      'account-scoped',
      config,
      organization.id,
      firstConnection.id
    );
    const second = await discoverTools(
      'account-scoped',
      config,
      organization.id,
      secondConnection.id
    );

    expect(first.map((tool) => tool.originalName)).toEqual(['account_session_1']);
    expect(second.map((tool) => tool.originalName)).toEqual(['account_session_2']);
    expect(issuedSessions).toBe(2);
  });
});

describe('optional MCP OAuth connections', () => {
  it('lists tools anonymously and with the signed-in bearer per connection', async () => {
    const sql = getTestDb();
    const organization = await createTestOrganization();
    const owner = await createTestUser({ email: `optional-oauth-${organization.id}@example.com` });
    await addUserToOrganization(owner.id, organization.id, 'owner');
    const connectorKey = 'mcp.optional-oauth';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Optional OAuth MCP',
      organization_id: organization.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: connectorKey,
            required: false,
            requiredScopes: ['mcp:tools'],
            authorizationUrl: 'https://auth.example.com/oauth/authorize',
            tokenUrl: 'https://auth.example.com/oauth/token',
            tokenEndpointAuthMethod: 'none',
            usePkce: true,
            clientIdKey: 'MCP_CLIENT_ID',
            clientSecretKey: 'MCP_CLIENT_SECRET',
            resource: OPTIONAL_OAUTH_UPSTREAM,
          },
          { type: 'none' },
        ],
      },
    });
    const anonymous = await createTestConnection({
      organization_id: organization.id,
      connector_key: connectorKey,
      createDefaultFeed: false,
    });
    const signedIn = await createTestConnection({
      organization_id: organization.id,
      connector_key: connectorKey,
      createDefaultFeed: false,
      visibility: 'private',
    });
    const appProfile = await createAuthProfile({
      organizationId: organization.id,
      connectorKey,
      displayName: 'Optional OAuth App',
      profileKind: 'oauth_app',
      provider: connectorKey,
      authData: { MCP_CLIENT_ID: 'dynamic-client-id' },
    });
    const accountId = `acct_optional_${organization.id}`;
    await sql`
      INSERT INTO "account" (
        id, "accountId", "providerId", "userId",
        "accessToken", "accessTokenExpiresAt", scope, "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, ${connectorKey}, ${owner.id},
        ${'signed-in-token'}, ${new Date(Date.now() + 86_400_000).toISOString()},
        'mcp:tools', NOW(), NOW()
      )
    `;
    const accountProfile = await createAuthProfile({
      organizationId: organization.id,
      connectorKey,
      displayName: 'Optional OAuth Account',
      profileKind: 'oauth_account',
      provider: connectorKey,
      accountId,
    });
    await sql`
      UPDATE connections
      SET auth_profile_id = ${accountProfile.id}, app_auth_profile_id = ${appProfile.id}
      WHERE id = ${signedIn.id}
    `;

    const authorizations: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const authorization = new Headers(init?.headers).get('authorization');
      authorizations.push(authorization);
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: 0,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
          },
          authorization ? 'signed-in-session' : 'anon-session'
        );
      }
      if (body.method === 'tools/list') {
        const names = authorization === 'Bearer signed-in-token'
          ? ['web_search', 'deep_research']
          : ['web_search'];
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) },
        });
      }
      return new Response(null, { status: 202 });
    }) as typeof fetch;

    const config = { upstream_url: OPTIONAL_OAUTH_UPSTREAM, tool_prefix: 'optional' };
    const anonymousTools = await discoverTools(connectorKey, config, organization.id, anonymous.id);
    const anonymousAuthorizations = authorizations.splice(0);
    const signedInTools = await discoverTools(connectorKey, config, organization.id, signedIn.id);

    expect(anonymousTools.map((tool) => tool.originalName)).toEqual(['web_search']);
    expect(anonymousAuthorizations.every((value) => value === null)).toBe(true);
    expect(signedInTools.map((tool) => tool.originalName)).toEqual(['web_search', 'deep_research']);
    expect(authorizations.every((value) => value === 'Bearer signed-in-token')).toBe(true);
  });
});

describe('callTool session recovery', () => {
  const config = {
    upstream_url: 'https://mcp.example.com/rpc',
    tool_prefix: 'recovery',
  };

  /** initialize → session id + negotiated protocol version. */
  const initializeResponse = (sessionId: string) =>
    jsonResponse(
      {
        jsonrpc: '2.0',
        id: 0,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
        },
      },
      sessionId
    );

  it('does not replay a tools/call when the upstream rejects a cached session id', async () => {
    const { connectionId, organizationId } = await createMcpTestConnection('recovery-connector');
    const sent: Array<{ method: unknown; sessionId: string | null }> = [];
    const expired = new Set<string>();
    let issued = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const sessionId = new Headers(init?.headers).get('mcp-session-id');
      sent.push({ method: body.method, sessionId });
      if (body.method === 'initialize') {
        issued += 1;
        return initializeResponse(`session-live-${issued}`);
      }
      // MCP Streamable HTTP requires a 404 for a session id the upstream no
      // longer knows. The gateway cannot prove the tool did not execute across
      // that transport boundary, so replay is forbidden.
      if (sessionId && expired.has(sessionId)) {
        return new Response('Session not found', { status: 404 });
      }
      if (body.method === 'tools/call') {
        // The upstream drops the session right after answering, so the next
        // call arrives with a cached id it no longer recognizes.
        if (sessionId) expired.add(sessionId);
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'ok' }], isError: false },
        });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    const first = await callTool(
      'recovery-connector',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    );
    expect(first.isError).toBe(false);

    await expect(callTool(
      'recovery-connector',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    )).rejects.toThrow(/Upstream MCP returned 404/);
    expect(sent.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
    expect(sent.filter((entry) => entry.method === 'tools/call')).toHaveLength(2);
  });

  it('never replays a tools/call after an ambiguous transport failure', async () => {
    const { connectionId, organizationId } = await createMcpTestConnection('ambiguous-connector');
    let toolCalls = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') return initializeResponse('session-ambiguous');
      if (body.method === 'tools/call') {
        toolCalls += 1;
        // The upstream may have executed the action before the response was
        // lost, so this must surface rather than re-run the side effect.
        return new Response('gateway timeout', { status: 504 });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    await expect(
      callTool('ambiguous-connector', config, organizationId, 'charge_card', {}, connectionId)
    ).rejects.toThrow(/Upstream MCP returned 504/);
    expect(toolCalls).toBe(1);
  });

  it('invalidates a JSON-RPC session error without replaying the tool call', async () => {
    const { connectionId, organizationId } = await createMcpTestConnection('json-session-connector');
    let initializations = 0;
    let toolCalls = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        initializations += 1;
        return initializeResponse(`session-json-${initializations}`);
      }
      if (body.method === 'tools/call') {
        toolCalls += 1;
        return toolCalls === 1
          ? jsonResponse({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: 'Session not found' },
            })
          : jsonResponse({
              jsonrpc: '2.0',
              id: 1,
              result: { content: [{ type: 'text', text: 'ok' }], isError: false },
            });
      }
      return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
    }) as typeof fetch;

    const first = await callTool(
      'json-session-connector',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    );
    expect(first).toEqual({
      content: [{ type: 'text', text: 'Session not found' }],
      isError: true,
    });
    expect(initializations).toBe(1);
    expect(toolCalls).toBe(1);

    const second = await callTool(
      'json-session-connector',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    );
    expect(second).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
    expect(initializations).toBe(2);
    expect(toolCalls).toBe(2);
  });
});

describe('MCP refresh-on-401 (dead access token)', () => {
  const config = {
    upstream_url: 'https://mcp.example.com/rpc',
    tool_prefix: 'refresh',
  };

  async function seedOAuthMcpConnection(): Promise<{
    connectionId: number;
    organizationId: string;
  }> {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const sql = getTestDb();
    const organization = await createTestOrganization({ name: 'Refresh MCP Org' });
    const owner = await createTestUser({ name: 'Refresh MCP Owner', email: 'refresh@example.com' });
    await addUserToOrganization(owner.id, organization.id, 'owner');

    const connectorKey = 'mcp.refresh-demo';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Refresh Demo MCP',
      organization_id: organization.id,
      auth_schema: {
        methods: [
          {
            type: 'oauth',
            provider: 'demo',
            requiredScopes: ['read'],
            authorizationUrl: 'https://demo.example/authorize',
            tokenUrl: 'https://demo.example/oauth/token',
            tokenEndpointAuthMethod: 'client_secret_post',
            clientIdKey: 'DEMO_CLIENT_ID',
            clientSecretKey: 'DEMO_CLIENT_SECRET',
            resource: 'https://mcp.example.com/rpc',
          },
        ],
      },
    });

    const appProfile = await createAuthProfile({
      organizationId: organization.id,
      connectorKey,
      displayName: 'Demo App',
      profileKind: 'oauth_app',
      provider: 'demo',
      authData: {
        DEMO_CLIENT_ID: 'demo-client-id',
        DEMO_CLIENT_SECRET: 'demo-client-secret',
      },
    });

    // The account holds a token that is NOT expiring soon (revoked upstream)
    // plus a refresh token, exactly the state that used to 401 forever.
    const accountId = `acct_refresh_${organization.id}`;
    const notExpiringSoon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO "account" (
        id, "accountId", "providerId", "userId",
        "accessToken", "refreshToken", "accessTokenExpiresAt",
        scope, "createdAt", "updatedAt"
      ) VALUES (
        ${accountId}, ${accountId}, 'demo', ${owner.id},
        ${'stale-access-token'}, ${'refresh-token-original'}, ${notExpiringSoon},
        'read', NOW(), NOW()
      )
    `;

    const accountProfile = await createAuthProfile({
      organizationId: organization.id,
      connectorKey,
      displayName: 'Demo Account',
      profileKind: 'oauth_account',
      provider: 'demo',
      accountId,
    });

    const connection = await createTestConnection({
      organization_id: organization.id,
      connector_key: connectorKey,
      createDefaultFeed: false,
      visibility: 'private',
    });

    // Bind both profiles to the connection, as the OAuth install flow does.
    await sql`
      UPDATE connections
      SET auth_profile_id = ${accountProfile.id},
          app_auth_profile_id = ${appProfile.id}
      WHERE id = ${connection.id}
    `;

    return { connectionId: connection.id, organizationId: organization.id };
  }

  it('refreshes a revoked access token once and retries the tool call', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();
    let refreshHits = 0;
    let toolCalls = 0;

    const initializeResponse = (sessionId: string) =>
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 0,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        },
        sessionId
      );

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        // The refresh endpoint — asserts it was actually called with the stored
        // refresh token, and returns a fresh token.
        refreshHits += 1;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('refresh_token')).toBe('refresh-token-original');
        return jsonResponse({
          access_token: 'fresh-access-token',
          refresh_token: 'refresh-token-rotated',
          expires_in: 3600,
        });
      }
      if (href === config.upstream_url) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.method === 'initialize') {
          return initializeResponse('session-refresh');
        }
        if (body.method === 'tools/call') {
          toolCalls += 1;
          // First call arrives with the stale token → reject with 401; the
          // refreshed token succeeds.
          if (headers.get('authorization') === 'Bearer stale-access-token') {
            return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
          }
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'ok' }], isError: false },
          });
        }
        return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const result = await callTool(
      'mcp.refresh-demo',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    );

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.isError).toBe(false);
    expect(refreshHits).toBe(1);
    expect(toolCalls).toBe(2); // one rejected + one replayed after refresh
  });

  it('refreshes when the stale token is rejected during initialize', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();
    let refreshHits = 0;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        refreshHits += 1;
        return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
      }
      if (href === config.upstream_url) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') === 'Bearer stale-access-token') {
          return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
        }
        if (body.method === 'initialize') {
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            },
            'session-initialize-refresh'
          );
        }
        if (body.method === 'tools/call') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: 'ok' }], isError: false },
          });
        }
        return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    await expect(
      callTool('mcp.refresh-demo', config, organizationId, 'do_thing', {}, connectionId)
    ).resolves.toMatchObject({ isError: false });
    expect(refreshHits).toBe(1);
  });

  it('does not rotate twice when the refreshed token passes initialize but the tool rejects it', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();
    let refreshHits = 0;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        refreshHits += 1;
        return jsonResponse({ access_token: 'fresh-access-token', expires_in: 3600 });
      }
      if (href === config.upstream_url) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') === 'Bearer stale-access-token') {
          return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
        }
        if (body.method === 'initialize') {
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: 0,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
              },
            },
            'session-single-initialize-refresh'
          );
        }
        if (body.method === 'tools/call') {
          return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
        }
        return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    await expect(
      callTool('mcp.refresh-demo', config, organizationId, 'do_thing', {}, connectionId)
    ).rejects.toThrow(/Upstream MCP returned 401/);
    expect(refreshHits).toBe(1);
  });

  it('does not rotate again when another replica already replaced the rejected token', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();
    let refreshHits = 0;

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== 'https://demo.example/oauth/token') {
        throw new Error(`Unexpected fetch: ${String(url)}`);
      }
      refreshHits += 1;
      return jsonResponse({
        access_token: `fresh-access-token-${refreshHits}`,
        refresh_token: `refresh-token-${refreshHits}`,
        expires_in: 3600,
      });
    }) as typeof fetch;

    const [first, second] = await Promise.all([
      resolveCredentialsByConnectionId(connectionId, organizationId, {
        rejectedAccessToken: 'stale-access-token',
      }),
      resolveCredentialsByConnectionId(connectionId, organizationId, {
        rejectedAccessToken: 'stale-access-token',
      }),
    ]);

    expect(refreshHits).toBe(1);
    expect(first?.accessToken).toBe('fresh-access-token-1');
    expect(second?.accessToken).toBe('fresh-access-token-1');
  });

  it('retries discovery only once when the refreshed token is also rejected', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();
    let refreshHits = 0;
    let initializeHits = 0;

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        refreshHits += 1;
        return jsonResponse({
          access_token: `still-rejected-${refreshHits}`,
          refresh_token: `refresh-token-${refreshHits}`,
          expires_in: 3600,
        });
      }
      if (href === config.upstream_url) {
        initializeHits += 1;
        if (initializeHits > 2) {
          return new Response('unexpected extra retry', { status: 503 });
        }
        return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    await expect(
      discoverTools('mcp.refresh-demo', config, organizationId, connectionId)
    ).rejects.toThrow(/Upstream MCP returned 401/);
    expect(refreshHits).toBe(1);
    expect(initializeHits).toBe(2);
  });

  it('surfaces a 401 when the refresh token is also dead (no infinite retry)', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();

    const initializeResponse = (sessionId: string) =>
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 0,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        },
        sessionId
      );

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      if (href === config.upstream_url) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.method === 'initialize') return initializeResponse('session-dead-refresh');
        if (body.method === 'tools/call') {
          return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
        }
        return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    await expect(
      callTool('mcp.refresh-demo', config, organizationId, 'do_thing', {}, connectionId)
    ).rejects.toThrow(/Upstream MCP returned 401/);
  });

  it('does not refresh or replay when a tools/call gets an ambiguous 404', async () => {
    const { connectionId, organizationId } = await seedOAuthMcpConnection();

    // The first tools/call gets a 404. No recovery initialize or credential
    // refresh is allowed after that side-effecting request boundary.
    const initializeResponse = (sessionId: string) =>
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 0,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        },
        sessionId
      );

    let refreshHits = 0;
    let initializeHits = 0;
    let toolCalls = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://demo.example/oauth/token') {
        refreshHits += 1;
        return jsonResponse({
          access_token: 'fresh-after-session-expiry',
          refresh_token: 'rotated-after-session-expiry',
          expires_in: 3600,
        });
      }
      if (href === config.upstream_url) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.method === 'initialize') {
          initializeHits += 1;
          return initializeResponse(`session-${initializeHits}`);
        }
        if (body.method === 'tools/call') {
          toolCalls += 1;
          return new Response('Session not found', { status: 404 });
        }
        return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    await expect(callTool(
      'mcp.refresh-demo',
      config,
      organizationId,
      'do_thing',
      {},
      connectionId
    )).rejects.toThrow(/Upstream MCP returned 404/);
    expect(refreshHits).toBe(0);
    expect(initializeHits).toBe(1);
    expect(toolCalls).toBe(1);
  });
});
