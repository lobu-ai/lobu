#!/usr/bin/env bun

import type {
  ConfigProviderMeta,
  InstructionContext,
  WorkerTokenData,
} from "@lobu/core";
import {
  AgentErrorCode,
	createLogger,
	generateWorkerToken,
	encrypt,
	verifyWorkerToken,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import {
  AUTOMATION_RUN_SOURCE,
  type AutomationRunSkillResolver,
  formatAutomationRunSkillInstructions,
  resolveAutomationRunSkills,
} from "../automation-run-session.js";
import { toPublicWebOrigin } from "../../utils/url-builder.js";
import type { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { McpProxy } from "../auth/mcp/proxy.js";
import type { McpTool } from "../auth/mcp/tool-cache.js";
import { isUnresolvedModelRef } from "../auth/model-sentinel.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import { composeEffectiveModelRef } from "../auth/settings/model-selection.js";
import { getOrgDefaultModel } from "../../lobu/stores/provider-secrets.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import {
  commitTerminalReply,
  extendTurnDeadlines,
  hasLiveTurnForMessage,
} from "../orchestration/turn-liveness.js";
import type { InstructionService } from "../services/instruction-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  WorkerConnectionManager,
} from "./connection-manager.js";
import { createTranscriptRoutes } from "./transcript-routes.js";

const logger = createLogger("worker-gateway");

/**
 * Minimal seam onto the deployment manager's idle clock. Any worker-driven
 * signal (HTTP response / ACK) must refresh the deployment's `lastActivity` so
 * the idle reaper doesn't scale a long-running-but-active worker to 0 mid-turn.
 * Narrow on purpose: the gateway only needs to touch the idle clock, not the
 * full deployment lifecycle.
 */
export interface DeploymentActivityTracker {
  updateDeploymentActivity(deploymentName: string): Promise<void>;
}

/**
 * Worker Gateway - SSE and HTTP endpoints for worker communication
 * Workers connect via SSE to receive jobs, send responses via HTTP POST
 * Uses encrypted tokens for authentication and routing
 */
export class WorkerGateway {
  private app: Hono;
  private connectionManager: WorkerConnectionManager;
  private queue: IMessageQueue;
  private mcpConfigService: McpConfigService;
  private instructionService: InstructionService;
  private publicGatewayUrl: string;
  private mcpProxy?: McpProxy;
  private providerCatalogService?: ProviderCatalogService;
  private agentSettingsStore?: AgentSettingsStore;
  private automationRunSkillResolver: AutomationRunSkillResolver;
  private deploymentActivityTracker?: DeploymentActivityTracker;

  constructor(
    queue: IMessageQueue,
    publicGatewayUrl: string,
    mcpConfigService: McpConfigService,
    instructionService: InstructionService,
    mcpProxy?: McpProxy,
    providerCatalogService?: ProviderCatalogService,
    agentSettingsStore?: AgentSettingsStore,
    automationRunSkillResolver: AutomationRunSkillResolver = resolveAutomationRunSkills
  ) {
    this.queue = queue;
    this.publicGatewayUrl = publicGatewayUrl;
    this.connectionManager = new WorkerConnectionManager();
    this.mcpConfigService = mcpConfigService;
    this.instructionService = instructionService;
    this.mcpProxy = mcpProxy;
    this.providerCatalogService = providerCatalogService;
    this.agentSettingsStore = agentSettingsStore;
    this.automationRunSkillResolver = automationRunSkillResolver;

    // Setup Hono app
    this.app = new Hono();
    this.setupRoutes();
  }

  /**
   * Get the Hono app
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Get the connection manager (for sending SSE notifications from external routes)
   */
  getConnectionManager(): WorkerConnectionManager {
    return this.connectionManager;
  }

  /**
   * Wire the deployment manager's idle clock. Injected after construction
   * because the gateway and the orchestrator (which owns the deployment
   * manager) are built separately, and optional — the base manager's
   * implementation is a no-op in the isolate lane, where a turn is claimed
   * over HTTP and there is no worker process to keep alive or reap.
   */
  setDeploymentActivityTracker(tracker: DeploymentActivityTracker): void {
    this.deploymentActivityTracker = tracker;
  }

  /**
   * Setup routes on Hono app
   */
  private setupRoutes() {
    // SSE endpoint for workers to receive jobs
    // Routes are mounted at /worker, so paths here should be relative

    // HTTP POST endpoint for workers to send responses
    this.app.post("/response", (c) => this.handleWorkerResponse(c));

    // Unified session context endpoint (includes MCP + instructions)
    this.app.get("/session-context", (c) =>
      this.handleSessionContextRequest(c)
    );

    // Mint a fresh worker token while the deployment still has live work.
    // Lets a warm worker (or a single turn running past the 2h TTL) keep a
    // non-expired token without lengthening the TTL — see handler.
    this.app.post("/token/refresh", (c) => this.handleTokenRefresh(c));

    // Per-run transcript snapshots — backs the multi-replica unblock.
    // Workers hydrate from the latest completed snapshot on boot and POST
    // a new snapshot on every terminal state. The routes themselves are
    // always mounted (gated by the JWT scope check inside).
    this.app.route("/transcript", createTranscriptRoutes());

    logger.debug("Worker gateway routes registered");
  }

  private enrichMcpStatus(
    mcpStatus: Array<{
      id: string;
      name: string;
      requiresAuth: boolean;
      requiresInput: boolean;
    }>
  ): Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput: boolean;
    authenticated: boolean;
    configured: boolean;
  }> {
    return mcpStatus.map((mcp) => ({
      ...mcp,
      authenticated: false,
      configured: !mcp.requiresInput,
    }));
  }

  /**
   * Resolve the reply-to-source Automation selected for this exact queued turn.
   *
   * platformMetadata in a worker response is attacker-controlled. The signed
   * per-run token carries the queued runs.id rather than an Automation id;
   * re-reading that durable gateway-written row binds the Automation id to the
   * planner decision without putting per-turn state on the deployment-lifetime
   * fallback token. Missing per-run identity degrades safely to no schedule
   * mutation. Database errors propagate so a terminal quota reply is retried
   * rather than delivered with an untrusted id.
   */
  private async resolveTrustedAutomationId(
    tokenData: WorkerTokenData
  ): Promise<number | undefined> {
    const { runId, organizationId, agentId, messageId } = tokenData;
    if (
      typeof runId !== "number" ||
      !Number.isSafeInteger(runId) ||
      runId < 1 ||
      !organizationId ||
      !agentId
    ) {
      return undefined;
    }

    const rows = await getDb()<{
      payload: {
        organizationId?: unknown;
        agentId?: unknown;
        messageId?: unknown;
        platformMetadata?: unknown;
      } | null;
    }>`
      SELECT CASE
        WHEN jsonb_typeof(action_input) = 'string'
          THEN (action_input #>> '{}')::jsonb
        ELSE action_input
      END AS payload
      FROM public.runs
      WHERE id = ${runId}
        AND run_type = 'chat_message'
        AND organization_id = ${organizationId}
      LIMIT 1
    `;
    const payload = rows[0]?.payload;
    if (
      !payload ||
      payload.organizationId !== organizationId ||
      payload.agentId !== agentId ||
      (messageId && payload.messageId !== messageId)
    ) {
      return undefined;
    }

    const metadata = payload.platformMetadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return undefined;
    }
    const automationId = (metadata as { automationId?: unknown }).automationId;
    return typeof automationId === "number" &&
      Number.isSafeInteger(automationId) &&
      automationId > 0
      ? automationId
      : undefined;
  }

  /**
   * Handle HTTP response from worker
   */
  private async handleWorkerResponse(c: Context): Promise<Response> {
    const auth = await this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { deploymentName } = auth.tokenData;

    // SSE stale-cleanup clock: every worker HTTP response (including pure
    // heartbeats) proves the SSE connection is still alive.
    this.connectionManager.touchConnection(deploymentName);

    try {
      const body = await c.req.json();
      const { jobId, ...responseData } = body;
      // A worker may be compromised, so the response body is never authoritative
      // for routing. Rebuild every destination-bearing field from the signed
      // token and retain only non-routing metadata from the body. In particular,
      // an absent connectionId must remove a body-supplied value rather than
      // turning a non-chat run into a cross-tenant Chat delivery.
      const trustedAutomationId =
        responseData.errorCode === AgentErrorCode.PROVIDER_QUOTA_EXHAUSTED
          ? await this.resolveTrustedAutomationId(auth.tokenData)
          : undefined;
      const tokenRouting = {
        userId: auth.tokenData.userId,
        conversationId: auth.tokenData.conversationId,
        channelId: auth.tokenData.channelId,
        teamId: auth.tokenData.teamId,
        platform: auth.tokenData.platform,
        organizationId: auth.tokenData.organizationId,
      };
      const tokenMetadata = {
        connectionId: auth.tokenData.connectionId,
        agentId: auth.tokenData.agentId,
        organizationId: tokenRouting.organizationId,
        chatId: tokenRouting.channelId,
        responseChannel: tokenRouting.channelId,
        responseThreadId: auth.tokenData.responseThreadId,
        teamId: tokenRouting.teamId,
        source: auth.tokenData.source,
        senderId: tokenRouting.userId,
        automationId: trustedAutomationId,
      };
      const platformMetadata =
        responseData.platformMetadata &&
        typeof responseData.platformMetadata === "object" &&
        !Array.isArray(responseData.platformMetadata)
          ? { ...responseData.platformMetadata }
          : {};
      const bodyCustomEvent = responseData.customEvent;
      const bodyCustomEventData = bodyCustomEvent?.data;
      const bodyInteractionEvent = bodyCustomEventData?.event;
      const customEvent =
        bodyCustomEvent?.name === "chat-interaction" &&
        bodyCustomEventData &&
        typeof bodyCustomEventData === "object" &&
        bodyInteractionEvent &&
        typeof bodyInteractionEvent === "object" &&
        !Array.isArray(bodyInteractionEvent)
          ? {
              ...bodyCustomEvent,
              data: {
                ...bodyCustomEventData,
                event: {
                  ...bodyInteractionEvent,
                  ...tokenRouting,
                  connectionId: tokenMetadata.connectionId,
                  agentId: tokenMetadata.agentId,
                  source: tokenMetadata.source,
                },
              },
            }
          : bodyCustomEvent;
      const enrichedResponse = {
        ...responseData,
        ...tokenRouting,
        customEvent,
        platformMetadata: {
          ...platformMetadata,
          ...tokenMetadata,
        },
      };

      // Refresh the deployment idle clock, skipping pure heartbeat ACKs: they
      // fire forever on a warm idle worker, so counting them as activity is
      // what made idle cleanup a no-op under the subprocess lane (16× ~180MB
      // children stuck forever, the dominant prod OOM cost).
      //
      // The isolate lane has no child to reap, so the tracker's default
      // implementation is a no-op — this stays wired for the injected-tracker
      // seam (`setDeploymentActivityTracker`) and to keep the skip rule with
      // the ACK it describes. Mid-turn liveness does NOT depend on it:
      // `extendTurnDeadlines` below is what keeps a live-but-slow turn safe.
      const isHeartbeatOnlyAck = !!(
        enrichedResponse.received && enrichedResponse.heartbeat
      );
      if (!isHeartbeatOnlyAck) {
        void this.deploymentActivityTracker
          ?.updateDeploymentActivity(deploymentName)
          .catch((err) => {
            logger.warn(
              `[WORKER-GATEWAY] Failed to refresh deployment activity for ${deploymentName}: ${err}`
            );
          });
      }

      // Delivery receipts (worker ACKs) have no message payload — just acknowledge and return
      if (enrichedResponse.received) {
        if (enrichedResponse.heartbeat) {
          logger.debug(
            `[WORKER-GATEWAY] Received heartbeat ACK from ${deploymentName}`
          );
        }
        // A worker ACK (delivery receipt or heartbeat) is a worker-driven
        // liveness signal — push the turn-liveness deadline forward so a live
        // but slow worker is never falsely failed by the sweep. Best-effort.
        void extendTurnDeadlines(deploymentName);
        return c.json({ success: true });
      }

      // The worker's 20s status_update (HEARTBEAT_INTERVAL_MS in
      // session-runner.ts) carries `statusUpdate` and NO `received` flag, so it
      // falls through the ACK block above. It is the most frequent worker-driven
      // liveness signal — far more frequent than the 30s SSE-ping ACK — so it
      // must refresh the turn-liveness deadline too, otherwise a live worker
      // emitting status updates every 20s could still lapse the 60s deadline on
      // ~2 consecutive missed ping ACKs and be falsely failed by the sweep.
      // Best-effort, same as the ACK path.
      if (enrichedResponse.statusUpdate) {
        void extendTurnDeadlines(deploymentName);
      }

      // Log for debugging
      logger.info(
        `[WORKER-GATEWAY] Received response with fields: ${Object.keys(enrichedResponse).join(", ")}`
      );
      if (enrichedResponse.delta) {
        logger.info(
          `[WORKER-GATEWAY] Stream delta: deltaLength=${enrichedResponse.delta.length}`
        );
      }

      // Send response to thread_response queue. TERMINAL rows (success
      // completion via processedMessageIds, or error) are subject to the API
      // owner-gate in routeToRenderer — a non-owning replica re-queues them —
      // so they need the elevated retry budget to survive cross-pod hand-off.
      // Non-terminal deltas/status keep default options (not owner-gated).
      const isTerminalResponse = !!(
        enrichedResponse.error ||
        (Array.isArray(enrichedResponse.processedMessageIds) &&
          enrichedResponse.processedMessageIds.length > 0)
      );

      if (isTerminalResponse) {
        // The worker produced a real terminal reply (success or explicit
        // error). Persist the reply AND discharge the turn-liveness marker(s)
        // for the message(s) it processed in ONE transaction — so a pod crash
        // can't leave a surviving marker that the sweep would later turn into a
        // duplicate "worker stopped" error. The terminal row carries the
        // elevated retry budget (applied inside commitTerminalReply) so it
        // survives the owner-gate re-queue to the SSE-holding pod.
        const dischargeIds = new Set<string>();
        if (typeof enrichedResponse.messageId === "string") {
          dischargeIds.add(enrichedResponse.messageId);
        }
        for (const id of enrichedResponse.processedMessageIds ?? []) {
          if (typeof id === "string") dischargeIds.add(id);
        }
        await commitTerminalReply(
          deploymentName,
          [...dischargeIds],
          enrichedResponse,
          (enrichedResponse.organizationId as string | undefined) ?? null
        );
      } else {
        // Non-terminal (delta / status): best-effort, not owner-gated.
        await this.queue.send("thread_response", enrichedResponse);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error(`Error handling worker response: ${error}`);
      return c.json({ error: "Failed to process response" }, 500);
    }
  }

  /**
   * Unified session context endpoint
   */
  private async handleSessionContextRequest(c: Context): Promise<Response> {
    if (!this.mcpConfigService || !this.instructionService) {
      return c.json({ error: "session_context_unavailable" }, 503);
    }

    const auth = await this.authenticateWorker(c);
    if (!auth) {
      return c.json({ error: "Invalid token" }, 401);
    }

    try {
      const {
        userId,
        platform,
        sessionKey,
        conversationId,
        agentId,
        deploymentName,
      } = auth.tokenData;
      const baseUrl = this.getRequestBaseUrl(c);
      if (!conversationId) {
        return c.json({ error: "Invalid token (missing conversationId)" }, 401);
      }

      // CROSS-TENANT GUARD (hoisted): compute org-scope safety ONCE, before any
      // agent-scoped read (instructions, MCP, skills, model). A DB-backed agent's
      // settings read MUST be org-scoped — the worker token can be orgless, and a
      // shared id (e.g. "lobu-builder", present in every org) would id-only read
      // ANOTHER org's identity/soul/skills/MCP-slug and ship it to the worker.
      // Declared (SDK-embedded) agents are org-agnostic, so they resolve without
      // an org. When `!orgScopedOk` for a DB-backed agent we deny ALL agent-scoped
      // reads (fail closed to generic/no-agent access semantics).
      const tokenOrgId = auth.tokenData.organizationId;
      // ORG-AWARE declared check: a declared id that ALSO has a real DB row in
      // the token's org is DB-backed (the DB row wins), so a collision cannot
      // flip the orgless guard open for a tenant's agent. Falls back to the
      // synchronous membership check for a store without the org-aware method.
      const store = this.agentSettingsStore;
      const isDeclared =
        !!agentId && store
          ? store.isDeclaredAgentScoped
            ? await store.isDeclaredAgentScoped(agentId, tokenOrgId)
            : (store.isDeclaredAgent?.(agentId) ?? false)
          : false;
      const orgScopedOk = !!tokenOrgId || isDeclared;

      // Build instruction context
      const instructionContext: InstructionContext = {
        userId,
        agentId: agentId || "",
        connectionId: auth.tokenData.connectionId,
        organizationId: tokenOrgId,
        // Instruction providers skip their by-id settings read when this is
        // false (orgless DB-backed agent) and use the generic branch.
        orgScoped: orgScopedOk,
        sessionKey: sessionKey || "",
        workingDirectory: "/workspace",
        availableProjects: [],
      };

      // Build settings URL as a short-lived claim link so platform users
      // can open it without a pre-existing browser session.
      const CLAIM_TTL_MS = 10 * 60 * 1000; // 10 minutes
      const claimToken = encrypt(
        JSON.stringify({
          userId,
          platform: platform || "unknown",
          agentId: agentId || undefined,
          exp: Date.now() + CLAIM_TTL_MS,
        })
      );
      const settingsUrl = new URL("/connect/claim", baseUrl);
      settingsUrl.searchParams.set("claim", claimToken);
      if (agentId) {
        settingsUrl.searchParams.set("agent", agentId);
      }

      // Fetch MCP config and session context in parallel
      const [mcpConfig, contextData] = await Promise.all([
        this.mcpConfigService.getWorkerConfig({
          baseUrl,
          workerToken: auth.token,
          deploymentName,
        }),
        this.instructionService.getSessionContext(
          platform || "unknown",
          instructionContext,
          { settingsUrl: settingsUrl.toString() }
        ),
      ]);

      const enrichedMcpStatus = this.enrichMcpStatus(contextData.mcpStatus);

      // Fetch tool lists and instructions for ALL MCPs (unauthenticated ones
      // will attempt discovery without credentials)
      const mcpTools: Record<string, McpTool[]> = {};
      const mcpInstructions: Record<string, string> = {};
      if (this.mcpProxy && enrichedMcpStatus.length > 0) {
        const toolResults = await Promise.allSettled(
          enrichedMcpStatus.map(async (mcp) => {
            const result = await this.mcpProxy?.fetchToolsForMcp(
              mcp.id,
              agentId || userId,
              auth.tokenData,
              auth.token
            );
            return { mcpId: mcp.id, ...(result || { tools: [] }) };
          })
        );

        for (const result of toolResults) {
          if (result.status === "fulfilled") {
            if (result.value.tools && result.value.tools.length > 0) {
              mcpTools[result.value.mcpId] = result.value.tools;
            }
            if (result.value.instructions) {
              mcpInstructions[result.value.mcpId] = result.value.instructions;
            }
          } else {
            logger.error("MCP tool fetch rejected", {
              reason:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }
      }

      // Resolve dynamic provider configuration. The org-scope guard
      // (tokenOrgId / orgScopedOk) was hoisted above — a DB-backed agent with no
      // org reads nothing here (fail closed). `agentSettings` is null in that
      // case, which is ALSO the correct fail-closed value the skills-sync below
      // reuses (no duplicate id-only read).
      const agentSettings =
        this.agentSettingsStore && agentId && orgScopedOk
          ? await this.agentSettingsStore.getSettings(agentId, {
              organizationId: tokenOrgId,
            })
          : null;
      // The layered fallback default (agent models[0] or org default). For a
      // non-empty models list this is models[0] — which may be a SENTINEL.
      const layeredDefault = orgScopedOk
        ? await composeEffectiveModelRef(agentSettings, tokenOrgId, getOrgDefaultModel)
        : undefined;
      // Resolve the EFFECTIVE dispatch model through the SAME shared resolver the
      // enqueue gate uses: when models[0] is a sentinel but a later listed ref is
      // real+routable, this picks that ref (e.g. ["chatgpt/__unresolved__",
      // "openai/gpt-5"] → "openai/gpt-5" with the OpenAI module published). Only
      // an all-sentinel / nothing-routable list — or an orgless DB-backed agent
      // (resolveDispatchModel then reads not-found → deny) — yields undefined
      // (fail closed).
      const effectiveModel =
        agentId && this.providerCatalogService && orgScopedOk
          ? (
              await this.providerCatalogService.resolveDispatchModel(
                agentId,
                tokenOrgId,
                layeredDefault,
                userId
              )
            ).model
          : undefined;
      const providerConfig = await this.resolveProviderConfig(
        agentId || "",
        effectiveModel,
        baseUrl,
        auth.token,
        tokenOrgId,
        userId
      );

      // Enabled skills for worker filesystem sync. REUSE the org-scoped
      // `agentSettings` fetched above — it is null for an orgless DB-backed agent
      // (the correct fail-closed value: NO skill content leaks cross-tenant), and
      // this removes the duplicate id-only read that ignored the org guard.
      //
      // An Automation run uses version-pinned instructions, so the live library
      // must not re-enter the turn. Replace both live surfaces with the pinned
      // snapshot: `skillsConfig` syncs the frozen files, and the compact catalog
      // tells the agent which of those files this version requires.
      const automationRun = auth.tokenData.source === AUTOMATION_RUN_SOURCE;
      let skillsConfig: Array<{ name: string; content: string }> = [];
      const mcpContext: Record<string, string> = {};
      if (automationRun) {
        skillsConfig = await this.automationRunSkillResolver({
          conversationId,
          organizationId: tokenOrgId,
          agentId,
        });
      } else if (agentSettings) {
        const skills = agentSettings.skillsConfig?.skills || [];
        skillsConfig = skills
          .filter((s) => s.enabled && s.content)
          .map((s) => ({ name: s.name, content: s.content! }));
      }

      const mergedSkillsInstructions = automationRun
        ? formatAutomationRunSkillInstructions(skillsConfig)
        : contextData.skillsInstructions || "";

      logger.info(
        `Session context for ${userId}: ${Object.keys(mcpConfig.mcpServers || {}).length} MCPs, ${contextData.agentLayers.identityMd.length}/${contextData.agentLayers.soulMd.length}/${contextData.agentLayers.userMd.length} chars identity/soul/user, ${contextData.platformInstructions.length} chars platform instructions, ${contextData.networkInstructions.length} chars network instructions, ${mergedSkillsInstructions.length} chars skills instructions, ${enrichedMcpStatus.length} MCP status entries, ${Object.keys(mcpTools).length} MCP tool lists, ${Object.keys(mcpInstructions).length} MCP instructions, ${skillsConfig.length} skills${automationRun ? " (Automation run — pinned snapshot)" : ""}, provider: ${providerConfig.defaultProvider || "none"}`
      );

      return c.json({
        mcpConfig,
        agentLayers: contextData.agentLayers,
        platformInstructions: contextData.platformInstructions,
        networkInstructions: contextData.networkInstructions,
        skillsInstructions: mergedSkillsInstructions,
        mcpStatus: enrichedMcpStatus,
        mcpTools,
        mcpInstructions,
        mcpContext,
        providerConfig,
        skillsConfig,
        // The origin an agent can build user-openable Lobu links against.
        // Deliberately NOT `getRequestBaseUrl(c)`: this endpoint is called by
        // the worker over the INTERNAL dispatcher address, so the request Host
        // is a cluster name no user can reach. The configured public origin is
        // the only value here that is correct off-cluster.
        webOrigin: toPublicWebOrigin(this.publicGatewayUrl),
      });
    } catch (error) {
      logger.error("Failed to generate session context", { err: error });
      return c.json({ error: "session_context_error" }, 500);
    }
  }

  private async authenticateWorker(
    c: Context
  ): Promise<{ tokenData: WorkerTokenData; token: string } | null> {
    const authHeader = c.req.header("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const tokenData = verifyWorkerToken(token);

    if (!tokenData) {
      logger.warn("Invalid token");
      return null;
    }

    if (
      tokenData.jti &&
      (await getRevokedTokenStore().isRevoked(tokenData.jti))
    ) {
      logger.warn("Revoked worker token");
      return null;
    }

    return { tokenData, token };
  }

  /**
   * Mint a fresh same-claims token from a currently-valid one, so a >2h turn
   * doesn't die when its token hits the 2h TTL (the short TTL is the leak-
   * revocation path; this swaps the token without lengthening it).
   *
   * Contract: requires a valid per-run token (`runId` + `messageId`) AND a live
   * turn-timeout marker for the token's OWN turn ({@link hasLiveTurnForMessage}
   * on `(deploymentName, messageId)`). Gating per-turn — not per-deployment —
   * is the load-bearing invariant: it closes the cross-turn leak where a still-
   * valid token from a COMPLETED turn refreshes off a later, unrelated turn's
   * liveness on the same deployment. Expired (verifyWorkerToken) and jti-revoked
   * tokens are rejected before the gate; the fresh token gets its own jti.
   * Legacy direct-enqueue tokens (no runId/messageId → no marker) are denied.
   */
  private async handleTokenRefresh(c: Context): Promise<Response> {
    const auth = await this.authenticateWorker(c);
    if (!auth) {
      // Expired / malformed / jti-revoked — verifyWorkerToken or the
      // revoked-token check already rejected. An expired token CANNOT refresh
      // itself; that bounds the leak window.
      return c.json({ error: "Invalid token" }, 401);
    }
    const { tokenData } = auth;

    // No runId/messageId → no turn-timeout marker exists for this token's work,
    // so we have no per-turn liveness signal. Deny rather than mint blind.
    if (typeof tokenData.runId !== "number" || !tokenData.messageId) {
      return c.json({ error: "Token not eligible for refresh" }, 403);
    }

    if (!tokenData.deploymentName) {
      return c.json({ error: "Token missing deployment scope" }, 400);
    }

    const live = await hasLiveTurnForMessage(
      tokenData.deploymentName,
      tokenData.messageId
    );
    if (!live) {
      // THIS token's turn has no in-flight marker — the turn is terminal (reply
      // committed, worker died, or deadline swept), even if a later unrelated
      // turn on the same deployment is still live. Refusing here is the
      // revocation property: the token chain ends with the turn it was minted
      // for, so a completed turn's token can't piggyback on a newer turn.
      logger.info(
        {
          deploymentName: tokenData.deploymentName,
          runId: tokenData.runId,
          messageId: tokenData.messageId,
        },
        "Token refresh denied: no live turn for this message"
      );
      return c.json({ error: "No live turn for token" }, 403);
    }

    // Mint a fresh token with identical claims (fresh timestamp + new jti).
    const refreshed = generateWorkerToken(
      tokenData.userId,
      tokenData.conversationId,
      tokenData.deploymentName,
      {
        channelId: tokenData.channelId,
        teamId: tokenData.teamId,
        agentId: tokenData.agentId,
        organizationId: tokenData.organizationId,
        connectionId: tokenData.connectionId,
        responseThreadId: tokenData.responseThreadId,
        platform: tokenData.platform,
        source: tokenData.source,
        sessionKey: tokenData.sessionKey,
        traceId: tokenData.traceId,
        runId: tokenData.runId,
        messageId: tokenData.messageId,
        // Preserve the admin-tool allowlist across refresh — otherwise a
        // long admin-granted turn loses its allowlist when the token rotates.
        adminTools: tokenData.adminTools,
        adminActorUserId: tokenData.adminActorUserId,
        // Preserve the runtime selection — otherwise a remote-runtime worker's
        // bash starts failing (the generic route 404s with no provider claim)
        // after the token rotates mid-turn.
        runtimeProviderId: tokenData.runtimeProviderId,
        sandboxId: tokenData.sandboxId,
        // Preserve the egress allow/deny lists too — otherwise a refreshed
        // token would fall to deny-all (allow) or, worse, drop its exclusions
        // (deny) and re-open denied hosts mid-turn.
        allowedDomains: tokenData.allowedDomains,
        deniedDomains: tokenData.deniedDomains,
        // And the package claim with them — a long turn that rotates its token
        // would otherwise stop provisioning the connector's CLI mid-run.
        nixPackages: tokenData.nixPackages,
        // Preserve the capture pair, or a long eval replay silently becomes a
        // LIVE run the moment its token rotates: absent `executionMode` reads
        // as live, so every guarded route would start performing real side
        // effects against the org being scored. `verifyWorkerToken` rejects a
        // capture claim with no `automationRunId`; a live token may carry the
        // parent run id on its own, so carry both through explicitly.
        executionMode: tokenData.executionMode,
        automationRunId: tokenData.automationRunId,
      }
    );

    logger.info(
      {
        deploymentName: tokenData.deploymentName,
        runId: tokenData.runId,
        messageId: tokenData.messageId,
      },
      "Issued refreshed worker token"
    );
    return c.json({ token: refreshed });
  }

  private getRequestBaseUrl(c: Context): string {
    const forwardedProto = c.req.header("x-forwarded-proto");
    const protocolCandidate = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto?.split(",")[0];
    const protocol = (protocolCandidate || "http").trim();
    const host = c.req.header("host");
    if (host) {
      // Preserve any base path from publicGatewayUrl (e.g. /lobu) when the
      // gateway is mounted as a sub-app under a prefix path.
      let basePath = "";
      try {
        basePath = new URL(this.publicGatewayUrl).pathname.replace(/\/$/, "");
      } catch {
        // publicGatewayUrl may not be a full URL in some configurations.
      }
      return `${protocol}://${host}${basePath}`;
    }
    return this.publicGatewayUrl;
  }

  /**
   * Resolve dynamic provider configuration for a given agent, returning
   * config values the worker reads from its session context.
   */
  private async resolveProviderConfig(
    agentId: string,
    agentModel?: string,
    requestBaseUrl?: string,
    workerToken?: string,
    organizationId?: string,
    userId?: string
  ): Promise<{
    defaultProvider?: string;
    defaultProviderSlug?: string;
    defaultModel?: string;
    providerBaseUrlMappings?: Record<string, string>;
    configProviders?: Record<string, ConfigProviderMeta>;
    installedProviderRoutes?: Record<string, string>;
  }> {
    if (!this.providerCatalogService || !agentId) {
      return {};
    }

    const effectiveProviders =
      await this.providerCatalogService.getInstalledModules(
        agentId,
        organizationId
      );
    if (effectiveProviders.length === 0) {
      return {};
    }

    // FAIL CLOSED on a restriction sentinel: a `<slug>/__unresolved__` model is
    // NOT a real model — it must never route. If the resolved default is a
    // sentinel, publish NO provider config (no defaultProvider, no defaultModel),
    // so the worker surfaces "no routable model" instead of stripping the
    // "__unresolved__" prefix and sending it to a credentialed upstream, or
    // silently falling back to the first credentialed module.
    if (agentModel && isUnresolvedModelRef(agentModel)) {
      logger.warn(
        { agentId, organizationId, agentModel },
        "Agent's default model is an unresolved restriction sentinel — publishing no routable model (fail closed)"
      );
      return {};
    }

    // Determine primary provider
    let primaryProvider = agentModel
      ? await this.providerCatalogService.findProviderForModel(
          agentModel,
          effectiveProviders
        )
      : undefined;

    if (!primaryProvider) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId, { organizationId, userId }))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
      // The fallback silently re-points the turn at a provider the model does
      // not belong to, so "<slug>/<model>" goes upstream verbatim and returns an
      // opaque "400 invalid model ID" naming neither the requested provider nor
      // the reason it was skipped. The provider is usually INSTALLED but not
      // routable — commonly an `inference_providers` row with no
      // `capabilities.<modality>` block, whose org key therefore never resolves.
      // Without this line the only evidence is a slash surviving in the model id.
      const requestedSlug = agentModel?.includes("/")
        ? agentModel.slice(0, agentModel.indexOf("/"))
        : undefined;
      if (requestedSlug && requestedSlug !== primaryProvider?.providerId) {
        logger.warn(
          {
            agentId,
            organizationId,
            agentModel,
            requestedProvider: requestedSlug,
            fallbackProvider: primaryProvider?.providerId ?? null,
            installedProviders: effectiveProviders.map((p) => p.providerId),
          },
          "Requested model's provider is not routable (not installed, or no resolvable credential) — falling back to a credentialed provider; the model keeps its prefix"
        );
      }
    }

    // Build proxy base URL mappings for all installed providers
    // Use the request base URL (the worker's DISPATCHER_URL) for internal routing
    const proxyBaseUrl = `${requestBaseUrl || this.publicGatewayUrl}/api/proxy`;
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      Object.assign(
        providerBaseUrlMappings,
        provider.getProxyBaseUrlMappings(proxyBaseUrl, agentId, {
          organizationId,
          userId,
        })
      );
    }

    // Collect metadata from config-driven providers for worker model resolution
    const configProviders: Record<string, ConfigProviderMeta> = {};
    for (const provider of effectiveProviders) {
      const meta = (provider as ApiKeyProviderModule).getProviderMetadata?.();
      if (meta) {
        configProviders[provider.providerId] = meta;
      }
    }

    // Key placeholders by Lobu provider id: providers can share an SDK env var,
    // and a turn can select a different provider from the agent's default.
    // Providers that authenticate via the worker JWT (e.g. Bedrock) receive
    // the worker token so their placeholder *is* a verifiable credential.
    const credentialPlaceholders: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      if (
        provider.hasSystemKey() ||
        (await provider.hasCredentials(agentId, { organizationId, userId }))
      ) {
        const placeholder = provider.buildCredentialPlaceholder
          ? await provider.buildCredentialPlaceholder(agentId, {
              organizationId,
              userId,
              workerToken,
            })
          : "lobu-proxy";
        credentialPlaceholders[provider.providerId] = placeholder;
      }
    }

    const result: {
      defaultProvider?: string;
      defaultProviderSlug?: string;
      defaultModel?: string;
      providerBaseUrlMappings?: Record<string, string>;
      configProviders?: typeof configProviders;
      installedProviderRoutes?: Record<string, string>;
      credentialPlaceholders?: Record<string, string>;
    } = {};

    if (primaryProvider) {
      const upstream = primaryProvider.getUpstreamConfig?.();
      result.defaultProvider = upstream?.slug || primaryProvider.providerId;
      // The worker is told `defaultProvider` is the UPSTREAM slug (e.g.
      // "anthropic") and only strips a `<defaultProvider>/` model prefix. But
      // Lobu stores models under the provider's LOBU id (e.g.
      // "claude/claude-opus-4-8"), so for a provider whose Lobu id differs from
      // its upstream slug the prefix is never stripped and reaches the provider
      // API verbatim → 404. Hand the worker the Lobu slug too so it can strip
      // that prefix as well (see resolveModelRef). Omitted when the slugs match.
      if (upstream?.slug && upstream.slug !== primaryProvider.providerId) {
        result.defaultProviderSlug = primaryProvider.providerId;
      }
    }

    // Only an explicitly configured model is used — Lobu no longer silently
    // resolves a provider default (the worker errors with an actionable
    // "select a model" message when none is set). A concrete model is chosen at
    // config time via the model picker (getModelOptions).
    if (agentModel) {
      result.defaultModel = agentModel;
    }

    if (Object.keys(providerBaseUrlMappings).length > 0) {
      result.providerBaseUrlMappings = providerBaseUrlMappings;
    }

    if (Object.keys(configProviders).length > 0) {
      result.configProviders = configProviders;
    }

    result.installedProviderRoutes = Object.fromEntries(
      effectiveProviders.map((provider) => [
        provider.providerId,
        provider.getUpstreamConfig?.()?.slug || provider.providerId,
      ])
    );

    if (Object.keys(credentialPlaceholders).length > 0) {
      result.credentialPlaceholders = credentialPlaceholders;
    }

    return result;
  }

  /**
   * Shutdown gateway
   */
  shutdown(): void {
    this.connectionManager.shutdown();
  }
}
