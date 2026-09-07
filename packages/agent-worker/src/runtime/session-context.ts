import {
  type ConfigProviderMeta,
  createLogger,
  ensureBaseUrl,
  type McpStatus,
  type McpToolDef,
} from "@lobu/core";

const logger = createLogger("runtime-session-context");

interface ProviderConfig {
  defaultProvider?: string;
  /**
   * The primary provider's LOBU id (e.g. "claude"), sent only when it differs
   * from `defaultProvider` (the upstream slug, e.g. "anthropic"). Lobu stores
   * models prefixed with the Lobu id; the resolver strips this prefix in
   * addition to `<defaultProvider>/` so a stored "claude/…" model doesn't reach
   * the provider API verbatim and 404. See resolveModelRef.
   */
  defaultProviderSlug?: string;
  defaultModel?: string;
  cliBackends?: Array<{
    providerId: string;
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    modelArg?: string;
    sessionArg?: string;
  }>;
  providerBaseUrlMappings?: Record<string, string>;
  /** Dynamic provider metadata from config-driven providers */
  configProviders?: Record<string, ConfigProviderMeta>;
  /** Installed Lobu provider ID → upstream runtime provider slug. */
  installedProviderRoutes?: Record<string, string>;
  /** Lobu provider ID → credential placeholder for proxy mode. */
  credentialPlaceholders?: Record<string, string>;
}

interface SkillContent {
  name: string;
  content: string;
}

/**
 * The agent's configured instruction sources, kept apart on the wire so prompt
 * assembly does not have to recover their boundaries from operator-authored
 * headings.
 */
export interface AgentInstructionLayers {
  identityMd: string;
  soulMd: string;
  userMd: string;
  /** Non-empty only when identity, soul and user are all blank. */
  unconfiguredNotice: string;
}

export const EMPTY_AGENT_LAYERS: AgentInstructionLayers = {
  identityMd: "",
  soulMd: "",
  userMd: "",
  unconfiguredNotice: "",
};

interface SessionContextResponse {
  agentLayers: AgentInstructionLayers;
  /** Absent on an older gateway that predates the field. */
  webOrigin?: string;
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
  mcpTools?: Record<string, McpToolDef[]>;
  mcpInstructions?: Record<string, string>;
  mcpContext?: Record<string, string>;
  providerConfig?: ProviderConfig;
  skillsConfig?: SkillContent[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SESSION_CONTEXT = {
  agentLayers: EMPTY_AGENT_LAYERS,
  gatewayInstructions: "",
  webOrigin: "",
  providerConfig: {} as ProviderConfig,
  skillsConfig: [] as SkillContent[],
  mcpStatus: [] as McpStatus[],
  mcpTools: {} as Record<string, McpToolDef[]>,
  mcpContext: {} as Record<string, string>,
} as const;

// Module-level cache for session context
let cachedResult: {
  agentLayers: AgentInstructionLayers;
  gatewayInstructions: string;
  webOrigin: string;
  providerConfig: ProviderConfig;
  skillsConfig: SkillContent[];
  mcpStatus: McpStatus[];
  mcpTools: Record<string, McpToolDef[]>;
  mcpContext: Record<string, string>;
  mcpExposure: "tools" | "cli";
  cachedAt: number;
} | null = null;

/**
 * Last-known-good per-server MCP instructions, keyed by mcpId. A transient
 * gateway-side tool-fetch failure makes a server's `mcpInstructions` entry
 * arrive empty/missing; rendering that as-is would drop the whole
 * `## MCP Server Instructions` block for one turn, shrinking the system prompt
 * and busting the prompt cache — then the block returns next turn and busts it
 * again. Reusing the last non-empty value keeps the block stable across a blip.
 */
let lastGoodMcpInstructions: Record<string, string> = {};

/**
 * Invalidate the session context cache.
 * Called by the SSE client when a config_changed event is received.
 */
export function invalidateSessionContextCache(): void {
  cachedResult = null;
  logger.info("Session context cache invalidated");
}

/**
 * Reset the last-known-good MCP instructions cache. Exposed for tests; a
 * real config change flows in as fresh non-empty instructions which overwrite
 * the stale entries anyway.
 */
export function resetLastGoodMcpInstructions(): void {
  lastGoodMcpInstructions = {};
}

/**
 * Reconcile freshly-fetched MCP instructions against the last-known-good ones.
 *
 * `knownServerIds` (from `mcpStatus`) is the authoritative set of servers that
 * still EXIST for this agent. `fresh` (from `mcpInstructions`) carries their
 * instruction text — but the gateway only populates a key when the tool fetch
 * succeeded AND returned instructions (gateway/index.ts: `if
 * (result.value.instructions)`). So a transient blip (401, init failure) shows
 * up as a server that is in `knownServerIds` but MISSING from `fresh` — not as
 * an empty string. We must tell these two cases apart:
 *
 *   - id in knownServerIds, present & non-empty in fresh -> use fresh (remember)
 *   - id in knownServerIds, absent/empty in fresh        -> BLIP: reuse last-good
 *   - id NOT in knownServerIds                            -> REMOVED: drop it
 *
 * This keeps a disconnected connector from lingering (security) while a
 * momentary fetch failure no longer drops the block and busts the cache twice.
 * When `knownServerIds` is omitted we fall back to treating `fresh`'s own keys
 * as the known set (used by unit tests exercising the map logic directly).
 */
export function withLastGoodMcpInstructions(
  fresh: Record<string, string>,
  knownServerIds?: Iterable<string>
): Record<string, string> {
  const known = new Set(knownServerIds ?? Object.keys(fresh));
  const reconciled: Record<string, string> = {};
  for (const mcpId of known) {
    const value = fresh[mcpId];
    if (value && value.trim().length > 0) {
      reconciled[mcpId] = value;
    } else if (lastGoodMcpInstructions[mcpId]) {
      // Known server, but instructions absent/empty this fetch -> blip.
      reconciled[mcpId] = lastGoodMcpInstructions[mcpId];
    }
    // Known but no text anywhere yet -> nothing to render.
  }
  // Authoritative: forget any server not in knownServerIds (removed/revoked).
  lastGoodMcpInstructions = reconciled;
  return reconciled;
}

function buildMcpInstructions(
  mcpStatus: McpStatus[],
  mcpToolIds: Set<string>,
  mcpExposure: "tools" | "cli" = "tools"
): string {
  if (!mcpStatus || mcpStatus.length === 0) {
    return "";
  }

  const needsAuthentication = mcpStatus.filter(
    (mcp) => mcp.requiresAuth && !mcp.authenticated
  );
  const needsConfiguration = mcpStatus.filter(
    (mcp) => mcp.requiresInput && !mcp.configured
  );
  const undiscoveredMcps = mcpStatus.filter((mcp) => !mcpToolIds.has(mcp.id));

  if (
    needsAuthentication.length === 0 &&
    needsConfiguration.length === 0 &&
    undiscoveredMcps.length === 0
  ) {
    return "";
  }

  const lines: string[] = ["## MCP Tools Requiring Setup"];

  for (const mcp of needsAuthentication) {
    const loginCmd =
      mcpExposure === "cli"
        ? `run \`${mcp.id} auth login\` in Bash`
        : `call \`${mcp.id}_login\``;
    const checkCmd =
      mcpExposure === "cli"
        ? `run \`${mcp.id} auth check\``
        : `call \`${mcp.id}_login_check\``;
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Authentication is required. To start login, ${loginCmd}. After the user completes login, ${checkCmd}. Newly available MCP tools will refresh on the next message.`
    );
  }

  for (const mcp of needsConfiguration) {
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): Additional MCP input is required before this server can be used. Tell the user an admin must configure the MCP inputs in settings.`
    );
  }

  for (const mcp of undiscoveredMcps) {
    if (mcp.requiresAuth || mcp.requiresInput) {
      continue;
    }
    lines.push(
      `- ⚠️ **${mcp.name}** (id: ${mcp.id}): No tools were discovered for this MCP in the current session. Do not assume a login tool exists unless it is actually registered.`
    );
  }

  return lines.join("\n");
}

/**
 * CLI-mode header introducing the `<server> <tool>` idiom. Appended to gateway
 * instructions when `mcpExposure === "cli"` so the model understands how to
 * invoke MCP tools through bash instead of as first-class function calls.
 */
function buildMcpCliInstructions(mcpStatus: McpStatus[]): string {
  if (!mcpStatus || mcpStatus.length === 0) return "";
  const servers = mcpStatus.map((m) => `- \`${m.id}\` — ${m.name}`).join("\n");
  return `## Available MCP CLIs

MCP servers are exposed as Bash commands. One command per server. Invoke tools by piping JSON on stdin:

\`\`\`bash
<server> <tool> <<'EOF'
{ ...json args... }
EOF
\`\`\`

Discovery:
- \`<server> --help\` — list a server's tools
- \`<server> <tool> --schema\` — print the JSON Schema for a tool
- \`<server> auth login|check|logout\` — manage OAuth where required

Servers:
${servers}`;
}

export function buildMcpServerInstructions(
  mcpInstructions: Record<string, string>
): string {
  // Sort by mcpId so the rendered block is byte-identical turn-to-turn
  // regardless of the map's key order. Non-deterministic ordering here would
  // reshuffle a stable-content block and needlessly bust the prompt cache.
  const entries = Object.entries(mcpInstructions)
    .filter(([, v]) => v)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";

  const lines: string[] = ["## MCP Server Instructions", ""];
  for (const [mcpId, instructions] of entries) {
    lines.push(`### ${mcpId}`, "", instructions, "");
  }
  return lines.join("\n");
}

/**
 * Fetch session context from gateway for Lobu worker.
 * Returns gateway instructions and dynamic provider configuration.
 * Caches the result until invalidated by a config_changed SSE event.
 * Skips MCP server config (Lobu doesn't use Claude SDK's MCP format).
 */
export async function getAgentSessionContext(
  opts: { mcpExposure?: "tools" | "cli" } = {}
): Promise<{
  /**
   * The agent's identity/soul/user sources, still separate. Returned apart
   * from `gatewayInstructions` because their composed block belongs BEFORE the
   * pi-coding-agent base prompt (which would otherwise anchor the model with
   * "You are an expert coding assistant" before the agent's real persona).
   */
  agentLayers: AgentInstructionLayers;
  /** Platform / network / skills / MCP setup instructions (no identity). */
  gatewayInstructions: string;
  /**
   * The gateway's PUBLIC web origin, for links an agent hands to a user.
   * Empty when the gateway predates the field or has no parseable public
   * origin configured — callers omit the link rather than guessing one.
   */
  webOrigin: string;
  providerConfig: ProviderConfig;
  skillsConfig: SkillContent[];
  mcpStatus: McpStatus[];
  mcpTools: Record<string, McpToolDef[]>;
  mcpContext: Record<string, string>;
}> {
  const mcpExposure: "tools" | "cli" = opts.mcpExposure ?? "tools";

  if (
    cachedResult &&
    cachedResult.mcpExposure === mcpExposure &&
    Date.now() - cachedResult.cachedAt < CACHE_TTL_MS
  ) {
    logger.debug("Returning cached session context");
    return cachedResult;
  }

  // On any fetch failure, fall back to the last SUCCESSFUL context (even if
  // stale past the TTL) rather than the empty default — dropping to
  // DEFAULT_SESSION_CONTEXT would blank the MCP server block, shrink the system
  // prompt, and bust the prompt cache until the gateway recovers. An empty
  // default is only correct when we've never had a successful fetch.
  const fallbackContext = () =>
    cachedResult && cachedResult.mcpExposure === mcpExposure
      ? cachedResult
      : { ...DEFAULT_SESSION_CONTEXT };

  const dispatcherUrl = process.env.DISPATCHER_URL;
  const workerToken = process.env.WORKER_TOKEN;

  if (!dispatcherUrl || !workerToken) {
    logger.warn("Missing dispatcher URL or worker token for session context");
    return fallbackContext();
  }

  try {
    const url = new URL(
      `${ensureBaseUrl(dispatcherUrl)}/worker/session-context`
    );
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${workerToken}`,
      },
      // Session context is fetched once per turn; a stalled gateway here would
      // otherwise hang the worker before the agent ever sees the prompt.
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      logger.warn("Gateway returned non-success status for session context", {
        status: response.status,
      });
      return fallbackContext();
    }

    const data = (await response.json()) as SessionContextResponse;

    logger.info(
      `Received session context: ${data.platformInstructions.length} chars platform instructions, ${data.mcpStatus.length} MCP status entries, provider: ${data.providerConfig?.defaultProvider || "none"}, cliBackends: ${data.providerConfig?.cliBackends?.map((b) => b.name).join(", ") || "none"}`
    );

    const toolMcpIds = new Set(Object.keys(data.mcpTools || {}));
    const mcpSetupInstructions = buildMcpInstructions(
      data.mcpStatus,
      toolMcpIds,
      mcpExposure
    );
    // Include MCP server instructions for all servers (with or without tools).
    // These provide workspace context (available connectors, entity schemas, etc.)
    // that helps the agent use the tools effectively.
    const mcpServerInstructions = buildMcpServerInstructions(
      withLastGoodMcpInstructions(
        data.mcpInstructions || {},
        (data.mcpStatus || []).map((mcp) => mcp.id)
      )
    );
    const mcpCliInstructions =
      mcpExposure === "cli" ? buildMcpCliInstructions(data.mcpStatus) : "";

    // Keep the wire-level boundaries intact until prompt assembly.
    const agentLayers = data.agentLayers;

    const gatewayInstructions = [
      data.platformInstructions,
      data.networkInstructions,
      data.skillsInstructions,
      mcpCliInstructions,
      mcpSetupInstructions,
      mcpServerInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");

    const mcpTools = data.mcpTools || {};

    logger.info(
      `Built gateway instructions: agent (identity ${agentLayers.identityMd.length} / soul ${agentLayers.soulMd.length} / user ${agentLayers.userMd.length} chars, prepended) + platform (${data.platformInstructions.length} chars) + network (${data.networkInstructions.length} chars) + skills (${(data.skillsInstructions || "").length} chars) + MCP setup (${mcpSetupInstructions.length} chars) + MCP server instructions (${mcpServerInstructions.length} chars), mcpTools: ${Object.keys(mcpTools).length} servers`
    );

    const mcpContext = data.mcpContext || {};

    const result = {
      agentLayers,
      gatewayInstructions,
      webOrigin: data.webOrigin || "",
      providerConfig: data.providerConfig || {},
      skillsConfig: data.skillsConfig || [],
      mcpStatus: data.mcpStatus || [],
      mcpTools,
      mcpContext,
    };

    // Don't cache if any authenticated MCP returned no tools — likely a
    // transient upstream failure that should be retried on the next message.
    const hasEmptyAuthenticatedMcp = data.mcpStatus.some(
      (mcp) => mcp.authenticated && !toolMcpIds.has(mcp.id)
    );
    if (!hasEmptyAuthenticatedMcp) {
      cachedResult = { ...result, mcpExposure, cachedAt: Date.now() };
    } else {
      logger.warn(
        "Skipping session context cache — authenticated MCP(s) returned no tools",
        {
          emptyMcps: data.mcpStatus
            .filter((mcp) => mcp.authenticated && !toolMcpIds.has(mcp.id))
            .map((mcp) => mcp.id),
        }
      );
    }

    return result;
  } catch (error) {
    logger.error("Failed to fetch session context from gateway", { error });
    return fallbackContext();
  }
}
