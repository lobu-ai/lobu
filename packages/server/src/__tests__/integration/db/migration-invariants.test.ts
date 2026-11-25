/**
 * Migration-invariant guard.
 *
 * The test harness applies the real baseline -> latest migration chain before
 * any test runs (setup/test-db.ts). This suite asserts the load-bearing schema
 * invariants that recent migrations established, so a future migration that
 * silently drops or reshapes one fails CI here rather than in production.
 *
 * Motivated by the 2-week stability audit:
 *  - #1121 reshaped pending-auth uniqueness from org-wide to per-user, scoped to
 *    oauth_account. The functional contract (same user collides, distinct users
 *    run parallel OAuth flows) is the real invariant — pin it, not just the DDL.
 *  - #1069/#1080 added event_embeddings.embedding_model; its absence reopens the
 *    full-corpus recall regression.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from '../../../db/migration-loader';
import { createAuthProfile, PendingAuthConflictError } from '../../../utils/auth-profiles';
import { assertSchemaUpToDate } from '../../../utils/schema-version-check';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
	createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('migration invariants', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  describe('schema (DDL applied by the migration chain)', () => {
    it.each(['baseline', 'older forward migration'])('refuses boot when the ledger lacks a required %s despite its current maximum', async (kind) => {
      const sql = getTestDb();
      const migrationsDir = fileURLToPath(new URL('../../../../../../db/migrations/', import.meta.url));
      const required = listMigrationFiles(migrationsDir).map((file) => file.split('_')[0]);
      const rollback = new Error('synthetic ledger rollback');
      await expect(sql.begin(async (tx) => {
        // The test harness applies SQL directly, without dbmate's ledger.
        // Create it only inside this rolled-back fixture transaction.
        await tx`CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY)`;
        await tx`DELETE FROM public.schema_migrations`;
        await tx`INSERT INTO public.schema_migrations (version)
          SELECT jsonb_array_elements_text(${tx.json(required)}::jsonb)`;
        await expect(assertSchemaUpToDate(tx, { migrationsDir })).resolves.toBeUndefined();
        await tx`INSERT INTO public.schema_migrations (version) VALUES ('99999999999999')`;
        await expect(assertSchemaUpToDate(tx, { migrationsDir })).resolves.toBeUndefined();
        const versions = await tx`SELECT version FROM schema_migrations ORDER BY version`;
        expect(versions.length).toBeGreaterThan(2);
        const missing = versions[kind === 'baseline' ? 0 : 1].version;
        await tx`DELETE FROM schema_migrations WHERE version = ${missing}`;
        await expect(assertSchemaUpToDate(tx, { migrationsDir })).rejects.toThrow(missing);
        throw rollback;
      })).rejects.toBe(rollback);
    });

    it('auth_profiles has the per-user pending oauth_account unique index (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_oauth_account_unique'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      // per-user, per-connector, per-provider scope
      for (const col of ['organization_id', 'connector_key', 'provider', 'created_by']) {
        expect(def).toContain(col);
      }
      // partial predicate: only in-flight oauth_account rows
      expect(def).toContain("'pending_auth'");
      expect(def).toContain("'oauth_account'");
    });

    it('the old org-wide auth_profiles_pending_unique index is gone (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_unique'
      `;
      expect(rows).toHaveLength(0);
    });

    it('event_embeddings carries a NOT NULL embedding_model stamp (#1069/#1080, contract #1372)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'event_embeddings'
          AND column_name = 'embedding_model'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_nullable).toBe('NO');
    });

    it('event_embeddings PK is (event_id, embedding_model, chunk_index) (#1372 contract)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ attname: string }[]>`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'event_embeddings'
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
      `;
      expect(rows.map((r) => r.attname)).toEqual([
        'event_id',
        'embedding_model',
        'chunk_index',
      ]);
    });

    it('current_event_records is supersession-only — no embedding columns (#1372 contract)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'current_event_records'
          AND column_name IN ('embedding', 'embedding_model')
      `;
      expect(rows).toHaveLength(0);
    });

    it('current_event_records projects the stored events.content_length column (#2983)', async () => {
      const sql = getTestDb();
      const [row] = await sql<{ definition: string }[]>`
        SELECT pg_get_viewdef('public.current_event_records'::regclass, true) AS definition
      `;
      expect(row?.definition).toMatch(/\n\s+content_length,\n/);
      expect(row?.definition).not.toMatch(/length\s*\(\s*(?:e\.)?payload_text\s*\)/i);
    });

    it('current_event_records content_length preserves PostgreSQL character and NULL semantics', async () => {
      const sql = getTestDb();
      // 5 codepoints as PostgreSQL length() counts them: A, 😀 U+1F600 (one
      // codepoint, two UTF-16 units in JS), e, U+0301 combining accent (é), 終.
      // Explicit escapes so Unicode normalization can't silently recompose the
      // accent and change the expected count.
      const content = 'A\u{1F600}e\u0301\u7D42';
      const org = await createTestOrganization({ name: 'Content Length Invariant Org' });
      const event = await createTestEvent({ content, organization_id: org.id });
      const [row] = await sql<{
        stored_length: number;
        projected_length: number;
        measured_length: number;
      }[]>`
        SELECT
          e.content_length AS stored_length,
          current.content_length AS projected_length,
          length(e.payload_text) AS measured_length
        FROM public.events e
        JOIN public.current_event_records current ON current.id = e.id
        WHERE e.id = ${event.id}
      `;
      expect(row).toEqual({
        stored_length: 5,
        projected_length: 5,
        measured_length: 5,
      });

      const [nullEvent] = await sql<{ id: string }[]>`
        INSERT INTO public.events (organization_id, origin_id, payload_text)
        VALUES (${org.id}, ${`content-length-null-${org.id}`}, NULL)
        RETURNING id
      `;
      const [nullRow] = await sql<{
        payload_text: string | null;
        stored_length: number;
        projected_length: number;
      }[]>`
        SELECT
          e.payload_text,
          e.content_length AS stored_length,
          current.content_length AS projected_length
        FROM public.events e
        JOIN public.current_event_records current ON current.id = e.id
        WHERE e.id = ${nullEvent.id}
      `;
      expect(nullRow).toEqual({
        payload_text: null,
        stored_length: 0,
        projected_length: 0,
      });
    });

    it('stale orphan tables entity_read_grant + mcp_proxy_sessions are dropped (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('entity_read_grant', 'mcp_proxy_sessions')
      `;
      expect(rows).toHaveLength(0);
    });

    it('vestigial columns are dropped (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'agents' AND column_name IN ('agent_integrations', 'skill_registries', 'skill_auto_granted_domains'))
            OR (table_name = 'device_workers' AND column_name IN ('first_seen_at', 'notification_budget_per_day'))
            OR (table_name = 'organization' AND column_name = 'repair_agents_enabled')
          )
      `;
      expect(rows).toHaveLength(0);
    });

    it('agents no longer carry skills or guardrails: the workspace libraries own them', async () => {
      const sql = getTestDb();
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agents'
          AND column_name IN ('skills_config', 'guardrails', 'guardrails_inline')
      `;
      expect(rows).toHaveLength(0);
    });

    it('environments.scope + owner_user_id are dropped (contract phase of the #1914 env→provider unification)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sandboxes'
          AND column_name IN ('scope', 'owner_user_id')
      `;
      expect(rows).toHaveLength(0);
    });

    it('missing FK indexes were added and the duplicate token_hash index removed (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const present = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_runs_parent_run_id',
            'oauth_tokens_parent_token_id_idx',
            'oauth_tokens_organization_id_idx'
          )
      `;
      expect(present.map((r) => r.indexname).sort()).toEqual([
        'idx_runs_parent_run_id',
        'oauth_tokens_organization_id_idx',
        'oauth_tokens_parent_token_id_idx',
      ]);

      // The redundant non-unique copy is gone; the UNIQUE index on token_hash stays.
      const hashIdx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'oauth_tokens'
          AND indexname IN ('oauth_tokens_token_hash_idx', 'oauth_tokens_token_hash_key')
      `;
      expect(hashIdx.map((r) => r.indexname)).toEqual(['oauth_tokens_token_hash_key']);
    });

    it('agent history has an ordered partial index over retained thread responses', async () => {
      const sql = getTestDb();
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'runs'
          AND indexname = 'idx_runs_thread_response_history'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0]?.indexdef ?? '';
      expect(def).toContain('(organization_id, id DESC)');
      expect(def).toContain("run_type = 'chat_message'::text");
      expect(def).toContain("queue_name = 'thread_response'::text");
      expect(def).toContain("'pending'::text");
      expect(def).toContain("'completed'::text");
      expect(def).toContain("'failed'::text");
      expect(def).toContain('action_input IS NOT NULL');
    });

		it('paused feeds cannot retain a scheduler cursor', async () => {
			const org = await createTestOrganization({ name: 'Paused Feed Invariant Org' });
			await createTestConnectorDefinition({
				organization_id: org.id,
				key: 'paused-feed-invariant',
				name: 'Paused Feed Invariant',
			});
			const connection = await createTestConnection({
				organization_id: org.id,
				connector_key: 'paused-feed-invariant',
			});
			const sql = getTestDb();
			const [feed] = await sql`
				UPDATE feeds
				SET status = 'paused', next_run_at = NOW() - INTERVAL '1 hour'
				WHERE connection_id = ${connection.id}
				RETURNING status, next_run_at
			`;
			expect(feed.status).toBe('paused');
			expect(feed.next_run_at).toBeNull();
		});

		it('schedule-auto-paused Automations cannot retain or resurrect a cursor', async () => {
			const org = await createTestOrganization({
				name: 'Automation Pause Invariant Org',
			});
			const user = await createTestUser({
				email: 'automation-pause-invariant@example.com',
			});
			await addUserToOrganization(user.id, org.id, 'owner');
			const sql = getTestDb();
			const [automation] = await sql`
				INSERT INTO automations (
					organization_id, created_by, automation_group_id, name, slug,
					status, version, schedule, next_run_at,
					consecutive_scheduled_failures, schedule_auto_paused_at
				) VALUES (
					${org.id}, ${user.id}, 0, 'Paused Automation Invariant',
					'paused-automation-invariant', 'active', 1, '0 * * * *',
					current_timestamp + interval '1 hour', 5, current_timestamp
				)
				RETURNING id, next_run_at
			`;
			expect(automation.next_run_at).toBeNull();

			const [stillPaused] = await sql`
				UPDATE automations
				SET next_run_at = current_timestamp + interval '2 hours'
				WHERE id = ${automation.id}
				RETURNING next_run_at
			`;
			expect(stillPaused.next_run_at).toBeNull();

			const [resumed] = await sql`
				UPDATE automations
				SET schedule_auto_paused_at = NULL,
					consecutive_scheduled_failures = 0,
					next_run_at = current_timestamp + interval '1 hour'
				WHERE id = ${automation.id}
				RETURNING next_run_at, consecutive_scheduled_failures
			`;
			expect(resumed.next_run_at).not.toBeNull();
			expect(Number(resumed.consecutive_scheduled_failures)).toBe(0);
		});

    it('redundant/dead indexes are dropped while their covering indexes remain (2026-06-16 audit round 2)', async () => {
      const sql = getTestDb();
      // Dropped: idx_events_source_embedding (redundant btree(event_id) before
      // the contract PK became composite),
      // idx_connect_tokens_token (dup of the UNIQUE connect_tokens_token_key),
      // geo_places_location_idx (postgis index superseded by geo_places_earth_idx).
      const dropped = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_events_source_embedding', 'idx_connect_tokens_token', 'geo_places_location_idx')
      `;
      expect(dropped).toHaveLength(0);

      // The covering indexes that make the drops safe must still exist.
      const kept = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('event_embeddings_pkey', 'connect_tokens_token_key', 'geo_places_earth_idx')
      `;
      expect(kept.map((r) => r.indexname).sort()).toEqual([
        'connect_tokens_token_key',
        'event_embeddings_pkey',
        'geo_places_earth_idx',
      ]);
    });
  });

  describe('functional contract: pending oauth_account uniqueness is per-user (#1121)', () => {
    let orgId: string;
    let userA: string;
    let userB: string;
    const connectorKey = 'invariant-oauth-connector';
    const provider = 'google';

    beforeAll(async () => {
      const org = await createTestOrganization({ name: 'Migration Invariant Org' });
      orgId = org.id;
      const a = await createTestUser({ email: 'invariant-user-a@example.com' });
      const b = await createTestUser({ email: 'invariant-user-b@example.com' });
      userA = a.id;
      userB = b.id;
      await addUserToOrganization(userA, orgId, 'member');
      await addUserToOrganization(userB, orgId, 'member');
      await createTestConnectorDefinition({
        key: connectorKey,
        name: 'Invariant OAuth',
        organization_id: orgId,
      });
    });

    async function createPending(createdBy: string) {
      return createAuthProfile({
        organizationId: orgId,
        connectorKey,
        displayName: 'Invariant pending',
        profileKind: 'oauth_account',
        provider,
        status: 'pending_auth',
        createdBy,
      });
    }

    it('a user cannot open two parallel pending flows for the same connector', async () => {
      await createPending(userA);
      await expect(createPending(userA)).rejects.toBeInstanceOf(PendingAuthConflictError);
    });

    it('distinct users CAN run pending flows for the same connector in parallel', async () => {
      const profile = await createPending(userB);
      expect(profile.status).toBe('pending_auth');
      expect(profile.created_by).toBe(userB);
    });
  });
});
