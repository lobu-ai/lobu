import {
	createLogger,
	getErrorMessage,
	type ModelOption,
} from "@lobu/core";
import { getModelProviderModules } from "../modules/module-system.js";
import { catalogProviderOf, getCatalogModels } from "./model-catalog.js";

const logger = createLogger("provider-model-options");

export async function collectProviderModelOptions(
  agentId: string,
  userId: string
): Promise<Record<string, ModelOption[]>> {
  const modules = getModelProviderModules();

  const results: Record<string, ModelOption[]> = {};

  await Promise.all(
    modules.map(async (mod) => {
      const catalogProvider = catalogProviderOf(mod);
      results[mod.providerId] = getCatalogModels(catalogProvider)
        .map(id => ({ value: `${mod.providerId}/${id}`, label: id }));
      try {
        const options = await mod.getModelOptions?.(agentId, userId);
        if (options?.length) results[mod.providerId] = options;
      } catch (error) {
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
