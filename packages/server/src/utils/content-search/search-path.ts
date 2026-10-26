/**
 * Content search path: searchContentBySingleQuery.
 */

import postgres from 'postgres';
import { buildEventResourceFilterClause } from './resource-filter';
import type { Env } from '../../index';
import { type DbClient, pgTextArray } from '../../db/client';
import { incrementCounter } from '../../gateway/metrics/prometheus';
import { boundedQuery, boundedRead, cancellable } from '../bounded-read';
import { CONTENT_READ_STATEMENT_TIMEOUT_MS } from '../content-read-bounds';
import {
  buildConnectionFilter,
  buildFeedFilter,
  buildOrderByClause,
  buildRunFilter,
  groupClassificationFilters,
} from '../content-query-filters';
import { parseDateAlias, toEndOfDay } from '../date-aliases';
import {
  embeddingModelSqlLiteral,
  generateQueryEmbedding,
  resolveEmbeddingModel,
} from '../embeddings';
import { toVectorLiteral } from '../entity-management';
import logger from '../logger';
import { validateNumericId } from '../sql-validation';
import {
  buildClassificationExistsClauses,
  buildSourceOnlyExistsClause,
  resolveClassifierIds,
} from './classification';
import { buildLatestClassificationsCteSql, buildThreadMetaCteSql } from './ctes';
import { buildEntityLinkUnion, entityLinkMatchSql, fetchEntityIdentityScopes } from './entity-link';
import {
  CANDIDATE_IVFFLAT_PROBES,
  CANDIDATE_QUERY_TIMEOUT_MS,
  CANDIDATE_VECTOR_LIMIT,
  COLLAPSE_POOL_FACTOR,
  COLLAPSE_POOL_MAX,
  TSQUERY_SQL,
  buildSearchDocumentExpr,
  buildTsqueryString,
} from './fts';
import {
  INTERNAL_OPS_EXCLUSION_SQL,
  buildFinalSelect,
  deduplicateWithClassifications,
  operationalTrailExclusionSql,
} from './sql-fragments';
import { buildSemanticTypeFilterSql } from './params';
import {
  buildDateCandidateOrderBy,
  buildDateCursorClause,
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

/**
 * Run a recall query inside its own transaction with the recall budget applied
 * via `SET LOCAL`, cancelled with the caller. Database failures (including
 * their SQLSTATE) propagate so recall can report partial coverage instead of
 * claiming a successful empty search.
 */
export async function runBoundedRecallQuery(
  sql: DbClient,
  querySQL: string,
  queryParams: unknown[],
  signal?: AbortSignal
): Promise<any[]> {
  try {
    return await boundedRead(
      sql,
      { signal, statementTimeoutMs: CANDIDATE_QUERY_TIMEOUT_MS },
      async (tx: DbClient) => {
        await tx.unsafe(`SET LOCAL ivfflat.probes = ${CANDIDATE_IVFFLAT_PROBES}`);
        await tx.unsafe('SET LOCAL ivfflat.iterative_scan = off');
        return await cancellable(tx.unsafe(querySQL, queryParams), signal);
      }
    );
  } catch (error) {
    // A caller that left is not a recall failure.
    if (signal?.aborted) throw error;
    incrementCounter('lobu_recall_query_failures_total', {
      sqlstate: error instanceof postgres.PostgresError ? error.code : 'unknown',
    });
    throw error;
  }
}

export async function searchContentBySingleQuery(
  sql: DbClient,
  queryText: string,
  options: ContentSearchOptions & { offset?: number },
  env?: Env
): Promise<ContentSearchResponse> {
  const entityId = options.entity_id;
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const useDateFeed = isDateFeedMode(options);
  const cursor = resolveDateCursor(options);
  const effectiveOffset = useDateFeed ? 0 : offset;
  const fetchLimit = useDateFeed ? limit + 1 : limit;
  // Recall (`approximate_candidate_search`) discards `total` and only needs
  // the top snippets, so default it out of the unbounded `full_count` over
  // all workspace events. An explicit `include_total: true` still opts in.
  const includeTotal =
    options.approximate_candidate_search === true
      ? options.include_total === true
      : options.include_total !== false;
  const trimmedQuery = queryText.trim();

  // One resolution for both the query vector and the stored vectors it is ranked
  // against — see `modelScopeFor` below. Resolving per side is how a query
  // embedded by one model comes to be compared against another's rows.
  const embeddingModel = resolveEmbeddingModel();

  let queryEmbedding: number[] | null = options.query_embedding?.length
    ? options.query_embedding
    : null;
  let queryEmbeddingUnavailable = false;
  if (!queryEmbedding && env?.EMBEDDINGS_SERVICE_URL) {
    queryEmbedding = await generateQueryEmbedding(trimmedQuery, env, embeddingModel);
    queryEmbeddingUnavailable = queryEmbedding === null;
  }
  const hasEmbedding = queryEmbedding !== null;
  // Clamp to [0, 1] so a caller can't produce an always-true / always-false
  // predicate with an out-of-range value. Non-numeric input falls back to the
  // default. The parameter is still bound (not interpolated) below for defense
  // in depth.
  const rawMinSimilarity = Number(options.min_similarity ?? 0.3);
  const minSimilarity = Number.isFinite(rawMinSimilarity)
    ? Math.max(0, Math.min(1, rawMinSimilarity))
    : 0.3;

  const sinceDate = options.since ? parseDateAlias(options.since).date : null;
  const untilDate = options.until ? toEndOfDay(parseDateAlias(options.until).date) : null;
  const connectionIdsArray =
    options.connection_ids && options.connection_ids.length > 0 ? options.connection_ids : null;
  const feedIdsArray =
    options.feed_ids && options.feed_ids.length > 0 ? options.feed_ids : null;
  const runIdsArray =
    options.run_ids && options.run_ids.length > 0 ? options.run_ids : null;

  const needClassifications =
    options.include_classifications ||
    (options.classification_filters && options.classification_filters.length > 0);

  const connectionCondition = buildConnectionFilter(connectionIdsArray);
  const feedCondition = buildFeedFilter(feedIdsArray);
  const runCondition = buildRunFilter(runIdsArray);

  // Pre-fetch the entity's identity claims so the entity-link UNION trims
  // unused namespaces. Search path benefits even more than the chronological
  // path because filtered_ids re-evaluates on every query variant attempt.
  const searchEntityScopes =
    entityId != null ? await fetchEntityIdentityScopes(sql, entityId) : [];

  // Slots $11-$13 are the agent, client, and exact MCP-conversation filters —
  // they bump orgScope to $14. Keep this in step with buildStandardParams: the two
  // param lists are positional mirrors, so an added slot shifts BOTH.
  const orgScope = buildOrgScopeWhere({
    entity_id: entityId,
    organization_id: options.organization_id,
    strict_organization_scope: options.strict_organization_scope,
    baseParamIndex: 14,
  });
  // Exclude-automation param slot sits immediately after orgScope so its $N index
  // is stable regardless of whether an embedding param follows.
  const excludeParamIdx = 14 + orgScope.params.length;
  const excludeClause = buildExcludeAutomationClause(
    options.exclude_automation_id,
    excludeParamIdx
  );
  // Same positional discipline as the exclude slot above: this clause claims
  // the next index, and everything after it shifts by its param count.
  const producedParamIdx = excludeParamIdx + excludeClause.params.length;
  const producedClause = buildProducedByAutomationClause(
    options.produced_by_automation_id,
    producedParamIdx
  );
  const analyzedParamIdx = producedParamIdx + producedClause.params.length;
  const analyzedClause = buildAnalyzedByAutomationClause(
    options.analyzed_by_automation_id,
    analyzedParamIdx
  );
  // Connection-visibility predicate. Same helper used by every other
  // get_content branch, so authed/unauthed/private/system-event semantics
  // are guaranteed identical across the search/text-query path and the
  // chronological list path.
  const visibilityParamIdx = analyzedParamIdx + analyzedClause.params.length;
  const visibilityClause = buildConnectionVisibilityClause({
    organizationId: options.visibility_scope?.organizationId,
    userId: options.visibility_scope?.userId ?? null,
    baseParamIndex: visibilityParamIdx,
  });
  const entityTypesParamIdx = visibilityParamIdx + visibilityClause.params.length;
  const entityTypesClause = buildEntityTypesFilterClause({
    entity_types: options.entity_types,
    organization_id: options.organization_id,
    baseParamIndex: entityTypesParamIdx,
  });
  const entityLinkParamIdx = entityTypesParamIdx + entityTypesClause.params.length;
  // Build entity-link UNION (alias `f` for filtered_ids; alias `p` for thread
  // walk). Params slot after visibility, before vector/min_similarity.
  let searchEntityLinkSql: string;
  let searchEntityLinkSqlForP: string | undefined;
  let searchEntityLinkParams: string[] = [];
  if (entityId != null) {
    const validatedId = validateNumericId(entityId, 'entity_id');
    const link = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: searchEntityScopes,
      alias: 'f',
      baseParamIndex: entityLinkParamIdx,
    });
    searchEntityLinkSql = link.sql;
    searchEntityLinkParams = link.params;
    searchEntityLinkSqlForP = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes: searchEntityScopes,
      alias: 'p',
      baseParamIndex: entityLinkParamIdx,
    }).sql;
  } else {
    // Org-wide path keeps the legacy 7-branch UNION; outer NULL check
    // short-circuits when entity_id is absent.
    searchEntityLinkSql = entityLinkMatchSql('$2::bigint');
  }
  const resourceClause = buildEventResourceFilterClause(options, entityLinkParamIdx + searchEntityLinkParams.length);
  const classificationParamIdx = entityLinkParamIdx + searchEntityLinkParams.length + resourceClause.params.length;
  let classificationClause: { sql: string; params: unknown[] } = { sql: '', params: [] };
  const classificationFilters = options.classification_filters ?? [];
  if (classificationFilters.length > 0) {
    const filtersBySlug = groupClassificationFilters(classificationFilters);
    const classifierIds = await resolveClassifierIds(sql, filtersBySlug, {
      organizationId: options.organization_id,
      entityId,
    });
    const exists = buildClassificationExistsClauses(
      filtersBySlug,
      classifierIds,
      options.classification_source,
      classificationParamIdx
    );
    if (!exists) {
      return emptyListResponse({ limit, effectiveOffset, useDateFeed, cursor, includeTotal });
    }
    classificationClause = {
      sql: exists.clauses.map((clause) => `AND ${clause}`).join('\n          '),
      params: exists.params,
    };
  } else if (options.classification_source) {
    const sourceOnly = buildSourceOnlyExistsClause(
      options.classification_source,
      classificationParamIdx
    );
    classificationClause = { sql: `AND ${sourceOnly.clause}`, params: sourceOnly.params };
  }
  const baseParamIdx = classificationParamIdx + classificationClause.params.length;
  const vectorParamIdx = hasEmbedding ? baseParamIdx : null;
  // Bind min_similarity as a numeric parameter after the vector slot (when
  // present) so a hostile float can't break out of the comparison expression.
  const minSimilarityParamIdx = baseParamIdx + (hasEmbedding ? 1 : 0);

  // As in buildStandardWhereSql, allow semi-joins while keeping the entity
  // parameter typed even when the link predicate inlines its id.
  const entityFilterSQL = entityId != null
    ? `${searchEntityLinkSql} AND ($2::bigint IS NOT NULL)`
    : `($2::bigint IS NULL OR ${searchEntityLinkSql})`;
  const standardFiltersFor = (orgScopeSql: string) => `${entityFilterSQL}
          AND ${connectionCondition}
          AND ${feedCondition}
          AND ${runCondition}
          AND ($3::text IS NULL OR f.connector_key = $3::text)
          AND ($4::timestamptz IS NULL OR f.occurred_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR f.occurred_at <= $5::timestamptz)
          AND ($6::int IS NULL OR iwf.run_id = $6::int)
          AND ($7::numeric IS NULL OR f.score >= $7::numeric)
          AND ($8::numeric IS NULL OR f.score <= $8::numeric)
          AND ($9::text[] IS NULL OR ${buildSemanticTypeFilterSql('f', '$9')})
          AND ($10::text IS NULL OR f.interaction_status = $10::text)
          AND ($11::text IS NULL OR f.metadata->>'agent_id' = $11::text)
          AND ($12::text[] IS NULL OR f.client_id = ANY($12::text[]))
          AND ($13::text[] IS NULL OR f.metadata->>'mcp_session_id' = ANY($13::text[]))
          ${excludeClause.sql}
          ${producedClause.sql}
          ${analyzedClause.sql}
          ${visibilityClause.sql}
          ${options.exclude_workspace_audit ? `AND NOT (f.metadata ? '_lobu_workspace_audit')` : ''}
          ${options.exclude_operational_trail ? `AND ${operationalTrailExclusionSql('f')}` : ''}
          ${
            // Internal-ops discovery filter (see the option's doc). An
            // explicit semantic_type filter ($9) wins over it: a caller asking
            // for 'audit' rows is reading the ops trail on purpose.
            options.exclude_internal_ops && !options.semantic_type
              ? `AND ${INTERNAL_OPS_EXCLUSION_SQL}`
              : ''
          }
          ${classificationClause.sql}
          ${resourceClause.sql}
          ${orgScopeSql}${entityTypesClause.sql}`;
  const standardFiltersSQL = standardFiltersFor(orgScope.sql);

  const textDocumentExpr = buildSearchDocumentExpr('f');
  const resultDocumentExpr = buildSearchDocumentExpr('fi');
  // Guard ILIKE/tsquery on non-empty $1 so an embedding-only call (trimmedQuery='')
  // doesn't degenerate to ILIKE '%%' (matches everything) — we want the vector
  // branch to be the sole filter in that case.
  const substringMatchExpr = hasEmbedding ? 'text_match.substring_match' : `f.payload_text ILIKE '%' || $1 || '%'`;
  const textMatchExpr = `(LENGTH($1) > 0 AND (${substringMatchExpr} OR COALESCE(${textDocumentExpr} @@ ${TSQUERY_SQL}, false)))`;
  const vecParam = vectorParamIdx ? `$${vectorParamIdx}::vector` : 'NULL::vector';
  const minSimilarityParam = `$${minSimilarityParamIdx}::numeric`;
  // Vector-space integrity: only compare against rows stamped with the EXACT
  // model the query vector above was produced under. A NULL stamp (legacy row
  // written before stamping) is NOT comparable — its true model is unknown, so
  // comparing it against the query vector could mix incompatible spaces. Such
  // rows are excluded from vector ranking until the backfill restamps them (see
  // trigger-embed-backfill, which treats NULL as stale). Inlined as a validated
  // literal (`<alias>` substituted per CTE).
  const modelLiteral = embeddingModelSqlLiteral(embeddingModel);
  const modelScopeFor = (alias: string) => `${alias}.embedding_model = ${modelLiteral}`;
  // A lateral aggregate computes the best chunk once per scoped event. A
  // scalar subquery in both WHERE and SELECT produces two independent scans.
  // Reuse the substring predicate too: hybrid search otherwise decompresses
  // and scans the same payload once for matching and again for ranking.
  // OFFSET 0 keeps that cheap lateral projection from being flattened back
  // into its consumers. Text-only searches keep their indexable predicate.
  const scoringJoins = hasEmbedding ? `
        CROSS JOIN LATERAL (
          SELECT MAX(1 - (emb.embedding <=> ${vecParam})) AS best_sim
          FROM event_embeddings emb
          WHERE emb.event_id = f.id AND ${modelScopeFor('emb')}
        ) chunk_score
        CROSS JOIN LATERAL (
          SELECT (LENGTH($1) > 0 AND f.payload_text ILIKE '%' || $1 || '%') AS substring_match
          OFFSET 0
        ) text_match` : '';
  const bestSimSelect = hasEmbedding ? 'chunk_score.best_sim' : 'NULL';
  const substringMatchSelect = hasEmbedding ? 'text_match.substring_match' : 'NULL';
  const matchCondition = hasEmbedding
    ? `(${textMatchExpr} OR ${bestSimSelect} >= ${minSimilarityParam})`
    : textMatchExpr;

  const searchWhereFor = (orgScopeSql: string) => `${matchCondition}
          AND ${standardFiltersFor(orgScopeSql)}`;

  // Text relevance in [0, 1]: half substring match, half full-text rank.
  // Normalization 32 maps rank to rank / (rank + 1), so repeated terms
  // cannot overwhelm cosine similarity (which ranges from -1 to 1).
  const rankedSubstringMatch = hasEmbedding ? 'fi.substring_match' : `fi.payload_text ILIKE '%' || $1 || '%'`;
  const textRankExpr = `
    (CASE WHEN LENGTH($1) > 0 AND ${rankedSubstringMatch} THEN 0.5 ELSE 0.0 END)
    + CASE WHEN LENGTH($1) > 0 THEN 0.5 * COALESCE(ts_rank_cd(${resultDocumentExpr}, ${TSQUERY_SQL}, 32), 0) ELSE 0 END
  `;
  let similarityExpr: string;
  let combinedScoreExpr: string;
  let searchExtraColumns: string;
  let orderByExpr: string;
  let resultSetOrderBy: string;
  const preferChronologicalOrdering = options.sort_by === 'date';

  // Tiebreaker for score-sorted branches: (id % 997) spreads near-tied rows pseudo-uniformly
  // across the ID space so that near-duplicate content (e.g. LoCoMo conversation sessions) does
  // not collapse onto the most-recent cluster via the occurred_at/id fallback. The final
  // occurred_at/id tiebreaker stays for full determinism when hashes also collide — keyed on the
  // effective time so a NULL-source-timestamp row ranks by its record time.
  const outerScoreTiebreaker =
    '(f.id % 997) ASC, COALESCE(f.occurred_at, f.created_at) DESC, f.id DESC';
  const innerScoreTiebreaker =
    '(fi.id % 997) ASC, COALESCE(fi.occurred_at, fi.created_at) DESC, fi.id DESC';

  if (hasEmbedding) {
    // Clamp to [0, 1] so callers can't accidentally invert the weighting.
    const vectorWeight = Math.max(0, Math.min(1, options.vector_weight ?? 0.6));
    const textWeight = 1 - vectorWeight;
    if (process.env.LOBU_DEBUG_SEARCH === '1') {
      logger.info(
        { vector_weight: vectorWeight, text_weight: textWeight, q: queryText.slice(0, 40) },
        '[content-search] weights'
      );
    }
    // Same model scope as matchCondition: a row whose stamp differs from the
    // configured model contributes no vector similarity, so stale-model rows can
    // never rank via an incompatible <=> comparison.
    // filtered_ids precomputes the best-chunk similarity per event as best_sim
    // (NULL when no comparable chunk), so scoring reads that column instead of a
    // per-row <=> against a single view embedding that no longer exists.
    // A row without a comparable chunk scores similarity 0 inside the same
    // weighted sum, avoiding an unweighted text bonus for missing embeddings.
    similarityExpr = `fi.best_sim`;
    combinedScoreExpr = `(${textRankExpr}) * ${textWeight} + COALESCE(fi.best_sim, 0) * ${vectorWeight}`;
    searchExtraColumns =
      'rs.text_rank, rs.similarity, rs.combined_score, rs.total_count, rs.cursor_fetched_count';
    orderByExpr = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'rs', 'final_select')
      : `rs.combined_score DESC, ${outerScoreTiebreaker}`;
    resultSetOrderBy = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'fi', 'result_set')
      : `${combinedScoreExpr} DESC, ${innerScoreTiebreaker}`;
  } else {
    similarityExpr = 'NULL';
    combinedScoreExpr = textRankExpr;
    searchExtraColumns =
      'rs.text_rank, NULL as similarity, rs.text_rank as combined_score, rs.total_count, rs.cursor_fetched_count';
    orderByExpr = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'rs', 'final_select')
      : `rs.combined_score DESC, ${outerScoreTiebreaker}`;
    resultSetOrderBy = preferChronologicalOrdering
      ? buildOrderByClause('date', options.sort_order, 'fi', 'result_set')
      : `${textRankExpr} DESC, ${innerScoreTiebreaker}`;
  }

  const searchFinalSelect = buildFinalSelect({
    withClassifications: !!needClassifications,
    extraColumns: searchExtraColumns,
    orderBy: orderByExpr,
  });

  const searchThreadCteSql = buildThreadMetaCteSql(
    '$2',
    'result_set',
    searchEntityLinkSqlForP
  );
  const latestClassificationsCteSql = buildLatestClassificationsCteSql();
  const ctes = needClassifications
    ? `${searchThreadCteSql},\n      ${latestClassificationsCteSql}`
    : searchThreadCteSql;

  // When hasEmbedding, two params (vector + min_similarity) follow baseParamIdx;
  // otherwise neither is bound, so the cursor params resume at baseParamIdx.
  const cursorBaseParamIdx = baseParamIdx + (hasEmbedding ? 2 : 0);
  const cursorClause = buildDateCursorClause(
    cursor,
    'COALESCE(fi.occurred_at, fi.created_at)',
    'fi.id',
    cursorBaseParamIdx
  );
  const limitParamIdx = cursorBaseParamIdx + cursorClause.params.length;
  const offsetParamIdx = limitParamIdx + 1;
  const validatedLimit = validateNumericId(limit, 'limit');

  // ── Recall-only index-driven candidate path ──────────────────────────────
  // Exact org-wide search keeps using `exactFilteredIdsBody` so title-only matches,
  // filtered result sets, totals, and offsets retain their historical semantics.
  // The bounded candidate path is opt-in for recall/search_memory snippets: the
  // caller ignores exact totals/pagination and only needs a small set of highly
  // relevant rows under the agent recall timeout.
  // A selective agent filter can make the global ANN candidate scan expensive.
  // Keep agent recall on the exact org-scoped path, under the same timeout.
  const useCandidatePath =
    options.approximate_candidate_search === true &&
    options.agent_id == null &&
    entityId == null &&
    options.organization_id != null &&
    !useDateFeed &&
    effectiveOffset === 0 &&
    hasEmbedding;
  const hasTextCandidates = useCandidatePath && trimmedQuery.length >= 3;
  let searchCandidatesCteSql = '';
  if (useCandidatePath) {
    // $tsq is appended last in queryParams; offsetParamIdx is the current tail
    // (useDateFeed is false here, so there is no cursor block before it).
    const tsqueryParamIdx = offsetParamIdx + 1;
    const candidateFilterJoins = `LEFT JOIN connections c ON c.id = f.connection_id
          LEFT JOIN automation_run_events iwf
            ON iwf.event_id = f.id
            AND ($6::int IS NOT NULL)
            AND iwf.run_id = $6::int`;
    const branches: string[] = [];
    // ivfflat ANN — the only shape that index serves. Multi-vector: the ANN now
    // ranks CHUNK rows, so over-fetch chunks then collapse to distinct events by
    // their best (nearest) chunk, so N chunks of one event can't crowd the
    // candidate set down to a handful of distinct events. The inner ORDER BY
    // ... LIMIT is the index-served part; the outer GROUP BY runs over the small
    // over-fetched set. Downstream filters applied before the LIMIT so a filtered
    // recall doesn't discard everything after an unfiltered pick.
    branches.push(`SELECT id FROM (
            SELECT emb.event_id AS id, (emb.embedding <=> ${vecParam}) AS dist
            FROM event_embeddings emb
            JOIN current_event_records f ON f.id = emb.event_id
            ${candidateFilterJoins}
            WHERE ${standardFiltersSQL}
              AND ${modelScopeFor('emb')}
              AND (1 - (emb.embedding <=> ${vecParam})) >= ${minSimilarityParam}
            ORDER BY emb.embedding <=> ${vecParam}
            LIMIT ${CANDIDATE_VECTOR_LIMIT * 3}
          ) ann
          GROUP BY id
          ORDER BY MIN(dist)
          LIMIT ${CANDIDATE_VECTOR_LIMIT}`);
    if (hasTextCandidates) {
      // Keep direct and linked scope separately indexable, as on the exact
      // path. Capping each disjoint arm then capping their union preserves the
      // original global top-N while avoiding a global history scan for a term
      // that is common elsewhere but rare in this organization.
      const textScopeFilters = orgScope.branches
        ? [orgScope.branches.direct, orgScope.branches.linked]
          .map((scope) => standardFiltersFor(`AND ${scope}`))
        : [standardFiltersSQL];
      const textCandidates = (matchSql: string, rankSql: string) => `SELECT id FROM (
          ${textScopeFilters.map((filters) => `(SELECT ce.id AS id, ${rankSql} AS rank
            FROM events ce
            JOIN current_event_records f ON f.id = ce.id
            ${candidateFilterJoins}
            WHERE ${matchSql}
              AND ${filters}
            ORDER BY ${rankSql} DESC, ce.id + 0 DESC
            LIMIT ${CANDIDATE_VECTOR_LIMIT})`).join('\n          UNION ALL\n          ')}
        ) text_candidates
        ORDER BY rank DESC, id DESC
        LIMIT ${CANDIDATE_VECTOR_LIMIT}`;
      // fulltext GIN — `@@` is index-served. Rank the STORED search_tsv before
      // the cap so the strongest matches survive CANDIDATE_VECTOR_LIMIT; this
      // costs a top-N sort over FTS-matching rows in the organization.
      branches.push(textCandidates(
        `ce.search_tsv @@ to_tsquery('english', $${tsqueryParamIdx})`,
        `ts_rank_cd(ce.search_tsv, to_tsquery('english', $${tsqueryParamIdx}))`
      ));
      // trigram GIN — preserves the payload substring match (exact strings, ids).
      // Sort the equivalent id expression so LIMIT cannot favor a backwards
      // primary-key scan through unrelated history. The explicit sort permits
      // filtered bitmap/index access before the same newest-id candidate cap.
      branches.push(textCandidates(`ce.payload_text ILIKE '%' || $1 || '%'`, 'ce.id + 0'));
    }
    // Each branch has its own ORDER BY/LIMIT and must therefore be
    // parenthesized for the UNION to parse. `UNION` (not UNION ALL) dedupes
    // ids that several sources surface — cheap over ≤200 rows per branch.
    searchCandidatesCteSql = `search_candidates AS (
        ${branches.map((b) => `(${b})`).join('\n        UNION\n        ')}
      ),
      `;
  }

  const filteredIdsSelect = (whereSql: string, candidateJoin = '') => `SELECT f.id, f.score, f.occurred_at, f.created_at, f.title, f.payload_text, ${bestSimSelect} AS best_sim, ${substringMatchSelect} AS substring_match, f.search_tsv
        FROM current_event_records f
        ${candidateJoin}
        ${scoringJoins}
        LEFT JOIN connections c ON c.id = f.connection_id
        LEFT JOIN automation_run_events iwf
          ON iwf.event_id = f.id
          AND ($6::int IS NOT NULL)
          AND iwf.run_id = $6::int
        WHERE ${whereSql}`;
  // Disjoint org-scope arms preserve exact totals without deduplication and let
  // the planner use the direct-org and linked-org indexes independently.
  // Entity-scoped reads keep one predicate.
  const exactBranches = entityId == null ? orgScope.branches : null;
  const exactFilteredIdsBody = exactBranches
    ? `(${filteredIdsSelect(searchWhereFor(`AND ${exactBranches.direct}`))})
        UNION ALL
        (${filteredIdsSelect(searchWhereFor(`AND ${exactBranches.linked}`))})`
    : filteredIdsSelect(searchWhereFor(orgScope.sql));
  const nonDateFilteredIdsCteSql = `filtered_ids AS (
        ${
          useCandidatePath
            ? filteredIdsSelect(standardFiltersSQL, 'JOIN search_candidates sc ON sc.id = f.id')
            : exactFilteredIdsBody
        }
      )`;

  // An opted-out caller skips the exact count; the column stays (NULL) so the
  // final select's shape does not depend on the option.
  const fullCountCteSql = includeTotal
    ? `full_count AS (
        SELECT COUNT(*) as total_count FROM filtered_ids
      )`
    : `full_count AS (
        SELECT NULL::bigint as total_count
      )`;
  // Without a total, an offset page learns it is not the last one from a
  // one-row overfetch: result_probe takes limit + 1 (bound below) and
  // result_set keeps the first `limit` under the same total order.
  const probeOrderBy = preferChronologicalOrdering
    ? buildOrderByClause('date', options.sort_order, 'rp', 'result_set')
    : `rp.combined_score DESC, (rp.id % 997) ASC, COALESCE(rp.occurred_at, rp.created_at) DESC, rp.id DESC`;
  // Bound the window before comparing content. Rows without text stay separate:
  // their title alone does not prove the content is the same.
  const collapseIdentical =
    options.collapse_identical_content === true &&
    !useDateFeed &&
    !preferChronologicalOrdering &&
    effectiveOffset === 0;
  const collapsePoolLimit = Math.min(validatedLimit * COLLAPSE_POOL_FACTOR, COLLAPSE_POOL_MAX);
  const collapsedIdsCteSql = collapseIdentical
    ? `collapsed_ids AS (
        SELECT pool.id, pool.score, pool.occurred_at, pool.created_at, pool.title, pool.payload_text, pool.best_sim, pool.substring_match, pool.search_tsv
        FROM (
          SELECT ranked.*, ROW_NUMBER() OVER (
            PARTITION BY ranked.title, ranked.payload_text,
              CASE WHEN LENGTH(ranked.payload_text) > 0 THEN NULL ELSE ranked.id END
            ORDER BY ranked.pool_score DESC, (ranked.id % 997) ASC, COALESCE(ranked.occurred_at, ranked.created_at) DESC, ranked.id DESC
          ) AS copy_rank
          FROM (
            SELECT fi.*, ${combinedScoreExpr} AS pool_score
            FROM filtered_ids fi
            ORDER BY ${resultSetOrderBy}
            LIMIT ${collapsePoolLimit}
          ) ranked
        ) pool
        WHERE pool.copy_rank = 1
      ),
      `
    : '';
  const rankedSource = collapseIdentical ? 'collapsed_ids' : 'filtered_ids';
  const nonDateResultSetSql = includeTotal
    ? `result_set AS (
        SELECT
          fi.id,
          ${textRankExpr} as text_rank,
          ${similarityExpr} as similarity,
          ${combinedScoreExpr} as combined_score,
          (SELECT total_count FROM full_count) as total_count,
          NULL::bigint as cursor_fetched_count
        FROM ${rankedSource} fi
        ORDER BY ${resultSetOrderBy}
        LIMIT $${limitParamIdx}
        OFFSET $${offsetParamIdx}
      )`
    : `result_probe AS (
        SELECT
          fi.id,
          fi.occurred_at,
          fi.created_at,
          ${textRankExpr} as text_rank,
          ${similarityExpr} as similarity,
          ${combinedScoreExpr} as combined_score
        FROM ${rankedSource} fi
        ORDER BY ${resultSetOrderBy}
        LIMIT $${limitParamIdx}
        OFFSET $${offsetParamIdx}
      ),
      result_set AS (
        SELECT
          rp.id,
          rp.text_rank,
          rp.similarity,
          rp.combined_score,
          NULL::bigint as total_count,
          (SELECT COUNT(*) FROM result_probe) as cursor_fetched_count
        FROM result_probe rp
        ORDER BY ${probeOrderBy}
        LIMIT ${validatedLimit}
      )`;

  const querySQL = useDateFeed
    ? `
      WITH RECURSIVE filtered_ids AS (
        ${exactFilteredIdsBody}
      ),
      ${fullCountCteSql},
      candidate_set AS (
        SELECT
          fi.id,
          fi.occurred_at,
          fi.created_at,
          ${textRankExpr} as text_rank,
          ${similarityExpr} as similarity,
          ${combinedScoreExpr} as combined_score
        FROM filtered_ids fi
        WHERE 1=1 ${cursorClause.sql}
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'fi')}
        LIMIT $${limitParamIdx}
      ),
      result_set AS (
        SELECT
          cs.id,
          cs.text_rank,
          cs.similarity,
          cs.combined_score,
          cs.created_at,
          (SELECT total_count FROM full_count) as total_count,
          (SELECT COUNT(*) FROM candidate_set) as cursor_fetched_count
        FROM candidate_set cs
        ORDER BY ${buildDateCandidateOrderBy(cursor, 'cs')}
        LIMIT ${validatedLimit}
      ),
      ${ctes}
      ${searchFinalSelect}`
    : `
      WITH RECURSIVE ${useCandidatePath ? searchCandidatesCteSql : ''}${nonDateFilteredIdsCteSql},
      ${fullCountCteSql},
      ${collapsedIdsCteSql}${nonDateResultSetSql},
      ${ctes}
      ${searchFinalSelect}`;

  const queryParams: unknown[] = [
    trimmedQuery,
    entityId ?? null,
    options.platform ?? null,
    sinceDate?.toISOString() ?? null,
    untilDate?.toISOString() ?? null,
    options.run_id ?? null,
    options.engagement_min ?? null,
    options.engagement_max ?? null,
    // Same Postgres `text[]` literal wrap as buildStandardParams — slot $9 in
    // the search template is `= ANY($9::text[])`.
    options.semantic_type
      ? pgTextArray(
          Array.isArray(options.semantic_type) ? options.semantic_type : [options.semantic_type]
        )
      : null,
    options.interaction_status ?? null,
    // Slot $11 — per-agent memory scope. See buildStandardParams for the
    // mirror call site.
    options.agent_id ?? null,
    // Slot $12 — per-OAuth-client scope. The conversation slot after it bumps
    // orgScope to $14 (set above).
    options.client_id
      ? pgTextArray(Array.isArray(options.client_id) ? options.client_id : [options.client_id])
      : null,
    // Slot $13 — exact MCP host-conversation transport ids. Preserve [] as
    // an empty Postgres array so a corrupt/title-only projection fails closed.
    options.mcp_session_ids !== undefined ? pgTextArray(options.mcp_session_ids) : null,
    ...orgScope.params,
    ...excludeClause.params,
    ...producedClause.params,
    ...analyzedClause.params,
    ...visibilityClause.params,
    ...entityTypesClause.params,
    ...searchEntityLinkParams,
    ...resourceClause.params,
    ...classificationClause.params,
    ...(hasEmbedding ? [toVectorLiteral(queryEmbedding!), minSimilarity] : []),
    ...cursorClause.params,
    ...(useDateFeed ? [fetchLimit] : [includeTotal ? limit : limit + 1, effectiveOffset]),
  ];
  if (hasTextCandidates) {
    // $tsq for the fulltext candidate branch. null (all-stopword query) →
    // to_tsquery('english', NULL) → `@@ NULL` → that branch matches nothing.
    queryParams.push(buildTsqueryString(trimmedQuery));
  }

  let rawRows: any[];
  // Recall opted into a bounded answer. Without a query embedding it cannot use
  // the candidate path, but it still must not outlast the candidate budget.
  const exactRead = { signal: options.signal, statementTimeoutMs: CONTENT_READ_STATEMENT_TIMEOUT_MS };
  if (options.approximate_candidate_search === true) {
    rawRows = await runBoundedRecallQuery(sql, querySQL, queryParams, options.signal);
  } else {
    rawRows = await boundedQuery(sql, querySQL, queryParams, exactRead);
  }

  let emptyPageTotal: number | null = null;
  if (includeTotal && !useDateFeed && rawRows.length === 0 && effectiveOffset > 0) {
    // The candidate path requires effectiveOffset === 0, so this block only
    // ever runs on the exact path: no search_candidates CTE, and params end
    // before the cursor/limit/offset tail.
    const countSQL = `
      WITH RECURSIVE ${nonDateFilteredIdsCteSql}
      SELECT COUNT(*) as total_count FROM filtered_ids`;
    const countParams = queryParams.slice(0, cursorBaseParamIdx - 1);
    const countRows = await boundedQuery(sql, countSQL, countParams, exactRead);
    emptyPageTotal = parseInt(String(countRows[0]?.total_count ?? '0'), 10);
  }

  const total = !includeTotal
    ? null
    : rawRows.length > 0
      ? parseInt(String(rawRows[0].total_count ?? '0'), 10)
      : (emptyPageTotal ?? 0);
  const content = needClassifications
    ? deduplicateWithClassifications(rawRows)
    : (rawRows as any as ContentSearchResult[]);

  return {
    content,
    total,
    page: buildPageInfo({
      limit,
      offset: effectiveOffset,
      total,
      returnedCount: content.length,
      useDateFeed,
      cursor,
      fetchedCount: rawRows[0]?.cursor_fetched_count,
    }),
    ...(queryEmbeddingUnavailable && { query_embedding_unavailable: true }),
  };
}
