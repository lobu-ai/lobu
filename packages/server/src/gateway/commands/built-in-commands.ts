import type { CommandContext, CommandRegistry } from "@lobu/core";
import {
  bindChatToAgentForOwner,
  bindChatToPreviewAgent,
  canonicalSlackChannelId,
  consumePreviewClaim,
  listPreviewAgents,
  previewAgentMenu,
} from "../../preview/slack.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";
import { formatChatCommand } from "./command-spelling.js";

const LINK_AUTHORITY_REVOKED_MESSAGE = "The existing chat link no longer has access to both workspaces. Retire its Automation in Lobu, then link this chat again.";

interface BuiltInCommandDeps {
  agentSettingsStore: AgentSettingsStore;
}

/**
 * Register all built-in slash commands on the given registry.
 */
export function registerBuiltInCommands(
  registry: CommandRegistry,
	deps: BuiltInCommandDeps,
): void {
  registry.register({
    name: "new",
    description: "Save context to memory and start a fresh session",
    handler: async (ctx: CommandContext) => {
      // Handled by message-handler-bridge before slash dispatch
      await ctx.reply("Starting new session...");
    },
  });

  registry.register({
    name: "clear",
    description: "Clear chat history and start fresh",
    handler: async (ctx: CommandContext) => {
      // Handled by message-handler-bridge before slash dispatch
      await ctx.reply("Chat history cleared.");
    },
  });

  registry.register({
    name: "help",
    description: "Show available commands",
    handler: async (ctx: CommandContext) => {
      const commands = registry.getAll();
      const lines = commands.map(
        (command) =>
          `${formatChatCommand(ctx.platform, command.name)} - ${command.description}`,
      );
      await ctx.reply(
				`Available commands:\n${lines.join("\n")}\n\nYou can also just send a message to start a conversation with the agent.`,
      );
    },
  });

  registry.register({
    name: "status",
    description: "Show current agent status",
    handler: async (ctx: CommandContext) => {
      if (!ctx.agentId) {
        await ctx.reply("No agent is configured for this conversation yet.");
        return;
      }

      // Command context keeps the installation's organization for /link.
      // Agent settings belong to the workspace selected by the chat subscription.
      const subscription = ctx.connectionId && ctx.organizationId
        ? await new AutomationSubscriptionService().resolveForConnection(
            ctx.connectionId, ctx.channelId, ctx.organizationId, false, ctx.teamId,
          )
        : null;
      const settings = await deps.agentSettingsStore.getSettings(ctx.agentId, {
        organizationId: subscription?.organizationId ?? ctx.organizationId,
      });

      const effectiveModel = resolveEffectiveModelRef(settings);
      const model = effectiveModel || "(org default)";
      const skillsCount = settings?.skillsConfig?.skills
        ? Object.keys(settings.skillsConfig.skills).length
        : 0;

      const parts = [
        `Agent: ${ctx.agentId}`,
        `Model: ${model}`,
        `Skills: ${skillsCount}`,
      ];

      await ctx.reply(parts.join("\n"));
    },
  });

  // Public preview: bind this chat to one of the demo agents in the preview
  // connection's org. Re-running with another agent rebinds; wrapped-command
  // platforms reach these handlers as the `try` / `agents` subcommands.
  const replyDemoMenu = async (ctx: CommandContext, prefix?: string) => {
    if (!ctx.connectionId) {
			await ctx.reply(
				"Couldn't identify this workspace — try again in a moment.",
			);
      return;
    }
    const agents = await listPreviewAgents(ctx.connectionId);
    const menu = previewAgentMenu(ctx.platform, agents);
    await ctx.reply(prefix ? `${prefix}\n\n${menu}` : menu);
  };

  registry.register({
    name: "try",
    description:
      "Try a demo agent in this workspace — `try <agentId>` (no arg lists them)",
    handler: async (ctx: CommandContext) => {
      const agentId = ctx.args.trim();
      if (!agentId) {
        await replyDemoMenu(ctx);
        return;
      }
      if (!ctx.connectionId) {
				await ctx.reply(
					"Couldn't identify this workspace — try again in a moment.",
				);
        return;
      }
      // Bindings are keyed on the canonical channel-id form; Slack slash
      // commands hand us the bare id.
      const channelId =
        ctx.platform === "slack"
          ? canonicalSlackChannelId(ctx.channelId)
          : ctx.channelId;
      const result = await bindChatToPreviewAgent({
        connectionId: ctx.connectionId,
        agentId,
        platform: ctx.platform,
        teamId: ctx.teamId,
        channelId,
      });
      switch (result.status) {
        case "bound":
          await ctx.reply(
						`Now talking to \`${result.agentId}\`. Say hi — I'll reply here from now on.`,
          );
          return;
        case "not_available":
          await replyDemoMenu(ctx, `No demo agent \`${agentId}\` here.`);
          return;
        case "no_connection":
          await ctx.reply(
						"This chat isn't connected to a Lobu preview workspace.",
          );
          return;
      }
    },
  });

  registry.register({
    name: "agents",
    description: "List the demo agents you can try here",
    handler: async (ctx: CommandContext) => {
      await replyDemoMenu(ctx);
    },
  });

  // Redeem a link code minted by `lobu run` and bind this channel/DM to that
  // agent. Wrapped-command platforms reach this as the `link` subcommand;
  // re-running it with a different code rebinds.
  registry.register({
    name: "link",
    // The help command renders this on every platform, so it stays code-only; the
    // Slack-only `<agentId>` shortcut is surfaced by `agentIdHint` below.
    description: "Link this chat to a Lobu agent with a `<code>` from `lobu run`",
    handler: async (ctx: CommandContext) => {
      const arg = ctx.args.trim();
      const cmd = formatChatCommand(ctx.platform, "link");
      // The codeless `<agentId>` shortcut needs a workspace-scoped Slack
      // identity, which only Slack sign-in and the install claim write — so it
      // never applies on other platforms. Don't promise it there.
      const agentIdHint =
        ctx.platform === "slack"
          ? " (If you connected this workspace to Lobu, `/lobu link <agentId>` works too.)"
          : "";
      if (!arg) {
        await ctx.reply(
					`Usage: \`${cmd} <code>\` — get a code by running \`lobu run\` on a Preview-enabled agent.${agentIdHint}`,
        );
        return;
      }
      const surfaceType: "dm" | "channel" = ctx.isGroup ? "channel" : "dm";
      // The message handler looks bindings up by the platform's canonical
      // channel-id form; Slack slash commands hand us the bare id.
      const channelId =
        ctx.platform === "slack"
          ? canonicalSlackChannelId(ctx.channelId)
          : ctx.channelId;
      const result = await consumePreviewClaim({
        code: arg,
        platform: ctx.platform,
        teamId: ctx.teamId,
        channelId,
        surfaceType,
				connectionId: ctx.connectionId,
				connectionOrganizationId: ctx.organizationId,
      });
      switch (result.status) {
        case "bound":
          await ctx.reply(
						`Linked this chat to agent \`${result.agentId}\`. Say hi — I'll reply here from now on.`,
          );
          return;
        case "surface_not_allowed":
          await ctx.reply(
						`This code can't be used in a ${result.surfaceType === "dm" ? "DM" : "channel"}. Check the agent's \`preview.${ctx.platform}.surfaces\` setting.`,
					);
					return;
				case "connection_mismatch":
					await ctx.reply(
						"That code isn't authorized for this chat connection. Use the selected installation or hosted preview bot, or create a fresh code with access to this connection.",
					);
					return;
        case "link_authority_revoked":
          await ctx.reply(LINK_AUTHORITY_REVOKED_MESSAGE);
          return;
        case "not_found": {
          // Not a valid code — but if we already know who this chat user is,
          // treat the arg as an agent id and re-bind directly (no fresh code
          // needed). Identity comes only from Slack sign-in / the install claim
          // (slack-claim.ts), never from redeeming a code: the same mapping
          // authorizes Slack approvals, so a pasted code must not mint it.
          const lobuUserId = await resolveChatUserIdentity(
            ctx.platform,
            ctx.teamId,
						ctx.userId,
          );
          if (lobuUserId) {
            const bound = await bindChatToAgentForOwner({
              platform: ctx.platform,
              teamId: ctx.teamId,
              channelId,
              agentId: arg,
              lobuUserId,
							connectionId: ctx.connectionId ?? "",
							connectionOrganizationId: ctx.organizationId,
            });
            if (bound.status === "link_authority_revoked") {
              await ctx.reply(LINK_AUTHORITY_REVOKED_MESSAGE);
              return;
            }
            if (bound.status === "bound") {
              await ctx.reply(
								`Linked this chat to agent \`${arg}\`. Say hi — I'll reply here from now on.`,
              );
              return;
            }
            await ctx.reply(
						`No agent \`${arg}\` you can manage in your orgs. Either run \`lobu apply\` to register it, or paste a fresh \`${formatChatCommand(ctx.platform, "link")} <code>\` from \`lobu run\`.`,
            );
            return;
          }
          await ctx.reply(
						`That link code is invalid or expired. Run \`lobu run\` again to get a fresh one.${agentIdHint}`,
          );
          return;
        }
      }
    },
  });
}
