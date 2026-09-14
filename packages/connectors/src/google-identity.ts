/**
 * Google connector identity namespace and normalization.
 *
 * Single source of truth for `google_user_id` rules. Google sign-in writes it;
 * the Google Chat sender lookup reads it. Connector-specific identity knowledge
 * stays in the connector package so core code never names Google.
 *
 * WHY ONE NAMESPACE SERVES BOTH: a Google Chat `User.name` is `users/{id}`,
 * where `{id}` is the same account id Google puts in the OIDC `sub` claim. So
 * the Chat sender and the web signer are keyed identically, with no directory
 * lookup in between. This was confirmed against real accounts before relying on
 * it — the Chat-side user cache and the stored OIDC `sub` agree digit for
 * digit — not inferred from Google's documentation alone.
 */

import type { ChatUserIdentity } from './chat-user-identity.js';
import type { ConnectorIdentityModule } from './connector-identity-module.js';

/** Connector-owned identity namespaces (not SDK-global). */
export const GOOGLE_IDENTITY = {
  /**
   * The Google account id (the OIDC `sub`), bare and unscoped. Unlike Slack's
   * `T…:U…`, this needs no tenant prefix: Google account ids are unique across
   * all of Google, so there is no second workspace that can mint the same id.
   */
  USER_ID: 'google_user_id',
} as const;

export type GoogleIdentityNamespace =
  (typeof GOOGLE_IDENTITY)[keyof typeof GOOGLE_IDENTITY];

/** Google Chat addresses a person as `users/{id}`; the stored key is bare. */
const GCHAT_USER_PREFIX = 'users/';

/**
 * Canonicalize a Google account id to its bare numeric form, accepting either
 * the raw ~21-digit id as the OIDC `sub` delivers it, or the Google Chat
 * resource name that wraps the same digits as `users/<id>`.
 *
 * Digits only, deliberately, and that rule is load-bearing rather than mere
 * hygiene. Not every stored Google OAuth account is a sign-in: a Google
 * CONNECTOR grant (drive/gmail/calendar) writes one too, under a synthetic
 * account id such as `connect_<n>_<n>` or `lobu-connector:<org>:google.drive:<id>`.
 * A connector authorization is a different consent from proving who you are, so
 * it must not mint a chat identity — and some of those grants DO request
 * `openid`, so a scope check would not separate them. The numeric rule does.
 *
 * It also refuses a Chat app id, a service-account resource name, an id from
 * another platform, and an empty string. Returns null when the value is not a
 * bare Google account id.
 */
export function normalizeGoogleUserId(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = trimmed.startsWith(GCHAT_USER_PREFIX)
    ? trimmed.slice(GCHAT_USER_PREFIX.length)
    : trimmed;
  // Bounded length: a Google account id is ~21 digits. The cap keeps an
  // unbounded string out of an indexed identity column.
  return /^[0-9]{1,32}$/.test(bare) ? bare : null;
}

/**
 * Normalize a Google identity namespace value. Returns `undefined` when the
 * namespace is not Google-owned (caller should fall back to generic hygiene).
 */
export function normalizeGoogleIdentityValue(
  namespace: string,
  raw: string,
): string | null | undefined {
  switch (namespace) {
    case GOOGLE_IDENTITY.USER_ID:
      return normalizeGoogleUserId(raw);
    default:
      return undefined;
  }
}

/** The Google connector's contribution to the server identity wiring. */
export const googleIdentityModule: ConnectorIdentityModule = {
  key: 'google',
  // Not recall-indexed: `google_user_id` links a signer to a chat sender, it is
  // not an event-recall key, so it ships no `idx_events_metadata_*` index.
  recallNamespaces: [],
  normalize: normalizeGoogleIdentityValue,
};

/**
 * Google Chat's sender-identity model: a `gchat` message's sender is keyed by
 * the bare Google account id, which a `google` sign-in proves.
 *
 * `teamId` is ignored on purpose. Slack needs it because two workspaces can
 * both contain `U12345`; Google cannot produce two accounts with one id, so
 * there is nothing to scope by and no cross-tenant bleed to prevent. Inbound
 * Google Chat events carry no workspace id anyway.
 */
export const gchatChatUserIdentity: ChatUserIdentity = {
  platform: 'gchat',
  providerId: 'google',
  namespace: GOOGLE_IDENTITY.USER_ID,
  buildUserKey(_teamId, platformUserId) {
    return normalizeGoogleUserId(platformUserId);
  },
};
