import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverConnectorWebhook } from '../../connectors/webhook-delivery';
import { receiveFeedNotifications, requestFeedSync, sourceFeedContextForRun } from '../../runs/feed-notifications';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser, createTestAccessToken, createTestOAuthClient } from '../setup/test-fixtures';
import { enqueueSourceFeedListener, reconcileSourceFeedListeners, runSourceFeedListener } from '../../runs/source-feed-listener';
import { sourceFeedScopeKey, sourceFeedSubscriptions } from '../../runs/source-feed-subscriptions';
import * as subscriptions from '../../runs/source-feed-subscriptions';
import * as activation from '../../automations/activation';
import { SOURCE_FEED_LISTENER_TASK } from '../../scheduled/task-definitions';
import { DEVICE_FEED_READ_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY, SOURCE_FEED_SUBSCRIPTION_METADATA_KEY, SOURCE_FEED_SCOPE_METADATA_KEY } from '../../lib/device-feed-read-protocol';
import { resolveRunConnectorPolicy } from '../../authz/operation-run-policy';
import * as entityPolicy from '../../authz/entity-policy';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import type { Env } from '../../index';
import type { ToolContext } from '../../tools/registry';
import { feedBackoff } from '../../connectors/feed-backoff';
import { getContent } from '../../tools/get_content';
import { AUTOMATION_RUN_SOURCE } from '../../gateway/automation-run-session';
import { verifyWindowToken } from '../../utils/jwt';
import { TestApiClient, TestMcpClient } from '../setup/test-mcp-client';
import { readAutomationChanges } from '../../tools/get_content/changes';
import { persistSourceReference } from '../../runs/source-reference-events';
import { handleListActivity } from '../../tools/admin/manage_operations/handlers/runs';

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

async function externalFixture() {
  const fixtureData = await subscribedFixture();
  const { sql, org, user, automationId, notice } = fixtureData;
  await sql`UPDATE automations SET managed_agent_id = NULL,
    execution_config = ${sql.json({ executor: { kind: 'external' } })},
    triggers = ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
      connection_id: notice.connection_id, event_types: ['message.created'], capture: 'references' }])}
    WHERE id = ${automationId}`;
  const ctx = { organizationId: org.id, userId: user.id, memberRole: 'owner',
    scopes: ['mcp:read'], tokenType: 'pat', clientId: null } as ToolContext;
  const env = { JWT_SECRET: 'synthetic-source-changes-secret' } as Env;
  const read = (cursor?: string, limit = 1, caller = ctx) => getContent({ automation_id: automationId,
    view: 'changes', ...(cursor ? { cursor } : {}), limit }, env, caller);
  const deliver = (id: string, after: number, resourceRef = 'source-1') => receiveFeedNotifications(sql, [{ ...notice,
    subscription: { ...referenceDelivery(), records: [{ revision: after, payload: {
      id: `batch-${after}`, events: [{ id, event_type: 'message.created', resource_ref: resourceRef }],
      checkpoint: { previous: after === 1 ? null : { after: after - 1 }, next: { after } },
    } }] },
  }], fixtureData.device.id, [org.id]);
  return { ...fixtureData, ctx, env, read, deliver };
}

describe('source feed notifications', () => {
  beforeEach(cleanupTestDatabase);

  it('creates the subscription through the SDK and polls it through authenticated MCP without creating a run', async () => {
    const { sql, org, user, device, notice, automationId } = await subscribedFixture();
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    const api = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner' });
    const created = await api.automations.create({ slug: 'synthetic-sdk-source', name: 'SDK source',
      execution_config: { executor: { kind: 'external' } },
      triggers: [{ kind: 'event', connector_key: 'synthetic.source', connection_id: notice.connection_id,
        event_types: ['message.created'], capture: 'references' }],
    }) as { automation_id: string };
    const client = await createTestOAuthClient();
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, { scope: 'mcp:read' });
    const mcp = new TestMcpClient({ token, orgSlug: org.slug });
    const beforeResponse = await mcp.querySdk<any>(`export default async (_ctx, client) => client.knowledge.read({automation_id:${Number(created.automation_id)},view:"changes"});`);
    expect(beforeResponse).toMatchObject({ success: true });
    const before = beforeResponse.return_value;
    expect(before.content).toEqual([]);
    await receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]);
    await sql`SELECT pg_sleep(0.003)`;
    const afterResponse = await mcp.querySdk<any>(`export default async (_ctx, client) => client.knowledge.read({automation_id:${Number(created.automation_id)},view:"changes",cursor:${JSON.stringify(before.resume_cursor)}});`);
    expect(afterResponse).toMatchObject({ success: true });
    const after = afterResponse.return_value;
    expect(after.content).toHaveLength(1);
    expect(after.content[0].metadata.observation_id).toBe('message-1');
    expect(after).not.toHaveProperty('window_token');
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(0);
  });

  it('keeps a late-committing observation ahead of the resume boundary', async () => {
    const { sql, org, user, notice, read } = await externalFixture();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const writer = sql.begin(async tx => {
      await persistSourceReference(tx, { organizationId: org.id, connectorKey: 'synthetic.source',
        notice: { ...notice, subscription: referenceDelivery() }, principal: user.id,
        event: { id: 'late-commit', event_type: 'message.created', resource_ref: 'synthetic-late' } });
      ready();
      await held;
    });
    let before: Awaited<ReturnType<typeof read>>;
    try {
      await entered;
      before = await read();
      expect(before.content).toEqual([]);
    } finally { release(); await writer; }
    await sql`SELECT pg_sleep(0.003)`;
    const after = await read(before!.resume_cursor);
    expect(after.content).toHaveLength(1);
    expect((after.content[0] as any).metadata.observation_id).toBe('late-commit');
  });

  it('rolls reference persistence and checkpoint back together on activation failure', async () => {
    const { sql, org, notice, deliver } = await externalFixture();
    const failure = vi.spyOn(activation, 'queueAutomationActivations').mockRejectedValueOnce(new Error('Synthetic capture failure'));
    try { expect(await deliver('retryable', 1)).toEqual([]); } finally { failure.mockRestore(); }
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${notice.feed_id}`)[0].checkpoint).toBeNull();
    expect((await deliver('retryable', 1))[0].active).toBe(true);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(1);
  });

  it('uses a bounded arrival index scan despite large unrelated source history', async () => {
    const { sql, org, connection, automationId, ctx, env, deliver } = await externalFixture();
    await deliver('visible', 1);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`INSERT INTO events (organization_id, connection_id, connector_key, origin_type, semantic_type, origin_id,
      payload_type, created_at) SELECT ${org.id}, ${connection.id}, 'synthetic.source', 'source_reference',
      'unrelated.changed', 'synthetic-history-' || n, 'empty', '2020-01-01'::timestamptz FROM generate_series(1, 20000) n`;
    await sql`ANALYZE events`;
    const spy = vi.spyOn(sql, 'unsafe');
    await readAutomationChanges(sql, { automation_id: automationId, view: 'changes', limit: 1 }, env, ctx);
    const call = spy.mock.calls.find(([query]) => query.includes('WITH sources AS MATERIALIZED'))!;
    spy.mockRestore();
    const [result] = await sql.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + call[0], call[1]);
    const plan = result['QUERY PLAN'][0].Plan;
    const nodes: any[] = [];
    const visit = (node: any) => { nodes.push(node); node.Plans?.forEach(visit); };
    visit(plan);
    const arrival = nodes.find(node => node['Index Name'] === 'idx_events_source_reference_arrival');
    expect(arrival).toBeTruthy();
    expect(arrival['Actual Rows']).toBeLessThanOrEqual(2);
    expect(arrival['Rows Removed by Filter'] ?? 0).toBe(0);
  });

  it('revokes divergent checkpoint branches without retaining their observations, then rebinds from committed progress', async () => {
    const { sql, org, notice, deliver } = await externalFixture();
    await deliver('accepted-first', 1);
    await deliver('accepted-second', 2);
    const [stale] = await deliver('unknown-old-branch', 2);
    expect(stale.active).toBe(false);
    expect(stale).not.toHaveProperty('ack');
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(2);
    const [feed] = await sql`SELECT checkpoint, last_error, next_run_at > now() AS deferred FROM feeds WHERE id = ${notice.feed_id}`;
    expect(feed.checkpoint.cursor).toEqual({ after: 2 });
    expect(feed.last_error).toContain('rebinding');
    expect(feed.deferred).toBe(true);
    expect((await deliver('resumed-third', 3))[0].active).toBe(true);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(3);
  });

  it('does not expose private or ACL-graphed arrival counts through pagination', async () => {
    const { sql, org, connection, deliver, read } = await externalFixture();
    for (let index = 1; index <= 4; index++) await deliver(`hidden-${index}`, index);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`UPDATE connections SET visibility = 'private', created_by = NULL WHERE id = ${connection.id}`;
    const privateRead = await read();
    expect(privateRead.content).toEqual([]);
    expect(privateRead.page.has_more).toBe(false);
    expect(privateRead.next_cursor).toBeUndefined();
    await sql`UPDATE connections SET visibility = 'org' WHERE id = ${connection.id}`;
    await sql`INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
      VALUES (${org.id}, ${String(connection.id)}, 'full', 'fresh', now())`;
    const graphedRead = await read();
    expect(graphedRead.content).toEqual([]);
    expect(graphedRead.page.has_more).toBe(false);
    expect(graphedRead.next_cursor).toBeUndefined();
  });

  it('continues reading retained history while its feed is paused but stops further capture', async () => {
    const { sql, org, automationId, deliver, read } = await externalFixture();
    await deliver('before-pause', 1);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`UPDATE feeds SET status = 'paused' WHERE organization_id = ${org.id}`;
    expect((await deliver('after-pause', 2))[0].active).toBe(false);
    expect((await read()).content).toHaveLength(1);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(1);
  });

  it('retains references with mixed managed/external subscribers and activates the managed subscriber once', async () => {
    const { sql, org, user, device, notice, automationId } = await subscribedFixture();
    const [sequence] = await sql`SELECT nextval('automations_id_seq') AS id`;
    const [external] = await sql`INSERT INTO automations
      (id, automation_group_id, organization_id, slug, name, status, created_by, execution_config, triggers)
      VALUES (${sequence.id}, ${sequence.id}, ${org.id}, 'synthetic-external-observer', 'External observer', 'active', ${user.id},
        ${sql.json({ executor: { kind: 'external' } })},
        ${sql.json([{ kind: 'event', connector_key: 'synthetic.source', event_types: ['message.created'], capture: 'references' }])}) RETURNING id`;
    const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
      VALUES (${external.id}, 1, 'External observer', 'Inspect references', ${user.id}) RETURNING id`;
    await sql`UPDATE automations SET current_version_id = ${version.id} WHERE id = ${external.id}`;
    const deliver = () => receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]);
    await deliver();
    await deliver();
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id} AND origin_type = 'source_reference'`).toHaveLength(1);
    const runs = await sql`SELECT automation_id FROM runs WHERE run_type = 'automation'`;
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].automation_id)).toBe(automationId);
    expect(Number(runs[0].automation_id)).not.toBe(Number(external.id));
  });

  it('retains repeated transitions immutably, suppresses stale replay and serializes concurrent deliveries', async () => {
    const { sql, org, deliver } = await externalFixture();
    await Promise.all([deliver('A-1', 1), deliver('A-1', 1)]);
    await deliver('B-2', 2);
    await deliver('A-3', 3);
    await deliver('B-4', 4);
    await deliver('A-1', 1);
    const rows = await sql`SELECT supersedes_event_id, metadata FROM events WHERE organization_id = ${org.id} ORDER BY id`;
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.supersedes_event_id === null)).toBe(true);
    expect(rows.map(row => row.metadata.observation_id)).toEqual(['A-1', 'B-2', 'A-3', 'B-4']);
    expect((await sql`SELECT checkpoint FROM feeds ORDER BY id LIMIT 1`)[0].checkpoint.cursor).toEqual({ after: 4 });
  });

  it('does not acknowledge or advance progress when an observation identity changes its resource', async () => {
    const { sql, org, deliver } = await externalFixture();
    await deliver('immutable-message', 1);
    expect(await deliver('immutable-message', 2, 'different-resource')).toEqual([]);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(1);
    expect((await sql`SELECT checkpoint FROM feeds ORDER BY id LIMIT 1`)[0].checkpoint.cursor).toEqual({ after: 1 });
  });

  it('deduplicates immutable message references across overlapping feeds on the same connection', async () => {
    const { sql, org, device, notice, feeds } = await externalFixture();
    await sql`UPDATE feeds SET config = '{"syntheticScope":"overlap"}'::jsonb WHERE id = ${feeds[1].id}`;
    const receipts = await Promise.all(feeds.map((feed, index) => receiveFeedNotifications(sql, [{ ...notice, feed_id: Number(feed.id),
      subscription: { ...referenceDelivery(), scope_key: sourceFeedScopeKey(index ? { syntheticScope: 'overlap' } : {}, '1.0.0') } }], device.id, [org.id])));
    expect(receipts.every(([receipt]) => receipt.active)).toBe(true);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(1);
  });

  it.each(['connector', 'connection', 'event'])('preserves legacy observers when capture targets an unrelated %s', async (target) => {
    const { sql, org, automationId, notice, feeds, device } = await subscribedFixture();
    const [automation] = await sql`SELECT triggers FROM automations WHERE id = ${automationId}`;
    await sql`UPDATE automations SET triggers = ${sql.json([...automation.triggers, {
      kind: 'event', connector_key: target === 'connector' ? 'synthetic.other' : 'synthetic.source',
      connection_id: target === 'connection' ? notice.connection_id + 1 : notice.connection_id,
      event_types: [target === 'event' ? 'other.changed' : 'message.created'], capture: 'references',
    }])} WHERE id = ${automationId}`;
    for (const feed of feeds) expect(await sourceFeedSubscriptions(sql, org.id, Number(feed.id))).toHaveLength(1);
    const delivery = { ...notice, subscription: referenceDelivery() };
    await receiveFeedNotifications(sql, [delivery], device.id, [org.id]);
    const [replayed] = await receiveFeedNotifications(sql, [delivery], device.id, [org.id]);
    expect(replayed.active).toBe(true);
    expect(replayed.ack).toBeDefined();
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(1);
  });

  it('does not let a denied capture subscription alter authorized legacy observer selection', async () => {
    const { sql, org, user, automationId, feeds } = await subscribedFixture();
    const [{ id }] = await sql`SELECT nextval('automations_id_seq') AS id`;
    await sql`INSERT INTO automations (id, automation_group_id, organization_id, slug, name, status, created_by, execution_config, triggers)
      SELECT ${id}, ${id}, organization_id, 'synthetic-denied-capture', 'Denied capture', 'active', created_by,
        '{"executor":{"kind":"external"}}'::jsonb, jsonb_set(triggers, '{0,capture}', '"references"'::jsonb)
      FROM automations WHERE id = ${automationId}`;
    const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
      VALUES (${id}, 1, 'Denied capture', 'Inspect references', ${user.id}) RETURNING id`;
    await sql`UPDATE automations SET current_version_id = ${version.id} WHERE id = ${id}`;
    const principal = await entityPolicy.resolveActingPrincipal(sql, { organizationId: org.id, sessionAutomationId: Number(id) });
    await entityPolicy.upsertEntityApprovalPolicy(org.id, { resourceClass: 'connector_action', connectorKey: 'synthetic.source',
      operationCategory: 'read', principalKind: 'automation', principalId: principal.id, effects: { execute: 'deny' } });
    for (const feed of feeds) {
      const subscriptions = await sourceFeedSubscriptions(sql, org.id, Number(feed.id));
      expect(subscriptions.map(subscription => subscription.automationId)).toEqual([automationId]);
    }
  });

  it('canonicalizes equivalent resolved versions and separates them after a connector upgrade', async () => {
    const { sql, org, feeds } = await externalFixture();
    await sql`UPDATE feeds SET pinned_version = '1.0.0' WHERE id = ${feeds[1].id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[1].id))).toHaveLength(0);
    await sql`UPDATE connector_definitions SET status = 'archived' WHERE organization_id = ${org.id}`;
    await sql`INSERT INTO connector_definitions (organization_id, key, name, version, status, feeds_schema, auth_schema, automation_events)
      SELECT organization_id, key, name, '2.0.0', 'active', feeds_schema, auth_schema, automation_events
      FROM connector_definitions WHERE organization_id = ${org.id} AND version = '1.0.0'`;
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[0].id))).toHaveLength(1);
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[1].id))).toHaveLength(1);
    await sql`UPDATE feeds SET pinned_version = '2.0.0' WHERE id = ${feeds[1].id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[1].id))).toHaveLength(0);
  });

  it('shares one observer for identical feeds and permits failover when it pauses', async () => {
    const { sql, org, feeds } = await externalFixture();
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[0].id))).toHaveLength(1);
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[1].id))).toHaveLength(0);
    await sql`UPDATE feeds SET status = 'paused' WHERE id = ${feeds[0].id}`;
    expect(await sourceFeedSubscriptions(sql, org.id, Number(feeds[1].id))).toHaveLength(1);
  });

  it('restarts history when a source becomes readable instead of skipping it behind a cursor', async () => {
    const { sql, org, connection, read, deliver } = await externalFixture();
    await deliver('historical', 1);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`UPDATE connections SET visibility = 'private', created_by = NULL WHERE id = ${connection.id}`;
    const hidden = await read();
    expect(hidden.content).toEqual([]);
    await sql`UPDATE connections SET visibility = 'org' WHERE id = ${connection.id}`;
    await expect(read(hidden.resume_cursor)).rejects.toThrow(/scope/);
    expect((await read()).content).toHaveLength(1);
  });

  it('uses the verified Automation author for its private source and rejects a foreign Automation', async () => {
    const { sql, org, user, connection, automationId, ctx, env, read, deliver } = await externalFixture();
    await deliver('private', 1);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`UPDATE connections SET visibility = 'private', created_by = ${user.id} WHERE id = ${connection.id}`;
    const other = await createTestUser();
    await addUserToOrganization(other.id, org.id, 'admin');
    const runContext = { ...ctx, userId: other.id, actingAutomationId: automationId,
      sourceContext: { source: AUTOMATION_RUN_SOURCE, conversationId: `synthetic_automation_${automationId}_run_99` } } as ToolContext;
    expect((await read(undefined, 1, { ...ctx, userId: other.id })).content).toEqual([]);
    const own = await read(undefined, 1, runContext);
    expect(own.content).toHaveLength(1);
    await expect(read(own.resume_cursor)).rejects.toThrow(/scope/);
    await expect(getContent({ automation_id: automationId + 1, view: 'changes' }, env, runContext)).rejects.toThrow(/own automation_id/);
  });

  it('revokes a stale branch whose unknown reference no longer matches capture consent', async () => {
    const { sql, org, automationId, deliver } = await externalFixture();
    await deliver('accepted', 1, 'wanted');
    await deliver('second', 2, 'wanted');
    await sql`UPDATE automations SET triggers = jsonb_set(triggers, '{0,match}', '{"resource_ref":"wanted"}'::jsonb)
      WHERE id = ${automationId}`;
    const [receipt] = await deliver('unknown-filtered', 2, 'other');
    expect(receipt.active).toBe(false);
    expect(receipt).not.toHaveProperty('ack');
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(2);
  });

  it('excludes stamped or body-bearing rows and projects only reference metadata', async () => {
    const { sql, org, read, deliver } = await externalFixture();
    await deliver('valid', 1);
    await deliver('stamped', 2);
    await deliver('body', 3);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz,
      metadata = metadata || '{"syntheticSecret":"hidden"}'::jsonb WHERE organization_id = ${org.id}`;
    await sql`UPDATE events SET entity_ids = ARRAY[123456789]::bigint[] WHERE metadata->>'observation_id' = 'stamped'`;
    await sql`UPDATE events SET payload_type = 'text' WHERE metadata->>'observation_id' = 'body'`;
    const result = await read(undefined, 10);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).metadata.observation_id).toBe('valid');
    expect((result.content[0] as any).metadata).not.toHaveProperty('syntheticSecret');
    expect(result.page.has_more).toBe(false);
  });

  it('paginates sub-millisecond arrivals without repetitions and excludes arrivals beyond a pinned boundary', async () => {
    const { sql, org, read, deliver, env } = await externalFixture();
    await deliver('one', 1);
    await deliver('two', 2);
    await sql`UPDATE events SET created_at = '2020-01-01 00:00:00.000123+00'::timestamptz
      + (id % 100)::int * interval '1 microsecond' WHERE organization_id = ${org.id}`;
    const first = await read();
    expect(first.content).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    await expect(verifyWindowToken(first.next_cursor!, env)).rejects.toThrow();
    await deliver('three', 3);
    const second = await read(first.next_cursor);
    expect(second.content).toHaveLength(1);
    expect((second.content[0] as any).id).not.toBe((first.content[0] as any).id);
    expect(second.page.has_more).toBe(false);
    await sql`SELECT pg_sleep(0.003)`;
    const third = await read(second.resume_cursor);
    expect(third.content).toHaveLength(1);
    expect((third.content[0] as any).metadata.observation_id).toBe('three');
    expect((third.content[0] as any).metadata.source_occurred_at).toBeNull();
  });

  it('advances bounded empty pages through sparse matches and rechecks private access between pages', async () => {
    const { sql, org, automationId, connection, read, deliver } = await externalFixture();
    for (let index = 1; index <= 6; index++) await deliver(`message-${index}`, index, index === 6 ? 'wanted' : 'other');
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz WHERE organization_id = ${org.id}`;
    await sql`UPDATE automations SET triggers = jsonb_set(triggers, '{0,match}', '{"resource_ref":"wanted"}'::jsonb)
      WHERE id = ${automationId}`;
    const first = await read(undefined, 2);
    expect(first.content).toHaveLength(0);
    expect(first.page.has_more).toBe(true);
    const second = await read(first.next_cursor, 2);
    expect(second.content).toHaveLength(0);
    expect(second.page.has_more).toBe(true);
    await sql`UPDATE connections SET visibility = 'private', created_by = NULL WHERE id = ${connection.id}`;
    await expect(read(second.next_cursor, 2)).rejects.toThrow(/scope/);
    expect((await read()).content).toEqual([]);
  });

  it('invalidates changed/deleted subscription cursors and rejects incompatible read arguments', async () => {
    const { sql, automationId, read, deliver, ctx, env } = await externalFixture();
    await deliver('one', 1);
    await deliver('two', 2);
    await sql`UPDATE events SET created_at = '2020-01-01'::timestamptz`;
    const first = await read();
    await expect(read(first.next_cursor, 1, { ...ctx, clientId: 'synthetic-other-client' })).rejects.toThrow(/scope/);
    await expect(read(first.next_cursor!.slice(0, -4) + 'AAAA')).rejects.toThrow(/cursor/);
    await expect(getContent({ automation_id: automationId, view: 'changes', run_id: 123 }, env, ctx)).rejects.toThrow(/only/);
    await sql`UPDATE automations SET current_version_id = NULL WHERE id = ${automationId}`;
    await expect(read(first.next_cursor)).rejects.toThrow(/configuration/);
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    await expect(read()).rejects.toThrow(/deleted/);
  });

  it('discovers source subscriptions without claiming work or presenting a shared unread count', async () => {
    const { sql, ctx, automationId } = await externalFixture();
    const result = await handleListActivity({ action: 'list_activity', kinds: ['source_changes'] }, ctx);
    expect(result).toMatchObject({ items: [{ kind: 'source_changes', status: 'available',
      next_action: { method: 'knowledge.read', input: { automation_id: automationId, view: 'changes' } } }] });
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(0);
  });

  it('captures external subscriptions without executions and lets independent clients resume changes', async () => {
    const { sql, org, user, device, notice, automationId } = await subscribedFixture();
    await sql`UPDATE automations SET managed_agent_id = NULL,
      execution_config = ${sql.json({ executor: { kind: 'external' } })},
      triggers = ${sql.json([{ kind: 'event', connector_key: 'synthetic.source',
        connection_id: notice.connection_id, event_types: ['message.created'], capture: 'references' }])}
      WHERE id = ${automationId}`;
    const delivery = referenceDelivery();
    const [receipt] = await receiveFeedNotifications(sql, [{ ...notice, subscription: delivery }], device.id, [org.id]);
    expect(receipt.active).toBe(true);
    expect(receipt.ack).toBeTruthy();
    const rows = await sql`SELECT id, metadata FROM events WHERE organization_id = ${org.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ resource_ref: 'source-1' });
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(0);
    const context = { organizationId: org.id, userId: user.id, memberRole: 'owner',
      scopes: ['mcp:read'], tokenType: 'pat', clientId: null } as ToolContext;
    const env = { JWT_SECRET: 'synthetic-source-changes-secret' } as Env;
    const read = (cursor?: string) => getContent({ automation_id: automationId, view: 'changes',
      ...(cursor ? { cursor } : {}), limit: 1 }, env, context);
    const first = await read();
    const independent = await read();
    expect(first.content.map((item: any) => item.id)).toEqual(independent.content.map((item: any) => item.id));
    expect(first.content).toHaveLength(1);
    expect(first).not.toHaveProperty('window_token');
    expect(first.resume_cursor).toBeTruthy();
    await receiveFeedNotifications(sql, [{ ...notice, subscription: delivery }], device.id, [org.id]);
    expect((await read(first.resume_cursor)).content).toHaveLength(0);
    expect(await sql`SELECT id FROM runs WHERE run_type = 'automation'`).toHaveLength(0);
  });

  it('requires explicit capture consent for an external source observer', async () => {
    const { sql, org, device, notice, automationId } = await subscribedFixture();
    await sql`UPDATE automations SET managed_agent_id = NULL,
      execution_config = ${sql.json({ executor: { kind: 'external' } })} WHERE id = ${automationId}`;
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
    expect((await receiveFeedNotifications(sql, [{ ...notice, subscription: referenceDelivery() }], device.id, [org.id]))[0].active).toBe(false);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
  });

  it.each(['setup', 'reconciliation'])('backs off %s when subscription lookup fails before browser dispatch', async (stage) => {
    const { sql, notice, task, org, device } = await subscribedFixture();
    await sql`UPDATE feeds SET status = 'paused' WHERE organization_id = ${org.id} AND id <> ${notice.feed_id}`;
    const lookup = vi.spyOn(subscriptions, 'sourceFeedSubscriptions').mockRejectedValueOnce(new Error('Synthetic lookup failure'));
    try {
      const operation = stage === 'setup' ? runSourceFeedListener(task)
        : reconcileSourceFeedListeners(sql, device.id, [org.id], []);
      await expect(operation).rejects.toThrow('Synthetic lookup failure');
      const [feed] = await sql`SELECT consecutive_failures, last_error, next_run_at > now() AS deferred
        FROM feeds WHERE id = ${notice.feed_id}`;
      expect(feed).toMatchObject({ consecutive_failures: 1, deferred: true });
      expect(feed.last_error).toBeTruthy();
    } finally {
      lookup.mockRestore();
    }
  });

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
    { operations: ['read'], mode: 'trigger', kind: 'record' },
    { operations: null, mode: 'trigger' },
    { operations: 'read', mode: 'trigger' },
    { operations: { read: true }, mode: 'trigger' },
  ])('uses source-only trigger eligibility for delegated reads: %j', async ({ operations, mode, kind }) => {
    const { sql, org, notice } = await subscribedFixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({
      items: { operations, webhook: { mode, kind, events: ['message.created'] } },
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
        ${sql.json({ [SOURCE_FEED_READ_METADATA_KEY]: true, [SOURCE_FEED_SUBSCRIPTION_METADATA_KEY]: true,
          [SOURCE_FEED_SCOPE_METADATA_KEY]: sourceFeedScopeKey({}, '1.0.0') })}, now() + interval '1 minute', '1.0.0') RETURNING id`;
    expect(await resolveRunConnectorPolicy({ organizationId: org.id, runId: Number(parent.id), sql })).toMatchObject({ effect: 'auto' });
    expect(await sourceFeedContextForRun(sql, Number(parent.id), device.id, org.id)).toMatchObject({ feed_id: notice.feed_id });
    await sql`UPDATE runs SET run_metadata = run_metadata - ${SOURCE_FEED_SCOPE_METADATA_KEY} WHERE id = ${parent.id}`;
    expect(await sourceFeedContextForRun(sql, Number(parent.id), device.id, org.id)).toBeUndefined();
    await sql`UPDATE runs SET run_metadata = run_metadata || ${sql.json({
      [SOURCE_FEED_SCOPE_METADATA_KEY]: sourceFeedScopeKey({}, '1.0.0'),
    })}::jsonb WHERE id = ${parent.id}`;
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

  it('routes installation and registered-connection deliveries through the shared scheduling mutation', async () => {
    const { sql, org, connection, feeds } = await fixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: { operations: ['sync'], webhook: { events: ['changed'], match: { fields: { owner: 'source.owner', name: 'source.name' }, caseInsensitive: true } } } })} WHERE organization_id = ${org.id}`;
    await sql`UPDATE connections SET config = ${sql.json({ installation_ref: 'synthetic-installation' })} WHERE id = ${connection.id}`;
    await sql`UPDATE feeds SET config = ${sql.json({ owner: 'synthetic-owner', name: 'synthetic-repo' })} WHERE id = ${feeds[0].id}`;
    const enqueueRecord = vi.fn(async () => undefined);
    const deliver = (scope: { installationRef: string } | { connectionId: number }) => deliverConnectorWebhook({
      sql, rawBody: new TextEncoder().encode(JSON.stringify({ source: { owner: 'Synthetic-Owner', name: 'Synthetic-Repo' } })),
      headers: new Headers({ 'x-source-event': 'changed' }), eventType: { header: 'x-source-event' },
      organizationId: org.id, connectorKey: 'synthetic.source', scope, enqueueRecord,
    });
    expect(await deliver({ installationRef: 'wrong-installation' })).toEqual({ triggered: false });
    expect(await deliver({ installationRef: 'synthetic-installation' })).toEqual({ triggered: true });
    expect((await sql`SELECT next_run_at <= now() AS due FROM feeds ORDER BY id`).map((row) => row.due)).toEqual([true, false]);
    await sql`UPDATE feeds SET next_run_at = now() + interval '1 hour' WHERE id = ${feeds[0].id}`;
    expect(await deliver({ connectionId: Number(connection.id) })).toEqual({ triggered: true });
    expect((await sql`SELECT next_run_at <= now() AS due FROM feeds ORDER BY id`).map((row) => row.due)).toEqual([true, false]);
    expect(await deliver({ connectionId: 999999 })).toEqual({ triggered: false });
    expect(enqueueRecord).not.toHaveBeenCalled();
  });

  it('records provider deliveries without accepting device invalidations for the same feed', async () => {
    const { sql, org, connection, device, notice } = await fixture();
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: {
      operations: ['sync'], webhook: { kind: 'record', events: ['changed'] },
    } })} WHERE organization_id = ${org.id}`;
    expect((await receiveFeedNotifications(sql, [notice], device.id, [org.id]))[0].active).toBe(false);

    // Keeping the legacy device opt-out must not disable provider records.
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: {
      operations: ['sync'], webhook: { kind: 'record', mode: 'store', events: ['changed'] },
    } })} WHERE organization_id = ${org.id}`;
    const enqueueRecord = vi.fn(async () => undefined);
    expect(await deliverConnectorWebhook({
      sql, rawBody: new TextEncoder().encode('{}'), headers: new Headers({ 'x-event': 'changed' }),
      eventType: { header: 'x-event' }, organizationId: org.id, connectorKey: 'synthetic.source',
      scope: { connectionId: Number(connection.id) }, enqueueRecord,
    })).toEqual({ triggered: true });
    expect(enqueueRecord).toHaveBeenCalledTimes(2);
    expect((await sql`SELECT next_run_at > now() AS future FROM feeds WHERE organization_id = ${org.id}`)
      .every(row => row.future)).toBe(true);
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
