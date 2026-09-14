/**
 * Slack capability descriptor: routing-info extraction, the file handler
 * built on the Chat SDK Postable.files path, and the per-agent identity
 * instruction provider. (Slack OAuth/coordinator semantics stay in
 * `SlackConnectionCoordinator` — it is connection lifecycle, not a per-message
 * capability.)
 */

import { stripPlatformPrefix } from "../../channels/bound-channels.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import { SlackInstructionProvider } from "../slack-instruction-provider.js";
import { isSlackConfig } from "../types.js";
import { postFileToChatTarget, streamToBuffer } from "./shared.js";
import type { ChatPlatformDescriptor, ChatPlatformInstance } from "./types.js";

function createSlackFileHandler(
  instance: ChatPlatformInstance
): IFileHandler | undefined {
  if (!isSlackConfig(instance.connection.config)) return undefined;
  if (typeof instance.connection.config.botToken !== "string") {
    return undefined;
  }
  const platform = instance.connection.platform;

  // For Slack, `conversationId` is the Chat SDK's canonical `thread.id`
  // (`slack:{channel}:{parent_thread_ts}`) for group threads, or the bare
  // channel id for DMs/channel-level posts (no thread_ts).
  const parseSlackThread = (
    channelId: string,
    conversationId?: string
  ): { channel: string; threadTs?: string } => {
    // Token-bound worker channel ids are canonical (`slack:D0123`); strip so
    // the fallbacks below can't rebuild a double-prefixed key.
    const nativeChannel = stripPlatformPrefix("slack", channelId);
    if (conversationId?.startsWith("slack:")) {
      const [, channel, threadTs] = conversationId.split(":");
      return {
        channel: channel || nativeChannel,
        threadTs: threadTs && threadTs !== "" ? threadTs : undefined,
      };
    }
    return { channel: nativeChannel };
  };

  return {
    // Use the Chat SDK's Postable.files mechanism — the slack adapter handles
    // files.uploadV2 internally. We resolve a Thread (in-thread reply) or
    // Channel (top-level) and post a Postable carrying the file buffer.
    uploadFile: async (fileStream, options) => {
      const target = parseSlackThread(options.channelId, options.threadTs);
      const buffer = await streamToBuffer(fileStream);

      const sent = await postFileToChatTarget(
        instance,
        {
          threadId: target.threadTs
            ? `${platform}:${target.channel}:${target.threadTs}`
            : undefined,
          channelKey: `${platform}:${target.channel}`,
        },
        {
          raw: options.initialComment || "",
          files: [{ data: buffer, filename: options.filename }],
        }
      );

      const uploadedFile = (sent?.attachments || sent?.files || [])[0] as
        | { id?: string; permalink?: string; name?: string; size?: number }
        | undefined;
      const fileId = String(
        uploadedFile?.id || sent?.id || sent?.messageId || sent?.ts || ""
      );
      return {
        fileId,
        permalink: uploadedFile?.permalink || "",
        name: uploadedFile?.name || options.filename,
        size: Number(uploadedFile?.size || buffer.length),
      };
    },
  };
}

export const slackPlatform: ChatPlatformDescriptor = {
  requiredConfigKeys: ["botToken", "signingSecret"],

  // Pre-existing lazy adapter factory, moved verbatim from the manager's
  // ADAPTER_FACTORIES map (adapter SDKs stay lazy-loaded per platform).
  createAdapter: async (c) =>
    (await import("@chat-adapter/slack")).createSlackAdapter(c),

  extractRoutingInfo: (body) => {
    const slack = body.slack as
      | { channel?: string; thread?: string; team?: string }
      | undefined;
    if (!slack?.channel) return null;
    return {
      channelId: slack.channel,
      conversationId: slack.thread,
      teamId: slack.team,
    };
  },

  // Chat Automation projections key Slack channels by the canonical
  // `slack:<id>` the bridge looks bindings up with (`thread.channelId`), but a
  // slash command hands us the bare `C…`/`D…`. A value that already carries a
  // transport prefix is left alone.
  canonicalChannelId: (channelId) =>
    /^[a-z]+:/i.test(channelId) ? channelId : `slack:${channelId}`,

  // `#` is how a Slack channel is written, and the stored name may or may not
  // already carry it.
  formatChannelLabel: (name) => `#${name.replace(/^#/, "")}`,

  // Inbound Slack events carry the REAL workspace `T…`; the enterprise `E…` of
  // a Grid org is not a workspace and must never be healed onto.
  healableTeamId: (teamId) => /^T[A-Z0-9]+$/i.test(teamId),

  // Slack gives every top-level channel message a fresh thread id
  // (`slack:C…:<message-ts>`).
  channelMessagesMintFreshThreadIds: true,

  createFileHandler: createSlackFileHandler,

  getInstructionProvider: (manager) => new SlackInstructionProvider(manager),
};
