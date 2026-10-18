/**
 * The chat-identity registry — the ONE place core code COLLECTS the per-platform
 * sender-identity models. Each descriptor is owned by its connector; this file
 * only gathers them so `resolveChatUserIdentity`, the login writer and the
 * transcript attribution edge (`gateway/connections/sender-identity.ts`)
 * dispatch without naming a connector.
 *
 * Adding a platform is one descriptor in its `@lobu/connectors/<key>-identity`
 * module plus one entry here — and, for the write side, one extractor in
 * `auth/chat-login-identities.ts` saying how to read that provider's account.
 *
 * A platform with NO entry resolves null everywhere, which is the correct
 * fail-closed answer: an unlinked sender must never resolve to some user.
 */

import type { ChatUserIdentity } from "@lobu/connectors/chat-user-identity";
import { gchatChatUserIdentity } from "@lobu/connectors/google-identity";
import { linkedInChatUserIdentity } from "@lobu/connectors/linkedin-identity";
import { slackChatUserIdentity } from "@lobu/connectors/slack-identity";
import { whatsAppWebChatUserIdentity } from "@lobu/connectors/whatsapp-web-identity";

/** Every chat platform whose senders can be resolved to a Lobu user. */
export const CHAT_USER_IDENTITIES: readonly ChatUserIdentity[] = [
	slackChatUserIdentity,
	gchatChatUserIdentity,
	whatsAppWebChatUserIdentity,
	linkedInChatUserIdentity,
];

/**
 * Chat sender namespaces reserved from connector-declared attribution rules.
 * Platform-owned chat attribution and ACL writers may still use them; the
 * sender lookup separately requires a sign-in or verified-link source.
 */
export const CHAT_SENDER_NAMESPACES: ReadonlySet<string> = new Set(
	CHAT_USER_IDENTITIES.map((c) => c.namespace),
);

const BY_PLATFORM = new Map<string, ChatUserIdentity>(
	CHAT_USER_IDENTITIES.map((c) => [c.platform, c]),
);

/**
 * The sender-identity model for a chat platform, or null when that platform has
 * no linkable identity.
 */
export function chatUserIdentityFor(
	platform: string | null | undefined,
): ChatUserIdentity | null {
	if (!platform) return null;
	return BY_PLATFORM.get(platform) ?? null;
}
