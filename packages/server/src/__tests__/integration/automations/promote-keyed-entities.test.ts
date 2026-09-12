/**
 * Integration test for promoting keyed Automation run rows into
 * real child entities.
 *
 * complete_window persists each declared entity output row under the automation's
 * bound parent, keyed by an internal stable identity and an
 * entity_identities `automation_key` claim (the idempotency lock). Origin
 * provenance (run_id / stable_key / automation_id) is stamped onto the child
 * entity's own metadata — there is no separate observation event.
 *
 * Proves:
 *   1. Completing a run with keyed rows creates the expected child entities
 *      (resolvable by stable key), each carrying its origin run in metadata.
 *   2. Replaying the same run
 *      creates NO duplicate entities.
 */

import { slugify } from '@lobu/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { createAutomationRun } from '../../../runs/queue-service';
import { computePendingWindow } from '../../../utils/window-utils';
import { compileEntityRule } from '../../../authz/entity-rule-executor';
import { promoteAutomationEntityOutput } from '../../../utils/promote-keyed-entities';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';
import {
  computeStableKey,
  formatAutomationEntityIdentity,
} from '../../../utils/stable-keys';

const OUTPUTS = {
  problems: { entity: 'topic', key: ['category', 'name'] },
};

/**
 * Per-record shape owned by the `topic` entity type's `metadata_schema`.
 * The automation's extraction contract is DERIVED from this (an array of these
 * records in `outputs.problems`), never authored on the Automation.
 */
const TOPIC_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    name: { type: 'string' },
  },
  additionalProperties: true,
};

const KEYED_EXTRACTED_DATA = {
  problems: [
    { category: 'Stability', name: 'App Crashes' },
    { category: 'Performance', name: 'Slow Loading' },
  ],
};

const stableTopicKey = (category: string, name: string) =>
  computeStableKey({ category, name }, ['category', 'name']);
const APP_CRASHES_KEY = stableTopicKey('Stability', 'App Crashes');
const SLOW_LOADING_KEY = stableTopicKey('Performance', 'Slow Loading');
const topicIdentity = (automationId: number, stableKey: string) =>
  formatAutomationEntityIdentity(automationId, 'problems', 'topic', stableKey);

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

/**
 * Block until some backend is waiting on a transaction lock — the state the
 * losing promotion's INSERT enters while the sibling slug it collides with is
 * still uncommitted. Polls on a THIRD connection so it observes A and B rather
 * than participating.
 *
 * Releasing A directly instead would be a coin flip, not a race: A usually
 * commits before B has even acquired its connection, so B's identity probe
 * finds the committed claim and returns down the ordinary idempotent path,
 * never reaching the lost-race cleanup this test exists to prove. Throws rather
 * than hanging, so a future version where the race stops being reachable fails
 * loudly instead of silently testing nothing.
 */
async function waitForBlockedEntityInsert(
  sql: ReturnType<typeof getTestDb>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO entities%'
    `;
    if (Number(rows[0].count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'no entity INSERT blocked on the uncommitted sibling slug; the promotion race was not reached'
  );
}

/** Owner web-session auth context for invoking manage_operations.approve. */
function ownerAuthCtx(orgId: string, userId: string): AuthContext {
  return {
    organizationId: orgId,
    tokenOrganizationId: orgId,
    userId,
    memberRole: 'owner',
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    requestUrl: `http://localhost/api/${orgId}`,
    baseUrl: '',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

async function setupKeyedAutomation() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Keyed Promotion Org' });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  // Promotion resolves the target type itself; ensure `topic` exists in the
  // org, and own the extraction contract on the type's `metadata_schema`.
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
    VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_RECORD_SCHEMA)}, current_timestamp, current_timestamp)
    ON CONFLICT DO NOTHING
  `;

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'keyed-agent',
    name: 'Keyed Agent',
  });

  const automation = (await workspace.owner.automations.create({
    entity_id: parentEntity.id,
    slug: 'keyed-automation',
    name: 'Keyed Automation',
    prompt: 'Extract problems for {{entities}}.',
    outputs: OUTPUTS,
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    managed_agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  await sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${automationId}`;

  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });

  return {
    sql,
    dbClient,
    workspace,
    api,
    parentEntityId: parentEntity.id,
    agent,
    automationId,
  };
}

/**
 * Queue + claim a running automation run for the automation's pending window so a
 * completion lands on the run-driven path (which makes the SAME window
 * reusable for an idempotent replay).
 */
async function queueRunningRun(ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>) {
  const { windowStart, windowEnd } = await computePendingWindow(ctx.dbClient, ctx.automationId);
  const queued = await createAutomationRun({
    organizationId: ctx.workspace.org.id,
    automationId: ctx.automationId,
    agentId: ctx.agent.agentId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dispatchSource: 'scheduled',
  });
  await ctx.sql`
    UPDATE runs SET status = 'running', claimed_at = NOW(), claimed_by = ${`lobu:${ctx.agent.agentId}`}
    WHERE id = ${queued.runId}
  `;
  return queued.runId;
}

/**
 * A read_knowledge window token to complete against (reused for replays).
 *
 * Bound with `run_id`: on the arrival axis an unbound read recomputes
 * `[mark, horizon)` against a clock that has moved since the run was queued, so
 * its bounds would no longer match the run's snapshot and `complete_window`
 * would reject them. Real callers bind the same way.
 */
async function readWindowToken(
  ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>,
  runId: number
): Promise<string> {
  const content = (await ctx.api.knowledge.read({
    automation_id: ctx.automationId,
    run_id: runId,
  })) as {
    window_token: string;
  };
  return content.window_token;
}

async function nextCompletion(
  ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>
): Promise<{ runId: number; token: string }> {
  const runId = await queueRunningRun(ctx);
  return { runId, token: await readWindowToken(ctx, runId) };
}

async function completeWithToken(
  ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>,
  windowToken: string,
  runId: number,
  extractedData: Record<string, unknown> = KEYED_EXTRACTED_DATA
): Promise<number> {
  const completion = (await ctx.api.automations.completeWindow({
    automation_id: String(ctx.automationId),
    run_id: runId,
    window_token: windowToken,
    extracted_data: extractedData,
  })) as { action: string; run_id: number };
  expect(completion.action).toBe('complete_window');
  return completion.run_id;
}

describe('complete_window promotes keyed rows into entities (P2 phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates a child entity per keyed row, with origin run provenance in its metadata', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    const resultRunId = await completeWithToken(ctx, token, runId);

    // Two child entities, one per stable key, hung under the parent.
    const identities = await sql`
      SELECT ei.identifier, ei.entity_id, e.name, e.parent_id
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    expect(identities.map((r) => String(r.identifier))).toEqual([
      topicIdentity(
        ctx.automationId,
        computeStableKey(
          { category: 'Performance', name: 'Slow Loading' },
          ['category', 'name']
        )
      ),
      topicIdentity(
        ctx.automationId,
        computeStableKey(
          { category: 'Stability', name: 'App Crashes' },
          ['category', 'name']
        )
      ),
    ].sort());
    for (const row of identities) {
      expect(Number(row.parent_id)).toBe(parentEntityId);
    }

    // The promoted entities are of the configured type.
    const childTypes = await sql`
      SELECT et.slug, e.metadata->>'source' AS source
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.parent_id = ${parentEntityId}
        AND e.organization_id = ${workspace.org.id}
    `;
    expect(childTypes).toHaveLength(2);
    expect(childTypes.every((r) => String(r.slug) === 'topic')).toBe(true);
    expect(childTypes.every((r) => r.source === null)).toBe(true);

    // Origin provenance lives on the entity itself — each promoted child carries
    // its run_id / stable_key in metadata (no separate observation event).
    const childMeta = await sql`
      SELECT e.metadata
      FROM entities e
      JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    expect(childMeta).toHaveLength(2);
    const stableKeys = childMeta.map((r) => (r.metadata as Record<string, unknown>).stable_key);
    expect(stableKeys.sort()).toEqual([APP_CRASHES_KEY, SLOW_LOADING_KEY].sort());
    for (const row of childMeta) {
      const md = row.metadata as Record<string, unknown>;
      expect(Number(md.run_id)).toBe(resultRunId);
      expect(Number(md.automation_id)).toBe(ctx.automationId);
    }

    // The run carries a FIRST-CLASS change-set event listing what it applied —
    // even though these creates were auto-applied (no approval involved). This
    // is the run's own diff, not an approval artifact.
    const changeSet = await sql`
      SELECT title, metadata, entity_ids, run_id
      FROM current_event_records
      WHERE run_id = ${runId}
        AND organization_id = ${workspace.org.id}
        AND semantic_type = 'change_set'
    `;
    expect(changeSet).toHaveLength(1);
    const csMeta = changeSet[0].metadata as Record<string, unknown>;
    expect(csMeta.kind).toBe('automation_change_set');
    expect(Number(changeSet[0].run_id)).toBe(resultRunId);
    expect(Number(csMeta.created_count)).toBe(2);
    expect(Number(csMeta.updated_count)).toBe(0);
    const csChanges = csMeta.changes as Array<{
      kind: string;
      entityId: number;
    }>;
    expect(csChanges).toHaveLength(2);
    expect(csChanges.every((c) => c.kind === 'created')).toBe(true);
  });

  it('rejects duplicate exact keys instead of silently dropping an output row', async () => {
    const ctx = await setupKeyedAutomation();
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    await expect(
      ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', severity: 'high' },
            { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          ],
        },
      })
    ).rejects.toThrow(/duplicate.*key/i);

    const identities = await ctx.sql<{ count: number }>`
      SELECT COUNT(*)::int AS count
      FROM entity_identities
      WHERE organization_id = ${ctx.workspace.org.id}
        AND namespace = 'automation_key'
    `;
    expect(Number(identities[0].count)).toBe(0);
  });

  it('does not reuse an old-type entity when a later version retargets the output', async () => {
    const ctx = await setupKeyedAutomation();
    await ctx.sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (
        ${ctx.workspace.org.id},
        'issue',
        'Issue',
        ${ctx.sql.json(TOPIC_RECORD_SCHEMA)},
        current_timestamp,
        current_timestamp
      )
    `;
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    const extracted = {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'high' }],
    };
    await completeWithToken(ctx, token, runId, extracted);

    await ctx.api.automations.createVersion({
      automation_id: String(ctx.automationId),
      outputs: { problems: { entity: 'issue', key: ['category', 'name'] } },
    });
    const retargetedRunId = await queueRunningRun(ctx);
    const retargetedToken = await readWindowToken(ctx, retargetedRunId);
    await completeWithToken(ctx, retargetedToken, retargetedRunId, extracted);

    const promotedTypes = await ctx.sql<{ slug: string }>`
      SELECT et.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE ei.organization_id = ${ctx.workspace.org.id}
        AND ei.namespace = 'automation_key'
        AND ei.deleted_at IS NULL
      ORDER BY et.slug
    `;
    expect(promotedTypes.map((row) => row.slug)).toEqual(['issue', 'topic']);
  });

  it('keeps an exact in-window source_event_id and drops ungranted claims', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, parentEntityId } = ctx;

    // Stored after the Automation's arrival mark, so read_knowledge grants it in
    // the token's content_ids. Dated in the PAST: every read path carries
    // `occurred_at <= now()`, so a future date would hide the row whatever the
    // window said.
    const { windowStart } = await computePendingWindow(ctx.dbClient, ctx.automationId);
    expect(windowStart.getTime()).toBeLessThanOrEqual(Date.now());
    const inWindow = await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Content that exists in the org but is NOT part of this window's token:
    // stored long before the mark, so no window reaching forward can grant it.
    const outOfWindow = await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Unrelated content the agent must not be able to cite.',
      occurred_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await completeWithToken(ctx, token, runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', source_event_id: Number(inWindow.id) },
        {
          category: 'Performance',
          name: 'Slow Loading',
          source_event_id: Number(outOfWindow.id),
        },
        {
          category: 'Stability',
          name: 'Fractional Reference',
          source_event_id: Number(inWindow.id) + 0.5,
        },
        {
          category: 'Stability',
          name: 'String Reference',
          source_event_id: String(inWindow.id),
        },
      ],
    });

    const rows = await sql`
      SELECT ei.identifier, e.metadata->>'source_event_id' AS source_event_id
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    const byIdentifier = Object.fromEntries(
      rows.map((r) => [String(r.identifier), r.source_event_id])
    );

    // The verifiable claim survives; unverifiable values are stripped rather
    // than stored as false provenance. Every row still promotes.
    expect(byIdentifier[topicIdentity(ctx.automationId, APP_CRASHES_KEY)]).toBe(
      String(inWindow.id)
    );
    expect(
      byIdentifier[
        topicIdentity(
          ctx.automationId,
          stableTopicKey('Stability', 'Fractional Reference')
        )
      ]
    ).toBeNull();
    expect(byIdentifier[topicIdentity(ctx.automationId, SLOW_LOADING_KEY)]).toBeNull();
    expect(
      byIdentifier[
        topicIdentity(ctx.automationId, stableTopicKey('Stability', 'String Reference'))
      ]
    ).toBeNull();
    expect(Object.keys(byIdentifier)).toHaveLength(4);
  });

  it("a create=deny policy on the automation's OWNING AGENT blocks its promotions", async () => {
    // The v1.1 fix: an automation is its agent's autonomous mode, so the agent's own
    // envelope binds the automation. Pin entity create=deny to THIS automation's agent;
    // the promotion must create nothing. Before the fix the gate resolved the
    // automation as principal `automation:<id>` (agentId null), so this agent-scoped
    // deny never matched and the rows were created under the looser org default.
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId, parentEntityId, agent } = ctx;

    const policyRows = await sql<{ id: number }>`
      INSERT INTO write_approval_policies
        (organization_id, resource_class, principal_kind, principal_id)
      VALUES (${workspace.org.id}, 'entity', 'agent', ${agent.agentId})
      RETURNING id
    `;
    await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${Number(policyRows[0].id)}, 'create', 'deny')
    `;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await completeWithToken(ctx, token, runId);

    // No `topic` entities were promoted — the agent's deny bound the automation.
    const promoted = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c
      FROM entity_identities
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'automation_key'
        AND identifier LIKE ${`${automationId}::%`}
    `;
    expect(Number(promoted[0].c)).toBe(0);

    // Policy is the other decider, and its refusals need the same record: with
    // nothing created and nothing carded, the run's change set is all there is.
    const [changeSet] = await sql`
      SELECT metadata FROM current_event_records
      WHERE run_id = ${runId}
        AND organization_id = ${workspace.org.id}
        AND semantic_type = 'change_set'
    `;
    expect(changeSet).toBeDefined();
    const meta = changeSet.metadata as Record<string, unknown>;
    expect(Number(meta.created_count)).toBe(0);
    expect(Number(meta.denied_count)).toBeGreaterThan(0);
    const changes = meta.changes as Array<{
      kind: string;
      denied?: { source: string; reason: string };
    }>;
    expect(changes.every((c) => c.kind === 'denied')).toBe(true);
    expect(changes.every((c) => c.denied?.source === 'policy')).toBe(true);
    expect(changes.every((c) => (c.denied?.reason ?? '').length > 0)).toBe(true);

    const audits = await sql`
      SELECT metadata, payload_type
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND run_id = ${runId}
        AND semantic_type = 'change'
        AND metadata->>'category' = 'entity_write_denial'
      ORDER BY id
    `;
    expect(audits).toHaveLength(2);
    expect(
      audits.every(
        (event) =>
          event.payload_type === 'empty' &&
          event.metadata.denial_source === 'policy' &&
          event.metadata.operation === 'create' &&
          event.metadata.automation_id === automationId
      )
    ).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('App Crashes');
    expect(JSON.stringify(audits)).not.toContain('Slow Loading');
  });

  it("a create=approval policy on the OWNING AGENT cards the create instead of refusing it", async () => {
    // The sibling of the deny case above, and the branch that separates the two.
    // 'approval' and 'deny' both stop the inline insert, but only one is a refusal:
    // a held create must be QUEUED, and must not be written into the change set as
    // denied — recording it as a refusal makes the caller skip the carding branch,
    // so the row reads as rejected and the approval it was owed is never queued.
    // Drives the real `write_approval_policies` resolver through complete_window,
    // not a test interceptor.
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId, parentEntityId, agent } = ctx;

    const policyRows = await sql<{ id: number }>`
      INSERT INTO write_approval_policies
        (organization_id, resource_class, principal_kind, principal_id)
      VALUES (${workspace.org.id}, 'entity', 'agent', ${agent.agentId})
      RETURNING id
    `;
    await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${Number(policyRows[0].id)}, 'create', 'approval')
    `;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await completeWithToken(ctx, token, runId);

    // Held, not written: no promotion claimed an identity.
    const promoted = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c
      FROM entity_identities
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'automation_key'
        AND identifier LIKE ${`${automationId}::%`}
    `;
    expect(Number(promoted[0].c)).toBe(0);

    // Held, not refused: an approval card exists for the create...
    const cards = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c
      FROM current_event_records
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'operation'
        AND interaction_type = 'approval'
        AND interaction_status = 'pending'
    `;
    expect(Number(cards[0].c)).toBeGreaterThan(0);

    // ...and nothing was refused. complete-window writes a change_set only when
    // the run produced at least one change (`entityChanges.length > 0`), and a
    // held create produces none — so the absence of the event IS the assertion.
    // Guarding this behind `if (changeSet)` would make it never run: reporting the
    // deferral as a refusal writes a change_set, which is exactly what must fail.
    const [changeSet] = await sql`
      SELECT metadata FROM current_event_records
      WHERE run_id = ${runId}
        AND organization_id = ${workspace.org.id}
        AND semantic_type = 'change_set'
    `;
    expect(changeSet).toBeUndefined();
  });

  it('is idempotent across a same-run replay — no duplicate entities', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId, parentEntityId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    // Reuse the same token and run ID for an idempotent retry.
    const token = await readWindowToken(ctx, runId);
    const firstResultRunId = await completeWithToken(ctx, token, runId);

    const entitiesAfterFirst = await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${workspace.org.id} AND namespace = 'automation_key'
      ORDER BY entity_id
    `;
    expect(entitiesAfterFirst).toHaveLength(2);

    const secondResultRunId = await completeWithToken(ctx, token, runId);
    expect(secondResultRunId).toBe(firstResultRunId);

    const entitiesAfterSecond = await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${workspace.org.id} AND namespace = 'automation_key'
      ORDER BY entity_id
    `;
    // Same entities resolved — NO duplicates.
    expect(entitiesAfterSecond.map((r) => Number(r.entity_id)).sort()).toEqual(
      entitiesAfterFirst.map((r) => Number(r.entity_id)).sort()
    );
    expect(entitiesAfterSecond).toHaveLength(2);

    // No entity-count growth under the parent.
    const childCount = await sql`
      SELECT COUNT(*)::int AS c FROM entities
      WHERE parent_id = ${parentEntityId} AND organization_id = ${workspace.org.id}
    `;
    expect(Number(childCount[0].c)).toBe(2);

    const changeSets = await sql`
      SELECT id, metadata->>'_lobu_idempotency_key' AS idempotency_key
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND run_id = ${runId}
        AND semantic_type = 'change_set'
    `;
    expect(changeSets).toHaveLength(1);
    expect(changeSets[0].idempotency_key).toBe(
      `automation:${automationId}:run:${runId}:change_set`
    );
  });

  it('hard-deletes the provisional entity after losing a concurrent identity race', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId, parentEntityId } = ctx;
    const resultRuns = await sql<{ id: number }[]>`
      INSERT INTO runs (organization_id, automation_id, run_type, status)
      VALUES
        (${workspace.org.id}, ${automationId}, 'automation', 'completed'),
        (${workspace.org.id}, ${automationId}, 'automation', 'completed')
      RETURNING id
    `;
    const promote = (tx: DbClient, runId: number) =>
      promoteAutomationEntityOutput({
        tx,
        extractedData: {
          problems: [{ category: 'Stability', name: 'App Crashes' }],
        },
        outputName: 'problems',
        output: OUTPUTS.problems,
        automationId,
        organizationId: workspace.org.id,
        runId,
        parentEntityId,
        createdBy: workspace.users.owner.id,
        validContentIds: new Set<number>(),
      });

    let signalAReady!: () => void;
    const aReady = new Promise<void>((resolve) => {
      signalAReady = resolve;
    });
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A promotes (entity insert + identity claim) and parks with its
    // transaction still OPEN, so neither row is visible to B yet.
    const runA = sql.begin(async (tx) => {
      const result = await promote(tx as unknown as DbClient, resultRuns[0].id);
      signalAReady();
      await aMayCommit;
      return result;
    });
    await aReady;

    // B must NOT be awaited before A is released: B's entity insert blocks on
    // A's uncommitted sibling slug, so awaiting here deadlocks the test against
    // itself instead of exercising the race.
    const runB = sql.begin((tx) => promote(tx as unknown as DbClient, resultRuns[1].id));
    try {
      await waitForBlockedEntityInsert(sql);
    } finally {
      releaseA();
    }
    const [a, b] = await Promise.all([runA, runB]);

    expect(a.created).toBe(1);
    expect(b.created).toBe(0);
    const identity = topicIdentity(automationId, APP_CRASHES_KEY);
    const rows = await sql`
      SELECT e.id, e.slug
      FROM entities e
      WHERE e.organization_id = ${workspace.org.id}
        AND e.parent_id = ${parentEntityId}
        AND e.metadata->>'stable_key' = ${APP_CRASHES_KEY}
    `;
    expect(rows).toHaveLength(1);
    const claims = await sql`
      SELECT entity_id
      FROM entity_identities
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'automation_key'
        AND identifier = ${identity}
        AND deleted_at IS NULL
    `;
    expect(claims).toHaveLength(1);
    expect(Number(claims[0].entity_id)).toBe(Number(rows[0].id));
  });

  it('syncs extracted fields into entities and respects a human-owned field on re-run, queuing an approval', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    // Run 1: a non-key `severity` field is synced into the promoted entity's metadata.
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      window_token: token,
      run_id: runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    const appCrashesId = topicIdentity(ctx.automationId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id, e.metadata, e.field_controls
      FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'automation_key' AND ei.identifier = ${appCrashesId}
    `;
    // Slice 2 (create): the extracted field value lands in metadata, not just provenance.
    expect((created.metadata as Record<string, unknown>).severity).toBe('low');
    expect(created.field_controls).toEqual({});
    const entityId = Number(created.id);

    // A human takes ownership of `severity`, attaching a correction note.
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
      field_note: 'confirmed critical with eng',
    });
    const [edited] =
      await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    // Slice 1: human edit applies the value AND marks the field owned, carrying the note.
    expect((edited.metadata as Record<string, unknown>).severity).toBe('high');
    const sevControl = (edited.field_controls as Record<string, { note?: string; set_by?: string }>)
      .severity;
    expect(sevControl).toBeTruthy();
    expect(sevControl.note).toBe('confirmed critical with eng');
    expect(sevControl.set_by).toBe(workspace.users.owner.id);

    // Run 2 proposes a different severity for the SAME key.
    const revised = await nextCompletion(ctx);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      window_token: revised.token,
      run_id: revised.runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    // Slice 2 (match): the automation does NOT overwrite the human-owned value.
    const [afterRerun] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((afterRerun.metadata as Record<string, unknown>).severity).toBe('high');

    // Slice 3: the blocked change is queued as a durable approval the human can act on.
    const pendingRuns = async () => sql`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    const pending = await pendingRuns();
    expect(pending.length).toBe(1);
    const proposal = pending[0].action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(proposal.entity_id).toBe(entityId);
    expect(proposal.fields.severity).toBe('critical');

    // Idempotency: replaying the SAME window again must NOT stack a second
    // pending approval card (complete_window is replay-safe under retries/replicas).
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      window_token: revised.token,
      run_id: revised.runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    expect((await pendingRuns()).length).toBe(1);

    // Slice 3 (apply): an owner approves via manage_operations → the value lands and
    // the field stays human-owned (now carrying the approved value).
    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending[0].id) },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { approved?: boolean };
    expect(approveRes.approved).toBe(true);

    const [applied] =
      await sql`SELECT metadata, field_controls FROM entities WHERE id = ${entityId}`;
    expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    // Still owned — an approved automation value remains human-owned, not automation-writable.
    expect((applied.field_controls as Record<string, unknown>).severity).toBeTruthy();
    const [approvedRun] =
      await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending[0].id)}`;
    expect(approvedRun.status).toBe('completed');
    expect(approvedRun.approval_status).toBe('approved');
  });

  it('approving a STALE proposal does not clobber a value the human moved after it was queued', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    // Run 1 seeds the entity; human then owns `severity` at 'high'.
    await ctx.api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: token,
      run_id: runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const appCrashesId = topicIdentity(automationId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'automation_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
    });

    // Run 2: automation proposes 'critical' against the 'high' snapshot → pending approval.
    const revised = await nextCompletion(ctx);
    await ctx.api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: revised.token,
      run_id: revised.runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const [pending] = await sql`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${workspace.org.id} AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect((pending.action_input as { current?: Record<string, unknown> }).current?.severity).toBe(
      'high'
    );

    // The human moves severity to 'medium' AFTER the proposal was queued (proposal is now stale).
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'medium' },
    });

    // Approving the stale proposal must NOT overwrite the human's newer 'medium'.
    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending.id) },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { approved?: boolean; message?: string };
    expect(approveRes.approved).toBe(true);

    const [after] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((after.metadata as Record<string, unknown>).severity).toBe('medium'); // human wins
    // Run still resolves (terminal), it just applied nothing.
    const [resolved] =
      await sql`SELECT status, approval_status FROM runs WHERE id = ${Number(pending.id)}`;
    expect(resolved.status).toBe('completed');
    expect(resolved.approval_status).toBe('approved');
  });

  it('list_promoted returns the automation promoted entities with field ownership + provenance', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    const completion = await ctx.api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: token,
      run_id: runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    // A human owns `severity` on one of the two promoted entities.
    const appCrashesId = topicIdentity(automationId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'automation_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);
    await workspace.owner.entities.update({
      entity_id: entityId,
      metadata: { severity: 'high' },
      field_note: 'confirmed critical with eng',
    });

    const res = (await workspace.owner.automations.manage({
      action: 'list_promoted',
      automation_id: String(automationId),
    })) as {
      action: string;
      entities: Array<{
        id: number;
        name: string;
        entity_type: string;
        metadata: Record<string, unknown>;
        field_controls: Record<string, { set_by?: string; note?: string }>;
        run_id: number | null;
        stable_key: string | null;
      }>;
    };

    expect(res.action).toBe('list_promoted');
    expect(res.entities.length).toBe(2);
    const appCrashes = res.entities.find((e) => e.stable_key === APP_CRASHES_KEY);
    const slowLoading = res.entities.find((e) => e.stable_key === SLOW_LOADING_KEY);
    expect(appCrashes).toBeDefined();
    expect(slowLoading).toBeDefined();

    // The owned entity carries its human ownership marker + the corrected value…
    expect(appCrashes?.id).toBe(entityId);
    expect(appCrashes?.entity_type).toBe('topic');
    expect(appCrashes?.metadata.severity).toBe('high');
    expect(appCrashes?.field_controls.severity?.set_by).toBe(workspace.users.owner.id);
    expect(appCrashes?.run_id).toBe((completion as { run_id: number }).run_id);
    // …while the untouched entity has no owned fields.
    expect(slowLoading?.field_controls).toEqual({});

    await sql`
      UPDATE entity_identities
      SET deleted_at = NOW()
      WHERE organization_id = ${workspace.org.id}
        AND namespace = 'automation_key'
        AND identifier = ${topicIdentity(automationId, SLOW_LOADING_KEY)}
    `;
    const afterRetraction = (await workspace.owner.automations.manage({
      action: 'list_promoted',
      automation_id: String(automationId),
    })) as { entities: Array<{ id: number }> };
    expect(afterRetraction.entities.map((entity) => entity.id)).toEqual([entityId]);
  });

  it('approve (affirm_fields) locks a value as-is so a later Automation change is blocked', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    // Run 1 seeds `severity: 'low'` (automation-owned, no field_controls yet).
    await ctx.api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: token,
      run_id: runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'low' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });
    const appCrashesId = topicIdentity(automationId, APP_CRASHES_KEY);
    const [created] = await sql`
      SELECT e.id FROM entities e JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.namespace = 'automation_key' AND ei.identifier = ${appCrashesId}
    `;
    const entityId = Number(created.id);

    // The human APPROVES the current value as-is (no value change) — the recap's
    // "approve" affordance. This must claim ownership (not the pre-fix no-op).
    await workspace.owner.entities.update({
      entity_id: entityId,
      affirm_fields: ['severity'],
      field_note: 'looks right',
    });
    const [afterApprove] = await sql`
      SELECT metadata, field_controls FROM entities WHERE id = ${entityId}
    `;
    expect((afterApprove.metadata as Record<string, unknown>).severity).toBe('low'); // unchanged
    const sevControl = (
      afterApprove.field_controls as Record<string, { set_by?: string; note?: string }>
    ).severity;
    expect(sevControl?.set_by).toBe(workspace.users.owner.id); // now human-owned
    expect(sevControl?.note).toBe('looks right');

    // Run 2 proposes a different severity for the SAME key. Because the human
    // affirmed the field, the automation must be BLOCKED and queue an approval —
    // proving the affirm actually locked the value.
    const revised = await nextCompletion(ctx);
    await ctx.api.automations.completeWindow({
      automation_id: String(automationId),
      window_token: revised.token,
      run_id: revised.runId,
      extracted_data: {
        problems: [
          { category: 'Stability', name: 'App Crashes', severity: 'critical' },
          { category: 'Performance', name: 'Slow Loading', severity: 'low' },
        ],
      },
    });

    const [afterRerun] = await sql`SELECT metadata FROM entities WHERE id = ${entityId}`;
    expect((afterRerun.metadata as Record<string, unknown>).severity).toBe('low'); // affirm held

    const pending = await sql`
      SELECT action_input FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending.length).toBe(1);
    const proposal = pending[0].action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(proposal.entity_id).toBe(entityId);
    expect(proposal.fields.severity).toBe('critical');
  });

  it('disambiguates a slug that collides with a pre-existing sibling — window is NOT poison-pilled', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, parentEntityId, automationId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Pre-create a sibling under the parent whose slug is EXACTLY the one the
    // first keyed row ("Stability · App Crashes") slugifies to. Without
    // collision-tolerant insertion, promotion's INSERT throws 23505 and rolls
    // the whole window completion back — permanently, since the slug is
    // deterministic (every retry re-hits it). This is the poison-pill.
    const collidingSlug = slugify('Stability · App Crashes');
    const [topicType] = (await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'topic'
      LIMIT 1
    `) as Array<{ id: number }>;
    await sql`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, parent_id, created_by,
        created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${topicType.id}, 'Squatter', ${collidingSlug},
        ${parentEntityId}, ${workspace.users.owner.id}, current_timestamp, current_timestamp
      )
    `;

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    // MUST NOT throw — the window completes despite the slug collision.
    const resultRunId = await completeWithToken(ctx, token, runId);

    // Both keyed rows promoted: two automation_key identities exist.
    const identities = await sql`
      SELECT ei.identifier, ei.entity_id, e.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    expect(identities).toHaveLength(2);

    // The "App Crashes" promotion took the FIRST readable suffix, not the
    // squatter's slug and not the identifier fallback.
    const appCrashes = identities.find(
      (r) => String(r.identifier) === topicIdentity(automationId, APP_CRASHES_KEY)
    );
    expect(appCrashes).toBeDefined();
    expect(String(appCrashes?.slug)).toBe(`${collidingSlug}-2`);

    // The promoted entity carries its origin run.
    const promoted = await sql`SELECT metadata FROM entities WHERE id = ${appCrashes?.entity_id}`;
    expect(Number((promoted[0].metadata as Record<string, unknown>).run_id)).toBe(resultRunId);
  });

  it('uses the identifier fallback after every readable slug suffix collides', async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, parentEntityId, automationId } = ctx;

    await createTestEvent({
      entity_id: parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    // Occupy the base slug and all four readable suffixes. Promotion must reach
    // the final identifier-derived fallback without poison-pilling the window.
    const collidingSlug = slugify('Stability · App Crashes');
    const [topicType] = (await sql`
      SELECT id FROM entity_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'topic'
      LIMIT 1
    `) as Array<{ id: number }>;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const occupiedSlug = attempt === 1 ? collidingSlug : `${collidingSlug}-${attempt}`;
      await sql`
        INSERT INTO entities (
          organization_id, entity_type_id, name, slug, parent_id, created_by,
          created_at, updated_at
        ) VALUES (
          ${workspace.org.id}, ${topicType.id}, ${`Squatter ${attempt}`}, ${occupiedSlug},
          ${parentEntityId}, ${workspace.users.owner.id}, current_timestamp, current_timestamp
        )
      `;
    }

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    // MUST NOT throw — the window completes despite the slug collision.
    const resultRunId = await completeWithToken(ctx, token, runId);

    // Both keyed rows promoted: two automation_key identities exist.
    const identities = await sql`
      SELECT ei.identifier, ei.entity_id, e.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    expect(identities).toHaveLength(2);

    // The "App Crashes" promotion exhausted the readable suffixes and used its
    // identity-derived fallback.
    const appCrashes = identities.find(
      (r) => String(r.identifier) === topicIdentity(automationId, APP_CRASHES_KEY)
    );
    expect(appCrashes).toBeDefined();
    expect(String(appCrashes?.slug)).toBe(
      `${collidingSlug}-${slugify(topicIdentity(automationId, APP_CRASHES_KEY))}`
    );

    // The promoted entity carries its origin run.
    const promoted = await sql`SELECT metadata FROM entities WHERE id = ${appCrashes?.entity_id}`;
    expect(Number((promoted[0].metadata as Record<string, unknown>).run_id)).toBe(resultRunId);
  });

  it("groups a run's proposals by window and approves them all in one batch", async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace, automationId } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    // Run 1: create both entities with a `severity` field.
    await completeWithToken(ctx, token, runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', severity: 'low' },
        { category: 'Performance', name: 'Slow Loading', severity: 'low' },
      ],
    });

    // A human takes ownership of `severity` on BOTH promoted entities.
    const ids = await sql`
      SELECT ei.identifier, ei.entity_id FROM entity_identities ei
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'automation_key'
      ORDER BY ei.identifier
    `;
    for (const row of ids) {
      await workspace.owner.entities.update({
        entity_id: Number(row.entity_id),
        metadata: { severity: 'high' },
        field_note: 'human-owned',
      });
    }

    // A later run proposes a new severity for both. Each proposal points to the
    // producing run.
    const revised = await nextCompletion(ctx);
    const proposalRunId = await completeWithToken(ctx, revised.token, revised.runId, {
      problems: [
        { category: 'Stability', name: 'App Crashes', severity: 'critical' },
        { category: 'Performance', name: 'Slow Loading', severity: 'critical' },
      ],
    });

    const pending = await sql`
      SELECT id, parent_run_id FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal' AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
      ORDER BY id ASC
    `;
    expect(pending.length).toBe(2);
    expect(pending.every((r) => Number(r.parent_run_id) === proposalRunId)).toBe(true);

    // A UI-pinned batch fails closed if another proposal appeared after review.
    const pendingIds = pending.map((row) => Number(row.id));
    const staleBatch = (await executeTool(
      'manage_operations',
      {
        action: 'approve_batch',
        run_id: proposalRunId,
        run_ids: [pendingIds[0]],
      },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { error?: string };
    expect(staleBatch.error).toContain('Pending proposals changed');

    // approve_batch approves exactly the reviewed pending set in one call.
    const batchRes = (await executeTool(
      'manage_operations',
      { action: 'approve_batch', run_id: proposalRunId, run_ids: pendingIds },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { action: string; approved_count?: number; failed_count?: number };
    expect(batchRes.action).toBe('approve_batch');
    expect(batchRes.approved_count).toBe(2);
    expect(batchRes.failed_count).toBe(0);

    // Both proposals applied and their runs completed.
    for (const row of ids) {
      const [applied] =
        await sql`SELECT metadata FROM entities WHERE id = ${Number(row.entity_id)}`;
      expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    }
    const stillPending = await sql`
      SELECT id FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'internal' AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(stillPending.length).toBe(0);
  });

  it("reject_batch cancels a run's proposals and records the reason for revision", async () => {
    const ctx = await setupKeyedAutomation();
    const { sql, workspace } = ctx;

    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: workspace.org.id,
      content: 'Users report the app crashing and loading slowly.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);
    await completeWithToken(ctx, token, runId, {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'low' }],
    });
    const [row] = await sql`
      SELECT ei.entity_id FROM entity_identities ei
      WHERE ei.organization_id = ${workspace.org.id} AND ei.namespace = 'automation_key' LIMIT 1
    `;
    await workspace.owner.entities.update({
      entity_id: Number(row.entity_id),
      metadata: { severity: 'high' },
      field_note: 'human-owned',
    });
    const revised = await nextCompletion(ctx);
    const proposalRunId = await completeWithToken(ctx, revised.token, revised.runId, {
      problems: [{ category: 'Stability', name: 'App Crashes', severity: 'critical' }],
    });

    const rejectRes = (await executeTool(
      'manage_operations',
      {
        action: 'reject_batch',
        run_id: proposalRunId,
        reason: 'severity should stay high',
      },
      TEST_ENV,
      ownerAuthCtx(workspace.org.id, workspace.users.owner.id)
    )) as { action: string; rejected_count?: number };
    expect(rejectRes.action).toBe('reject_batch');
    expect(rejectRes.rejected_count).toBe(1);

    // The human-owned value is untouched; the proposal run is cancelled.
    const [after] = await sql`SELECT metadata FROM entities WHERE id = ${Number(row.entity_id)}`;
    expect((after.metadata as Record<string, unknown>).severity).toBe('high');

    // The rejection reason is recorded as a `correction` feedback event — the
    // SAME channel getRecentFeedbackSummary reads to feed the automation's next run
    // (the revision loop). Keyed to the automation, field_path='$batch_reject'.
    const feedback = await sql`
      SELECT metadata FROM current_event_records
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'correction'
        AND (metadata->>'kind') = 'automation_batch_reject'
    `;
    expect(feedback.length).toBe(1);
    expect((feedback[0].metadata as Record<string, unknown>).reason).toBe(
      'severity should stay high'
    );
  });

  /**
   * A write rule is a per-ROW verdict. Every case that mints a card ends the
   * same way — approve, and the change lands — because that round trip is the
   * only thing that proves the card is CLEARABLE. A card can be minted, carry
   * the right fields, and still be dead: the apply path replays the write, so a
   * grant that does not cover what the rule escalates makes the write throw and
   * `applyFailure` resets the run to pending, forever. The last case mints no
   * card at all, for the same reason: a write the rule denies has no approval
   * that could rescue it.
   */
  describe('a rule escalate is contained to its row', () => {
    const escalatingType = async (ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>, source: string) => {
      const compiled = await compileEntityRule(source);
      await ctx.sql`
        UPDATE entity_types SET rules_compiled = ${compiled}
        WHERE organization_id = ${ctx.workspace.org.id} AND slug = 'topic'
      `;
    };

    const metaFor = async (ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>, stableKey: string) => {
      const [row] = await ctx.sql`
        SELECT e.metadata FROM entities e
        JOIN entity_identities ei ON ei.entity_id = e.id
        WHERE ei.namespace = 'automation_key'
          AND ei.identifier = ${topicIdentity(ctx.automationId, stableKey)}
      `;
      return row.metadata as Record<string, unknown>;
    };

    const pendingCard = async (ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>) => {
      const rows = await ctx.sql`
        SELECT id, action_input FROM runs
        WHERE organization_id = ${ctx.workspace.org.id}
          AND run_type = 'internal'
          AND action_key = 'entity_field_change'
          AND approval_status = 'pending'
      `;
      return rows;
    };

    const approve = async (ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>, runId: number) => {
      const res = (await executeTool(
        'manage_operations',
        { action: 'approve', run_id: runId },
        TEST_ENV,
        ownerAuthCtx(ctx.workspace.org.id, ctx.workspace.users.owner.id)
      )) as { approved?: boolean };
      expect(res.approved).toBe(true);
      const [settled] = await ctx.sql`
        SELECT status, approval_status FROM runs WHERE id = ${runId}
      `;
      expect(settled.status).toBe('completed');
      expect(settled.approval_status).toBe('approved');
    };

    it('holds the escalating row only, and the card clears', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing and loading slowly.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', severity: 'low' },
            { category: 'Performance', name: 'Slow Loading', severity: 'low' },
          ],
        },
      });

      // The rule is deployed AFTER the automation is already promoting rows.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && row.next.severity === "critical") {
    row.escalate(["severity"], "a critical topic needs sign-off");
  }
};`
      );

      let windowError: unknown = null;
      try {
        const revised = await nextCompletion(ctx);
        await ctx.api.automations.completeWindow({
          automation_id: String(ctx.automationId),
          window_token: revised.token,
          run_id: revised.runId,
          extracted_data: {
            problems: [
              { category: 'Stability', name: 'App Crashes', severity: 'critical' },
              { category: 'Performance', name: 'Slow Loading', severity: 'medium' },
            ],
          },
        });
      } catch (err) {
        windowError = err;
      }

      // Letting a per-row verdict escape rolls back the WHOLE completion — every
      // promoted row and every declared output — and it recurs on every retry.
      expect(windowError).toBeNull();
      expect((await metaFor(ctx, SLOW_LOADING_KEY)).severity).toBe('medium');
      expect((await metaFor(ctx, APP_CRASHES_KEY)).severity).toBe('low');

      const cards = await pendingCard(ctx);
      expect(cards.length).toBe(1);
      const proposal = cards[0].action_input as {
        escalated_fields?: string[];
        fields: Record<string, unknown>;
      };
      expect(proposal.escalated_fields).toEqual(['severity']);
      expect(proposal.fields.severity).toBe('critical');

      await approve(ctx, Number(cards[0].id));
      expect((await metaFor(ctx, APP_CRASHES_KEY)).severity).toBe('critical');
    });

    it('holds the row whole when the rule gates on COMMITTED state', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'ops', summary: 'first' },
          ],
        },
      });

      // `row.next` is `{...committed, ...patch}`, so this reads the MERGED owner
      // and keeps firing however much a write drops. Anything that tried to
      // satisfy it by shrinking the patch would never terminate — or would fail
      // the row closed with no card at all.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && row.next.owner) {
    row.escalate(["owner", "reviewed_by"], "an owned topic needs sign-off");
  }
};`
      );

      const revised = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: revised.token,
        run_id: revised.runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'security', summary: 'second' },
          ],
        },
      });

      // Nothing applies: the rule judged this write as one unit, so no subset of
      // it may commit on its own.
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({
        owner: 'ops',
        summary: 'first',
      });

      const cards = await pendingCard(ctx);
      expect(cards.length).toBe(1);
      const proposal = cards[0].action_input as {
        escalated_fields?: string[];
        fields: Record<string, unknown>;
      };
      // The grant is the rule's OWN list — including `reviewed_by`, which this
      // row never proposes. The replay demands the grant cover every field the
      // VERDICT names, so trimming it to the proposed subset mints a dead card.
      expect(proposal.escalated_fields).toEqual(['owner', 'reviewed_by']);
      expect(proposal.fields).toMatchObject({ owner: 'security', summary: 'second' });

      await approve(ctx, Number(cards[0].id));
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({
        owner: 'security',
        summary: 'second',
      });
    });

    it('clears when the rule escalates from more than one branch', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            {
              category: 'Stability',
              name: 'App Crashes',
              severity: 'low',
              owner: 'ops',
            },
          ],
        },
      });

      // Two branches both fire. The executor UNIONS repeated `escalate()` calls
      // (#2910), so one verdict carries both field sets and both reasons — and
      // because the card replays the same write the verdict judged, the replay
      // agrees with it.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && row.changed("severity")) {
    row.escalate(["severity"], "a severity change needs sign-off");
  }
  if (row.op === "update" && row.changed("owner")) {
    row.escalate(["owner"], "reassigning an owner needs sign-off");
  }
};`
      );

      const revised = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: revised.token,
        run_id: revised.runId,
        extracted_data: {
          problems: [
            {
              category: 'Stability',
              name: 'App Crashes',
              severity: 'critical',
              owner: 'security',
            },
          ],
        },
      });

      const cards = await pendingCard(ctx);
      expect(cards.length).toBe(1);
      const proposal = cards[0].action_input as {
        escalated_fields?: string[];
        reason?: string;
      };
      expect([...(proposal.escalated_fields ?? [])].sort()).toEqual(['owner', 'severity']);
      // Every field the card holds is explained: a grant naming a field whose
      // reason was dropped tells the approver nothing about why it is held.
      expect(proposal.reason).toContain('reassigning an owner needs sign-off');
      expect(proposal.reason).toContain('a severity change needs sign-off');

      // The decisive assertion: BOTH fields land. Approving replays the whole
      // write, so the severity branch is satisfied by the same grant.
      await approve(ctx, Number(cards[0].id));
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({
        severity: 'critical',
        owner: 'security',
      });
    });

    it('grants what the rule says about the CARD, not about the residual write', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'ops', summary: 'first' },
          ],
        },
      });

      // A human owns `owner`, so the automation's proposal for it is held by
      // FIELD OWNERSHIP before any rule runs — the write the rule sees is a
      // strict subset of the write the card will replay.
      const [row] = await ctx.sql`
        SELECT e.id FROM entities e
        JOIN entity_identities ei ON ei.entity_id = e.id
        WHERE ei.namespace = 'automation_key'
          AND ei.identifier = ${topicIdentity(ctx.automationId, APP_CRASHES_KEY)}
      `;
      await ctx.workspace.owner.entities.update({
        entity_id: Number(row.id),
        metadata: { owner: 'sec-team' },
        field_note: 'assigned by hand',
      });

      // Two branches, and only the FIRST can fire on the residual: the held
      // `owner` never reaches `row.next`, so the residual answers about
      // `summary` while the card's own write answers about `owner`.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && row.next.summary) {
    row.escalate(["summary"], "a summary needs sign-off");
  }
  if (row.op === "update" && row.next.owner === "ops") {
    row.escalate(["owner"], "handing a topic back to ops needs sign-off");
  }
};`
      );

      const revised = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: revised.token,
        run_id: revised.runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'ops', summary: 'second' },
          ],
        },
      });

      const cards = await pendingCard(ctx);
      expect(cards.length).toBe(1);
      const proposal = cards[0].action_input as {
        escalated_fields?: string[];
        fields: Record<string, unknown>;
      };
      expect(proposal.fields).toMatchObject({ owner: 'ops', summary: 'second' });
      // The residual's verdict names only `summary` — the held `owner` never
      // reaches `row.next`, so its branch cannot fire there. The card replays
      // `owner` too, so a grant copied off the residual is short by exactly the
      // field the replay escalates on, and approval could never clear it.
      expect([...(proposal.escalated_fields ?? [])].sort()).toEqual(['owner', 'summary']);

      await approve(ctx, Number(cards[0].id));
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({
        owner: 'ops',
        summary: 'second',
      });
    });

    it('fails the row closed when the rule denies the write the card would replay', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'ops', summary: 'first' },
          ],
        },
      });

      const [row] = await ctx.sql`
        SELECT e.id FROM entities e
        JOIN entity_identities ei ON ei.entity_id = e.id
        WHERE ei.namespace = 'automation_key'
          AND ei.identifier = ${topicIdentity(ctx.automationId, APP_CRASHES_KEY)}
      `;
      await ctx.workspace.owner.entities.update({
        entity_id: Number(row.id),
        metadata: { owner: 'sec-team' },
        field_note: 'assigned by hand',
      });

      // The residual only ever reaches the escalate; the write the card would
      // replay hits the deny. Carding it would mint a proposal that throws the
      // moment anyone approves it.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && row.next.owner === "ops") {
    row.deny("a topic cannot be handed back to ops");
  }
  if (row.op === "update" && row.next.summary) {
    row.escalate(["summary"], "a summary needs sign-off");
  }
};`
      );

      const revised = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: revised.token,
        run_id: revised.runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', owner: 'ops', summary: 'second' },
          ],
        },
      });

      expect(await pendingCard(ctx)).toEqual([]);
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({
        owner: 'sec-team',
        summary: 'first',
      });
    });

    it('records a rule DENY in the run change set, not just a log line', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const seedRunId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, seedRunId);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: seedRunId,
        extracted_data: {
          problems: [{ category: 'Stability', name: 'App Crashes', summary: 'first' }],
        },
      });

      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update") {
    row.deny("this topic is frozen for the quarter");
  }
};`
      );

      // Its OWN run: the change set is idempotent per run, so a denial folded
      // into the create's run would be swallowed by the existing event.
      const denied = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: denied.token,
        run_id: denied.runId,
        extracted_data: {
          problems: [{ category: 'Stability', name: 'App Crashes', summary: 'second' }],
        },
      });

      // A deny is a refusal, not a request for review: nothing written, nothing
      // carded — which is exactly why the run event is the only record left.
      expect(await metaFor(ctx, APP_CRASHES_KEY)).toMatchObject({ summary: 'first' });
      expect(await pendingCard(ctx)).toEqual([]);

      const [changeSet] = await ctx.sql`
        SELECT title, metadata, entity_ids
        FROM current_event_records
        WHERE run_id = ${denied.runId}
          AND organization_id = ${ctx.workspace.org.id}
          AND semantic_type = 'change_set'
      `;
      expect(changeSet).toBeDefined();
      const meta = changeSet.metadata as Record<string, unknown>;
      expect(Number(meta.created_count)).toBe(0);
      expect(Number(meta.updated_count)).toBe(0);
      expect(Number(meta.denied_count)).toBe(1);
      expect(String(changeSet.title)).toContain('1 denied');
      const changes = meta.changes as Array<{
        kind: string;
        denied?: { source: string; reason: string };
      }>;
      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe('denied');
      expect(changes[0].denied).toEqual({
        source: 'rule',
        reason: 'this topic is frozen for the quarter',
      });

      const [audit] = await ctx.sql`
        SELECT to_jsonb(entity_ids) AS entity_ids, metadata, payload_type
        FROM events
        WHERE organization_id = ${ctx.workspace.org.id}
          AND run_id = ${denied.runId}
          AND semantic_type = 'change'
          AND metadata->>'category' = 'entity_write_denial'
      `;
      expect(audit).toBeDefined();
      expect(audit.payload_type).toBe('empty');
      expect(audit.metadata).toMatchObject({
        denial_source: 'rule',
        operation: 'update',
        reason: 'this topic is frozen for the quarter',
        denied_fields: ['summary'],
        automation_id: ctx.automationId,
        run_id: denied.runId,
      });
      expect(audit.entity_ids).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain('second');
    });

    it('cards with NO grant when the rule escalates the residual but allows the whole write', async () => {
      const ctx = await setupKeyedAutomation();
      const { sql, workspace } = ctx;
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: token,
        run_id: runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', severity: 'low', summary: 'first' },
          ],
        },
      });

      // A human owns `severity`, so the merge strips it and the rule sees a
      // residual with no severity at all.
      const [entity] = await sql`
        SELECT e.id FROM entities e
        JOIN entity_identities ei ON ei.entity_id = e.id
        WHERE ei.namespace = 'automation_key'
          AND ei.identifier = ${topicIdentity(ctx.automationId, APP_CRASHES_KEY)}
      `;
      await sql`
        UPDATE entities
        SET field_controls = ${sql.json({ severity: { set_by: workspace.users.owner.id } })}
        WHERE id = ${entity.id}
      `;

      // `changed()` is what separates the residual from the whole write:
      // `row.next` merges committed state, so severity LOOKS present either way,
      // but only the whole write actually changes it. The rule therefore
      // escalates the residual and allows the whole write — `fullProposalVerdict`
      // returns null and the card is held by OWNERSHIP, not by the rule.
      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "update" && !row.changed("severity")) {
    row.escalate(["summary"], "a topic that leaves severity alone needs sign-off");
  }
};`
      );

      const revised = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: revised.token,
        run_id: revised.runId,
        extracted_data: {
          problems: [
            { category: 'Stability', name: 'App Crashes', severity: 'high', summary: 'second' },
          ],
        },
      });

      const cards = await pendingCard(ctx);
      expect(cards.length).toBe(1);
      // No grant and no rule reason: neither describes why THIS card exists —
      // the rule is satisfied by the write the card replays.
      const proposal = cards[0].action_input as { escalated_fields?: string[] };
      expect(proposal.escalated_fields ?? []).toEqual([]);

      // And it still clears, which is the point: a grantless card is only safe
      // because the replayed write is one the rule allows.
      await approve(ctx, Number(cards[0].id));
      expect((await metaFor(ctx, APP_CRASHES_KEY)).severity).toBe('high');
    });

    /**
     * Creates are the other half of the class. `validateEntityRowInsert` throws
     * on an uncovered escalate, and the caller only ever queued a create card
     * for a POLICY defer — so a rule escalate on create reached the outer catch
     * and rolled the whole completion back, on every retry.
     */
    // A create card carries `entity_change`, not the update path's
    // `entity_field_change`, so it needs its own lookup.
    const pendingAnyCard = async (ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>) =>
      await ctx.sql`
        SELECT id, action_key, action_input FROM runs
        WHERE organization_id = ${ctx.workspace.org.id}
          AND run_type = 'internal'
          AND approval_status = 'pending'
      `;

    const findEntity = async (
      ctx: Awaited<ReturnType<typeof setupKeyedAutomation>>,
      stableKey: string
    ) =>
      await ctx.sql`
        SELECT id, slug, metadata FROM entities
        WHERE organization_id = ${ctx.workspace.org.id}
          AND metadata->>'stable_key' = ${stableKey}
      `;

    it('cards a CREATE the rule escalated instead of failing the window', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);

      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "create") {
    row.escalate(["severity"], "a new topic needs sign-off");
  }
};`
      );

      let windowError: unknown = null;
      try {
        await ctx.api.automations.completeWindow({
          automation_id: String(ctx.automationId),
          window_token: await readWindowToken(ctx, runId),
          run_id: runId,
          extracted_data: {
            problems: [{ category: 'Stability', name: 'App Crashes', severity: 'critical' }],
          },
        });
      } catch (err) {
        windowError = err;
      }

      expect(windowError).toBeNull();
      // No row: a create has no held-field bookkeeping, because the aborted
      // savepoint leaves nothing behind and the whole proposal is the card.
      expect(await findEntity(ctx, APP_CRASHES_KEY)).toEqual([]);

      const cards = await pendingAnyCard(ctx);
      expect(cards.length).toBe(1);
      expect(cards[0].action_key).toBe('entity_change');
      // The verdict needs no second ask here: a create strips nothing before
      // the rule runs, so the judged write and the replayed write are the same.
      expect((cards[0].action_input as { escalated_fields?: string[] }).escalated_fields).toEqual([
        'severity',
      ]);

      await approve(ctx, Number(cards[0].id));
      const created = await findEntity(ctx, APP_CRASHES_KEY);
      expect(created.length).toBe(1);
      expect(created[0].metadata as Record<string, unknown>).toMatchObject({
        severity: 'critical',
      });

      // The automation_key identity is claimed on the NEXT promotion, not at
      // approval — so re-promoting must adopt the approved row, not fork it.
      const adopted = await nextCompletion(ctx);
      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        window_token: adopted.token,
        run_id: adopted.runId,
        extracted_data: {
          problems: [{ category: 'Stability', name: 'App Crashes', severity: 'critical' }],
        },
      });
      expect((await findEntity(ctx, APP_CRASHES_KEY)).length).toBe(1);
    });

    it('skips a CREATE the rule denied, and mints no card for it', async () => {
      const ctx = await setupKeyedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report the app crashing.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);

      await escalatingType(
        ctx,
        `export default (row) => {
  if (row.op === "create") {
    row.deny("this type is closed to new rows");
  }
};`
      );

      let windowError: unknown = null;
      try {
        await ctx.api.automations.completeWindow({
          automation_id: String(ctx.automationId),
          window_token: await readWindowToken(ctx, runId),
          run_id: runId,
          extracted_data: {
            problems: [{ category: 'Stability', name: 'App Crashes', severity: 'low' }],
          },
        });
      } catch (err) {
        windowError = err;
      }

      // Fail the ROW closed, not the window — and mint nothing, because
      // approval cannot launder a deny into a write.
      expect(windowError).toBeNull();
      expect(await findEntity(ctx, APP_CRASHES_KEY)).toEqual([]);
      expect(await pendingAnyCard(ctx)).toEqual([]);

      // No entity and no card means the run's change set is the ONLY record
      // that this row was seen and refused. A refused create has no id, so it
      // is recorded under the name the automation proposed.
      const [changeSet] = await ctx.sql`
        SELECT title, metadata, entity_ids
        FROM current_event_records
        WHERE run_id = ${runId}
          AND organization_id = ${ctx.workspace.org.id}
          AND semantic_type = 'change_set'
      `;
      expect(changeSet).toBeDefined();
      const meta = changeSet.metadata as Record<string, unknown>;
      expect(Number(meta.created_count)).toBe(0);
      expect(Number(meta.denied_count)).toBe(1);
      // A row that was never written must not be linked as an entity — and in
      // particular must not link the `0` placeholder a refused create carries.
      // An event with no links stores NULL; a linked one comes back as a raw PG
      // array literal (`{0}` if the placeholder ever leaked through).
      expect(changeSet.entity_ids ?? null).toBeNull();
      const changes = meta.changes as Array<{
        kind: string;
        name: string;
        denied?: { source: string; reason: string };
      }>;
      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe('denied');
      // The readable promoted name, not the stable key — the refusal has to be
      // legible to whoever reads the run.
      expect(changes[0].name).toBe('Stability · App Crashes');
      expect(changes[0].denied).toEqual({
        source: 'rule',
        reason: 'this type is closed to new rows',
      });
    });
  });
});
