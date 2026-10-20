/**
 * Integration test: a public workspace is readable by everyone. A signed-in
 * user who is not a member reads exactly what an anonymous visitor does —
 * before, signing in turned entity-scoped reads into a 403 that anonymous
 * visitors never saw. Private workspaces stay members-only, and SQL / SDK
 * execution stays off the public-read allowlist entirely.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { isPublicReadable } from '../../../auth/tool-access';
import { getDb } from '../../../db/client';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { requireOrgReadAccess } from '../../../utils/organization-access';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('public workspace > signed-in non-member reads', () => {
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let privateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let outsider: Awaited<ReturnType<typeof createTestUser>>;
  let publicEntityId: number;
  let publicEventId: number;
  let privateEntityId: number;

  const outsiderIn = (organizationId: string): ToolContext =>
    ({
      organizationId,
      userId: outsider.id,
      memberRole: null,
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: true,
      allowCrossOrg: false,
      scopes: ['mcp:read'],
    }) as ToolContext;

  const anonymousIn = (organizationId: string): ToolContext =>
    ({
      organizationId,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    }) as ToolContext;

  const readEntity = (ctx: ToolContext, entityId: number) =>
    getContent(
      { entity_id: entityId, limit: 20, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const owner = await createTestUser({ email: 'owner-public-read@example.com' });
    outsider = await createTestUser({ email: 'outsider-public-read@example.com' });

    publicOrg = await createTestOrganization({ name: 'Public Read Org', visibility: 'public' });
    privateOrg = await createTestOrganization({ name: 'Private Read Org', visibility: 'private' });
    await addUserToOrganization(owner.id, publicOrg.id, 'owner');
    await addUserToOrganization(owner.id, privateOrg.id, 'owner');

    publicEntityId = (await createTestEntity({ name: 'Lisbon', organization_id: publicOrg.id })).id;
    privateEntityId = (await createTestEntity({ name: 'Porto', organization_id: privateOrg.id })).id;
    publicEventId = (
      await createTestEvent({
        organization_id: publicOrg.id,
        entity_id: publicEntityId,
        content: 'Lisbon office rents rose 4%',
      })
    ).id;
    await createTestEvent({
      organization_id: privateOrg.id,
      entity_id: privateEntityId,
      content: 'Porto private note',
    });
  });

  it('reads an entity of a public workspace, like an anonymous visitor', async () => {
    const outsiderIds = (await readEntity(outsiderIn(publicOrg.id), publicEntityId)).content.map((c) => c.id);
    const anonymousIds = (await readEntity(anonymousIn(publicOrg.id), publicEntityId)).content.map((c) => c.id);
    expect(outsiderIds).toContain(publicEventId);
    expect(outsiderIds).toEqual(anonymousIds);
  });

  it('is still denied an entity of a private workspace', async () => {
    await expect(readEntity(outsiderIn(privateOrg.id), privateEntityId)).rejects.toThrow(
      /not found in this workspace, or you do not have access/
    );
  });

  it('cannot read another workspace’s entity through a public one', async () => {
    await expect(readEntity(outsiderIn(publicOrg.id), privateEntityId)).rejects.toThrow(
      /not found in this workspace, or you do not have access/
    );
  });

  it('passes org-level reads of a public workspace, not of a private one', async () => {
    await expect(requireOrgReadAccess(getDb(), outsiderIn(publicOrg.id))).resolves.toBeUndefined();
    await expect(requireOrgReadAccess(getDb(), outsiderIn(privateOrg.id))).rejects.toThrow(
      /permission to view this workspace/
    );
  });

  it.each(['query_sql', 'query_sdk', 'run_sdk'])('%s stays members-only', (tool) => {
    expect(isPublicReadable(tool, {})).toBe(false);
  });
});
