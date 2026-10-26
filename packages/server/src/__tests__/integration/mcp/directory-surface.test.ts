import { beforeAll, describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../../../db/client';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-session-state';
import { get, post, mcpRequest } from '../../setup/test-helpers';
import { cleanupTestDatabase } from '../../setup/test-db';
import { addUserToOrganization, createTestAccessToken, createTestEntity, createTestOAuthClient, createTestOrganization, createTestSession, createTestUser, seedSystemEntityTypes } from '../../setup/test-fixtures';

const directoryPath = '/mcp-directory';
const resource = `http://localhost${directoryPath}`;

describe('directory MCP surface', () => {
  let token: string;
  let legacyToken: string;
  let readToken: string;
  let userId: string;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let workspace: { id: string; slug: string };

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    workspace = await createTestOrganization({ slug: 'directory-workspace' });
    const user = await createTestUser({ email: 'directory-user@example.test' });
    userId = user.id;
    await addUserToOrganization(user.id, workspace.id, 'owner');
    client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, null, client.client_id, {
      resource, grantedOrganizationIds: [workspace.id], scope: 'mcp:read mcp:write',
    })).token;
    legacyToken = (await createTestAccessToken(user.id, null, client.client_id, {
      grantedOrganizationIds: [workspace.id], scope: 'mcp:read mcp:write',
    })).token;
    readToken = (await createTestAccessToken(user.id, null, client.client_id, {
      resource, grantedOrganizationIds: [workspace.id], scope: 'mcp:read',
    })).token;
  });

  const request = (path: string, bearer: string, method: string, params = {}, sessionId?: string) => post(path, {
    token: bearer,
    body: { jsonrpc: '2.0', id: 1, method, params },
    headers: sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': MCP_PROTOCOL_VERSION } : {},
  });
  const initialize = async (bearer = token, path = directoryPath) => {
    const response = await request(path, bearer, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: 'directory-test', version: '1.0.0' },
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    if (path === directoryPath) {
      expect(body.result.instructions).not.toMatch(/search_sdk|query_sdk|run_sdk|client\.org|get_approval/);
      expect(body.result.instructions).toContain(workspace.slug);
    }
    const id = response.headers.get('mcp-session-id');
    expect(id).toBeTruthy();
    return id!;
  };
  const call = async (sessionId: string, name: string, args = {}) => {
    const response = await request(directoryPath, token, 'tools/call', { name, arguments: args }, sessionId);
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };

  it('advertises exact protected-resource metadata and requires resource-bound OAuth', async () => {
    const metadata = await get('/.well-known/oauth-protected-resource/mcp-directory');
    expect(metadata.status).toBe(200);
    expect((await metadata.json()).resource).toBe(resource);
    for (const bearer of ['', legacyToken]) {
      const response = await request(directoryPath, bearer, 'initialize', {});
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('/oauth-protected-resource/mcp-directory');
    }
  });

  it('lists a fixed tool set with local-only SQL and no SDK instructions', async () => {
    const session = await initialize();
    const listed = await request(directoryPath, token, 'tools/list', {}, session);
    const tools = (await listed.json()).result.tools;
    expect(tools.map((tool: any) => tool.name).sort()).toEqual(['open_view', 'query_sql', 'save_memory', 'search_memory']);
    expect(tools.find((tool: any) => tool.name === 'query_sql').inputSchema.properties.connection).toBeUndefined();
    expect(tools.find((tool: any) => tool.name === 'query_sql').inputSchema.properties.org_slug.description).not.toContain('Only honored on the unscoped `/mcp`');
    const resources = await request(directoryPath, token, 'resources/list', {}, session);
    expect(JSON.stringify(await resources.json())).not.toMatch(/invoke_view_action|run\/validate\/evaluate\/connect/);
    const skill = await request(directoryPath, token, 'resources/read', { uri: 'skill://lobu' }, session);
    expect(JSON.stringify(await skill.json())).not.toMatch(/search_sdk|query_sdk|run_sdk/);
  });

  it('rejects a hostile browser Origin before tool dispatch', async () => {
    const response = await post(directoryPath, {
      token, headers: { Origin: 'https://untrusted.example.test' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe('Untrusted MCP Origin');
  });

  it('completes consent, code exchange and refresh with the exact directory resource', async () => {
    const human = await createTestSession(userId);
    const verifier = randomBytes(32).toString('base64url');
    const authorization = {
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      scope: 'mcp:read mcp:write', resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    };
    const started = await get(`/oauth/authorize?${new URLSearchParams(authorization)}`);
    expect(started.status).toBe(302);
    const consentUrl = new URL(started.headers.get('location')!);
    expect(consentUrl.searchParams.get('resource')).toBe(resource);
    const consent = await post('/oauth/authorize/consent', {
      cookie: human.cookieHeader,
      headers: { Origin: 'http://localhost' },
      body: { ...authorization, authorization_intent: consentUrl.searchParams.get('authorization_intent'), approved: true, organization_ids: [workspace.id], workspace_access: 'selected' },
    });
    expect(consent.status).toBe(200);
    const code = new URL((await consent.json()).redirect_url).searchParams.get('code');
    const exchanged = await post('/oauth/token', {
      body: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: authorization.redirect_uri, resource },
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens.resource).toBe(resource);
    await initialize(tokens.access_token);
    const refreshed = await post('/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, client_secret: client.client_secret, resource },
    });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json();
    expect(rotated.resource).toBe(resource);
    await initialize(rotated.access_token);
  });

  it('rejects hidden and generic calls before execution, including view-pinned calls', async () => {
    const session = await initialize();
    for (const name of ['search_sdk', 'query_sdk', 'run_sdk', 'manage_connections', 'invoke_view_action']) {
      const response = await request(directoryPath, token, 'tools/call', {
        name, arguments: {}, _meta: { 'lobu/view-workspace': workspace.slug },
      }, session);
      const result = (await response.json()).result;
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text).toContain('not available');
    }
    const external = await call(session, 'query_sql', { org_slug: workspace.slug, sql: 'SELECT 1', connection: 'unreviewed-external-source' });
    expect(external.isError).toBe(true);
    expect(external.content[0].text).toContain('saved workspace data');
  });

  it('opens the picker, saves explicitly, and reads local workspace data', async () => {
    const session = await initialize();
    const picker = await call(session, 'open_view');
    expect(picker.isError).not.toBe(true);
    expect(picker.structuredContent.picker.workspaces.map((item: any) => item.slug)).toEqual([workspace.slug]);
    const saved = await call(session, 'save_memory', { org_slug: workspace.slug, content: 'Synthetic directory note', semantic_type: 'note' });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const local = await call(session, 'query_sql', { org_slug: workspace.slug, sql: 'SELECT 7 AS value' });
    expect(local.isError, JSON.stringify(local)).not.toBe(true);
    expect(local.structuredContent.rows).toEqual([{ value: 7 }]);
  });

  it('keeps empty and entity search guidance within the directory tool set', async () => {
    const session = await initialize();
    const entity = await createTestEntity({ name: 'Directory fixture', organization_id: workspace.id });
    for (const args of [
      { query: 'unfindable-directory-fixture' },
      { entity_id: entity.id, workspace: workspace.slug },
    ]) {
      const result = await call(session, 'search_memory', { ...args, include_content: false });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent.suggestion).not.toMatch(/search_sdk|query_sdk|run_sdk|client\./);
    }
  });

  it('cannot replay the restricted token against ordinary MCP or REST, even with a session', async () => {
    const session = await initialize();
    for (const path of ['/mcp', `/mcp/${workspace.slug}`, `/api/${workspace.slug}/query_sdk`]) {
      const response = await request(path, token, 'tools/call', { name: 'query_sdk', arguments: { script: 'export default async () => 1' } }, session);
      expect(response.status, path).toBe(401);
    }
    clearInMemoryMcpSessionsForTests();
    const recovered = await call(session, 'query_sdk', { script: 'export default async () => 1' });
    expect(recovered.isError).toBe(true);
    const replay = await request('/mcp', token, 'tools/list', {}, session);
    expect(replay.status).toBe(401);
    const ordinary = await mcpRequest('tools/list', {}, { token: legacyToken });
    expect(ordinary.result.tools.map((tool: any) => tool.name)).toContain('query_sdk');
  });

  it('does not gain generic tools by reusing an ordinary session across replicas', async () => {
    const ordinarySession = await initialize(legacyToken, '/mcp');
    const mismatched = await request(directoryPath, token, 'tools/list', {}, ordinarySession);
    expect(mismatched.status).toBe(400);
    clearInMemoryMcpSessionsForTests();
    const recovered = await call(ordinarySession, 'run_sdk', { script: 'export default async () => 1' });
    expect(recovered.isError).toBe(true);
  });

  it('preserves read-only scope restrictions on the directory tools', async () => {
    const session = await initialize(readToken);
    const response = await request(directoryPath, readToken, 'tools/call', {
      name: 'save_memory', arguments: { org_slug: workspace.slug, content: 'Must not be saved' },
    }, session);
    expect((await response.json()).result.isError).toBe(true);
  });

  it('uses live membership when a directory session loses its workspace', async () => {
    const session = await initialize();
    await getDb()`DELETE FROM member WHERE "organizationId"=${workspace.id} AND "userId"=${userId}`;
    const result = await call(session, 'open_view', { organization: workspace.slug });
    expect(result.isError).toBe(true);
  });
});
