import { Hono } from 'hono';
import type { Env } from '../../../index';
import { agentRoutes } from '../../../lobu/agent-routes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreServices } from '../../../gateway/services/core-services';
import type { IMessageQueue, QueueJob } from '../../../gateway/infrastructure/queue/types';
import { bootTaskScheduler } from '../../../scheduled/jobs';
import { QUERYABLE_SCHEMA } from '../../../utils/table-schema';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestPAT } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

describe('retired product evals', () => {
  beforeEach(cleanupTestDatabase);

  it('does not expose case promotion, suite execution, or results to an authorized owner', async () => {
    const workspace = await TestWorkspace.create();
    const { token } = await createTestPAT(workspace.users.owner.id, workspace.org.id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });
    const base = `/api/${workspace.org.slug}/agents`;
    // Empty input deliberately distinguished the old mutation handlers (400)
    // from missing routes (404), without creating or replaying any cases.
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/:orgSlug/agents', agentRoutes);
    for (const [method, path] of [
      ['POST', '/evals/cases'],
      ['POST', '/automations/invalid/evals/run'],
      ['GET', '/automations/invalid/evals/results'],
    ]) {
      const response = await app.request(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }, { ENVIRONMENT: 'test' });
      expect(response.status).toBe(404);
    }
  });

  it('stops querying eval columns before a later release drops them physically', () => {
    const automation = QUERYABLE_SCHEMA.tables.find((table) => table.name === 'automations');
    expect(automation).toBeDefined();
    expect(automation!.columns.filter((column) => column.name.startsWith('latest_eval_'))).toEqual([]);
  });

  it('drains an old scorer tick without boot seeding or scheduling a successor', async () => {
    const workers = new Map<string, (job: QueueJob<any>) => Promise<void>>();
    const send = vi.fn(async () => 'synthetic-task-id');
    const queue = {
      send,
      work: async (name: string, handler: (job: QueueJob<any>) => Promise<void>) => {
        workers.set(name, handler);
      },
    } as unknown as IMessageQueue;
    const scheduler = await bootTaskScheduler({
      getQueue: () => queue,
      getAuthProfilesManager: () => null,
    } as unknown as CoreServices, { ENVIRONMENT: 'test' });
    try {
      expect(send.mock.calls.some((call: unknown[]) =>
        (call[1] as { name?: string } | undefined)?.name === 'score-eval-runs'
      )).toBe(false);
      send.mockClear();
      await workers.get('task')!({
        id: '999',
        data: { name: 'score-eval-runs', payload: {}, __scheduledTick: '2026-01-01T00:00:00.000Z' },
      } as QueueJob<any>);
      expect(send).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });
});
