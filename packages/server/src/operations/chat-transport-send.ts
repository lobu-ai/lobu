/**
 * Delivery for connector actions declared `delivery: 'chat_transport'`: the
 * gateway's chat transport posts them through the connection's Chat SDK
 * adapter. An agent's `send_message` to anywhere but the conversation that
 * asked creates such a run; this module is what executes it, inline or after
 * approval.
 *
 * Execution trusts nothing it is handed. An approver may edit the input, and a
 * binding may be revoked while a run waits, so the destination is
 * re-authorized against the agent's CURRENT bindings and the text re-checked
 * at dispatch, on exactly the input that is about to be posted.
 */

import {
  type AddressableTarget,
  resolveAddressableTargets,
  threadHandleForMessage,
} from "../gateway/conversations/authorization.js";
import { captureChannelMessage } from "../gateway/connections/channel-transcript.js";
import { getChatInstanceManager } from "../lobu/gateway.js";

export const MAX_CHAT_MESSAGE_LENGTH = 4000;
// Refuse mass-mentions: both the human-written `@channel` form (anywhere, not
// just after whitespace) and Slack's actual broadcast tokens `<!channel>` /
// `<!here>` / `<!everyone>` / `<!subteam^…>`.
const MASS_MENTION =
  /@(channel|here|everyone)\b|<!(channel|here|everyone|subteam)\b/i;

/** Why `text` may not be posted, or null when it may. */
export function outboundChatTextError(text: string): string | null {
  if (!text) return "text is required";
  if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
    return `Message too long (max ${MAX_CHAT_MESSAGE_LENGTH} chars)`;
  }
  if (MASS_MENTION.test(text)) {
    return "Mass mentions (@channel/@here/@everyone) are not allowed";
  }
  return null;
}

/** Run metadata a chat_transport run is created with: whose bindings fence it. */
export interface ChatTransportRunMetadata {
  agent_id: string;
}

export function chatTransportRunMetadata(
  runMetadata: Record<string, unknown> | null | undefined,
): ChatTransportRunMetadata | null {
  const value = runMetadata?.chat_transport as { agent_id?: unknown } | undefined;
  return typeof value?.agent_id === "string" && value.agent_id
    ? { agent_id: value.agent_id }
    : null;
}

/**
 * The thread handle a later turn replies into: the thread the adapter reports
 * the post landed in. A post the adapter reports at channel level (a Telegram
 * DM, WhatsApp, a new Teams or Google Chat message) gets no handle. A handle
 * built from its message id would name a thread the platform cannot post
 * into, and a send never degrades to channel level, so the follow-up would
 * fail.
 */
export function threadHandleForPost(
  target: AddressableTarget,
  sent: { messageId: string; threadId: string },
): string | undefined {
  const threadRoot = typeof sent.threadId === "string" ? sent.threadId.split(":")[2] : undefined;
  return threadRoot ? threadHandleForMessage(target, threadRoot) : undefined;
}

/**
 * Post `text` to an authorized target and record it in the transcript. The
 * thread, when given, must resolve exactly: a send never degrades to a
 * channel-level post, which would land where nobody addressed or approved it.
 */
export async function postToChatTarget(params: {
  organizationId: string;
  agentId: string;
  target: AddressableTarget;
  threadId?: string;
  text: string;
}): Promise<{ messageId: string; threadId: string }> {
  const { organizationId, agentId, target, threadId, text } = params;
  const manager = getChatInstanceManager();
  if (!manager?.postToConversation) {
    throw new ChatTransportUnavailableError();
  }
  const sent = (await manager.postToConversation(target.connectionId, {
    platform: target.platform,
    channelKey: target.channelKey,
    channelId: target.channelId,
    threadId,
    content: { markdown: text },
    // Follow the thread we just posted into so replies come back to us and
    // land in the transcript.
    subscribe: true,
    threadFallback: false,
  })) as { messageId: string; threadId: string };

  // Persist the bot's own post (with the real platform message id) so
  // read_conversation includes it AND the inbound echo dedups against it.
  if (sent.messageId) {
    captureChannelMessage({
      organizationId,
      connectionId: target.connectionId,
      platform: target.platform,
      channelId: target.channelId,
      threadId: threadId ?? null,
      platformMessageId: sent.messageId,
      authorId: agentId,
      authorName: agentId,
      // Bot's own post — no sender attribution; team_id is not in scope here.
      teamId: null,
      isBot: true,
      text,
      occurredAt: new Date(),
    });
  }
  return sent;
}

/** Nothing was posted: no chat instance manager runs on this pod. */
export class ChatTransportUnavailableError extends Error {
  constructor() {
    super("Chat instance manager unavailable");
  }
}

type DeliveryResult =
  | { ok: true; output: { message_id: string | null; thread: string | undefined } }
  | { ok: false; error: string };

/**
 * Execute one chat_transport run: `{ channel_id, thread_id?, text }` on the
 * run's connection, fenced to the bindings of the agent that requested it.
 */
export async function deliverChatTransportSend(params: {
  organizationId: string;
  connectionId: number;
  input: Record<string, unknown>;
  runMetadata: Record<string, unknown> | null | undefined;
}): Promise<DeliveryResult> {
  const requester = chatTransportRunMetadata(params.runMetadata);
  if (!requester) {
    return { ok: false, error: "This message was not requested by an agent's send_message." };
  }
  const channelId = typeof params.input.channel_id === "string" ? params.input.channel_id : "";
  const threadRoot = typeof params.input.thread_id === "string" ? params.input.thread_id : undefined;
  const text = typeof params.input.text === "string" ? params.input.text.trim() : "";
  const textError = outboundChatTextError(text);
  if (textError) return { ok: false, error: textError };

  const targets = await resolveAddressableTargets(requester.agent_id, params.organizationId);
  const target = targets.find(
    (candidate) =>
      candidate.connectionDbId === params.connectionId &&
      candidate.channelId === channelId &&
      !candidate.crossOrg,
  );
  if (!target) {
    return {
      ok: false,
      error: `The agent is not bound to channel '${channelId}' on this connection.`,
    };
  }
  const threadId = threadRoot ? `${target.platform}:${target.channelId}:${threadRoot}` : undefined;
  const sent = await postToChatTarget({
    organizationId: params.organizationId,
    agentId: requester.agent_id,
    target,
    threadId,
    text,
  });
  return {
    ok: true,
    output: {
      message_id: sent.messageId || null,
      thread: threadHandleForPost(target, sent),
    },
  };
}
