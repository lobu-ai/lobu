/**
 * A connector version change resets feed checkpoints so the newly active code
 * never resumes from a cursor another version wrote. A sync run claimed under
 * the OLD version before the change is still executing that old code; if it
 * can still commit a page or complete after the reset, it writes the old
 * version's cursor straight back and the reset is undone.
 *
 * These drive the real handlers: the update/install path, then the old run's
 * stream page and completion, and assert on the stored feed state.
 */

import type { Context } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { manageConnections } from '../../../tools/admin/manage_connections';
import { getDb } from '../../../db/client';
import { createSyncRun } from '../../../runs/queue-service';
import {
  resolveConnectorInstallSource,
  upsertConnectorDefinitionRecords,
} from '../../../utils/connector-definition-install';
import { completeWorkerJob, streamContent } from '../../../worker-api';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { seedOwnerContext } from '../../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as unknown as Env;

const KEY = 'zz.versionfenceprobe';
const WORKER_ID = 'worker-version-fence';

function probeSource(version: string): string {
  return `
export default class VersionFenceProbeConnector {
  definition = {
    key: '${KEY}',
    name: 'Version Fence Probe',
    description: 'probe ${version}',
    version: '${version}',
    feeds: {
      items: {
        key: 'items',
        name: 'Items',
        sync: async (ctx) => { await ctx.commit([], null); return { status: 'complete' }; },
      },
    },
  };
  async sync(ctx) { await ctx.commit([], null); return { status: 'complete' }; }
  async execute() { return {}; }
}
`;
}

/** The probe with an identity attribution, so its upsert takes identity-scope locks. */
function identityProbeSource(version: string): string {
  return probeSource(version).replace(
    `name: 'Items',`,
    `name: 'Items',
        eventKinds: {
          item: {
            attributions: [
              {
                role: 'about',
                target: {
                  identities: [{ namespace: 'zz_version_fence_item', eventPath: 'metadata.item_id' }],
                },
              },
            ],
          },
        },`,
  );
}

function mockWorkerCtx(body: unknown): Context<{ Bindings: Env }> {
  return {
    req: { json: async () => body },
    var: {},
    json: (b: unknown) => b as Response,
  } as unknown as Context<{ Bindings: Env }>;
}

async function waitForVersionFenceWaiters(expected: number): Promise<void> {
  const sql = getTestDb();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND (
          query ILIKE '%UPDATE feeds f%'
          OR query ILIKE '%SELECT f.organization_id%'
        )
    `;
    if ((row?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const activity = await sql`
    SELECT wait_event_type, wait_event, left(query, 180) AS query
    FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active'
  `;
  throw new Error(
    `Timed out waiting for ${expected} version-fence lock waiters: ${JSON.stringify(activity)}`,
  );
}

describe('connector version change vs in-flight runs of the old version', () => {
  let ctx: ToolContext;
  let orgId: string;
  let feedId: number;
  let connectionId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext({
      orgName: 'Version Fence Org',
      userName: 'Version Fence User',
    });
    ctx = seeded.ctx;
    orgId = seeded.org.id;

    const installed = await manageConnections(
      { action: 'install_connector', source_code: probeSource('1.0.0') },
      TEST_ENV,
      ctx,
    );
    expect('error' in installed ? installed.error : undefined).toBeUndefined();

    const sql = getTestDb();
    const [conn] = await sql<{ id: number }[]>`
      INSERT INTO connections (organization_id, connector_key, display_name, slug, status)
      VALUES (${orgId}, ${KEY}, 'Version Fence Conn', 'zz-version-fence-conn', 'active')
      RETURNING id
    `;
    connectionId = Number(conn.id);
    const [feed] = await sql<{ id: number }[]>`
      INSERT INTO feeds (organization_id, connection_id, feed_key, status, schedule, checkpoint)
      VALUES (${orgId}, ${connectionId}, 'items', 'active', '0 */6 * * *',
              ${sql.json({ cursor: 'v1-committed' })})
      RETURNING id
    `;
    feedId = Number(feed.id);
  }, 120_000);

  async function seedRun(status: 'running' | 'pending', version: string | null = '1.0.0') {
    const sql = getTestDb();
    const [run] = await sql<{ id: number }[]>`
      INSERT INTO runs
        (organization_id, run_type, feed_id, connection_id, connector_key,
         connector_version, status, claimed_by, claimed_at, created_at)
      VALUES (${orgId}, 'sync', ${feedId}, ${connectionId}, ${KEY}, ${version},
              ${status}, ${status === 'running' ? WORKER_ID : null},
              ${status === 'running' ? sql`NOW()` : null}, NOW())
      RETURNING id
    `;
    return Number(run.id);
  }

  async function feedCheckpoint(): Promise<unknown> {
    const [row] = await getTestDb()<{ checkpoint: unknown }[]>`
      SELECT checkpoint FROM feeds WHERE id = ${feedId}
    `;
    return row?.checkpoint ?? null;
  }

  async function runStatus(runId: number): Promise<string> {
    const [row] = await getTestDb()<{ status: string }[]>`
      SELECT status FROM runs WHERE id = ${runId}
    `;
    return row.status;
  }

  async function bumpTo(version: string) {
    const updated = await manageConnections(
      { action: 'update_connector_source', connector_key: KEY, source_code: probeSource(version) },
      TEST_ENV,
      ctx,
    );
    expect('error' in updated ? updated.error : undefined).toBeUndefined();
  }

  it('an old-version run cannot write its cursor back through a page after the reset', async () => {
    const runId = await seedRun('running');
    await getTestDb()`UPDATE feeds SET last_sync_status = 'pending' WHERE id = ${feedId}`;
    await bumpTo('2.0.0');
    expect(await feedCheckpoint()).toBeNull();
    const [feed] = await getTestDb()<{ last_sync_status: string | null }[]>`
      SELECT last_sync_status FROM feeds WHERE id = ${feedId}
    `;
    expect(feed.last_sync_status).toBeNull();

    const pageCtx = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      checkpoint: { cursor: 'v1-page' },
      items: [],
    });
    await streamContent(pageCtx);

    expect(await feedCheckpoint()).toBeNull();
  }, 120_000);

  it('an old-version run cannot write its cursor back through completion after the reset', async () => {
    const runId = await seedRun('running');
    await bumpTo('2.0.0');
    expect(await feedCheckpoint()).toBeNull();

    const completeCtx = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 0,
      checkpoint: { cursor: 'v1-final' },
    });
    await completeWorkerJob(completeCtx);

    expect(await feedCheckpoint()).toBeNull();
  }, 120_000);

  it('a pending old-version run is not left to execute the old code after the change', async () => {
    const runId = await seedRun('pending');
    await bumpTo('2.0.0');
    expect(await runStatus(runId)).toBe('cancelled');
  }, 120_000);

  it('cancels a versionless active sync because it cannot prove it runs the new version', async () => {
    const runId = await seedRun('running', null);
    await bumpTo('2.0.0');
    expect(await runStatus(runId)).toBe('cancelled');
  }, 120_000);

  it('cannot enqueue the old version from a snapshot taken while the version change is blocked', async () => {
    const sql = getTestDb();
    const blockerReady = Promise.withResolvers<void>();
    const releaseBlocker = Promise.withResolvers<void>();
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM feeds WHERE id = ${feedId} FOR UPDATE`;
      blockerReady.resolve();
      await releaseBlocker.promise;
    });
    await blockerReady.promise;

    const bump = bumpTo('2.0.0');
    let enqueue: ReturnType<typeof createSyncRun> | undefined;
    try {
      await waitForVersionFenceWaiters(1);
      enqueue = sql.begin((tx) => createSyncRun(feedId, TEST_ENV, tx));
      await waitForVersionFenceWaiters(2);
    } finally {
      releaseBlocker.resolve();
      await blocker;
    }

    await bump;
    const created = await enqueue;
    expect(created?.ok).toBe(true);
    if (!created?.ok) return;
    const [run] = await sql<{ connector_version: string; status: string }[]>`
      SELECT connector_version, status FROM runs WHERE id = ${created.runId}
    `;
    expect(run).toEqual({ connector_version: '2.0.0', status: 'pending' });
  }, 120_000);

  it('leaves an in-flight run of the new version alone', async () => {
    const runId = await seedRun('running', '2.0.0');
    await bumpTo('2.0.0');
    expect(await runStatus(runId)).toBe('running');
  }, 120_000);

  it('leaves the run of a feed pinned to that run\'s version alone', async () => {
    await getTestDb()`UPDATE feeds SET pinned_version = '1.0.0' WHERE id = ${feedId}`;
    const runId = await seedRun('running');
    await bumpTo('2.0.0');
    expect(await runStatus(runId)).toBe('running');
    expect(await feedCheckpoint()).toEqual({ cursor: 'v1-committed' });
  }, 120_000);

  it('install_connector over an installed connector at a new version resets the feed and its old runs', async () => {
    const runId = await seedRun('running');
    const reinstalled = await manageConnections(
      { action: 'install_connector', source_code: probeSource('2.0.0') },
      TEST_ENV,
      ctx,
    );
    expect('error' in reinstalled ? reinstalled.error : undefined).toBeUndefined();

    expect(await feedCheckpoint()).toBeNull();
    expect(await runStatus(runId)).toBe('cancelled');
  }, 120_000);

  /**
   * A second writer activates 2.0.0 and starts a 2.0.0 run while this install
   * is in flight. The install must compute its reset from the version it
   * actually replaces (2.0.0), not from a read taken before that writer
   * committed (1.0.0, which equals the incoming version and skips the reset).
   */
  async function whileAnotherWriterActivates2(write: () => Promise<unknown>) {
    const sql = getTestDb();
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let concurrentRunId = 0;
    const writer = sql.begin(async (tx) => {
      await tx`
        UPDATE connector_definitions SET version = '2.0.0', updated_at = NOW()
        WHERE key = ${KEY} AND organization_id = ${orgId} AND status = 'active'
      `;
      holding.resolve();
      await release.promise;
      const [run] = await tx<{ id: number }[]>`
        INSERT INTO runs
          (organization_id, run_type, feed_id, connection_id, connector_key,
           connector_version, status, claimed_by, claimed_at, created_at)
        VALUES (${orgId}, 'sync', ${feedId}, ${connectionId}, ${KEY}, '2.0.0',
                'running', ${WORKER_ID}, NOW(), NOW())
        RETURNING id
      `;
      concurrentRunId = Number(run.id);
      await tx`UPDATE feeds SET checkpoint = ${tx.json({ cursor: 'v2-cursor' })} WHERE id = ${feedId}`;
      const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return pid;
    });
    await holding.promise;
    const [{ pid: writerPid }] = await sql<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND query ILIKE '%UPDATE connector_definitions SET version = ''2.0.0''%'
    `;
    const pending = write().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = await sql<{ c: number }[]>`
          SELECT count(*)::int AS c FROM pg_stat_activity
          WHERE ${writerPid}::int = ANY(pg_blocking_pids(pid))
        `;
        if ((row?.c ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('second writer never blocked the install');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release.resolve();
      await writer;
    }
    return { outcome: await pending, concurrentRunId };
  }

  it('install_connector resets from the version a concurrent writer activated, not a stale read', async () => {
    const { outcome, concurrentRunId } = await whileAnotherWriterActivates2(() =>
      manageConnections(
        { action: 'install_connector', source_code: probeSource('1.0.0') },
        TEST_ENV,
        ctx,
      ),
    );
    expect('error' in outcome ? outcome.error : undefined).toBeUndefined();
    expect(await runStatus(concurrentRunId)).toBe('cancelled');
    expect(await feedCheckpoint()).toBeNull();
  }, 120_000);

  it('update_connector_source resets from the version a concurrent writer activated, not a stale read', async () => {
    const { outcome, concurrentRunId } = await whileAnotherWriterActivates2(() =>
      manageConnections(
        { action: 'update_connector_source', connector_key: KEY, source_code: probeSource('1.0.0') },
        TEST_ENV,
        ctx,
      ),
    );
    expect('error' in outcome ? outcome.error : undefined).toBeUndefined();
    const result = 'value' in outcome ? outcome.value : undefined;
    expect(result && typeof result === 'object' && 'error' in result ? result.error : undefined).toBeUndefined();
    expect(await runStatus(concurrentRunId)).toBe('cancelled');
    expect(await feedCheckpoint()).toBeNull();
  }, 120_000);

  it('a source update and a shared definition upsert of the same connector serialize instead of deadlocking', async () => {
    const sql = getTestDb();
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = sql.begin(async (tx) => {
      await tx`
        SELECT id FROM connector_definitions
        WHERE key = ${KEY} AND organization_id = ${orgId} AND status = 'active'
        FOR UPDATE
      `;
      holding.resolve();
      await release.promise;
    });
    await holding.promise;

    const lockWaiters = async (expected: number) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = await sql<{ c: number }[]>`
          SELECT count(*)::int AS c FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `;
        if ((row?.c ?? 0) >= expected) return;
        if (Date.now() > deadline) throw new Error(`never saw ${expected} lock waiters`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const settle = <T,>(promise: Promise<T>) =>
      promise.then(
        () => null,
        (error: unknown) => error,
      );

    let sourceUpdate: Promise<unknown> = Promise.resolve(null);
    let sharedUpsert: Promise<unknown> = Promise.resolve(null);
    try {
      // The source update reaches the definition row first and queues behind
      // the blocker; the shared writer (catalog/device path) queues second.
      sourceUpdate = settle(
        manageConnections(
          {
            action: 'update_connector_source',
            connector_key: KEY,
            source_code: identityProbeSource('2.0.0'),
          },
          TEST_ENV,
          ctx,
        ).then((result) => {
          if ('error' in result) throw new Error(String(result.error));
        }),
      );
      await lockWaiters(1);
      const { metadata } = await resolveConnectorInstallSource({
        sourceCode: identityProbeSource('2.0.0'),
      });
      sharedUpsert = settle(
        upsertConnectorDefinitionRecords({
          sql: getDb(),
          organizationId: orgId,
          metadata,
          versionRecord: {
            compiledCode: null,
            compiledCodeHash: null,
            compileConfigHash: null,
            sourceCode: null,
            sourcePath: null,
          },
          versionScope: 'organization',
        }),
      );
      await lockWaiters(2);
    } finally {
      release.resolve();
      await blocker;
    }

    expect(await sourceUpdate).toBeNull();
    expect(await sharedUpsert).toBeNull();
    // Both writers declared the identity namespace, so both took its lock.
    const registry = await sql`
      SELECT namespace FROM connector_identity_scope_registry
      WHERE organization_id = ${orgId} AND connector_key = ${KEY}
    `;
    expect(registry.map((row) => row.namespace)).toEqual(['zz_version_fence_item']);
  }, 120_000);
});
