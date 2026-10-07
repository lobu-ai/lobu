import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGithubWebhookDelivery, deliverGithubConnectorConnectionWebhook } from '../../gateway/routes/public/app-webhooks';
import { receiveFeedNotifications, requestFeedSync, sourceFeedContextForRun } from '../../runs/feed-notifications';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser } from '../setup/test-fixtures';
import { enqueueSourceFeedListener, reconcileSourceFeedListeners } from '../../runs/source-feed-listener';
import { sourceFeedScopeKey, sourceFeedSubscriptions } from '../../runs/source-feed-subscriptions';
import * as subscriptions from '../../runs/source-feed-subscriptions';
import * as activation from '../../automations/activation';
import { SOURCE_FEED_LISTENER_TASK } from '../../scheduled/task-definitions';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY } from '../../lib/device-feed-read-protocol';
import { resolveRunConnectorPolicy } from '../../authz/operation-run-policy';
import * as entityPolicy from '../../authz/entity-policy';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import type { Env } from '../../index';
import type { ToolContext } from '../../tools/registry';
import { feedBackoff } from '../../connectors/feed-backoff';

async function fixture() {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  const [device] = await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at)
    VALUES (${user.id}, 'synthetic-source-worker', 'headless', ${sql.json([])}, ${org.id}, now()) RETURNING id
  `;
  const [connection] = await sql`
    INSERT INTO connections (organization_id, connector_key, slug, status, device_worker_id, visibility)
    VALUES (${org.id}, 'synthetic.source', 'source-notification-test', 'active', ${device.id}::uuid, 'org') RETURNING id
  `;
  await sql`
    INSERT INTO connector_definitions (organization_id, key, name, version, status, feeds_schema, auth_schema)
    VALUES (${org.id}, 'synthetic.source', 'Source', '1.0.0', 'active',
      ${sql.json({ items: { operations: ['sync'], webhook: { mode: 'trigger', events: ['changed'] } } })}, ${sql.json({ methods: [] })})
  `;
  const feeds = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
    VALUES (${org.id}, ${connection.id}, 'items', 'active', '* * * * *', now() + interval '1 hour'),
           (${org.id}, ${connection.id}, 'items', 'active', '* * * * *', now() + interval '1 hour') RETURNING id
  `;
  const notice = {
    feed_id: Number(feeds[0].id), connection_id: Number(connection.id), feed_key: 'items',
    notification_id: 'synthetic-notification', changed: true,
  };
  return { sql, org, user, device, connection, feeds, notice };
}

async function subscribedFixture() {
  const fixtureData = await fixture();
  const { sql, org, user, connection, notice } = fixtureData;
  await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: { operations: ['read'], webhook: { mode: 'trigger', events: ['message.created'] } } })},
    automation_events = ${sql.json([{ key: 'message.created', label: 'New message', resourceType: 'message' }])}
    WHERE organization_id = ${org.id}`;
  await sql`UPDATE feeds SET schedule = NULL, next_run_at = NULL`;
  await entityPolicy.upsertEntityApprovalPolicy(org.id, { resourceClass: 'connector_action', connectorKey: 'synthetic.source',
    operationCategory: 'read', effects: { execute: 'auto' } });
  const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
  const [{ id }] = await sql`SELECT nextval('automations_id_seq') AS id`;
  const automationId = Number(id);
  await sql`INSERT INTO automations (id, organization_id, slug, name, status, created_by, automation_group_id, managed_agent_id, triggers)
    VALUES (${automationId}, ${org.id}, 'synthetic-source-subscription', 'Source subscription', 'active', ${user.id},
      ${automationId}, ${agent.agentId}, ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
        connection_id: Number(connection.id), event_types: ['message.created'], execution: 'turn', active_run: 'queue', output: 'silent' }])})`;
  const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
    VALUES (${automationId}, 1, 'Source subscription', 'Read the source reference and distill it.', ${user.id}) RETURNING id`;
  const versionId = Number(version.id);
  await sql`UPDATE automations SET current_version_id = ${versionId} WHERE id = ${automationId}`;
  return { ...fixtureData, automationId, task: { organizationId: org.id, feedId: notice.feed_id } };
}

function referenceDelivery() {
  return {
    scope_key: sourceFeedScopeKey({}, '1.0.0'), binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', needs_rebind: false,
    records: [{ revision: 1, payload: { id: 'batch-1',
      events: [{ id: 'message-1', event_type: 'message.created', resource_ref: 'source-1' }],
      checkpoint: { previous: null, next: { after: 1 } } } }],
  };
}

describe('source feed notifications', () => {
  beforeEach(cleanupTestDatabase);

  it('delivers reference batches directly to existing coalescing subscriptions without a source runner', async () => {
    const { sql, org, device, notice, automationId } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: {
      operations: ['read'], webhook: { mode: 'trigger', events: ['message.created'] },
    } })} WHERE organization_id = ${org.id}`;
    await sql`UPDATE automations SET triggers = ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
      connection_id: notice.connection_id, event_types: ['message.created'], execution: 'turn',
      active_run: 'coalesce', output: 'silent' }])} WHERE id = ${automationId}`;
    const subscription = {
      scope_key: sourceFeedScopeKey({}, '1.0.0'), binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', needs_rebind: false,
      records: [{ revision: 1, payload: { id: 'batch-1', events: [
        { id: 'message-1', event_type: 'message.created', resource_ref: 'source-1' },
        { id: 'message-2', event_type: 'message.created', resource_ref: 'source-2' },
      ], checkpoint: { previous: null, next: { after: 2 } } } }],
    };
    const [receipt] = await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(receipt.active).toBe(true);
    expect(receipt.ack).toEqual({ binding_id: subscription.binding_id, epoch: subscription.epoch,
      records: [{ id: 'batch-1', revision: 1 }] });
    const runs = await sql`SELECT approved_input FROM runs WHERE organization_id = ${org.id} AND run_type = 'automation'`;
    expect(runs).toHaveLength(1);
    expect(runs[0].approved_input.trigger_signals).toHaveLength(2);
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id} AND run_type = 'automation'`).toHaveLength(1);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id} AND run_type = 'task'`).toHaveLength(0);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toEqual({ cursor: { after: 2 } });
  });

  it('wakes bound observers after scope changes and rejects results from the old configuration', async () => {
    const { sql, org, user, device, notice, feeds } = await subscribedFixture();
    const context = { organizationId: org.id, userId: user.id, memberRole: 'owner', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] } as ToolContext;
    await sql`UPDATE feeds SET consecutive_failures = 2, last_error = 'synthetic failure', next_run_at = now() + interval '1 hour' WHERE id = ${notice.feed_id}`;
    const updated = await manageFeeds({ action: 'update_feed', feed_id: notice.feed_id, config: { scope: 'new' } }, {} as Env, context);
    expect(updated).not.toHaveProperty('error');
    expect((await sql`SELECT next_run_at <= now() AS due, consecutive_failures, last_error FROM feeds WHERE id = ${notice.feed_id}`)[0])
      .toMatchObject({ due: true, consecutive_failures: 0, last_error: null });
    expect((await receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]))[0].active).toBe(false);
    expect(await sql`SELECT id FROM runs WHERE automation_id IS NOT NULL`).toHaveLength(0);
    await reconcileSourceFeedListeners(sql, device.id, [org.id], feeds.map(feed => Number(feed.id)));
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(1);
  });

  it('resuming observation clears failure backoff and marks the source due without adding a cadence', async () => {
    const { sql, org, user, notice } = await subscribedFixture();
    await sql`UPDATE feeds SET status = 'paused', consecutive_failures = 2, last_error = 'synthetic failure', next_run_at = now() + interval '1 hour' WHERE id = ${notice.feed_id}`;
    const context = { organizationId: org.id, userId: user.id, memberRole: 'owner', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] } as ToolContext;
    const updated = await manageFeeds({ action: 'update_feed', feed_id: notice.feed_id, status: 'active' }, {} as Env, context);
    expect(updated).not.toHaveProperty('error');
    expect((await sql`SELECT schedule, next_run_at <= now() AS due, consecutive_failures, last_error FROM feeds WHERE id = ${notice.feed_id}`)[0])
      .toMatchObject({ schedule: null, due: true, consecutive_failures: 0, last_error: null });
  });

  it.each([null, {}, { events: [] }, { events: [''] }])('does not set up a listener for an undispatchable webhook %j', async (webhook) => {
    const { sql, org, user, device, notice } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: { operations: ['read'], webhook } })}
      WHERE organization_id = ${org.id}`;
    const context = { organizationId: org.id, userId: user.id, memberRole: 'owner', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] } as ToolContext;
    const updated = await manageFeeds({ action: 'update_feed', feed_id: notice.feed_id, config: { scope: 'new' } }, {} as Env, context);
    expect(updated).not.toHaveProperty('error');
    await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
    expect.soft((await sql`SELECT next_run_at FROM feeds WHERE id = ${notice.feed_id}`)[0].next_run_at).toBeNull();
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(0);
    const subscription = { ...referenceDelivery(), scope_key: sourceFeedScopeKey({ scope: 'new' }, '1.0.0'), records: [], needs_rebind: true };
    expect((await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]))[0].active).toBe(false);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(0);
  });

  it('starts observation only for active subscriptions, dedupes wakes, and revokes the binding on pause', async () => {
    const { sql, org, device, notice, automationId } = await subscribedFixture();
    await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
    const initial = await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`;
    expect(initial).toHaveLength(2); // Two explicitly configured feed instances.
    const resolveSubscriptions = vi.spyOn(subscriptions, 'sourceFeedSubscriptions');
    try {
      await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
      expect(resolveSubscriptions).not.toHaveBeenCalled(); // Pending observation already owns authorization and setup.
    } finally {
      resolveSubscriptions.mockRestore();
    }
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(2);
    expect((await sql`SELECT schedule, next_run_at FROM feeds`).every(feed => feed.schedule === null && feed.next_run_at === null)).toBe(true);
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    expect((await receiveFeedNotifications(sql, [notice], device.id, [org.id]))[0].active).toBe(false);
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
  });

  it('does not regress the cursor when an old receipt is replayed', async () => {
    const { sql, org, device, notice } = await subscribedFixture();
    const subscription = referenceDelivery();
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    await sql`UPDATE feeds SET checkpoint = ${sql.json({ cursor: { after: 99 } })} WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toEqual({ cursor: { after: 99 } });
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(1);
  });

  it('retains replay continuation while a setup task finishes and drains buffered batches first', async () => {
    const { sql, org, device, notice } = await subscribedFixture();
    await sql.begin(tx => enqueueSourceFeedListener(tx, org.id, notice.feed_id));
    const subscription = { ...referenceDelivery(), needs_rebind: true };
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(1);
    subscription.records = [];
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(1);
    await sql`UPDATE runs SET status = 'completed' WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`;
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(2);
  });

  it('retries an unfinished setup after its task is reaped even when the browser already bound', async () => {
    const { sql, org, device, notice, feeds } = await subscribedFixture();
    await sql.begin(tx => enqueueSourceFeedListener(tx, org.id, notice.feed_id));
    await sql`UPDATE runs SET status = 'failed' WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`;
    await sql`UPDATE feeds SET next_run_at = now() WHERE id = ${notice.feed_id}`;
    await reconcileSourceFeedListeners(sql, device.id, [org.id], feeds.map(feed => Number(feed.id)));
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(2);
  });

  it('confirms idle bindings without defeating failed or interrupted setup recovery', async () => {
    const { sql, org, device, notice } = await subscribedFixture();
    const subscription = { ...referenceDelivery(), records: [] };
    for (const failures of [0, 1]) {
      await sql`UPDATE feeds SET consecutive_failures = ${failures},
        last_error = ${failures ? 'Synthetic setup failure' : null}, next_run_at = now() + interval '1 minute'
        WHERE id = ${notice.feed_id}`;
      await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
      expect((await sql`SELECT next_run_at IS NULL AS confirmed FROM feeds WHERE id = ${notice.feed_id}`)[0].confirmed).toBe(failures === 0);
    }
    for (const failures of [0, 2]) {
      // A late confirmation cannot cancel an already-due recovery attempt.
      await sql`UPDATE feeds SET consecutive_failures = ${failures}, last_error = NULL,
        next_run_at = now() - interval '1 minute' WHERE id = ${notice.feed_id}`;
      await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
      const [late] = await sql`SELECT next_run_at <= now() AS due, consecutive_failures
        FROM feeds WHERE id = ${notice.feed_id}`;
      expect(late).toEqual({ due: true, consecutive_failures: failures });
    }
    await reconcileSourceFeedListeners(sql, device.id, [org.id], [notice.feed_id]);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}
      AND action_input->'payload'->>'feedId' = ${String(notice.feed_id)}`).toHaveLength(1);
  });

  it('excludes foreign private feeds before resolving owners during reconciliation', async () => {
    const { sql, org, device, connection, automationId } = await subscribedFixture();
    const other = await createTestUser();
    await sql`UPDATE connections SET visibility = 'private', created_by = ${other.id} WHERE id = ${connection.id}`;
    await sql`UPDATE automations SET triggers = ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
      event_types: ['message.created'], execution: 'turn', active_run: 'queue', output: 'silent' }])} WHERE id = ${automationId}`;
    const resolveOwner = vi.spyOn(entityPolicy, 'resolveActingPrincipal');
    try {
      await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
      expect(resolveOwner).not.toHaveBeenCalled();
      expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id}`).toHaveLength(0);
    } finally {
      resolveOwner.mockRestore();
    }
  });

  it('skips subscription resolution when the device has no active connector subscriber', async () => {
    const { sql, org, device, automationId } = await subscribedFixture();
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    const resolveSubscriptions = vi.spyOn(subscriptions, 'sourceFeedSubscriptions');
    try {
      await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
      expect(resolveSubscriptions).not.toHaveBeenCalled();
      expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id}`).toHaveLength(0);
    } finally {
      resolveSubscriptions.mockRestore();
    }
  });

  it.each([
    { operations: ['read', 'sync'], mode: 'trigger' },
    { operations: ['read'], mode: 'store' },
    { operations: null, mode: 'trigger' },
    { operations: 'read', mode: 'trigger' },
    { operations: { read: true }, mode: 'trigger' },
  ])('uses source-only trigger eligibility for delegated reads: %j', async ({ operations, mode }) => {
    const { sql, org, notice } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({
      items: { operations, webhook: { mode, events: ['message.created'] } },
    })} WHERE organization_id = ${org.id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
  });

  it.each([null, 'message.created', { key: 'message.created' }])('rejects malformed feed event metadata without throwing: %j', async (events) => {
    const { sql, org, notice } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({
      items: { operations: ['read'], webhook: { mode: 'trigger', events } },
    })} WHERE organization_id = ${org.id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
  });

  it('does not listen to a feed when the Automation subscribes only to another connector event', async () => {
    const { sql, org, device, notice, automationId } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET automation_events = ${sql.json([
      { key: 'message.created', label: 'New message', resourceType: 'message' },
      { key: 'contact.changed', label: 'Changed contact', resourceType: 'contact' },
    ])} WHERE organization_id = ${org.id}`;
    await sql`UPDATE automations SET triggers = ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
      connection_id: notice.connection_id, event_types: ['contact.changed'], execution: 'turn',
      active_run: 'queue', output: 'silent' }])} WHERE id = ${automationId}`;
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
    await reconcileSourceFeedListeners(sql, device.id, [org.id], []);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_LISTENER_TASK}`).toHaveLength(0);
    expect((await receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]))[0].active).toBe(false);
  });

  it.each(['deny', 'approval'] as const)('revokes source subscriptions when organization policy requires %s', async (effect) => {
    const { sql, org, device, connection, notice, automationId } = await subscribedFixture();
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id, automationId)).toHaveLength(1);
    await entityPolicy.upsertEntityApprovalPolicy(org.id, { resourceClass: 'connector_action', connectionId: Number(connection.id),
      operationCategory: 'read', effects: { execute: effect } });
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id, automationId)).toEqual([]);
    expect((await receiveFeedNotifications(sql, [notice], device.id, [org.id]))[0].active).toBe(false);

    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id}`).toHaveLength(0);
  });

  it.each(['undeclared event', 'invalid timestamp', 'oversized delivery', 'too many events'])('revokes a binding with %s without advancing its checkpoint', async (invalid) => {
    const { sql, org, device, notice } = await subscribedFixture();
    const subscription = referenceDelivery();
    const events = subscription.records[0].payload.events;
    if (invalid === 'undeclared event') events.push({ id: 'bad', event_type: 'undeclared', resource_ref: 'bad' });
    if (invalid === 'invalid timestamp') Object.assign(events[0], { occurred_at: 'invalid' });
    if (invalid === 'oversized delivery') events[0].resource_ref = 'x'.repeat(256 * 1024);
    if (invalid === 'too many events') subscription.records[0].payload.events = Array(1001).fill(events[0]);
    const checkpoint = { cursor: { after: 0 } };
    await sql`UPDATE feeds SET checkpoint = ${sql.json(checkpoint)} WHERE id = ${notice.feed_id}`;
    const receipts = await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    expect(receipts).toEqual([expect.objectContaining({ feed_id: notice.feed_id, active: false })]);
    expect(receipts[0]).not.toHaveProperty('ack');
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toEqual(checkpoint);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id}`).toHaveLength(0);
    const [failed] = await sql`SELECT consecutive_failures, last_error,
      EXTRACT(EPOCH FROM next_run_at - now()) * 1000 AS retry_ms FROM feeds WHERE id = ${notice.feed_id}`;
    expect.soft(failed.consecutive_failures).toBe(1);
    expect.soft(failed.last_error).toBeTruthy();
    expect.soft(Number(failed.retry_ms)).toBeGreaterThan(feedBackoff.baseMs - 5000);
    await sql`UPDATE feeds SET consecutive_failures = 3, next_run_at = now() WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [{ ...notice, subscription }], device.id, [org.id]);
    const [repeated] = await sql`SELECT consecutive_failures,
      EXTRACT(EPOCH FROM next_run_at - now()) * 1000 AS retry_ms FROM feeds WHERE id = ${notice.feed_id}`;
    expect(repeated.consecutive_failures).toBe(4);
    expect(Number(repeated.retry_ms)).toBeGreaterThan(Math.min(feedBackoff.baseMs * 8, feedBackoff.maxMs) - 5000);
  });

  it('continues other bindings when one delivery is rejected', async () => {
    const { sql, org, device, notice, feeds } = await subscribedFixture();
    const invalid = referenceDelivery();
    invalid.records[0].payload.events[0].event_type = 'undeclared';
    const secondFeed = Number(feeds[1].id);
    const receipts = await receiveFeedNotifications(sql, [
      { ...notice, subscription: invalid },
      { ...notice, feed_id: secondFeed, subscription: referenceDelivery() },
    ], device.id, [org.id]);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ feed_id: notice.feed_id, active: false });
    expect(receipts[1]).toMatchObject({ feed_id: secondFeed, active: true });
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(1);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toBeNull();
  });

  it('retains a valid delivery after a database failure while other bindings progress', async () => {
    const { sql, org, device, notice, feeds } = await subscribedFixture();
    const queue = vi.spyOn(activation, 'queueAutomationActivations').mockRejectedValueOnce(new Error('Synthetic database failure'));
    try {
      const receipts = await receiveFeedNotifications(sql, [
        { ...notice, subscription: referenceDelivery() },
        { ...notice, feed_id: Number(feeds[1].id), subscription: referenceDelivery() },
      ], device.id, [org.id]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ feed_id: Number(feeds[1].id), active: true });
      expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toBeNull();
      expect((await receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]))[0].active).toBe(true);
      expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(1);
    } finally {
      queue.mockRestore();
    }
  });

  it('delivers the same source change once when configured feeds overlap', async () => {
    const { sql, org, device, feeds, notice } = await subscribedFixture();
    for (const feed of feeds) {
      expect((await receiveFeedNotifications(sql, [{ ...notice, feed_id: Number(feed.id), subscription: referenceDelivery() }], device.id, [org.id]))[0].active).toBe(true);
    }
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id} AND run_type = 'automation'`).toHaveLength(1);
  });

  it('binds observation authority to the subscribed principal and rejects foreign private connections', async () => {
    const { sql, org, user, device, connection, notice, automationId } = await subscribedFixture();
    await sql`UPDATE connections SET visibility = 'private', created_by = ${user.id} WHERE id = ${connection.id}`;
    const actor = await entityPolicy.resolveActingPrincipal(sql, { organizationId: org.id, sessionAutomationId: automationId });
    const [parent] = await sql`INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, action_key,
      status, approval_status, policy_principal_kind, policy_principal_id, created_by_user_id, automation_id, run_metadata, expires_at, connector_version)
      VALUES (${org.id}, 'action', ${notice.feed_id}, ${connection.id}, 'synthetic.source', ${DEVICE_FEED_READ_ACTION_KEY},
        'running', 'auto', ${actor.kind}, ${actor.id}, ${user.id}, ${automationId},
        ${sql.json({ [SOURCE_FEED_READ_METADATA_KEY]: true, [SOURCE_FEED_SUBSCRIPTION_METADATA_KEY]: true })}, now() + interval '1 minute', '1.0.0') RETURNING id`;
    expect(await resolveRunConnectorPolicy({ organizationId: org.id, runId: Number(parent.id), sql })).toMatchObject({ effect: 'auto' });
    expect(await sourceFeedContextForRun(sql, Number(parent.id), device.id, org.id)).toMatchObject({ feed_id: notice.feed_id });
    const other = await createTestUser();
    await sql`UPDATE connections SET created_by = ${other.id} WHERE id = ${connection.id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
    expect(await resolveRunConnectorPolicy({ organizationId: org.id, runId: Number(parent.id), sql })).toMatchObject({ effect: 'deny' });
    expect(await sourceFeedContextForRun(sql, Number(parent.id), device.id, org.id)).toBeUndefined();
  });

  it('uses the shared trigger mutation and targets a feed instance, not all copies of its feed key', async () => {
    const { sql, org, device, feeds, notice } = await fixture();
    const receipts = await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect(receipts[0].active).toBe(true);
    const rows = await sql`SELECT id, next_run_at <= now() AS due FROM feeds ORDER BY id`;
    expect(rows.map((row) => row.due)).toEqual([true, false]);
    await requestFeedSync(sql, sql`SELECT id FROM feeds WHERE id = ${feeds[1].id}`);
    expect((await sql`SELECT next_run_at <= now() AS due FROM feeds WHERE id = ${feeds[1].id}`)[0].due).toBe(true);
  });

  it('wakes a manual feed when its bound source reports a change', async () => {
    const { sql, org, device, notice } = await fixture();
    await sql`UPDATE feeds SET schedule = NULL, next_run_at = NULL WHERE id = ${notice.feed_id}`;
    const [receipt] = await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect(receipt.active).toBe(true);
    const [feed] = await sql`
      SELECT next_run_at <= now() AS due FROM feeds WHERE id = ${notice.feed_id}
    `;
    expect(feed.due).toBe(true);
  });

  it('rejects foreign organization, device, connection and inactive feed without moving schedules', async () => {
    const { sql, org, device, notice } = await fixture();
    const other = await createTestOrganization();
    expect((await receiveFeedNotifications(sql, [notice], device.id, [other.id]))[0].active).toBe(false);
    expect((await receiveFeedNotifications(sql, [notice], '00000000-0000-4000-8000-000000000099', [org.id]))[0].active).toBe(false);
    expect((await receiveFeedNotifications(sql, [{ ...notice, connection_id: 999999 }], device.id, [org.id]))[0].active).toBe(false);
    await sql`UPDATE feeds SET status = 'paused' WHERE id = ${notice.feed_id}`;
    expect((await receiveFeedNotifications(sql, [notice], device.id, [org.id]))[0].active).toBe(false);
    expect((await sql`SELECT next_run_at FROM feeds WHERE id = ${notice.feed_id}`)[0].next_run_at).toBeNull();
  });

  it('preserves failure backoff and delivers only saved checkpoint acknowledgments', async () => {
    const { sql, org, device, notice } = await fixture();
    const ack = { binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [{ id: 'source-1', revision: 3 }] };
    await sql`UPDATE feeds SET consecutive_failures = 2, checkpoint = ${sql.json({ source_ack: ack })} WHERE id = ${notice.feed_id}`;
    const [receipt] = await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect(receipt.ack).toEqual(ack);
    expect((await sql`SELECT next_run_at > now() + interval '50 minutes' AS backed_off FROM feeds WHERE id = ${notice.feed_id}`)[0].backed_off).toBe(true);
    await sql`UPDATE feeds SET consecutive_failures = 0 WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [{ ...notice, changed: false }], device.id, [org.id]);
    expect((await sql`SELECT next_run_at > now() AS future FROM feeds WHERE id = ${notice.feed_id}`)[0].future).toBe(true);
  });

  it('preserves both GitHub ingress selectors through the shared scheduling mutation', async () => {
    const { sql, org, connection, feeds } = await fixture();
    await sql`UPDATE connections SET config = ${sql.json({ installation_ref: 'synthetic-installation' })} WHERE id = ${connection.id}`;
    await sql`UPDATE feeds SET config = ${sql.json({ repo_owner: 'synthetic-owner', repo_name: 'synthetic-repo' })} WHERE id = ${feeds[0].id}`;
    const body = {
      sql, rawBody: new TextEncoder().encode(JSON.stringify({ repository: { owner: { login: 'Synthetic-Owner' }, name: 'Synthetic-Repo' } })),
      headers: new Headers({ 'x-github-event': 'changed' }),
    };
    const deliver = createGithubWebhookDelivery({ connectorKey: 'synthetic.source' });
    expect(await deliver({ ...body, install: { id: 'wrong-installation', organizationId: org.id, externalTenantId: 'synthetic-tenant' } })).toEqual({ triggered: false });
    expect(await deliver({ ...body, install: { id: 'synthetic-installation', organizationId: org.id, externalTenantId: 'synthetic-tenant' } })).toEqual({ triggered: true });
    expect((await sql`SELECT next_run_at <= now() AS due FROM feeds ORDER BY id`).map((row) => row.due)).toEqual([true, false]);
    await sql`UPDATE feeds SET next_run_at = now() + interval '1 hour' WHERE id = ${feeds[0].id}`;
    expect(await deliverGithubConnectorConnectionWebhook({ ...body, connectionId: Number(connection.id), organizationId: org.id, connectorKey: 'synthetic.source' })).toEqual({ triggered: true });
    expect((await sql`SELECT next_run_at <= now() AS due FROM feeds ORDER BY id`).map((row) => row.due)).toEqual([true, false]);
    expect(await deliverGithubConnectorConnectionWebhook({ ...body, connectionId: 999999, organizationId: org.id, connectorKey: 'synthetic.source' })).toEqual({ triggered: false });
  });

  it('derives source authority only from an active parent sync and fences dry runs', async () => {
    const { sql, org, device, connection, notice } = await fixture();
    const [run] = await sql`
      INSERT INTO runs (organization_id, run_type, feed_id, connection_id, status, claimed_by)
      VALUES (${org.id}, 'sync', ${notice.feed_id}, ${connection.id}, 'running', 'synthetic-source-worker') RETURNING id
    `;
    const ctx = await sourceFeedContextForRun(sql, Number(run.id), device.id, org.id);
    expect(ctx).toMatchObject({ feed_id: notice.feed_id, connection_id: notice.connection_id, dry_run: false });
    expect(await sourceFeedContextForRun(sql, null, device.id, org.id)).toBeUndefined();
    await sql`UPDATE runs SET dry_run = true WHERE id = ${run.id}`;
    await sql`UPDATE feeds SET status = 'paused' WHERE id = ${notice.feed_id}`;
    expect(await sourceFeedContextForRun(sql, Number(run.id), device.id, org.id)).toMatchObject({ dry_run: true, ack: null });
    await sql`UPDATE runs SET dry_run = false WHERE id = ${run.id}`;
    expect(await sourceFeedContextForRun(sql, Number(run.id), device.id, org.id)).toBeUndefined();
    await sql`UPDATE feeds SET status = 'active' WHERE id = ${notice.feed_id}`;
    await sql`
      UPDATE connector_definitions
      SET feeds_schema = ${sql.json({ items: { operations: [], webhook: { mode: 'trigger', events: ['changed'] } } })}
      WHERE organization_id = ${org.id} AND key = 'synthetic.source'
    `;
    expect(await sourceFeedContextForRun(sql, Number(run.id), device.id, org.id)).toBeUndefined();
    await sql`
      UPDATE connector_definitions
      SET feeds_schema = ${sql.json({ items: { operations: ['sync'], webhook: { mode: 'trigger', events: ['changed'] } } })}
      WHERE organization_id = ${org.id} AND key = 'synthetic.source'
    `;
    await sql`UPDATE runs SET status = 'completed' WHERE id = ${run.id}`;
    expect(await sourceFeedContextForRun(sql, Number(run.id), device.id, org.id)).toBeUndefined();
  });
});
