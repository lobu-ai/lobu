/**
 * Org-shared provider credentials live in `agent_secrets` under a documented
 * naming convention so the worker's credential-resolution path and `lobu apply`
 * agree on where to read/write the same row.
 *
 * Resolution order (worker side, see base-provider-module.ts):
 *   1. Per-user `auth_profiles` (BYOK / personal OAuth)
 *   2. Org-shared `agent_secrets` row (this name) — declarative, set via
 *      `lobu apply` from `[[agents.<id>.providers]] key = "$VAR"`
 *   3. Deployment-wide `process.env` (operator's machine, last resort)
 *
 * The org-scoping is enforced by `(organization_id, name)` PK on the table;
 * no per-agent override exists today (the same key is used by every agent in
 * the org that calls this provider).
 */

import { createLogger, decrypt, encrypt, getErrorMessage } from "@lobu/core";
import { getDb, type DbClient } from "../../db/client.js";

const logger = createLogger("provider-secrets");

// ── Inference providers (org-owned per-modality custom upstreams) ─────────────
//
// One row per named provider credential for an org (see
// db/migrations/20260702170000_inference_providers.sql — the DDL is the
// contract). ONE api_key per row (no per-modality key): a row with any custom
// base_url is org-key-only across every modality it serves. `capabilities` is
// per-modality config `{ "<modality>": { base_url?, model?, models_endpoint? } }`.
//
// The api key lives in `agent_secrets` under a ROW-UNIQUE name `<slug>-<id>`
// (embedded in `api_key_ref = secret://<org>/<slug>-<id>`), so a
// soft-delete→recreate never inherits a deleted row's ciphertext (the TOTAL
// keyref unique index keeps the name reserved even after soft-delete).

export type InferenceModality = "text" | "image" | "stt" | "tts";

export const INFERENCE_MODALITIES: ReadonlySet<InferenceModality> = new Set([
	"text",
	"image",
	"stt",
	"tts",
]);

/** Type guard: is `m` a known inference modality? */
export function isInferenceModality(m: string): m is InferenceModality {
	return INFERENCE_MODALITIES.has(m as InferenceModality);
}

/**
 * Canonical provider-slug shape. MUST match the DB CHECK
 * (`inference_providers_slug_format`) and the CLI (map-config
 * ORG_PROVIDER_SLUG_PATTERN) EXACTLY: lowercase alphanumeric + hyphen, 1-63
 * chars, no leading/trailing hyphen. Validated server-side so a bad slug is a
 * clean 400 instead of a raw DB CHECK-violation 500.
 */
export const INFERENCE_PROVIDER_SLUG_PATTERN =
	/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Is `slug` a valid inference-provider slug (see INFERENCE_PROVIDER_SLUG_PATTERN)? */
export function isValidInferenceProviderSlug(slug: string): boolean {
	return INFERENCE_PROVIDER_SLUG_PATTERN.test(slug);
}

const ALLOWED_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
	"base_url",
	"model",
	"models_endpoint",
]);

/**
 * Row-unique vault name for one inference-provider credential:
 * `<slug>-<id>`. Embedded in `api_key_ref = secret://<org>/<slug>-<id>`.
 * Org-scoping is enforced by the `(organization_id, name)` PK on
 * `agent_secrets`; the `<id>` suffix makes the name unique per row so a
 * recreate after soft-delete gets a fresh, un-poisoned ciphertext slot.
 */
export function inferenceProviderSecretName(
	slug: string,
	id: number | string,
): string {
	return `${slug}-${id}`;
}

export interface InferenceCapabilityBlock {
	base_url?: string;
	model?: string;
	models_endpoint?: string;
}

export type InferenceCapabilities = Partial<
	Record<InferenceModality, InferenceCapabilityBlock>
>;

export interface InferenceProviderListItem {
	id: number;
	slug: string;
	kind: string;
	displayName: string | null;
	capabilities: InferenceCapabilities;
	hasCustomUpstream: boolean;
	status: string;
	/**
	 * Why the provider last failed terminally, when `status = 'error'`. Written
	 * by `markInferenceProviderUnhealthy` with the failure the caller observed
	 * (currently the proxy's upstream HTTP status), so a workspace whose
	 * Automations went quiet can read the cause here instead of seeing a row that
	 * still says `active`.
	 */
	errorMessage: string | null;
	createdAt: string;
	/** When the row (including its health) last changed — dates the error above. */
	updatedAt: string;
	/** This row is the org's default inference provider (the model-resolution tail). */
	isDefault: boolean;
}

export interface InferenceProviderRow {
	id: number;
	organizationId: string;
	slug: string;
	kind: string;
	displayName: string | null;
	apiKeyRef: string;
	capabilities: InferenceCapabilities;
	hasCustomUpstream: boolean;
	status: string;
	createdAt: string;
	/**
	 * Whether THIS row is the org default. Load-bearing on create: the first
	 * runnable provider is auto-promoted, so a caller that assumed "not default
	 * unless I asked" would report the wrong state (the CLI's `--json` output
	 * did exactly that). Resolved inside the same transaction as the promotion.
	 */
	isDefault: boolean;
}

/** Typed error returned (not thrown) when a live slug already exists for the org. */
export interface InferenceProviderSlugConflict {
	error: "slug_conflict";
	slug: string;
}

/**
 * Validate one modality capability block before it is persisted. The DB CHECKs
 * are an unconditional floor; this is the full app-layer guard — every
 * capabilities write MUST pass through it. Returns an error string, or null
 * when the block is valid.
 *
 * Rules:
 *   - base_url (if present): must be https:// (no http), no userinfo (`@`
 *     before host), no query/hash, and must parse as a URL.
 *   - models_endpoint (if present): `^/[A-Za-z0-9/_.-]*$` and NOT `//`-prefixed
 *     (identical to the DB CHECK — belt and braces).
 *   - model (if present): non-empty string.
 *   - no unknown keys (only base_url / model / models_endpoint).
 */
export function validateCapabilityBlock(
	modality: string,
	block: unknown,
): string | null {
	if (!isInferenceModality(modality)) {
		return `Unknown modality '${modality}' (expected text|image|stt|tts)`;
	}
	if (typeof block !== "object" || block === null || Array.isArray(block)) {
		return `capabilities.${modality} must be an object`;
	}
	const b = block as Record<string, unknown>;

	for (const key of Object.keys(b)) {
		if (!ALLOWED_CAPABILITY_KEYS.has(key)) {
			return `capabilities.${modality}.${key} is not an allowed field (base_url|model|models_endpoint)`;
		}
	}

	if (b.base_url !== undefined && b.base_url !== null) {
		if (typeof b.base_url !== "string" || b.base_url.trim() === "") {
			return `capabilities.${modality}.base_url must be a non-empty string`;
		}
		let url: URL;
		try {
			url = new URL(b.base_url);
		} catch {
			return `capabilities.${modality}.base_url is not a valid URL`;
		}
		if (url.protocol !== "https:") {
			return `capabilities.${modality}.base_url must be https://`;
		}
		if (url.username !== "" || url.password !== "") {
			return `capabilities.${modality}.base_url must not contain userinfo (user:pass@)`;
		}
		if (url.search !== "" || url.hash !== "") {
			return `capabilities.${modality}.base_url must not contain a query string or fragment`;
		}
		if (url.hostname === "") {
			return `capabilities.${modality}.base_url must have a host`;
		}
	}

	if (b.models_endpoint !== undefined && b.models_endpoint !== null) {
		if (typeof b.models_endpoint !== "string") {
			return `capabilities.${modality}.models_endpoint must be a string`;
		}
		if (
			!/^\/[A-Za-z0-9/_.-]*$/.test(b.models_endpoint) ||
			b.models_endpoint.startsWith("//")
		) {
			return `capabilities.${modality}.models_endpoint must be a relative path (^/[A-Za-z0-9/_.-]*$, not //-prefixed)`;
		}
	}

	if (b.model !== undefined && b.model !== null) {
		if (typeof b.model !== "string" || b.model.trim() === "") {
			return `capabilities.${modality}.model must be a non-empty string`;
		}
	}

	return null;
}

/**
 * Drop null/undefined-valued fields from a capability block (canonicalize)
 * before merging into `capabilities`, so a `{ base_url: null }` write clears
 * nothing and never persists a null. Returns a fresh object.
 */
function canonicalizeCapabilityBlock(
	block: InferenceCapabilityBlock,
): InferenceCapabilityBlock {
	const out: InferenceCapabilityBlock = {};
	for (const key of ALLOWED_CAPABILITY_KEYS) {
		const v = (block as Record<string, unknown>)[key];
		if (v !== undefined && v !== null) {
			(out as Record<string, unknown>)[key] = v;
		}
	}
	return out;
}

interface RawInferenceProviderRow {
	id: string | number;
	organization_id: string;
	slug: string;
	kind: string;
	display_name: string | null;
	api_key_ref: string;
	capabilities: InferenceCapabilities;
	has_custom_upstream: boolean;
	status: string;
	created_at: string | Date;
	is_default: boolean;
}

function oauthInferenceProviderRef(
	organizationId: string,
	slug: string,
	id: number | string,
): string {
	return `oauth://${organizationId}/${slug}-${id}`;
}

function isOAuthInferenceProviderRef(ref: string): boolean {
	return ref.startsWith("oauth://");
}

function mapRow(r: RawInferenceProviderRow): InferenceProviderRow {
	return {
		id: Number(r.id),
		organizationId: r.organization_id,
		slug: r.slug,
		kind: r.kind,
		displayName: r.display_name,
		apiKeyRef: r.api_key_ref,
		capabilities: r.capabilities ?? {},
		hasCustomUpstream: r.has_custom_upstream,
		status: r.status,
		createdAt:
			r.created_at instanceof Date
				? r.created_at.toISOString()
				: String(r.created_at),
		isDefault: r.is_default,
	};
}

/**
 * Serialize every default-mutating path for ONE org by taking a row lock on
 * its `organization` row. Multi-replica correctness: two pods creating or
 * deleting providers concurrently would otherwise interleave the
 * "is there a default?" read with the other's write, and both could conclude
 * "no default exists" and promote — which the partial unique index
 * `inference_providers_org_default_live` then surfaces to a user as a spurious
 * conflict error on an unrelated create. Locking the parent row (never the
 * provider rows, which the racing txn may be inserting) makes promotion
 * read-modify-write safe. Scoped per-org, so unrelated tenants never contend.
 */
async function lockInferenceProviderDefaults(
	sql: DbClient,
	organizationId: string,
): Promise<void> {
	await sql`
		SELECT id FROM organization
		WHERE id = ${organizationId}
		FOR UPDATE
	`;
}

/**
 * Promote the oldest RUNNABLE live provider to org default, but only when the
 * org currently has none (the `NOT EXISTS` guard makes this idempotent, so
 * every mutating path can call it unconditionally).
 *
 * "Runnable" has TWO halves, and both are load-bearing:
 *
 *  1. A non-blank `capabilities.text.model`. Without one the row resolves to
 *     null in `getOrgDefaultModel`, leaving the org just as default-less as
 *     before while *looking* fixed.
 *
 *  2. An org-readable credential — i.e. NOT an `oauth://` ref. OAuth
 *     credentials live in per-user `auth_profiles` and are fetched by
 *     `getBestProfile(agentId, providerId, …, context)`; `oauth://` joins to no
 *     `agent_secrets` row, so `readOrgSharedProviderApiKey` returns null for
 *     them. Runs can resolve the requesting user's or agent owner's profile,
 *     including that owner's org bucket, but agents owned by other members
 *     need their own sign-in. An ORG default must be usable regardless of
 *     which member owns an agent, so personal subscriptions remain ineligible.
 *
 * {@link setInferenceProviderDefault} rejects these for the SAME reason, so an
 * explicit choice cannot reach a state automatic promotion refuses to create.
 * (An earlier revision allowed the explicit path, reasoning the chooser holds
 * the profile — but an ORG-WIDE default is inherited by everyone else too.)
 *
 * Oldest-first (`created_at`, ties broken by the monotonic identity id) keeps
 * the choice deterministic and identical across replicas.
 */
async function promoteOldestRunnableProvider(
	sql: DbClient,
	organizationId: string,
): Promise<number | null> {
	const promoted = (await sql`
		UPDATE inference_providers
		SET is_default = true, updated_at = now()
		WHERE id = (
			SELECT candidate.id
			FROM inference_providers candidate
			WHERE candidate.organization_id = ${organizationId}
			  AND candidate.deleted_at IS NULL
			  AND NULLIF(BTRIM(candidate.capabilities #>> '{text,model}'), '') IS NOT NULL
			  AND candidate.api_key_ref NOT LIKE 'oauth://%'
			  AND NOT EXISTS (
				  SELECT 1 FROM inference_providers current_default
				  WHERE current_default.organization_id = ${organizationId}
				    AND current_default.is_default
				    AND current_default.deleted_at IS NULL
			  )
			ORDER BY candidate.created_at, candidate.id
			LIMIT 1
		)
		RETURNING id
	`) as Array<{ id: string | number }>;
	return promoted[0] ? Number(promoted[0].id) : null;
}

/**
 * Stamp `isDefault` onto a row that may have just been auto-promoted.
 *
 * Every writer reads its row with `RETURNING` BEFORE calling
 * {@link promoteOldestRunnableProvider}, so the returned `is_default` is stale
 * `false` for the very row the promotion then picks. Callers publish this over
 * the REST API and the CLI prints it, so a stale value is a lie about state the
 * server owns — `lobu providers create --json` reported `isDefault: false` for
 * a provider that WAS the org default.
 */
function withPromotion(
	row: InferenceProviderRow,
	promotedId: number | null,
): InferenceProviderRow {
	return promotedId === row.id ? { ...row, isDefault: true } : row;
}

/**
 * Create one inference-provider credential for an org. Atomic: a single
 * transaction (a) mints the row id via the identity sequence, (b) derives the
 * row-unique `api_key_ref = secret://<org>/<slug>-<id>`, (c) INSERTs the row
 * with the explicit id, (d) ensures the org has a runnable default, and (e)
 * encrypts the api key into `agent_secrets` under `<slug>-<id>`. On a live slug
 * collision returns a typed
 * `{ error: 'slug_conflict' }` rather than throwing.
 *
 * Why (d): the org default is the tail of the layered model fallback
 * (automation → agent → org default), so `getOrgDefaultModel` returns null when
 * neither an automation nor an agent supplies a model. Marking a provider default
 * was a SEPARATE explicit call (`PUT /inference-providers/:slug/default`) that
 * nothing chained to creation.
 *
 * "Runnable" is load-bearing — promotion only ever considers rows that carry a
 * `capabilities.text.model`. Promoting a model-less row would hand the org a
 * default that still resolves to null, which is the same silent no-op wearing
 * a different hat.
 */
export async function createInferenceProvider(args: {
	organizationId: string;
	slug: string;
	kind: string;
	displayName?: string | null;
	apiKey: string;
	capabilities?: InferenceCapabilities;
	createdBy?: string | null;
}): Promise<InferenceProviderRow | InferenceProviderSlugConflict> {
	const {
		organizationId,
		slug,
		kind,
		displayName = null,
		apiKey,
		capabilities = {},
		createdBy = null,
	} = args;

	const sql = getDb();
	const ciphertext = encrypt(apiKey);

	try {
		return await sql.begin(async (tx) => {
			await lockInferenceProviderDefaults(tx, organizationId);

			// Mint the id up front so it can be embedded in api_key_ref BEFORE the
			// INSERT (BY DEFAULT identity allows the explicit id; see migration).
			const idRows = (await tx`
				SELECT nextval(pg_get_serial_sequence('inference_providers', 'id')) AS id
			`) as Array<{ id: string | number }>;
			const id = Number(idRows[0]?.id);
			const secretName = inferenceProviderSecretName(slug, id);
			const apiKeyRef = `secret://${organizationId}/${secretName}`;

			const rows = (await tx`
				INSERT INTO inference_providers
					(id, organization_id, slug, kind, display_name, api_key_ref, capabilities, created_by)
				VALUES (
					${id}, ${organizationId}, ${slug}, ${kind}, ${displayName},
					${apiKeyRef}, ${sql.json(capabilities)}, ${createdBy}
				)
				RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
				          capabilities, has_custom_upstream, status, created_at, is_default
			`) as RawInferenceProviderRow[];

			const promotedId = await promoteOldestRunnableProvider(
				tx,
				organizationId,
			);

			// Encrypt the key into the org vault under the row-unique name.
			await tx`
				INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
				VALUES (${organizationId}, ${secretName}, ${ciphertext}, now(), now())
				ON CONFLICT (organization_id, name)
				DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
			`;

			return withPromotion(mapRow(rows[0]), promotedId);
		});
	} catch (error) {
		const msg = getErrorMessage(error);
		// Live-slug unique index (inference_providers_org_slug_live).
		if (
			/inference_providers_org_slug_live/.test(msg) ||
			/duplicate key/.test(msg)
		) {
			return { error: "slug_conflict", slug };
		}
		throw error;
	}
}

/**
 * Ensure an OAuth-backed provider is visible in the org provider list.
 *
 * OAuth credentials live in `auth_profiles` (the per-user org bucket), not in
 * `agent_secrets`. The row still needs a stable `api_key_ref` for the existing
 * table contract, so use an `oauth://` ref that never joins to a vault secret.
 * Static catalog routing then falls through to the OAuth profile. If someone
 * later configures a custom `base_url` on this row, the invariant sees no row
 * key and fails closed rather than sending a subscription token to a tenant URL.
 */
export async function ensureOAuthInferenceProvider(args: {
	organizationId: string;
	slug: string;
	kind: string;
	displayName?: string | null;
	defaultModel?: string | null;
	createdBy?: string | null;
}): Promise<InferenceProviderRow> {
	const {
		organizationId,
		slug,
		kind,
		displayName = null,
		defaultModel = null,
		createdBy = null,
	} = args;
	const sql = getDb();
	const oauthCapabilities: InferenceCapabilities = defaultModel
		? { text: { model: defaultModel } }
		: {};

	try {
		return await sql.begin(async (tx) => {
			await lockInferenceProviderDefaults(tx, organizationId);

			const existing = (await tx`
					SELECT id, organization_id, slug, kind, display_name, api_key_ref,
					       capabilities, has_custom_upstream, status, created_at, is_default
					FROM inference_providers
					WHERE organization_id = ${organizationId}
					  AND slug = ${slug}
					  AND deleted_at IS NULL
					LIMIT 1
				`) as RawInferenceProviderRow[];
			const existingRow = existing[0];
			if (existingRow) {
				if (isOAuthInferenceProviderRef(existingRow.api_key_ref)) {
					let row = existingRow;
					if (
						defaultModel &&
						!existingRow.capabilities?.text?.model?.trim()
					) {
						const updated = (await tx`
							UPDATE inference_providers
							SET capabilities = capabilities || jsonb_build_object(
								'text',
								COALESCE(capabilities -> 'text', '{}'::jsonb) ||
									jsonb_build_object('model', ${defaultModel}::text)
							),
							    updated_at = now()
							WHERE id = ${existingRow.id}
							RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
							          capabilities, has_custom_upstream, status, created_at, is_default
						`) as RawInferenceProviderRow[];
						row = updated[0] ?? existingRow;
					}
					// A row that is ALREADY `oauth://` can still carry `is_default`:
					// rows predating the demote below landed that way, and this
					// branch returns before reaching it. Clearing here is the same
					// load-bearing repair for the same reason — an `oauth://`
					// credential belongs to ONE user, and promotion cannot fix the
					// flag on its own because the NOT EXISTS guard sees a default
					// already present and no-ops, stranding the org on a model no
					// other member and no headless run can authenticate.
					if (row.is_default) {
						const demoted = (await tx`
							UPDATE inference_providers
							SET is_default = false, updated_at = now()
							WHERE id = ${row.id}
							RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
							          capabilities, has_custom_upstream, status, created_at, is_default
						`) as RawInferenceProviderRow[];
						row = demoted[0] ?? row;
					}
					const promotedId = await promoteOldestRunnableProvider(
						tx,
						organizationId,
					);
					return withPromotion(mapRow(row), promotedId);
				}

				const apiKeyRef = oauthInferenceProviderRef(
					organizationId,
					slug,
					existingRow.id,
				);
				// Clearing `is_default` is load-bearing, not tidiness. This row is
				// becoming `oauth://`, which {@link promoteOldestRunnableProvider}
				// and {@link setInferenceProviderDefault} both refuse as an org
				// default — its credential belongs to ONE user. Keeping the flag
				// would strand the org on a model no other member and no headless
				// Automation run can authenticate, and promotion could not repair it:
				// the NOT EXISTS guard sees a default already present and no-ops.
				// Clearing first lets the promotion below hand off to an eligible
				// row, or leave the org default-less when none exists — which is
				// the correct outcome, since a default that always fails at egress
				// is worse than none.
				const repaired = (await tx`
						UPDATE inference_providers
						SET kind = ${kind},
						    display_name = COALESCE(${displayName}, display_name),
						    api_key_ref = ${apiKeyRef},
						    capabilities = ${sql.json(oauthCapabilities)}::jsonb,
						    created_by = COALESCE(created_by, ${createdBy}),
						    is_default = false,
						    updated_at = now()
						WHERE id = ${existingRow.id}
						RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
						          capabilities, has_custom_upstream, status, created_at, is_default
					`) as RawInferenceProviderRow[];
				const promotedId = await promoteOldestRunnableProvider(
					tx,
					organizationId,
				);
				return withPromotion(mapRow(repaired[0]), promotedId);
			}

			const idRows = (await tx`
					SELECT nextval(pg_get_serial_sequence('inference_providers', 'id')) AS id
				`) as Array<{ id: string | number }>;
			const id = Number(idRows[0]?.id);
			const apiKeyRef = oauthInferenceProviderRef(organizationId, slug, id);

			const rows = (await tx`
				INSERT INTO inference_providers
					(id, organization_id, slug, kind, display_name, api_key_ref, capabilities, created_by)
				VALUES (
					${id}, ${organizationId}, ${slug}, ${kind}, ${displayName},
					${apiKeyRef}, ${sql.json(oauthCapabilities)}::jsonb, ${createdBy}
				)
				RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
				          capabilities, has_custom_upstream, status, created_at, is_default
			`) as RawInferenceProviderRow[];

			const promotedId = await promoteOldestRunnableProvider(
				tx,
				organizationId,
			);
			return withPromotion(mapRow(rows[0]), promotedId);
		});
	} catch (error) {
		const msg = getErrorMessage(error);
		if (
			/inference_providers_org_slug_live/.test(msg) ||
			/duplicate key/.test(msg)
		) {
			return await ensureOAuthInferenceProvider(args);
		}
		throw error;
	}
}

/**
 * List an org's live inference providers. NEVER returns the ciphertext / key or
 * the api_key_ref — this feeds the settings UI.
 */
export async function listInferenceProviders(
	organizationId: string,
): Promise<InferenceProviderListItem[]> {
	const sql = getDb();
	const rows = (await sql`
		SELECT id, slug, kind, display_name, capabilities, has_custom_upstream,
		       status, error_message, created_at, updated_at, is_default
		FROM inference_providers
		WHERE organization_id = ${organizationId} AND deleted_at IS NULL
		ORDER BY slug
	`) as Array<
		Omit<RawInferenceProviderRow, "organization_id" | "api_key_ref"> & {
			error_message: string | null;
			updated_at: string | Date;
		}
	>;
	return rows.map((r) => ({
		id: Number(r.id),
		slug: r.slug,
		kind: r.kind,
		displayName: r.display_name,
		capabilities: r.capabilities ?? {},
		hasCustomUpstream: r.has_custom_upstream,
		status: r.status,
		errorMessage: r.error_message,
		createdAt:
			r.created_at instanceof Date
				? r.created_at.toISOString()
				: String(r.created_at),
		updatedAt:
			r.updated_at instanceof Date
				? r.updated_at.toISOString()
				: String(r.updated_at),
		isDefault: r.is_default,
	}));
}

/**
 * Longest provider message kept on the row. Provider errors routinely carry a
 * stack, a request id and a docs URL; the settings UI needs the sentence, not
 * the payload, and this column is read on every provider-list request.
 */
const PROVIDER_ERROR_MESSAGE_LIMIT = 500;

/**
 * Record that an org's inference provider failed terminally on a quota or
 * credential error, so the settings page can say WHY a workspace's Automations
 * stopped instead of showing a row that still reads `active`.
 *
 * **Never a gate.** Credential resolution ignores `status` entirely. Model
 * routing reads it in exactly one place — `resolveDispatchModel` prefers a
 * healthy provider over an `error` one among refs the agent already lists and
 * that are already routable — and only as a PREFERENCE: it cannot shrink the
 * candidate set, so a missed, stale or duplicated write here can never strand a
 * workspace or fail a turn that would otherwise have run. At worst it moves a
 * turn onto a sibling the agent had already listed. That is why the caller
 * still treats a failure here as best-effort: this is not durable
 * dispatch/delivery state, and failing a delivered turn to protect a status
 * label would trade a real outcome for a cosmetic one.
 *
 * `disabled` is an operator decision and is never overwritten.
 */
export async function markInferenceProviderUnhealthy(
	organizationId: string,
	slug: string,
	errorMessage: string,
): Promise<void> {
	const sql = getDb();
	await sql`
		UPDATE inference_providers
		SET status = 'error',
		    error_message = ${errorMessage.slice(0, PROVIDER_ERROR_MESSAGE_LIMIT)},
		    updated_at = now()
		WHERE organization_id = ${organizationId}
		  AND slug = ${slug}
		  AND deleted_at IS NULL
		  AND status <> 'disabled'
	`;
}

/**
 * Clear a provider's error health after a turn it served completed.
 *
 * The `status = 'error'` predicate is what keeps this off the hot path: the
 * healthy case matches no row, so a successful turn costs one indexed no-op
 * UPDATE rather than a write. It also means a `disabled` row cannot be
 * resurrected by traffic — only an operator re-enables it.
 */
export async function clearInferenceProviderError(
	organizationId: string,
	slug: string,
): Promise<void> {
	const sql = getDb();
	await sql`
		UPDATE inference_providers
		SET status = 'active',
		    error_message = NULL,
		    updated_at = now()
		WHERE organization_id = ${organizationId}
		  AND slug = ${slug}
		  AND deleted_at IS NULL
		  AND status = 'error'
	`;
}

interface OrgDefaultModelRow {
	id: string | number;
	slug: string;
	capabilities: InferenceCapabilities;
	is_default: boolean;
	api_key_ref: string;
}

/**
 * The row that currently is — or should become — the org default.
 *
 * A flagged row sorts first so the caller can either return it or repair it
 * when it is no longer eligible. The `OR` branch finds a promotion candidate
 * for an org with no usable flag, using the same model and `oauth://` filters
 * as {@link promoteOldestRunnableProvider}.
 */
async function readOrgDefaultCandidate(
	sql: DbClient,
	organizationId: string,
): Promise<OrgDefaultModelRow | null> {
	const rows = (await sql`
		SELECT id, slug, capabilities, is_default, api_key_ref
		FROM inference_providers
		WHERE organization_id = ${organizationId}
		  AND deleted_at IS NULL
		  AND (
			  is_default
			  OR (
				  NULLIF(BTRIM(capabilities #>> '{text,model}'), '') IS NOT NULL
				  AND api_key_ref NOT LIKE 'oauth://%'
			  )
		  )
		ORDER BY is_default DESC, created_at, id
		LIMIT 1
	`) as OrgDefaultModelRow[];
	return rows[0] ?? null;
}

/**
 * Can this row serve as the ORG-wide default? One predicate, used by the read
 * path and mirrored by the promotion SQL, so a read can never repair away what
 * a write just accepted. Both halves are required: a model to resolve, and a
 * credential every member (and every headless run) can actually read.
 */
function isOrgDefaultEligible(row: OrgDefaultModelRow | null): boolean {
	if (!row?.slug) return false;
	if (!row.capabilities?.text?.model?.trim()) return false;
	return !isOAuthInferenceProviderRef(row.api_key_ref);
}

function modelRefFromDefaultRow(row: OrgDefaultModelRow | null): string | null {
	if (!isOrgDefaultEligible(row) || !row) return null;
	const model = row.capabilities?.text?.model?.trim();
	if (!model) return null;
	return model.startsWith(`${row.slug}/`) ? model : `${row.slug}/${model}`;
}

/**
 * The org's default model — the fallback tail of `automation → agent → org` —
 * as a ROUTABLE `slug/model` ref, or null when the org has nothing runnable.
 *
 * The `slug/` prefix is load-bearing: the worker derives the provider from a
 * model ref's first segment (`model-resolver.ts` auto path), so a bare `gpt-4o`
 * throws "No provider specified" there. Checking for a bare `/` would be wrong
 * — provider-native ids often contain slashes (openrouter
 * `anthropic/claude-sonnet-5`) — so only an existing `${slug}/…` is left alone.
 *
 * SELF-HEALING, because the writers alone cannot fix history. Orgs that
 * predate first-provider-is-default (and orgs whose only flagged default was
 * later soft-deleted) would otherwise stay default-less forever. Two repairs
 * happen under the org lock:
 *   - no flagged default at all ⇒ promote the oldest runnable provider;
 *   - a flagged default that is NOT eligible — no `capabilities.text.model`,
 *     or an `oauth://` ref backed by a personal subscription ⇒ demote it,
 *     then promote an eligible one. Leaving it would keep returning null while
 *     the UI showed a default, which is the confusing half of the bug. The
 *     OAuth case also repairs rows written before that rule existed.
 * The fast path (a runnable flagged default) never opens a transaction.
 */
export async function getOrgDefaultModel(
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const current = await readOrgDefaultCandidate(sql, organizationId);
	if (!current) return null;
	const currentModel = modelRefFromDefaultRow(current);
	if (current.is_default && currentModel) return currentModel;

	return await sql.begin(async (tx) => {
		await lockInferenceProviderDefaults(tx, organizationId);
		const afterLock = await readOrgDefaultCandidate(tx, organizationId);
		if (!afterLock) return null;
		const afterLockModel = modelRefFromDefaultRow(afterLock);
		if (afterLock.is_default && afterLockModel) return afterLockModel;

		if (afterLock.is_default) {
			await tx`
				UPDATE inference_providers
				SET is_default = false, updated_at = now()
				WHERE id = ${afterLock.id}
			`;
		}

		await promoteOldestRunnableProvider(tx, organizationId);
		return modelRefFromDefaultRow(
			await readOrgDefaultCandidate(tx, organizationId),
		);
	});
}

/**
 * Mark one live provider as the org default (clearing any prior default in the
 * same transaction). The partial unique index guarantees at most one live
 * default per org; clearing first keeps the switch atomic.
 *
 * Rejects two kinds of target rather than committing them, each with its own
 * result so the caller can explain WHY:
 *
 *  - no `capabilities.text.model`. Such a row cannot serve as a default:
 *    `getOrgDefaultModel` resolves it to null and then REPAIRS the org by
 *    demoting it and promoting a runnable row. Accepting the write would
 *    report success for a selection that silently reverts on the very next
 *    read — the API must not claim to have stored something it will undo.
 *
 *  - an `oauth://` row. Its credential belongs to a user. Inference can resolve
 *    that user's profile directly or through an agent-owner fallback, but
 *    agents owned by other members still need their own sign-in. An ORG-WIDE
 *    default backed by one person's token cannot guarantee that coverage.
 *    Being a deliberate choice does not help: the chooser is not the only one
 *    who has to run on it. Same reason automatic promotion skips these (see
 *    {@link promoteOldestRunnableProvider}); the two paths must agree, or a
 *    read repairs away what a write just accepted.
 */
export type SetInferenceProviderDefaultResult =
	| "ok"
	| "not_found"
	/** Live row, but no `capabilities.text.model` to resolve. */
	| "no_text_model"
	/** Live row with a model, but an `oauth://` ref only one user can read. */
	| "oauth_provider";

export async function setInferenceProviderDefault(
	organizationId: string,
	slug: string,
): Promise<SetInferenceProviderDefaultResult> {
	const sql = getDb();
	return await sql.begin(async (tx) => {
		await lockInferenceProviderDefaults(tx, organizationId);

		// Confirm the target exists BEFORE clearing the current default —
		// otherwise a missing slug would commit the clear and leave the org with
		// no default at all.
		const target = (await tx`
			SELECT id, api_key_ref,
			       NULLIF(BTRIM(capabilities #>> '{text,model}'), '') AS text_model
			FROM inference_providers
			WHERE organization_id = ${organizationId}
			  AND slug = ${slug} AND deleted_at IS NULL
			LIMIT 1
		`) as Array<{
			id: string | number;
			api_key_ref: string;
			text_model: string | null;
		}>;
		const row = target[0];
		if (!row) return "not_found";
		if (!row.text_model) return "no_text_model";
		if (isOAuthInferenceProviderRef(row.api_key_ref)) return "oauth_provider";

		await tx`
			UPDATE inference_providers
			SET is_default = false, updated_at = now()
			WHERE organization_id = ${organizationId}
			  AND is_default AND deleted_at IS NULL
		`;
		await tx`
			UPDATE inference_providers
			SET is_default = true, updated_at = now()
			WHERE organization_id = ${organizationId}
			  AND slug = ${slug} AND deleted_at IS NULL
		`;
		return "ok";
	});
}

/**
 * Fetch one live provider row by slug (or null). Includes `apiKeyRef` — this is
 * an internal-caller accessor (the resolver needs the ref to read the key).
 */
export async function getInferenceProviderBySlug(
	organizationId: string,
	slug: string,
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT id, organization_id, slug, kind, display_name, api_key_ref,
		       capabilities, has_custom_upstream, status, created_at, is_default
		FROM inference_providers
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		LIMIT 1
	`) as RawInferenceProviderRow[];
	const row = rows[0];
	return row ? mapRow(row) : null;
}

/**
 * Per-modality config resolved from an org's `inference_providers` row: the
 * modality's `base_url`/`model`/`models_endpoint` PLUS the row's decrypted key,
 * read in ONE query (row capabilities + ciphertext joined together). This is the
 * single source of truth for both consumers:
 *   - the capability services (image/stt/tts) — `null` ⇒ static fallback;
 *   - the credential chains via {@link resolveUrlInvariant} — which applies the
 *     text fail-closed policy on top.
 *
 * SINGLE READ: because capabilities and the ciphertext come from one row read,
 * the `base_url` a call is gated for and the key it sends cannot diverge (the
 * flip vector the URL invariant guards against). Two separate reads could.
 *
 * Returns `null` when there is no live row for `slug`, the row has no
 * `capabilities.<modality>` block, or the key is missing/undecryptable —
 * `hasKey` distinguishes the last case for callers that must fail closed.
 */
export interface ResolvedInferenceProviderConfig {
	baseUrl?: string;
	model?: string;
	modelsEndpoint?: string;
	/** The row's ONE decrypted api key. Absent only when missing/undecryptable. */
	apiKey?: string;
	/** capabilities.<modality>.base_url is present ⇒ this modality has a custom upstream. */
	custom: boolean;
}

export async function resolveInferenceProviderConfig(
	organizationId: string,
	slug: string,
	modality: InferenceModality,
): Promise<ResolvedInferenceProviderConfig | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT p.capabilities -> ${modality} AS block, s.ciphertext
		FROM inference_providers p
		LEFT JOIN agent_secrets s
		  ON s.organization_id = p.organization_id
		 AND ('secret://' || p.organization_id || '/' || s.name) = p.api_key_ref
		 AND (s.expires_at IS NULL OR s.expires_at > now())
		WHERE p.organization_id = ${organizationId} AND p.slug = ${slug}
		  AND p.deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		block: InferenceCapabilityBlock | null;
		ciphertext: string | null;
	}>;

	const row = rows[0];
	// No live row, or the row has no block for this modality ⇒ static fallback.
	if (!row?.block) return null;

	let apiKey: string | undefined;
	if (row.ciphertext) {
		try {
			apiKey = decrypt(row.ciphertext);
		} catch (error) {
			logger.warn(
				`Failed to decrypt inference-provider key for ${organizationId}/${slug}: ${getErrorMessage(error)}`,
			);
		}
	}

	return {
		baseUrl: row.block.base_url,
		model: row.block.model,
		modelsEndpoint: row.block.models_endpoint,
		apiKey,
		custom: Boolean(row.block.base_url),
	};
}

interface ResolvedInferenceProviderCredential {
	kind: string;
	baseUrl?: string;
	model?: string;
	modelsEndpoint?: string;
	apiKey?: string;
}

/**
 * Resolve a provider row's credential even when it has no modality override.
 * The base URL and ciphertext come from one read so a concurrent capability
 * edit cannot pair a tenant URL with a key read from a different row state.
 */
export async function resolveInferenceProviderCredential(
	organizationId: string,
	slug: string,
	modality: InferenceModality,
): Promise<ResolvedInferenceProviderCredential | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT p.kind, p.capabilities -> ${modality} AS block, s.ciphertext
		FROM inference_providers p
		LEFT JOIN agent_secrets s
		  ON s.organization_id = p.organization_id
		 AND ('secret://' || p.organization_id || '/' || s.name) = p.api_key_ref
		 AND (s.expires_at IS NULL OR s.expires_at > now())
		WHERE p.organization_id = ${organizationId} AND p.slug = ${slug}
		  AND p.deleted_at IS NULL
		LIMIT 1
	`) as Array<{
		kind: string;
		block: InferenceCapabilityBlock | null;
		ciphertext: string | null;
	}>;
	const row = rows[0];
	if (!row) return null;

	let apiKey: string | undefined;
	if (row.ciphertext) {
		try {
			apiKey = decrypt(row.ciphertext);
		} catch (error) {
			logger.warn(
				`Failed to decrypt inference-provider key for ${organizationId}/${slug}: ${getErrorMessage(error)}`,
			);
		}
	}

	return {
		kind: row.kind,
		baseUrl: row.block?.base_url,
		model: row.block?.model,
		modelsEndpoint: row.block?.models_endpoint,
		apiKey,
	};
}

/**
 * Merge (never clobber) one modality's block into `capabilities`:
 * `capabilities || jsonb_build_object(<modality>, <block>)`, so a concurrent
 * edit to a DIFFERENT modality can't lose this one. Null-valued fields are
 * stripped (canonicalized) before merge.
 * Callers MUST have validated the block via {@link validateCapabilityBlock}.
 * Returns the updated row, or null when no live row exists for the slug.
 */
export async function updateInferenceProviderCapabilities(
	organizationId: string,
	slug: string,
	modality: InferenceModality,
	block: InferenceCapabilityBlock,
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const canonical = canonicalizeCapabilityBlock(block);

	// Merge (never clobber): `||` overlays only this modality's key, so a
	// concurrent edit to a DIFFERENT modality can't lose this one. Null-valued
	// fields were stripped by canonicalizeCapabilityBlock.
	const rows = (await sql`
		UPDATE inference_providers
		SET capabilities = capabilities || jsonb_build_object(${modality}::text, ${sql.json(canonical)}::jsonb),
		    updated_at = now()
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
		          capabilities, has_custom_upstream, status, created_at, is_default
	`) as RawInferenceProviderRow[];

	return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Update a provider's editable core fields. Only `display_name` is editable —
 * `slug` (agents reference it) and `kind` (catalog linkage) are immutable.
 * `COALESCE` leaves the column unchanged when `displayName` is null/undefined,
 * so the route can pass undefined for "no change". Returns the updated row, or
 * null when no live row exists for the slug.
 */
export async function updateInferenceProviderCoreFields(
	organizationId: string,
	slug: string,
	fields: { displayName?: string | null },
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const rows = (await sql`
		UPDATE inference_providers
		SET display_name = COALESCE(${fields.displayName ?? null}, display_name),
		    updated_at = now()
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
		          capabilities, has_custom_upstream, status, created_at, is_default
	`) as RawInferenceProviderRow[];
	return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Rotate a provider's api key: re-encrypt into the SAME api_key_ref name (the
 * ref is immutable). Returns "not_found" when no live row exists for the slug
 * and "oauth_provider" for an OAuth-backed row (its `oauth://` ref never reads
 * the vault, so a write would be silently unused).
 */
export type RotateInferenceProviderKeyResult =
	| "rotated"
	| "not_found"
	/** The row signs in via OAuth (`oauth://` api_key_ref) — it has no vault
	 *  key to rotate, and writing one would be silently unread. */
	| "oauth_provider";

export async function rotateInferenceProviderKey(
	organizationId: string,
	slug: string,
	apiKey: string,
): Promise<RotateInferenceProviderKeyResult> {
	const sql = getDb();
	const ciphertext = encrypt(apiKey);

	return await sql.begin(async (tx) => {
		const rows = (await tx`
			SELECT id, api_key_ref
			FROM inference_providers
			WHERE organization_id = ${organizationId} AND slug = ${slug}
			  AND deleted_at IS NULL
			LIMIT 1
			FOR UPDATE
		`) as Array<{ id: string | number; api_key_ref: string }>;
		const row = rows[0];
		if (!row) return "not_found";
		if (isOAuthInferenceProviderRef(row.api_key_ref)) return "oauth_provider";

		const secretName = inferenceProviderSecretName(slug, Number(row.id));

		await tx`
			INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
			VALUES (${organizationId}, ${secretName}, ${ciphertext}, now(), now())
			ON CONFLICT (organization_id, name)
			DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
		`;

		return "rotated";
	});
}

/**
 * Soft-delete a provider (set `deleted_at = now()`). The
 * `agent_secrets` ciphertext is intentionally LEFT in place — the TOTAL
 * api_key_ref unique index keeps the `<slug>-<id>` name reserved, and a
 * recreate mints a fresh id so it never inherits this row's ciphertext.
 * Returns false when no live row exists for the slug.
 *
 * Deleting THE default promotes the oldest surviving runnable provider in the
 * same transaction. Without this, removing the default makes
 * `getOrgDefaultModel` return null until another default is chosen. Promotion
 * is skipped when the deleted row was not the default, and is a no-op when it
 * was the org's last runnable provider.
 */
export async function softDeleteInferenceProvider(
	organizationId: string,
	slug: string,
): Promise<boolean> {
	const sql = getDb();
	return await sql.begin(async (tx) => {
		await lockInferenceProviderDefaults(tx, organizationId);

		const rows = (await tx`
			UPDATE inference_providers
			SET deleted_at = now(), updated_at = now()
			WHERE organization_id = ${organizationId} AND slug = ${slug}
			  AND deleted_at IS NULL
			RETURNING id, is_default
		`) as Array<{ id: string | number; is_default: boolean }>;
		if (rows.length === 0) return false;
		if (!rows[0]?.is_default) return true;

		await promoteOldestRunnableProvider(tx, organizationId);
		return true;
	});
}

/**
 * Vault row name for one credential field of a sandbox provider. Keyed by
 * `sandboxes.id` (not provider kind) so two sandboxes of the same provider in
 * one org keep distinct credentials — e.g. `sandbox:env-abc:token`. Org-scoping
 * is still enforced by the `(organization_id, name)` PK on `agent_secrets`.
 */
export function sandboxSecretName(sandboxId: string, field: string): string {
	return `sandbox:${sandboxId}:${field}`;
}

/**
 * Encrypt + upsert one credential field for a sandbox provider into the org
 * vault (`sandbox:<id>:<field>`). Used by the sandboxes API; the plaintext is
 * never persisted and the gateway resolves it back via {@link readSandboxSecret}
 * at exec time.
 */
export async function writeSandboxSecret(
	sandboxId: string,
	field: string,
	organizationId: string,
	value: string,
): Promise<void> {
	const sql = getDb();
	const ciphertext = encrypt(value);
	await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, updated_at)
    VALUES (${organizationId}, ${sandboxSecretName(sandboxId, field)}, ${ciphertext}, now())
    ON CONFLICT (organization_id, name)
    DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
  `;
}

/**
 * Read + decrypt one credential field for a sandbox provider. Returns null on
 * miss/expiry/decrypt-failure. Callers that are sandbox-bound MUST fail closed
 * on null (no system-env fallback) — see resolveRuntimeCredentials. Mirrors
 * {@link readOrgSharedProviderApiKey} but keyed per-sandbox.
 */
export async function readSandboxSecret(
	sandboxId: string,
	field: string,
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT ciphertext
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name = ${sandboxSecretName(sandboxId, field)}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
	const ciphertext = rows[0]?.ciphertext;
	if (!ciphertext) return null;
	try {
		return decrypt(ciphertext);
	} catch (error) {
		logger.warn(
			`Failed to decrypt sandbox secret ${sandboxSecretName(
				sandboxId,
				field,
			)}: ${getErrorMessage(error)}`,
		);
		return null;
	}
}

/**
 * Read + decrypt the org-shared API key for a provider (tier 2 of the
 * resolution chain above). Returns null when no row exists, the row expired,
 * or the ciphertext fails to decrypt — every miss is silent so callers keep
 * walking the chain. Shared by the worker-spawn credential path
 * (base-provider-module.ts) and the egress secret-proxy, which MUST agree on
 * this tier: run dispatch checks it via `hasCredentials`, so a proxy that
 * skips it lets an apply-provisioned org dispatch its agent only to 401 at
 * the first provider call.
 *
 * Post-cutover this resolves through the org's `inference_providers` row for
 * the slug (= the module providerId) to its row-unique `<slug>-<id>` vault
 * name — the same name `createInferenceProvider` / `rotateInferenceProviderKey`
 * write. Legacy `provider:<id>:apiKey` rows were converged into these by the
 * (since-retired) boot-time backfill and are never read.
 */
export async function readOrgSharedProviderApiKey(
	providerId: string,
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT s.ciphertext
    FROM inference_providers p
    JOIN agent_secrets s
      ON s.organization_id = p.organization_id
     AND ('secret://' || p.organization_id || '/' || s.name) = p.api_key_ref
     AND (s.expires_at IS NULL OR s.expires_at > now())
    WHERE p.organization_id = ${organizationId}
      AND p.slug = ${providerId}
      AND p.deleted_at IS NULL
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
	const ciphertext = rows[0]?.ciphertext;
	if (!ciphertext) return null;
	try {
		return decrypt(ciphertext);
	} catch (error) {
		logger.warn(
			`Failed to decrypt org-shared key for provider ${providerId}: ${getErrorMessage(error)}`,
		);
		return null;
	}
}
