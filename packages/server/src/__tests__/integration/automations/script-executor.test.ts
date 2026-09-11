import { beforeEach, describe, expect, it } from 'vitest';
import { createAutomationRun, createAutomationEventRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { dispatchPendingAutomationRuns } from '../../../automations/automation';
import { runAutomationScriptTask } from '../../../automations/script-task';
import { reconcileAutomationScriptRuns } from '../../../automations/script-enqueue';
import type { Env } from '../../../index';
import { RunsQueue } from '../../../gateway/infrastructure/queue/runs-queue';
import { TaskScheduler } from '../../../scheduled/task-scheduler';
import { AUTOMATION_SCRIPT_TASK } from '../../../scheduled/task-definitions';
import type { AutomationScriptTaskPayload } from '../../../automations/script-enqueue';
import { assertAutomationScriptExecutor } from '../../../automations/script-config';

const SOURCE = 'export default async (ctx) => ({ run_id: ctx.window.run_id, result: "script result" });';

async function seedScriptAutomation(source = SOURCE) {
  const workspace = await TestWorkspace.create({ name: 'Script Executor Org' });
  const agent = await createTestAgent({
    organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id,
    agentId: 'script-owner', name: 'Script Owner',
  });
  const created = await workspace.owner.automations.create({
    slug: 'script-job', name: 'Script Job', managed_agent_id: agent.agentId,
    triggers: [{ kind: 'schedule', cron: '*/20 * * * *', execution: 'window', active_run: 'coalesce', skip_if_unchanged: false }],
    execution_config: { executor: { kind: 'script', source } },
  } as never) as { automation_id: string };
  return { workspace, agentId: agent.agentId, automationId: Number(created.automation_id) };
}

async function dispatchedScript(source = SOURCE) {
  const seed = await seedScriptAutomation(source);
  const sql = getTestDb();
  const start = '2026-01-01T00:00:00.000Z';
  const end = '2026-01-01T00:20:00.000Z';
  await sql`UPDATE automations SET next_window_start = ${start}::timestamptz, next_run_at = now() - interval '1 hour' WHERE id = ${seed.automationId}`;
  const run = await createAutomationRun({ organizationId: seed.workspace.org.id, agentId: seed.agentId,
    automationId: seed.automationId, windowStart: start, windowEnd: end, dispatchSource: 'scheduled' });
  expect(await dispatchPendingAutomationRuns({ runIds: [run.runId] })).toMatchObject({ dispatched: 1, failed: 0 });
  const [task] = await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
  const taskRunId = Number(task!.id);
  const payload = { organizationId: seed.workspace.org.id, automationId: seed.automationId, sourceRunId: run.runId };
  await sql`UPDATE runs SET status = 'claimed', claimed_by = 'script-fixture', claimed_at = now() WHERE id = ${taskRunId}`;
  return { ...seed, sql, start, end, runId: run.runId, taskRunId, payload };
}

const TEST_ENV = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL } as Env;

describe('Automation script executor', () => {
  beforeEach(async () => { await cleanupTestDatabase(); });

  it('accepts a script as the complete job without a model prompt or reaction', async () => {
    const { automationId } = await seedScriptAutomation();
    expect(automationId).toBeGreaterThan(0);
  });

  it('rejects a source without a default handler before storing the job', async () => {
    await expect(seedScriptAutomation('export const named = () => {};')).rejects.toThrow('default');
  });

  it('rejects clearing the only executable instructions', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    await expect(workspace.owner.automations.update({ automation_id: String(automationId), execution_config: null })).rejects.toThrow('needs instructions');
  });

  it('keeps script-owned windows out of the external processor lane', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    await expect(workspace.owner.automations.claimNextWindow({
      automation_id: String(automationId),
    })).rejects.toThrow('cannot be claimed by an external processor');
    expect(await getTestDb()`SELECT id FROM runs WHERE automation_id = ${automationId}`).toEqual([]);
  });

  it('keeps a pinned script run out of the external lane after its live config changes', async () => {
    const { workspace, agentId, automationId } = await seedScriptAutomation();
    const sql = getTestDb();
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T00:20:00.000Z';
    await sql`UPDATE automations SET next_window_start = ${start}::timestamptz WHERE id = ${automationId}`;
    const run = await createAutomationRun({
      organizationId: workspace.org.id,
      agentId,
      automationId,
      windowStart: start,
      windowEnd: end,
      dispatchSource: 'scheduled',
    });
    await sql`UPDATE automations SET execution_config = NULL WHERE id = ${automationId}`;

    await expect(workspace.owner.automations.claimNextWindow({
      automation_id: String(automationId),
    })).rejects.toThrow('cannot be claimed by an external processor');
    expect((await sql`SELECT status FROM runs WHERE id = ${run.runId}`)[0]?.status).toBe('pending');
  });

  it('manually dispatches without the model gateway and recognizes its runtime claim', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    const first = await workspace.owner.automations.trigger({
      automation_id: String(automationId),
    });
    expect(first).toMatchObject({
      created: true,
      execution: { owner: 'lobu', next_action: { kind: 'handled_elsewhere' } },
    });

    const second = await workspace.owner.automations.trigger({
      automation_id: String(automationId),
    });
    expect(second).toMatchObject({
      run_id: first.run_id,
      created: false,
      execution: { owner: 'lobu', next_action: { kind: 'handled_elsewhere' } },
    });
    const [run] = await getTestDb()`SELECT status, claimed_by FROM runs WHERE id = ${first.run_id}`;
    expect(run).toMatchObject({ status: 'running', claimed_by: 'automation-script' });
  });

  it('rejects agent-only settings when updating a script job', async () => {
    const base = { executionConfig: { executor: { kind: 'script', source: SOURCE } }, agentId: 'synthetic-owner', validateSource: false };
    await expect(assertAutomationScriptExecutor({ ...base,
      executionConfig: { ...base.executionConfig, model: 'provider/model' },
    })).rejects.toThrow('model, CLI, timeout, and finalize settings do not apply');
    await expect(assertAutomationScriptExecutor({ ...base,
      triggers: [{ kind: 'event', output: 'reply_to_source' }],
    })).rejects.toThrow('use silent triggers');
    await expect(assertAutomationScriptExecutor({ ...base, skills: [{ name: 'synthetic' }] })).rejects.toThrow('cannot use agent skills');
    await expect(assertAutomationScriptExecutor({ ...base, deviceWorkerId: 'synthetic-device' })).rejects.toThrow('cannot be pinned');
  });

  it('prevents a script from completing itself before its handler succeeds', async () => {
    const { workspace, sql, automationId, runId, taskRunId, payload, start } = await dispatchedScript();
    const content = await workspace.owner.knowledge.read({ automation_id: automationId, run_id: runId }) as { window_token: string };
    await expect(workspace.owner.automations.completeWindow({ automation_id: String(automationId), run_id: runId,
      window_token: content.window_token, extracted_data: {} })).rejects.toThrow('runtime completes script Automations');
    const [automation] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
  });

  it('pins the script when creating a run so later edits cannot change a retry', async () => {
    const { workspace, agentId, automationId } = await seedScriptAutomation();
    const sql = getTestDb();
    const run = await createAutomationRun({
      organizationId: workspace.org.id, agentId, automationId,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual',
    });
    await sql`UPDATE automations SET execution_config = ${sql.json({ executor: { kind: 'script', source: 'export default async () => ({ changed: true });' } })} WHERE id = ${automationId}`;
    const [stored] = await sql`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(stored!.approved_input.executor).toEqual({ kind: 'script', source: SOURCE });
  });

  it('executes the pinned script in an isolate and completes without producing a model turn', async () => {
    const { sql, automationId, runId, taskRunId, payload, end } = await dispatchedScript();
    await sql`UPDATE automations SET execution_config = NULL WHERE id = ${automationId}`;
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
    const [run] = await sql`SELECT status, action_output, model_used FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({ status: 'completed', action_output: { run_id: runId, result: 'script result' }, model_used: 'script' });
    const [automation] = await sql`SELECT next_window_start, consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(end);
    expect(Number(automation!.consecutive_scheduled_failures)).toBe(0);
    expect(await sql`SELECT id FROM runs WHERE run_type IN ('agent_run', 'agent_turn')`).toEqual([]);
    // A queue replay after the source commit cannot repeat the script.
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
    const [again] = await sql`SELECT action_output FROM runs WHERE id = ${runId}`;
    expect(again!.action_output).toEqual(run!.action_output);
  });

  it('accepts no return value as an empty action output', async () => {
    const noValue = await dispatchedScript('export default async () => {};');
    await runAutomationScriptTask(noValue.payload, TEST_ENV, noValue.taskRunId);
    const [completed] = await noValue.sql`SELECT status, action_output FROM runs WHERE id = ${noValue.runId}`;
    expect(completed).toMatchObject({ status: 'completed', action_output: {} });
  });

  it('rejects an explicit null return as a deterministic validation failure', async () => {
    const explicitNull = await dispatchedScript('export default async () => null;');
    await runAutomationScriptTask(explicitNull.payload, TEST_ENV, explicitNull.taskRunId);
    const [failed] = await explicitNull.sql`SELECT status, error_message FROM runs WHERE id = ${explicitNull.runId}`;
    expect(failed).toMatchObject({
      status: 'failed',
      error_message: 'ValidationError: Automation scripts must return an object or no value.',
    });
  });

  it('is claimed and settled by the real durable task queue', async () => {
    const { sql, runId, taskRunId } = await dispatchedScript();
    await sql`UPDATE runs SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ${taskRunId}`;
    const queue = new RunsQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register(AUTOMATION_SCRIPT_TASK, async (ctx) => {
      await runAutomationScriptTask(ctx.payload as AutomationScriptTaskPayload, TEST_ENV, ctx.taskRunId, ctx.attempt);
    });
    try {
      await queue.start();
      await scheduler.start();
      await expect.poll(async () => (await sql`SELECT status FROM runs WHERE id = ${taskRunId}`)[0]?.status, { timeout: 5000 }).toBe('completed');
      expect((await sql`SELECT status FROM runs WHERE id = ${runId}`)[0]?.status).toBe('completed');
    } finally {
      scheduler.stop();
      await queue.stop();
    }
  });

  it.each(['window', 'turn'] as const)('executes an event %s with its pinned signal and params without advancing the arrival mark', async (execution) => {
    const { workspace, automationId, agentId } = await seedScriptAutomation('export default async (ctx, _client, params) => ({ signal: ctx.trigger_signals[0].delivery_id, value: params.value });');
    const sql = getTestDb();
    const start = '2026-01-01T00:00:00.000Z';
    await sql`UPDATE automations SET next_window_start = ${start}::timestamptz,
      execution_config = jsonb_set(execution_config, '{executor,params}', ${sql.json({ value: 'pinned' })}::jsonb) WHERE id = ${automationId}`;
    const queued = await createAutomationEventRun({
      organizationId: workspace.org.id, automationId, agentId,
      trigger: { kind: 'event', connector_key: 'github', event_types: ['pull_request.created'], execution, output: 'silent' },
      signal: { connector_key: 'github', event_type: 'pull_request.created', delivery_id: 'synthetic-delivery', label: 'Test event', input_text: 'Synthetic event' },
    });
    expect(queued.runId).toBeTruthy();
    await sql`UPDATE automations SET execution_config = jsonb_set(execution_config, '{executor,params}', ${sql.json({ value: 'changed' })}::jsonb) WHERE id = ${automationId}`;
    await dispatchPendingAutomationRuns({ runIds: [queued.runId!] });
    const [task] = await sql`UPDATE runs SET status = 'claimed', claimed_by = 'event-fixture', claimed_at = now()
      WHERE parent_run_id = ${queued.runId} AND action_key = 'automation-script' RETURNING id`;
    await runAutomationScriptTask({ organizationId: workspace.org.id, automationId, sourceRunId: queued.runId! }, TEST_ENV, Number(task!.id));
    const [run] = await sql`SELECT status, action_output FROM runs WHERE id = ${queued.runId}`;
    expect(run).toMatchObject({ status: 'completed', action_output: { signal: 'synthetic-delivery', value: 'pinned' } });
    const [automation] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
  });

  it('leaves the arrival cursor untouched through transient retries and terminal failure', async () => {
    const { sql, automationId, runId, taskRunId, payload, start } = await dispatchedScript('export default async () => { throw new Error("synthetic upstream failure"); };');
    await expect(runAutomationScriptTask(payload, TEST_ENV, taskRunId, 1)).rejects.toThrow('synthetic upstream failure');
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId, 3);
    const [run] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({ status: 'failed', error_message: expect.stringContaining('synthetic upstream failure') });
    const [automation] = await sql`SELECT next_window_start, consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
    expect(Number(automation!.consecutive_scheduled_failures)).toBe(1);
  });

  it('settles a crashed and exhausted child task without stranding its parent', async () => {
    const { sql, automationId, runId, taskRunId, start } = await dispatchedScript();
    await sql`UPDATE runs SET status = 'failed', error_message = 'synthetic crashed task' WHERE id = ${taskRunId}`;
    expect(await reconcileAutomationScriptRuns()).toBe(1);
    expect(await reconcileAutomationScriptRuns()).toBe(0);
    const [run] = await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({ status: 'failed', error_message: 'synthetic crashed task' });
    const [automation] = await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
  });
});
