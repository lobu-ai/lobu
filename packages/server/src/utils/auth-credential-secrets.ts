/**
 * Credential-at-rest handling for `auth_profiles.auth_data`.
 *
 * `auth_data` on an `env` profile holds bearer credentials — a postgres DSN
 * carries its own password, so whoever reads the column owns the database.
 * Historically the column stored those values verbatim, which put a live
 * credential in plaintext in a row that several read paths select wholesale.
 *
 * Values are now stored as `secret://` refs. The ref points at
 * `agent_secrets`, whose store already encrypts with AES-256-GCM and scopes
 * rows per organization — the same mechanism Slack bot tokens and webhook
 * secrets use. Reusing it (rather than encrypting the JSONB value inline)
 * means one key-management story, one rotation story, and it composes with
 * the redaction layer, which already treats a `secret://` ref as non-secret
 * to echo.
 *
 * Only `env`-kind profiles are converted. `browser_session` / `interactive`
 * profiles hold structured session state (cookie jars, Baileys creds), not
 * flat credential strings; they are out of scope here and untouched.
 *
 * Caller-supplied credential values are NEVER treated as already-stored
 * refs: a crafted `secret://…` string is encrypted as opaque input under
 * this profile's name. Already-stored refs are preserved only on internal
 * paths (no-authData profile updates, legacy migration of partially
 * converted rows).
 */

import {
	createBuiltinSecretRef,
	createLogger,
	encrypt,
	parseSecretRef,
} from "@lobu/core";
import { type DbClient, getDb, pgTextArray } from "../db/client";
import { PostgresSecretStore } from "../lobu/stores/postgres-secret-store";
import { orgContext } from "../lobu/stores/org-context";
import {
	resolveSecretValue,
	type SecretStore,
	type WritableSecretStore,
} from "../gateway/secrets/index.js";
import { getAuthProfileById, normalizeAuthValues, readHttpAuthBinding } from "./auth-profiles";

const logger = createLogger("auth-credential-secrets");

/** Scheme of the builtin (`agent_secrets`-backed) store. */
const BUILTIN_SECRET_SCHEME = "secret";

/**
 * True only for a ref into the builtin secret store.
 *
 * Deliberately NOT `isSecretRef` from @lobu/core: that matches ANY
 * `scheme://…` URI, so a `postgres://user:pass@host/db` DSN — exactly the
 * credential this module exists to protect — parses as an "already stored
 * ref" and would be passed through verbatim, leaving the password in
 * plaintext. The scheme must be checked explicitly.
 */
function isStoredSecretRef(value: string): boolean {
	return parseSecretRef(value)?.scheme === BUILTIN_SECRET_SCHEME;
}

/**
 * Decode a builtin secret ref to its logical name, or null if not a builtin ref.
 */
function secretRefName(value: string): string | null {
	const parsed = parseSecretRef(value);
	if (parsed?.scheme !== BUILTIN_SECRET_SCHEME) return null;
	try {
		return decodeURIComponent(parsed.path);
	} catch {
		return null;
	}
}

/**
 * True when `value` is exactly the live or legacy-convergence secret for
 * `auth-profile/<id>/<key>`. Resolution and migration must not honor any
 * other `secret://` string — including same-org secrets or GLOBAL names.
 */
function isOwnedFieldRef(
	value: string,
	authProfileId: number,
	key: string,
): boolean {
	const name = secretRefName(value);
	if (name === null) return false;
	return (
		name === authCredentialSecretName(authProfileId, key) ||
		name === authCredentialSecretName(authProfileId, key, "legacy-convergence")
	);
}

/**
 * Secret name for one credential field. Namespaced per auth profile so two
 * profiles holding a `DATABASE_URL` never collide.
 */
function authCredentialSecretName(
	authProfileId: number,
	key: string,
	namespace?: "legacy-convergence",
): string {
	return namespace
		? `auth-profile/${authProfileId}/${namespace}/${key}`
		: `auth-profile/${authProfileId}/${key}`;
}

type SecretRefAuthDataParams = {
	organizationId: string;
	authProfileId: number;
	credentials: Record<string, unknown>;
	/** Injected store for tests; production writes use `db` directly. */
	secretStore?: WritableSecretStore;
	/**
	 * Connection that also owns the profile UPDATE. Secret rows are written
	 * on this handle so they share the caller's transaction (rollback +
	 * concurrent delete cannot leave decryptable orphans).
	 */
	db?: DbClient;
	/**
	 * Internal only (legacy migration). When set, already-stored
	 * `secret://` values are kept rather than re-encrypted as opaque strings.
	 * Public create/validate/completion paths must leave this false.
	 */
	preserveStoredRefs?: boolean;
};

/**
 * Encrypt one credential into `agent_secrets` on the caller's DbClient so the
 * write participates in the same transaction as the profile row update.
 */
async function putAuthCredentialOnDb(params: {
	db: DbClient;
	organizationId: string;
	name: string;
	value: string;
}): Promise<string> {
	const ciphertext = encrypt(params.value);
	await params.db`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, expires_at, created_at, updated_at)
    VALUES (${params.organizationId}, ${params.name}, ${ciphertext}, NULL, now(), now())
    ON CONFLICT (organization_id, name) DO UPDATE SET
      ciphertext = EXCLUDED.ciphertext,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `;
	return createBuiltinSecretRef(encodeURIComponent(params.name));
}

async function storeAuthCredentialRefs(
	params: SecretRefAuthDataParams,
	namespace?: "legacy-convergence",
): Promise<Record<string, string>> {
	const values = normalizeAuthValues(params.credentials);
	const out: Record<string, string> = {};
	const sql = params.db ?? getDb();

	// When writing on a caller transaction, lock the profile first. Concurrent
	// deleteAuthProfile takes the same row lock; if the profile is gone we must
	// not insert decryptable agent_secrets that would survive as orphans.
	if (params.db && !params.secretStore) {
		const locked = await sql`
      SELECT id
      FROM auth_profiles
      WHERE id = ${params.authProfileId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `;
		if (locked.length === 0) {
			throw new Error(
				`auth profile ${params.authProfileId} not found for credential write`,
			);
		}
	}

	for (const [key, value] of Object.entries(values)) {
		// Migration of partially-converted rows may still hold some refs.
		// Public paths never set preserveStoredRefs — every caller-supplied
		// value is encrypted under THIS profile's field name.
		if (
			params.preserveStoredRefs &&
			isOwnedFieldRef(value, params.authProfileId, key)
		) {
			out[key] = value;
			continue;
		}
		const name = authCredentialSecretName(
			params.authProfileId,
			key,
			namespace,
		);
		if (params.secretStore) {
			// Test injection path — still force the org context so a bare
			// store cannot land tenant secrets in the GLOBAL bucket.
			out[key] = await orgContext.run(
				{ organizationId: params.organizationId },
				() => params.secretStore!.put(name, value),
			);
		} else {
			out[key] = await putAuthCredentialOnDb({
				db: sql,
				organizationId: params.organizationId,
				name,
				value,
			});
		}
	}

	// Drop prior credential rows whose fields are no longer present. Replacing
	// or shrinking auth_data must not leave decryptable bearer secrets behind.
	// (Namespace staging rows for keys still referenced above are kept.)
	const keepNames = Object.keys(out).flatMap((key) => {
		const live = authCredentialSecretName(params.authProfileId, key);
		const staged = authCredentialSecretName(
			params.authProfileId,
			key,
			"legacy-convergence",
		);
		const kept: string[] = [live];
		const current = out[key];
		if (current && secretRefName(current) === staged) kept.push(staged);
		return kept;
	});
	if (params.secretStore) {
		await orgContext.run({ organizationId: params.organizationId }, async () => {
			const listed = await params.secretStore!.list(
				`auth-profile/${params.authProfileId}/`,
			);
			const keep = new Set(keepNames);
			await Promise.all(
				listed
					.filter((entry) => !keep.has(entry.name))
					.map((entry) => params.secretStore!.delete(entry.ref)),
			);
		});
	} else {
		// postgres.js: empty array for NOT IN is awkward — only run when we
		// have keep names (always at least one when out is non-empty). When
		// out is empty, delete the entire profile prefix.
		if (keepNames.length === 0) {
			await sql`
        DELETE FROM agent_secrets
        WHERE organization_id = ${params.organizationId}
          AND name LIKE ${`auth-profile/${params.authProfileId}/%`}
      `;
		} else {
			// fetch_types:false can't auto-serialize a JS array, so pass a
			// `text[]` literal and use `<> ALL(...)` — equivalent to `NOT IN`
			// for the non-null secret names collected above.
			await sql`
        DELETE FROM agent_secrets
        WHERE organization_id = ${params.organizationId}
          AND name LIKE ${`auth-profile/${params.authProfileId}/%`}
          AND name <> ALL(${pgTextArray(keepNames)}::text[])
      `;
		}
	}

	return out;
}

/**
 * Convert a credential map into one safe to store in `auth_data`: every
 * value is written to the secret store and replaced by its `secret://` ref.
 *
 * Caller-supplied strings are always stored, including strings that look
 * like `secret://…`. That closes the connect-route ref-injection attack:
 * an attacker cannot bind a profile field to another secret by submitting
 * its ref. Rename-only updates that must keep existing refs go through
 * `updateAuthProfile` without `authData`, which never calls this function.
 *
 * The org is threaded EXPLICITLY on every write. `PostgresSecretStore.put`
 * silently falls back to a deployment-wide GLOBAL bucket when no ambient
 * context is set; worker-token paths have none, so the fallback would
 * otherwise be reachable in production for the test-store path.
 */
export async function toSecretRefAuthData(
	params: SecretRefAuthDataParams,
): Promise<Record<string, string>> {
	return storeAuthCredentialRefs(params);
}

/**
 * Write a credential map onto an auth profile, storing only `secret://` refs.
 *
 * Secret upserts and the `auth_data` UPDATE run on the same DbClient. When
 * the caller does not pass one, they share a fresh transaction so a failed
 * update cannot leave a rotated secret behind, and a rolled-back create
 * cannot leave decryptable orphans.
 */
export async function persistAuthCredentials(params: {
	organizationId: string;
	authProfileId: number;
	credentials: Record<string, unknown>;
	secretStore?: WritableSecretStore;
	db?: DbClient;
}): Promise<Record<string, string>> {
	const write = async (sql: DbClient): Promise<Record<string, string>> => {
		// Lock the profile row so a concurrent delete cannot race a secret
		// write and leave credentials without a profile.
		const locked = await sql`
      SELECT id
      FROM auth_profiles
      WHERE id = ${params.authProfileId}
        AND organization_id = ${params.organizationId}
      FOR UPDATE
    `;
		if (locked.length === 0) {
			throw new Error(
				`auth profile ${params.authProfileId} not found for credential write`,
			);
		}
		const refs = await storeAuthCredentialRefs({
			organizationId: params.organizationId,
			authProfileId: params.authProfileId,
			credentials: params.credentials,
			secretStore: params.secretStore,
			db: sql,
		});
		await sql`
      UPDATE auth_profiles
      SET auth_data = ${sql.json(refs)},
          updated_at = NOW()
      WHERE id = ${params.authProfileId}
        AND organization_id = ${params.organizationId}
    `;
		return refs;
	};

	if (params.db) {
		return write(params.db);
	}
	return getDb().begin((tx) => write(tx));
}

/**
 * Resolve any `secret://` refs in an `env` profile's `auth_data` back to real
 * values, for handing to connector execution.
 *
 * A value that is not a ref is passed through: `auth_data` also carries
 * non-secret bookkeeping (`requested_scopes`, `granted_scopes`) that was never
 * secret-stored.
 */
export async function resolveAuthCredentials(params: {
	organizationId: string;
	/** Required so resolution can refuse foreign/predictable secret:// names. */
	authProfileId: number;
	authData: Record<string, unknown> | null | undefined;
	secretStore?: SecretStore;
	/** Gateway egress only: checked against the persisted immutable binding. */
	httpOrigin?: string;
}): Promise<Record<string, string>> {
	const profile = await getAuthProfileById(params.organizationId, params.authProfileId);
	const binding = readHttpAuthBinding(profile?.metadata);
	if (binding && (params.httpOrigin !== binding.origin || profile?.status !== 'active')) {
		throw new Error('HTTP-bound credentials are only available at their gateway destination');
	}
	if (params.httpOrigin && !binding) throw new Error('HTTP credential binding is unavailable');
	const values = normalizeAuthValues(binding ? profile?.auth_data ?? {} : params.authData ?? {});
	if (Object.keys(values).length === 0) return {};

	const store = params.secretStore ?? new PostgresSecretStore();
	const out: Record<string, string> = {};

	await orgContext.run({ organizationId: params.organizationId }, async () => {
		for (const [key, value] of Object.entries(values)) {
			if (!isStoredSecretRef(value)) {
				// Non-ref bookkeeping or still-plaintext legacy values.
				out[key] = value;
				continue;
			}
			// Only resolve refs that name THIS profile's field. A crafted
			// secret://other-name in auth_data must not materialize another
			// org/GLOBAL secret at execution time.
			if (!isOwnedFieldRef(value, params.authProfileId, key)) {
				logger.warn(
					{ key, auth_profile_id: params.authProfileId, auth_profile_ref: value },
					"Ignoring unowned auth credential ref",
				);
				continue;
			}
			const resolved = await resolveSecretValue(store, value);
			if (resolved === undefined) {
				// A dangling ref means the credential is gone. Drop the key rather
				// than passing the literal `secret://…` string to a connector,
				// which would surface as a confusing connect failure.
				logger.warn(
					{ key, auth_profile_ref: value },
					"Auth credential ref did not resolve",
				);
				continue;
			}
			out[key] = resolved;
		}
	});

	return out;
}

/**
 * One pass converting legacy plaintext `env` credentials into secret refs.
 *
 * Called by the scheduled convergence job. Kept in TS because the values must
 * pass through the encrypting secret store.
 */
export async function migrateLegacyPlaintextAuthData(): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, auth_data
    FROM auth_profiles
    WHERE profile_kind = 'env'
      AND auth_data IS NOT NULL
      AND auth_data <> '{}'::jsonb
  `) as unknown as Array<{
		id: number;
		organization_id: string;
		auth_data: Record<string, unknown> | null;
	}>;

	let converted = 0;
	for (const row of rows) {
		const values = normalizeAuthValues(row.auth_data ?? {});
		const profileId = Number(row.id);
		// Convert plaintext AND unowned secret:// strings. Fully owned rows
		// (every value is already this profile's field ref) are no-ops.
		const needsConversion = Object.entries(values).some(
			([key, value]) => !isOwnedFieldRef(value, profileId, key),
		);
		if (!needsConversion) {
			continue;
		}

		// Staging namespace + compare-and-swap on auth_data: a rotation that
		// lands between scan and write wins, and the losing staging rows are
		// cleaned up below.
		const refs = await sql.begin(async (tx) => {
			const locked = await tx`
        SELECT id, auth_data
        FROM auth_profiles
        WHERE id = ${row.id}
          AND organization_id = ${row.organization_id}
          AND auth_data = ${tx.json(row.auth_data)}::jsonb
        FOR UPDATE
      `;
			if (locked.length === 0) return null;

			const nextRefs = await storeAuthCredentialRefs(
				{
					organizationId: row.organization_id,
					authProfileId: profileId,
					credentials: values,
					db: tx,
					// Keep only refs that already name this profile's field.
					preserveStoredRefs: true,
				},
				"legacy-convergence",
			);
			const updated = await tx`
        UPDATE auth_profiles
        SET auth_data = ${tx.json(nextRefs)},
            updated_at = NOW()
        WHERE id = ${row.id}
          AND organization_id = ${row.organization_id}
          AND auth_data = ${tx.json(row.auth_data)}::jsonb
        RETURNING id
      `;
			return updated.length > 0 ? nextRefs : null;
		});
		if (refs) converted += 1;
	}

	// Staging rows remain referenced after a successful conversion. Remove them
	// only after the profile has rotated to a live ref (or been deleted); this
	// also cleans up a staging write whose compare-and-swap lost a race.
	await sql`
    DELETE FROM agent_secrets staged
    WHERE staged.name LIKE 'auth-profile/%/legacy-convergence/%'
      AND NOT EXISTS (
        SELECT 1
        FROM auth_profiles profile
        WHERE profile.organization_id = staged.organization_id
          AND profile.id::text = split_part(staged.name, '/', 2)
          AND profile.auth_data::text LIKE '%legacy-convergence%'
      )
  `;

	return converted;
}
