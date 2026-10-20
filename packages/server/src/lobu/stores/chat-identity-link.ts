import { createHash, randomBytes } from "node:crypto";
import { type DbClient, getDb } from "../../db/client.js";
import { chatUserIdentityFor } from "./chat-identity-sources.js";

/**
 * One-click chat identity link claims.
 *
 * A chat sender who is not linked to a Lobu user is offered, in a direct
 * message only, a link to `/connect/chat-identity`. The signed-in browser
 * session proves the Lobu account. Where the platform has a login that
 * proves its accounts, the redeeming user's own sign-in must name the sender:
 * the inbox's operator can also read the DM. Other platforms rely on possession
 * of the link, trusted only within the organization that offered it. The claim
 * binds the exact sender (platform + canonical identity key from the
 * platform's own descriptor), the organization it was offered in, and the
 * connection that delivered it.
 *
 * Claims live in `oauth_states` under {@link CHAT_IDENTITY_LINK_SCOPE}: the row
 * id is the SHA-256 of the opaque token, so a database read never yields a
 * usable link, and the row is deleted when it is redeemed.
 */

export const CHAT_IDENTITY_LINK_SCOPE = "chat-identity-link";

/** How long an offered link stays redeemable. */
export const CHAT_IDENTITY_LINK_TTL_SECONDS = 10 * 60;

/** The facts a link is bound to. Server-built only. */
export interface ChatIdentityLinkClaim {
	organizationId: string;
	/** Runtime connection id of the chat connection that delivered the offer. */
	connectionId: string;
	platform: string;
	teamId: string | null;
	/** The sender's platform user id as the inbound message carried it. */
	senderId: string;
	/** The descriptor's storage key for this sender, fixed at mint time. */
	identityKey: string;
	/** Platform display name, shown on the confirmation page only. */
	senderDisplayName: string | null;
	/**
	 * The conversation the link was offered in, where the redeem route posts
	 * its confirmation. Absent on a claim that has nowhere to confirm.
	 */
	replyTarget?: ChatIdentityLinkReplyTarget;
}

/** A chat conversation on the claim's connection, as the chat bridge saw it. */
interface ChatIdentityLinkReplyTarget {
	channelId: string;
	threadId?: string;
}

function chatIdentityLinkTokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * The canonical storage key for a sender, or null when the platform has no
 * linkable identity or cannot key these ids (fail closed: no link offered).
 */
export function chatIdentityLinkKey(
	platform: string,
	teamId: string | null | undefined,
	senderId: string,
): { namespace: string; identityKey: string } | null {
	const identity = chatUserIdentityFor(platform);
	if (!identity) return null;
	const identityKey = identity.buildUserKey(teamId, senderId);
	if (!identityKey) return null;
	return { namespace: identity.namespace, identityKey };
}

/**
 * Mint a single-use link token for an unlinked sender, or null when the
 * platform's identity registry cannot key this sender.
 */
export async function mintChatIdentityLink(
	args: {
		organizationId: string;
		connectionId: string;
		platform: string;
		teamId: string | undefined;
		senderId: string;
		senderDisplayName?: string;
		replyTarget?: ChatIdentityLinkReplyTarget;
	},
	sql: DbClient = getDb(),
): Promise<string | null> {
	const key = chatIdentityLinkKey(args.platform, args.teamId, args.senderId);
	if (!key) return null;
	const token = randomBytes(32).toString("base64url");
	const claim: ChatIdentityLinkClaim = {
		organizationId: args.organizationId,
		connectionId: args.connectionId,
		platform: args.platform,
		teamId: args.teamId ?? null,
		senderId: args.senderId,
		identityKey: key.identityKey,
		senderDisplayName: args.senderDisplayName?.slice(0, 200) || null,
		...(args.replyTarget && { replyTarget: args.replyTarget }),
	};
	const expiresAt = new Date(Date.now() + CHAT_IDENTITY_LINK_TTL_SECONDS * 1000);
	await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (
      ${chatIdentityLinkTokenHash(token)}, ${CHAT_IDENTITY_LINK_SCOPE}, ${sql.json(claim)}, ${expiresAt}
    )
  `;
	return token;
}

/**
 * Read a live claim without consuming it. Redemption serializes on the
 * identity via withChatIdentityLock before re-reading and consuming it.
 */
export async function readChatIdentityLink(
	token: string,
	sql: DbClient = getDb(),
): Promise<ChatIdentityLinkClaim | null> {
	if (!token || token.length > 200) return null;
	const rows = await sql<{ payload: ChatIdentityLinkClaim }>`
    SELECT payload FROM oauth_states
    WHERE id = ${chatIdentityLinkTokenHash(token)}
      AND scope = ${CHAT_IDENTITY_LINK_SCOPE}
      AND expires_at > clock_timestamp()
  `;
	return rows[0]?.payload ?? null;
}

/** Burn a claim. Called in the same transaction that writes the link. */
export async function deleteChatIdentityLink(
	token: string,
	sql: DbClient,
): Promise<void> {
	await sql`
    DELETE FROM oauth_states
    WHERE id = ${chatIdentityLinkTokenHash(token)}
      AND scope = ${CHAT_IDENTITY_LINK_SCOPE}
  `;
}
