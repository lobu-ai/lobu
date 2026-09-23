/**
 * Cross-org scoping guard: validateAndScopeQuery MUST reject schema-qualified
 * table references (`public.connections`, `pg_catalog.*`, …) anywhere in the
 * query.
 *
 * Why this is security-critical: org-scoping shadows UNQUALIFIED table names
 * with org-filtered CTEs. A schema-qualified reference resolves to the real
 * base table and bypasses the CTE → reads every org's rows. Regression guard:
 * the @polyglot-sql/sdk migration's first cut used `ast.getTables`, which only
 * returns the first FROM table — a schema-qualified table in a JOIN or subquery
 * slipped past and leaked. These reproducers were RED then; the raw-AST
 * walk in extractTableRefs makes them GREEN.
 */

import { describe, expect, it } from 'bun:test';
import {
  isReadQuery,
  stripLeadingComments,
  validateAndScopeQuery,
} from '../../utils/execute-data-sources';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';

const scope = (sql: string) =>
  validateAndScopeQuery(sql, 'org_test', { safeColumns: SAFE_COLUMN_DEFS });

// A non-admin caller passes the auth/identity tables as restricted.
const scopeAsMember = (sql: string) =>
  validateAndScopeQuery(sql, 'org_test', {
    safeColumns: SAFE_COLUMN_DEFS,
    restrictedTables: ADMIN_ONLY_QUERYABLE_TABLES,
  });

describe('validateAndScopeQuery — schema-qualified table rejection', () => {
  const leaks: Array<[string, string]> = [
    ['top-level', 'SELECT cc.payload_text FROM public.connections cc'],
    ['join 2nd table', 'SELECT * FROM entities e JOIN public.connections c ON c.id = e.id'],
    [
      'multi-join',
      'SELECT * FROM entities e JOIN public.connections c ON c.id = e.id JOIN public.events x ON x.id = e.id',
    ],
    [
      'subquery IN join',
      'SELECT id FROM entities WHERE id IN (SELECT id FROM entities e2 JOIN public.connections c ON true)',
    ],
    [
      'subquery EXISTS',
      'SELECT id FROM entities e WHERE EXISTS (SELECT 1 FROM public.connections c WHERE c.id = e.id)',
    ],
    ['UNION branch', 'SELECT id FROM entities UNION SELECT id FROM public.connections'],
    ['CTE body', 'WITH x AS (SELECT id FROM public.connections) SELECT * FROM x'],
    ['three-part name', 'SELECT * FROM entities e JOIN mydb.public.connections c ON true'],
  ];

  for (const [label, sql] of leaks) {
    it(`rejects a schema-qualified ref (${label})`, () => {
      expect(() => scope(sql)).toThrow(/schema-qualified/i);
    });
  }

  it('catches a deeply-nested schema-qualified ref (no recursion depth fail-open)', () => {
    let sql = 'SELECT id FROM public.events';
    for (let i = 0; i < 60; i++) sql = `SELECT id FROM (${sql}) AS _n${i}`;
    expect(() => scope(sql)).toThrow(/schema-qualified/i);
  });

  it('rejects multiple statements (the org-scoping CTEs only wrap the first)', () => {
    // The 2nd statement would otherwise run unscoped against public.oauth_tokens.
    expect(() =>
      scope('SELECT id FROM events; SELECT id FROM public.oauth_tokens')
    ).toThrow();
  });

  const clean: Array<[string, string]> = [
    ['plain', 'SELECT * FROM entities WHERE id > 0'],
    ['unqualified join', 'SELECT * FROM events ev JOIN entities en ON en.id = ANY(ev.entity_ids)'],
    [
      'jsonb aggregate view',
      "SELECT (metadata->>'vendor') AS v, SUM((metadata->>'amount')::numeric) AS s, COUNT(*) AS n FROM events GROUP BY 1",
    ],
    ['cte join', 'WITH c AS (SELECT id FROM events) SELECT * FROM c JOIN entities e ON e.id = c.id'],
    ['union', 'SELECT id FROM entities UNION SELECT id FROM events'],
  ];

  for (const [label, sql] of clean) {
    it(`scopes a clean query without error (${label})`, () => {
      const out = scope(sql);
      // every referenced base table is wrapped in an org-scoped CTE
      expect(out.sql).toContain('organization_id');
      expect(out.params[0]).toBe('org_test');
    });
  }
});

describe('validateAndScopeQuery — member table restriction (auth/identity admin-only)', () => {
  const blocked: Array<[string, string]> = [
    ['oauth_tokens', 'SELECT * FROM oauth_tokens'],
    ['oauth_clients', 'SELECT * FROM oauth_clients'],
    ['user roster', 'SELECT * FROM "user"'],
    ['joined oauth_tokens', 'SELECT * FROM entities e JOIN oauth_tokens t ON t.id = e.id'],
  ];
  for (const [label, sql] of blocked) {
    it(`blocks a non-admin from ${label}`, () => {
      expect(() => scopeAsMember(sql)).toThrow(/admin access/i);
    });
  }

  const allowed: Array<[string, string]> = [
    ['events', 'SELECT * FROM events'],
    ['entities', 'SELECT * FROM entities'],
    ['connections', 'SELECT * FROM connections'],
    ['feeds', 'SELECT * FROM feeds'],
  ];
  for (const [label, sql] of allowed) {
    it(`allows a non-admin to query ${label}`, () => {
      const out = scopeAsMember(sql);
      expect(out.sql).toContain('organization_id');
    });
  }

  it('allows an admin (no restriction) to query oauth_tokens', () => {
    const out = scope('SELECT * FROM oauth_tokens');
    expect(out.sql).toContain('organization_id');
  });
});

/**
 * Parser-bypass regressions. These were RED after the @polyglot-sql/sdk swap
 * (confirmed by the adversarial bug-hunt), because the member-accessible scoping
 * relied on `ast.getTableNames`, which (a) yields nothing for the `TABLE <name>`
 * shorthand (mis-parsed as a column) and (b) does not descend into subqueries
 * nested inside an expression (CASE / scalar). Both let a non-admin read
 * oauth_tokens — unscoped AND past the admin gate. Now GREEN via the SELECT/WITH
 * prefix guard + the complete (union) table walk + the CTE-collision guard.
 */
describe('validateAndScopeQuery — parser-bypass regressions', () => {
  it('rejects session-setting functions even in tableless SELECTs', () => {
    expect(() => scope("SELECT set_config('lobu.acl_write', 'on', false)")).toThrow(
      /Function 'set_config'.*not allowed/i
    );
    expect(() =>
      scope("SELECT pg_catalog.\"set_config\"('lobu.acl_write', 'on', false)")
    ).toThrow(/Function 'set_config'.*not allowed/i);
  });

  // Scoping shadows table NAMES; these functions read a relation named by a
  // string or regclass, or run a query given as text, so the scoped CTEs never
  // see what they touch. Each position is a separate parse shape.
  it.each([
    ["SELECT query_to_xml('SELECT count(*) FROM public.entities', true, false, '') FROM entities WHERE id = 1"],
    ["SELECT id FROM entities WHERE query_to_xml('SELECT 1 FROM public.organization', true, false, '')::text LIKE '%1%'"],
    ["SELECT * FROM query_to_xml('SELECT * FROM public.oauth_tokens', true, false, '') AS x"],
    ["SELECT pg_catalog.\"query_to_xml\"('SELECT 1', true, false, '')"],
    ["SELECT QUERY_TO_XML('SELECT 1', true, false, '')"],
    ["SELECT table_to_xml('public.entities'::regclass, true, false, '')"],
    ["SELECT query_to_xml_and_xmlschema('SELECT 1', true, false, '')"],
    ["SELECT schema_to_xml('public', true, false, '')"],
    ["SELECT database_to_xml(true, false, '')"],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(name) FROM public.entities')"],
    ["SELECT * FROM crosstab('SELECT 1, 2, 3') AS t(a int, b int)"],
    ["SELECT * FROM dblink('dbname=x', 'SELECT 1') AS t(a int)"],
    ["SELECT pg_read_file('/etc/passwd')"],
    ["SELECT pg_read_binary_file('/etc/passwd')"],
    ["SELECT * FROM pg_ls_dir('.')"],
    ["SELECT lo_get(1)"],
    ["SELECT pg_advisory_lock(1)"],
    ["SELECT pg_try_advisory_lock(1)"],
    ["SELECT pg_sleep(10)"],
    ["SELECT pg_notify('c', 'x')"],
    ["SELECT pg_terminate_backend(1)"],
  ])('rejects %s', (sql) => {
    expect(() => scopeAsMember(sql)).toThrow(/not allowed/i);
  });

  it.each([
    ["SELECT lower(name), to_char(created_at, 'YYYY'), date_trunc('day', created_at) FROM entities"],
    ["SELECT coalesce(metadata->>'tier', 'none'), jsonb_array_length(coalesce(metadata->'tags', '[]'::jsonb)) FROM entities"],
    ["SELECT count(*), max(created_at), log(2, 8), to_tsvector(name) FROM entities GROUP BY 4"],
  ])('still allows ordinary functions: %s', (sql) => {
    expect(() => scopeAsMember(sql)).not.toThrow();
  });

  it('rejects the PostgreSQL `TABLE <name>` shorthand (member)', () => {
    expect(() => scopeAsMember('TABLE oauth_tokens')).toThrow(/SELECT \/ WITH/i);
  });

  it('rejects `TABLE <name>` even for an admin (not a SELECT)', () => {
    expect(() => scope('TABLE events')).toThrow(/SELECT \/ WITH/i);
  });

  it('blocks oauth_tokens nested in a CASE-expression subquery (member)', () => {
    const sql =
      "SELECT id, (CASE WHEN true THEN (SELECT token FROM oauth_tokens LIMIT 1) ELSE 'x' END) AS leak FROM entities";
    expect(() => scopeAsMember(sql)).toThrow(/admin access/i);
  });

  it('blocks oauth_tokens nested in a scalar SELECT-list subquery (member)', () => {
    const sql = 'SELECT id, (SELECT count(*) FROM oauth_tokens) AS n FROM entities';
    expect(() => scopeAsMember(sql)).toThrow(/admin access/i);
  });

  it('still allows the same shapes for an admin (no restriction)', () => {
    const sql = 'SELECT id, (SELECT count(*) FROM oauth_tokens) AS n FROM entities';
    const out = scope(sql);
    expect(out.sql).toContain('organization_id');
  });

  it('SCOPES a non-admin table nested in a scalar subquery (no cross-org leak)', () => {
    // events nested in a SELECT-list subquery is invisible to getTableNames; the
    // complete walk catches it so it gets its own org-scoped CTE rather than
    // reading every org's events.
    const out = scopeAsMember('SELECT id, (SELECT count(*) FROM events) AS n FROM entities');
    expect(out.sql).toMatch(/"events"\s+AS\s+\(/i);
    expect(out.sql).toMatch(/"entities"\s+AS\s+\(/i);
  });

  it('rejects a CTE whose name shadows a real table (fail-closed)', () => {
    // The parser cannot tell, by lexical scope, whether `events` in the CTE body
    // is the CTE or the base table — so we forbid the ambiguity outright.
    expect(() => scope('WITH events AS (SELECT 1 AS x) SELECT * FROM events')).toThrow(
      /collides|reserved/i
    );
    expect(() =>
      scope('WITH events AS (SELECT id FROM events) SELECT * FROM events')
    ).toThrow(/collides|reserved/i);
  });

  it('rejects a CTE whose name shadows an admin-only table (fail-closed)', () => {
    expect(() =>
      scope('WITH oauth_tokens AS (SELECT 1 AS x) SELECT * FROM oauth_tokens')
    ).toThrow(/collides|reserved/i);
  });

  it('still allows an ordinary (non-colliding) CTE name', () => {
    const out = scopeAsMember('WITH recent AS (SELECT id FROM events) SELECT * FROM recent');
    expect(out.sql).toMatch(/"events"\s+AS\s+\(/i);
  });
});

/**
 * Completeness invariant — the security property the whole table-extraction
 * exists to uphold: an admin-only table referenced ANYWHERE in a member's query
 * must be rejected, in EVERY syntactic position. This is the parser-independent
 * guarantee a DB role would otherwise provide, asserted instead where we can run
 * it in CI. It is the canary for a future parser blind spot: add a position the
 * extractor can't see and one of these flips RED before the leak can ship.
 *
 * Each builder embeds the table with NO column references (SELECT 1 / count(*) /
 * ON true), so the schema validator can't reject for an unrelated reason and
 * mask a missed-table hole — the only thing that should reject is the admin gate.
 */
describe('validateAndScopeQuery — admin-table completeness invariant', () => {
  const positions: Array<[string, (t: string) => string]> = [
    ['top-level FROM', (t) => `SELECT * FROM ${t}`],
    ['JOIN', (t) => `SELECT * FROM entities e JOIN ${t} x ON true`],
    ['WHERE EXISTS subquery', (t) => `SELECT id FROM entities WHERE EXISTS (SELECT 1 FROM ${t})`],
    [
      'scalar SELECT-list subquery',
      (t) => `SELECT id, (SELECT count(*) FROM ${t}) AS n FROM entities`,
    ],
    [
      'CASE-nested subquery',
      (t) =>
        `SELECT id, (CASE WHEN true THEN (SELECT count(*) FROM ${t}) ELSE 0 END) AS n FROM entities`,
    ],
    ['CTE body', (t) => `WITH src AS (SELECT 1 AS c FROM ${t}) SELECT * FROM src`],
    ['UNION branch', (t) => `SELECT id FROM entities UNION SELECT 1 FROM ${t}`],
    [
      'doubly-nested subquery',
      (t) => `SELECT 1 FROM (SELECT 1 AS c FROM (SELECT 1 AS c FROM ${t}) AS a) AS b`,
    ],
  ];

  // SQL-safe identifiers for each restricted table ("user" is reserved).
  const adminTables = [...ADMIN_ONLY_QUERYABLE_TABLES].map((t) => (t === 'user' ? '"user"' : t));

  for (const [label, build] of positions) {
    for (const t of adminTables) {
      it(`blocks ${t} in ${label} (member)`, () => {
        expect(() => scopeAsMember(build(t))).toThrow(/admin access/i);
      });
    }
    // Inverse: the same shape with an allowed table must NOT be over-blocked —
    // it scopes cleanly (every base table wrapped in an org-scoped CTE).
    it(`does not over-block a clean ${label}`, () => {
      const out = scopeAsMember(build('events'));
      expect(out.sql).toContain('organization_id');
    });
  }
});

/**
 * Edge cases the review surfaced once query_sql became member-reachable (both
 * pre-existing in buildScopedQuery / validateTableQuery, latent while the tool
 * was admin-only). The output-alias relaxation must NOT relax real unknown
 * columns or excluded columns — those stay rejected.
 */
describe('validateAndScopeQuery — ORDER BY/GROUP BY alias + leading-comment WITH', () => {
  it('accepts ORDER BY on an output alias', () => {
    const out = scopeAsMember('SELECT COUNT(*) AS n FROM events ORDER BY n');
    expect(out.sql).toContain('organization_id');
  });

  it('accepts GROUP BY on an output alias', () => {
    const out = scopeAsMember('SELECT semantic_type AS st, COUNT(*) AS c FROM events GROUP BY st');
    expect(out.sql).toContain('organization_id');
  });

  it('still rejects ORDER BY on a genuinely unknown column', () => {
    expect(() => scopeAsMember('SELECT id FROM events ORDER BY nonsense_col')).toThrow(
      /unknown column/i
    );
  });

  it('still rejects an excluded column even when aliased', () => {
    // `credentials` is withheld from connections; aliasing it must not sneak it in.
    expect(() => scopeAsMember('SELECT credentials AS x FROM connections')).toThrow(
      /unknown column/i
    );
  });

  it('emits a single WITH for a leading-comment WITH query (valid SQL)', () => {
    const out = scopeAsMember('-- note\nWITH recent AS (SELECT id FROM events) SELECT * FROM recent');
    expect((out.sql.match(/\bWITH\b/gi) || []).length).toBe(1);
    expect(out.sql).toMatch(/"events"\s+AS\s+\(/i);
  });
});

/**
 * The read-query prefix guard strips leading comments with a LINEAR scan, not a
 * nested-quantifier regex (which backtracks catastrophically — a ReDoS, since
 * this runs on member-supplied SQL). Guards against reintroducing that.
 */
describe('isReadQuery / stripLeadingComments (ReDoS-safe)', () => {
  it('strips leading line + block comments before the SELECT/WITH check', () => {
    expect(isReadQuery('-- note\nSELECT 1')).toBe(true);
    expect(isReadQuery('/* a */ /* b */ WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isReadQuery('  \n  SELECT 1')).toBe(true);
    expect(isReadQuery('DELETE FROM events')).toBe(false);
    expect(isReadQuery('TABLE events')).toBe(false);
    expect(stripLeadingComments('-- x\n/* y */  SELECT 1')).toBe('SELECT 1');
    // unterminated comment → consumes to EOF (no match, fail-closed)
    expect(isReadQuery('/* unclosed SELECT 1')).toBe(false);
  });

  it('handles pathological unclosed-comment input in linear time (no catastrophic backtracking)', () => {
    const start = Date.now();
    expect(isReadQuery(`${'/*'.repeat(100_000)} SELECT 1`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000); // a backtracking regex would hang
  });
});
