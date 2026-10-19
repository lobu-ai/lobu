/**
 * Integration test: a public workspace publishes its knowledge, not its
 * operational trail. Operation cards (connector operation runs, approvals,
 * suggestions) and notifications are events too, and an anonymous visitor of
 * market.lobu.ai saw them listed as "Recent Knowledge" — "send_message —
 * completed", "Action "navigate" needs approval …".
 *
 * Readers outside the workspace (anonymous, or signed in without membership)
 * must not get those rows from any read path: the public page bootstrap and
 * its counts, get_content list / exact-ID / query reads (the public REST
 * search), and search_memory recall. Members keep seeing them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createNotificationForUsers, deleteNotification } from '../../../notifications/service';
import { buildPublicPageModel } from '../../../public-pages';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { resolvePath } from '../../../tools/resolve_path';
import { search } from '../../../tools/search';
import { searchContentByText } from '../../../utils/content-search';
import { getEnvFromProcess } from '../../../utils/env';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const QUERY = 'warehouse';

describe('operational trail > public-read exclusion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let knowledgeId: number;
  let deletedNotificationId: number;
  let operationCardId: number;
  let approvalNoticeId: number;
  let unboundOperationCardId: number;
  let trailIds: number[];

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
      userId: alice.id,
      memberRole: 'member',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  const publicReaders = [
    ['anonymous', () => anonymousCtx()],
    ['signed-in non-member', () => outsiderCtx()],
  ] as const;

  async function listIds(ctx: ToolContext, args: Record<string, unknown> = {}) {
    const result = await getContent(
      { limit: 100, sort_by: 'date', sort_order: 'desc', ...args } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  async function bootstrap(ctx: ToolContext, path = `/${org.slug}`) {
    const result = await resolvePath(
      { path, include_bootstrap: true } as never,
      {} as never,
      ctx
    );
    const boot = result.bootstrap as {
      total_content?: number;
      recent_content?: Array<{ id: number }>;
    };
    return {
      total: boot.total_content ?? 0,
      ids: new Set((boot.recent_content ?? []).map((c) => c.id)),
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Operational Trail Org', visibility: 'public' });
    alice = await createTestUser({ email: 'alice-operational-trail@example.com' });
    await addUserToOrganization(alice.id, org.id, 'member');
    outsider = await createTestUser({ email: 'outsider-operational-trail@example.com' });

    entity = await createTestEntity({ name: 'Warehouse Market', organization_id: org.id });

    knowledgeId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Warehouse rents rose 4% in Q3',
        content: 'Warehouse rents rose 4% quarter over quarter.',
        semantic_type: 'note',
      })
    ).id;

    // The shape a connector operation run leaves behind: an interactive card.
    operationCardId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'send_message — completed (warehouse digest)',
        content: 'warehouse digest sent',
        semantic_type: 'operation',
      })
    ).id;

    // An approval request delivered to a member's inbox.
    approvalNoticeId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Action "navigate" needs approval (warehouse portal)',
        content: 'warehouse portal navigation needs approval',
        semantic_type: 'connector_operation_approval',
      })
    ).id;

    // Unbound card (no entity): reachable only through org-wide reads.
    unboundOperationCardId = (
      await createTestEvent({
        organization_id: org.id,
        title: 'evaluate — rejected (warehouse scrape)',
        content: 'warehouse scrape rejected',
        semantic_type: 'operation',
      })
    ).id;

    // A notification whose only recipient deleted it: the inbox row is gone,
    // the event stays (append-only), and it must stay private.
    const notification = await createNotificationForUsers([alice.id], {
      organizationId: org.id,
      type: 'generic',
      title: 'Warehouse lease renewal reminder',
      body: 'warehouse lease renewal is due',
      entityIds: [entity.id],
    });
    deletedNotificationId = notification.eventId!;
    expect(await deleteNotification(org.id, alice.id, deletedNotificationId)).toBe(true);

    trailIds = [operationCardId, approvalNoticeId, unboundOperationCardId, deletedNotificationId];

    const sql = getTestDb();
    await sql`
      UPDATE events SET interaction_type = 'approval', interaction_status = 'completed'
      WHERE id IN ${sql([operationCardId, unboundOperationCardId])}
    `;
    await sql`
      INSERT INTO notification_targets (event_id, user_id) VALUES (${approvalNoticeId}, ${alice.id})
    `;
  });

  function expectKnowledgeOnly(ids: Set<number>) {
    expect(ids.has(knowledgeId)).toBe(true);
    for (const id of trailIds) expect(ids.has(id)).toBe(false);
  }

  it('member sees the operational trail (list, bootstrap)', async () => {
    const ids = await listIds(memberCtx());
    expect(ids.has(knowledgeId)).toBe(true);
    for (const id of trailIds) expect(ids.has(id)).toBe(true);

    const boot = await bootstrap(memberCtx());
    expect(boot.ids.has(operationCardId)).toBe(true);
    expect(boot.total).toBe(5);
  });

  it.each(publicReaders)('%s org-home bootstrap lists and counts knowledge only', async (_, ctx) => {
    const boot = await bootstrap(ctx());
    expectKnowledgeOnly(boot.ids);
    expect(boot.total).toBe(1);
  });

  it.each(publicReaders)('%s entity-page bootstrap lists and counts knowledge only', async (_, ctx) => {
    const boot = await bootstrap(ctx(), `/${org.slug}/${entity.entity_type}/${entity.name.toLowerCase().replace(/\s+/g, '-')}`);
    expectKnowledgeOnly(boot.ids);
    expect(boot.total).toBe(1);
  });

  it.each(publicReaders)('%s get_content org-wide list excludes the trail', async (_, ctx) => {
    expectKnowledgeOnly(await listIds(ctx()));
  });

  it.each(publicReaders)('%s get_content entity list excludes the trail', async (_, ctx) => {
    expectKnowledgeOnly(await listIds(ctx(), { entity_id: entity.id }));
  });

  it.each(publicReaders)('%s exact-ID read excludes the trail', async (_, ctx) => {
    expectKnowledgeOnly(await listIds(ctx(), { content_ids: [knowledgeId, ...trailIds] }));
  });

  it.each(publicReaders)('%s query read (public REST search) excludes the trail', async (_, ctx) => {
    expectKnowledgeOnly(await listIds(ctx(), { query: QUERY }));
  });

  it.each(publicReaders)('%s cannot lift the boundary with a semantic_type filter', async (_, ctx) => {
    const ids = await listIds(ctx(), { semantic_type: ['operation', 'connector_operation_approval'] });
    for (const id of trailIds) expect(ids.has(id)).toBe(false);
  });

  it.each(publicReaders)('%s search_memory recall excludes the trail', async (_, ctx) => {
    const result = await search(
      { query: QUERY, include_content: true, content_limit: 50 } as never,
      {} as never,
      ctx()
    );
    const ids = new Set((result.content ?? []).map((c) => c.id));
    for (const id of trailIds) expect(ids.has(id)).toBe(false);
  });

  it('search path honours exclude_operational_trail', async () => {
    const all = await searchContentByText(QUERY, { organization_id: org.id });
    const allIds = all.content.map((r) => Number(r.id));
    expect(allIds).toContain(operationCardId);

    const filtered = await searchContentByText(QUERY, {
      organization_id: org.id,
      exclude_operational_trail: true,
    });
    const ids = filtered.content.map((r) => Number(r.id));
    expect(ids).toContain(knowledgeId);
    for (const id of trailIds) expect(ids).not.toContain(id);
  });

  it.each([
    ['workspace home', () => `/${org.slug}`],
    ['entity page', () => `/${org.slug}/${entity.entity_type}/warehouse-market`],
  ])('rendered public %s (HTML and bootstrap JSON) carries knowledge only', async (_, path) => {
    const model = await buildPublicPageModel(
      path(),
      getEnvFromProcess(),
      `https://app.example.test${path()}`
    );
    expect(model?.status).toBe(200);
    // Everything the anonymous visitor receives: rendered HTML plus the
    // serialized window.__LOBU_PUBLIC_BOOTSTRAP__ payload.
    const served = `${model?.bodyHtml}\n${JSON.stringify(model?.bootstrap)}`;
    expect(served).toContain('Warehouse rents rose 4% in Q3');
    for (const leaked of ['send_message', 'needs approval', 'evaluate — rejected']) {
      expect(served).not.toContain(leaked);
    }
  });
});
