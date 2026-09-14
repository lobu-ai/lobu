import type { CommandContext, CommandRegistry } from "@lobu/core";
import {
  bindChatToAgentForOwner,
  canonicalSlackChannelId,
  consumePreviewClaim,
} from "../../preview/slack.js";
import { resolveChatUserIdentity } from "../../lobu/stores/chat-identity.js";
import { chatUserIdentityFor } from "../../lobu/stores/chat-identity-sources.js";
import type { AutomationSubscriptionService } from "../channels/automation-subscription-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  resolveEffectiveModelRef,
} from "../auth/settings/model-selection.js";
import { formatChatCommand } from "./command-spelling.js";

const LINK_AUTHORITY_REVOKED_MESSAGE = "The existing chat link no longer has access to both workspaces. Retire its Automation in Lobu, then link this chat again.";

interface BuiltInCommandDeps {
  agentSettingsStore: AgentSettingsStore;
  automationSubscriptionService: AutomationSubscriptionService;
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
        ? await deps.automationSubscriptionService.resolveForConnection(
            ctx.connectionId, ctx.channelId, ctx.organizationId, { teamId: ctx.teamId },
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
      // The codeless `<agentId>` shortcut needs a proven chat identity, which a
      // sign-in with the platform's own provider mints (Slack sign-in or the
      // Slack install claim; Google sign-in for Google Chat). Offer it wherever
      // that is possible, in provider-neutral wording — naming the platform here
      // is what previously kept it invisible to everyone but Slack.
      const agentIdHint = chatUserIdentityFor(ctx.platform)
        ? ` (Signed in to Lobu? \`${cmd} <agentId>\` links this chat to your own agent — no code needed.)`
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
          // needed). Identity comes only from a chat sign-in (Slack, Google) or
          // the install claim (slack-claim.ts), never from redeeming a code:
          // the same mapping authorizes Slack approvals, so a pasted code must
          // not mint it.
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
