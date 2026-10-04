/**
 * Tool: read_knowledge — SQL query building and the direct list branches
 * (content_ids lookup, include_superseded history listing, classification
 * stats aggregation).
 */

import { type DbClient, pgBigintArray, pgTextArray } from '../../db/client';
import {
  buildConnectionVisibilityClause,
  buildEntityLinkUnion,
  buildOrgScopeWhere,
  buildFutureOccurredAtClause,
  fetchEntityIdentityScopes,
} from '../../utils/content-search';
import { buildClassificationOrderSql } from '../../utils/content-search/classification';
import { buildSemanticTypeFilterSql } from '../../utils/content-search/params';
import logger from '../../utils/logger';
import { validateNumericId } from '../../utils/sql-validation';
import {
  boundedAttachmentsSql,
  boundedJsonSql,
  boundedPayloadTextSql,
} from '../../utils/content-read-bounds';
import type { GetContentArgs } from './schema';
import type { ClassificationStatsRow, ContentRow, GetContentResult } from './types';

/** Connection-visibility scope derived from the tool context. */
interface VisibilityScope {
  organizationId: string;
  userId: string | null;
}

/** Shared shape returned by the direct list branches. */
interface ListPageResult {
  rawContent: ContentRow[];
  total: number;
  /**
   * Distinct-lineage count, set only by the content_ids branch where one id can
   * expand to a whole supersede chain. `total` counts returned rows; this counts
   * the atomic chains those rows collapse into.
   */
  chainTotal?: number;
  pageInfo: GetContentResult['page'];
}

/**
 * Build the common SELECT columns, JOINs, and classification subquery
 * used by both the content_ids and include_superseded query branches.
 */
export function buildContentQuery(opts: {
  table: string;
  alias: string;
  /** Extra JOIN clause(s) spliced in before the fixed connection/oauth joins. */
  join?: string;
  where: string;
  orderBy: string;
  limit: number;
  offset: number;
  /** Explicit content_ids reads keep the full payload; list/history reads do not. */
  boundAgentContent?: boolean;
}): string {
  const {
    table,
    alias: a,
    join = '',
    where,
    orderBy,
    limit,
    offset,
    boundAgentContent = true,
  } = opts;
  const payloadTextColumns = boundAgentContent
    ? boundedPayloadTextSql(a)
    : `${a}.payload_text, ${a}.content_length, false AS payload_truncated`;
  const payloadData = boundAgentContent
    ? boundedJsonSql(a, 'payload_data')
    : `${a}.payload_data`;
  const payloadTemplate = boundAgentContent
    ? boundedJsonSql(a, 'payload_template')
    : `${a}.payload_template`;
  const attachments = boundAgentContent
    ? boundedAttachmentsSql(a)
    : `${a}.attachments, false AS attachments_truncated, NULL::int AS attachments_bytes`;
  // The only bounded caller is fetchIncludeSuperseded. Select its page first,
  // then run octet_length/json replacement in the outer projection so large
  // JSON cells outside the page are never measured. Exact-ID reads stay on the
  // original direct query below because they are intentionally full fidelity.
  const source = boundAgentContent
    ? `(
        SELECT ${a}.*
        FROM ${table} ${a}
        ${join}
        LEFT JOIN connections c ON c.id = ${a}.connection_id
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${limit}
        OFFSET ${offset}
      )`
    : table;
  const sourceJoin = boundAgentContent ? '' : join;
  const sourceWhere = boundAgentContent ? 'TRUE' : where;
  const sourceLimit = boundAgentContent ? '' : `LIMIT ${limit}\n    OFFSET ${offset}`;
  return `
    SELECT
      ${a}.id,
      ${a}.entity_ids,
      ${payloadTextColumns},
      ${a}.title,
      ${a}.author_name,
      ${a}.source_url,
      ${a}.occurred_at,
      ${a}.semantic_type,
      ${a}.origin_id,
      ${a}.origin_parent_id,
      COALESCE(${a}.origin_parent_id, ${a}.origin_id) as root_origin_id,
      CASE WHEN ${a}.origin_parent_id IS NULL THEN 0 ELSE 1 END as depth,
      ${a}.origin_type,
      ${a}.payload_type,
      ${payloadData},
      ${payloadTemplate},
      ${attachments},
      ${a}.score,
      ${a}.metadata,
      ${a}.created_at,
      COALESCE(${a}.connector_key, c.connector_key) as platform,
      ${a}.interaction_type,
      ${a}.interaction_status,
      ${a}.interaction_input_schema,
      ${a}.interaction_input,
      ${a}.interaction_output,
      ${a}.interaction_error,
      ${a}.supersedes_event_id,
      ${a}.superseded_by,
      ${a}.run_id,
      ${a}.connection_id,
      ${a}.feed_id,
      ${a}.feed_key,
      ${a}.automation_id,
      fd.display_name AS feed_name,
      COALESCE(wv.name, 'Automation #' || ${a}.automation_id) AS automation_name,
      oc.client_name,
      -- Per-event classifications keyed by classifier attribute, matching the
      -- list/search path shape so exact reads (content_ids / include_superseded)
      -- surface a manual classifiers.classify immediately (#2050). One row per
      -- (event, classifier): source priority user then llm then embedding,
      -- newest first -- the same dedup rule as buildLatestClassificationsCteSql.
      COALESCE(
        (
          SELECT jsonb_object_agg(
            lc.attribute_key,
            jsonb_build_object(
              'values', lc.values,
              'confidences', lc.confidences,
              'source', lc.source,
              'is_manual', lc.is_manual
            )
          )
          FROM (
            SELECT
              fcl.attribute_key,
              cc."values" AS values,
              cc.confidences,
              cc.source,
              cc.is_manual,
              ROW_NUMBER() OVER (
                PARTITION BY cc.event_id, cc.classifier_id
                ORDER BY ${buildClassificationOrderSql('cc')}
              ) AS rn
            FROM event_classifications cc
            JOIN classify_facet fcl ON fcl.id = cc.classifier_id
            WHERE cc.event_id = ${a}.id AND cc.classifier_id IS NOT NULL
          ) lc
          WHERE lc.rn = 1
        ),
        '{}'::jsonb
      ) as classifications
    FROM ${source} ${a}
    ${sourceJoin}
    LEFT JOIN connections c ON c.id = ${a}.connection_id
    LEFT JOIN oauth_clients oc ON oc.id = ${a}.client_id
    LEFT JOIN feeds fd ON fd.id = ${a}.feed_id
    LEFT JOIN automation_versions wv ON wv.id = ${a}.automation_version_id
    WHERE ${sourceWhere}
    ORDER BY ${orderBy}
    ${sourceLimit}
  `;
}

/**
 * Chain-resolution CTE. Expands each requested content id to its full supersede
 * lineage so a permalink minted at pending-approval time (its id is later
 * superseded and hidden from `current_event_records`) still resolves — and
 * shows the whole pending→executing→completed history, not just the head.
 *
 * Reads from `events` (not the masked view) because superseded rows are the
 * whole point. Walk the `superseded_by` / `supersedes_event_id` linked list out
 * from every seed in both directions. `run_id` is deliberately not a lineage
 * key: a connector feed sync writes many unrelated source items under one run,
 * so expanding by run would make a permalink for one item return the whole
 * batch. Operation lifecycle rows already carry explicit supersede edges.
 * Chains are bounded (normally 2–3 hops; the forward edge is uniquely indexed),
 * so the recursion terminates cheaply.
 *
 * `$1` must be a bigint[] bind param of the requested ids. Emits a CTE named
 * `resolved_ids(id, chain_key)` — `id` is an event id in a resolved chain and
 * `chain_key` is a stable per-chain identifier shared by every row of the same
 * lineage, so the caller can `COUNT(DISTINCT chain_key)` to count chains (an
 * atomic unit) rather than expanded rows. The caller filters the final read to
 * `f.id IN (SELECT id FROM resolved_ids)`.
 */
const RESOLVED_IDS_CTE = `
  resolved_ids AS (
    -- Transitive closure of each explicit supersede lineage in both directions.
    -- Chain key is the lineage root (oldest ancestor), which every row in the
    -- chain shares regardless of which id the caller entered from.
    SELECT walked.id, 'ev:' || walked.root AS chain_key
    FROM (
      WITH RECURSIVE lineage(id, root) AS (
        -- Seed each requested id with itself as the provisional root; MIN()
        -- over the connected component finalizes the oldest ancestor below.
        SELECT s.id, s.id AS root
        FROM events s
        WHERE s.id = ANY($1::bigint[])
        UNION
        SELECT nxt.id, LEAST(l.root, nxt.id)
        FROM lineage l
        JOIN events cur ON cur.id = l.id
        JOIN events nxt
          ON nxt.id = cur.superseded_by        -- forward: newer
          OR nxt.id = cur.supersedes_event_id  -- backward: older
      )
      -- A component can be reached from multiple seeds / hop orders; collapse to
      -- one row per event with the smallest root so the chain key is stable.
      SELECT id, MIN(root) AS root FROM lineage GROUP BY id
    ) walked
  )
`;

/**
 * Direct query by content IDs. Each requested id is expanded to its full
 * supersede chain (see {@link RESOLVED_IDS_CTE}) so stale permalinks resolve and
 * the caller sees the pending→completed history. Bypasses other filters except
 * entity_id. Caller dispatches here only when content_ids is non-empty.
 */
export async function fetchByContentIds(opts: {
  args: GetContentArgs;
  sql: DbClient;
  organizationId: string;
  visibilityScope: VisibilityScope;
  excludeWorkspaceAudit?: boolean;
  limit: number;
  offset: number;
}): Promise<ListPageResult> {
  const { args, sql, organizationId, visibilityScope, excludeWorkspaceAudit, limit, offset } = opts;

  // typebox validates content_ids as number[] at the tool boundary; the
  // caller only dispatches here when it is non-empty.
  const contentIdsArray = args.content_ids ?? [];

  logger.info(`[get_content] Filtering by ${contentIdsArray.length} specific content IDs`);

  // $1 is the requested-id array, consumed by RESOLVED_IDS_CTE. All later
  // filters bind from $2 onward and read the expanded chain set, so org scope,
  // entity link, and visibility apply to every resolved row, not just the seed.
  const queryParams: Array<string | number | null> = [pgBigintArray(contentIdsArray)];
  const idFilter = 'f.id IN (SELECT id FROM resolved_ids)';

  // Exact-id reads use the same workspace boundary as ordinary memory
  // search: direct ownership OR an entity/connection bridge into the selected
  // workspace. The previous direct-only predicate contradicted the handler's
  // authorization precheck (which already accepted those bridges), causing a
  // permitted exact event to disappear after policy validation. An explicit
  // organization id is always supplied, so this can never degrade to an
  // unscoped read.
  const orgScope = buildOrgScopeWhere({
    organization_id: organizationId,
    strict_organization_scope: true,
    baseParamIndex: queryParams.length + 1,
  });
  queryParams.push(...orgScope.params);

  let entityFilter = '';
  if (args.entity_id) {
    // Use the trimmed entity-link UNION when we know the entity id —
    // skips namespaces this entity doesn't claim. Identifier values are
    // bound params; entity id is inlined as a literal so the planner
    // sees the actual selectivity.
    const validatedId = validateNumericId(args.entity_id as number, 'entity_id');
    const scopes = await fetchEntityIdentityScopes(sql, validatedId);
    const link = buildEntityLinkUnion({
      entityIdLiteral: validatedId,
      scopes,
      alias: 'f',
      baseParamIndex: queryParams.length + 1,
    });
    entityFilter = ` AND ${link.sql}`;
    queryParams.push(...link.params);
  }

  // Visibility: hide events from connections the caller can't see. Inline,
  // shared with the count below.
  const visibility = buildConnectionVisibilityClause({
    organizationId: visibilityScope.organizationId,
    userId: visibilityScope.userId,
    baseParamIndex: queryParams.length + 1,
  });
  queryParams.push(...visibility.params);

  const where = `${idFilter} ${orgScope.sql}${entityFilter} ${visibility.sql}${
    excludeWorkspaceAudit
      ? ` AND NOT (f.metadata ? '_lobu_workspace_audit')`
      : ''
  }`;

  // Read the full chain from `events` (not the masked view — superseded rows are
  // what we're here for). The list query JOINs resolved_ids so it can order by
  // the resolver's stable `chain_key`: lineages never interleave, and within a
  // chain rows read pending→completed top-to-bottom by occurred_at.
  const result = await sql.unsafe(
    `
    WITH ${RESOLVED_IDS_CTE}
    ${buildContentQuery({
      table: 'events',
      alias: 'f',
      join: 'JOIN resolved_ids ri ON ri.id = f.id',
      where,
      orderBy: 'ri.chain_key ASC, f.occurred_at ASC, f.id ASC',
      limit,
      offset,
      boundAgentContent: false,
    })}
  `,
    queryParams
  );

  // `total` counts the returned ROWS, not chains: a chain expands to its whole
  // supersede lineage (original + tombstone), so a chain-count `total` under-
  // reports (says 1 when 2 rows return) — a lying count. `total` and the
  // row-wise `has_more` below now agree with what the caller actually receives.
  // `chain_total` is kept as the atomic-unit count (distinct lineages), for
  // callers that want "how many things did my ids resolve to". Both re-apply the
  // same org/entity/visibility WHERE via the resolved_ids join, so neither can
  // drift from the list above.
  const countResult = await sql.unsafe(
    `
    WITH ${RESOLVED_IDS_CTE}
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT ri.chain_key) as chain_total
    FROM events f
    JOIN resolved_ids ri ON ri.id = f.id
    LEFT JOIN connections c ON c.id = f.connection_id
    WHERE ${where}
  `,
    queryParams
  );

  const rawContent = result as unknown as ContentRow[];
  const total = Number(countResult[0]?.total ?? 0);
  const chainTotal = Number(countResult[0]?.chain_total ?? 0);
  return {
    rawContent,
    total,
    chainTotal,
    pageInfo: {
      limit,
      offset,
      has_more: offset + rawContent.length < total,
    },
  };
}

/**
 * Entity-scoped chronological listing over `events` including superseded
 * historical rows. Caller validates args via
 * `getIncludeSupersededValidationErrors` before dispatching here.
 */
export async function fetchIncludeSuperseded(opts: {
  args: GetContentArgs;
  sql: DbClient;
  organizationId: string;
  entityId: number | undefined;
  effectiveConnectionIds: number[] | undefined;
  effectivePlatform: string | undefined;
  sinceDate: Date | null;
  untilDate: Date | null;
  visibilityScope: VisibilityScope;
  mcpSessionIds: string[] | undefined;
  excludeWorkspaceAudit?: boolean;
  limit: number;
  offset: number;
}): Promise<ListPageResult> {
  const {
    args,
    sql,
    organizationId,
    entityId,
    effectiveConnectionIds,
    effectivePlatform,
    sinceDate,
    untilDate,
    visibilityScope,
    mcpSessionIds,
    excludeWorkspaceAudit,
    limit,
    offset,
  } = opts;

  logger.info('[get_content] Listing content including superseded history');

  // Pre-fetch the entity's identity scopes once so the trimmed entity
  // link UNION skips namespaces this entity doesn't claim. Same pattern
  // as listContentInternal. Entity id is inlined as a literal, so it's
  // not a bound param here — identifier values are.
  const supersededValidatedId = validateNumericId(entityId as number, 'entity_id');
  const supersededScopes = await fetchEntityIdentityScopes(sql, supersededValidatedId);
  const supersededLink = buildEntityLinkUnion({
    entityIdLiteral: supersededValidatedId,
    scopes: supersededScopes,
    alias: 'e',
    baseParamIndex: 2, // org=$1; identifier params start at $2
  });

  const conditions: string[] = [
    'e.organization_id = $1',
    supersededLink.sql,
  ];
  const queryParams: Array<string | number | null> = [
    organizationId,
    ...supersededLink.params,
  ];
  let paramIndex = 2 + supersededLink.params.length;

  if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
    const placeholders = effectiveConnectionIds.map(() => `$${paramIndex++}`).join(',');
    conditions.push(`e.connection_id IN (${placeholders})`);
    queryParams.push(...effectiveConnectionIds);
  }
  if (args.feed_ids && args.feed_ids.length > 0) {
    const validFeedIds = args.feed_ids.filter((id) => Number.isInteger(id));
    if (validFeedIds.length > 0) {
      const placeholders = validFeedIds.map(() => `$${paramIndex++}`).join(',');
      conditions.push(`e.feed_id IN (${placeholders})`);
      queryParams.push(...validFeedIds);
    }
  }
  if (args.run_ids && args.run_ids.length > 0) {
    const validRunIds = args.run_ids.filter((id) => Number.isInteger(id));
    if (validRunIds.length > 0) {
      const placeholders = validRunIds.map(() => `$${paramIndex++}`).join(',');
      conditions.push(`e.run_id IN (${placeholders})`);
      queryParams.push(...validRunIds);
    }
  }
  if (effectivePlatform) {
    conditions.push(`COALESCE(e.connector_key, c.connector_key) = $${paramIndex}`);
    queryParams.push(effectivePlatform);
    paramIndex += 1;
  }
  if (sinceDate) {
    conditions.push(`e.occurred_at >= $${paramIndex}`);
    queryParams.push(sinceDate.toISOString());
    paramIndex += 1;
  }
  if (untilDate) {
    conditions.push(`e.occurred_at <= $${paramIndex}`);
    queryParams.push(untilDate.toISOString());
    paramIndex += 1;
  }
  if (args.run_id !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_run_events iwf WHERE iwf.event_id = e.id AND iwf.run_id = $${paramIndex})`
    );
    queryParams.push(args.run_id);
    paramIndex += 1;
  }
  if (args.analyzed_by_automation_id !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_run_events iwf WHERE iwf.event_id = e.id AND iwf.automation_id = $${paramIndex})`
    );
    queryParams.push(args.analyzed_by_automation_id);
    paramIndex += 1;
  }
  if (args.exclude_automation_id !== undefined) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM automation_run_events exc_iwe WHERE exc_iwe.event_id = e.id AND exc_iwe.automation_id = $${paramIndex})`
    );
    queryParams.push(args.exclude_automation_id);
    paramIndex += 1;
  }
  if (args.produced_by_automation_id !== undefined) {
    conditions.push(`e.automation_id = $${paramIndex}`);
    queryParams.push(
      validateNumericId(args.produced_by_automation_id, 'produced_by_automation_id')
    );
    paramIndex += 1;
  }
  if (args.engagement_min !== undefined) {
    conditions.push(`e.score >= $${paramIndex}`);
    queryParams.push(args.engagement_min);
    paramIndex += 1;
  }
  if (args.engagement_max !== undefined) {
    conditions.push(`e.score <= $${paramIndex}`);
    queryParams.push(args.engagement_max);
    paramIndex += 1;
  }
  if (args.agent_id) {
    conditions.push(`e.metadata->>'agent_id' = $${paramIndex}`);
    queryParams.push(args.agent_id);
    paramIndex += 1;
  }
  if (args.client_ids?.length) {
    conditions.push(`e.client_id = ANY($${paramIndex}::text[])`);
    queryParams.push(pgTextArray(args.client_ids));
    paramIndex += 1;
  }
  if (mcpSessionIds !== undefined) {
    conditions.push(
      `e.metadata->>'mcp_session_id' = ANY($${paramIndex}::text[])`
    );
    queryParams.push(pgTextArray(mcpSessionIds));
    paramIndex += 1;
  }
  if (args.semantic_type) {
    const types = Array.isArray(args.semantic_type)
      ? args.semantic_type
      : [args.semantic_type];
    conditions.push(buildSemanticTypeFilterSql('e', `$${paramIndex}`));
    queryParams.push(pgTextArray(types));
    paramIndex += 1;
  }
  if (args.interaction_status) {
    conditions.push(`e.interaction_status = $${paramIndex}`);
    queryParams.push(args.interaction_status);
    paramIndex += 1;
  }
  if (excludeWorkspaceAudit) {
    conditions.push(`NOT (e.metadata ? '_lobu_workspace_audit')`);
  }

  // Visibility: events from connections the caller can't see drop out.
  // The clause is appended as an `AND (…)` fragment so it folds cleanly
  // into the existing `conditions.join(' AND ')`.
  const visibility = buildConnectionVisibilityClause(
    {
      organizationId: visibilityScope.organizationId,
      userId: visibilityScope.userId,
      baseParamIndex: paramIndex,
    },
    'e'
  );
  if (visibility.sql) {
    // strip the leading "AND " that buildConnectionVisibilityClause emits
    // since we're joining conditions with ' AND ' ourselves.
    conditions.push(visibility.sql.replace(/^AND\s+/, ''));
    queryParams.push(...visibility.params);
    paramIndex += visibility.params.length;
  }

  const orderDirection = args.sort_order === 'asc' ? 'ASC' : 'DESC';
  const orderBySql = `e.occurred_at ${orderDirection} NULLS LAST, e.id ${orderDirection}`;

  const result = await sql.unsafe(
    buildContentQuery({
      table: 'events',
      alias: 'e',
      where: conditions.join(' AND '),
      orderBy: orderBySql,
      limit,
      offset,
    }),
    queryParams
  );

  const countResult = await sql.unsafe(
    `
    SELECT COUNT(*) as total
    FROM events e
    LEFT JOIN connections c ON c.id = e.connection_id
    WHERE ${conditions.join(' AND ')}
  `,
    queryParams
  );

  const rawContent = result as unknown as ContentRow[];
  const total = Number(countResult[0]?.total ?? 0);
  return {
    rawContent,
    total,
    pageInfo: {
      limit,
      offset,
      has_more: offset + rawContent.length < total,
    },
  };
}

/**
 * Classification statistics aggregated across ALL matching content (not just
 * paginated results).
 * NOTE: Stats are computed WITHOUT classification filters to show the full
 * distribution (sticky stats). This allows users to see all available values
 * even when filtering, enabling informed filter choices.
 */
export async function fetchClassificationStats(opts: {
  args: GetContentArgs;
  sql: DbClient;
  effectiveConnectionIds: number[] | undefined;
  effectivePlatform: string | undefined;
  sinceDate: Date | null;
  untilDate: Date | null;
  visibilityScope: VisibilityScope;
  mcpSessionIds: string[] | undefined;
  excludeWorkspaceAudit?: boolean;
}): Promise<NonNullable<GetContentResult['classification_stats']>> {
  const {
    args,
    sql,
    effectiveConnectionIds,
    effectivePlatform,
    sinceDate,
    untilDate,
    visibilityScope,
    mcpSessionIds,
    excludeWorkspaceAudit,
  } = opts;

  // Build dynamic WHERE conditions using inline SQL
  const conditions: string[] = ['1=1'];
  const params: Array<string | number | null> = [];
  let paramIndex = 1;

  if (excludeWorkspaceAudit) {
    conditions.push(`NOT (f.metadata ? '_lobu_workspace_audit')`);
  }

  if (args.entity_id) {
    // Use the trimmed UNION here too so the stats CTE doesn't pay for
    // namespaces the entity doesn't have. Identifier values are bound
    // params; entity id is inlined as a literal.
    const statsValidatedId = validateNumericId(args.entity_id as number, 'entity_id');
    const statsScopes = await fetchEntityIdentityScopes(sql, statsValidatedId);
    const statsLink = buildEntityLinkUnion({
      entityIdLiteral: statsValidatedId,
      scopes: statsScopes,
      alias: 'f',
      baseParamIndex: paramIndex,
    });
    conditions.push(statsLink.sql);
    params.push(...statsLink.params);
    paramIndex += statsLink.params.length;
  }
  if (effectiveConnectionIds && effectiveConnectionIds.length > 0) {
    // Parameterize — every other branch in this file does, and an
    // upstream schema relaxation shouldn't be the thing that turns this
    // into a string-concat injection sink.
    const placeholders = effectiveConnectionIds
      .map(() => `$${paramIndex++}`)
      .join(',');
    conditions.push(`f.connection_id IN (${placeholders})`);
    params.push(...effectiveConnectionIds);
  }
  if (effectivePlatform) {
    conditions.push(`COALESCE(f.connector_key, c.connector_key) = $${paramIndex++}`);
    params.push(effectivePlatform);
  }
  if (sinceDate) {
    conditions.push(`f.occurred_at >= $${paramIndex++}`);
    params.push(sinceDate.toISOString());
  }
  if (untilDate) {
    conditions.push(`f.occurred_at <= $${paramIndex++}`);
    params.push(untilDate.toISOString());
  }
  // The chronological LIST excludes not-yet-occurred events (see
  // buildFutureOccurredAtClause); a distribution over a wider set than the rows
  // it labels is wrong, so apply the same guard to the stats scope. Only on the
  // list path (no query): search still returns future-dated rows and its stats
  // must match that result set.
  if (!args.query) {
    const futureGuard = buildFutureOccurredAtClause(untilDate, null).sql;
    if (futureGuard) {
      conditions.push(futureGuard.replace(/^AND\s+/, ''));
    }
  }
  let runJoinSql = '';
  if (args.run_id) {
    runJoinSql = `JOIN automation_run_events iwf ON iwf.event_id = f.id AND iwf.run_id = $${paramIndex}`;
    params.push(args.run_id);
    paramIndex++;
  }
  if (args.analyzed_by_automation_id !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_run_events iwf WHERE iwf.event_id = f.id AND iwf.automation_id = $${paramIndex++})`
    );
    params.push(args.analyzed_by_automation_id);
  }
  if (args.exclude_automation_id !== undefined) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM automation_run_events exc_iwe WHERE exc_iwe.event_id = f.id AND exc_iwe.automation_id = $${paramIndex++})`
    );
    params.push(args.exclude_automation_id);
  }
  // Produced, not analyzed. A column read rather than an EXISTS over
  // `automation_run_events`, because that table records what an Automation READ.
  // Index: idx_events_automation_produced (organization_id, automation_id,
  // occurred_at DESC) — the org predicate and the ORDER BY are already there.
  if (args.produced_by_automation_id !== undefined) {
    conditions.push(`f.automation_id = $${paramIndex++}`);
    params.push(
      validateNumericId(args.produced_by_automation_id, 'produced_by_automation_id')
    );
  }
  if (args.agent_id) {
    conditions.push(`f.metadata->>'agent_id' = $${paramIndex++}`);
    params.push(args.agent_id);
  }
  // Keep the stats scope identical to the list scope — a distribution computed
  // over a wider set than the rows it labels is simply wrong.
  if (args.client_ids?.length) {
    conditions.push(`f.client_id = ANY($${paramIndex++}::text[])`);
    params.push(pgTextArray(args.client_ids));
  }
  if (mcpSessionIds !== undefined) {
    conditions.push(
      `f.metadata->>'mcp_session_id' = ANY($${paramIndex++}::text[])`
    );
    params.push(pgTextArray(mcpSessionIds));
  }

  // Visibility: events from connections the caller can't see must not
  // skew the classification distribution.
  const statsVisibility = buildConnectionVisibilityClause({
    organizationId: visibilityScope.organizationId,
    userId: visibilityScope.userId,
    baseParamIndex: paramIndex,
  });
  if (statsVisibility.sql) {
    conditions.push(statsVisibility.sql.replace(/^AND\s+/, ''));
    params.push(...statsVisibility.params);
    paramIndex += statsVisibility.params.length;
  }

  // Stats query WITHOUT classification filters (to show full distribution)
  const statsQueryResult = await sql.unsafe(
    `
    WITH matching_content AS (
      SELECT f.id
      FROM current_event_records f
      LEFT JOIN connections c ON c.id = f.connection_id
      ${runJoinSql}
      WHERE ${conditions.join(' AND ')}
    ),
    ranked_classifications AS (
      -- P4: dedup per (event, stable classifier_id) directly; version ordering is redundant.
      SELECT
        cc.event_id,
        cc.classifier_id,
        cc."values",
        ROW_NUMBER() OVER (
          PARTITION BY cc.event_id, cc.classifier_id
          ORDER BY ${buildClassificationOrderSql('cc')}
        ) as rn
      FROM event_classifications cc
      JOIN matching_content mc ON mc.id = cc.event_id
      WHERE cc.classifier_id IS NOT NULL
    ),
    latest_classifications AS (
      SELECT event_id, classifier_id, "values"
      FROM ranked_classifications
      WHERE rn = 1
    )
    SELECT
      fcl.slug as classifier_slug,
      fcl.attribute_key,
      value::text as value,
      COUNT(*) as count
    FROM latest_classifications lc
    JOIN classify_facet fcl ON lc.classifier_id = fcl.id
    CROSS JOIN unnest(lc."values") AS t(value)
    GROUP BY fcl.slug, fcl.attribute_key, value
    ORDER BY fcl.slug, count DESC
  `,
    params
  );

  // Transform to nested object structure: { classifier_slug: { value: count } }
  const classificationStats: NonNullable<GetContentResult['classification_stats']> = {};
  for (const row of statsQueryResult as unknown as ClassificationStatsRow[]) {
    (classificationStats[row.classifier_slug] ??= {})[row.value] = Number(row.count);
  }
  return classificationStats;
}
