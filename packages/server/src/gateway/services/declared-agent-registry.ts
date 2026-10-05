import type { AgentSettings, DeclaredCredential } from "@lobu/core";
import { createLogger } from "@lobu/core";
import type { AgentSettingsStored } from "@lobu/core/contracts/agent-settings";
import { UNRESOLVED_MODEL_SUFFIX } from "../auth/model-sentinel.js";
import { buildProviderCatalog } from "../auth/provider-catalog.js";
import type { AgentConfig } from "../config/index.js";

/**
 * Compile-time exhaustiveness guard, the same `-?` projection the CLI's
 * `AgentSettingsProjection` uses (packages/cli/src/commands/_lib/apply/map-config.ts).
 * Adding a field to AgentSettingsStoredSchema that this converter doesn't
 * handle is a compile error, not a silent drop. `authProfiles` excluded
 * (separate-store), `updatedAt` excluded (store-owned).
 */
type AgentSettingsProjection = {
	[K in Exclude<keyof AgentSettingsStored, "updatedAt" | "authProfiles">]-?:
		| AgentSettingsStored[K]
		| undefined;
};

const logger = createLogger("declared-agent-registry");

interface DeclaredAgentEntry {
  settings: Partial<AgentSettings>;
  credentials: DeclaredCredential[];
}

/**
 * In-memory registry of agents declared by `GatewayConfig.agents` when the
 * gateway is embedded as a library (SDK-mode).
 *
 * `lobu.config.ts` is no longer read at gateway boot — file-declared agents
 * enter Postgres via `lobu apply` and are read through `AgentConfigStore`.
 *
 * Declared agents own their settings and credentials at runtime — there is
 * no second copy to drift.
 */
export class DeclaredAgentRegistry {
  private readonly entries = new Map<string, DeclaredAgentEntry>();

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  get(agentId: string): DeclaredAgentEntry | undefined {
    return this.entries.get(agentId);
  }

  agentIds(): string[] {
    return Array.from(this.entries.keys());
  }

  entriesList(): Array<[string, DeclaredAgentEntry]> {
    return Array.from(this.entries.entries());
  }

  /** Replace the entire registry. Used at startup and on hot-reload. */
  replaceAll(next: Map<string, DeclaredAgentEntry>): void {
    this.entries.clear();
    for (const [agentId, entry] of next) {
      this.entries.set(agentId, entry);
    }
    logger.debug(`Registry now holds ${this.entries.size} declared agent(s)`);
  }
}

/**
 * Build a registry entry from an embedded SDK `AgentConfig`. The settings
 * shape mirrors `buildSettingsFromAgentConfig` in `core-services`.
 */
export function entryFromAgentConfig(agent: AgentConfig): DeclaredAgentEntry {
  const settings: Partial<AgentSettings> = {};
  if (agent.identityMd) settings.identityMd = agent.identityMd;
  if (agent.soulMd) settings.soulMd = agent.soulMd;
  if (agent.userMd) settings.userMd = agent.userMd;

  if (agent.providers?.length) {
    // Each declared provider becomes one explicit `<providerId>/<model>` ref in
    // the ordered `models` list (index 0 = the primary/default). A provider
    // that declares no model resolves to its catalog defaultModel; if none
    // exists it becomes a `<providerId>/__unresolved__` restriction sentinel —
    // NEVER dropped to nothing. Dropping it would leave an agent that DECLARED
    // providers with `models` undefined = allow-all, silently widening the
    // intended restriction. The sentinel keeps the exact gate CLOSED (it never
    // routes) until a real model is picked. Refs are always concrete or
    // sentinel, never "<providerId>/auto".
    const catalogDefaults = new Map(
      buildProviderCatalog().map((entry) => [entry.slug, entry.defaultModel])
    );
    const models: string[] = [];
    for (const provider of agent.providers) {
      const declared = provider.model?.trim();
      const model = declared || catalogDefaults.get(provider.id) || "";
      if (!model) {
        logger.warn(
          `Declared provider "${provider.id}" on agent "${agent.id}" has no model and no catalog default — kept as a restriction sentinel (agent stays gated, not allow-all)`
        );
        models.push(`${provider.id}/${UNRESOLVED_MODEL_SUFFIX}`);
        continue;
      }
      models.push(
        model.startsWith(`${provider.id}/`) ? model : `${provider.id}/${model}`
      );
    }
    // providers were declared ⇒ ALWAYS a non-empty models list (restricted),
    // never undefined/allow-all.
    settings.models = models;
  }

  if (agent.network) {
    settings.networkConfig = {
      allowedDomains: agent.network.allowed,
      deniedDomains: agent.network.denied,
    };
  }

  if (agent.nixPackages?.length) {
    settings.nixConfig = { packages: agent.nixPackages };
  }

  const credentials: DeclaredCredential[] = (agent.providers || [])
    .filter((p) => p.key || p.secretRef)
    .map((p) => ({
      provider: p.id,
      ...(p.key ? { key: p.key } : {}),
      ...(p.secretRef ? { secretRef: p.secretRef } : {}),
    }));

  // Exhaustiveness guard: see the comment on AgentSettingsProjection above.
  // Every stored key is present; the projection object is discarded.
  const _exhaustive: AgentSettingsProjection = {
    models: settings.models,
    networkConfig: settings.networkConfig,
    nixConfig: settings.nixConfig,
    soulMd: settings.soulMd,
    userMd: settings.userMd,
    identityMd: settings.identityMd,
    skillsConfig: settings.skillsConfig,
    guardrails: settings.guardrails,
    guardrailsInline: settings.guardrailsInline,
    sandboxId: settings.sandboxId,
    verboseLogging: settings.verboseLogging,
    showToolCalls: settings.showToolCalls,
  };
  void _exhaustive;

  return { settings, credentials };
}

/**
 * Build a fresh registry map from a list of SDK config agents. Used by
 * `core-services` on startup.
 */
export function buildRegistryMap(
  configAgents: AgentConfig[]
): Map<string, DeclaredAgentEntry> {
  const result = new Map<string, DeclaredAgentEntry>();
  for (const agent of configAgents) {
    result.set(agent.id, entryFromAgentConfig(agent));
  }
  return result;
}
