import { Dialect, tokenize, type TokenInfo } from '@polyglot-sql/sdk';
import { ToolUserError } from './errors';
import type { ColumnDef } from './table-schema';

// These relations exist only in caller-scoped SQL. Never resolve them to
// PostgreSQL's information_schema views.
export const SQL_CATALOG_COLUMNS: Record<'tables' | 'columns', ColumnDef[]> = {
  tables: [
    { name: 'table_schema', type: 'text' },
    { name: 'table_name', type: 'text' },
    { name: 'table_type', type: 'text' },
  ],
  columns: [
    { name: 'table_schema', type: 'text' },
    { name: 'table_name', type: 'text' },
    { name: 'column_name', type: 'text' },
    { name: 'ordinal_position', type: 'integer' },
    { name: 'data_type', type: 'text' },
  ],
};

export type SqlCatalogRelation = keyof typeof SQL_CATALOG_COLUMNS;

export function isSqlCatalogRelation(name: string): name is SqlCatalogRelation {
  return Object.hasOwn(SQL_CATALOG_COLUMNS, name);
}

/**
 * Remove the qualifiers of the catalog relations identified by the AST. Only
 * edit identifier and dot tokens so literals, comments, context placeholders
 * and PostgreSQL syntax outside the references keep their original meaning.
 */
export function rewriteSqlCatalog(sql: string, relations: SqlCatalogRelation[]): string {
  // The WASM wire format uses token_type, even though the SDK type advertises
  // tokenType. Accept both so a future SDK fix also works.
  const tokens = (tokenize(sql, Dialect.PostgreSQL).tokens ?? []) as Array<
    TokenInfo & { token_type?: string }
  >;
  const tokenType = (token?: (typeof tokens)[number]) => token?.token_type ?? token?.tokenType;
  const expected = new Map<SqlCatalogRelation, number>();
  for (const name of relations) expected.set(name, (expected.get(name) ?? 0) + 1);

  const edits: Array<{ start: number; end: number }> = [];
  const identifier = (token: (typeof tokens)[number]) => {
    if (tokenType(token) === 'QUOTED_IDENTIFIER') return token.text;
    if (tokenType(token) === 'VAR') return token.text.toLowerCase();
    return '';
  };
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [schema, dot, relation, next] = tokens.slice(i, i + 4);
    if (identifier(schema) !== 'information_schema' || tokenType(dot) !== 'DOT') continue;
    const name = identifier(relation);
    if (!isSqlCatalogRelation(name) || !expected.has(name)) continue;
    // Three-part column references and qualified stars don't count as FROM
    // items. Too many two-part matches means an alias or expression uses the
    // same spelling. Reject that ambiguity instead of editing the expression.
    if (tokenType(next) !== 'DOT') expected.set(name, expected.get(name)! - 1);
    edits.push(schema.span, dot.span);
    i += 2;
  }
  if ([...expected.values()].some((count) => count !== 0)) {
    throw new ToolUserError(
      'Could not resolve the information_schema reference. Alias the catalog relation and use that alias to qualify its columns.',
      400,
      'VALIDATION'
    );
  }

  // Polyglot spans index Unicode code points, whereas JS strings index UTF-16.
  const characters = Array.from(sql);
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of edits) {
    parts.push(characters.slice(cursor, start).join(''), ' ');
    cursor = end;
  }
  parts.push(characters.slice(cursor).join(''));
  return parts.join('');
}

export function buildSqlCatalogCtes(
  relations: ReadonlySet<SqlCatalogRelation>,
  safeColumns: ReadonlyMap<string, ColumnDef[]>,
  restrictedTables: ReadonlySet<string> | undefined,
  params: unknown[]
): string[] {
  const visible = [
    ...[...safeColumns]
      .filter(([name]) => !restrictedTables?.has(name))
      .map(([name, columns]) => ({ name, columns, schema: 'public' })),
    ...Object.entries(SQL_CATALOG_COLUMNS)
      .map(([name, columns]) => ({ name, columns, schema: 'information_schema' })),
  ];

  const ctes: string[] = [];
  if (relations.has('tables')) {
    params.push(JSON.stringify(visible.map(({ name, schema }) => ({
      table_schema: schema,
      table_name: name,
    }))));
    ctes.push(`"tables" AS (
      SELECT table_schema, table_name, 'VIEW'::text AS table_type
      FROM jsonb_to_recordset($${params.length}::text::jsonb) AS t(table_schema text, table_name text)
    )`);
  }
  if (relations.has('columns')) {
    params.push(JSON.stringify(visible.flatMap(({ name, schema, columns }) =>
      columns.map((column, index) => ({
        table_schema: schema,
        table_name: name,
        column_name: column.name,
        ordinal_position: index + 1,
        // Safe projections with an expression declare its result type. The
        // entities projection also exposes the joined entity_types.slug.
        projected_type: schema === 'information_schema' || column.expr ||
          (name === 'entities' && column.name === 'entity_type') ? column.type : null,
      }))
    )));
    // This is a trusted metadata lookup. The input is the allowlist above, and
    // only projected columns of those named relations can reach the caller.
    ctes.push(`"columns" AS (
      SELECT s.table_schema, s.table_name, s.column_name, s.ordinal_position,
             COALESCE(s.projected_type, pg_catalog.format_type(a.atttypid, NULL)) AS data_type
      FROM jsonb_to_recordset($${params.length}::text::jsonb)
        AS s(table_schema text, table_name text, column_name text, ordinal_position integer, projected_type text)
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'public' AND s.table_schema = 'public'
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = s.table_name
      LEFT JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attname = s.column_name AND a.attnum > 0 AND NOT a.attisdropped
      WHERE s.projected_type IS NOT NULL OR a.attnum IS NOT NULL
    )`);
  }
  return ctes;
}
