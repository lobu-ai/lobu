import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAutomationRun,
  createAutomationEventRun,
} from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestConnection,
  createTestEvent,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';
import { dispatchPendingAutomationRuns } from '../../../automations/automation';
import { runAutomationReactionTask } from '../../../automations/reaction-task';
import { runAutomationScriptTask } from '../../../automations/script-task';
import { enqueueAutomationScript, reconcileAutomationScriptRuns } from '../../../automations/script-enqueue';
import type { Env } from '../../../index';
import { RunsQueue } from '../../../gateway/infrastructure/queue/runs-queue';
import { TaskScheduler } from '../../../scheduled/task-scheduler';
import { AUTOMATION_PREPARATION_TASK, AUTOMATION_SCRIPT_TASK } from '../../../scheduled/task-definitions';
import type { AutomationScriptTaskPayload } from '../../../automations/script-enqueue';
import { assertAutomationScriptExecutor } from '../../../automations/script-config';
import { runAutomationPreparationTask, reconcileAutomationPreparationRuns } from '../../../automations/preparation-task';
import { claimPendingAutomationRun } from '../../../runs/queue-service';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';

const SOURCE =
  'export default async (ctx) => ({ run_id: ctx.window.run_id, result: "script result" });';

const MEMBER_PROBE_EMAIL = 'probe-member@test.example.com';
const AUDIT_PROBE_TITLE = 'Synthetic workspace audit row';

// Every member-data read a script can make, each reporting its own denial so
// one failure does not hide the others.
const MEMBER_READ_PROBE = `export default async (_ctx, client) => {
  const read = async (fn) => {
    try { return { ...(await fn()), error: null }; }
    catch (error) { return { error: String(error?.message ?? error) }; }
  };
  return {
    list: await read(async () => {
      const { entities } = await client.entities.list({ entity_type: '$member', limit: 50 });
      const probe = entities.filter((e) => e.name === 'Probe Member');
      return { names: probe.map((e) => e.name), emails: probe.map((e) => e.metadata.email).filter(Boolean) };
    }),
    memberRows: await read(async () => {
      const rows = await client.query("SELECT metadata FROM entities WHERE entity_type = '$member' AND name = 'Probe Member'");
      return { emails: rows.map((r) => r.metadata.email).filter(Boolean) };
    }),
    auditRows: await read(async () => {
      const rows = await client.query("SELECT title FROM events WHERE title = '${AUDIT_PROBE_TITLE}'");
      return { titles: rows.map((r) => r.title) };
    }),
    users: await read(async () => {
      const rows = await client.query('SELECT * FROM "user"');
      return { withheldEmail: rows.some((r) => 'email' in r) };
    }),
  };
};`;

async function seedScriptAutomation(source = SOURCE) {
  const workspace = await TestWorkspace.create({ name: 'Script Executor Org' });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: 'script-owner',
    name: 'Script Owner',
  });
  const created = (await workspace.owner.automations.create({
    slug: 'script-job',
    name: 'Script Job',
    managed_agent_id: agent.agentId,
    triggers: [
      {
        kind: 'schedule',
        cron: '*/20 * * * *',
        execution: 'window',
        active_run: 'coalesce',
        skip_if_unchanged: false,
      },
    ],
    prompt: 'Legacy fixture',
  } as never)) as { automation_id: string };
  await assertAutomationScriptExecutor({ executionConfig: { executor: { kind: 'script', source } }, agentId: agent.agentId });
  const sql = getTestDb();
  await sql`UPDATE automations SET execution_config = ${sql.json({ executor: { kind: 'script', source } })} WHERE id = ${Number(created.automation_id)}`;
  await sql`UPDATE automation_versions SET prompt = '' WHERE automation_id = ${Number(created.automation_id)}`;
  return {
    workspace,
    agentId: agent.agentId,
    automationId: Number(created.automation_id),
  };
}

async function dispatchedScript(source = SOURCE) {
  const seed = await seedScriptAutomation(source);
  const sql = getTestDb();
  const start = '2026-01-01T00:00:00.000Z';
  const end = '2026-01-01T00:20:00.000Z';
  await sql`UPDATE automations SET next_window_start = ${start}::timestamptz, next_run_at = now() - interval '1 hour' WHERE id = ${seed.automationId}`;
  const run = await createAutomationRun({
    organizationId: seed.workspace.org.id,
    agentId: seed.agentId,
    automationId: seed.automationId,
    windowStart: start,
    windowEnd: end,
    dispatchSource: 'scheduled',
  });
  expect(
    await dispatchPendingAutomationRuns({ runIds: [run.runId] })
  ).toMatchObject({ dispatched: 1, failed: 0 });
  const [task] =
    await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
  const taskRunId = Number(task!.id);
  const payload = {
    organizationId: seed.workspace.org.id,
    automationId: seed.automationId,
    sourceRunId: run.runId,
  };
  await sql`UPDATE runs SET status = 'claimed', claimed_by = 'script-fixture', claimed_at = now() WHERE id = ${taskRunId}`;
  return { ...seed, sql, start, end, runId: run.runId, taskRunId, payload };
}

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
} as Env;

async function seedPreparedAutomation(source: string) {
  const workspace = await TestWorkspace.create({ name: 'Preparation Org' });
  const agent = await createTestAgent({ organizationId: workspace.org.id, ownerUserId: workspace.users.owner.id, agentId: 'prepared-owner', name: 'Prepared Owner' });
  const created = await workspace.owner.automations.create({
    slug: 'prepared-agent', name: 'Prepared Agent', prompt: 'Analyze the saved finance_snapshot source.',
    managed_agent_id: agent.agentId, reaction_script: source,
  } as never) as { automation_id: string };
  const automationId = Number(created.automation_id);
  const run = await createAutomationRun({ organizationId: workspace.org.id, automationId, agentId: agent.agentId, windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual' });
  const sql = getTestDb();
  const [task] = await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-preparation'`;
  const taskRunId = Number(task?.id);
  const payload = { organizationId: workspace.org.id, automationId, sourceRunId: run.runId };
  const prepare = async (attempt = 1) => {
    await sql`UPDATE runs SET status = 'claimed', claimed_by = 'preparation-fixture', claimed_at = now() WHERE id = ${taskRunId}`;
    await runAutomationPreparationTask(payload, TEST_ENV, taskRunId, attempt);
  };
  return { workspace, automationId, runId: run.runId, taskRunId, sql, prepare, payload };
}

describe('Automation script executor', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each([
    ['default', 'export default async (ctx) => ({ result: "code only", saved: ctx.sources ?? {} });'],
    ['prepare', 'export async function prepare() { return { snapshot: [{ total: 42 }] }; }'],
    ['both', 'export async function prepare() { return { snapshot: [{ total: 42 }] }; } export default async (ctx) => ({ total: ctx.sources.snapshot[0].total });'],
  ])('runs a %s module without admitting a model or invoking default twice', async (slug, source) => {
    const { workspace, agentId } = await seedScriptAutomation();
    const created = await workspace.owner.automations.create({
      slug: `module-${slug}`, name: 'Code Module', managed_agent_id: agentId,
      reaction_script: source,
    } as never) as { automation_id: string };
    const automationId = Number(created.automation_id);
    await getTestDb()`UPDATE automations SET next_window_start = '2026-01-01'::timestamptz WHERE id = ${automationId}`;
    await expect(workspace.owner.automations.claimNextWindow({ automation_id: String(automationId) })).rejects.toThrow('cannot be claimed by an external processor');
    expect(await getTestDb()`SELECT id FROM runs WHERE automation_id = ${automationId}`).toEqual([]);
    const run = await createAutomationRun({ organizationId: workspace.org.id, automationId, agentId, windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual' });
    const sql = getTestDb();
    const payload = { organizationId: workspace.org.id, automationId, sourceRunId: run.runId };
    if (slug !== 'default') {
      const [prep] = await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-preparation'`;
      await sql`UPDATE runs SET status = 'claimed' WHERE id = ${prep!.id}`;
      await runAutomationPreparationTask(payload, TEST_ENV, Number(prep!.id));
    }
    expect(await dispatchPendingAutomationRuns({ runIds: [run.runId] })).toMatchObject({ dispatched: 1, failed: 0 });
    const [task] = await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
    expect(task).toBeDefined();
    await sql`UPDATE runs SET status = 'claimed' WHERE id = ${task!.id}`;
    await runAutomationScriptTask(payload, TEST_ENV, Number(task!.id));
    await runAutomationScriptTask(payload, TEST_ENV, Number(task!.id));
    const [stored] = await sql`SELECT status, model_used, action_output, run_metadata FROM runs WHERE id = ${run.runId}`;
    expect(stored).toMatchObject({ status: 'completed', model_used: 'script' });
    if (slug === 'both') expect(stored!.action_output).toEqual({ total: 42 });
    if (slug !== 'default') expect(stored!.run_metadata.preparation_sources).toEqual({ snapshot: [{ total: 42 }] });
    expect(await sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-reaction'`).toEqual([]);
  });

  it.each(['script', 'external'])('rejects retired %s authoring atomically with 422', async (kind) => {
    const { workspace, automationId, agentId } = await seedScriptAutomation();
    const executor = kind === 'script' ? { kind, source: SOURCE } : { kind };
    await expect(workspace.owner.automations.create({ slug: 'retired', name: 'Retired', managed_agent_id: agentId, execution_config: { executor } } as never)).rejects.toMatchObject({ httpStatus: 422 });
    await expect(workspace.owner.automations.update({ automation_id: String(automationId), execution_config: { executor } } as never)).rejects.toMatchObject({ httpStatus: 422 });
    expect(await getTestDb()`SELECT id FROM automations WHERE slug = 'retired'`).toEqual([]);
  });

  it.each([{ model: 'auto' }, { timeout_seconds: 120 }, { permission_mode: 'default' }])('rejects agent-only options on code modules at create and update (%j)', async (executionConfig) => {
    const { workspace, agentId } = await seedScriptAutomation();
    await expect(workspace.owner.automations.create({ slug: 'invalid-code', name: 'Invalid', managed_agent_id: agentId, reaction_script: SOURCE, execution_config: executionConfig } as never)).rejects.toMatchObject({ httpStatus: 422 });
    const created = await workspace.owner.automations.create({ slug: 'valid-code', name: 'Valid', managed_agent_id: agentId, reaction_script: SOURCE } as never) as { automation_id: string };
    await expect(workspace.owner.automations.update({ automation_id: created.automation_id, execution_config: executionConfig } as never)).rejects.toMatchObject({ httpStatus: 422 });
    const [stored] = await getTestDb()`SELECT execution_config FROM automations WHERE id = ${Number(created.automation_id)}`;
    expect(stored!.execution_config).toBeNull();
  });

  it('accepts a preparation-only module on a native agent Automation', async () => {
    const { workspace, agentId } = await seedScriptAutomation();
    const created = await workspace.owner.automations.create({
      slug: 'prepared-agent',
      name: 'Prepared Agent',
      prompt: 'Read the saved finance_snapshot source and summarize it.',
      managed_agent_id: agentId,
      reaction_script: 'export async function prepare(ctx) { return { finance_snapshot: [{ run_id: ctx.window.run_id, total: 42 }] }; }',
    } as never) as { automation_id: string };
    expect(Number(created.automation_id)).toBeGreaterThan(0);
  });

  it('gates native execution, saves calculated sources and pages the frozen result', async () => {
    const seed = await seedPreparedAutomation(`export async function prepare(ctx, client) {
      const rows = await client.query('SELECT 19 + 23 AS total');
      return { finance_snapshot: [{ ...rows[0], run_id: ctx.window.run_id }, { total: 84 }, { total: 126 }] };
    }`);
    const claim = () => seed.sql.begin(tx => claimPendingAutomationRun(tx, { runId: seed.runId, automationId: seed.automationId, claimedBy: 'native-fixture', status: 'running' }));
    expect(await claim()).toBe(false);
    await expect(seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId })).rejects.toThrow('preparation is not ready');
    await seed.prepare();
    await expect(seed.workspace.owner.automations.claimNextWindow({ automation_id: String(seed.automationId) })).rejects.toThrow('cannot be claimed by an external processor');
    expect(await claim()).toBe(true);
    const first = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId, limit: 1 }) as any;
    expect(first.sources.finance_snapshot).toEqual([{ total: 42, run_id: seed.runId }]);
    expect(first.sources_page.finance_snapshot).toMatchObject({ returned: 1, has_more: true });
    const next = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId, limit: 1, source_name: 'finance_snapshot', source_cursor: first.sources_page.finance_snapshot.next_cursor }) as any;
    expect(next.sources.finance_snapshot).toEqual([{ total: 84 }]);
    const last = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId, limit: 1, source_name: 'finance_snapshot', source_cursor: next.sources_page.finance_snapshot.next_cursor }) as any;
    expect(last.sources.finance_snapshot).toEqual([{ total: 126 }]);
    expect(last.sources_page.finance_snapshot.has_more).toBe(false);
    await expect(seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId + 1000, source_name: 'finance_snapshot', source_cursor: first.sources_page.finance_snapshot.next_cursor })).rejects.toThrow();
  });

  it('freezes preparation code at activation and reuses successful preparation', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return { finance_snapshot: [{ total: 42 }] }; }');
    await seed.workspace.owner.automations.setReactionScript({ automation_id: String(seed.automationId), reaction_script: 'export async function prepare() { throw new Error("replacement must not run"); }' });
    await seed.prepare();
    await seed.prepare();
    const [run] = await seed.sql`SELECT status, run_metadata FROM runs WHERE id = ${seed.runId}`;
    expect(run.status).toBe('pending');
    expect(run.run_metadata.preparation_sources).toEqual({ finance_snapshot: [{ total: 42 }] });
    await seed.workspace.owner.automations.setReactionScript({ automation_id: String(seed.automationId), reaction_script: '' });
    const read = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId }) as any;
    expect(read.sources.finance_snapshot).toEqual([{ total: 42 }]);
  });

  it.each(['null', '[]', '{ content: [] }', '{ finance_snapshot: [1] }', '{ finance_snapshot: [{ text: "x".repeat(20000) }] }', '{ finance_snapshot: [{ payload_text: "x".repeat(5000), content_length: 1 }] }'])(
    'fails preparation closed for invalid or colliding result %s', async (result) => {
      const seed = await seedPreparedAutomation(`export async function prepare() { return ${result}; }`);
      await seed.prepare();
      const [run] = await seed.sql`SELECT status, run_metadata FROM runs WHERE id = ${seed.runId}`;
      expect(run.status).toBe('failed');
      expect(run.run_metadata.preparation_sources).toBeUndefined();
    },
  );

  it('reconciles an exhausted preparation task without advancing arrival progress', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return {}; }');
    const [before] = await seed.sql`SELECT next_window_start FROM automations WHERE id = ${seed.automationId}`;
    await seed.sql`UPDATE runs SET status = 'failed', error_message = 'preparation fixture exhausted' WHERE id = ${seed.taskRunId}`;
    await reconcileAutomationPreparationRuns(seed.sql);
    const [run] = await seed.sql`SELECT status, error_message FROM runs WHERE id = ${seed.runId}`;
    expect(run).toMatchObject({ status: 'failed', error_message: 'preparation fixture exhausted' });
    const [after] = await seed.sql`SELECT next_window_start FROM automations WHERE id = ${seed.automationId}`;
    expect(after.next_window_start).toEqual(before.next_window_start);
  });

  it('completes a preparation-only window without queuing a reaction', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return { finance_snapshot: [{ total: 42 }] }; }');
    await seed.prepare();
    expect(await seed.sql.begin(tx => claimPendingAutomationRun(tx, { runId: seed.runId, automationId: seed.automationId, claimedBy: 'native-fixture', status: 'running' }))).toBe(true);
    const read = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId }) as { window_token: string };
    await seed.workspace.owner.automations.completeWindow({ automation_id: String(seed.automationId), run_id: seed.runId, window_token: read.window_token, extracted_data: { summary: 'Verified total: 42' }, run_metadata: { preparation_sources: { forged: [] } } });
    const [run] = await seed.sql`SELECT status, run_metadata, action_output FROM runs WHERE id = ${seed.runId}`;
    expect(run.status).toBe('completed');
    expect(run.action_output).toEqual({ summary: 'Verified total: 42' });
    expect(run.run_metadata.preparation_sources).toEqual({ finance_snapshot: [{ total: 42 }] });
    expect(await seed.sql`SELECT id FROM runs WHERE parent_run_id = ${seed.runId} AND action_key = 'automation-reaction'`).toEqual([]);
  });

  it('uses the frozen schema and completion handler with the same saved sources', async () => {
    const seed = await seedPreparedAutomation(`
      export const input = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] };
      export async function prepare() { return { finance_snapshot: [{ total: 42 }] }; }
      export default async function reaction(ctx, client) {
        await client.knowledge.save({ semantic_type: 'note', title: 'preparation-echo', content: JSON.stringify({ sources: ctx.sources, answer: ctx.extracted_data.answer, version: ctx.automation.version }) });
      }
    `);
    await seed.prepare();
    await seed.workspace.owner.automations.setReactionScript({ automation_id: String(seed.automationId), reaction_script: `export const input = { type: 'object', properties: { replacement: { type: 'string' } }, required: ['replacement'] }; export default async function reaction() { throw new Error('replacement must not execute'); }` });
    await seed.workspace.owner.automations.createVersion({ automation_id: String(seed.automationId), prompt: 'Edited instructions', set_as_current: true });
    expect(await seed.sql.begin(tx => claimPendingAutomationRun(tx, { runId: seed.runId, automationId: seed.automationId, claimedBy: 'native-fixture', status: 'running' }))).toBe(true);
    const read = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId }) as { window_token: string; extraction_schema: { required: string[] } };
    expect(read.extraction_schema.required).toContain('answer');
    await seed.workspace.owner.automations.completeWindow({ automation_id: String(seed.automationId), run_id: seed.runId, window_token: read.window_token, extracted_data: { answer: 42 } });
    const [task] = await seed.sql`SELECT id FROM runs WHERE parent_run_id = ${seed.runId} AND action_key = 'automation-reaction'`;
    expect(await runAutomationReactionTask(seed.payload, TEST_ENV, Number(task.id))).toEqual({ status: 'success' });
    const [echo] = await seed.sql`SELECT payload_text FROM events WHERE organization_id = ${seed.workspace.org.id} AND title = 'preparation-echo'`;
    expect(JSON.parse(echo.payload_text)).toEqual({ sources: { finance_snapshot: [{ total: 42 }] }, answer: 42, version: 1 });
  });

  it('does not start analysis when a preparation write awaits approval', async () => {
    const seed = await seedPreparedAutomation(`export async function prepare(ctx, client) {
      await client.automations.update({ automation_id: String(ctx.automation.id), tags: ['approval-fixture'] });
      return { finance_snapshot: [{ total: 42 }] };
    }`);
    await seed.prepare();
    const [run] = await seed.sql`SELECT status, error_message, run_metadata FROM runs WHERE id = ${seed.runId}`;
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain('awaits approval');
    expect(run.run_metadata.preparation_sources).toBeUndefined();
    const approvals = await seed.sql`SELECT id FROM runs WHERE organization_id = ${seed.workspace.org.id} AND approval_status = 'pending' AND status = 'pending'`;
    expect(approvals.length).toBeGreaterThan(0);
  });

  it('rejects switching preparation to a reply turn or external executor', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return {}; }');
    await expect(seed.workspace.owner.automations.update({ automation_id: String(seed.automationId), execution_config: { executor: { kind: 'external' } } } as never)).rejects.toThrow('execution_config.executor is retired');
    await expect(seed.workspace.owner.automations.createVersion({ automation_id: String(seed.automationId), triggers: [{ kind: 'event', source: 'connector', connector_key: 'slack', event_types: ['message.created'], execution: 'turn', output: 'reply_to_source' }], set_as_current: true } as never)).rejects.toThrow('requires an owning native agent');
  });

  it('freezes coalesced event inputs when preparation starts', async () => {
    const seed = await seedPreparedAutomation('export async function prepare(ctx) { return { signals: [{ count: ctx.trigger_signals.length, end: ctx.window.window_end }] }; }');
    const trigger = { kind: 'event' as const, connector_key: 'github', event_types: ['pull_request.created'], execution: 'window' as const, output: 'silent' as const, active_run: 'coalesce' as const };
    const activate = (index: number) => createAutomationEventRun({ organizationId: seed.workspace.org.id, automationId: seed.automationId, agentId: 'prepared-owner', trigger, signal: { connector_key: 'github', event_type: 'pull_request.created', delivery_id: `synthetic-preparation-${index}`, occurred_at: `2026-01-01T00:00:0${index}.000Z`, labels: {} } });
    const first = await activate(1);
    const second = await activate(2);
    expect(second).toMatchObject({ runId: first.runId, disposition: 'coalesced' });
    const [task] = await seed.sql`SELECT id FROM runs WHERE parent_run_id = ${first.runId} AND action_key = 'automation-preparation'`;
    await seed.sql`UPDATE runs SET status = 'claimed', claimed_at = now(), claimed_by = 'preparation-fixture' WHERE id = ${task.id}`;
    await runAutomationPreparationTask({ ...seed.payload, sourceRunId: first.runId! }, TEST_ENV, Number(task.id));
    const third = await activate(3);
    expect(third.runId).not.toBe(first.runId);
    const [run] = await seed.sql`SELECT approved_input, run_metadata FROM runs WHERE id = ${first.runId}`;
    expect(run.approved_input.trigger_signals).toHaveLength(2);
    expect(run.run_metadata.preparation_sources.signals).toEqual([{ count: 2, end: run.approved_input.window_end }]);
  });

  it('rejects captured preparation before any hosted agent starts', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return {}; }');
    await seed.prepare();
    await seed.sql`UPDATE runs SET run_type = 'automation_eval' WHERE id = ${seed.runId}`;
    await expect(seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId })).rejects.toThrow('not supported for captured');
    expect(await dispatchPendingAutomationRuns({ runIds: [seed.runId] })).toMatchObject({ failed: 1, dispatched: 0 });
  });

  it('keeps saved preparation sources scoped to their workspace', async () => {
    const seed = await seedPreparedAutomation('export async function prepare() { return { private_context: [{ value: "private-fixture" }] }; }');
    await seed.prepare();
    const foreign = await TestWorkspace.create({ name: 'Unrelated Preparation Org' });
    await expect(foreign.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId })).rejects.toThrow();
    const read = await seed.workspace.owner.knowledge.read({ automation_id: seed.automationId, run_id: seed.runId }) as { sources: Record<string, unknown[]> };
    expect(read.sources.private_context).toEqual([{ value: 'private-fixture' }]);
  });

  it.each(['export const prepare = 1; export default async () => {};', 'export const defaultHandler = 1;', 'export async function prepare() { return {}; } export default 1;'])(
    'rejects invalid lifecycle exports without replacing the saved module: %s', async (source) => {
      const seed = await seedPreparedAutomation('export async function prepare() { return { snapshot: [{ value: 42 }] }; }');
      await expect(seed.workspace.owner.automations.setReactionScript({ automation_id: String(seed.automationId), reaction_script: source })).rejects.toThrow('must export prepare or a default async function');
      const [automation] = await seed.sql`SELECT reaction_script FROM automations WHERE id = ${seed.automationId}`;
      expect(automation.reaction_script).toContain('value: 42');
    },
  );

  it('accepts a script as the complete job without a model prompt or reaction', async () => {
    const { automationId } = await seedScriptAutomation();
    expect(automationId).toBeGreaterThan(0);
  });

  it('rejects a source without a default handler before storing the job', async () => {
    await expect(
      seedScriptAutomation('export const named = () => {};')
    ).rejects.toThrow('Automation script must export a default async function');
  });

  it('rejects clearing the only executable instructions', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    await expect(
      workspace.owner.automations.update({
        automation_id: String(automationId),
        execution_config: null,
      })
    ).rejects.toThrow('needs instructions');
  });

  it('keeps script-owned windows out of the external processor lane', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    await expect(
      workspace.owner.automations.claimNextWindow({
        automation_id: String(automationId),
      })
    ).rejects.toThrow('cannot be claimed by an external processor');
    expect(
      await getTestDb()`SELECT id FROM runs WHERE automation_id = ${automationId}`
    ).toEqual([]);
  });

  it('recommends trigger, not the claim it would reject, for a script Automation', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    // Put the arrival mark behind the horizon so a next window genuinely exists;
    // the recommendation is only emitted when one does.
    await getTestDb()`
      UPDATE automations
      SET next_window_start = now() - interval '1 day'
      WHERE id = ${automationId}
    `;

    const detail = (await workspace.owner.automations.get({
      automation_id: String(automationId),
    })) as {
      pending_analysis?: {
        next_window: { start: string; end: string } | null;
        next_action: { tool: string } | null;
      };
    };

    expect(detail.pending_analysis?.next_window).not.toBeNull();
    // `claim_next_window` 409s for script executors, so recommending it walked
    // external clients into a guaranteed error; `trigger` is the working path.
    expect(detail.pending_analysis?.next_action?.tool).toBe(
      'client.automations.trigger'
    );
  });

  it('recommends the claim for an unassigned analysis Automation', async () => {
    const { workspace, automationId } = await seedScriptAutomation();
    // Removing both native assignments leaves analysis to an external client.
    await getTestDb()`
      UPDATE automations
      SET next_window_start = now() - interval '1 day', execution_config = NULL, managed_agent_id = NULL
      WHERE id = ${automationId}
    `;

    const detail = (await workspace.owner.automations.get({
      automation_id: String(automationId),
    })) as {
      pending_analysis?: {
        next_window: { start: string; end: string } | null;
        next_action: { tool: string } | null;
      };
    };

    expect(detail.pending_analysis?.next_window).not.toBeNull();
    expect(detail.pending_analysis?.next_action?.tool).toBe(
      'client.automations.claimNextWindow'
    );
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

    await expect(
      workspace.owner.automations.claimNextWindow({
        automation_id: String(automationId),
      })
    ).rejects.toThrow('cannot be claimed by an external processor');
    expect(
      (await sql`SELECT status FROM runs WHERE id = ${run.runId}`)[0]?.status
    ).toBe('pending');
  });

  it('keeps an already-pinned external run claimable after the live config switches to script', async () => {
    const { workspace, agentId, automationId } = await seedScriptAutomation();
    const sql = getTestDb();
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T00:20:00.000Z';
    await sql`UPDATE automations SET next_window_start = ${start}::timestamptz, execution_config = NULL, managed_agent_id = NULL WHERE id = ${automationId}`;
    const run = await createAutomationRun({
      organizationId: workspace.org.id,
      agentId: null,
      automationId,
      windowStart: start,
      windowEnd: end,
      dispatchSource: 'scheduled',
    });
    await sql`UPDATE automations SET managed_agent_id = ${agentId}, execution_config = ${sql.json({ executor: { kind: 'script', source: SOURCE } })} WHERE id = ${automationId}`;

    const claim = await workspace.owner.automations.claimNextWindow({
      automation_id: String(automationId),
    });
    expect(claim).toMatchObject({
      run_id: run.runId,
      context: { window_start: start, window_end: end },
    });
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
    const [run] =
      await getTestDb()`SELECT status, claimed_by FROM runs WHERE id = ${first.run_id}`;
    expect(run).toMatchObject({
      status: 'running',
      claimed_by: 'automation-script',
    });
  });

  it('hands off a script without reversing the Automation-before-run lock order', async () => {
    const { workspace, automationId, agentId } = await seedScriptAutomation();
    const sql = getTestDb();
    const queued = await createAutomationRun({
      organizationId: workspace.org.id, automationId, agentId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'event',
    });
    await sql`UPDATE runs SET status = 'claimed', claimed_by = 'lobu-dispatcher', claimed_at = now() WHERE id = ${queued.runId}`;
    let handoff: Promise<{ value?: boolean; error?: unknown }> | undefined;
    let manualError: unknown;
    try {
      await sql.begin(async (tx) => {
        const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
        // Manual trigger owns the Automation row before inspecting its active run.
        await tx`SELECT id FROM automations WHERE id = ${automationId} FOR UPDATE`;
        handoff = enqueueAutomationScript(sql as never, {
          organizationId: workspace.org.id, automationId, sourceRunId: queued.runId,
        }).then(value => ({ value }), error => ({ error }));
        // Observe actual database contention, not a timing-dependent promise race.
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const waiting = await sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND ${Number(holder.pid)}::integer = ANY(pg_blocking_pids(pid))`;
          if (waiting.length) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await tx`SET LOCAL lock_timeout = '3s'`;
        // Before the fix dispatch owns the run and waits for our Automation FK.
        // Reading the run now closes the lock cycle and PostgreSQL aborts a peer.
        const [run] = await tx`SELECT status FROM runs WHERE id = ${queued.runId} FOR UPDATE`;
        expect(run.status).toBe('claimed');
      });
    } catch (error) { manualError = error; }
    const result = await handoff;
    if (manualError) throw manualError;
    if (result?.error) throw result.error;
    expect(result?.value).toBe(true);
    const tasks = await sql`SELECT id FROM runs WHERE parent_run_id = ${queued.runId} AND action_key = 'automation-script'`;
    expect(tasks).toHaveLength(1);
    const [run] = await sql`SELECT status, claimed_by, run_metadata FROM runs WHERE id = ${queued.runId}`;
    expect(run.status).toBe('running');
    expect(run.claimed_by).toBe('automation-script');
    expect(Number(run.run_metadata.executor_task_run_id)).toBe(Number(tasks[0].id));
  });

  it('rejects agent-only settings when updating a script job', async () => {
    const base = {
      executionConfig: { executor: { kind: 'script', source: SOURCE } },
      agentId: 'synthetic-owner',
      validateSource: false,
    };
    await expect(
      assertAutomationScriptExecutor({
        ...base,
        executionConfig: { ...base.executionConfig, model: 'provider/model' },
      })
    ).rejects.toThrow(
      'model, CLI, timeout, and finalize settings do not apply'
    );
    await expect(
      assertAutomationScriptExecutor({
        ...base,
        triggers: [{ kind: 'event', output: 'reply_to_source' }],
      })
    ).rejects.toThrow('use silent triggers');
    await expect(
      assertAutomationScriptExecutor({
        ...base,
        skills: [{ name: 'synthetic' }],
      })
    ).rejects.toThrow('cannot use agent skills');
    await expect(
      assertAutomationScriptExecutor({
        ...base,
        outputs: { summary: { entity: 'note' } },
      })
    ).rejects.toThrow('cannot use agent skills');
    await expect(
      assertAutomationScriptExecutor({
        ...base,
        deviceWorkerId: 'synthetic-device',
      })
    ).rejects.toThrow('cannot be pinned');
  });

  it('prevents a script from completing itself before its handler succeeds', async () => {
    const { workspace, sql, automationId, runId, taskRunId, payload, start } =
      await dispatchedScript();
    const content = (await workspace.owner.knowledge.read({
      automation_id: automationId,
      run_id: runId,
    })) as { window_token: string };
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: String(automationId),
        run_id: runId,
        window_token: content.window_token,
        extracted_data: {},
      })
    ).rejects.toThrow('runtime completes script Automations');
    const [automation] =
      await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
  });

  it('pins the script when creating a run so later edits cannot change a retry', async () => {
    const { workspace, agentId, automationId } = await seedScriptAutomation();
    const sql = getTestDb();
    const run = await createAutomationRun({
      organizationId: workspace.org.id,
      agentId,
      automationId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-01T00:20:00.000Z',
      dispatchSource: 'manual',
    });
    await sql`UPDATE automations SET execution_config = ${sql.json({ executor: { kind: 'script', source: 'export default async () => ({ changed: true });' } })} WHERE id = ${automationId}`;
    const [stored] =
      await sql`SELECT approved_input FROM runs WHERE id = ${run.runId}`;
    expect(stored!.approved_input.executor).toEqual({
      kind: 'script',
      source: SOURCE,
    });
  });

  it('executes the pinned script in an isolate and completes without producing a model turn', async () => {
    const { sql, automationId, runId, taskRunId, payload, end } =
      await dispatchedScript();
    await sql`UPDATE automations SET execution_config = NULL WHERE id = ${automationId}`;
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
    const [run] =
      await sql`SELECT status, action_output, model_used FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({
      status: 'completed',
      action_output: { run_id: runId, result: 'script result' },
      model_used: 'script',
    });
    const [automation] =
      await sql`SELECT next_window_start, consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(end);
    expect(Number(automation!.consecutive_scheduled_failures)).toBe(0);
    expect(
      await sql`SELECT id FROM runs WHERE run_type IN ('agent_run', 'agent_turn')`
    ).toEqual([]);
    // A queue replay after the source commit cannot repeat the script.
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);
    const [again] =
      await sql`SELECT action_output FROM runs WHERE id = ${runId}`;
    expect(again!.action_output).toEqual(run!.action_output);
  });

  it('reads its author\'s private connections through client.query, but not another user\'s', async () => {
    const { sql, workspace, runId, taskRunId, payload } = await dispatchedScript(
      `export default async (_ctx, client) => {
        const rows = await client.query("SELECT payload_text FROM events WHERE payload_text LIKE 'visibility-probe:%' ORDER BY payload_text");
        return { seen: rows.map((r) => r.payload_text) };
      };`
    );
    const authorPrivate = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'github',
      created_by: workspace.users.owner.id,
      visibility: 'private',
    });
    const otherPrivate = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'github',
      created_by: workspace.users.admin.id,
      visibility: 'private',
    });
    const shared = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'github',
      visibility: 'org',
    });
    for (const [connection, label] of [
      [authorPrivate, 'author-private'],
      [otherPrivate, 'other-private'],
      [shared, 'org-visible'],
    ] as const) {
      await createTestEvent({
        organization_id: workspace.org.id,
        connection_id: connection.id,
        connector_key: 'github',
        content: `visibility-probe:${label}`,
      });
    }

    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);

    const [run] = await sql`SELECT status, action_output FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({
      status: 'completed',
      action_output: {
        seen: ['visibility-probe:author-private', 'visibility-probe:org-visible'],
      },
    });
  });

  it.each([
    {
      creator: 'member' as const,
      expected: {
        list: { names: ['Probe Member'], emails: [], error: null },
        memberRows: { emails: [], error: null },
        auditRows: { titles: [], error: null },
        users: { error: expect.stringMatching(/require owner\/admin access/) },
      },
    },
    {
      creator: 'admin' as const,
      expected: {
        list: { names: ['Probe Member'], emails: [MEMBER_PROBE_EMAIL], error: null },
        memberRows: { emails: [MEMBER_PROBE_EMAIL], error: null },
        auditRows: { titles: [AUDIT_PROBE_TITLE], error: null },
        users: { error: null, withheldEmail: false },
      },
    },
    {
      creator: 'departed' as const,
      expected: {
        list: { error: expect.stringMatching(/only visible to members/) },
        memberRows: { emails: [], error: null },
        auditRows: { titles: [], error: null },
        users: { error: expect.stringMatching(/require owner\/admin access/) },
      },
    },
  ])('reads member data with its $creator creator\'s current role', async ({ creator, expected }) => {
    const { sql, workspace, automationId, runId, taskRunId, payload } = await dispatchedScript(MEMBER_READ_PROBE);
    const orgId = workspace.org.id;
    await ensureMemberEntityType(orgId);
    await sql`
      INSERT INTO entities (name, slug, entity_type_id, organization_id, metadata, created_by, created_at, updated_at)
      VALUES (
        'Probe Member', 'probe-member',
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${orgId} AND deleted_at IS NULL),
        ${orgId}, ${sql.json({ email: MEMBER_PROBE_EMAIL, status: 'active', role: 'member' })},
        ${workspace.users.owner.id}, NOW(), NOW()
      )
    `;
    await createTestEvent({
      organization_id: orgId,
      title: AUDIT_PROBE_TITLE,
      content: 'Probe Member joined the workspace.',
      metadata: { _lobu_workspace_audit: true, category: 'workspace' },
    });
    const creatorId = creator === 'member' ? workspace.users.member.id : workspace.users.admin.id;
    await sql`UPDATE automations SET created_by = ${creatorId} WHERE id = ${automationId}`;
    if (creator === 'departed') {
      await sql`DELETE FROM "member" WHERE "organizationId" = ${orgId} AND "userId" = ${creatorId}`;
    }

    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);

    const [run] = await sql`SELECT status, action_output, error_message FROM runs WHERE id = ${runId}`;
    expect(run!.error_message ?? null).toBeNull();
    expect(run).toMatchObject({ status: 'completed', action_output: expected });
  });

  it.each([
    ['completed', SOURCE],
    ['failed', 'export default async () => 42;'],
  ])('dispatches a run queued behind the script as soon as it is %s', async (status, source) => {
    const { sql, workspace, agentId, automationId, taskRunId, payload } =
      await dispatchedScript(source);
    // A scheduled window dedupes onto the active run; an event queues behind it.
    const followUp = await createAutomationEventRun({
      organizationId: workspace.org.id,
      automationId,
      agentId,
      trigger: {
        kind: 'event',
        connector_key: 'github',
        event_types: ['pull_request.created'],
        execution: 'window',
        output: 'silent',
      },
      signal: {
        connector_key: 'github',
        event_type: 'pull_request.created',
        delivery_id: 'synthetic-follow-up',
        label: 'Follow-up event',
        input_text: 'Synthetic event',
      },
    });
    expect(followUp.runId).toBeTruthy();
    // Unclaimable while the script run is in flight.
    expect(
      await dispatchPendingAutomationRuns({ runIds: [followUp.runId!] })
    ).toMatchObject({ claimed: 0 });

    await runAutomationScriptTask(payload, TEST_ENV, taskRunId);

    const [finished] =
      await sql`SELECT status FROM runs WHERE id = ${payload.sourceRunId}`;
    expect(finished!.status).toBe(status);
    const [next] =
      await sql`SELECT status FROM runs WHERE id = ${followUp.runId}`;
    expect(next!.status).toBe('running');
    expect(
      await sql`SELECT id FROM runs WHERE parent_run_id = ${followUp.runId} AND action_key = 'automation-script'`
    ).toHaveLength(1);
  });

  it('accepts no return value as an empty action output', async () => {
    const noValue = await dispatchedScript('export default async () => {};');
    await runAutomationScriptTask(noValue.payload, TEST_ENV, noValue.taskRunId);
    const [completed] =
      await noValue.sql`SELECT status, action_output FROM runs WHERE id = ${noValue.runId}`;
    expect(completed).toMatchObject({ status: 'completed', action_output: {} });
  });

  it('rejects an explicit null return as a deterministic validation failure', async () => {
    const explicitNull = await dispatchedScript(
      'export default async () => null;'
    );
    await runAutomationScriptTask(
      explicitNull.payload,
      TEST_ENV,
      explicitNull.taskRunId
    );
    const [failed] =
      await explicitNull.sql`SELECT status, error_message FROM runs WHERE id = ${explicitNull.runId}`;
    expect(failed).toMatchObject({
      status: 'failed',
      error_message:
        'ValidationError: Automation scripts must return an object or no value.',
    });
  });

  it('runs preparation through the real durable task queue before admitting analysis', async () => {
    const seed = await seedPreparedAutomation('export async function prepare(ctx, client) { return { calculated: await client.query("SELECT 19 + 23 AS total") }; }');
    const queue = new RunsQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register(AUTOMATION_PREPARATION_TASK, async (ctx) => {
      await runAutomationPreparationTask(ctx.payload as AutomationScriptTaskPayload, TEST_ENV, ctx.taskRunId, ctx.attempt);
    });
    try {
      await queue.start();
      await scheduler.start();
      await expect.poll(async () => (await seed.sql`SELECT status FROM runs WHERE id = ${seed.taskRunId}`)[0]?.status, { timeout: 5000 }).toBe('completed');
      const [run] = await seed.sql`SELECT status, run_metadata FROM runs WHERE id = ${seed.runId}`;
      expect(run.status).toBe('pending');
      expect(run.run_metadata.preparation_sources).toEqual({ calculated: [{ total: 42 }] });
      expect(await seed.sql.begin(tx => claimPendingAutomationRun(tx, { runId: seed.runId, automationId: seed.automationId, claimedBy: 'native-fixture', status: 'running' }))).toBe(true);
    } finally {
      scheduler.stop();
      await queue.stop();
    }
  });

  it('is claimed and settled by the real durable task queue', async () => {
    const { sql, runId, taskRunId } = await dispatchedScript();
    await sql`UPDATE runs SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ${taskRunId}`;
    const queue = new RunsQueue();
    const scheduler = new TaskScheduler(queue);
    scheduler.register(AUTOMATION_SCRIPT_TASK, async (ctx) => {
      await runAutomationScriptTask(
        ctx.payload as AutomationScriptTaskPayload,
        TEST_ENV,
        ctx.taskRunId,
        ctx.attempt
      );
    });
    try {
      await queue.start();
      await scheduler.start();
      await expect
        .poll(
          async () =>
            (await sql`SELECT status FROM runs WHERE id = ${taskRunId}`)[0]
              ?.status,
          { timeout: 5000 }
        )
        .toBe('completed');
      expect(
        (await sql`SELECT status FROM runs WHERE id = ${runId}`)[0]?.status
      ).toBe('completed');
    } finally {
      scheduler.stop();
      await queue.stop();
    }
  });

  it.each(['window', 'turn'] as const)(
    'executes an event %s with its pinned signal and params without advancing the arrival mark',
    async (execution) => {
      const { workspace, automationId, agentId } = await seedScriptAutomation(
        'export default async (ctx, _client, params) => ({ signal: ctx.trigger_signals[0].delivery_id, value: params.value });'
      );
      const sql = getTestDb();
      const start = '2026-01-01T00:00:00.000Z';
      await sql`UPDATE automations SET next_window_start = ${start}::timestamptz,
      execution_config = jsonb_set(execution_config, '{executor,params}', ${sql.json({ value: 'pinned' })}::jsonb) WHERE id = ${automationId}`;
      const queued = await createAutomationEventRun({
        organizationId: workspace.org.id,
        automationId,
        agentId,
        trigger: {
          kind: 'event',
          connector_key: 'github',
          event_types: ['pull_request.created'],
          execution,
          output: 'silent',
        },
        signal: {
          connector_key: 'github',
          event_type: 'pull_request.created',
          delivery_id: 'synthetic-delivery',
          label: 'Test event',
          input_text: 'Synthetic event',
        },
      });
      expect(queued.runId).toBeTruthy();
      await sql`UPDATE automations SET execution_config = jsonb_set(execution_config, '{executor,params}', ${sql.json({ value: 'changed' })}::jsonb) WHERE id = ${automationId}`;
      await dispatchPendingAutomationRuns({ runIds: [queued.runId!] });
      const [task] =
        await sql`UPDATE runs SET status = 'claimed', claimed_by = 'event-fixture', claimed_at = now()
      WHERE parent_run_id = ${queued.runId} AND action_key = 'automation-script' RETURNING id`;
      await runAutomationScriptTask(
        {
          organizationId: workspace.org.id,
          automationId,
          sourceRunId: queued.runId!,
        },
        TEST_ENV,
        Number(task!.id)
      );
      const [run] =
        await sql`SELECT status, action_output FROM runs WHERE id = ${queued.runId}`;
      expect(run).toMatchObject({
        status: 'completed',
        action_output: { signal: 'synthetic-delivery', value: 'pinned' },
      });
      const [automation] =
        await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
      expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
    }
  );

  it('leaves the arrival cursor untouched through transient retries and terminal failure', async () => {
    const { sql, automationId, runId, taskRunId, payload, start } =
      await dispatchedScript(
        'export default async () => { throw new Error("synthetic upstream failure"); };'
      );
    await expect(
      runAutomationScriptTask(payload, TEST_ENV, taskRunId, 1)
    ).rejects.toThrow('synthetic upstream failure');
    await runAutomationScriptTask(payload, TEST_ENV, taskRunId, 3);
    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('synthetic upstream failure'),
    });
    const [automation] =
      await sql`SELECT next_window_start, consecutive_scheduled_failures FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
    expect(Number(automation!.consecutive_scheduled_failures)).toBe(1);
  });

  it('settles a crashed and exhausted child task without stranding its parent', async () => {
    const { sql, automationId, runId, taskRunId, start } =
      await dispatchedScript();
    await sql`UPDATE runs SET status = 'failed', error_message = 'synthetic crashed task' WHERE id = ${taskRunId}`;
    expect(await reconcileAutomationScriptRuns()).toBe(1);
    expect(await reconcileAutomationScriptRuns()).toBe(0);
    const [run] =
      await sql`SELECT status, error_message FROM runs WHERE id = ${runId}`;
    expect(run).toMatchObject({
      status: 'failed',
      error_message: 'synthetic crashed task',
    });
    const [automation] =
      await sql`SELECT next_window_start FROM automations WHERE id = ${automationId}`;
    expect(new Date(automation!.next_window_start).toISOString()).toBe(start);
  });
});
