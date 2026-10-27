/**
 * Integration test: workspace-identity audit events (metadata.category=
 * 'workspace') are visible to authenticated members in the All activity feed
 * but are NEVER returned to anonymous public-workspace readers through the
 * public read_knowledge path. These events carry member emails / invitation
 * details, so public exposure is a privacy leak.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { getContent } from '../../../tools/get_content';
import { resolvePath } from '../../../tools/resolve_path';
import { saveContent } from '../../../tools/save_content';
import { search } from '../../../tools/search';
import type { ToolContext } from '../../../tools/registry';
import { getEntityHooks } from '../../../utils/entity-hooks';
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

describe('workspace-identity audit events > public-read exclusion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let workspaceAuditEventId: number;
  let normalEventId: number;
  let orgWideWorkspaceAuditEventId: number;
  let spoofedCategoryEventId: number;

  function authedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: alice.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  function unauthedCtx(): ToolContext {
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

  function signedInOutsiderCtx(): ToolContext {
    // A signed-in user with NO membership in this public workspace — they can
    // read public content, but must not see workspace-identity audit rows.
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
    // An ordinary member (not owner/admin): can read the workspace, but must
    // not see another member's invitation / email audit PII.
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

  function memberWriteCtx(): ToolContext {
    // An ordinary member with write access (save_memory requires it).
    return {
      organizationId: org.id,
      userId: alice.id,
      memberRole: 'member',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read', 'mcp:write'],
    } as ToolContext;
  }

  function userlessOAuthCtx(): ToolContext {
    // Authenticated, no user id, no membership — matches isSystemContext() but
    // NOT isInProcessSystemCall() (tokenType is oauth, not session). Must not
    // see workspace audit rows.
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  async function listIds(ctx: ToolContext): Promise<Set<number>> {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  async function listOrgWideIds(ctx: ToolContext): Promise<Set<number>> {
    const result = await getContent(
      { limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  async function readExactIds(ctx: ToolContext, ids: number[]): Promise<Set<number>> {
    const result = await getContent(
      { entity_id: entity.id, content_ids: ids, limit: 100 } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  async function recallIds(ctx: ToolContext): Promise<Set<number>> {
    const result = await search(
      {
        query: 'invitation',
        include_content: true,
        content_limit: 50,
      } as never,
      {} as never,
      ctx
    );
    return new Set((result.content ?? []).map((c) => c.id));
  }

  async function readClassified(ctx: ToolContext, opts: { orgWide?: boolean } = {}): Promise<number> {
    const result = await getContent(
      {
        ...(opts.orgWide ? {} : { entity_id: entity.id }),
        limit: 100,
        sort_by: 'date',
        sort_order: 'desc',
        include_classification: 'summary',
      } as never,
      {} as never,
      ctx
    );
    const stats = result.classification_stats as Record<
      string,
      Record<string, number> | undefined
    > | null;
    return stats?.['audit-severity']?.['sensitive'] ?? 0;
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Workspace Audit Visibility Org' });
    alice = await createTestUser({ email: 'alice-workspace-audit@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    outsider = await createTestUser({ email: 'outsider-workspace-audit@example.com' });

    entity = await createTestEntity({
      name: 'Workspace Audit Entity',
      organization_id: org.id,
    });

    normalEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'normal content event',
      })
    ).id;

    // Mirrors what recordWorkspaceChangeEvent emits (minus embeddings, which
    // are not needed for the chronological date-sort list path).
    workspaceAuditEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Invitation sent to new.member@example.com',
        content: 'workspace audit event',
        semantic_type: 'change',
        metadata: {
          category: 'workspace',
          _lobu_workspace_audit: true,
          resource_kind: 'invitation',
          resource_id: 'inv_abc',
          op: 'created',
        },
      })
    ).id;

    // Unbound (org-wide, no entity / connection) workspace audit row — the
    // shape an anonymous or signed-in non-member could otherwise retrieve
    // through an org-wide read of a public workspace.
    orgWideWorkspaceAuditEventId = (
      await createTestEvent({
        organization_id: org.id,
        title: 'Invitation sent to orgwide.member@example.com',
        content: 'org-wide workspace audit event',
        semantic_type: 'change',
        metadata: {
          category: 'workspace',
          _lobu_workspace_audit: true,
          resource_kind: 'invitation',
          resource_id: 'inv_xyz',
          op: 'created',
        },
      })
    ).id;

    // Classify the workspace audit row so classification STATS (which are
    // aggregated across all matching content) could leak its presence to
    // non-members even when the row itself is filtered out.
    const sql = getDb();
    const facet = await sql`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status,
                                  created_by, entity_ids, attribute_values, min_similarity)
      VALUES (${org.id}, 'audit-severity', 'Audit severity', 'severity', 'active', ${alice.id},
              ARRAY[]::bigint[], ${sql.json({ sensitive: { description: 'S', examples: [] } })}, 0.7)
      RETURNING id
    `;
    const facetId = Number(facet[0].id);
    await sql`
      INSERT INTO event_classifications (event_id, classifier_id, automation_id, run_id,
                                         "values", confidences, source, is_manual)
      VALUES (${orgWideWorkspaceAuditEventId}, ${facetId}, NULL, NULL, ${'{sensitive}'}::text[],
              ${sql.json({ sensitive: 1 })}, 'user', true)
    `;

    // A NON-audit event whose caller supplied category='workspace' in metadata
    // (save_memory accepts arbitrary metadata). The exclusion must gate on the
    // server-owned _lobu_workspace_audit discriminator, NOT the category, so
    // ordinary members retain access to this legitimate event.
    spoofedCategoryEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'A normal note with spoofed category',
        content: 'ordinary member should keep reading this',
        metadata: { category: 'workspace' },
      })
    ).id;
  });

  it('authenticated member sees the workspace audit event in the feed', async () => {
    const ids = await listIds(authedCtx());
    expect(ids.has(workspaceAuditEventId)).toBe(true);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('anonymous public-workspace reader does NOT see the workspace audit event', async () => {
    const ids = await listIds(unauthedCtx());
    expect(ids.has(workspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('userless OAuth token does NOT see workspace audit (not in-process system)', async () => {
    const ids = await listOrgWideIds(userlessOAuthCtx());
    expect(ids.has(workspaceAuditEventId)).toBe(false);
    expect(ids.has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('signed-in non-member does NOT see workspace audit events via org-wide read', async () => {
    const ids = await listOrgWideIds(signedInOutsiderCtx());
    expect(ids.has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect(ids.has(workspaceAuditEventId)).toBe(false);
  });

  it('ordinary member does NOT see workspace audit PII (list / exact-ID / search)', async () => {
    // List (entity-scoped)
    const listed = await listIds(memberCtx());
    expect(listed.has(workspaceAuditEventId)).toBe(false);
    expect(listed.has(normalEventId)).toBe(true);

    // Exact-ID
    const exact = await readExactIds(memberCtx(), [workspaceAuditEventId, normalEventId]);
    expect(exact.has(workspaceAuditEventId)).toBe(false);
    expect(exact.has(normalEventId)).toBe(true);

    // Search recall
    const recall = await recallIds(memberCtx());
    expect(recall.has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect(recall.has(workspaceAuditEventId)).toBe(false);
  });

  it('ordinary member retains access to a NON-audit event that spoofs the workspace category', async () => {
    // save_memory accepts caller metadata, so a member could legitimately save
    // an event with category='workspace'. The exclusion gates on the
    // server-owned _lobu_workspace_audit discriminator, NOT the category, so
    // this event stays readable by everyone.
    const listed = await listIds(memberCtx());
    expect(listed.has(spoofedCategoryEventId)).toBe(true);

    const exact = await readExactIds(memberCtx(), [spoofedCategoryEventId]);
    expect(exact.has(spoofedCategoryEventId)).toBe(true);

    const anon = await listOrgWideIds(unauthedCtx());
    expect(anon.has(spoofedCategoryEventId)).toBe(true);
  });

  it('save_memory strips the server-owned _lobu_workspace_audit key from caller metadata', async () => {
    const sql = getDb();

    // A member tries to forge the audit discriminator via save_memory metadata.
    await saveContent(
      {
        entity_ids: [entity.id],
        content: 'forged-audit-attempt',
        semantic_type: 'note',
        metadata: { _lobu_workspace_audit: true, category: 'workspace' },
      } as never,
      {} as never,
      memberWriteCtx()
    );

    const row = (await sql`
      SELECT metadata FROM events
      WHERE organization_id = ${org.id}
        AND payload_text = 'forged-audit-attempt'
      ORDER BY id DESC LIMIT 1
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(row).toHaveLength(1);
    expect(row[0].metadata._lobu_workspace_audit).toBeUndefined();
  });

  it('anonymous org-wide read excludes unbound workspace audit rows', async () => {
    const ids = await listOrgWideIds(unauthedCtx());
    expect(ids.has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('signed-in non-member search_memory recall excludes workspace audit rows', async () => {
    const ids = await recallIds(signedInOutsiderCtx());
    expect(ids.has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect(ids.has(workspaceAuditEventId)).toBe(false);
  });

  it('non-member automation_id read is denied (no workspace audit surface)', async () => {
    // Automation read mode executes an Automation's authored sources; a public
    // non-member must not be able to run it and surface workspace-identity
    // audit rows. The denial happens before any automation lookup.
    await expect(
      getContent(
        { automation_id: 999999, limit: 100 } as never,
        {} as never,
        signedInOutsiderCtx()
      )
    ).rejects.toThrow(/workspace membership/);
  });

  it('ordinary member automation_id read is NOT denied (membership gate only)', async () => {
    // The membership gate must deny only NON-members. An ordinary member gets
    // past the gate and fails on the (nonexistent) automation lookup instead of
    // a 403 — proving the gate no longer misapplies to members.
    await expect(
      getContent(
        { automation_id: 999999, limit: 100 } as never,
        {} as never,
        memberCtx()
      )
    ).rejects.toThrow(/Automation/);
  });

  it('classification stats exclude workspace audit rows for non-members', async () => {
    // Anonymous and signed-in non-members must not see the 'sensitive' count
    // that derives from the classified workspace-audit row (org-wide read).
    expect(await readClassified(unauthedCtx(), { orgWide: true })).toBe(0);
    expect(await readClassified(signedInOutsiderCtx(), { orgWide: true })).toBe(0);
  });

  it('classification stats include workspace audit rows for members', async () => {
    expect(await readClassified(authedCtx(), { orgWide: true })).toBe(1);
  });

  it('deleting an invited member emits an invitation-cancelled audit event', async () => {
    const sql = getDb();

    // Insert a pending invitation directly (the $member beforeCreate hook
    // does exactly this when a $member entity is created with an email).
    await sql`
      INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt")
      VALUES (gen_random_uuid()::text, ${org.id}, 'cancel-me@example.com', 'member',
              'pending', NOW() + interval '48 hours', ${alice.id}, NOW())
    `;
    const invRows = (await sql`
      SELECT id FROM invitation
      WHERE "organizationId" = ${org.id}
        AND email = 'cancel-me@example.com'
        AND status = 'pending'
    `) as unknown as Array<{ id: string }>;
    expect(invRows).toHaveLength(1);

    // Deleting the member fires beforeDelete → cancels the invitation.
    const hooks = getEntityHooks('$member');
    expect(hooks?.beforeDelete).toBeDefined();
    await hooks!.beforeDelete!(
      {
        id: 999999,
        entity_type: '$member',
        metadata: { email: 'cancel-me@example.com' },
      },
      {
        organizationId: org.id,
        userId: alice.id,
        principal: { userId: alice.id },
      }
    );

    // The invitation is now canceled and the cancellation is audited.
    const cancelledRows = (await sql`
      SELECT status FROM invitation
      WHERE "organizationId" = ${org.id}
        AND email = 'cancel-me@example.com'
    `) as unknown as Array<{ status: string }>;
    expect(cancelledRows[0]?.status).toBe('canceled');

    // Poll for the fire-and-forget audit row.
    const deadline = Date.now() + 2000;
    let sawCancelled = false;
    while (Date.now() < deadline) {
      const audit = await sql`
        SELECT 1 FROM events
        WHERE organization_id = ${org.id}
          AND semantic_type = 'change'
          AND metadata->>'category' = 'workspace'
          AND metadata->>'resource_kind' = 'invitation'
          AND metadata->>'op' = 'updated'
          AND metadata->>'resource_id' = ${invRows[0].id}
        LIMIT 1
      `;
      if (audit.length > 0) {
        sawCancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sawCancelled).toBe(true);
  });

  it('org-home bootstrap hides workspace audit rows from non-owner/admin', async () => {
    const slug = (org as unknown as { slug: string }).slug;

    async function bootstrapRecent(ctx: ToolContext) {
      const result = await resolvePath(
        { path: `/${slug}`, include_bootstrap: true } as never,
        {} as never,
        ctx
      );
      return new Set(
        ((result.bootstrap as { recent_content?: Array<{ id: number }> })
          ?.recent_content ?? []).map((c) => c.id)
      );
    }

    // Anonymous and ordinary members do not see the org-wide workspace audit row.
    expect((await bootstrapRecent(unauthedCtx())).has(orgWideWorkspaceAuditEventId)).toBe(false);
    expect((await bootstrapRecent(memberCtx())).has(orgWideWorkspaceAuditEventId)).toBe(false);
    // Owner does.
    expect((await bootstrapRecent(authedCtx())).has(orgWideWorkspaceAuditEventId)).toBe(true);
  });

  it('owner of another org does not see this org workspace audit via bootstrap', async () => {
    // memberRole is scoped to ctx.organizationId. An owner of org A resolving
    // public org B must not inherit owner visibility on B's audit rows.
    // resolve_path now only crosses workspaces into a granted or PUBLIC
    // target, so make the browsed org actually public for this test.
    const otherOrg = await createTestOrganization({
      visibility: 'private',
      name: 'Other owner org',
    });
    await addUserToOrganization(alice.id, otherOrg.id, 'owner');

    const sql = getTestDb();
    await sql`UPDATE organization SET visibility = 'public' WHERE id = ${org.id}`;
    try {
      const slug = (org as unknown as { slug: string }).slug;
      const result = await resolvePath(
        { path: `/${slug}`, include_bootstrap: true } as never,
        {} as never,
        {
          organizationId: otherOrg.id,
          userId: alice.id,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'oauth',
          scopedToOrg: false,
          allowCrossOrg: true,
          grantedOrganizationIds: [otherOrg.id],
          directSearchFederation: false,
          scopes: ['mcp:read'],
        } as ToolContext
      );
      const recentIds = new Set(
        ((result.bootstrap as { recent_content?: Array<{ id: number }> })
          ?.recent_content ?? []).map((c) => c.id)
      );
      expect(recentIds.has(orgWideWorkspaceAuditEventId)).toBe(false);
      expect(recentIds.has(normalEventId)).toBe(true);
    } finally {
      await sql`UPDATE organization SET visibility = 'private' WHERE id = ${org.id}`;
    }
  });

  it('anonymous content_ids exact-ID read excludes workspace audit but keeps ordinary events', async () => {
    const ids = await readExactIds(unauthedCtx(), [
      workspaceAuditEventId,
      normalEventId,
    ]);
    expect(ids.has(workspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });
});
