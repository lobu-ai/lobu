import { createLogger, verifyWorkerToken } from "@lobu/core";
import { getLobuMemoryUpstreamOrigin } from "../../config/index.js";
import { chatTurnAccessOf } from "../../orchestration/chat-turn-actor.js";
import { getRevokedTokenStore } from "../revoked-token-store.js";

const logger = createLogger("mcp-config-service");
const LOBU_MEMORY_MCP_ID = "lobu-memory";

interface HttpMcpServerConfig {
  id: string;
  upstreamUrl: string;
  /**
   * Marks the embedded Lobu MCP server. The gateway proxy passes the worker JWT
   * directly, bypasses the SSRF localhost guard, and stamps the upstream
   * request with the direct-auth header so Lobu promotes it to admin scope.
   */
  internal: true;
}

interface WorkerMcpConfig {
  mcpServers: Record<string, any>;
}

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
}

interface LobuMemoryConfigOptions {
  /**
   * Resolve the org slug for the lobu-memory MCP endpoint. Takes the token's
   * organizationId — NOT an id-only agent lookup — so a shared agent id can't
   * derive an ARBITRARY org's slug. Returns null when the org can't be resolved
   * (orgless db-backed agent) → no lobu-memory MCP for that turn (fail closed).
   */
  resolveOrgSlug?: (
    agentId: string,
    organizationId: string | undefined
  ) => Promise<string | null>;
}

interface McpConfigServiceOptions {
  lobuMemory?: LobuMemoryConfigOptions;
}

export class McpConfigService {
  private lobuMemory?: LobuMemoryConfigOptions;

  constructor(options: McpConfigServiceOptions = {}) {
    this.lobuMemory = options.lobuMemory;
    logger.debug("McpConfigService initialized");
  }

  /**
   * Return MCP config tailored for a worker request. Raw agent/global MCP
   * servers are intentionally unsupported; the only worker MCP is the
   * gateway-derived system `lobu-memory` server. External MCP capabilities must
   * be installed as connectors and executed through connector operations.
   */
  async getWorkerConfig(options: {
    baseUrl: string;
    workerToken: string;
    deploymentName?: string;
  }): Promise<WorkerMcpConfig> {
    const { baseUrl, workerToken } = options;
    const workerConfig: WorkerMcpConfig = { mcpServers: {} };

    const tokenData = verifyWorkerToken(workerToken);
    if (!tokenData) {
      logger.warn("Failed to verify worker token");
      return workerConfig;
    }

    if (
      tokenData.jti &&
      (await getRevokedTokenStore().isRevoked(tokenData.jti))
    ) {
      logger.warn("Rejected revoked worker token while building MCP config");
      return workerConfig;
    }

    // A reply-only chat turn has no workspace tools; the MCP lane would refuse
    // it anyway (workspace/multi-tenant.ts), so it is offered no server.
    if (chatTurnAccessOf(tokenData) === "reply_only") return workerConfig;

    const { userId, agentId } = tokenData;
    const effectiveAgentId = agentId || userId;
    logger.info(`Building MCP config for user ${userId}`);

    const lobuMemory = await this.deriveLobuMemoryServer(
      effectiveAgentId,
      tokenData.organizationId
    );
    if (lobuMemory) {
      workerConfig.mcpServers[LOBU_MEMORY_MCP_ID] = {
        ...lobuMemory,
        originalUrl: lobuMemory.url,
        url: baseUrl,
        type: "sse",
        headers: mergeHeaders(undefined, workerToken, LOBU_MEMORY_MCP_ID),
        perAgent: true,
      };
    }

    logger.info(
      `Returning worker config with ${Object.keys(workerConfig.mcpServers).length} MCPs for user ${userId}:`,
      {
        mcpIds: Object.keys(workerConfig.mcpServers),
        configs: Object.entries(workerConfig.mcpServers).map(([id, cfg]) => ({
          id,
          type: cfg.type,
          hasUrl: !!cfg.url,
          hasCommand: !!cfg.command,
          perAgent: cfg.perAgent || false,
        })),
      }
    );

    return workerConfig;
  }

  /** Get status of system MCPs for a specific agent (org-scoped). */
  async getMcpStatus(
    agentId: string,
    organizationId?: string
  ): Promise<McpStatus[]> {
    const lobuMemory = await this.deriveLobuMemoryServer(
      agentId,
      organizationId
    );
    if (!lobuMemory) return [];
    return [
      {
        id: LOBU_MEMORY_MCP_ID,
        name: LOBU_MEMORY_MCP_ID,
        requiresAuth: false,
        requiresInput: false,
      },
    ];
  }

  /** Get HTTP proxy metadata for a specific MCP server (org-scoped). */
  async getHttpServer(
    id: string,
    agentId?: string,
    organizationId?: string
  ): Promise<HttpMcpServerConfig | undefined> {
    if (id !== LOBU_MEMORY_MCP_ID || !agentId) return undefined;
    const lobuMemory = await this.deriveLobuMemoryServer(
      agentId,
      organizationId
    );
    if (!lobuMemory) return undefined;
    return {
      id: LOBU_MEMORY_MCP_ID,
      upstreamUrl: lobuMemory.url,
      internal: true,
    };
  }

  /** Get all HTTP proxy metadata for system MCPs (org-scoped). */
  async getAllHttpServers(
    agentId?: string,
    organizationId?: string
  ): Promise<Map<string, HttpMcpServerConfig>> {
    const servers = new Map<string, HttpMcpServerConfig>();
    if (!agentId) return servers;
    const lobuMemory = await this.getHttpServer(
      LOBU_MEMORY_MCP_ID,
      agentId,
      organizationId
    );
    if (lobuMemory) servers.set(LOBU_MEMORY_MCP_ID, lobuMemory);
    return servers;
  }

  private async deriveLobuMemoryServer(
    agentId: string,
    organizationId: string | undefined
  ): Promise<{ url: string; type: "streamable-http"; internal: true } | null> {
    const resolveOrgSlug = this.lobuMemory?.resolveOrgSlug;
    if (!resolveOrgSlug) {
      return null;
    }

    try {
      const orgSlug = await resolveOrgSlug(agentId, organizationId);
      if (!orgSlug) {
        return null;
      }
      const upstreamOrigin = getLobuMemoryUpstreamOrigin();
      return {
        url: buildLobuMemoryScopedMcpUrl(upstreamOrigin, orgSlug),
        type: "streamable-http",
        internal: true,
      };
    } catch (error) {
      logger.warn(`Failed to derive ${LOBU_MEMORY_MCP_ID} MCP for ${agentId}`, {
        error,
      });
      return null;
    }
  }
}

function buildLobuMemoryScopedMcpUrl(baseUrl: string, orgSlug: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/mcp/${orgSlug}`;
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function mergeHeaders(
  existingHeaders: unknown,
  workerToken: string,
  mcpId: string
): Record<string, string> {
  const normalized: Record<string, string> = {};

  if (existingHeaders && typeof existingHeaders === "object") {
    for (const [key, value] of Object.entries(existingHeaders as any)) {
      if (typeof value === "string") {
        normalized[key] = value;
      } else if (value != null) {
        normalized[key] = String(value);
      }
    }
  }

  normalized.Authorization = `Bearer ${workerToken}`;
  normalized["X-Mcp-Id"] = mcpId;
  return normalized;
}
