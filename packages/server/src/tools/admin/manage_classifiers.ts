/**
 * Tool: manage_classifiers
 *
 * Unified classifier management: template CRUD, entity-classifier assignment, and manual classification.
 *
 * A classifier is a label schema; `classify` is the only writer of labels.
 * An Automation labels events by having its agent read them and call
 * `classify` with source 'llm'.
 *
 * - create: Create a classifier (label schema)
 * - list: List classifiers (optionally filter by entity_id/status)
 * - delete: Archive classifier (soft delete)
 * - classify: Write or unset labels (single or batch)
 */

import { classifyMutationPrincipal } from '../../authz/entity-policy';
import {
  ClassifyContentAction,
  CreateClassifierAction,
  DeleteClassifierAction,
  ListClassifiersAction,
  ManageClassifiersSchema,
  ManageClassifiersResultSchema,
  type ManageClassifiersResult,
} from '@lobu/core/contracts/tools/manage-classifiers';
import type { Static } from '@sinclair/typebox';
import type { DbClient } from '../../db/client';
import { getDb, pgTextArray } from '../../db/client';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

export { ManageClassifiersResultSchema, ManageClassifiersSchema };

/**
 * Read a classifier's stored `attribute_values` map for wire responses.
 *
 * The stored shape is an object-MAP keyed by value string. A malformed row can
 * hold a JSON ARRAY (or any non-record root) — historically these were fed
 * straight into `Object.entries`, which turned `[a, b]` into a map with numeric
 * keys `{"0":a,"1":b}` that then got re-persisted. Guard the root: an array or
 * non-record is returned as `null` so callers surface "needs repair" rather
 * than silently emitting corruption. Valid object-maps round-trip exactly.
 */
function readAttributeValues(
  attributeValues: unknown
): Record<string, { description: string; examples?: string[] }> | null {
  if (!attributeValues) return null;
  let parsed: unknown = attributeValues;
  if (typeof attributeValues === 'string') {
    try {
      parsed = JSON.parse(attributeValues);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, { description: string; examples?: string[] }>;
}

// ============================================
// Main Function (Action Router)
// ============================================

// Variants in the contract's order, so the derived union matches the exposed
// `ManageClassifiersSchema`. Each handler receives its own variant's args.
const manageClassifiersTool = defineActionTool('manage_classifiers', {
  create: action(CreateClassifierAction, handleCreate),
  list: action(ListClassifiersAction, handleList),
  delete: action(DeleteClassifierAction, handleDelete),
  classify: action(ClassifyContentAction, handleClassify),
});

export const manageClassifiers = manageClassifiersTool.run;

// ============================================
// Template CRUD Handlers
// ============================================

async function handleCreate(
  args: Static<typeof CreateClassifierAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  const entityId = args.entity_id ?? null;
  if (entityId !== null) {
    const entity = await sql`
      SELECT id FROM entities
      WHERE id = ${entityId} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    `;
    if (entity.length === 0) {
      return {
        success: false,
        action: 'create',
        message: `Entity not found: ${entityId}`,
      };
    }
  }

  const existing = await sql`
    SELECT id, slug FROM classify_facet
    WHERE slug = ${args.slug} AND organization_id = ${ctx.organizationId}
  `;
  if (existing.length > 0) {
    return {
      success: false,
      action: 'create',
      message: `Classifier with slug '${args.slug}' already exists.`,
      data: { classifier_id: existing[0].id },
    };
  }

  // `created_by` is NOT NULL and carries NO foreign key — `classify_facet` has
  // no FK at all (9 NOT NULLs, a PK, one unique index), so any stable
  // identifier satisfies it. The previous comment here asserted an FK to
  // `user(id)` that does not exist, and concluded from "the route is
  // admin-gated" that `ctx.userId` is non-null. Both halves were wrong:
  // `action-router.ts` returns early for a system context, so an Automation
  // reaction (userId null, memberRole null) skips the admin gate and reached
  // this INSERT with no identity — dying on the NOT NULL as a raw Postgres
  // 23502.
  //
  // The 'system' sentinel follows the manage_entity.ts precedent
  // (`ctx.agentId ?? ctx.userId ?? "system"`), but userId stays first here to
  // preserve the pre-existing user attribution when both are set. An Automation
  // sets neither, so it lands on 'system'.
  const createdBy = args.created_by ?? ctx.userId ?? ctx.agentId ?? 'system';

  const classifierResult = await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, description, attribute_key, status, created_by,
      entity_id, entity_ids, attribute_values
    ) VALUES (
      ${ctx.organizationId},
      ${args.slug}, ${args.name}, ${args.description || null}, ${args.attribute_key},
      'active', ${createdBy}, ${entityId},
      CASE WHEN ${entityId}::bigint IS NULL THEN ARRAY[]::bigint[] ELSE ARRAY[${entityId}]::bigint[] END,
      ${sql.json(args.attribute_values)}
    )
    RETURNING id, slug
  `;
  const classifier = classifierResult[0];

  return {
    success: true,
    action: 'create',
    message: `Classifier '${args.slug}' created successfully`,
    data: { classifier_id: classifier.id, slug: classifier.slug, version: 1 },
  };
}

async function handleList(
  args: Static<typeof ListClassifiersAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();
  const filterEntityId = args.entity_id ?? null;
  // Default to active classifiers only (exclude deprecated), mirroring the
  // automations list default. `status: 'all'` is the explicit escape hatch that
  // returns every classifier regardless of lifecycle state. Without a default,
  // repeated E2E runs left deprecated rows visible in the ordinary list (#2051).
  const statusFilter = args.status ?? 'active';

  // No automation_id filter: `create` produces org-level classifiers, and
  // historical Automation-scoped ones stay listable.
  const conditions: string[] = ['fc.organization_id = $1'];
  const params: unknown[] = [ctx.organizationId];
  let paramIdx = 2;

  if (statusFilter !== 'all') {
    conditions.push(`fc.status = $${paramIdx++}`);
    params.push(statusFilter);
  }

  if (filterEntityId !== null) {
    conditions.push(`$${paramIdx++} = ANY(fc.entity_ids)`);
    params.push(filterEntityId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const classifiers = await sql.unsafe(
    `SELECT
      fc.id, fc.slug, fc.name, fc.description, fc.attribute_key, fc.entity_ids,
      et.slug AS entity_type, fc.status, fc.created_at, fc.updated_at,
      fc.attribute_values,
      fc.automation_id as automation_id,
      w.name as automation_name,
      CASE
        WHEN fc.entity_ids IS NULL OR cardinality(fc.entity_ids) = 0 THEN 'global'
        WHEN e.parent_id IS NULL THEN 'root'
        ELSE 'child'
      END as scope
    FROM classify_facet fc
    LEFT JOIN entities e ON e.id = ANY(fc.entity_ids)
    LEFT JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN automations w ON fc.automation_id = w.id
    ${whereClause}
    ORDER BY
      CASE WHEN fc.entity_ids IS NULL OR cardinality(fc.entity_ids) = 0 THEN 0 WHEN e.parent_id IS NULL THEN 1 ELSE 2 END,
      fc.automation_id NULLS LAST,
      fc.created_at DESC`,
    params
  );

  const result = classifiers.map((row) => ({
    ...row,
    attribute_values: readAttributeValues(row.attribute_values),
  }));

  return {
    success: true,
    action: 'list',
    message: `Found ${result.length} classifiers`,
    data: { classifiers: result },
  };
}

async function handleDelete(
  args: Static<typeof DeleteClassifierAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  const result = await sql`
    UPDATE classify_facet
    SET status = 'deprecated', updated_at = current_timestamp
    WHERE id = ${args.classifier_id} AND organization_id = ${ctx.organizationId}
    RETURNING id
  `;
  if (result.length === 0) {
    return {
      success: false,
      action: 'delete',
      message: `Classifier not found: ${args.classifier_id}`,
    };
  }

  return {
    success: true,
    action: 'delete',
    message: 'Classifier archived (status set to deprecated)',
    data: { classifier_id: args.classifier_id },
  };
}

// ============================================
// Manual Classification Handler
// ============================================

async function handleClassify(
  args: Static<typeof ClassifyContentAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  try {
    const isSingleMode = args.content_id !== undefined;
    const isBatchMode = args.classifications !== undefined;

    if (isSingleMode === isBatchMode) {
      return {
        success: false,
        action: 'classify',
        message:
          'Must provide either content_id (single mode) or classifications array (batch mode), not both',
      };
    }

    const classifierResult = (await sql`
      SELECT cf.id as classifier_id, cf.attribute_key
      FROM classify_facet cf
      WHERE cf.slug = ${args.classifier_slug}
        AND cf.status = 'active'
        AND cf.organization_id = ${ctx.organizationId}
    `) as unknown as Array<{ classifier_id: number; attribute_key: string }>;

    if (classifierResult.length === 0) {
      return {
        success: false,
        action: 'classify',
        message: `Classifier not found or inactive: ${args.classifier_slug}`,
      };
    }

    const classifier = classifierResult[0];
    // `user` marks a human label that outranks model labels and serves as
    // ground truth, so it follows the acting principal, never the caller's word.
    const humanCaller =
      classifyMutationPrincipal({
        userId: ctx.userId,
        agentId: ctx.agentId,
        automationSource: ctx.actingAutomationId,
      }) === 'user';
    if (!humanCaller && args.source === 'user') {
      return {
        success: false,
        action: 'classify',
        message: "Only a person can write source 'user' labels; Automations and agents write 'llm'.",
      };
    }
    const source = args.source ?? (humanCaller ? 'user' : 'llm');

    if (isSingleMode) {
      if (args.content_id === undefined)
        return { success: false, action: 'classify', message: 'content_id is required' };
      if (args.value === undefined)
        return { success: false, action: 'classify', message: 'value is required' };

      const result = await writeLabel(sql, ctx, args.content_id, classifier.classifier_id, {
        value: args.value,
        confidence: args.confidence,
        source,
        reasoning: args.reasoning,
      });
      return {
        success: result.success,
        action: 'classify',
        message: result.message,
        data: {
          updated: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
          details: [
            { content_id: args.content_id, success: result.success, error: result.message },
          ],
        },
      };
    }

    if (isBatchMode && args.classifications) {
      const results = await Promise.allSettled(
        args.classifications.map((item) =>
          writeLabel(sql, ctx, item.content_id, classifier.classifier_id, {
            value: item.value,
            confidence: item.confidence,
            source,
            reasoning: item.reasoning || args.reasoning,
          })
        )
      );

      const details = results.map((result, index) => {
        const item = args.classifications![index];
        if (result.status === 'fulfilled') {
          const value = result.value as { success: boolean; message?: string };
          return {
            content_id: item.content_id,
            success: value.success,
            error: value.success ? undefined : value.message,
          };
        }
        return {
          content_id: item.content_id,
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      });

      const updated = details.filter((d) => d.success).length;
      const failed = details.filter((d) => !d.success).length;

      logger.info(
        {
          classifier_slug: args.classifier_slug,
          source,
          total: args.classifications.length,
          updated,
          failed,
        },
        'Batch classification update completed'
      );

      return {
        success: true,
        action: 'classify',
        message: `Updated ${updated} classification(s), ${failed} failed`,
        data: { updated, failed, details },
      };
    }

    return { success: false, action: 'classify', message: 'Invalid input mode' };
  } catch (error) {
    logger.error({ error, args }, 'Failed to update content classification');
    return {
      success: false,
      action: 'classify',
      message: error instanceof Error ? error.message : 'Failed to update classification',
    };
  }
}

/**
 * Write (or, with `value: null`, remove) one label.
 *
 * A label is keyed by (event, classifier, source, Automation) — the same key as
 * `idx_cc_unique_per_source_v2`. The Automation comes from the trusted reaction
 * identity on the context, never from caller input, so an Automation replaces
 * and unsets only its own labels. Only a `user` label is manual.
 */
async function writeLabel(
  sql: DbClient,
  ctx: ToolContext,
  contentId: number,
  classifierId: number,
  label: {
    value: string | null;
    confidence?: number | null;
    source: 'llm' | 'user';
    reasoning?: string;
  }
): Promise<{ success: boolean; message?: string }> {
  const contentCheck = await sql`
    SELECT id FROM events
    WHERE id = ${contentId} AND organization_id = ${ctx.organizationId}
  `;
  if (contentCheck.length === 0) {
    return { success: false, message: `Content not found: ${contentId}` };
  }

  const automationId = ctx.actingAutomationId ?? null;
  const runId = ctx.actingRunId ?? null;
  const { value, source } = label;
  const confidence = label.confidence ?? (source === 'user' ? 1 : null);

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM event_classifications
      WHERE event_id = ${contentId} AND classifier_id = ${classifierId} AND source = ${source}
        AND COALESCE(automation_id, 0) = ${automationId ?? 0}
    `;
    if (value === null) return;
    await tx`
      INSERT INTO event_classifications (event_id, classifier_id, automation_id, run_id, "values", confidences, source, is_manual, reasoning)
      VALUES (${contentId}, ${classifierId}, ${automationId}, ${runId}, ${pgTextArray([value])}::text[],
              ${sql.json(confidence === null ? {} : { [value]: confidence })}, ${source}, ${source === 'user'}, ${label.reasoning || null})
    `;
  });

  return { success: true };
}
