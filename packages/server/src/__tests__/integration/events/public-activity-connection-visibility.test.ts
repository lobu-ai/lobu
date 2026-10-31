/**
 * A public org's home is manage_operations.list_activity. Readers outside the
 * workspace already cannot open a private connection, so that connection's
 * runs must not fill the home either.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { handleListActivity } from '../../../tools/admin/manage_operations/handlers/runs';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('public activity > private connection runs', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let member: Awaited<ReturnType<typeof createTestUser>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let publicRunId: number;
  let privateRunId: number;
  let unscopedRunId: number;

  function anonymousCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    } as ToolContext;
  }

  function outsiderCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: outsider.id,
      memberRole: null,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  function memberCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: member.id,
      memberRole: 'member',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  async function runIds(ctx: ToolContext): Promise<Set<number>> {
    const result = await handleListActivity(
      {
        action: 'list_activity',
        include_notifications: false,
        include_runs: true,
        aggregate: false,
        limit: 20,
      },
      ctx,
    );
    if (!('items' in result)) throw new Error(`list_activity failed: ${JSON.stringify(result)}`);
    return new Set(
      result.items.flatMap((item) => (item.run_id != null ? [item.run_id] : [])),
    );
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Public Activity Org', visibility: 'public' });
    member = await createTestUser({ email: 'member-public-activity@example.com' });
    outsider = await createTestUser({ email: 'outsider-public-activity@example.com' });
    await addUserToOrganization(member.id, org.id, 'member');

    const reddit = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
      display_name: 'Reddit',
      visibility: 'org',
      created_by: member.id,
    });
    const chrome = await createTestConnection({
      organization_id: org.id,
      connector_key: 'chrome',
      display_name: 'Chrome',
      visibility: 'private',
      created_by: member.id,
      createDefaultFeed: false,
    });

    const sql = getTestDb();
    const inserted = await sql<{ id: number }[]>`
      INSERT INTO runs (organization_id, run_type, connection_id, connector_key, action_key, status)
      VALUES
        (${org.id}, 'sync', ${reddit.id}, 'reddit', 'sync', 'completed'),
        (${org.id}, 'action', ${chrome.id}, 'chrome', 'evaluate', 'completed'),
        (${org.id}, 'automation', NULL, NULL, NULL, 'completed')
      RETURNING id
    `;
    publicRunId = Number(inserted[0].id);
    privateRunId = Number(inserted[1].id);
    unscopedRunId = Number(inserted[2].id);
  });

  it('shows a member the private device run', async () => {
    const ids = await runIds(memberCtx());
    expect(ids.has(publicRunId)).toBe(true);
    expect(ids.has(privateRunId)).toBe(true);
    expect(ids.has(unscopedRunId)).toBe(true);
  });

  it.each([
    ['anonymous', () => anonymousCtx()],
    ['signed-in non-member', () => outsiderCtx()],
  ] as const)('%s sees the public feed run and not the private device run', async (_, ctx) => {
    const ids = await runIds(ctx());
    expect(ids.has(publicRunId)).toBe(true);
    expect(ids.has(privateRunId)).toBe(false);
    expect(ids.has(unscopedRunId)).toBe(true);
  });
});
