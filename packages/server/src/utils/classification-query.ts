/**
 * Shared Classification Query Utility
 *
 * Provides a unified classification query builder for both queue-based
 * and entity-based classification scenarios.
 *
 * Vector operations (cosine similarity) are computed in TypeScript.
 */

import { type DbClient, getDb, parsePgNumberArray, pgTextArray } from '../db/client';
import { entityLinkMatchSql } from './content-search';
import { embeddingModelSqlLiteral, resolveEmbeddingModel } from './embeddings';
import logger from './logger';

/**
 * Classifier consolidation (P4) phase 6c: the classifier config is read from classify_facet (the
 * config-home that mirrors event_classifiers identity + the CURRENT version's config) instead of
 * the legacy event_classifiers -> event_classifier_versions(is_current) JOIN. classify_facet is an
 * accurate mirror (triggers sync identity + config incl. in-place edits), so the reads are
 * equivalent. The cutover is unconditional; the legacy JOIN and its env flag are gone.
 */

/**
 * Default weights for combining child and parent embeddings.
 * Child weight: 0.7 (70%) - emphasizes direct content
 * Parent weight: 0.3 (30%) - incorporates context
 */
const CHILD_EMBEDDING_WEIGHT = 0.7;
const PARENT_EMBEDDING_WEIGHT = 0.3;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function combineEmbeddings(
  child: number[],
  parent: number[],
  childWeight: number,
  parentWeight: number
): number[] {
  const result = new Array(child.length);
  for (let i = 0; i < child.length; i++) {
    result[i] = child[i] * childWeight + parent[i] * parentWeight;
  }
  return result;
}

function roundTo4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Parse a pgvector column value into a number[].
 *
 * The prod client runs `fetch_types:false` and registers NO pgvector type
 * parser (db/client.ts only parses bigint + JSON/JSONB), so postgres.js returns
 * a `vector` column as its TEXT representation `"[1,2,3]"` — NOT a JS array.
 * Every other embedding consumer computes cosine in SQL via the `<=>` operator;
 * this classification path is the ONLY one that materializes the raw vector in
 * JS, so it MUST parse the text form. Treating the string as a number[] (the old
 * `as number[]` cast) made cosineSimilarity iterate over characters → NaN, so the
 * embedding path silently produced no real similarities (its only caller, the
 * reconciliation cron, swallows the result). The Array.isArray branch is
 * defensive in case a future parser pre-materializes the value.
 */
function parsePgVector(value: number[] | string | null | undefined): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  const inner = value.slice(1, -1); // strip the surrounding "[ ]"
  return inner.length === 0 ? [] : inner.split(',').map(Number);
}

interface ClassificationQueryOptions {
  /**
   * Target selection mode
   */
  mode: 'entity' | 'content_ids';

  /**
   * Owning organization. REQUIRED: both the target-content and the
   * classifier-template lookups filter on it. Before this was threaded through,
   * `content_ids` mode selected purely on `f.id IN (...)` and the template
   * lookup purely on `cf.slug IN (...)`, so a caller could classify another
   * org's events, or match against another org's classifier of the same slug.
   * That was unreachable while the only caller was the reconciliation cron
   * (which derives ids from one org's own entity); it becomes reachable the
   * moment an agent-facing action can pass ids directly.
   */
  organizationId: string;

  /**
   * Enabled classifier slugs
   */
  enabledClassifiers: string[];

  /**
   * For mode='entity': Filter by entity type and ID
   */
  entity_type?: string;
  entity_id?: number;

  /**
   * For mode='content_ids': Specific content IDs to classify
   */
  content_ids?: number[];

  /**
   * Embedding model to classify in. Defaults to the deployment's configured
   * model. Scopes BOTH sides of every cosine comparison — the event vectors
   * joined from `event_embeddings` and the label vectors read from
   * `classify_facet.attribute_values` — so the two can never be drawn from
   * different spaces.
   *
   * A model with no vectors yields no matches rather than an error: the event
   * join finds nothing and the templates are all filtered out. That is the
   * correct read of "this corpus is not embedded under that model", but it is
   * indistinguishable from "nothing matched" at this layer, so agent-facing
   * callers must report the emptiness themselves (see `manage_classifiers`'
   * `not_embedded` skip reason).
   */
  embeddingModel?: string;
}

// ── Internal types for intermediate data ───────────────────────────────

interface TargetContent {
  id: number;
  entity_ids: number[];
  parent_id: number | null;
  combined_embedding: number[];
}

interface ClassifierTemplate {
  classifier_id: number;
  min_similarity: number;
  fallback_value: string | null;
  attribute_value: string;
  parent_mapping: Record<string, string> | null;
  template_embedding: number[];
}

interface Similarity {
  content_id: number;
  classifier_id: number;
  attribute_value: string;
  parent_mapping: Record<string, string> | null;
  min_similarity: number;
  fallback_value: string | null;
  confidence: number;
}

interface BestMatch {
  content_id: number;
  classifier_id: number;
  value: string | null;
  parent_mapping: Record<string, string> | null;
  actual_confidence: number;
  met_threshold: boolean;
  threshold: number;
  best_match_attribute: string;
  fallback_value: string | null;
  confidences_map: Record<string, number>;
}

export interface AllClassification {
  content_id: number;
  classifier_id: number;
  value: string;
  confidences_map: Record<string, number>;
  met_threshold: boolean;
  threshold: number;
  best_match_attribute: string;
  actual_confidence: number;
}

interface ClassifierVersionLookup {
  slug: string;
  classifier_id: number;
}

// ── Step 1: Fetch target content with embeddings ───────────────────────

async function fetchTargetContent(
  sql: DbClient,
  options: ClassificationQueryOptions,
  embeddingModel: string
): Promise<TargetContent[]> {
  const { mode, enabledClassifiers } = options;

  // Build the classifier version IDs for the "not yet classified" check
  const classifierPlaceholders = enabledClassifiers.map((_, i) => `$${i + 1}`).join(', ');

  let targetRows: Array<{
    id: number;
    entity_ids: number[];
    parent_id: number | null;
    // pgvector columns come back as the TEXT form "[1,2,3]" under fetch_types:false
    // (no registered parser) — parsePgVector() materializes them.
    embedding: string | number[] | null;
    parent_embedding: string | number[] | null;
  }>;

  // current_event_records no longer carries an embedding (multi-vector). For
  // classification the representative chunk_index=0 vector (lead content) stands
  // in for "the event's embedding" — same semantics as the pre-chunking single
  // vector. Scoped to the requested model so we never compare across spaces.
  const embModel = embeddingModelSqlLiteral(embeddingModel);
  const repEmbeddingJoins = `LEFT JOIN event_embeddings fe ON fe.event_id = f.id AND fe.chunk_index = 0 AND fe.embedding_model = ${embModel}
       LEFT JOIN event_embeddings pe ON pe.event_id = parent.id AND pe.chunk_index = 0 AND pe.embedding_model = ${embModel}`;

  // Tenancy scoping for the parent join. `origin_id` is the connector's own
  // identifier and is NOT unique across tenants — a GitHub node id or Hacker
  // News item id is the same string in every org that syncs it — so joining on
  // it alone resolved another tenant's row and blended that row's vector into
  // this org's classification at PARENT_EMBEDDING_WEIGHT. Prod carried 1,118
  // live cross-org matches and 25,099 same-org cross-connection ones.
  //
  // `IS NOT DISTINCT FROM` rather than `=` on connection_id: 17% of
  // parent-referencing rows have a NULL connection, and plain equality would
  // silently strand all of them without parent context. Org equality is what
  // makes NULL-matches-NULL safe. Mirrors the thread-chain join in
  // content-search/ctes.ts, which scopes by connection for the same reason.
  const parentJoin = `LEFT JOIN current_event_records parent
         ON parent.organization_id = f.organization_id
        AND parent.origin_id = f.origin_parent_id
        AND parent.connection_id IS NOT DISTINCT FROM f.connection_id`;

  if (mode === 'content_ids') {
    const contentIds = options.content_ids!;
    const contentPlaceholders = contentIds.map((_, i) => `$${i + 2}`).join(', ');

    // $1 is the org; ids start at $2. Org-scoping here is what makes the
    // agent-facing `apply` action safe to expose — see ClassificationQueryOptions.
    targetRows = await sql.unsafe(
      `SELECT DISTINCT
         f.id,
         f.entity_ids,
         NULL as parent_id,
         fe.embedding,
         pe.embedding as parent_embedding
       FROM current_event_records f
       ${parentJoin}
       ${repEmbeddingJoins}
       WHERE f.organization_id = $1
         AND f.id IN (${contentPlaceholders})
         AND fe.embedding IS NOT NULL`,
      [options.organizationId, ...contentIds]
    );
  } else if (mode === 'entity') {
    const entityId = options.entity_id!;

    // Get the stable classifier IDs whose embedding classifications we maintain
    const classifierRows = await sql.unsafe<{ classifier_id: number }>(
      `SELECT cf.id as classifier_id
       FROM classify_facet cf
       WHERE cf.slug IN (${classifierPlaceholders})
         AND cf.status = 'active'
         AND cf.automation_id IS NULL
         AND cf.engine = 'embedding'
         AND cf.organization_id = $${enabledClassifiers.length + 1}`,
      [...enabledClassifiers, options.organizationId]
    );
    const classifierIds = classifierRows.map((r) => r.classifier_id);

    if (classifierIds.length === 0) return [];

    const classifierIdPlaceholders = classifierIds.map((_, i) => `$${i + 2}`).join(', ');
    targetRows = await sql.unsafe(
      `SELECT DISTINCT
         f.id,
         f.entity_ids,
         NULL as parent_id,
         fe.embedding,
         pe.embedding as parent_embedding
       FROM current_event_records f
       ${parentJoin}
       ${repEmbeddingJoins}
       WHERE (
           ${entityLinkMatchSql('$1::bigint')}
           OR (
             (SELECT parent_id FROM entities WHERE id = $1) IS NULL
             AND f.entity_ids && ARRAY(
               SELECT id FROM entities WHERE parent_id = $1 AND enabled_classifiers IS NULL
             )::bigint[]
           )
         )
         AND fe.embedding IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM unnest(ARRAY[${classifierIdPlaceholders}]::bigint[]) AS ccc(classifier_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM event_classifications cc
             WHERE cc.event_id = f.id
               AND cc.classifier_id = ccc.classifier_id
               AND cc.source = 'embedding'
           )
         )`,
      [entityId, ...classifierIds]
    );
  } else {
    throw new Error(`Invalid mode: ${mode}`);
  }

  // Compute combined embeddings in TypeScript (parsing the pgvector text form).
  return targetRows
    .map((row) => {
      const childEmb = parsePgVector(row.embedding);
      // WHERE fe.embedding IS NOT NULL guarantees a vector, but stay defensive.
      if (childEmb == null) return null;
      const parentEmb = parsePgVector(row.parent_embedding);

      const combined =
        parentEmb != null
          ? combineEmbeddings(childEmb, parentEmb, CHILD_EMBEDDING_WEIGHT, PARENT_EMBEDDING_WEIGHT)
          : childEmb;

      return {
        id: row.id,
        // `entity_ids` is bigint[]; under fetch_types:false it arrives as the raw
        // literal "{1,2}" (or "{}"), never a JS array. The scope check flatMaps
        // these into a Set — flatMap doesn't flatten strings, so the Set would
        // hold the raw literal and numeric membership tests would never match.
        entity_ids: parsePgNumberArray(row.entity_ids),
        parent_id: row.parent_id,
        combined_embedding: combined,
      };
    })
    .filter((tc): tc is TargetContent => tc !== null);
}

// ── Step 2: Fetch classifier templates ─────────────────────────────────

async function fetchClassifierTemplates(
  sql: DbClient,
  enabledClassifiers: string[],
  targetContent: TargetContent[],
  organizationId: string,
  embeddingModel: string
): Promise<ClassifierTemplate[]> {
  if (targetContent.length === 0) return [];

  const classifierPlaceholders = enabledClassifiers.map((_, i) => `$${i + 1}`).join(', ');

  // Fetch classifier versions with their attribute_values JSON
  const rows = await sql.unsafe<{
    classifier_id: number;
    min_similarity: number;
    fallback_value: string | null;
    attribute_values: string | Record<string, unknown>;
    entity_ids: number[] | null;
  }>(
    `SELECT DISTINCT
       cf.id as classifier_id,
       cf.min_similarity,
       cf.fallback_value,
       cf.attribute_values,
       cf.entity_ids
     FROM classify_facet cf
     WHERE cf.slug IN (${classifierPlaceholders})
       AND cf.status = 'active'
       AND cf.automation_id IS NULL
       -- Service classifiers have no label vectors; \`apply\` runs them through the service.
       AND cf.engine = 'embedding'
       AND cf.organization_id = $${enabledClassifiers.length + 1}`,
    [...enabledClassifiers, organizationId]
  );

  // Collect unique entity_ids from target content for scoping
  const targetEntityIds = new Set(targetContent.flatMap((tc) => tc.entity_ids));

  // Expand attribute_values JSON into individual templates in TypeScript
  const templates: ClassifierTemplate[] = [];
  let staleTemplates = 0;

  for (const row of rows) {
    // Scope check: classifier must be global (empty entity_ids) OR overlap with target content entity_ids
    // Same raw-array read as above. Without the parse, "{}" is a 2-char string:
    // the length guard passes and `.some` throws TypeError. `manage_classifiers
    // create` writes ARRAY[]::bigint[] rather than NULL, so every org-level
    // classifier it creates would crash the engine on this line.
    const classifierEntityIds = parsePgNumberArray(row.entity_ids ?? []);
    if (
      classifierEntityIds.length > 0 &&
      !classifierEntityIds.some((id) => targetEntityIds.has(id))
    ) {
      continue;
    }

    const attrValues = row.attribute_values as Record<string, unknown>;

    for (const [key, val] of Object.entries(attrValues)) {
      const attrObj = val as Record<string, unknown>;
      const embeddingArr = attrObj.embedding as number[] | undefined;
      if (!embeddingArr) continue;

      // The event side of this comparison is model-scoped (fetchTargetContent
      // joins event_embeddings ON embedding_model = the SAME `embeddingModel`
      // passed here), so the label side must be too. Cosine across two different
      // 768-dim spaces returns a confident-looking number instead of an error,
      // which is the whole hazard: without this guard a model swap keeps
      // classifying and silently assigns wrong labels.
      //
      // Both sides take the model from one resolved value in
      // executeClassificationQuery — deliberately not re-read from config here,
      // because two independent reads is exactly how the two sides drift apart.
      //
      // Dropped rather than compared, and counted so the operator sees a real
      // reason instead of a bare "No classifier templates found".
      if (attrObj.embedding_model !== embeddingModel) {
        staleTemplates++;
        continue;
      }

      const parentMapping = attrObj.parent as Record<string, string> | undefined;

      templates.push({
        classifier_id: row.classifier_id,
        min_similarity: row.min_similarity,
        fallback_value: row.fallback_value,
        attribute_value: key,
        parent_mapping: parentMapping && typeof parentMapping === 'object' ? parentMapping : null,
        template_embedding: embeddingArr,
      });
    }
  }

  if (staleTemplates > 0) {
    logger.warn(
      {
        staleTemplates,
        usableTemplates: templates.length,
        embeddingModel,
        classifiers: enabledClassifiers,
      },
      '[Classification Query] Dropped label vectors embedded by a different model — ' +
        'run manage_classifiers generate_embeddings to re-embed them under this model'
    );
  }

  return templates;
}

// ── Step 3: Compute similarities in TypeScript ─────────────────────────

function computeSimilarities(
  targetContent: TargetContent[],
  templates: ClassifierTemplate[]
): Similarity[] {
  const similarities: Similarity[] = [];

  for (const tc of targetContent) {
    for (const ct of templates) {
      const confidence = cosineSimilarity(tc.combined_embedding, ct.template_embedding);
      similarities.push({
        content_id: tc.id,
        classifier_id: ct.classifier_id,
        attribute_value: ct.attribute_value,
        parent_mapping: ct.parent_mapping,
        min_similarity: ct.min_similarity,
        fallback_value: ct.fallback_value,
        confidence,
      });
    }
  }

  return similarities;
}

// ── Step 4: Determine best matches ─────────────────────────────────────

function determineBestMatches(similarities: Similarity[]): BestMatch[] {
  // Group by (content_id, classifier_id)
  const groups = new Map<string, Similarity[]>();
  for (const s of similarities) {
    const key = `${s.content_id}:${s.classifier_id}`;
    const group = groups.get(key);
    if (group) {
      group.push(s);
    } else {
      groups.set(key, [s]);
    }
  }

  const bestMatches: BestMatch[] = [];

  for (const group of groups.values()) {
    // Build confidences map (all attribute_value -> confidence for this group)
    const confidencesMap: Record<string, number> = {};
    for (const s of group) {
      confidencesMap[s.attribute_value] = roundTo4(s.confidence);
    }

    // Sort by confidence descending and pick the best
    group.sort((a, b) => b.confidence - a.confidence);
    const best = group[0];

    const metThreshold = best.confidence >= best.min_similarity;
    const value = metThreshold ? best.attribute_value : best.fallback_value;
    const parentMapping = metThreshold ? best.parent_mapping : null;

    bestMatches.push({
      content_id: best.content_id,
      classifier_id: best.classifier_id,
      value,
      parent_mapping: parentMapping,
      actual_confidence: roundTo4(best.confidence),
      met_threshold: metThreshold,
      threshold: best.min_similarity,
      best_match_attribute: best.attribute_value,
      fallback_value: best.fallback_value,
      confidences_map: confidencesMap,
    });
  }

  return bestMatches;
}

// ── Step 5: Generate parent classifications ────────────────────────────

function generateParentClassifications(
  bestMatches: BestMatch[],
  classifierVersionLookup: Map<string, ClassifierVersionLookup>
): AllClassification[] {
  const parentClassifications: AllClassification[] = [];

  for (const bm of bestMatches) {
    if (bm.value == null || bm.parent_mapping == null) continue;

    for (const [parentSlug, parentValue] of Object.entries(bm.parent_mapping)) {
      const parentLookup = classifierVersionLookup.get(parentSlug);
      if (parentLookup == null) continue;

      parentClassifications.push({
        content_id: bm.content_id,
        classifier_id: parentLookup.classifier_id,
        value: parentValue,
        confidences_map: {},
        met_threshold: true,
        threshold: 0,
        best_match_attribute: parentValue,
        actual_confidence: bm.actual_confidence,
      });
    }
  }

  return parentClassifications;
}

// ── Step 6: Fetch all classifier version slugs for parent lookups ──────

async function fetchAllClassifierVersions(
  sql: DbClient,
  organizationId: string
): Promise<ClassifierVersionLookup[]> {
  return sql.unsafe<ClassifierVersionLookup>(
    `SELECT cf.slug, cf.id as classifier_id
     FROM classify_facet cf
     WHERE cf.status = 'active'
       AND cf.automation_id IS NULL
       AND cf.organization_id = $1`,
    [organizationId]
  );
}

// ── Step 7: Upsert classifications via DELETE + INSERT ─────────────────

export async function upsertClassifications(
  sql: DbClient,
  classifications: AllClassification[]
): Promise<{ content_id: number }[]> {
  if (classifications.length === 0) return [];

  // Deduplicate: for each (content_id, classifier_id), keep the one with highest confidence
  // and merge values/confidences (matches the old ON CONFLICT logic)
  const deduped = new Map<string, AllClassification & { merged_values: string[] }>();
  for (const c of classifications) {
    const key = `${c.content_id}:${c.classifier_id}`;
    const existing = deduped.get(key);
    if (existing) {
      // Merge values (distinct)
      if (!existing.merged_values.includes(c.value)) {
        existing.merged_values.push(c.value);
      }
      // Merge confidences
      Object.assign(existing.confidences_map, c.confidences_map);
      // Keep higher confidence
      if (c.actual_confidence > existing.actual_confidence) {
        existing.met_threshold = c.met_threshold;
        existing.threshold = c.threshold;
        existing.best_match_attribute = c.best_match_attribute;
        existing.actual_confidence = c.actual_confidence;
      }
    } else {
      deduped.set(key, { ...c, merged_values: [c.value] });
    }
  }

  const allClassifications = [...deduped.values()];

  // Build the conflict keys for DELETE (stable classifier_id — the post-collapse uniqueness key)
  const deleteConditions = allClassifications.map((c) => ({
    event_id: c.content_id,
    classifier_id: c.classifier_id,
  }));

  // Delete existing non-manual embedding classifications for these (event_id, classifier_id) pairs
  // Process in batches to avoid overly long SQL
  const BATCH_SIZE = 500;
  for (let i = 0; i < deleteConditions.length; i += BATCH_SIZE) {
    const batch = deleteConditions.slice(i, i + BATCH_SIZE);
    const whereClauses = batch
      .map(
        (_, j) =>
          `(event_id = $${j * 2 + 1} AND classifier_id = $${j * 2 + 2} AND source = 'embedding' AND COALESCE(automation_id, 0) = 0)`
      )
      .join(' OR ');
    const params = batch.flatMap((d) => [d.event_id, d.classifier_id]);

    await sql.unsafe(
      `DELETE FROM event_classifications
       WHERE NOT is_manual AND (${whereClauses})`,
      params
    );
  }

  // Insert new classifications in batches
  const affectedContentIds = new Set<number>();

  for (let i = 0; i < allClassifications.length; i += BATCH_SIZE) {
    const batch = allClassifications.slice(i, i + BATCH_SIZE);

    // Each row BINDS 8 params (event_id, classifier_id, values, confidences, met_threshold,
    // threshold, best_match_attribute, embedding_confidence); automation_id/run_id are NULL and
    // source/is_manual are literals. The stride MUST be 8 — the old `j * 10` overran by 2 per row,
    // so any batch with >1 classification mis-mapped params (row 2 read $11.. while its params sat
    // at $9..) and Postgres rejected it. Single-classification batches were unaffected (j=0).
    const valuePlaceholders = batch
      .map((_, j) => {
        const base = j * 8;
        // $base+3 is the values text[]: under fetch_types:false (prod config) a raw JS array param
        // serializes to a malformed literal, so it MUST be a pgTextArray() pg-literal string cast
        // ::text[] (same pattern every other text[] insert in the codebase uses).
        return `($${base + 1}, $${base + 2}, NULL, NULL, $${base + 3}::text[], $${base + 4}::JSON, 'embedding', false, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(', ');

    const params = batch.flatMap((c) => [
      c.content_id,
      c.classifier_id,
      pgTextArray(c.merged_values),
      JSON.stringify(c.confidences_map),
      c.met_threshold,
      c.threshold,
      c.best_match_attribute,
      c.actual_confidence,
    ]);

    await sql.unsafe(
      `INSERT INTO event_classifications (
         event_id, classifier_id, automation_id, run_id,
         "values", confidences, source, is_manual,
         met_threshold, threshold, best_match_attribute, embedding_confidence
       )
       VALUES ${valuePlaceholders}`,
      params
    );

    for (const c of batch) {
      affectedContentIds.add(c.content_id);
    }
  }

  return [...affectedContentIds].map((content_id) => ({ content_id }));
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Execute classification query with shared logic.
 *
 * Returns array of {content_id} for successfully classified content.
 */
export async function executeClassificationQuery(
  options: ClassificationQueryOptions
): Promise<{ content_id: number }[]> {
  const { mode, enabledClassifiers } = options;

  if (enabledClassifiers.length === 0) {
    return [];
  }

  // Resolved ONCE and passed to both fetches. Event vectors and label vectors
  // are the two sides of every cosine below; resolving the model separately per
  // side is how they would come to disagree.
  const embeddingModel = resolveEmbeddingModel(options.embeddingModel);

  try {
    const sql = getDb();

    // Step 1: Fetch target content with embeddings
    const targetContent = await fetchTargetContent(sql, options, embeddingModel);
    if (targetContent.length === 0) {
      logger.info({ mode, embeddingModel }, '[Classification Query] No target content to classify');
      return [];
    }

    // Step 2: Fetch classifier templates (attribute_values expanded in TypeScript)
    const templates = await fetchClassifierTemplates(
      sql,
      enabledClassifiers,
      targetContent,
      options.organizationId,
      embeddingModel
    );
    if (templates.length === 0) {
      logger.info({ mode }, '[Classification Query] No classifier templates found');
      return [];
    }

    // Step 3: Compute cosine similarities in TypeScript
    const similarities = computeSimilarities(targetContent, templates);

    // Step 4: Determine best matches per (content_id, classifier_id)
    const bestMatches = determineBestMatches(similarities);

    // Step 5: Build parent classifications from parent_mapping
    const classifierVersionRows = await fetchAllClassifierVersions(sql, options.organizationId);
    const classifierVersionLookup = new Map(
      classifierVersionRows.map((r) => [r.slug, r])
    );
    const parentClassifications = generateParentClassifications(
      bestMatches,
      classifierVersionLookup
    );

    // Step 6: Combine direct and parent classifications
    const directClassifications: AllClassification[] = bestMatches
      .filter((bm) => bm.value != null)
      .map((bm) => ({
        content_id: bm.content_id,
        classifier_id: bm.classifier_id,
        value: bm.value!,
        confidences_map: bm.confidences_map,
        met_threshold: bm.met_threshold,
        threshold: bm.threshold,
        best_match_attribute: bm.best_match_attribute,
        actual_confidence: bm.actual_confidence,
      }));

    const allClassifications = [...directClassifications, ...parentClassifications];

    // Step 7: Upsert into event_classifications (DELETE + INSERT)
    const results = await upsertClassifications(sql, allClassifications);

    const logContext: Record<string, unknown> = { count: results.length, mode };
    if (mode === 'entity') {
      logContext.entity_type = options.entity_type;
      logContext.entity_id = options.entity_id;
    }
    if (mode === 'content_ids') logContext.content_count = options.content_ids?.length;

    logger.info(logContext, '[Classification Query] Success');
    return results;
  } catch (error) {
    logger.error(
      {
        mode,
        classifiers: enabledClassifiers,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack?.split('\n').slice(0, 10),
              }
            : String(error),
      },
      '[Classification Query] FAILED'
    );
    throw error;
  }
}
