/**
 * Classification filter helpers:
 * collectClassifierIds, resolveClassifierIds, buildClassificationExistsClauses.
 */

import { type DbClient, pgBigintArray, pgTextArray } from '../../db/client';
import logger from '../logger';

function collectClassifierIds(rows: unknown[], mapping: Map<string, number[]>): void {
  for (const row of rows as Array<{ slug: string; classifier_id: number | string }>) {
    const slug = String(row.slug);
    const classifierId =
      typeof row.classifier_id === 'number' ? row.classifier_id : Number(row.classifier_id);
    if (Number.isNaN(classifierId)) continue;
    const existing = mapping.get(slug);
    if (existing) {
      existing.push(classifierId);
    } else {
      mapping.set(slug, [classifierId]);
    }
  }
}

export async function resolveClassifierIds(
  sql: DbClient,
  filtersBySlug: Map<string, string[]>,
  entityId: number | undefined
): Promise<Map<string, number[]>> {
  const slugs = Array.from(filtersBySlug.keys())
    .map((slug) => String(slug).trim())
    .filter((slug) => slug.length > 0);

  if (slugs.length === 0) return new Map();

  const placeholders = slugs.map((_, index) => `$${index + 1}`).join(', ');
  const mapping = new Map<string, number[]>();

  if (entityId) {
    const entityRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccl.id as classifier_id
      FROM classify_facet ccl
      JOIN automations i ON i.id = ccl.automation_id
      WHERE ccl.slug IN (${placeholders})
        AND $${slugs.length + 1} = ANY(i.entity_ids)
    `,
      [...slugs, entityId]
    );
    collectClassifierIds(entityRows, mapping);
  }

  const missingSlugs = slugs.filter((slug) => !mapping.has(slug));
  if (missingSlugs.length > 0) {
    const globalPlaceholders = missingSlugs.map((_, index) => `$${index + 1}`).join(', ');
    const globalRows = await sql.unsafe(
      `
      SELECT ccl.slug, ccl.id as classifier_id
      FROM classify_facet ccl
      WHERE ccl.slug IN (${globalPlaceholders})
        AND ccl.automation_id IS NULL
    `,
      missingSlugs
    );
    collectClassifierIds(globalRows, mapping);
  }

  return mapping;
}

/**
 * Build a source-only EXISTS clause (no classifier-value filters).
 *
 * Mirrors the inline `$8` predicate emitted by `buildStandardWhereSql` so the
 * date-sort and score-sort paths return identical rows when only a
 * `classification_source` filter is supplied. Keyed by `f.id` over event_classifications.
 *
 * `tableAlias` is the alias of the outer event row (always `f` in both paths).
 */
export function buildSourceOnlyExistsClause(
  classificationSource: 'user' | 'embedding' | 'llm' | 'service',
  baseParamIndex: number,
  tableAlias = 'f'
): { clause: string; params: any[] } {
  return {
    clause: `
      EXISTS (
        SELECT 1 FROM event_classifications lc_source
        WHERE lc_source.event_id = ${tableAlias}.id
          AND lc_source.source = $${baseParamIndex}::text
      )
    `.trim(),
    params: [classificationSource],
  };
}

export function buildClassificationExistsClauses(
  filtersBySlug: Map<string, string[]>,
  classifierIdsBySlug: Map<string, number[]>,
  classificationSource: 'user' | 'embedding' | 'llm' | 'service' | undefined,
  baseParamIndex: number
): { clauses: string[]; params: any[] } | null {
  const clauses: string[] = [];
  const params: any[] = [];
  let paramIndex = baseParamIndex;

  let sourceCondition = '';
  if (classificationSource) {
    params.push(classificationSource);
    sourceCondition = ` AND cc.source = $${paramIndex}`;
    paramIndex++;
  }

  for (const [slug, values] of filtersBySlug.entries()) {
    const slugStr = String(slug);
    const valuesArr = Array.isArray(values) ? values.map((v) => String(v)) : [String(values)];

    if (valuesArr.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping empty values array for classification filter');
      continue;
    }

    const classifierIds = (classifierIdsBySlug.get(slugStr) || []).filter(
      (value) => typeof value === 'number' && Number.isInteger(value)
    );
    if (classifierIds.length === 0) {
      logger.warn({ slug: slugStr }, 'Skipping classification filter without classifier');
      return null;
    }

    // Parameterize values array. Under the prod client (fetch_types:false) a raw
    // JS array bound to a $N param serializes to a malformed array literal, so it
    // MUST be a pgTextArray() pg-literal string cast ::text[].
    params.push(pgTextArray(valuesArr));
    const valuesParamSQL = `$${paramIndex}::text[]`;
    paramIndex++;

    // Parameterize classifier IDs (stable classifier_id, any version's classifications).
    // Same fetch_types:false rule — bind a pgBigintArray() literal, not a raw JS array.
    params.push(pgBigintArray(classifierIds));
    const classifierFilterSql = `cc.classifier_id = ANY($${paramIndex}::bigint[])`;
    paramIndex++;

    clauses.push(
      `
      EXISTS (
        SELECT 1 FROM event_classifications cc
        WHERE cc.event_id = f.id
          AND ${classifierFilterSql}
          AND cc."values" && ${valuesParamSQL}
          ${sourceCondition}
      )
    `.trim()
    );
  }

  if (clauses.length === 0) {
    return null;
  }

  return { clauses, params };
}
