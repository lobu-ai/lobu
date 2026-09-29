import { parseSecretRef } from "@lobu/core";
import { beforeAll, describe, expect, it } from "vitest";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store";
import { orgContext } from "../../lobu/stores/org-context";
import {
	migrateLegacyPlaintextAuthData,
	persistAuthCredentials,
	resolveAuthCredentials,
	toSecretRefAuthData,
} from "../../utils/auth-credential-secrets";
import {
	createAuthProfile,
	deleteAuthProfile,
	updateAuthProfile,
} from "../../utils/auth-profiles";
import { resolveExecutionAuth } from "../../utils/execution-context";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestConnection } from "../setup/test-fixtures";
import { TestWorkspace } from "../setup/test-mcp-client";

/**
 * A postgres connection string is a bearer credential: whoever reads it owns
 * the database. Before this suite, the DSN sat as PLAINTEXT in
 * `auth_profiles.auth_data` — the row BOTH execution paths read through
 * `resolveExecutionAuth` — and (for at least one live connection) a second
 * plaintext copy in `connections.config`.
 *
 * Every assertion below reads the RAW DB ROW rather than an API response.
 * The list/get/query_sql surfaces are redacted, so asserting on the API would
 * pass even if the column underneath were still plaintext — that exact trap
 * produced a false-negative test earlier in this sprint.
 */
const DSN_PASSWORD = "pw-LEAK-dsn-secret-storage";
const DSN = `postgres://app_ro:${DSN_PASSWORD}@db.internal:5432/app`;
const ROTATED_PASSWORD = "pw-LEAK-dsn-rotated";
const ROTATED_DSN = `postgres://app_ro:${ROTATED_PASSWORD}@db.internal:5432/app`;

let workspace: TestWorkspace;

async function seedEnvProfile(
	organizationId: string,
	slug: string,
	authData: Record<string, unknown>,
): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql`
    INSERT INTO auth_profiles (
      organization_id, connector_key, slug, display_name,
      profile_kind, status, auth_data, created_at, updated_at
    ) VALUES (
      ${organizationId}, 'postgres', ${slug}, ${slug},
      'env', 'active', ${sql.json(authData)}, NOW(), NOW()
    )
    RETURNING id
  `;
	return Number((row as { id: number }).id);
}

async function rawAuthData(profileId: number): Promise<Record<string, unknown>> {
	const sql = getTestDb();
	const rows = await sql`
    SELECT auth_data FROM auth_profiles WHERE id = ${profileId}
  `;
	return (rows[0] as { auth_data: Record<string, unknown> }).auth_data ?? {};
}

async function waitForBlockedSecretWrite(): Promise<void> {
	const sql = getTestDb();
	for (let attempt = 0; attempt < 40; attempt++) {
		const rows = await sql`
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%INSERT INTO agent_secrets%'
      LIMIT 1
    `;
		if (rows.length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Legacy convergence did not reach the blocked secret write");
}

/** Resolve credentials the way BOTH execution paths do. */
async function resolveCredentials(
	organizationId: string,
	connectionId: number,
	authProfileId: number,
): Promise<Record<string, string>> {
	const { connectionCredentials } = await resolveExecutionAuth({
		organizationId,
		connectionId,
		authProfileId,
		appAuthProfileId: null,
		credentialDb: getTestDb(),
		logContext: {},
	});
	return connectionCredentials as Record<string, string>;
}

describe("auth_profiles credential storage", () => {
	beforeAll(async () => {
		workspace = await TestWorkspace.create();
		return async () => {
			await cleanupTestDatabase();
		};
	});

	it("withholds HTTP-bound env credentials from execution and raw resolution", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({ organization_id: orgId, connector_key: "postgres" });
		const profile = await createAuthProfile({
			organizationId: orgId, connectorKey: "postgres", displayName: "HTTP bound",
			profileKind: "env", authData: { AUTHORIZATION: "Bearer synthetic-http-secret" },
		});
		await sql`UPDATE auth_profiles SET metadata = ${sql.json({ http: {
			origin: "https://api.example.com", headers: { authorization: "AUTHORIZATION" },
		} })} WHERE id = ${profile.id}`;
		await sql`UPDATE connections SET auth_profile_id = ${profile.id} WHERE id = ${conn.id}`;
		expect(await resolveCredentials(orgId, conn.id, profile.id)).toEqual({});
		await expect(resolveAuthCredentials({
			organizationId: orgId, authProfileId: profile.id, authData: profile.auth_data,
		})).rejects.toThrow("HTTP-bound");
	});

	/**
	 * ITEM 1 — WRITE. The persisted row must not contain the password in any
	 * form. Asserted on the serialized raw row so a nested/re-encoded copy
	 * still trips it.
	 */
	it("stores no plaintext credential in the auth_profiles row", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-write", {});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		// Stored as a secret:// ref, not a bare value.
		// Must be a ref into the BUILTIN store. `isSecretRef` would also accept
		// the raw `postgres://` DSN, so the scheme is asserted explicitly.
		expect(parseSecretRef(String(stored.DATABASE_URL))?.scheme).toBe("secret");
	});

	it("creates an env profile with credentials inside a caller transaction", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profile = await sql.begin((tx) =>
			createAuthProfile(
				{
					organizationId: orgId,
					connectorKey: "postgres",
					displayName: "Transactional env profile",
					slug: "pg-transactional-create",
					profileKind: "env",
					authData: { DATABASE_URL: DSN },
				},
				tx,
			),
		);

		const stored = await rawAuthData(profile.id);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		expect(parseSecretRef(String(stored.DATABASE_URL))?.scheme).toBe("secret");
	});

	/**
	 * BOTH execution paths (worker poll + direct source read) resolve
	 * credentials through `resolveExecutionAuth` only — not through
	 * `connections.config`. One seam test covers both; separate path-A/path-B
	 * copies that re-called the same helper were deleted as pure duplication.
	 */
	it("resolves the real credential back through resolveExecutionAuth", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-resolve", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		const creds = await resolveCredentials(orgId, conn.id, profileId);
		// Stored as a ref, delivered as a usable DSN (not secret://…).
		expect(JSON.stringify(await rawAuthData(profileId))).not.toContain(
			DSN_PASSWORD,
		);
		expect(creds.DATABASE_URL).toBe(DSN);
		expect(String(creds.DATABASE_URL)).not.toContain("secret://");
		// Credential comes from the auth profile, not a second plaintext copy
		// in connections.config (that column is exposed by query_sql).
		const [row] = (await sql`
      SELECT COALESCE(config, '{}'::jsonb) AS config
      FROM connections WHERE id = ${conn.id}
    `) as unknown as Array<{ config: Record<string, unknown> }>;
		expect(JSON.stringify(row.config)).not.toContain(DSN_PASSWORD);
	});

	/**
	 * ITEM 6 — ROTATION. Writing a new password must supersede the old one on
	 * the resolve path (a stale cached ref would keep the old DSN alive).
	 */
	it("resolves the new value after the credential is rotated", async () => {
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-rotate", {});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		expect(await resolveCredentials(orgId, conn.id, profileId)).toEqual({
			DATABASE_URL: DSN,
		});

		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: ROTATED_DSN },
			}),
		);

		const rotated = await resolveCredentials(orgId, conn.id, profileId);
		expect(rotated.DATABASE_URL).toBe(ROTATED_DSN);
		expect(rotated.DATABASE_URL).not.toContain(DSN_PASSWORD);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(ROTATED_PASSWORD);
	});

	/**
	 * Cross-tenant guard. `PostgresSecretStore.put` falls back to a GLOBAL
	 * bucket when no org context is ambient; a secret written there shadows
	 * every org's read of the same name. The credential must be scoped to the
	 * writing org explicitly, so another org resolving the same ref gets
	 * nothing.
	 */
	it("scopes the stored credential to the owning organization", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-scope", {});
		await orgContext.run({ organizationId: orgId }, () =>
			persistAuthCredentials({
				organizationId: orgId,
				authProfileId: profileId,
				credentials: { DATABASE_URL: DSN },
			}),
		);
		const ref = String((await rawAuthData(profileId)).DATABASE_URL);
		// Precondition: a real ref was stored. Without this the org-scoping
		// assertion below is vacuous — a plaintext column trivially "isn't
		// readable by another org through the store".
		expect(parseSecretRef(ref)?.scheme).toBe("secret");

		const store = new PostgresSecretStore();
		// The owning org resolves it...
		const ownerRead = await orgContext.run({ organizationId: orgId }, () =>
			store.get(ref as never),
		);
		expect(ownerRead).toBe(DSN);
		// ...and another org does not.
		const otherOrgRead = await orgContext.run(
			{ organizationId: "org-someone-else" },
			() => store.get(ref as never),
		);
		expect(otherOrgRead).not.toBe(DSN);
	});

	/**
	 * ITEM 7 — MIGRATION. A row seeded in the OLD plaintext shape must be
	 * converted by the migration and still resolve afterwards.
	 */
	it("converts a legacy plaintext row and keeps it resolvable", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "postgres",
		});
		const profileId = await seedEnvProfile(orgId, "pg-legacy", {
			DATABASE_URL: DSN,
		});
		await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${conn.id}
    `;

		// Precondition: the legacy row really is plaintext.
		expect(JSON.stringify(await rawAuthData(profileId))).toContain(
			DSN_PASSWORD,
		);

		await orgContext.run({ organizationId: orgId }, () =>
			migrateLegacyPlaintextAuthData(),
		);

		const stored = await rawAuthData(profileId);
		expect(JSON.stringify(stored)).not.toContain(DSN_PASSWORD);
		const creds = await resolveCredentials(orgId, conn.id, profileId);
		expect(creds.DATABASE_URL).toBe(DSN);
	});

	it("does not overwrite a credential rotated during legacy convergence", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const blockerId = await seedEnvProfile(orgId, "pg-migration-blocker", {});
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: blockerId,
			credentials: { DATABASE_URL: DSN },
		});
		await orgContext.run({ organizationId: orgId }, () =>
			new PostgresSecretStore().put(
				`auth-profile/${blockerId}/legacy-convergence/DATABASE_URL`,
				DSN,
			),
		);
		await sql`
      UPDATE auth_profiles
      SET auth_data = ${sql.json({ DATABASE_URL: DSN })}
      WHERE id = ${blockerId}
    `;

		const targetId = await seedEnvProfile(orgId, "pg-migration-race", {
			DATABASE_URL: DSN,
		});
		let migration: Promise<number> | undefined;
		await sql.begin(async (tx) => {
			await tx`
        SELECT name
        FROM agent_secrets
        WHERE organization_id = ${orgId}
          AND name IN (
            ${`auth-profile/${blockerId}/DATABASE_URL`},
            ${`auth-profile/${blockerId}/legacy-convergence/DATABASE_URL`}
          )
        FOR UPDATE
      `;

			migration = migrateLegacyPlaintextAuthData();
			await waitForBlockedSecretWrite();
			await persistAuthCredentials({
				organizationId: orgId,
				authProfileId: targetId,
				credentials: { DATABASE_URL: ROTATED_DSN },
			});
		});
		await migration;

		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: targetId,
			authData: await rawAuthData(targetId),
		});
		expect(resolved.DATABASE_URL).toBe(ROTATED_DSN);
		const staleStagingRows = await sql`
      SELECT 1
      FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${targetId}/legacy-convergence/%`}
    `;
		expect(staleStagingRows).toHaveLength(0);
	});

	/**
	 * Public create/validate paths must never treat a caller-supplied
	 * `secret://…` string as an already-stored ref — not even one under this
	 * profile's own name (cross-key binding) or another profile's.
	 */
	it("does not bind a caller-supplied foreign secret:// ref", async () => {
		const orgId = workspace.org.id;
		const victimId = await seedEnvProfile(orgId, "pg-ref-victim", {});
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: victimId,
			credentials: { DATABASE_URL: DSN },
		});
		const victimRef = String((await rawAuthData(victimId)).DATABASE_URL);
		expect(parseSecretRef(victimRef)?.scheme).toBe("secret");

		const attackerId = await seedEnvProfile(orgId, "pg-ref-attacker", {});
		const putCalls: string[] = [];
		const store = new PostgresSecretStore();
		const originalPut = store.put.bind(store);
		store.put = async (name, value, options) => {
			putCalls.push(value);
			return originalPut(name, value, options);
		};

		const out = await toSecretRefAuthData({
			organizationId: orgId,
			authProfileId: attackerId,
			credentials: { DATABASE_URL: victimRef },
			secretStore: store,
		});

		// Must have written (not short-circuited) and must not keep the victim ref.
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0]).toBe(victimRef);
		expect(out.DATABASE_URL).not.toBe(victimRef);
		expect(parseSecretRef(out.DATABASE_URL)?.scheme).toBe("secret");

		// Resolving the attacker's profile must NOT yield the victim DSN.
		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: attackerId,
			authData: out,
		});
		expect(resolved.DATABASE_URL).toBe(victimRef);
		expect(resolved.DATABASE_URL).not.toBe(DSN);
	});

	it("does not bind one field to another via same-profile secret:// ref", async () => {
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-ref-cross-key", {});
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			credentials: { API_KEY: "real-api-key", DATABASE_URL: DSN },
		});
		const stored = await rawAuthData(profileId);
		const apiKeyRef = String(stored.API_KEY);
		expect(parseSecretRef(apiKeyRef)?.scheme).toBe("secret");

		// Attacker re-submits the API_KEY ref as DATABASE_URL.
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			credentials: { DATABASE_URL: apiKeyRef },
		});
		const after = await rawAuthData(profileId);
		// DATABASE_URL must be a NEW ref for that field — not the API_KEY ref.
		expect(String(after.DATABASE_URL)).not.toBe(apiKeyRef);
		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			authData: after,
		});
		// Opaque store of the ref string — must not resolve to the API key value.
		expect(resolved.DATABASE_URL).toBe(apiKeyRef);
		expect(resolved.DATABASE_URL).not.toBe("real-api-key");
		expect(resolved.DATABASE_URL).not.toBe(DSN);
	});

	it("does not resolve a legacy unowned secret:// planted in auth_data", async () => {
		const orgId = workspace.org.id;
		const store = new PostgresSecretStore();
		const foreignRef = await orgContext.run({ organizationId: orgId }, () =>
			store.put("predictable-global-name", "should-not-leak"),
		);
		const profileId = await seedEnvProfile(orgId, "pg-legacy-inject", {
			DATABASE_URL: foreignRef,
		});
		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			authData: await rawAuthData(profileId),
		});
		expect(resolved.DATABASE_URL).toBeUndefined();
		// Convergence must encrypt the foreign ref as opaque input, not keep it.
		await migrateLegacyPlaintextAuthData();
		const after = await rawAuthData(profileId);
		expect(String(after.DATABASE_URL)).not.toBe(foreignRef);
		expect(parseSecretRef(String(after.DATABASE_URL))?.scheme).toBe("secret");
		const afterResolve = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			authData: after,
		});
		expect(afterResolve.DATABASE_URL).toBe(foreignRef);
		expect(afterResolve.DATABASE_URL).not.toBe("should-not-leak");
	});

	it("deletes agent_secrets for credential keys removed from auth_data", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profileId = await seedEnvProfile(orgId, "pg-key-prune", {});
		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			credentials: { DATABASE_URL: DSN, API_KEY: "extra-key" },
		});
		const before = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profileId}/%`}
      ORDER BY name
    `;
		expect(before.map((r) => (r as { name: string }).name)).toEqual(
			expect.arrayContaining([
				`auth-profile/${profileId}/API_KEY`,
				`auth-profile/${profileId}/DATABASE_URL`,
			]),
		);

		await persistAuthCredentials({
			organizationId: orgId,
			authProfileId: profileId,
			credentials: { DATABASE_URL: DSN },
		});
		const after = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profileId}/%`}
      ORDER BY name
    `;
		expect(after.map((r) => (r as { name: string }).name)).toEqual([
			`auth-profile/${profileId}/DATABASE_URL`,
		]);
	});

	it("rename-only update keeps existing refs without re-storing", async () => {
		const orgId = workspace.org.id;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: "postgres",
			displayName: "Rename me",
			slug: "pg-ref-rename",
			profileKind: "env",
			authData: { DATABASE_URL: DSN },
		});
		const before = String((await rawAuthData(profile.id)).DATABASE_URL);
		expect(parseSecretRef(before)?.scheme).toBe("secret");

		const updated = await updateAuthProfile({
			organizationId: orgId,
			slug: profile.slug,
			displayName: "Renamed",
		});
		expect(updated?.display_name).toBe("Renamed");
		expect(String((await rawAuthData(profile.id)).DATABASE_URL)).toBe(before);
		const resolved = await resolveAuthCredentials({
			organizationId: orgId,
			authProfileId: profile.id,
			authData: await rawAuthData(profile.id),
		});
		expect(resolved.DATABASE_URL).toBe(DSN);
	});

	/**
	 * Deleting a profile must drop its encrypted credential rows. Leaving
	 * `agent_secrets` behind keeps decryptable bearer credentials forever.
	 */
	it("deletes agent_secrets when the auth profile is deleted", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: "postgres",
			displayName: "Delete cleanup",
			slug: "pg-delete-cleanup",
			profileKind: "env",
			authData: { DATABASE_URL: DSN },
		});
		const secretRowsBefore = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profile.id}/%`}
    `;
		expect(secretRowsBefore.length).toBeGreaterThan(0);

		const deleted = await deleteAuthProfile(orgId, profile.slug);
		expect(deleted?.id).toBe(profile.id);

		const profileGone = await sql`
      SELECT 1 FROM auth_profiles WHERE id = ${profile.id}
    `;
		expect(profileGone).toHaveLength(0);

		const secretRowsAfter = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profile.id}/%`}
    `;
		expect(secretRowsAfter).toHaveLength(0);
	});

	it("refuses credential writes when the profile was deleted concurrently", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		const profile = await createAuthProfile({
			organizationId: orgId,
			connectorKey: "postgres",
			displayName: "Race delete",
			slug: "pg-race-delete",
			profileKind: "env",
			authData: { DATABASE_URL: DSN },
		});
		await deleteAuthProfile(orgId, profile.slug);

		await expect(
			sql.begin(async (tx) =>
				toSecretRefAuthData({
					organizationId: orgId,
					authProfileId: profile.id,
					credentials: { DATABASE_URL: ROTATED_DSN },
					db: tx,
				}),
			),
		).rejects.toThrow(/not found for credential write/);

		const secrets = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profile.id}/%`}
    `;
		expect(secrets).toHaveLength(0);
	});

	it("rolls back agent_secrets when the caller transaction aborts", async () => {
		const sql = getTestDb();
		const orgId = workspace.org.id;
		let profileId: number | undefined;
		try {
			await sql.begin(async (tx) => {
				const profile = await createAuthProfile(
					{
						organizationId: orgId,
						connectorKey: "postgres",
						displayName: "Rollback secrets",
						slug: "pg-rollback-secrets",
						profileKind: "env",
						authData: { DATABASE_URL: DSN },
					},
					tx,
				);
				profileId = profile.id;
				const secretsInTx = await tx`
          SELECT name FROM agent_secrets
          WHERE organization_id = ${orgId}
            AND name LIKE ${`auth-profile/${profile.id}/%`}
        `;
				expect(secretsInTx.length).toBeGreaterThan(0);
				throw new Error("force-rollback");
			});
		} catch (err) {
			expect((err as Error).message).toBe("force-rollback");
		}
		expect(profileId).toBeDefined();
		const profileGone = await sql`
      SELECT 1 FROM auth_profiles WHERE id = ${profileId!}
    `;
		expect(profileGone).toHaveLength(0);
		const secretsGone = await sql`
      SELECT name FROM agent_secrets
      WHERE organization_id = ${orgId}
        AND name LIKE ${`auth-profile/${profileId!}/%`}
    `;
		expect(secretsGone).toHaveLength(0);
	});
});
