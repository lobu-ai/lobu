import type {
	AgentConfigStore,
	AgentConnectionStore,
	AgentMetadata,
	AgentSettings,
} from "@lobu/core";
import { createLogger } from "@lobu/core";
import { resolveNewAgentProvisioningDefaults } from "../../auth/system-provider-resolution";
import { getDb, tsTime, tsTimeOrNull } from "../../db/client";
import { recordLifecycleEvent } from "../../utils/insert-event";
import {
	chatTenantAdvisoryLockKey,
	connectionsRowToStored,
	managedTenantAdvisoryLockKey,
	runtimeConnectionIdToSlug,
	softDeleteChatConnectionProjection,
	upsertChatConnectionProjection,
} from "./connections-projection";
import { getOrgId, tryGetOrgId } from "./org-context";

const logger = createLogger("postgres-stores");

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,59}$/;

export function isValidAgentId(agentId: string): boolean {
	return AGENT_ID_PATTERN.test(agentId);
}

async function withChatConnectionDeadlockRetry<T>(
	context: { organizationId: string; slug: string },
	transaction: () => Promise<T>,
): Promise<T> {
	try {
		return await transaction();
	} catch (error) {
		const code =
			error && typeof error === "object"
				? (error as { code?: unknown }).code
				: undefined;
		if (code !== "40P01") throw error;
		logger.warn(
			context,
			"chat connection write deadlocked — retrying transaction",
		);
		return transaction();
	}
}

export async function agentExistsInOrganization(
	organizationId: string,
	agentId: string,
): Promise<boolean> {
	const sql = getDb();
	const rows = await sql`
    SELECT 1
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
	return rows.length > 0;
}

export async function touchAgentLastUsed(
	organizationId: string,
	agentId: string,
): Promise<void> {
	const sql = getDb();
	await sql`
    UPDATE agents
    SET last_used_at = NOW()
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
  `;
}

function rowToSettings(row: Record<string, any>): AgentSettings {
	return {
		// The `models` column is the agent's ordered list of explicit
		// `<providerSlug>/<model>` refs (index 0 = default). NULL/empty ⇒ all org
		// providers are available and the default falls through to the org
		// default model.
		models: row.models ?? undefined,
		networkConfig: row.network_config ?? undefined,
		nixConfig: row.nix_config ?? undefined,
		soulMd: row.soul_md ?? undefined,
		userMd: row.user_md ?? undefined,
		identityMd: row.identity_md ?? undefined,
		skillsConfig: row.skills_config ?? undefined,
		verboseLogging: row.verbose_logging ?? undefined,
		showToolCalls: row.show_tool_calls ?? undefined,
		guardrails: row.guardrails ?? undefined,
		guardrailsInline: row.guardrails_inline ?? undefined,
		sandboxId: row.sandbox_id ?? undefined,
		updatedAt: tsTime(row.updated_at),
	};
}

function rowToMetadata(row: Record<string, any>): AgentMetadata {
	return {
		agentId: row.id,
		name: row.name,
		description: row.description ?? undefined,
		owner: {
			platform: row.owner_platform ?? "lobu",
			userId: row.owner_user_id ?? "",
		},
		organizationId: row.organization_id ?? undefined,
		createdAt: tsTime(row.created_at),
		lastUsedAt: tsTimeOrNull(row.last_used_at),
	};
}

const SECRET_PATTERN =
	/(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

function isSecretField(key: string): boolean {
	return SECRET_PATTERN.test(key);
}

function isRedactedSecretValue(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("***");
}

export function createPostgresAgentConfigStore(): AgentConfigStore {
	const store: AgentConfigStore = {
		async getSettings(agentId) {
			const sql = getDb();
			// CROSS-TENANT GUARD: `agents` is keyed (organization_id, id) with no
			// global unique index on `id`, so a shared agent id (the same string
			// in multiple orgs) has one row per tenant and an id-only read returns
			// an arbitrary one.
			// The settings-cookie routes authenticate without a Better Auth user, so
			// `createLobuOrgContextMiddleware` opens no context on a real, externally
			// reachable path. Callers must prove the tenant and open their own
			// orgContext; fail closed here, as PR #2284 did for agent history.
			const orgId = tryGetOrgId();
			if (!orgId) {
				logger.warn(
					{ agentId },
					"[getSettings] no org context — returning null (cross-tenant guard)",
				);
				return null;
			}
			const rows = await sql`
          SELECT models,
                 network_config, nix_config,
                 soul_md, user_md, identity_md,
                 skills_config,
                 verbose_logging, show_tool_calls,
                 guardrails, guardrails_inline,
                 sandbox_id, updated_at
          FROM agents
          WHERE id = ${agentId} AND organization_id = ${orgId}
        `;
			if (rows.length === 0) return null;
			return rowToSettings(rows[0]);
		},
		async saveSettings(agentId, settings) {
			const sql = getDb();
			const orgId = getOrgId();
			const now = new Date();
			await sql`
        UPDATE agents SET
          models = ${settings.models ? sql.json(settings.models) : null},
          network_config = ${sql.json(settings.networkConfig ?? {})},
          nix_config = ${sql.json(settings.nixConfig ?? {})},
          soul_md = ${settings.soulMd ?? ""},
          user_md = ${settings.userMd ?? ""},
          identity_md = ${settings.identityMd ?? ""},
          skills_config = ${sql.json(settings.skillsConfig ?? { skills: [] })},
          verbose_logging = ${settings.verboseLogging ?? false},
          show_tool_calls = ${settings.showToolCalls ?? false},
          guardrails = ${sql.json(settings.guardrails ?? [])},
          guardrails_inline = ${sql.json(settings.guardrailsInline ?? [])},
          sandbox_id = ${settings.sandboxId ?? null},
          updated_at = ${now}
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
		},
		async updateSettings(agentId, updates) {
			const existing = await store.getSettings(agentId);
			if (!existing) return;
			await store.saveSettings(agentId, {
				...existing,
				...updates,
				updatedAt: Date.now(),
			});
		},
		async deleteSettings(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			await sql`
        UPDATE agents SET
          models = NULL,
          network_config = '{}', nix_config = '{}',
          soul_md = '', user_md = '', identity_md = '',
          skills_config = '{"skills": []}',
          verbose_logging = false,
          show_tool_calls = false,
          guardrails = '[]', guardrails_inline = '[]',
          sandbox_id = NULL,
          updated_at = now()
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
		},
		async hasSettings(agentId) {
			return store.hasAgent(agentId);
		},
		async getMetadata(agentId) {
			const sql = getDb();
			// CROSS-TENANT GUARD: same composite-key reasoning as `getSettings`, and
			// higher stakes — `verifyOwnedAgentAccess` vouches the caller against the
			// `owner_*` columns of whatever row this returns, so an id-only read lets
			// an arbitrary tenant's row decide authorization.
			const orgId = tryGetOrgId();
			if (!orgId) {
				logger.warn(
					{ agentId },
					"[getMetadata] no org context — returning null (cross-tenant guard)",
				);
				return null;
			}
			const rows = await sql`
          SELECT id, organization_id, name, description, owner_platform, owner_user_id,
                 created_at, last_used_at
          FROM agents
          WHERE id = ${agentId} AND organization_id = ${orgId}
        `;
			if (rows.length === 0) return null;
			return rowToMetadata(rows[0]);
		},
		async saveMetadata(agentId, metadata) {
			const sql = getDb();
			const orgId = getOrgId();
			const now = new Date();
			// Fresh-agent provisioning defaults, from the SAME helper every other
			// create path uses (see `resolveNewAgentProvisioningDefaults`). This is
			// the shared UPSERT reached by `AgentMetadataStore.createAgent`, i.e. the
			// `POST /api/v1/agents` route, so seeding here is what keeps an agent
			// created through that route runnable.
			//
			// The models column is deliberately ABSENT from the DO UPDATE SET
			// clause below. `saveMetadata` is an UPSERT, so any caller re-saving an
			// existing agent (a re-`createAgent` on an id that already exists, a
			// replayed apply) must never clobber an admin's curated `models`
			// allow-list. INSERT seeds it; CONFLICT leaves it untouched.
			const provisioning = await resolveNewAgentProvisioningDefaults(orgId);
			// The PK is (organization_id, id) — UPSERT on the composite key. Two
			// orgs can independently own an agent with the same id; the conflict
			// path here only triggers for re-saves within the *same* org.
			// `xmax = 0` on the returning row distinguishes a fresh INSERT from
			// a CONFLICT UPDATE so we can emit the right lifecycle event.
			const rows = await sql`
        INSERT INTO agents (id, organization_id, name, description, owner_platform, owner_user_id,
                            models, created_at)
        VALUES (
          ${agentId}, ${orgId}, ${metadata.name}, ${metadata.description ?? null},
          ${metadata.owner.platform}, ${metadata.owner.userId},
          ${sql.json(provisioning.models)},
          ${metadata.createdAt ? new Date(metadata.createdAt) : now}
        )
        ON CONFLICT (organization_id, id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          owner_platform = EXCLUDED.owner_platform,
          owner_user_id = EXCLUDED.owner_user_id,
          last_used_at = ${metadata.lastUsedAt ? new Date(metadata.lastUsedAt) : null},
          updated_at = ${now}
        RETURNING (xmax = 0) AS inserted
      `;
			const inserted = rows[0]?.inserted === true;
			recordLifecycleEvent({
				organizationId: orgId,
				entityType: "agent",
				op: inserted ? "created" : "updated",
				entityId: agentId,
				summary: inserted
					? `Agent "${metadata.name}" created`
					: `Agent "${metadata.name}" updated`,
			});
		},
		async updateMetadata(agentId, updates) {
			const sql = getDb();
			const orgId = getOrgId();
			// A DIRECT update of the three mutable metadata fields, deliberately NOT
			// a read-then-`saveMetadata` round trip. Routing a rename through the
			// UPSERT would run fresh-agent provisioning (provider discovery, and a
			// possible org-default lookup) on a metadata-only edit — wasted work,
			// and a rename that could fail on a provider-discovery error. COALESCE
			// keeps an omitted field at its current value.
			const rows = await sql`
        UPDATE agents SET
          name = COALESCE(${updates.name ?? null}, name),
          description = COALESCE(${updates.description ?? null}, description),
          last_used_at = COALESCE(${
						updates.lastUsedAt ? new Date(updates.lastUsedAt) : null
					}, last_used_at),
          updated_at = ${new Date()}
        WHERE id = ${agentId} AND organization_id = ${orgId}
        RETURNING name
      `;
			if (rows.length === 0) return;
			recordLifecycleEvent({
				organizationId: orgId,
				entityType: "agent",
				op: "updated",
				entityId: agentId,
				summary: `Agent "${rows[0].name ?? agentId}" updated`,
			});
		},
		async deleteMetadata(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        DELETE FROM agents
        WHERE id = ${agentId} AND organization_id = ${orgId}
        RETURNING name
      `;
			if (rows.length > 0) {
				recordLifecycleEvent({
					organizationId: orgId,
					entityType: "agent",
					op: "deleted",
					entityId: agentId,
					summary: `Agent "${rows[0].name ?? agentId}" deleted`,
				});
			}
		},
		async hasAgent(agentId) {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        SELECT 1 FROM agents WHERE id = ${agentId} AND organization_id = ${orgId} LIMIT 1
      `;
			return rows.length > 0;
		},
		async listAgents() {
			const sql = getDb();
			const orgId = getOrgId();
			const rows = await sql`
        SELECT id, organization_id, name, description, owner_platform, owner_user_id,
               created_at, last_used_at
        FROM agents
        WHERE organization_id = ${orgId}
        ORDER BY created_at DESC
      `;
			return rows.map(rowToMetadata);
		},
	};
	return store;
}

export function createPostgresAgentConnectionStore(): AgentConnectionStore {
	return {
		async getConnection(connectionId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			// `connections` is the sole source of truth (chat rows carry a non-null
			// credential_mode; data connectors leave it NULL). Keyed by slug.
			const slug = runtimeConnectionIdToSlug(connectionId);
			const projRows = orgId
				? await sql`
            SELECT * FROM connections
            WHERE organization_id = ${orgId} AND slug = ${slug}
              AND credential_mode IS NOT NULL AND deleted_at IS NULL
            LIMIT 1
          `
				: await sql`
            SELECT * FROM connections
            WHERE slug = ${slug}
              AND credential_mode IS NOT NULL AND deleted_at IS NULL
            LIMIT 1
          `;
			return projRows.length > 0 ? connectionsRowToStored(projRows[0]) : null;
		},
		async listConnections(filter) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			const agentId = filter?.agentId ?? null;
			const platform = filter?.platform ?? null;

			// CROSS-TENANT GUARD: an AGENT-scoped list with NO ambient org would drop
			// the org filter below and return ANOTHER tenant's rows for a shared
			// agent id (`lobu-builder`). That's a leak. Callers that legitimately
			// want all-tenant rows (reconcile loops, admin/list) do NOT pass
			// `agentId` and run either unscoped-by-design or inside their own
			// `orgContext.run` — so requiring an ambient org ONLY when `agentId` is
			// set is the tightest guard that leaves those callers untouched.
			if (agentId && !orgId) {
				logger.warn(
					{ agentId, platform },
					"[listConnections] agent-scoped list with no org context — returning empty (cross-tenant guard)",
				);
				return [];
			}

			// `connections` is the sole source of truth; `credential_mode IS NOT NULL`
			// selects chat rows only (data connectors leave it NULL). filter.agentId →
			// agent_id, filter.platform → connector_key.
			const projRows = await sql`
        SELECT * FROM connections
        WHERE credential_mode IS NOT NULL AND deleted_at IS NULL
          ${orgId ? sql`AND organization_id = ${orgId}` : sql``}
          ${agentId ? sql`AND agent_id = ${agentId}` : sql``}
          ${platform ? sql`AND connector_key = ${platform}` : sql``}
        ORDER BY created_at DESC
      `;
			return projRows.map(connectionsRowToStored);
		},
		async saveConnection(connection) {
			const sql = getDb();
			const orgId = getOrgId();
			const slug = runtimeConnectionIdToSlug(connection.id);

			// One transaction so the secret-preserving read, the
			// `pg_advisory_xact_lock` taken inside upsertChatConnectionProjection,
			// the one-active-per-tenant demotion, and the upsert are all serialized
			// together. The advisory lock is TRANSACTION-scoped — calling the writer
			// on the pool handle would release it after the first statement and
			// defeat the cross-replica serialization.
			//
			// A concurrent same-org tenant swap can deadlock after each transaction
			// demotes the other's target. Retrying once is safe here: every effect is
			// enclosed by this transaction, so PostgreSQL rolls the aborted attempt
			// back completely before the callback is re-run.
			await withChatConnectionDeadlockRetry(
				{ organizationId: orgId, slug },
				() =>
					sql.begin(async (tx: typeof sql) => {
						const configToPersist = { ...connection.config };
						// Universal lock order for chat writes (see
						// chatTenantAdvisoryLockKey): org-tenant advisory →
						// managed-workspace advisory → only then any `connections` row
						// lock (the FOR UPDATE below, and every row lock in the
						// projection). The managed lock is taken UNCONDITIONALLY rather
						// than after peeking at credential_mode — the peek would be a
						// TOCTOU (a concurrent managed install can flip the mode between
						// peek and FOR UPDATE, reopening the advisory↔row cycle);
						// over-acquiring on a BYO write merely serializes it against
						// managed writes on the same tenant. Both locks are reentrant, so
						// the projection re-taking them inside this txn is a no-op.
						const tenantLockKey = chatTenantAdvisoryLockKey(connection, orgId);
						if (tenantLockKey) {
							await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
								tenantLockKey,
							]);
						}
						const managedLockKey = managedTenantAdvisoryLockKey(connection);
						if (managedLockKey) {
							await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
								managedLockKey,
							]);
						}
						// Scope to the LIVE row only, and lock it. Slug uniqueness holds
						// solely for live rows (the projection's ON CONFLICT targets the
						// `WHERE deleted_at IS NULL` partial index), so a same-slug
						// tombstone — e.g. a deleted managed install whose slackinst-* id
						// was later recreated as BYO — must NOT be read here. Without the
						// filter, LIMIT 1 could pick the tombstone and its credential_mode
						// would reclassify the live row (managed↔byo). FOR UPDATE ties the
						// read to the same live row the upsert below writes.
						const existingRows = await tx`
          SELECT config, credential_mode
          FROM connections
          WHERE slug = ${slug} AND organization_id = ${orgId}
            AND deleted_at IS NULL
          LIMIT 1
          FOR UPDATE
        `;
						const existingConfig =
							existingRows[0] &&
							typeof existingRows[0].config === "object" &&
							existingRows[0].config
								? (existingRows[0].config as Record<string, any>)
								: null;

						// The generic store has no notion of managed vs BYO — it always
						// carried "byo" here, which reclassified an OAuth-MANAGED chat
						// connection to BYO on any store-driven edit (e.g. setting a
						// fallback agent_id via manage_connections update). A reclassified
						// managed row skips revokeManagedConnection on delete (leaking the
						// install's credentials) and loses managed-credential edit
						// protection. Preserve the existing mode; only a brand-new row
						// defaults to byo (managed rows are created by the Slack install
						// path, which passes "managed" explicitly).
						const existingCredentialMode =
							existingRows[0]?.credential_mode === "managed" ||
							existingRows[0]?.credential_mode === "byo"
								? (existingRows[0].credential_mode as "managed" | "byo")
								: null;

						// ChatInstanceManager normalizes secret fields into `secret://` refs
						// before reaching here. The remaining special case is the API surface
						// that hands back `***last4`-redacted values when a sanitized
						// connection is round-tripped to an UPDATE — preserve the existing
						// ref/value so a non-edited secret doesn't overwrite the real one.
						if (existingConfig) {
							for (const [key, value] of Object.entries(configToPersist)) {
								if (!isSecretField(key) || !isRedactedSecretValue(value))
									continue;

								const existingValue = existingConfig[key];
								if (
									typeof existingValue === "string" &&
									existingValue.length > 0
								) {
									configToPersist[key] = existingValue;
								}
							}
						}

						// `connections` is the sole source of truth — persist the chat projection.
						await upsertChatConnectionProjection(
							tx,
							(v) => sql.json(v),
							{ ...connection, config: configToPersist },
							orgId,
							existingCredentialMode ?? "byo",
						);
					}),
			);
		},
		async updateConnection(connectionId, updates) {
			const existing = await this.getConnection(connectionId);
			if (!existing) return;
			const merged = { ...existing, ...updates, updatedAt: Date.now() };
			await this.saveConnection(merged);
		},
		async deleteConnection(connectionId) {
			const sql = getDb();
			const orgId = tryGetOrgId();
			// `connections` is the sole source of truth — soft-delete (`deleted_at`)
			// the chat projection (kept for audit; getConnection filters it out).
			await sql.begin((tx) =>
				softDeleteChatConnectionProjection(tx, orgId, connectionId),
			);
		},
	};
}
