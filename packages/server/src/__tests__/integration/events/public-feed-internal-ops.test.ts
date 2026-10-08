/**
 * Default non-owner/admin knowledge feeds and bootstrap exclude internal ops.
 * Explicit semantic_type reads retain the operational trail, so this tests
 * discovery filtering rather than an authorization boundary.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { type ContentItem, getContent } from '../../../tools/get_content';
import { resolvePath } from '../../../tools/resolve_path';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('public knowledge feed > internal-ops exclusion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let slug: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let normalId: number;
  let auditId: number;
  let lifecycleId: number;
  let configId: number;
  let memberNoteId: number;

  function anonCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
      scopes: ['*'],
    } as ToolContext;
  }

  function ownerCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: 'owner-user',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'Public Internal Ops Org',
      visibility: 'public',
    });
    slug = org.slug;
    entity = await createTestEntity({
      name: 'Catalog item',
      organization_id: org.id,
    });

    normalId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Nightly sync review',
        content: 'A real connector-synced review body.',
        semantic_type: 'content',
      })
    ).id;

    auditId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'query_sql completed',
        content: '',
        semantic_type: 'audit',
        origin_type: 'tool_invocation',
        metadata: { category: 'audit', tool_name: 'query_sql' },
      })
    ).id;

    lifecycleId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Nightly sync Automation "created"',
        content: '',
        semantic_type: 'change',
        origin_type: 'automation_created',
        metadata: { category: 'lifecycle', entity_type: 'automation' },
      })
    ).id;

    configId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: "Nightly sync Automation 'created'",
        content: '',
        semantic_type: 'change',
        origin_type: 'config_automation_created',
        metadata: { category: 'config', resource_kind: 'automation' },
      })
    ).id;

    memberNoteId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Nightly sync config notes',
        content: 'A member note that reuses the config label.',
        semantic_type: 'note',
        metadata: { category: 'config' },
      })
    ).id;
  });

  it.each([undefined, 'Nightly sync'])('anonymous list/search excludes internal ops (query: %s)', async (query) => {
    const result = await getContent(
      { limit: 50, sort_by: 'date', sort_order: 'desc', ...(query ? { query } : {}) },
      {} as never,
      anonCtx(),
    );
    const ids = new Set((result.content as ContentItem[]).map((c) => c.id));
    expect(ids.has(normalId)).toBe(true);
    expect(ids.has(memberNoteId)).toBe(true);
    expect(ids.has(auditId)).toBe(false);
    expect(ids.has(lifecycleId)).toBe(false);
    expect(ids.has(configId)).toBe(false);
    expect(result.total).toBe(2);
  });

  it('explicit semantic_type filter still returns the ops rows on purpose', async () => {
    const result = await getContent(
      {
        limit: 50,
        sort_by: 'date',
        sort_order: 'desc',
        semantic_type: ['audit'],
      } as never,
      {} as never,
      anonCtx(),
    );
    const ids = new Set((result.content as ContentItem[]).map((c) => c.id));
    expect(ids.has(auditId)).toBe(true);
  });

  it.each(['owner', 'admin'] as const)('%s keeps the full ops trail in the default feed', async (memberRole) => {
    const result = await getContent(
      { limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      { ...ownerCtx(), memberRole },
    );
    const ids = new Set((result.content as ContentItem[]).map((c) => c.id));
    expect(ids.has(auditId)).toBe(true);
    expect(ids.has(lifecycleId)).toBe(true);
    expect(ids.has(configId)).toBe(true);
  });

  it.each(['', '/brand/catalog-item'])('bootstrap counts match recent content at %s', async (entityPath) => {
    const resolved = await resolvePath(
      { path: `/${slug}${entityPath}`, include_bootstrap: true },
      {} as never,
      anonCtx(),
    );
    const recent = resolved.bootstrap?.recent_content ?? [];
    const recentIds = new Set(recent.map((c) => c.id));
    expect(recentIds.has(normalId)).toBe(true);
    expect(recentIds.has(memberNoteId)).toBe(true);
    expect(recentIds.has(auditId)).toBe(false);
    expect(recentIds.has(lifecycleId)).toBe(false);
    expect(recentIds.has(configId)).toBe(false);
    expect(resolved.bootstrap?.total_content).toBe(2);
    if (entityPath) expect(resolved.entity?.total_content).toBe(2);
  });

  it.each(['', '/brand/catalog-item'])('owner bootstrap keeps the full operational trail at %s', async (entityPath) => {
    const resolved = await resolvePath(
      { path: `/${slug}${entityPath}`, include_bootstrap: true },
      {} as never,
      ownerCtx(),
    );
    const ids = new Set(resolved.bootstrap?.recent_content.map((c) => c.id));
    expect(ids.has(auditId)).toBe(true);
    expect(ids.has(lifecycleId)).toBe(true);
    expect(ids.has(configId)).toBe(true);
    expect(resolved.bootstrap?.total_content).toBe(5);
    if (entityPath) expect(resolved.entity?.total_content).toBe(5);
  });
});
