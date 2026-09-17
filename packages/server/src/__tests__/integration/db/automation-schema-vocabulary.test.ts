import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadMigrationUpSection } from '../../../db/migration-loader';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const CUTOVER_MIGRATION = '20260816000010_automation_vocabulary.sql';
const CANVAS_REMOVAL_MIGRATION = '20260820120000_remove_canvas_runtime.sql';
const CANVAS_RESULT_CUTOVER_START = '-- canvas-result-cutover:start';
const CANVAS_RESULT_CUTOVER_END = '-- canvas-result-cutover:end';
const ORPHAN_REACTION_CUTOVER_START = '-- orphan-reaction-cutover:start';
const ORPHAN_REACTION_CUTOVER_END = '-- orphan-reaction-cutover:end';
const TRAIT_REWRITE_START = '-- connector-trait-merge-strategy:start';
const TRAIT_REWRITE_END = '-- connector-trait-merge-strategy:end';
const ENTITY_REWRITE_START = '-- entity-metadata-cutover:start';
const ENTITY_REWRITE_END = '-- entity-metadata-cutover:end';
const AUTHORED_QUERY_CUTOVER_START = '-- authored-query-cutover:start';
const AUTHORED_QUERY_CUTOVER_END = '-- authored-query-cutover:end';

class Rollback extends Error {}

function resolveMigrationsDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate db/migrations from the test directory');
}

function loadMarkedSection(
  startMarker: string,
  endMarker: string,
  label: string,
  migration = CUTOVER_MIGRATION,
): string {
  const up = loadMigrationUpSection(resolveMigrationsDir(), migration);
  const start = up.indexOf(startMarker);
  const end = up.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error(`Could not locate ${label}`);
  return up.slice(start + startMarker.length, end);
}

function loadTraitRewrite(): string {
  return loadMarkedSection(TRAIT_REWRITE_START, TRAIT_REWRITE_END, 'connector trait rewrite');
}

function loadCanvasResultCutover(): string {
  return loadMarkedSection(
    CANVAS_RESULT_CUTOVER_START,
    CANVAS_RESULT_CUTOVER_END,
    'Canvas result cutover',
    CANVAS_REMOVAL_MIGRATION,
  );
}

function loadOrphanReactionCutover(): string {
  return loadMarkedSection(
    ORPHAN_REACTION_CUTOVER_START,
    ORPHAN_REACTION_CUTOVER_END,
    'orphan reaction cutover',
    CANVAS_REMOVAL_MIGRATION,
  );
}

describe('Automation schema vocabulary', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('bridges keyed event identity without rewriting or deleting authored event history', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/\bDELETE\s+FROM\s+(?:public\.)?events\b/i);
    expect(up).not.toMatch(/UPDATE\s+(?:public\.)?events[^;]*SET\s+(?:payload_|metadata|attachments|identity_)/i);
    expect(up).toMatch(/SET\s+superseded_by\s*=\s*canonical\.id/i);
    expect(up).toMatch(/legacy\.id,\s*'automation_event',\s*legacy\.identity_key/i);
  });

  it('does not globally rewrite user-authored SQL, templates, or opaque run JSON', () => {
    const up = loadMigrationUpSection(resolveMigrationsDir(), CUTOVER_MIGRATION);
    expect(up).not.toMatch(/UPDATE\s+public\.(?:watchers|watcher_versions|view_template_versions)\b/i);
    expect(up).not.toMatch(/SET\s+\w+\s*=\s*replace\s*\(\s*replace\s*\([^;]*::text/is);
  });

  it('preserves legacy runless Canvas results as completed runs', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
      agentId: 'runless-canvas-cutover-agent',
    });

    try {
      await sql.begin(async (tx: typeof sql) => {
        const windowStart = '2026-08-18T00:00:00.000Z';
        const windowEnd = '2026-08-19T00:00:00.000Z';
        await tx`
          ALTER TABLE automations
            ALTER CONSTRAINT automations_current_version_id_fkey DEFERRABLE INITIALLY DEFERRED,
            ADD COLUMN notification_channel text,
            ADD COLUMN notification_priority text
        `;
        const createLegacyCanvas = async (params: {
          slug: string;
          payload: Record<string, unknown>;
          metadataIdKey: 'automation_id' | 'watcher_id';
          contentAnalyzed: number;
        }): Promise<{ automationId: number; legacyId: number }> => {
          const [automation] = await tx<{ id: number }[]>`
            WITH next_id AS (
              SELECT nextval('automations_id_seq')::int AS id
            )
            INSERT INTO automations (
              id, organization_id, created_by, managed_agent_id, automation_group_id,
              name, slug
            )
            SELECT id, ${org.id}, ${user.id}, ${agent.agentId}, id, ${params.slug}, ${params.slug}
            FROM next_id
            RETURNING id
          `;
          const [legacy] = await tx<{ id: number }[]>`
            INSERT INTO events (
              organization_id, entity_ids, origin_id, payload_type, payload_data,
              metadata, semantic_type, automation_id, occurred_at, created_at
            ) VALUES (
              ${org.id}, '{}'::bigint[], ${params.slug}, 'json_template', ${tx.json(params.payload)},
              ${tx.json({
                [params.metadataIdKey]: automation.id,
                // Historical shape, deliberately kept. This fixture replays the
                // Canvas cutover against production data written BEFORE the
                // arrival axis, and that migration only synthesizes a run for a
                // head whose `metadata->>'granularity'` is non-null. The arrival
                // cutover retires the field going forward; it cannot retroactively
                // remove it from rows the migration still has to read.
                granularity: 'daily',
                window_start: windowStart,
                window_end: windowEnd,
                content_analyzed: params.contentAnalyzed,
                version_id: null,
              })},
              'canvas_state', ${automation.id}, ${windowEnd}, ${windowEnd}
            )
            RETURNING id
          `;
          return { automationId: automation.id, legacyId: legacy.id };
        };

        const skipped = await createLegacyCanvas({
          slug: 'runless-canvas-cutover',
          payload: {},
          metadataIdKey: 'automation_id',
          contentAnalyzed: 0,
        });
        const legacyPayload = { tasks: [{ title: 'Preserved result' }] };
        const legacyResult = await createLegacyCanvas({
          slug: 'legacy-result-cutover',
          payload: legacyPayload,
          metadataIdKey: 'watcher_id',
          contentAnalyzed: 3,
        });
        const linkedPayload = { summary: 'Preserved linked result' };
        const linked = await createLegacyCanvas({
          slug: 'linked-run-cutover',
          payload: linkedPayload,
          metadataIdKey: 'watcher_id',
          contentAnalyzed: 5,
        });
        const [legacyVersion] = await tx<{ id: number }[]>`
          INSERT INTO automation_versions (
            automation_id, version, name, created_by, prompt, version_sources
          ) VALUES (
            ${legacyResult.automationId}, 1, 'Legacy result cutover', ${user.id},
            'Preserve the legacy result', '[]'::jsonb
          )
          RETURNING id
        `;
        await tx`
          UPDATE automations
          SET current_version_id = ${legacyVersion.id}
          WHERE id = ${legacyResult.automationId}
        `;

        // The marked section runs before the full migration drops this legacy
        // relation key; the test database has already applied that final drop.
        await tx`ALTER TABLE runs ADD COLUMN IF NOT EXISTS window_id bigint`;
        await tx`ALTER TABLE automation_reactions DROP CONSTRAINT IF EXISTS automation_reactions_source_run_id_fkey`;
        await tx`ALTER TABLE automation_reactions RENAME COLUMN source_run_id TO window_id`;
        const [orphanReaction] = await tx<{ id: number }[]>`
          INSERT INTO automation_reactions (
            organization_id, automation_id, window_id, reaction_type, tool_name, created_at
          ) VALUES (
            ${org.id}, ${legacyResult.automationId}, ${legacyResult.automationId},
            'notification_sent', 'notify', '2026-08-18T12:00:00.000Z'
          )
          RETURNING id
        `;
        const [linkedRun] = await tx<{ id: number }[]>`
          INSERT INTO runs (
            organization_id, run_type, automation_id, approval_status, status,
            action_output, approved_input, run_metadata, window_id, created_at,
            completed_at
          ) VALUES (
            ${org.id}, 'automation', ${linked.automationId}, 'auto', 'completed',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${linked.legacyId},
            ${windowEnd}, ${windowEnd}
          )
          RETURNING id
        `;
        await tx.unsafe(loadCanvasResultCutover());
        // Production rejected the later structural cutover while this FK check was pending.
        await tx`
          ALTER TABLE automations
            DROP COLUMN notification_channel,
            DROP COLUMN notification_priority
        `;
        await tx.unsafe(loadOrphanReactionCutover());

        const [run] = await tx`
          SELECT id, status, outcome, action_output, approved_input, run_metadata
          FROM runs
          WHERE automation_id = ${skipped.automationId} AND run_type = 'automation'
        `;
        expect(run).toMatchObject({
          status: 'completed',
          outcome: 'scoreable',
          action_output: {},
          approved_input: {
            automation_id: skipped.automationId,
            dispatch_source: 'scheduled',
            window_start: windowStart,
            window_end: windowEnd,
          },
          run_metadata: { content_analyzed: 0, skipped_unchanged: true },
        });
        const [mapping] = await tx`
          SELECT run_id, head_event_id
          FROM canvas_run_map
          WHERE legacy_id = ${skipped.legacyId}
        `;
        expect(Number(mapping.run_id)).toBe(Number(run.id));
        expect(Number(mapping.head_event_id)).toBe(Number(skipped.legacyId));

        const [resultRun] = await tx`
          SELECT id, status, outcome, action_output, approved_input, run_metadata
          FROM runs
          WHERE automation_id = ${legacyResult.automationId} AND run_type = 'automation'
        `;
        expect(resultRun).toMatchObject({
          status: 'completed',
          outcome: 'scoreable',
          action_output: legacyPayload,
          approved_input: {
            automation_id: legacyResult.automationId,
            dispatch_source: 'scheduled',
            window_start: windowStart,
            window_end: windowEnd,
          },
          run_metadata: { content_analyzed: 3 },
        });
        const [resultMapping] = await tx`
          SELECT run_id, head_event_id
          FROM canvas_run_map
          WHERE legacy_id = ${legacyResult.legacyId}
        `;
        expect(Number(resultMapping.run_id)).toBe(Number(resultRun.id));
        expect(Number(resultMapping.head_event_id)).toBe(Number(legacyResult.legacyId));
        const [preservedReaction] = await tx`
          SELECT window_id
          FROM automation_reactions
          WHERE id = ${orphanReaction.id}
        `;
        expect(Number(preservedReaction.window_id)).toBe(Number(resultRun.id));

        const linkedRuns = await tx`
          SELECT id, action_output, approved_input, run_metadata
          FROM runs
          WHERE automation_id = ${linked.automationId} AND run_type = 'automation'
        `;
        expect(linkedRuns).toHaveLength(1);
        expect(Number(linkedRuns[0].id)).toBe(Number(linkedRun.id));
        expect(linkedRuns[0]).toMatchObject({
          action_output: linkedPayload,
          approved_input: {
            window_start: windowStart,
            window_end: windowEnd,
          },
          run_metadata: { content_analyzed: 5 },
        });

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('fails the cutover when stored authored SQL still names a retired relation', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
      agentId: 'authored-query-cutover-agent',
    });
    // The cutover text still names `view_template_versions` (a frozen,
    // already-applied migration), while the views migration retires that
    // table — on fresh installs the cutover runs first, with the table
    // present. Recreate the retired shape here so this replay keeps proving
    // the template carrier is guarded; drop it after.
    await sql.unsafe(`
      CREATE TABLE public.view_template_versions (
        id serial PRIMARY KEY,
        resource_type text NOT NULL,
        resource_id text NOT NULL,
        organization_id text NOT NULL,
        version integer NOT NULL,
        tab_name text,
        tab_order integer DEFAULT 0,
        json_template jsonb NOT NULL,
        change_notes text,
        created_by text NOT NULL,
        created_at timestamptz DEFAULT now()
      )
    `);
    try {
      await sql`
        INSERT INTO view_template_versions (
          resource_type, resource_id, organization_id, version,
          json_template, created_by
        ) VALUES (
          'entity_type', 'authored-prose', ${org.id}, 1,
          ${sql.json({
            type: 'text',
            content: 'Customer-authored watchers and behaviors prose',
            data_sources: { rows: { query: 'SELECT id FROM automations' } },
          })},
          ${user.id}
        )
      `;

      const [authoredAutomation] = await sql<{ id: number }[]>`
      WITH next_id AS (
        SELECT nextval('automations_id_seq')::int AS id
      )
      INSERT INTO automations (
        id, organization_id, created_by, managed_agent_id, automation_group_id,
        name, slug, sources
      )
      SELECT
        id, ${org.id}, ${user.id}, ${agent.agentId}, id,
        'Authored query cutover', 'authored-query-cutover',
        ${sql.json([
          {
            name: 'canonical',
            description: 'Customer-authored watchers and behaviors prose',
            query: 'SELECT id FROM automations',
          },
        ])}
      FROM next_id
      RETURNING id
    `;
    await sql`
      INSERT INTO automation_versions (
        automation_id, version, name, created_by, prompt, version_sources
      ) VALUES (
        ${authoredAutomation.id}, 1, 'Authored query cutover', ${user.id},
        'Customer-authored watchers and behaviors prompt',
        ${sql.json([
          {
            name: 'canonical',
            description: 'Customer-authored watchers and behaviors prose',
            query: 'SELECT id FROM automations',
          },
        ])}
      )
    `;

    const cutover = loadMarkedSection(
      AUTHORED_QUERY_CUTOVER_START,
      AUTHORED_QUERY_CUTOVER_END,
      'authored query cutover'
    );
    await sql.begin((tx) => tx.unsafe(cutover));

    await sql`
      UPDATE automations
      SET sources = ${sql.json([{ name: 'legacy', query: 'SELECT id FROM behaviors' }])}
      WHERE id = ${authoredAutomation.id}
    `;

    expect(cutover).toMatch(/FROM public\.automations\b/);
    expect(cutover).toMatch(/FROM public\.automation_versions\b/);
    expect(cutover).toMatch(/FROM public\.view_template_versions\b/);
    expect(cutover).toMatch(/FROM public\.entity_types\b/);
    await expect(sql.begin((tx) => tx.unsafe(cutover))).rejects.toThrow(
      /cutover blocked by 1 stored query\/template row/i
    );
    } finally {
      await sql.unsafe(`DROP TABLE public.view_template_versions`);
    }
  });

  it('hard-renames persisted connector trait merge policies in definitions and device manifests', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const legacyTrait = {
      eventPath: 'metadata.display_name',
      behavior: 'prefer_non_empty',
    };
    const feedsSchema = {
      messages: {
        configSchema: {
          type: 'object',
          default: { behavior: 'overwrite' },
        },
        eventKinds: {
          message: {
            attributions: [{ role: 'authored_by', traits: { display_name: legacyTrait } }],
          },
        },
      },
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          INSERT INTO connector_definitions
            (organization_id, key, name, version, auth_schema, feeds_schema, status)
          VALUES (
            ${org.id}, 'merge-strategy-cutover', 'Merge strategy cutover', '1.0.0',
            ${tx.json({ methods: [{ type: 'none' }] })}, ${tx.json(feedsSchema)}, 'active'
          )
        `;
        await tx`
          INSERT INTO device_workers
            (user_id, worker_id, platform, app_version, capabilities, label,
             organization_id, connector_manifests)
          VALUES (
            ${user.id}, 'merge-strategy-cutover', 'macos', '1.0.0',
            ${tx.json(['test'])}, 'Merge strategy cutover', ${org.id},
            ${tx.json({
              test: {
                manifest_hash: 'legacy',
                received_at: '2026-08-15T00:00:00.000Z',
                manifest: { key: 'test', feeds_schema: feedsSchema },
              },
            })}
          )
        `;

        const rewrite = loadTraitRewrite();
        await tx.unsafe(rewrite);
        await tx.unsafe(rewrite);

        const [definition] = await tx<{ feeds_schema: Record<string, unknown> }[]>`
          SELECT feeds_schema
          FROM connector_definitions
          WHERE organization_id = ${org.id} AND key = 'merge-strategy-cutover'
        `;
        const [device] = await tx<{ connector_manifests: Record<string, unknown> }[]>`
          SELECT connector_manifests
          FROM device_workers
          WHERE user_id = ${user.id} AND worker_id = 'merge-strategy-cutover'
        `;

        const definitionText = JSON.stringify(definition.feeds_schema);
        const manifestText = JSON.stringify(device.connector_manifests);
        expect(definitionText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(manifestText).toContain('"mergeStrategy":"prefer_non_empty"');
        expect(definitionText).toContain('"default":{"behavior":"overwrite"}');
        expect(manifestText).toContain('"default":{"behavior":"overwrite"}');
        expect(definitionText).not.toContain('"behavior":"prefer_non_empty"');
        expect(manifestText).not.toContain('"behavior":"prefer_non_empty"');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('rewrites only entity metadata claimed by Automation identities', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization();
    const user = await createTestUser();
    const owned = await createTestEntity({
      name: 'Owned Automation entity',
      organization_id: org.id,
      created_by: user.id,
    });
    const authored = await createTestEntity({
      name: 'Customer-authored entity',
      organization_id: org.id,
      created_by: user.id,
    });
    const legacyMetadata = {
      automation_id: null,
      behavior_id: null,
      watcher_id: 42,
      source: 'watcher_promotion',
      resourceKind: 'behavior',
      resource_kind: 'watcher',
      note: 'customer text remains byte-for-byte',
    };

    try {
      await sql.begin(async (tx: typeof sql) => {
        await tx`
          UPDATE entities
          SET metadata = ${tx.json(legacyMetadata)}
          WHERE id IN (${owned.id}, ${authored.id})
        `;
        await tx`
          INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
          VALUES (${org.id}, ${owned.id}, 'automation_key', 'owned-automation-key')
        `;

        const rewrite = loadMarkedSection(ENTITY_REWRITE_START, ENTITY_REWRITE_END, 'entity metadata cutover');
        await tx.unsafe(rewrite);
        await tx.unsafe(rewrite);

        const rows = await tx<{ id: number; metadata: Record<string, unknown> }[]>`
          SELECT id, metadata
          FROM entities
          WHERE id IN (${owned.id}, ${authored.id})
          ORDER BY id
        `;
        const ownedRow = rows.find((row) => Number(row.id) === owned.id);
        const authoredRow = rows.find((row) => Number(row.id) === authored.id);
        expect(ownedRow?.metadata).toEqual({
          automation_id: 42,
          source: 'automation_promotion',
          resourceKind: 'automation',
          resource_kind: 'automation',
          note: 'customer text remains byte-for-byte',
        });
        expect(authoredRow?.metadata).toEqual(legacyMetadata);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
  it('contains no live schema identifiers or definitions using retired product names', async () => {
    const sql = getTestDb();
    const rows = await sql<{ kind: string; name: string }[]>`
      SELECT 'relation' AS kind, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'column', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'constraint', con.conname
      FROM pg_constraint con
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'
        AND (
          con.conname ~* '(watcher|behavior)'
          OR pg_get_constraintdef(con.oid) ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'trigger', trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND (
          trigger_name ~* '(watcher|behavior)'
          OR action_statement ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'function', p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND (
          p.proname ~* '(watcher|behavior)'
          OR CASE
            WHEN p.prokind IN ('f', 'p')
              THEN pg_get_functiondef(p.oid) ~* '(watcher|behavior)'
            ELSE false
          END
        )
      UNION ALL
      SELECT 'view', viewname
      FROM pg_views
      WHERE schemaname = 'public' AND definition ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'default', table_name || '.' || column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'index', indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ~* '(watcher|behavior)'
      UNION ALL
      SELECT 'policy', policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (
          qual ~* '(watcher|behavior)'
          OR with_check ~* '(watcher|behavior)'
        )
      UNION ALL
      SELECT 'comment', COALESCE(c.relname || '.' || a.attname, c.relname, p.proname)
      FROM pg_description d
      LEFT JOIN pg_class c ON c.oid = d.objoid
      LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      LEFT JOIN pg_proc p ON p.oid = d.objoid
      LEFT JOIN pg_namespace n ON n.oid = COALESCE(c.relnamespace, p.pronamespace)
      WHERE n.nspname = 'public' AND d.description ~* '(watcher|behavior)'
      ORDER BY kind, name
    `;

    expect(rows).toEqual([]);
  });
});
