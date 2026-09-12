import { beforeEach, describe, expect, it } from 'vitest';
import { createGithubWebhookDelivery, deliverGithubConnectorConnectionWebhook } from '../../gateway/routes/public/app-webhooks';
import { receiveFeedNotifications, requestFeedSync, sourceFeedContextForRun } from '../../runs/feed-notifications';
import { reapStaleRuns } from '../../scheduled/check-stalled-executions';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser, createTestConnectorDefinition } from '../setup/test-fixtures';

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
  await createTestConnectorDefinition({
    key: 'synthetic.source', name: 'Source', organization_id: org.id,
    feeds_schema: { items: { operations: ['sync'], webhook: { mode: 'trigger', events: ['changed'] } } },
    auth_schema: { methods: [] },
  });
  const feeds = await sql`
    INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
    VALUES (${org.id}, ${connection.id}, 'items', 'active', '* * * * *', now() + interval '1 hour'),
           (${org.id}, ${connection.id}, 'items', 'active', '* * * * *', now() + interval '1 hour') RETURNING id
  `;
  const notice = {
    feed_id: Number(feeds[0].id), connection_id: Number(connection.id), feed_key: 'items',
    notification_id: 'synthetic-notification', changed: true,
  };
  return { sql, org, device, connection, feeds, notice };
}

describe('source feed notifications', () => {
  beforeEach(cleanupTestDatabase);

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


describe('buffered delivery admission through existing sync runs', () => {
  beforeEach(cleanupTestDatabase);

  async function deliveryFixture() {
    const value = await fixture();
    const { sql, org, notice } = value;
    await sql`UPDATE feeds SET schedule = NULL, next_run_at = NULL WHERE id = ${notice.feed_id}`;
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({
      items: { operations: ['delivery'], webhook: { events: ['records'] } },
    })} WHERE organization_id = ${org.id} AND key = 'synthetic.source'`;
    return { ...value, notice: { ...notice, batch: {
      binding_id: 'synthetic-binding', epoch: 'synthetic-epoch', records: [
        { revision: 1, payload: { id: 'one', body: 'first message' } },
        { revision: 2, payload: { id: 'two', body: 'second message' } },
      ],
    } } };
  }

  it('persists a whole batch in one run and retains the immutable snapshot during concurrent arrivals', async () => {
    const { sql, org, device, notice } = await deliveryFixture();
    const first = await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect(first[0]).toMatchObject({ active: true, ack: null });
    const [run] = await sql`SELECT id, action_input FROM runs WHERE feed_id = ${notice.feed_id}`;
    expect(run.action_input.delivery.payload).toEqual(notice.batch);
    const more = { ...notice, notification_id: 'synthetic-next', batch: {
      ...notice.batch, records: [...notice.batch.records, { revision: 3, payload: { id: 'three' } }],
    } };
    await Promise.all([
      receiveFeedNotifications(sql, [more], device.id, [org.id]),
      receiveFeedNotifications(sql, [more], device.id, [org.id]),
    ]);
    expect((await sql`SELECT id FROM runs WHERE feed_id = ${notice.feed_id}`)).toHaveLength(1);
    expect((await sql`SELECT action_input FROM runs WHERE id = ${run.id}`)[0].action_input.delivery.payload).toEqual(notice.batch);
    expect((await sql`SELECT schedule, next_run_at FROM feeds WHERE id = ${notice.feed_id}`)[0])
      .toMatchObject({ schedule: null, next_run_at: null });
    await sql`UPDATE runs SET status = 'running', claimed_at = now() - interval '1 day',
      last_heartbeat_at = now() - interval '1 day' WHERE id = ${run.id}`;
    expect((await reapStaleRuns()).retriesCreated).toBe(1);
    const [retry] = await sql`SELECT action_input FROM runs WHERE feed_id = ${notice.feed_id} AND status = 'pending'`;
    expect(retry.action_input).toEqual(run.action_input);
  });

  it('admits the remainder after completion without replaying acknowledged revisions or creating idle runs', async () => {
    const { sql, org, device, notice } = await deliveryFixture();
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    const ack = { ...notice.batch, records: notice.batch.records.map((row) => ({ id: row.payload.id, revision: row.revision })) };
    await sql`UPDATE runs SET status = 'completed' WHERE feed_id = ${notice.feed_id}`;
    await sql`UPDATE feeds SET checkpoint = ${sql.json({ source_ack: ack })} WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect((await sql`SELECT id FROM runs WHERE feed_id = ${notice.feed_id}`)).toHaveLength(1);
    const more = { ...notice, notification_id: 'synthetic-third', batch: {
      ...notice.batch, records: [...notice.batch.records, { revision: 3, payload: { id: 'three', body: 'third message' } }],
    } };
    const [receipt] = await receiveFeedNotifications(sql, [more], device.id, [org.id]);
    expect(receipt.ack).toEqual(ack);
    const pending = await sql`SELECT action_input FROM runs WHERE feed_id = ${notice.feed_id} AND status = 'pending'`;
    expect(pending).toHaveLength(1);
    expect(pending[0].action_input.delivery.payload.records).toEqual([{ revision: 3, payload: { id: 'three', body: 'third message' } }]);
  });

  it('preserves source failure backoff and rejects foreign scope before admitting payloads', async () => {
    const { sql, org, device, notice } = await deliveryFixture();
    const other = await createTestOrganization();
    expect((await receiveFeedNotifications(sql, [notice], device.id, [other.id]))[0].active).toBe(false);
    await sql`UPDATE feeds SET consecutive_failures = 2, last_sync_at = now() WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect((await sql`SELECT id FROM runs WHERE feed_id = ${notice.feed_id}`)).toHaveLength(0);
    await sql`UPDATE feeds SET last_sync_at = now() - interval '1 day' WHERE id = ${notice.feed_id}`;
    await receiveFeedNotifications(sql, [notice], device.id, [org.id]);
    expect((await sql`SELECT id FROM runs WHERE feed_id = ${notice.feed_id}`)).toHaveLength(1);
  });
});
