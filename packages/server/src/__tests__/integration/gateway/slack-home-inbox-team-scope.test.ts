/**
 * Real-Postgres reproducer: Slack App Home inbox MUST be scoped by team_id.
 *
 * Bug (pi blocker): `resolveSlackHomeUserInbox` looked up the viewing Slack
 * user's Lobu identity by `platform_user_id` alone:
 *
 *   WHERE platform = 'slack' AND platform_user_id = ${slackUserId}
 *
 * Slack user ids are only unique WITHIN a workspace, so two different Lobu
 * users in two different Slack workspaces can share the same
 * `platform_user_id`. With both rows present the un-scoped query matched BOTH
 * (LIMIT 2 → length 2), and the function bailed to `null` — but the underlying
 * lookup had no workspace boundary at all, so a single-identity collision would
 * have surfaced the WRONG user's notifications/org on the home tab.
 *
 * Fix: scope by the connection's Slack team_id —
 *
 *   WHERE platform = 'slack' AND team_id = ${teamId} AND platform_user_id = ${slackUserId}
 *
 * — where `teamId` is the real workspace id for OAuth installs and '' for the
 * hosted-preview connection (which writes identity rows with team_id='').
 *
 * This drives the REAL exported `resolveSlackHomeUserInbox` against the test
 * Postgres. It seeds two identities sharing `platform_user_id='U_COLLIDE'` in
 * different workspaces ('T_AAA'→userA, 'T_BBB'→userB), each with its own org +
 * notification, and asserts the lookup returns exactly the scoped user's data
 * and never the other workspace's.
 *
 * Red/green proof (run manually, reported in the PR): reverting the query to
 * the un-scoped form (`team_id = ${teamId} AND` removed) makes the collision
 * case return null (length-2 ambiguity) instead of userA's inbox → tests FAIL.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSlackHomeUserInbox } from '../../../gateway/connections/chat-instance-manager';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  linkChatIdentityInGraph,
} from '../../setup/test-fixtures';

const COLLIDING_SLACK_USER_ID = 'U_COLLIDE';

/** Link a Slack (team, user) → Lobu user, as Slack sign-in does. */
async function linkSlackIdentity(opts: {
  organizationId: string;
  teamId: string;
  platformUserId: string;
  lobuUserId: string;
}): Promise<void> {
  await linkChatIdentityInGraph({
    organizationId: opts.organizationId,
    platform: "slack",
    userId: opts.lobuUserId,
    teamId: opts.teamId,
    platformUserId: opts.platformUserId,
  });
}

/** Deliver one notification (events row + notification_targets row) to a user. */
async function seedNotification(opts: {
  organizationId: string;
  userId: string;
  title: string;
  resourceUrl: string;
}): Promise<void> {
  const sql = getTestDb();
  const event = await createTestEvent({
    organization_id: opts.organizationId,
    title: opts.title,
    content: opts.title,
    metadata: { resource_url: opts.resourceUrl },
  });
  await sql`
    INSERT INTO notification_targets (event_id, user_id, delivered_at, read_at)
    VALUES (${event.id}, ${opts.userId}, now(), NULL)
  `;
}

/**
 * Seed a self-contained workspace identity: an org (with a known slug), a Lobu
 * user that owns it, the Slack identity link for `teamId`, and one unread
 * notification. Returns the data the assertions check against.
 */
async function seedWorkspaceUser(opts: {
  teamId: string;
  orgSlug: string;
  notifTitle: string;
  resourceUrl: string;
}): Promise<{ userId: string; orgSlug: string; notifTitle: string }> {
  const org = await createTestOrganization({ slug: opts.orgSlug });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await linkSlackIdentity({
    organizationId: org.id,
    teamId: opts.teamId,
    platformUserId: COLLIDING_SLACK_USER_ID,
    lobuUserId: user.id,
  });
  await seedNotification({
    organizationId: org.id,
    userId: user.id,
    title: opts.notifTitle,
    resourceUrl: opts.resourceUrl,
  });
  return { userId: user.id, orgSlug: org.slug, notifTitle: opts.notifTitle };
}

describe('resolveSlackHomeUserInbox team_id scoping (cross-workspace isolation)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('resolves only the scoped workspace user when platform_user_id collides across workspaces', async () => {
    // Two DIFFERENT Lobu users in two DIFFERENT Slack workspaces, sharing the
    // SAME Slack user id 'U_COLLIDE'.
    const a = await seedWorkspaceUser({
      teamId: 'T_AAA',
      orgSlug: 'workspace-a',
      notifTitle: 'A-notif',
      resourceUrl: '/workspace-a/items/1',
    });
    const b = await seedWorkspaceUser({
      teamId: 'T_BBB',
      orgSlug: 'workspace-b',
      notifTitle: 'B-notif',
      resourceUrl: '/workspace-b/items/1',
    });

    // T_AAA → user A's inbox, and NEVER user B's data.
    const inboxA = await resolveSlackHomeUserInbox(COLLIDING_SLACK_USER_ID, 'T_AAA');
    expect(inboxA).not.toBeNull();
    expect(inboxA!.orgSlug).toBe(a.orgSlug);
    expect(inboxA!.items.map((i) => i.title)).toEqual(['A-notif']);
    expect(inboxA!.unreadCount).toBe(1);
    // The collision-safety assertion that nails the bug: user B must not leak in.
    expect(inboxA!.orgSlug).not.toBe(b.orgSlug);
    expect(inboxA!.items.map((i) => i.title)).not.toContain('B-notif');

    // T_BBB → user B's inbox, symmetrically isolated.
    const inboxB = await resolveSlackHomeUserInbox(COLLIDING_SLACK_USER_ID, 'T_BBB');
    expect(inboxB).not.toBeNull();
    expect(inboxB!.orgSlug).toBe(b.orgSlug);
    expect(inboxB!.items.map((i) => i.title)).toEqual(['B-notif']);
    expect(inboxB!.items.map((i) => i.title)).not.toContain('A-notif');
  });

  it('returns null when no identity matches the (team_id, user) pair', async () => {
    await seedWorkspaceUser({
      teamId: 'T_AAA',
      orgSlug: 'workspace-a',
      notifTitle: 'A-notif',
      resourceUrl: '/workspace-a/items/1',
    });
    // Right Slack user, wrong workspace → no linked identity → setup prompt.
    const inbox = await resolveSlackHomeUserInbox(COLLIDING_SLACK_USER_ID, 'T_NONEXISTENT');
    expect(inbox).toBeNull();
  });
});
