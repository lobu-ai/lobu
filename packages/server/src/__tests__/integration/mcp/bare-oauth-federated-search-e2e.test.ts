/**
 * Bare-OAuth federated search, through the real local wire:
 * DCR -> explicit PKCE consent -> token exchange -> `/oauth/userinfo` ->
 * `/mcp` initialize/call.
 *
 * The only direct database mutation after setup is membership revocation,
 * which proves an already-established MCP session revalidates live membership
 * instead of trusting the immutable OAuth grant snapshot by itself.
 */

import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthorizationIntent } from '../../../auth/oauth/authorization-intent';
import { hashToken } from '../../../auth/oauth/utils';
import { parsePgTextArray } from '../../../db/client';
import { getMcpTools } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { get, mcpToolsCall, post } from '../../setup/test-helpers';

const ORIGIN = 'http://localhost';
const SEARCH_NAME = 'Bare OAuth Federated Needle';
const MULTI_GRANT_ENV = { LOBU_OAUTH_MULTI_WORKSPACE_GRANTS: '1' } as const;

interface SearchResult {
  entity: { id: number; workspace_slug: string | null } | null;
  matches: Array<{ id: number; workspace_slug: string | null }>;
  coverage?: {
    scope: string;
    workspaces?: Array<{ workspace_slug: string; status: string }>;
  };
}

beforeAll(async () => {
  await initWorkspaceProvider();
});

describe('bare OAuth /mcp federated search end to end', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('honors the explicit workspace grant and live membership on every search', async () => {
    const sql = getTestDb();
    const workspaceA = await createTestOrganization({ name: 'OAuth Search Alpha' });
    const workspaceB = await createTestOrganization({ name: 'OAuth Search Beta' });
    const workspaceC = await createTestOrganization({ name: 'OAuth Search Ungranted' });
    const user = await createTestUser({ name: 'OAuth Search User' });
    await Promise.all([
      addUserToOrganization(user.id, workspaceA.id, 'owner'),
      addUserToOrganization(user.id, workspaceB.id, 'admin'),
      addUserToOrganization(user.id, workspaceC.id, 'owner'),
    ]);
    const session = await createTestSession(user.id);
    const [entityA, entityB, entityC] = await Promise.all([
      createTestEntity({
        name: SEARCH_NAME,
        organization_id: workspaceA.id,
        created_by: user.id,
      }),
      createTestEntity({
        name: SEARCH_NAME,
        organization_id: workspaceB.id,
        created_by: user.id,
      }),
      createTestEntity({
        name: SEARCH_NAME,
        organization_id: workspaceC.id,
        created_by: user.id,
      }),
    ]);

    const redirectUri = `${ORIGIN}/bare-oauth-search-callback`;
    const resource = `${ORIGIN}/mcp`;
    const registration = await post('/oauth/register', {
      body: {
        client_name: 'Bare OAuth Search E2E',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    // Request exactly what the published tool metadata advertises, as an MCP
    // host does. Hardcoding the scope here would still pass if that metadata
    // stopped asking for identity, which is the failure this covers.
    const searchTool = getMcpTools().find((tool) => tool.name === 'search_memory');
    const scope = (searchTool?.securitySchemes?.[0]?.scopes ?? []).join(' ');
    expect(scope).toContain('mcp:read');

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const consent = await post('/oauth/authorize/consent', {
      body: {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
        organization_ids: [workspaceA.id, workspaceB.id],
        workspace_access: 'selected',
        authorization_intent: createAuthorizationIntent(
          {
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource,
          },
          'test-jwt-secret-for-testing-only'
        ),
        approved: true,
      },
      cookie: session.cookieHeader,
      headers: { Origin: ORIGIN },
      env: MULTI_GRANT_ENV,
    });
    expect(consent.status).toBe(200);
    const { redirect_url: redirectUrl } = (await consent.json()) as { redirect_url: string };
    const code = new URL(redirectUrl).searchParams.get('code');
    expect(code).toBeTruthy();

    const tokenResponse = await post('/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      },
      env: MULTI_GRANT_ENV,
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token: accessToken, refresh_token: refreshToken } =
      (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    expect(accessToken).toBeTruthy();

    // The metadata-derived scope must actually unlock the identity call a host
    // makes before it initializes MCP.
    const identity = await get('/oauth/userinfo', { token: accessToken });
    expect(identity.status).toBe(200);
    expect(((await identity.json()) as { sub: string }).sub).toBe(user.id);

    // Advertising `profile:read` only shapes the REQUEST: a token refreshed
    // without it loses identity access instead of being silently widened.
    const withoutIdentity = await post('/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        resource,
        scope: 'mcp:read',
      },
      env: MULTI_GRANT_ENV,
    });
    expect(withoutIdentity.status).toBe(200);
    const mcpOnly = (await withoutIdentity.json()) as { access_token: string; scope: string };
    expect(mcpOnly.scope).toBe('mcp:read');
    expect((await get('/oauth/userinfo', { token: mcpOnly.access_token })).status).toBe(403);

    const tokenRows = await sql`
      SELECT organization_id, granted_organization_ids
      FROM oauth_tokens
      WHERE token_hash = ${hashToken(accessToken)}
        AND token_type = 'access'
      LIMIT 1
    `;
    expect(tokenRows[0]?.organization_id).toBeNull();
    expect(
      parsePgTextArray(tokenRows[0]?.granted_organization_ids as string | null)
    ).toEqual([workspaceA.id, workspaceB.id]);

    const searchArgs = {
      query: SEARCH_NAME,
      fuzzy: false,
      include_content: false,
      include_connections: false,
      include_public_catalogs: false,
      limit: 10,
    };
    const allGranted = await mcpToolsCall<SearchResult>('search_memory', searchArgs, {
      token: accessToken,
    });
    expect(allGranted.matches.map((match) => match.id).sort()).toEqual(
      [entityA.id, entityB.id].sort()
    );
    expect(allGranted.matches.map((match) => match.workspace_slug).sort()).toEqual(
      [workspaceA.slug, workspaceB.slug].sort()
    );
    expect(allGranted.entity).toBeNull();
    expect(allGranted.coverage?.scope).toBe('all_granted');
    expect(allGranted.coverage?.workspaces?.map((entry) => entry.workspace_slug)).toEqual([
      workspaceA.slug,
      workspaceB.slug,
    ]);
    expect(allGranted.matches.map((match) => match.id)).not.toContain(entityC.id);
    expect(JSON.stringify(allGranted)).not.toContain(workspaceC.slug);

    const narrowed = await mcpToolsCall<SearchResult>(
      'search_memory',
      { ...searchArgs, workspace: workspaceB.slug },
      { token: accessToken }
    );
    expect(narrowed.matches.map((match) => match.id)).toEqual([entityB.id]);
    expect(narrowed.matches[0]?.workspace_slug).toBe(workspaceB.slug);

    await sql`
      DELETE FROM member
      WHERE "userId" = ${user.id}
        AND "organizationId" = ${workspaceB.id}
    `;

    const afterRevocation = await mcpToolsCall<SearchResult>('search_memory', searchArgs, {
      token: accessToken,
    });
    expect(afterRevocation.matches.map((match) => match.id)).toEqual([entityA.id]);
    expect(afterRevocation.matches[0]?.workspace_slug).toBe(workspaceA.slug);
    expect(JSON.stringify(afterRevocation)).not.toContain(workspaceB.slug);
    expect(JSON.stringify(afterRevocation)).not.toContain(workspaceC.slug);

    const errorFor = async (workspace: string): Promise<string> => {
      try {
        await mcpToolsCall<SearchResult>(
          'search_memory',
          { ...searchArgs, workspace },
          { token: accessToken }
        );
        return 'unexpected success';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const revokedError = await errorFor(workspaceB.slug);
    const unknownError = await errorFor('workspace-that-does-not-exist');
    expect(revokedError).toBe(unknownError);
    expect(revokedError).toContain('Workspace is not available for this connection.');
    expect(revokedError).not.toContain(workspaceB.slug);
  });
});
