import { Value } from "@sinclair/typebox/value";
import { getDb } from "../../db/client.js";
import { getChatInstanceManager } from "../../lobu/gateway.js";
import {
	runtimeConnectionIdToSlug,
	slugToRuntimeConnectionId,
} from "../../lobu/stores/connections-projection.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { restoreRedactedConfig } from "../../utils/connection-config-redaction.js";
import { SLACK_INSTALLATION_ID_PREFIX } from "../../lobu/stores/slack-installations.js";
import { PlatformAdapterConfigSchema } from "../routes/schemas/platform-config.js";
import { isAdapterlessPlatform } from "./chat-instance-manager.js";
import { getPlatformDescriptor } from "./platforms/index.js";
import { createSlackWebApi } from "./slack-web.js";
import { isSlackConfig, type PlatformAdapterConfig } from "./types.js";

const CHAT_LOCK_NAMESPACE = 0x63686174; // "chat"

type ReservedSql = ((
	strings: TemplateStringsArray,
	...values: unknown[]
) => Promise<unknown[]>) & { release(): void };

export interface ChatConnectionRow {
	id: number;
	organization_id: string;
	connector_key: string;
	slug: string;
	credential_mode: "byo" | "managed";
	status: string;
	config: Record<string, unknown>;
	display_name: string | null;
}

export interface UpsertChatConnectionInput {
	organizationId: string;
	platform: string;
	stableId: string;
	displayName?: string;
	agentId?: string;
	config: Record<string, unknown>;
	settings?: { allowFrom?: string[]; allowGroups?: boolean };
}

function hashLockKey(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

async function withStableChatLock<T>(
	organizationId: string,
	stableId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const sql = getDb() as unknown as { reserve(): Promise<ReservedSql> };
	const reserved = await sql.reserve();
	const key = hashLockKey(`${organizationId}:${stableId}`);
	try {
		await reserved`SELECT pg_advisory_lock(${CHAT_LOCK_NAMESPACE}, ${key})`;
		try {
			return await fn();
		} finally {
			await reserved`SELECT pg_advisory_unlock(${CHAT_LOCK_NAMESPACE}, ${key})`;
		}
	} finally {
		reserved.release();
	}
}

function requireManager() {
	const manager = getChatInstanceManager();
	if (!manager) {
		throw new Error(
			"Chat connection manager unavailable — retry once startup completes",
		);
	}
	return manager;
}

function requireChatPlatform(platform: string): void {
	// Adapterless platforms (rest, webhook) have no descriptor by design — the
	// row persists but no chat instance is ever created (lobu-ai/lobu#1179).
	if (!getPlatformDescriptor(platform) && !isAdapterlessPlatform(platform)) {
		throw new Error(`Unsupported chat platform: ${platform}`);
	}
}

/**
 * A config key counts as supplied when it carries a non-blank string or the
 * boolean `true` — the latter for an opt-in flag that STANDS IN for a
 * credential (declare it in an either-or group) rather than holding one.
 */
function isConfigKeySupplied(value: unknown): boolean {
	if (value === true) return true;
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Presence and usability of a platform's credentials, read off that platform's
 * own descriptor. Every requirement is declared in `platforms/<key>.ts`, so
 * no platform branch lives here — adding a platform never edits this file.
 */
function validateRequiredCredentials(
	platform: string,
	config: Record<string, unknown>,
): void {
	const descriptor = getPlatformDescriptor(platform);
	const missing = (descriptor?.requiredConfigKeys ?? [])
		.filter((requirement) =>
			typeof requirement === "string"
				? !isConfigKeySupplied(config[requirement])
				: !requirement.some((key) => isConfigKeySupplied(config[key])),
		)
		.map((requirement) =>
			typeof requirement === "string" ? requirement : requirement.join(" or "),
		);
	if (missing.length > 0) {
		throw new Error(
			`Missing required ${platform} configuration: ${missing.join(", ")}`,
		);
	}
	descriptor?.assertCredentialsUsable?.(config);
}

export function parseConfig(
	platform: string,
	rawConfig: Record<string, unknown>,
): PlatformAdapterConfig {
	requireChatPlatform(platform);
	const candidate = { ...rawConfig, platform };
	// Validate against the union member matching `platform` (requireChatPlatform
	// guarantees one exists) so failures surface FIELD-level messages (e.g. the
	// Telegram token pattern) instead of a generic union mismatch. STRICT Check,
	// no Value.Convert: the `lobu apply` string-boolean spellings are accepted
	// by the SCHEMA (boolOrString includes the "true"/"false" literals, exactly
	// like the previous Zod union), while coercion would silently accept
	// wrong-typed credentials (numeric botToken → "123"). Clean strips unknown
	// keys so they don't get persisted (Zod's `safeParse` parity).
	const memberSchema =
		PlatformAdapterConfigSchema.anyOf.find(
			(s) => s.properties.platform.const === platform,
		) ?? PlatformAdapterConfigSchema;
	if (!Value.Check(memberSchema, candidate)) {
		const messages = [...Value.Errors(memberSchema, candidate)].map(
			(issue) => `${issue.path || "(root)"} ${issue.message}`.trim(),
		);
		throw new Error(messages.join("; ") || "invalid platform config");
	}
	const coerced = Value.Clean(memberSchema, candidate);
	validateRequiredCredentials(platform, coerced as Record<string, unknown>);
	// The TypeBox union and the hand-written `PlatformAdapterConfig` union are
	// member-for-member equivalent; TS treats the schema-inferred type as distinct
	// only because of declaration order / optional-field variance.
	return coerced as PlatformAdapterConfig;
}

async function validateProviderIdentity(
	config: PlatformAdapterConfig,
): Promise<Record<string, unknown>> {
	const metadata: Record<string, unknown> = {};
	if (isSlackConfig(config)) {
		// Since @chat-adapter/slack 4.38, `botToken` may be a lazy resolver rather
		// than a literal, so the adapter can fetch a per-workspace token on demand.
		// authTest needs the resolved value.
		const configured = config.botToken;
		if (!configured) throw new Error("Slack bot token is required");
		const botToken =
			typeof configured === "function" ? await configured() : configured;
		const identity = await createSlackWebApi().authTest(botToken);
		metadata.teamId = identity.teamId;
	}
	return metadata;
}

export async function getChatConnectionRow(
	organizationId: string,
	connectionId: number,
): Promise<ChatConnectionRow | null> {
	const sql = getDb();
	const rows = (await sql`
    SELECT id, organization_id, connector_key, slug, credential_mode, status,
           config, display_name
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as ChatConnectionRow[];
	return rows[0] ?? null;
}

/**
 * Resolve one stored Slack connection's bot credential through the same
 * secret-aware gateway path used to boot its adapter, then probe Slack itself.
 * The token never leaves this function; callers receive provider identity only.
 */
export async function probeSlackConnectionIdentity(
	organizationId: string,
	connectionId: number,
): Promise<{
	teamId: string;
	enterpriseId: string | null;
	isEnterpriseInstall: boolean;
}> {
	const row = await getChatConnectionRow(organizationId, connectionId);
	if (!row || row.connector_key !== "slack") {
		throw new Error("Slack connection not found");
	}
	const runtimeId = slugToRuntimeConnectionId(row.slug);
	const manager = requireManager();
	const config = await orgContext.run({ organizationId }, () =>
		manager.resolveConnectionConfig(
			runtimeId,
			row.config as PlatformAdapterConfig,
		),
	);
	if (!isSlackConfig(config)) {
		throw new Error("Stored Slack connection config is invalid");
	}
	const configured = config.botToken;
	if (!configured) throw new Error("Slack bot token is missing");
	const botToken =
		typeof configured === "function" ? await configured() : configured;
	return createSlackWebApi().authTest(botToken);
}

/**
 * Unwind the two placeholder layers on an incoming BYO chat config, in order,
 * before anything treats it as credentials.
 *
 * 1. RESTORE. Callers round-trip config read back from the (redacted)
 *    connection read paths, so a `__LOBU_REDACTED__` here means "unchanged" —
 *    take the stored value rather than persisting the placeholder. Chat
 *    connectors are the ones declaring `format: "password"` (Slack/Discord bot
 *    tokens), so without this an apply built from a redacted read would both
 *    fail `validateProviderIdentity` and overwrite a live bot token.
 *
 * 2. RESOLVE. What the restore hands back is whatever is STORED — and for a BYO
 *    chat connection that is a `secret://` REFERENCE, not plaintext. None of
 *    the downstream consumers (`parseConfig`, `connectionMatches`,
 *    `validateProviderIdentity`) resolve references, so an unresolved ref makes
 *    an UNCHANGED re-apply look changed and makes `validateProviderIdentity`
 *    authenticate with the literal `secret://…` URI.
 *
 * This is the sentinel bug one indirection out: that fix stopped a PLACEHOLDER
 * being treated as a live credential, and a stored `secret://` ref is the same
 * kind of placeholder. Order matters — resolving before restoring does nothing
 * for a sentinel, so the placeholder would reach the consumers.
 *
 * `stableId` IS the runtime id resolution needs (the slug is derived from it),
 * so this needs nothing that isn't already in hand at the call site: no
 * validation is reordered to make it possible.
 *
 * Exported as the testable seam for that ordering — `upsertByoChatConnection`
 * itself takes a `pg_advisory_lock` through `sql.reserve()`, which the test
 * harness's pooled client does not service.
 */
export async function unwrapIncomingChatConfig(params: {
	organizationId: string;
	stableId: string;
	incoming: Record<string, unknown>;
	/** The stored row's config, or undefined when creating. */
	stored: Record<string, unknown> | undefined;
	resolveRefs: (
		runtimeId: string,
		config: PlatformAdapterConfig,
	) => Promise<PlatformAdapterConfig>;
}): Promise<Record<string, unknown>> {
	// Nothing stored yet: the caller supplied real values, and there is no row
	// to restore from or reference to resolve.
	if (!params.stored) return params.incoming;

	const restored = restoreRedactedConfig(
		params.incoming,
		params.stored,
	) as PlatformAdapterConfig;

	return (await resolveChatConfigRefsForOrg({
		organizationId: params.organizationId,
		runtimeId: params.stableId,
		config: restored,
		resolveRefs: params.resolveRefs,
	})) as unknown as Record<string, unknown>;
}

/**
 * Resolve stored chat secret references inside the explicit tenant context.
 * The Postgres secret store scopes `secret://` lookups through orgContext, so
 * request paths that already carry organizationId must install it here rather
 * than relying on ambient middleware context.
 */
async function resolveChatConfigRefsForOrg(params: {
	organizationId: string;
	runtimeId: string;
	config: PlatformAdapterConfig;
	resolveRefs: (
		runtimeId: string,
		config: PlatformAdapterConfig,
	) => Promise<PlatformAdapterConfig>;
}): Promise<PlatformAdapterConfig> {
	return orgContext.run({ organizationId: params.organizationId }, () =>
		params.resolveRefs(params.runtimeId, params.config),
	);
}

export async function upsertByoChatConnection(
	input: UpsertChatConnectionInput,
): Promise<{
	connectionId: number;
	runtimeId: string;
	created: boolean;
	changed: boolean;
}> {
	if (input.platform === "webhook" && /^\d+$/.test(input.stableId)) {
		throw new Error(
			"Webhook connection slugs cannot be numeric because numeric webhook URLs are reserved for provider connector IDs",
		);
	}
	if (input.stableId.startsWith(SLACK_INSTALLATION_ID_PREFIX)) {
		throw new Error(
			`Stable ID ${input.stableId} is reserved for managed Slack installations`,
		);
	}
	return withStableChatLock(input.organizationId, input.stableId, async () => {
		const sql = getDb();
		const slug = runtimeConnectionIdToSlug(input.stableId);
		const existingRows = (await sql`
      SELECT id, slug, connector_key, config, status, display_name, agent_id
      FROM connections
      WHERE organization_id = ${input.organizationId}
        AND slug = ${slug}
        AND credential_mode = 'byo'
        AND deleted_at IS NULL
      LIMIT 1
    `) as Array<{
			id: number;
			slug: string;
			connector_key: string;
			config: Record<string, unknown>;
			status: string;
			display_name: string | null;
			agent_id: string | null;
		}>;

		const manager = requireManager();
		const settings = { allowGroups: true, ...(input.settings ?? {}) };
		const existing = existingRows[0];
		const config = parseConfig(
			input.platform,
			await unwrapIncomingChatConfig({
				organizationId: input.organizationId,
				stableId: input.stableId,
				incoming: input.config,
				stored: existing?.config,
				resolveRefs: (id, cfg) => manager.resolveConnectionConfig(id, cfg),
			}),
		);
		if (!existing) {
			const providerMetadata = await validateProviderIdentity(config);
			await orgContext.run({ organizationId: input.organizationId }, () =>
				manager.addConnection(
					input.platform,
					input.agentId,
					config,
					settings,
					{
						...providerMetadata,
						...(input.displayName ? { teamName: input.displayName } : {}),
					},
					input.stableId,
				),
			);
			const rows = (await sql`
        SELECT id FROM connections
        WHERE organization_id = ${input.organizationId}
          AND slug = ${slug}
          AND deleted_at IS NULL
        LIMIT 1
      `) as Array<{ id: number }>;
			if (!rows[0]) throw new Error("Chat connection did not persist");
			return {
				connectionId: rows[0].id,
				runtimeId: input.stableId,
				created: true,
				changed: true,
			};
		}
		if (existing.connector_key !== input.platform) {
			throw new Error(
				`Chat connection ${input.stableId} is already ${existing.connector_key}; stable IDs cannot change platform`,
			);
		}
		// A stable ID names ONE agent's connection: a colliding apply from another
		// agent must not silently reparent the row and steal its traffic.
		if (
			input.agentId !== undefined &&
			existing.agent_id !== null &&
			existing.agent_id !== input.agentId
		) {
			throw new Error(
				`Stable ID ${input.stableId} is already used by a different agent`,
			);
		}
		// An apply that omits agent_id keeps the current owner rather than
		// orphaning the connection.
		const agentId = input.agentId ?? existing.agent_id ?? undefined;

		const matches = await orgContext.run(
			{ organizationId: input.organizationId },
			() =>
				manager.connectionMatches(input.stableId, config, settings, agentId),
		);
		if (
			matches &&
			(!input.displayName || existing.display_name === input.displayName)
		) {
			return {
				connectionId: existing.id,
				runtimeId: input.stableId,
				created: false,
				changed: false,
			};
		}

		const providerMetadata = matches
			? {}
			: await validateProviderIdentity(config);
		await orgContext.run({ organizationId: input.organizationId }, () =>
			manager.updateConnection(input.stableId, {
				agentId: agentId ?? null,
				...(matches ? {} : { config }),
				settings,
				metadata: {
					...providerMetadata,
					...(input.displayName ? { teamName: input.displayName } : {}),
				},
			}),
		);
		if (input.displayName && existing.display_name !== input.displayName) {
			await sql`
        UPDATE connections
        SET display_name = ${input.displayName}, updated_at = now()
        WHERE id = ${existing.id} AND organization_id = ${input.organizationId}
      `;
		}
		return {
			connectionId: existing.id,
			runtimeId: input.stableId,
			created: false,
			changed: true,
		};
	});
}

export async function updateChatConnection(input: {
	organizationId: string;
	connectionId: number;
	displayName?: string;
	/** Fallback agent for the chat runtime; `null` clears it, `undefined` leaves it untouched. */
	agentId?: string | null;
	config?: Record<string, unknown>;
	status?: string;
}): Promise<void> {
	// Identity-only pre-read: resolves which connection this is (and therefore
	// the lock key). Every value this function ACTS on is re-read under the lock
	// below — nothing from this snapshot is trusted for the write.
	const identity = await getChatConnectionRow(
		input.organizationId,
		input.connectionId,
	);
	if (!identity) throw new Error("Chat connection not found");
	const runtimeId = slugToRuntimeConnectionId(identity.slug);

	// Serialize on the same stable-chat lock `upsertByoChatConnection` uses, so
	// a config edit and a concurrent apply/rotation of the SAME connection
	// cannot interleave. Without it there is no serialization on this path at
	// all, and the restore below would source a stale row.
	return withStableChatLock(input.organizationId, runtimeId, async () => {
		// Re-read INSIDE the lock: this is the row the write is actually based on.
		const row = await getChatConnectionRow(
			input.organizationId,
			input.connectionId,
		);
		if (!row) throw new Error("Chat connection not found");
		// Managed installs own their credentials, but credential-free updates —
		// pause/resume, rename — still apply to them.
		if (row.credential_mode !== "byo" && input.config) {
			throw new Error("Managed app credentials cannot be edited directly");
		}
		const manager = requireManager();
		if (input.config) {
			const currentConfig = { ...(row.config ?? {}) };
			delete currentConfig.settings;
			delete currentConfig.chatMetadata;
			// Un-redact against the LOCKED row, not the caller's snapshot. A
			// `__LOBU_REDACTED__` means "unchanged", so it must resolve to what is
			// stored NOW — restoring from a stale read would write a pre-rotation
			// token back over a newer one, silently rolling the rotation back.
			// (This is why crud.ts hands us the RAW incoming config.)
			const restored = restoreRedactedConfig(
				input.config,
				currentConfig,
			) as Record<string, unknown>;
			const merged = {
				...currentConfig,
				...restored,
			} as PlatformAdapterConfig;
			const resolved = await resolveChatConfigRefsForOrg({
				organizationId: input.organizationId,
				runtimeId,
				config: merged,
				resolveRefs: (id, config) =>
					manager.resolveConnectionConfig(id, config),
			});
			const config = parseConfig(
				row.connector_key,
				resolved as unknown as Record<string, unknown>,
			);
			const providerMetadata = await validateProviderIdentity(config);
			await orgContext.run({ organizationId: input.organizationId }, () =>
				manager.updateConnection(runtimeId, {
					...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
					config,
					metadata: {
						...providerMetadata,
						...(input.displayName ? { teamName: input.displayName } : {}),
					},
				}),
			);
		} else if (input.agentId !== undefined) {
			// agentId-only update: no config change, so no restart is needed — the
			// manager persists the new fallback agent and refreshes any warm
			// in-memory instance in place.
			await orgContext.run({ organizationId: input.organizationId }, () =>
				manager.updateConnection(runtimeId, { agentId: input.agentId }),
			);
		}
		if (input.status === "active") {
			await manager.restartConnection(runtimeId);
		} else if (input.status === "paused") {
			await manager.stopConnection(runtimeId);
		}
		if (input.displayName !== undefined) {
			const sql = getDb();
			await sql`
        UPDATE connections
        SET display_name = ${input.displayName || row.connector_key}, updated_at = now()
        WHERE id = ${row.id} AND organization_id = ${input.organizationId}
      `;
		}
	});
}

export async function deleteChatConnection(
	organizationId: string,
	connectionId: number,
	opts?: { skipConnectionTombstone?: boolean },
): Promise<void> {
	const row = await getChatConnectionRow(organizationId, connectionId);
	if (!row) throw new Error("Chat connection not found");
	const manager = requireManager();
	if (row.credential_mode === "managed") {
		await manager.revokeManagedConnection(connectionId, {
			skipTombstone: opts?.skipConnectionTombstone,
		});
		return;
	}
	await orgContext.run({ organizationId }, () =>
		manager.removeConnection(slugToRuntimeConnectionId(row.slug), {
			skipTombstone: opts?.skipConnectionTombstone,
		}),
	);
}
