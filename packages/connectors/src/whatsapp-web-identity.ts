/**
 * WhatsApp Web chat-sender identity: namespace and normalization.
 *
 * A WhatsApp person is addressed by one of two unrelated JIDs: the phone-number
 * JID (`<digits>@s.whatsapp.net`, which the web client also spells `@c.us`) and
 * the privacy LID (`<digits>@lid`). The SAME human can arrive under either, but
 * nothing in a message proves that a given LID and a given phone JID belong to
 * one person — the page's own LID→phone migration is best-effort and silent on
 * a miss. So the stored key KEEPS its server suffix: a phone JID and a LID are
 * two distinct keys that never compare equal, and a member who wants to be
 * recognised under both carries both, each written by an explicit link. This
 * module never derives one from the other.
 *
 * Group JIDs (`@g.us`), broadcasts and newsletters name a conversation, not a
 * person, so they are not user keys at all.
 */

import type { ChatUserIdentity } from "./chat-user-identity.js";
import type { ConnectorIdentityModule } from "./connector-identity-module.js";

/** Connector-owned identity namespaces (not SDK-global). */
export const WHATSAPP_WEB_IDENTITY = {
	/**
	 * A WhatsApp person JID, server suffix included: `<digits>@s.whatsapp.net`
	 * or `<digits>@lid`. Distinct from the connector's `wa_jid` person-entity
	 * attribution key, so a chat link on a `$member` never collides with the
	 * contact entity the same sender's messages auto-create.
	 */
	USER_JID: "whatsapp_user_jid",
} as const;

const PHONE_SERVER = "s.whatsapp.net";
const LEGACY_PHONE_SERVER = "c.us";
const LID_SERVER = "lid";

/** True when `value` is only ASCII digits, with a length in [min, max]. */
function isDigits(value: string, min: number, max: number): boolean {
	if (value.length < min || value.length > max) return false;
	for (const ch of value) {
		if (ch < "0" || ch > "9") return false;
	}
	return true;
}

/**
 * Canonicalize a WhatsApp person JID, or null when the value is not one.
 *
 * - `@c.us` is the web client's spelling of the phone server and becomes
 *   `@s.whatsapp.net`, matching the connector's own canonical form.
 * - A multi-device suffix (`<user>:<device>@server`) addresses one of the
 *   person's devices, not a different person, so it is dropped.
 * - Group, broadcast, newsletter and any other server return null.
 *
 * The user part is digits only and bounded, so an arbitrary string can never
 * become an indexed identity value.
 */
export function normalizeWhatsAppUserJid(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim().toLowerCase();
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) return null;
	const server = value.slice(at + 1);
	const userPart = value.slice(0, at);
	const colon = userPart.indexOf(":");
	const user = colon === -1 ? userPart : userPart.slice(0, colon);
	if (colon !== -1 && !isDigits(userPart.slice(colon + 1), 1, 4)) return null;
	if (!isDigits(user, 5, 32)) return null;
	if (server === PHONE_SERVER || server === LEGACY_PHONE_SERVER) {
		return `${user}@${PHONE_SERVER}`;
	}
	if (server === LID_SERVER) return `${user}@${LID_SERVER}`;
	return null;
}

/**
 * Normalize a WhatsApp Web identity namespace value. Returns `undefined` when
 * the namespace is not owned here (caller falls back to generic hygiene).
 */
export function normalizeWhatsAppWebIdentityValue(
	namespace: string,
	raw: string,
): string | null | undefined {
	switch (namespace) {
		case WHATSAPP_WEB_IDENTITY.USER_JID:
			return normalizeWhatsAppUserJid(raw);
		default:
			return undefined;
	}
}

/** The WhatsApp Web connector's contribution to the server identity wiring. */
export const whatsAppWebIdentityModule: ConnectorIdentityModule = {
	key: "whatsapp.web",
	// Links a chat sender to a member; not an event-recall key.
	recallNamespaces: [],
	normalize: normalizeWhatsAppWebIdentityValue,
};

/**
 * WhatsApp Web's sender-identity model. JIDs are unique across all of WhatsApp,
 * so there is no tenant axis: `teamId` is ignored and the scope is global.
 *
 * `providerId` names no sign-in provider Lobu configures — WhatsApp has no OAuth
 * login — so no web sign-in can ever stamp this namespace. A link has to come
 * from an explicit, sender-proven linking step.
 */
export const whatsAppWebChatUserIdentity: ChatUserIdentity = {
	platform: "whatsapp.web",
	providerId: "whatsapp",
	namespace: WHATSAPP_WEB_IDENTITY.USER_JID,
	buildUserKey(_teamId, platformUserId) {
		return normalizeWhatsAppUserJid(platformUserId);
	},
	userKeyScope: () => ({ kind: "global" }),
	// The stored key is already the JID the device's `send_message` addresses.
	platformUserIdFromKey(key) {
		return normalizeWhatsAppUserJid(key);
	},
};
