import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, seedOwnerContext } from '../../setup/test-fixtures';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { activateWorkspaceEventTask } from '../../../automations/workspace-event';
import { dispatchPendingAutomationRuns } from '../../../automations/automation';
import { runAutomationScriptTask } from '../../../automations/script-task';
import * as preparationTasks from '../../../automations/preparation-task';
import * as reactionTasks from '../../../automations/reaction-task';
import * as queue from '../../../runs/queue-service';
import { initWorkspaceProvider } from '../../../workspace';
import triageFeedback from '../../../../../../examples/lobu-team/feedback-triage.reaction';
import teamConfig from '../../../../../../examples/lobu-team/lobu.config';
import type { ReactionClient, ReactionContext } from '@lobu/connector-sdk';

const TEST_ENV = { ENVIRONMENT: 'test', JWT_SECRET: 'synthetic-feedback-window-signing-secret' } as Env;
let reactionSource: string;
beforeAll(async () => {
  await initWorkspaceProvider();
  reactionSource = await readFile(new URL('../../../../../../examples/lobu-team/feedback-triage.reaction.ts', import.meta.url), 'utf8');
});
beforeEach(cleanupTestDatabase);

async function fixture() {
  const sender = await seedOwnerContext({ orgName: 'Synthetic sending workspace' });
  const receiver = await seedOwnerContext({ orgName: 'Synthetic receiving workspace' });
  const sql = getTestDb();
  const sdk = buildClientSDK(sender.ctx, TEST_ENV);
  const receiverSdk = buildClientSDK(receiver.ctx, TEST_ENV);
  await ensureMemberEntityType(receiver.org.id);
  const declaration = teamConfig.entities!.find((type) => type.key === '$member')!;
  await receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: declaration.eventKinds });
  for (const key of ['task', 'issue']) {
    const entity = teamConfig.entities!.find((type) => type.key === key)!;
    await receiverSdk.entitySchema.createType({ slug: key, name: key, metadata_schema: { type: 'object', properties: entity.properties } });
  }
  const agent = await createTestAgent({ organizationId: receiver.org.id, ownerUserId: receiver.user.id });
  const triage = teamConfig.automations!.find((automation) => automation.slug === 'product-feedback-triage')!;
  const created = await receiverSdk.automations.create({ slug: 'synthetic-feedback-triage', managed_agent_id: agent.agentId,
    prompt: triage.prompt, triggers: triage.triggers,
    sources: Object.entries(triage.sources!).map(([name, source]) => ({ name, ...(typeof source === 'string' ? { query: source } : source) })),
    reaction_script: reactionSource,
  });
  const automationId = Number(created.automation_id);
  const message = { organization: receiver.org.slug, inbox: 'product.feedback', title: 'Source sync fails',
    body: 'Expected a successful sync; received a failure after authorization.', data: { references: ['https://example.com/reproduction'] } };
  return { sender, receiver, sdk, receiverSdk, automationId, sql, message };
}

async function activate(f: Awaited<ReturnType<typeof fixture>>, eventId: number) {
  const [queued] = await f.sql`SELECT id, action_input FROM runs WHERE organization_id = ${f.receiver.org.id}
    AND action_key = 'activate-workspace-event' AND action_input->'payload'->>'eventId' = ${String(eventId)}`;
  expect(queued).toBeDefined();
  await activateWorkspaceEventTask(queued.action_input.payload);
  await activateWorkspaceEventTask(queued.action_input.payload);
}

async function prepareRun(f: Awaited<ReturnType<typeof fixture>>, runId: number) {
  const [task] = await f.sql`SELECT id FROM runs WHERE parent_run_id = ${runId} AND action_key = 'automation-preparation'`;
  expect(task).toBeDefined();
  await f.sql`UPDATE runs SET status = 'claimed', claimed_by = 'synthetic-feedback-preparation', claimed_at = now() WHERE id = ${task.id}`;
  await preparationTasks.runAutomationPreparationTask({ organizationId: f.receiver.org.id,
    automationId: f.automationId, sourceRunId: runId }, TEST_ENV, Number(task.id));
  const [run] = await f.sql`SELECT id, status, approved_input, run_metadata FROM runs WHERE id = ${runId}`;
  expect(run.status).toBe('pending');
  expect(run.run_metadata.preparation_sources.reports).toHaveLength(1);
  return run;
}

describe('published notification inbox end to end', () => {
  it('lets an authorized sending Automation submit through its real sandbox with stamped provenance', async () => {
    const f = await fixture();
    const agent = await createTestAgent({ organizationId: f.sender.org.id, ownerUserId: f.sender.user.id });
    const message = { ...f.message, idempotency_key: 'authorized-automation-report' };
    const created = await f.sdk.automations.create({ slug: 'synthetic-authorized-reporter', managed_agent_id: agent.agentId,
      reaction_script: `export default async (_ctx, client) => client.notifications.submit(${JSON.stringify(message)});` });
    const automationId = Number(created.automation_id);
    const run = await queue.createAutomationRun({ organizationId: f.sender.org.id, automationId, agentId: agent.agentId,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual' });
    expect(await dispatchPendingAutomationRuns({ runIds: [run.runId] })).toMatchObject({ dispatched: 1, failed: 0 });
    const [task] = await f.sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
    await f.sql`UPDATE runs SET status = 'claimed' WHERE id = ${task.id}`;
    await runAutomationScriptTask({ organizationId: f.sender.org.id, automationId, sourceRunId: run.runId }, TEST_ENV, Number(task.id));
    const [completed] = await f.sql`SELECT status, action_output FROM runs WHERE id = ${run.runId}`;
    expect(completed.status).toBe('completed');
    const [report] = await f.sql`SELECT id, metadata, automation_id, run_id FROM events
      WHERE organization_id = ${f.receiver.org.id} AND semantic_type = 'product.feedback'`;
    expect(report.metadata.inbox_submission).toMatchObject({ organization_id: f.sender.org.id,
      automation_id: automationId, run_id: run.runId });
    expect(report.automation_id).toBeNull();
    expect(report.run_id).toBeNull();
    await activate(f, Number(report.id));
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
  });

  it('attaches user evidence to existing issues and creates only one task across reaction retries', async () => {
    const f = await fixture();
    const receipt = { id: Number((await f.sdk.notifications.submit({ ...f.message, idempotency_key: 'e2e-report' })).receipt) };
    await activate(f, receipt.id);
    const issue = await f.receiverSdk.entities.create({ entity_type: 'issue', name: 'Synthetic production error', slug: 'synthetic-issue',
      metadata: { fingerprint: '0123456789abcdef0123456789abcdef', status: 'ongoing', kind: 'system', seen_24h: 17 } });
    if (!issue.entity) throw new Error('Missing issue');
    const [queued] = await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const run = await prepareRun(f, Number(queued.id));
    expect(run.run_metadata.preparation_sources.reports).toEqual([{ id: receipt.id,
      origin_id: expect.any(String) }]);
    const context = {
      extracted_data: { reports: [{ report_id: receipt.id, summary: 'A user reports that the authorized source sync fails. Reproduction remains pending.', kind: 'bug', issue_id: issue.entity.id }] },
      sources: run.run_metadata.preparation_sources,
      window: { automation_id: f.automationId, run_id: Number(run.id), window_start: run.approved_input.window_start, window_end: run.approved_input.window_end },
    } as ReactionContext;
    const client = f.receiverSdk as unknown as ReactionClient;
    expect(await f.sql.begin((tx) => queue.claimPendingAutomationRun(tx, { runId: Number(run.id),
      automationId: f.automationId, claimedBy: 'synthetic-feedback-analysis', status: 'running' }))).toBe(true);
    const read = await f.receiverSdk.knowledge.read({ automation_id: f.automationId, run_id: Number(run.id) }) as {
      window_token: string; sources: Record<string, unknown[]>;
    };
    expect(read.sources.reports).toEqual(context.sources!.reports);
    const complete = (reports: unknown[]) => f.receiverSdk.automations.completeWindow({ automation_id: String(f.automationId),
      run_id: Number(run.id), window_token: read.window_token, extracted_data: { reports } });
    // Reject oversized extraction before the source run completes or any
    // side effect executes, rather than failing after the 200th SDK call.
    await expect(complete(Array.from({ length: 100 }, () => (context.extracted_data.reports as unknown[])[0]))).rejects.toThrow(/reports: must NOT have more than 1 items/);
    await expect(complete([])).rejects.toThrow(/reports: must NOT have fewer than 1 items/);
    expect(await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id
      WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`).toHaveLength(0);
    await complete(context.extracted_data.reports as unknown[]);
    const [reaction] = await f.sql`SELECT id FROM runs WHERE parent_run_id = ${run.id} AND action_key = 'automation-reaction'`;
    const payload = { organizationId: f.receiver.org.id, automationId: f.automationId, sourceRunId: Number(run.id) };
    expect(await reactionTasks.runAutomationReactionTask(payload, TEST_ENV, Number(reaction.id))).toEqual({ status: 'success' });
    expect(await reactionTasks.runAutomationReactionTask(payload, TEST_ENV, Number(reaction.id))).toEqual({ status: 'success' });
    const first = await triageFeedback(context, client);
    expect(await triageFeedback(context, client)).toEqual(first);
    const alerts = await f.receiverSdk.notifications.list({ limit: 50 });
    expect(alerts.notifications).toHaveLength(2);
    const tasks = await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`;
    expect(tasks).toHaveLength(1);
    const evidence = await f.sql`SELECT ${issue.entity.id}::bigint = ANY(entity_ids) AS linked_issue, payload_data FROM events WHERE organization_id = ${f.receiver.org.id} AND metadata ? '_lobu_idempotency_key' AND metadata->>'_lobu_idempotency_key' LIKE 'feedback-triage:%'`;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].payload_data).toMatchObject({ report_id: receipt.id, verification: 'user_reported' });
    expect(evidence[0].linked_issue).toBe(true);
    const [unchanged] = await f.sql`SELECT metadata FROM entities WHERE id = ${issue.entity.id}`;
    expect(unchanged.metadata).toMatchObject({ seen_24h: 17, status: 'ongoing' });
    const outside = { ...context, extracted_data: { reports: [{ report_id: receipt.id + 1000000, summary: 'Outside report', kind: 'bug' }] } } as ReactionContext;
    await expect(triageFeedback(outside, client)).rejects.toThrow('in this inbox');
    await expect(triageFeedback({ ...context, extracted_data: { reports: [] } }, client)).rejects.toThrow('every report');
    const wrongIssue = { ...context, extracted_data: { reports: [{ report_id: receipt.id, summary: 'Reported failure', kind: 'bug', issue_id: tasks[0].id }] } } as ReactionContext;
    // An already persisted decision is replayed instead of rematched.
    expect(await triageFeedback(wrongIssue, client)).toEqual(first);
  });

  it('keeps burst deliveries in separate bounded runs, including reports larger than the preparation budget', async () => {
    const f = await fixture();
    const receiptIds: number[] = [];
    for (let index = 0; index < 3; index++) {
      const receipt = await f.sdk.notifications.submit({ ...f.message, title: `Synthetic burst report ${index}`,
        data: { references: ['https://example.com/' + 'a'.repeat(8000)] }, idempotency_key: `burst-${index}` });
      receiptIds.push(Number(receipt.receipt));
      await activate(f, Number(receipt.receipt));
    }
    const queued = await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation' ORDER BY id`;
    expect(queued).toHaveLength(receiptIds.length);
    for (const [index, queuedRun] of queued.entries()) {
      const run = await prepareRun(f, Number(queuedRun.id));
      const sources = run.run_metadata.preparation_sources;
      expect(sources.reports[0].id).toBe(receiptIds[index]);
      expect(Buffer.byteLength(JSON.stringify(sources))).toBeLessThan(1024);
      const context = { sources, window: { automation_id: f.automationId, run_id: Number(run.id),
        window_start: run.approved_input.window_start, window_end: run.approved_input.window_end },
      extracted_data: { reports: [{ report_id: receiptIds[index], summary: 'Synthetic user-reported failure; verification pending.', kind: 'bug' }] } } as ReactionContext;
      const client = f.receiverSdk as unknown as ReactionClient;
      await expect(triageFeedback({ ...context, extracted_data: { reports: receiptIds.map((report_id) => ({ report_id,
        summary: 'Cannot batch queued deliveries', kind: 'bug' })) } }, client)).rejects.toThrow('exactly once');
      await expect(triageFeedback({ ...context, extracted_data: { reports: [{ report_id: receiptIds[(index + 1) % receiptIds.length],
        summary: 'Another queued delivery', kind: 'bug' }] } }, client)).rejects.toThrow('in this inbox');
      expect(await triageFeedback(context, client)).toMatchObject({ reports: [{ report_id: receiptIds[index], task_id: expect.any(Number) }] });
    }
    const tasks = await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id
      WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`;
    expect(tasks).toHaveLength(receiptIds.length);
    const alerts = await f.receiverSdk.notifications.list({ limit: 50 });
    expect(alerts.notifications).toHaveLength(receiptIds.length * 2);
  });
});
