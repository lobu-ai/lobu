/**
 * MCP Authentication Tests
 *
 * Tests for MCP endpoint authentication including:
 * - OAuth access tokens
 * - Personal Access Tokens (PATs)
 * - Unauthenticated discovery requests
 */

import { createHash } from 'node:crypto';
import { MCP_PROTOCOL_VERSION } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthorizationIntent } from '../../../auth/oauth/authorization-intent';
import { hashToken } from '../../../auth/oauth/utils';
import { parsePgTextArray } from '../../../db/client';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createExpiredAccessToken,
  createTestAccessToken,
  createTestAgent,
  createTestDeviceCode,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { del, get, mcpListTools, mcpRequest, mcpToolsCall, post } from '../../setup/test-helpers';

async function verifyDeviceCode(userCode: string, cookie: string): Promise<void> {
  const response = await get(`/oauth/device/info?user_code=${encodeURIComponent(userCode)}`, {
    cookie,
  });
  expect(response.status).toBe(200);
}

async function createAccountAccessToken(
  userId: string,
  grantedOrganizationId: string,
  clientId: string,
  options?: Parameters<typeof createTestAccessToken>[3]
) {
  const credentials = await createTestAccessToken(userId, grantedOrganizationId, clientId, options);
  await getTestDb()`
    UPDATE oauth_tokens SET organization_id = NULL
    WHERE token_hash = ${hashToken(credentials.token)}
  `;
  return { token: credentials.token };
}

describe('MCP Authentication', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let org2: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let agent: Awaited<ReturnType<typeof createTestAgent>>;
  let publicEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let sessionCookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Test Org' });
    publicOrg = await createTestOrganization({
      name: 'Public Org',
      visibility: 'public',
    });
    org2 = await createTestOrganization({ name: 'Second Org' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id);
    await addUserToOrganization(user.id, org2.id);
    client = await createTestOAuthClient();
    agent = await createTestAgent({
      organizationId: org.id,
      agentId: 'lobu-test-agent',
      ownerUserId: user.id,
    });
    publicEntity = await createTestEntity({
      name: 'Public Brand',
      organization_id: publicOrg.id,
      entity_type: 'brand',
    });
    const session = await createTestSession(user.id);
    sessionCookie = session.cookieHeader;
  });

  describe('Unauthenticated Requests', () => {
    it('rejects an MCP authorization request that omits its RFC 8707 resource', async () => {
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris.at(0) ?? '',
        response_type: 'code',
        scope: 'mcp:read',
        code_challenge: 'test-pkce-challenge',
        code_challenge_method: 'S256',
      });
      const response = await get(`/oauth/authorize?${query.toString()}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: 'A valid trusted MCP resource is required',
      });
    });

    it('challenges unauthenticated requests on the unscoped /mcp endpoint with 401 + WWW-Authenticate', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe(
        'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write profile:read"'
      );
    });

    // SKIP: post-#438 the unscoped /mcp endpoint refuses ALL anonymous POSTs
    // (including initialize) with 401 + WWW-Authenticate. The original test
    // assumed an anonymous initialize would create a session that subsequent
    // GETs could probe; that path no longer exists. The first test in this
    // describe block ("challenges unauthenticated requests…") covers the
    // 401 challenge contract directly.
    it.skip('returns an OAuth challenge for anonymous root session stream requests', async () => {
      const initResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const response = await get('/mcp', {
        headers: {
          Accept: 'text/event-stream',
          'mcp-session-id': sessionId!,
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource'
      );
    });

    // SKIP: post-#438 unscoped /mcp anonymous initialize returns 401 with no
    // session ID. This test's "anonymous-then-upgrade" flow is no longer
    // possible — the upgrade path is to start with an authenticated initialize.
    // The "challenges unauthenticated requests…" test above already verifies
    // the 401 contract.
    it.skip('upgrades an anonymous unscoped session when Bearer token is provided', async () => {
      const initResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Anonymous tool call should be rejected
      const anonResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'upgrade-test-probe' },
          },
        },
        headers: { 'mcp-session-id': sessionId! },
      });
      expect(anonResponse.status).toBe(401);

      // Re-initialize with a new anonymous session (previous was cleared)
      const initResponse2 = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__test_init_2__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
      });
      const sessionId2 = initResponse2.headers.get('mcp-session-id');
      expect(sessionId2).toBeTruthy();

      // Now provide a Bearer token on the same session — should upgrade auth
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);
      const authResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'upgrade-test-probe-after-auth' },
          },
        },
        headers: { 'mcp-session-id': sessionId2! },
        token,
      });
      expect(authResponse.status).toBe(200);
      const body = await authResponse.json();
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('rejects anonymous public-readable tool calls for private workspaces', async () => {
      const response = await post(`/api/${org.slug}/resolve_path`, {
        body: {
          path: `/${org.slug}`,
          include_bootstrap: true,
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
      expect(body.error_description).toContain('Authentication required');
    });

    it('allows anonymous public-readable tool calls for public workspaces', async () => {
      const response = await post(`/api/${publicOrg.slug}/resolve_path`, {
        body: {
          path: `/${publicOrg.slug}`,
          include_bootstrap: true,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.workspace.slug).toBe(publicOrg.slug);
      expect(body.workspace.type).toBe('organization');
    });

    it('rejects anonymous knowledge reads for private workspaces', async () => {
      const response = await post(`/api/${org.slug}/read_knowledge`, {
        body: { limit: 1 },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });
  });

  describe('Public Organization MCP', () => {
    async function initializePublicSession() {
      const initResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const initBody = await initResponse.json();
      expect(initBody.result?.instructions).toContain(
        "Use Lobu's tools only when they are relevant to the user's request"
      );
      expect(initBody.result?.instructions).toContain('### Writes and approvals');
      expect(initBody.result?.instructions).toContain('Use it only when the user asks');
      expect(initBody.result?.instructions).not.toContain(
        "Use it proactively — don't wait to be asked"
      );
      expect(initBody.result?.instructions).not.toContain(
        '### Saving (do this automatically)'
      );

      await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': sessionId! },
      });

      return sessionId!;
    }

    it('allows anonymous tools/list on public org MCP routes and hides mutating tools', async () => {
      const result = await mcpListTools({ orgSlug: publicOrg.slug });
      const toolNames = result.tools.map((t) => t.name);

      // Public reads survive: search_memory, search_sdk (SDK discovery).
      expect(toolNames).toContain('search_memory');
      expect(toolNames).toContain('search_sdk');
      // Writes and admin reads must not be visible to anonymous public callers.
      expect(toolNames).not.toContain('save_memory');
      expect(toolNames).not.toContain('query_sql');
      expect(toolNames).not.toContain('run_sdk');
      // Admin flat tools are not on the MCP list — use search_sdk + query_sdk.
      expect(toolNames).not.toContain('manage_entity');
    });

    it('allows anonymous public-read tool calls on public org MCP routes', async () => {
      const sessionId = await initializePublicSession();

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'public-mcp-probe-nonexistent-12345' },
          },
        },
        headers: { 'mcp-session-id': sessionId },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('requires auth for anonymous write attempts on public org MCP routes', async () => {
      const sessionId = await initializePublicSession();

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'save_memory',
            arguments: {
              content: 'public org write probe',
              kind: 'note',
              metadata: {},
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource'
      );
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('allows consent approval for a public org resource even when the user is not a member', async () => {
      const response = await post('/oauth/authorize/consent', {
        body: {
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          scope: 'mcp:read profile:read',
          state: 'public-org-consent-test',
          code_challenge: 'test-code-challenge',
          code_challenge_method: 'S256',
          resource: `http://localhost/mcp/${publicOrg.slug}`,
          authorization_intent: createAuthorizationIntent(
            {
              client_id: client.client_id,
              redirect_uri: client.redirect_uris[0],
              response_type: 'code',
              scope: 'mcp:read profile:read',
              state: 'public-org-consent-test',
              code_challenge: 'test-code-challenge',
              code_challenge_method: 'S256',
              resource: `http://localhost/mcp/${publicOrg.slug}`,
            },
            'test-jwt-secret-for-testing-only'
          ),
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.redirect_url).toContain(client.redirect_uris[0]);
      expect(body.redirect_url).toContain('code=');
      expect(body.redirect_url).toContain('state=public-org-consent-test');
    });
  });

  describe('OAuth Access Token Authentication', () => {
    it('should accept valid OAuth access token', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });

      expect(result.tools).toBeInstanceOf(Array);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('rejects retired default-bound bare OAuth even with a client-declared agent', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
      for (const headers of [{}, { 'x-lobu-agent-id': agent.agentId }]) {
        const response = await post('/mcp', {
          token,
          headers,
          body: {
            jsonrpc: '2.0',
            id: 'legacy-default-init',
            method: 'initialize',
            params: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: {
                name: 'legacy-default-test',
                version: '1.0',
                agentId: agent.agentId,
              },
            },
          },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('mcp-session-id')).toBeNull();
        expect((await response.json()).error_description).toContain('retired default workspace');
      }
    });

    it('initializes and recovers account sessions without borrowing a persisted workspace', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);
      const initialized = await post('/mcp', {
        token,
        body: {
          jsonrpc: '2.0',
          id: 'account-recovery-init',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'account-recovery-test', version: '1.0' },
          },
        },
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      const headers = { 'mcp-session-id': sessionId!, 'X-MCP-Format': 'json' };
      await post('/mcp', {
        token,
        headers,
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      const sql = getTestDb();
      const [persisted] = await sql`
        SELECT organization_id, member_role FROM mcp_sessions WHERE session_id = ${sessionId}
      `;
      expect(persisted).toMatchObject({
        organization_id: null,
        member_role: null,
      });
      clearInMemoryMcpSessionsForTests();
      const body = {
        jsonrpc: '2.0',
        id: 'account-recovery-list',
        method: 'tools/list',
        params: {},
      };
      const recovered = await post('/mcp', { token, headers, body });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).result.tools.length).toBeGreaterThan(0);
      const [afterRecovery] = await sql`
        SELECT organization_id, member_role FROM mcp_sessions WHERE session_id = ${sessionId}
      `;
      expect(afterRecovery).toMatchObject({
        organization_id: null,
        member_role: null,
      });

      // A stale pre-cutover session row is never a source of execution scope.
      await sql`
        UPDATE mcp_sessions SET organization_id = ${org.id}, member_role = 'owner'
        WHERE session_id = ${sessionId}
      `;
      clearInMemoryMcpSessionsForTests();
      const stale = await post('/mcp', { token, headers, body });
      expect(stale.status).toBe(404);
      expect((await stale.json()).result).toBeUndefined();
    });

    it('rejects an OAuth token bound to a different MCP resource', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
        resource: `http://localhost/mcp/${org.slug}`,
      });

      await expect(mcpListTools({ token, orgSlug: org2.slug })).rejects.toThrow();

      const response = await post(`/mcp/${org2.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'audience-test', version: '1.0.0' },
          },
        },
        token,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe(
        `Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp/${org2.slug}", scope="mcp:read mcp:write profile:read", error="invalid_token"`
      );
    });

    it('enforces OAuth workspace grants on REST tools and rejects MCP audience replay', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);
      const grantedRead = await post(`/api/${org.slug}/search_memory`, {
        body: {
          query: 'oauth-rest-grant-probe',
          include_public_catalogs: false,
        },
        token,
      });
      expect(grantedRead.status).toBe(200);

      const ungrantedRead = await post(`/api/${org2.slug}/search_memory`, {
        body: {
          query: 'oauth-rest-ungranted-probe',
          include_public_catalogs: false,
        },
        token,
      });
      const ungrantedWrite = await post(`/api/${org2.slug}/save_memory`, {
        body: {},
        token,
      });
      expect(ungrantedRead.status).toBe(403);
      expect(ungrantedWrite.status).toBe(403);
      const unavailable = {
        error: 'forbidden',
        error_description: 'Workspace is not available for this authorization',
      };
      const ungrantedReadBody = await ungrantedRead.json();
      expect(ungrantedReadBody).toEqual(unavailable);
      expect(await ungrantedWrite.json()).toEqual(unavailable);

      const unknownRead = await post('/api/unknown-oauth-workspace/search_memory', {
        body: { query: 'oauth-rest-unknown-probe', include_public_catalogs: false },
        token,
      });
      expect(unknownRead.status).toBe(ungrantedRead.status);
      expect(await unknownRead.json()).toEqual(ungrantedReadBody);

      const initializeBody = {
        jsonrpc: '2.0',
        id: 'workspace-oracle-probe',
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'workspace-oracle-test', version: '1.0.0' },
        },
      };
      const ungrantedMcp = await post(`/mcp/${org2.slug}`, {
        body: initializeBody,
        token,
      });
      const unknownMcp = await post('/mcp/unknown-oauth-workspace', {
        body: initializeBody,
        token,
      });
      const ungrantedMcpBody = await ungrantedMcp.json();
      expect(ungrantedMcp.status).toBe(403);
      expect(ungrantedMcpBody).toEqual(unavailable);
      expect(unknownMcp.status).toBe(ungrantedMcp.status);
      expect(await unknownMcp.json()).toEqual(ungrantedMcpBody);

      const { token: mcpBoundToken } = await createAccountAccessToken(
        user.id,
        org.id,
        client.client_id,
        { resource: `http://localhost/mcp/${org.slug}` }
      );
      const replay = await post(`/api/${org.slug}/search_memory`, {
        body: {
          query: 'oauth-rest-audience-probe',
          include_public_catalogs: false,
        },
        token: mcpBoundToken,
      });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ error: 'invalid_token' });
    });

    it('gates hidden resolve_path targets at the MCP and REST tool boundaries', async () => {
      const secretEntityName = 'Private B Resolve Path Secret';
      await createTestEntity({
        name: secretEntityName,
        entity_type: 'brand',
        organization_id: org2.id,
      });
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);
      const unavailable = 'Workspace is not available for this authorization';

      const deniedPaths = [
        { path: `/${org2.slug}` },
        { path: `/${org2.slug}/brand/private-b-resolve-path-secret` },
        { path: `/${org2.slug}`, include_bootstrap: true },
      ];
      for (const args of deniedPaths) {
        const denied = await mcpRequest<any>(
          'tools/call',
          { name: 'resolve_path', arguments: args },
          { token }
        );
        expect(denied.error).toBeUndefined();
        expect(denied.result?.isError).toBe(true);
        const text = String(denied.result?.content?.[0]?.text);
        expect(text).toBe(unavailable);
        expect(text).not.toContain(org2.slug);
        expect(text).not.toContain(secretEntityName);
      }

      const unknown = await mcpRequest<any>(
        'tools/call',
        { name: 'resolve_path', arguments: { path: '/unknown-resolve-path-workspace' } },
        { token }
      );
      expect(unknown.result?.isError).toBe(true);
      expect(unknown.result?.content?.[0]?.text).toBe(unavailable);

      const foreignNamespaceUser = await createTestUser({ name: 'Private Namespace User' });
      await getTestDb()`
        INSERT INTO namespace (slug, type, ref_id)
        VALUES ('private-namespace-user', 'user', ${foreignNamespaceUser.id})
      `;
      const userNamespace = await mcpRequest<any>(
        'tools/call',
        { name: 'resolve_path', arguments: { path: '/@private-namespace-user' } },
        { token }
      );
      expect(userNamespace.result?.isError).toBe(true);
      expect(userNamespace.result?.content?.[0]?.text).toBe(unavailable);

      const urlBodyMismatch = await post(`/api/${org.slug}/resolve_path`, {
        body: { path: `/${org2.slug}`, include_bootstrap: true },
        token,
      });
      expect(urlBodyMismatch.status).toBe(404);
      expect(await urlBodyMismatch.json()).toEqual({ error: unavailable });

      const publicBrowse = await mcpToolsCall<any>(
        'resolve_path',
        { path: `/${publicOrg.slug}/brand/public-brand` },
        { token }
      );
      expect(publicBrowse.workspace).toMatchObject({
        id: publicOrg.id,
        slug: publicOrg.slug,
      });
      expect(publicBrowse.entity).toMatchObject({ id: publicEntity.id });

      const { token: grantedToken } = await createAccountAccessToken(
        user.id,
        org.id,
        client.client_id
      );
      await getTestDb()`
        UPDATE oauth_tokens
        SET granted_organization_ids = ARRAY[${org.id}, ${org2.id}]::text[]
        WHERE token_hash = ${hashToken(grantedToken)}
      `;
      const grantedBrowse = await mcpToolsCall<any>(
        'resolve_path',
        {
          path: `/${org2.slug}/brand/private-b-resolve-path-secret`,
          include_bootstrap: true,
        },
        { token: grantedToken }
      );
      expect(grantedBrowse.workspace).toMatchObject({
        id: org2.id,
        slug: org2.slug,
      });
      expect(grantedBrowse.entity).toMatchObject({ name: secretEntityName });
      expect(grantedBrowse.bootstrap).not.toBeNull();

      const agentBound = await mcpRequest<any>(
        'tools/call',
        { name: 'resolve_path', arguments: { path: `/${org2.slug}` } },
        { token: grantedToken, orgSlug: org.slug, agentId: agent.agentId }
      );
      expect(agentBound.result?.isError).toBe(true);
      expect(agentBound.result?.content?.[0]?.text).toBe(unavailable);
    });

    it('allows a public-org scoped OAuth token for a non-member and only exposes public tools', async () => {
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read profile:read',
      });

      const result = await mcpListTools({ token, orgSlug: publicOrg.slug });
      const toolNames = result.tools.map((t) => t.name);

      expect(toolNames).toContain('search_memory');
      expect(toolNames).toContain('search_sdk');
      expect(toolNames).not.toContain('save_memory');
      expect(toolNames).not.toContain('query_sql');
      expect(toolNames).not.toContain('run_sdk');
      expect(toolNames).not.toContain('manage_entity');
    });

    it('keeps a public workspace readable when it is not in the OAuth workspace grant', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
        scope: 'mcp:read profile:read',
      });
      await getTestDb()`
        UPDATE oauth_tokens
        SET granted_organization_ids = ARRAY[${org.id}]::text[]
        WHERE token_hash = ${hashToken(token)}
      `;

      const result = await mcpListTools({ token, orgSlug: publicOrg.slug });
      const toolNames = result.tools.map((tool) => tool.name);

      expect(toolNames).toContain('search_memory');
      expect(toolNames).toContain('search_sdk');
      expect(toolNames).not.toContain('save_memory');
      expect(toolNames).not.toContain('query_sql');
      expect(toolNames).not.toContain('run_sdk');

      const publicRead = await mcpToolsCall<any>(
        'resolve_path',
        { path: `/${publicOrg.slug}/brand/public-brand` },
        { token, orgSlug: publicOrg.slug }
      );
      expect(publicRead.workspace).toMatchObject({ id: publicOrg.id, slug: publicOrg.slug });
      expect(publicRead.entity).toMatchObject({ id: publicEntity.id });

      clearInMemoryMcpSessionsForTests();
      const recovered = await mcpListTools({ token, orgSlug: publicOrg.slug });
      expect(recovered.tools.map((tool) => tool.name)).toContain('search_memory');
    });

    it('should reject expired OAuth access token', async () => {
      const { token } = await createExpiredAccessToken(user.id, org.id, client.client_id);

      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('should reject invalid OAuth access token', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'invalid_token_that_does_not_exist',
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('searches an explicit grant without borrowing a workspace target', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      // Account search uses the grant set even though the token has no target.
      const response = await mcpRequest(
        'tools/call',
        {
          name: 'search_memory',
          arguments: { query: 'nonexistent-brand-12345' },
        },
        { token }
      );

      // Should succeed (even if entity not found) because auth works
      expect(response.error).toBeUndefined();
    });

    it('still dispatches list_organizations by name via tools/call when omitted from tools/list', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const listed = await mcpListTools({ token });
      expect(listed.tools.map((t: any) => t.name)).not.toContain('list_organizations');

      const result = await mcpToolsCall<unknown[]>('list_organizations', {}, { token });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('recovers a stale authenticated MCP session from the persisted session store', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const initResponse = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
        token,
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': sessionId! },
        token,
      });

      const persistedRows = await getTestDb()`
        SELECT organization_id
        FROM mcp_sessions
        WHERE session_id = ${sessionId}
      `;
      expect(persistedRows).toHaveLength(1);
      expect(persistedRows[0].organization_id).toBe(org.id);

      clearInMemoryMcpSessionsForTests();

      const recoveredToolCall = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'search_memory',
          arguments: { query: 'recovery-probe-nonexistent-12345' },
        },
      };
      const headerlessRecovery = await post(`/mcp/${org.slug}`, {
        body: recoveredToolCall,
        headers: { 'X-MCP-Format': 'json', 'mcp-session-id': sessionId! },
      });
      expect(headerlessRecovery.status).toBe(401);
      expect(headerlessRecovery.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource'
      );
      const retainedRows = await getTestDb()`
        SELECT 1 FROM mcp_sessions WHERE session_id = ${sessionId}
      `;
      expect(retainedRows).toHaveLength(1);

      const recoveredResponse = await post(`/mcp/${org.slug}`, {
        body: recoveredToolCall,
        headers: { 'X-MCP-Format': 'json', 'mcp-session-id': sessionId! },
        token,
      });

      expect(recoveredResponse.status).toBe(200);
      const recoveredBody = await recoveredResponse.json();
      expect(recoveredBody.error).toBeUndefined();
      expect(recoveredBody.result?.isError).not.toBe(true);
    });

    it('requires the OAuth bearer on follow-ups and immediately applies membership and token revocation', async () => {
      const sql = getTestDb();
      const liveOrg = await createTestOrganization({
        name: 'Live OAuth Session Org',
      });
      const liveUser = await createTestUser({
        name: 'Live OAuth Session User',
      });
      const memberId = await addUserToOrganization(liveUser.id, liveOrg.id, 'owner');
      const liveClient = await createTestOAuthClient({
        client_name: 'Live OAuth Session Client',
      });
      const { token } = await createAccountAccessToken(
        liveUser.id,
        liveOrg.id,
        liveClient.client_id
      );

      const initResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__live_auth_init__',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'live-auth-test', version: '1.0' },
          },
        },
        token,
      });
      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      await post('/mcp', {
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers: { 'mcp-session-id': sessionId! },
        token,
      });

      const toolCall = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search_memory',
          arguments: {
            query: 'live-oauth-session-probe',
            workspace: liveOrg.slug,
          },
        },
      };
      const headerless = await post('/mcp', {
        body: toolCall,
        headers: { 'mcp-session-id': sessionId! },
      });
      expect(headerless.status).toBe(401);

      const withBearer = await post('/mcp', {
        body: toolCall,
        headers: { 'mcp-session-id': sessionId! },
        token,
      });
      expect(withBearer.status).toBe(200);

      const headerlessGet = await get('/mcp', {
        headers: { Accept: 'text/event-stream', 'mcp-session-id': sessionId! },
      });
      expect(headerlessGet.status).toBe(401);
      const headerlessDelete = await del('/mcp', {
        headers: { 'mcp-session-id': sessionId! },
      });
      expect(headerlessDelete.status).toBe(401);

      const deleteInitResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__delete_auth_init__',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'delete-auth-test', version: '1.0' },
          },
        },
        token,
      });
      const deleteSessionId = deleteInitResponse.headers.get('mcp-session-id');
      expect(deleteSessionId).toBeTruthy();
      await post('/mcp', {
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
        headers: { 'mcp-session-id': deleteSessionId! },
        token,
      });
      const validDelete = await del('/mcp', {
        headers: { 'mcp-session-id': deleteSessionId! },
        token,
      });
      expect(validDelete.status).toBe(200);
      const afterDelete = await post('/mcp', {
        body: toolCall,
        headers: { 'mcp-session-id': deleteSessionId! },
        token,
      });
      expect(afterDelete.status).toBe(404);

      await sql`DELETE FROM "member" WHERE id = ${memberId}`;
      const afterMembershipRevoke = await post('/mcp', {
        body: toolCall,
        headers: { 'mcp-session-id': sessionId! },
        token,
      });
      expect(afterMembershipRevoke.status).toBe(200);
      const revokedResult = await afterMembershipRevoke.json();
      expect(revokedResult.result?.isError).toBe(true);
      expect(revokedResult.result?.content?.[0]?.text).toContain('Workspace is not available');

      await addUserToOrganization(liveUser.id, liveOrg.id, 'owner');
      await sql`
        UPDATE oauth_tokens SET revoked_at = NOW()
        WHERE token_hash = ${hashToken(token)}
      `;
      const afterTokenRevoke = await post('/mcp', {
        body: toolCall,
        headers: { 'mcp-session-id': sessionId! },
        token,
      });
      expect(afterTokenRevoke.status).toBe(401);
    });

    it('binds an MCP session to a durable agent and updates last_used_at', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      await mcpToolsCall(
        'search_memory',
        { query: 'nonexistent-brand-12345' },
        { token, orgSlug: org.slug, agentId: agent.agentId }
      );

      const rows = await getTestDb()`
        SELECT last_used_at
        FROM agents
        WHERE id = ${agent.agentId}
          AND organization_id = ${org.id}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].last_used_at).toBeTruthy();
    });

    it('revokes an MCP client only within the current organization', async () => {
      const revoker = await createTestUser({});
      await addUserToOrganization(revoker.id, org.id, 'owner');
      await addUserToOrganization(revoker.id, org2.id, 'owner');
      const revokerSession = await createTestSession(revoker.id);

      const scopedClient = await createTestOAuthClient({
        client_name: 'Scoped Revoke Client',
      });
      const { token: orgToken } = await createTestAccessToken(
        revoker.id,
        org.id,
        scopedClient.client_id
      );
      await createTestAccessToken(revoker.id, org2.id, scopedClient.client_id);

      const initResponse = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'lobu-test', version: '1.0' },
          },
        },
        token: orgToken,
      });
      const activeSessionId = initResponse.headers.get('mcp-session-id');
      expect(activeSessionId).toBeTruthy();

      await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': activeSessionId! },
        token: orgToken,
      });

      const preRevokeResponse = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'revocation-check-before' },
          },
        },
        headers: { 'mcp-session-id': activeSessionId! },
      });
      expect(preRevokeResponse.status).toBe(401);

      await getTestDb()`
        INSERT INTO mcp_sessions (
          session_id,
          user_id,
          client_id,
          organization_id,
          member_role,
          requested_agent_id,
          is_authenticated,
          scoped_to_org,
          last_accessed_at,
          expires_at
        ) VALUES (
          'session-org-1',
          ${revoker.id},
          ${scopedClient.client_id},
          ${org.id},
          'owner',
          NULL,
          true,
          false,
          NOW(),
          NOW() + INTERVAL '1 hour'
        ), (
          'session-org-2',
          ${revoker.id},
          ${scopedClient.client_id},
          ${org2.id},
          'owner',
          NULL,
          true,
          false,
          NOW(),
          NOW() + INTERVAL '1 hour'
        )
      `;

      const response = await del(`/api/${org.slug}/clients/mcp/${scopedClient.client_id}`, {
        cookie: revokerSession.cookieHeader,
      });

      expect(response.status).toBe(200);

      const tokenRows = await getTestDb()`
        SELECT organization_id, revoked_at
        FROM oauth_tokens
        WHERE client_id = ${scopedClient.client_id}
        ORDER BY organization_id ASC
      `;
      expect(tokenRows).toHaveLength(2);
      const tokensByOrg = new Map(
        tokenRows.map((row) => [row.organization_id as string, row.revoked_at as Date | null])
      );
      expect(tokensByOrg.get(org.id)).toBeTruthy();
      expect(tokensByOrg.get(org2.id)).toBeNull();

      const sessionRows = await getTestDb()`
        SELECT session_id, organization_id
        FROM mcp_sessions
        WHERE client_id = ${scopedClient.client_id}
        ORDER BY session_id ASC
      `;
      expect(sessionRows).toHaveLength(0);

      const postRevokeResponse = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'revocation-check-after' },
          },
        },
        headers: { 'mcp-session-id': activeSessionId! },
      });
      expect(postRevokeResponse.status).not.toBe(200);

      const clientRows = await getTestDb()`
        SELECT id
        FROM oauth_clients
        WHERE id = ${scopedClient.client_id}
      `;
      expect(clientRows).toHaveLength(1);
    });

    it('lists and revokes first-ever approved codes before they can mint tokens', async () => {
      const revoker = await createTestUser({});
      await addUserToOrganization(revoker.id, org.id, 'owner');
      const revokerSession = await createTestSession(revoker.id);
      const pendingClient = await createTestOAuthClient({
        client_name: 'Unredeemed Grant Client',
        grant_types: [
          'authorization_code',
          'refresh_token',
          'urn:ietf:params:oauth:grant-type:device_code',
        ],
      });
      const verifier = 'unredeemed-code-verifier-for-revocation';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorizationCode = `unredeemed-auth-${pendingClient.client_id}`;
      const deviceCode = `unredeemed-device-${pendingClient.client_id}`;
      const sql = getTestDb();
      await sql`
        INSERT INTO oauth_authorization_codes (
          code, client_id, user_id, organization_id, granted_organization_ids,
          code_challenge, code_challenge_method, redirect_uri, scope, resource, expires_at
        ) VALUES (
          ${authorizationCode}, ${pendingClient.client_id}, ${revoker.id}, ${org.id},
          ARRAY[${org.id}]::text[], ${challenge}, 'S256', ${pendingClient.redirect_uris[0]},
          'mcp:read', 'http://localhost/mcp', NOW() + INTERVAL '10 minutes'
        )
      `;
      await sql`
        INSERT INTO oauth_device_codes (
          device_code, user_code, client_id, scope, resource, user_id,
          organization_id, granted_organization_ids, status, expires_at
        ) VALUES (
          ${deviceCode}, 'UNREDEEM', ${pendingClient.client_id}, 'mcp:read',
          'http://localhost/mcp', ${revoker.id}, ${org.id}, ARRAY[${org.id}]::text[],
          'approved', NOW() + INTERVAL '10 minutes'
        )
      `;

      const inventory = await get(`/api/${org.slug}/clients`, {
        cookie: revokerSession.cookieHeader,
      });
      expect(inventory.status).toBe(200);
      const inventoryBody = (await inventory.json()) as {
        clients: { id: string }[];
      };
      expect(inventoryBody.clients.map((entry) => entry.id)).toContain(pendingClient.client_id);

      const revoked = await del(`/api/${org.slug}/clients/mcp/${pendingClient.client_id}`, {
        cookie: revokerSession.cookieHeader,
      });
      expect(revoked.status).toBe(200);
      const remainingCodes = await sql`
        SELECT code AS id FROM oauth_authorization_codes WHERE code = ${authorizationCode}
        UNION ALL
        SELECT device_code AS id FROM oauth_device_codes WHERE device_code = ${deviceCode}
      `;
      expect(remainingCodes).toHaveLength(0);

      const authExchange = await post('/oauth/token', {
        body: {
          grant_type: 'authorization_code',
          code: authorizationCode,
          client_id: pendingClient.client_id,
          client_secret: pendingClient.client_secret,
          redirect_uri: pendingClient.redirect_uris[0],
          code_verifier: verifier,
          resource: 'http://localhost/mcp',
        },
      });
      expect(authExchange.status).toBe(400);

      const deviceExchange = await post('/oauth/token', {
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: pendingClient.client_id,
          client_secret: pendingClient.client_secret,
          resource: 'http://localhost/mcp',
        },
      });
      expect(deviceExchange.status).toBe(400);
    });

    it('revoking the displayed owner of a shared registration keeps the coworker connected', async () => {
      const revoker = await createTestUser({});
      await addUserToOrganization(revoker.id, org.id, 'owner');
      const revokerSession = await createTestSession(revoker.id);

      const alice = await createTestUser({});
      await addUserToOrganization(alice.id, org.id);
      const bob = await createTestUser({});
      await addUserToOrganization(bob.id, org.id);

      const sharedClient = await createTestOAuthClient({
        client_name: 'Shared Registration Client',
      });
      const { token: bobToken } = await createAccountAccessToken(
        bob.id,
        org.id,
        sharedClient.client_id
      );
      const { token: aliceToken } = await createAccountAccessToken(
        alice.id,
        org.id,
        sharedClient.client_id
      );
      // Same-second created_at ties break on token id, so pin Alice as the
      // newest grant — the owner the inventory row displays and the revoke
      // must resolve.
      await getTestDb()`
        UPDATE oauth_tokens
        SET created_at = NOW() + INTERVAL '1 minute'
        WHERE client_id = ${sharedClient.client_id}
          AND user_id = ${alice.id}
      `;

      const initMcpSession = async (token: string): Promise<string> => {
        const initResponse = await post('/mcp', {
          body: {
            jsonrpc: '2.0',
            id: '__test_init__',
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'lobu-test', version: '1.0' },
            },
          },
          token,
        });
        const sessionId = initResponse.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();
        await post('/mcp', {
          body: { jsonrpc: '2.0', method: 'notifications/initialized' },
          headers: { 'mcp-session-id': sessionId! },
          token,
        });
        return sessionId!;
      };
      const aliceSessionId = await initMcpSession(aliceToken);
      const bobSessionId = await initMcpSession(bobToken);

      const response = await del(`/api/${org.slug}/clients/mcp/${sharedClient.client_id}`, {
        cookie: revokerSession.cookieHeader,
      });
      expect(response.status).toBe(200);

      const tokenRows = await getTestDb()`
        SELECT user_id, revoked_at
        FROM oauth_tokens
        WHERE client_id = ${sharedClient.client_id}
      `;
      expect(tokenRows).toHaveLength(2);
      const revokedByUser = new Map(
        tokenRows.map((row) => [row.user_id as string, row.revoked_at as Date | null])
      );
      expect(revokedByUser.get(alice.id)).toBeTruthy();
      expect(revokedByUser.get(bob.id)).toBeNull();

      const sessionRows = await getTestDb()`
        SELECT session_id
        FROM mcp_sessions
        WHERE client_id = ${sharedClient.client_id}
      `;
      expect(sessionRows.map((row) => row.session_id)).toEqual([bobSessionId]);

      // Bob's session must survive a pod restart: the recovery path may only
      // refresh his still-valid persisted row, never recreate Alice's.
      clearInMemoryMcpSessionsForTests();

      const bobCall = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'shared-revoke-bob-probe' },
          },
        },
        headers: { 'X-MCP-Format': 'json', 'mcp-session-id': bobSessionId },
        token: bobToken,
      });
      expect(bobCall.status).toBe(200);
      const bobBody = await bobCall.json();
      expect(bobBody.error).toBeUndefined();
      expect(bobBody.result?.isError).not.toBe(true);

      const aliceCall = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_memory',
            arguments: { query: 'shared-revoke-alice-probe' },
          },
        },
        headers: { 'X-MCP-Format': 'json', 'mcp-session-id': aliceSessionId },
        token: aliceToken,
      });
      expect(aliceCall.status).not.toBe(200);
    });

    it('rejects initialize when an authenticated client declares an unknown agent', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'lobu-test',
              version: '1.0',
              agentId: 'missing-agent',
            },
          },
        },
        token,
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error?.message).toContain("Agent 'missing-agent' was not found");
    });

    it('does not let a client-declared agent binding unlock managed-agent instructions', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'directory-client-test',
              version: '1.0',
              agentId: agent.agentId,
            },
          },
        },
        token,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result?.instructions).toContain('### Writes and approvals');
      expect(body.result?.instructions).not.toContain(
        "You have persistent memory. Use it proactively — don't wait to be asked."
      );
      expect(body.result?.instructions).not.toContain('### Saving (do this automatically)');
    });
  });

  describe('Session Cookie Authentication', () => {
    it('allows a signed-in non-member to call public-readable REST tools on a public org', async () => {
      const response = await post(`/api/${publicOrg.slug}/manage_entity`, {
        body: {
          action: 'list',
          entity_type: 'brand',
          limit: 50,
        },
        cookie: sessionCookie,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: publicEntity.id,
            name: publicEntity.name,
            entity_type: publicEntity.entity_type,
          }),
        ])
      );
    });

    it('still blocks signed-in non-members from mutating a public org through REST tools', async () => {
      const response = await post(`/api/${publicOrg.slug}/manage_entity`, {
        body: {
          action: 'create',
          entity_type: 'brand',
          name: 'Should Not Be Created',
        },
        cookie: sessionCookie,
      });

      // 403 (forbidden) — the caller is authenticated but lacks the role to
      // mutate a public workspace they're not a member of. (Earlier versions
      // of this test asserted 400; the auth refactor introduced an explicit
      // role check that returns the more accurate 403.)
      expect(response.status).toBe(403);
    });
  });

  describe('Human approval transport boundary', () => {
    let approvalSession: Awaited<ReturnType<typeof createTestSession>>;

    beforeAll(async () => {
      const approvalOwner = await createTestUser({
        email: 'mcp-session-approval-owner@test.example.com',
      });
      await addUserToOrganization(approvalOwner.id, org.id, 'owner');
      approvalSession = await createTestSession(approvalOwner.id);
    });

    async function seedPendingApproval(): Promise<number> {
      const [run] = await getTestDb()<[{ id: number }]>`
        INSERT INTO runs (
          organization_id, run_type, status, approval_status, action_key
        ) VALUES (
          ${org.id}, 'action', 'pending', 'pending', 'session_auth_reject_probe'
        )
        RETURNING id
      `;
      return Number(run.id);
    }

    async function approvalStatus(runId: number): Promise<string> {
      const [run] = await getTestDb()<[{ approval_status: string }]>`
        SELECT approval_status
        FROM runs
        WHERE id = ${runId} AND organization_id = ${org.id}
      `;
      return String(run?.approval_status ?? 'missing');
    }

    it('denies direct approve/reject sent through an unbound cookie-authenticated MCP session', async () => {
      const approveRunId = await seedPendingApproval();
      const rejectRunId = await seedPendingApproval();
      const calls = [];
      for (const arguments_ of [
        { action: 'approve', run_id: approveRunId },
        { action: 'reject', run_id: rejectRunId, reason: 'MCP must not decide' },
      ]) {
        calls.push(
          await mcpRequest<{ content?: Array<{ text?: string }> }>(
            'tools/call',
            { name: 'manage_operations', arguments: arguments_ },
            { cookie: approvalSession.cookieHeader, orgSlug: org.slug }
          )
        );
      }

      expect(await approvalStatus(approveRunId)).toBe('pending');
      expect(await approvalStatus(rejectRunId)).toBe('pending');
      for (const call of calls) {
        expect(call.error).toBeUndefined();
        expect(call.result?.content?.[0]?.text).toContain('human web session');
      }
    });

    it('denies approve/reject through run_sdk on an unbound Better Auth session bearer', async () => {
      const approveRunId = await seedPendingApproval();
      const rejectRunId = await seedPendingApproval();
      const result = await mcpRequest<{ content?: Array<{ text?: string }> }>(
        'tools/call',
        {
          name: 'run_sdk',
          arguments: {
            script: `export default async (_ctx, client) => {
              const message = async (call) => {
                try {
                  const value = await call();
                  return JSON.stringify(value);
                } catch (error) {
                  return String(error && error.message ? error.message : error);
                }
              };
              return {
                approve: await message(() => client.operations.approve({ run_id: ${approveRunId} })),
                reject: await message(() => client.operations.reject({ run_id: ${rejectRunId}, reason: 'MCP SDK must not decide' })),
              };
            };`,
          },
        },
        { token: approvalSession.token, orgSlug: org.slug }
      );

      expect(result.error).toBeUndefined();
      expect(await approvalStatus(approveRunId)).toBe('pending');
      expect(await approvalStatus(rejectRunId)).toBe('pending');
      const text = result.result?.content?.[0]?.text ?? '';
      expect(text.match(/human web session/g) ?? []).toHaveLength(2);
    });
  });

  describe('Personal Access Token Authentication', () => {
    it('should accept valid PAT (owl_pat_*)', async () => {
      const { token } = await createTestPAT(user.id, org.id);

      const result = await mcpListTools({ token });

      expect(result.tools).toBeInstanceOf(Array);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should reject invalid PAT format', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'owl_pat_invalid_token_hash',
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('should reject org-bound PAT on a different organization route', async () => {
      const org2 = await createTestOrganization({ name: 'PAT Other Org' });
      await addUserToOrganization(user.id, org2.id);
      const { token } = await createTestPAT(user.id, org.id);

      const response = await post(`/mcp/${org2.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('forbidden');
      expect(body.error_description).toContain(
        'Token organization does not match URL organization'
      );
    });

    it('rejects an OAuth target outside the immutable grant even when the user is a member', async () => {
      const org2 = await createTestOrganization({
        name: 'OAuth Cross-Org Target',
      });
      await addUserToOrganization(user.id, org2.id);
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const response = await post(`/mcp/${org2.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'forbidden',
        error_description: 'Workspace is not available for this authorization',
      });
    });

    it('rejects OAuth cross-org call when user is not a member', async () => {
      const org2 = await createTestOrganization({ name: 'OAuth Stranger Org' });
      // Deliberately not adding user to org2.
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const response = await post(`/mcp/${org2.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('forbidden');
      expect(body.error_description).toBe('Workspace is not available for this authorization');
    });

    it('should reject PAT without owl_pat_ prefix', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'not_a_valid_pat_format',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Scoped /mcp/{slug} membership-role resolution', () => {
    // Regression: scoped sessions derived org from the URL slug and user from
    // the token but never looked up the caller's membership row, so `memberRole`
    // stayed null even for an owner — role-gated actions wrongly denied real
    // members. `connections.install_connector` is a genuinely admin-only action
    // (OWNER_ADMIN_ACTIONS); `catalog.list_installed` is READ-tier (a normal
    // token discovers connectors). Together they prove the role resolved AND
    // isn't over-granted.
    it('resolves an OWNER role on a scoped session (admin-only action allowed)', async () => {
      const roleOrg = await createTestOrganization({ name: 'Scoped Role Org' });
      const owner = await createTestUser({});
      await addUserToOrganization(owner.id, roleOrg.id, 'owner');
      const { token } = await createTestPAT(owner.id, roleOrg.id, {
        scope: 'mcp:read mcp:write mcp:admin',
      });

      // install_connector requires admin/owner. Pre-fix this threw
      // "requires ... admin access" on the scoped endpoint because memberRole
      // was null. run_sdk exposes write/admin methods (query_sdk does not), so
      // this genuinely reaches the admin gate. A bad connector_id still reaches
      // the handler (proving the access gate passed) and fails with a business
      // error, not an auth denial.
      const result = await mcpToolsCall(
        'run_sdk',
        {
          script:
            'export default async (_c, client) => { try { await client.connections.installConnector({ connector_id: "__nonexistent__" }); return { denied: false }; } catch (e) { return { denied: /admin/i.test(String(e && e.message)), msg: String(e && e.message) }; } }',
        },
        { token, orgSlug: roleOrg.slug }
      );
      // Owner is NOT denied by the admin gate (it may fail for a missing
      // connector, but never with an admin-access denial).
      expect(result.return_value?.denied).toBe(false);
    });

    it('allows a bare OAuth client to explicitly target its sole granted workspace', async () => {
      const singletonOrg = await createTestOrganization({
        name: 'Singleton Explicit Grant Org',
        slug: 'singleton-explicit-grant-org',
      });
      const singletonUser = await createTestUser({});
      await addUserToOrganization(singletonUser.id, singletonOrg.id, 'member');
      const { token } = await createAccountAccessToken(
        singletonUser.id,
        singletonOrg.id,
        client.client_id,
        { scope: 'mcp:read mcp:write' }
      );
      await getTestDb()`
        UPDATE oauth_tokens
        SET granted_organization_ids = ARRAY[${singletonOrg.id}]::text[]
        WHERE token_hash = ${hashToken(token)}
      `;

      const sdk = await mcpToolsCall<any>(
        'run_sdk',
        {
          script: `export default async (_ctx, client) => {
            const target = await client.org(${JSON.stringify(singletonOrg.slug)});
            return target.organizations.current();
          };`,
        },
        { token }
      );
      expect(sdk.success).toBe(true);
      expect(sdk.return_value).toMatchObject({ id: singletonOrg.id, slug: singletonOrg.slug });

      const result = await mcpToolsCall<any>(
        'query_sql',
        {
          sql: 'SELECT 1 AS ok',
          org_slug: singletonOrg.slug,
        },
        { token }
      );

      expect(result.error).toBeUndefined();
      expect(result.rows).toEqual([{ ok: 1 }]);

      const init = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 'single-grant-init',
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'single-grant-test', version: '1.0' },
          },
        },
        token,
      });
      const initBody = await init.json();
      expect(initBody.result?.instructions).not.toContain('primary workspace');
      expect(initBody.result?.instructions).toContain('client.org(');
    });

    it('uses the selected workspace role for cross-org SDK mutations on unscoped OAuth only', async () => {
      const otherGrantedOrg = await createTestOrganization({
        name: 'Cross-Org SDK Other',
        slug: 'cross-org-sdk-other',
      });
      const targetOrg = await createTestOrganization({
        name: 'Cross-Org SDK Target',
        slug: 'cross-org-sdk-target',
      });
      const crossOrgOwner = await createTestUser({});
      await addUserToOrganization(crossOrgOwner.id, otherGrantedOrg.id, 'member');
      await addUserToOrganization(crossOrgOwner.id, targetOrg.id, 'owner');
      const targetAgent = await createTestAgent({
        organizationId: targetOrg.id,
        ownerUserId: crossOrgOwner.id,
      });
      const sql = getTestDb();
      const [targetDevice] = await sql<[{ id: string }]>`
        INSERT INTO device_workers (
          user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds
        ) VALUES (
          ${crossOrgOwner.id}, 'cross-org-sdk-device', 'macos', ${sql.json([])},
          'Cross-Org SDK Device', ${targetOrg.id}, ${'{opencode,codex}'}::text[]
        )
        RETURNING id
      `;
      const { token } = await createAccountAccessToken(
        crossOrgOwner.id,
        otherGrantedOrg.id,
        client.client_id,
        { scope: 'mcp:read mcp:write mcp:admin' }
      );
      await sql`
        UPDATE oauth_tokens
        SET granted_organization_ids = ARRAY[${otherGrantedOrg.id}, ${targetOrg.id}]::text[]
        WHERE token_hash = ${hashToken(token)}
      `;

      const listed = await mcpListTools({ token });
      expect(listed.tools.some((tool: any) => tool.name === 'run_sdk')).toBe(true);
      const discovery = await mcpToolsCall<any>(
        'search_sdk',
        { query: 'automations.create' },
        { token }
      );
      expect(discovery.match_count).toBe(1);

      const result = await mcpToolsCall<any>(
        'run_sdk',
        {
          script: `export default async (_ctx, client) => {
            const target = await client.org(${JSON.stringify(targetOrg.slug)});
            return target.automations.create({
              slug: 'cross-org-sdk-created',
              name: 'Cross-Org SDK Created',
              prompt: 'Prove target-aware mutation authorization.',
              managed_agent_id: ${JSON.stringify(targetAgent.agentId)},
              device_worker_id: ${JSON.stringify(String(targetDevice.id))},
              agent_kind: 'opencode'
            });
          };`,
        },
        { token }
      );
      expect(result.success).toBe(true);
      expect(result.return_value).toEqual(
        expect.objectContaining({
          action: 'create',
          automation_id: expect.any(String),
        })
      );
      expect(result.return_value).not.toHaveProperty('id');

      const updated = await mcpToolsCall<any>(
        'run_sdk',
        {
          script: `export default async (_ctx, client) => {
            const target = await client.org(${JSON.stringify(targetOrg.slug)});
            return target.automations.update({
              automation_id: ${JSON.stringify(result.return_value.automation_id)},
              agent_kind: 'codex'
            });
          };`,
        },
        { token }
      );
      expect(updated.success).toBe(true);

      const [created] = await getTestDb()<
        [
          {
            organization_id: string;
            device_worker_id: string;
            agent_kind: string;
          },
        ]
      >`
        SELECT organization_id, device_worker_id, agent_kind
        FROM automations
        WHERE id = ${result.return_value.automation_id}
      `;
      expect(created.organization_id).toBe(targetOrg.id);
      expect(created.device_worker_id).toBe(String(targetDevice.id));
      expect(created.agent_kind).toBe('codex');

      const scoped = await mcpRequest<any>(
        'tools/call',
        {
          name: 'run_sdk',
          arguments: {
            script: `export default async (_ctx, client) => {
              await client.org(${JSON.stringify(targetOrg.slug)});
              return { reached: true };
            };`,
          },
        },
        { token, orgSlug: otherGrantedOrg.slug }
      );
      expect(scoped.result?.structuredContent?.success).toBe(false);
      expect(scoped.result?.structuredContent?.error?.message).toMatch(
        /cross-org access is not available/i
      );
    });

    it('denies a cross-org admin mutation when the selected workspace role is only member', async () => {
      const otherGrantedOrg = await createTestOrganization({
        name: 'Cross-Org Deny Other',
        slug: 'cross-org-deny-other',
      });
      const targetOrg = await createTestOrganization({
        name: 'Cross-Org Deny Target',
        slug: 'cross-org-deny-target',
      });
      const crossOrgMember = await createTestUser({});
      // Owner in another grant, plain member in the selected workspace.
      // The selected target's live role must govern the mutation.
      await addUserToOrganization(crossOrgMember.id, otherGrantedOrg.id, 'owner');
      await addUserToOrganization(crossOrgMember.id, targetOrg.id, 'member');
      const targetAgent = await createTestAgent({
        organizationId: targetOrg.id,
        ownerUserId: crossOrgMember.id,
      });
      const { token } = await createAccountAccessToken(
        crossOrgMember.id,
        otherGrantedOrg.id,
        client.client_id,
        { scope: 'mcp:read mcp:write mcp:admin' }
      );
      await getTestDb()`
        UPDATE oauth_tokens
        SET granted_organization_ids = ARRAY[${otherGrantedOrg.id}, ${targetOrg.id}]::text[]
        WHERE token_hash = ${hashToken(token)}
      `;

      const denied = await mcpToolsCall<any>(
        'run_sdk',
        {
          script: `export default async (_ctx, client) => {
            const target = await client.org(${JSON.stringify(targetOrg.slug)});
            return target.automations.create({
              slug: 'cross-org-deny-created',
              name: 'Cross-Org Deny Created',
              prompt: 'Must not be created.',
              managed_agent_id: ${JSON.stringify(targetAgent.agentId)}
            });
          };`,
        },
        { token }
      );
      expect(denied.success).toBe(false);
      // Assert the REASON, not just the failure: the target workspace's role is
      // what denies. A passing `success: false` alone would also match an
      // unrelated fault (bad agent id, missing device) and hide a regression.
      expect(denied.error?.message).toMatch(
        /organization-level write access is required|requires admin or owner access/i
      );

      const rows = await getTestDb()`
        SELECT id FROM automations
        WHERE organization_id = ${targetOrg.id} AND slug = 'cross-org-deny-created'
      `;
      expect(rows).toHaveLength(0);
    });

    it('offers an owner at write tier progressive authorization for nested admin SDK methods', async () => {
      const roleOrg = await createTestOrganization({ name: 'Scoped Progressive Admin Org' });
      const owner = await createTestUser({});
      await addUserToOrganization(owner.id, roleOrg.id, 'owner');
      const { token } = await createTestPAT(owner.id, roleOrg.id, {
        scope: 'mcp:read mcp:write',
      });

      const listed = await mcpListTools({ token, orgSlug: roleOrg.slug });
      const runSdk = listed.tools.find((tool: any) => tool.name === 'run_sdk');
      expect(runSdk?.securitySchemes).toEqual([
        { type: 'oauth2', scopes: ['mcp:write', 'profile:read'] },
        { type: 'oauth2', scopes: ['mcp:write', 'mcp:admin', 'profile:read'] },
      ]);
      expect(runSdk?._meta?.securitySchemes).toEqual(runSdk?.securitySchemes);

      const discovery = await mcpToolsCall(
        'search_sdk',
        { query: 'connections.installConnector' },
        { token, orgSlug: roleOrg.slug }
      );
      expect(discovery.match_count).toBe(1);
      expect(discovery.results[0]).toContain('access: admin');

      const response = await mcpRequest<any>(
        'tools/call',
        {
          name: 'run_sdk',
          arguments: {
            script:
              'export default async (_c, client) => { await client.connections.installConnector({ connector_id: "__nonexistent__" }); return { ok: true }; }',
          },
        },
        { token, orgSlug: roleOrg.slug }
      );
      const result = response.result as any;
      const challenge = result?._meta?.['mcp/www_authenticate']?.[0];

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.success).toBe(false);
      expect(result?.structuredContent?.error?.message).toContain('admin access');
      expect(result?.structuredContent?.started_side_effects).toEqual([
        { path: 'connections.installConnector', access: 'admin', count: 1 },
      ]);
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="mcp:read mcp:write mcp:admin profile:read"');
    });

    it('does not challenge when an owner catches a nested admin denial and run_sdk succeeds', async () => {
      const roleOrg = await createTestOrganization({ name: 'Scoped Caught Admin Org' });
      const owner = await createTestUser({});
      await addUserToOrganization(owner.id, roleOrg.id, 'owner');
      const { token } = await createTestPAT(owner.id, roleOrg.id, {
        scope: 'mcp:read mcp:write',
      });

      const response = await mcpRequest<any>(
        'tools/call',
        {
          name: 'run_sdk',
          arguments: {
            script:
              'export default async (_c, client) => { try { await client.connections.installConnector({ connector_id: "__nonexistent__" }); } catch { return { ok: true, caught: true }; } return { ok: false, caught: false }; }',
          },
        },
        { token, orgSlug: roleOrg.slug }
      );
      const result = response.result as any;

      expect(result?.isError).not.toBe(true);
      expect(result?.structuredContent?.success).toBe(true);
      expect(result?.structuredContent?.return_value).toEqual({ ok: true, caught: true });
      expect(result?._meta?.['mcp/www_authenticate']).toBeUndefined();
    });

    it('lets a normal MEMBER discover connectors (list_installed is read-tier) but NOT do admin actions', async () => {
      const roleOrg = await createTestOrganization({
        name: 'Scoped Member Org',
      });
      const member = await createTestUser({});
      await addUserToOrganization(member.id, roleOrg.id, 'member');
      const { token } = await createTestPAT(member.id, roleOrg.id, {
        scope: 'mcp:read mcp:write',
      });

      // READ-tier discovery works for a plain member with a default-scoped token.
      const discover = await mcpToolsCall(
        'query_sdk',
        {
          script:
            'export default async (_c, client) => { await client.catalog.listInstalled({ kinds: ["connectors"] }); return { ok: true }; }',
        },
        { token, orgSlug: roleOrg.slug }
      );
      expect(discover.success).toBe(true);

      // But an admin-only action is still denied (no over-grant). run_sdk DOES
      // expose installConnector, so this reaches the admin gate — and a default
      // (mcp:read mcp:write) member token is denied there. This proves the
      // member's role resolved AND was not over-granted, the mirror of the
      // owner case above.
      const admin = await mcpToolsCall(
        'run_sdk',
        {
          script:
            'export default async (_c, client) => { await client.connections.installConnector({ connector_id: "__nonexistent__" }); return { ok: true }; }',
        },
        { token, orgSlug: roleOrg.slug }
      );
      expect(admin.success).toBe(false);
      expect(admin.error?.message).toMatch(
        /admin or owner access|admin access|not a function|not available/i
      );
    });

    it('never offers a regular member an mcp:admin escalation', async () => {
      const roleOrg = await createTestOrganization({ name: 'Scoped Non-Admin Org' });
      const member = await createTestUser({});
      await addUserToOrganization(member.id, roleOrg.id, 'member');
      const { token } = await createTestPAT(member.id, roleOrg.id, {
        scope: 'mcp:read mcp:write',
      });

      const listed = await mcpListTools({ token, orgSlug: roleOrg.slug });
      const runSdk = listed.tools.find((tool: any) => tool.name === 'run_sdk');
      expect(runSdk?.securitySchemes).toEqual([
        { type: 'oauth2', scopes: ['mcp:write', 'profile:read'] },
      ]);

      const discovery = await mcpToolsCall(
        'search_sdk',
        { query: 'connections.installConnector' },
        { token, orgSlug: roleOrg.slug }
      );
      expect(discovery.match_count).toBe(0);

      const response = await mcpRequest<any>(
        'tools/call',
        {
          name: 'run_sdk',
          arguments: {
            script:
              'export default async (_c, client) => { await client.connections.installConnector({ connector_id: "__nonexistent__" }); }',
          },
        },
        { token, orgSlug: roleOrg.slug }
      );
      const result = response.result as any;

      expect(result?.structuredContent?.success).toBe(false);
      expect(result?._meta?.['mcp/www_authenticate']).toBeUndefined();
    });
  });

  // The pre-#438 "JSON-RPC -32001 Organization context required" error path
  // no longer exists — anonymous calls now get HTTP 401 with WWW-Authenticate
  // before they ever reach the org-context guard. That contract is covered
  // by "challenges unauthenticated requests…" in the Unauthenticated block.
  describe('JSON-RPC Error Handling', () => {
    it('should handle malformed JSON-RPC requests', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const response = await post('/mcp', {
        body: {
          // Missing jsonrpc version
          id: 1,
          method: 'tools/list',
        },
        token,
      });

      // Should either reject or handle gracefully
      expect(response.status).toBeLessThan(500);
      // Body should be valid JSON regardless of success/failure
      const body = await response.json();
      expect(body).toBeDefined();
    });
  });

  describe('tools/list Response', () => {
    it('should return list of available tools', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      });

      const result = await mcpListTools({ token, orgSlug: org.slug });

      expect(result.tools).toBeInstanceOf(Array);

      const serializedTools = JSON.stringify(result.tools).toLowerCase();
      for (const retiredTerm of [
        'wat' + 'cher',
        'behav' + 'ior',
        'behav' + 'iour',
      ]) {
        expect(serializedTools).not.toContain(retiredTerm);
      }

      // MCP tools/list is the agent surface only — admin flat tools dispatch
      // via REST and tools/call by name but are not advertised here.
      const toolNames = result.tools.map((t: any) => t.name);
      expect(toolNames.sort()).toEqual(
        [
          'query_sdk',
          'query_sql',
          'get_approval',
          'run_sdk',
          'save_memory',
          'search_memory',
          'search_sdk',
        ].sort()
      );
      expect(toolNames).not.toContain('list_organizations');
      expect(toolNames).not.toContain('list_metrics');
      expect(toolNames).not.toContain('query_metric');
      expect(toolNames).not.toContain('metric_series');
      expect(toolNames).not.toContain('list_automations');
      expect(toolNames).not.toContain('manage_entity');
      expect(toolNames).not.toContain('read_knowledge');
      expect(toolNames).not.toContain('execute');
      expect(toolNames).not.toContain('join_organization');

      const runSdk = (result.tools as any[]).find((tool) => tool.name === 'run_sdk');
      expect(runSdk?.securitySchemes).toEqual([
        { type: 'oauth2', scopes: ['mcp:write', 'profile:read'] },
      ]);
    });

    it('lists Automations through the consolidated internal admin tool', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const result = await mcpToolsCall<{ automations?: unknown[] }>(
        'manage_automations',
        { action: 'list', status: 'active' },
        { token, orgSlug: org.slug }
      );
      expect(Array.isArray(result.automations)).toBe(true);
    });

    it('should include tool descriptions', async () => {
      const { token } = await createAccountAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });

      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
      }
    });
  });

  describe('Device flow workspace grants and device ownership', () => {
    let deviceClient: Awaited<ReturnType<typeof createTestOAuthClient>>;

    beforeAll(async () => {
      deviceClient = await createTestOAuthClient({
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      });
    });

    it('approves ordinary device-code login with explicit grants and no target', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: 'http://localhost/mcp',
      });

      await verifyDeviceCode(dc.userCode, sessionCookie);
      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_ids: [org.id],
          workspace_access: 'selected',
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe('approved');
      const [approved] =
        await getTestDb()`SELECT organization_id FROM oauth_device_codes WHERE device_code = ${dc.deviceCode}`;
      expect(approved.organization_id).toBeNull();
    });

    it('rejects ordinary device-code login without a workspace grant selection', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: 'http://localhost/mcp',
      });

      await verifyDeviceCode(dc.userCode, sessionCookie);
      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('workspace access selection');
    });

    it('should use resource org slug when present (existing semantics)', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: `http://localhost/mcp/${org.slug}`,
      });

      await verifyDeviceCode(dc.userCode, sessionCookie);
      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe('approved');
    });

    it('rejects device-code consent for an unavailable workspace grant', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: 'http://localhost/mcp',
      });

      await verifyDeviceCode(dc.userCode, sessionCookie);
      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_ids: ['org_nonexistent_12345'],
          workspace_access: 'selected',
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('access_denied');
    });

    it('requires an explicit grant selection even when a personal workspace exists', async () => {
      // Account login must not turn personal workspace ownership into a grant.
      const sql = getTestDb();
      const pUser = await createTestUser({});
      const personalOrg = await createTestOrganization({
        name: 'Personal Org (device)',
      });
      await addUserToOrganization(pUser.id, personalOrg.id);
      // organization.metadata is text storing JSON (see findExistingPersonalOrg).
      await sql`
        UPDATE "organization"
        SET metadata = ${JSON.stringify({ personal_org_for_user_id: pUser.id })}
        WHERE id = ${personalOrg.id}
      `;
      const otherOrg = await createTestOrganization({
        name: 'Other Org (device)',
      });
      await addUserToOrganization(pUser.id, otherOrg.id);

      const pSession = await createTestSession(pUser.id);
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: 'http://localhost/mcp',
      });

      await verifyDeviceCode(dc.userCode, pSession.cookieHeader);
      const response = await post('/oauth/device/approve', {
        body: { user_code: dc.userCode, approved: true },
        cookie: pSession.cookieHeader,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('workspace access selection');
    });

    it('grants the selected team workspace without making Personal the execution target', async () => {
      // An ordinary login selects access, independently of its personal workspace.
      const sql = getTestDb();
      const pUser = await createTestUser({});
      const personalOrg = await createTestOrganization({
        name: 'Personal Org (device override)',
      });
      await addUserToOrganization(pUser.id, personalOrg.id);
      await sql`
        UPDATE "organization"
        SET metadata = ${JSON.stringify({ personal_org_for_user_id: pUser.id })}
        WHERE id = ${personalOrg.id}
      `;
      const otherOrg = await createTestOrganization({
        name: 'Other Org (device override)',
      });
      await addUserToOrganization(pUser.id, otherOrg.id);

      const pSession = await createTestSession(pUser.id);
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: 'http://localhost/mcp',
      });

      await verifyDeviceCode(dc.userCode, pSession.cookieHeader);
      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_ids: [otherOrg.id],
          workspace_access: 'selected',
        },
        cookie: pSession.cookieHeader,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe('approved');
      const [approved] =
        await getTestDb()`SELECT organization_id, granted_organization_ids FROM oauth_device_codes WHERE device_code = ${dc.deviceCode}`;
      expect(approved.organization_id).toBeNull();
      expect(parsePgTextArray(approved.granted_organization_ids)).toEqual([otherOrg.id]);
    });

    it('keeps a verified device-worker grant bound to its personal workspace', async () => {
      await getTestDb()`UPDATE organization SET metadata = ${JSON.stringify({ personal_org_for_user_id: user.id })} WHERE id = ${org.id}`;
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        scope: 'mcp:read mcp:write device_worker:run',
      });

      // Verified device-worker consent retains the personal data ownership rule.
      await verifyDeviceCode(dc.userCode, sessionCookie);
      const approveRes = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_ids: [org.id],
          workspace_access: 'selected',
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
        env: { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' },
      });
      expect(approveRes.status).toBe(200);

      // The device exchanges its device code for an access token.
      const tokenRes = await post('/oauth/token', {
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: dc.deviceCode,
          client_id: deviceClient.client_id,
          client_secret: deviceClient.client_secret,
        },
      });
      expect(tokenRes.status).toBe(200);
      const { access_token: accessToken } = (await tokenRes.json()) as {
        access_token: string;
      };
      expect(accessToken).toBeTruthy();

      // First poll registers the worker under its explicitly verified device home.
      const workerId = `test-mac-${Date.now()}`;
      const pollRes = await post('/api/workers/poll', {
        body: { worker_id: workerId, capabilities: {} },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(pollRes.status).toBe(200);

      const rows = (await getTestDb()`
        SELECT organization_id FROM device_workers WHERE worker_id = ${workerId} LIMIT 1
      `) as Array<{ organization_id: string | null }>;
      expect(rows[0]?.organization_id).toBe(org.id);
    });

    // The Owletto extension's service-worker poll unavoidably carries the
    // gateway's Better Auth session cookie — Chrome attaches it to
    // host-permission fetches regardless of `credentials: "omit"`. When the
    // extension's OAuth access token expires, the Bearer fails and auth falls
    // back to that cookie: a real user session, but with no worker scopes.
    // Worker endpoints must reject it with 401 (which the poller recovers from
    // via tryRefreshToken), NOT the 403 it used to return and could not act on.
    // Contrast: the device-token poll above (a scoped Bearer) returns 200.
    it('rejects a browser session cookie on worker endpoints with 401', async () => {
      const response = await post('/api/workers/poll', {
        body: { worker_id: `sess-${Date.now()}`, capabilities: {} },
        cookie: sessionCookie,
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });
  });
});
