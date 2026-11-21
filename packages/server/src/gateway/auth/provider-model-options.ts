import {
	createLogger,
	getErrorMessage,
	type ModelOption,
} from "@lobu/core";
import { resolveInferenceProviderCredential } from "../../lobu/stores/provider-secrets.js";
import { ApiKeyProviderModule, sameProviderDiscoveryUpstream } from "./api-key-provider-module.js";
import { getModelProviderModules } from "../modules/module-system.js";

const logger = createLogger("provider-model-options");

export async function collectProviderModelOptions(
  agentId: string,
  userId: string,
  selection: { automaticDefaultOnly?: boolean } = {}
): Promise<Record<string, ModelOption[]>> {
  const modules = getModelProviderModules();

  const results: Record<string, ModelOption[]> = {};

  await Promise.all(
    modules.map(async (mod) => {
      try {
        if (typeof mod.getModelOptions !== "function" ||
            (selection.automaticDefaultOnly && mod instanceof ApiKeyProviderModule &&
              !mod.supportsAutomaticDiscoveryDefault)) {
          results[mod.providerId] = [];
          return;
        }

        const options = await mod.getModelOptions(agentId, userId);
        results[mod.providerId] = Array.isArray(options) ? options : [];
      } catch (error) {
        results[mod.providerId] = [];
        logger.warn(
          {
            providerId: mod.providerId,
            error: getErrorMessage(error),
          },
          "Failed to collect model options for provider"
        );
      }
    })
  );

  return results;
}


/** Workspace discoveries use a credential and destination from the same scope. */
export async function discoverInferenceProviderModels(organizationId: string, slug: string) {
  const signal = AbortSignal.timeout(5000);
  const row = await resolveInferenceProviderCredential(organizationId, slug, "text");
  const module = getModelProviderModules().find(
    (candidate) => candidate.providerId === (row?.kind ?? slug) && candidate.catalogVisible !== false,
  );
  if (!row && !module) return { error: "Provider not found", status: 404 as const };
  if (!(module instanceof ApiKeyProviderModule) || !module.supportsModelDiscovery) {
    return { error: "This provider does not support model discovery", status: 409 as const };
  }

  const upstream = module.getUpstreamConfig()?.upstreamBaseUrl;
  // This endpoint only contacts server-configured destinations, and accepts
  // explicit copies of the catalog URL from previously saved provider forms.
  // A tenant URL or endpoint override needs its own safe egress path.
  if (!upstream || row?.modelsEndpoint ||
      (row?.baseUrl && !sameProviderDiscoveryUpstream(row.baseUrl, upstream))) {
    return { error: "Live model discovery is unavailable for this upstream", status: 409 as const };
  }

  const key = row ? row.apiKey : module.getSystemDiscoveryKey();
  if (!key) return { error: "Connect a provider credential to discover models", status: 409 as const };
  const options = await module.discoverModels(key, true, signal);
  const prefix = `${module.providerId}/`;
  const models = new Map<string, { id: string; label: string }>();
  for (const option of options ?? []) {
    const id = option.value.slice(prefix.length);
    if (id && !models.has(id)) models.set(id, { id, label: option.label });
    if (models.size >= 1000) break;
  }
  return { models: [...models.values()] };
}
