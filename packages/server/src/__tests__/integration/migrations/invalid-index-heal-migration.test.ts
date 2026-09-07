import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
	executeMigrationSection,
	loadMigrationDown,
	loadMigrationUp,
} from "../../../db/migration-loader";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestConnectorDefinition,
	createTestOrganization,
} from "../../setup/test-fixtures";

/**
 * Concurrent CREATE INDEX IF NOT EXISTS silently no-ops when an INVALID
 * leftover of the same name exists (failed prior concurrent build). The INVALID
 * carcass must be dropped by a heal `DO` block that runs immediately before the
 * `transaction:false` CONCURRENTLY build.
 *
 * Two layouts appear in the tree, both exercised here:
 *  - Legacy: the heal lives in its own companion migration applied just before
 *    the build (`files` = [heal, build]).
 *  - Inline: the heal `DO` and the CONCURRENTLY build share one
 *    `transaction:false` file (`files` = [build]). This is the retry-safe
 *    layout — a standalone heal records as applied on first success, so a later
 *    crash of the build leaves an INVALID carcass the retry never clears; the
 *    inline heal re-runs on every attempt. Both runners (scripts/migrate-up.mjs
 *    in prod, db/migration-loader.ts here) split a `transaction:false` body into
 *    top-level statements so CONCURRENTLY is never trapped in an implicit
 *    multi-statement transaction. `files` is applied in order.
 */
const HEAL_MIGRATIONS = [
	{
		files: [
			"20260719115959_channel_messages_org_dedupe_heal.sql",
			"20260719120000_channel_messages_org_dedupe.sql",
		],
		index: "channel_messages_org_dedup",
		seedSql: `
      CREATE INDEX IF NOT EXISTS channel_messages_org_dedup
        ON channel_messages (id)
    `,
	},
	{
		// Inline heal + build in one transaction:false file (retry-safe layout).
		files: ["20260721120020_connector_versions_org_unique.sql"],
		index: "connector_versions_org_key_version",
		seedSql: `
      CREATE INDEX IF NOT EXISTS connector_versions_org_key_version
        ON connector_versions (id)
    `,
	},
	{
		// Inline heal + build in one transaction:false file (retry-safe layout).
		files: ["20260721120030_connector_versions_shared_unique.sql"],
		index: "connector_versions_shared_key_version",
		seedSql: `
      CREATE INDEX IF NOT EXISTS connector_versions_shared_key_version
        ON connector_versions (id)
    `,
	},
	{
		// Inline heal + build before retiring the weaker preview-slot index.
		files: ["20260801150000_preview_connection_workspace_scope.sql"],
		index: "uniq_preview_connection_per_platform_all",
		seedSql: `
      CREATE INDEX IF NOT EXISTS uniq_preview_connection_per_platform_all
        ON connections (id)
		`,
	},
	{
		files: ["20260803155100_mcp_activity_scope_client_idx.sql"],
		index: "mcp_activity_scope_client_recent",
		seedSql: `
      CREATE INDEX IF NOT EXISTS mcp_activity_scope_client_recent
        ON mcp_client_conversations (conversation_id)
		`,
	},
	{
		files: ["20260803160000_events_mcp_session_activity_idx.sql"],
		index: "events_mcp_session_activity",
		seedSql: `
      CREATE INDEX IF NOT EXISTS events_mcp_session_activity
        ON events (id)
    `,
	},
	{
		files: ["20260820130000_events_org_origin_index.sql"],
		index: "idx_events_org_origin",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_events_org_origin
			ON events (id)
    `,
	},
	{
		files: ["20260821222000_notification_targets_browser_run.sql"],
		index: "idx_notification_targets_browser_run_id",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_notification_targets_browser_run_id
        ON notification_targets (event_id)
    `,
	},
	{
		files: ["20260824160000_event_metadata_linkedin_identity_indexes.sql"],
		index: "idx_events_metadata_linkedin_slug",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_events_metadata_linkedin_slug
        ON events (id)
    `,
	},
	{
		files: ["20260824160000_event_metadata_linkedin_identity_indexes.sql"],
		index: "idx_events_metadata_linkedin_member_id",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_events_metadata_linkedin_member_id
        ON events (id)
    `,
	},
	{
		files: ["20260827160000_entity_identity_tenant_scope.sql"],
		index: "idx_entity_identities_live_unique_tenant_scoped",
		seedSql: `
      CREATE INDEX IF NOT EXISTS idx_entity_identities_live_unique_tenant_scoped
        ON entity_identities (id)
    `,
	},
] as const;

function resolveMigrationsDir(): string {
	let dir = __dirname;
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, "db/migrations");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not locate db/migrations from the test directory");
}

async function indexValidity(
	indexName: string,
): Promise<{ exists: boolean; valid: boolean | null }> {
	const sql = getDb();
	const [row] = await sql<{ exists: boolean; valid: boolean | null }>`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ${indexName}
      ) AS exists,
      (
        SELECT i.indisvalid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ${indexName}
      ) AS valid
  `;
	return row ?? { exists: false, valid: null };
}

describe("INVALID concurrent-index heal in transaction:false migrations", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it.each(
		HEAL_MIGRATIONS,
	)("replays $files over an INVALID $index and leaves a VALID index", async ({
		files,
		index,
		seedSql,
	}) => {
		const migrationsDir = resolveMigrationsDir();
		const sql = getDb();

		// Drop any live index from prior suite setup, then seed a same-named
		// INVALID carcass the way a crashed CREATE INDEX CONCURRENTLY would.
		await sql.unsafe(`DROP INDEX IF EXISTS public.${index}`);
		await sql.unsafe(seedSql);
		await sql.unsafe(`
        UPDATE pg_index
        SET indisvalid = false
        WHERE indexrelid = (
          SELECT c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = '${index}'
        )
      `);

		const before = await indexValidity(index);
		expect(before).toEqual({ exists: true, valid: false });

		// Apply the pair in order: the companion heal migration drops the
		// INVALID carcass, then the transaction:false migration rebuilds it
		// CONCURRENTLY. Statement-at-a-time mirrors the runtime runner.
		for (const file of files) {
			const up = loadMigrationUp(migrationsDir, file);
			await executeMigrationSection((statement) => sql.unsafe(statement), up);
		}

		const after = await indexValidity(index);
		expect(after).toEqual({ exists: true, valid: true });
	});

	it("round-trips the notification browser-run column, index, and foreign key", async () => {
		const migrationsDir = resolveMigrationsDir();
		const file = "20260821222000_notification_targets_browser_run.sql";
		const sql = getDb();
		const execute = (statement: string) => sql.unsafe(statement);

		await executeMigrationSection(
			execute,
			loadMigrationDown(migrationsDir, file),
		);

		const [afterDown] = await sql<{
			column_exists: boolean;
			index_exists: boolean;
		}>`
			SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'notification_targets'
					  AND column_name = 'browser_run_id'
				) AS column_exists,
				to_regclass('public.idx_notification_targets_browser_run_id') IS NOT NULL
					AS index_exists
		`;
		expect(afterDown).toEqual({ column_exists: false, index_exists: false });

		await executeMigrationSection(
			execute,
			loadMigrationUp(migrationsDir, file),
		);

		const [afterUp] = await sql<{
			column_exists: boolean;
			index_exists: boolean;
			foreign_key_exists: boolean;
		}>`
			SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'notification_targets'
					  AND column_name = 'browser_run_id'
				) AS column_exists,
				to_regclass('public.idx_notification_targets_browser_run_id') IS NOT NULL
					AS index_exists,
				EXISTS (
					SELECT 1 FROM pg_constraint
					WHERE conname = 'notification_targets_browser_run_id_fkey'
				) AS foreign_key_exists
		`;
		expect(afterUp).toEqual({
			column_exists: true,
			index_exists: true,
			foreign_key_exists: true,
		});
	});

	it("refuses tenant-scope rollback while zero-row declarations remain", async () => {
		const migrationsDir = resolveMigrationsDir();
		const file = "20260827160000_entity_identity_tenant_scope.sql";
		const sql = getDb();
		const execute = (statement: string) => sql.unsafe(statement);
		const org = await createTestOrganization({ name: "Tenant rollback guard org" });

		await sql`
			INSERT INTO connector_identity_scope_registry (
				organization_id, connector_key, namespace, scope, scope_key_path
			) VALUES (
				${org.id}, 'rollback-registry-probe', 'erp_customer',
				'tenant', 'metadata.tenant_id'
			)
		`;
		await expect(
			executeMigrationSection(
				execute,
				loadMigrationDown(migrationsDir, file),
			),
		).rejects.toThrow(/tenant declaration registry rows still exist/i);
		await sql`
			DELETE FROM connector_identity_scope_registry
			WHERE organization_id = ${org.id}
		`;
		await sql`ALTER TABLE entity_identities DROP COLUMN IF EXISTS scope_connection_id`;

		await createTestConnectorDefinition({
			key: "rollback-active-probe",
			name: "Rollback active probe",
			organization_id: org.id,
			feeds_schema: {
				customers: {
					eventKinds: {
						customer: {
							attributions: [
								{
									role: "about",
									target: {
										entityType: "person",
										identities: [
											{
												namespace: "erp_customer",
												eventPath: "metadata.customer_id",
												scope: "tenant",
												scopeKeyPath: "metadata.tenant_id",
											},
										],
									},
								},
							],
						},
					},
				},
			},
		});
		await expect(
			executeMigrationSection(
				execute,
				loadMigrationDown(migrationsDir, file),
			),
		).rejects.toThrow(/active connector declarations still use tenant scope/i);
		await sql`
			DELETE FROM connector_definitions
			WHERE organization_id = ${org.id}
			  AND key = 'rollback-active-probe'
		`;
		await sql`ALTER TABLE entity_identities DROP COLUMN IF EXISTS scope_connection_id`;
	});

	it("round-trips and replays the entity identity tenant-scope schema", async () => {
		const migrationsDir = resolveMigrationsDir();
		const file = "20260827160000_entity_identity_tenant_scope.sql";
		const sql = getDb();
		const execute = (statement: string) => sql.unsafe(statement);

		await executeMigrationSection(
			execute,
			loadMigrationDown(migrationsDir, file),
		);

			const [afterDown] = await sql<{
				scope_key_exists: boolean;
				connection_scope_exists: boolean;
			registry_exists: boolean;
			legacy_index_exists: boolean;
		}>`
			SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'entity_identities'
					  AND column_name = 'scope_key'
				) AS scope_key_exists,
					EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'entity_identities'
					  AND column_name = 'scope_connection_id'
				) AS connection_scope_exists,
				to_regclass('public.connector_identity_scope_registry') IS NOT NULL
					AS registry_exists,
				to_regclass('public.idx_entity_identities_live_unique_scoped') IS NOT NULL
					AS legacy_index_exists
		`;
			expect(afterDown).toEqual({
				scope_key_exists: false,
				connection_scope_exists: true,
			registry_exists: false,
			legacy_index_exists: true,
		});

		const up = loadMigrationUp(migrationsDir, file);
		await executeMigrationSection(execute, up);
		// A production runner can replay the body after the final column drop but
		// before recording the migration. The old-column guard must stay valid.
		await executeMigrationSection(execute, up);

			const [afterReplay] = await sql<{
				scope_key_exists: boolean;
				connection_scope_exists: boolean;
			registry_exists: boolean;
			tenant_index_valid: boolean;
		}>`
			SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'entity_identities'
					  AND column_name = 'scope_key'
				) AS scope_key_exists,
					EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public'
					  AND table_name = 'entity_identities'
					  AND column_name = 'scope_connection_id'
				) AS connection_scope_exists,
				to_regclass('public.connector_identity_scope_registry') IS NOT NULL
					AS registry_exists,
				COALESCE((
					SELECT i.indisvalid
					FROM pg_index i
					WHERE i.indexrelid =
						to_regclass('public.idx_entity_identities_live_unique_tenant_scoped')
				), false) AS tenant_index_valid
		`;
			expect(afterReplay).toEqual({
				scope_key_exists: true,
				connection_scope_exists: false,
			registry_exists: true,
			tenant_index_valid: true,
		});
	});

	it("refuses the clean vocabulary break while an active connection-scoped declaration remains", async () => {
		const migrationsDir = resolveMigrationsDir();
		const file = "20260827160000_entity_identity_tenant_scope.sql";
		const sql = getDb();
		const execute = (statement: string) => sql.unsafe(statement);

		await executeMigrationSection(
			execute,
			loadMigrationDown(migrationsDir, file),
		);
		const org = await createTestOrganization({
			name: "Connection declaration migration guard org",
		});
		await createTestConnectorDefinition({
			key: "connection-scope-upgrade-probe",
			name: "Connection scope upgrade probe",
			organization_id: org.id,
			feeds_schema: {
				customers: {
					eventKinds: {
						customer: {
							attributions: [
								{
									role: "about",
									target: {
										entityType: "person",
										identities: [
											{
												namespace: "erp_customer",
												eventPath: "metadata.customer_id",
												scope: "connection",
											},
										],
									},
								},
							],
						},
					},
				},
			},
		});

		const up = loadMigrationUp(migrationsDir, file);
		await expect(executeMigrationSection(execute, up)).rejects.toThrow(
			/active connector declarations still use connection scope/i,
		);
		await sql`
			DELETE FROM connector_definitions
			WHERE organization_id = ${org.id}
			  AND key = 'connection-scope-upgrade-probe'
		`;
		await executeMigrationSection(execute, up);
	});
});
