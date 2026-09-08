#!/usr/bin/env bun

import {
	type AgentConfigStore,
	type AgentConnectionStore,
	CommandRegistry,
	createLogger,
	GuardrailRegistry,
	getErrorMessage,
	moduleRegistry,
	type ProviderRegistryEntry,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import {
	type AppInstallationStore,
	createPostgresAppInstallationStore,
} from "../../lobu/stores/app-installation-store.js";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
// inference_providers row access (per-modality custom upstreams) — the store
// owns the SQL + api_key_ref decrypt; core-services owns org resolution.
// See buildInferenceProviderSource below.
import {
	listInferenceProviders,
	resolveInferenceProviderConfig,
	resolveInferenceProviderCredential,
} from "../../lobu/stores/provider-secrets.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { BedrockProviderModule } from "../auth/bedrock/provider-module.js";
import { ChatGPTOAuthModule } from "../auth/chatgpt/chatgpt-oauth-module.js";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module.js";
import { ExternalAuthClient } from "../auth/external/client.js";
import { McpConfigService } from "../auth/mcp/config-service.js";
import { McpProxy } from "../auth/mcp/proxy.js";
import { resolveEnv } from "../auth/mcp/string-substitution.js";
import { McpToolCache } from "../auth/mcp/tool-cache.js";
import { buildOAuthRefreshers } from "../auth/oauth/client.js";
import {
	getOAuthProviderConfig,
	loadOAuthProvidersFromConfigs,
} from "../auth/oauth/providers.js";
import {
	createOAuthStateStore,
	type ProviderOAuthStateStore,
	sweepExpiredOAuthStates,
} from "../auth/oauth/state-store.js";
import { ProviderCatalogService } from "../auth/provider-catalog.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import { ModelPreferenceStore } from "../auth/settings/model-preference-store.js";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import { registerBuiltInCommands } from "../commands/built-in-commands.js";
import type { AgentConfig, GatewayConfig } from "../config/index.js";
import { ConversationStateStore } from "../connections/conversation-state-store.js";
import { sweepStalePendingInteractions } from "../connections/pending-interaction-store.js";
import { createGatewayStateAdapter } from "../connections/state-adapter.js";
import type { RuntimeProviderCredentialResolver } from "../embedded.js";
import { ArtifactStore } from "../files/artifact-store.js";
import { WorkerGateway } from "../worker-dispatch/worker-gateway.js";
import { registerBuiltinGuardrails } from "../guardrails/builtins.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import { QueueProducer, RunsQueue } from "../infrastructure/queue/index.js";
import { sweepCompletedRuns } from "../infrastructure/queue/runs-queue.js";
import { InteractionService } from "../interactions.js";
import { getModelProviderModules } from "../modules/module-system.js";
import { GrantStore, sweepExpiredGrants } from "../permissions/grant-store.js";
import { PolicyStore } from "../permissions/policy-store.js";
import { SecretProxy } from "../proxy/secret-proxy.js";
import { TokenRefreshJob } from "../proxy/token-refresh-job.js";
import {
	AwsSecretsManagerSecretStore,
	SecretStoreRegistry,
} from "../secrets/index.js";
import { InMemoryAgentStore } from "../stores/in-memory-agent-store.js";
import { sweepExpiredRateLimits } from "../utils/rate-limiter.js";
import { BedrockModelCatalog } from "./bedrock-model-catalog.js";
import { BedrockOpenAIService } from "./bedrock-openai-service.js";
import {
	buildRegistryMap,
	DeclaredAgentRegistry,
	entryFromAgentConfig,
} from "./declared-agent-registry.js";
import { ImageGenerationService } from "./image-generation-service.js";
import type {
	InferenceProviderConfigSource,
	InferenceProviderCredentialSource,
} from "./inference-provider-source.js";
import { InstructionService } from "./instruction-service.js";
import { ProviderConfigResolver } from "./provider-config-resolver.js";
import {
	ProviderRegistryService,
	resolveProviderRegistryPath,
} from "./provider-registry-service.js";
import { SessionManager, StateAdapterSessionStore } from "./session-manager.js";
import { SseFanout } from "./sse-fanout.js";
import { SseManager } from "./sse-manager.js";
import { TranscriptionService } from "./transcription-service.js";

const logger = createLogger("core-services");

/**
 * Core Services - Centralized service initialization and lifecycle management
 */
export class CoreServices {
	// ============================================================================
	// Queue Services
	// ============================================================================
	private queue?: IMessageQueue;
	private queueProducer?: QueueProducer;

	// ============================================================================
	// Session Services
	// ============================================================================
	private sessionManager?: SessionManager;
	private instructionService?: InstructionService;
	private interactionService?: InteractionService;
	private sseManager?: SseManager;
	private sseFanout?: SseFanout;

	// ============================================================================
	// Auth & Provider Services
	// ============================================================================
	private authProfilesManager?: AuthProfilesManager;
	private declaredAgentRegistry?: DeclaredAgentRegistry;
	private userAuthProfileStore?: UserAuthProfileStore;
	private modelPreferenceStore?: ModelPreferenceStore;
	private oauthStateStore?: ProviderOAuthStateStore;
	private secretProxy?: SecretProxy;
	private secretStore?: SecretStoreRegistry;
	private tokenRefreshJob?: TokenRefreshJob;

	// ============================================================================
	// MCP Services
	// ============================================================================
	private mcpConfigService?: McpConfigService;
	private mcpProxy?: McpProxy;

	// ============================================================================
	// Permissions
	// ============================================================================
	private grantStore?: GrantStore;
	private policyStore?: PolicyStore;

	// ============================================================================
	// Bundled Provider Registry
	// ============================================================================
	private providerRegistryService?: ProviderRegistryService;
	private providerConfigResolver?: ProviderConfigResolver;

	// ============================================================================
	// Worker Gateway
	// ============================================================================
	private workerGateway?: WorkerGateway;

	// ============================================================================
	// Agent Configuration Services
	// ============================================================================
	private agentSettingsStore?: AgentSettingsStore;
	private automationSubscriptionService?: AutomationSubscriptionService;
	private transcriptionService?: TranscriptionService;
	private imageGenerationService?: ImageGenerationService;
	private bedrockOpenAIService?: BedrockOpenAIService;
	private artifactStore?: ArtifactStore;
	private userAgentsStore?: UserAgentsStore;
	private agentMetadataStore?: AgentMetadataStore;

	// ============================================================================
	// External OAuth
	// ============================================================================
	private externalAuthClient?: ExternalAuthClient;

	// ============================================================================
	// Provider Catalog
	// ============================================================================
	private providerCatalogService?: ProviderCatalogService;

	// ============================================================================
	// Command Registry
	// ============================================================================
	private commandRegistry?: CommandRegistry;

	// ============================================================================
	// Guardrails — runtime registry of input/output/pre-tool checks. Populated
	// with built-ins at boot; downstream packages can register more by calling
	// `getGuardrailRegistry().register(...)` after `initialize()` returns.
	// ============================================================================
	private guardrailRegistry?: GuardrailRegistry;

	// ============================================================================
	// Agent Sub-Stores (injectable — host can provide its own implementations)
	// ============================================================================
	private configStore?: AgentConfigStore;
	private connectionStore?: AgentConnectionStore;
	private appInstallationStore?: AppInstallationStore;

	// SDK-embedded agents (passed via `GatewayConfig.agents`). lobu.config.ts
	// file-declared agents have been moved out of the gateway boot path —
	// they enter Postgres via `lobu apply`.
	private configAgents: AgentConfig[] = [];

	// Options stored for deferred initialization
	private options?: {
		configStore?: AgentConfigStore;
		connectionStore?: AgentConnectionStore;
		providerRegistry?: ProviderRegistryEntry[];
		secretStore?: SecretStoreRegistry;
		providerCredentialResolver?: RuntimeProviderCredentialResolver;
		stateAdapter?: import("chat").StateAdapter;
	};

	constructor(
		private readonly config: GatewayConfig,
		options?: {
			configStore?: AgentConfigStore;
			connectionStore?: AgentConnectionStore;
			providerRegistry?: ProviderRegistryEntry[];
			secretStore?: SecretStoreRegistry;
			providerCredentialResolver?: RuntimeProviderCredentialResolver;
			stateAdapter?: import("chat").StateAdapter;
		},
	) {
		this.options = options;
		if (options?.configStore) this.configStore = options.configStore;
		if (options?.connectionStore)
			this.connectionStore = options.connectionStore;
	}

	getConfigStore(): AgentConfigStore | undefined {
		return this.configStore;
	}

	getConnectionStore(): AgentConnectionStore | undefined {
		return this.connectionStore;
	}

	getAppInstallationStore(): AppInstallationStore {
		if (!this.appInstallationStore) {
			throw new Error("App installation store not initialized");
		}
		return this.appInstallationStore;
	}

	/**
	 * Initialize all core services in dependency order
	 */
	async initialize(): Promise<void> {
		logger.debug("Initializing core services...");

		// 0. Guardrail registry — populated before any service that may invoke
		// `runGuardrails()` is constructed (McpProxy, MessageConsumer, etc.).
		this.guardrailRegistry = new GuardrailRegistry();
		registerBuiltinGuardrails(this.guardrailRegistry);
		logger.debug("Guardrail registry initialized with built-ins");

		// 1. Queue (foundation for everything else)
		await this.initializeQueue();
		logger.debug("Queue initialized");

		// 2. Session management
		await this.initializeSessionServices();
		logger.debug("Session services initialized");

		// 3. Auth & provider services
		await this.initializeClaudeServices();
		logger.debug("Auth & provider services initialized");

		// 4. MCP ecosystem (depends on queue and Claude services)
		await this.initializeMcpServices();
		logger.debug("MCP services initialized");

		// 5. Queue producer (depends on queue being ready)
		await this.initializeQueueProducer();
		logger.debug("Queue producer initialized");

		// 6. Command registry (depends on agent settings store)
		this.initializeCommandRegistry();
		logger.debug("Command registry initialized");

		// Ephemeral-table sweeper used to live here as a per-pod setInterval.
		// It now runs as a cross-pod-coordinated scheduler task — see
		// `getRunSweepEphemeralTables()` and the `sweep-ephemeral-tables`
		// registration in `scheduled/jobs.ts`.

		logger.info("Core services initialized successfully");
	}

	/** Public entry point for the scheduler-registered ephemeral-table sweep.
	 *  Deletes expired rows from oauth_states, rate_limits, grants, and
	 *  archives completed runs. Lazy `expires_at > now()` filters on read
	 *  make this a hygiene task — running ~5 minutes apart is plenty. */
	async sweepEphemeralTables(): Promise<void> {
		try {
			const [expiredOAuthStateCount, rate, grants, completedRuns, pendingIds] =
				await Promise.all([
					sweepExpiredOAuthStates(),
					sweepExpiredRateLimits(),
					sweepExpiredGrants(),
					sweepCompletedRuns(),
					sweepStalePendingInteractions(),
				]);
			const pendingInteractions = pendingIds.length;
			if (
				expiredOAuthStateCount +
					rate +
					grants +
					completedRuns +
					pendingInteractions >
				0
			) {
				logger.debug("Ephemeral table sweeper deleted expired rows");
			}
		} catch (error) {
			logger.warn(
				{ error: getErrorMessage(error) },
				"Ephemeral table sweeper failed",
			);
		}
	}

	// ============================================================================
	// 1. Queue Services Initialization
	// ============================================================================

	private async initializeQueue(): Promise<void> {
		// Queue substrate is `public.runs` over Postgres (SKIP LOCKED +
		// LISTEN/NOTIFY).
		this.queue = new RunsQueue();
		await this.queue.start();
		logger.debug("Queue connection established (runs-table substrate)");
	}

	private async initializeQueueProducer(): Promise<void> {
		if (!this.queue) {
			throw new Error("Queue must be initialized before queue producer");
		}

		this.queueProducer = new QueueProducer(this.queue);
		await this.queueProducer.start();
		logger.debug("Queue producer initialized");
	}

	// ============================================================================
	// 2. Session Services Initialization
	// ============================================================================

	private async initializeSessionServices(): Promise<void> {
		if (!this.queue) {
			throw new Error("Queue must be initialized before session services");
		}

		const stateAdapter =
			this.options?.stateAdapter ?? createGatewayStateAdapter();
		await stateAdapter.connect();
		const sessionStore = new StateAdapterSessionStore(
			new ConversationStateStore(stateAdapter),
		);
		this.sessionManager = new SessionManager(sessionStore);
		logger.debug("Session manager initialized");

		this.interactionService = new InteractionService();
		logger.debug("Interaction service initialized");

		this.sseManager = new SseManager();
		logger.debug("SSE manager initialized");

		// Cross-replica SSE delivery: LISTEN/NOTIFY fan-out so events produced on
		// this pod reach clients (and seed replay backlogs) on every pod. Queue is
		// already started here, so the DB is known-reachable. Fails open to
		// local-only on LISTEN failure.
		this.sseFanout = new SseFanout(this.sseManager);
		await this.sseFanout.start();
		logger.debug("SSE fan-out initialized");

		// Initialize grant store for unified permissions (PG-backed)
		this.grantStore = new GrantStore();
		logger.debug("Grant store initialized");

		// Policy store for egress judge (per-agent judged-domain rules + named
		// judges + operator extra_policy). In-memory; synced on each deployment.
		this.policyStore = new PolicyStore();
		logger.debug("Policy store initialized");

		const defaultSecretStore = new PostgresSecretStore();
		this.secretStore =
			this.options?.secretStore ??
			new SecretStoreRegistry(
				defaultSecretStore,
				{ secret: defaultSecretStore },
				{
					readOnlyStores: {
						"aws-sm": new AwsSecretsManagerSecretStore(
							this.config.secrets.aws.region,
						),
					},
				},
			);
		logger.debug("Secret store initialized");

		// The generic app-installation primitive: the multi-tenant record of "Lobu
		// App <X> is installed into external tenant <Y>", shared by every provider
		// (GitHub App installs, Slack OAuth workspace installs, Jira sites, …).
		// Slack installs are a thin projection over this (see
		// `lobu/stores/slack-installations.ts`) with NO bespoke table or store.
		// Always Postgres-backed; only exercised on the OAuth/webhook path.
		this.appInstallationStore = createPostgresAppInstallationStore();

		this.automationSubscriptionService = new AutomationSubscriptionService();
		this.userAgentsStore = new UserAgentsStore();

		// Initialize agent sub-stores. The configStore here owns all Postgres I/O
		// for agent settings + metadata; the AgentSettingsStore / AgentMetadataStore
		// wrappers below add the declared-agent overlay and convenience helpers
		// without duplicating the storage layer.
		if (!this.configStore || !this.connectionStore) {
			if (this.config.agents?.length) {
				const inMemoryStore = new InMemoryAgentStore();
				if (!this.configStore) this.configStore = inMemoryStore;
				if (!this.connectionStore) this.connectionStore = inMemoryStore;

				await this.populateStoreFromAgentConfigs(
					inMemoryStore,
					this.config.agents,
				);
				logger.debug(
					`Agent sub-stores initialized (in-memory, ${this.config.agents.length} agent(s) from config)`,
				);
			} else {
				throw new Error(
					"No agent sub-stores configured: provide configStore/connectionStore via CoreServices options, or pass agents via GatewayConfig.agents. (lobu.config.ts is no longer read at gateway boot — push agents with `lobu apply`.)",
				);
			}
		} else {
			logger.debug("Using host-provided agent sub-stores (embedded mode)");
		}

		this.agentSettingsStore = new AgentSettingsStore(this.configStore);
		this.agentMetadataStore = new AgentMetadataStore(this.configStore);
		logger.debug(
			"Agent settings, connections, user agents & metadata stores initialized",
		);

		// Initialize external OAuth client if configured. The KV here is a tiny
		// per-process TTL map — the only state ExternalAuthClient persists is a
		// short-lived state nonce during the OAuth handshake. Multi-replica is
		// fine because each redirect lands on the same gateway that started it
		// (the `state` parameter is opaque to the AS, so any replica can verify).
		const externalAuthKv = new Map<
			string,
			{ value: string; expiresAt: number }
		>();
		this.externalAuthClient =
			ExternalAuthClient.fromConfig({
				issuerUrl: this.config.auth.issuerUrl,
				publicGatewayUrl: this.config.mcp.publicGatewayUrl,
				cacheStore: {
					get: async (key) => {
						const entry = externalAuthKv.get(key);
						if (!entry) return null;
						if (entry.expiresAt <= Date.now()) {
							externalAuthKv.delete(key);
							return null;
						}
						return entry.value;
					},
					set: async (key, value, ttlSeconds) => {
						externalAuthKv.set(key, {
							value,
							expiresAt: Date.now() + ttlSeconds * 1000,
						});
					},
				},
			}) ?? undefined;
		if (this.externalAuthClient) {
			logger.debug("External OAuth client initialized");
		}
	}

	// ============================================================================
	// 3. Auth & Provider Services Initialization
	// ============================================================================

	private async initializeClaudeServices(): Promise<void> {
		if (!this.queue) {
			throw new Error("Queue must be initialized before auth services");
		}

		if (!this.agentSettingsStore) {
			throw new Error(
				"Agent settings store must be initialized before auth services",
			);
		}

		// Initialize auth profile and preference stores
		if (!this.secretStore) {
			throw new Error("Secret store must be initialized before auth services");
		}

		// Declared registry: read-only snapshot of SDK-declared agents (passed
		// via `GatewayConfig.agents`). No second copy is kept — declared
		// settings live in memory.
		this.declaredAgentRegistry = new DeclaredAgentRegistry();
		this.declaredAgentRegistry.replaceAll(buildRegistryMap(this.configAgents));
		// Plumb registry into the settings store so getSettings
		// returns declared settings for declared agents (no second copy exists
		// by design — see one-shot cleanup below).
		this.agentSettingsStore.setDeclaredAgents(this.declaredAgentRegistry);

		// User-scoped auth profile store: durable per-(userId, agentId)
		// OAuth/BYOK state. Persists to `public.user_auth_profiles`; sensitive
		// values live in the secret store with refs in the JSON column.
		this.userAuthProfileStore = new UserAuthProfileStore(this.secretStore);

		this.authProfilesManager = new AuthProfilesManager({
			ephemeralProfiles: this.agentSettingsStore.getEphemeralAuthProfiles(),
			declaredAgents: this.declaredAgentRegistry,
			userAuthProfiles: this.userAuthProfileStore,
			secretStore: this.secretStore,
			runtimeCredentialResolver: this.options?.providerCredentialResolver,
			agentOwnerResolver: async (agentId) =>
				(await this.agentSettingsStore?.getMetadata(agentId))?.owner.userId,
			agentOrgResolver: async (agentId) =>
				(await this.resolveAgentOrgId(agentId)) ?? undefined,
		});
		this.transcriptionService = new TranscriptionService(
			this.authProfilesManager,
		);
		this.imageGenerationService = new ImageGenerationService(
			this.authProfilesManager,
		);
		this.artifactStore = new ArtifactStore();
		this.modelPreferenceStore = new ModelPreferenceStore("claude");

		// Embedded SDK mode: per-agent in-memory credentials supplied via
		// `provider.key` are exposed as ephemeral profiles. Credentials with
		// a `secretRef` come through the declared registry (no separate
		// ephemeral copy needed).
		if (this.configAgents.length > 0) {
			for (const agent of this.configAgents) {
				for (const provider of agent.providers || []) {
					if (!provider.key || provider.secretRef) continue;
					this.authProfilesManager.registerEphemeralProfile({
						agentId: agent.id,
						provider: provider.id,
						credential: provider.key,
						authType: "api-key",
						label: `${provider.id} (from config)`,
						makePrimary: true,
					});
				}
			}
		}

		logger.debug(
			"Auth profile, model preference, transcription, and image generation services initialized",
		);

		// Initialize secret injection proxy (will be finalized after provider modules are registered)
		this.secretProxy = new SecretProxy(
			{
				defaultUpstreamUrl:
					this.config.anthropicProxy.anthropicBaseUrl ||
					"https://api.anthropic.com",
			},
			this.secretStore,
		);
		logger.debug(
			`Secret proxy initialized (upstream: ${this.config.anthropicProxy.anthropicBaseUrl || "https://api.anthropic.com"})`,
		);

		// Load providers.json first so subscription OAuth configs (and config-
		// driven API-key providers) come from data, not hard-coded TS.
		const injectedProviders = this.options?.providerRegistry;
		if (injectedProviders) {
			this.providerRegistryService = new ProviderRegistryService(
				undefined,
				injectedProviders,
			);
			logger.debug(
				`Provider registry initialized from injected providers (${injectedProviders.length})`,
			);
		} else {
			const registryPath = resolveProviderRegistryPath();
			this.providerRegistryService = new ProviderRegistryService(registryPath);
			if (registryPath) {
				logger.info(`Provider registry path: ${registryPath}`);
			} else {
				logger.warn(
					"No providers registry found (set LOBU_PROVIDER_REGISTRY_PATH or run from a dir with config/providers.json) — config-driven providers will be unavailable",
				);
			}
		}
		this.providerConfigResolver = new ProviderConfigResolver(
			this.providerRegistryService,
		);

		const configProvidersEarly =
			await this.providerConfigResolver.getProviderConfigs();
		const oauthLoaded = loadOAuthProvidersFromConfigs(configProvidersEarly);
		if (oauthLoaded.length === 0) {
			logger.warn(
				"No subscription OAuth providers loaded from providers.json — Claude/ChatGPT/xAI subscription sign-in and token refresh will be unavailable until oauth blocks are present",
			);
		} else {
			logger.info(
				`Loaded ${oauthLoaded.length} subscription OAuth provider(s) from config: ${oauthLoaded.map((p) => p.id).join(", ")}`,
			);
		}

		// Token refresh job — one refresher per oauth block in providers.json.
		// Scheduling is wired by TaskScheduler (see scheduled/jobs.ts).
		if (!this.authProfilesManager) {
			throw new Error(
				"Auth profiles manager must be initialized before token refresh job",
			);
		}
		this.tokenRefreshJob = new TokenRefreshJob(
			this.authProfilesManager,
			buildOAuthRefreshers(),
		);
		logger.debug("Token refresh job constructed");

		// Runtime modules with provider-specific credential injection (Anthropic
		// headers, Codex account placeholders). OAuth *endpoints* still come from
		// providers.json via the registry above.
		this.oauthStateStore = createOAuthStateStore("claude");
		const claudeOAuthModule = new ClaudeOAuthModule(
			this.authProfilesManager,
			this.modelPreferenceStore,
		);
		moduleRegistry.register(claudeOAuthModule);
		logger.debug("Claude OAuth module registered");

		const chatgptOAuthModule = new ChatGPTOAuthModule(this.authProfilesManager);
		moduleRegistry.register(chatgptOAuthModule);
		logger.debug("ChatGPT OAuth module registered");

		const bedrockModelCatalog = new BedrockModelCatalog();
		const bedrockProviderModule = new BedrockProviderModule(
			this.authProfilesManager,
			bedrockModelCatalog,
		);
		moduleRegistry.register(bedrockProviderModule);
		this.bedrockOpenAIService = new BedrockOpenAIService({
			modelCatalog: bedrockModelCatalog,
		});
		logger.debug("Bedrock provider module registered");

		this.transcriptionService?.setProviderConfigSource(() =>
			this.providerConfigResolver
				? this.providerConfigResolver.getProviderConfigs()
				: Promise.resolve({}),
		);

		// Inference-provider config source: resolves an org's `inference_providers`
		// row for (agentId, slug, modality) → { apiKey, base_url, model,
		// models_endpoint }. Org resolution (agentId → organizationId) stays here
		// (we own `resolveAgentOrgId`); the store owns the row read + key decrypt.
		const inferenceProviderSource = this.buildInferenceProviderSource();
		this.transcriptionService?.setInferenceProviderSource(
			inferenceProviderSource,
		);
		this.transcriptionService?.setInferenceProviderCredentialSource(
			this.buildInferenceProviderCredentialSource(),
		);
		this.imageGenerationService?.setInferenceProviderSource(
			inferenceProviderSource,
		);

		// Register config-driven providers (any providers.json entry not already
		// claimed by a specialized runtime module). oauth blocks surface Sign-in.
		const configProviders = configProvidersEarly;
		logger.info(
			`Provider registry loaded ${Object.keys(configProviders).length} config-driven provider(s)`,
		);
		const registeredIds = new Set(
			getModelProviderModules().map((m) => m.providerId),
		);
		for (const [id, entry] of Object.entries(configProviders)) {
			if (registeredIds.has(id)) {
				logger.info(
					`Skipping config-driven provider "${id}" — already registered`,
				);
				continue;
			}
			const oauth = entry.oauth ?? getOAuthProviderConfig(id);
			const oauthAuthType = oauth?.authType ?? "oauth";
			const module = new ApiKeyProviderModule({
				providerId: id,
				providerDisplayName: entry.displayName,
				providerIconUrl: entry.iconUrl,
				envVarName: entry.envVarName,
				slug: id,
				upstreamBaseUrl: entry.upstreamBaseUrl,
				modelsEndpoint: entry.modelsEndpoint,
				sdkCompat: entry.sdkCompat,
				defaultModel: entry.defaultModel,
				registryAlias: entry.registryAlias,
				apiKeyInstructions: entry.apiKeyInstructions,
				apiKeyPlaceholder: entry.apiKeyPlaceholder,
				authProfilesManager: this.authProfilesManager,
				...(oauth
					? {
							authType: oauthAuthType,
							supportedAuthTypes: [oauthAuthType, "api-key" as const],
						}
					: {}),
			});
			moduleRegistry.register(module);
			registeredIds.add(id);
			logger.debug(
				`Registered config-driven provider: ${id} (system key: ${module.hasSystemKey() ? "available" : "not available"}${oauth ? `, oauth: ${oauth.grant}` : ""})`,
			);
		}

		// Initialize provider catalog service. The inference-provider reader +
		// registerUpstream callback let it synthesize routable modules for
		// org-defined provider slugs (custom upstreams) on demand. Registration is
		// per-pod, hydrated from the row each call — multi-replica safe (no shared
		// in-memory map another replica must read).
		this.providerCatalogService = new ProviderCatalogService(
			this.agentSettingsStore,
			this.authProfilesManager,
			(organizationId) => listInferenceProviders(organizationId),
			(upstream, providerId) =>
				this.secretProxy?.registerUpstream(upstream, providerId),
		);
		logger.debug("Provider catalog service initialized");

		// Register provider upstream configs with the secret proxy for path-based routing
		if (this.secretProxy) {
			this.secretProxy.setAuthProfilesManager(this.authProfilesManager);
			// Independent source of the caller's expected org for placeholder
			// lookups — without this the org-scoping guard on
			// `lookupPlaceholderMapping` has nothing to enforce against.
			this.secretProxy.setAgentOrgResolver((agentId) =>
				this.resolveAgentOrgId(agentId),
			);
			for (const provider of getModelProviderModules()) {
				const upstream = provider.getUpstreamConfig?.();
				if (upstream) {
					this.secretProxy.registerUpstream(upstream, provider.providerId);
				}
			}
			// Register system key resolver for fallback when no per-agent auth profile exists
			const modules = getModelProviderModules();
			this.secretProxy.setSystemKeyResolver((providerId: string) => {
				const mod = modules.find((m) => m.providerId === providerId);
				if (!mod) return undefined;
				// Use the module's injectSystemKeyFallback to resolve the system key.
				// The fallback may inject into a different env var than credentialEnvVarName
				// (e.g., Claude injects ANTHROPIC_API_KEY, not CLAUDE_CODE_OAUTH_TOKEN),
				// so check all secret env var names.
				const testEnv: Record<string, string> = {};
				mod.injectSystemKeyFallback(testEnv);
				const value =
					mod
						.getSecretEnvVarNames()
						.map((v) => testEnv[v])
						.find(Boolean) ?? testEnv[mod.getCredentialEnvVarName()];
				if (!value) return undefined;
				// Classify by the SOURCE env var, not the destination: a module's
				// injectSystemKeyFallback may re-home a Bearer/OAuth token into an
				// api-key var (e.g. Claude copies ANTHROPIC_AUTH_TOKEN into
				// ANTHROPIC_API_KEY). Match the resolved value back to a declared
				// bearer var so a Bearer token is still presented as Bearer, not
				// x-api-key.
				const isBearer = (mod.getBearerCredentialEnvVarNames?.() ?? []).some(
					(v) => {
						const raw = resolveEnv(v);
						return !!raw && raw === value;
					},
				);
				return { value, kind: isBearer ? "oauth" : "api-key" };
			});
			logger.debug("Provider upstreams registered with secret proxy");
		}
	}

	// ============================================================================
	// 4. MCP Services Initialization
	// ============================================================================

	private async initializeMcpServices(): Promise<void> {
		if (!this.queue) {
			throw new Error("Queue must be initialized before MCP services");
		}

		// Initialize system MCP config service. External MCP capabilities are
		// connector-backed operations; the worker only receives lobu-memory.
		this.mcpConfigService = new McpConfigService({
			lobuMemory: {
				// CROSS-TENANT SAFE: resolve the lobu-memory org slug from the token's
				// organizationId, NOT an id-only agent lookup. A shared agent id
				// (`lobu-builder`) exists in every org, so `WHERE a.id = agentId` alone
				// would pick an ARBITRARY org's slug and build the wrong tenant's
				// `/mcp/<orgSlug>` endpoint. When the token carries no org (orgless
				// db-backed agent) we return null → no lobu-memory MCP (fail closed).
				resolveOrgSlug: async (
					_agentId: string,
					organizationId: string | undefined,
				) => {
					if (!organizationId) return null;
					const rows = await getDb()`
            SELECT slug FROM organization WHERE id = ${organizationId} LIMIT 1
          `;
					const slug = rows[0]?.slug;
					return typeof slug === "string" && slug.trim() ? slug.trim() : null;
				},
			},
		});

		// Initialize instruction service (needed by WorkerGateway)
		this.instructionService = new InstructionService(
			this.mcpConfigService,
			this.agentSettingsStore,
		);
		logger.debug("Instruction service initialized");

		// Initialize MCP tool cache and proxy
		if (!this.secretStore) {
			throw new Error("Secret store must be initialized before MCP proxy");
		}
		const mcpToolCache = new McpToolCache();
		this.mcpProxy = new McpProxy(this.mcpConfigService, {
			toolCache: mcpToolCache,
			grantStore: this.grantStore,
			agentSettingsStore: this.agentSettingsStore,
			guardrailRegistry: this.guardrailRegistry,
		});
		this.mcpProxy.onToolBlocked = async (
			requestId,
			agentId,
			userId,
			mcpId,
			toolName,
			args,
			grantPattern,
			channelId,
			conversationId,
			teamId,
			connectionId,
			platform,
			source,
		) => {
			await this.interactionService?.postToolApproval(
				requestId,
				agentId,
				userId,
				conversationId,
				channelId,
				teamId,
				connectionId,
				platform || "unknown",
				mcpId,
				toolName,
				args,
				grantPattern,
				source,
			);
		};
		logger.debug("MCP proxy initialized");

		// Initialize worker gateway
		this.workerGateway = new WorkerGateway(
			this.queue,
			this.config.mcp.publicGatewayUrl,
			this.mcpConfigService,
			this.instructionService,
			this.mcpProxy,
			this.providerCatalogService,
			this.agentSettingsStore,
		);
		logger.debug("Worker gateway initialized");

		// Initialize all registered modules
		await moduleRegistry.initAll();
		logger.debug("Modules initialized");
	}

	// ============================================================================
	// 7. Command Registry Initialization
	// ============================================================================

	private initializeCommandRegistry(): void {
		if (!this.agentSettingsStore) {
			throw new Error(
				"Agent settings store must be initialized before command registry",
			);
		}
		this.commandRegistry = new CommandRegistry();
		registerBuiltInCommands(this.commandRegistry, {
			agentSettingsStore: this.agentSettingsStore,
			automationSubscriptionService: this.getAutomationSubscriptionService(),
		});
		logger.debug("Command registry initialized with built-in commands");
	}

	// ============================================================================
	// SDK-Embedded Helpers
	// ============================================================================

	private async populateStoreFromAgentConfigs(
		store: InMemoryAgentStore,
		agents: AgentConfig[],
	): Promise<void> {
		for (const agent of agents) {
			await store.saveMetadata(agent.id, {
				agentId: agent.id,
				name: agent.name,
				description: agent.description,
				owner: { platform: "system", userId: "config" },
				createdAt: Date.now(),
			});
			await store.saveSettings(agent.id, {
				...entryFromAgentConfig(agent).settings,
				updatedAt: Date.now(),
			} as any);
		}

		// Store agent configs for credential seeding and connection seeding later
		this.configAgents = agents;
	}

	getConfigAgents(): AgentConfig[] {
		return this.configAgents;
	}

	// ============================================================================
	// Shutdown
	// ============================================================================

	async shutdown(): Promise<void> {
		logger.info("Shutting down core services...");

		// Ephemeral sweeper + token refresh have no per-instance lifecycle anymore
		// — scheduling is owned by the TaskScheduler. Nothing to stop here.

		if (this.sseFanout) {
			await this.sseFanout.stop();
		}

		if (this.queueProducer) {
			await this.queueProducer.stop();
		}

		if (this.workerGateway) {
			this.workerGateway.shutdown();
			logger.info("Worker gateway shutdown complete");
		}

		if (this.queue) {
			await this.queue.stop();
		}

		logger.info("Core services shutdown complete");
	}

	// ============================================================================
	// Service Accessors (implements ICoreServices interface)
	// ============================================================================

	getQueue(): IMessageQueue {
		if (!this.queue) throw new Error("Queue not initialized");
		return this.queue;
	}

	getTokenRefreshJob(): TokenRefreshJob {
		if (!this.tokenRefreshJob) {
			throw new Error("Token refresh job not initialized");
		}
		return this.tokenRefreshJob;
	}

	getQueueProducer(): QueueProducer {
		if (!this.queueProducer) throw new Error("Queue producer not initialized");
		return this.queueProducer;
	}

	getSecretProxy(): SecretProxy | undefined {
		return this.secretProxy;
	}

	/**
	 * Resolve an agent's owning organization id from `public.agents`. Used by
	 * the secret proxy to compute the `expectedOrganizationId` it hands to
	 * placeholder lookups. No cache — the SecretProxy is called once per
	 * upstream request, and a SELECT by primary key on `agents.id` is cheap
	 * enough that we'd rather avoid the staleness window of a TTL cache.
	 */
	private async resolveAgentOrgId(agentId: string): Promise<string | null> {
		const sql = getDb();
		const rows = (await sql`
      SELECT organization_id FROM agents WHERE id = ${agentId} LIMIT 1
    `) as Array<{ organization_id?: string }>;
		return rows[0]?.organization_id ?? null;
	}

	/**
	 * Build the {@link InferenceProviderConfigSource} the capability services
	 * consume. Resolves the org from the agent, then delegates to
	 * provider-secrets.resolveInferenceProviderConfig — one row read for the
	 * modality's config + key (the single-read URL invariant). Returns null when
	 * no live row / no capabilities block / no usable key ⇒ static fallback.
	 */
	private buildInferenceProviderSource(): InferenceProviderConfigSource {
		return async (agentId, slug, modality) => {
			const organizationId = await this.resolveAgentOrgId(agentId);
			if (!organizationId) return null;

			// One row read: capabilities + key together (see the store's
			// single-read invariant). Require a usable key so the service never
			// tries a custom upstream with no credential.
			const config = await resolveInferenceProviderConfig(
				organizationId,
				slug,
				modality,
			);
			if (!config?.apiKey) return null;

			return {
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				model: config.model,
				modelsEndpoint: config.modelsEndpoint,
			};
		};
	}

	/**
	 * Resolve an org provider's credential even when no modality override block
	 * exists. Transcription uses this only after providers.json has declared the
	 * provider STT-capable, so a normal org OpenAI key enables the catalog's
	 * trusted transcription defaults without hidden duplicate key setup.
	 */
	private buildInferenceProviderCredentialSource(): InferenceProviderCredentialSource {
		return async (agentId, slug, modality) => {
			const organizationId = await this.resolveAgentOrgId(agentId);
			if (!organizationId) return null;

			const credential = await resolveInferenceProviderCredential(
				organizationId,
				slug,
				modality,
			);
			if (!credential?.apiKey) return null;

			return {
				kind: credential.kind,
				apiKey: credential.apiKey,
				baseUrl: credential.baseUrl,
				model: credential.model,
				modelsEndpoint: credential.modelsEndpoint,
			};
		};
	}

	getSecretStore(): SecretStoreRegistry {
		if (!this.secretStore) throw new Error("Secret store not initialized");
		return this.secretStore;
	}

	getWorkerGateway(): WorkerGateway | undefined {
		return this.workerGateway;
	}

	getMcpProxy(): McpProxy | undefined {
		return this.mcpProxy;
	}

	getMcpConfigService(): McpConfigService | undefined {
		return this.mcpConfigService;
	}

	getModelPreferenceStore(): ModelPreferenceStore | undefined {
		return this.modelPreferenceStore;
	}

	getOAuthStateStore(): ProviderOAuthStateStore | undefined {
		return this.oauthStateStore;
	}

	getPublicGatewayUrl(): string {
		return this.config.mcp.publicGatewayUrl;
	}

	getArtifactStore(): ArtifactStore {
		if (!this.artifactStore) throw new Error("Artifact store not initialized");
		return this.artifactStore;
	}

	getSessionManager(): SessionManager {
		if (!this.sessionManager)
			throw new Error("Session manager not initialized");
		return this.sessionManager;
	}

	getInstructionService(): InstructionService | undefined {
		return this.instructionService;
	}

	getInteractionService(): InteractionService {
		if (!this.interactionService)
			throw new Error("Interaction service not initialized");
		return this.interactionService;
	}

	getSseManager(): SseManager {
		if (!this.sseManager) throw new Error("SSE manager not initialized");
		return this.sseManager;
	}

	getAgentSettingsStore(): AgentSettingsStore {
		if (!this.agentSettingsStore)
			throw new Error("Agent settings store not initialized");
		return this.agentSettingsStore;
	}

	getAutomationSubscriptionService(): AutomationSubscriptionService {
		if (!this.automationSubscriptionService)
			throw new Error("Automation subscription service not initialized");
		return this.automationSubscriptionService;
	}

	getTranscriptionService(): TranscriptionService | undefined {
		return this.transcriptionService;
	}

	getImageGenerationService(): ImageGenerationService | undefined {
		return this.imageGenerationService;
	}

	getBedrockOpenAIService(): BedrockOpenAIService | undefined {
		return this.bedrockOpenAIService;
	}

	getUserAgentsStore(): UserAgentsStore {
		if (!this.userAgentsStore)
			throw new Error("User agents store not initialized");
		return this.userAgentsStore;
	}

	getAgentMetadataStore(): AgentMetadataStore {
		if (!this.agentMetadataStore)
			throw new Error("Agent metadata store not initialized");
		return this.agentMetadataStore;
	}

	getGuardrailRegistry(): GuardrailRegistry | undefined {
		return this.guardrailRegistry;
	}

	getCommandRegistry(): CommandRegistry {
		if (!this.commandRegistry)
			throw new Error("Command registry not initialized");
		return this.commandRegistry;
	}

	getProviderCatalogService(): ProviderCatalogService {
		if (!this.providerCatalogService)
			throw new Error("Provider catalog service not initialized");
		return this.providerCatalogService;
	}

	getAuthProfilesManager(): AuthProfilesManager | undefined {
		return this.authProfilesManager;
	}

	getDeclaredAgentRegistry(): DeclaredAgentRegistry | undefined {
		return this.declaredAgentRegistry;
	}

	getUserAuthProfileStore(): UserAuthProfileStore | undefined {
		return this.userAuthProfileStore;
	}

	getGrantStore(): GrantStore | undefined {
		return this.grantStore;
	}

	getPolicyStore(): PolicyStore | undefined {
		return this.policyStore;
	}

	getProviderRegistryService(): ProviderRegistryService | undefined {
		return this.providerRegistryService;
	}

	getProviderConfigResolver(): ProviderConfigResolver | undefined {
		return this.providerConfigResolver;
	}

	getExternalAuthClient(): ExternalAuthClient | undefined {
		return this.externalAuthClient;
	}
}
