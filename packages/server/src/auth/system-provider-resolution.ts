/**
 * Resolve the system-key model providers available to this deployment into an
 * ordered `models` list for freshly created agents. The deployment's
 * `AGENT_DEFAULT_MODEL` (`<slug>/<model>`) is index 0 when its provider is
 * installed; every other installed provider is a `<slug>/__unresolved__`
 * restriction sentinel. The repo ships no default model id, so a deployment
 * without `AGENT_DEFAULT_MODEL` yields only sentinels.
 *
 * Reads `config/providers.json` directly so resolution is deterministic
 * regardless of whether the gateway module registry is initialized.
 */

import type { ProviderConfigEntry } from "@lobu/core";
import { getErrorMessage } from "@lobu/core";
import { resolveEnv } from "../gateway/auth/mcp/string-substitution";
import { UNRESOLVED_MODEL_SUFFIX } from "../gateway/auth/model-sentinel";
import { getModelProviderModules } from "../gateway/modules/module-system";
import { getOrgDefaultModel } from "../lobu/stores/provider-secrets";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "../gateway/services/provider-registry-service";
import logger from "../utils/logger";

export interface ResolvedSystemProviders {
	/**
	 * Ordered `<slug>/<model>` refs (or `<slug>/__unresolved__` sentinels);
	 * index 0 = the default when one resolves.
	 */
	models: string[];
}

const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SYSTEM_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
];

function hasClaudeSystemKey(): boolean {
	return CLAUDE_SYSTEM_ENV_VARS.some((v) => !!resolveEnv(v));
}

export async function resolveSystemKeyProvidersAndModel(): Promise<ResolvedSystemProviders> {
	// Ordered set of provider slugs with a system-level credential.
	const installed = new Set<string>();

	let configs: Record<string, ProviderConfigEntry> = {};
	try {
		const registry = new ProviderRegistryService(resolveProviderRegistryPath());
		configs = await registry.getProviderConfigs();
	} catch (err) {
		logger.warn(
			{ err: getErrorMessage(err) },
			"[system-provider-resolution] providers.json read failed; relying on module registry",
		);
	}
	for (const [providerId, cfg] of Object.entries(configs)) {
		if (cfg.envVarName && resolveEnv(cfg.envVarName)) {
			installed.add(providerId);
		}
	}

	if (hasClaudeSystemKey()) {
		installed.add(CLAUDE_PROVIDER_ID);
	}

	try {
		for (const m of getModelProviderModules()) {
			if (m.hasSystemKey()) {
				installed.add(m.providerId);
			}
		}
	} catch {
		// Registry not available — the providers.json + Claude floor already applies.
	}

	// The deployment's default model, honoured only when its provider is
	// installed here; a ref to an absent provider could never route.
	const configured = resolveEnv("AGENT_DEFAULT_MODEL")?.trim() ?? "";
	const slash = configured.indexOf("/");
	const defaultSlug = slash > 0 ? configured.slice(0, slash) : null;
	const defaultRef =
		defaultSlug && slash < configured.length - 1 && installed.has(defaultSlug)
			? configured
			: null;

	// Default first, then EVERY other system-key provider as a
	// `<slug>/__unresolved__` restriction SENTINEL — never dropped. Dropping it
	// would let "system providers exist but none resolved" collapse to an empty
	// `models` list, which the provisioning callers persist as `[]` = allow-all,
	// silently widening the restriction. The sentinel keeps the agent gated
	// (non-empty, never routes) until a concrete model is chosen.
	const models: string[] = defaultRef ? [defaultRef] : [];
	const sentinelled: string[] = [];
	for (const providerId of installed) {
		if (defaultRef && providerId === defaultSlug) continue;
		models.push(`${providerId}/${UNRESOLVED_MODEL_SUFFIX}`);
		sentinelled.push(providerId);
	}
	if (sentinelled.length > 0) {
		logger.info(
			{ sentinelled },
			"[system-provider-resolution] System-key providers with no configured model kept as restriction sentinels (agent stays gated, not allow-all)",
		);
	}
	return { models };
}

/**
 * The provisioning defaults a brand-new agent row must carry to be runnable on
 * THIS deployment. Every create path — the web `POST /agents` route, the
 * `manage_agents` create tool, and the shared `saveMetadata` UPSERT — resolves
 * its defaults here.
 *
 * The run path resolves a model as `agent.models[0] → the org's
 * `inference_providers` is_default ROW → nothing`, so `models` is seeded
 * ORG-AWARELY, in that same order of authority:
 *
 *   - The org HAS a configured default ⇒ seed an EMPTY list. The agent inherits
 *     the org default at run time, which is the documented design. Baking a
 *     concrete ref here would be persisted at `models[0]` and permanently SHADOW
 *     the org default — an admin's later change to it would silently not reach
 *     agents created before the change.
 *   - The org has NO default ⇒ bake the system-key list. Environment API keys
 *     (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, a providers.json
 *     `envVarName`, a module registry `hasSystemKey()`) never create an
 *     `inference_providers` row, so without this the agent resolves NO model at
 *     all, never completes a turn, and its Automation fails with "Agent reply
 *     finished without calling completeWindow".
 *
 * An explicit `default_model` supplied by the caller outranks both and is
 * applied by the caller, not here.
 *
 * Keeping this in ONE place is the point: the divergence between paths that
 * baked a models list and paths that did not WAS the bug.
 */
export async function resolveNewAgentProvisioningDefaults(
	organizationId: string,
): Promise<{
	models: string[];
}> {
	// An org-level default already makes the agent runnable through the
	// documented fallback, so seed nothing and let it inherit.
	const orgDefault = await getOrgDefaultModel(organizationId);
	const resolved = orgDefault
		? { models: [] }
		: await resolveSystemKeyProvidersAndModel();
	return {
		models: resolved.models,
	};
}
