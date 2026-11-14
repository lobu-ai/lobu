/**
 * Content listing path: executeListQuery and listContentInternal.
 */

import { buildEventResourceFilterClause } from './resource-filter';
import { type DbClient } from '../../db/client';
import { boundedQuery } from '../bounded-read';
import { CONTENT_READ_STATEMENT_TIMEOUT_MS } from '../content-read-bounds';
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
  RECALL_BOOKKEEPING_EXCLUSION_SQL,
  INTERNAL_OPS_EXCLUSION_SQL,
  buildFinalSelect,
  deduplicateWithClassifications,
  operationalTrailExclusionSql,
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
  type OrgScopeWhere,
} from './visibility';
import {
  appendStandardEventFilters,
  buildStandardParams,
  buildEffectiveAtRangeSql,
  buildStandardWhereSql,
  RUN_JOIN_SQL,
} from './params';

/**
 * Shared count + query-pair execution for both `listContentInternal` branches.
 *
 * The two branches differ only in how they assemble `whereExpr` (the full
 * WHERE body, excluding the org scope and the date cursor clause) and whether
 * they need the `automation_run_events` join (`joinSql`). Everything past
 * that — the count, the empty-result short-circuit, the
 * `candidate_set/result_set` vs `result_set` CTE pair, param indexing, dedup,
 * and the response shape — is identical, so it lives here.
 *
 * `orgScope` stays separate from `whereExpr` so an org-wide read can restate
 * its date bounds on the indexed recency key next to the organization
 * predicate (`orgWideRangeSql`).
 */
async function executeListQuery(args: {
  sql: DbClient;
  joinSql: string;
  whereExpr: string;
  orgScope: OrgScopeWhere;
  /** Redundant since/until bound on the indexed recency key; org-wide reads only. */
  orgWideRangeSql: string;
  countParams: any[];
  entityId: number | null;
  threadEntityLinkSqlForP: string | undefined;
  needClassifications: boolean;
  useDateFeed: boolean;
  cursor: ReturnType<typeof resolveDateCursor>;
  orderByForResultSet: string;
  orderByForProbe: string;
  latestClassificationsCteSql: string;
  mkFinalSelect: (withClassifications: boolean) => string;
  limit: number;
  effectiveOffset: number;
  fetchLimit: number;
  includeTotal: boolean;
  signal?: AbortSignal;
}): Promise<ContentSearchResponse> {
  const { sql, joinSql, countParams, includeTotal } = args;
  // Capped by Postgres and cancelled with the caller (utils/bounded-read.ts).
  const read = (text: string, params: unknown[], signal = args.signal) =>
    boundedQuery(sql, text, params, {
      signal,
      statementTimeoutMs: CONTENT_READ_STATEMENT_TIMEOUT_MS,
    });
  const whereExpr = `${args.whereExpr} ${args.orgScope.sql}`;

  // An org-wide read carries `f.organization_id = $org`; the range bound then
  // becomes an index condition after it on idx_events_live_org_effective_date.
  // Entity-scoped reads are narrowed by the entity link instead.
  const orgWide = args.entityId == null && args.orgScope.sql !== '';
  const orgWideRangeSql = orgWide ? args.orgWideRangeSql : '';
  const countSql = `SELECT COUNT(*) as total FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${joinSql}
      WHERE ${whereExpr} ${orgWideRangeSql}`;

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

  const emptyResponse = () =>
    emptyListResponse({
      limit: args.limit,
      effectiveOffset: args.effectiveOffset,
      useDateFeed: args.useDateFeed,
      cursor: args.cursor,
      includeTotal,
    });

  let querySQL: string;
  if (args.useDateFeed) {
    const candidateSetSql = buildDateCandidateSetSql({
      joinSql,
      whereExpr,
      cursorSql: cursorClause.sql,
      rangeSql: orgWide ? `${cursorClause.rangeSql} ${orgWideRangeSql}` : '',
      cursor: args.cursor,
      limitParam: `$${limitIdx}`,
    });
    querySQL = `
      WITH RECURSIVE candidate_set AS (
        ${candidateSetSql}
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
      ${args.mkFinalSelect(args.needClassifications)}`;
  } else if (includeTotal) {
    querySQL = `
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
  } else {
    // No total to compare the offset against: overfetch one id (limitIdx binds
    // limit + 1 below) and trim it before enrichment. page_probe carries the
    // sort keys so result_set can re-apply the same total order to keep the
    // first `limit` ids; cursor_fetched_count reports whether the sentinel came.
    querySQL = `
      WITH RECURSIVE page_probe AS (
        SELECT
          f.id,
          f.score,
          f.occurred_at,
          f.created_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${joinSql}
        WHERE ${whereExpr}
        ORDER BY ${args.orderByForResultSet}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      ),
      result_set AS (
        SELECT
          pp.id,
          (SELECT COUNT(*) FROM page_probe) as cursor_fetched_count
        FROM page_probe pp
        ORDER BY ${args.orderByForProbe}
        LIMIT ${validatedLimit}
      ),
      ${ctes}
      ${args.mkFinalSelect(args.needClassifications)}`;
  }

  const queryParams = args.useDateFeed
    ? [...queryBaseParams, args.fetchLimit]
    : [...queryBaseParams, includeTotal ? args.limit : args.limit + 1, args.effectiveOffset];

  let total: number | null;
  let rawRows: any[];

  if (!includeTotal) {
    // Opted out of the exact count: one query, and an empty page is simply an
    // empty page. has_more comes from the overfetch, never from a count.
    total = null;
    rawRows = await read(querySQL, queryParams);
    if (rawRows.length === 0) return emptyResponse();
  } else if (args.entityId == null) {
    // Org-wide listing (the activity feed). The exact count still evaluates
    // visibility for all matching events, so run count + list in parallel.
    // The total stays exact on every page (cursor pages included):
    // ContentSearchResponse.total is part of the
    // read_knowledge contract and callers rely on it unless they opt out.
    // Either half failing makes the other useless, so it cancels it.
    const sibling = new AbortController();
    const signal = args.signal ? AbortSignal.any([args.signal, sibling.signal]) : sibling.signal;
    const failFast = <T>(pending: Promise<T>) =>
      pending.catch((error: unknown) => {
        sibling.abort(error);
        throw error;
      });
    const [countResult, rows] = await Promise.all([
      failFast(read(countSql, countParams, signal)),
      failFast(read(querySQL, queryParams, signal)),
    ]);
    total = parseInt(String(countResult[0]?.total ?? '0'), 10);
    rawRows = rows;
    if (total === 0 && rawRows.length === 0) return emptyResponse();
  } else {
    // Entity-scoped listing: count FIRST so empty matches short-circuit before
    // paying the enrichment planner cost — recursive thread_meta +
    // classifications + parent/root LEFT JOINs cost real planning time on a
    // large events table even when result_set is empty server-side. Entities
    // can legitimately have zero content, and callers rely on exact totals
    // across cursor pages, so keep both semantics here.
    const countResult = await read(countSql, countParams);
    total = parseInt(String(countResult[0]?.total ?? '0'), 10);
    if (total === 0) return emptyResponse();
    rawRows = await read(querySQL, queryParams);
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

/**
 * Body of the date feed's `candidate_set` CTE: the newest (or, after an
 * `after` cursor, oldest) `limitParam` matching ids in cursor order.
 *
 * `whereExpr` is the full WHERE body including the org scope. On an org-wide
 * read `f.organization_id = $org` is an index condition on
 * idx_events_live_org_effective_date, which also matches the ORDER BY, so the
 * scan can stop after enough rows pass the remaining filters.
 */
export function buildDateCandidateSetSql(args: {
  joinSql: string;
  whereExpr: string;
  cursorSql: string;
  /**
   * Bounds implied by the filters/cursor, restated on the indexed recency key
   * so they become an index condition after `organization_id`. Empty unless
   * the read is org-wide.
   */
  rangeSql: string;
  cursor: ReturnType<typeof resolveDateCursor>;
  limitParam: string;
}): string {
  return `SELECT
          f.id,
          f.occurred_at,
          f.created_at
        FROM current_event_records f
        LEFT JOIN connections c ON c.id = f.connection_id
        ${args.joinSql}
        WHERE ${args.whereExpr} ${args.rangeSql}
          ${args.cursorSql}
        ORDER BY ${buildDateCandidateOrderBy(args.cursor, 'f')}
        LIMIT ${args.limitParam}`;
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
  const includeTotal = options.include_total !== false;

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
  const orderByForProbe = buildOrderByClause(
    options.sort_by,
    options.sort_order,
    'pp',
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
    const classifierIds = await resolveClassifierIds(sql, filtersBySlug, {
      organizationId,
      entityId,
    });
    const connectionFilterClause = buildConnectionFilter(connectionIdsArray);
    const feedFilterClause = buildFeedFilter(feedIdsArray);
    const runFilterClause = buildRunFilter(runIdsArray);

    const baseConditions: string[] = [];
    const baseParams: any[] = [];
    let orgScope: OrgScopeWhere = { sql: '', params: [] };

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
      // The predicate itself is handed to executeListQuery structurally (see
      // `orgScope` there); only its params take their slot here.
      orgScope = buildOrgScopeWhere({
        organization_id: organizationId,
        baseParamIndex: baseParams.length + 1,
      });
      baseParams.push(...orgScope.params);
      // Avoid treating the organization id in $1 as a bigint entity id while
      // walking parent threads.
      threadEntityLinkSql = 'TRUE';
    }

    baseConditions.push(connectionFilterClause);
    baseConditions.push(feedFilterClause);
    baseConditions.push(runFilterClause);

    const { sinceParam, untilParam } = appendStandardEventFilters(
      baseConditions,
      baseParams,
      {
        platform: options.platform,
        sinceDate,
        untilDate,
        run_id: options.run_id,
        engagement_min: options.engagement_min,
        engagement_max: options.engagement_max,
        semantic_type: options.semantic_type,
        event_category: options.event_category,
        resource_kind: options.resource_kind,
        resource_id: options.resource_id,
        interaction_status: options.interaction_status,
        agent_id: options.agent_id,
        client_id: options.client_id,
        mcp_session_ids: options.mcp_session_ids,
        exclude_workspace_audit: options.exclude_workspace_audit,
        exclude_operational_trail: options.exclude_operational_trail,
        exclude_internal_ops: options.exclude_internal_ops,
        exclude_recall_bookkeeping: options.exclude_recall_bookkeeping,
      }
    );

    const classificationExists = buildClassificationExistsClauses(
      filtersBySlug,
      classifierIds,
      options.classification_source,
      baseParams.length + 1
    );
    if (!classificationExists) {
      return emptyListResponse({ limit, effectiveOffset, useDateFeed, cursor, includeTotal });
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
      orgScope,
      orgWideRangeSql: buildEffectiveAtRangeSql(sinceParam, untilParam),
      countParams: allFilterParams,
      entityId: entityId ?? null,
      threadEntityLinkSqlForP: threadEntityLinkSql,
      needClassifications,
      useDateFeed,
      cursor,
      orderByForResultSet,
      orderByForProbe,
      latestClassificationsCteSql,
      mkFinalSelect,
      limit,
      effectiveOffset,
      fetchLimit,
      includeTotal,
      signal: options.signal,
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
  const standardWhereSql = buildStandardWhereSql(standardEntityLinkSql, {
    entityScoped: entityId != null,
  });

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
  const resourceClause = buildEventResourceFilterClause(options, countParams.length + 1);
  countParams.push(...resourceClause.params);

  return executeListQuery({
    sql,
    joinSql: RUN_JOIN_SQL,
    entityId: entityId ?? null,
    whereExpr: `${standardWhereSql}
          AND ${connectionCondition}
          AND ${feedCondition}
          AND ${runCondition}
          ${options.exclude_workspace_audit ? `AND NOT (f.metadata ? '_lobu_workspace_audit')` : ''}
          ${options.exclude_operational_trail ? `AND ${operationalTrailExclusionSql('f')}` : ''}
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
          ${
            options.exclude_recall_bookkeeping && !options.semantic_type
              ? `AND ${RECALL_BOOKKEEPING_EXCLUSION_SQL}`
              : ''
          }
          ${excludeClause.sql}
          ${producedFilterClause.sql}
          ${analyzedFilterClause.sql}
          ${visibilityClause.sql}
          ${entityTypesClause.sql} ${resourceClause.sql} ${futureClause.sql}`,
    orgScope,
    // $3/$4 are buildStandardParams' since/until slots.
    orgWideRangeSql: buildEffectiveAtRangeSql('$3::timestamptz', '$4::timestamptz'),
    countParams,
    threadEntityLinkSqlForP: standardEntityLinkSqlForP,
    needClassifications,
    useDateFeed,
    cursor,
    orderByForResultSet,
    orderByForProbe,
    latestClassificationsCteSql,
    mkFinalSelect,
    limit,
    effectiveOffset,
    fetchLimit,
    includeTotal,
    signal: options.signal,
  });
}
