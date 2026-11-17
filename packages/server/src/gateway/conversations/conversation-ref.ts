/**
 * Structural identity for a conversation reference.
 *
 * A conversation is addressed two different ways in this codebase and they
 * cannot be compared as strings:
 *
 *  - Inbound dispatch stamps a flat `conversationId` on the turn — either the
 *    channel id (`slack:D0123`) or the SDK thread id (`slack:C0123:1700.123`).
 *    A top-level DM can also arrive as `slack:D0123:` with an EMPTY trailing
 *    thread segment (see `message-handler-bridge`'s `isThreadReply` check),
 *    which denotes the channel, not a thread.
 *  - The conversation tools address a `channelKey` (`${platform}:${channelId}`)
 *    plus an optional resolved `threadId`, because the model only ever holds an
 *    opaque handle that the server re-resolves per call.
 *
 * Comparing the flat forms with `===` therefore reports a false mismatch for
 * the trailing-colon DM, and cannot compare the tool form at all. Parse both
 * into components and compare those.
 */

import { parseAutomationRunConversationId } from "../permissions/automation-run-intent.js";

export interface ConversationRef {
  /** `${platform}:${channelId}` — the conversation's channel. */
  channelKey: string;
  /** Thread root within the channel; absent for a channel-level conversation. */
  threadId?: string;
}

/**
 * Parse a flat `conversationId` into its components.
 *
 * Returns `null` for anything without at least `platform:channelId`, so a
 * malformed or empty id can never accidentally compare equal to a real one.
 * An empty third segment (`slack:D0123:`) yields no `threadId` — that form
 * denotes the channel itself.
 */
export function parseConversationRef(
  conversationId: string | undefined
): ConversationRef | null {
  if (!conversationId) return null;
  const [platform, channelId, ...rest] = conversationId.split(":");
  if (!platform || !channelId) return null;
  const threadId = rest.join(":");
  return {
    channelKey: `${platform}:${channelId}`,
    ...(threadId ? { threadId } : {}),
  };
}

/** True when both references name the same channel AND the same thread scope. */
export function conversationRefsMatch(
  a: ConversationRef | null,
  b: ConversationRef | null
): boolean {
  if (!a || !b) return false;
  return a.channelKey === b.channelKey && a.threadId === b.threadId;
}

/**
 * THE decision whether a post is a reply in the conversation that asked for
 * it. Everything else an agent posts goes through policy as an operation run.
 *
 * `asking` comes from the worker's signed token, never from the model: the
 * thread the gateway routes this turn's replies to (`responseThreadId`), else
 * the turn's own conversation. `post` is the resolved destination: the route's
 * `threadId` is a full `platform:channel:root` thread id and is compared by
 * its parsed root, so `slack:C:ts` and the asking `slack:C:ts` agree. An
 * Automation turn has no asking conversation, so nothing it posts is a reply.
 */
export function isReplyInAskingConversation(
  asking: {
    connectionId?: string;
    conversationId: string;
    responseThreadId?: string;
  },
  post: { connectionId: string; channelKey: string; threadId?: string }
): boolean {
  if (!asking.connectionId || asking.connectionId !== post.connectionId) {
    return false;
  }
  if (parseAutomationRunConversationId(asking.conversationId)) return false;
  return conversationRefsMatch(
    parseConversationRef(post.threadId ?? post.channelKey),
    parseConversationRef(asking.responseThreadId ?? asking.conversationId)
  );
}
