import {
	createLogger,
	getErrorMessage,
	type ModelOption,
} from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import { resolveInferenceProviderCredential } from "../../lobu/stores/provider-secrets.js";
import {
	getModelProviderModules,
	type ModelListingCredential,
	type ModelProviderModule,
	type ProviderModel,
	resolveSystemCredential,
} from "../modules/module-system.js";
import { ApiKeyProviderModule } from "./api-key-provider-module.js";
import { sameProviderDiscoveryUpstream } from "./base-provider-module.js";
import { filterModelsByModelsDev, loadModelsDevProvider } from "./models-dev.js";
import { orgBucketAgentId } from "./settings/user-auth-profile-store.js";

const logger = createLogger("provider-model-options");

const LISTING_TIMEOUT_MS = 5000;
const MAX_MODELS = 1000;

/**
 * The one listing path every surface shares: the provider's own live catalog,
 * filtered by models.dev, de-duplicated and bounded. Returns null when the
 * module needs a credential and none was supplied.
 */
async function listProviderModels(
	module: ModelProviderModule,
	credential: ModelListingCredential | null,
	signal: AbortSignal,
): Promise<ProviderModel[] | null> {
	if (!module.listModels) return [];
	const [listed, modelsDev] = await Promise.all([
		module.listModels(credential, signal),
		loadModelsDevProvider(module.modelsDevId),
	]);
	if (!listed) return null;
	const models = new Map<string, ProviderModel>();
	for (const model of filterModelsByModelsDev(listed, modelsDev)) {
		if (model.id && !models.has(model.id)) models.set(model.id, model);
		if (models.size >= MAX_MODELS) break;
	}
	return [...models.values()];
}

/** Every installed provider's live models, as `<providerId>/<model id>` options. */
export async function collectProviderModelOptions(
	agentId: string,
	userId: string,
): Promise<Record<string, ModelOption[]>> {
	const results: Record<string, ModelOption[]> = {};

	await Promise.all(
		getModelProviderModules().map(async (mod) => {
			results[mod.providerId] = [];
			if (!mod.listModels) return;
			try {
				const credential =
					(await mod.resolveModelListingCredential?.(
						agentId,
						{ userId },
						{ includeSystemEnv: true },
					)) ?? null;
				const models = await listProviderModels(
					mod,
					credential,
					AbortSignal.timeout(LISTING_TIMEOUT_MS),
				);
				results[mod.providerId] = (models ?? []).map((model) => ({
					value: `${mod.providerId}/${model.id}`,
					label: model.label,
				}));
			} catch (error) {
				logger.warn(
					{
						providerId: mod.providerId,
						error: getErrorMessage(error),
					},
					"Failed to collect model options for provider",
				);
			}
		}),
	);

	return results;
}

/** Workspace discoveries use a credential and destination from the same scope. */
export async function discoverInferenceProviderModels(
	organizationId: string,
	userId: string | undefined,
	slug: string,
) {
	return orgContext.run({ organizationId }, async () => {
		const row = await resolveInferenceProviderCredential(organizationId, slug, "text");
		const module = getModelProviderModules().find(
			(candidate) => candidate.providerId === (row?.kind ?? slug) && candidate.catalogVisible !== false,
		);
		if (!row && !module) return { error: "Provider not found", status: 404 as const };
		const apiKeyModule = module instanceof ApiKeyProviderModule;
		if (!module?.listModels || (apiKeyModule && !module.supportsModelDiscovery)) {
			return { error: "This provider does not support model discovery", status: 409 as const };
		}

		const upstream = module.getUpstreamConfig?.()?.upstreamBaseUrl;
		// This endpoint only contacts server-configured destinations, and accepts
		// explicit copies of the catalog URL from previously saved provider forms.
		// A tenant URL or endpoint override needs its own safe egress path.
		if (row?.modelsEndpoint || (apiKeyModule && !upstream) ||
				(row?.baseUrl && (!upstream || !sameProviderDiscoveryUpstream(row.baseUrl, upstream)))) {
			return { error: "Live model discovery is unavailable for this upstream", status: 409 as const };
		}

		let credential: ModelListingCredential | null;
		if (row?.apiKey) {
			credential = { value: row.apiKey, kind: "api-key" };
		} else if (row) {
			// A signed-in (OAuth) workspace provider: the caller's own sign-in.
			credential =
				(await module.resolveModelListingCredential?.(
					orgBucketAgentId(organizationId),
					{ organizationId, userId },
					{ includeSystemEnv: false },
				)) ?? null;
		} else {
			credential = resolveSystemCredential(module) ?? null;
		}

		const models = await listProviderModels(
			module,
			credential,
			AbortSignal.timeout(LISTING_TIMEOUT_MS),
		);
		if (!models) return { error: "Connect a provider credential to discover models", status: 409 as const };
		return { models };
	});
}
