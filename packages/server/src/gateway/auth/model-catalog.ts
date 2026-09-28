import { createLogger } from "@lobu/core";
import snapshot from "../../generated/models-dev.json";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ModelProviderModule, ProviderModelMetadata } from "../modules/module-system.js";

interface CatalogModel {
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number | null;
  toolCall: boolean;
  reasoning: boolean | undefined;
}

const models = snapshot.models as Record<string, Record<string, CatalogModel>>;
const logger = createLogger("model-catalog");

/** The one models.dev provider key for a module, shared by picker and turn. */
export function catalogProviderOf(module: Pick<ModelProviderModule, "catalogProvider" | "providerId">): string {
  return module.catalogProvider ?? module.providerId;
}

export function getCatalogModel(provider: string, modelId: string): CatalogModel | undefined {
  return models[provider]?.[modelId];
}

export function getCatalogModels(provider: string): string[] {
  return Object.entries(models[provider] ?? {})
    .filter(([, model]) => model.toolCall)
    .map(([id]) => id)
    .sort();
}

/** The turn and picker use the same provider identity and release snapshot. */
export async function resolveModelMetadata(
  module: ModelProviderModule,
  modelId: string,
  agentId: string,
  context: ProviderCredentialContext
): Promise<Omit<CatalogModel, "toolCall">> {
  let model: ProviderModelMetadata | CatalogModel | undefined = getCatalogModel(catalogProviderOf(module), modelId);
  if (!model) {
    try {
      model = await module.getModelMetadata?.(agentId, modelId, context);
    } catch {
      logger.warn({ provider: module.providerId, modelId }, "Provider model metadata unavailable");
    }
  }
  // Retain dynamic-provider support when catalog facts are absent. Removing
  // these operational defaults needs an explicit private-model metadata contract.
  const window = model?.contextWindow;
  const input = model?.input;
  return {
    contextWindow: typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : 128_000,
    input: input?.length && input.every(value => value === "text" || value === "image") ? [...input] : ["text", "image"],
    maxTokens: typeof model?.maxTokens === "number" && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : null,
    reasoning: typeof model?.reasoning === "boolean" ? model.reasoning : undefined,
  };
}
