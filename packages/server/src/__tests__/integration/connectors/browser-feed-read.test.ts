import { COMPILE_CONFIG_HASH } from '@lobu/connector-worker/compile';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index';
import { upsertEntityApprovalPolicy } from '../../../authz/entity-policy';
import { sweepAbandonedDeviceFeedReadRuns } from '../../../scheduled/check-stalled-executions';
import { manageFeeds } from '../../../tools/admin/manage_feeds';
import { getContent } from '../../../tools/get_content/handler';
import * as sourceFeedPage from '../../../lib/source-feed-page';
import type { ToolContext } from '../../../tools/registry';
import { compileConnectorSource, extractConnectorMetadata } from '../../../utils/connector-compiler';
import * as inlineAttachments from '../../../utils/inline-attachments';
import { deviceManifestHash, type DeviceConnectorManifest } from '../../../worker-api/device-manifests';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import * as sourceObservations from '../../../runs/source-feed-observation';
import * as sourceNotifications from '../../../runs/feed-notifications';
import { runAutomationScriptTask } from '../../../automations/script-task';

const SOURCE_KEY = 'browser-read-fixture';
const VERSION = '0.0.1';
const WORKER_ID = 'browser-source-read-worker';
const SOURCE = `
  import { defineConnector } from '@lobu/connector-sdk';
  export default defineConnector({
    key: '${SOURCE_KEY}', name: 'Browser read fixture', version: '${VERSION}',
    authSchema: { methods: [{ type: 'none' }] },
    automationEvents: [{ key: 'message.created', label: 'New message', resourceType: 'message' }],
    feeds: { items: {
      key: 'items', name: 'Items',
      observe: async (ctx) => {
        const page = await ctx.sessionState.chrome_dispatcher.dispatch('feed_listen', {});
        return { changes: page.references, checkpoint: { source_ack: page.ack } };
      },
      read: async (ctx) => {
        if (ctx.query === 'plain') return { rows: [{ id: 'plain' }], hasMore: false };
        const dispatcher = ctx.sessionState?.chrome_dispatcher;
        if (!dispatcher) throw new Error('source read has no chrome_dispatcher');
        const page = await dispatcher.dispatch('evaluate', { expression: ctx.query });
        return { rows: page.rows, hasMore: false };
      },
    } },
  });
`;
const CHROME: DeviceConnectorManifest = {
  key: 'chrome', name: 'Chrome fixture', version: VERSION,
  required_capability: 'browser.debugger', runtime: { platforms: ['chrome-extension'] },
  auth_schema: { methods: [{ type: 'none' }] }, feeds_schema: {},
  actions_schema: {
    evaluate: { key: 'evaluate', name: 'Evaluate', kind: 'read', requiresApproval: false },
    feed_listen: { key: 'feed_listen', name: 'Listen', kind: 'read' },
  },
};
const CHROME_HASH = deviceManifestHash(CHROME);
const ROWS = [{ id: 'source-item', text: 'private browser source result' }];
let orgId: string;
let userId: string;
let deviceId: string;
let connectionId: number;
let feedId: number;
let compiled: Awaited<ReturnType<typeof compileConnectorSource>>;

function context(): ToolContext {
  return { organizationId: orgId, userId, memberRole: 'owner', scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] } as ToolContext;
}

async function read(ctx = context(), query = 'private query'): Promise<Record<string, any>> {
  return manageFeeds({ action: 'read_feeds', reads: [{ feed_id: feedId, query, limit: 2 }], timeout_ms: 5000 }, {} as Env, ctx) as Promise<Record<string, any>>;
}

/** The real worker poll/complete routes carry observations across DB connections. */
async function answerBrowser(reading: Promise<Record<string, any>>, answer = true): Promise<number | undefined> {
  let finished = false;
  reading.finally(() => { finished = true; }).catch(() => {});
  for (let attempt = 0; attempt < 70 && !finished; attempt += 1) {
    const response = await post('/api/workers/poll', { body: {
      worker_id: WORKER_ID, platform: 'chrome-extension', app_version: '9.9.0',
      capabilities: { 'browser.debugger': true, 'browser.tabs': true },
    } });
    expect(response.status).toBe(200);
    const job = await response.json();
    if (job?.run_id && job.operation_key === 'evaluate') {
      expect(job.action_input).toMatchObject({ expression: 'private query' });
      if (!answer) return job.run_id;
      const completion = await post('/api/workers/complete-action', { body: {
        run_id: job.run_id, worker_id: WORKER_ID, status: 'success', action_output: {
          rows: ROWS, attachments: [{ filename: 'private.txt', data: Buffer.from('private bytes').toString('base64'), mime_type: 'text/plain' }],
        },
      } });
      expect(completion.status).toBe(200);
      return job.run_id;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForChild() {
  const sql = getTestDb();
  await expect.poll(async () => Number((await sql`SELECT count(*) AS n FROM runs
    WHERE organization_id = ${orgId} AND action_key = 'evaluate'`)[0].n)).toBe(1);
  return (await sql`SELECT * FROM runs WHERE organization_id = ${orgId} AND action_key = 'evaluate'`)[0];
}

async function expectScrubbed() {
  const sql = getTestDb();
  await expect.poll(async () => Number((await sql`SELECT count(*) AS n FROM runs WHERE organization_id = ${orgId}
    AND (status IN ('pending', 'running', 'claimed') OR action_output IS NOT NULL
      OR action_input->>'scrubbed' IS DISTINCT FROM 'true')`)[0].n)).toBe(0);
  expect(JSON.stringify(await sql`SELECT action_input, action_output, error_message FROM runs WHERE organization_id = ${orgId}`)).not.toContain('private');
}

describe('compiled browser source reads', () => {
  beforeAll(async () => { compiled = await compileConnectorSource(SOURCE); });
  beforeEach(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Browser source fixture' });
    orgId = org.id;
    const user = await createTestUser({ email: 'browser-source@example.test' });
    userId = user.id;
    await addUserToOrganization(userId, orgId, 'owner');
    await sql`UPDATE organization SET metadata = ${sql.json({ personal_org_for_user_id: userId })} WHERE id = ${orgId}`;
    const [device] = await sql`INSERT INTO device_workers
      (user_id, worker_id, platform, app_version, capabilities, label, organization_id, last_seen_at, connector_manifests)
      VALUES (${userId}, ${WORKER_ID}, 'chrome-extension', '9.9.0', ${sql.json(['browser.debugger', 'browser.tabs'])},
        'Browser fixture', ${orgId}, NOW(), ${sql.json({ chrome: { manifest: CHROME, manifest_hash: CHROME_HASH, received_at: new Date().toISOString() } })}) RETURNING id`;
    deviceId = device.id;
    for (const key of [SOURCE_KEY, 'chrome']) {
      const isChrome = key === 'chrome';
      await sql`INSERT INTO connector_definitions
        (key, name, version, organization_id, status, runtime, required_capability, feeds_schema, actions_schema, auth_schema, automation_events)
        VALUES (${key}, ${key}, ${VERSION}, ${orgId}, 'active', ${isChrome ? sql.json(CHROME.runtime!) : null},
          ${isChrome ? 'browser.debugger' : null}, ${sql.json(isChrome ? {} : { items: { key: 'items', operations: ['read', 'observe'] } })},
          ${sql.json(isChrome ? CHROME.actions_schema! : {})}, ${sql.json({ methods: [{ type: 'none' }] })},
          ${sql.json(isChrome ? [] : [{ key: 'message.created', label: 'New message', resourceType: 'message' }])})`;
      await sql`INSERT INTO connector_versions
        (organization_id, connector_key, version, compiled_code, compiled_code_hash, compile_config_hash, source_code, source_path)
        VALUES (${orgId}, ${key}, ${VERSION}, ${isChrome ? null : compiled.compiledCode},
          ${isChrome ? CHROME_HASH : compiled.compiledCodeHash}, ${isChrome ? null : COMPILE_CONFIG_HASH}, ${isChrome ? null : SOURCE},
          ${isChrome ? 'device-manifest://chrome-extension/chrome@0.0.1' : null})`;
      const [connection] = await sql`INSERT INTO connections
        (organization_id, connector_key, slug, status, visibility, device_worker_id, created_by)
        VALUES (${orgId}, ${key}, ${key}, 'active', 'private', ${deviceId}::uuid, ${userId}) RETURNING id`;
      if (!isChrome) connectionId = Number(connection.id);
    }
    const [feed] = await sql`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
      VALUES (${orgId}, ${connectionId}, 'items', 'active', '{}'::jsonb) RETURNING id`;
    feedId = Number(feed.id);
    await upsertEntityApprovalPolicy(orgId, { resourceClass: 'connector_action', connectorKey: SOURCE_KEY,
      operationCategory: 'read', effects: { execute: 'auto' } });
  });
  afterAll(cleanupTestDatabase);
  afterEach(() => vi.restoreAllMocks());

  it('extracts read/observe capabilities and rejects competing checkpoint writers', async () => {
    expect((await extractConnectorMetadata(compiled.compiledCode)).feeds).toMatchObject({ items: { operations: ['read', 'observe'] } });
    const invalid = await compileConnectorSource(SOURCE.replace("name: 'Items',", "name: 'Items', sync: async () => ({ status: 'complete' }),"));
    await expect(extractConnectorMetadata(invalid.compiledCode)).rejects.toThrow('cannot implement both sync and observe');
  });

  it.each(['notification receipts', 'observation reconciliation'])('keeps browser polling available when %s fails', async (phase) => {
    const failed = phase === 'notification receipts'
      ? vi.spyOn(sourceNotifications, 'receiveFeedNotifications')
      : vi.spyOn(sourceObservations, 'reconcileSourceFeedObservations');
    failed.mockRejectedValueOnce(new Error('Synthetic source activity failure'));
    const response = await post('/api/workers/poll', { body: {
      worker_id: WORKER_ID, platform: 'chrome-extension', app_version: '9.9.0', capacity_available: 0,
      capabilities: { 'browser.debugger': true, 'browser.tabs': true },
      feed_notifications: phase === 'notification receipts'
        ? [{ feed_id: feedId, connection_id: connectionId, feed_key: 'items', changed: true, notification_id: 'synthetic-poll-notice' }]
        : [],
    } });
    expect(failed).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ next_poll_seconds: 10, page_activations: [] });
    expect(body.feed_notification_receipts).toBeUndefined();
  });

  it('runs a compiled observer through browser claim/completion into a durable Automation with no content events', async () => {
    const sql = getTestDb();
    const agent = await createTestAgent({ organizationId: orgId, ownerUserId: userId });
    const [automation] = await sql`WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
      INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug, triggers)
      SELECT id, id, ${orgId}, ${agent.agentId}, ${userId}, 'Observation fixture', 'source-observation-fixture',
        ${sql.json([{ kind: 'event', connector_key: SOURCE_KEY, connection_id: connectionId,
          event_types: ['message.created'], execution: 'turn', active_run: 'queue', output: 'silent' }])}
      FROM next_id RETURNING id`;
    const [version] = await sql`INSERT INTO automation_versions (automation_id, version, name, prompt, created_by)
      VALUES (${automation.id}, 1, 'Observation fixture', 'Read only the referenced source item.', ${userId}) RETURNING id`;
    await sql`UPDATE automations SET current_version_id = ${version.id} WHERE id = ${automation.id}`;
    const script = `export default async (ctx, client) => {
      const result = await client.feeds.readMany({ reads: [{ feed_id: ${feedId}, query: 'private query' }] });
      const page = result.results[0];
      if (!page.ok) throw new Error('Source read failed: ' + page.error);
      return { message_count: page.rows.length, character_count: page.rows[0].text.length };
    };`;
    await sql`UPDATE automations SET execution_config = ${sql.json({ executor: { kind: 'script', source: script } })}
      WHERE id = ${automation.id}`;
    const observed = sourceObservations.runSourceFeedObservation({ organizationId: orgId, feedId });
    let finished = false;
    observed.finally(() => { finished = true; }).catch(() => {});
    let answered = false;
    const ack = { binding_id: 'synthetic-observation-binding', epoch: 'synthetic-epoch', records: [{ id: 'source-item', revision: 1 }] };
    for (let attempt = 0; attempt < 70 && !finished; attempt++) {
      const response = await post('/api/workers/poll', { body: {
        worker_id: WORKER_ID, platform: 'chrome-extension', app_version: '9.9.0',
        capabilities: { 'browser.debugger': true, 'browser.tabs': true },
      } });
      expect(response.status).toBe(200);
      const job = await response.json();
      if (job?.run_id && job.operation_key === 'feed_listen') {
        expect(job.feed_context).toMatchObject({ feed_id: feedId, connection_id: connectionId, dry_run: false });
        const completed = await post('/api/workers/complete-action', { body: {
          run_id: job.run_id, worker_id: WORKER_ID, status: 'success', action_output: {
            references: [{ event_type: 'message.created', resource_type: 'message', resource_ref: 'source-item', delivery_id: 'message-1' }], ack,
          },
        } });
        expect(completed.status).toBe(200);
        answered = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await observed;
    expect(answered).toBe(true);
    const [feed] = await sql`SELECT checkpoint, items_collected, schedule FROM feeds WHERE id = ${feedId}`;
    expect(feed.checkpoint).toEqual({ source_ack: ack });
    expect(Number(feed.items_collected)).toBe(0);
    expect(feed.schedule).toBeNull();
    expect(await sql`SELECT id FROM events WHERE organization_id = ${orgId}`).toHaveLength(0);
    const activations = await sql`SELECT id FROM runs WHERE organization_id = ${orgId} AND run_type = 'automation'`;
    expect(activations).toHaveLength(1);
    const steps = await sql`SELECT action_input, action_output, status FROM runs WHERE organization_id = ${orgId} AND run_type = 'action'`;
    expect(steps).toHaveLength(2);
    expect(steps.every(step => step.status === 'completed' && step.action_output === null && step.action_input.scrubbed)).toBe(true);

    const sourceRunId = Number(activations[0].id);
    expect(await sql`SELECT id FROM runs WHERE parent_run_id = ${sourceRunId} AND action_key = 'automation-script'`)
      .toHaveLength(1); // Observation dispatches immediately, without a scheduler tick.
    const [scriptTask] = await sql`UPDATE runs SET status = 'claimed', claimed_by = 'synthetic-script-worker', claimed_at = now()
      WHERE parent_run_id = ${sourceRunId} AND action_key = 'automation-script' RETURNING id`;
    const executing = runAutomationScriptTask({ organizationId: orgId, automationId: Number(automation.id), sourceRunId },
      { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL } as Env, Number(scriptTask.id));
    await answerBrowser(executing.then(() => ({})));
    await executing;
    const [completed] = await sql`SELECT status, action_output FROM runs WHERE id = ${sourceRunId}`;
    expect(completed).toEqual({ status: 'completed', action_output: { message_count: 1, character_count: ROWS[0].text.length } });
    const retained = await sql`SELECT action_input, action_output, error_message FROM runs WHERE organization_id = ${orgId}`;
    expect(JSON.stringify(retained)).not.toContain(ROWS[0].text);
    expect(await sql`SELECT id FROM events WHERE organization_id = ${orgId}`).toHaveLength(0);
    // Revocation removes the delegated private-feed access as well as the listener.
    await sql`UPDATE automations SET status = 'archived' WHERE id = ${automation.id}`;
    const denied = await read({ ...context(), userId: null, actingAutomationId: Number(automation.id) });
    expect(denied.results[0]).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
  }, 30_000);

  it('reads through Chrome without retaining results, filters, events, or sync state', async () => {
    const materialize = vi.spyOn(inlineAttachments, 'materializeActionOutputAttachments');
    const reading = read();
    await answerBrowser(reading);
    const result = await reading;
    expect(result.results).toEqual([{ feed_id: feedId, ok: true, rows: ROWS, columns: [] }]);
    const sql = getTestDb();
    const runs = await sql`SELECT status, action_input, action_output FROM runs WHERE organization_id = ${orgId} ORDER BY id`;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'completed' && run.action_output === null)).toBe(true);
    expect(JSON.stringify(runs)).not.toContain('private');
    const [events] = await sql`SELECT count(*)::int AS n FROM events WHERE organization_id = ${orgId}`;
    expect(events.n).toBe(0);
    const [feed] = await sql`SELECT checkpoint, last_sync_at, last_sync_status FROM feeds WHERE id = ${feedId}`;
    expect(feed).toEqual({ checkpoint: null, last_sync_at: null, last_sync_status: null });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('keeps non-browser compiled reads free of operation runs', async () => {
    expect((await read(context(), 'plain')).results).toEqual([{ feed_id: feedId, ok: true, rows: [{ id: 'plain' }], columns: [] }]);
    expect(await getTestDb()`SELECT id FROM runs WHERE organization_id = ${orgId}`).toHaveLength(0);
  });

  it('rejects a private feed before creating browser authority for another user', async () => {
    const other = await createTestUser({ email: 'other-browser@example.test' });
    await addUserToOrganization(other.id, orgId, 'member');
    const result = await read({ ...context(), userId: other.id });
    expect(result.results[0]).toMatchObject({ ok: false, error_code: 'NOT_FOUND' });
    expect(await getTestDb()`SELECT id FROM runs WHERE organization_id = ${orgId}`).toHaveLength(0);
  });

  it.each(['agent', 'automation'] as const)('keeps %s authority and a payload-free policy veto', async (kind) => {
    const sql = getTestDb();
    const agent = await createTestAgent({ organizationId: orgId, agentId: 'source-reader', ownerUserId: userId });
    let automationId: number | undefined;
    if (kind === 'automation') {
      const [automation] = await sql`WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
        INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug)
        SELECT id, id, ${orgId}, ${agent.agentId}, ${userId}, 'Browser source fixture', 'browser-source-fixture'
        FROM next_id RETURNING id`;
      automationId = Number(automation.id);
    }
    await upsertEntityApprovalPolicy(orgId, { resourceClass: 'connector_action', connectorKey: 'chrome',
      principalKind: 'agent', principalId: agent.agentId, effects: { execute: 'deny' } });
    const result = await read({ ...context(), agentId: agent.agentId, actingAutomationId: automationId });
    expect(result.results[0].ok).toBe(false);
    const runs = await sql`SELECT status, policy_principal_kind, policy_principal_id FROM runs WHERE organization_id = ${orgId} ORDER BY id`;
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.policy_principal_kind === kind
      && run.policy_principal_id === (automationId ? `automation:${automationId}` : agent.agentId))).toBe(true);
    expect(runs[1].status).toBe('cancelled');
    await expectScrubbed();
    const events = await sql`SELECT * FROM events WHERE organization_id = ${orgId}`;
    expect(events).toHaveLength(1);
    expect(events[0].interaction_input).toBeNull();
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('rechecks source visibility before a queued browser step is claimed', async () => {
    const sql = getTestDb();
    const reading = read();
    const child = await waitForChild();
    const other = await createTestUser({ email: 'new-source-owner@example.test' });
    await sql`UPDATE connections SET created_by = ${other.id} WHERE id = ${connectionId}`;
    await answerBrowser(reading);
    expect((await reading).results[0].ok).toBe(false);
    expect((await sql`SELECT status FROM runs WHERE id = ${child.id}`)[0].status).toBe('cancelled');
    await expectScrubbed();
  });

  it.each([false, true])('keeps the verified requester when selecting another Automation (session: %s)', async (hasSession) => {
    const sql = getTestDb();
    const agent = await createTestAgent({ organizationId: orgId, agentId: 'restricted-reader', ownerUserId: userId });
    const otherAgent = await createTestAgent({ organizationId: orgId, agentId: 'source-owner', ownerUserId: userId });
    const automationIds: number[] = [];
    for (const owner of [otherAgent.agentId, agent.agentId]) {
      const [automation] = await sql`WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
        INSERT INTO automations (id, automation_group_id, organization_id, managed_agent_id, created_by, name, slug, sources)
        SELECT id, id, ${orgId}, ${owner}, ${userId}, 'Source authority fixture', ${owner},
          ${sql.json([{ name: 'items', query: `@feed:${feedId}` }])}
        FROM next_id RETURNING id`;
      automationIds.push(Number(automation.id));
    }
    await sql`UPDATE connector_definitions SET feeds_schema = ${sql.json({
      items: { key: 'items', operations: ['read'], readWindowAxis: 'source_at' },
    })} WHERE organization_id = ${orgId} AND key = ${SOURCE_KEY}`;
    const stop = new Error('Stopped at source reader');
    const pageRead = vi.spyOn(sourceFeedPage, 'readSourceFeedPage').mockRejectedValue(stop);
    const controller = new AbortController();
    const actingAutomationId = hasSession ? automationIds[1] : undefined;
    await expect(getContent({
      automation_id: automationIds[0], since: '2026-01-01', until: '2026-01-02',
    }, {} as Env, {
      ...context(), agentId: agent.agentId, actingAutomationId, abortSignal: controller.signal,
    })).rejects.toThrow('Stopped at source reader');
    expect(pageRead).toHaveBeenCalledWith(
      expect.objectContaining({ feed_id: feedId }), 30_000,
      { organizationId: orgId, principal: userId, agentId: agent.agentId },
      controller.signal, actingAutomationId,
    );
  });

  it('cancels a claimed step and ignores a late completion without publishing artifacts', async () => {
    const materialize = vi.spyOn(inlineAttachments, 'materializeActionOutputAttachments');
    const controller = new AbortController();
    const reading = read({ ...context(), abortSignal: controller.signal });
    const childId = await answerBrowser(reading, false);
    expect(childId).toBeDefined();
    controller.abort();
    expect((await reading).results[0]).toMatchObject({ ok: false, error_code: 'UPSTREAM_TIMEOUT' });
    await expectScrubbed();
    const response = await post('/api/workers/complete-action', { body: {
      run_id: childId, worker_id: WORKER_ID, status: 'success', action_output: {
        rows: ROWS, attachments: [{ filename: 'private.txt', data: Buffer.from('private bytes').toString('base64'), mime_type: 'text/plain' }],
      },
    } });
    expect(await response.json()).toMatchObject({ success: false, reason: 'already_finalized' });
    await expectScrubbed();
    const sql = getTestDb();
    expect(materialize).not.toHaveBeenCalled();
    expect(await sql`SELECT id FROM events WHERE organization_id = ${orgId}`).toHaveLength(0);
  });

  it('recovers abandoned running parents and browser payloads at their persisted deadline', async () => {
    const sql = getTestDb();
    const reading = read();
    const childId = await answerBrowser(reading, false);
    await sql`UPDATE runs SET expires_at = now() - interval '1 second',
      action_input = action_input || ${sql.json({ scrubbed: true, feed_key: 'private filter' })},
      action_output = CASE WHEN id = ${childId} THEN NULL ELSE ${sql.json({ private: 'orphaned rows' })} END
      WHERE organization_id = ${orgId}`;
    expect(await sweepAbandonedDeviceFeedReadRuns(sql)).toBe(2);
    expect((await reading).results[0].ok).toBe(false);
    await expectScrubbed();
    expect((await sql`SELECT status FROM runs WHERE id = ${childId}`)[0].status).toBe('timeout');
    expect(await sweepAbandonedDeviceFeedReadRuns(sql)).toBe(0);
  });
});
