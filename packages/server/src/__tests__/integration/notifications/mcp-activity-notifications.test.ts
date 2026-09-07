import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import {
  currentMcpActivityAttribution,
  recordMcpConversationActivity,
} from '../../../lobu/stores/mcp-client-conversations';
import {
  createNotificationForUsers,
  deleteNotification,
  listNotifications,
  markAllAsRead,
  markAsRead,
} from '../../../notifications/service';
import { listOrgActivity } from '../../../tools/admin/manage_operations/activity-feed';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('MCP activity notification attribution', () => {
  let organizationId: string;
  let organizationSlug: string;
  let ownerId: string;
  let otherOwnerId: string;
  let ownerToken: string;
  let otherOwnerToken: string;
  let clientId: string;

  const conversationId = 'host-conversation';
  const transportSessionId = 'transport-session';

  function conversationContext(
    userId: string,
    overrides: Partial<ToolContext> = {}
  ): ToolContext {
    return {
      organizationId,
      userId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId,
      mcpConversationId: conversationId,
      mcpSessionId: transportSessionId,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      ...overrides,
    } as ToolContext;
  }

  async function activityFor(token: string) {
    const response = await get(
      `/api/${organizationSlug}/clients/activity-scopes?client_ids=${clientId}`,
      { token }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scopes: Array<{ activityId: string; unreadNotificationCount: number }>;
    };
    return body.scopes.find((scope) => scope.activityId === conversationId)!;
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const organization = await createTestOrganization({
      name: 'MCP Activity Notification Org',
      slug: 'mcp-activity-notifications',
    });
    organizationId = organization.id;
    organizationSlug = organization.slug;

    const owner = await createTestUser({ email: 'mcp-count-owner@example.com' });
    const otherOwner = await createTestUser({ email: 'mcp-count-other@example.com' });
    ownerId = owner.id;
    otherOwnerId = otherOwner.id;
    await addUserToOrganization(ownerId, organizationId, 'owner');
    await addUserToOrganization(otherOwnerId, organizationId, 'owner');

    clientId = (
      await createTestOAuthClient({
        client_name: 'ChatGPT',
        owner_user_id: ownerId,
      })
    ).client_id;
    ownerToken = (
      await createTestAccessToken(ownerId, organizationId, clientId, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
    otherOwnerToken = (
      await createTestAccessToken(otherOwnerId, organizationId, clientId, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;

    await recordMcpConversationActivity({
      ctx: conversationContext(ownerId),
      toolName: 'manage_operations',
      failed: false,
    });
    await recordMcpConversationActivity({
      ctx: conversationContext(ownerId, {
        mcpConversationId: 'other-chatgpt-conversation',
        mcpSessionId: 'other-chatgpt-transport',
      }),
      toolName: 'manage_operations',
      failed: false,
    });
  });

  it('derives per-user unread counts from existing notification target state', async () => {
    const mcpActivity = currentMcpActivityAttribution(conversationContext(ownerId));
    expect(mcpActivity).not.toBeNull();

    expect(
      await createNotificationForUsers([ownerId, otherOwnerId], {
        organizationId,
        type: 'generic',
        title: 'Shared activity notification',
        idempotencyKey: 'mcp-activity-shared',
        mcpActivity,
      })
    ).toMatchObject({ created: true });
    expect(
      await createNotificationForUsers([ownerId, otherOwnerId], {
        organizationId,
        type: 'generic',
        title: 'Shared activity notification retry',
        idempotencyKey: 'mcp-activity-shared',
        mcpActivity,
      })
    ).toMatchObject({ created: false });
    await notify(
      {
        action: 'send',
        recipients: [ownerId],
        title: 'Owner-only activity notification',
      },
      {} as never,
      conversationContext(ownerId)
    );
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Unattributed notification',
    });

    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(2);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    const notifications = await getDb()<Array<{ id: number; title: string }>>`
      SELECT id, title
      FROM events
      WHERE organization_id = ${organizationId}
        AND semantic_type = 'notification'
    `;
    const sharedId = Number(
      notifications.find((item) => item.title === 'Shared activity notification')!.id
    );
    const ownerOnlyId = Number(
      notifications.find((item) => item.title === 'Owner-only activity notification')!.id
    );

    expect(await markAsRead(organizationId, ownerId, sharedId)).toBe(true);
    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(1);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    expect(await deleteNotification(organizationId, ownerId, ownerOnlyId)).toBe(true);
    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(0);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(1);

    expect(await deleteNotification(organizationId, ownerId, sharedId)).toBe(true);
    expect(await markAllAsRead(organizationId, otherOwnerId)).toBe(1);
    expect((await activityFor(otherOwnerToken)).unreadNotificationCount).toBe(0);
  });

  it('stores provenance on the event and keeps notification targets recipient-only', async () => {
    const [event] = await getDb()<Array<{
      client_id: string | null;
      metadata: Record<string, unknown>;
    }>>`
      SELECT client_id, metadata
      FROM events
      WHERE organization_id = ${organizationId}
        AND title = 'Shared activity notification'
    `;
    expect(event).toMatchObject({
      client_id: clientId,
      metadata: {
        mcp_conversation_id: conversationId,
        mcp_session_id: transportSessionId,
      },
    });

    const targetAttributionColumns = await getDb()<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notification_targets'
        AND column_name LIKE 'mcp_%'
    `;
    expect(targetAttributionColumns).toEqual([]);
  });

  it('filters notifications and events to exactly one activity id', async () => {
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Exact activity notification',
      mcpActivity: currentMcpActivityAttribution(conversationContext(ownerId)),
    });
    await createNotificationForUsers([ownerId], {
      organizationId,
      type: 'generic',
      title: 'Other ChatGPT conversation notification',
      mcpActivity: currentMcpActivityAttribution(
        conversationContext(ownerId, {
          mcpConversationId: 'other-chatgpt-conversation',
          mcpSessionId: 'other-chatgpt-transport',
        })
      ),
    });
    const notificationsResponse = await get(
      `/api/${organizationSlug}/notifications?client_ids=${clientId}&mcp_activity_id=${conversationId}`,
      { token: ownerToken }
    );
    expect(notificationsResponse.status).toBe(200);
    const notificationsBody = (await notificationsResponse.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(notificationsBody.notifications.map((item) => item.title)).toContain(
      'Exact activity notification'
    );
    expect(notificationsBody.notifications.map((item) => item.title)).not.toContain(
      'Unattributed notification'
    );
    expect(notificationsBody.notifications.map((item) => item.title)).not.toContain(
      'Other ChatGPT conversation notification'
    );

    const result = await getContent(
      {
        client_ids: [clientId],
        mcp_activity_id: conversationId,
        limit: 100,
      } as never,
      {} as never,
      conversationContext(ownerId)
    );
    expect(result.content.map((item) => item.title)).toContain('Exact activity notification');
    expect(result.content.map((item) => item.title)).not.toContain('Unattributed notification');
    expect(result.content.map((item) => item.title)).not.toContain(
      'Other ChatGPT conversation notification'
    );
  });

  it('does not guess legacy notification provenance from a linked proposal', async () => {
    const unreadBefore = (await activityFor(ownerToken)).unreadNotificationCount;
    const sql = getDb();
    const [proposal] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        organization_id, origin_id, payload_type, semantic_type,
        interaction_type, interaction_status, client_id, metadata
      ) VALUES (
        ${organizationId}, 'legacy-proposal', 'text', 'operation',
        'approval', 'pending', ${clientId},
        ${sql.json({ mcp_session_id: transportSessionId })}
      )
      RETURNING id
    `;
    const [notification] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        organization_id, title, payload_type, semantic_type, metadata
      ) VALUES (
        ${organizationId}, 'Legacy approval notification', 'text', 'notification',
        ${sql.json({
          notification_type: 'action_approval_needed',
          resource_type: 'event',
          resource_id: String(proposal.id),
        })}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO notification_targets (event_id, user_id)
      VALUES (${notification.id}, ${ownerId})
    `;

    expect((await activityFor(ownerToken)).unreadNotificationCount).toBe(unreadBefore);
    const filtered = await get(
      `/api/${organizationSlug}/notifications?client_ids=${clientId}&mcp_activity_id=${conversationId}`,
      { token: ownerToken }
    );
    const filteredBody = (await filtered.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(filteredBody.notifications.map((item) => item.title)).not.toContain(
      'Legacy approval notification'
    );

    const global = await get(`/api/${organizationSlug}/notifications`, { token: ownerToken });
    const globalBody = (await global.json()) as {
      notifications: Array<{ title: string }>;
    };
    expect(globalBody.notifications.map((item) => item.title)).toContain(
      'Legacy approval notification'
    );
  });
});

describe('notification list > source attribution', () => {
  it('carries the complete linked source and originator attribution', async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const sql = getDb();
    const org = await createTestOrganization({ name: 'Attr Notification Org' });
    const user = await createTestUser({ email: 'attr-notif@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    await createTestAgent({
      organizationId: org.id,
      agentId: 'attr-notif-agent',
      name: 'Attribution Agent',
      ownerUserId: user.id,
    });
    await createTestAgent({
      organizationId: org.id,
      agentId: 'replacement-agent',
      name: 'Replacement Agent',
      ownerUserId: user.id,
    });
    const attributedClient = await createTestOAuthClient({ client_name: 'ChatGPT' });

    await createTestConnectorDefinition({
      key: 'attr-notif-connector',
      name: 'Attr Notif',
      organization_id: org.id,
    });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'attr-notif-connector',
      display_name: 'Attribution account',
      visibility: 'org',
      created_by: user.id,
    });
    const [device] = await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${user.id}, 'attr-notif-device', 'macos', '[]'::jsonb,
        'Burak Mac mini', ${org.id}
      )
      RETURNING id
    `;
    const [replacementDevice] = await sql`
      INSERT INTO device_workers (
        user_id, worker_id, platform, capabilities, label, organization_id
      ) VALUES (
        ${user.id}, 'replacement-device', 'linux', '[]'::jsonb,
        'Replacement device', ${org.id}
      )
      RETURNING id
    `;
    await sql`
      UPDATE connections SET device_worker_id = ${device.id} WHERE id = ${conn.id}
    `;

    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, display_name, created_at)
      VALUES (${org.id}, ${conn.id}, 'home_feed', 'active', 'Attr Notif Feed', NOW())
      RETURNING id
    `;

    const automationId = 910001;
    await sql`
      INSERT INTO automations (
        id, name, slug, organization_id, entity_ids, schedule, timezone,
        next_run_at, managed_agent_id, model_config, sources, version, tags, status,
        created_by, created_at, updated_at, automation_group_id, triggers
      ) VALUES (
        ${automationId}, 'Attr Notif Automation', 'attr-notif-automation',
        ${org.id}, '{}'::bigint[], '0 9 * * *', 'Europe/London', NOW(),
        'attr-notif-agent', '{}'::jsonb, '[]'::jsonb, 1, '{}'::text[],
        'active', ${user.id}, NOW(), NOW(), ${automationId}, '[]'::jsonb
      )
    `;
    const [v1] = await sql`
      INSERT INTO automation_versions (automation_id, version, name, created_by, prompt, created_at)
      VALUES (${automationId}, 1, 'Attr Notif Automation', ${user.id}, 'prompt', NOW())
      RETURNING id
    `;
    await sql`
      UPDATE automations SET current_version_id = ${v1.id} WHERE id = ${automationId}
    `;

    const [sourceRun] = await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, status, approved_input
      ) VALUES (
        ${org.id}, 'automation', ${automationId}, 'completed',
        ${sql.json({
          agent_id: 'attr-notif-agent',
          device_worker_id: String(device.id),
        })}
      )
      RETURNING id
    `;

    const [ev] = await sql`
      INSERT INTO events (
        organization_id, title, payload_type, payload_text, occurred_at,
        semantic_type, connector_key, connection_id, feed_id, feed_key,
        automation_id, automation_version_id, run_id, client_id, metadata, created_at
      ) VALUES (
        ${org.id}, 'Attr notification', 'text', 'notification body', NOW(),
        'notification', 'attr-notif-connector', ${conn.id}, ${feed.id}, 'home_feed',
        ${automationId}, ${v1.id}, ${sourceRun.id}, ${attributedClient.client_id}, '{}'::jsonb, NOW()
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO notification_targets (event_id, user_id, delivered_at)
      VALUES (${ev.id}, ${user.id}, NOW())
    `;

    // Change every mutable current assignment after the notification was
    // produced. Attribution must stay on the immutable event-time run values.
    const [v2] = await sql`
      INSERT INTO automation_versions (automation_id, version, name, created_by, prompt, created_at)
      VALUES (${automationId}, 2, 'Renamed Notif Automation', ${user.id}, 'prompt', NOW())
      RETURNING id
    `;
    await sql`
      UPDATE automations
      SET current_version_id = ${v2.id},
          managed_agent_id = 'replacement-agent',
          device_worker_id = ${replacementDevice.id}
      WHERE id = ${automationId}
    `;
    await sql`
      UPDATE connections
      SET device_worker_id = ${replacementDevice.id}
      WHERE id = ${conn.id}
    `;

    const { notifications } = await listNotifications({
      organizationId: org.id,
      userId: user.id,
    });
    const item = notifications.find((n) => n.id === ev.id);
    expect(item).toBeTruthy();
    // The producing version (v1) name, not the renamed current version.
    expect(item!.automation_name).toBe('Attr Notif Automation');
    expect(item!.automation_id).toBe(automationId);
    expect(item!.feed_name).toBe('Attr Notif Feed');
    expect(item!.feed_id).toBe(feed.id);
    expect(item!.feed_key).toBe('home_feed');
    expect(item!.platform).toBe('attr-notif-connector');
    expect(item!.connection_id).toBe(conn.id);
    expect(item).toMatchObject({
      connection_name: 'Attribution account',
      agent_id: 'attr-notif-agent',
      agent_name: 'Attribution Agent',
      client_id: attributedClient.client_id,
      client_name: 'ChatGPT',
      device_worker_id: device.id,
      device_label: 'Burak Mac mini',
      device_platform: 'macos',
    });

    const activity = await listOrgActivity({
      organizationId: org.id,
      userId: user.id,
      ownerSlug: org.slug,
      includeRuns: false,
    });
    const card = activity.items.find((entry) => entry.notification_id === ev.id);
    expect(card).toMatchObject({
      platform: 'attr-notif-connector',
      connection_id: conn.id,
      feed_id: feed.id,
      feed_key: 'home_feed',
      feed_name: 'Attr Notif Feed',
      automation_id: automationId,
      automation_name: 'Attr Notif Automation',
      connection_name: 'Attribution account',
      agent_id: 'attr-notif-agent',
      agent_name: 'Attribution Agent',
      client_id: attributedClient.client_id,
      client_name: 'ChatGPT',
      device_worker_id: device.id,
      device_label: 'Burak Mac mini',
      device_platform: 'macos',
    });

    const content = await getContent(
      { content_ids: [Number(ev.id)], limit: 10 } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopes: ['mcp:read'],
      } as ToolContext
    );
    expect(content.content[0]).toMatchObject({
      connection_name: 'Attribution account',
      agent_id: 'attr-notif-agent',
      agent_name: 'Attribution Agent',
      client_id: attributedClient.client_id,
      client_name: 'ChatGPT',
      device_worker_id: device.id,
      device_label: 'Burak Mac mini',
      device_platform: 'macos',
    });

    const publicContent = await getContent(
      { content_ids: [Number(ev.id)], limit: 10 } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: null,
        memberRole: null,
        isAuthenticated: false,
        tokenType: 'anonymous',
        scopedToOrg: true,
        allowCrossOrg: false,
      } as ToolContext
    );
    expect(publicContent.content[0]).toMatchObject({
      connection_name: null,
      agent_id: null,
      agent_name: null,
      client_id: null,
      device_worker_id: null,
      device_label: null,
      device_platform: null,
    });

    const authenticatedNonMemberContent = await getContent(
      { content_ids: [Number(ev.id)], limit: 10 } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: 'authenticated-outsider',
        memberRole: null,
        isAuthenticated: true,
        tokenType: 'oauth',
        scopes: ['mcp:read'],
      } as ToolContext
    );
    expect(authenticatedNonMemberContent.content[0]).toMatchObject({
      connection_name: null,
      agent_id: null,
      agent_name: null,
      client_id: null,
      device_worker_id: null,
      device_label: null,
      device_platform: null,
    });

    const malformedConnectionEvents = await sql`
      INSERT INTO events (
        organization_id, origin_id, title, payload_type, payload_text,
        semantic_type, connector_key, metadata, occurred_at, created_at
      ) VALUES
        (
          ${org.id}, 'fractional-source-connection', 'Fractional source connection',
          'text', 'fractional', 'content', 'attr-notif-connector',
          '{"source_connection_id": 1.5}'::jsonb, NOW(), NOW()
        ),
        (
          ${org.id}, 'oversized-source-connection', 'Oversized source connection',
          'text', 'oversized', 'content', 'attr-notif-connector',
          '{"source_connection_id": 999999999999999999999999999999}'::jsonb, NOW(), NOW()
        )
      RETURNING id
    `;
    const malformedContent = await getContent(
      {
        content_ids: malformedConnectionEvents.map((row) => Number(row.id)),
        limit: 10,
      } as never,
      {} as never,
      {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopes: ['mcp:read'],
      } as ToolContext
    );
    expect(malformedContent.content).toHaveLength(2);
    expect(malformedContent.content.every((item) => item.connection_name === null)).toBe(true);
  });
});
