import { createLogger } from "@lobu/core";
import { getLobuMemoryUpstreamOrigin } from "../../config/index.js";

const logger = createLogger("mcp-config-service");
export const LOBU_MEMORY_MCP_ID = "lobu-memory";

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
