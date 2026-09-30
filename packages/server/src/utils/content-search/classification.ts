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

/**
 * Classifier ids for each filtered slug, resolved inside ONE organization.
 * A slug is a tenant-scoped name, so another organization's classifier with
 * the same slug must never contribute ids. The organization is the caller's
 * when known, otherwise the owner of the scoped entity.
 */
export async function resolveClassifierIds(
  sql: DbClient,
  filtersBySlug: Map<string, string[]>,
  scope: { organizationId?: string | null; entityId?: number | null }
): Promise<Map<string, number[]>> {
  const slugs = Array.from(filtersBySlug.keys())
    .map((slug) => String(slug).trim())
    .filter((slug) => slug.length > 0);

  const mapping = new Map<string, number[]>();
  if (slugs.length === 0 || (!scope.organizationId && scope.entityId == null)) return mapping;

  const rows = await sql`
    SELECT ccl.slug, ccl.id AS classifier_id
    FROM classify_facet ccl
    WHERE ccl.slug = ANY(${pgTextArray(slugs)}::text[])
      AND ccl.organization_id = COALESCE(
        ${scope.organizationId ?? null}::text,
        (SELECT organization_id FROM entities WHERE id = ${scope.entityId ?? null}::bigint)
      )
  `;
  collectClassifierIds(rows, mapping);
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
  classificationSource: 'user' | 'embedding' | 'llm',
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

/** Keep filters and displayed labels identical, including timestamp ties. */
export function buildClassificationOrderSql(alias: string): string {
  return `CASE ${alias}.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
          ${alias}.created_at DESC NULLS FIRST, ${alias}.id DESC`;
}

export function buildClassificationExistsClauses(
  filtersBySlug: Map<string, string[]>,
  classifierIdsBySlug: Map<string, number[]>,
  classificationSource: 'user' | 'embedding' | 'llm' | undefined,
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

    // An explicit source asks what that source said; otherwise match only
    // the label the reader shows, even when other sources disagree.
    const winningRowSql = classificationSource
      ? ''
      : `AND cc.id = (
            SELECT hi.id FROM event_classifications hi
            WHERE hi.event_id = cc.event_id
              AND hi.classifier_id = cc.classifier_id
            ORDER BY ${buildClassificationOrderSql('hi')}
            LIMIT 1
          )`;
    clauses.push(
      `
      EXISTS (
        SELECT 1 FROM event_classifications cc
        WHERE cc.event_id = f.id
          AND ${classifierFilterSql}
          AND cc."values" && ${valuesParamSQL}
          ${sourceCondition}
          ${winningRowSql}
      )
    `.trim()
    );
  }

  if (clauses.length === 0) {
    return null;
  }

  return { clauses, params };
}
