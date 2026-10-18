/**
 * LinkedIn connector identity namespaces and normalization.
 *
 * Single source of truth for LinkedIn identity matching and event recall. The
 * connector and server ingestion path both import this module, so the values
 * written to entity_identities are normalized by the same rules used by the
 * connector that extracted them.
 */

import type { ChatUserIdentity } from "./chat-user-identity.js";
import type { ConnectorIdentityModule } from "./connector-identity-module.js";

/** Connector-owned identity namespaces (not SDK-global). */
export const LINKEDIN_IDENTITY = {
	/**
	 * Canonical `/in/<vanity>` profile slug. It is mutable, so it remains an
	 * equal-weight identity rather than a primary identity. It is recall-indexed
	 * because the personalized feed exposes no immutable member id for authors.
	 */
	SLUG: "linkedin_slug",
	/** Immutable member id from `urn:li:fsd_profile:<id>`. */
	MEMBER_ID: "linkedin_member_id",
	/**
	 * A direct-message sender's member id, linking the sender to a Lobu member.
	 * Distinct from `linkedin_member_id`, the person-entity attribution key, so
	 * a chat link on a `$member` never collides with the contact entity the same
	 * sender's messages auto-create.
	 */
	USER_MEMBER_ID: "linkedin_user_member_id",
} as const;

export type LinkedInIdentityNamespace =
	(typeof LINKEDIN_IDENTITY)[keyof typeof LINKEDIN_IDENTITY];

/**
 * Extract a canonical LinkedIn vanity slug from a profile URL or bare slug.
 */
export function normalizeLinkedInSlug(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	const match = value.match(/\/in\/([^/?#]+)/i);
	const slug = (match ? match[1] : value).toLowerCase();
	if (!/^[a-z0-9\-_%]+$/.test(slug)) return null;
	return slug;
}

/**
 * Extract the immutable member id from a LinkedIn person URN or bare id.
 */
export function normalizeLinkedInMemberId(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	if (value.includes(":")) {
		const match = value.match(
			/^urn:li:(?:fsd_profile|member):([A-Za-z0-9_-]+)$/,
		);
		return match ? match[1] : null;
	}
	return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** Normalize a LinkedIn-owned identity namespace. */
export function normalizeLinkedInIdentityValue(
	namespace: string,
	raw: string,
): string | null | undefined {
	switch (namespace) {
		case LINKEDIN_IDENTITY.SLUG:
			return normalizeLinkedInSlug(raw);
		case LINKEDIN_IDENTITY.MEMBER_ID:
		case LINKEDIN_IDENTITY.USER_MEMBER_ID:
			return normalizeLinkedInMemberId(raw);
		default:
			return undefined;
	}
}

/** The LinkedIn connector's contribution to server identity wiring. */
export const linkedInIdentityModule: ConnectorIdentityModule = {
	key: "linkedin",
	recallNamespaces: [LINKEDIN_IDENTITY.SLUG, LINKEDIN_IDENTITY.MEMBER_ID],
	normalize: normalizeLinkedInIdentityValue,
};

/**
 * LinkedIn's direct-message sender model. Member ids are unique across
 * LinkedIn, so there is no tenant axis: `teamId` is ignored and the scope is
 * global.
 *
 * LinkedIn's OpenID sign-in returns an opaque `sub`, not the messaging member
 * id, so no sign-in extractor writes this namespace; a link comes only from the
 * explicit, sender-proven chat link offered in the direct message.
 */
export const linkedInChatUserIdentity: ChatUserIdentity = {
	platform: "linkedin",
	providerId: "linkedin",
	namespace: LINKEDIN_IDENTITY.USER_MEMBER_ID,
	buildUserKey(_teamId, platformUserId) {
		return normalizeLinkedInMemberId(platformUserId);
	},
	userKeyScope: () => ({ kind: "global" }),
	// The stored key is the member id the adapter puts on a message author.
	platformUserIdFromKey(key) {
		return normalizeLinkedInMemberId(key);
	},
};
