/**
 * A chat turn's direct MCP principal comes from its verified sender identity.
 * Borrowing the agent owner would expose the owner's private connections;
 * using a null principal would still expose org-shared connections. Instead,
 * the producer signs the linked member as `actorUserId`, and direct MCP auth
 * re-checks membership on every request and refuses chat turns with no actor.
 */
import { resolveChatSenderMember } from "../../lobu/stores/chat-identity.js";
import { chatUserIdentityFor } from "../../lobu/stores/chat-identity-sources.js";
import { DEVICE_CHAT_RUN_SOURCE } from "../services/run-worker-access.js";

/** The direct MCP lane's refusal for a chat turn with no linked member. */
export const CHAT_SENDER_NOT_LINKED =
  "Chat sender is not a linked member of this organization";

/**
 * Whether a turn's principal must come from its chat sender.
 *
 * Every non-API turn is one, unless it carries a headless `source`
 * (Automation run, platform CLI, messaging API): those have no chat sender and
 * keep their existing principal. A device-placed chat turn is still a chat
 * turn — its run-scoped token names the device lane as its `source`, but the
 * message it runs came from a chat sender all the same.
 */
export function isChatSenderTurn(claims: {
  platform?: string;
  source?: string;
}): boolean {
  if (!claims.platform || claims.platform === "api") return false;
  return claims.source === undefined || claims.source === DEVICE_CHAT_RUN_SOURCE;
}

/**
 * The member of `organizationId` a chat turn's sender is linked to, or
 * undefined when the turn is reply-only or is not a chat turn at all.
 *
 * Use the routing claims prepared for signing, especially the provider-native
 * `teamId`, rather than the bridge's worker routing key.
 */
export async function resolveChatTurnActor(args: {
  organizationId: string | undefined;
  senderId: string;
  claims: { platform?: string; source?: string; teamId?: string };
}): Promise<string | undefined> {
  const { platform, teamId } = args.claims;
  if (!platform || !args.organizationId || !isChatSenderTurn(args.claims)) return undefined;
  const member = await resolveChatSenderMember(platform, teamId, args.senderId, args.organizationId);
  return member?.userId;
}

/**
 * What a reply-only turn's model is told, so it neither promises workspace
 * work it cannot do nor leaves the sender without a way to fix it.
 */
export function replyOnlyTurnInstructions(platform: string): string {
  const providerId = chatUserIdentityFor(platform)?.providerId;
  const remedy = providerId
    ? `If they need workspace data or actions, tell them to sign in to Lobu with their ${providerId.charAt(0).toUpperCase()}${providerId.slice(1)} account to link this chat account to their membership, then message again.`
    : "Chat accounts on this platform cannot be linked to a workspace member yet, so workspace tools stay off here.";
  return [
    "## Workspace access",
    "",
    "The person messaging you is not linked to a member of this workspace, so this turn has no workspace tools: no memory, connections, or operations.",
    "Answer from the conversation alone, and do not claim to have looked anything up or changed anything in the workspace.",
    remedy,
  ].join("\n");
}
