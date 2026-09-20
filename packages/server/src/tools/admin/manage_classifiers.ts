/**
 * Tool: manage_classifiers
 *
 * Unified classifier management: template CRUD, entity-classifier assignment, and manual classification.
 *
 * Template actions:
 * - create: Create new classifier (v1)
 * - list: List all classifiers (optionally filter by entity_id/status)
 * - generate_embeddings: Generate embeddings for attribute values
 * - delete: Archive classifier (soft delete)
 *
 * Manual classification:
 * - classify: Update content classification manually (single or batch)
 *
 * Bulk classification:
 * - apply: Run a classifier's embedding match over given content ids
 */

import {
  ApplyClassifierAction,
  ClassifyContentAction,
  CreateClassifierAction,
  DeleteClassifierAction,
  GenerateClassifierEmbeddingsAction,
  ListClassifiersAction,
  ManageClassifiersSchema,
  ManageClassifiersResultSchema,
  type ManageClassifiersResult,
} from '@lobu/core/contracts/tools/manage-classifiers';
import type { Static } from '@sinclair/typebox';
import type { DbClient } from '../../db/client';
import { getDb, pgBigintArray } from '../../db/client';
import type { Env } from '../../index';
import { executeClassificationQuery } from '../../utils/classification-query';
import {
  generateEmbeddings as generateEmbeddingsViaService,
  resolveEmbeddingModel,
  isValidEmbedding,
} from '../../utils/embeddings';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

export { ManageClassifiersResultSchema, ManageClassifiersSchema };

// ============================================
// Typeers
// ============================================

/**
 * Generate any missing or stale label vectors and stamp each with the model
 * that produced it.
 *
 * A label vector lives inside `attribute_values[value].embedding` and is cosine-
 * compared against `event_embeddings.embedding`. Event vectors are model-scoped
 * on every path that touches them (search, the classification engine, the
 * backfill's staleness predicate) precisely because vectors from different
 * models are NOT comparable even at equal dimensionality. Label vectors had no
 * stamp at all, so they were the one side of that comparison that a model swap
 * left behind: cosine over two incompatible 768-dim spaces returns a plausible
 * number rather than an error, so classification would keep "working" and
 * quietly assign wrong labels.
 *
 * A stale stamp is therefore treated exactly like a missing embedding —
 * regenerate it — which also means the existing `EMBEDDINGS_MODEL` swap
 * procedure repairs classifiers by itself instead of needing a manual
 * `force_regenerate` sweep nobody would remember to run.
 */
async function hydrateAttributeEmbeddings(
  attributeValues: Record<
    string,
    {
      description: string;
      examples: string[];
      embedding?: number[] | null;
      embedding_model?: string | null;
    }
  >,
  env: Env,
  options: { forceRegenerate?: boolean; embeddingModel?: string } = {}
): Promise<{
  attributeValues: Record<
    string,
    {
      description: string;
      examples: string[];
      embedding?: number[];
      embedding_model?: string;
    }
  >;
  generatedCount: number;
}> {
  // The model these label vectors will live in. Defaults to the deployment's
  // configured model; an override embeds the labels into whichever space the
  // caller intends to classify in, which is the only way label and event
  // vectors can be made to agree under a non-default model.
  const targetModel = resolveEmbeddingModel(options.embeddingModel);
  const updated: Record<
    string,
    {
      description: string;
      examples: string[];
      embedding?: number[];
      embedding_model?: string;
    }
  > = {};
  const valuesToEmbed: string[] = [];

  for (const [value, config] of Object.entries(attributeValues)) {
    const hasEmbedding = isValidEmbedding(config.embedding ?? null);
    // A DIFFERENT stamp means stale — regenerate. A MISSING stamp does not:
    // this function also runs on `create`, where the vector was just handed to
    // us by a caller running this same deployment, and where discarding it
    // would both throw away supplied input and force a live embeddings-service
    // round-trip on a path that never needed one. So an unstamped vector is
    // adopted at the configured model — the identical assumption
    // `ensureEmbedding` already makes for worker-supplied vectors, since the
    // configured model is the only provenance available either way.
    //
    // That is safe rather than optimistic because genuinely legacy rows do not
    // survive to be read here: the backfill migration stamps all 208 of them at
    // deploy, deriving the value from event_embeddings.
    const isForeignModel =
      config.embedding_model != null && config.embedding_model !== targetModel;
    const reusable = hasEmbedding && !isForeignModel;
    if (!reusable || options.forceRegenerate) {
      valuesToEmbed.push(value);
    }
    updated[value] = {
      description: config.description,
      examples: config.examples,
      // Vector and stamp move together — never carry a vector past its stamp,
      // and never leave a stamp describing a vector that is no longer there.
      embedding: reusable ? (config.embedding as number[]) : undefined,
      embedding_model: reusable ? targetModel : undefined,
    };
  }

  if (valuesToEmbed.length > 0) {
    // A stored entry is NOT guaranteed to carry `description`/`examples`.
    // Migration 20260720120000 rebuilds the map with `elem - 'value' -
    // 'embedding'`, so an element that held only `{value}` becomes a bare `{}`,
    // and `stripEmbeddingsFromAttributeValues` round-trips scalar entries as
    // plain strings. Both reach here typed as `{description, examples}` only
    // because that cast is unchecked — the declared type is a claim about these
    // rows, not a guarantee. The label key is the one field always present;
    // absent text contributes nothing rather than throwing and taking the whole
    // regeneration down.
    const texts = valuesToEmbed.map((value) => {
      const entry = updated[value] as { description?: unknown; examples?: unknown };
      const parts: string[] = [value];
      if (typeof entry.description === 'string') {
        parts.push(entry.description);
      }
      if (Array.isArray(entry.examples)) {
        parts.push(
          ...entry.examples.filter((example): example is string => typeof example === 'string')
        );
      }
      return parts.join('\n');
    });
    const embeddings = await generateEmbeddingsViaService(texts, env, targetModel);
    valuesToEmbed.forEach((value, index) => {
      updated[value] = {
        ...updated[value],
        embedding: embeddings[index],
        embedding_model: targetModel,
      };
    });
  }

  return { attributeValues: updated, generatedCount: valuesToEmbed.length };
}

/**
 * Drop `embedding` from a classifier's `attribute_values` map for wire
 * responses while preserving every other field (`description`, `examples`, …).
 *
 * The stored shape is an object-MAP keyed by value string. A malformed row can
 * hold a JSON ARRAY (or any non-record root) — historically these were fed
 * straight into `Object.entries`, which turned `[a, b]` into a map with numeric
 * keys `{"0":a,"1":b}` and, once the array elements only carried `embedding`,
 * into the corrupted `{"0":{},"1":{}}` that then got re-persisted. Guard the
 * root: an array or non-record never becomes a numeric-keyed map here — it is
 * rejected (returned as `null`) so callers surface "needs repair" rather than
 * silently emitting and re-saving corruption. Valid object-maps round-trip
 * exactly (plain-string entries and rich `{description, examples}` entries
 * alike), minus `embedding`.
 */
function stripEmbeddingsFromAttributeValues(
  attributeValues: unknown
): Record<string, { description: string; examples: string[] }> | null {
  if (!attributeValues) return null;
  let parsed: unknown = attributeValues;
  if (typeof attributeValues === 'string') {
    try {
      parsed = JSON.parse(attributeValues);
    } catch {
      return null;
    }
  }
  // Reject non-record roots. A jsonb array would otherwise be coerced by
  // Object.entries into `{"0":…}` numeric keys — the corruption this guards.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const stripped: Record<string, { description: string; examples: string[] }> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { embedding, ...rest } = value as Record<string, unknown>;
      void embedding;
      stripped[key] = rest as { description: string; examples: string[] };
    } else {
      // Plain-string (or other scalar) entries round-trip untouched.
      stripped[key] = value as unknown as { description: string; examples: string[] };
    }
  }
  return stripped;
}

// ============================================
// Main Function (Action Router)
// ============================================

// Variants in the contract's order, so the derived union matches the exposed
// `ManageClassifiersSchema`. Each handler receives its own variant's args.
const manageClassifiersTool = defineActionTool('manage_classifiers', {
  create: action(CreateClassifierAction, (args, ctx, env) => handleCreate(args, env, ctx)),
  list: action(ListClassifiersAction, handleList),
  generate_embeddings: action(GenerateClassifierEmbeddingsAction, (args, ctx, env) =>
    handleGenerateEmbeddings(args, env, ctx)
  ),
  delete: action(DeleteClassifierAction, handleDelete),
  classify: action(ClassifyContentAction, handleClassify),
  apply: action(ApplyClassifierAction, handleApply),
});

export const manageClassifiers = manageClassifiersTool.run;

// ============================================
// Template CRUD Handlers
// ============================================

async function handleCreate(
  args: Static<typeof CreateClassifierAction>,
  env: Env,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  const entityId = args.entity_id ?? null;
  // Optional on purpose. `automation_id` becomes `classify_facet.automation_id`, and
  // every embedding-engine lookup filters `cf.automation_id IS NULL` — so while
  // this was required, EVERY classifier creatable through this tool or the
  // ClientSDK was invisible to the engine, and `apply`/the reconciliation cron
  // reported clean zero-result runs over it. Omit it for an org-level
  // classifier the engine can match; pass it for an Automation-scoped one.
  const automationId = args.automation_id ?? null;

  if (automationId !== null) {
    const automation = await sql`
      SELECT id FROM automations
      WHERE id = ${automationId} AND organization_id = ${ctx.organizationId}
    `;
    if (automation.length === 0) {
      return {
        success: false,
        action: 'create',
        message: `Automation not found: ${automationId}`,
      };
    }
  }

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
  // 23502. Measured on an Automation context: `list` and `apply` both succeeded,
  // so `create` was the verb blocking ad-hoc agent-defined classification.
  // (`classify` and `delete` were not exercised; neither writes `created_by`.)
  //
  // The 'system' sentinel follows the manage_entity.ts precedent
  // (`ctx.agentId ?? ctx.userId ?? "system"`), but userId stays first here to
  // preserve the pre-existing user attribution when both are set. An Automation
  // sets neither, so it lands on 'system'.
  const createdBy = args.created_by ?? ctx.userId ?? ctx.agentId ?? 'system';
  // Config lives on the single classify_facet row now (no version table) — hydrate embeddings first,
  // then one insert carrying identity + config.
  const { attributeValues: withEmbeddings, generatedCount } = await hydrateAttributeEmbeddings(
    args.attribute_values,
    env,
    { embeddingModel: args.embedding_model }
  );

  const classifierResult = await sql`
    INSERT INTO classify_facet (
      organization_id, slug, name, description, attribute_key, status, created_by,
      entity_id, entity_ids, automation_id, attribute_values, min_similarity, fallback_value
    ) VALUES (
      ${ctx.organizationId},
      ${args.slug}, ${args.name}, ${args.description || null}, ${args.attribute_key},
      'active', ${createdBy}, ${entityId},
      CASE WHEN ${entityId}::bigint IS NULL THEN ARRAY[]::bigint[] ELSE ARRAY[${entityId}]::bigint[] END,
      ${automationId}, ${sql.json(withEmbeddings)}, ${args.min_similarity ?? 0.7}, ${args.fallback_value ?? null}
    )
    RETURNING id, slug, name, attribute_key, entity_id, entity_ids, automation_id as automation_id
  `;
  const classifier = classifierResult[0];

  return {
    success: true,
    action: 'create',
    message:
      generatedCount > 0
        ? `Classifier '${args.slug}' created successfully (generated ${generatedCount} embeddings)`
        : `Classifier '${args.slug}' created successfully`,
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

  // No automation_id filter: org-level classifiers (automation_id IS NULL) are the
  // kind `create` now produces by default and the only kind the engine matches.
  // The old `fc.automation_id IS NOT NULL` condition hid every one of them from
  // the agent that had just created it (and left the NULLS LAST ordering below
  // dead).
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
      fc.min_similarity, fc.fallback_value, fc.attribute_values,
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
    attribute_values: stripEmbeddingsFromAttributeValues(row.attribute_values),
  }));

  return {
    success: true,
    action: 'list',
    message: `Found ${result.length} classifiers`,
    data: { classifiers: result },
  };
}

async function handleGenerateEmbeddings(
  args: Static<typeof GenerateClassifierEmbeddingsAction>,
  env: Env,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  const facet = await sql`
    SELECT cf.attribute_values
    FROM classify_facet cf
    WHERE cf.id = ${args.classifier_id}
      AND cf.status = 'active'
      AND cf.organization_id = ${ctx.organizationId}
  `;
  if (facet.length === 0) {
    return {
      success: false,
      action: 'generate_embeddings',
      message: `No active classifier found for ${args.classifier_id}`,
    };
  }

  const current = facet[0];
  const attributeValues = current.attribute_values as Record<string, any>;
  const { attributeValues: updatedValues, generatedCount } = await hydrateAttributeEmbeddings(
    attributeValues,
    env,
    { forceRegenerate: args.force_regenerate, embeddingModel: args.embedding_model }
  );

  // Config + embeddings live on the single classify_facet row now.
  if (generatedCount > 0 || args.force_regenerate) {
    await sql`UPDATE classify_facet SET attribute_values = ${sql.json(updatedValues)}, updated_at = now() WHERE id = ${args.classifier_id}`;
  }

  return {
    success: true,
    action: 'generate_embeddings',
    message:
      generatedCount > 0
        ? `Generated ${generatedCount} embeddings`
        : 'All attribute values already have embeddings',
    data: {
      classifier_id: args.classifier_id,
      generated_embeddings: generatedCount,
      attribute_count: Object.keys(updatedValues).length,
    },
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
    const source = args.source || 'user';

    if (isSingleMode) {
      if (args.content_id === undefined)
        return { success: false, action: 'classify', message: 'content_id is required' };
      if (args.value === undefined)
        return { success: false, action: 'classify', message: 'value is required' };

      const result = await updateSingleClassification(
        sql,
        ctx.organizationId,
        args.content_id,
        classifier,
        args.value,
        source,
        args.reasoning
      );
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
          updateSingleClassification(
            sql,
            ctx.organizationId,
            item.content_id,
            classifier,
            item.value,
            source,
            item.reasoning || args.reasoning
          )
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
 * Why an id the caller asked for produced no classification. These are the
 * engine's own target-selection conjuncts, in the order it applies them.
 */
type SkipReason = 'not_in_organization' | 'superseded' | 'not_embedded' | 'below_threshold';

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  not_in_organization: 'not in this organization',
  superseded: 'superseded',
  not_embedded: 'not embedded',
  below_threshold: 'below min_similarity',
};

/**
 * Run a classifier's embedding match over caller-supplied content ids.
 *
 * This is the agent-facing entry to the same engine the reconciliation cron
 * uses; the cron only ever reaches it in `entity` mode, so org-scoped feeds
 * (events with no entity link) had no way to be classified at all.
 *
 * Every id that does not produce a classification is reported with a reason.
 * The engine filters on `fe.embedding IS NOT NULL`, so an unembedded event is
 * dropped by a WHERE clause — reporting the count is what keeps that from
 * looking like a successful no-op.
 */
async function runApply(
  args: Static<typeof ApplyClassifierAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  const sql = getDb();

  // Dedupe so the counts below describe distinct events, not request repeats.
  const requestedIds = [...new Set(args.content_ids)];

  // Resolved once and used for BOTH the has_embedding probe and the engine
  // call. If the probe checked one model and the engine another, an event
  // would pass the probe and then be dropped by the engine's join — landing in
  // `below_threshold`, which would be a lie about a row that was never scored.
  const embeddingModel = resolveEmbeddingModel(args.embedding_model);

  // Mirrors the engine's classifier-template lookup exactly (org + active +
  // automation_id IS NULL). Diverging here would report an automation-owned classifier
  // as "found" and then blame its zero results on min_similarity.
  const classifierRows = (await sql`
    SELECT cf.id AS classifier_id
    FROM classify_facet cf
    WHERE cf.slug = ${args.classifier_slug}
      AND cf.status = 'active'
      AND cf.automation_id IS NULL
      AND cf.organization_id = ${ctx.organizationId}
  `) as unknown as Array<{ classifier_id: number }>;

  if (classifierRows.length === 0) {
    return {
      success: false,
      action: 'apply',
      message: `Classifier not found or inactive: ${args.classifier_slug}`,
    };
  }

  // Partition the request BEFORE classifying so each skip has a real reason
  // rather than being inferred from a missing result.
  //
  // The engine's target set is (in this org) AND (live) AND (has a representative
  // vector). Each of those three is evaluated SEPARATELY here, because the value
  // of this action is not just the classified/skipped split — it is that the
  // stated reason is TRUE. Collapsing any two of them reports a real condition
  // under a false name:
  //   - live: read from `events` and derive liveness from `superseded_by`, NOT
  //     from `current_event_records`. The view is the right relation for the
  //     ENGINE, but selecting through it here makes a superseded event
  //     indistinguishable from a foreign one, and it gets reported as
  //     `not_in_organization` — sending the reader after a tenancy bug that does
  //     not exist. Reading the base table without the liveness split is the
  //     opposite error: the event looks reachable and gets blamed on
  //     `below_threshold`.
  //   - chunk/model: the engine joins the representative vector (chunk 0 AND the
  //     SAME model resolved above), so a stale-model vector is not an embedding
  //     to it.
  //     Ignoring the model stamp reports `below_threshold` for a row that the
  //     engine never scored at all.
  //   - organization: the engine is org-scoped, as is this.
  const inOrg = (await sql`
    SELECT e.id,
           (e.superseded_by IS NULL) AS is_live,
           EXISTS (
             SELECT 1 FROM event_embeddings emb
             WHERE emb.event_id = e.id
               AND emb.chunk_index = 0
               AND emb.embedding_model = ${embeddingModel}
           ) AS has_embedding
    FROM events e
    WHERE e.organization_id = ${ctx.organizationId}
      AND e.id = ANY(${pgBigintArray(requestedIds)}::bigint[])
  `) as unknown as Array<{ id: number; is_live: boolean; has_embedding: boolean }>;

  const byId = new Map(inOrg.map((r) => [Number(r.id), r]));
  const embeddedIds = inOrg
    .filter((r) => r.is_live && r.has_embedding)
    .map((r) => Number(r.id));

  let classifiedIds: number[] = [];
  if (embeddedIds.length > 0) {
    const results = await executeClassificationQuery({
      mode: 'content_ids',
      organizationId: ctx.organizationId,
      content_ids: embeddedIds,
      enabledClassifiers: [args.classifier_slug],
      embeddingModel,
    });
    classifiedIds = [...new Set(results.map((r) => Number(r.content_id)))];
  }
  const classified = new Set(classifiedIds);

  // One pass, in the engine's own conjunct order, so an id can only ever carry
  // the FIRST condition it actually fails. Counts and samples are derived from
  // this single list rather than from parallel filters, so they cannot disagree.
  const skipped: Array<{ id: number; reason: SkipReason }> = [];
  for (const id of requestedIds) {
    const row = byId.get(id);
    // An id this org cannot see is indistinguishable from one that never
    // existed, and both are equally "not yours to classify".
    if (!row) skipped.push({ id, reason: 'not_in_organization' });
    else if (!row.is_live) skipped.push({ id, reason: 'superseded' });
    else if (!row.has_embedding) skipped.push({ id, reason: 'not_embedded' });
    // In-org, live, embedded and still unclassified means every attribute value
    // scored below min_similarity and no fallback_value is set.
    else if (!classified.has(id)) skipped.push({ id, reason: 'below_threshold' });
  }

  const counts: Record<SkipReason, number> = {
    not_in_organization: 0,
    superseded: 0,
    not_embedded: 0,
    below_threshold: 0,
  };
  for (const s of skipped) counts[s.reason]++;

  const detail = (Object.entries(counts) as Array<[SkipReason, number]>)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${SKIP_REASON_TEXT[reason]}`);

  return {
    success: true,
    action: 'apply',
    message:
      `Classified ${classifiedIds.length}/${requestedIds.length} with "${args.classifier_slug}"` +
      (detail.length > 0 ? `; ${detail.join('; ')}` : ''),
    data: {
      requested: requestedIds.length,
      classified: classifiedIds.length,
      skipped: counts,
      // Bounded sample: enough to go look at the actual events behind a
      // disappointing run, without returning thousands of ids into the agent's
      // context. Truncation is visible from `skipped` vs this length.
      sample_skipped: skipped.slice(0, 20),
    },
  };
}

/**
 * Same failure contract as `classify`: a thrown DB/engine error comes back as a
 * `manage_classifiers` result with `success: false`, not a raw exception out of
 * `routeAction`.
 */
async function handleApply(
  args: Static<typeof ApplyClassifierAction>,
  ctx: ToolContext
): Promise<ManageClassifiersResult> {
  try {
    return await runApply(args, ctx);
  } catch (error) {
    logger.error(
      { error, classifier_slug: args.classifier_slug, requested: args.content_ids.length },
      'Failed to apply classifier over content ids'
    );
    return {
      success: false,
      action: 'apply',
      message: error instanceof Error ? error.message : 'Failed to apply classifier',
    };
  }
}

async function updateSingleClassification(
  sql: DbClient,
  organizationId: string,
  contentId: number,
  classifier: { classifier_id: number; attribute_key: string },
  value: string | null,
  source: 'llm' | 'user',
  reasoning?: string
): Promise<{ success: boolean; message?: string }> {
  const contentCheck = await sql`
    SELECT id FROM events
    WHERE id = ${contentId} AND organization_id = ${organizationId}
  `;
  if (contentCheck.length === 0) {
    return { success: false, message: `Content not found: ${contentId}` };
  }

  const existingClassification = await sql`
    SELECT confidences FROM event_classifications
    WHERE event_id = ${contentId} AND classifier_id = ${classifier.classifier_id} AND source = 'embedding'
  `;

  let confidences: Record<string, number> = {};
  if (existingClassification.length > 0) {
    const existing = existingClassification[0].confidences as Record<string, number> | null;
    if (existing && typeof existing === 'object') confidences = { ...existing };
  }
  if (value) confidences[value] = 1.0;

  // Format as PostgreSQL text array literal — postgres.js with fetch_types:false can't serialize JS arrays
  const valuesLiteral = value ? `{${value}}` : '{}';

  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM event_classifications
      WHERE event_id = ${contentId} AND classifier_id = ${classifier.classifier_id} AND source = ${source} AND automation_id IS NULL
    `;
    await tx`
      INSERT INTO event_classifications (event_id, classifier_id, automation_id, run_id, "values", confidences, source, is_manual, reasoning)
      VALUES (${contentId}, ${classifier.classifier_id}, NULL, NULL, ${valuesLiteral}::text[], ${sql.json(confidences)}, ${source}, true, ${reasoning || null})
    `;
  });

  return { success: true };
}
