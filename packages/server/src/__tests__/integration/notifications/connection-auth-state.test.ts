import { beforeEach, describe, expect, it } from 'vitest';
import { getUnreadCount, listNotifications, markAsRead } from '../../../notifications/service';
import { notifyConnectionPermissionRequest } from '../../../notifications/triggers';
import { listOrgActivity } from '../../../tools/admin/manage_operations/activity-feed';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestConnection, createTestEvent, createTestUser, seedOwnerContext } from '../../setup/test-fixtures';

async function seed() {
  const { org, user } = await seedOwnerContext({ orgName: 'Synthetic consent notifications' });
  const other = await createTestUser({ name: 'Synthetic workspace administrator' });
  await addUserToOrganization(other.id, org.id, 'admin');
  const connection = await createTestConnection({ organization_id: org.id, created_by: user.id,
    connector_key: 'synthetic.oauth', display_name: 'Synthetic personal account', visibility: 'private',
    status: 'pending_auth', createDefaultFeed: false });
  await notifyConnectionPermissionRequest({ orgId: org.id, connectionId: connection.id, connectorKey: 'synthetic.oauth' });
  return { org, user, other, connection, options: { organizationId: org.id, userId: user.id } };
}

describe('connection authorization notification lifecycle', () => {
  beforeEach(cleanupTestDatabase);

  it('targets the account owner and keeps unresolved authorization in attention after opening', async () => {
    const s = await seed();
    expect((await listNotifications({ ...s.options, userId: s.other.id })).notifications).toHaveLength(0);
    const initial = await listNotifications({ ...s.options, attentionOnly: true });
    expect(initial.notifications).toHaveLength(1);
    await markAsRead(s.org.id, s.user.id, Number(initial.notifications[0].id));
    expect((await listNotifications({ ...s.options, attentionOnly: true })).notifications).toHaveLength(1);
    expect(await getUnreadCount(s.org.id, s.user.id)).toBe(0);
    const activity = await listOrgActivity({ ...s.options, ownerSlug: s.org.slug, includeRuns: false });
    expect(activity.items).toEqual(expect.arrayContaining([expect.objectContaining({
      notification_id: Number(initial.notifications[0].id), interaction_type: 'authorization', interaction_status: 'pending',
    })]));
  });

  it('prioritizes unresolved authorization before newer unread messages within the attention limit', async () => {
    const s = await seed();
    const initial = await listNotifications(s.options);
    const id = Number(initial.notifications[0].id);
    await markAsRead(s.org.id, s.user.id, id);
    const message = await createTestEvent({ organization_id: s.org.id, semantic_type: 'notification', title: 'Newer message', content: 'Synthetic unread notification' });
    await getTestDb()`INSERT INTO notification_targets (event_id, user_id) VALUES (${message.id}, ${s.user.id})`;
    const attention = await listNotifications({ ...s.options, attentionOnly: true, limit: 1 });
    expect(attention.notifications.map((item) => Number(item.id))).toEqual([id]);
  });

  it.each(['active', 'deleted'] as const)('resolves an unread request when its connection is %s', async (change) => {
    const s = await seed();
    const sql = getTestDb();
    if (change === 'deleted') await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${s.connection.id}`;
    else await sql`UPDATE connections SET status = 'active' WHERE id = ${s.connection.id}`;
    expect((await listNotifications({ ...s.options, attentionOnly: true })).notifications).toHaveLength(0);
    expect(await getUnreadCount(s.org.id, s.user.id)).toBe(0);
    const history = await listNotifications(s.options);
    expect(history.notifications).toHaveLength(1);
    expect(history.notifications[0].title).not.toContain('needs authorization');
  });
});
