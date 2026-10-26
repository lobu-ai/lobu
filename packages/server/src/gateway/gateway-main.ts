#!/usr/bin/env bun

import {
	type AgentConfigStore,
	type AgentConnectionStore,
	createLogger,
	type ProviderRegistryEntry,
} from "@lobu/core";
import type { GatewayConfig } from "./config/index.js";
import type { RuntimeProviderCredentialResolver } from "./embedded.js";
import {
	startTurnTimeoutSweep,
	stopTurnTimeoutSweep,
} from "./orchestration/turn-liveness.js";
import { UnifiedThreadResponseConsumer } from "./platform/unified-thread-consumer.js";
import { type PlatformAdapter, platformRegistry } from "./platform.js";
import type { SecretStoreRegistry } from "./secrets/index.js";
import { CoreServices } from "./services/core-services.js";

const logger = createLogger("gateway");

/**
 * Main Gateway class that orchestrates all platform adapters
 *
 * Architecture:
 * - CoreServices: Platform-agnostic services (queue, MCP, Anthropic)
 * - PlatformAdapters: Platform-specific integrations (Slack, Discord, etc.)
 *
 * Lifecycle:
 * 1. Gateway initializes CoreServices
 * 2. Platforms register themselves via registerPlatform()
 * 3. Gateway calls initialize() on each platform with CoreServices
 * 4. Gateway calls start() on each platform
 */
interface GatewayOptions {
	/** Agent settings + metadata store. Defaults to InMemoryAgentStore. */
	configStore?: AgentConfigStore;
	/** Runtime connection store. Defaults to InMemoryAgentStore. */
	connectionStore?: AgentConnectionStore;
	/** Provide bundled providers programmatically (skips file loading). */
	providerRegistry?: ProviderRegistryEntry[];
	/** Override the default secret-store registry (embedded mode). */
	secretStore?: SecretStoreRegistry;
	/** Resolve provider credentials dynamically at runtime (embedded mode). */
	providerCredentialResolver?: RuntimeProviderCredentialResolver;
	/**
	 * The tool registry's authorization read-only classifier, handed to the MCP
	 * proxy (`McpProxy` option `isReadOnlyLobuTool`). Injected from the server
	 * entry because the registry cannot be imported from the gateway graph
	 * without an import cycle through the tool modules.
	 */
	isReadOnlyLobuTool?: (toolName: string) => boolean;
}

export class Gateway {
	private coreServices: CoreServices;
	private platforms: Map<string, PlatformAdapter> = new Map();
	private unifiedConsumer?: UnifiedThreadResponseConsumer;
	private isRunning = false;

	constructor(
		private readonly config: GatewayConfig,
		options?: GatewayOptions,
	) {
		this.coreServices = new CoreServices(config, {
			configStore: options?.configStore,
			connectionStore: options?.connectionStore,
			providerRegistry: options?.providerRegistry,
			secretStore: options?.secretStore,
			providerCredentialResolver: options?.providerCredentialResolver,
			isReadOnlyLobuTool: options?.isReadOnlyLobuTool,
		});
	}

	/**
	 * Register a platform adapter
	 * Platforms register themselves via dependency injection
	 *
	 * @param platform - Platform adapter to register
	 * @returns This gateway for chaining
	 */
	registerPlatform(platform: PlatformAdapter): this {
		if (this.platforms.has(platform.name)) {
			throw new Error(`Platform ${platform.name} is already registered`);
		}

		this.platforms.set(platform.name, platform);
		// Also register in global platform registry for deployment managers
		platformRegistry.register(platform);

		// If the gateway is already running, the start() registration loop has
		// already passed. Register the instruction provider eagerly so platforms
		// added post-start (chat adapters) still contribute identity context.
		if (this.isRunning && platform.getInstructionProvider) {
			const provider = platform.getInstructionProvider();
			if (provider) {
				this.coreServices
					.getInstructionService()
					?.registerPlatformProvider(platform.name, provider);
			}
		}

		logger.debug(`Platform registered: ${platform.name}`);
		return this;
	}

	/**
	 * Start the gateway
	 * 1. Initialize core services
	 * 2. Initialize all platforms
	 * 3. Register instruction providers from platforms
	 * 4. Start all platforms
	 */
	async start(): Promise<void> {
		logger.debug("Starting gateway...");

		// 1. Initialize core services (queue, MCP, Anthropic, etc.)
		await this.coreServices.initialize();

		// 2. Initialize each platform with core services
		for (const [name, platform] of this.platforms) {
			logger.debug(`Initializing platform: ${name}`);
			await platform.initialize(this.coreServices);
		}

		// 3. Register instruction providers from platforms
		const instructionService = this.coreServices.getInstructionService();
		if (instructionService) {
			for (const [name, platform] of this.platforms) {
				if (platform.getInstructionProvider) {
					const provider = platform.getInstructionProvider();
					if (provider) {
						instructionService.registerPlatformProvider(name, provider);
					}
				}
			}
		}

		// 4. Start all platforms
		for (const [name, platform] of this.platforms) {
			logger.debug(`Starting platform: ${name}`);
			await platform.start();
		}

		// 5. Start unified thread response consumer
		// Single consumer routes responses to platforms via registry
		this.unifiedConsumer = new UnifiedThreadResponseConsumer(
			this.coreServices.getQueue(),
			platformRegistry,
			this.coreServices.getSseManager(),
		);
		// Output-stage guardrails for the API/SSE path. ChatResponseBridge runs
		// output guardrails for chat platforms; pure API/SSE rows (web SPA +
		// programmatic Agent API) route through ApiResponseRenderer, which has no
		// guardrail hook — wire them on the consumer so secret-scan/pii-scan
		// configured via `defineAgent` enforce on the API surface too.
		this.unifiedConsumer.setOutputGuardrails(
			this.coreServices.getGuardrailRegistry() ?? undefined,
			this.coreServices.getAgentSettingsStore() ?? undefined,
		);
		await this.unifiedConsumer.start();

		// 6. Start the turn-liveness deadline sweep — the cross-replica backstop
		// that fails a turn whose worker hung or whose pod died (the fast path in
		// DeploymentManager covers an observed crash instantly).
		startTurnTimeoutSweep();

		this.isRunning = true;
	}

	/**
	 * Stop the gateway gracefully
	 * 1. Stop unified consumer if running
	 * 2. Stop all platforms
	 * 3. Shutdown core services
	 */
	async stop(): Promise<void> {
		logger.info("Stopping gateway...");

		// Stop the turn-liveness deadline sweep (symmetric with start()).
		stopTurnTimeoutSweep();

		// Stop unified consumer if running
		if (this.unifiedConsumer) {
			logger.info("Stopping unified thread response consumer");
			try {
				await this.unifiedConsumer.stop();
			} catch (error) {
				logger.error("Failed to stop unified consumer:", error);
			}
		}

		// Stop all platforms
		for (const [name, platform] of this.platforms) {
			logger.info(`Stopping platform: ${name}`);
			try {
				await platform.stop();
			} catch (error) {
				logger.error(`Failed to stop platform ${name}:`, error);
			}
		}

		// Shutdown core services
		await this.coreServices.shutdown();

		this.isRunning = false;
		logger.info("✅ Gateway stopped");
	}

	/**
	 * Get gateway status
	 */
	getStatus(): {
		isRunning: boolean;
		platforms: string[];
		config: Partial<GatewayConfig>;
	} {
		return {
			isRunning: this.isRunning,
			platforms: Array.from(this.platforms.keys()),
			config: {
				queues: this.config.queues,
			},
		};
	}

	/**
	 * Get core services (for platform adapters during initialization)
	 */
	getCoreServices(): CoreServices {
		return this.coreServices;
	}

	/**
	 * Get platform registry (for routes that need to access platform adapters)
	 */
	getPlatformRegistry() {
		return platformRegistry;
	}

	/**
	 * Get unified thread response consumer (for wiring Chat SDK response bridge)
	 */
	getUnifiedConsumer() {
		return this.unifiedConsumer;
	}
}
