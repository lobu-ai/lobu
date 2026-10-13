/**
 * The authority a chat turn runs with.
 *
 * {@link resolveChatTurnActor} is the ONE decision, made from existing facts
 * only (the verified chat-identity graph, the organization's visibility, and
 * provider-authoritative evidence on the inbound event). The producer signs
 * its answer into the turn's worker token as `chatAccess` (+ `actorUserId`),
 * and every enforcement point reads it back off the signed claims through
 * {@link chatTurnAccessOf}, so the mint, the direct MCP lane, the internal
 * worker routes, and the device poll can never disagree:
 *
 * 1. A sender linked to a member acts as that member with their own role.
 *    In a group conversation (`member_shared`) the member's PRIVATE
 *    connections are hidden; they are reachable only in a direct message.
 * 2. An unlinked sender the platform vouches for as same-tenant
 *    (`org_shared`) acts with no user and an ordinary-member role, so it sees
 *    org-shared connections only, never anyone's private ones.
 * 3. Any other unlinked sender is a `public_visitor` of a public organization
 *    (the anonymous public-read path) or, in a private organization,
 *    `reply_only`: no workspace tools at all, refused server-side.
 *
 * The agent owner is never substituted for a chat sender.
 */
import type { ChatTurnAccess } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { resolveChatSenderMember } from "../../lobu/stores/chat-identity.js";
import { DEVICE_CHAT_RUN_SOURCE } from "../services/run-worker-access.js";

/** The server's refusal for a chat turn that may not use workspace tools. */
export const CHAT_SENDER_NOT_LINKED =
  "Chat sender is not a linked member of this organization";

/**
 * Turns per hour one unlinked sender (tiers 2 and 3) may start per
 * organization and platform. Over it, the message gets no agent turn.
 */
export const UNLINKED_SENDER_TURNS_PER_HOUR = 30;

/** How often one sender may be shown the access notice. */
export const CHAT_ACCESS_NOTICE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * `platformMetadata` keys the chat bridge stamps from structured platform
 * data, and the mint reads back. Server-built only: no worker or caller
 * authors a chat payload's metadata.
 */
export const CHAT_TURN_EVIDENCE_KEYS = {
  /** Structured DM flag from the Chat SDK event source (never message text). */
  isDirectMessage: "isDirect",
  /** Provider-authoritative same-tenant evidence for the sender. */
  senderVouched: "senderVouched",
} as const;

export interface ChatTurnEvidence {
  isDirectMessage: boolean;
  senderVouched: boolean;
}

/** Read the bridge's evidence; anything absent or malformed is "no". */
export function chatTurnEvidenceFrom(
  platformMetadata: Record<string, unknown> | undefined,
): ChatTurnEvidence {
  return {
    isDirectMessage: platformMetadata?.[CHAT_TURN_EVIDENCE_KEYS.isDirectMessage] === true,
    senderVouched: platformMetadata?.[CHAT_TURN_EVIDENCE_KEYS.senderVouched] === true,
  };
}

/**
 * Whether a turn's authority must come from its chat sender.
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

export interface ChatTurnActor {
  access: ChatTurnAccess;
  /** Set exactly for the member tiers. */
  actorUserId?: string;
}

/**
 * Decide a chat turn's authority, or undefined when the turn has no chat
 * sender at all (headless or API turns keep their own principal).
 *
 * Takes the routing claims prepared for signing, especially the
 * provider-native `teamId`, never the bridge's worker routing key.
 */
export async function resolveChatTurnActor(args: {
  organizationId: string | undefined;
  senderId: string;
  claims: { platform?: string; source?: string; teamId?: string };
  evidence: ChatTurnEvidence;
}): Promise<ChatTurnActor | undefined> {
  const { platform, teamId } = args.claims;
  if (!platform || !isChatSenderTurn(args.claims)) return undefined;
  if (!args.organizationId) return { access: "reply_only" };
  const member = await resolveChatSenderMember(platform, teamId, args.senderId, args.organizationId);
  if (member) {
    return {
      access: args.evidence.isDirectMessage ? "member" : "member_shared",
      actorUserId: member.userId,
    };
  }
  if (args.evidence.senderVouched) return { access: "org_shared" };
  const [org] = await getDb()<{ visibility: string | null }>`
    SELECT visibility FROM "organization" WHERE id = ${args.organizationId} LIMIT 1
  `;
  return { access: org?.visibility === "public" ? "public_visitor" : "reply_only" };
}

/**
 * The authority a verified token's turn runs with, or null for a turn with no
 * chat sender. A chat token minted without a tier — including one from a pod
 * that predates this claim — is reply-only: it fails closed.
 */
export function chatTurnAccessOf(claims: {
  platform?: string;
  source?: string;
  chatAccess?: ChatTurnAccess;
  actorUserId?: string;
}): ChatTurnAccess | null {
  if (!isChatSenderTurn(claims)) return null;
  const access = claims.chatAccess ?? "reply_only";
  if ((access === "member" || access === "member_shared") && !claims.actorUserId) {
    return "reply_only";
  }
  return access;
}

/**
 * Whether a turn is confined to answering in its own thread: no other
 * conversations, media, remote execution, or local device CLI.
 */
export function isConfinedChatTurn(claims: Parameters<typeof chatTurnAccessOf>[0]): boolean {
  const access = chatTurnAccessOf(claims);
  return access === "reply_only" || access === "public_visitor";
}

/** Whether a tier is one of the unlinked-sender tiers the bridge rate-limits. */
export function isUnlinkedChatAccess(access: ChatTurnAccess): boolean {
  return access === "org_shared" || access === "public_visitor" || access === "reply_only";
}

/**
 * What a reply-only turn's model is told, so it neither promises workspace
 * work it cannot do nor leaves the sender without a way to fix it.
 */
export function replyOnlyTurnInstructions(): string {
  return [
    "## Workspace access",
    "",
    "The person messaging you is not a member of this workspace, so this turn has no workspace tools: no memory, connections, or operations.",
    "Answer from the conversation alone, and do not claim to have looked anything up or changed anything in the workspace.",
    "If they need workspace data or actions, tell them to ask an admin of this workspace to invite them.",
  ].join("\n");
}

/**
 * The fixed notice the chat bridge posts (at most once per sender per
 * {@link CHAT_ACCESS_NOTICE_WINDOW_SECONDS}) to a sender whose turns cannot
 * use the workspace. A public organization's stranger also gets a link to its
 * public page, where the existing join flow lives.
 */
export function chatAccessNotice(
  access: "reply_only" | "public_visitor",
  joinUrl: string | null,
): string {
  if (access === "public_visitor") {
    const join = joinUrl ? ` To do more, join the workspace: ${joinUrl}` : "";
    return `I can answer here, but for you I can only read this workspace's public knowledge.${join}`;
  }
  return "I can answer here, but I can't use this workspace's tools for you until you're a member. Ask an admin of this workspace to invite you.";
}
