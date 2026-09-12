/**
 * Execute SQL data sources defined in a JSON view template.
 *
 * Queries run against a virtual schema of org-scoped CTEs. Table references
 * in user queries are resolved to:
 *   - Core tables (entities, events, connections, automations, event_classifications)
 *     → CTE with organization_id filter
 *   - Any other name → treated as an entity_type slug, filtered from entities
 *
 * Security:
 *   - SQL parsed via @polyglot-sql/sdk to extract ALL table references
 *   - Schema-qualified references (e.g. public.user) rejected outright
 *   - Every table ref gets a CTE with org-scoping baked in
 *   - READ ONLY transaction + timeout via sql.begin()
 *   - FORBIDDEN_OPS regex as additional safeguard
 */

import { Dialect, ast, parse as parseSql } from '@polyglot-sql/sdk';
import { type DbClient, pgTextArray } from '../db/client';
import logger from './logger';
import { useLinkedOrgScope } from './linked-org-ids';
import {
  compileConnectionFkVisibility,
  compileConnectionRowVisibility,
} from '../authz/connection-visibility';
import { compileChannelMessagesVisibility } from '../authz/channel-messages-visibility';
import { compileResourceVisibility } from '../authz/resource-visibility';
import type { AuthzScope } from '../authz/scope';
import {
  ADMIN_ONLY_QUERYABLE_TABLES,
  buildColumnList,
  type ColumnDef,
  formatUnknownTablesError,
  QUERYABLE_TABLE_NAMES,
  SAFE_COLUMN_DEFS,
  validateTableQuery,
} from './table-schema';
import { getErrorMessage } from "@lobu/core";

/** A named SQL data source: { name, query } or keyed as Record<string, { query }> */
export type DataSourceInput =
  | Record<string, { query: string }>
  | Array<{ name: string; query: string }>;

export interface DataSourceContext {
  organizationId: string;
  /**
   * The requesting user. When set, the events CTE additionally intersects with
   * per-user connection visibility (visibility='org' OR created_by=userId) so
   * query_sql / metrics / client.query don't leak other users' private-connection
   * data — matching what search_memory/get_content already enforce.
   */
  userId?: string | null;
  /** When set, events CTE filters to events belonging to any of these entities */
  entityIds?: number[];
  query?: Record<string, string>;
  /**
   * When set, the events and channel_messages CTEs are filtered to rows STORED
   * in `[windowStart, windowEnd)` — `created_at`, the arrival axis, never
   * `occurred_at`. An Automation window is "what arrived since the last run":
   * a resynced or backfilled row with an old `occurred_at` lands in the window
   * of the run that follows its arrival instead of vanishing inside a period
   * that already completed.
   */
  windowStart?: string;
  windowEnd?: string;
  /** Drop rows this Automation produced during its own source execution. */
  excludeProducedByAutomationId?: number | null;
}

/** Operations that bypass READ ONLY transactions or have side-effects. */
const FORBIDDEN_OPS = /\b(COPY|IMPORT|PRAGMA|CALL)\b/i;
const FORBIDDEN_QUERY_FUNCTIONS = new Set(['set_config']);
export const MAX_DATA_SOURCE_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5000;

type SqlNode = ast.Expression;

/** Strip {{...}} template placeholders to a literal so the parser doesn't choke. */
function stripPlaceholders(sql: string): string {
  return sql.replace(/\{\{\w+(?:\.\w+)?\}\}/g, '0');
}

/** Parse to the top-level statement node, or undefined when the SQL won't parse. */
function parseRoot(sql: string): SqlNode | undefined {
  const res = parseSql(stripPlaceholders(sql), Dialect.PostgreSQL);
  if (!res.success || !res.ast) return undefined;
  return (Array.isArray(res.ast) ? res.ast[0] : res.ast) as SqlNode | undefined;
}

/** Pull a bare identifier string out of polyglot's `{ name, quoted }` shapes. */
function identName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (o.name && typeof o.name === 'object') return identName(o.name);
    if (o.this) return identName(o.this);
  }
  return null;
}

/**
 * Reject functions that mutate the database session even inside a read-only
 * transaction. `set_config` can persist a custom GUC on a pooled connection;
 * that would let caller SQL forge server-only transaction flags used by database
 * triggers on a later request.
 */
function assertNoForbiddenFunctions(root: unknown): void {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }

    const record = node as Record<string, unknown>;
    const functionNode = record.function as Record<string, unknown> | undefined;
    const methodNode = record.method_call as Record<string, unknown> | undefined;
    const name = identName(functionNode?.name) ?? identName(methodNode?.method);
    if (name && FORBIDDEN_QUERY_FUNCTIONS.has(name.toLowerCase())) {
      throw new Error(`Function '${name}' is not allowed in read-only queries.`);
    }
    for (const child of Object.values(record)) stack.push(child);
  }
}

/**
 * Collect every schema-qualified table reference (`schema.table`) in the parsed
 * tree by recursing the RAW AST node graph.
 *
 * Security-critical: org-scoping shadows UNQUALIFIED table names with CTEs, so a
 * schema-qualified ref (`public.connections`, `pg_catalog.*`) bypasses scoping
 * and reads every org's rows. polyglot's `getTables`/`walk`/`findByType` only
 * surface the FIRST `FROM` table — they do NOT descend into JOINs or
 * sub-selects — so a qualified table in a join or subquery would slip past a
 * node-enumeration check. A raw recursion over the node graph is the only
 * reliable way to see them all. A polyglot table-ref node is shaped
 * `{ name, schema, catalog, ... }`; `schema` is null when unqualified.
 *
 * Iterative (stack) traversal, NOT recursion: a recursion depth-cap would
 * fail OPEN — a deeply-nested `public.oauth_tokens` past the cap would slip
 * past and bypass scoping. The `seen` set bounds the walk on cyclic graphs.
 */
function collectSchemaQualifiedTables(root: unknown): string[] {
  const seen = new Set<object>();
  const hits: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (obj.schema != null && obj.name != null && Object.hasOwn(obj, 'catalog')) {
      hits.push(`${identName(obj.schema) ?? '?'}.${identName(obj.name) ?? '?'}`);
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return hits;
}

/**
 * Every table-ref name anywhere in the tree (lowercased) via the same raw walk.
 * Security-critical: `ast.getTableNames` does NOT descend into subqueries nested
 * inside an expression (e.g. `(CASE WHEN … THEN (SELECT … FROM oauth_tokens) …)`),
 * so a table hidden there would be neither scoped nor admin-gated. This walk
 * reaches them. Includes CTE-reference names (filtered out by the caller).
 */
function collectAllTableNames(root: unknown): string[] {
  const seen = new Set<object>();
  const names: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (obj.name != null && Object.hasOwn(obj, 'catalog')) {
      const n = identName(obj.name);
      if (n) names.push(n.toLowerCase());
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return names;
}

/**
 * Names defined in every WITH clause in the tree (lowercased), incl. nested
 * WITHs. A CTE name is a local alias, NOT a base table — it must be excluded
 * from the scoping list (we'd otherwise inject a conflicting CTE) and from the
 * admin gate (a `WITH events AS …` would otherwise be treated as the base table).
 */
function collectCteNames(root: unknown): Set<string> {
  const seen = new Set<object>();
  const names = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.ctes)) {
      for (const cte of obj.ctes) {
        const alias = identName((cte as Record<string, unknown>)?.alias);
        if (alias) names.add(alias.toLowerCase());
      }
    }
    for (const key of Object.keys(obj)) stack.push(obj[key]);
  }
  return names;
}

/**
 * Strip leading whitespace + SQL comments (line `--…` and block `/* … *​/`) with
 * a single linear scan. Deliberately NOT a regex: a comment-stripping regex with
 * nested quantifiers (`(?:--…|/*…*​/)*`) backtracks catastrophically on crafted
 * input (e.g. many unclosed `/*`) — a ReDoS DoS, since this runs on member SQL.
 */
export function stripLeadingComments(sql: string): string {
  const n = sql.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) return '';
      i = nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i);
      if (end === -1) return '';
      i = end + 2;
    } else {
      return sql.slice(i);
    }
  }
}

// A read query is SELECT or WITH … SELECT, after any leading comments. Rejects
// DML/DDL prefixes AND PostgreSQL's `TABLE <name>` shorthand (≡ SELECT * FROM
// <name>) — polyglot mis-parses the latter as a column, so it yields no table
// refs and would otherwise pass through unscoped.
export function isReadQuery(sql: string): boolean {
  return /^(SELECT|WITH)\b/i.test(stripLeadingComments(sql));
}

// ============================================
// SQL Parsing
// ============================================

/**
 * Extract the COMPLETE set of base-table references a query reads, lowercased —
 * the list that must each be wrapped in an org-scoping CTE.
 *
 * Why this is more than `ast.getTableNames`: the @polyglot-sql/sdk migration's
 * scoping relied on `getTableNames`, which has TWO blind spots that each leak
 * (found by the adversarial bug-hunt):
 *  1. It does not descend into subqueries nested inside an EXPRESSION — e.g.
 *     `(CASE WHEN … THEN (SELECT … FROM oauth_tokens) END)` or a scalar
 *     `SELECT (SELECT … FROM events) …`. Such a table was left unscoped.
 *  2. PostgreSQL's `TABLE <name>` shorthand mis-parses as a column, yielding no
 *     refs at all (handled by the SELECT/WITH guard in validateAndScopeQuery).
 *
 * Strategy here:
 *  - Reject multiple statements and schema-qualified refs (both bypass scoping).
 *  - Build the ref set from a raw AST walk (`collectAllTableNames`), which is a
 *    strict SUPERSET of `ast.getTableNames` (verified across diverse shapes) and
 *    additionally reaches expression-nested subqueries getTableNames misses. The
 *    completeness-invariant test suite guards this against parser changes.
 *  - Exclude CTE names (local aliases, not base tables).
 *  - FAIL-CLOSED collision guard: reject a query whose CTE name shadows a real
 *    or admin table. The parser cannot tell, by lexical scope, whether `events`
 *    in `WITH events AS (SELECT … FROM events)` is the CTE or the base table —
 *    so we forbid the ambiguity rather than risk an unscoped base-table read.
 */
function extractTableRefs(
  query: string,
  queryableTableNames: ReadonlySet<string> = QUERYABLE_TABLE_NAMES
): string[] {
  const res = parseSql(stripPlaceholders(query), Dialect.PostgreSQL);
  if (!res.success || !res.ast) {
    throw new Error('Could not parse SQL query for table extraction');
  }
  // Reject multiple statements: org-scoping CTEs only wrap the FIRST statement,
  // so a trailing `; SELECT … FROM public.oauth_tokens` would run unscoped.
  const statements = Array.isArray(res.ast) ? res.ast : [res.ast];
  if (statements.length > 1) {
    throw new Error('Multiple SQL statements are not allowed; provide a single query.');
  }
  const root = statements[0] as SqlNode;

  assertNoForbiddenFunctions(root);

  // Reject schema-qualified references anywhere in the tree (joins, subqueries,
  // CTE bodies, UNION branches) — they bypass the org-scoping CTEs.
  const qualified = collectSchemaQualifiedTables(root);
  if (qualified.length > 0) {
    throw new Error(
      `Schema-qualified table references are not allowed: ${[...new Set(qualified)].join(', ')}`
    );
  }

  const cteNames = collectCteNames(root);
  // A CTE may not shadow a real/admin table name — see fail-closed note above.
  for (const cte of cteNames) {
    if (queryableTableNames.has(cte) || ADMIN_ONLY_QUERYABLE_TABLES.has(cte)) {
      throw new Error(
        `CTE name '${cte}' collides with a reserved table name; rename the CTE.`
      );
    }
  }

  // Every base-table ref via the raw walk (superset of getTableNames, incl.
  // expression-nested), minus CTE names (local aliases, not base tables).
  const refs = new Set<string>();
  for (const n of collectAllTableNames(root)) {
    if (!cteNames.has(n)) refs.add(n);
  }
  return Array.from(refs);
}

// ============================================
// Validate + Scope (shared by query_sql and reaction SDK)
// ============================================

/**
 * Validate a user SQL query and produce an org-scoped version.
 *
 * Validation pipeline:
 *   1. validateTableQuery() — @polyglot-sql/sdk parses the SQL and checks
 *      all table/column references against the allowlisted schema
 *   2. extractTableRefs() — @polyglot-sql/sdk AST extracts table names
 *   3. buildScopedQuery() — wraps each table reference in an org-scoped CTE
 *
 * Throws on any validation failure.
 */
export function validateAndScopeQuery(
  rawSql: string,
  organizationId: string,
  options?: {
    safeColumns?: Map<string, ColumnDef[]>;
    /**
     * Tables the caller may NOT reference (rejected even though they're in the
     * global allowlist). Used to keep auth/identity tables (oauth_tokens,
     * oauth_clients, user) admin-only when a non-admin runs query_sql /
     * metric_series. Omit for admin / server-internal callers (full access).
     */
    restrictedTables?: ReadonlySet<string>;
    /**
     * The requesting user. Threaded into the events CTE so connection-sourced
     * rows are filtered to org-visible connections or this user's own private
     * ones (per-user visibility). Omit for service/headless callers — null
     * yields org-visible-only (fail-closed for private data).
     */
    userId?: string | null;
    /**
     * Exclude workspace-identity audit events (metadata.category='workspace')
     * from the events and event_classifications CTEs. These rows record
     * member/invitation lifecycle and are owner/admin-only; ordinary members
     * running query_sql / client.query must not surface them.
     */
    excludeWorkspaceAudit?: boolean;
    /** Verified Automation window; supplied by the token resolver, never raw SQL. */
    window?: Pick<DataSourceContext, 'windowStart' | 'windowEnd' | 'entityIds' | 'excludeProducedByAutomationId'>;
  }
): { sql: string; params: unknown[]; tableRefs: string[] } {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new Error('SQL query is required');
  }

  // Must be a read query. Rejects DML/DDL AND PostgreSQL's `TABLE <name>`
  // shorthand (≡ `SELECT * FROM <name>`) — polyglot mis-parses `TABLE` as a
  // column, so it would yield zero table refs and pass through UNSCOPED and
  // past the admin-table gate. The gate below is fail-closed regardless, but
  // rejecting the shorthand outright keeps the contract obvious.
  if (!isReadQuery(trimmed)) {
    throw new Error('Only SELECT / WITH queries are allowed.');
  }

  // Schema-level validation via SQL parser (rejects unknown tables/columns, mutations, etc.)
  const safeColumns = options?.safeColumns ?? SAFE_COLUMN_DEFS;
  const queryableTableNames = new Set(safeColumns.keys());
  const validation = validateTableQuery(trimmed, safeColumns);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  // COMPLETE table extraction (union of getTableNames + raw walk, CTE names
  // excluded). Drives the unknown-table check, the admin gate, AND org-scoping,
  // so an expression-nested table is caught by all three.
  const tableRefs = extractTableRefs(trimmed, queryableTableNames);
  const unknown = tableRefs.filter((t) => !queryableTableNames.has(t));
  if (unknown.length > 0) {
    throw new Error(formatUnknownTablesError(unknown, queryableTableNames));
  }

  if (options?.restrictedTables) {
    const blocked = tableRefs.filter((t) => options.restrictedTables?.has(t));
    if (blocked.length > 0) {
      throw new Error(
        `Table(s) '${[...new Set(blocked)].join("', '")}' require owner/admin access — ` +
          `the query did not run. This is an error, not an empty result.`
      );
    }
  }

  return {
    ...buildScopedQuery(
      trimmed,
      tableRefs,
      { ...options?.window, organizationId, userId: options?.userId ?? null },
      options
    ),
    tableRefs,
  };
}

// ============================================
// CTE Building
// ============================================

/**
 * Build org-scoped CTEs for each referenced table and combine with the user query.
 *
 * Core tables get predefined scoping patterns. Unknown table names are
 * treated as entity_type slugs (filtered from the entities table).
 */
export function buildScopedQuery(
  userQuery: string,
  tableRefs: string[],
  context: DataSourceContext,
  options?: {
    safeColumns?: Map<string, ColumnDef[]>;
    excludeWorkspaceAudit?: boolean;
  }
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let idx = 0;

  // Organization scoping is mandatory for table-backed queries, but tableless
  // SELECTs bind it only when the query explicitly references the context value.
  // This keeps the normal placeholder contract without sending unused params to
  // postgres, which cannot infer their types.
  let organizationP: string | undefined;
  const bindOrganization = (): string => {
    if (!organizationP) {
      idx++;
      params.push(context.organizationId);
      organizationP = `$${idx}`;
    }
    return organizationP;
  };
  if (tableRefs.length > 0) bindOrganization();

  // Requesting user, bound lazily like the org. Cast because a null principal
  // (headless/service caller) gives postgres no type to infer — and `user_id =
  // NULL` is never true, so those callers see zero owner-scoped rows, which is
  // the fail-closed direction.
  let principalP: string | undefined;
  const bindPrincipal = (): string => {
    if (!principalP) {
      idx++;
      params.push(context.userId ?? null);
      principalP = `$${idx}::text`;
    }
    return principalP;
  };

  // Run every query through the same context-placeholder compiler. Parameter
  // allocation stays lazy so tableless SELECTs bind only values they reference.
  let processedQuery = userQuery;
  if (context.entityIds && context.entityIds.length > 0) {
    let entityP: string | undefined;
    processedQuery = processedQuery.replace(/\{\{entityId\}\}/g, () => {
      if (!entityP) {
        idx++;
        params.push(context.entityIds![0]);
        entityP = `$${idx}::bigint`;
      }
      return entityP;
    });
  }

  processedQuery = processedQuery.replace(/\{\{organizationId\}\}/g, () =>
    bindOrganization()
  );

  processedQuery = processedQuery.replace(/\{\{query\.(\w+)\}\}/g, (_match, paramName: string) => {
    idx++;
    params.push(context.query?.[paramName] ?? null);
    return `$${idx}::text`;
  });

  const remaining = processedQuery.match(/\{\{(\w+(?:\.\w+)?)\}\}/g);
  if (remaining) {
    throw new Error(`Unknown context variables: ${remaining.join(', ')}`);
  }

  if (/\$\d+/.test(userQuery)) {
    throw new Error('Positional parameters ($1, $2, ...) are not allowed in data source queries');
  }

  if (tableRefs.length === 0) return { sql: processedQuery, params };
  const orgP = bindOrganization();

  // Per-user connection visibility (S0). Applied to EVERY CTE on this seam that
  // exposes connection-sourced event content — `events`, `event_classifications`
  // (whose `excerpts` is verbatim source text), and `connections` — so query_sql
  // / metrics / client.query never surface another user's private-connection data.
  // This is the same gate search_memory/get_content already enforce. M1 routes
  // both shapes through the one connection-visibility compiler keyed on an
  // AuthzScope; `principal` null (headless/service) yields org-visible-only,
  // fail-closed for private data.
  const scope: AuthzScope = {
    organizationId: context.organizationId,
    principal: context.userId ?? null,
  };

  // For a table holding events (alias has a `connection_id` col): restrict to
  // org-visible connections or the requesting user's own private ones.
  const eventConnVisibility = (alias: string): string => {
    const vis = compileConnectionFkVisibility(scope, idx + 1, alias);
    params.push(...vis.params);
    idx += vis.params.length;
    return ` ${vis.sql}`;
  };

  // Per-resource membership gate for an events table (alias has `entity_ids` +
  // `connection_id`): on ACL-enforced connections, restrict to events linked to a
  // resource the requester is `member_of`. Composed AFTER eventConnVisibility on
  // event-bearing tables ONLY (NOT feeds, which carry no entity_ids).
  const eventResourceVisibility = (alias: string): string => {
    const vis = compileResourceVisibility(scope, idx + 1, alias);
    params.push(...vis.params);
    idx += vis.params.length;
    return ` ${vis.sql}`;
  };

  // Tenancy predicate for an events table (alias has `organization_id`,
  // `entity_ids`, `connection_id`). Mirrors buildOrgScopeWhere in
  // content-search.ts: an event is in scope if it was stamped to the caller's
  // org directly, OR any of its entity_ids belong to the caller's org, OR it
  // came in through a connection in the caller's org.
  //
  // Shared by `events` and `event_classifications` on purpose. These were two
  // hand-written predicates and they drifted: the classifications CTE only ever
  // implemented the middle disjunct (an entity join), so labels on an
  // entity-less event were invisible while the event itself was queryable in
  // the same breath. A classification must be visible exactly when its event
  // is, and one expression is the only way to keep that true.
  //
  // Written as ONE template literal on purpose: `+`-joining SQL fragments trips
  // the check-security-patterns string-concat guard, and this fragment is far
  // enough from the whitelisted for-loop below that no `security-allowed:`
  // annotation covers it. Keep it concat-free rather than allowlisting it.
  const eventOrgScope = (alias: string): string => useLinkedOrgScope()
    ? `(${alias}.organization_id = ${orgP}
      OR ${alias}.linked_org_ids @> ARRAY[${orgP}]::text[])`
    : `(${alias}.organization_id = ${orgP}
      OR EXISTS (SELECT 1 FROM public.entities ent
        WHERE ent.id = ANY(${alias}.entity_ids) AND ent.organization_id = ${orgP})
      OR EXISTS (SELECT 1 FROM public.connections con
        WHERE con.id = ${alias}.connection_id AND con.organization_id = ${orgP}))`;

  // Per-channel membership gate for the `channel_messages` table (alias has
  // `connection_id` + `channel_id`): on an ACL-enforced Slack connection, restrict
  // to channels the requester is `member_of`. A headless/null principal sees only
  // non-enforced channels — this is what keeps an automation's streaming @feed source
  // from leaking enforced-channel content into the shared recap.
  const channelMessagesVisibility = (alias: string): string => {
    const vis = compileChannelMessagesVisibility(scope, idx + 1, alias);
    params.push(...vis.params);
    idx += vis.params.length;
    return ` ${vis.sql}`;
  };

  // For the `connections` table itself: the row is visible when org-shared or
  // owned by the requesting user (mirrors manage_connections CRUD).
  const connectionRowVisibility = (alias: string): string =>
    ` ${compileConnectionRowVisibility(scope, alias)}`;

  // Build CTEs
  const ctes: string[] = [];

  // When safeColumns is provided, emit explicit column lists instead of SELECT *
  const sc = options?.safeColumns;
  const sel = (table: string, alias?: string) => {
    const defs = sc?.get(table);
    if (!defs) return alias ? `${alias}.*` : '*';
    // `table` drives how a redaction expression resolves the row's
    // connector-DECLARED secret fields: a connection carries `connector_key`,
    // a feed reaches it through `connection_id`.
    return buildColumnList(defs, alias, table);
  };

  // Build the SELECT list for the entities CTE, where entity_type is now a
  // derived column from a JOIN to entity_types (et.slug AS entity_type).
  const selEntitiesJoined = (entityAlias: string, typeAlias: string): string => {
    const defs = sc?.get('entities');
    if (!defs) return `${entityAlias}.*, ${typeAlias}.slug AS entity_type`;
    return defs
      .map((c) => {
        if (c.name === 'entity_type') return `${typeAlias}.slug AS "entity_type"`;
        if (c.expr) {
          const prefixed = c.expr.replace(/^(\w+)/, `${entityAlias}.$1`);
          return `${prefixed} as "${c.name}"`;
        }
        return `${entityAlias}."${c.name}"`;
      })
      .join(', ');
  };

  // The event and classification CTEs must agree on both versions and access.
  const eventTable = context.windowStart && context.windowEnd
    ? 'public.events' : 'public.current_event_records';
  const eventReadPredicate = (alias: string): string => {
    let predicate = '';
    // Workspace-identity audit rows are owner/admin-only; ordinary members
    // running raw SQL must not surface them.
    if (options?.excludeWorkspaceAudit) {
      predicate += ` AND NOT (${alias}.metadata ? '_lobu_workspace_audit')`;
    }

    // Entity scoping: filter events to the automation's entities
    if (context.entityIds && context.entityIds.length > 0) {
      const placeholders = context.entityIds.map((id) => {
        idx++;
        params.push(id);
        return `$${idx}`;
      });
      predicate += ` AND ${alias}.entity_ids && ARRAY[${placeholders.join(',')}]::bigint[]`;
    }

    // Stable version at the exclusive window end. Later successors must not
    // erase rows between a source summary, pagination, and a detail query.
    if (context.windowStart && context.windowEnd) {
      idx++;
      params.push(context.windowStart);
      const windowStartP = `$${idx}`;
      idx++;
      params.push(context.windowEnd);
      const windowEndP = `$${idx}`;
      predicate += ` AND ${alias}.created_at >= ${windowStartP}::timestamptz AND ${alias}.created_at < ${windowEndP}::timestamptz`;
      predicate += ` AND NOT EXISTS (SELECT 1 FROM public.events successor WHERE successor.id = ${alias}.superseded_by AND successor.created_at < ${windowEndP}::timestamptz)`;
    }

    // An Automation never reads what it wrote itself. This used to be bought by
    // stamping outputs at `window_end` so they fell outside their own window
    // — which also made them future-dated and invisible everywhere else. Now
    // that outputs are stamped truthfully they land inside their own window,
    // and only this predicate stops an hourly Automation compounding on itself.
    //
    // Self-scoped: one Automation refining another's output is ordinary
    // composition, so this drops rows from THIS Automation only.
    if (context.excludeProducedByAutomationId != null) {
      idx++;
      params.push(context.excludeProducedByAutomationId);
      predicate += ` AND (${alias}.automation_id IS NULL OR ${alias}.automation_id <> $${idx})`;
    }

    predicate += eventConnVisibility(alias);
    predicate += eventResourceVisibility(alias);

    return predicate;
  };

  // security-allowed: every `${safeName}` below is a QUERYABLE_TABLE_NAMES-whitelisted
  // identifier that's been double-quote-escaped; every `${orgP}` is a $N parameter
  // placeholder; `sel()` / `selEntitiesJoined()` return validated column expressions.
  // postgres.js tagged templates can't template dynamic identifiers, so these CTE
  // skeletons are built via concatenation. Static-guard suppression applies to this
  // whole loop body.
  for (const table of tableRefs) {
    // Escape double quotes in table name for safe identifier quoting
    const safeName = table.replace(/"/g, '""');

    if (table === 'entities') {
      // security-allowed: see block comment above this for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${selEntitiesJoined('e', 'et')} ` +
          `FROM public.entities e ` +
          `JOIN public.entity_types et ON et.id = e.entity_type_id ` +
          `WHERE e.organization_id = ${orgP})`
      );
    } else if (table === 'events') {
      // Tenancy via eventOrgScope, shared with event_classifications — keeps
      // query_sql consistent with what search_memory/get_content surface.
      // security-allowed: see block comment above the for-loop
      let eventsCte =
        `"${safeName}" AS (SELECT ${sel(table, 'ev')} FROM ${eventTable} ev ` +
        `WHERE ${eventOrgScope('ev')}`;

      eventsCte += eventReadPredicate('ev');

      eventsCte += ')';
      ctes.push(eventsCte);
    } else if (table === 'connections') {
      // A private connection's own row (display_name, account_id, config) is
      // per-user too — mirror manage_connections CRUD so a member can't read
      // another user's private-connection metadata via raw SQL.
      // Soft-deleted rows are intentionally NOT excluded here — query_sql is an
      // audit/debug surface and there's no cross-user leak (a deleted private
      // connection still carries created_by, so the visibility predicate blocks
      // it). The per-user predicate is the security boundary.
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'cn')} FROM public.connections cn WHERE cn.organization_id = ${orgP}` +
          connectionRowVisibility('cn') +
          ')'
      );
    } else if (table === 'automations') {
      // Scoped on `automations.organization_id` (NOT NULL), NOT through an
      // entity-existence join.
      //
      // The old predicate was `EXISTS (SELECT 1 FROM entities ent WHERE ent.id =
      // ANY(i.entity_ids) AND ent.organization_id = $org)`. `entity_ids` is
      // NULLABLE and org-scoped Automations carry NULL, so every entity-less
      // Automation was structurally invisible — `SELECT count(*) FROM automations`
      // returned a confident wrong number while `automations.list` showed them.
      // The direct column is both COMPLETE (no row can lack it) and strictly
      // fail-closed (it is the tenancy key itself, so this cannot widen
      // cross-org visibility the way an EXISTS over a joined table could).
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'i')} FROM public.automations i ` +
          `WHERE i.organization_id = ${orgP})`
      );
    } else if (table === 'event_classifications') {
      // Visible exactly when the underlying event is: same eventOrgScope
      // tenancy, then the same two per-user gates on `ev`.
      //
      // `excerpts`/`values`/`reasoning` carry verbatim source-event content, so
      // the EXISTS must apply per-user connection visibility on `ev` — otherwise
      // any member reads classifications of another user's private-connection
      // events (the same leak the events CTE closes, on the joined table).
      // security-allowed: eventTable is an internal fixed table name.
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'ec')} FROM public.event_classifications ec WHERE EXISTS (` +
          `SELECT 1 FROM ${eventTable} ev ` +
          `WHERE ev.id = ec.event_id AND ${eventOrgScope('ev')}` +
          eventReadPredicate('ev') +
          '))'
      );
    } else if (table === 'automation_versions') {
      // `automation_versions` carries no organization_id of its own, so it inherits
      // the parent Automation's. Same fix as the `automations` CTE: the previous
      // entity-existence join hid every version of an entity-less Automation. The
      // INNER JOIN is the tenancy boundary — a version whose parent is missing
      // or in another org yields no row, so this stays fail-closed.
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'wv')} FROM public.automation_versions wv ` +
          'JOIN public.automations w ON w.id = wv.automation_id ' +
          `WHERE w.organization_id = ${orgP})`
      );
    } else if (table === 'oauth_clients') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.oauth_clients WHERE organization_id = ${orgP})`
      );
    } else if (table === 'oauth_tokens') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.oauth_tokens WHERE organization_id = ${orgP})`
      );
    } else if (table === 'user') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'u')} FROM public."user" u ` +
          `JOIN public.member m ON m."userId" = u.id ` +
          `WHERE m."organizationId" = ${orgP})`
      );
    } else if (table === 'device_workers') {
      // NOT an org-scoped table. The PK is (user_id, worker_id) and
      // `organization_id` is nullable — it records where a device is ATTACHED,
      // not who owns it. Scoping on the org alone would let any member of a
      // shared org enumerate every colleague's machines: `label` is typically a
      // personal name, and `last_seen_at` is a presence feed. That is the leak
      // class that keeps `user` in ADMIN_ONLY_QUERYABLE_TABLES, so the owner
      // filter — not the org — is what makes this member-safe.
      //
      // The owner predicate is the one `listDeviceWorkers`
      // (worker-api/device-management.ts) already uses for the typed device
      // list. The org arm still admits devices with NO org, because
      // `evaluateDeviceWorkerAccess` already lets an owner pin a device they own
      // regardless of attachment; hiding those would leave a device you can pin
      // but cannot find, which is the gap this entry exists to close. It cannot
      // widen exposure: the owner predicate is ANDed first.
      //
      // Deliberately narrower than the pin policy in two places: an owner's
      // device attached to ANOTHER org is not this org's data, and the
      // owner/admin arm of `evaluateDeviceWorkerAccess` is not mirrored because
      // DataSourceContext carries no member role. Both still resolve through
      // the typed device list, which is owner-scoped and cross-org.
      const principalP = bindPrincipal();
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'dw')} FROM public.device_workers dw ` +
          `WHERE dw.user_id = ${principalP} ` +
          `AND (dw.organization_id = ${orgP} OR dw.organization_id IS NULL))`
      );
    } else if (table === 'feeds') {
      // Every feed derives from a connection (`connection_id` NOT NULL), so a
      // private connection's feeds (display_name, config, last_error) are
      // per-user too — gate via the owning connection's visibility.
      //
      // This uses the ROW form (`compileConnectionRowVisibility`), matching
      // `manage_feeds`. It previously used the FK form, which is built for
      // EVENT tables and additionally requires `vc.deleted_at IS NULL` — so a
      // live feed on a soft-deleted connection vanished from SQL while
      // `client.feeds.get` still returned it. Feeds carry their own
      // `deleted_at`; the CONNECTION's soft-delete is not the feed's, and
      // query_sql is an audit surface. Same structural-visibility class as the
      // Automations defect: the SDK and the SQL view must agree on what exists.
      // The row form matches the FK form on visibility (`'org'` or the
      // principal's own), with no soft-delete coupling to the connection.
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'fd')} FROM public.feeds fd ` +
          `WHERE fd.organization_id = ${orgP} ` +
          // security-allowed: see block comment above the for-loop
          `AND EXISTS (SELECT 1 FROM public.connections fc ` +
          `WHERE fc.id = fd.connection_id AND fc.organization_id = ${orgP}` +
          connectionRowVisibility('fc') +
          '))'
      );
    } else if (table === 'channel_messages') {
      // Chat transcript rows. `text` is verbatim channel content, so the CTE
      // stacks the SAME gates the events CTE applies, adapted to channel_messages:
      //   1. connection visibility — a PRIVATE connection's transcript is visible
      //      only to its creator (org-visible connections to everyone). Resolved
      //      by slug because channel_messages.connection_id is the runtime id, not
      //      connections.id. A null principal (headless automation) → org-only.
      //   2. time window (incremental mode) — only rows inside the automation window,
      //      so a channel @feed reads its window, not the whole history.
      //   3. per-channel membership (channelMessagesVisibility) — ACL-enforced
      //      channels require member_of; stale/enforced fail closed.
      // security-allowed: see block comment above the for-loop
      let cmCte =
        `"${safeName}" AS (SELECT ${sel(table, 'cm')} FROM public.channel_messages cm ` +
        `WHERE cm.organization_id = ${orgP}`;
      // security-allowed: see block comment above the for-loop
      cmCte +=
        ` AND EXISTS (SELECT 1 FROM public.connections cc ` +
        `WHERE cc.organization_id = ${orgP} AND cc.deleted_at IS NULL ` +
        `AND cc.slug IN (cm.connection_id, 'agentconn-' || cm.connection_id) ` +
        `${compileConnectionRowVisibility(scope, 'cc')})`;
      if (context.windowStart && context.windowEnd) {
        idx++;
        params.push(context.windowStart);
        const cmWindowStart = `$${idx}`;
        idx++;
        params.push(context.windowEnd);
        const cmWindowEnd = `$${idx}`;
        cmCte += ` AND cm.created_at >= ${cmWindowStart}::timestamptz AND cm.created_at < ${cmWindowEnd}::timestamptz`;
      }
      cmCte += channelMessagesVisibility('cm');
      cmCte += ')';
      ctes.push(cmCte);
    } else if (table === 'connector_definitions') {
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.connector_definitions WHERE organization_id = ${orgP})`
      );
    } else if (table === 'entity_relationships') {
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table)} FROM public.entity_relationships WHERE organization_id = ${orgP} AND deleted_at IS NULL)`
      );
    } else if (table === 'entity_relationship_types') {
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'rt')} FROM public.entity_relationship_types rt ` +
          'LEFT JOIN public.organization o ON o.id = rt.organization_id ' +
          `WHERE rt.deleted_at IS NULL AND (rt.organization_id = ${orgP} OR o.visibility = 'public'))`
      );
    } else if (table === 'entity_identities') {
      // Internal metric compilation opts this relation into its private safe
      // column map. It is intentionally absent from QUERYABLE_SCHEMA, so raw
      // member/admin SQL and view templates cannot enumerate identity claims.
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${sel(table, 'ei')} FROM public.entity_identities ei ` +
          `WHERE ei.organization_id = ${orgP})`
      );
    } else {
      // Treat as entity_type slug — uses entities columns
      idx++;
      params.push(table);
      // security-allowed: see block comment above the for-loop
      ctes.push(
        `"${safeName}" AS (SELECT ${selEntitiesJoined('e', 'et')} ` +
          `FROM public.entities e ` +
          `JOIN public.entity_types et ON et.id = e.entity_type_id ` +
          `WHERE e.organization_id = ${orgP} AND et.slug = $${idx})`
      );
    }
  }

  // Combine CTEs with user query
  if (ctes.length === 0) return { sql: processedQuery, params };

  const cteStr = `WITH ${ctes.join(',\n')}`;
  // Strip leading line/block comments before deciding how to merge: a
  // `-- note\nWITH x AS (…) …` query is still a WITH, and prepending a second
  // WITH keyword would emit invalid SQL (`WITH … \n -- note \n WITH x …`).
  // Comments are cosmetic, so dropping the leading ones is safe.
  const body = stripLeadingComments(processedQuery).trim();

  // If the user query is itself a WITH, splice our CTEs in front of its CTE list
  // (single WITH keyword); otherwise prepend our WITH block.
  const finalSql = /^WITH\b/i.test(body)
    ? `${cteStr},\n${body.replace(/^WITH\s+/i, '')}`
    : `${cteStr}\n${body}`;

  return { sql: finalSql, params };
}

// ============================================
// Validation
// ============================================

/**
 * Inspect a SELECT/WITH query's top-level projection and report whether it
 * surfaces an `id` column.
 *
 * Automation-mode content aggregation keys every row by `row.id` (see
 * queryContentData in get_content.ts) and the signed window_token only carries
 * those numeric ids. A source query that omits `id` (e.g. `SELECT origin_id,
 * payload_text FROM events`) therefore produces zero content_ids — which makes
 * complete_window silently report `content_linked: 0` and skip the reaction
 * even though the agent received the rows. We catch that at save time instead.
 *
 * A projection "has id" if it contains a `*` star (bare or table-qualified),
 * a bare `id` column reference, or any column aliased `AS id`.
 *
 * Returns true on any parse failure: this is a best-effort guard, not a
 * security control, and we never want a parser edge case to block a save.
 */
export function queryProjectsIdColumn(query: string): boolean {
  try {
    const root = parseRoot(query);
    // Treat any shape we can't analyze (parse failure, non-SELECT) as "has id"
    // so we never block a save on a parser edge case.
    if (!root || ast.getExprType(root) !== 'select') return true;
    const projection = (ast.getExprData(root) as { expressions?: unknown[] }).expressions;
    if (!Array.isArray(projection)) return true;

    for (const item of projection as SqlNode[]) {
      const itemType = ast.getExprType(item);
      // Star projection: `*` or `alias.*`
      if (itemType === 'star' || ast.isStar?.(item)) return true;
      if (itemType === 'alias') {
        const d = ast.getExprData(item) as Record<string, unknown>;
        if (identName(d.alias)?.toLowerCase() === 'id') return true; // ... AS id
        const inner = (d.this ?? d.expr) as SqlNode | undefined;
        if (inner && (ast.getExprType(inner) === 'star' || ast.isStar?.(inner))) return true;
      } else if (itemType === 'column') {
        if (identName((ast.getExprData(item) as Record<string, unknown>).name)?.toLowerCase() === 'id')
          return true; // bare `id`
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Validate a data source query.
 * Checks: SELECT/WITH prefix, forbidden ops, SQL syntax, schema-qualified refs.
 * When `parse` is true (save-time), also validates syntax and table refs.
 */
export function validateDataSourceQuery(name: string, query: string, parse = false): void {
  const trimmed = query.trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error(`Data source '${name}': query must start with SELECT or WITH`);
  }
  if (FORBIDDEN_OPS.test(trimmed)) {
    throw new Error(`Data source '${name}': query contains forbidden operations`);
  }
  if (parse) {
    try {
      const res = parseSql(stripPlaceholders(trimmed), Dialect.PostgreSQL);
      if (!res.success) throw new Error(res.error ?? 'could not parse query');
      // Reject auth/identity tables at save time so a template that would only
      // be masked at runtime fails fast with a clear error. (Runtime masking via
      // SAFE_COLUMN_DEFS is the enforcement; this is early, defense-in-depth
      // feedback.) Column-level allowlisting is intentionally NOT applied here —
      // data sources legitimately reference entity-type slugs (unknown tables).
      const refs = extractTableRefs(trimmed);
      const restricted = refs.filter((t) => ADMIN_ONLY_QUERYABLE_TABLES.has(t));
      if (restricted.length > 0) {
        throw new Error(
          `references admin-only table(s): ${[...new Set(restricted)].join(', ')}`
        );
      }
    } catch (err) {
      throw new Error(`Data source '${name}': ${getErrorMessage(err)}`);
    }
  }
}

/** Normalize DataSourceInput to entries array */
function toEntries(input: DataSourceInput): Array<[string, string]> {
  if (Array.isArray(input)) {
    return input.map((s) => [s.name, s.query]);
  }
  return Object.entries(input).map(([name, { query }]) => [name, query]);
}

// ============================================
// Execution
// ============================================

/**
 * Execute all data sources and return a map of name → rows.
 *
 * Each query runs in a proper sql.begin() transaction (connection-pinned)
 * with READ ONLY mode and a per-query timeout. Errors are caught per-source
 * so one failure doesn't break the rest.
 */
export async function executeDataSources(
  dataSources: DataSourceInput,
  context: DataSourceContext,
  sql: DbClient,
  options?: {
    /** Transform the scoped SQL before execution (e.g. wrap for ID-only extraction or pagination). */
    wrapQuery?: (
      scopedSql: string,
      params: unknown[],
      sourceName: string
    ) => string | { sql: string; params: unknown[] };
    /** Fail the whole read when any source fails instead of treating it as empty. */
    throwOnError?: boolean;
    /** Retain one overflow row so a caller can detect incomplete source results. */
    includeOverflowRow?: boolean;
    /** At save time, require unknown table refs to resolve to local or public entity types. */
    validateEntitySlugs?: boolean;
    /** Exclude workspace-identity audit rows from the events/event_classifications CTEs. */
    excludeWorkspaceAudit?: boolean;
  }
): Promise<Record<string, unknown[]>> {
  const results: Record<string, unknown[]> = {};
  const entries = toEntries(dataSources);
  if (entries.length === 0) return results;

  await Promise.all(
    entries.map(async ([name, query]) => {
      try {
        validateDataSourceQuery(name, query);
        const tableRefs = extractTableRefs(query);

        // Auth/identity tables (oauth_tokens, oauth_clients, user) must not be
        // referenceable from a view-template / automation data source — these
        // results surface to public/member readers via resolve_path. Mirror
        // query_sql's non-admin gate. (Entity-type slugs are never in this set.)
        const restricted = tableRefs.filter((t) =>
          ADMIN_ONLY_QUERYABLE_TABLES.has(t)
        );
        if (restricted.length > 0) {
          throw new Error(
            `Source '${name}': table(s) require admin access: ${[...new Set(restricted)].join(', ')}`
          );
        }

        // Unknown refs compile as entity-type CTEs instead of erroring. At save
        // time, resolve them through entity creation's local-or-public schema path.
        if (options?.validateEntitySlugs) {
          const slugRefs = tableRefs.filter((t) => !QUERYABLE_TABLE_NAMES.has(t));
          if (slugRefs.length > 0) {
            const existing = await sql<{ slug: string }>`
              SELECT DISTINCT et.slug
              FROM entity_types et
              LEFT JOIN organization o ON o.id = et.organization_id
              WHERE et.slug = ANY(${pgTextArray(slugRefs)}::text[])
                AND et.deleted_at IS NULL
                AND (
                  et.organization_id = ${context.organizationId}
                  OR o.visibility = 'public'
                )
            `;
            const known = new Set(existing.map((r) => r.slug));
            const missing = slugRefs.filter((s) => !known.has(s));
            if (missing.length > 0) {
              throw new Error(
                `Source '${name}': unknown table or entity type: ${missing.join(', ')}`
              );
            }
          }
        }

        // safeColumns masks each core-table CTE to its allowlisted columns, so
        // excluded secret columns (connections.credentials, oauth_tokens.
        // token_hash, oauth_clients.client_secret, user.email/phoneNumber,
        // events.embedding, feeds.checkpoint) are never emitted even when the
        // query selects them. Without it the CTE fell back to SELECT *, leaking
        // every physical column. Entity-type slug CTEs (no allowlist entry) keep
        // their SELECT * — entity data is the template's intended payload.
        let { sql: scopedQuery, params } = buildScopedQuery(query, tableRefs, context, {
          safeColumns: SAFE_COLUMN_DEFS,
          excludeWorkspaceAudit: options?.excludeWorkspaceAudit,
        });

        // Validate param count matches placeholders in scoped query
        const placeholderMatches = scopedQuery.match(/\$(\d+)/g);
        if (placeholderMatches) {
          const maxPlaceholder = Math.max(
            ...placeholderMatches.map((p: string) => parseInt(p.slice(1), 10))
          );
          if (maxPlaceholder > params.length) {
            throw new Error(
              `Source '${name}': query references $${maxPlaceholder} but only ${params.length} params provided`
            );
          }
        }

        if (options?.wrapQuery) {
          const wrapped = options.wrapQuery(scopedQuery, params, name);
          if (typeof wrapped === 'string') {
            scopedQuery = wrapped;
          } else {
            scopedQuery = wrapped.sql;
            params = wrapped.params;
          }
        }

        const rows = await sql.begin(async (tx) => {
          await tx.unsafe('SET TRANSACTION READ ONLY');
          await tx.unsafe(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}'`);
          return tx.unsafe(scopedQuery, params);
        });

        const rowLimit = MAX_DATA_SOURCE_ROWS + (options?.includeOverflowRow ? 1 : 0);
        results[name] = Array.isArray(rows) ? rows.slice(0, rowLimit) : [];
      } catch (err) {
		if (options?.throwOnError) {
			throw new Error(`Data source '${name}' failed: ${getErrorMessage(err)}`);
		}
        logger.warn(
          { error: getErrorMessage(err), dataSource: name },
          'Data source execution failed'
        );
        results[name] = [];
      }
    })
  );

  return results;
}
