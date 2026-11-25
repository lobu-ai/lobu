/**
 * Shared validation and persistence for agent configuration. REST and MCP
 * retain their transport/access rules and use the same transactional writers.
 */
import { createHash } from "node:crypto";
import type { AgentConfigStore, AgentMetadata, AgentSettings } from "@lobu/core";
import {
	AgentConfigRevisionSchema,
	type AgentCreateInput,
} from "@lobu/core/contracts/tools/manage-agents";
import { stableStringify } from "@lobu/core/contracts/tools/view-content-hash";
import { isUnrestrictedMode } from "@lobu/connector-sdk/egress-policy";
import { AgentSettingsStoredSchema } from "@lobu/core/contracts/agent-settings";
import { Value } from "@sinclair/typebox/value";
import { resolveNewAgentProvisioningDefaults } from "../auth/system-provider-resolution";
import { type DbClient, getDb } from "../db/client";
import { loadAllowedDomains } from "../gateway/config/network-allowlist";
import {
	findSuppressedJudgedDomains,
	judgedEgressDomains,
} from "../gateway/permissions/policy-store";
import {
	agentGuardrailPrincipal,
	resolveEgressGuardrails,
} from "../guardrails/workspace-guardrails";
import {
	type ConfigChangeEventParams,
	insertConfigChangeEventInTransaction,
} from "../utils/insert-event";
import logger from "../utils/logger";
import {
	type ModelValidationError,
	validateModelRefsAgainstOrg,
} from "./model-config";
import { createPostgresAgentConfigStore } from "./stores/postgres-stores";

/** Caller holds a shared/read or update lock on this agent for a consistent snapshot. */
export async function agentConfigRevision(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	settings: AgentSettings,
): Promise<string> {
	const metadata = await createPostgresAgentConfigStore(tx).getMetadata(agentId);
	const { updatedAt: _updatedAt, authProfiles: _authProfiles, ...stored } = settings;
	return createHash("sha256")
		.update(stableStringify({
			organizationId,
			agentId,
			createdAt: metadata?.createdAt,
			name: metadata?.name,
			description: metadata?.description ?? null,
			settings: stored,
		}))
		.digest("hex");
}

/** Shared by HTTP If-Match and the MCP/SDK expected_revision precondition. */
export function validateAgentConfigRevision(expected: string | undefined, actual: string): {
	status: 400 | 409;
	error: string;
	error_description: string;
} | null {
	if (expected === undefined) return null;
	const revision = expected.startsWith('"') && expected.endsWith('"')
		? expected.slice(1, -1)
		: expected;
	if (!Value.Check(AgentConfigRevisionSchema, revision)) {
		return {
			status: 400,
			error: "invalid_agent_config_revision",
			error_description: "Use the revision returned by agents.get or the ETag from an agent read.",
		};
	}
	if (revision !== actual) {
		return {
			status: 409,
			error: "agent_config_conflict",
			error_description: "Agent configuration changed. Reload and review it before applying this change.",
		};
	}
	return null;
}

/**
 * Write-boundary check for `networkConfig` domain lists. Agent network settings
 * are deliberately looser than connector declarations (an operator may list
 * hosts a third party could not), so this does NOT apply the strict domain
 * grammar. It refuses only entries that can never name a host under any
 * grammar: non-strings, empty or whitespace-only strings, and strings containing
 * whitespace. They were previously persisted verbatim and then silently matched
 * nothing.
 */
export function validateNetworkConfig(updates: unknown): string | null {
	const config = (updates as { networkConfig?: unknown } | null)?.networkConfig;
	if (config === undefined || config === null) return null;
	if (typeof config !== "object" || Array.isArray(config)) {
		return "networkConfig must be an object";
	}
	for (const key of ["allowedDomains", "deniedDomains"] as const) {
		const list = (config as Record<string, unknown>)[key];
		if (list === undefined || list === null) continue;
		if (!Array.isArray(list)) return `networkConfig.${key} must be an array`;
		for (const [i, entry] of list.entries()) {
			if (typeof entry !== "string") {
				return `networkConfig.${key}/${i} must be a string`;
			}
			if (entry.trim() === "") {
				return `networkConfig.${key}/${i} must not be empty`;
			}
			if (/\s/.test(entry)) {
				return `networkConfig.${key}/${i} must not contain whitespace`;
			}
		}
	}
	return null;
}

/**
 * Settings keys that moved out of agent settings, with where they live now.
 * A patch carrying one is refused with a 422 (`setting_moved`) rather than
 * dropped, so a caller still writing the old shape learns the new home.
 */
const MOVED_SETTINGS: Record<string, string> = {
	skillsConfig:
		"skillsConfig was removed from agent settings: skills live in the workspace skill library. Read them with manage_skills.",
	guardrails:
		"guardrails was removed from agent settings: guardrails live in the workspace guardrail library. Read them with GET /api/:org/guardrails or client.guardrails; they are listed in Settings → Policies.",
	guardrailsInline:
		"guardrailsInline was removed from agent settings: custom checks live in the workspace guardrail library. Read them with GET /api/:org/guardrails or client.guardrails; they are listed in Settings → Policies.",
};

/** The 422 message for the first moved key in `updates`, or null. */
export function movedSettingError(updates: unknown): string | null {
	if (updates === null || typeof updates !== "object") return null;
	for (const [key, message] of Object.entries(MOVED_SETTINGS)) {
		if (Object.hasOwn(updates, key)) return message;
	}
	return null;
}

/**
 * Write-boundary type check for the settings fields a patch may carry.
 *
 * Without it a wrongly-typed value (`{"verboseLogging":"not-a-boolean"}`) was
 * handed to the store, which coerced or ignored it, and the route still answered
 * `{ success: true }` - the caller could not tell the write had not applied.
 * Each key the stored-settings schema knows is checked against its own property
 * schema, so this cannot drift from the type the readers rely on. Unknown keys
 * (`authProfiles` and the legacy model fields, which the PATCH route handles
 * itself) and `null` (an explicit clear) keep their existing handling. `models`
 * is skipped here: it has a stricter validator of its own with its own error
 * code.
 */
const OWN_VALIDATED_SETTINGS_KEYS = new Set(["models"]);

export function validateSettingsPatch(updates: unknown): string | null {
	if (updates === null || typeof updates !== "object" || Array.isArray(updates)) {
		return "request body must be a JSON object";
	}
	if (Object.hasOwn(updates, "toolsConfig")) {
		return "toolsConfig was removed. Configure action permissions in Settings → Policies.";
	}
	const properties = AgentSettingsStoredSchema.properties as Record<
		string,
		Parameters<typeof Value.Check>[0]
	>;
	for (const [key, value] of Object.entries(updates)) {
		if (key === "updatedAt" || OWN_VALIDATED_SETTINGS_KEYS.has(key)) continue;
		// Own keys only: a body key such as "constructor" or "toString" would
		// otherwise resolve to an inherited Object.prototype member and make
		// Value.Check throw instead of being treated as an unknown key.
		if (!Object.hasOwn(properties, key)) continue;
		const schema = properties[key];
		if (!schema || value === null) continue;
		if (Value.Check(schema, value)) continue;
		const first = Value.Errors(schema, value).First();
		return `${key}${first?.path ?? ""}: ${first?.message ?? "invalid value"}`;
	}
	return null;
}

interface AgentSettingsValidationError {
	error: string;
	error_description: string;
}

/**
 * Validate a settings patch for an agent. Returns `null` when the patch may be
 * persisted, otherwise the error envelope; a `models` error also carries the
 * structured `modelError` so the HTTP route can enrich it with
 * request-derived URLs.
 */
export async function validateAgentSettingsUpdate(
	updates: unknown,
	organizationId: string,
	agentId: string
): Promise<
	| AgentSettingsValidationError
	| (AgentSettingsValidationError & { modelError: ModelValidationError })
	| null
> {
	const moved = movedSettingError(updates);
	if (moved) return { error: "setting_moved", error_description: moved };

	// Type-check every known settings field before anything is persisted, so a
	// wrongly-typed value is refused atomically instead of reported as success.
	const settingsPatchError = validateSettingsPatch(updates);
	if (settingsPatchError) {
		return {
			error: "invalid_settings",
			error_description: settingsPatchError,
		};
	}

	const networkConfigError = validateNetworkConfig(updates);
	if (networkConfigError) {
		return {
			error: "invalid_network_config",
			error_description: networkConfigError,
		};
	}

	const patch = updates as Partial<AgentSettings>;

	// An allow grant BEATS the egress judge. `checkDomainAccess` (proxy/
	// http-proxy.ts) checks per-agent allow grants (step 4) before consulting
	// the judge (step 5), so a domain that is both judged and allow-granted
	// returns `source: "grant"` and its judge never runs. That failure is
	// invisible from the outside — the request succeeds, just for the wrong
	// reason — so refuse the config instead of saving a control that cannot fire.
	//
	// The judges come from the workspace guardrail library, so only a patch
	// that touches `networkConfig` can open the hole here: an unrelated edit to
	// an agent already in this state still saves, and removing the grant is
	// always a valid repair.
	if ("networkConfig" in (updates as object)) {
		const effectiveGuardrails =
			(
				await resolveEgressGuardrails(
					getDb(),
					organizationId,
					agentGuardrailPrincipal(agentId),
					null,
				)
			).rows ?? [];
		const effectiveAllowed = patch.networkConfig?.allowedDomains ?? [];

		const shadowed = findSuppressedJudgedDomains(
			effectiveGuardrails,
			effectiveAllowed
		);
		// Every judge covering a domain runs, so an allow over that domain
		// silences each of them: name every (judge, domain) pair it hides.
		if (shadowed.length > 0) {
			const pairs = shadowed
				.map(
					({ domain, judge, grant }) =>
						`guardrail "${judge}" judges "${domain}" but allowedDomains grants "${grant}"`,
				)
				.join("; ");
			return {
				error: "guardrail_domain_shadowed_by_grant",
				error_description: `This agent's networkConfig.allowedDomains shadows egress judges, and the proxy matches an allow grant FIRST — these judges would never run: ${pairs}. A judged domain must not be allow-listed: remove the grant from allowedDomains (a judged domain is reachable through its judges, so it needs no grant), or drop the domain from the guardrail.`,
			};
		}

		// The GLOBAL allowlist shadows judges the same way (`checkDomainAccess`
		// step 3), but it is `WORKER_ALLOWED_DOMAINS` — operator config the
		// tenant editing this agent cannot fix. Warn rather than reject, so
		// the signal reaches whoever can act on it without blocking a save
		// nobody in this request can make valid. Only consult the allowlist
		// when there is a judge to shadow: `loadAllowedDomains` logs on every
		// call in isolation mode.
		if (judgedEgressDomains(effectiveGuardrails).length > 0) {
			const globalAllowed = loadAllowedDomains();
			const unrestricted = isUnrestrictedMode(globalAllowed);
			// Unrestricted mode allows every host, so it shadows every judged
			// domain without any of them appearing in a list to match against.
			// The global matcher's `.suffix` also covers the root host, unlike a
			// per-agent grant.
			if (
				unrestricted ||
				findSuppressedJudgedDomains(effectiveGuardrails, globalAllowed, {
					wildcardCoversRoot: true,
				}).length > 0
			) {
				logger.warn(
					`[agent-config] agent "${agentId}" has egress judge guardrails whose domains are covered by WORKER_ALLOWED_DOMAINS${
						unrestricted ? " (unrestricted, '*')" : ""
					}. The global allowlist is matched before the judge, so those judges will not run.`
				);
			}
		}
	}

	// The `models` list is an access gate, so a lookup/infra failure while
	// validating it must REJECT the write — never persist an unvalidated
	// allow-list that could silently widen access.
	const models = patch.models;
	if (models !== undefined) {
		try {
			const modelError = await validateModelRefsAgainstOrg(
				models,
				organizationId
			);
			if (modelError) {
				return {
					error: modelError.kind,
					error_description: modelError.message,
					modelError,
				};
			}
		} catch (err) {
			logger.warn(
				{ agentId, err },
				"Failed to validate models list before saving agent settings — rejecting"
			);
			return {
				error: "models_validation_failed",
				error_description:
					"Could not validate the models list against the organization's providers. No change was saved; please retry.",
			};
		}
	}

	return null;
}

type AgentConfigAudit = Pick<
	ConfigChangeEventParams,
	| "organizationId"
	| "applyId"
	| "actorSource"
	| "createdBy"
	| "clientId"
	| "agentId"
	| "actingAutomationId"
	| "actingRunId"
	| "mcpSessionId"
	| "tokenType"
>;

/**
 * Persist a validated settings patch and its config audit row in the caller's
 * transaction. The caller holds the org and agent row locks and passes the
 * settings snapshot it validated against as `before`, so the audit pre-image is
 * the row the patch actually merged into.
 */
export async function persistAgentSettingsPatch(
	tx: DbClient,
	agentId: string,
	updates: Partial<AgentSettings>,
	before: AgentSettings | null,
	audit: AgentConfigAudit
): Promise<void> {
	const store = createPostgresAgentConfigStore(tx);
	await store.updateSettings(agentId, {
		...updates,
		// Persist the trimmed refs, not the raw client payload.
		...(updates.models
			? { models: updates.models.map((model) => model.trim()) }
			: {}),
	});
	// Snapshot the merged settings row as stored (the store merges partial
	// patches server-side), so the audit state reflects what took effect.
	const merged = await store.getSettings(agentId);
	await insertConfigChangeEventInTransaction(
		{
			...audit,
			before: before ? { ...before } : null,
			resourceKind: "agent-settings",
			resourceId: agentId,
			op: "updated",
			summary: `Agent '${agentId}' settings updated`,
			state: merged ? { ...merged } : null,
			changedFields: Object.keys(updates),
		},
		tx
	);
}

/** Idempotent insertion; an external ownership mapping commits with the agent. */
export async function insertAgentConfig(
	tx: DbClient,
	args: Pick<
		AgentCreateInput,
		"agent_id" | "name" | "description" | "identity_md"
	>,
	owner: AgentMetadata["owner"],
	models: AgentSettings["models"] | null | undefined,
	audit: AgentConfigAudit
): Promise<boolean> {
	const seedModels =
		models === undefined
			? (await resolveNewAgentProvisioningDefaults(audit.organizationId)).models
			: models;
	const rows = await tx`
		INSERT INTO agents (id, organization_id, name, description, identity_md,
			owner_platform, owner_user_id, models, created_at, updated_at)
		VALUES (${args.agent_id}, ${audit.organizationId}, ${args.name}, ${args.description ?? null},
			${args.identity_md ?? ""}, ${owner.platform}, ${owner.userId},
			${seedModels == null ? null : tx.json(seedModels)}, NOW(), NOW())
		ON CONFLICT (organization_id, id) DO NOTHING RETURNING id
	`;
	if (!rows.length) return false;
	if (owner.platform === "external") {
		await tx`INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
			VALUES (${audit.organizationId}, ${args.agent_id}, ${owner.platform}, ${owner.userId}, NOW())
			ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING`;
	}
	await insertConfigChangeEventInTransaction(
		{
			...audit,
			resourceKind: "agent",
			resourceId: args.agent_id,
			op: "created",
			summary: `Agent '${args.name}' created`,
			before: null,
			state: {
				agentId: args.agent_id,
				name: args.name,
				description: args.description ?? null,
			},
		},
		tx
	);
	return true;
}

/** Caller holds the org and agent row locks, just as for settings patches. */
export async function persistAgentMetadataPatch(
	tx: DbClient,
	agentId: string,
	updates: Parameters<AgentConfigStore["updateMetadata"]>[1],
	audit: AgentConfigAudit
): Promise<void> {
	const store = createPostgresAgentConfigStore(tx);
	const before = await store.getMetadata(agentId);
	await store.updateMetadata(agentId, updates);
	const after = await store.getMetadata(agentId);
	await insertConfigChangeEventInTransaction(
		{
			...audit,
			resourceKind: "agent",
			resourceId: agentId,
			op: "updated",
			summary: `Agent '${after?.name ?? agentId}' metadata updated`,
			before: before ? { ...before } : null,
			state: after ? { ...after } : null,
			changedFields: Object.keys(updates),
		},
		tx
	);
}

/** Caller holds the org and agent row locks; FK cascades own dependent cleanup. */
export async function deleteAgentConfig(
	tx: DbClient,
	agentId: string,
	audit: AgentConfigAudit
): Promise<boolean> {
	const store = createPostgresAgentConfigStore(tx);
	const before = await store.getMetadata(agentId);
	if (!before) return false;
	await store.deleteMetadata(agentId);
	await insertConfigChangeEventInTransaction(
		{
			...audit,
			resourceKind: "agent",
			resourceId: agentId,
			op: "deleted",
			summary: `Agent '${agentId}' deleted`,
			before: { ...before },
			state: null,
		},
		tx
	);
	return true;
}
