/**
 * Agent Config Routes
 *
 * Configuration endpoints mounted under /api/v1/agents/{agentId}/config
 */

import { Type } from "@sinclair/typebox";
import type { AgentConfigStore, ModelOption, SkillConfig } from "@lobu/core";
import { type Context, Hono } from "hono";
import { orgContext, tryGetOrgId } from "../../../lobu/stores/org-context.js";
import { defineRoute, type RouteSpec } from "../shared/define-route.js";
import {
	buildProviderCatalog,
	type ProviderCatalogService,
} from "../../auth/provider-catalog.js";
import { collectProviderModelOptions } from "../../auth/provider-model-options.js";

import type {
	AgentSettings,
	AgentSettingsStore,
} from "../../auth/settings/agent-settings-store.js";
import type { AuthProfilesManager } from "../../auth/settings/auth-profiles-manager.js";
import {
	canEditSettingsSection,
	type ResolvedProviderView,
	type ResolvedSectionView,
	SETTINGS_SECTION_KEYS,
	type SettingsSectionKey,
} from "../../auth/settings/resolved-settings-view.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { IMessageQueue } from "../../infrastructure/queue/index.js";
import type { GrantStore } from "../../permissions/grant-store.js";
import { createOwnershipResolver } from "../shared/agent-ownership.js";
import { errorResponse } from "../shared/helpers.js";
import {
	ErrorResponseSchema,
	errorResponses,
} from "../shared/openapi-responses.js";
import { verifySettingsSessionOrToken } from "./settings-auth.js";

const TAG = "Configuration";
const TokenQuery = Type.Object({ token: Type.Optional(Type.String()) });
const REDACTED_VALUE = "__LOBU_REDACTED__";

const SENSITIVE_KEY_PATTERN =
	/(?:credential|secret|token|password|api(?:_|-)?key|authorization)/i;

// --- Route Definitions ---

const getConfigRoute: RouteSpec = {
	method: "get",
	// This router is mounted at `/api/v1/agents/:agentId/config` (gateway.ts),
	// so it registers `/` on the sub-app but documents the full mounted URL.
	path: "/api/v1/agents/{agentId}/config",
	honoPath: "/",
	tags: [TAG],
	summary: "Get agent configuration",
	request: {
		params: Type.Object({ agentId: Type.String() }),
		query: TokenQuery,
	},
	responses: {
		200: { description: "Configuration", schema: Type.Any() },
		...errorResponses(ErrorResponseSchema, {
			401: "Unauthorized",
		}),
	},
};

interface ProviderCredentialStore {
	hasCredentials(
		agentId: string,
		context?: { userId?: string },
	): Promise<boolean>;
}

interface AgentConfigRoutesConfig {
	agentSettingsStore: AgentSettingsStore;
	agentConfigStore: Pick<AgentConfigStore, "getMetadata" | "getSettings">;
	userAgentsStore?: UserAgentsStore;
	providerStores?: Record<string, ProviderCredentialStore>;
	/**
	 * Provider connectivity overrides (e.g., system token means "connected" even if no user credentials are stored).
	 */
	providerConnectedOverrides?: Record<string, boolean>;
	providerCatalogService?: ProviderCatalogService;
	authProfilesManager?: AuthProfilesManager;
	queue?: IMessageQueue;
	grantStore?: GrantStore;
}

function getViewer(payload: SettingsTokenPayload | null | undefined): {
	settingsMode?: "admin" | "user";
	allowedScopes?: string[];
	isAdmin?: boolean;
} {
	return {
		settingsMode: payload?.settingsMode,
		allowedScopes: payload?.allowedScopes,
		isAdmin: payload?.isAdmin,
	};
}

async function resolveSettingsView(
	config: AgentConfigRoutesConfig,
	agentId: string,
	payload: SettingsTokenPayload | null,
): Promise<{
	sections: Record<SettingsSectionKey, ResolvedSectionView>;
	providerSources: Record<string, ResolvedProviderView>;
	settings: AgentSettings | null;
}> {
	const viewer = getViewer(payload);
	const settings = await config.agentSettingsStore.getSettings(agentId);

	const sections = Object.fromEntries(
		SETTINGS_SECTION_KEYS.map((section) => [
			section,
			{
				editable: canEditSettingsSection(section, viewer),
			} satisfies ResolvedSectionView,
		]),
	) as Record<SettingsSectionKey, ResolvedSectionView>;

	const providerSources = Object.fromEntries(
		orderedProviderSlugs(settings?.models).map((providerId) => [
			providerId,
			{
				id: providerId,
				canEdit: canEditSettingsSection("model", viewer),
			} satisfies ResolvedProviderView,
		]),
	);

	return { sections, providerSources, settings };
}

/**
 * Ordered provider slugs derived from a `models` list — the `<slug>/` prefixes
 * in first-appearance order.
 */
function orderedProviderSlugs(models: string[] | undefined): string[] {
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const ref of models ?? []) {
		const slash = ref.indexOf("/");
		if (slash <= 0) continue;
		const slug = ref.slice(0, slash);
		if (!seen.has(slug)) {
			seen.add(slug);
			slugs.push(slug);
		}
	}
	return slugs;
}

async function buildResolvedConfigResponse(
	config: AgentConfigRoutesConfig,
	agentId: string,
	payload: SettingsTokenPayload | null,
	providerModels: Record<string, ModelOption[]>,
	organizationId?: string,
): Promise<any> {
	const [settingsView, grants] = await Promise.all([
		resolveSettingsView(config, agentId, payload),
		// `grants` rows are keyed by organization, so there is nothing to read
		// for a declared agent authorized without a tenant. Asking anyway used
		// to answer across every organization at once.
		organizationId
			? (config.grantStore?.listGrants(agentId, organizationId) ??
				Promise.resolve([]))
			: Promise.resolve([]),
	]);
	const settings = settingsView.settings;

	const providers: Record<
		string,
		{
			connected: boolean;
			userConnected: boolean;
			systemConnected: boolean;
			activeAuthType?: string;
			authMethods?: string[];
		}
	> = {};
	if (config.providerStores) {
		for (const [name, store] of Object.entries(config.providerStores)) {
			try {
				const hasSystemCredentials =
					config.providerConnectedOverrides?.[name] === true;
				const hasUserCredentials = await store.hasCredentials(
					agentId,
					payload?.userId ? { userId: payload.userId } : undefined,
				);

				const profiles = config.authProfilesManager
					? await config.authProfilesManager.getProviderProfiles(
							agentId,
							name,
							payload?.userId,
						)
					: [];
				const now = Date.now();
				const validProfiles = profiles.filter(
					(profile) =>
						!profile.metadata?.expiresAt || profile.metadata.expiresAt > now,
				);

				providers[name] = {
					connected: hasUserCredentials || hasSystemCredentials,
					userConnected: hasUserCredentials,
					systemConnected: hasSystemCredentials,
					activeAuthType: validProfiles[0]?.authType,
					authMethods: validProfiles.map((profile) => profile.authType),
				};
			} catch {
				providers[name] = {
					connected: false,
					userConnected: false,
					systemConnected: false,
				};
			}
		}
	}

	// Shared catalog builder (same source as the org inference-providers catalog
	// route) so Claude/ChatGPT and their auth metadata stay consistent across
	// both surfaces. agent-config only needs the auth fields, so it maps a subset.
	const allProviderMeta = buildProviderCatalog().map((entry) => ({
		id: entry.slug,
		name: entry.displayName,
		iconUrl: entry.iconUrl,
		authType: entry.authType,
		supportedAuthTypes: entry.supportedAuthTypes,
		apiKeyInstructions: entry.apiKeyInstructions,
		apiKeyPlaceholder: entry.apiKeyPlaceholder,
		capabilities: [] as string[],
	}));

	const installedIds = orderedProviderSlugs(settings?.models);
	const installedIdSet = new Set(installedIds);
	const catalogProviders = allProviderMeta.filter(
		(provider) => !installedIdSet.has(provider.id),
	);
	const providerIconUrls: Record<string, string> = {};
	for (const provider of allProviderMeta) {
		if (provider.iconUrl) {
			providerIconUrls[provider.id] = provider.iconUrl;
		}
	}

	const providerMeta: Record<string, object> = {};
	for (const provider of allProviderMeta) {
		providerMeta[provider.id] = {
			name: provider.name,
			authType: provider.authType,
			supportedAuthTypes: provider.supportedAuthTypes,
			apiKeyInstructions: provider.apiKeyInstructions,
			apiKeyPlaceholder: provider.apiKeyPlaceholder,
			capabilities: provider.capabilities,
		};
	}

	const sanitized = sanitizeSettingsForResponse(settings);
	return {
		agentId,
		sections: settingsView.sections,
		providerViews: settingsView.providerSources,
		instructions: {
			identity: sanitized.identityMd || "",
			soul: sanitized.soulMd || "",
			user: sanitized.userMd || "",
		},
		providers: {
			order: installedIds,
			status: providers,
			catalog: catalogProviders,
			meta: providerMeta,
			models: providerModels,
			icons: providerIconUrls,
			configManaged: [] as string[],
		},
		// The agent's ordered EXACT model allow-list (`<slug>/<model>` refs).
		// models[0] is the default (middle of the layered fallback Automation →
		// agent → org default); the rest are alternates. Empty/absent ⇒ inherit
		// the org default + allow all org providers.
		models: settings?.models ?? [],
		skills: sanitized.skillsConfig?.skills || [],
		tools: {
			nixPackages: sanitized.nixConfig?.packages || [],
			permissions: grants,
			registries: [],
			globalRegistries: [],
		},
		settings: {
			verboseLogging: !!sanitized.verboseLogging,
			showToolCalls: !!sanitized.showToolCalls,
			memoryEnabled: !!process.env.MEMORY_URL,
		},
	};
}

export function createAgentConfigRoutes(config: AgentConfigRoutesConfig): Hono {
	const app = new Hono();

	const resolveOwnership = createOwnershipResolver({
		userAgentsStore: config.userAgentsStore,
		agentMetadataStore: config.agentConfigStore,
	});

	/**
	 * Verify settings token against agentId.
	 * Admin sessions bypass ownership checks.
	 * Owner-scoped browser sessions get admin-equivalent access for their own
	 * agents, while exact agent-scoped tokens remain limited unless they were
	 * explicitly minted as admin/user-mode sessions.
	 */
	const verifyToken = async (
		payload: SettingsTokenPayload | null,
		agentId: string,
	): Promise<{
		payload: SettingsTokenPayload;
		organizationId?: string;
	} | null> => {
		if (!payload) return null;
		if (payload.isAdmin || payload.settingsMode === "admin") {
			const organizationId = tryGetOrgId() ?? undefined;
			if (
				!organizationId &&
				!config.agentSettingsStore.isDeclaredAgent(agentId)
			) {
				return null;
			}
			return {
				payload: {
					...payload,
					isAdmin: true,
					settingsMode: "admin",
				},
				organizationId,
			};
		}

		const ownership = await resolveOwnership(payload, agentId);
		if (!ownership.authorized) return null;
		if (
			!ownership.organizationId &&
			!config.agentSettingsStore.isDeclaredAgent(agentId)
		) {
			return null;
		}

		if (payload.agentId || payload.settingsMode === "user") {
			return { payload, organizationId: ownership.organizationId };
		}

		return {
			payload: {
				...payload,
				isAdmin: true,
				settingsMode: "admin",
			},
			organizationId: ownership.organizationId,
		};
	};

	/**
	 * Resolve the `agentId` path param and verify the settings session/token for
	 * it. Returns the verified payload and tenant scope, or a 401 Response.
	 */
	const requireConfigAuth = async (
		c: Context,
	): Promise<{
		agentId: string;
		payload: SettingsTokenPayload;
		organizationId?: string;
	} | Response> => {
		const agentId = c.req.param("agentId") || "";
		const auth = await verifyToken(
			await verifySettingsSessionOrToken(c),
			agentId,
		);
		if (!auth) return errorResponse(c, "Unauthorized", 401);
		return { agentId, ...auth };
	};

	defineRoute(app, getConfigRoute, async (c): Promise<Response> => {
		const auth = await requireConfigAuth(c);
		if (auth instanceof Response) return auth;
		const { agentId, payload, organizationId } = auth;
		const loadConfig = async () => {
			const providerModels = await collectProviderModelOptions(
				agentId,
				payload.userId,
			);
			return c.json(
				await buildResolvedConfigResponse(
					config,
					agentId,
					payload,
					providerModels,
					organizationId,
				),
			);
		};
		// No org here means `verifyToken` authorized a DECLARED agent, whose
		// settings are org-agnostic — a DB-backed agent without a tenant is
		// already rejected there with 401. So the config still loads; the org
		// only decides whether there are grants to read, and
		// `buildResolvedConfigResponse` skips them rather than querying
		// unscoped (which used to answer for every tenant at once).
		if (!organizationId) {
			return loadConfig();
		}
		return orgContext.run({ organizationId }, loadConfig);
	});

	// ===== Grant Endpoints (read-only) =====

	if (config.grantStore) {
		const grantStore = config.grantStore;

		// GET /grants - List all active grants
		app.get("/grants", async (c) => {
			const auth = await requireConfigAuth(c);
			if (auth instanceof Response) return auth;

			// Same tenant rule as the config route: a declared agent authorized
			// without an org has no org-scoped rows to list, and `listGrants`
			// now refuses to run unscoped rather than answering for everyone.
			if (!auth.organizationId) return c.json([]);

			const grants = await grantStore.listGrants(
				auth.agentId,
				auth.organizationId,
			);
			return c.json(grants);
		});
	}

	return app;
}

function sanitizeSettingsForResponse(
	settings: AgentSettings | null,
): AgentSettings | Record<string, never> {
	if (!settings) return {};

	const sanitized = redactSensitiveFields(settings) as AgentSettings;

	if (sanitized.skillsConfig?.skills) {
		sanitized.skillsConfig = {
			skills: sanitized.skillsConfig.skills.map((skill) => {
				const legacySkill = skill as SkillConfig & {
					integrations?: unknown;
				};
				const {
					integrations: _integrations,
					modelPreference: _modelPreference,
					thinkingLevel: _thinkingLevel,
					...rest
				} = legacySkill;
				return rest;
			}),
		};
	}

	return sanitized;
}

function redactSensitiveFields(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => redactSensitiveFields(entry));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};

	for (const [key, rawValue] of Object.entries(input)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			output[key] = REDACTED_VALUE;
			continue;
		}

		output[key] = redactSensitiveFields(rawValue);
	}

	return output;
}
