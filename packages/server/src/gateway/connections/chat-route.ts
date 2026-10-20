/**
 * Which agent answers a chat message. Shared by the message bridge (a real
 * inbound message) and Slack assistant starters (a thread that has no message
 * yet), so the starters a user sees always come from the agent their first
 * message will reach.
 */

import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import type { AutomationActivationPlan } from "../../automations/activation.js";
import { stripPlatformPrefix } from "../channels/bound-channels.js";
import { resolveAgentId } from "../services/platform-helpers.js";
import type { PlatformConnection } from "./types.js";

/**
 * The Automation signal for one chat message. Trigger matching reads only its
 * attributes (channel, user, team, mention flags), never `input_text`.
 */
export function chatMessageSignal(args: {
  platform: string;
  connectionId: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  userId: string;
  messageId: string;
  text: string;
  isMention: boolean;
  occurredAt: string;
}): ConnectorTriggerSignal {
  const { platform, channelId, teamId } = args;
  const normalizedChannelId = stripPlatformPrefix(platform, channelId);
  return {
    connector_key: platform,
    resource_type: "channel",
    resource_ref: teamId
      ? `${platform}:channel:${teamId}:${normalizedChannelId}`
      : `${platform}:channel:${normalizedChannelId}`,
    event_type: "message.created",
    delivery_id: `chat:${args.connectionId}:${args.messageId}`,
    label: `${platform} message in ${normalizedChannelId}`,
    input_text: args.text,
    occurred_at: args.occurredAt,
    attributes: {
      channel_id: normalizedChannelId,
      channel_key: channelId,
      user_id: args.userId,
      is_mention: args.isMention,
      mention_only: args.isMention,
      ...(teamId ? { team_id: teamId } : {}),
      ...(args.conversationId !== channelId
        ? { thread_id: args.conversationId }
        : {}),
    },
  };
}

/**
 * The planned Automation wins; otherwise the connection's owning agent. The
 * planner is the only Automation routing decision because it evaluates the
 * complete trigger predicate.
 */
export async function resolveChatRoute(args: {
  plan: AutomationActivationPlan;
  platform: string;
  channelId: string;
  connection: Pick<PlatformConnection, "agentId" | "organizationId">;
}) {
  const automation =
    args.plan.replyTargets[0] ?? args.plan.backgroundTargets[0];
  if (automation) {
    return {
      agentId: automation.agentId,
      source: "automation" as const,
      organizationId: automation.organizationId,
      model: automation.model ?? undefined,
      instructions: automation.instructions,
      automationId: automation.automationId,
    };
  }
  return resolveAgentId({
    platform: args.platform,
    channelId: args.channelId,
    agentId: args.connection.agentId,
    organizationId: args.connection.organizationId,
  });
}
