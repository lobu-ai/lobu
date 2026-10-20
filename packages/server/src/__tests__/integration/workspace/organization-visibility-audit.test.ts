/**
 * Integration test: changing a workspace's visibility leaves an audit trail.
 *
 * Visibility decides whether anonymous visitors and crawlers can read a
 * workspace, yet the switch used to write no event, so a workspace found
 * public could not be traced to who changed it or when. The PATCH route now
 * writes a `workspace_organization_updated` change event in the same
 * transaction as the update. Renames through Better Auth's update endpoint
 * are audited by the `afterUpdateOrganization` hook.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';
import { post, testRequest } from '../../setup/test-helpers';

describe('workspace visibility > audit trail', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let ownerId: string;
  let ownerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'Visibility Audit Org', slug: 'visibility-audit' });
    const owner = await createTestUser({ email: 'visibility-owner@test.example' });
    const member = await createTestUser({ email: 'visibility-member@test.example' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    await addUserToOrganization(member.id, org.id, 'member');
    ownerId = owner.id;
    ownerCookie = (await createTestSession(owner.id)).cookieHeader;
    memberCookie = (await createTestSession(member.id)).cookieHeader;
  });

  function setVisibility(cookie: string, visibility: 'public' | 'private') {
    return testRequest('PATCH', `/api/${org.slug}/organization/visibility`, {
      body: { visibility },
      cookie,
    });
  }

  async function organizationUpdateEvents() {
    const sql = getTestDb();
    return sql<{ title: string; created_by: string | null; metadata: Record<string, unknown> }>`
      SELECT title, created_by, metadata
      FROM events
      WHERE organization_id = ${org.id}
        AND origin_type = 'workspace_organization_updated'
      ORDER BY id
    `;
  }

  async function visibilityEvents() {
    return (await organizationUpdateEvents()).filter((event) =>
      event.title.startsWith('Workspace visibility')
    );
  }

  it('records who made the workspace public', async () => {
    const response = await setVisibility(ownerCookie, 'public');
    expect(response.status).toBe(200);

    const events = await visibilityEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Workspace visibility set to public',
      created_by: ownerId,
    });
    expect(events[0]!.metadata).toMatchObject({ category: 'workspace', op: 'updated' });
  });

  it('writes nothing when the visibility does not change', async () => {
    const response = await setVisibility(ownerCookie, 'public');
    expect(response.status).toBe(200);
    expect(await visibilityEvents()).toHaveLength(1);
  });

  it('records the switch back to private', async () => {
    await setVisibility(ownerCookie, 'private');
    const events = await visibilityEvents();
    expect(events.map((event) => event.title)).toEqual([
      'Workspace visibility set to public',
      'Workspace visibility set to private',
    ]);
  });

  it('a refused change writes no event', async () => {
    const response = await setVisibility(memberCookie, 'public');
    expect(response.status).toBe(403);
    expect(await visibilityEvents()).toHaveLength(2);
  });

  it('records a rename made through Better Auth', async () => {
    const response = await post('/api/auth/organization/update', {
      body: { organizationId: org.id, data: { name: 'Renamed Audit Org' } },
      cookie: ownerCookie,
    });
    expect(response.status).toBe(200);

    // The hook writes fire-and-forget, after the response.
    let renamed: Awaited<ReturnType<typeof organizationUpdateEvents>> = [];
    for (let attempt = 0; attempt < 50 && renamed.length === 0; attempt++) {
      renamed = (await organizationUpdateEvents()).filter(
        (event) => event.title === 'Organization "Renamed Audit Org" updated'
      );
      if (renamed.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.created_by).toBe(ownerId);
  });
});
