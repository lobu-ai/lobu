/**
 * Inbound webhook connection create: the UI form has no slug input, but the
 * server rejected slug-less creates with "Webhook connections require a
 * non-numeric slug" — the connection could not be created at all. The server
 * now derives a readable, non-numeric slug when the caller supplies none.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { __setChatInstanceManagerForTests } from '../../../lobu/gateway';
import { orgContext } from '../../../lobu/stores/org-context';
import { runtimeConnectionIdToSlug } from '../../../lobu/stores/connections-projection';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { initWorkspaceProvider } from '../../../workspace';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEST_ENV = {} as Env;

function ctxFor(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
    baseUrl: 'https://gateway.test/lobu',
  } as ToolContext;
}

describe('webhook connection create without an explicit slug', () => {
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    // Adapterless platforms never instantiate a chat adapter; a stub manager
    // satisfies the connection-service seam without gateway startup. Its
    // addConnection persists the row the way ChatInstanceManager.persistConnection
    // does (no secret normalization needed for a synthetic token).
    __setChatInstanceManagerForTests({
      resolveConnectionConfig: async (_id: unknown, cfg: unknown) => cfg,
      addConnection: async (
        platform: string,
        _agentId: unknown,
        config: unknown,
        _settings: unknown,
        metadata: { teamName?: string } | undefined,
        stableId: string,
      ) => {
        const orgId = orgContext.getStore()?.organizationId;
        if (!orgId) throw new Error('stub addConnection outside org context');
        const sql = getTestDb();
        await sql`
          INSERT INTO connections (
            organization_id, connector_key, display_name, status, config,
            credential_mode, slug, visibility, created_at, updated_at
          ) VALUES (
            ${orgId}, ${platform}, ${metadata?.teamName ?? null}, 'active',
            ${sql.json((config ?? {}) as Record<string, unknown>)}, 'byo',
            ${runtimeConnectionIdToSlug(stableId)}, 'org', now(), now()
          )
        `;
      },
      connectionMatches: () => false,
      updateConnection: async () => {},
    });
  });

  afterAll(() => {
    __setChatInstanceManagerForTests(null);
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Webhook Slug Org' });
    const user = await createTestUser({ name: 'Webhook Slug User' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ctx = ctxFor(org.id, user.id);
    await createTestConnectorDefinition({ key: 'webhook', name: 'Inbound Webhook' });
    const sql = getTestDb();
    await sql`
      UPDATE connector_definitions
      SET options_schema = ${sql.json({ 'x-lobu-adapterless-platform': 'webhook' })}
      WHERE key = 'webhook'
    `;
  });

  it('creates the connection with a derived non-numeric slug when none is supplied', async () => {
    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'webhook',
        display_name: 'My Inbound Hook',
        config: { token: 'wh_test_token_0123456789abcdef0123456789abcdef' },
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in res ? res.error : undefined).toBeUndefined();
    if (!('connection' in res)) throw new Error('unexpected result shape');
    const slug = (res.connection as { slug: string }).slug;
    expect(slug).toMatch(/^agentconn-my-inbound-hook-[0-9a-f]{6}$/);
    expect(slug).not.toMatch(/^\d+$/);
  });

  it('still rejects an explicitly numeric slug', async () => {
    const res = await manageConnections(
      { action: 'create', connector_key: 'webhook', slug: '12345', display_name: 'Numeric Hook' },
      TEST_ENV,
      ctx,
    );
    expect('error' in res && typeof res.error === 'string' ? res.error : '').toMatch(
      /numeric/i,
    );
  });

  it('honors an explicit non-numeric slug', async () => {
    const res = await manageConnections(
      {
        action: 'create',
        connector_key: 'webhook',
        slug: 'orders-hook',
        display_name: 'Orders Hook',
        config: { token: 'wh_test_token_fedcba9876543210fedcba9876543210' },
      },
      TEST_ENV,
      ctx,
    );
    expect('error' in res ? res.error : undefined).toBeUndefined();
    if (!('connection' in res)) throw new Error('unexpected result shape');
    expect((res.connection as { slug: string }).slug).toBe('agentconn-orders-hook');
  });
});
