import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import type { Env } from '../../../index';
import { connectRoutes } from '../../../connect/routes';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { manageCatalog } from '../../../tools/admin/manage_catalog';
import { manageOperations } from '../../../tools/admin/manage_operations';
import { __resetPublicOriginCachesForTests } from '../../../utils/public-origin';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;
const upstreamUrl = 'https://mcp.example.com/rpc';
const resourceMetadataUrl =
  'https://mcp.example.com/.well-known/oauth-protected-resource/rpc';
const authorizationServer = 'https://auth.example.com/tenant';
const authorizationMetadataUrl =
  'https://auth.example.com/.well-known/oauth-authorization-server/tenant';
const registrationUrl = 'https://auth.example.com/register';
const originalFetch = globalThis.fetch;
const originalPublicGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OAuth-protected MCP connector installation', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPublicGatewayUrl === undefined) {
      delete process.env.PUBLIC_GATEWAY_URL;
    } else {
      process.env.PUBLIC_GATEWAY_URL = originalPublicGatewayUrl;
    }
    __resetPublicOriginCachesForTests();
    vi.restoreAllMocks();
  });

  it('discovers OAuth, registers one app client, and returns a user consent URL', async () => {
    let registrationCount = 0;
    let registrationBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === upstreamUrl) {
        const headers = new Headers(init?.headers);
        if (headers.get('authorization') === 'Bearer mcp-access-token') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (body.method === 'initialize') {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 0,
                result: {
                  protocolVersion: MCP_PROTOCOL_VERSION,
                  capabilities: { tools: {} },
                  serverInfo: { name: 'Example MCP', version: '1.0.0' },
                },
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/json',
                  'Mcp-Session-Id': 'authenticated-session',
                },
              }
            );
          }
          if (body.method === 'tools/list') {
            return jsonResponse({
              jsonrpc: '2.0',
              id: 1,
              result: {
                tools: [
                  {
                    name: 'get_issue',
                    description: 'Get an issue',
                    inputSchema: { type: 'object', properties: {} },
                    annotations: { readOnlyHint: true },
                  },
                  {
                    name: 'create_issue',
                    description: 'Create an issue',
                    inputSchema: { type: 'object', properties: {} },
                    annotations: { readOnlyHint: false, destructiveHint: true },
                  },
                ],
              },
            });
          }
          return jsonResponse({ jsonrpc: '2.0', id: null, result: {} });
        }
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
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
          registration_endpoint: registrationUrl,
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (href === registrationUrl) {
        registrationCount += 1;
        registrationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          client_id: 'registered-mcp-client',
          token_endpoint_auth_method: 'none',
        });
      }
      if (href === 'https://auth.example.com/token') {
        return jsonResponse({
          access_token: 'mcp-access-token',
          refresh_token: 'mcp-refresh-token',
          expires_in: 3600,
          scope: 'read:issues write:issues offline_access',
          token_type: 'Bearer',
        });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    }) as typeof fetch;

    const { org, ctx } = await seedOwnerContext({
      orgName: 'MCP OAuth Org',
      userName: 'MCP OAuth Owner',
    });
    process.env.PUBLIC_GATEWAY_URL = 'https://gateway.test';
    __resetPublicOriginCachesForTests();
    ctx.baseUrl = 'https://gateway.test';

    const installed = await manageConnections(
      { action: 'install_connector', mcp_url: upstreamUrl },
      TEST_ENV,
      ctx
    );
    expect(installed).toMatchObject({
      action: 'install_connector',
      installed: true,
      connector_key: 'mcp.mcp-example-com',
    });
    expect(registrationCount).toBe(1);
    expect(registrationBody).toMatchObject({
      redirect_uris: ['https://gateway.test/connect/oauth/callback'],
      token_endpoint_auth_method: 'none',
      scope: 'read:issues write:issues offline_access',
    });

    // Reinstalling refreshes metadata but reuses the durable org-level client.
    const reinstalled = await manageConnections(
      { action: 'install_connector', mcp_url: upstreamUrl },
      TEST_ENV,
      ctx
    );
    expect(reinstalled).toMatchObject({
      action: 'install_connector',
      installed: true,
      connector_key: 'mcp.mcp-example-com',
      updated: true,
    });
    expect(registrationCount).toBe(1);

    const sql = getTestDb();
    const [definition] = (await sql`
      SELECT auth_schema, mcp_config
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = 'mcp.mcp-example-com'
        AND status = 'active'
    `) as Array<{
      auth_schema: { methods: Array<Record<string, unknown>> };
      mcp_config: Record<string, unknown>;
    }>;
    expect(definition.mcp_config).toEqual({
      upstream_url: upstreamUrl,
      tool_prefix: 'mcp_example_com',
    });
    expect(definition.auth_schema.methods[0]).toMatchObject({
      type: 'oauth',
      provider: 'mcp.mcp-example-com',
      requiredScopes: ['read:issues', 'write:issues', 'offline_access'],
      tokenEndpointAuthMethod: 'none',
      usePkce: true,
      resource: upstreamUrl,
    });

    const catalog = await manageCatalog(
      { action: 'list_installed', kinds: ['connectors'] },
      TEST_ENV,
      ctx
    );
    const catalogItems = (
      catalog as {
        installed?: { connectors?: { items?: Array<Record<string, unknown>> } };
      }
    ).installed?.connectors?.items;
    const catalogDefinition = catalogItems?.find(
      (item) => item.id === 'mcp.mcp-example-com'
    );
    expect(catalogDefinition?.detail).toMatchObject({
      mcp_config: {
        upstream_url: upstreamUrl,
        tool_prefix: 'mcp_example_com',
      },
    });

    const appProfiles = (await sql`
      SELECT id, provider, status, auth_data
      FROM auth_profiles
      WHERE organization_id = ${org.id}
        AND connector_key = 'mcp.mcp-example-com'
        AND profile_kind = 'oauth_app'
    `) as Array<{
      id: number;
      provider: string;
      status: string;
      auth_data: Record<string, unknown>;
    }>;
    expect(appProfiles).toHaveLength(1);
    expect(appProfiles[0]).toMatchObject({
      provider: 'mcp.mcp-example-com',
      status: 'active',
      auth_data: { MCP_CLIENT_ID: 'registered-mcp-client' },
    });

    const connected = await manageConnections(
      { action: 'connect', connector_key: 'mcp.mcp-example-com' },
      TEST_ENV,
      ctx
    );
    expect(connected).toMatchObject({
      action: 'connect',
      status: 'pending_auth',
      auth_type: 'oauth',
      connect_url: expect.stringMatching(
        /^https:\/\/gateway\.test\/connect\/[A-Za-z0-9_-]+\/oauth\/start$/
      ),
    });

    const connectionId = 'connection_id' in connected ? Number(connected.connection_id) : 0;
    expect(connectionId).toBeGreaterThan(0);
    const [connection] = (await sql`
      SELECT app_auth_profile_id
      FROM connections
      WHERE id = ${connectionId}
        AND organization_id = ${org.id}
    `) as Array<{ app_auth_profile_id: number }>;
    expect(Number(connection.app_auth_profile_id)).toBe(Number(appProfiles[0].id));

    const [connectToken] = (await sql`
      SELECT auth_config
      FROM connect_tokens
      WHERE connection_id = ${connectionId}
        AND organization_id = ${org.id}
        AND status = 'pending'
    `) as Array<{ auth_config: Record<string, unknown> }>;
    expect(connectToken.auth_config).toMatchObject({
      provider: 'mcp.mcp-example-com',
      scopes: ['read:issues', 'write:issues', 'offline_access'],
      tokenEndpointAuthMethod: 'none',
      usePkce: true,
      resource: upstreamUrl,
    });

    const startResponse = await connectRoutes.request(
      `/${String(connected.connect_token)}/oauth/start`
    );
    expect(startResponse.status).toBe(302);
    const authorizeUrl = new URL(startResponse.headers.get('location')!);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      'https://auth.example.com/authorize'
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe('registered-mcp-client');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'https://gateway.test/connect/oauth/callback'
    );
    expect(authorizeUrl.searchParams.get('scope')).toBe(
      'read:issues write:issues offline_access'
    );
    expect(authorizeUrl.searchParams.get('resource')).toBe(upstreamUrl);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const callbackResponse = await connectRoutes.request(
      `/oauth/callback?state=${encodeURIComponent(String(connected.connect_token))}&code=approved-code`
    );
    expect(callbackResponse.status).toBe(302);

    const [activeConnection] = (await sql`
      SELECT status, auth_profile_id
      FROM connections
      WHERE id = ${connectionId}
        AND organization_id = ${org.id}
    `) as Array<{ status: string; auth_profile_id: number | null }>;
    expect(activeConnection.status).toBe('active');
    expect(activeConnection.auth_profile_id).not.toBeNull();

    const available = (await manageOperations(
      { action: 'list_available', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as {
      operations: Array<Record<string, unknown>>;
    };
    expect(available.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation_key: 'get_issue',
          kind: 'read',
          backend: 'mcp_tool',
          readiness: 'ready',
        }),
        expect.objectContaining({
          operation_key: 'create_issue',
          kind: 'write',
          backend: 'mcp_tool',
          readiness: 'ready',
        }),
      ])
    );

    const expectedSummary = {
      total: 2,
      reads: 1,
      writes: 1,
      mcp_tool: 2,
    };

    const got = (await manageConnections(
      { action: 'get', connection_id: connectionId },
      TEST_ENV,
      ctx
    )) as {
      connection: {
        has_operations: boolean;
        operations_summary: Record<string, number>;
      };
    };
    expect(got.connection.has_operations).toBe(true);
    expect(got.connection.operations_summary).toMatchObject(expectedSummary);

    const listed = (await manageConnections(
      { action: 'list', connector_key: 'mcp.mcp-example-com' },
      TEST_ENV,
      ctx
    )) as {
      connections: Array<{
        has_operations: boolean;
        operations_summary: Record<string, number>;
      }>;
    };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0].has_operations).toBe(true);
    expect(listed.connections[0].operations_summary).toMatchObject(expectedSummary);

    const groups = (await manageConnections(
      { action: 'list_connector_groups' },
      TEST_ENV,
      ctx
    )) as {
      groups: Array<{
        connector_key: string;
        facets: { actions: boolean };
      }>;
    };
    expect(
      groups.groups.find((group) => group.connector_key === 'mcp.mcp-example-com')
        ?.facets.actions
    ).toBe(true);
  });

  it('stamps the source-readable Jira issues feed onto an Atlassian Rovo MCP install', async () => {
    const atlassianUrl = 'https://mcp.atlassian.com/v1/mcp';
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === atlassianUrl) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      if (href === resourceMetadataUrl) {
        return jsonResponse({
          resource: atlassianUrl,
          authorization_servers: [authorizationServer],
          scopes_supported: ['read:jira-work', 'write:jira-work', 'offline_access'],
        });
      }
      if (href === authorizationMetadataUrl) {
        return jsonResponse({
          issuer: authorizationServer,
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: registrationUrl,
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (href === registrationUrl) {
        return jsonResponse({
          client_id: 'atlassian-mcp-client',
          token_endpoint_auth_method: 'none',
        });
      }
      throw new Error(`Unexpected fetch: ${href} ${init?.method ?? ''}`);
    }) as typeof fetch;

    const { org, ctx } = await seedOwnerContext({
      orgName: 'Atlassian MCP Feed Org',
      userName: 'Atlassian MCP Feed Owner',
    });
    process.env.PUBLIC_GATEWAY_URL = 'https://gateway.test';
    __resetPublicOriginCachesForTests();
    ctx.baseUrl = 'https://gateway.test';

    const installed = await manageConnections(
      { action: 'install_connector', mcp_url: atlassianUrl },
      TEST_ENV,
      ctx
    );
    expect(installed).toMatchObject({
      action: 'install_connector',
      installed: true,
      connector_key: 'mcp.mcp-atlassian-com',
    });

    const sql = getTestDb();
    const [definition] = (await sql`
      SELECT feeds_schema, mcp_config
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = 'mcp.mcp-atlassian-com'
        AND status = 'active'
    `) as Array<{
      feeds_schema: Record<string, unknown> | null;
      mcp_config: Record<string, unknown>;
    }>;
    expect(definition.mcp_config).toEqual({
      upstream_url: atlassianUrl,
      tool_prefix: 'mcp_atlassian_com',
    });
    expect(definition.feeds_schema).toMatchObject({
      issues: { key: 'issues', operations: ['read'] },
    });
  });

  it('installs a managed MCP manifest from trusted source without registering a local OAuth client', async () => {
    const { org, ctx } = await seedOwnerContext({
      orgName: 'Managed MCP Clone Org',
      userName: 'Managed MCP Clone Owner',
    });
    const sourceCode = `
      import { defineConnector } from "@lobu/connector-sdk";
      export default defineConnector({
        key: "mcp.managed-clone",
        name: "Managed Clone",
        version: "1.0.0",
        authSchema: {
          methods: [{
            type: "oauth",
            provider: "mcp.managed-clone",
            clientIdKey: "MCP_CLIENT_ID",
            clientSecretKey: "MCP_CLIENT_SECRET",
          }],
        },
        mcpConfig: {
          upstream_url: "https://mcp.example.com/rpc",
          tool_prefix: "managed_clone",
        },
      } as never);
    `;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const installed = await manageConnections(
      { action: 'install_connector', source_code: sourceCode },
      TEST_ENV,
      ctx
    );
    expect(installed).toMatchObject({
      action: 'install_connector',
      installed: true,
      connector_key: 'mcp.managed-clone',
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const sql = getTestDb();
    const [definition] = (await sql`
      SELECT mcp_config
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = 'mcp.managed-clone'
        AND status = 'active'
    `) as Array<{ mcp_config: Record<string, unknown> }>;
    expect(definition.mcp_config).toEqual({
      upstream_url: 'https://mcp.example.com/rpc',
      tool_prefix: 'managed_clone',
    });
    const catalog = await manageCatalog(
      { action: 'list_installed', kinds: ['connectors'] },
      TEST_ENV,
      ctx
    );
    const catalogItems = (
      catalog as {
        installed?: { connectors?: { items?: Array<Record<string, unknown>> } };
      }
    ).installed?.connectors?.items;
    const catalogDefinition = catalogItems?.find(
      (item) => item.id === 'mcp.managed-clone'
    );
    expect(catalogDefinition?.detail).toMatchObject({
      source_uri: null,
      mcp_config: {
        upstream_url: 'https://mcp.example.com/rpc',
        tool_prefix: 'managed_clone',
      },
    });

    await sql`
      UPDATE connector_definitions
      SET mcp_config = ${sql.json({
        upstream_url: 'https://mcp.example.com/rpc?access_token=secret',
        tool_prefix: 'managed_clone',
      })}
      WHERE organization_id = ${org.id}
        AND key = 'mcp.managed-clone'
        AND status = 'active'
    `;
    const secretBearingCatalog = await manageCatalog(
      { action: 'list_installed', kinds: ['connectors'] },
      TEST_ENV,
      ctx
    );
    const secretBearingItems = (
      secretBearingCatalog as {
        installed?: { connectors?: { items?: Array<Record<string, unknown>> } };
      }
    ).installed?.connectors?.items;
    expect(
      secretBearingItems?.find((item) => item.id === 'mcp.managed-clone')?.detail
    ).toMatchObject({ mcp_config: null });

    const [profileCount] = (await sql`
      SELECT COUNT(*)::int AS count
      FROM auth_profiles
      WHERE organization_id = ${org.id}
        AND connector_key = 'mcp.managed-clone'
    `) as Array<{ count: number }>;
    expect(profileCount.count).toBe(0);
  });
});
