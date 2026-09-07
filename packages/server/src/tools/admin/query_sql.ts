/**
 * Tool: query_sql
 *
 * Server-side paginated, sortable, searchable table queries.
 * SQL is auto-scoped to the caller's organization via CTE wrapping.
 * Table references are validated against an allowlist.
 */

import { type Static, Type } from '@sinclair/typebox';
import { authzScopeFromToolContext } from '../../authz/scope';
import { getDb } from '../../db/client';
import { classifyPushdownFailure, runConnectorQuery } from '../../lib/connector-pushdown';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { raceAbort } from '../../utils/race-abort';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { SortOrderField } from './schemas/common-fields';
import { isAdminOrOwnerRole, isInProcessSystemCall } from '../access-control';
import { classifyToolError, getErrorMessage, isRetryable, type ToolErrorCode } from "@lobu/core";
import { ToolUserError } from '../../utils/errors';
import {
  QUERY_SQL_RESULT_MAX_BYTES,
  finalizeDynamicQueryRows,
} from '../../utils/content-read-bounds';

export const QuerySqlSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        'Optional human-friendly heading for this result (e.g. "Recent support tickets"). When set, the UI renders it in the query result summary.',
      maxLength: 200,
    })
  ),
  sql: Type.String({
    minLength: 1,
    description:
      'Base SELECT query. Table references are auto-scoped to your organization. It is wrapped as a subquery, so ORDER BY / LIMIT / window functions inside it are fine; pagination + sort are added on the outside via sort_by/limit/offset.',
  }),
  connection: Type.Optional(
    Type.String({
      description:
        'Optional connection slug. When set, `sql` runs LIVE (read-only) against that connection’s external database via its connector (pushdown), and the internal org-scoping is skipped. When unset, the query runs over your org’s internal tables.',
    })
  ),
  org_slug: Type.Optional(
    Type.String({
      description:
        'Optional. Only honored on the unscoped `/mcp` endpoint with OAuth auth. Rejected for PAT auth, browser-session auth, and scoped `/mcp/{slug}` connections — re-connect to the target workspace instead.',
    })
  ),
  sort_by: Type.Optional(
    Type.String({
      description: 'Column name to sort by. Omit to return rows unordered (e.g. a view whose columns you don\'t know upfront).',
    })
  ),
  sort_order: SortOrderField('Sort direction. Default: asc.'),
  limit: Type.Optional(
    Type.Number({
      description: 'Rows per page (1–500). Default: 50.',
      minimum: 1,
      maximum: 500,
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: 'Row offset for pagination. Default: 0.',
      minimum: 0,
    })
  ),
  search_term: Type.Optional(
    Type.String({
      description: 'ILIKE search value for an internal SQL query.',
    })
  ),
  search_columns: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Columns to search across (required when search_term is set).',
    })
  ),
});

type QuerySqlArgs = Static<typeof QuerySqlSchema>;

const COLUMN_NAME_RE = /^[a-zA-Z_]\w*$/;

const PG_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

function oidToTypeName(oid: number): string {
  return PG_OID_TYPE_MAP[oid] ?? 'unknown';
}

export const QuerySqlResultSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description: 'The caller-supplied human-friendly heading for this result, echoed back for the UI.',
      maxLength: 200,
    })
  ),
  sql: Type.Optional(
    Type.String({
      description:
        'The original caller-supplied SQL statement. This is never the tenant-scoped SQL rewritten by Lobu.',
    })
  ),
  rows: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
    description:
      'Returned rows. String cells longer than 4,000 Unicode code points contain the 4,000-character head followed by the literal suffix "… [truncated]". payload_text and text_content also receive content_length and payload_truncated sidecars.',
  }),
  columns: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
    })
  ),
  total_count: Type.Integer(),
  has_more: Type.Boolean(),
  omitted_rows: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Rows fetched for this page but omitted by the serialized response-size ceiling. When rows are present, continue from offset + rows.length rather than offset + limit. If no bounded row fits, query_sql returns a VALIDATION error and the projection must be narrowed.',
    })
  ),
  execution_time_ms: Type.Number(),
  error: Type.Optional(Type.String()),
  error_code: Type.Optional(Type.String()),
  retryable: Type.Optional(Type.Boolean()),
});

interface QuerySqlResult {
  title?: string;
  sql?: string;
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
  omitted_rows?: number;
  execution_time_ms: number;
  error?: string;
  /** Structured error code (lobu#2051 Item 2), set alongside `error`. */
  error_code?: ToolErrorCode;
  /** Whether retrying the identical query may succeed. Advisory for the agent. */
  retryable?: boolean;
}

/**
 * Final response chokepoint for every QuerySqlResult branch, including soft
 * validation/database errors. Successful database/source columns remain typed;
 * only oversized final cells are replaced.
 */
function finalizeQuerySqlResult(
  result: QuerySqlResult,
  maxSerializedResultBytes = QUERY_SQL_RESULT_MAX_BYTES
): QuerySqlResult {
  const additiveColumns = [
    ['payload_truncated', 'boolean'],
    ['content_length', 'integer'],
    ['attachments_truncated', 'boolean'],
    ['attachments_bytes', 'integer'],
  ] as const;
  const possibleColumns = [...result.columns];
  const possibleColumnNames = new Set(possibleColumns.map((column) => column.name));
  if (result.rows.length > 0) {
    for (const [name, type] of additiveColumns) {
      if (possibleColumnNames.has(name)) continue;
      possibleColumns.push({ name, type });
      possibleColumnNames.add(name);
    }
  }

  // Reserve the complete response envelope before admitting rows. The
  // possible sidecars and omitted_rows are deliberately pessimistic; the
  // actual response can only be smaller than this budget calculation.
  const envelope = {
    ...result,
    rows: [],
    columns: possibleColumns,
    has_more: false,
    ...(result.rows.length > 0 ? { omitted_rows: result.rows.length } : {}),
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8') - 2; // []
  const maxSerializedRowsBytes = maxSerializedResultBytes - envelopeBytes;
  const resultTooLarge = (message: string, totalCount = result.total_count): QuerySqlResult => ({
    ...(result.title ? { title: result.title } : {}),
    rows: [],
    columns: [],
    total_count: totalCount,
    has_more: false,
    ...(result.rows.length > 0 ? { omitted_rows: result.rows.length } : {}),
    execution_time_ms: result.execution_time_ms,
    error: message,
    error_code: 'VALIDATION',
    retryable: false,
  });
  if (maxSerializedRowsBytes < 2) {
    return resultTooLarge(
      `The query_sql response envelope exceeds the strict ${QUERY_SQL_RESULT_MAX_BYTES}-byte ceiling. Select fewer columns or use a shorter query and retry.`
    );
  }

  const finalized = finalizeDynamicQueryRows(result.rows, maxSerializedRowsBytes);
  if (finalized.sidecarCollisions.length > 0) {
    return {
      ...(result.title ? { title: result.title } : {}),
      rows: [],
      columns: [],
      total_count: 0,
      has_more: false,
      execution_time_ms: result.execution_time_ms,
      error:
        'query_sql cannot add truncation metadata because the projection defines ' +
        `incompatible sidecar column(s): ${finalized.sidecarCollisions.join(', ')}. ` +
        'Rename those aliases and retry.',
      error_code: 'VALIDATION',
      retryable: false,
    };
  }
  if (finalized.rows.length === 0 && finalized.omittedRows > 0) {
    return resultTooLarge(
      `The first bounded row exceeds the strict ${QUERY_SQL_RESULT_MAX_BYTES}-byte ` +
        'query_sql response ceiling. Select fewer or narrower columns and retry.'
    );
  }
  const columns = [...result.columns];
  const known = new Set(columns.map((column) => column.name));
  for (const [name, type] of additiveColumns) {
    if (known.has(name) || !finalized.rows.some((row) => name in row)) continue;
    columns.push({ name, type });
    known.add(name);
  }
  const response = {
    ...result,
    rows: finalized.rows,
    columns,
    has_more: result.has_more || finalized.omittedRows > 0,
    ...(finalized.omittedRows > 0 ? { omitted_rows: finalized.omittedRows } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > maxSerializedResultBytes) {
    return resultTooLarge(
      `The query_sql response exceeds the strict ${QUERY_SQL_RESULT_MAX_BYTES}-byte ceiling. Select fewer or narrower columns and retry.`
    );
  }
  return response;
}

// Cost-attribution ledger: a single expensive user/derived query is how an org
// degrades the shared DB for everyone (precedent: the 3.5s subscription view).
// Anything at or above this gets an alertable, structured entry so expensive
// queries can be rolled up per org in Loki and cross-referenced against
// pg_stat_statements for the normalized SQL.
const SLOW_QUERY_COST_MS = 500;

/**
 * Coerce + clamp the page bounds. TypeBox schemas aren't runtime-validated in
 * this codebase, so a non-number limit/offset would otherwise interpolate as a
 * string into raw SQL and bypass the intended bounds. Shared by the internal and
 * external (connection pushdown) branches.
 */
function coercePageBounds(
  args: QuerySqlArgs
): { limit: number; offset: number } | { error: string } {
  const rawLimit = Number(args.limit ?? 50);
  const rawOffset = Number(args.offset ?? 0);
  if (!Number.isFinite(rawLimit) || !Number.isFinite(rawOffset)) {
    return { error: 'limit and offset must be numbers.' };
  }
  return {
    limit: Math.max(1, Math.min(500, Math.trunc(rawLimit))),
    offset: Math.max(0, Math.trunc(rawOffset)),
  };
}

/**
 * A soft-error result (lobu#2051 Item 2). `code` defaults to `VALIDATION` because
 * every non-DB-catch call site here is an argument/scope fault (bad column, unknown
 * org, malformed query) — none of those are retryable. The DB catch and the
 * timeout path pass explicit codes.
 */
function errorResult(
  message: string,
  startTime: number,
  code: ToolErrorCode = 'VALIDATION'
): QuerySqlResult {
  return {
    rows: [],
    columns: [],
    total_count: 0,
    has_more: false,
    execution_time_ms: Date.now() - startTime,
    error: message,
    error_code: code,
    retryable: isRetryable(code),
  };
}

export const querySql = withValidatedArgs('query_sql', QuerySqlSchema, querySqlImpl);

export async function querySqlImpl(
  args: QuerySqlArgs,
  _env: unknown,
  ctx: ToolContext,
  options?: {
    maxSerializedResultBytes?: number;
    /**
     * Internal-only exact-match filter (NOT on the agent-facing schema). Keeps
     * the first non-null of `columns` on each row, trimmed, and compares it to
     * `value` as a bound parameter. Read via `to_jsonb(...)->>` so a column the
     * query doesn't project yields NULL and falls through instead of raising
     * `undefined column` — that mirrors the caller's `a ?? b` semantics without
     * needing to know the projection. Internal path only: pushdown hands raw
     * SQL to the connector, whose dialect we can't assume.
     */
    exactMatch?: { columns: string[]; value: string };
  }
): Promise<QuerySqlResult> {
  const startTime = Date.now();
  const title = args.title?.trim() || undefined;
  const fail = (message: string, code?: ToolErrorCode): QuerySqlResult =>
    finalizeQuerySqlResult(
      {
        ...(title ? { title } : {}),
        ...errorResult(message, startTime, code),
      },
      options?.maxSerializedResultBytes
    );

  const baseSql = args.sql.trim();

  // The base query is wrapped as `SELECT * FROM (<sql>) _t [ORDER BY …] LIMIT …`,
  // so an ORDER BY / LIMIT / window inside the caller's SQL is valid (it sits in
  // the subquery). A derived view's backing_sql commonly has `OVER (ORDER BY …)`.

  // sort_by is optional: omit it for a view whose columns aren't known upfront.
  if (args.sort_by !== undefined && !COLUMN_NAME_RE.test(args.sort_by)) {
    return fail(`Invalid sort_by column name: ${args.sort_by}`);
  }

  // search_columns only filters in concert with search_term — passing it alone
  // is a silent no-op on both the internal and external paths, which reads as
  // "a filter was applied" when none was. Reject it so the caller notices.
  if (args.search_columns?.length && !args.search_term) {
    return fail(
      'search_columns has no effect without search_term — set search_term to filter, or drop search_columns.'
    );
  }

  // Dispatch resolves explicit targets before this workspace handler runs.
  const targetOrgId = ctx.organizationId;
  const callerIsAdmin = isAdminOrOwnerRole(ctx.memberRole);

  // External pushdown: when a connection is named, the SQL runs LIVE against that
  // connection's database via its connector (no internal org-scoping — it's the
  // org's own DB, read-only). The connection is resolved org-scoped inside
  // runConnectorQuery; access is bounded by the connection's read-only DB role.
  if (args.connection) {
    if (args.search_term) {
      return fail(
        'search_term is not supported with an external connection — use search_memory.'
      );
    }
    if (options?.exactMatch) {
      return fail(
        'exactMatch is not supported with an external connection — the connector owns its dialect.'
      );
    }
    const bounds = coercePageBounds(args);
    if ('error' in bounds) return fail(bounds.error);
    const { limit, offset } = bounds;
    try {
      const r = await runConnectorQuery({
        scope: authzScopeFromToolContext({ organizationId: targetOrgId, userId: ctx.userId }),
        isAdmin: callerIsAdmin,
        connectionSlug: args.connection,
        query: baseSql,
        limit,
        offset,
        sort: args.sort_by
          ? { column: args.sort_by, order: args.sort_order === 'desc' ? 'desc' : 'asc' }
          : undefined,
      });
      return finalizeQuerySqlResult(
        {
          ...(title ? { title } : {}),
          sql: baseSql,
          rows: r.rows,
          columns: r.columns,
          total_count: r.total ?? r.rows.length,
          has_more: r.total !== undefined ? offset + limit < r.total : r.rows.length >= limit,
          execution_time_ms: Date.now() - startTime,
        },
        options?.maxSerializedResultBytes
      );
    } catch (err) {
      // A pushdown failure is a hard tool
      // error, never a success-shaped empty table (#2042).
      throw new ToolUserError(
        `connection pushdown failed (connection=${args.connection}): ${getErrorMessage(err)}. ` +
          'The query did not run against the source — this is not an empty result.',
        502,
        classifyPushdownFailure(err)
      );
    }
  }

  // Validate, parse, and org-scope the query
  let scopedSql: string;
  let params: unknown[];
  let tableRefs: string[];
  try {
    const scoped = validateAndScopeQuery(baseSql, targetOrgId, {
      safeColumns: SAFE_COLUMN_DEFS,
      restrictedTables: callerIsAdmin ? undefined : ADMIN_ONLY_QUERYABLE_TABLES,
      // Per-user connection visibility: even an admin sees another user's
      // PRIVATE-connection events only when org-visible. Cross-org reuses the
      // same global user id, re-validated against the target org above.
      userId: ctx.userId,
      // Workspace-identity audit rows are owner/admin/system-only; ordinary
      // members must not select their member/invitation lifecycle data via raw SQL.
      excludeWorkspaceAudit: !isInProcessSystemCall(ctx) && !callerIsAdmin,
    });
    scopedSql = scoped.sql;
    params = scoped.params;
    tableRefs = scoped.tableRefs;
  } catch (err) {
    return fail(getErrorMessage(err));
  }

  // Build search + exact-match WHERE clause
  const whereClauses: string[] = [];
  if (args.search_term) {
    if (!args.search_columns?.length) {
      return fail('search_columns is required when search_term is set.');
    }
    for (const col of args.search_columns) {
      if (!COLUMN_NAME_RE.test(col)) {
        return fail(`Invalid search column name: ${col}`);
      }
    }
    const searchParamRef = `$${params.length + 1}`;
    params.push(`%${args.search_term.toLowerCase()}%`);
    const orClauses = args.search_columns.map((col) => `lower("${col}") LIKE ${searchParamRef}`);
    whereClauses.push(`(${orClauses.join(' OR ')})`);
  }
  if (options?.exactMatch) {
    const { columns, value } = options.exactMatch;
    if (!columns.length) {
      return fail('exactMatch.columns must not be empty.');
    }
    for (const col of columns) {
      if (!COLUMN_NAME_RE.test(col)) {
        return fail(`Invalid exact-match column name: ${col}`);
      }
    }
    const matchParamRef = `$${params.length + 1}`;
    params.push(value);
    const coalesced = columns.map((col) => `to_jsonb(_t)->>'${col}'`).join(', ');
    // Trim the same character set JS `String.prototype.trim` strips, so a
    // tab/newline-padded value still matches: bare `btrim` strips spaces only,
    // which would 404 a row the in-memory match resolved. (JS also strips
    // Unicode spaces such as U+00A0; a value padded with those falls through to
    // the caller's `derivedRowSlug` confirm and 404s rather than mis-resolving.)
    whereClauses.push(`btrim(COALESCE(${coalesced}), E' \\t\\n\\r\\f\\v') = ${matchParamRef}`);
  }
  const searchWhere = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sortOrder = args.sort_order === 'desc' ? 'DESC' : 'ASC';
  const bounds = coercePageBounds(args);
  if ('error' in bounds) return fail(bounds.error);
  const { limit, offset } = bounds;

  const orderBy = args.sort_by ? `ORDER BY "${args.sort_by}" ${sortOrder}` : '';
  // Single execution: the scoped subquery can be expensive (derived entity views
  // aggregate large event ranges), so run it ONCE and take the total from a
  // window count instead of a second full `SELECT count(*) FROM (subquery)`
  // pass. Windows evaluate before LIMIT, so the count covers the full filtered
  // set exactly like the old separate COUNT did. Two fallbacks keep the exact
  // legacy contract: an empty/out-of-range page carries no row to bear the
  // window count (run the explicit COUNT then), and if the caller's own query
  // projects a column named like the internal window alias, re-run the plain
  // two-query shape rather than clobber their column.
  const TOTAL_COL = '__lobu_total_count__';
  const countSql = `SELECT count(*)::int AS c FROM (${scopedSql}) AS _t ${searchWhere}`;
  const dataSql = `SELECT *, COUNT(*) OVER () AS "${TOTAL_COL}" FROM (${scopedSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  const plainDataSql = `SELECT * FROM (${scopedSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  try {
    const sql = getDb();
    // Race the DB transaction against the sandbox abort signal so the handler
    // returns promptly when the script times out. The 5s `statement_timeout`
    // is the actual hard cap on the postgres side (postgres.js doesn't expose
    // an AbortSignal hook); raceAbort just unblocks the awaiting caller.
    const txPromise = sql.begin(async (tx: typeof sql) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const data = await tx.unsafe(dataSql, params);
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      // Duplicate TOTAL_COL in the result columns means the caller's query
      // itself projects that name — fall back to the classic two-query shape
      // so the caller's column survives untouched.
      const aliasCollision =
        ((data as any)?.columns ?? []).filter((col: { name: string }) => col.name === TOTAL_COL)
          .length > 1;
      // An empty exact-match page needs no count: the caller reads `rows`, never
      // `total_count`, and the whole point of pushing the match into SQL is that
      // a MISS executes the backing SQL exactly once.
      if (rows.length === 0 && options?.exactMatch && !aliasCollision) {
        return { rows, columns: (data as any)?.columns, totalCount: 0, columnsHaveWindowCol: true };
      }
      if (rows.length === 0 || aliasCollision) {
        const cnt = await tx.unsafe(countSql, params);
        const totalCount = Number(cnt[0]?.c ?? 0);
        if (aliasCollision) {
          const plain = await tx.unsafe(plainDataSql, params);
          return {
            rows: plain,
            columns: (plain as any)?.columns,
            totalCount,
            columnsHaveWindowCol: false,
          };
        }
        // Empty page: columns still come from the window query, so the
        // internal alias must be stripped from them too.
        return { rows, columns: (data as any)?.columns, totalCount, columnsHaveWindowCol: true };
      }
      return {
        rows,
        columns: (data as any)?.columns,
        totalCount: Number(rows[0][TOTAL_COL]) || 0,
        stripWindowCol: true,
        columnsHaveWindowCol: true,
      };
    });
    const result = await raceAbort(txPromise, ctx.abortSignal);

    const rawRows = result.rows as Array<Record<string, unknown>>;
    const totalCount = result.totalCount;
    const rows = result.stripWindowCol
      ? rawRows.map((row) => {
          const { [TOTAL_COL]: _total, ...rest } = row;
          return rest;
        })
      : rawRows;

    const columns = (result.columns ?? [])
      .filter((col: { name: string }) => !(result.columnsHaveWindowCol && col.name === TOTAL_COL))
      .map(
        (col: { name: string; type: number }) => ({
          name: col.name,
          type: oidToTypeName(col.type),
        })
      );

    const executionTimeMs = Date.now() - startTime;
    if (executionTimeMs >= SLOW_QUERY_COST_MS) {
      logger.warn(
        {
          org_id: targetOrgId,
          user_id: ctx.userId,
          execution_time_ms: executionTimeMs,
          row_count: rows.length,
          total_count: totalCount,
          tables: tableRefs,
        },
        'query_sql slow/expensive query (cost ledger)'
      );
    }
    return finalizeQuerySqlResult(
      {
        ...(title ? { title } : {}),
        sql: baseSql,
        rows,
        columns,
        total_count: totalCount,
        has_more: offset + limit < totalCount,
        execution_time_ms: executionTimeMs,
      },
      options?.maxSerializedResultBytes
    );
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error({ error }, 'query_sql error');

    // Classify via SQLSTATE where available (57014 = statement timeout), falling
    // back to message matching. The `error_code`/`retryable` fields let the agent
    // distinguish a transient timeout (worth retrying) from a permanent SQL fault.
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === '57014' || msg.includes('timeout') || msg.includes('statement timeout')) {
      return fail('Query exceeded the 5 second timeout.', 'UPSTREAM_TIMEOUT');
    }
    if (msg.includes('read-only')) {
      return fail('Only read-only queries are allowed.', 'VALIDATION');
    }
    return fail(msg, classifyToolError({ pgCode: pgCode ?? undefined, message: msg }));
  }
}
