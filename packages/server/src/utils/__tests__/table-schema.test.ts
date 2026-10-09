import { describe, expect, inject, it } from 'vitest';
import { buildScopedQuery, validateAndScopeQuery } from '../execute-data-sources';
import {
  buildColumnList,
  QUERYABLE_SCHEMA,
  QUERYABLE_TABLE_NAMES,
  SAFE_COLUMN_DEFS,
  validateTableQuery,
} from '../table-schema';

describe('QUERYABLE_TABLE_NAMES', () => {
  it('should include all expected core tables', () => {
    const expected = [
      'entities',
      'events',
      'connections',
      // Canonical Automation relations.
      'automations',
      'event_classifications',
      'automation_versions',
      'oauth_clients',
      'oauth_tokens',
      'user',
      'feeds',
      'connector_definitions',
      'entity_relationships',
      'entity_relationship_types',
      // Owner-scoped, not org-scoped — see the CTE in execute-data-sources.
      'device_workers',
    ];
    for (const t of expected) {
      expect(QUERYABLE_TABLE_NAMES.has(t)).toBe(true);
    }
  });

  it('should not include non-allowlisted tables', () => {
    expect(QUERYABLE_TABLE_NAMES.has('session')).toBe(false);
    expect(QUERYABLE_TABLE_NAMES.has('member')).toBe(false);
    expect(QUERYABLE_TABLE_NAMES.has('entity_identities')).toBe(false);
  });
});

describe('SAFE_COLUMN_DEFS', () => {
  function colList(table: string) {
    return buildColumnList(SAFE_COLUMN_DEFS.get(table)!);
  }

  it('should exclude sensitive columns from connections', () => {
    expect(colList('connections')).not.toContain('"credentials"');
  });

  it('should exclude sensitive columns from oauth_clients', () => {
    expect(colList('oauth_clients')).not.toContain('"client_secret"');
  });

  it('should exclude sensitive columns from oauth_tokens', () => {
    expect(colList('oauth_tokens')).not.toContain('"token_hash"');
  });

  it('should exclude PII from user', () => {
    const cols = colList('user');
    expect(cols).not.toContain('"email"');
    expect(cols).not.toContain('"phoneNumber"');
  });

  it('should exclude embeddings from entities', () => {
    const cols = colList('entities');
    expect(cols).not.toContain('"embedding"');
    expect(cols).not.toContain('"content_tsv"');
  });

  it('should emit direct columns for automation_versions', () => {
    const cols = colList('automation_versions');
    expect(cols).toContain('"prompt"');
    expect(cols).toContain('"outputs"');
  });

  it('should prefix columns with alias', () => {
    const defs = SAFE_COLUMN_DEFS.get('automation_versions')!;
    const cols = buildColumnList(defs, 'wv');
    expect(cols).toContain('wv."prompt"');
    expect(cols).toContain('wv."id"');
  });
});

describe('validateTableQuery', () => {
  it('should accept queries referencing allowlisted tables', () => {
    const result = validateTableQuery('SELECT id, name FROM entities');
    expect(result.valid).toBe(true);
  });

  it('should reject queries referencing unknown tables', () => {
    const result = validateTableQuery('SELECT * FROM session');
    expect(result.valid).toBe(false);
  });

  it('should reject queries referencing sensitive columns', () => {
    const result = validateTableQuery('SELECT credentials FROM connections');
    expect(result.valid).toBe(false);
  });

  it('should reject queries referencing excluded PII columns', () => {
    const result = validateTableQuery('SELECT email FROM "user"');
    expect(result.valid).toBe(false);
  });
});

describe('validateAndScopeQuery', () => {
  it('should validate and scope graph queries', () => {
    const scoped = validateAndScopeQuery(
      `SELECT e.id FROM entities e
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_relationships er
         JOIN entity_relationship_types ert ON ert.id = er.relationship_type_id
         WHERE er.from_entity_id = e.id AND ert.slug = 'works_at')`,
      'org_test',
      { safeColumns: SAFE_COLUMN_DEFS }
    );

    expect(scoped.tableRefs).toEqual(
      expect.arrayContaining(['entities', 'entity_relationships', 'entity_relationship_types'])
    );
    expect(scoped.params).toEqual(['org_test']);
    expect(scoped.sql).toMatch(
      /public\.entity_relationships WHERE organization_id = \$1 AND deleted_at IS NULL/
    );
    expect(scoped.sql).toMatch(
      /public\.entity_relationship_types rt LEFT JOIN public\.organization o.*rt\.deleted_at IS NULL.*rt\.organization_id = \$1 OR o\.visibility = 'public'/
    );
  });

  it('does not bind an unused organization parameter for tableless SELECTs', () => {
    const sql = 'SELECT generate_series(1, 25) AS row_number';
    const scoped = validateAndScopeQuery(sql, 'org_test', {
      safeColumns: SAFE_COLUMN_DEFS,
    });

    expect(scoped.tableRefs).toEqual([]);
    expect(scoped.sql).toBe(sql);
    expect(scoped.params).toEqual([]);
  });

  it('keeps identity claims out of the raw query allowlist', () => {
    expect(() =>
      validateAndScopeQuery(
        'SELECT identifier FROM entity_identities',
        'org_test',
        { safeColumns: SAFE_COLUMN_DEFS }
      )
    ).toThrow(/Unknown table 'entity_identities'/);
  });

  it('keeps tableless params empty when an unused entity context is present', () => {
    const scoped = buildScopedQuery('SELECT 1 AS value', [], {
      organizationId: 'org_test',
      entityIds: [42],
    });

    expect(scoped.sql).toBe('SELECT 1 AS value');
    expect(scoped.params).toEqual([]);
  });

  it('binds repeated tableless entity placeholders once with compiler casts', () => {
    const scoped = buildScopedQuery(
      'SELECT {{entityId}} AS first_id, {{entityId}} AS second_id',
      [],
      {
        organizationId: 'org_test',
        entityIds: [42],
      }
    );

    expect(scoped.sql).toBe('SELECT $1::bigint AS first_id, $1::bigint AS second_id');
    expect(scoped.params).toEqual([42]);
  });

  it('binds organization context only when a tableless query references it', () => {
    const scoped = buildScopedQuery('SELECT {{organizationId}} AS organization_id', [], {
      organizationId: 'org_test',
    });

    expect(scoped.sql).toBe('SELECT $1 AS organization_id');
    expect(scoped.params).toEqual(['org_test']);
  });

  it('binds tableless query context values with text casts', () => {
    const scoped = buildScopedQuery('SELECT {{query.name}} AS name', [], {
      organizationId: 'org_test',
      query: { name: 'Alpha' },
    });

    expect(scoped.sql).toBe('SELECT $1::text AS name');
    expect(scoped.params).toEqual(['Alpha']);
  });

  it('rejects unresolved placeholders in tableless queries', () => {
    expect(() =>
      buildScopedQuery('SELECT {{unknown}} AS value', [], {
        organizationId: 'org_test',
      })
    ).toThrow('Unknown context variables: {{unknown}}');
  });

  it('rejects raw positional parameters in tableless queries', () => {
    expect(() =>
      buildScopedQuery('SELECT $1 AS value', [], {
        organizationId: 'org_test',
      })
    ).toThrow('Positional parameters ($1, $2, ...) are not allowed');
  });
});

/**
 * Schema drift detection — runs whenever the suite has a Postgres backend.
 *
 * BIDIRECTIONAL, and it has to be. The original block only checked DB → schema
 * ("is every real column listed?"). The opposite direction is the one that
 * takes a relation down entirely: `buildColumnList` emits an EXPLICIT
 * projection into the generated CTE, so a schema column that does not exist in
 * the database is injected into every query against that relation — including
 * `SELECT 1 AS one FROM automation_versions`, which references no column at all.
 * `automation_versions` listed `sources` (an `automations` column that has never
 * existed on `automation_versions`) and was therefore 100% unqueryable in prod,
 * with an error naming a column no caller ever wrote, while this gate stayed
 * green. A one-directional drift check is a half gate.
 *
 * Gating note: the previous `describe.skipIf(!process.env.DATABASE_URL)` was
 * evaluated at module load. In the embedded-PG path the URL is set by
 * global-setup in the SETUP process; whether a forked vitest worker observes it
 * at module-load time is timing-dependent, so the block could silently
 * self-skip and the gate was toothless. We now gate on the URL `provide()`d by
 * global-setup and read via `inject()` at runtime — vitest's transport-level
 * channel always reaches forks — and skip from inside the test so the decision
 * is made against the authoritative value.
 */
describe('QUERYABLE_SCHEMA vs database (drift detection)', () => {
  const INTENTIONALLY_OMITTED: Record<string, Set<string>> = {
    // enabled_classifiers (entities) and classifiers (automation_versions) were
    // retired with Automation classifier extraction. Schema exposure is removed
    // ahead of the two-phase column drop.
    entities: new Set(['embedding', 'content_tsv', 'content_hash', 'field_controls', 'enabled_classifiers']),
    automation_versions: new Set(['classifiers']),
    // superseded_by: the query_sql events CTE reads from current_event_records,
    // which doesn't expose the column — and never usefully can: the Stage-2
    // flip makes the view `WHERE superseded_by IS NULL`, so through the view
    // the column is always NULL. Lineage queries belong on the raw table.
    // linked_org_ids: internal org-scope bridge (migration 20260804170000). The
    // view exposes it so eventOrgScope can use the GIN-indexed containment
    // predicate, but the raw array is not a user query surface — scoping is
    // enforced by the typed tools, not by callers probing which other orgs an
    // event bridges to.
    events: new Set(['superseded_by', 'linked_org_ids']),
    connections: new Set(['credentials']),
    // Large per-connector JSONB blobs — too big and structure-dependent to expose
    // via raw SQL. Callers should hit the typed connector handler instead.
    connector_definitions: new Set([
      // Browser grants include executable account probes; use typed discovery.
      'browser',
      'mcp_config',
      'api_config',
      'openapi_config',
      'default_connection_config',
      // Retired with the connector repair-agent subsystem. Schema exposure is
      // removed ahead of the two-phase column drop, so the physical column
      // outlives its QUERYABLE_SCHEMA entry until the phase-2 migration.
      'default_repair_agent_id',
    ]),
    // user_id: always the caller under the CTE's owner filter, so projecting it
    // adds nothing but a correlation handle.
    // connector_manifests: free-form jsonb the device writes verbatim — the
    // same uncurated-write risk class that forced redaction onto
    // connections.config, and nothing needs it to pin an Automation.
    device_workers: new Set(['user_id', 'connector_manifests']),
    oauth_clients: new Set(['client_secret', 'client_secret_expires_at']),
    // granted_organization_ids / authorization_grant_type: internal grant
    // snapshot and issuing-flow provenance (migrations 20260827110000/-02),
    // same class as events.linked_org_ids — enforcement inputs for the typed
    // OAuth verifier, not a user query surface.
    oauth_tokens: new Set([
      'token_hash',
      'granted_organization_ids',
      'authorization_grant_type',
    ]),
    // repair_*/last_repair_*: same retired repair-agent subsystem, awaiting the
    // phase-2 DROP COLUMN migration.
    feeds: new Set([
      'checkpoint',
      'kind',
      'virtual',
      'repair_agent_id',
      'repair_thread_id',
      'repair_attempt_count',
      'last_repair_at',
      'last_repair_post_hash',
    ]),
    // scheduler_client_id: retired with the Automation scheduler rework in #2499,
    // which stopped writing it and replaced it with agent_kind on the read path.
    // Prod has it NULL on every row. Schema exposure is removed ahead of the
    // two-phase column drop, so the physical column outlives its
    // QUERYABLE_SCHEMA entry until the phase-2 migration. next_window_start is
    // internal scheduler coordination state, exposed through the Automation
    // contract as pending_analysis.next_window rather than raw query_sql. The
    // latest-completion scalar is the rest of that same scheduler-internal
    // projection.
    automations: new Set([
      'scheduler_client_id',
      'next_window_start',
      'last_completed_window_start',
      // Product evals are retired. Keep physical columns through release N
      // while old replicas still project them; drop them in release N+1.
      'latest_eval_score',
      'latest_eval_at',
      'latest_eval_run_id',
    ]),
    user: new Set(['email', 'phoneNumber', 'phoneNumberVerified']),
  };

  /**
   * Schema columns that legitimately have no physical column of that name on
   * the backing table, because the CTE DERIVES them. Keep this list tiny: every
   * entry is a column the reverse check can no longer protect.
   */
  const DERIVED_COLUMNS: Record<string, Set<string>> = {
    // entities CTE JOINs entity_types and aliases et.slug AS entity_type.
    entities: new Set(['entity_type']),
  };

  /** relation name → physical column set, read once per drift test. */
  async function loadDbColumns(): Promise<Map<string, Set<string>>> {
    const { getDb, pgTextArray } = await import('../../db/client');
    const sql = getDb();

    const physicalNames = QUERYABLE_SCHEMA.tables.map((t) => t.name);

    const rows = await sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY(${pgTextArray(physicalNames)}::text[])
      ORDER BY table_name, ordinal_position
    `;

    const byPhysical = new Map<string, Set<string>>();
    for (const row of rows) {
      const table = row.table_name as string;
      if (!byPhysical.has(table)) byPhysical.set(table, new Set());
      byPhysical.get(table)!.add(row.column_name as string);
    }

    const byRelation = new Map<string, Set<string>>();
    for (const t of QUERYABLE_SCHEMA.tables) {
      const physical = byPhysical.get(t.name);
      if (physical) byRelation.set(t.name, physical);
    }
    return byRelation;
  }

  it('resolves every exposed relation to a real physical table', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      ctx.skip();
      return;
    }
    process.env.DATABASE_URL = databaseUrl;

    // A relation that resolves to nothing means both drift directions silently
    // pass for it. Assert coverage explicitly rather than letting a `continue`
    // skip it.
    const byRelation = await loadDbColumns();
    const unresolved = QUERYABLE_SCHEMA.tables
      .map((t) => t.name)
      .filter((name) => !byRelation.has(name));

    expect(
      unresolved,
      `Exposed relations with no backing table/view:\n  ${unresolved.join('\n  ')}`
    ).toEqual([]);
  });

  it('should have every DB column listed in the schema (or intentionally omitted)', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      // Only reachable when SKIP_TEST_DB_SETUP=1 — no backend to diff against.
      ctx.skip();
      return;
    }
    // Defensive: pin the env the db client reads to the authoritative URL from
    // global-setup, independent of env-propagation timing into this fork.
    process.env.DATABASE_URL = databaseUrl;

    const byRelation = await loadDbColumns();

    const missing: string[] = [];
    for (const t of QUERYABLE_SCHEMA.tables) {
      const dbCols = byRelation.get(t.name);
      if (!dbCols) continue; // asserted non-empty by the coverage test above
      const schemaCols = new Set(t.columns.map((c) => c.name));
      const omitted = INTENTIONALLY_OMITTED[t.name];
      for (const column of dbCols) {
        if (omitted?.has(column)) continue;
        if (!schemaCols.has(column)) missing.push(`${t.name}.${column}`);
      }
    }

    expect(missing, `DB columns missing from QUERYABLE_SCHEMA:\n  ${missing.join('\n  ')}`).toEqual(
      []
    );
  });

  it('should not list a schema column the physical table does not have', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      ctx.skip();
      return;
    }
    process.env.DATABASE_URL = databaseUrl;

    // The direction that was missing. A phantom column is injected into the
    // generated CTE's explicit projection, so it does not degrade one query —
    // it breaks EVERY query against the relation. This is what let
    // `automation_versions.sources` reach prod.
    const byRelation = await loadDbColumns();

    const phantom: string[] = [];
    for (const t of QUERYABLE_SCHEMA.tables) {
      const dbCols = byRelation.get(t.name);
      if (!dbCols) continue; // asserted non-empty by the coverage test above
      const derived = DERIVED_COLUMNS[t.name];
      for (const c of t.columns) {
        if (derived?.has(c.name)) continue;
        if (!dbCols.has(c.name)) phantom.push(`${t.name}.${c.name}`);
      }
    }

    expect(
      phantom,
      `QUERYABLE_SCHEMA columns with no physical column (every query against ` +
        `these relations fails):\n  ${phantom.join('\n  ')}`
    ).toEqual([]);
  });

  it('should execute graph CTEs with local and public relationship types only', async (ctx) => {
    const databaseUrl = inject('databaseUrl');
    if (!databaseUrl) {
      ctx.skip();
      return;
    }
    process.env.DATABASE_URL = databaseUrl;

    const { getDb } = await import('../../db/client');
    const sql = getDb();
    await sql`
      INSERT INTO organization (id, name, slug, visibility)
      VALUES
        ('schema-scope-local', 'Schema Scope Local', 'schema-scope-local', 'private'),
        ('schema-scope-public', 'Schema Scope Public', 'schema-scope-public', 'public'),
        ('schema-scope-private', 'Schema Scope Private', 'schema-scope-private', 'private')
    `;
    await sql`
      INSERT INTO entity_relationship_types
        (organization_id, slug, name, deleted_at)
      VALUES
        ('schema-scope-local', 'schema-scope-local', 'Local', NULL),
        ('schema-scope-public', 'schema-scope-public', 'Public', NULL),
        ('schema-scope-private', 'schema-scope-private', 'Private', NULL),
        ('schema-scope-public', 'schema-scope-deleted', 'Deleted', NOW())
    `;

    const scoped = validateAndScopeQuery(
      `SELECT ert.slug
       FROM entity_relationship_types ert
       LEFT JOIN entity_relationships er ON er.relationship_type_id = ert.id
       WHERE ert.slug LIKE 'schema-scope-%'
       ORDER BY ert.slug`,
      'schema-scope-local',
      { safeColumns: SAFE_COLUMN_DEFS }
    );
    const rows = await sql.unsafe(scoped.sql, scoped.params);

    expect(rows.map((row) => row.slug)).toEqual(['schema-scope-local', 'schema-scope-public']);
  });
});
