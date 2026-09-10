#!/usr/bin/env bun

/**
 * API Platform Adapter
 * Handles direct API access for browser extensions, CLI clients, etc.
 * Does not require external platform integration (no Slack, Discord, etc.)
 */

import { randomUUID } from "node:crypto";
import {
  createLogger,
  type InstructionProvider,
  type ThreadResponsePayload,
} from "@lobu/core";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import { TERMINAL_DELIVERY_SEND_OPTS } from "../infrastructure/queue/index.js";
import type { CoreServices, PlatformAdapter } from "../platform.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import { ApiResponseRenderer } from "./response-renderer.js";

const logger = createLogger("api-platform");

/**
 * API Platform adapter for direct access via HTTP/SSE
 * This platform doesn't interact with external services like Slack or Discord.
 * Instead, it provides endpoints for:
 * - Creating sessions
 * - Sending messages
 * - Receiving streaming responses via SSE
 * - Handling tool approvals
 */
export class ApiPlatform implements PlatformAdapter {
  readonly name = "api";

  private responseRenderer?: ApiResponseRenderer;
  private isRunning = false;
  private services?: CoreServices;

  /**
   * Initialize with core services
   */
  async initialize(services: CoreServices): Promise<void> {
    logger.debug("Initializing API platform...");

    this.services = services;
    const sseManager = services.getSseManager();

    // Create response renderer for routing worker responses to SSE clients
    this.responseRenderer = new ApiResponseRenderer(sseManager);

    // Subscribe to interaction events and deliver them to SSE clients.
    //
    // These cards (ask_user question, tool-approval, link-button, status
    // message) are raised by the worker on ITS pod, but the browser's SSE
    // stream is pinned by ClientIP
    // affinity to a possibly DIFFERENT pod. The SseManager is per-pod and
    // in-memory, so broadcasting directly here would land the card on the
    // worker's pod, which the browser is not connected to — the user never sees
    // it and the turn hangs. Instead we enqueue each card onto the Postgres
    // thread_response queue marked `requireSseOwner`, so the consumer's
    // owner-routing re-queue delivers it on the pod that holds the SSE socket
    // (same mechanism that already owner-routes terminal API completions).
    const interactionService = services.getInteractionService();
    const queue = services.getQueue();

    interactionService.on("question:created", (event: any) => {
      if (event.platform !== "api") return;
      this.enqueueInteractionCard(queue, event, "question", {
        type: "question",
        questionId: event.id,
        question: event.question,
        options: event.options,
      });
    });

    interactionService.on("link-button:created", (event: any) => {
      if (event.platform !== "api") return;
      this.enqueueInteractionCard(queue, event, "link-button", {
        type: "link-button",
        url: event.url,
        label: event.label,
        linkType: event.linkType,
      });
    });

    // Suggested follow-up chips use the same owner-routed queue as every other
    // API card. The consumer re-reads the durable current set immediately
    // before broadcasting, so a delayed card cannot replay stale prompts over a
    // newer turn's terminal state.
    interactionService.on("suggestion:created", (event: any) => {
      if (event.platform !== "api") return;
      // No prompts here on purpose — the consumer fills them from durable state
      // at broadcast time, so this row carries only routing.
      this.enqueueInteractionCard(queue, event, "suggestion", {
        type: "suggestion",
      });
    });

    interactionService.on("tool:approval-needed", (event: any) => {
      if (event.platform !== "api") return;
      this.enqueueInteractionCard(queue, event, "tool-approval", {
        type: "tool-approval",
        requestId: event.id,
        mcpId: event.mcpId,
        toolName: event.toolName,
        args: event.args,
        grantPattern: event.grantPattern,
        durationOptions: ["1h", "24h", "always"],
      });
    });

    // Durable approval card (runs/events-backed — an agent's manage_agents
    // write gate). Same SSE event name ("tool-approval") + same
    // owner-gated thread_response delivery as the MCP grant above, but the
    // payload carries run_id + action + the proposed-vs-current diff so the SPA
    // ToolApprovalPart renders the interactive Approve/Reject card. The chat
    // bridge does NOT subscribe to this event, so it never mis-renders it.
    interactionService.on("tool:durable-approval-card", (event: any) => {
      if (event.platform !== "api") return;
      const resourceKind: string | null = event.resourceKind ?? null;
      const toolName =
        event.fields
          ? "manage_entity"
          : resourceKind === "automation"
            ? "manage_automations"
            : "manage_agents";
      this.enqueueInteractionCard(queue, event, "tool-approval", {
        type: "tool-approval",
        requestId: event.id,
        runId: event.runId,
        action: event.cardAction,
        proposal: event.proposal ?? null,
        current: event.current ?? null,
        // entity_field_change carries a human-owned-field diff + attribution;
        // the SPA routes on `fields` (non-empty) to the entity-field-change
        // card. manage_agents leaves these null and renders its agent-row diff.
        fields: event.fields ?? null,
        attribution: event.attribution ?? null,
        resourceKind,
        toolName,
      });
    });

    logger.debug("✅ API platform initialized");
  }

  /**
   * Enqueue an interaction card onto the thread_response queue so the pod that
   * owns the browser's SSE connection delivers it (cross-replica safe). The
   * consumer broadcasts `customEvent.name` on `conversationId`; the
   * `requireSseOwner` flag makes a non-owning pod re-queue rather than drop it.
   */
  private enqueueInteractionCard(
    queue: IMessageQueue,
    event: {
      conversationId: string;
      organizationId?: string;
      userId?: string;
      source?: string;
      turnMessageId?: string;
    },
    name: string,
    data: Record<string, unknown>
  ): void {
    const payload: ThreadResponsePayload = {
      messageId: randomUUID(),
      conversationId: event.conversationId,
      // For the API platform channelId == conversationId == the SSE key.
      channelId: event.conversationId,
      userId: event.userId ?? "api",
      organizationId: event.organizationId,
      platform: "api",
      teamId: "api",
      timestamp: Date.now(),
      // Stamp the headless run origin so the owner-gate exempts cards from
      // headless turns — no browser SSE exists on any pod for them, so an
      // owner-gated card would re-queue 30x and dead-letter. Interactive turns
      // carry no source and stay owner-routed.
      ...(event.source
        ? { platformMetadata: { source: event.source } }
        : {}),
      customEvent: { name, data: { ...data, turnMessageId: event.turnMessageId }, requireSseOwner: true },
    };
    void queue
      .send("thread_response", payload, TERMINAL_DELIVERY_SEND_OPTS)
      .catch((err) => {
        logger.error(
          `Failed to enqueue ${name} interaction card for ${event.conversationId}:`,
          err
        );
      });
  }

  /**
   * Start the platform
   * For API platform, this is mostly a no-op since routes are registered separately
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.debug("✅ API platform started");
  }

  /**
   * Stop the platform
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.debug("✅ API platform stopped");
  }

  /**
   * Check if platform is healthy
   */
  isHealthy(): boolean {
    return this.isRunning;
  }

  /**
   * No custom instruction provider for API platform
   */
  getInstructionProvider(): InstructionProvider | null {
    return null;
  }

  /**
   * Get the response renderer for routing worker responses
   */
  getResponseRenderer(): ResponseRenderer | undefined {
    return this.responseRenderer;
  }

  /**
   * Send a message via API platform
   * Creates or reuses a session and queues the message for processing
   *
   * @param token - Auth token (used to derive userId)
   * @param message - Message content
   * @param options - Routing info (agentId = channelId = conversationId for API)
   */
  async sendMessage(
    token: string,
    message: string,
    options: {
      agentId: string;
      organizationId: string;
      channelId: string;
      conversationId: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }> {
    if (!this.services) {
      throw new Error("API platform not initialized");
    }

    const { agentId, organizationId } = options;
    const sessionManager = this.services.getSessionManager();
    const queueProducer = this.services.getQueueProducer();
    const messageId = randomUUID();
    const userId = `api-${token.slice(0, 8) || "anonymous"}`;

    // For API platform: agentId = channelId = conversationId (all same)
    // Try to get existing session or create new one
    let session = await sessionManager.getSession(agentId);

    if (!session) {
      session = {
        conversationId: agentId,
        channelId: agentId,
        userId,
        threadCreator: userId,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        status: "created",
        provider: "claude",
        organizationId,
      };

      await sessionManager.setSession(session);
      logger.info(`Created new API session: ${agentId}`);
    } else if (session.organizationId !== organizationId) {
      throw new Error(
        `API session ${agentId} is not scoped to organization ${organizationId}`,
      );
    }

    // Update session activity
    await sessionManager.touchSession(agentId);

    // Carry the authoritative organization scope so downstream guardrails and
    // response routing cannot fall back to stale session metadata.
    const platformMetadata: Record<string, any> = {
      agentId,
      source: "messaging-api",
      organizationId,
    };

    if (options.files && options.files.length > 0) {
      platformMetadata.fileCount = options.files.length;
      platformMetadata.fileNames = options.files.map((f) => f.filename);
      logger.info(
        `Message includes ${options.files.length} file(s): ${platformMetadata.fileNames.join(", ")}`
      );
    }

    // Enqueue message for worker processing
    await queueProducer.enqueueMessage({
      userId,
      conversationId: agentId,
      messageId,
      channelId: agentId,
      teamId: "api",
      agentId: agentId,
      organizationId,
      botId: "lobu-api",
      platform: "api",
      messageText: message,
      platformMetadata,
      agentOptions: {
        provider: session.provider || "claude",
      },
    });

    logger.info(`Queued message ${messageId} for agent ${agentId}`);

    const publicUrl = this.services.getPublicGatewayUrl();
    const baseUrl = publicUrl || "http://localhost:8080";

    return {
      messageId,
      eventsUrl: `${baseUrl}/api/v1/agents/${agentId}/events`,
      queued: true,
    };
  }
}
