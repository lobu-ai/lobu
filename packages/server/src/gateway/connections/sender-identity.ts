/**
 * Chat sender → identity spec for chat-transcript attribution.
 *
 * The connector-agnostic core resolver (`resolveSenderIdentity` in
 * entity-link-upsert) names no platform: it takes an already-normalized
 * identity spec + the entity type to mint on a miss. This edge uses the same
 * connector-owned descriptor as sender lookup, sign-in and DM linking, so
 * those paths agree on the sender's namespace and key within each org.
 *
 * Attribution grants nothing: a newly minted `person` has no `auth_user_id`.
 * `resolveChatUserIdentity` requires that provider-proven identity alongside
 * the chat identity; redeemed DM links are trusted only within their org.
 *
 * A platform with no descriptor (or a bot / malformed author) yields `null`:
 * the message is still captured, just without `author_entity_id`.
 */
import { chatUserIdentityFor } from '../../lobu/stores/chat-identity-sources.js';
import type { ResolvedIdentity } from '../../utils/entity-link-upsert.js';

export interface SenderIdentitySpec {
  /** Normalized identity keys the sender is looked up / minted under. */
  identities: ResolvedIdentity[];
  /** Entity type to mint when no existing entity owns the identity. */
  mintEntityType: string;
}

export interface RawChatSender {
  platform: string;
  teamId?: string | null;
  authorId?: string | null;
  isBot: boolean;
}

/**
 * Build the normalized identity spec for a chat sender, or `null` when it
 * shouldn't be attributed (a bot, a platform with no identity descriptor, or
 * an id the descriptor refuses to key).
 */
export function buildSenderIdentity(sender: RawChatSender): SenderIdentitySpec | null {
  // A bot post never attributes to a human entity.
  if (sender.isBot) return null;

  const identity = chatUserIdentityFor(sender.platform);
  if (!identity) return null;

  // Let the connector reject malformed or insufficiently scoped sender ids.
  const identifier = identity.buildUserKey(sender.teamId, sender.authorId);
  if (!identifier) return null;

  return {
    identities: [
      {
        namespace: identity.namespace,
        identifier,
        matchOnly: false,
        primary: false,
        // Share the identity across connections in this org: the descriptor
        // already includes any upstream tenant scope in the key.
        scopeKey: null,
      },
    ],
    mintEntityType: 'person',
  };
}
