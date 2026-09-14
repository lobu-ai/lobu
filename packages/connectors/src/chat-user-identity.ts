/**
 * Connector-owned chat-identity descriptors.
 *
 * A chat platform's "who is this sender" model has two connector-specific
 * facts core code must never hardcode: which `entity_identities` namespace the
 * link is stored under, and how a raw (team, user) pair from an inbound message
 * becomes the storage key. Both live here, contributed by the connector that
 * owns the platform — mirroring `ChannelReadIdentity` for the read-ACL gate.
 *
 * The server collects these in `lobu/stores/chat-identity-sources.ts` and
 * dispatches on `platform`, so `resolveChatUserIdentity` names no connector.
 *
 * The KEY SHAPE is the whole point of the descriptor. Slack user ids are only
 * unique within a workspace, so Slack's key is the composite `T…:U…` and a
 * message without a team id must fail closed. A Google account id is globally
 * unique, so Google's key is the bare id and there is nothing to scope it by.
 * Getting that wrong in either direction is a mis-grant, not a wrong answer —
 * these links authorize approvals and agent re-binding.
 */

/** How one chat platform keys a sender identity. */
export interface ChatUserIdentity {
  /** Chat platform key an inbound message arrives on (`slack`, `gchat`, …). */
  platform: string;
  /**
   * The Better Auth `providerId` whose sign-in PROVES this identity. The login
   * writer stamps the namespace only after a successful OAuth exchange with
   * this provider; nothing else may mint the link.
   */
  providerId: string;
  /** `entity_identities` namespace the key is stored under. */
  namespace: string;
  /**
   * Build the storage key from an inbound message's team id and platform user
   * id. Returns null when the inputs cannot form a valid key — callers treat
   * null as "unlinked", which is the correct fail-closed answer.
   *
   * `teamId` is meaningful only for platforms whose user ids are tenant-scoped;
   * globally-unique platforms ignore it.
   */
  buildUserKey(
    teamId: string | null | undefined,
    platformUserId: string | null | undefined,
  ): string | null;
}
