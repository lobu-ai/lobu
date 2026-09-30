/**
 * CTE SQL builder helpers:
 * buildThreadMetaCteSql, buildLatestClassificationsCteSql.
 */

import { buildClassificationOrderSql } from './classification';
import { entityLinkMatchSql } from './entity-link';

export function buildThreadMetaCteSql(
  entityIdParam: string,
  resultSetAlias = 'result_set',
  entityLinkSql?: string
): string {
  // Pre-built scope-aware fragment beats the legacy 7-branch UNION when the
  // caller has already pre-fetched scopes; fall back to the legacy form for
  // call sites that haven't been migrated yet.
  //
  // When `entityLinkSql` is provided, the caller has already inlined the
  // entity id (so there's no `$N IS NULL` guard needed). When it isn't
  // provided, we keep the legacy `(${entityIdParam} IS NULL OR …)` shape so
  // org-wide callers can pass `$1` and have it dynamically null-checked.
  const usePrebuilt = entityLinkSql !== undefined;
  const linkSql = entityLinkSql ?? entityLinkMatchSql(`${entityIdParam}::bigint`, 'p');
  const entityFilter = usePrebuilt ? linkSql : `(${entityIdParam} IS NULL OR ${linkSql})`;
  return `
    thread_chain AS (
      SELECT
        rs.id as content_id,
        f.connection_id,
        f.origin_id,
        f.origin_parent_id,
        f.origin_id as root_origin_id,
        0 as depth,
        ARRAY[COALESCE(f.origin_id, CAST(f.id AS VARCHAR))] as path
      FROM ${resultSetAlias} rs
      JOIN current_event_records f ON f.id = rs.id

      UNION ALL

      SELECT
        tc.content_id,
        p.connection_id,
        p.origin_id,
        p.origin_parent_id,
        p.origin_id as root_origin_id,
        tc.depth + 1,
        array_append(tc.path, COALESCE(p.origin_id, CAST(p.id AS VARCHAR)))
      FROM thread_chain tc
      JOIN current_event_records p
        ON p.connection_id = tc.connection_id
       AND p.origin_id = tc.origin_parent_id
      WHERE tc.connection_id IS NOT NULL
        AND tc.origin_parent_id IS NOT NULL
        AND tc.depth < 25
        AND ${entityFilter}
        AND NOT (COALESCE(p.origin_id, CAST(p.id AS VARCHAR)) = ANY(tc.path))
    ),
    thread_meta AS (
      SELECT * FROM (
        SELECT
          content_id,
          root_origin_id,
          depth,
          ROW_NUMBER() OVER (PARTITION BY content_id ORDER BY depth DESC) as rn
        FROM thread_chain
      ) sub WHERE rn = 1
    )
  `;
}

export function buildLatestClassificationsCteSql(resultSetAlias = 'result_set'): string {
  return `
    latest_classifications AS (
      SELECT * FROM (
        -- P4: dedup per (event, stable classifier_id) directly off event_classifications. The old
        -- version-ordering (ccv.is_current/version) is redundant — each classifier is one current
        -- config and old-version rows are purged on switch — so source priority + created_at picks
        -- the same row without the event_classifier_versions JOIN.
        SELECT
          cc.event_id,
          cc.classifier_id,
          cc."values",
          cc.confidences,
          cc.source,
          cc.is_manual,
          ROW_NUMBER() OVER (
            PARTITION BY cc.event_id, cc.classifier_id
            ORDER BY ${buildClassificationOrderSql('cc')}
          ) as rn
        FROM event_classifications cc
        JOIN ${resultSetAlias} rs ON rs.id = cc.event_id
        WHERE cc.classifier_id IS NOT NULL
      ) sub WHERE rn = 1
    )
  `;
}
