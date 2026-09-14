/**
 * SQL fragment constants and the `buildFinalSelect` / `deduplicateWithClassifications`
 * helpers used by both the listing and search paths.
 */

import type { ContentSearchResult } from './types';
import {
  boundedAttachmentsSql,
  boundedJsonSql,
  boundedPayloadTextSql,
} from '../content-read-bounds';

/**
 * Rows recall must not surface: the internal operational trail. Matched by the
 * shape their writers actually persist, on alias `f`:
 *
 *   - tool-invocation audit — `semantic_type 'audit'` + `origin_type
 *     'tool_invocation'`, the same pair `get_content`'s renderer recognizes
 *     these rows by (`tools/get_content/render.ts`).
 *   - config / lifecycle state changes — `semantic_type 'change'` +
 *     `metadata.category`, the shape `idx_events_lifecycle_changes` is
 *     defined on.
 *
 * Neither half keys on `metadata.category` alone: `save_content` strips only
 * the reserved `_lobu_` namespace, so `category` is caller-written, and a
 * member's note tagged `category: 'config'` must stay recallable. `origin_type`
 * is never set through `save_content`, and both COALESCEs keep the negation
 * two-valued (a NULL arm would drop the row instead of keeping it).
 */
export const INTERNAL_OPS_EXCLUSION_SQL = `(NOT (f.semantic_type = 'audit' AND COALESCE(f.origin_type, '') = 'tool_invocation')
           AND NOT (f.semantic_type = 'change' AND COALESCE(f.metadata->>'category', '') IN ('config', 'lifecycle')))`;

const CONTEXT_CASE_SQL = `
        CASE
          WHEN f.origin_parent_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM result_set rs2 JOIN current_event_records f2 ON rs2.id = f2.id WHERE f2.origin_id = f.origin_parent_id)
          THEN jsonb_build_object(
            'author_name', p.author_name,
            'title', p.title,
            'text_content', LEFT(p.payload_text, 200),
            'occurred_at', p.occurred_at,
            'source_url', p.source_url,
            'score', p.score
          )
          ELSE NULL
        END as parent_context,
        CASE
          WHEN tm.depth > 0
            AND NOT EXISTS (SELECT 1 FROM result_set rs2 JOIN current_event_records f2 ON rs2.id = f2.id WHERE f2.origin_id = tm.root_origin_id)
          THEN jsonb_build_object(
            'author_name', root.author_name,
            'title', root.title,
            'occurred_at', root.occurred_at,
            'source_url', root.source_url,
            'score', root.score
          )
          ELSE NULL
        END as root_context`;

const FINAL_JOINS_SQL = `
      LEFT JOIN connections c ON c.id = f.connection_id
      LEFT JOIN feeds fd ON fd.id = f.feed_id
      LEFT JOIN automation_versions wv ON wv.id = f.automation_version_id
      LEFT JOIN thread_meta tm ON tm.content_id = f.id`;

const FINAL_JOINS_WITH_CLASSIFICATIONS_SQL = `${FINAL_JOINS_SQL}
      LEFT JOIN latest_classifications lc_all ON lc_all.event_id = f.id
      LEFT JOIN classify_facet fcl_all ON lc_all.classifier_id = fcl_all.id`;

const PARENT_ROOT_JOINS_SQL = `
      LEFT JOIN LATERAL (
        SELECT p.author_name, p.title, p.payload_text, p.occurred_at, p.source_url, p.score
        FROM current_event_records p
        WHERE f.connection_id IS NOT NULL
          AND f.origin_parent_id IS NOT NULL
          AND p.connection_id = f.connection_id
          AND p.origin_id = f.origin_parent_id
        ORDER BY p.occurred_at DESC NULLS LAST, p.id DESC
        LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT root.author_name, root.title, root.occurred_at, root.source_url, root.score
        FROM current_event_records root
        WHERE f.connection_id IS NOT NULL
          AND tm.depth > 0
          AND root.connection_id = f.connection_id
          AND root.origin_id = tm.root_origin_id
        ORDER BY root.occurred_at DESC NULLS LAST, root.id DESC
        LIMIT 1
      ) root ON true`;

const BASE_COLUMNS_SQL = `f.id, f.entity_ids, f.connection_id, f.feed_id, f.feed_key, f.automation_id, fd.display_name as feed_name, COALESCE(wv.name, 'Automation #' || f.automation_id) as automation_name, ${boundedPayloadTextSql('f')}, f.title, f.author_name, f.source_url, f.occurred_at, f.semantic_type,
          f.connector_key as platform, f.origin_id, f.origin_parent_id, f.score, f.metadata, f.payload_type, ${boundedJsonSql('f', 'payload_data')}, ${boundedJsonSql('f', 'payload_template')}, ${boundedAttachmentsSql('f')}, f.origin_type,
          f.interaction_type, f.interaction_status, f.interaction_input_schema, f.interaction_input, f.interaction_output, f.interaction_error, f.supersedes_event_id, f.run_id`;

const CLASSIFICATION_COLUMNS_SQL = `fcl_all.attribute_key as classifier_attribute_key,
          lc_all."values" as classifier_values,
          lc_all.confidences as classifier_confidences,
          lc_all.source as classifier_source,
          lc_all.is_manual as classifier_is_manual`;

export function buildFinalSelect(opts: {
  withClassifications: boolean;
  extraColumns?: string;
  orderBy: string;
}): string {
  const classificationCol = opts.withClassifications
    ? CLASSIFICATION_COLUMNS_SQL
    : 'NULL as classifications';
  const extra = opts.extraColumns ? `,\n          ${opts.extraColumns}` : '';
  const joins = opts.withClassifications ? FINAL_JOINS_WITH_CLASSIFICATIONS_SQL : FINAL_JOINS_SQL;
  return `
      SELECT
        ${BASE_COLUMNS_SQL},
        ${classificationCol}${extra},
        f.created_at,
        COALESCE(tm.root_origin_id, f.origin_id, CAST(f.id AS VARCHAR)) as root_origin_id,
        tm.depth,
${CONTEXT_CASE_SQL}
      FROM result_set rs
      JOIN current_event_records f ON f.id = rs.id${joins}
${PARENT_ROOT_JOINS_SQL}
      ORDER BY ${opts.orderBy}`;
}

/**
 * Aggregate classification rows into a keyed object in TypeScript.
 * Replaces PostgreSQL jsonb_object_agg with in-memory aggregation.
 */
function aggregateClassifications(
  rows: Array<{
    id: number;
    classifier_attribute_key: string | null;
    classifier_values: any;
    classifier_confidences: any;
    classifier_source: string | null;
    classifier_is_manual: boolean | null;
    [key: string]: any;
  }>
): Map<number, Record<string, any>> {
  const map = new Map<number, Record<string, any>>();
  for (const row of rows) {
    if (!row.classifier_attribute_key || row.classifier_values == null) continue;
    let obj = map.get(row.id);
    if (!obj) {
      obj = {};
      map.set(row.id, obj);
    }
    obj[row.classifier_attribute_key] = {
      values: row.classifier_values,
      confidences: row.classifier_confidences,
      source: row.classifier_source,
      is_manual: row.classifier_is_manual,
    };
  }
  return map;
}

export function deduplicateWithClassifications(rawRows: any[]): ContentSearchResult[] {
  const classificationsMap = aggregateClassifications(rawRows);
  const seenIds = new Set<number>();
  const results: ContentSearchResult[] = [];
  for (const row of rawRows) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    results.push({
      ...row,
      classifications: classificationsMap.get(row.id) ?? {},
      classifier_attribute_key: undefined,
      classifier_values: undefined,
      classifier_confidences: undefined,
      classifier_source: undefined,
      classifier_is_manual: undefined,
    } as any as ContentSearchResult);
  }
  return results;
}
