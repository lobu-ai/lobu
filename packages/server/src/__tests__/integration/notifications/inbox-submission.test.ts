import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { buildClientSDK } from '../../../sandbox/client-sdk';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { addUserToOrganization, createTestAgent, createTestUser, seedOwnerContext } from '../../setup/test-fixtures';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { activateWorkspaceEventTask } from '../../../automations/workspace-event';
import { deleteNotification } from '../../../notifications/service';
import { MAX_WORKSPACE_EVENT_DEPTH, MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS } from '../../../automations/workspace-event-contract';
import { dispatchPendingAutomationRuns } from '../../../automations/automation';
import { runAutomationScriptTask } from '../../../automations/script-task';
import * as preparationTasks from '../../../automations/preparation-task';
import * as reactionTasks from '../../../automations/reaction-task';
import * as queue from '../../../runs/queue-service';
import { initWorkspaceProvider } from '../../../workspace';
import triageIssueReport from '../../../../../../examples/lobu-team/issue-triage.reaction';
import teamConfig from '../../../../../../examples/lobu-team/lobu.config';
import type { ReactionClient, ReactionContext } from '@lobu/connector-sdk';

const ISSUE_DATA = {
  kind: 'bug',
  expected: 'The authorized source sync completes.',
  actual: 'The sync fails right after authorization.',
  evidence: { run_ids: [101] },
  diagnosis: { cause: 'Unknown', checked: ['The connection is active'], ruled_out: ['Expired credentials'] },
  alternatives_considered: ['Reconnecting the source'],
  suggested_fix: 'Keep the authorization result when the first sync starts.',
  references: ['https://example.com/reproduction'],
};
const TEST_ENV = { ENVIRONMENT: 'test', JWT_SECRET: 'synthetic-issue-window-signing-secret' } as Env;
let reactionSource: string;
beforeAll(async () => {
  await initWorkspaceProvider();
  reactionSource = await readFile(new URL('../../../../../../examples/lobu-team/issue-triage.reaction.ts', import.meta.url), 'utf8');
});
beforeEach(cleanupTestDatabase);

/**
 * Apply the example's `$member` declaration the way `lobu apply` does: merge
 * its owned kinds over the platform defaults. A whole-registry replace would
 * delete `observation` and the other built-ins, which the reaction writes.
 */
async function mergeTeamMemberKinds(
  sdk: ReturnType<typeof buildClientSDK>,
  organizationId: string
): Promise<void> {
  const sql = getTestDb();
  const [row] = await sql`SELECT event_kinds FROM entity_types
    WHERE organization_id = ${organizationId} AND slug = '$member'`;
  const declaration = teamConfig.entities!.find((type) => type.key === '$member')!;
  await sdk.entitySchema.updateType({
    slug: '$member',
    event_kinds: {
      ...((row?.event_kinds ?? {}) as Record<string, unknown>),
      ...declaration.eventKinds,
    },
  });
}

async function fixture() {
  const sender = await seedOwnerContext({ orgName: 'Synthetic sending workspace' });
  const receiver = await seedOwnerContext({ orgName: 'Synthetic receiving workspace' });
  const sql = getTestDb();
  const sdk = buildClientSDK(sender.ctx, TEST_ENV);
  const receiverSdk = buildClientSDK(receiver.ctx, TEST_ENV);
  await ensureMemberEntityType(receiver.org.id);
  await mergeTeamMemberKinds(receiverSdk, receiver.org.id);
  for (const key of ['task', 'issue']) {
    const entity = teamConfig.entities!.find((type) => type.key === key)!;
    await receiverSdk.entitySchema.createType({ slug: key, name: key, metadata_schema: { type: 'object', properties: entity.properties } });
  }
  const agent = await createTestAgent({ organizationId: receiver.org.id, ownerUserId: receiver.user.id });
  const triage = teamConfig.automations!.find((automation) => automation.slug === 'product-issue-triage')!;
  const created = await receiverSdk.automations.create({ slug: 'synthetic-issue-triage', managed_agent_id: agent.agentId,
    prompt: triage.prompt, triggers: triage.triggers,
    sources: Object.entries(triage.sources!).map(([name, source]) => ({ name, ...(typeof source === 'string' ? { query: source } : source) })),
    reaction_script: reactionSource,
  });
  const automationId = Number(created.automation_id);
  const message = { organization: receiver.org.slug, inbox: 'product.issue', title: 'Source sync fails',
    body: 'Expected a successful sync; received a failure after authorization.', data: ISSUE_DATA };
  return { sender, receiver, sdk, receiverSdk, automationId, sql, message };
}

async function activate(f: Awaited<ReturnType<typeof fixture>>, eventId: number, organizationId = f.receiver.org.id) {
  const [queued] = await f.sql`SELECT id, action_input FROM runs WHERE organization_id = ${organizationId}
    AND action_key = 'activate-workspace-event' AND action_input->'payload'->>'eventId' = ${String(eventId)}`;
  expect(queued).toBeDefined();
  await activateWorkspaceEventTask(queued.action_input.payload);
  await activateWorkspaceEventTask(queued.action_input.payload);
}

async function prepareRun(f: Awaited<ReturnType<typeof fixture>>, runId: number) {
  const [task] = await f.sql`SELECT id FROM runs WHERE parent_run_id = ${runId} AND action_key = 'automation-preparation'`;
  expect(task).toBeDefined();
  await f.sql`UPDATE runs SET status = 'claimed', claimed_by = 'synthetic-issue-preparation', claimed_at = now() WHERE id = ${task.id}`;
  await preparationTasks.runAutomationPreparationTask({ organizationId: f.receiver.org.id,
    automationId: f.automationId, sourceRunId: runId }, TEST_ENV, Number(task.id));
  const [run] = await f.sql`SELECT id, status, approved_input, run_metadata FROM runs WHERE id = ${runId}`;
  expect(run.status).toBe('pending');
  expect(run.run_metadata.preparation_sources.reports).toHaveLength(1);
  return run;
}

function automationSdk(f: Awaited<ReturnType<typeof fixture>>, automationId: number, runId: number, ctx = f.receiver.ctx) {
  return buildClientSDK({ ...ctx, userId: null, memberRole: null, tokenType: 'session',
    actingAutomationId: automationId, actingRunId: runId }, TEST_ENV);
}

describe('published notification inbox end to end', () => {
  it('preserves ancestry across A -> B -> A workspace inbox submissions', async () => {
    const f = await fixture();
    await ensureMemberEntityType(f.sender.org.id);
    await mergeTeamMemberKinds(f.sdk, f.sender.org.id);
    const agent = await createTestAgent({ organizationId: f.sender.org.id, ownerUserId: f.sender.user.id });
    const created = await f.sdk.automations.create({ slug: 'synthetic-sending-subscriber', managed_agent_id: agent.agentId,
      prompt: 'Submit a synthetic report.', triggers: [{ kind: 'event', source: 'workspace', event_types: ['product.issue'],
        execution: 'window', active_run: 'queue' }] });
    const senderId = Number(created.automation_id);
    const toSender = { ...f.message, organization: f.sender.org.slug };
    const root = await f.receiverSdk.notifications.submit({ ...toSender, idempotency_key: 'cross-root' });
    await activate(f, Number(root.receipt), f.sender.org.id);
    const [senderRun] = await f.sql`SELECT id FROM runs WHERE automation_id = ${senderId} AND run_type = 'automation'`;
    const report = await automationSdk(f, senderId, Number(senderRun.id), f.sender.ctx).notifications.submit({ ...f.message,
      idempotency_key: `cross-report:${senderRun.id}` });
    const [activation] = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${report.receipt}`;
    expect(activation.action_input.payload).toMatchObject({ rootEventIds: [Number(root.receipt)],
      causalAutomationIds: [senderId], depth: 2 });
    await activate(f, Number(report.receipt));
    const [receiverRun] = await f.sql`SELECT id, approved_input FROM runs
      WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    expect(receiverRun.approved_input.trigger_signal).toMatchObject({ event_id: Number(report.receipt),
      root_event_ids: [Number(root.receipt)], causal_automation_ids: [senderId], depth: 2 });
    // Foreign roots correlate deliveries, but grant no source-event visibility.
    expect(await f.receiverSdk.query(`SELECT id FROM events WHERE id = ${Number(root.receipt)}`)).toHaveLength(0);
    const reply = await automationSdk(f, f.automationId, Number(receiverRun.id)).notifications.submit({ ...toSender,
      idempotency_key: `cross-reply:${receiverRun.id}` });
    const [replyActivation] = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${reply.receipt}`;
    expect(replyActivation.action_input.payload).toMatchObject({ rootEventIds: [Number(root.receipt)],
      causalAutomationIds: [senderId, f.automationId], depth: 3 });
    await activate(f, Number(reply.receipt), f.sender.org.id);
    for (const eventId of [report.receipt, reply.receipt]) {
      const [event] = await f.sql`SELECT automation_id, run_id FROM events WHERE id = ${Number(eventId)}`;
      expect(event).toEqual({ automation_id: null, run_id: null });
    }
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${senderId} AND run_type = 'automation'`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
  });

  it.each(['depth', 'breadth', 'breadth-overflow'] as const)('retains cross-workspace reports and admin targets at the %s cap', async (cap) => {
    const f = await fixture();
    const admin = await createTestUser();
    const member = await createTestUser();
    await addUserToOrganization(admin.id, f.sender.org.id, 'admin');
    await addUserToOrganization(member.id, f.sender.org.id, 'member');
    await ensureMemberEntityType(f.sender.org.id);
    await mergeTeamMemberKinds(f.sdk, f.sender.org.id);
    const root = await f.sdk.notifications.submit({ ...f.message, idempotency_key: 'cross-cap-root' });
    await activate(f, Number(root.receipt));
    const [run] = await f.sql`SELECT id, approved_input FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const signal = run.approved_input.trigger_signals[0];
    if (cap === 'depth') signal.depth = MAX_WORKSPACE_EVENT_DEPTH - 1;
    else signal.causal_automation_ids = Array.from({ length: MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS - (cap === 'breadth' ? 1 : 0) },
      (_, i) => f.automationId + i + 1);
    await f.sql`UPDATE runs SET approved_input = ${f.sql.json({ ...run.approved_input,
      trigger_signal: signal, trigger_signals: [signal] })} WHERE id = ${run.id}`;
    const message = { ...f.message, organization: f.sender.org.slug, idempotency_key: `cross-cap:${run.id}` };
    const sdk = automationSdk(f, f.automationId, Number(run.id));
    const receipt = await sdk.notifications.submit(message);
    expect(await sdk.notifications.submit(message)).toEqual(receipt);
    const eventId = Number(receipt.receipt);
    const [event] = await f.sql`SELECT automation_id, run_id, payload_data FROM events WHERE id = ${eventId}`;
    expect(event).toEqual({ automation_id: null, run_id: null, payload_data: message.data });
    const targets = await f.sql`SELECT user_id FROM notification_targets WHERE event_id = ${eventId}`;
    expect(targets.map((target) => target.user_id).sort()).toEqual([f.sender.user.id, admin.id].sort());
    expect(await f.sql`SELECT id FROM runs WHERE action_key = 'deliver-notification'
      AND action_input->'payload'->>'eventId' = ${receipt.receipt}`).toHaveLength(1);
    const activations = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${receipt.receipt}`;
    if (cap === 'breadth-overflow') expect(activations).toHaveLength(0);
    else {
      expect(activations).toHaveLength(1);
      expect(activations[0].action_input.payload.rootEventIds).toEqual([Number(root.receipt)]);
      expect(await activateWorkspaceEventTask(activations[0].action_input.payload)).toMatchObject({ queued: 0,
        invalidCausalPath: false, depthLimited: cap === 'depth', causalBreadthLimited: cap === 'breadth' });
    }
  });

  it.each(['knowledge', 'successor', 'notification', 'submission'] as const)('rejects forged causal provenance from %s input', async (entrypoint) => {
    const f = await fixture();
    await f.receiverSdk.entitySchema.updateType({ slug: '$member', event_kinds: { 'product.issue': {
      inbox: { accept_from: 'authenticated_workspaces', recipients: 'admins' }, metadataSchema: { type: 'object' },
    } } });
    const original = await f.sdk.notifications.submit({ ...f.message, idempotency_key: 'original-for-provenance-copy' });
    const [broker] = await f.sql`SELECT metadata FROM events WHERE id = ${Number(original.receipt)}`;
    const forged = { ...broker.metadata, inbox_submission: { ...broker.metadata.inbox_submission,
      automation_id: f.automationId, run_id: 1 } };
    let eventId: number;
    if (entrypoint === 'notification') {
      const sent = await f.receiverSdk.notifications.send({ title: f.message.title, body: f.message.body,
        semantic_type: f.message.inbox, data: forged, idempotency_key: `inbox:${'f'.repeat(64)}` });
      eventId = Number(sent.event_id);
    } else if (entrypoint === 'submission') {
      const sent = await f.sdk.notifications.submit({ ...f.message, data: forged, idempotency_key: 'forged-payload' });
      eventId = Number(sent.receipt);
    } else {
      const saved = await f.receiverSdk.knowledge.save({ title: f.message.title, content: f.message.body,
        semantic_type: f.message.inbox, payload_type: 'empty', payload_data: f.message.data,
        metadata: forged, idempotency_key: `inbox:${'f'.repeat(64)}`,
        ...(entrypoint === 'successor' ? { supersedes_event_id: Number(original.receipt) } : {}) }) as { id: number };
      eventId = Number(saved.id);
      // Neither copying the metadata nor superseding the original transfers
      // its durable target rows to the caller-authored event.
      expect(await f.sql`SELECT event_id FROM notification_targets WHERE event_id = ${eventId}`).toHaveLength(0);
      expect(await f.sql`SELECT event_id FROM notification_targets WHERE event_id = ${Number(original.receipt)}`).toHaveLength(1);
    }
    const payload = { organizationId: f.receiver.org.id, eventId, rootEventIds: [eventId], depth: 1 };
    expect(await activateWorkspaceEventTask({ ...payload, causalAutomationIds: [f.automationId] })).toMatchObject({
      invalidCausalPath: true, queued: 0 });
    expect(await activateWorkspaceEventTask({ ...payload, causalAutomationIds: [] })).toMatchObject({
      invalidCausalPath: false, queued: 1 });
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
  });

  it('does not reactivate an Automation submitting to its own workspace inbox', async () => {
    const f = await fixture();
    const run = await queue.createAutomationRun({ organizationId: f.receiver.org.id, automationId: f.automationId,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual' });
    await f.sql`UPDATE automations SET delivery_target = '{"connection_id":999999,"channel_id":"slack:C_SYNTHETIC"}'::jsonb
      WHERE id = ${f.automationId}`;
    const sdk = automationSdk(f, f.automationId, run.runId);
    const message = { ...f.message, idempotency_key: `self-report:${run.runId}` };
    const receipt = await sdk.notifications.submit(message);
    expect(await sdk.notifications.submit(message)).toEqual(receipt);
    const eventId = Number(receipt.receipt);
    await activate(f, eventId);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
    const [event] = await f.sql`SELECT automation_id, run_id, metadata FROM events WHERE id = ${eventId}`;
    expect(event).toMatchObject({ automation_id: f.automationId, run_id: run.runId });
    expect(event.metadata.delivery_request).toMatchObject({ strictAutomationTarget: false, targets: [] });
    const [activation] = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${String(eventId)}`;
    expect(activation.action_input.payload).toMatchObject({ rootEventIds: [eventId],
      causalAutomationIds: [f.automationId], depth: 1 });
  });

  it('inherits the producing run ancestry and stops indirect inbox re-entry', async () => {
    const f = await fixture();
    const agent = await createTestAgent({ organizationId: f.receiver.org.id, ownerUserId: f.receiver.user.id });
    const created = await f.receiverSdk.automations.create({ slug: 'synthetic-upstream-reporter', managed_agent_id: agent.agentId,
      prompt: 'Submit a synthetic report.', triggers: [{ kind: 'event', source: 'workspace', event_types: ['product.issue'],
        execution: 'window', active_run: 'queue' }] });
    const upstreamId = Number(created.automation_id);
    const upstreamRun = await queue.createAutomationRun({ organizationId: f.receiver.org.id, automationId: upstreamId,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'manual' });
    const root = await automationSdk(f, upstreamId, upstreamRun.runId).notifications.submit({ ...f.message,
      idempotency_key: `upstream:${upstreamRun.runId}` });
    await activate(f, Number(root.receipt));
    const [consumerRun] = await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const receipt = await automationSdk(f, f.automationId, Number(consumerRun.id)).notifications.submit({ ...f.message,
      idempotency_key: `downstream:${consumerRun.id}` });
    const [activation] = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${receipt.receipt}`;
    expect(activation.action_input.payload).toMatchObject({ rootEventIds: [Number(root.receipt)],
      causalAutomationIds: [upstreamId, f.automationId], depth: 2 });
    await activate(f, Number(receipt.receipt));
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${upstreamId} AND run_type = 'automation'`).toHaveLength(1);
  });

  it.each(['depth', 'breadth'] as const)('terminates inbox activation at the causal %s cap while retaining the report', async (cap) => {
    const f = await fixture();
    const root = await f.sdk.notifications.submit({ ...f.message, idempotency_key: 'cap-root' });
    await activate(f, Number(root.receipt));
    const [run] = await f.sql`SELECT id, approved_input FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const signal = run.approved_input.trigger_signals[0];
    if (cap === 'depth') signal.depth = MAX_WORKSPACE_EVENT_DEPTH - 1;
    else signal.causal_automation_ids = Array.from({ length: MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS }, (_, i) => f.automationId + i + 1);
    await f.sql`UPDATE runs SET approved_input = ${f.sql.json({ ...run.approved_input,
      trigger_signal: signal, trigger_signals: [signal] })} WHERE id = ${run.id}`;
    const receipt = await automationSdk(f, f.automationId, Number(run.id)).notifications.submit({ ...f.message,
      idempotency_key: `cap-report:${run.id}` });
    expect(await f.sql`SELECT id FROM events WHERE id = ${Number(receipt.receipt)}`).toHaveLength(1);
    const activations = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${receipt.receipt}`;
    if (cap === 'depth') {
      expect(activations).toHaveLength(1);
      expect(await activateWorkspaceEventTask(activations[0].action_input.payload)).toMatchObject({ queued: 0, depthLimited: true });
    } else expect(activations).toHaveLength(0);
    expect(await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`).toHaveLength(1);
  });

  it.each(['ordinary', 'dismissed', 'nul-title', 'nul-body', 'nul-data'] as const)('lets a scheduled sending Automation submit through its real sandbox with %s provenance', async (scenario) => {
    const f = await fixture();
    const agent = await createTestAgent({ organizationId: f.sender.org.id, ownerUserId: f.sender.user.id });
    const message = { ...f.message, idempotency_key: 'authorized-automation-report',
      ...(scenario === 'nul-title' ? { title: 'Source\u0000 sync fails' } : {}),
      ...(scenario === 'nul-body' ? { body: 'Synthetic\u0000 operational report' } : {}),
      ...(scenario === 'nul-data' ? { data: { ...ISSUE_DATA, references: ['https://example.com/\u0000reproduction'] } } : {}),
    };
    const created = await f.sdk.automations.create({ slug: 'synthetic-authorized-reporter', managed_agent_id: agent.agentId,
      triggers: [{ kind: 'schedule', cron: '*/20 * * * *', execution: 'window', active_run: 'coalesce', skip_if_unchanged: false }],
      reaction_script: `export default async (_ctx, client) => client.notifications.submit(${JSON.stringify(message)});` });
    const automationId = Number(created.automation_id);
    const run = await queue.createAutomationRun({ organizationId: f.sender.org.id, automationId, agentId: agent.agentId,
      windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-01-01T00:20:00.000Z', dispatchSource: 'scheduled' });
    expect(await dispatchPendingAutomationRuns({ runIds: [run.runId] })).toMatchObject({ dispatched: 1, failed: 0 });
    const [task] = await f.sql`SELECT id FROM runs WHERE parent_run_id = ${run.runId} AND action_key = 'automation-script'`;
    await f.sql`UPDATE runs SET status = 'claimed' WHERE id = ${task.id}`;
    await runAutomationScriptTask({ organizationId: f.sender.org.id, automationId, sourceRunId: run.runId }, TEST_ENV, Number(task.id));
    const [completed] = await f.sql`SELECT status, action_output FROM runs WHERE id = ${run.runId}`;
    expect(completed.status).toBe('completed');
    const [report] = await f.sql`SELECT id, metadata, automation_id, run_id FROM events
      WHERE organization_id = ${f.receiver.org.id} AND semantic_type = 'product.issue'`;
    expect(report.metadata.inbox_submission).toMatchObject({ organization_id: f.sender.org.id,
      automation_id: automationId, run_id: run.runId });
    expect(report.automation_id).toBeNull();
    expect(report.run_id).toBeNull();
    const [activation] = await f.sql`SELECT action_input FROM runs WHERE action_key = 'activate-workspace-event'
      AND action_input->'payload'->>'eventId' = ${String(report.id)}`;
    expect(activation.action_input.payload).toMatchObject({ rootEventIds: [Number(report.id)],
      causalAutomationIds: [automationId], depth: 1 });
    expect(await activateWorkspaceEventTask({ ...activation.action_input.payload, causalAutomationIds: [] }))
      .toMatchObject({ invalidCausalPath: true, queued: 0 });
    if (scenario === 'dismissed') {
      expect(await deleteNotification(f.receiver.org.id, f.receiver.user.id, Number(report.id))).toBe(true);
      expect(await f.sql`SELECT event_id FROM notification_targets WHERE event_id = ${report.id}`).toHaveLength(0);
    }
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
      automationId: f.automationId, claimedBy: 'synthetic-issue-analysis', status: 'running' }))).toBe(true);
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
    const first = await triageIssueReport(context, client);
    expect(await triageIssueReport(context, client)).toEqual(first);
    const alerts = await f.receiverSdk.notifications.list({ limit: 50 });
    expect(alerts.notifications).toHaveLength(2);
    const tasks = await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`;
    expect(tasks).toHaveLength(1);
    const evidence = await f.sql`SELECT ${issue.entity.id}::bigint = ANY(entity_ids) AS linked_issue, payload_data FROM events WHERE organization_id = ${f.receiver.org.id} AND metadata ? '_lobu_idempotency_key' AND metadata->>'_lobu_idempotency_key' LIKE 'issue-triage:%'`;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].payload_data).toMatchObject({ report_id: receipt.id, verification: 'user_reported' });
    expect(evidence[0].linked_issue).toBe(true);
    const [unchanged] = await f.sql`SELECT metadata FROM entities WHERE id = ${issue.entity.id}`;
    expect(unchanged.metadata).toMatchObject({ seen_24h: 17, status: 'ongoing' });
    const outside = { ...context, extracted_data: { reports: [{ report_id: receipt.id + 1000000, summary: 'Outside report', kind: 'bug' }] } } as ReactionContext;
    await expect(triageIssueReport(outside, client)).rejects.toThrow('in this inbox');
    await expect(triageIssueReport({ ...context, extracted_data: { reports: [] } }, client)).rejects.toThrow('every report');
    const wrongIssue = { ...context, extracted_data: { reports: [{ report_id: receipt.id, summary: 'Reported failure', kind: 'bug', issue_id: tasks[0].id }] } } as ReactionContext;
    // An already persisted decision is replayed instead of rematched.
    expect(await triageIssueReport(wrongIssue, client)).toEqual(first);
  });

  it('accepts only reports in the published issue shape', async () => {
    const f = await fixture();
    const { kind: _kind, ...withoutKind } = ISSUE_DATA;
    for (const data of [withoutKind, { ...ISSUE_DATA, severity: 'high' }, { ...ISSUE_DATA, evidence: { failure_fingerprint: 'linkedin-connect' } }])
      await expect(f.sdk.notifications.submit({ ...f.message, data, idempotency_key: `bad-shape-${JSON.stringify(data).length}` }))
        .rejects.toThrow('does not match the published inbox schema');
    const listed = await f.sdk.notifications.listInboxes({ organization: f.receiver.org.slug });
    expect(listed.inboxes).toEqual([expect.objectContaining({ key: 'product.issue',
      input_schema: expect.objectContaining({ required: ['kind', 'expected', 'actual'] }) })]);
  });

  it('links a report that cites a failure fingerprint to that telemetry issue', async () => {
    const f = await fixture();
    const fingerprint = '0123456789abcdef0123456789abcdef';
    const issue = await f.receiverSdk.entities.create({ entity_type: 'issue', name: 'OperationFailed in linkedin.send_connection_request',
      slug: `issue-${fingerprint}`, metadata: { fingerprint, status: 'new', kind: 'system', seen_24h: 2 } });
    if (!issue.entity) throw new Error('Missing issue');
    const receipt = Number((await f.sdk.notifications.submit({ ...f.message, idempotency_key: 'fingerprinted-report',
      data: { ...ISSUE_DATA, evidence: { run_ids: [101, 108], failure_fingerprint: fingerprint } } })).receipt);
    await activate(f, receipt);
    const [queued] = await f.sql`SELECT id FROM runs WHERE automation_id = ${f.automationId} AND run_type = 'automation'`;
    const run = await prepareRun(f, Number(queued.id));
    const context = { sources: run.run_metadata.preparation_sources, window: { automation_id: f.automationId, run_id: Number(run.id),
      window_start: run.approved_input.window_start, window_end: run.approved_input.window_end },
    // The model found no issue; the cited fingerprint still names it.
    extracted_data: { reports: [{ report_id: receipt, summary: 'Reported connect failure; not yet reproduced.', kind: 'bug' }] } } as ReactionContext;
    expect(await triageIssueReport(context, f.receiverSdk as unknown as ReactionClient))
      .toMatchObject({ reports: [{ report_id: receipt, task_id: expect.any(Number) }] });
    const [evidence] = await f.sql`SELECT ${issue.entity.id}::bigint = ANY(entity_ids) AS linked_issue, payload_data FROM events
      WHERE organization_id = ${f.receiver.org.id} AND metadata->>'_lobu_idempotency_key' LIKE 'issue-triage:%'`;
    expect(evidence.linked_issue).toBe(true);
    expect(evidence.payload_data).toMatchObject({ issue_id: issue.entity.id, verification: 'user_reported' });
    const [unchanged] = await f.sql`SELECT metadata FROM entities WHERE id = ${issue.entity.id}`;
    expect(unchanged.metadata).toMatchObject({ seen_24h: 2, status: 'new' });
  });

  it('keeps burst deliveries in separate bounded runs, including reports larger than the preparation budget', async () => {
    const f = await fixture();
    const receiptIds: number[] = [];
    for (let index = 0; index < 3; index++) {
      const receipt = await f.sdk.notifications.submit({ ...f.message, title: `Synthetic burst report ${index}`,
        data: { ...ISSUE_DATA, references: ['https://example.com/' + 'a'.repeat(8000)] }, idempotency_key: `burst-${index}` });
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
      await expect(triageIssueReport({ ...context, extracted_data: { reports: receiptIds.map((report_id) => ({ report_id,
        summary: 'Cannot batch queued deliveries', kind: 'bug' })) } }, client)).rejects.toThrow('exactly once');
      await expect(triageIssueReport({ ...context, extracted_data: { reports: [{ report_id: receiptIds[(index + 1) % receiptIds.length],
        summary: 'Another queued delivery', kind: 'bug' }] } }, client)).rejects.toThrow('in this inbox');
      expect(await triageIssueReport(context, client)).toMatchObject({ reports: [{ report_id: receiptIds[index], task_id: expect.any(Number) }] });
    }
    const tasks = await f.sql`SELECT e.id FROM entities e JOIN entity_types t ON t.id = e.entity_type_id
      WHERE e.organization_id = ${f.receiver.org.id} AND t.slug = 'task'`;
    expect(tasks).toHaveLength(receiptIds.length);
    const alerts = await f.receiverSdk.notifications.list({ limit: 50 });
    expect(alerts.notifications).toHaveLength(receiptIds.length * 2);
  });
});
