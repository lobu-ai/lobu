/**
 * Tool: metric_series
 *
 * Generic read-only SQL endpoint for dashboard sparklines + stat chips.
 * The caller passes a single SELECT (or WITH … SELECT) returning N columns
 * of time-bucketed values. The query goes through the same
 * `validateAndScopeQuery` guard as `query_sql`, plus a few endpoint-local
 * defense layers:
 *
 *   - prefix check: only `SELECT` or `WITH` are accepted (no DML/DDL prefix)
 *   - validateAndScopeQuery: parser-validated, table allowlist, sensitive
 *     column blocklist, user `$N` rejection, auto-scoped via CTEs that
 *     inject `WHERE organization_id = $1` per referenced table
 *   - server-injected `$1`: caller can't choose which org to query
 *   - statement timeout: 5s, enforced via SET LOCAL inside a transaction
 *   - hard row cap: queries returning more than MAX_ROWS rows are rejected
 *
 * Returns `{ columns: string[], rows: unknown[][], data_quality }`, where
 * `data_quality` reports NULL/unparseable/out-of-range bucket timestamps
 * against a bounded valid range (default 2000-01-01 … now+1d, overridable via
 * `start`/`end`). `exclude_invalid_timestamps` drops the flagged rows and
 * `strict` fails the call instead (#2051). Also exposed as
 * `client.metrics.series` in the ClientSDK and on the MCP agent surface.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { isReadQuery, validateAndScopeQuery } from '../../utils/execute-data-sources';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { isAdminOrOwnerRole, isInProcessSystemCall } from '../access-control';

export const MetricSeriesSchema = Type.Object({
  sql: Type.String({
    description:
      'A single SELECT (or WITH … SELECT) returning a bucket column plus one or more numeric stat columns. Table references are auto-scoped to the caller\'s organization; `$1` is the organization id (injected — do not pass it).',
  }),
  time_column: Type.Optional(
    Type.String({
      description:
        'Name of the time-bucket column to run data-quality checks against. Defaults to the first column whose name looks temporal (bucket, time, date, *_at, …).',
    })
  ),
  start: Type.Optional(
    Type.String({
      description:
        'Inclusive lower bound (ISO 8601) of the valid time range for the bucket column. Buckets before this are counted as out-of-range. Default 2000-01-01T00:00:00Z.',
    })
  ),
  end: Type.Optional(
    Type.String({
      description:
        'Exclusive upper bound (ISO 8601) of the valid time range for the bucket column. Buckets at/after this are counted as out-of-range. Default now + 1 day.',
    })
  ),
  exclude_invalid_timestamps: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        'Drop rows whose bucket timestamp is NULL, unparseable, or outside the valid range instead of returning them. Counts are still reported in data_quality.',
    })
  ),
  strict: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        'Fail the call if any NULL/unparseable/out-of-range bucket timestamps are found.',
    })
  ),
});

type MetricSeriesArgs = Static<typeof MetricSeriesSchema>;

// Statement timeout in ms. Dashboards refresh frequently — keep tight.
const STATEMENT_TIMEOUT_MS = 5000;

// Hard cap on returned rows. Sparklines need ≤ ~365; anything orders of
// magnitude larger is misuse or a runaway query, so refuse rather than ship
// megabytes back to the client.
const MAX_ROWS = 2000;


/**
 * Default floor of the valid bucket range. Org operational data predating 2000
 * is, in practice, a NULL-ish sentinel (epoch timestamps from unset fields) —
 * the production incident behind #2051 charted a 1970 bucket and future buckets
 * through 2056 without any warning.
 */
const DEFAULT_RANGE_START_MS = Date.parse('2000-01-01T00:00:00Z');
/** Default ceiling slack: buckets more than a day in the future are outliers. */
const DEFAULT_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** Column names that plausibly hold the series' time bucket. */
const TIME_COLUMN_PATTERN =
  /^(bucket|time|date|day|week|month|hour|minute|ts|timestamp)$|(_at|_date|_time|_day|_ts|_bucket)$/i;

/** Data-quality report for the detected/declared time-bucket column. */
export interface MetricSeriesDataQuality {
  /** Column the checks ran against; null when no temporal column was found. */
  time_column: string | null;
  /** Rows whose bucket value is NULL. */
  null_timestamps: number;
  /** Rows whose bucket value could not be parsed as a timestamp. */
  invalid_timestamps: number;
  /** Rows whose bucket falls outside [range.start, range.end). */
  out_of_range: number;
  /** Valid range the buckets were checked against. */
  range: { start: string; end: string } | null;
  /** True when flagged rows were dropped (exclude_invalid_timestamps). */
  excluded: boolean;
}

interface MetricSeriesResult {
  columns: string[];
  rows: unknown[][];
  data_quality: MetricSeriesDataQuality;
}

/**
 * Parse a bucket cell into epoch ms. postgres.js runs with `fetch_types:false`,
 * so timestamptz values arrive as strings like `2026-07-20 00:00:00+00`;
 * normalize to ISO before falling back to raw Date.parse.
 */
function parseBucketValue(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string' || value.length === 0) return null;
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return direct;
  const normalized = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(normalized) ? null : normalized;
}

export const metricSeries = withValidatedArgs('metric_series', MetricSeriesSchema, metricSeriesImpl);

async function metricSeriesImpl(
  args: MetricSeriesArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<MetricSeriesResult> {
  const orgId = ctx.organizationId;
  if (!orgId) {
    throw new Error('metric_series: caller must be scoped to an organization');
  }

  if (!isReadQuery(args.sql)) {
    throw new ToolUserError('metric_series: only SELECT or WITH … SELECT queries are accepted');
  }

  // Resolve the valid bucket range up front so a bad bound is a clean caller
  // error before any SQL runs.
  const rangeStartMs = args.start != null ? Date.parse(args.start) : DEFAULT_RANGE_START_MS;
  const rangeEndMs = args.end != null ? Date.parse(args.end) : Date.now() + DEFAULT_FUTURE_SLACK_MS;
  if (Number.isNaN(rangeStartMs)) {
    throw new ToolUserError(`metric_series: start must be an ISO 8601 timestamp (got '${args.start}')`);
  }
  if (Number.isNaN(rangeEndMs)) {
    throw new ToolUserError(`metric_series: end must be an ISO 8601 timestamp (got '${args.end}')`);
  }
  if (rangeEndMs <= rangeStartMs) {
    throw new ToolUserError('metric_series: end must be after start');
  }

  // Members may chart their org's operational data; the auth/identity tables
  // (oauth_tokens, oauth_clients, user) stay admin-only.
  const isAdmin = isAdminOrOwnerRole(ctx.memberRole);
  const { sql: scopedSql, params } = validateAndScopeQuery(args.sql, orgId, {
    // Emit the safe column allowlist (not SELECT *) so a member charting e.g.
    // `connections` can't pull credential columns the allowlist withholds.
    safeColumns: SAFE_COLUMN_DEFS,
    restrictedTables: isAdmin ? undefined : ADMIN_ONLY_QUERYABLE_TABLES,
    // Charts are filtered to the requesting user's connection visibility, so a
    // member can't sparkline another user's private-connection events.
    userId: ctx.userId,
    // Workspace-identity audit rows are owner/admin/system-only; ordinary
    // members must not chart member/invitation lifecycle data via raw SQL.
    excludeWorkspaceAudit: !isInProcessSystemCall(ctx) && !isAdmin,
    // $member entity rows carry PII reserved by the manage_entity read
    // policy; ordinary members must not bypass it via raw SQL.
    excludeMemberEntities: !isInProcessSystemCall(ctx) && !isAdmin,
  });
  const db = getDb();

  // Run inside a transaction so SET LOCAL applies for the user query only.
  // `SET LOCAL` doesn't accept prepared parameters, so the timeout literal is
  // interpolated directly (safe — it's a module-level number).
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.begin(async (tx) => {
      // READ ONLY first: a data-modifying CTE (`WITH x AS (DELETE … RETURNING …)
      // SELECT …`) passes the SELECT/WITH guard, so the DB must refuse the write.
      // Mirrors query_sql; without it this read-tier endpoint could mutate.
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return tx.unsafe(scopedSql, params as unknown[]);
    })) as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err, orgId }, '[metric_series] query failed');
    throw err;
  }

  if (rows.length > MAX_ROWS) {
    throw new ToolUserError(
      `metric_series: query returned ${rows.length} rows (cap ${MAX_ROWS}). Bucket the result further or narrow the time window.`
    );
  }

  const emptyQuality = (timeColumn: string | null): MetricSeriesDataQuality => ({
    time_column: timeColumn,
    null_timestamps: 0,
    invalid_timestamps: 0,
    out_of_range: 0,
    range: timeColumn
      ? { start: new Date(rangeStartMs).toISOString(), end: new Date(rangeEndMs).toISOString() }
      : null,
    excluded: false,
  });

  // postgres.js returns Array<Record<column, value>>. Flatten to a tabular
  // result so the frontend doesn't have to know column order.
  if (rows.length === 0) {
    return { columns: [], rows: [], data_quality: emptyQuality(args.time_column ?? null) };
  }
  const columns = Object.keys(rows[0]);

  // Identify the bucket column: explicit `time_column` wins; otherwise the
  // first column whose name looks temporal. Series without one (plain stat
  // chips) skip the timestamp checks entirely.
  let timeColumn: string | null = null;
  if (args.time_column != null) {
    if (!columns.includes(args.time_column)) {
      throw new ToolUserError(
        `metric_series: time_column '${args.time_column}' is not in the result columns (${columns.join(', ')})`
      );
    }
    timeColumn = args.time_column;
  } else {
    timeColumn = columns.find((c) => TIME_COLUMN_PATTERN.test(c)) ?? null;
  }

  const quality = emptyQuality(timeColumn);
  let keptRows = rows;
  if (timeColumn) {
    const col = timeColumn;
    const isValidBucket = (row: Record<string, unknown>): boolean => {
      const raw = row[col];
      if (raw == null) {
        quality.null_timestamps++;
        return false;
      }
      const ms = parseBucketValue(raw);
      if (ms == null) {
        quality.invalid_timestamps++;
        return false;
      }
      if (ms < rangeStartMs || ms >= rangeEndMs) {
        quality.out_of_range++;
        return false;
      }
      return true;
    };
    const valid = rows.filter(isValidBucket);
    const flagged = quality.null_timestamps + quality.invalid_timestamps + quality.out_of_range;
    if (flagged > 0 && args.strict) {
      throw new ToolUserError(
        `metric_series: strict mode — ${flagged} bucket timestamp(s) are NULL, unparseable, or out-of-range ` +
          `(null: ${quality.null_timestamps}, invalid: ${quality.invalid_timestamps}, out-of-range: ${quality.out_of_range}; ` +
          `valid range ${quality.range?.start} … ${quality.range?.end}). ` +
          'Fix the query bounds or pass exclude_invalid_timestamps to drop them.'
      );
    }
    if (args.exclude_invalid_timestamps) {
      keptRows = valid;
      quality.excluded = true;
    }
  }

  const tabular = keptRows.map((r) => columns.map((c) => r[c]));
  return { columns, rows: tabular, data_quality: quality };
}
