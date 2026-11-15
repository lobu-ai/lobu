/** Integration coverage for kind-backed notification write, render, and filtering. */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createNotificationForUsers } from '../../../notifications/service';
import { notify } from '../../../tools/admin/notify';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { primeMemberEventKinds } from '../../../utils/event-kind-validation';
import { insertEvent } from '../../../utils/insert-event';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('notify > semantic_type (kind) payload', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let ctx: ToolContext;
  const sql = getTestDb();

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Notify Kind Org' });
    user = await createTestUser({ email: 'notify-kind@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({
      name: 'Notify Kind Entity',
      organization_id: org.id,
    });
    // An entity-anchored notification renders from the same entity kind that
    // owns its native chat card and interactions. Unanchored notifications
    // continue to use the workspace $member registry.
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        funnel_digest: {
          description: 'Entity-scoped digest renderer',
          jsonTemplate: { type: 'markdown', content: 'Entity-local registry' },
        },
      })}
      WHERE id = (
        SELECT entity_type_id FROM entities WHERE id = ${entity.id}
      )
    `;

    const { client_id } = await createTestOAuthClient({
      client_name: 'notify-kind-test',
      owner_user_id: user.id,
    });
    await createTestAccessToken(user.id, org.id, client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId: client_id,
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };

    // Register a kind with a bar-chart template so the render tail can resolve it.
    await ensureMemberEntityType(org.id);
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
        funnel_digest: {
          description: 'Weekly funnel digest',
          metadataSchema: {
            type: 'object',
            properties: {
              rows: { type: 'array' },
            },
            required: ['rows'],
          },
          jsonTemplate: {
            type: 'bar-chart',
            data: '{{rows}}',
          },
        },
        static_digest: {
          description: 'Static digest',
          metadataSchema: { type: 'object' },
          jsonTemplate: { type: 'bar-chart', data: [] },
        },
      })}
      WHERE slug = '$member'
        AND organization_id = ${org.id}
        AND deleted_at IS NULL
    `;
    primeMemberEventKinds(org.id, {
      funnel_digest: {
        description: 'Weekly funnel digest',
        metadataSchema: {
          type: 'object',
          properties: {
            rows: { type: 'array' },
          },
          required: ['rows'],
        },
        jsonTemplate: {
          type: 'bar-chart',
          data: '{{rows}}',
        },
      },
      static_digest: {
        description: 'Static digest',
        metadataSchema: { type: 'object' },
        jsonTemplate: { type: 'bar-chart', data: [] },
      },
    } as never);
  });

  it('writes a kind notification through the event payload columns', async () => {
    const data = {
      rows: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 24 },
      ],
      _lobu_idempotency_key: 'caller-controlled',
      card: { type: 'caller-controlled' },
      mcp_session_id: 'caller-controlled',
    };
    const { notified_count, event_id } = await notify({
      action: 'send',
      title: 'Funnel digest',
      body: 'Two new leads this week.',
      semantic_type: 'funnel_digest',
      data,
    }, {} as never, ctx);

    expect(notified_count).toBe(1);
    expect(event_id).not.toBeNull();

    const rows = await sql<{
      semantic_type: string;
      payload_type: string;
      payload_text: string;
      payload_data: unknown;
    }>`
      SELECT semantic_type, payload_type, payload_text, payload_data
      FROM events
      WHERE id = ${event_id}
    `;
    expect(rows[0].semantic_type).toBe('funnel_digest');
    expect(rows[0].payload_type).toBe('empty');
    expect(rows[0].payload_text).toBe('Two new leads this week.');
    expect(rows[0].payload_data).toEqual(data);

    const meta = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM events WHERE id = ${event_id}
    `;
    expect(meta[0].metadata.notification_type).toBe('agent_message');
    expect(meta[0].metadata).not.toHaveProperty('rows');
    expect(meta[0].metadata).not.toHaveProperty('_lobu_idempotency_key');
    expect(meta[0].metadata).not.toHaveProperty('card');
    expect(meta[0].metadata).not.toHaveProperty('mcp_session_id');
  });

  it('renders the owning kind template for notifications via get_content', async () => {
    await insertEvent({
      organizationId: org.id,
      originId: 'notify-kind-non-notification-control',
      title: 'only-nonnotification-control-94721',
      entityIds: [entity.id],
      semanticType: 'funnel_digest',
      payloadType: 'empty',
      payloadData: { rows: [{ label: 'Wed', value: 7 }] },
      metadata: { rows: [{ label: 'Wed', value: 7 }] },
    });
    await createNotificationForUsers([user.id], {
      organizationId: org.id,
      type: 'agent_message',
      title: 'Chart notification',
      body: 'Daily events',
      entityIds: [entity.id],
      semanticType: 'funnel_digest',
      payloadData: {
        rows: [
          { label: 'Mon', value: 10 },
          { label: 'Tue', value: 24 },
        ],
      },
    });
    await notify({
      action: 'send',
      title: 'Kind notification without data',
      semantic_type: 'static_digest',
      data: {},
    }, {} as never, ctx);
    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'notify-kind-summary-control',
      title: 'Summary control',
      semanticType: 'summary',
      payloadType: 'text',
      content: 'A normal summary',
    });
    const content = await getContent(
      {
        limit: 10,
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );

    const chartItem = content.content?.find((item) => item.title === 'Chart notification');
    expect(chartItem).toBeDefined();
    expect(
      content.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);
    expect(chartItem?.payload_type).toBe('json_template');
    expect(chartItem?.payload_data).toEqual({
      rows: [
        { label: 'Mon', value: 10 },
        { label: 'Tue', value: 24 },
      ],
    });
    expect(chartItem?.payload_template).toEqual({
      root: {
        type: 'markdown',
        content: 'Entity-local registry',
      },
    });
    const noDataItem = content.content?.find(
      (item) => item.title === 'Kind notification without data'
    );
    expect(noDataItem?.payload_type).toBe('json_template');
    expect(noDataItem?.payload_template).toEqual({
      root: { type: 'bar-chart', data: [] },
    });
    expect(noDataItem?.payload_data).toEqual({});

    const search = await getContent(
      {
        query: 'only-nonnotification-control-94721',
        sort_by: 'date',
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(search.content).toEqual([]);

    const mixedKinds = await getContent(
      {
        limit: 20,
        semantic_type: ['notification', 'summary'],
      } as never,
      {} as never,
      ctx
    );
    expect(mixedKinds.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(mixedKinds.content?.some((item) => item.title === 'Summary control')).toBe(true);
    expect(
      mixedKinds.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);

    const scoreSorted = await getContent(
      {
        limit: 20,
        sort_by: 'score',
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(scoreSorted.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(
      scoreSorted.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);

    const history = await getContent(
      {
        entity_id: entity.id,
        limit: 20,
        include_superseded: true,
        semantic_type: 'notification',
      } as never,
      {} as never,
      ctx
    );
    expect(history.content?.some((item) => item.title === 'Chart notification')).toBe(true);
    expect(
      history.content?.some((item) => item.title === 'only-nonnotification-control-94721')
    ).toBe(false);
  });

  it('rejects an unregistered kind', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Bad kind',
          semantic_type: 'does_not_exist',
          data: {},
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/Invalid kind 'does_not_exist'/);
  });

  it('rejects data that does not match the kind metadata schema', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Bad data',
          semantic_type: 'funnel_digest',
          data: { total: 12 },
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/Metadata validation failed for kind 'funnel_digest'/);
  });

  it('rejects semantic_type combined with input_schema', async () => {
    await expect(
      notify(
        {
          action: 'send',
          title: 'Mixed',
          semantic_type: 'funnel_digest',
          input_schema: {},
          recipients: ['missing-user'],
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('leaves the ask path untouched: notification stays semantic_type=notification', async () => {
    await notify(
      {
        action: 'send',
        title: 'Approve this?',
        input_schema: {},
      } as never,
      {} as never,
      ctx
    );

    const rows = await sql<{ semantic_type: string }>`
      SELECT semantic_type
      FROM events
      WHERE title = 'Approve this?'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows[0].semantic_type).toBe('notification');
  });
});

describe('published notification inboxes', () => {
  async function fixture() {
    const { buildClientSDK } = await import('../../../sandbox/client-sdk');
    const { seedOwnerContext } = await import('../../setup/test-fixtures');
    const sender = await seedOwnerContext({ orgName: 'Synthetic inbox sender' });
    const receiver = await seedOwnerContext({ orgName: 'Synthetic inbox receiver' });
    const receiverSdk = buildClientSDK(receiver.ctx, {} as never);
    await ensureMemberEntityType(receiver.org.id);
    await receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: {
      'support.report': { description: 'Submit a support report',
        inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' },
        metadataSchema: { type: 'object', properties: { reference: { type: 'string' } }, additionalProperties: false } },
      'private.note': { description: 'Never published' },
    } } as never);
    const sdk = buildClientSDK(sender.ctx, {} as never);
    const args = { organization: receiver.org.slug, inbox: 'support.report', title: 'Operational pilot',
      body: 'A synthetic report', data: { reference: 'https://example.com/reproduction' }, idempotency_key: 'synthetic-pilot' };
    return { sender, receiver, receiverSdk, sdk, args };
  }
  it('discovers and accepts a report from a different workspace without a connection', async () => {
    const { sender, receiver, receiverSdk, sdk, args } = await fixture();
    const discovered = await sdk.notifications.listInboxes({ organization: receiver.org.slug });
    expect(discovered.inboxes.map((inbox) => inbox.key)).toEqual(['support.report']);
    const accepted = await sdk.notifications.submit(args);
    expect(accepted).toEqual({ status: 'received', receipt: expect.any(String) });
    expect(await sdk.notifications.submit(args)).toEqual(accepted);
    const [event] = await getTestDb()`SELECT organization_id, connection_id, metadata, payload_data FROM events WHERE id = ${Number(accepted.receipt)}`;
    expect(event.organization_id).toBe(receiver.org.id);
    expect(event.connection_id).toBeNull();
    expect(event.metadata.inbox_submission).toMatchObject({ organization_id: sender.org.id, user_id: sender.user.id, inbox: 'support.report' });
    expect(event.payload_data).toEqual(args.data);
    expect((await sdk.notifications.list()).notifications).toHaveLength(0);
    expect((await receiverSdk.notifications.list()).notifications).toHaveLength(1);
    expect(await sdk.query(`SELECT id FROM events WHERE id = ${Number(accepted.receipt)}`)).toHaveLength(0);
    const tasks = await getTestDb()`SELECT id FROM runs WHERE action_key = 'activate-workspace-event' AND action_input->'payload'->>'eventId' = ${accepted.receipt}`;
    expect(tasks).toHaveLength(1);
  });

  it('uses the authenticated MCP sandbox for discovery and submission', async () => {
    const { sender, receiver, args } = await fixture();
    const { TestMcpClient } = await import('../../setup/test-mcp-client');
    const { createTestPAT } = await import('../../setup/test-fixtures');
    const wire = new TestMcpClient({ token: (await createTestPAT(sender.user.id, sender.org.id, { scope: 'mcp:read mcp:write' })).token, orgSlug: sender.org.slug });
    expect(await wire.querySdk(`export default async (_ctx, client) => client.notifications.listInboxes({ organization: ${JSON.stringify(receiver.org.slug)} })`))
      .toMatchObject({ success: true, return_value: { inboxes: [{ key: 'support.report' }] } });
    expect(await wire.runSdk(`export default async (_ctx, client) => client.notifications.submit(${JSON.stringify(args)})`))
      .toMatchObject({ success: true, return_value: { status: 'received', receipt: expect.any(String) } });
    expect(await wire.querySdk(`export default async (_ctx, client) => client.notifications.submit(${JSON.stringify(args)})`))
      .toMatchObject({ success: false });
  });

  it('deduplicates concurrent retries and refuses changed content for the same key', async () => {
    const { sdk, args } = await fixture();
    const receipts = await Promise.all(Array.from({ length: 5 }, () => sdk.notifications.submit(args)));
    expect(new Set(receipts.map((r) => r.receipt)).size).toBe(1);
    await expect(sdk.notifications.submit({ ...args, body: 'Different report' })).rejects.toMatchObject({ httpStatus: 409 });
    const race = await Promise.allSettled([
      sdk.notifications.submit({ ...args, idempotency_key: 'conflicting-race' }),
      sdk.notifications.submit({ ...args, idempotency_key: 'conflicting-race', body: 'Competing content' }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((result) => result.status === 'rejected')).toMatchObject({ reason: { httpStatus: 409 } });
  });

  it('keeps server provenance separate from arbitrary untrusted report data', async () => {
    const { sdk, receiverSdk, sender, args } = await fixture();
    await receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: { 'support.report': {
      inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' }, metadataSchema: { type: 'object' },
    } } });
    const forged = { organization_id: 'forged-workspace', user_id: 'forged-user' };
    const accepted = await sdk.notifications.submit({ ...args, data: { inbox_submission: forged } });
    const [report] = await getTestDb()`SELECT metadata, payload_data FROM events WHERE id = ${Number(accepted.receipt)}`;
    expect(report.metadata.inbox_submission).toMatchObject({ organization_id: sender.org.id, user_id: sender.user.id });
    expect(report.payload_data.inbox_submission).toEqual(forged);
  });

  it('enforces the persisted byte limit after schema coercion', async () => {
    const { sdk, receiverSdk, args } = await fixture();
    await receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: { 'support.report': {
      inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' },
      metadataSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } } },
    } } });
    await expect(sdk.notifications.submit({ ...args, data: { values: Array(5000).fill(1) } })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it.each([
    ['long title', { title: 'x'.repeat(201) }], ['long body', { body: 'x'.repeat(1001) }],
    ['large UTF-8 data', { data: { reference: '界'.repeat(6000) } }], ['schema mismatch', { data: { unexpected: true } }],
    ['caller recipients', { recipients: 'all' }], ['empty workspace', { organization: '' }], ['empty key', { idempotency_key: '' }],
  ])('rejects invalid or recipient-controlled input: %s', async (_label, patch) => {
    const { sdk, args } = await fixture();
    await expect(sdk.notifications.submit({ ...args, ...patch } as never)).rejects.toThrow();
  });

  it('fails closed for an unpublished, missing or immediately revoked inbox', async () => {
    const { sdk, receiverSdk, receiver, args } = await fixture();
    await expect(sdk.notifications.submit({ ...args, inbox: 'private.note' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(sdk.notifications.submit({ ...args, organization: 'nonexistent-synthetic-org' })).rejects.toMatchObject({ httpStatus: 404 });
    await receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: { 'support.report': { description: 'Closed' } } });
    expect(await sdk.notifications.listInboxes({ organization: receiver.org.slug })).toEqual({ inboxes: [] });
    await expect(sdk.notifications.submit(args)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('allows ordinary sending members, denies read-only tokens and nonmembers', async () => {
    const { buildClientSDK } = await import('../../../sandbox/client-sdk');
    const { sender, sdk, args } = await fixture();
    await expect(buildClientSDK({ ...sender.ctx, memberRole: null }, {} as never).notifications.submit(args)).rejects.toThrow(/membership/);
    await expect(buildClientSDK({ ...sender.ctx, scopes: ['mcp:read'] }, {} as never).notifications.submit(args)).rejects.toThrow(/write|scope/i);
    await getTestDb()`UPDATE "member" SET role = 'member' WHERE "organizationId" = ${sender.org.id} AND "userId" = ${sender.user.id}`;
    expect(await buildClientSDK({ ...sender.ctx, memberRole: 'member' }, {} as never).notifications.submit(args)).toMatchObject({ status: 'received' });
    expect(await sdk.notifications.listInboxes({ organization: args.organization })).toHaveProperty('inboxes');
  });

  it('publishes only workspace-owned kinds and requires a receiving administrator', async () => {
    const { sdk, receiver, args } = await fixture();
    const kinds = { 'support.report': { inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' } } };
    await expect(sdk.entitySchema.createType({ slug: 'ordinary', name: 'Ordinary', event_kinds: kinds })).rejects.toThrow('$member');
    const { buildClientSDK } = await import('../../../sandbox/client-sdk');
    await expect(buildClientSDK({ ...receiver.ctx, memberRole: 'member' }, {} as never).entitySchema.updateType({ slug: '$member', event_kinds: kinds })).rejects.toThrow();
    expect(await sdk.notifications.submit(args)).toMatchObject({ status: 'received' });
  });

  it('bounds new submissions across shared database admission while allowing an accepted retry', async () => {
    const { sdk, args } = await fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const first = await sdk.notifications.submit(args);
      for (let index = 1; index < 30; index++) {
        await sdk.notifications.submit({ ...args, idempotency_key: `bounded-${index}` });
      }
      await expect(sdk.notifications.submit({ ...args, idempotency_key: 'over-limit' })).rejects.toMatchObject({ httpStatus: 429 });
      expect(await sdk.notifications.submit(args)).toEqual(first);
    } finally { now.mockRestore(); }
  });

  it('fails closed without receiving administrators and never accepts sender identity from data', async () => {
    const { sdk, receiver, args } = await fixture();
    await expect(sdk.notifications.submit({ ...args, data: { organization_id: 'forged-workspace' } })).rejects.toMatchObject({ httpStatus: 422 });
    await getTestDb()`UPDATE "member" SET role = 'member' WHERE "organizationId" = ${receiver.org.id}`;
    await expect(sdk.notifications.submit(args)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await getTestDb()`SELECT id FROM events WHERE organization_id = ${receiver.org.id} AND semantic_type = 'support.report'`).toHaveLength(0);
  });

  it('rolls back the event and admin targets when durable activation cannot be queued', async () => {
    const { sdk, receiver, args } = await fixture();
    const db = getTestDb();
    await db`CREATE FUNCTION test_reject_inbox_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action_key = 'activate-workspace-event' THEN RAISE EXCEPTION 'synthetic activation persistence failure'; END IF; RETURN NEW; END $$`;
    await db`CREATE TRIGGER test_inbox_activation_failure BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION test_reject_inbox_activation()`;
    try {
      await expect(sdk.notifications.submit(args)).rejects.toThrow('synthetic activation persistence failure');
      expect(await db`SELECT id FROM events WHERE organization_id = ${receiver.org.id} AND semantic_type = 'support.report'`).toHaveLength(0);
    } finally {
      await db`DROP TRIGGER test_inbox_activation_failure ON runs`;
      await db`DROP FUNCTION test_reject_inbox_activation()`;
    }
    expect(await sdk.notifications.submit(args)).toMatchObject({ status: 'received' });
  });
});
