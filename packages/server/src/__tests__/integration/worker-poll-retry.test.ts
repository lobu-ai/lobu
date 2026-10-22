import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbClient from '../../db/client';
import type { Env } from '../../index';
import logger from '../../utils/logger';
import { pollWorkerJob } from '../../worker-api/poll';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { seedOwnerContext } from '../setup/test-fixtures';

const WORKER_ID = 'poll-retry-worker';
const OLD_HEARTBEAT = new Date('2020-01-01T00:00:00Z');

async function pollWithWriteFailure(
  error: Error,
  failures: number,
  options: { commitBeforeFailing?: boolean } = {}
) {
  const sql = getTestDb();
  const { org, user } = await seedOwnerContext();
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, organization_id, last_seen_at)
    VALUES (${user.id}, ${WORKER_ID}, 'headless', ${org.id}, ${OLD_HEARTBEAT})
  `;

  let writes = 0;
  const failingSql = new Proxy(dbClient.getDb(), {
    apply(target, thisArg, args) {
      if (Array.isArray(args[0]) && args[0].join('').includes('INSERT INTO device_workers')) {
        writes += 1;
        if (writes <= failures) {
          // A drop that reports after the write already committed.
          if (options.commitBeforeFailing) {
            return Promise.resolve(Reflect.apply(target, thisArg, args)).then(() => {
              throw error;
            });
          }
          return Promise.reject(error);
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  vi.spyOn(dbClient, 'getDb').mockReturnValue(failingSql);
  const logged = vi.spyOn(logger, 'error');
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/workers/poll', async (c) => {
    c.set('workerAuthMode', 'user');
    c.set('workerUserId', user.id);
    c.set('workerOrgIds', [org.id]);
    c.set('organizationId', org.id);
    return pollWorkerJob(c);
  });
  const response = await app.request('/api/workers/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      worker_id: WORKER_ID,
      platform: 'headless',
      app_version: '999.0.0',
      capabilities: {},
      capacity_available: 0,
    }),
  });
  const [device] = await sql<{ last_seen_at: Date }[]>`
    SELECT last_seen_at FROM device_workers
    WHERE user_id = ${user.id} AND worker_id = ${WORKER_ID}
  `;
  return { response, writes, logged, lastSeenAt: device.last_seen_at };
}

describe('worker poll heartbeat retry', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['CONNECTION_ENDED', false],
    ['CONNECTION_ENDED', true],
    ['CONNECTION_CLOSED', false],
    ['CONNECTION_CLOSED', true],
  ])('persists the heartbeat after one %s failure (code=%s)', async (code, withCode) => {
    const error = new Error(`write ${code} test-pooler:5432`);
    if (withCode) Object.assign(error, { code });
    const { response, writes, logged, lastSeenAt } = await pollWithWriteFailure(error, 1);

    expect(response.status).toBe(200);
    expect(lastSeenAt.getTime()).toBeGreaterThan(OLD_HEARTBEAT.getTime());
    expect(writes).toBe(2);
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs and counts the heartbeat retry', async () => {
    const warned = vi.spyOn(logger, 'warn');
    const error = Object.assign(new Error('write CONNECTION_CLOSED test-pooler:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    const { response, writes } = await pollWithWriteFailure(error, 1);

    expect(response.status).toBe(200);
    expect(writes).toBe(2);
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'poll.device_upsert', attempt: 1 }),
      expect.stringContaining('retrying query on a fresh connection')
    );
  });

  it('keeps the heartbeat when the first write committed before the drop', async () => {
    const error = Object.assign(new Error('write CONNECTION_CLOSED test-pooler:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    const { response, writes, lastSeenAt } = await pollWithWriteFailure(error, 1, {
      commitBeforeFailing: true,
    });

    expect(response.status).toBe(200);
    expect(writes).toBe(2);
    expect(lastSeenAt.getTime()).toBeGreaterThan(OLD_HEARTBEAT.getTime());
  });

  it.each([
    ['CONNECTION_ENDED', 2],
    ['CONNECTION_CLOSED', 2],
    ['23505', 1],
  ])('logs %s after %i writes without failing the poll', async (code, attempts) => {
    const error = Object.assign(new Error(`write failed: ${code}`), { code });
    const { response, writes, logged, lastSeenAt } = await pollWithWriteFailure(error, Infinity);

    // Registration remains best-effort after exhausting the single retry.
    expect(response.status).toBe(200);
    expect(lastSeenAt.getTime()).toBe(OLD_HEARTBEAT.getTime());
    expect(writes).toBe(attempts);
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      { worker_id: WORKER_ID, err: error.message },
      '[pollWorkerJob] device_workers upsert failed (non-fatal)'
    );
  });
});
