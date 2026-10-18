import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ACCESS_REFUSED } from '../../authz/device-access';
import { upsertEntityApprovalPolicy } from '../../authz/entity-policy';
import type { Env } from '../../index';
import { manageOperations } from '../../tools/admin/manage_operations';
import type { ToolContext } from '../../tools/registry';
import { initWorkspaceProvider } from '../../workspace';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

const CONNECTOR = 'demo.device.runtime';

/**
 * Admission for an UNPINNED native runtime (`connector_runtime` set,
 * `device_worker_id` NULL). The execute gate must treat a runtime exactly
 * like a pin: members run on it, `org_shared` queues for the owner, and
 * `public_visitor`/`reply_only` are refused without creating a run.
 */
describe('unpinned device-runtime operation admission', () => {
  let ctx: ToolContext;
  let connectionId: number;

  beforeAll(initWorkspaceProvider);

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext({ orgName: 'Device Runtime Fixture' });
    ctx = { ...seeded.ctx, baseUrl: 'https://gateway.test/lobu' };
    const sql = getTestDb();
    await createTestConnectorDefinition({
      key: CONNECTOR,
      name: 'Device runtime fixture',
      organization_id: ctx.organizationId,
      auth_schema: { methods: [{ type: 'none' }] },
    });
    await sql`UPDATE connector_definitions SET actions_schema = ${sql.json({
      echo: { name: 'Echo', kind: 'write', input_schema: { type: 'object' } },
    })}, supports_execute = true, runtime = ${sql.json({ platforms: ['macos'] })}
      WHERE organization_id = ${ctx.organizationId} AND key = ${CONNECTOR}`;
    connectionId = (
      await createTestConnection({
        organization_id: ctx.organizationId,
        connector_key: CONNECTOR,
        created_by: seeded.user.id,
        visibility: 'private',
      })
    ).id;
    // Deliberately NO device_worker_id pin: admission must come from the
    // connector runtime alone.
    await upsertEntityApprovalPolicy(ctx.organizationId, {
      resourceClass: 'connector_action',
      connectionId,
      effects: { execute: 'auto' },
    });
  });

  function execute(
    extraArgs: Record<string, unknown> = {},
    context: ToolContext = ctx,
  ) {
    return manageOperations(
      {
        action: 'execute',
        connection_id: connectionId,
        operation_key: 'echo',
        input: {},
        ...extraArgs,
      },
      {} as Env,
      context,
    ) as Promise<{ run_id: number; status: string; error?: string }>;
  }

  function chatCtx(chatAccess: 'org_shared' | 'public_visitor' | 'reply_only'): ToolContext {
    return {
      ...ctx,
      sourceContext: { platform: 'slack', chatAccess },
    } as ToolContext;
  }

  async function actionRunIds(): Promise<number[]> {
    const rows = await getTestDb()<{ id: number }>`SELECT id FROM runs
      WHERE connection_id = ${connectionId} AND run_type = 'action' ORDER BY id`;
    return rows.map((row) => Number(row.id));
  }

  it('member executes on the unpinned runtime without queueing', async () => {
    const result = await execute({ background: true });
    expect(result.status).toBe('in_progress');
    const [run] = await getTestDb()`SELECT status, approval_status FROM runs WHERE id = ${result.run_id}`;
    expect(run).toMatchObject({ status: 'pending', approval_status: 'auto' });
  });

  it('org_shared queues for owner approval instead of running', async () => {
    const result = await execute({ background: true }, chatCtx('org_shared'));
    expect(result.status).toBe('pending_approval');
    // Exactly one action run — the queued one. (Approval delivery commits a
    // separate notification run alongside it.)
    expect(await actionRunIds()).toEqual([result.run_id]);
    const [run] = await getTestDb()`SELECT approval_status FROM runs WHERE id = ${result.run_id}`;
    expect(run.approval_status).toBe('pending');
    const cards = await getTestDb()`SELECT 1 FROM current_event_records
      WHERE run_id = ${result.run_id} AND interaction_status = 'pending'`;
    expect(cards.length).toBe(1);
  });

  it.each(['public_visitor', 'reply_only'] as const)(
    '%s is refused without creating a run',
    async (chatAccess) => {
      const result = await execute({ background: true }, chatCtx(chatAccess));
      expect(result).toMatchObject({ error: DEVICE_ACCESS_REFUSED });
      expect(await actionRunIds()).toEqual([]);
    },
  );
});
