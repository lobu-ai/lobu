import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { materializeDueAutomationRuns, dispatchPendingAutomationRuns } from '../../../automations/automation';
import { handleListActivity } from '../../../tools/admin/manage_operations/handlers/runs';
import { handleClaimNextWindow } from '../../../tools/admin/manage_automations/claim-next-window';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import type { Env } from '../../../index';
import { handleAutomationMode } from '../../../tools/get_content/automation-mode';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import { createAutomationRun } from '../../../runs/queue-service';

const ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const EXTERNAL = { executor: { kind: 'external' } };
const SCHEDULE = [{ kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' }];

describe('external Automation activity', () => {
  let sql: DbClient;
  let api: TestApiClient;
  let ctx: ToolContext;
  let agentId: string;

  beforeAll(async () => { await initWorkspaceProvider(); });
  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    ctx = seeded.ctx;
    sql = getTestDb() as unknown as DbClient;
    agentId = (await createTestAgent({ organizationId: ctx.organizationId!, ownerUserId: seeded.user.id })).agentId;
    api = await TestApiClient.for({ organizationId: seeded.org.id, userId: seeded.user.id, memberRole: 'owner' });
  });

  async function createExternal(overrides: Record<string, unknown> = {}) {
    const created = await api.automations.create({
      slug: 'synthetic-external-attention', name: 'Synthetic external attention',
      prompt: 'Review the window and complete it.',
      managed_agent_id: agentId,
      execution_config: EXTERNAL, triggers: SCHEDULE,
      sources: [{ name: 'content', query: 'SELECT id, occurred_at FROM events WHERE FALSE ORDER BY occurred_at DESC, id DESC' }],
      outputs: { signals: { event: 'observation' } },
      ...overrides,
    } as never) as { automation_id: string };
    await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '1 minute', next_window_start = NOW() - INTERVAL '1 hour' WHERE id = ${Number(created.automation_id)}`;
    return created.automation_id;
  }

  async function work(caller = ctx) {
    const result = await handleListActivity({ action: 'list_activity', kinds: ['automation_due'], limit: 5 }, caller);
    return (result as { items: Array<Record<string, any>> }).items;
  }

  it('advertises scheduled external work without starting the owning managed agent, and completion clears due work', async () => {
    const id = await createExternal();
    const materialized = await materializeDueAutomationRuns(ENV, sql, Number(id));
    expect(materialized).toMatchObject({ runsCreated: 0, unrunnable: 0 });
    expect((await dispatchPendingAutomationRuns({ db: sql })).claimed).toBe(0);
    const items = await work();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ automation_id: Number(id), status: 'due', next_action: {
      method: 'automations.claimNextWindow', input: { automation_id: id },
    } });
    const claim = await api.automations.claimNextWindow({ automation_id: id });
    const own = await work();
    expect(own[0]).toMatchObject({ status: 'running', run_id: claim.run_id, next_action: {
      method: 'automations.claimNextWindow', input: { automation_id: id, run_id: claim.run_id },
    } });
    expect(await work({ ...ctx, clientId: 'synthetic-other-client' })).toEqual([]);
    await api.automations.completeWindow({ automation_id: id, run_id: claim.run_id,
      window_token: claim.context.window_token, extracted_data: { signals: [] } });
    expect(await work()).toEqual([]);
    const [state] = await sql`SELECT next_run_at > NOW() AS future, next_window_start FROM automations WHERE id = ${Number(id)}`;
    expect(state.future).toBe(true);
    expect(new Date(state.next_window_start).toISOString()).toBe(claim.context.window_end);
  });

  it('allows an external schedule without a managed executor and returns nothing before it is due', async () => {
    const id = await createExternal({ managed_agent_id: null });
    expect(await work()).toHaveLength(1);
    await sql`UPDATE automations SET next_run_at = NOW() + INTERVAL '1 hour' WHERE id = ${Number(id)}`;
    expect(await work()).toEqual([]);
    await expect(api.automations.claimNextWindow({ automation_id: id })).rejects.toThrow(/not due/);
  });

  it('isolates workspaces and excludes hosted schedules', async () => {
    const id = await createExternal();
    const other = await seedOwnerContext({ orgName: 'Synthetic other workspace' });
    expect(await work(other.ctx)).toEqual([]);
    await sql`UPDATE automations SET execution_config = NULL WHERE id = ${Number(id)}`;
    expect(await work()).toEqual([]);
  });

  it('offers an expired claim again, with the old completion still fenced', async () => {
    const id = await createExternal();
    const claim = await api.automations.claimNextWindow({ automation_id: id });
    await sql`UPDATE runs SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${claim.run_id}`;
    expect((await work({ ...ctx, clientId: 'synthetic-next-client' }))[0]).toMatchObject({ status: 'due' });
    const next = await handleClaimNextWindow({ action: 'claim_next_window', automation_id: id } as never, ENV,
      { ...ctx, clientId: 'synthetic-next-client' });
    expect(next.context.window_start).toBe(claim.context.window_start);
    await expect(api.automations.completeWindow({ automation_id: id, run_id: claim.run_id,
      window_token: claim.context.window_token, extracted_data: { signals: [] } })).rejects.toThrow();
  });

  it.each([
    { agent_kind: 'codex' },
    { device_worker_id: '99999999-8888-7777-6666-555555555555' },
    { execution_config: { ...EXTERNAL, model: 'auto' } },
    { triggers: [{ kind: 'event', source: 'workspace', event_types: ['connection.deleted'] }] },
  ])('rejects incompatible external settings %j', async (overrides) => {
    await expect(createExternal(overrides)).rejects.toThrow();
  });

  it('returns due work through read-only activity despite newer completed history', async () => {
    const id = await createExternal();
    await sql`INSERT INTO runs (organization_id, run_type, automation_id, status, created_at)
      SELECT ${ctx.organizationId!}, 'automation', ${Number(id)}, 'completed', NOW()
      FROM generate_series(1, 70)`;
    const reader = await TestApiClient.for({ organizationId: ctx.organizationId!, userId: ctx.userId!,
      memberRole: 'owner', scopes: ['mcp:read'] });
    const result = await reader.operations.listActivity({ limit: 1 }) as { items: Array<{ kind: string }> };
    expect(result.items[0].kind).toBe('automation_due');
    const excluded = await reader.operations.listActivity({ include_runs: false }) as { items: unknown[] };
    expect(excluded.items).toEqual([]);
    const [counts] = await sql`SELECT COUNT(*)::int AS count FROM runs WHERE automation_id = ${Number(id)}`;
    expect(counts.count).toBe(70);
  });

  it.each([true, false])('keeps manual external handoff out of hosted dispatch and completes it (owner=%s)', async (hasOwner) => {
    const id = await createExternal({ triggers: [], managed_agent_id: hasOwner ? agentId : null });
    const result = await api.automations.trigger({ automation_id: id });
    expect(result.execution.lane).toBe('external_client');
    expect((await dispatchPendingAutomationRuns({ db: sql, runIds: [result.run_id] })).claimed).toBe(0);
    expect((await work())[0]).toMatchObject({ run_id: result.run_id, status: 'due' });
    const [snapshot] = await sql`SELECT approved_input FROM runs WHERE id = ${result.run_id}`;
    expect(snapshot.approved_input.agent_id ?? null).toBe(hasOwner ? agentId : null);
    const content = await handleAutomationMode({ automation_id: Number(id), run_id: result.run_id }, ENV, sql, { ...ctx, organizationId: ctx.organizationId!, userId: ctx.userId ?? null });
    await handleCompleteWindow({ action: 'complete_window', automation_id: id, run_id: result.run_id,
      window_token: content.window_token, extracted_data: { signals: [] } } as never, ENV, ctx);
    expect(await work()).toEqual([]);
  });

  it('keeps a frozen external claim resumable after live config changes to hosted', async () => {
    const id = await createExternal();
    const claim = await api.automations.claimNextWindow({ automation_id: id });
    await api.automations.update({ automation_id: id, execution_config: null });
    expect((await work())[0]).toMatchObject({ status: 'running', run_id: claim.run_id });
    const continued = await api.automations.claimNextWindow({ automation_id: id, run_id: claim.run_id });
    await api.automations.completeWindow({ automation_id: id, run_id: claim.run_id,
      window_token: continued.context.window_token, extracted_data: { signals: [] } });
    expect(await work()).toEqual([]);
  });

  it('does not advertise an existing hosted snapshot after live config changes to external', async () => {
    const id = await createExternal({ execution_config: null });
    const run = await createAutomationRun({ organizationId: ctx.organizationId!, automationId: Number(id),
      agentId, dispatchSource: 'manual', windowStart: new Date(Date.now() - 3600_000).toISOString(),
      windowEnd: new Date(Date.now() - 60_000).toISOString() }, sql);
    await api.automations.update({ automation_id: id, execution_config: EXTERNAL } as never);
    expect(await work()).toEqual([]);
    const [snapshot] = await sql`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(snapshot.approved_input.executor).toBeUndefined();
  });

  it.each([EXTERNAL, null])('uses the frozen owner for pending work after reassignment (config=%j)', async (executionConfig) => {
    const id = await createExternal({ triggers: [] });
    const run = await api.automations.trigger({ automation_id: id });
    const replacement = await createTestAgent({ organizationId: ctx.organizationId!, ownerUserId: ctx.userId! });
    await api.automations.update({ automation_id: id, managed_agent_id: replacement.agentId,
      execution_config: executionConfig } as never);
    const original = { ...ctx, agentId };
    const other = { ...ctx, agentId: replacement.agentId };
    expect((await work(original))[0]).toMatchObject({ run_id: run.run_id, status: 'due' });
    expect(await work(other)).toEqual([]);
    await expect(handleClaimNextWindow({ action: 'claim_next_window', automation_id: id } as never,
      ENV, other)).rejects.toThrow(/another agent/);
    const claim = await handleClaimNextWindow({ action: 'claim_next_window', automation_id: id } as never,
      ENV, original);
    expect(claim.run_id).toBe(run.run_id);
    await handleCompleteWindow({ action: 'complete_window', automation_id: id, run_id: claim.run_id,
      window_token: claim.context.window_token, extracted_data: { signals: [] } } as never, ENV, original);
    expect(await work(original)).toEqual([]);
  });

  it('keeps a pending ownerless snapshot open after assigning a live owner', async () => {
    const id = await createExternal({ triggers: [], managed_agent_id: null });
    const run = await api.automations.trigger({ automation_id: id });
    await api.automations.update({ automation_id: id, managed_agent_id: agentId });
    const other = { ...ctx, agentId: 'synthetic-other-agent' };
    expect((await work(other))[0]).toMatchObject({ run_id: run.run_id, status: 'due' });
    const claim = await handleClaimNextWindow({ action: 'claim_next_window', automation_id: id } as never,
      ENV, other);
    expect(claim.run_id).toBe(run.run_id);
  });

  it('does not let another agent bypass the owner check through direct completion', async () => {
    const id = await createExternal({ triggers: [] });
    const run = await api.automations.trigger({ automation_id: id });
    const other = { ...ctx, organizationId: ctx.organizationId!, userId: ctx.userId ?? null,
      agentId: 'synthetic-other-agent' };
    const content = await handleAutomationMode({ automation_id: Number(id), run_id: run.run_id }, ENV, sql, other);
    await expect(handleCompleteWindow({ action: 'complete_window', automation_id: id, run_id: run.run_id,
      window_token: content.window_token, extracted_data: { signals: [] } } as never, ENV, other)).rejects.toThrow(/another agent/);
    const [state] = await sql`SELECT status FROM runs WHERE id = ${run.run_id}`;
    expect(state.status).toBe('pending');
  });

  it('validates updates and versioned trigger changes against the external executor', async () => {
    const id = await createExternal();
    const triggers = [{ kind: 'event', source: 'workspace', event_types: ['connection.deleted'] }];
    await expect(api.automations.update({ automation_id: id, agent_kind: 'codex' })).rejects.toThrow(/external/);
    await expect(api.automations.createVersion({ automation_id: id, triggers } as never)).rejects.toThrow(/external/);
    const [row] = await sql`SELECT execution_config, triggers FROM automations WHERE id = ${Number(id)}`;
    expect(row.execution_config).toEqual(EXTERNAL);
    expect(row.triggers[0].kind).toBe('schedule');
  });

  it('uses authenticated identity, not the agent display filter, for claims', async () => {
    const id = await createExternal();
    const other = { ...ctx, agentId: 'synthetic-other-agent' };
    expect(await work(other)).toEqual([]);
    const result = await handleListActivity({ action: 'list_activity', agent_id: agentId, kinds: ['automation_due'] }, other);
    expect((result as { items: unknown[] }).items).toEqual([]);
    await expect(handleClaimNextWindow({ action: 'claim_next_window', automation_id: id } as never, ENV, other)).rejects.toThrow(/another agent/);
  });
});
