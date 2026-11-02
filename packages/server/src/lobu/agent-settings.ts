/**
 * Shared validation and persistence for agent configuration. REST and MCP
 * retain their transport/access rules and use the same transactional writers.
 */
import type { AgentConfigStore, AgentMetadata, AgentSettings } from "@lobu/core";
import type { AgentCreateInput } from "@lobu/core/contracts/tools/manage-agents";
import { isUnrestrictedMode } from "@lobu/connector-sdk/egress-policy";
import {
	AgentSettingsStoredSchema,
	SkillsConfigSchema,
} from "@lobu/core/contracts/agent-settings";
import { Value } from "@sinclair/typebox/value";
import { resolveNewAgentProvisioningDefaults } from "../auth/system-provider-resolution";
import type { DbClient } from "../db/client";
import { loadAllowedDomains } from "../gateway/config/network-allowlist";
import { resolveSystemJudgeTarget } from "../gateway/inference/system-judge-target";
import {
	egressGuardrailsToPolicyBundle,
	findSuppressedJudgedDomains,
} from "../gateway/permissions/policy-store";
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
import { getOrgDefaultModel } from "./stores/provider-secrets";

const GUARDRAIL_STAGES = new Set(["input", "output", "pre-tool", "egress"]);

/**
 * Validate a `guardrailsInline` payload before it is persisted to agent
 * settings. Returns a human-readable error string on the first invalid entry,
 * or `null` when the payload is absent or fully valid. Persisting an entry with
 * an invalid `stage` would crash the guardrail aggregator at message time, so
 * we reject malformed input at the write boundary instead.
 */
export function validateGuardrailsInline(value: unknown): string | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return "guardrailsInline must be an array";
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (typeof entry !== "object" || entry === null) {
			return `guardrailsInline[${i}] must be an object`;
		}
		const g = entry as Record<string, unknown>;
		if (typeof g.name !== "string" || g.name.trim() === "") {
			return `guardrailsInline[${i}].name must be a non-empty string`;
		}
		if (typeof g.enabled !== "boolean") {
			return `guardrailsInline[${i}].enabled must be a boolean`;
		}
		if (typeof g.stage !== "string" || !GUARDRAIL_STAGES.has(g.stage)) {
			return `guardrailsInline[${i}].stage must be one of: input, output, pre-tool, egress`;
		}
		// Only `undefined` defaults to "judge" (backward compatible with rows
		// written before `kind` existed). `null` is not a valid value in the
		// Core `AgentInlineGuardrailSchema`, so reject it rather than coercing.
		if (
			g.kind !== undefined &&
			g.kind !== "judge" &&
			g.kind !== "require-tool"
		) {
			return `guardrailsInline[${i}].kind must be "judge" or "require-tool"`;
		}
		const kind = g.kind === undefined ? "judge" : g.kind;
		// Common optional fields are typed the same way for every kind in the
		// Core schema, so validate them whenever present regardless of kind.
		// Otherwise a malformed `require-tool` row (e.g. `model: 42`) would be
		// persisted here yet rejected by `AgentInlineGuardrailSchema`.
		if (g.model !== undefined && typeof g.model !== "string") {
			return `guardrailsInline[${i}].model must be a string`;
		}
		if (
			g.domains !== undefined &&
			(!Array.isArray(g.domains) ||
				g.domains.some((d) => typeof d !== "string"))
		) {
			return `guardrailsInline[${i}].domains must be an array of strings`;
		}
		if (kind === "require-tool") {
			if (g.stage !== "output") {
				return `guardrailsInline[${i}]: require-tool only supports stage "output"`;
			}
			if (
				!Array.isArray(g.tools) ||
				g.tools.length === 0 ||
				g.tools.some((t) => typeof t !== "string" || t.trim() === "")
			) {
				return `guardrailsInline[${i}].tools must be a non-empty array of tool names for require-tool`;
			}
			// `policy` is ignored for require-tool, but must still match the
			// schema's type when the operator supplies it.
			if (g.policy !== undefined && typeof g.policy !== "string") {
				return `guardrailsInline[${i}].policy must be a string`;
			}
		} else {
			// judge (default)
			if (typeof g.policy !== "string" || g.policy.trim() === "") {
				return `guardrailsInline[${i}].policy must be a non-empty string`;
			}
			if (
				g.tools !== undefined &&
				(!Array.isArray(g.tools) || g.tools.some((t) => typeof t !== "string"))
			) {
				return `guardrailsInline[${i}].tools must be an array of strings`;
			}
		}
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
 * Write-boundary validation for `skillsConfig`, the sibling of
 * {@link validateGuardrailsInline}.
 *
 * The settings patch is spread through untouched, so without this a
 * malformed payload persists and is then read back as a trusted `SkillConfig`.
 * Two concrete failures: a non-array `skills` throws at the first `.filter()`
 * downstream, and a non-boolean `enabled` diverges from the runtime, which
 * gates on truthiness (`s.enabled && …`) — so `"yes"` would enable a skill that
 * no write-time check ever saw as enabled.
 *
 * Checked against `SkillsConfigSchema` in core rather than a hand-rolled shape,
 * so the write boundary cannot drift from the type the readers rely on. The
 * schema is the only definition of a skill entry; it no longer carries
 * guardrails (those are operator-owned and live on `guardrailsInline`), so this
 * validates the current contract without reintroducing skill-declared ones.
 *
 * `Type.Object` admits unknown keys by design: rows written before a field was
 * dropped still round-trip through the editor's `_original` spread, and
 * rejecting them would fail a payload the server simply ignores.
 */
export function validateSkillsConfig(value: unknown): string | null {
	if (value === undefined) return null;
	if (Value.Check(SkillsConfigSchema, value)) return null;
	const first = Value.Errors(SkillsConfigSchema, value).First();
	if (!first) return "skillsConfig is invalid";
	return `skillsConfig${first.path}: ${first.message}`;
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
 * is skipped here, as are `guardrailsInline` and `skillsConfig`: each has a
 * stricter validator of its own with its own error code.
 */
const OWN_VALIDATED_SETTINGS_KEYS = new Set([
	"models",
	"guardrailsInline",
	"skillsConfig",
]);

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
 * Validate a settings patch against the agent's current settings. The caller
 * holds the agent row lock, so `storedSettings` is the snapshot the patch will
 * merge into. Returns `null` when the patch may be persisted, otherwise the
 * error envelope; a `models` error also carries the structured `modelError` so
 * the HTTP route can enrich it with request-derived URLs.
 */
export async function validateAgentSettingsUpdate(
	updates: unknown,
	storedSettings: AgentSettings | null,
	organizationId: string,
	agentId: string
): Promise<
	| AgentSettingsValidationError
	| (AgentSettingsValidationError & { modelError: ModelValidationError })
	| null
> {
	// Type-check every known settings field before anything is persisted, so a
	// wrongly-typed value is refused atomically instead of reported as success.
	const settingsPatchError = validateSettingsPatch(updates);
	if (settingsPatchError) {
		return {
			error: "invalid_settings",
			error_description: settingsPatchError,
		};
	}

	// Validate inline guardrail shape before it is persisted. An invalid `stage`
	// (or missing name/policy) would otherwise be written verbatim and then crash
	// the guardrail aggregator mid-message (it indexes `seen[stage]`).
	const guardrailError = validateGuardrailsInline(
		(updates as { guardrailsInline?: unknown }).guardrailsInline
	);
	if (guardrailError) {
		return { error: "invalid_guardrail", error_description: guardrailError };
	}

	const networkConfigError = validateNetworkConfig(updates);
	if (networkConfigError) {
		return {
			error: "invalid_network_config",
			error_description: networkConfigError,
		};
	}

	// Structural check on skillsConfig — the store persists the patch verbatim,
	// and the runtime reads it back as a trusted SkillConfig.
	const skillsConfigError = validateSkillsConfig(
		(updates as { skillsConfig?: unknown }).skillsConfig
	);
	if (skillsConfigError) {
		return { error: "invalid_skills_config", error_description: skillsConfigError };
	}

	const patch = updates as Partial<AgentSettings>;

	// Judge-kind custom guardrails need a model. With no org default provider
	// model, every judge entry must carry its own `model` — otherwise it would
	// fail closed at runtime with no model to call. require-tool entries never
	// call a model.
	const judgeDefault = (
		await getOrgDefaultModel(organizationId).catch(
			() => null
		)
	)?.trim();
	const inline = patch.guardrailsInline;
	if (Array.isArray(inline)) {
		if (!judgeDefault) {
			const missing = inline.find((g) => {
				if (g?.kind === "require-tool") return false;
				return typeof g?.model !== "string" || g.model.trim() === "";
			});
			if (missing) {
				return {
					error: "guardrail_model_required",
					error_description: `Custom guardrail "${missing.name ?? "(unnamed)"}" needs a model: this organization has no default provider model.`,
				};
			}
		}

		// A judge model that cannot resolve is worse than a missing one: the
		// guardrail SAVES, then denies every request it covers at runtime with
		// only a log line to say why. Resolve it here, through the exact
		// function the judge uses, so write-time acceptance and runtime
		// resolution cannot drift. Applies whether or not a default exists —
		// an explicitly named bad model is bad either way.
		//
		// Only NEW or CHANGED models are checked. Rejecting an already-stored
		// value would lock the agent out of its own config: every PATCH carries
		// the full `guardrailsInline` array, so an agent holding a
		// now-unrunnable model could not be edited at all — not even to remove
		// the offending guardrail. Grandfathering the stored value keeps the
		// repair path open while still refusing to accept a new bad one.
		const storedModels = new Map<string, string>();
		const storedInline = storedSettings?.guardrailsInline;
		if (Array.isArray(storedInline)) {
			for (const g of storedInline) {
				// require-tool entries never ran a judge, so they grandfather nothing:
				// converting one into a model-less judge is a NEW judge to validate.
				if (g?.kind === "require-tool") continue;
				if (g?.name) storedModels.set(g.name, (g.model ?? "").trim());
			}
		}

		for (const g of inline) {
			if (g?.kind === "require-tool") continue;
			const ownModel = g?.model?.trim();
			// A model-less guardrail runs on the org default, so that default must
			// be runnable by the judge too (a deployment system key, OpenAI-compatible
			// protocol). Otherwise it would save and then deny every covered request.
			const model = ownModel || judgeDefault;
			if (!model) continue;
			if (g?.name && storedModels.get(g.name) === (ownModel ?? "")) continue;
			const resolved = await resolveSystemJudgeTarget(model);
			if (!resolved.ok) {
				return {
					error: "guardrail_model_unresolvable",
					error_description: `Custom guardrail "${g?.name ?? "(unnamed)"}" ${ownModel ? `names judge model "${model}"` : `has no model, so it uses this organization's default model "${model}"`}, which this deployment cannot run: ${resolved.detail}. Use a "<provider>/<model>" ref whose provider has a system key and speaks the OpenAI-compatible protocol.`,
				};
			}
		}
	}

	// An allow grant BEATS the egress judge. `checkDomainAccess` (proxy/
	// http-proxy.ts) checks per-agent allow grants (step 4) before consulting
	// the judge (step 5), so a domain that is both judged and allow-granted
	// returns `source: "grant"` and its judge never runs. That failure is
	// invisible from the outside — the request succeeds, just for the wrong
	// reason — so refuse the config instead of saving a control that cannot fire.
	//
	// Validate the MERGE, not the patch: a PATCH may carry `guardrailsInline`
	// alone, `networkConfig` alone, or both, and the hole only exists in the
	// combination. Only run when the patch actually touches one of them, so an
	// unrelated edit to an agent that is already in this state still saves (and
	// so removing either side is always a valid repair).
	const touchesGuardrails = "guardrailsInline" in (updates as object);
	const touchesNetwork = "networkConfig" in (updates as object);
	if (touchesGuardrails || touchesNetwork) {
		const effectiveGuardrails = touchesGuardrails
			? (patch.guardrailsInline ?? [])
			: (storedSettings?.guardrailsInline ?? []);
		const effectiveAllowed = touchesNetwork
			? (patch.networkConfig?.allowedDomains ?? [])
			: (storedSettings?.networkConfig?.allowedDomains ?? []);

		const shadowed = findSuppressedJudgedDomains(
			effectiveGuardrails,
			effectiveAllowed
		);
		if (shadowed[0]) {
			const { domain, judge, grant } = shadowed[0];
			return {
				error: "guardrail_domain_shadowed_by_grant",
				error_description: `Guardrail "${judge}" judges "${domain}", but this agent's networkConfig.allowedDomains grants "${grant}", which the proxy matches FIRST — the judge would never run. A judged domain must not be allow-listed: remove "${grant}" from allowedDomains (a judged domain is reachable through its judge, so it needs no grant), or drop "${domain}" from the guardrail.`,
			};
		}

		// The GLOBAL allowlist shadows judges the same way (`checkDomainAccess`
		// step 3), but it is `WORKER_ALLOWED_DOMAINS` — operator config the
		// tenant editing this agent cannot fix. Warn rather than reject, so
		// the signal reaches whoever can act on it without blocking a save
		// nobody in this request can make valid. Only consult the allowlist
		// when there is a judge to shadow: `loadAllowedDomains` logs on every
		// call in isolation mode.
		const judgedCount =
			egressGuardrailsToPolicyBundle(effectiveGuardrails)?.judgedDomains
				.length ?? 0;
		if (judgedCount > 0) {
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
	args: Pick<AgentCreateInput, "agent_id" | "name" | "description" | "identity_md">,
	owner: AgentMetadata["owner"],
	models: AgentSettings["models"] | null | undefined,
	audit: AgentConfigAudit
): Promise<boolean> {
	const seedModels = models === undefined
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
	await insertConfigChangeEventInTransaction({
		...audit, resourceKind: "agent", resourceId: args.agent_id, op: "created",
		summary: `Agent '${args.name}' created`, before: null,
		state: { agentId: args.agent_id, name: args.name, description: args.description ?? null },
	}, tx);
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
	await insertConfigChangeEventInTransaction({
		...audit, resourceKind: "agent", resourceId: agentId, op: "updated",
		summary: `Agent '${after?.name ?? agentId}' metadata updated`,
		before: before ? { ...before } : null, state: after ? { ...after } : null,
		changedFields: Object.keys(updates),
	}, tx);
}

/** Caller holds the org and agent row locks; FK cascades own dependent cleanup. */
export async function deleteAgentConfig(
	tx: DbClient, agentId: string, audit: AgentConfigAudit
): Promise<boolean> {
	const store = createPostgresAgentConfigStore(tx);
	const before = await store.getMetadata(agentId);
	if (!before) return false;
	await store.deleteMetadata(agentId);
	await insertConfigChangeEventInTransaction({
		...audit, resourceKind: "agent", resourceId: agentId, op: "deleted",
		summary: `Agent '${agentId}' deleted`, before: { ...before }, state: null,
	}, tx);
	return true;
}
