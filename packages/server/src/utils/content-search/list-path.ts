/**
 * Content listing path: executeListQuery and listContentInternal.
 */

import { type DbClient, pgTextArray } from '../../db/client';
import {
  buildConnectionFilter,
  buildFeedFilter,
  buildOrderByClause,
  buildRunFilter,
  groupClassificationFilters,
} from '../content-query-filters';
import { parseDateAlias, toEndOfDay } from '../date-aliases';
import { validateNumericId } from '../sql-validation';
import {
  buildClassificationExistsClauses,
  resolveClassifierIds,
} from './classification';
import { buildLatestClassificationsCteSql, buildThreadMetaCteSql } from './ctes';
import { buildEntityLinkUnion, entityLinkMatchSql, fetchEntityIdentityScopes } from './entity-link';
import type { EntityIdentityScope } from './entity-link';
import {
  INTERNAL_OPS_EXCLUSION_SQL,
  buildFinalSelect,
  deduplicateWithClassifications,
} from './sql-fragments';
import {
  buildDateCandidateOrderBy,
  buildDateCursorClause,
  buildFutureOccurredAtClause,
  buildPageInfo,
  emptyListResponse,
  isDateFeedMode,
  resolveDateCursor,
  type ContentSearchOptions,
  type ContentSearchResponse,
  type ContentSearchResult,
} from './types';
import { buildEntityTypesFilterClause } from './entity-types-filter';
import {
  buildAnalyzedByAutomationClause,
  buildConnectionVisibilityClause,
  buildExcludeAutomationClause,
  buildOrgScopeWhere,
  buildProducedByAutomationClause,
} from './visibility';
import {
  buildSemanticTypeFilterSql,
  buildStandardParams,
  buildStandardWhereSql,
  RUN_JOIN_SQL,
} from './params';

/**
 * Shared count + query-pair execution for both `listContentInternal` branches.
 *
 * The two branches differ only in how they assemble `whereExpr` (the full
 * WHERE body, excluding the date cursor clause) and whether they need the
 * `automation_run_events` join (`joinSql`). Everything past the count — the
 * empty-result short-circuit, the `candidate_set/result_set` vs `result_set`
 * CTE pair, param indexing, dedup, and the response shape — is identical, so
 * it lives here. The generated SQL and parameter binding are unchanged.
 */
async function executeListQuery(args: {
  sql: DbClient;
  joinSql: string;
  whereExpr: string;
  countParams: any[];
  entityId: number | null;
  threadEntityLinkSqlForP: string | undefined;
  needClassifications: boolean;
  useDateFeed: boolean;
  cursor: ReturnType<typeof resolveDateCursor>;
  orderByForResultSet: string;
  latestClassificationsCteSql: string;
  mkFinalSelect: (withClassifications: boolean) => string;
  limit: number;
  effectiveOffset: number;
  fetchLimit: number;
}): Promise<ContentSearchResponse> {
  const { sql, joinSql, whereExpr, countParams } = args;

  const countSql = `SELECT COUNT(*) as total FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${joinSql}
      WHERE ${whereExpr}`;

  const cursorClause = buildDateCursorClause(
    args.cursor,
    'COALESCE(f.occurred_at, f.created_at)',
    'f.id',
    countParams.length + 1
  );
  const queryBaseParams = [...countParams, ...cursorClause.params];
  const limitIdx = queryBaseParams.length + 1;
  const offsetIdx = queryBaseParams.length + 2;
  const validatedLimit = validateNumericId(args.limit, 'limit');
  const threadMetaCteSql = buildThreadMetaCteSql('$1', 'result_set', args.threadEntityLinkSqlForP);
  const ctes = args.needClassifications
    ? `${threadMetaCteSql},\n      ${args.latestClassificationsCteSql}`
    : threadMetaCteSql;

  const querySQL = args.useDateFeed
    ? `
      WITH RECURSIVE candidate_set AS (
        SELECT
          f.id,
          f.occurred_at,
          f.created_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${joinSql}
        WHERE ${whereExpr}
          ${cursorClause.sql}
        ORDER BY ${buildDateCandidateOrderBy(args.cursor, 'f')}
        LIMIT $${limitIdx}
      ),
      result_set AS (
        SELECT
          cs.id,
          cs.occurred_at,
          cs.created_at,
          (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
        FROM candidate_set cs
        ORDER BY ${buildDateCandidateOrderBy(args.cursor, 'cs')}
        LIMIT ${validatedLimit}
      ),
      ${ctes}
      ${args.mkFinalSelect(args.needClassifications)}`
    : `
      WITH RECURSIVE result_set AS (
        SELECT
          f.id,
          NULL::bigint as cursor_fetched_count
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${joinSql}
        WHERE ${whereExpr}
        ORDER BY ${args.orderByForResultSet}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      ),
      ${ctes}
      ${args.mkFinalSelect(args.needClassifications)}`;

  const queryParams = args.useDateFeed
    ? [...queryBaseParams, args.fetchLimit]
    : [...queryBaseParams, args.limit, args.effectiveOffset];

  let total: number;
  let rawRows: any[];

  if (args.entityId == null) {
    // Org-wide listing (the activity feed). The COUNT is one of the two
    // expensive scans here — it re-evaluates the full visibility predicate
    // across every live event — so run count + list in parallel instead of
    // serializing two full scans. The total stays exact on every page
    // (cursor pages included): ContentSearchResponse.total is part of the
    // read_knowledge contract and callers rely on it.
    const [countResult, rows] = await Promise.all([
      sql.unsafe<{ total: number | string }>(countSql, countParams),
      args.sql.unsafe(querySQL, queryParams) as Promise<any[]>,
    ]);
    total = parseInt(String(countResult[0]?.total ?? '0'), 10);
    rawRows = rows;
    if (total === 0 && rawRows.length === 0) {
      return emptyListResponse({
        limit: args.limit,
        effectiveOffset: args.effectiveOffset,
        useDateFeed: args.useDateFeed,
        cursor: args.cursor,
      });
    }
  } else {
    // Entity-scoped listing: count FIRST so empty matches short-circuit before
    // paying the enrichment planner cost — recursive thread_meta +
    // classifications + parent/root LEFT JOINs cost real planning time on a
    // large events table even when result_set is empty server-side. Entities
    // can legitimately have zero content, and callers rely on exact totals
    // across cursor pages, so keep both semantics here.
    const countResult = await sql.unsafe<{ total: number | string }>(countSql, countParams);
    total = parseInt(String(countResult[0]?.total ?? '0'), 10);
    if (total === 0) {
      return emptyListResponse({
        limit: args.limit,
        effectiveOffset: args.effectiveOffset,
        useDateFeed: args.useDateFeed,
        cursor: args.cursor,
      });
    }
    rawRows = (await args.sql.unsafe(querySQL, queryParams)) as any[];
  }

  const content = args.needClassifications
    ? deduplicateWithClassifications(rawRows)
    : (rawRows as any as ContentSearchResult[]);

  return {
    content,
    total,
    page: buildPageInfo({
      limit: args.limit,
      offset: args.effectiveOffset,
      total,
      returnedCount: content.length,
      useDateFeed: args.useDateFeed,
      cursor: args.cursor,
      fetchedCount: rawRows[0]?.cursor_fetched_count,
    }),
  };
}

export async function listContentInternal(
  sql: DbClient,
  options: ContentSearchOptions & { offset?: number },
  limit: number,
  offset: number
): Promise<ContentSearchResponse> {
  const entityId = options.entity_id;
  const organizationId = options.organization_id;
  const useDateFeed = isDateFeedMode(options);
  const cursor = resolveDateCursor(options);
  const effectiveOffset = useDateFeed ? 0 : offset;
  const fetchLimit = useDateFeed ? limit + 1 : limit;

  const sinceDate = options.since ? parseDateAlias(options.since).date : null;
  const untilDate = options.until ? toEndOfDay(parseDateAlias(options.until).date) : null;
  const futureClause = buildFutureOccurredAtClause(untilDate, cursor);
  const connectionIdsArray =
    options.connection_ids && options.connection_ids.length > 0 ? options.connection_ids : null;
  const feedIdsArray =
    options.feed_ids && options.feed_ids.length > 0 ? options.feed_ids : null;
  const runIdsArray =
    options.run_ids && options.run_ids.length > 0 ? options.run_ids : null;

  const orderByForResultSet = buildOrderByClause(
    options.sort_by,
    options.sort_order,
    'f',
    'result_set'
  );
  const orderByForFinalSelect = buildOrderByClause(
    options.sort_by,
    options.sort_order,
    'rs',
    'final_select'
  );

  const needClassifications = !!(
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0)
  );

  const classificationFilters = options.classification_filters ?? [];
  const hasClassificationFilters = classificationFilters.length > 0;
  const filtersBySlug = hasClassificationFilters
    ? groupClassificationFilters(classificationFilters)
    : null;

  // Pre-fetch the entity's identity claims so the entity-link UNION only
  // emits branches for namespaces this entity actually has. For an entity
  // with 0 identities (~17% of the rows in real data) the legacy
  // 7-branch UNION takes ~1s on a 4.7GB events table even though every
  // branch returns 0 rows; the trimmed UNION takes ~200ms.
  const entityScopes: EntityIdentityScope[] =
    entityId != null ? await fetchEntityIdentityScopes(sql, entityId) : [];
  const latestClassificationsCteSql = buildLatestClassificationsCteSql();

  const listExtraColumns =
    'NULL as similarity, NULL as text_rank, 0 as combined_score, rs.cursor_fetched_count';
  const mkFinalSelect = (withClassifications: boolean) =>
    buildFinalSelect({
      withClassifications,
      extraColumns: listExtraColumns,
      orderBy: orderByForFinalSelect,
    });

  if (hasClassificationFilters && filtersBySlug) {
    const classifierIds = await resolveClassifierIds(sql, filtersBySlug, entityId);
    const connectionFilterClause = buildConnectionFilter(connectionIdsArray);
    const feedFilterClause = buildFeedFilter(feedIdsArray);
    const runFilterClause = buildRunFilter(runIdsArray);

    const baseConditions: string[] = [];
    const baseParams: any[] = [];

    // Pre-built entity-link fragment for thread_meta's recursive walk.
    // When entity_id is set we use the trimmed UNION; otherwise threadMeta
    // doesn't need an entity filter (org-wide listings already constrain
    // candidates upstream).
    let threadEntityLinkSql: string | undefined;
    if (entityId != null) {
      // Inline the entity id as a literal so the planner picks the
      // entity-specific GIN scan instead of building a generic plan that
      // ignores selectivity. The id is already a number from the typed
      // option; we further validate via validateNumericId below before
      // passing to buildEntityLinkUnion.
      const validatedId = validateNumericId(entityId, 'entity_id');
      const link = buildEntityLinkUnion({
        entityIdLiteral: validatedId,
        scopes: entityScopes,
        alias: 'f',
        baseParamIndex: baseParams.length + 1,
      });
      baseConditions.push(link.sql);
      baseParams.push(...link.params);
      // Same shape, alias `p`, for thread_meta's recursive parent walk.
      threadEntityLinkSql = buildEntityLinkUnion({
        entityIdLiteral: validatedId,
        scopes: entityScopes,
        alias: 'p',
        // params don't need fresh slots — they're the same identifier values
        // emitted by the outer `link` already in baseParams. We re-bind them
        // by reusing the same $N slots.
        baseParamIndex: baseParams.length - link.params.length + 1,
      }).sql;
    } else if (organizationId) {
      // Keep classification-filtered listings on the same direct/entity/
      // connection org scope as the standard listing path.
      const orgScope = buildOrgScopeWhere({
        organization_id: organizationId,
        baseParamIndex: baseParams.length + 1,
      });
      baseConditions.push(orgScope.sql.replace(/^AND\s+/, ''));
      baseParams.push(...orgScope.params);
      // Avoid treating the organization id in $1 as a bigint entity id while
      // walking parent threads.
      threadEntityLinkSql = 'TRUE';
    }

    baseConditions.push(connectionFilterClause);
    baseConditions.push(feedFilterClause);
    baseConditions.push(runFilterClause);

    if (options.platform) {
      baseParams.push(options.platform);
      baseConditions.push(`f.connector_key = $${baseParams.length}`);
    }
    if (sinceDate) {
      baseParams.push(sinceDate.toISOString());
      baseConditions.push(`f.occurred_at >= $${baseParams.length}`);
    }
    if (untilDate) {
      baseParams.push(untilDate.toISOString());
      baseConditions.push(`f.occurred_at <= $${baseParams.length}`);
    }
    if (options.run_id != null) {
      baseParams.push(options.run_id);
      baseConditions.push(
        `EXISTS (SELECT 1 FROM automation_run_events iwf WHERE iwf.event_id = f.id AND iwf.run_id = $${baseParams.length})`
      );
    }
    if (options.engagement_min != null) {
      baseParams.push(options.engagement_min);
      baseConditions.push(`f.score >= $${baseParams.length}`);
    }
    if (options.engagement_max != null) {
      baseParams.push(options.engagement_max);
      baseConditions.push(`f.score <= $${baseParams.length}`);
    }
    if (options.semantic_type) {
      // Match any of the requested types — single-string callers get wrapped
      // into a one-element Postgres array literal so the same predicate fits.
      const types = Array.isArray(options.semantic_type)
        ? options.semantic_type
        : [options.semantic_type];
      baseParams.push(pgTextArray(types));
      baseConditions.push(buildSemanticTypeFilterSql('f', `$${baseParams.length}`));
    }
    if (options.exclude_workspace_audit) {
      baseConditions.push(`NOT (f.metadata ? '_lobu_workspace_audit')`);
    }
    // Internal-ops filter, same rule as the search path and the standard
    // branch below. Recall does not reach this classification-filtered branch
    // today (fetchContentSnippets sends no classification_filters), but the
    // option is a contract on ContentSearchOptions, and exclude_workspace_audit
    // above is likewise applied on every builder. An explicit semantic_type
    // filter still wins, as in search-path.ts.
    if (options.exclude_internal_ops && !options.semantic_type) {
      baseConditions.push(INTERNAL_OPS_EXCLUSION_SQL);
    }
    if (options.interaction_status) {
      baseParams.push(options.interaction_status);
      baseConditions.push(`f.interaction_status = $${baseParams.length}`);
    }
    if (options.agent_id) {
      baseParams.push(options.agent_id);
      baseConditions.push(`f.metadata->>'agent_id' = $${baseParams.length}`);
    }
    if (options.client_id) {
      // `events.client_id` is a real indexed column (idx_events_client_id), not
      // a metadata field — so this is a plain column predicate. Always ANY() so
      // one id and a re-registered client's many ids share a single shape.
      const clientIds = Array.isArray(options.client_id)
        ? options.client_id
        : [options.client_id];
      baseParams.push(pgTextArray(clientIds));
      baseConditions.push(`f.client_id = ANY($${baseParams.length}::text[])`);
    }
    if (options.mcp_session_ids !== undefined) {
      baseParams.push(pgTextArray(options.mcp_session_ids));
      baseConditions.push(
        `f.metadata->>'mcp_session_id' = ANY($${baseParams.length}::text[])`
      );
    }

    const classificationExists = buildClassificationExistsClauses(
      filtersBySlug,
      classifierIds,
      options.classification_source,
      baseParams.length + 1
    );
    if (!classificationExists) {
      return emptyListResponse({ limit, effectiveOffset, useDateFeed, cursor });
    }

    baseConditions.push(...classificationExists.clauses);
    const whereSql = baseConditions.length > 0 ? baseConditions.join(' AND ') : '1=1';
    const filterParamsBeforeExclude = [...baseParams, ...classificationExists.params];
    const excludeClause = buildExcludeAutomationClause(
      options.exclude_automation_id,
      filterParamsBeforeExclude.length + 1
    );
    const paramsBeforeProduced = [...filterParamsBeforeExclude, ...excludeClause.params];
    const producedClause = buildProducedByAutomationClause(
      options.produced_by_automation_id,
      paramsBeforeProduced.length + 1
    );
    const paramsBeforeAnalyzed = [...paramsBeforeProduced, ...producedClause.params];
    const analyzedClause = buildAnalyzedByAutomationClause(
      options.analyzed_by_automation_id,
      paramsBeforeAnalyzed.length + 1
    );
    const filterParamsBeforeVisibility = [...paramsBeforeAnalyzed, ...analyzedClause.params];
    const visibilityClause = buildConnectionVisibilityClause({
      organizationId: options.visibility_scope?.organizationId,
      userId: options.visibility_scope?.userId ?? null,
      baseParamIndex: filterParamsBeforeVisibility.length + 1,
    });
    const filterParamsBeforeEntityTypes = [
      ...filterParamsBeforeVisibility,
      ...visibilityClause.params,
    ];
    const entityTypesClause = buildEntityTypesFilterClause({
      entity_types: options.entity_types,
      organization_id: organizationId,
      baseParamIndex: filterParamsBeforeEntityTypes.length + 1,
    });
    const allFilterParams = [...filterParamsBeforeEntityTypes, ...entityTypesClause.params];

    return executeListQuery({
      sql,
      joinSql: '',
      whereExpr: `${whereSql} ${excludeClause.sql}${producedClause.sql}${analyzedClause.sql} ${visibilityClause.sql}${entityTypesClause.sql} ${futureClause.sql}`,
      countParams: allFilterParams,
      entityId: entityId ?? null,
      threadEntityLinkSqlForP: threadEntityLinkSql,
      needClassifications,
      useDateFeed,
      cursor,
      orderByForResultSet,
      latestClassificationsCteSql,
      mkFinalSelect,
      limit,
      effectiveOffset,
      fetchLimit,
    });
  }

  const connectionCondition = buildConnectionFilter(connectionIdsArray);
  const feedCondition = buildFeedFilter(feedIdsArray);
  const runCondition = buildRunFilter(runIdsArray);
  const standardParams = buildStandardParams(options, { sinceDate, untilDate });

  // Build the entity-link UNION fragment once so both list and count emit
  // identical SQL — same shape as before but with namespaces trimmed to the
  // entity's actual identities. Params slot right after the fixed $1-$13
  // standardParams block.
  let standardEntityLinkSql: string;
  let standardEntityLinkParams: string[] = [];
  let standardEntityLinkSqlForP: string | undefined;
  if (entityId != null) {
    const validatedId = validateNumericId(entityId, 'entity_id');
    const link = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: entityScopes,
      alias: 'f',
      baseParamIndex: standardParams.length + 1,
    });
    standardEntityLinkSql = link.sql;
    standardEntityLinkParams = link.params;
    // thread_meta walks parents (alias `p`); reuse the same param slots so
    // the params array doesn't grow.
    standardEntityLinkSqlForP = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: entityScopes,
      alias: 'p',
      baseParamIndex: standardParams.length + 1,
    }).sql;
  } else {
    // Org-wide / no-entity path keeps the legacy 7-branch UNION because the
    // outer `($1::bigint IS NULL OR …)` short-circuits to true and the SQL
    // is never evaluated. Cheap.
    standardEntityLinkSql = entityLinkMatchSql('$1::bigint');
  }
  const standardWhereSql = buildStandardWhereSql(standardEntityLinkSql);

  const paramsAfterEntityLink = [...standardParams, ...standardEntityLinkParams];
  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: organizationId,
    baseParamIndex: paramsAfterEntityLink.length + 1,
  });
  const paramsBeforeExclude = [...paramsAfterEntityLink, ...orgScope.params];
  const excludeClause = buildExcludeAutomationClause(
    options.exclude_automation_id,
    paramsBeforeExclude.length + 1
  );
  const paramsBeforeProducedFilter = [...paramsBeforeExclude, ...excludeClause.params];
  const producedFilterClause = buildProducedByAutomationClause(
    options.produced_by_automation_id,
    paramsBeforeProducedFilter.length + 1
  );
  const paramsBeforeAnalyzedFilter = [
    ...paramsBeforeProducedFilter,
    ...producedFilterClause.params,
  ];
  const analyzedFilterClause = buildAnalyzedByAutomationClause(
    options.analyzed_by_automation_id,
    paramsBeforeAnalyzedFilter.length + 1
  );
  const paramsBeforeVisibility = [...paramsBeforeAnalyzedFilter, ...analyzedFilterClause.params];
  const visibilityClause = buildConnectionVisibilityClause({
    organizationId: options.visibility_scope?.organizationId,
    userId: options.visibility_scope?.userId ?? null,
    baseParamIndex: paramsBeforeVisibility.length + 1,
  });
  const paramsBeforeEntityTypes = [...paramsBeforeVisibility, ...visibilityClause.params];
  const entityTypesClause = buildEntityTypesFilterClause({
    entity_types: options.entity_types,
    organization_id: organizationId,
    baseParamIndex: paramsBeforeEntityTypes.length + 1,
  });
  const countParams = [...paramsBeforeEntityTypes, ...entityTypesClause.params];

  return executeListQuery({
    sql,
    joinSql: RUN_JOIN_SQL,
    entityId: entityId ?? null,
    whereExpr: `${standardWhereSql}
          AND ${connectionCondition}
          AND ${feedCondition}
          AND ${runCondition}
          ${options.exclude_workspace_audit ? `AND NOT (f.metadata ? '_lobu_workspace_audit')` : ''}
          ${
            // Internal-ops filter. Recall lands here, not on the search path,
            // whenever its query is shorter than three characters and no
            // embedding was supplied — `search_memory({ query: 'Q3' })` on a
            // workspace-scoped connection is the live case (searchContentByText
            // routes on that length). Without this, the rows the search path
            // hides come straight back through the other door. See the comment
            // on the sibling site above.
            options.exclude_internal_ops && !options.semantic_type
              ? `AND ${INTERNAL_OPS_EXCLUSION_SQL}`
              : ''
          }
          ${excludeClause.sql}
          ${producedFilterClause.sql}
          ${analyzedFilterClause.sql}
          ${visibilityClause.sql}
          ${orgScope.sql}${entityTypesClause.sql} ${futureClause.sql}`,
    countParams,
    threadEntityLinkSqlForP: standardEntityLinkSqlForP,
    needClassifications,
    useDateFeed,
    cursor,
    orderByForResultSet,
    latestClassificationsCteSql,
    mkFinalSelect,
    limit,
    effectiveOffset,
    fetchLimit,
  });
}
