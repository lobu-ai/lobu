/**
 * Repro: anonymous public-knowledge reads (the `market.lobu.ai` feed) surface
 * internal operational rows — tool-invocation audit (`query_sql completed`,
 * `manage_automations completed`, …) plus Automation config/lifecycle
 * dual-writes. They carry `connection_id IS NULL`, so the connection-visibility
 * gate lets them through, and `get_content` never sets `exclude_internal_ops`
 * (only the recall path does). Consequence on prod: ~95/100 head rows are
 * `tool_invocation` exhaust, `total` is inflated, and `sql_preview_redacted`
 * leaks full SQL + `mcp_session_id`/`mcp_conversation_id` to anon readers.
 *
 * Fix contract (mirrors `search-recall-internal-ops`): `get_content` list/search
 * excludes internal ops unless the caller explicitly filters `semantic_type`;
 * `resolve_path` bootstrap counts/recent exclude them as well.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import { resolvePath } from '../../../tools/resolve_path';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestEvent,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('public knowledge feed > internal-ops exclusion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let slug: string;
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
    } as unknown as ToolContext;
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
    } as unknown as ToolContext;
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({
      name: 'Public Internal Ops Org',
      visibility: 'public',
    });
    slug = (org as unknown as { slug: string }).slug;

    normalId = (
      await createTestEvent({
        organization_id: org.id,
        title: 'Public catalog review',
        content: 'A real connector-synced review body.',
        semantic_type: 'content',
      })
    ).id;

    auditId = (
      await createTestEvent({
        organization_id: org.id,
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
        title: 'Member config notes',
        content: 'A member note that reuses the config label.',
        semantic_type: 'note',
        metadata: { category: 'config' },
      })
    ).id;
  });

  it('anonymous date-feed excludes audit/lifecycle/config rows but keeps content', async () => {
    const result = await getContent(
      { limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      anonCtx(),
    );
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(normalId)).toBe(true);
    expect(ids.has(memberNoteId)).toBe(true);
    expect(ids.has(auditId)).toBe(false);
    expect(ids.has(lifecycleId)).toBe(false);
    expect(ids.has(configId)).toBe(false);
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
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(auditId)).toBe(true);
  });

  it('owners keep the full ops trail in the default feed', async () => {
    const result = await getContent(
      { limit: 50, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ownerCtx(),
    );
    const ids = new Set(result.content.map((c) => c.id));
    expect(ids.has(auditId)).toBe(true);
    expect(ids.has(lifecycleId)).toBe(true);
    expect(ids.has(configId)).toBe(true);
  });

  it('bootstrap recent_content/total_content exclude internal ops', async () => {
    const resolved = await resolvePath(
      { path: `/${slug}`, include_bootstrap: true } as never,
      {} as never,
      anonCtx(),
    );
    const recent = (resolved.bootstrap as { recent_content?: Array<{ id: number }> })
      ?.recent_content ?? [];
    const recentIds = new Set(recent.map((c) => c.id));
    expect(recentIds.has(normalId)).toBe(true);
    expect(recentIds.has(auditId)).toBe(false);
    expect(recentIds.has(lifecycleId)).toBe(false);
    expect(recentIds.has(configId)).toBe(false);
    expect(resolved.bootstrap?.total_content).toBe(2);
  });
});
