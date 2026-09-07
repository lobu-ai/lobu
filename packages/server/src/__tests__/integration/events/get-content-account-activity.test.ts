import { beforeAll, describe, expect, it } from 'vitest';
import type { ContentItem } from '@lobu/connector-sdk';
import { getDb, pgTextArray } from '../../../db/client';
import type { Env } from '../../../index';
import { recordToolInvocationAudit } from '../../../tools/audit';
import { getAccountContent } from '../../../tools/get_content';
import type { AuthContext } from '../../../tools/execute';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization, createTestUser, createTestOAuthClient,
  addUserToOrganization, seedSystemEntityTypes } from '../../setup/test-fixtures';

const activityId = 'fixture-shared-conversation';
const transportId = 'fixture-shared-transport';

describe('actor-owned MCP audit reads', () => {
  let userId: string;
  let otherUserId: string;
  let organizationId: string;
  let clientId: string;
  let ids: number[];
  let otherEventId: number;
  let ordinaryEventId: number;

  function context(actor = userId): AuthContext {
    return { userId: actor, organizationId: null, isAuthenticated: true,
      tokenType: 'oauth', clientId, scopes: ['mcp:read'], agentId: null,
      requestUrl: 'https://fixture.example/mcp', baseUrl: 'https://fixture.example',
      mcpConversationId: activityId, mcpSessionId: transportId } as AuthContext;
  }
  async function read(args: Parameters<typeof getAccountContent>[0], ctx = context()) {
    return getAccountContent(args, {} as Env, ctx);
  }
  async function audit(ctx: AuthContext, toolName: string) {
    await recordToolInvocationAudit({ ctx, toolName, args: { action: 'list', secret: 'retained-value' },
      result: {}, durationMs: 1 });
    const [row] = await getDb()`SELECT id FROM events WHERE created_by = ${ctx.userId}
      AND semantic_type = 'audit' AND origin_type = 'tool_invocation'
      ORDER BY id DESC LIMIT 1`;
    return Number(row!.id);
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    organizationId = (await createTestOrganization({ slug: 'account-reader-fixture' })).id;
    userId = (await createTestUser({ email: 'account-reader@example.test' })).id;
    otherUserId = (await createTestUser({ email: 'account-reader-other@example.test' })).id;
    await addUserToOrganization(userId, organizationId, 'member');
    await addUserToOrganization(otherUserId, organizationId, 'owner');
    clientId = (await createTestOAuthClient({ owner_user_id: userId })).client_id;
    ids = [await audit(context(), 'run_sdk'),
      await audit({ ...context(), organizationId }, 'run_sdk')];
    otherEventId = await audit(context(otherUserId), 'list_organizations');
    await audit({ ...context(), mcpConversationId: 'fixture-other-conversation' }, 'list_organizations');
    await audit({ ...context(), mcpConversationId: null, mcpSessionId: 'fixture-session-only' }, 'list_organizations');
    const [ordinary] = await getDb()`INSERT INTO events
      (organization_id, created_by, semantic_type, origin_type, origin_id, payload_text, client_id, metadata)
      VALUES (${organizationId}, ${userId}, 'content', 'fixture', 'fixture-content',
        'Workspace content must stay workspace-authorized', ${clientId},
        '{"mcp_conversation_id":"fixture-shared-conversation","mcp_session_id":"fixture-shared-transport"}'::jsonb)
      RETURNING id`;
    ordinaryEventId = Number(ordinary.id);
  });

  it('reads one actor conversation across null and actual targets without shared-session leakage', async () => {
    const result = await read({ mcp_activity_id: activityId, client_ids: [clientId] });
    expect(result.content.map(item => (item as ContentItem).id).sort()).toEqual([...ids].sort());
    for (const item of result.content as ContentItem[]) {
      expect(item.payload_data).not.toHaveProperty('request');
      expect(item.payload_data).not.toHaveProperty('request_bytes');
      expect(item.permalink).toContain('/me/events?content_ids=');
    }
  });

  it('includes transport-only activity', async () => {
    const result = await read({ mcp_activity_id: 'fixture-session-only', client_ids: [clientId] });
    expect(result.content).toHaveLength(1);
  });

  it('merges bounded pages for multiple registrations without duplicating repeated client IDs', async () => {
    const otherClient = (await createTestOAuthClient({ owner_user_id: userId })).client_id;
    const firstId = await audit({ ...context(), mcpConversationId: 'fixture-multiple-clients' }, 'list_organizations');
    const secondId = await audit({ ...context(), clientId: otherClient,
      mcpConversationId: 'fixture-multiple-clients' }, 'list_organizations');
    const result = await read({ mcp_activity_id: 'fixture-multiple-clients',
      client_ids: [clientId, otherClient, clientId], limit: 1 });
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as ContentItem).id).toBe(secondId);
    const item = result.content[0] as ContentItem;
    const next = await read({ mcp_activity_id: 'fixture-multiple-clients',
      client_ids: [clientId, otherClient, clientId], limit: 1,
      before_occurred_at: new Date(item.occurred_at!).toISOString(), before_id: item.id });
    expect(next.content).toHaveLength(1);
    expect((next.content[0] as ContentItem).id).toBe(firstId);
    expect(next.page.has_older).toBe(false);
  });

  it('restores requests only on actor-owned exact audit IDs and never reads referenced content', async () => {
    const result = await read({ content_ids: [...ids, otherEventId, ordinaryEventId] });
    expect(result.content).toHaveLength(2);
    for (const item of result.content as ContentItem[]) expect(item.payload_data).toHaveProperty('request');
    const other = await read({ content_ids: ids }, { ...context(otherUserId), memberRole: 'owner', organizationId });
    expect(other.content).toEqual([]);
  });

  it('keeps owned audit access after membership removal without authorizing workspace content', async () => {
    await getDb()`DELETE FROM member WHERE "userId" = ${userId} AND "organizationId" = ${organizationId}`;
    expect((await read({ content_ids: ids })).content).toHaveLength(2);
    expect((await read({ content_ids: [ordinaryEventId] })).content).toEqual([]);
  });

  it('paginates equal timestamps by event ID in both directions', async () => {
    const sql = getDb();
    await sql`INSERT INTO events (organization_id, created_by, semantic_type, origin_type,
      origin_id, occurred_at, client_id, metadata)
      SELECT NULL, ${userId}, 'audit', 'tool_invocation', 'fixture-page-' || n,
        '2026-09-07T10:00:00Z'::timestamptz, ${clientId},
        '{"mcp_conversation_id":"fixture-page"}'::jsonb
      FROM generate_series(1, 2) n`;
    const first = await read({ mcp_activity_id: 'fixture-page', client_ids: [clientId], limit: 1 });
    const firstItem = first.content[0] as ContentItem;
    expect(first.page.has_older).toBe(true);
    const second = await read({ mcp_activity_id: 'fixture-page', client_ids: [clientId], limit: 1,
      before_occurred_at: new Date(firstItem.occurred_at!).toISOString(), before_id: firstItem.id });
    const secondItem = second.content[0] as ContentItem;
    expect(secondItem.id).not.toBe(firstItem.id);
    expect(second.page.has_older).toBe(false);
    const newer = await read({ mcp_activity_id: 'fixture-page', client_ids: [clientId], limit: 1,
      after_occurred_at: new Date(secondItem.occurred_at!).toISOString(), after_id: secondItem.id });
    expect((newer.content[0] as ContentItem).id).toBe(firstItem.id);
    expect(newer.page.has_newer).toBe(false);
  });

  it('fails closed for anonymous, managed, unscoped, malformed, and non-read callers', async () => {
    const exact = { content_ids: ids };
    await expect(read(exact, { ...context(), userId: null })).rejects.toThrow(/user required/i);
    await expect(read(exact, { ...context(), agentId: 'fixture-agent' })).rejects.toThrow(/user required/i);
    await expect(read(exact, { ...context(), scopes: ['mcp:connect'] })).rejects.toThrow(/read access/i);
    await expect(read({})).rejects.toThrow(/exact/i);
    await expect(read({ mcp_activity_id: activityId })).rejects.toThrow(/client_ids/i);
    await expect(read({ ...exact, mcp_activity_id: activityId })).rejects.toThrow(/Select/i);
    await expect(read({ ...exact, limit: 101 })).rejects.toThrow(/100/);
    await expect(read({ ...exact, entity_id: 1 } as never)).rejects.toThrow(/unknown argument/i);
    await expect(read({ mcp_activity_id: activityId, client_ids: [clientId], before_id: 1 })).rejects.toThrow(/cursor/i);
  });

  it('uses the actor activity index for a bounded cursor page in representative history', async () => {
    const sql = getDb();
    await sql`INSERT INTO events (organization_id, created_by, semantic_type, origin_type,
      origin_id, occurred_at, client_id, metadata)
      SELECT NULL, ${userId}, 'audit', 'tool_invocation', 'fixture-plan-' || n,
        '2026-09-07T10:00:00Z'::timestamptz + n * INTERVAL '1 second', ${clientId},
        jsonb_build_object('mcp_conversation_id', CASE WHEN n <= 120
          THEN 'fixture-index-page' ELSE 'fixture-unrelated-history' END)
      FROM generate_series(1, 12000) n`;
    await sql`ANALYZE events`;
    const plan = await sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT e.id, oc.client_name FROM (
        SELECT e.* FROM unnest(${pgTextArray([clientId])}::text[]) requested(client_id)
        CROSS JOIN LATERAL (
          SELECT e.* FROM events e
          WHERE e.created_by = ${userId} AND e.semantic_type = 'audit'
            AND e.origin_type = 'tool_invocation' AND e.client_id = requested.client_id
            AND COALESCE(NULLIF(e.metadata->>'mcp_conversation_id', ''),
              NULLIF(e.metadata->>'mcp_session_id', '')) = 'fixture-index-page'
            AND (e.occurred_at, e.id) < ('2026-09-07T10:01:00Z'::timestamptz, 99999999)
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 11
        ) e ORDER BY e.occurred_at DESC, e.id DESC LIMIT 11
      ) e LEFT JOIN oauth_clients oc ON oc.id = e.client_id
      ORDER BY e.occurred_at DESC, e.id DESC`;
    type PlanNode = { 'Index Name'?: string; 'Actual Rows'?: number; Plans?: PlanNode[] };
    const queryPlan = plan[0]!['QUERY PLAN'][0];
    const nodes: PlanNode[] = [];
    function visit(node: PlanNode) { nodes.push(node); for (const child of node.Plans ?? []) visit(child); }
    visit(queryPlan.Plan);
    const eventScan = nodes.find(node => node['Index Name'] === 'events_mcp_actor_activity');
    expect(eventScan).toBeDefined();
    expect(eventScan!['Actual Rows']).toBeLessThanOrEqual(11);
    console.info('Actor activity cursor query plan:', JSON.stringify(queryPlan));
  });

  it('does not invent ownership after account deletion clears attribution', async () => {
    const deleted = (await createTestUser({ email: 'deleted-account-reader@example.test' })).id;
    const eventId = await audit(context(deleted), 'list_organizations');
    await getDb()`DELETE FROM "user" WHERE id = ${deleted}`;
    expect((await read({ content_ids: [eventId] }, context(deleted))).content).toEqual([]);
  });
});
