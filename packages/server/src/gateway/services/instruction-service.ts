#!/usr/bin/env bun

import {
  BaseInstructionProvider,
  buildUnconfiguredAgentNotice,
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";

const logger = createLogger("instruction-service");

interface McpStatus {
  id: string;
  name: string;
  requiresAuth: boolean;
  requiresInput: boolean;
}

/**
 * The agent's configured instruction sources, kept apart rather than welded
 * into one blob. Keeping the wire-level boundaries lets the worker own prompt
 * assembly without parsing headings that may also appear in operator content.
 *
 * `unconfiguredNotice` is rendered here rather than in the worker because it
 * embeds the settings URL, which only the gateway knows. It is non-empty only
 * when all three sources are blank.
 */
interface AgentInstructionLayers {
  identityMd: string;
  soulMd: string;
  userMd: string;
  unconfiguredNotice: string;
}

const EMPTY_AGENT_LAYERS: AgentInstructionLayers = {
  identityMd: "",
  soulMd: "",
  userMd: "",
  unconfiguredNotice: "",
};

interface SessionContextData {
  agentLayers: AgentInstructionLayers;
  platformInstructions: string;
  networkInstructions: string;
  skillsInstructions: string;
  mcpStatus: McpStatus[];
}

/**
 * Provides instructions from enabled skills for the agent.
 * Fetches skill content from AgentSettings and injects as instructions.
 * Falls back to generic skill discovery instructions if no skills configured.
 */
class SkillsInstructionProvider extends BaseInstructionProvider {
  readonly name = "skills";
  readonly priority = 15;

  constructor(private agentSettingsStore?: AgentSettingsStore) {
    super();
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    // If no settings store or agentId, return generic skill discovery instructions.
    // Also fail closed (generic) for an orgless DB-backed agent: an id-only read
    // of a shared id would leak another org's skills — `orgScoped === false` says
    // "do NOT read agent settings by id".
    if (
      !this.agentSettingsStore ||
      !context.agentId ||
      context.orgScoped === false
    ) {
      return this.getGenericSkillsInstructions();
    }

    // Settings lookup uses a local try/catch because the domain-specific
    // fallback here is "return the generic skills blurb", not "empty string".
    // The base class's catch-all still guards against any bug outside this
    // block.
    let enabledSkills: Array<{
      name: string;
      description?: string;
      repo: string;
      content?: string;
      modelPreference?: string;
      thinkingLevel?: string;
      instructions?: string;
    }> = [];
    try {
      const settings = await this.agentSettingsStore.getSettings(
        context.agentId,
        { organizationId: context.organizationId }
      );
      const skills = settings?.skillsConfig?.skills || [];
      enabledSkills = skills.filter((s) => s.enabled && s.content);
    } catch (error) {
      logger.error("Failed to load skill settings", { error });
      return this.getGenericSkillsInstructions();
    }

    if (enabledSkills.length === 0) {
      return this.getGenericSkillsInstructions();
    }

    // Progressive disclosure: inject only metadata (name + description + model/thinking tags)
    // to reduce prompt size. Agent reads full SKILL.md on demand.
    const skillSummaries = enabledSkills
      .map((skill) => {
        const desc = skill.description ? ` - ${skill.description}` : "";
        const tags: string[] = [];
        if (skill.modelPreference) {
          tags.push(`[model: ${skill.modelPreference}]`);
        }
        if (skill.thinkingLevel) {
          tags.push(`[thinking: ${skill.thinkingLevel}]`);
        }
        const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";
        const line = `- **${skill.name}**${desc} (\`${skill.repo}\`)${tagStr}`;
        if (skill.instructions?.trim()) {
          return `${line}\n  → ${skill.instructions.trim()}`;
        }
        return line;
      })
      .join("\n");

    return `# Enabled Skills

The following skills are installed and available. When a task matches a skill, read the full skill instructions before using it. Skills tagged with [model: ...] prefer a specific model — delegate to the corresponding coding agent when available.

${skillSummaries}

**To read full skill instructions:** \`cat .skills/*/SKILL.md\` to read the relevant SKILL.md file.

---

${this.getGenericSkillsInstructions()}`;
  }

  private getGenericSkillsInstructions(): string {
    return `## Skills

Your available skills are listed above. To read full instructions for a skill, use: \`cat .skills/{skillName}/SKILL.md\``;
  }
}

/**
 * Provides information about network access rules and allowed domains
 */
class NetworkInstructionProvider extends BaseInstructionProvider {
  readonly name = "network";
  readonly priority = 20;

  protected buildInstructions(_context: InstructionContext): string {
    const allowedDomains = process.env.WORKER_ALLOWED_DOMAINS?.trim() || "";
    const disallowedDomains =
      process.env.WORKER_DISALLOWED_DOMAINS?.trim() || "";

    // Unrestricted mode
    if (allowedDomains === "*") {
      if (disallowedDomains) {
        const blockedList = disallowedDomains
          .split(",")
          .map((d) => `  - ${d.trim()}`)
          .filter((d) => d.length > 4)
          .join("\n");
        return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

**Blocked domains:**
${blockedList}

You can access any external service except the blocked domains listed above.`;
      }
      return `## Network Access

**Internet Access:** Unrestricted (all domains allowed)

You can access any external service without restrictions.`;
    }

    // Complete isolation
    if (!allowedDomains) {
      return `## Network Access

**Internet Access:** Complete isolation (no external access)

You do NOT have access to the internet. All external requests (curl, wget, npm, pip, etc.) will fail. Network access is configured via lobu.config.ts or the gateway configuration APIs. Only local operations and MCP tools are available.`;
    }

    // Allowlist mode
    const allowedList = allowedDomains
      .split(",")
      .map((d) => `  - ${d.trim()}`)
      .filter((d) => d.length > 4)
      .join("\n");

    let instructions = `## Network Access

**Internet Access:** Filtered (allowlist mode)

**Allowed domains:**
${allowedList}`;

    if (disallowedDomains) {
      const blockedList = disallowedDomains
        .split(",")
        .map((d) => `  - ${d.trim()}`)
        .filter((d) => d.length > 4)
        .join("\n");
      instructions += `

**Blocked domains:**
${blockedList}`;
    }

    instructions += `

You can only access the allowed domains listed above. All other external requests will be blocked by the proxy. Network access is configured via lobu.config.ts or the gateway configuration APIs. Plan your work accordingly and use available MCP tools when possible.`;

    return instructions;
  }
}

/**
 * Aggregates session context data for workers
 * Returns raw data (not built instructions) so workers can format as needed
 */
export class InstructionService {
  private platformProviders = new Map<string, InstructionProvider>();
  private mcpConfigService?: McpConfigService;
  private agentSettingsStore?: AgentSettingsStore;
  private skillsProvider: SkillsInstructionProvider;

  constructor(
    mcpConfigService?: McpConfigService,
    agentSettingsStore?: AgentSettingsStore
  ) {
    this.mcpConfigService = mcpConfigService;
    this.agentSettingsStore = agentSettingsStore;
    this.skillsProvider = new SkillsInstructionProvider(agentSettingsStore);
  }

  /**
   * Register a platform-specific instruction provider
   * Called by platform adapters during initialization
   */
  registerPlatformProvider(
    platform: string,
    provider: InstructionProvider
  ): void {
    this.platformProviders.set(platform, provider);
    logger.info(
      `Registered instruction provider for platform: ${platform} (${provider.name})`
    );
  }

  /**
   * Get session context data for a worker
   */
  /**
   * The platform's own instructions for a turn — the chat identity block
   * ("you are reachable as `@bot`") a connection's provider renders.
   *
   * A platform provider may do an agent-scoped DB read (e.g.
   * SlackInstructionProvider.listConnections), so it is gated by the SAME
   * org-scope guard as skills/agent instructions: an orgless DB-backed agent
   * (`orgScoped === false`) skips it entirely and gets "" to avoid leaking
   * another tenant's data. A provider failure is logged and yields "" too — the
   * identity block is a prompt improvement, never a reason to lose the turn.
   */
  async getPlatformInstructions(
    platform: string,
    context: InstructionContext
  ): Promise<string> {
    const platformProvider = this.platformProviders.get(platform);
    if (!platformProvider || context.orgScoped === false) return "";
    try {
      const instructions = await platformProvider.getInstructions(context);
      logger.info(
        `Got ${platform} platform instructions (${instructions.length} chars)`
      );
      return instructions;
    } catch (error) {
      logger.error(
        `Failed to get instructions from ${platform} provider:`,
        error
      );
      return "";
    }
  }

  /**
   * Get session context data for a worker
   */
  async getSessionContext(
    platform: string,
    context: InstructionContext,
    options?: { settingsUrl?: string }
  ): Promise<SessionContextData> {
    const platformInstructions = await this.getPlatformInstructions(
      platform,
      context
    );

    // Get network access instructions
    let networkInstructions = "";
    const networkProvider = new NetworkInstructionProvider();
    try {
      networkInstructions = await networkProvider.getInstructions(context);
      logger.info(
        `Got network instructions (${networkInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get network instructions:", error);
    }

    // Read the agent's identity/soul/user settings. Skip the by-id read for an
    // orgless DB-backed agent (`orgScoped === false`) — it would id-only read
    // another org's identity/soul/user for a shared id.
    let agentLayers: AgentInstructionLayers = EMPTY_AGENT_LAYERS;
    if (
      this.agentSettingsStore &&
      context.agentId &&
      context.orgScoped !== false
    ) {
      try {
        const settings = await this.agentSettingsStore.getSettings(
          context.agentId,
          { organizationId: context.organizationId }
        );
        const identityMd = settings?.identityMd?.trim() ?? "";
        const soulMd = settings?.soulMd?.trim() ?? "";
        const userMd = settings?.userMd?.trim() ?? "";
        // When nothing is configured, tell the agent to defer to admin config.
        const unconfigured = !identityMd && !soulMd && !userMd;
        agentLayers = {
          identityMd,
          soulMd,
          userMd,
          unconfiguredNotice: unconfigured
            ? buildUnconfiguredAgentNotice(options?.settingsUrl)
            : "",
        };

        logger.info(
          `Read agent layers (identity ${identityMd.length} chars, soul ${soulMd.length} chars, user ${userMd.length} chars${unconfigured ? ", unconfigured" : ""})`
        );
      } catch (error) {
        logger.error("Failed to read agent instruction layers:", error);
      }
    }

    // NOTE: org-wide `guidance` is NOT injected here. Verified workers receive
    // it through the mandatory `lobu-memory` MCP server's managed-agent
    // instructions (buildWorkspaceInstructions renders the "Organization
    // Context" section), which the worker folds into its prompt. Direct MCP
    // clients receive the directory-safe audience instead. Injecting here too
    // would place identical guidance in a managed worker prompt twice.

    // Get skills instructions (includes enabled skills from agent settings)
    let skillsInstructions = "";
    try {
      skillsInstructions = await this.skillsProvider.getInstructions(context);
      logger.info(
        `Got skills instructions (${skillsInstructions.length} chars)`
      );
    } catch (error) {
      logger.error("Failed to get skills instructions:", error);
    }

    // Get MCP status data. Pass the org so the lobu-memory slug is resolved from
    // the token's org (not an id-only agent lookup); orgless db-backed → none.
    let mcpStatus: McpStatus[] = [];
    if (this.mcpConfigService) {
      try {
        mcpStatus =
          (await this.mcpConfigService.getMcpStatus(
            context.agentId,
            context.organizationId
          )) || [];
        logger.info(`Got MCP status for ${mcpStatus.length} MCPs`);
      } catch (error) {
        logger.error("Failed to get MCP status:", error);
      }
    }

    return {
      agentLayers,
      platformInstructions,
      networkInstructions,
      skillsInstructions,
      mcpStatus,
    };
  }
}
