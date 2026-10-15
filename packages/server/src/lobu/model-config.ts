/**
 * Shared, context-free agent model-config validation.
 *
 * The web route (`PATCH /:agentId/config`) and the MCP `manage_agents` tool both
 * need to validate an agent's `models` allow-list against the org's providers
 * before persisting it. The route wrapper (`validateModelsUpdate`) enriches the
 * error with request-derived proxy/settings URLs; the MCP path has no HTTP
 * request, so it calls this core directly. Keeping ONE validator means an agent
 * created via MCP is gated by the same rules as one edited in the web UI —
 * closing the #2047 gap where `manage_agents` had no model-config path at all.
 */

import type { AgentModelInfo } from "@lobu/core/contracts/tools/manage-agents";
import { isUnresolvedModelRef } from "../gateway/auth/model-sentinel";
import { resolveModelProvider } from "../gateway/auth/model-runnability";
import type { ProviderCatalogService } from "../gateway/auth/provider-catalog";
import { resolveEffectiveModelRef } from "../gateway/auth/settings/model-selection";
import { getModelProviderModules } from "../gateway/modules/module-system";
import { orgContext } from "./stores/org-context";
import { createPostgresAgentConfigStore } from "./stores/postgres-stores";
import {
  getOrgDefaultModel,
  listInferenceProviders,
} from "./stores/provider-secrets";

// One config store instance for this module — the SAME postgres-backed store
// the web config route and the settings-store wrapper delegate to. Reads/writes
// are org-scoped by running them inside `orgContext.run(...)` (the store reads
// the org from that async context), which is exactly how the settings store's
// own `getSettings` scopes its reads. Used directly rather than via
// `getLobuCoreServices()` so settings access also works without a booted
// gateway. Provider preflight separately depends on the supplied catalog.
const agentConfigStore = createPostgresAgentConfigStore();

/**
 * A structured validation failure. `kind` lets callers map to the right
 * error code / HTTP status and (for the route) attach friendly URLs. `null`
 * from the validator means the list is valid.
 */
export type ModelValidationError =
  | { kind: "invalid_models"; message: string }
  | { kind: "invalid_model_ref"; message: string; model: string }
  | {
      kind: "model_provider_not_connected";
      message: string;
      model: string;
      provider: string;
    };

/**
 * Every provider slug a `<slug>/<model>` ref may name at the ORG level:
 * registry provider modules (system keys — `openai`, `claude`, `deepseek`, …
 * from `config/providers.json`) UNION the org's own `inference_providers` rows.
 *
 * Exported because this union IS the definition of "a provider this org can
 * route to", and more than one write path has to answer that question — the
 * agent `models` allow-list here, and `execution_config.model` on a
 * server-dispatched Automation. Resolving against `inference_providers` alone
 * silently rejects every system-key provider, which is a valid config for an
 * org that never registered a row of its own.
 */
export async function listOrgModelProviderSlugs(
  organizationId: string,
): Promise<Set<string>> {
  const slugs = new Set<string>(
    getModelProviderModules().map((m) => m.providerId),
  );
  for (const row of await listInferenceProviders(organizationId)) {
    slugs.add(row.slug);
  }
  return slugs;
}

/**
 * Validate an agent `models` allow-list against the org's providers. Pure of any
 * HTTP context: every entry must be an explicit `<slug>/<model>` ref (no bare
 * ids, no `auto`) whose slug resolves at the ORG level (a registry provider
 * module OR a row in `inference_providers`). `__unresolved__` restriction
 * sentinels round-trip untouched (they are deliberate non-routable placeholders).
 *
 * Returns the first error, or `null` when the whole list is valid.
 */
export async function validateModelRefsAgainstOrg(
  models: unknown,
  organizationId: string,
): Promise<ModelValidationError | null> {
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) {
    return {
      kind: "invalid_models",
      message: "models must be an array of strings",
    };
  }

  const entries = (models as string[]).map((m) => m.trim());
  const invalid = (ref: string, why: string): ModelValidationError => ({
    kind: "invalid_model_ref",
    message: `Invalid models entry "${ref}": ${why}. Every entry must be an explicit "<provider>/<model>" ref.`,
    model: ref,
  });
  for (const ref of entries) {
    if (isUnresolvedModelRef(ref)) continue;
    const slash = ref.indexOf("/");
    if (!ref || slash <= 0 || slash === ref.length - 1) {
      return invalid(ref, "expected a provider-qualified model ref");
    }
    if (ref.slice(slash + 1).trim() === "auto") {
      return invalid(ref, '"auto" is not a model; pick a concrete model');
    }
  }

  const orgSlugs = await listOrgModelProviderSlugs(organizationId);
  for (const ref of entries) {
    if (isUnresolvedModelRef(ref)) continue;
    const providerId = ref.slice(0, ref.indexOf("/"));
    if (orgSlugs.has(providerId)) continue;
    return {
      kind: "model_provider_not_connected",
      message:
        `The model "${ref}" uses provider "${providerId}", but that provider does not exist in this organization. ` +
        `Add it under Providers (or fix the slug), then save again.`,
      model: ref,
      provider: providerId,
    };
  }

  return null;
}

/**
 * What the read side needs to ask the run path's routability question. Callers
 * take these from the booted gateway's core services.
 */
interface AgentModelRouting {
  agentId: string;
  catalog: ProviderCatalogService | undefined;
  publicGatewayUrl: string;
}

/**
 * Resolve an agent's effective model and where it comes from — the read side of
 * #2047's "is this agent actually runnable?" question. Composes the SAME layered
 * fallback the run path uses (`resolveEffectiveModelRef(agent.models) → org
 * default`); nothing new is stored, this only reports what a run would resolve.
 *
 * With a gateway catalog, `not_runnable` uses the cloud chat preflight
 * ({@link resolveModelProvider}) with the agent owner's credentials. A sender
 * may have additional credentials, and a device turn uses its local CLI's
 * authentication instead. `effective_model` remains the configured ref even
 * when preflight finds a runnable listed alternate.
 */
export async function resolveAgentModelInfo(
  agentModels: string[] | undefined,
  organizationId: string,
  routing: AgentModelRouting,
): Promise<AgentModelInfo> {
  const agentModel = resolveEffectiveModelRef({ models: agentModels });
  const orgDefault = agentModel ? null : await getOrgDefaultModel(organizationId);
  const effectiveModel = agentModel ?? orgDefault;
  if (!effectiveModel) {
    return { effective_model: null, source: "none", not_runnable: true };
  }
  const metadata = await orgContext.run({ organizationId }, () =>
    agentConfigStore.getMetadata(routing.agentId),
  );
  const resolution = await resolveModelProvider({
    catalog: routing.catalog,
    publicGatewayUrl: routing.publicGatewayUrl,
    agentId: routing.agentId,
    organizationId,
    userId: metadata?.owner.userId ?? "",
    modelRef: effectiveModel,
  });
  return {
    effective_model: effectiveModel,
    source: agentModel ? "agent" : "org_default",
    not_runnable: resolution.kind === "error",
  };
}

/**
 * Persist an agent's default model (`models[0]`) through the SAME config store
 * the web route writes — no parallel SQL, no second column. An empty/blank ref
 * clears the list (`models = NULL`), so the agent falls back to the org default.
 * Org-scoped via `orgContext.run`, matching the store's own read path.
 *
 * The caller is responsible for having validated `modelRef` with
 * {@link validateModelRefsAgainstOrg} first; this only writes.
 */
export async function persistDefaultModel(
  agentId: string,
  organizationId: string,
  modelRef: string,
): Promise<void> {
  const trimmed = modelRef.trim();
  await orgContext.run({ organizationId }, () =>
    agentConfigStore.updateSettings(agentId, {
      models: trimmed ? [trimmed] : undefined,
    }),
  );
}

/**
 * Read an agent's persisted `models` list, org-scoped. Wraps the config store's
 * `getSettings` in `orgContext.run` so it resolves the row for THIS org (agent
 * ids are unique, but scoping keeps cross-org reads honest).
 */
export async function readAgentModels(
  agentId: string,
  organizationId: string,
): Promise<string[] | undefined> {
  const settings = await orgContext.run({ organizationId }, () =>
    agentConfigStore.getSettings(agentId),
  );
  return settings?.models ?? undefined;
}
