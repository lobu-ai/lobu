import { beforeEach, describe, expect, it } from 'vitest';
import { activateWorkspaceEventTask } from '../../../automations/workspace-event';
import { enqueueWorkspaceEventActivations } from '../../../automations/workspace-event-enqueue';
import {
  MAX_WORKSPACE_EVENT_FANOUT,
  type WorkspaceEventActivationTaskPayload,
} from '../../../automations/workspace-event-contract';
import { type DbClient, pgBigintArray } from '../../../db/client';
import { createAutomationRun } from '../../../runs/queue-service';
import { validateSaveContentSemanticType } from '../../../utils/event-kind-validation';
import { insertEvent } from '../../../utils/insert-event';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { persistAutomationEventOutput } from '../../../utils/persist-automation-event-output';
import {
  AUTOMATION_EVENT_IDENTITY_NS,
  computeStableKey,
  formatAutomationEventIdentity,
} from '../../../utils/stable-keys';
import { computePendingWindow } from '../../../utils/window-utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';
import type { ToolContext } from '../../../tools/registry';

// Only consulted to authorize a row's own `entity_ids`; none of these rows carry any.
const UNLINKED_ROWS_CTX = {
  organizationId: 'unused',
  userId: null,
  memberRole: null,
  isAuthenticated: true,
} as ToolContext;

async function createResultRun(
  sql: DbClient,
  organizationId: string,
  automationId: number
): Promise<number> {
  const [run] = await sql<{ id: number }>`
    INSERT INTO runs (
      organization_id, run_type, automation_id, approval_status,
      status, action_output, completed_at
    ) VALUES (
      ${organizationId}, 'automation', ${automationId}, 'auto',
      'completed', '{}'::jsonb, current_timestamp
    )
    RETURNING id
  `;
  return Number(run.id);
}

describe('Automation event outputs', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('fails closed when an active non-task run owns the activation idempotency key', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Task Idempotency Collision Org' });
    const eventId = 424242;
    const idempotencyKey = `workspace-event-activation:${eventId}`;
    await sql`
      INSERT INTO runs (
        organization_id, run_type, status, idempotency_key
      ) VALUES (
        ${workspace.org.id}, 'internal', 'pending', ${idempotencyKey}
      )
    `;

    await expect(
      sql.begin((tx) =>
        enqueueWorkspaceEventActivations(tx as unknown as DbClient, [
          {
            organizationId: workspace.org.id,
            eventId,
            rootEventIds: [eventId],
            causalAutomationIds: [1],
            depth: 1,
          },
        ])
      )
    ).rejects.toThrow(/failed to enqueue transactional task/i);

    const rows = await sql<{ run_type: string }>`
      SELECT run_type
      FROM runs
      WHERE idempotency_key = ${idempotencyKey}
    `;
    expect(rows).toEqual([{ run_type: 'internal' }]);
  });

  it('accepts a custom output kind declared by any linked entity type', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Multi-Type Output Org' });
    await ensureMemberEntityType(workspace.org.id);
    const first = await createTestEntity({
      name: 'First typed entity',
      entity_type: 'first-output-type',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const second = await createTestEntity({
      name: 'Second typed entity',
      entity_type: 'second-output-type',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({ second_type_signal: { description: 'Second type signal' } })}
      WHERE organization_id = ${workspace.org.id}
        AND slug = 'second-output-type'
    `;

    await expect(
      validateSaveContentSemanticType(
        'second_type_signal',
        {},
        workspace.org.id,
        [first.id, second.id]
      )
    ).resolves.toMatchObject({ valid: true });
  });

  it('appends multiple events linked to their producing run', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Automation Event Output Org' });
    await ensureMemberEntityType(workspace.org.id);
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Observed account',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const unrelatedParent = await createTestEntity({
      name: 'Unrelated account',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'event-output-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: parent.id,
      slug: 'event-output-automation',
      prompt: 'Return notable observations as standard event drafts.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: {
        observations: { event: 'observation' },
        drafts: { event: 'draft_reply' },
      },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);
    await api.automations.update({
      automation_id: String(automationId),
      triggers: [
        { kind: 'schedule', cron: '0 9 * * *' },
        {
          kind: 'event',
          source: 'workspace',
          event_types: ['observation'],
          execution: 'window',
          active_run: 'coalesce',
        },
      ],
    });
    const consumer = (await api.automations.create({
      slug: 'observation-consumer',
      prompt: 'Handle the exact observation event.',
      triggers: [
        {
          kind: 'event',
          source: 'workspace',
          event_types: ['observation'],
          execution: 'window',
          active_run: 'queue',
        },
      ],
      sources: [
        {
          name: 'authored_context',
          query: 'SELECT id, payload_text, occurred_at FROM events WHERE false',
        },
      ],
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const consumerId = Number(consumer.automation_id);
    const unrelatedConsumer = (await api.automations.create({
      entity_id: unrelatedParent.id,
      slug: 'unrelated-observation-consumer',
      prompt: 'Only handle observations linked to the bound account.',
      triggers: [
        {
          kind: 'event',
          source: 'workspace',
          event_types: ['observation'],
          execution: 'window',
          active_run: 'queue',
        },
      ],
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const unrelatedConsumerId = Number(unrelatedConsumer.automation_id);
    await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationId}`;
    const pending = await computePendingWindow(sql as unknown as DbClient, automationId);
    const source = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'A source event the Automation can reply to.',
      occurred_at: new Date(pending.windowStart.getTime() + 60 * 60 * 1000),
      created_at: new Date(pending.windowStart.getTime() + 1),
    });
    const queued = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: agent.agentId,
      windowStart: pending.windowStart.toISOString(),
      windowEnd: pending.windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });
    await sql`
      UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${agent.agentId}`}
      WHERE id = ${queued.runId}
    `;
    const knowledge = (await api.knowledge.read({
      automation_id: automationId,
      run_id: queued.runId,
    })) as {
      window_token: string;
    };
    const extracted = {
      observations: [
        {
          title: 'Source reply',
          content: 'This is linked to the source event.',
          parent_event_id: source.id,
          idempotency_key: source.origin_id,
          metadata: { rank: 1 },
        },
        {
          title: 'Independent observation',
          content: 'This is another event from the same Automation run.',
          payload_type: 'markdown',
          metadata: { rank: 2 },
        },
      ],
      drafts: [
        {
          title: 'Draft reply to source',
          content: 'A reply the human can review before publishing.',
          parent_event_id: source.id,
          idempotency_key: `draft:${source.origin_id}`,
          metadata: {
            platform: 'linkedin',
            source_origin_id: source.origin_id,
            source_event_id: source.id,
          },
        },
      ],
    };

    await api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: knowledge.window_token,
      extracted_data: extracted,
      run_id: queued.runId,
    });

    const rows = await sql<{
      id: number;
      run_id: number;
      semantic_type: string;
      origin_parent_id: string | null;
      metadata: Record<string, unknown>;
    }>`
      SELECT id, run_id, semantic_type, origin_parent_id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'automation_output' IN ('observations', 'drafts')
      ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => Number(row.run_id) === queued.runId)).toBe(true);
    const observations = rows.filter(
      (row) => row.metadata.automation_output === 'observations'
    );
    const draft = rows.find((row) => row.metadata.automation_output === 'drafts');
    expect(observations).toHaveLength(2);
    expect(observations[0].origin_parent_id).toBe(source.origin_id);
    expect(observations[1].origin_parent_id).toBeNull();
    expect(draft).toMatchObject({
      semantic_type: 'draft_reply',
      origin_parent_id: source.origin_id,
    });
    expect(observations.map((row) => Number(row.metadata.rank))).toEqual([1, 2]);

    const activationTasks = await sql<{
      status: string;
      max_attempts: number;
      action_input: {
        name: string;
        payload: WorkspaceEventActivationTaskPayload;
      };
    }>`
      SELECT status, max_attempts, action_input
      FROM runs
      WHERE run_type = 'task'
        AND action_key = 'activate-workspace-event'
        AND organization_id = ${workspace.org.id}
      ORDER BY id
    `;
    expect(activationTasks).toHaveLength(2);
    expect(
      activationTasks.every(
        (task) => task.status === 'pending' && Number(task.max_attempts) === 5
      )
    ).toBe(true);
    expect(
      activationTasks.map((task) => Number(task.action_input.payload.eventId))
    ).toEqual(observations.map((row) => Number(row.id)));
    expect(
      activationTasks.every(
        (task) =>
          task.action_input.name === 'activate-workspace-event' &&
          task.action_input.payload.depth === 1 &&
          task.action_input.payload.causalAutomationIds[0] === automationId &&
          task.action_input.payload.rootEventIds.length === 1 &&
          task.action_input.payload.rootEventIds[0] ===
            task.action_input.payload.eventId
      )
    ).toBe(true);

    const observationTask = activationTasks.find((task) =>
      observations.some(
        (event) => Number(event.id) === Number(task.action_input.payload.eventId)
      )
    );
    if (!observationTask)
      throw new Error('Observation activation task was not written');
    const activation = await activateWorkspaceEventTask(
      observationTask.action_input.payload,
      sql
    );
    expect(activation).toMatchObject({ matched: 1, queued: 1 });
    await activateWorkspaceEventTask(observationTask.action_input.payload, sql);
    const downstreamRuns = await sql`
      SELECT approved_input
      FROM runs
      WHERE run_type = 'automation'
        AND automation_id = ${consumerId}
    `;
    expect(downstreamRuns).toHaveLength(1);
    expect(downstreamRuns[0].approved_input).toMatchObject({
      trigger_execution: 'window',
      delivery_ids: [
        `workspace-event:${observationTask.action_input.payload.eventId}`,
      ],
      trigger_signal: {
        kind: 'event',
        source: 'workspace',
        event_id: observationTask.action_input.payload.eventId,
        causal_automation_ids: [automationId],
        depth: 1,
      },
    });
    expect(
      await sql`
        SELECT id
        FROM runs
        WHERE run_type = 'automation'
          AND automation_id = ${unrelatedConsumerId}
      `
    ).toHaveLength(0);

    const triggerRead = (await api.knowledge.read({
      automation_id: consumerId,
      content_ids: [Number(observationTask.action_input.payload.eventId)],
      since: pending.windowStart.toISOString(),
      until: pending.windowEnd.toISOString(),
      limit: 25,
    })) as {
      content: Array<{ id: number }>;
      window_token: string;
    };
    expect(triggerRead.content.map((item) => Number(item.id))).toEqual([
      Number(observationTask.action_input.payload.eventId),
    ]);
    expect(triggerRead.window_token).toBeTruthy();
    const triggerBatchRead = (await api.knowledge.read({
      automation_id: consumerId,
      content_ids: observations.map((item) => Number(item.id)),
      since: pending.windowStart.toISOString(),
      until: pending.windowEnd.toISOString(),
      limit: 1,
    })) as { content: Array<{ id: number }> };
    expect(
      triggerBatchRead.content.map((item) => Number(item.id)).sort((a, b) => a - b)
    ).toEqual(observations.map((item) => Number(item.id)).sort((a, b) => a - b));

    const supersededOutput = await insertEvent({
      entityIds: [parent.id],
      organizationId: workspace.org.id,
      originId: 'superseded-workspace-output',
      content: 'This output became stale before its activation task ran.',
      semanticType: 'observation',
      automationId: automationId,
    });
    await insertEvent({
      entityIds: [parent.id],
      organizationId: workspace.org.id,
      originId: 'replacement-workspace-output',
      content: 'This is the current replacement output.',
      semanticType: 'observation',
      automationId: automationId,
      supersedesEventId: supersededOutput.id,
    });
    await expect(
      activateWorkspaceEventTask(
        {
          organizationId: workspace.org.id,
          eventId: supersededOutput.id,
          rootEventIds: [supersededOutput.id],
          causalAutomationIds: [automationId],
          depth: 1,
        },
        sql
      )
    ).resolves.toMatchObject({
      matched: 0,
      queued: 0,
    });

    await expect(
      activateWorkspaceEventTask(
        {
          ...observationTask.action_input.payload,
          causalAutomationIds: [automationId + 1],
        },
        sql
      )
    ).resolves.toMatchObject({
      matched: 0,
      queued: 0,
      invalidCausalPath: true,
    });
    await expect(
      activateWorkspaceEventTask(
        {
          ...observationTask.action_input.payload,
          causalAutomationIds: [automationId, 0],
        },
        sql
      )
    ).rejects.toThrow(/invalid workspace event activation task payload/i);
    await expect(
      activateWorkspaceEventTask(
        {
          ...observationTask.action_input.payload,
          causalAutomationIds: [automationId, automationId + 1000],
        },
        sql
      )
    ).resolves.toMatchObject({ invalidCausalPath: false });

    const otherObservationTask = activationTasks.find(
      (task) =>
        Number(task.action_input.payload.eventId) !==
          Number(observationTask.action_input.payload.eventId) &&
        observations.some(
          (event) =>
            Number(event.id) === Number(task.action_input.payload.eventId)
        )
    );
    if (!otherObservationTask)
      throw new Error('Second observation activation task was not written');
    await sql`
      UPDATE automations
      SET current_version_id = NULL
      WHERE id = ${consumerId}
    `;
    expect(
      await activateWorkspaceEventTask(
        otherObservationTask.action_input.payload,
        sql
      )
    ).toMatchObject({ matched: 0, queued: 0 });
    expect(
      await sql`
        SELECT id
        FROM runs
        WHERE run_type = 'automation'
          AND automation_id = ${consumerId}
      `
    ).toHaveLength(1);

    const fanoutConsumerIds: number[] = [];
    for (let index = 0; index <= MAX_WORKSPACE_EVENT_FANOUT; index++) {
      const fanoutConsumer = (await api.automations.create({
        slug: `fanout-observation-consumer-${index}`,
        prompt: 'Handle the observation event.',
        triggers: [
          {
            kind: 'event',
            source: 'workspace',
            event_types: ['observation'],
            execution: 'window',
            active_run: 'queue',
          },
        ],
        managed_agent_id: agent.agentId,
      })) as { automation_id: string };
      fanoutConsumerIds.push(Number(fanoutConsumer.automation_id));
    }
    expect(
      await activateWorkspaceEventTask(
        otherObservationTask.action_input.payload,
        sql
      )
    ).toMatchObject({
      matched: MAX_WORKSPACE_EVENT_FANOUT,
      queued: MAX_WORKSPACE_EVENT_FANOUT,
      fanoutLimited: true,
    });
    const fanoutRuns = await sql<{ automation_id: number }>`
      SELECT automation_id
      FROM runs
      WHERE run_type = 'automation'
        AND automation_id = ANY(${pgBigintArray(fanoutConsumerIds)}::bigint[])
      ORDER BY automation_id
    `;
    expect(fanoutRuns.map((row) => Number(row.automation_id))).toEqual(
      fanoutConsumerIds.slice(0, MAX_WORKSPACE_EVENT_FANOUT)
    );

    // A source-derived idempotency key is intentionally stronger than the
    // positional retry key: a later run that rediscovers the same post
    // reuses the original event instead of appending a duplicate.
    const laterRun = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: agent.agentId,
      windowStart: pending.windowStart.toISOString(),
      windowEnd: pending.windowEnd.toISOString(),
      dispatchSource: 'scheduled',
    });
    const reused = await sql.begin(async (tx) =>
      persistAutomationEventOutput({
        tx: tx as unknown as DbClient,
        rows: [extracted.observations[0]],
        outputName: 'observations',
        output: { event: 'observation' },
        automationId,
        versionId: null,
        organizationId: workspace.org.id,
        runId: laterRun.runId,
        boundEntityIds: [parent.id],
        ctx: UNLINKED_ROWS_CTX,
        validContentIds: new Set([source.id]),
        occurredAt: pending.windowEnd.toISOString(),
        createdBy: ownerUserId,
      })
    );
    expect(reused).toHaveLength(1);
    expect(reused[0].id).toBe(observations[0].id);

    await expect(
      sql.begin((tx) =>
        persistAutomationEventOutput({
          tx: tx as unknown as DbClient,
          rows: [
            { content: 'First draft', idempotency_key: 'duplicate-in-one-output' },
            { content: 'Different draft', idempotency_key: 'duplicate-in-one-output' },
          ],
          outputName: 'drafts',
          output: { event: 'draft_reply' },
          automationId,
          versionId: null,
          organizationId: workspace.org.id,
          runId: laterRun.runId,
          boundEntityIds: [parent.id],
          ctx: UNLINKED_ROWS_CTX,
          validContentIds: new Set([source.id]),
          occurredAt: pending.windowEnd.toISOString(),
          createdBy: ownerUserId,
        })
      )
    ).rejects.toThrow(/duplicate.*idempotency/i);
  });

  it('supersedes the prior event per key, keeping history append-only', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Keyed Event Output Org' });
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Subject',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'keyed-output-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: parent.id,
      slug: 'keyed-output-automation',
      prompt: 'Emit refined voice profiles.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { profiles: { event: 'observation', key: ['channel', 'mode'] } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    const baseParams = {
      outputName: 'profiles',
      output: { event: 'observation', key: ['channel', 'mode'] },
      automationId,
      organizationId: workspace.org.id,
      boundEntityIds: [parent.id],
      ctx: UNLINKED_ROWS_CTX,
      validContentIds: new Set<number>(),
      occurredAt: new Date().toISOString(),
      createdBy: ownerUserId,
    };
    const persist = async (rows: unknown[]) => {
      const runId = await createResultRun(
        sql as unknown as DbClient,
        workspace.org.id,
        automationId
      );
      return sql.begin((tx) =>
        persistAutomationEventOutput({
          tx: tx as unknown as DbClient,
          rows,
          runId,
          ...baseParams,
        })
      );
    };

    // Run 1: two profiles under distinct keys.
    await persist(
      [
        { content: 'X voice v1', metadata: { channel: 'x', mode: 'voice' } },
        { content: 'X taste v1', metadata: { channel: 'x', mode: 'taste' } },
      ]
    );
    let rows = await sql<{
      id: number;
      payload_text: string;
      supersedes_event_id: number | null;
      superseded_by: number | null;
    }>`
      SELECT id, payload_text, supersedes_event_id, superseded_by
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'automation_output' = 'profiles'
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.supersedes_event_id === null)).toHaveLength(2);

    // Run 2: refine only the x:voice profile. The new event supersedes the old
    // head; x:taste is untouched and still a head.
    await persist([{ content: 'X voice v2', metadata: { channel: 'x', mode: 'voice' } }]);
    rows = await sql<{
      id: number;
      payload_text: string;
      supersedes_event_id: number | null;
      superseded_by: number | null;
    }>`
      SELECT id, payload_text, supersedes_event_id, superseded_by
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'automation_output' = 'profiles'
      ORDER BY id
    `;
    expect(rows).toHaveLength(3);
    const v1 = rows.find((row) => row.payload_text === 'X voice v1');
    const v2 = rows.find((row) => row.payload_text === 'X voice v2');
    const taste = rows.find((row) => row.payload_text === 'X taste v1');
    expect(v1).toMatchObject({ supersedes_event_id: null, superseded_by: v2?.id ?? null });
    expect(v2).toMatchObject({ supersedes_event_id: v1?.id ?? null, superseded_by: null });
    expect(taste).toMatchObject({ supersedes_event_id: null, superseded_by: null });

    // An unkeyed row carrying the same metadata is INERT: identity is stamped by
    // the writer, never inferred from metadata at read time. A row nothing
    // claimed identity for cannot be hijacked as a supersede target — which is
    // what the old `metadata @>` probe did, and why a shrunk key declaration
    // could silently supersede a DIFFERENT key's head.
    const unkeyed = await sql<{ id: number }>`
      INSERT INTO events (
        organization_id, origin_id, title, payload_text, semantic_type, client_id, metadata
      ) VALUES (
        ${workspace.org.id}, ${'legacy-seed'}, ${'Legacy'}, ${'X voice legacy'},
        ${'observation'}, NULL, ${sql.json({ channel: 'x', mode: 'voice' })}
      )
      RETURNING id
    `;
    await persist([{ content: 'X voice v3', metadata: { channel: 'x', mode: 'voice' } }]);
    const v3 = await sql<{ id: number; supersedes_event_id: number | null }>`
      SELECT id, supersedes_event_id
      FROM events
      WHERE organization_id = ${workspace.org.id} AND payload_text = 'X voice v3'
    `;
    // The run extends its OWN chain (v2 was the head), and leaves the unkeyed
    // row exactly as it found it.
    expect(v3[0].supersedes_event_id).toBe(v2?.id);
    const untouched = await sql<{ superseded_by: number | null; identity_key: string | null }>`
      SELECT superseded_by, identity_key FROM events WHERE id = ${unkeyed[0].id}
    `;
    expect(untouched[0]).toMatchObject({ superseded_by: null, identity_key: null });

    // Pre-existing rows are adopted DELIBERATELY, by scripts/backfill-event-identity.ts
    // stamping the identity the writer computes — not by a lucky metadata match at
    // runtime. Once stamped, the chain is the Automation's to extend. This is the
    // same call the backfill makes.
    const adopted = await sql<{ id: number }>`
      INSERT INTO events (
        organization_id, origin_id, title, payload_text, semantic_type, client_id,
        metadata, identity_ns, identity_key
      ) VALUES (
        ${workspace.org.id}, ${'migrated-seed'}, ${'Migrated'}, ${'Y voice legacy'},
        ${'observation'}, NULL, ${sql.json({ channel: 'y', mode: 'voice' })},
        ${AUTOMATION_EVENT_IDENTITY_NS},
        ${formatAutomationEventIdentity(
          'observation',
          computeStableKey({ channel: 'y', mode: 'voice' }, ['channel', 'mode'])
        )}
      )
      RETURNING id
    `;
    await persist([{ content: 'Y voice v1', metadata: { channel: 'y', mode: 'voice' } }]);
    const adoptedNext = await sql<{ supersedes_event_id: number | null }>`
      SELECT supersedes_event_id
      FROM events
      WHERE organization_id = ${workspace.org.id} AND payload_text = 'Y voice v1'
    `;
    expect(adoptedNext[0].supersedes_event_id).toBe(adopted[0].id);

    // Missing key field and duplicate key within one array are rejected. The
    // message comes from computeStableKey — the one validator — so it names the
    // offending field rather than the declaration as a whole.
    await expect(
      persist([{ content: 'no key', metadata: { channel: 'x' } }])
    ).rejects.toThrow(/invalid key \(channel, mode\).*'mode' must be present/);
    await expect(
      persist(
        [
          { content: 'dup 1', metadata: { channel: 'y', mode: 'voice' } },
          { content: 'dup 2', metadata: { channel: 'y', mode: 'voice' } },
        ]
      )
    ).rejects.toThrow(/duplicate key/);
  });

  it('rejects the loser when concurrent output versions reuse a key for different event types', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Automation Event Output Race Org' });
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Observed account',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'event-output-race-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: parent.id,
      slug: 'event-output-race-automation',
      prompt: 'Return one durable event.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      outputs: { result: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    let arrivals = 0;
    let release!: () => void;
    const bothPrechecksComplete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pauseAfterInitialLookup = (tx: DbClient): DbClient => {
      let paused = false;
      const wrapped = (async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const rows = await tx(strings, ...values);
        if (!paused && strings.join('').includes("metadata->>'_lobu_idempotency_key'")) {
          paused = true;
          arrivals += 1;
          if (arrivals === 2) release();
          await bothPrechecksComplete;
        }
        return rows;
      }) as DbClient;
      wrapped.unsafe = tx.unsafe.bind(tx);
      wrapped.array = tx.array.bind(tx);
      wrapped.json = tx.json.bind(tx);
      wrapped.savepoint = tx.savepoint.bind(tx);
      return wrapped;
    };
    const persist = async (event: 'observation' | 'draft_reply') => {
      const runId = await createResultRun(
        sql as unknown as DbClient,
        workspace.org.id,
        automationId
      );
      return sql.begin((tx) =>
        persistAutomationEventOutput({
          tx: pauseAfterInitialLookup(tx as unknown as DbClient),
          rows: [{ content: `${event} result`, idempotency_key: 'shared-source' }],
          outputName: 'result',
          output: { event },
          automationId,
          versionId: null,
          organizationId: workspace.org.id,
          runId,
          boundEntityIds: [parent.id],
          ctx: UNLINKED_ROWS_CTX,
          validContentIds: new Set(),
          occurredAt: new Date().toISOString(),
          createdBy: ownerUserId,
        })
      );
    };

    const results = await Promise.allSettled([
      persist('observation'),
      persist('draft_reply'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ httpStatus: 409 }),
    });
  });

  it('gives each source item its own origin_id across runs in one period', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Origin Id Org' });
    const ownerUserId = workspace.users.owner.id;
    const parent = await createTestEntity({
      name: 'Radar subject',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'origin-id-agent',
    });
    const api = await TestApiClient.for({
      organizationId: workspace.org.id,
      userId: ownerUserId,
      memberRole: 'owner',
    });
    const created = (await api.automations.create({
      entity_id: parent.id,
      slug: 'origin-id-automation',
      prompt: 'Rank new posts as observation drafts.',
      triggers: [{ kind: 'schedule', cron: '25 * * * *' }],
      outputs: { signals: { event: 'observation' } },
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    // Each run ranks a different post and carries that post's own origin_id as
    // idempotency_key, so every row is a distinct source item, not a retry.
    const persistOne = async (idempotencyKey: string, content: string) => {
      const runId = await createResultRun(
        sql as unknown as DbClient,
        workspace.org.id,
        automationId
      );
      return sql.begin((tx) =>
        persistAutomationEventOutput({
          tx: tx as unknown as DbClient,
          rows: [{ content, idempotency_key: idempotencyKey }],
          outputName: 'signals',
          output: { event: 'observation' },
          automationId,
          versionId: null,
          organizationId: workspace.org.id,
          runId,
          boundEntityIds: [parent.id],
          ctx: UNLINKED_ROWS_CTX,
          validContentIds: new Set<number>(),
          occurredAt: new Date().toISOString(),
          createdBy: ownerUserId,
        })
      );
    };

    const first = await persistOne('2085196582245355991', 'johnzabroski / x');
    const second = await persistOne(
      'li_home_fInCfPOAe17mHCT5JA8II',
      'Wes McKinney / linkedin'
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // Two different posts, so two different events...
    expect(second[0].id).not.toBe(first[0].id);
    // ...and therefore two different stable identities. Deriving origin_id from
    // the array index instead made every run's item N collide, so one origin_id
    // resolved to a set of unrelated posts (prod: 8 live rows under
    // one legacy positional identity, each a different author).
    expect(second[0].origin_id).not.toBe(first[0].origin_id);

    const live = await sql<{ origin_id: string; payload_text: string }>`
      SELECT origin_id, payload_text
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND metadata->>'automation_output' = 'signals'
      ORDER BY id
    `;
    expect(live).toHaveLength(2);
    expect(new Set(live.map((row) => row.origin_id)).size).toBe(2);

    // The source-derived idempotency key still wins over the positional retry
    // key: rediscovering the same post reuses its event rather than minting a
    // second origin_id for it.
    const rediscovered = await persistOne('2085196582245355991', 'johnzabroski / x');
    expect(rediscovered[0].id).toBe(first[0].id);
    expect(rediscovered[0].origin_id).toBe(first[0].origin_id);
  });
});
