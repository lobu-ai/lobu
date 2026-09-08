/**
 * Typed view over the loose `platformMetadata: Record<string, unknown>`
 * bag that rides on `ThreadResponsePayload` / `MessagePayload`. Workers
 * and producers stuff various fields onto this object — historically read
 * with `(metadata as any).fooBar` at every call site. That hid two real
 * bugs in the guardrails wiring: the agentId fallback typed itself wrong,
 * and the organizationId read assumed a string without a runtime guard.
 *
 * This module declares the contract and gives a single narrowing helper
 * so call sites can read fields without `any` and still tolerate the
 * absence of the field.
 */


export interface PlatformMetadata {
  /** Outbound: the Chat SDK connection the response originated from. */
  connectionId?: string;
  /** Outbound: optional override for the chat-level recipient. */
  chatId?: string;
  /** Outbound: alternative override (Slack legacy ephemerals). */
  responseChannel?: string;
  /** Outbound: full thread id (e.g. `telegram:{chat}:{topic}`). */
  responseThreadId?: string;
  /** Both directions: the agent that produced/should produce the message. */
  agentId?: string;
  /** Both directions: the agent's owning organization id. */
  organizationId?: string;
  /** Inbound: chat sender's platform user id. */
  senderId?: string;
  senderUsername?: string;
  senderDisplayName?: string;
  /**
   * Inbound: Slack workspace id (also used as `raw.team_id` shim). Explicit
   * `null` for a teamless chat so the queued JSON keeps the known absence and
   * token minting does not fall back to the payload's routing `teamId`.
   */
  teamId?: string | null;
  /**
   * Inbound: a link back to the originating conversation/message on the source
   * platform (e.g. a Slack permalink). Surfaced to the agent in its per-run
   * conversation context. Absent for platforms that have no addressable URL.
   */
  conversationUrl?: string;
  /** Outbound: marker for the session-reset signal from the worker. */
  sessionReset?: boolean;
  /** Outbound: distributed tracing context propagation. */
  traceparent?: string;
  /** Outbound: client-side message id correlation. */
  clientMessageId?: string;
  /**
   * Per-turn Automation id for reply-to-source delivery. The gateway restores it
   * from the durable row named by the signed per-run token, never from the
   * response body; the response bridge also verifies ownership.
   */
  automationId?: number;
}

/**
 * Read `platformMetadata` as a typed object. Always returns an object
 * (empty when missing) so callers can safely chain optional reads without
 * a null check at each site.
 */
export function readPlatformMetadata(
  metadata: Record<string, unknown> | null | undefined
): PlatformMetadata {
  if (!metadata || typeof metadata !== "object") return {};
  return metadata as PlatformMetadata;
}

/**
 * Narrow a single string field on platformMetadata. Returns undefined when
 * the field is missing, empty, or the wrong type — never throws.
 */
export function platformMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: keyof PlatformMetadata
): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}
