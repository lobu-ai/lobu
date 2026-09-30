/**
 * Resolve the system-key model providers available to this deployment into an
 * ordered `models` list for freshly created agents. Each entry is an explicit
 * `<slug>/<model>` ref, OR a `<slug>/__unresolved__` restriction sentinel when
 * the provider is installed but no concrete model resolves. Index 0 is the
 * default when one resolves (a pinned default model from the catalog or a live
 * provider option); when nothing resolves, every entry is a sentinel.
 *
 * Reads `config/providers.json` directly so resolution is deterministic
 * regardless of whether the gateway module registry is initialized.
 */

import type { ProviderConfigEntry } from "@lobu/core";
import { getErrorMessage } from "@lobu/core";
import { resolveEnv } from "../gateway/auth/mcp/string-substitution";
import { collectProviderModelOptions } from "../gateway/auth/provider-model-options";
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

const MODEL_PROVIDER_PREFERENCE = [
	"openai",
	"gemini",
	"groq",
	"mistral",
	"deepseek",
	"cohere",
	"xai",
];

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

	// Live model options per provider (from the module registry) — the ONLY
	// source of a concrete default for providers whose defaultModel isn't in
	// providers.json (e.g. Bedrock declares it on the module). Fetched ONCE and
	// reused so EVERY system-key provider can resolve a concrete model, not just
	// the one that becomes the default. Best-effort: unavailable ⇒ empty map.
	let liveOptions: Record<string, Array<{ value: string }>> = {};
	if (installed.size > 0) {
		try {
			liveOptions = await collectProviderModelOptions("", "");
		} catch {
			// Registry/model fetch unavailable — fall back to providers.json only.
		}
	}

	// Prefix a bare model id with its slug, unless it is ALREADY `<slug>/…`
	// qualified. Provider-native ids can contain slashes (nvidia
	// `nvidia/moonshotai/kimi-k2.6`, openrouter `anthropic/claude-sonnet-5`), so
	// a catalog default or live option that already carries its slug must NOT be
	// double-prefixed to `<slug>/<slug>/…`.
	const qualify = (providerId: string, model: string): string =>
		model.startsWith(`${providerId}/`) ? model : `${providerId}/${model}`;

	// Concrete model ref per slug: the catalog defaultModel first, else the
	// provider's first live model option. No `auto` refs — a provider with no
	// resolvable concrete model returns null (caller decides sentinel vs skip).
	const concreteRef = (providerId: string): string | null => {
		const dm = configs[providerId]?.defaultModel?.trim();
		if (dm) return qualify(providerId, dm);
		const first = liveOptions[providerId]?.[0]?.value?.trim();
		if (!first) return null;
		return qualify(providerId, first);
	};

	const pickDefault = (providerId: string): string | null =>
		installed.has(providerId) ? concreteRef(providerId) : null;

	// Prefer Claude over the remaining config-declared providers, but use
	// the catalog's defaultModel for every provider. Keeping a second model ID in
	// code made auto-provisioned agents lag the picker after catalog updates.
	let defaultRef: string | null = hasClaudeSystemKey()
		? pickDefault(CLAUDE_PROVIDER_ID)
		: null;
	for (const providerId of MODEL_PROVIDER_PREFERENCE) {
		if (defaultRef) break;
		defaultRef = pickDefault(providerId);
	}
	if (!defaultRef) {
		for (const providerId of Object.keys(configs)) {
			defaultRef = pickDefault(providerId);
			if (defaultRef) break;
		}
	}
	if (!defaultRef) {
		// Still nothing from config-declared providers — take the first installed
		// provider that resolves a concrete (live) model as the default.
		for (const providerId of installed) {
			defaultRef = concreteRef(providerId);
			if (defaultRef) break;
		}
	}

	// Default first, then EVERY other system-key provider. A provider that
	// resolves to a concrete model (via catalog default OR live options) is added
	// as that ref; a provider that resolves to NOTHING is added as a
	// `<slug>/__unresolved__` restriction SENTINEL — never dropped. Dropping it
	// would let "system providers exist but none resolved" collapse to an empty
	// `models` list, which the provisioning callers persist as `[]` = allow-all,
	// silently widening the restriction. The sentinel keeps the agent gated
	// (non-empty, never routes) until a concrete model resolves.
	const models: string[] = defaultRef ? [defaultRef] : [];
	const defaultSlug = defaultRef ? defaultRef.split("/", 1)[0] : null;
	const sentinelled: string[] = [];
	for (const providerId of installed) {
		if (providerId === defaultSlug) continue;
		const ref = concreteRef(providerId);
		if (ref) {
			models.push(ref);
		} else {
			models.push(`${providerId}/${UNRESOLVED_MODEL_SUFFIX}`);
			sentinelled.push(providerId);
		}
	}
	// If NO provider resolved a concrete default (defaultRef null) but system
	// providers exist, the list is all sentinels — restricted, not allow-all.
	if (!defaultRef) {
		for (const providerId of installed) {
			if (!models.some((m) => m.startsWith(`${providerId}/`))) {
				models.push(`${providerId}/${UNRESOLVED_MODEL_SUFFIX}`);
				sentinelled.push(providerId);
			}
		}
	}
	if (sentinelled.length > 0) {
		logger.info(
			{ sentinelled },
			"[system-provider-resolution] System-key providers with no concrete model kept as restriction sentinels (agent stays gated, not allow-all)",
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
