/**
 * Integration test: an automation derives its extraction schema from its target
 * entity type's metadata_schema (consolidation — "schema lives on the entity
 * type"). When an Automation declares an entity output, complete_window
 * validates the extracted data against the entity type's schema — the SAME
 * schema that validates manual entity writes, so
 * a record's shape is defined exactly once.
 *
 * Proves:
 *   1. deriveAutomationExtractionSchema resolves a real entity type's schema.
 *   2. complete_window REJECTS extracted data that violates the entity type's
 *      schema and ACCEPTS data that conforms — with no inline Automation schema.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import type { DbClient } from '../../../db/client';
import { createAutomationRun } from '../../../runs/queue-service';
import {
  deriveAutomationExtractionSchema,
} from '../../../utils/automation-extraction-schema';
import { computePendingWindow } from '../../../utils/window-utils';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

const TOPIC_METADATA_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    name: { type: 'string' },
  },
  // `category` is intentionally optional on the entity type. Declaring it as
  // an output key must still require it in every Automation-produced row.
  required: ['name'],
  additionalProperties: true,
};

const OUTPUTS = {
  problems: { entity: 'topic', key: ['category', 'name'] },
};

async function setupEntityTypedAutomation() {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({
    name: 'Schema-From-Entity Org',
  });
  const ownerUserId = workspace.users.owner.id;

  const parentEntity = await createTestEntity({
    name: 'Parent Brand',
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });

  // The 'topic' type carries the metadata_schema that becomes the automation's
  // extraction contract. entity_types' unique index is partial (WHERE deleted_at
  // IS NULL), so ON CONFLICT can't bind — check then insert/update.
  const existingType = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${workspace.org.id} AND slug = 'topic' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existingType.length > 0) {
    await sql`
      UPDATE entity_types SET metadata_schema = ${sql.json(TOPIC_METADATA_SCHEMA)}
      WHERE id = ${existingType[0].id}
    `;
  } else {
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, metadata_schema, created_at, updated_at)
      VALUES (${workspace.org.id}, 'topic', 'Topic', ${sql.json(TOPIC_METADATA_SCHEMA)}, current_timestamp, current_timestamp)
    `;
  }

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'schema-agent',
    name: 'Schema Agent',
  });

  // NB: no inline Automation schema — the Automation relies on the entity type's schema.
  const automation = (await workspace.owner.automations.create({
    entity_id: parentEntity.id,
    slug: 'schema-automation',
    name: 'Scheman Automation',
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

type Ctx = Awaited<ReturnType<typeof setupEntityTypedAutomation>>;

async function queueRunningRun(ctx: Ctx) {
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
 * A window token for a queued run.
 *
 * Bound with `run_id`: on the arrival axis an unbound read recomputes
 * `[mark, horizon)` against a clock that has moved since the run was queued, so
 * its bounds would no longer match the run's snapshot and `complete_window`
 * would reject them. Real callers bind the same way.
 */
async function readWindowToken(ctx: Ctx, runId: number): Promise<string> {
  const content = (await ctx.api.knowledge.read({
    automation_id: ctx.automationId,
    run_id: runId,
  })) as { window_token: string };
  return content.window_token;
}

describe('complete_window derives its schema from the entity type', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it.each(['member', 'bound entity'])(
    'exposes and enforces the %s event kind metadata contract',
    async (location) => {
      const ctx = await setupEntityTypedAutomation();
      await ensureMemberEntityType(ctx.workspace.org.id);
      const kinds = {
        extraction_notice: {
          metadataSchema: {
            type: 'object',
            properties: { status: { $ref: '#/$defs/status' } },
            $defs: { status: { enum: ['reported', 'retracted'] } },
            required: ['status'],
          },
        },
      };
      if (location === 'member') {
        await ctx.sql`
          UPDATE entity_types SET event_kinds = event_kinds || ${ctx.sql.json(kinds)}
          WHERE organization_id = ${ctx.workspace.org.id} AND slug = '$member'
        `;
      } else {
        await ctx.sql`
          UPDATE entity_types SET event_kinds = ${ctx.sql.json(kinds)}
          WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${ctx.parentEntityId})
        `;
      }
      const created = (await ctx.api.automations.create({
        entity_id: ctx.parentEntityId,
        slug: 'event-schema-automation',
        prompt: 'Extract notices.',
        triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
        managed_agent_id: ctx.agent.agentId,
        outputs: { signals: { event: 'extraction_notice' } },
      })) as { automation_id: string };
      ctx.automationId = Number(created.automation_id);
      await ctx.sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${ctx.automationId}`;
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'A notice to extract.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const window = (await ctx.api.knowledge.read({
        automation_id: ctx.automationId,
        run_id: runId,
      })) as { window_token: string; extraction_schema: Record<string, unknown> };
      const ajv = new Ajv({ strict: false, formats: { 'date-time': true } });
      const validate = ajv.compile(window.extraction_schema);
      const output = (metadata?: Record<string, unknown>) => ({
        signals: [{ content: 'Extracted notice.', ...(metadata ? { metadata } : {}) }],
      });
      expect(validate(output({ status: 'candidate' }))).toBe(false);
      expect(validate(output({ unrelated: true }))).toBe(false);
      expect(validate(output({ status: 'reported' }))).toBe(true);
      // The save path deliberately permits absent and empty metadata.
      expect(validate(output())).toBe(true);
      expect(validate(output({}))).toBe(true);

      await expect(ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        run_id: runId,
        window_token: window.window_token,
        extracted_data: output({ status: 'candidate' }),
      })).rejects.toThrow(/status/);
      const [unfinished] = await ctx.sql`SELECT action_output FROM runs WHERE id = ${runId}`;
      expect(unfinished.action_output).toBeNull();

      const alternative = await createTestEntity({
        name: 'Alternative event subject',
        entity_type: 'alternative-extraction-type',
        organization_id: ctx.workspace.org.id,
        created_by: ctx.workspace.users.owner.id,
      });
      await ctx.sql`
        UPDATE entity_types SET event_kinds = ${ctx.sql.json({
          extraction_notice: {
            metadataSchema: {
              type: 'object',
              properties: { status: { enum: ['reviewed'] } },
              required: ['status'],
            },
          },
        })}
        WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${alternative.id})
      `;
      const explicitOutput = {
        content: 'Notice linked to an alternative subject.',
        entity_ids: [alternative.id],
        metadata: { status: 'reviewed' },
      };
      // Row linkage selects its own schema at persistence, not the bound one.
      expect(validate({ signals: [explicitOutput] })).toBe(true);

      await ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        run_id: runId,
        window_token: window.window_token,
        extracted_data: { signals: [...output({ status: 'reported' }).signals, explicitOutput] },
      });
      const saved = await ctx.sql`
        SELECT metadata->>'status' AS status FROM events
        WHERE organization_id = ${ctx.workspace.org.id} AND semantic_type = 'extraction_notice'
        ORDER BY status
      `;
      expect(saved).toEqual([{ status: 'reported' }, { status: 'reviewed' }]);

      const tightened = {
        extraction_notice: {
          metadataSchema: {
            type: 'object',
            properties: { status: { enum: ['retracted'] } },
          },
        },
      };
      await ctx.sql`
        UPDATE entity_types SET event_kinds = event_kinds || ${ctx.sql.json(tightened)}
        WHERE organization_id = ${ctx.workspace.org.id}
          AND id = ${location === 'member'
            ? (await ctx.sql`SELECT id FROM entity_types WHERE organization_id = ${ctx.workspace.org.id} AND slug = '$member'`)[0].id
            : (await ctx.sql`SELECT entity_type_id AS id FROM entities WHERE id = ${ctx.parentEntityId}`)[0].id}
      `;
      const nextRunId = await queueRunningRun(ctx);
      const nextWindow = (await ctx.api.knowledge.read({
        automation_id: ctx.automationId,
        run_id: nextRunId,
      })) as { extraction_schema: Record<string, unknown> };
      const validateNext = ajv.compile(nextWindow.extraction_schema);
      expect(validateNext(output({ status: 'reported' }))).toBe(false);
      expect(validateNext(output({ status: 'retracted' }))).toBe(true);
    }
  );

  it.each([
    { name: 'plain row', extras: {}, count: 42 },
    { name: 'worker envelope fields', extras: { embedding: [0.1] }, count: 42 },
    { name: 'coerced integer metadata', extras: {}, count: '42' },
  ])('completes a member metadata alternative with $name', async ({ extras, count }) => {
    const ctx = await setupEntityTypedAutomation();
    await ensureMemberEntityType(ctx.workspace.org.id);
    const metadataSchema = {
      type: 'object',
      properties: { member_status: { enum: ['reported'] }, count: { type: 'integer' } },
      required: ['member_status'],
      additionalProperties: false,
    };
    await ctx.sql`
      UPDATE entity_types SET event_kinds = event_kinds || ${ctx.sql.json({
        extraction_notice: { metadataSchema },
      })}
      WHERE organization_id = ${ctx.workspace.org.id} AND slug = '$member'
    `;
    await ctx.sql`
      UPDATE entity_types SET event_kinds = ${ctx.sql.json({
        extraction_notice: { metadataSchema: {
          ...metadataSchema,
          properties: { entity_status: { enum: ['reviewed'] } },
          required: ['entity_status'],
        } },
      })}
      WHERE id = (SELECT entity_type_id FROM entities WHERE id = ${ctx.parentEntityId})
    `;
    const created = (await ctx.api.automations.create({
      entity_id: ctx.parentEntityId,
      slug: 'alternative-event-schema',
      prompt: 'Extract notices.',
      triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
      managed_agent_id: ctx.agent.agentId,
      outputs: { signals: { event: 'extraction_notice' }, notices: { event: 'extraction_notice' } },
    })) as { automation_id: string };
    ctx.automationId = Number(created.automation_id);
    await ctx.sql`UPDATE automations SET next_run_at = NOW() - INTERVAL '10 minutes' WHERE id = ${ctx.automationId}`;
    const runId = await queueRunningRun(ctx);
    const windowToken = await readWindowToken(ctx, runId);
    await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: windowToken,
      extracted_data: {
        signals: [{ content: 'A member notice.', ...extras, metadata: { member_status: 'reported', count } }],
        notices: [],
      },
    });
    const saved = await ctx.sql`
      SELECT metadata->>'member_status' AS status, metadata->'count' AS count FROM events
      WHERE organization_id = ${ctx.workspace.org.id} AND semantic_type = 'extraction_notice'
    `;
    expect(saved).toEqual([{ status: 'reported', count: 42 }]);
  });

  it('resolves a real entity type metadata_schema into an extraction schema', async () => {
    const ctx = await setupEntityTypedAutomation();
    const derived = (await deriveAutomationExtractionSchema(
      ctx.dbClient,
      ctx.workspace.org.id,
      OUTPUTS
    )) as Record<string, any>;
    expect(derived).not.toBeNull();
    expect(derived.properties.problems.items.allOf).toHaveLength(2);
    expect(derived.properties.problems.items.allOf[0].required).toEqual(['name']);
    expect(derived.properties.problems.items.allOf[1].required).toEqual([
      'category',
      'name',
    ]);
  });

  it('still requires the named array when an entity type has no field schema', async () => {
    const ctx = await setupEntityTypedAutomation();
    await ctx.api.entity_schema.createType({ slug: 'unstructured', name: 'Unstructured' });
    const derived = (await deriveAutomationExtractionSchema(
      ctx.dbClient,
      ctx.workspace.org.id,
      { records: { entity: 'unstructured', key: ['id'] } }
    )) as Record<string, any>;
    expect(derived.required).toContain('records');
    expect(derived.properties.records).toEqual({
      type: 'array',
      maxItems: 500,
      items: {
        allOf: [
          { type: 'object' },
          {
            type: 'object',
            properties: {
              id: {
                anyOf: [
                  { type: 'string', minLength: 1, maxLength: 256 },
                  { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
                  { type: 'boolean' },
                ],
              },
            },
            required: ['id'],
          },
        ],
      },
    });
  });

  it('intersects a reaction refinement with the durable output schema', async () => {
    const ctx = await setupEntityTypedAutomation();
    await ctx.sql`
      UPDATE automations
      SET reaction_input_schema = ${ctx.sql.json({
        type: 'object',
        properties: {
          signals: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', minLength: 1 },
                metadata: {
                  type: 'object',
                  properties: { priority: { enum: ['low', 'high'] } },
                  required: ['priority'],
                },
              },
              required: ['content', 'metadata'],
            },
          },
        },
        required: ['signals'],
      })}
      WHERE id = ${ctx.automationId}
    `;

    const derived = (await deriveAutomationExtractionSchema(
      ctx.dbClient,
      ctx.workspace.org.id,
      { signals: { event: 'observation' } },
      ctx.automationId
    )) as Record<string, any>;
    expect(derived.properties.signals.allOf).toHaveLength(2);
    expect(derived.properties.signals.allOf[0].items.properties.metadata).toBeDefined();
    expect(derived.properties.signals.allOf[1].items.required).toEqual(['content']);
  });

  it('REJECTS extracted data missing a field the entity type requires', async () => {
    const ctx = await setupEntityTypedAutomation();
    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: ctx.workspace.org.id,
      content: 'Users report problems.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    // 'name' is required by topic's metadata_schema but missing here.
    await expect(
      ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        run_id: runId,
        window_token: token,
        extracted_data: { problems: [{ category: 'Stability' }] },
      })
    ).rejects.toThrow(/does not match|name/i);
  });

  it('REJECTS extracted data missing an output key even when the entity type makes it optional', async () => {
    const ctx = await setupEntityTypedAutomation();
    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: ctx.workspace.org.id,
      content: 'Users report problems.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    await expect(
      ctx.api.automations.completeWindow({
        automation_id: String(ctx.automationId),
        run_id: runId,
        window_token: token,
        extracted_data: { problems: [{ name: 'App Crashes' }] },
      })
    ).rejects.toThrow(/does not match|category/i);
  });

  it.each([
    ['a blank string', '   ', /non-blank/i],
    ['more than 256 UTF-8 bytes', 'é'.repeat(129), /256 bytes/i],
  ])(
    'REJECTS %s stable-key component as a 422 before writing the window',
    async (_label, category, expectedMessage) => {
      const ctx = await setupEntityTypedAutomation();
      await createTestEvent({
        entity_id: ctx.parentEntityId,
        organization_id: ctx.workspace.org.id,
        content: 'Users report problems.',
        occurred_at: new Date(Date.now() - 60 * 60 * 1000),
      });
      const runId = await queueRunningRun(ctx);
      const token = await readWindowToken(ctx, runId);

      const error = await ctx.api.automations
        .completeWindow({
          automation_id: String(ctx.automationId),
          run_id: runId,
          window_token: token,
          extracted_data: { problems: [{ category, name: 'App Crashes' }] },
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: 'ToolUserError', httpStatus: 422 });
      expect((error as Error).message).toMatch(expectedMessage);
      const durableRows = await ctx.sql<{ count: string }>`
        SELECT count(*)::text AS count FROM runs
        WHERE id = ${runId} AND action_output IS NOT NULL
      `;
      expect(durableRows[0].count).toBe('0');
    }
  );

  it('ACCEPTS extracted data that conforms to the entity type schema (no inline schema)', async () => {
    const ctx = await setupEntityTypedAutomation();
    await createTestEvent({
      entity_id: ctx.parentEntityId,
      organization_id: ctx.workspace.org.id,
      content: 'Users report problems.',
      occurred_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const runId = await queueRunningRun(ctx);
    const token = await readWindowToken(ctx, runId);

    const completion = (await ctx.api.automations.completeWindow({
      automation_id: String(ctx.automationId),
      run_id: runId,
      window_token: token,
      extracted_data: {
        problems: [{ category: 'Stability', name: 'App Crashes' }],
      },
    })) as { action: string };
    expect(completion.action).toBe('complete_window');

    // And the conforming record promoted into a topic entity under the parent.
    const promoted = await ctx.sql`
      SELECT e.name FROM entities e
      JOIN entity_identities ei ON ei.entity_id = e.id
      WHERE ei.organization_id = ${ctx.workspace.org.id} AND ei.namespace = 'automation_key'
    `;
    expect(promoted.length).toBe(1);
  });
});
