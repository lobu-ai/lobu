/**
 * GitHub App deliveries end to end, through the connector's own declarations.
 *
 * Signed delivery → shared app-webhook router → generic data dispatch →
 *  - invalidate: the matching feed is marked due → materialized sync run →
 *    real worker claim, isolated connector, HTTP stream → attributed pull
 *    request → `pull_request.created` Automation activation (bundled catalog);
 *  - record (star): a durable `connector-record` job → the real queue worker →
 *    the connector's `normalize` in the isolate → the same page ingest →
 *    attributed event → `stargazer` Automation activation (bundled catalog) on
 *    a feed that never polled.
 * Only the GitHub API and the OAuth grant are synthetic.
 */

import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { ConnectorWebhookSchema } from '@lobu/connector-sdk';
import GitHubConnector from '@lobu/connectors/github';
import { createIsolateConnectorCompiler } from '@lobu/connector-worker/compile';
import { executeRun, WorkerClient } from '@lobu/connector-worker/daemon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectorRecordEnqueuer, startConnectorRecordWorker } from '../../../connectors/webhook-delivery';
import { RunsQueue } from '../../../gateway/infrastructure/queue/runs-queue';
import {
  createAppWebhookRoutes,
  createDataWebhookDelivery,
  createDeclaredAppWebhookProvider,
} from '../../../gateway/routes/public/app-webhooks';
import { app, type Env } from '../../../index';
import { createPostgresAppInstallationStore } from '../../../lobu/stores/app-installation-store';
import { createSyncRun } from '../../../runs/queue-service';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  declaredFeedsSchema,
  seedOwnerContext,
} from '../../setup/test-fixtures';

const TOKEN = 'synthetic-webhook-worker-token';
const APP_ID = 'synthetic-app';
const APP_SECRET = 'synthetic-app-webhook-secret';
const INSTALLATION = '424242';
const WEBHOOK_SCHEMA = new GitHubConnector().definition.webhook as ConnectorWebhookSchema;
const originalFetch = globalThis.fetch;
const env = {
  ENVIRONMENT: 'test', WORKER_API_TOKEN: TOKEN, RATE_LIMIT_ENABLED: 'false',
  JWT_SECRET: 'test-jwt-secret-for-testing-only', BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
} as Env;

let server: ReturnType<typeof serve>;
let baseUrl: string;
let compiledGithub: string;
let queue: RunsQueue;

beforeAll(async () => {
  await initWorkspaceProvider();
  server = serve({ hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false,
    fetch: request => app.fetch(request, env) });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const source = fileURLToPath(new URL('../../../../../connectors/src/github.ts', import.meta.url));
  compiledGithub = await createIsolateConnectorCompiler().compileConnectorForIsolateFromFile(source);
  queue = new RunsQueue();
  await queue.start();
  await startConnectorRecordWorker(queue);
}, 120_000);
beforeEach(async () => { await cleanupTestDatabase(); });
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => {
  await queue?.stop();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await cleanupTestDatabase();
});

const router = () => createAppWebhookRoutes({
  installationStore: createPostgresAppInstallationStore(),
  providers: [createDeclaredAppWebhookProvider({
    provider: 'github', appId: APP_ID, webhookSchema: WEBHOOK_SCHEMA,
    onDelivery: createDataWebhookDelivery({ connectorKey: 'github', webhookSchema: WEBHOOK_SCHEMA }, connectorRecordEnqueuer(queue)),
  })],
  resolveAppWebhookSecret: async () => APP_SECRET,
});

function delivery(event: string, body: Record<string, unknown>, id: string): Request {
  const raw = JSON.stringify({ installation: { id: Number(INSTALLATION) }, ...body });
  return new Request('http://gateway.test/api/v1/app-webhooks/github', {
    method: 'POST', body: raw,
    headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id,
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
    },
  });
}

/** An org with the bundled github declaration + compiled code, one install-bound connection, and a person type. */
async function seedGithubOrg() {
  const sql = getTestDb();
  const owner = await seedOwnerContext();
  await sql`INSERT INTO entity_types (organization_id, slug, name) VALUES (${owner.org.id}, 'person', 'Person') ON CONFLICT DO NOTHING`;
  await createTestConnectorDefinition({ key: 'github', name: 'GitHub', organization_id: owner.org.id,
    feeds_schema: declaredFeedsSchema(new GitHubConnector().definition) });
  await sql`UPDATE connector_versions SET compiled_code = ${compiledGithub} WHERE connector_key = 'github'`;
  const install = await createPostgresAppInstallationStore().upsert({
    organizationId: owner.org.id, provider: 'github', providerInstance: 'cloud', providerAppId: APP_ID,
    externalTenantId: INSTALLATION, status: 'active',
  });
  const connection = await createTestConnection({ organization_id: owner.org.id, connector_key: 'github',
    config: { installation_ref: install.id }, created_by: owner.user.id, createDefaultFeed: false });
  const agent = await createTestAgent({ organizationId: owner.org.id, ownerUserId: owner.user.id });
  return { ...owner, connectionId: connection.id, agentId: agent.agentId };
}

async function seedFeed(org: { id: string }, connectionId: number, feedKey: string): Promise<number> {
  const [feed] = await getTestDb()`INSERT INTO feeds (organization_id, connection_id, feed_key, status, config)
    VALUES (${org.id}, ${connectionId}, ${feedKey}, 'active', ${getTestDb().json({ repo_owner: 'acme', repo_name: 'api' })}) RETURNING id`;
  return Number(feed.id);
}

async function listen(seed: Awaited<ReturnType<typeof seedGithubOrg>>, eventType: string,
  match?: Record<string, string>, slug = `github-${eventType}-listener`): Promise<number> {
  const created = await manageAutomations({
    action: 'create', slug, name: `GitHub ${eventType}`, prompt: 'Say thanks.',
    managed_agent_id: seed.agentId,
    triggers: [{ kind: 'event', source: 'connector', connector_key: 'github', connection_id: seed.connectionId,
      event_types: [eventType], execution: 'turn', active_run: 'queue', output: 'silent', skip_if_unchanged: true,
      ...(match ? { match } : {}) }],
  }, {} as Env, seed.ctx);
  if (created.action !== 'create' || !('automation_id' in created)) throw new Error('Automation creation did not complete');
  return Number(created.automation_id);
}

const activations = async (automationId: number) =>
  (await getTestDb()`SELECT id FROM runs WHERE automation_id = ${automationId}`).length;

const liveEvents = async (orgId: string, originType: string) => getTestDb()<{ origin_id: string; metadata: Record<string, unknown> }[]>`
  SELECT origin_id, metadata FROM events
  WHERE organization_id = ${orgId} AND origin_type = ${originType} AND superseded_by IS NULL ORDER BY id`;

async function people(orgId: string): Promise<string[]> {
  const rows = await getTestDb()<{ identifier: string }[]>`
    SELECT ei.identifier FROM entity_identities ei JOIN entities e ON e.id = ei.entity_id
    WHERE e.organization_id = ${orgId} AND ei.namespace = 'github_user_id' AND ei.deleted_at IS NULL ORDER BY 1`;
  return rows.map(row => row.identifier);
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the record job');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Stub the GitHub API; every other origin except the test server is refused. */
function stubGithub(routes: (url: URL) => unknown): void {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === baseUrl) return originalFetch(input, init);
    if (url.hostname !== 'api.github.com') throw new Error(`Unexpected test egress: ${url.origin}`);
    return Response.json(routes(url));
  }) as typeof fetch;
}

async function executeClaimed(workerId: string) {
  const client = new WorkerClient({ apiUrl: baseUrl, workerId, authToken: TOKEN, capabilities: {} });
  const claimed = await client.poll(1);
  expect(claimed.run_id).toBeTruthy();
  const result = await executeRun(client, { ...claimed, credentials: { provider: 'github', accessToken: 'synthetic-token' } }, {},
    { generateEmbeddings: false, timeoutMs: 20_000 });
  expect(result.error).toBeUndefined();
}

const old = '2026-01-01T00:00:00.000Z';
/** A pull request as the repo `/issues` listing returns it. */
const pull = (id: number, login: string, userId: number) => ({ id, number: id, title: `PR ${id}`, body: 'Body',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  html_url: `https://github.com/acme/api/pull/${id}`, pull_request: { url: `https://api.github.com/repos/acme/api/pulls/${id}` },
  user: { login, id: userId, html_url: `https://github.com/${login}` } });

describe('GitHub App deliveries through the generic dispatch', () => {
  it('a pull_request delivery marks the feed due; the worker sync stores an attributed PR that activates an Automation', async () => {
    const seed = await seedGithubOrg();
    const feedId = await seedFeed(seed.org, seed.connectionId, 'pull_requests');
    const automationId = await listen(seed, 'pull_request.created');
    let pulls = [pull(1, 'Hubot', 42)];
    stubGithub(() => pulls);

    // Baseline poll: the cold-start backfill stores without activating.
    expect((await createSyncRun(feedId, env)).ok).toBe(true);
    await executeClaimed('synthetic-baseline');
    expect(await liveEvents(seed.org.id, 'pull_request')).toHaveLength(1);
    expect(await activations(automationId)).toBe(0);

    pulls = [pull(1, 'Hubot', 42), pull(2, 'Octocat', 583231)];
    const res = await router().fetch(delivery('pull_request', {
      action: 'opened', number: 2, repository: { owner: { login: 'Acme' }, name: 'API' },
    }, 'gh-pull-2'));
    expect(await res.json()).toMatchObject({ triggered: true });
    const sql = getTestDb();
    expect((await materializeDueFeeds(env, sql)).runsCreated).toBe(1);
    await executeClaimed('synthetic-after-webhook');

    expect((await liveEvents(seed.org.id, 'pull_request')).map(row => row.origin_id)).toEqual(['pr_acme_api_1', 'pr_acme_api_2']);
    expect(await people(seed.org.id)).toEqual(['42', '583231']);
    expect(await activations(automationId)).toBe(1);
  }, 60_000);

  it('a star records through the job, activates on a never-polled feed, and dedupes with redeliveries and the poll', async () => {
    const seed = await seedGithubOrg();
    const feedId = await seedFeed(seed.org, seed.connectionId, 'stargazers');
    const automationId = await listen(seed, 'stargazer');
    // A resource-filtered trigger built from the advertised catalog entry must match the recorded star.
    const starEntry = new GitHubConnector().definition.automationEvents?.find(entry => entry.key === 'stargazer');
    const filteredId = await listen(seed, 'stargazer', { resource_type: String(starEntry?.resourceType) }, 'github-stargazer-by-resource');
    const star = { action: 'created', starred_at: '2026-06-20T10:00:00Z',
      sender: { login: 'Octocat', id: 583231, html_url: 'https://github.com/Octocat' },
      repository: { owner: { login: 'ACME' }, name: 'API', html_url: 'https://github.com/ACME/API' } };

    // Two concurrent redeliveries of one star.
    const responses = await Promise.all([
      router().fetch(delivery('star', star, 'gh-star-a')),
      router().fetch(delivery('star', star, 'gh-star-b')),
    ]);
    for (const res of responses) expect(await res.json()).toMatchObject({ triggered: true });
    const sql = getTestDb();
    await eventually(async () =>
      (await sql`SELECT id FROM runs WHERE queue_name = 'internal:connector-record' AND status NOT IN ('completed', 'failed')`).length === 0
      && (await sql`SELECT id FROM runs WHERE queue_name = 'internal:connector-record'`).length === 2);
    expect((await sql`SELECT status FROM runs WHERE queue_name = 'internal:connector-record'`).map(row => row.status))
      .toEqual(['completed', 'completed']);

    const recorded = await liveEvents(seed.org.id, 'stargazer');
    expect(recorded.map(row => row.origin_id)).toEqual(['stargazer_acme_api_github_user_id_583231']);
    expect(recorded[0].metadata.source).toBe('github_star_webhook');
    expect(await people(seed.org.id)).toEqual(['583231']);
    // A live record skips only the prior-poll gate: one star, one activation.
    expect(await activations(automationId)).toBe(1);
    expect(await activations(filteredId)).toBe(1);
    // The record never set the poll baseline.
    expect((await sql`SELECT checkpoint, last_sync_at FROM feeds WHERE id = ${feedId}`)[0])
      .toEqual({ checkpoint: null, last_sync_at: null });

    // The stargazers poll later sees the same star: still exactly one live event.
    stubGithub(url => url.pathname.endsWith('/stargazers')
      ? [{ starred_at: star.starred_at, user: star.sender }]
      : { login: 'Octocat', id: 583231, html_url: 'https://github.com/Octocat', updated_at: old });
    expect((await createSyncRun(feedId, env)).ok).toBe(true);
    await executeClaimed('synthetic-stargazers');
    expect((await liveEvents(seed.org.id, 'stargazer')).map(row => row.origin_id))
      .toEqual(['stargazer_acme_api_github_user_id_583231']);
    expect(await people(seed.org.id)).toEqual(['583231']);
    expect(await activations(automationId)).toBe(1);
  }, 60_000);
});
