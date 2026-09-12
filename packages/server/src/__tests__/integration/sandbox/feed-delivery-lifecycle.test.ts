import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WorkerClient, executeRun } from '@lobu/connector-worker/daemon';
import { app } from '../../../index';
import { initWorkspaceProvider } from '../../../workspace';
import { compileConnectorSource } from '../../../utils/connector-compiler';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestConnection, createTestConnectorDefinition, createTestPAT, seedOwnerContext } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const connectorKey = 'synthetic.external-batch';
const source = `
import { defineConnector } from '@lobu/connector-sdk';
export default defineConnector({
  key: '${connectorKey}', name: 'External batch', version: '1.0.0',
  authSchema: { methods: [{ type: 'none' }] },
  feeds: { items: { name: 'Items', webhook: { events: ['records'] },
    onDelivery: async (ctx) => {
      const batch = ctx.delivery.payload;
      await ctx.emitEvents(batch.records.map(({ payload: item }) => ({
        origin_id: item.id, origin_type: 'item', payload_text: item.body,
        occurred_at: new Date('2026-01-01T00:00:00Z'),
        automation_signals: [{ event_type: 'item.created', label: 'New item', input_text: item.body }],
      })));
      const checkpoint = { source_ack: { binding_id: batch.binding_id, epoch: batch.epoch,
        records: batch.records.map((row) => ({ id: row.payload.id, revision: row.revision })) } };
      await ctx.updateCheckpoint(checkpoint);
      return { events: [], checkpoint };
    },
  } },
});
`;

describe('source batch through HTTP, durable run, isolate, events and Automation', () => {
  let server: Server | undefined;
  beforeEach(cleanupTestDatabase);
  afterEach(async () => {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = undefined;
  });

  it('ingests a batch once, fences older workers and becomes idle after exact acknowledgment', async () => {
    await initWorkspaceProvider();
    const { org, user, ctx } = await seedOwnerContext();
    const sql = getTestDb();
    const { compiledCode } = await compileConnectorSource(source);
    await createTestConnectorDefinition({
      key: connectorKey, name: 'External batch', organization_id: org.id,
      auth_schema: { methods: [{ type: 'none' }] },
      feeds_schema: { items: { operations: ['delivery'], webhook: { events: ['records'] } } },
      automation_events: [{ key: 'item.created', label: 'New item' }],
    });
    await sql`UPDATE connector_versions SET compiled_code = ${compiledCode} WHERE connector_key = ${connectorKey}`;
    const [device] = await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id, last_seen_at)
      VALUES (${user.id}, 'synthetic-batch-browser', 'chrome-extension', ${sql.json(['browser.tabs'])}, ${org.id}, now()) RETURNING id
    `;
    const connection = await createTestConnection({ organization_id: org.id, connector_key: connectorKey, created_by: user.id, create_default_feed: false });
    await sql`UPDATE connections SET device_worker_id = ${device.id}::uuid WHERE id = ${connection.id}`;
    const [feed] = await sql`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, next_run_at)
      VALUES (${org.id}, ${connection.id}, 'items', 'active', NULL, NULL) RETURNING id
    `;
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const created = await manageAutomations({
      action: 'create', slug: 'synthetic-batch-listener', name: 'Batch listener', prompt: 'Record incoming items.',
      managed_agent_id: agent.agentId,
      triggers: [{ kind: 'event', connector_key: connectorKey, connection_id: connection.id,
        event_types: ['item.created'], execution: 'window', active_run: 'queue', output: 'silent' }],
    }, {}, ctx);
    expect(created.action).toBe('create');
    const pat = await createTestPAT(user.id, org.id);
    const token = 'synthetic-batch-fleet-token';
    const env = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL, WORKER_API_TOKEN: token,
      RATE_LIMIT_ENABLED: 'false', JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only' };
    expect((await post('/api/workers/poll', { token, env, body: { worker_id: 'synthetic-warmup', capacity_available: 0 } })).status).toBe(200);
    server = serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => app.fetch(request, env), overrideGlobalObjects: false }) as Server;
    await new Promise<void>((resolve) => server!.listening ? resolve() : server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const notice = { feed_id: Number(feed.id), connection_id: connection.id, feed_key: 'items',
      notification_id: 'synthetic-batch-notice', changed: true, batch: {
        binding_id: 'synthetic-binding', epoch: 'synthetic-epoch',
        records: [1, 2].map((revision) => ({ revision, payload: { id: `item-${revision}`, body: `Message ${revision}` } })),
      } };
    const deliver = () => fetch(`${apiUrl}/api/workers/poll`, {
      method: 'POST', headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'synthetic-batch-browser', platform: 'chrome-extension',
        capabilities: { 'browser.tabs': true }, capacity_available: 0, feed_notifications: [notice] }),
    });
    const incoming = await deliver();
    expect(incoming.status).toBe(200);
    expect(await incoming.json()).toMatchObject({ feed_notification_receipts: [{ active: true, ack: null }] });
    const legacy = await post('/api/workers/poll', { token, env, body: { worker_id: 'synthetic-legacy-worker', capacity_available: 1 } });
    expect(await legacy.json()).not.toHaveProperty('run_id');
    const client = new WorkerClient({ apiUrl, workerId: 'synthetic-batch-fleet', authToken: token, capabilities: {} });
    const job = await client.poll(1);
    expect(job.delivery?.payload).toEqual(notice.batch);
    const result = await executeRun(client, job, {}, { generateEmbeddings: false });
    expect(result).toEqual({ itemsCollected: 2 });
    expect((await sql`SELECT origin_id FROM events WHERE connection_id = ${connection.id} ORDER BY origin_id`).map((row) => row.origin_id))
      .toEqual(['item-1', 'item-2']);
    const [completed] = await sql`SELECT status, checkpoint FROM runs WHERE id = ${job.run_id!}`;
    expect(completed.status).toBe('completed');
    expect(completed.checkpoint.source_ack.records).toHaveLength(2);
    expect((await sql`SELECT id FROM runs WHERE run_type = 'automation' AND organization_id = ${org.id}`)).toHaveLength(2);
    const replay = await deliver();
    expect(await replay.json()).toMatchObject({ feed_notification_receipts: [{ active: true, ack: completed.checkpoint.source_ack }] });
    expect((await sql`SELECT id FROM runs WHERE feed_id = ${feed.id} AND run_type = 'sync'`)).toHaveLength(1);
    expect(await client.poll(1)).not.toHaveProperty('run_id');
    expect((await sql`SELECT id FROM runs WHERE run_type = 'automation' AND organization_id = ${org.id}`)).toHaveLength(2);
    expect((await sql`SELECT schedule, next_run_at FROM feeds WHERE id = ${feed.id}`)[0]).toEqual({ schedule: null, next_run_at: null });
  });
});
