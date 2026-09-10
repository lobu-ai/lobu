/**
 * Tool: get_automation (Incremental Time Windows)
 *
 * Query a single automation's analysis windows by arrival date range.
 * Returns time-windowed Automation results sourced directly from runs.
 */

import { type Static, Type } from '@sinclair/typebox';
import { createDbClientFromEnv, type DbClient, getDb } from '../db/client';
import type { Env } from '../index';
import type {
  AutomationTrigger,
  Outputs,
  PendingAnalysis,
  AutomationMetadata,
  AutomationSource,
  AutomationVersionInfo,
  AutomationWindow,
  AutomationWindowReaction,
} from '../types/automations';
import {
  PendingAnalysisSchema,
  AutomationMetadataSchema,
  AutomationWindowSchema,
} from '../types/automations';
import {
  buildEntityLinkUnion,
  STANDARD_IDENTITY_NAMESPACES,
  type EntityIdentityScope,
} from '../utils/content-search';
import { formatDateISO, parseDateAlias } from '../utils/date-aliases';
import { parseJsonObject } from '@lobu/core';
import logger from '../utils/logger';
import { parsePositiveIntegerId, ToolUserError } from '../utils/errors';
import {
  requireOrgReadAccess,
  requireReadAccess,
} from '../utils/organization-access';

import {
  buildAutomationUrl,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../utils/url-builder';
import {
  buildWindowsCountFromClause,
  buildWindowsSelectClause,
  ensureIsoString,
  ensureNumber,
  foldUnprocessedRanges,
  parseBigintArray,
  readPendingWindow,
} from '../utils/window-utils';
import { buildLatestAutomationRunJoinSql } from '../automations/automation';
import { computeAutomationHealth } from '../automations/automation-health';
import { loadRecentAutomationRunStatuses } from '../automations/automation-health-history';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';

// ============================================
// Typebox Schema
// ============================================

export const GetAutomationSchema = Type.Object({
  automation_id: Type.String({ description: 'Automation ID to query' }),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Optional entity ID for access validation and URL context',
    })
  ),
  content_since: Type.Optional(
    Type.String({
      description:
        'Filter windows from this date. Supports: ISO 8601 ("2025-01-01"), named aliases ("yesterday", "last_week"), or relative ("7d", "30d", "1m", "1y")',
    })
  ),
  content_until: Type.Optional(
    Type.String({
      description:
        'Filter windows until this date. Supports: ISO 8601 ("2025-01-31"), named aliases ("today", "yesterday"), or relative ("7d", "30d", "1m", "1y")',
    })
  ),
  template_version: Type.Optional(
    Type.Number({
      description:
        "Override template version *number* for viewing results. If not provided, uses the Automation's current pinned version. Useful for viewing results with a different renderer or schema. Prefer `template_version_id` when you need a stable reference (version numbers can change if a chain is reorganized).",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "Pin to a specific persisted Automation version. Workers receive this from runs.approved_input.version_id and pass it back so the agent loop reads the same version it extracted with, even if the group is edited mid-run.",
    })
  ),
  page: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 1_000_000,
      description: 'Page number for pagination (default: 1, max: 1000000)',
    })
  ),
  page_size: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description: 'Results per page (default: 50, max: 500)',
    })
  ),
  include_classification: Type.Optional(
    Type.String({
      description: 'Include per-window classification stats. Use "summary" to enable.',
    })
  ),
  include_versions: Type.Optional(
    Type.Boolean({
      description:
        'Include the full available_versions list. Off by default; the edit sheet sets it true. Saves one query per page open.',
    })
  ),
  include_pending_ranges: Type.Optional(
    Type.Boolean({
      description:
        'Include pending_analysis.unprocessed_ranges (per-month histogram). Off by default; the summary view sets it true on expand. Saves two events-table aggregates per page open.',
    })
  ),
});

// ============================================
// Type Definitions
// ============================================

type GetAutomationArgs = Static<typeof GetAutomationSchema>;

/**
 * Result of `get_automation`. TypeBox-first (single source of truth): the handler's
 * return type is `Static<>`-derived, and the same schema is the tool's
 * `outputSchema`. Nested automation types come from `types/automations.ts`.
 */
export const GetAutomationResultSchema = Type.Object({
  windows: Type.Array(AutomationWindowSchema),
  automation: Type.Optional(AutomationMetadataSchema),
  pending_analysis: Type.Optional(PendingAnalysisSchema),
  pagination: Type.Object({
    page: Type.Integer(),
    page_size: Type.Integer(),
    total: Type.Integer(),
  }),
  metadata: Type.Object({
    query_type: Type.Union([Type.Literal('specific'), Type.Literal('all_for_entity')]),
    date_range: Type.Object({
      content_since: Type.Union([Type.String(), Type.Null()]),
      content_until: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
  warnings: Type.Optional(Type.Array(Type.String())),
  view_url: Type.Optional(Type.String()),
});
export type GetAutomationResult = Static<typeof GetAutomationResultSchema>;

// ============================================
// Database Row Types (for query result typing)
// ============================================

/** Row type for window query results (from buildWindowsSelectClause) */
interface WindowRow {
  run_id: number;
  automation_id: string;
  automation_name: string;
  window_start: string;
  window_end: string;
  content_analyzed: number;
  extracted_data: Record<string, unknown> | null;
  model_used: string | null;
  client_id: string | null;
  run_metadata: Record<string, unknown> | null;
  execution_time_ms: number | null;
  created_at: string | null;
  version_id: number | null;
  total_count: number; // COUNT(*) OVER () — same value on every row
}

/** Row type for classification stats query results */
interface ClassificationStatsRow {
  run_id: number;
  classifier_slug: string;
  value: string;
  count: number;
}

/** Row type for automation query */
interface AutomationQueryRow {
  automation_id: string;
  name: string | null;
  slug: string | null;
  status: string;
  schedule: string | null;
  triggers: AutomationTrigger[] | null;
  next_run_at: string | null;
  consecutive_scheduled_failures: number;
  schedule_auto_paused_at: string | null;
  last_event_activation_at: string | null;
  managed_agent_id: string | null;
  delivery_target: {
    connection_id: number;
    channel_id: string;
  } | null;
  device_worker_id: string | null;
  agent_kind: string | null;
  execution_config: AutomationMetadata['execution_config'];
  version: number;
  current_version_id: number | null;
  entity_ids: string | number[];
  sources: AutomationSource[] | null;
  reaction_script: string | null;
  organization_id: string | null;
  latest_run_id: number | null;
  automation_run_status: string | null;
  automation_run_outcome: string | null;
  automation_run_error: string | null;
  automation_run_created_at: string | null;
  automation_run_completed_at: string | null;
  // Selected version row (pinned current_version unless template_version overrides)
  sel_version_id: number | null;
  sel_version: number | null;
  sel_version_name: string | null;
  sel_version_description: string | null;
  sel_version_prompt: string | null;
  sel_version_version_sources: unknown;
  sel_version_classifiers: unknown;
  sel_version_outputs: unknown;
  sel_version_reactions_guidance: string | null;
  // Latest window end (folded MAX(window_end) lookup)
  latest_window_end: string | null;
  // jsonb_agg of identity scopes for primary entity
  entity_scopes: Array<{
    namespace: string;
    identifier: string;
    scopeKey: string | null;
  }> | null;
}

function parseAutomationSources(value: unknown): AutomationSource[] {
  if (Array.isArray(value)) return value as AutomationSource[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as AutomationSource[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function requireAutomationReadAccess(
  sql: DbClient,
  automationId: string,
  ctx: ToolContext
): Promise<void> {
  const rows = await sql`
    SELECT organization_id, entity_ids
    FROM automations
    WHERE id = ${automationId}
    LIMIT 1
  `;
  if (rows.length === 0) return;

  const row = rows[0] as { organization_id: string | null; entity_ids: unknown };
  if (!row.organization_id || row.organization_id !== ctx.organizationId) {
    throw new ToolUserError(
      `Access denied: Automation ${automationId} is not accessible to your organization`,
      403
    );
  }

  const entityIds = parseBigintArray(row.entity_ids);
  if (entityIds.length > 0) {
    for (const entityId of entityIds) {
      await requireReadAccess(sql, entityId, ctx);
    }
  } else {
    await requireOrgReadAccess(sql, ctx);
  }
}

// ============================================
// Tool Implementation
// ============================================

export const getAutomation = withValidatedArgs(
  'get_automation',
  GetAutomationSchema,
  getAutomationImpl
);

async function getAutomationImpl(
  args: GetAutomationArgs,
  env: Env,
  ctx: ToolContext
): Promise<GetAutomationResult> {
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);

  // Validate entity access if entity_id provided (auth check stays on PG)
  if (args.entity_id) {
    await requireReadAccess(pgSql, args.entity_id, ctx);
  }
  const includeClassification = (args.include_classification || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  // Default to "summary" when nothing requested. The "timeline" value used to
  // ship a separate classification_timeline payload — that path was removed,
  // but we treat it as a summary alias so existing MCP callers passing
  // "timeline" or "summary,timeline" still get the per-window stats they were
  // already getting (deleting the timeline must not silently strip summary).
  const includeClassificationSummary =
    includeClassification.length === 0 ||
    includeClassification.includes('summary') ||
    includeClassification.includes('timeline');

  // ============================================
  // Step 1: Validate inputs
  // ============================================

  if (!args.automation_id) {
    throw new ToolUserError(
      "automation_id is required. Use client.automations.list() via query_sdk to discover Automations.",
      400
    );
  }
  parsePositiveIntegerId(args.automation_id, 'automation_id');

  await requireAutomationReadAccess(pgSql, args.automation_id, ctx);

  const page = Math.max(1, args.page || 1);
  const pageSize = Math.min(500, Math.max(1, args.page_size || 50));
  const offset = (page - 1) * pageSize;

  let parsedSince: string | undefined;
  let parsedUntil: string | undefined;

  if (args.content_since) {
    parsedSince = formatDateISO(parseDateAlias(args.content_since).date);
  }

  if (args.content_until) {
    const endOfDay = new Date(parseDateAlias(args.content_until).date);
    endOfDay.setHours(23, 59, 59, 999);
    parsedUntil = endOfDay.toISOString();
  }

  const whereClauses: string[] = [
    `iw.run_type = 'automation'`,
    `iw.status = 'completed'`,
    `iw.action_output IS NOT NULL`,
  ];
  const params: any[] = [];

  const addParam = (value: any): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (args.automation_id) {
    whereClauses.push(`iw.automation_id = ${addParam(args.automation_id)}`);
  } else if (args.entity_id) {
    whereClauses.push(`${addParam(args.entity_id)} = ANY(i.entity_ids)`);
    whereClauses.push(`i.status = 'active'`);
  }

  if (parsedSince) {
    whereClauses.push(`(iw.approved_input->>'window_end')::timestamptz >= ${addParam(parsedSince)}`);
  }

  if (parsedUntil) {
    whereClauses.push(`(iw.approved_input->>'window_start')::timestamptz <= ${addParam(parsedUntil)}`);
  }

  const whereClause = whereClauses.length > 0 ? whereClauses.join(' AND ') : '1=1';

  const windowsQuery = `
    ${buildWindowsSelectClause()}
    WHERE ${whereClause}
    ORDER BY (iw.approved_input->>'window_start')::timestamptz DESC
    LIMIT ${addParam(pageSize)}
    OFFSET ${addParam(offset)}
  `;

  const windows = await sql.unsafe(windowsQuery, params);

  // ============================================
  // Step 4: Total window count for pagination
  // ============================================
  // Derived from `COUNT(*) OVER ()` baked into the windows SELECT — no
  // separate round-trip on the common path. The COUNT is attached to each
  // returned row, so when `OFFSET` skips past every match we lose the
  // count. Pi-review fix: fall back to a dedicated `COUNT(*)` only when
  // the page is empty AND we requested a non-zero offset (page > 1).
  // Page-1 empty pages legitimately mean "no matches → total 0".
  let totalCount =
    windows.length > 0 ? Number((windows[0] as unknown as WindowRow).total_count ?? 0) : 0;
  if (windows.length === 0 && offset > 0) {
    const countQuery = `
      SELECT COUNT(*) as count
      FROM ${buildWindowsCountFromClause()}
      LEFT JOIN automation_versions cv ON i.current_version_id = cv.id
      WHERE ${whereClause}
    `;
    const countResult = await sql.unsafe(countQuery, params.slice(0, -2));
    totalCount = Number.parseInt(String(countResult[0].count), 10);
  }

  // ============================================
  // Step 4.5: Fetch classification stats for all windows
  // ============================================

  const typedWindows = windows as unknown as WindowRow[];
  const runIds = typedWindows.map((w) => ensureNumber(w.run_id));
  const classificationStatsMap: Map<number, Record<string, Record<string, number>>> = new Map();

  // Reaction-script execution log per window (newest first). One batched
  // query for the page; capped per page so a chatty reaction can't bloat the
  // response. Surfaced on each window so the UI can show what the reaction
  // did (or why it failed).
  const reactionsMap: Map<number, AutomationWindowReaction[]> = new Map();
  if (runIds.length > 0) {
    // PG array literal, not a JS array bind: the pool runs fetch_types:false,
    // so postgres.js ships a one-element JS array as a scalar and PG throws
    // `malformed array literal` (same trap as the reconciler regression
    // documented in automation-contract.test.ts).
    const runIdsLiteral = `{${runIds.join(',')}}`;
    const reactionRows = (await sql.unsafe(
      `SELECT id, source_run_id, reaction_type, tool_name, tool_args, tool_result, created_at
       FROM automation_reactions
       WHERE source_run_id = ANY($1::bigint[])
       ORDER BY created_at DESC
       LIMIT 500`,
      [runIdsLiteral]
    )) as unknown as Array<{
      id: number;
      source_run_id: number;
      reaction_type: string;
      tool_name: string;
      tool_args: Record<string, unknown> | null;
      tool_result: Record<string, unknown> | null;
      created_at: string;
    }>;
    for (const r of reactionRows) {
      const wid = ensureNumber(r.source_run_id);
      const list = reactionsMap.get(wid) ?? [];
      list.push({
        id: ensureNumber(r.id),
        reaction_type: r.reaction_type,
        tool_name: r.tool_name,
        tool_args: r.tool_args ?? undefined,
        tool_result: r.tool_result ?? undefined,
        created_at: r.created_at,
      });
      reactionsMap.set(wid, list);
    }
  }

  // Fire automation metadata query early (awaited after classification stats).
  // This single statement is the consolidated "Q-meta": automation row +
  // selected version row + entities (with parent
  // info) + identity scopes for the automation's primary entity + MAX(window_end)
  // + latest run via lateral. Replaces what used to be five separate
  // round-trips (entityCheck/automationEntityQuery, automation row, fetchEntityIdentityScopes,
  // MAX(window_end) lookup, version row).
  //
  // The version row is *the requested version* — usually the automation's
  // pinned current_version, but the optional template_version arg can
  // override it. We pass the resolved version number as $2; when it equals
  // the pinned version, we read off `cv` directly (the join is already there);
  // when it differs, the JOIN still resolves
  // the right row via (automation_id, version) which is unique.
  //
  // Two override mechanisms:
  //   - template_version_id (preferred): an exact automation_versions.id. Used
  //     by the worker run loop to read the snapshotted version even after a
  //     mid-run group edit. Joins by id so it works regardless of which
  //     automation in the group owns the version row.
  //   - template_version (legacy): a version *number*. Resolves via the
  //     group's root automation_id (automation_group_id), since after the group-
  //     edit refactor version chains live on the group root, not on each
  //     non-root assignment.
  //
  // Built as a single sql.unsafe() statement — composing sql.unsafe()
  // fragments inside a tagged template alongside $N params is fragile, so the
  // whole query is one unsafe call.
  const requestedVersion = args.template_version ?? null;
  const requestedVersionId = args.template_version_id ?? null;
  const namespacesLiteral = STANDARD_IDENTITY_NAMESPACES.map((n) => `'${n}'`).join(',');
  const automationQueryPromise = args.automation_id
    ? sql.unsafe(
        `
      SELECT
        i.id as automation_id,
        i.name,
        i.slug,
        i.status,
        i.schedule,
        i.triggers,
        i.next_run_at,
        i.consecutive_scheduled_failures,
        i.schedule_auto_paused_at,
        i.last_event_activation_at,
        i.managed_agent_id,
        i.delivery_target,
        i.device_worker_id,
        i.agent_kind,
        i.execution_config,
        i.version,
        i.current_version_id,
        i.entity_ids,
        i.sources,
        i.reaction_script,
        i.organization_id,
        -- Selected version row (pinned current_version unless template_version overrides)
        sv.id as sel_version_id,
        sv.version as sel_version,
        sv.name as sel_version_name,
        sv.description as sel_version_description,
        sv.prompt as sel_version_prompt,
        sv.version_sources as sel_version_version_sources,
        sv.classifiers as sel_version_classifiers,
        sv.outputs as sel_version_outputs,
        sv.reactions_guidance as sel_version_reactions_guidance,
        -- Latest window end for the unprocessedCount bound.
        (SELECT MAX((approved_input->>'window_end')::timestamptz) FROM runs
          WHERE automation_id = i.id AND run_type = 'automation' AND status = 'completed'
            AND action_output IS NOT NULL) as latest_window_end,
        -- Identity scopes for the primary entity (entity_ids[1]) — drives
        -- the entity-link UNION in the unprocessedCount query.
        (SELECT jsonb_agg(jsonb_build_object(
           'namespace', ei.namespace,
           'identifier', ei.identifier,
           'scopeKey', ei.scope_key
         ))
         FROM entity_identities ei
         WHERE ei.entity_id = (i.entity_ids)[1]
           AND ei.deleted_at IS NULL
           AND ei.namespace IN (${namespacesLiteral})
        ) as entity_scopes,
        -- Latest run via lateral
        wr.id as latest_run_id,
        wr.status as automation_run_status,
        wr.outcome as automation_run_outcome,
        wr.error_message as automation_run_error,
        wr.created_at as automation_run_created_at,
        wr.completed_at as automation_run_completed_at
      FROM automations i
      LEFT JOIN automation_versions sv
        ON sv.id = COALESCE(
             $3::bigint,
             (SELECT id FROM automation_versions
                WHERE automation_id = i.automation_group_id
                  AND version = COALESCE($2::int, i.version)
                LIMIT 1)
           )
       AND sv.automation_id = i.automation_group_id
      ${buildLatestAutomationRunJoinSql('i', 'wr')}
      WHERE i.id = $1
    `,
        [args.automation_id, requestedVersion, requestedVersionId]
      )
    : null;

  logger.info(
    { runIds, includeClassificationSummary },
    '[get_automation] Checking classification stats'
  );
  if (runIds.length > 0 && includeClassificationSummary) {
    try {
      logger.info({ runCount: runIds.length }, '[get_automation] Fetching classification stats');
      const statsResult = await sql.unsafe(
        `
        SELECT
          iwc.run_id,
          cc.slug as classifier_slug,
          value as value,
          CAST(COUNT(*) AS INTEGER) as count
        FROM automation_run_events iwc
        JOIN event_classifications cls ON iwc.event_id = cls.event_id
        JOIN classify_facet cc ON cls.classifier_id = cc.id
        CROSS JOIN unnest(cls."values") AS t(value)
        WHERE iwc.run_id IN (${runIds.map((_: unknown, i: number) => `$${i + 1}`).join(', ')})
        GROUP BY iwc.run_id, cc.slug, value
        ORDER BY iwc.run_id, cc.slug, count DESC
      `,
        runIds
      );

      logger.info(
        { statsResultCount: statsResult.length },
        '[get_automation] Got classification stats'
      );
      for (const row of statsResult as unknown as ClassificationStatsRow[]) {
        const runId = ensureNumber(row.run_id);
        let runStats = classificationStatsMap.get(runId);
        if (!runStats) {
          runStats = {};
          classificationStatsMap.set(runId, runStats);
        }
        if (!runStats[row.classifier_slug]) {
          runStats[row.classifier_slug] = {};
        }
        runStats[row.classifier_slug][row.value] = row.count;
      }
      logger.info(
        {
          mapSize: classificationStatsMap.size,
          mapKeys: Array.from(classificationStatsMap.keys()),
        },
        '[get_automation] Classification stats map built'
      );
    } catch (error) {
      // Log but don't fail if classification stats query fails
      logger.warn({ error, runIds }, '[get_automation] Failed to fetch classification stats');
    }
  }

  // ============================================
  // Step 4.6: Await automation details (query fired before classification stats)
  // ============================================

  let automationRow: AutomationQueryRow | null = null;
  if (automationQueryPromise) {
    const automationQuery = await automationQueryPromise;
    automationRow = automationQuery.length > 0 ? (automationQuery[0] as unknown as AutomationQueryRow) : null;
  }

  // ============================================
  // Step 5: Format results
  // ============================================

  // Format windows and include previous window data for trend calculation
  // Windows are sorted by window_start DESC, so "next" in array is "previous" chronologically
  const formattedWindows: AutomationWindow[] = typedWindows.map((w, index, arr) => {
    const previousWindow = arr[index + 1]; // Next in array = previous chronologically
    const runId = ensureNumber(w.run_id);
    const stats = classificationStatsMap.get(runId);
    const extractedData = parseJsonObject(w.extracted_data);
    const previousExtractedData = previousWindow
      ? parseJsonObject(previousWindow.extracted_data)
      : undefined;
    return {
      run_id: ensureNumber(w.run_id),
      automation_id: String(w.automation_id),
      automation_name: w.automation_name,
      // window_start/end and created_at come back from postgres.js as Date
      // objects (raw timestamp columns, no ::text cast), while the outputSchema
      // declares Type.String(). Coerce to ISO so structuredContent validates;
      // window_start/end are NOT NULL, created_at falls back to window_end.
      window_start: ensureIsoString(w.window_start) ?? '',
      window_end: ensureIsoString(w.window_end) ?? '',
      content_analyzed: ensureNumber(w.content_analyzed),
      extracted_data: extractedData,
      previous_extracted_data: previousExtractedData,
      classification_stats: stats,
      model_used: w.model_used ?? '',
      client_id: w.client_id ?? undefined,
      run_metadata: w.run_metadata ?? undefined,
      execution_time_ms: w.execution_time_ms ?? 0,
      created_at: ensureIsoString(w.created_at, w.window_end) ?? '',
      version_id: w.version_id ?? undefined,
      reactions: reactionsMap.get(runId),
    };
  });

  // ============================================
  // Step 6: Fetch automation metadata (for specific automation queries)
  // ============================================

  let automationMetadata: AutomationMetadata | undefined;

  if (args.automation_id && automationRow) {
    const pinnedVersion = automationRow.version;

    // The selected version row (prompt/schema/template) was folded into the
    // automation metadata query above via a `LEFT JOIN automation_versions sv …`,
    // resolved against `args.template_version ?? i.version`. Reads from
    // automationRow directly — no separate round-trip.
    //
    // available_versions list is opt-in (edit sheet) — still its own query.
    // Reads from the group root's chain (automation_group_id) so non-root
    // assignments see the same version history as the root.
    const versionsQuery = args.include_versions
      ? await sql`
          SELECT
            wv.version,
            wv.name,
            wv.created_at,
            (wv.id = ${automationRow.current_version_id}) as is_current
          FROM automation_versions wv
          WHERE wv.automation_id = (
            SELECT automation_group_id FROM automations WHERE id = ${args.automation_id}
          )
          ORDER BY wv.version DESC
        `
      : ([] as unknown[]);

    const version: Record<string, unknown> | null = automationRow.sel_version_id
      ? {
          version_id: automationRow.sel_version_id,
          version: automationRow.sel_version,
          name: automationRow.sel_version_name,
          description: automationRow.sel_version_description,
          prompt: automationRow.sel_version_prompt,
          version_sources: automationRow.sel_version_version_sources,
          classifiers: automationRow.sel_version_classifiers,
          outputs: automationRow.sel_version_outputs,
          reactions_guidance: automationRow.sel_version_reactions_guidance,
        }
      : null;

    const availableVersions: AutomationVersionInfo[] | undefined = args.include_versions
      ? (
          versionsQuery as unknown as Array<{
            version: number;
            name: string;
            created_at: string;
            is_current: boolean;
          }>
        ).map((v) => ({
          version: v.version,
          name: v.name,
          created_at: v.created_at,
          is_current: v.is_current,
        }))
      : undefined;

    // Sources come from automation row (or version if present)
    const automationSources = parseAutomationSources(automationRow.sources);

    // Computed health (item 3, #2033) — derived from the already-selected
    // schedule/run columns plus one bounded recent-run read.
    const automationRunError = automationRow.automation_run_error ?? null;
    const automationId = Number(automationRow.automation_id);
    const recentRunStatuses = await loadRecentAutomationRunStatuses(sql, [automationId]);
    const automationHealth = computeAutomationHealth({
      status: automationRow.status,
      nextRunAt: automationRow.next_run_at,
      consecutiveScheduledFailures:
        automationRow.consecutive_scheduled_failures,
      scheduleAutoPausedAt: automationRow.schedule_auto_paused_at,
      latestRunStatus: automationRow.automation_run_status,
      latestRunCreatedAt: automationRow.automation_run_created_at,
      latestRunError: automationRunError,
      latestRunOutcome: automationRow.automation_run_outcome,
      triggers: automationRow.triggers,
      lastEventActivationAt: automationRow.last_event_activation_at,
      recentTerminalRunStatuses: recentRunStatuses.get(automationId) ?? [],
    });

    automationMetadata = {
      automation_id: String(automationRow.automation_id),
      automation_name: automationRow.name || (version?.name as string) || 'Automation',
      slug: automationRow.slug || '',
      status: automationRow.status as 'active' | 'archived',
      triggers: automationRow.triggers ?? [],
      next_run_at: automationRow.next_run_at,
      consecutive_scheduled_failures:
        automationRow.consecutive_scheduled_failures,
      schedule_auto_paused_at: automationRow.schedule_auto_paused_at,
      managed_agent_id: automationRow.managed_agent_id,
      delivery_target: automationRow.delivery_target ?? null,
      device_worker_id: automationRow.device_worker_id ?? null,
      agent_kind: automationRow.agent_kind ?? null,
      execution_config: automationRow.execution_config ?? null,
      version: pinnedVersion,
      sources: automationSources,
      prompt: version?.prompt as string | undefined,
      description: (version?.description as string) || undefined,
      outputs: (version?.outputs as Outputs | null | undefined) ?? undefined,
      classifiers: (version?.classifiers as unknown[] | null | undefined) ?? undefined,
      reactions_guidance:
        (version?.reactions_guidance as string | null | undefined) ?? undefined,
      ...(availableVersions !== undefined && { available_versions: availableVersions }),
      reaction_script: automationRow.reaction_script || undefined,
      automation_run:
        automationRow.latest_run_id && automationRow.automation_run_status
          ? {
              run_id: Number(automationRow.latest_run_id),
              status: automationRow.automation_run_status as
                | 'pending'
                | 'claimed'
                | 'running'
                | 'completed'
                | 'failed'
                | 'cancelled'
                | 'timeout',
              outcome: (automationRow.automation_run_outcome ?? undefined) as
                | 'infra_error'
                | 'agent_error'
                | 'scoreable'
                | undefined,
              error_message: automationRunError ?? undefined,
              created_at: automationRow.automation_run_created_at,
              completed_at: automationRow.automation_run_completed_at,
            }
          : undefined,
      health: automationHealth.health,
      ...(automationHealth.reasons.length > 0 && {
        health_reasons: automationHealth.reasons,
      }),
      last_scheduling_error: automationHealth.last_scheduling_error,
      last_run_outcome: automationHealth.last_run_outcome,
    };
  }

  // ============================================
  // Step 6.5: Compute pending analysis info
  // ============================================
  // Count content not yet analyzed by any run of this automation.
  // Calculate next window bounds based on schedule
  // Generate processing instructions for client-driven Automation generation

  let pendingAnalysis: PendingAnalysis | undefined;

  if (args.automation_id && automationRow) {
    const automationEntityIds = parseBigintArray(automationRow.entity_ids);
    const automationEntityId = automationEntityIds[0] ?? 0;

    // Identity scopes + latest window end were folded into the automation
    // metadata query above. Read both off automationRow — no extra round-trip.
    // Scopes drive the entity-link UNION (only emit branches for namespaces
    // the entity actually owns); latestEnd bounds the unprocessedCount scan
    // so the planner uses idx_events_entity_ids_occurred_at.
    const entityScopes: EntityIdentityScope[] = (automationRow.entity_scopes ?? []).filter((s) =>
      (STANDARD_IDENTITY_NAMESPACES as readonly string[]).includes(s.namespace)
    );
    const latestEnd = automationRow.latest_window_end;
    // Two entity-link fragments: one with `$1 = automation_id` reserved (for
    // queries that join on the automation's windows), one without (for queries
    // that only need the entity scope). Sharing one fragment and passing a
    // phantom `$1` fails the postgres.js parse step when the entity has zero
    // identity scopes (query has zero placeholders, bind has one).
    const entityLinkAutomationScoped = buildEntityLinkUnion({
      entityIdLiteral: automationEntityId,
      scopes: entityScopes,
      baseParamIndex: 2,
    });
    const entityLinkOnly = buildEntityLinkUnion({
      entityIdLiteral: automationEntityId,
      scopes: entityScopes,
      baseParamIndex: 1,
    });
    const entityScopeCondition = entityLinkAutomationScoped.sql;
    const entityScopeOnlyCondition = entityLinkOnly.sql;
    const entityLinkParams = entityLinkAutomationScoped.params;
    const entityLinkOnlyParams = entityLinkOnly.params;

    // Bound the entity-scoped scans by `f.occurred_at >= latestEnd` only when
    // the automation has actually produced a window. Without the bound the
    // planner walks the entity's full event history; with it, the planner
    // uses `idx_events_entity_ids_occurred_at` for an indexed range scan.
    //
    // For fresh automations (latestEnd === null), bound by 90 days ago. The
    // older "unbounded so the badge reflects the full backlog" path blows
    // the 10s frontend timeout on high-volume entities (e.g. 78K+ events
    // → 9.5s scan, then "Failed to load automation"). 90 days matches the
    // per-month histogram's natural horizon, keeps the scan indexed, and
    // the badge is a notification — not a backlog audit.
    const FRESH_AUTOMATION_LOOKBACK_DAYS = 90;
    const effectiveBound =
      latestEnd ??
      new Date(Date.now() - FRESH_AUTOMATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const occurredAtBound = `f.occurred_at >= $${2 + entityLinkParams.length}::timestamptz`;
    const occurredAtBoundNoAutomation = `f.occurred_at >= $${1 + entityLinkOnlyParams.length}::timestamptz`;
    const automationScopedParams = [args.automation_id, ...entityLinkParams, effectiveBound];
    const noAutomationParams = [...entityLinkOnlyParams, effectiveBound];

    const notInWindowClause = `NOT EXISTS (
        SELECT 1 FROM automation_run_events iwc
        WHERE iwc.event_id = f.id AND iwc.automation_id = $1
      )`;

    // unprocessed_content_count drives the badge ("N pending analysis"). Cap the
    // scan at 1000 rows: the badge shows "1000+" semantics above that, and
    // the cap keeps the page query under the 10s frontend timeout even on
    // entities with 100K+ events in the lookback window. The 90-day bound
    // above lets the planner pick `idx_events_entity_ids_occurred_at`, but
    // on a high-volume entity that index range still has ~78K rows; the
    // LIMIT short-circuits row fetches once we've passed the cap.
    //
    // monthlyContent / monthlyLinked build the per-month histogram for
    // unprocessed_ranges, only used inside the (collapsed-by-default) summary
    // view. Off by default; the summary expand path sets include_pending_ranges
    // to true.
    const UNPROCESSED_COUNT_CAP = 1000;
    const unprocessedCountPromise = sql.unsafe(
      `SELECT CAST(COUNT(*) AS INTEGER) as count FROM (
        SELECT 1
        FROM current_event_records f
        WHERE ${entityScopeCondition}
          ${occurredAtBound ? `AND ${occurredAtBound}` : ''}
          AND ${notInWindowClause}
        LIMIT ${UNPROCESSED_COUNT_CAP}
      ) capped`,
      automationScopedParams
    );

    const histogramPromise = args.include_pending_ranges
      ? Promise.all([
          sql.unsafe(
            `SELECT DATE_TRUNC('month', f.occurred_at) as month, COUNT(*) as total
              FROM current_event_records f
              WHERE ${entityScopeOnlyCondition}
                ${occurredAtBoundNoAutomation ? `AND ${occurredAtBoundNoAutomation}` : ''}
              GROUP BY DATE_TRUNC('month', f.occurred_at)
              ORDER BY month`,
            noAutomationParams
          ),
          sql.unsafe(
            `SELECT DATE_TRUNC('month', f.occurred_at) as month, COUNT(DISTINCT f.id) as linked
              FROM current_event_records f
              JOIN automation_run_events iwc ON f.id = iwc.event_id
              WHERE ${entityScopeCondition}
                ${occurredAtBound ? `AND ${occurredAtBound}` : ''}
                AND iwc.automation_id = $1
              GROUP BY DATE_TRUNC('month', f.occurred_at)`,
            automationScopedParams
          ),
        ])
      : Promise.resolve([[], []] as [unknown[], unknown[]]);

    const [unprocessedCountResult, [monthlyContentResult, monthlyLinkedResult]] = await Promise.all(
      [unprocessedCountPromise, histogramPromise]
    );

    const unprocessedContentCount = Number(unprocessedCountResult[0]?.count ?? 0);

    // The arrival range a claim would hand out. Read without a lock or a seed:
    // a status surface must not move the mark it is reporting.
    const pending = await readPendingWindow(sql, Number(args.automation_id));
    const nextWindow: PendingAnalysis['next_window'] =
      pending && pending.windowEnd > pending.windowStart
        ? {
            start: pending.windowStart.toISOString(),
            end: pending.windowEnd.toISOString(),
          }
        : null;

    const unprocessedRanges = args.include_pending_ranges
      ? foldUnprocessedRanges(
          monthlyContentResult as Array<{ month: string; total: number | string }>,
          monthlyLinkedResult as Array<{ month: string; linked: number | string }>,
          false
        )
      : [];

    // Generate structured next_action for MCP clients
    const nextAction = nextWindow
      ? {
          tool: 'client.automations.claimNextWindow',
          params: {
            automation_id: args.automation_id,
          },
          description:
            'Atomically claim this completed period and receive bounded context plus window_token.',
        }
      : null;

    pendingAnalysis = {
      unprocessed_content_count: unprocessedContentCount,
      next_window: nextWindow,
      next_action: nextAction,
      unprocessed_ranges: unprocessedRanges.length > 0 ? unprocessedRanges : undefined,
    };

  }

  // ============================================
  // Step 7: Diagnostic warnings for the no-windows case
  // ============================================
  // Replaces the previous cold-path block (an `automations` re-fetch + a
  // 5-table-join entity_context aggregate that ran ~20s/call in prod for
  // entities with any volume — measured via pg_stat_statements). Both
  // produced fields (`automation_statuses`, `entity_context`) had zero UI
  // consumers; the only live output was the warnings, which we can derive
  // from data already in scope.

  const warnings: string[] = [];

  if (formattedWindows.length === 0 && automationRow) {
    if (automationRow.status === 'archived') {
      warnings.push(`Automation "${automationRow.name ?? args.automation_id}" is archived.`);
    } else {
      warnings.push(`Automation "${automationRow.name ?? args.automation_id}" has no windows yet.`);
    }
  }

  // ============================================
  // Step 8: Return results with diagnostic info
  // ============================================

  const organizationSlug = automationRow?.organization_id
    ? await getOrganizationSlug(automationRow.organization_id)
    : null;
  // Workspace-level route: agentless (device-pinned / manual-only) Automations
  // get the same link as agent-owned ones.
  const viewUrl = organizationSlug
    ? buildAutomationUrl(organizationSlug, args.automation_id, baseUrl)
    : undefined;

  const result: GetAutomationResult = {
    windows: formattedWindows,
    ...(automationMetadata && { automation: automationMetadata }),
    ...(pendingAnalysis && { pending_analysis: pendingAnalysis }),
    pagination: {
      page,
      page_size: pageSize,
      total: totalCount,
    },
    metadata: {
      query_type: args.automation_id ? 'specific' : 'all_for_entity',
      date_range: {
        content_since: parsedSince || null,
        content_until: parsedUntil || null,
      },
    },
    ...(warnings.length > 0 && { warnings }),
    ...(viewUrl && { view_url: viewUrl }),
  };

  return result;
}
