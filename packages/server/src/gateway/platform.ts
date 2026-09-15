#!/usr/bin/env bun

import type {
  AgentConnectionStore,
  CommandRegistry,
  InstructionProvider,
} from "@lobu/core";
import type { AgentMetadataStore } from "./auth/agent-metadata-store.js";
import type { McpConfigService } from "./auth/mcp/config-service.js";
import type { McpProxy } from "./auth/mcp/proxy.js";
import type { ProviderOAuthStateStore } from "./auth/oauth/state-store.js";
import type { ProviderCatalogService } from "./auth/provider-catalog.js";
import type { AgentSettingsStore } from "./auth/settings/agent-settings-store.js";
import type { ModelPreferenceStore } from "./auth/settings/model-preference-store.js";
import type { UserAgentsStore } from "./auth/user-agents-store.js";
import type { AutomationSubscriptionService } from "./channels/automation-subscription-service.js";
import type { ArtifactStore } from "./files/artifact-store.js";
import type { WorkerGateway } from "./worker-dispatch/worker-gateway.js";
import type {
  IMessageQueue,
  QueueProducer,
} from "./infrastructure/queue/index.js";
import type { InteractionService } from "./interactions.js";
import type { GrantStore } from "./permissions/grant-store.js";
import type { IFileHandler } from "./platform/file-handler.js";
import type { ResponseRenderer } from "./platform/response-renderer.js";
import type { SecretProxy } from "./proxy/secret-proxy.js";
import type { WritableSecretStore } from "./secrets/index.js";
import type { DeclaredAgentRegistry } from "./services/declared-agent-registry.js";
import type { InstructionService } from "./services/instruction-service.js";
import type { AppInstallationStore } from "../lobu/stores/app-installation-store.js";
import type { SseManager } from "./services/sse-manager.js";
import type { TranscriptionService } from "./services/transcription-service.js";
import type { ISessionManager } from "./session.js";

// ============================================================================
// Core Services Interface
// ============================================================================

/**
 * Core services interface that platforms receive during initialization
 * This allows platforms to access shared infrastructure without tight coupling
 */
export interface CoreServices {
  getQueue(): IMessageQueue;
  getQueueProducer(): QueueProducer;
  getSecretProxy(): SecretProxy | undefined;
  getSecretStore(): WritableSecretStore;
  getWorkerGateway(): WorkerGateway | undefined;
  getMcpProxy(): McpProxy | undefined;
  getMcpConfigService(): McpConfigService | undefined;
  getModelPreferenceStore(): ModelPreferenceStore | undefined;
  getOAuthStateStore(): ProviderOAuthStateStore | undefined;
  getPublicGatewayUrl(): string;
  getArtifactStore(): ArtifactStore;
  getSessionManager(): ISessionManager;
  getInstructionService(): InstructionService | undefined;
  getInteractionService(): InteractionService;
  getSseManager(): SseManager;
  getAgentSettingsStore(): AgentSettingsStore;
  getAutomationSubscriptionService(): AutomationSubscriptionService;
  getTranscriptionService(): TranscriptionService | undefined;
  getUserAgentsStore(): UserAgentsStore;
  getAgentMetadataStore(): AgentMetadataStore;
  getCommandRegistry(): CommandRegistry;
  getGrantStore(): GrantStore | undefined;
  getDeclaredAgentRegistry(): DeclaredAgentRegistry | undefined;
  getConnectionStore(): AgentConnectionStore | undefined;
  getAppInstallationStore(): AppInstallationStore;
  getProviderCatalogService?(): ProviderCatalogService;
}

// ============================================================================
// Platform Adapter Interface
// ============================================================================

/**
 * Interface that all platform adapters must implement
 * Platforms include: Slack, Discord, Teams, etc.
 *
 * Each platform adapter:
 * 1. Receives CoreServices during initialization
 * 2. Sets up platform-specific event handlers
 * 3. Manages its own platform client/connection
 * 4. Uses core services (MCP, Anthropic, queue, etc.) provided by Gateway
 */
export interface PlatformAdapter {
  /**
   * Platform name
   */
  readonly name: string;

  /**
   * Initialize the platform with core services
   * This is called by Gateway after core services are initialized
   *
   * @param services - Core services provided by Gateway
   */
  initialize(services: CoreServices): Promise<void>;

  /**
   * Start the platform (connect to platform API, start event listeners)
   * This is called after initialization
   */
  start(): Promise<void>;

  /**
   * Stop the platform gracefully
   */
  stop(): Promise<void>;

  /**
   * Check if platform is healthy and running
   */
  isHealthy(): boolean;

  /**
   * Optionally provide platform-specific instruction provider
   * Returns null if platform doesn't have custom instructions
   */
  getInstructionProvider?(): InstructionProvider | null;

  /**
   * Send a message via the messaging API
   * Uses polymorphic routing info extracted from the request
   *
   * @param token - Auth token from request
   * @param message - Message text to send (use @me to mention the bot)
   * @param options - Routing and file options
   * @param options.agentId - Universal session identifier
   * @param options.channelId - Platform-specific channel (or agentId for API)
   * @param options.conversationId - Platform-specific conversation (or agentId for API)
   * @param options.teamId - Platform-specific team/workspace
   * @param options.callerUserId - The AUTHENTICATED caller's identity, as the
   *   route's auth context resolved it. This is the value a blocked tool call
   *   stores as the pending approval's claimant, and the same value the
   *   approver later presents on `POST /api/v1/agents/approve` — so it MUST be
   *   the real subject id. Deriving one from the token bytes instead bound
   *   approvals to an identity no caller could ever present.
   * @param options.files - Files to upload with the message (up to 10)
   * @returns Message metadata
   */
  sendMessage?(
    token: string,
    message: string,
    options: {
      agentId: string;
      organizationId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
      callerUserId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }>;

  /**
   * Hydrate the connection's instance on this replica from its stored row.
   * Connections are lazy (no boot warm-start), so synchronous lookups like
   * `getFileHandler` must be preceded by this on pods that haven't served
   * the connection yet. Returns false when the connection can't run here
   * (missing, stopped, exclusive-transport owned by another replica).
   */
  warmConnection?(connectionId: string): Promise<boolean>;

  /**
   * Get the file handler for this platform.
   * Used by the file upload/download routes to route files
   * to the correct platform-specific handler.
   */
  getFileHandler?(options?: {
    connectionId?: string;
    channelId?: string;
    conversationId?: string;
    teamId?: string;
  }): IFileHandler | undefined;

  /**
   * Get the response renderer for this platform.
   * Used by the unified thread response consumer to route responses
   * to platform-specific rendering logic.
   *
   * @returns ResponseRenderer instance or undefined if platform handles responses differently
   */
  getResponseRenderer?(): ResponseRenderer | undefined;

  /**
   * Extract routing info from platform-specific request body.
   * Used by messaging API to parse platform-specific fields.
   *
   * @param body - Request body with platform-specific fields
   * @returns Routing info or null if platform fields are missing/invalid
   */
  extractRoutingInfo?(body: Record<string, unknown>): {
    channelId: string;
    conversationId?: string;
    teamId?: string;
  } | null;
}

// ============================================================================
// Platform Registry
// ============================================================================

/**
 * Global registry for platform adapters
 * Allows deployment managers and other services to access platform-specific functionality
 */
export class PlatformRegistry {
  private platforms: Map<string, PlatformAdapter> = new Map();

  /**
   * Register a platform adapter
   */
  register(platform: PlatformAdapter): void {
    this.platforms.set(platform.name, platform);
  }

  /**
   * Get a platform by name
   */
  get(name: string): PlatformAdapter | undefined {
    return this.platforms.get(name);
  }

  /**
   * Get list of available platform names
   */
  getAvailablePlatforms(): string[] {
    return Array.from(this.platforms.keys());
  }
}

/**
 * Global platform registry instance
 */
export const platformRegistry = new PlatformRegistry();
