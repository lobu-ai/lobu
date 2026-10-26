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
 * 1. A sender linked to a member, in a direct message (`member`), acts as
 *    that member with their own role and private connections.
 * 2. A linked member in a group conversation, and an unlinked sender the
 *    platform vouches for as same-tenant, are `org_shared`: no user and an
 *    ordinary-member role, so the turn sees org-shared connections only and
 *    never anyone's private ones. A linked member's user id still rides the
 *    token as attribution (`actorUserId`), recorded in run `initiator_ref`.
 * 3. Any other unlinked sender is a `public_visitor` of a public organization
 *    (the anonymous public-read path) or, in a private organization,
 *    `reply_only`: no workspace tools at all, refused server-side.
 *
 * The agent owner is never substituted for a chat sender.
 */
import type { ChatTurnAccess } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { resolveChatSenderMember } from "../../lobu/stores/chat-identity.js";

/** The server's refusal for a chat turn that may not use workspace tools. */
export const CHAT_SENDER_NOT_LINKED =
  "Chat sender is not a linked member of this organization";

/**
 * Turns per hour one unlinked sender may start per organization and
 * platform. Over it, the message gets no agent turn. A linked member is never
 * limited, whatever their tier.
 */
export const UNLINKED_SENDER_TURNS_PER_HOUR = 30;

/**
 * The shared rate-limit key for one unlinked chat sender. A platform user id
 * is only unique inside its tenant (Slack ids are per workspace), so the
 * native team is part of the identity. The bridge and every test derive the
 * key here, never by formatting it themselves.
 */
export function chatSenderLimitKey(
  counter: "turns" | "notice" | "link",
  sender: { organizationId: string | undefined; platform: string; teamId: string | undefined; senderId: string },
): string {
  const prefix = {
    turns: "chat-unlinked-turn",
    notice: "chat-access-notice",
    link: "chat-identity-link-notice",
  }[counter];
  return `${prefix}:${JSON.stringify([sender.organizationId ?? null, sender.platform, sender.teamId ?? null, sender.senderId])}`;
}

/**
 * Turns per fixed hourly window all senders with confined access (`reply_only`,
 * `public_visitor`) may start together in one organization, across every
 * sender and platform. The per-sender limit alone lets many throwaway
 * accounts multiply it; over this ceiling, such a message gets no turn. A
 * vouched sender (`org_shared`) and a linked member are not counted. Inherits
 * the shared limiter's per-pod fallback when Postgres is unavailable.
 */
export const UNLINKED_ORGANIZATION_TURNS_PER_HOUR = 120;

/** The shared rate-limit key for {@link UNLINKED_ORGANIZATION_TURNS_PER_HOUR}. */
export function chatOrganizationLimitKey(organizationId: string): string {
  return `chat-unlinked-org-turn:${JSON.stringify([organizationId])}`;
}

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
 * The evidence the bridge recorded for the message that started a chat turn,
 * read back off that turn's stored `agent_turn` run (`action_input.reply`).
 * A follow-up scheduled from the turn stores this, so the later turn is
 * decided from the same provider facts as the human message, never from
 * anything the model supplied. Null when the run is not this organization's
 * agent turn.
 */
export async function chatTurnEvidenceOfRun(
  organizationId: string,
  agentTurnRunId: number | undefined,
): Promise<ChatTurnEvidence | null> {
  if (!agentTurnRunId || !Number.isSafeInteger(agentTurnRunId)) return null;
  const [run] = await getDb()<{ platform_metadata: Record<string, unknown> | null }>`
    SELECT action_input->'reply'->'platform_metadata' AS platform_metadata
    FROM runs
    WHERE id = ${agentTurnRunId}
      AND organization_id = ${organizationId}
      AND run_type = 'agent_turn'
    LIMIT 1
  `;
  return run ? chatTurnEvidenceFrom(run.platform_metadata ?? undefined) : null;
}

/**
 * `source` of a follow-up turn a chat conversation scheduled for itself
 * (`schedule_followup` or a chat-created wake schedule).
 * Unlike the headless sources it keeps a chat sender: the turn is decided by
 * {@link resolveChatTurnActor} from the original sender and their stored
 * evidence, with membership re-evaluated when the follow-up fires.
 */
export const FOLLOWUP_SOURCE = "followup";

/**
 * Whether a turn's authority must come from its chat sender.
 *
 * Every non-API turn is one, unless it carries a headless `source`
 * (Automation run, platform CLI, messaging API): those have no chat sender and
 * keep their existing principal. A follow-up ({@link FOLLOWUP_SOURCE}) is a
 * chat-sender turn. An explicit `api` platform exempts one.
 */
export function isChatSenderTurn(claims: {
  platform?: string;
  source?: string;
}): boolean {
  if (claims.platform === "api") return false;
  return (
    !!claims.platform &&
    (claims.source === undefined || claims.source === FOLLOWUP_SOURCE)
  );
}

export interface ChatTurnActor {
  access: ChatTurnAccess;
  /**
   * The verified member behind the turn, set exactly when the sender is
   * linked. The turn acts as them only on the `member` tier; on `org_shared`
   * it is attribution only.
   */
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
  if (!isChatSenderTurn(args.claims)) return undefined;
  if (!platform || !args.organizationId) return { access: "reply_only" };
  const member = await resolveChatSenderMember(platform, teamId, args.senderId, args.organizationId);
  if (member) {
    return {
      access: args.evidence.isDirectMessage ? "member" : "org_shared",
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
  if (access === "member" && !claims.actorUserId) {
    return "reply_only";
  }
  return access;
}

/**
 * The sender-workspace grant to sign onto a chat turn's token
 * (docs/design/chat-sender-workspace-scope.md). Only a linked member writing
 * in a direct message qualifies: a group conversation's replies are visible
 * to everyone in it, so another workspace's data must never reach one. The
 * mint spreads this; {@link chatTurnReachesSenderWorkspaces} reads it back.
 */
export function chatSenderWorkspacesClaim(
  actor: ChatTurnActor | undefined,
  evidence: ChatTurnEvidence,
): { chatSenderWorkspaces?: true } {
  return actor?.access === "member" && actor.actorUserId && evidence.isDirectMessage
    ? { chatSenderWorkspaces: true }
    : {};
}

/**
 * Whether a verified token's turn may act in the sender's other workspaces.
 * The token's own organization stays the default; a call naming another
 * workspace acts there as the member, after a fresh membership read.
 */
export function chatTurnReachesSenderWorkspaces(
  claims: Parameters<typeof chatTurnAccessOf>[0] & { chatSenderWorkspaces?: true },
): boolean {
  return claims.chatSenderWorkspaces === true && chatTurnAccessOf(claims) === "member";
}

/**
 * Whether a turn is confined to answering in its own thread: no other
 * conversations, media, remote execution, or local device CLI.
 */
export function isConfinedChatTurn(claims: Parameters<typeof chatTurnAccessOf>[0]): boolean {
  const access = chatTurnAccessOf(claims);
  return access === "reply_only" || access === "public_visitor";
}

/**
 * The platform posts the access notice (with the one link) itself, so a
 * confined reply never adds its own linking or joining instructions on top.
 */
const LINKING_LEFT_TO_PLATFORM =
  "The platform sends this person any account-linking instructions itself; do not give linking or joining instructions.";

const CHAT_TURN_ACCESS_TEXT: Record<ChatTurnAccess, string[]> = {
  member: [
    "The person messaging you is a verified member of this workspace who linked this chat account, writing to you directly.",
    "Your workspace tools act as them, with their access, including their private connections.",
    "When a request needs workspace knowledge or actions, use the tools available to you (search memory first) rather than saying you cannot.",
  ],
  org_shared: [
    "The person messaging you is part of this organization.",
    "Your workspace tools see only what the organization shares, never anyone's private connections; use the tools available to you when a request needs workspace knowledge.",
  ],
  public_visitor: [
    "The person messaging you is not linked to a member of this workspace.",
    "Your tools can read only this workspace's public knowledge; do not claim access to anything else.",
    LINKING_LEFT_TO_PLATFORM,
  ],
  reply_only: [
    "The person messaging you is not linked to a member of this workspace, so this turn has no workspace tools: no memory, connections, or operations.",
    "Answer from the conversation alone, and do not claim to have looked anything up or changed anything in the workspace.",
    LINKING_LEFT_TO_PLATFORM,
  ],
};

/**
 * What a chat turn's model is told about its sender's access, so it uses the
 * tools it has, neither promises nor refuses what its tier decides, and is not
 * anchored by earlier replies made under different access (a sender who links
 * mid-conversation keeps the same history). The text depends on the access
 * tier, sender-workspace grant and home slug, never the sender's identity.
 */
export function chatTurnAccessInstructions(
  access: ChatTurnAccess,
  senderWorkspaces?: { homeWorkspaceSlug: string },
): string {
  return [
    "## Workspace access",
    "",
    ...CHAT_TURN_ACCESS_TEXT[access],
    ...(senderWorkspaces ? chatSenderWorkspacesText(senderWorkspaces.homeWorkspaceSlug) : []),
    "This describes access for the current message. Earlier replies in this conversation may reflect different access at that time; follow this section.",
  ].join("\n");
}

/**
 * The sender-workspace lines. Names the home workspace (fixed per agent, so
 * the cached prefix holds) and keeps the model there unless asked.
 */
function chatSenderWorkspacesText(homeWorkspaceSlug: string): string[] {
  return [
    `Your tools work in the ${JSON.stringify(homeWorkspaceSlug)} workspace by default.`,
    "This person's other Lobu workspaces are reachable only when they ask for one: pass its slug as `workspace` to search_memory or `org_slug` to save_memory and query_sql, or use `await client.org(slug)` in query_sdk/run_sdk. Do not look in other workspaces unprompted.",
  ];
}

interface ChatTurnSender {
  name?: string;
  role: string;
}

/**
 * The per-turn line naming a linked sender and their role, so "who am I?" is
 * answerable without a lookup. Conversation-scoped, so it rides the turn's
 * transient context, never the cached system prompt.
 */
export function chatTurnSenderContext(sender: ChatTurnSender): string {
  const role = sender.role === "owner" ? "an owner"
    : sender.role === "admin" ? "an admin" : "a member";
  // Quoted: the name is user-authored data, never instructions.
  const who = sender.name ? JSON.stringify(sender.name.slice(0, 100)) : "a person";
  return `This message is from ${who}, ${role} of this workspace, verified through their linked chat account.`;
}

/**
 * The per-turn line naming an unlinked sender by the display name their chat
 * platform reported, so the reply can address them. Unverified profile data,
 * quoted like a linked sender's name, never instructions.
 */
export function chatTurnUnlinkedSenderContext(name: string): string {
  return `This message is from ${JSON.stringify(name.slice(0, 100))} (the name on their chat profile, not verified), who is not a linked member of this workspace.`;
}

/**
 * A turn's transient context: the caller's context (an Automation preamble the
 * planner admitted at full length) exactly as before, then the sender line
 * (a linked sender's name and role, else an unlinked sender's profile name)
 * when it still fits under `cap`. The line is best-effort; the access section
 * in the system prompt carries the tier either way.
 */
export function chatTurnContext(
  turn: { sender?: ChatTurnSender; unlinkedSenderName?: string },
  context: string | undefined,
  cap: number,
): string | undefined {
  const rest = context?.trim() ? context.slice(0, cap) : "";
  const unlinkedName = turn.unlinkedSenderName?.trim();
  const line = turn.sender
    ? chatTurnSenderContext(turn.sender)
    : unlinkedName ? chatTurnUnlinkedSenderContext(unlinkedName) : "";
  const withSender = [rest, line].filter(Boolean).join("\n\n");
  return (withSender.length <= cap ? withSender : rest) || undefined;
}

/**
 * The linked sender's display name and CURRENT role in `organizationId`, or
 * undefined when they are not (or no longer) a member there.
 */
export async function chatTurnSender(
  actorUserId: string | undefined,
  organizationId: string,
): Promise<ChatTurnSender | undefined> {
  if (!actorUserId) return undefined;
  const [row] = await getDb()<{ name: string | null; role: string }>`
    SELECT u.name, m.role
    FROM "member" m
    JOIN "user" u ON u.id = m."userId"
    WHERE m."userId" = ${actorUserId}
      AND m."organizationId" = ${organizationId}
    LIMIT 1
  `;
  if (!row) return undefined;
  return { name: row.name?.trim() || undefined, role: row.role };
}

export async function chatTurnHomeWorkspaceSlug(organizationId: string): Promise<string | undefined> {
  const [org] = await getDb()<{ slug: string | null }>`
    SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
  return org?.slug || undefined;
}

/**
 * The notice the chat bridge posts to a sender whose turns cannot use the
 * workspace. It carries one URL at most: in a direct message, `linkUrl` is a
 * single-use link (connect/chat-identity-routes.ts) whose page both links a
 * member and lets a stranger join a public workspace; a group conversation
 * never gets one, so a public workspace's notice falls back to its public
 * page. DM links can be offered again after their expiry window; other
 * notices use {@link CHAT_ACCESS_NOTICE_WINDOW_SECONDS}.
 */
export function chatAccessNotice(
  access: "reply_only" | "public_visitor",
  joinUrl: string | null,
  linkUrl: string | null,
): string {
  if (access === "public_visitor") {
    const lead = "I can only use this workspace's public knowledge for you.";
    if (linkUrl) return `${lead} Connect your Lobu account to do more: ${linkUrl}`;
    return joinUrl ? `${lead} Join the workspace to do more: ${joinUrl}` : lead;
  }
  const lead = "I can't use this workspace's tools for you yet.";
  return linkUrl
    ? `${lead} If you're a member, connect your Lobu account: ${linkUrl}`
    : `${lead} Ask an admin of this workspace to invite you.`;
}
