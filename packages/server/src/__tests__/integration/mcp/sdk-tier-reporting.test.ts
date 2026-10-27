/**
 * Acceptance test for the reported MCP symptom: an mcp:write caller asked
 * search_sdk about an admin-enforced `external` method, was told it needed
 * "operate (mcp:write)" — the tier it already had — retried through run_sdk as
 * instructed, and hit a hard admin-scope denial.
 *
 * Exercised over a real OAuth-scoped MCP session (HTTP + JSON-RPC), not the
 * resolver in isolation, so it pins the tier the caller is actually shown.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('MCP SDK tier reporting', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Tier Report Org', slug: 'tier-report-org' });
    owner = await createTestUser({ email: 'tier-owner@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    client = await createTestOAuthClient();
  });

  async function session(token: string) {
    const init = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: '__init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lobu-test', version: '1.0' },
        },
      },
      token,
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sessionId! },
      token,
    });
    return sessionId!;
  }

  async function callTool(token: string, sessionId: string, name: string, args: unknown) {
    const res = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
  }

  it('tells an mcp:write owner that admin-enforced external methods need administer', async () => {
    const { token } = await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await session(token);

    const text = await callTool(token, sessionId, 'search_sdk', {
      query: 'feeds.trigger connections.test authProfiles.test',
    });

    // The bug: these advertised "operate (mcp:write)" — the tier the caller
    // already held — so the client retried into a hard admin rejection.
    for (const path of ['feeds.trigger', 'connections.test', 'authProfiles.test']) {
      const line = text.split('\n').find((l: string) => l.includes(path) && l.includes('access:'));
      expect(line, `no access line rendered for ${path}`).toBeTruthy();
      expect(line).toContain('administer');
      expect(line).not.toContain('operate (mcp:write)');
    }
  });

  it('reports the resolved tier, never the external marker, on the dry-run wire', async () => {
    const { token } = await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await session(token);

    const text = await callTool(token, sessionId, 'run_sdk', {
      dry_run: true,
      script:
        'export default async (_ctx, client) => client.operations.execute(' +
        '{ connection_id: 1, operation_key: "probe" });',
    });

    // `external` is a side-effect marker, not a tier. It legitimately stays on
    // the `access` field (that is the marker, and what keeps the method
    // write-VISIBLE for progressive OAuth) — but it must never surface as
    // `required_access`, which is the tier the caller is told to satisfy.
    expect(text).toContain('operations.execute');
    expect(text).toMatch(/"required_access":\s*"write"/);
    expect(text).not.toMatch(/"required_access":\s*"external"/);
    // The marker itself is still present and correct.
    expect(text).toMatch(/"access":\s*"external"/);
  });

  it('keeps admin-enforced external methods visible so progressive OAuth can fire', async () => {
    const { token } = await createTestAccessToken(owner.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await session(token);

    // Reporting got stricter; VISIBILITY must not. An owner on mcp:write still
    // sees the method, so calling it raises the mcp:admin OAuth challenge
    // instead of the method silently vanishing from discovery.
    const text = await callTool(token, sessionId, 'search_sdk', { query: 'connections.test' });
    expect(text).toContain('connections.test');
  });
});
