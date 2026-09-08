import {
  type CommandContext,
  type CommandRegistry,
  createLogger,
} from "@lobu/core";
import type { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import { platformAgentId } from "../spaces/space-resolver.js";

const logger = createLogger("command-dispatcher");

interface CommandDispatchInput {
  platform: string;
  userId: string;
  channelId: string;
  teamId?: string;
  isGroup: boolean;
  conversationId?: string;
  connectionId?: string;
  organizationId?: string;
  reply: CommandContext["reply"];
}

interface CommandDispatcherDeps {
  registry: CommandRegistry;
  automationSubscriptionService: AutomationSubscriptionService;
}

export class CommandDispatcher {
  private registry: CommandRegistry;
  private automationSubscriptionService: AutomationSubscriptionService;

  constructor(deps: CommandDispatcherDeps) {
    this.registry = deps.registry;
    this.automationSubscriptionService = deps.automationSubscriptionService;
  }

  async tryHandleSlashText(
    rawText: string,
		input: CommandDispatchInput,
  ): Promise<boolean> {
    const match = rawText.trim().match(/^\/(\w+)(?:\s+(.*))?$/);
    if (!match?.[1]) return false;
    let commandName = match[1];
    let commandArgs = match[2]?.trim() || "";
    // Slack and Google Chat register a single `/lobu` wrapper, so subcommands
    // arrive as `/lobu link <code>`. Slack also delivers this as plain message
    // text in an "Agents & AI Apps" DM (no slash-command UI). Unwrap at the
    // shared boundary so native and pasted command paths dispatch identically.
    if (commandName.toLowerCase() === "lobu" && commandArgs) {
      const sub = commandArgs.match(/^(\S+)(?:\s+(.*))?$/);
      if (sub?.[1]) {
        commandName = sub[1];
        commandArgs = sub[2]?.trim() || "";
      }
    }
    return this.tryHandle(commandName, commandArgs, input);
  }

  async tryHandle(
    commandName: string,
    commandArgs: string,
		input: CommandDispatchInput,
  ): Promise<boolean> {
    const agentId = await this.resolveAgentId(input);

    logger.info(
      {
        platform: input.platform,
        commandName,
        userId: input.userId,
        channelId: input.channelId,
        teamId: input.teamId,
        agentId,
      },
			"Dispatching command",
    );

    return this.registry.tryHandle(commandName, {
      userId: input.userId,
      channelId: input.channelId,
      teamId: input.teamId,
      isGroup: input.isGroup,
      conversationId: input.conversationId,
      connectionId: input.connectionId,
			organizationId: input.organizationId,
      agentId,
      args: commandArgs,
      platform: input.platform,
      reply: input.reply,
    });
  }

  private async resolveAgentId(input: CommandDispatchInput): Promise<string> {
    // Resolve through the concrete inbound installation so only its workspace
    // and authorized linked workspaces can supply the command's agent.
		const subscription =
			input.connectionId && input.organizationId
				? await this.automationSubscriptionService.resolveForConnection(
						input.connectionId,
      input.channelId,
						input.organizationId,
						false,
						input.teamId,
					)
				: null;
    if (subscription?.agentId) {
      return subscription.agentId;
    }

    return platformAgentId(
      input.platform,
      input.userId,
      input.channelId,
			input.isGroup,
    );
  }
}
