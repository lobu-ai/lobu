import { beforeEach, describe, expect, it } from 'vitest';
import { createGithubWebhookDelivery, deliverGithubConnectorConnectionWebhook } from '../../gateway/routes/public/app-webhooks';
import { receiveFeedNotifications, requestFeedSync, sourceFeedContextForRun } from '../../runs/feed-notifications';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser } from '../setup/test-fixtures';
import { commitSourceFeedObservation, reconcileSourceFeedObservations } from '../../runs/source-feed-observation';
import { sourceFeedSubscriptions } from '../../runs/source-feed-subscriptions';
import { SOURCE_FEED_OBSERVATION_TASK } from '../../scheduled/task-definitions';
import { SOURCE_FEED_OBSERVE_ACTION_KEY, SOURCE_FEED_READ_METADATA_KEY } from '../../lib/device-feed-read-protocol';
import { resolveRunConnectorPolicy } from '../../authz/operation-run-policy';
import { resolveActingPrincipal } from '../../authz/entity-policy';

async function fixture() {
  const sql = getTestDb();
  const org = await createTestOrganization();
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id);
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

async function observedFixture() {
  const fixtureData = await fixture();
  const { sql, org, user, connection, notice } = fixtureData;
  await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({ items: { operations: ['read', 'observe'] } })},
    automation_events = ${sql.json([{ key: 'message.created', label: 'New message', resourceType: 'message' }])}
    WHERE organization_id = ${org.id}`;
  await sql`UPDATE feeds SET schedule = NULL, next_run_at = NULL`;
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

describe('source feed notifications', () => {
  beforeEach(cleanupTestDatabase);

  it('starts observation only for active subscriptions, dedupes wakes, and revokes the binding on pause', async () => {
    const { sql, org, device, notice, automationId } = await observedFixture();
    await reconcileSourceFeedObservations(sql, device.id, [org.id], []);
    const initial = await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_OBSERVATION_TASK}`;
    expect(initial).toHaveLength(2); // Two explicitly configured feed instances.
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    await reconcileSourceFeedObservations(sql, device.id, [org.id], []);
    expect(await sql`SELECT id FROM runs WHERE action_key = ${SOURCE_FEED_OBSERVATION_TASK}`).toHaveLength(2);
    expect((await sql`SELECT schedule, next_run_at FROM feeds`).every(feed => feed.schedule === null && feed.next_run_at === null)).toBe(true);
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automationId}`;
    expect((await receiveFeedNotifications(sql, [notice], device.id, [org.id]))[0].active).toBe(false);
    expect(await sourceFeedSubscriptions(sql, org.id, notice.feed_id)).toEqual([]);
  });

  it('atomically queues references and acks with no content events, and replay creates no duplicate Automation run', async () => {
    const { sql, org, device, notice, task } = await observedFixture();
    const ack = { binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [{ id: 'source-42', revision: 1 }] };
    const result = { changes: [{ event_type: 'message.created', resource_ref: 'source-42', resource_type: 'message', delivery_id: 'change-42' }],
      checkpoint: { cursor: 'next', source_ack: ack } };
    expect(await commitSourceFeedObservation(sql, task, null, result)).toBe(true);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${org.id}`).toHaveLength(0);
    const runs = await sql`SELECT id, approved_input FROM runs WHERE organization_id = ${org.id} AND automation_id IS NOT NULL`;
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs[0].approved_input)).toContain('source-42');
    expect(await commitSourceFeedObservation(sql, task, null, result)).toBe(false);
    expect(await commitSourceFeedObservation(sql, task, result.checkpoint, result)).toBe(true);
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id} AND automation_id IS NOT NULL`).toHaveLength(1);
    expect((await receiveFeedNotifications(sql, [{ ...notice, changed: false }], device.id, [org.id]))[0].ack).toEqual(ack);
  });

  it('rolls back the whole batch on an undeclared event and retains the prior checkpoint', async () => {
    const { sql, task } = await observedFixture();
    await expect(commitSourceFeedObservation(sql, task, null, {
      changes: [
        { event_type: 'message.created', resource_ref: 'source-1', delivery_id: 'change-1' },
        { event_type: 'undeclared', resource_ref: 'source-2', delivery_id: 'change-2' },
      ], checkpoint: { cursor: 'must-not-commit' },
    })).rejects.toThrow('undeclared Automation event');
    expect((await sql`SELECT checkpoint FROM feeds WHERE id = ${task.feedId}`)[0].checkpoint).toBeNull();
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${task.organizationId}`).toHaveLength(0);
  });

  it('delivers the same source change once when configured feeds overlap', async () => {
    const { sql, org, feeds } = await observedFixture();
    const result = { changes: [{ event_type: 'message.created', resource_ref: 'source-42', delivery_id: 'change-42' }], checkpoint: { cursor: 'next' } };
    for (const feed of feeds) {
      expect(await commitSourceFeedObservation(sql, { organizationId: org.id, feedId: Number(feed.id) }, null, result)).toBe(true);
    }
    expect(await sql`SELECT id FROM runs WHERE organization_id = ${org.id} AND run_type = 'automation'`).toHaveLength(1);
  });

  it('binds observation authority to the subscribed principal and rejects foreign private connections', async () => {
    const { sql, org, user, device, connection, notice, automationId } = await observedFixture();
    await sql`UPDATE connections SET visibility = 'private', created_by = ${user.id} WHERE id = ${connection.id}`;
    const actor = await resolveActingPrincipal(sql, { organizationId: org.id, sessionAutomationId: automationId });
    const [parent] = await sql`INSERT INTO runs (organization_id, run_type, feed_id, connection_id, connector_key, action_key,
      status, approval_status, policy_principal_kind, policy_principal_id, created_by_user_id, automation_id, run_metadata, expires_at)
      VALUES (${org.id}, 'action', ${notice.feed_id}, ${connection.id}, 'synthetic.source', ${SOURCE_FEED_OBSERVE_ACTION_KEY},
        'running', 'auto', ${actor.kind}, ${actor.id}, ${user.id}, ${automationId},
        ${sql.json({ [SOURCE_FEED_READ_METADATA_KEY]: true })}, now() + interval '1 minute') RETURNING id`;
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
