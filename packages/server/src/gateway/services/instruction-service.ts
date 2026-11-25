#!/usr/bin/env bun

import {
  createLogger,
  type InstructionContext,
  type InstructionProvider,
} from "@lobu/core";

const logger = createLogger("instruction-service");

/**
 * Holds the per-platform instruction providers that chat adapters register,
 * and renders a platform's identity block for an agent turn.
 */
export class InstructionService {
  private platformProviders = new Map<string, InstructionProvider>();

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
   * The platform's own instructions for a turn — the chat identity block
   * ("you are reachable as `@bot`") a connection's provider renders.
   *
   * A platform provider may do an agent-scoped DB read (e.g.
   * SlackInstructionProvider.listConnections), so it is gated by the SAME
   * org-scope guard as other agent-scoped reads: an orgless DB-backed agent
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
}
