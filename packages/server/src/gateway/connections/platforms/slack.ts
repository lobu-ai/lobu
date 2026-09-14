/**
 * Slack capability descriptor: routing-info extraction, the file handler
 * built on the Chat SDK Postable.files path, and the per-agent identity
 * instruction provider. (Slack OAuth/coordinator semantics stay in
 * `SlackConnectionCoordinator` — it is connection lifecycle, not a per-message
 * capability.)
 */

import { createLogger } from "@lobu/core";
import { resolveSlackBotIdentity } from "../../../authz/slack-acl-sync.js";
import { stripPlatformPrefix } from "../../channels/bound-channels.js";
import type { IFileHandler } from "../../platform/file-handler.js";
import { SlackInstructionProvider } from "../slack-instruction-provider.js";
import { createSlackWebApi } from "../slack-web.js";
import { isSlackConfig } from "../types.js";
import type { PlatformConnection } from "../types.js";
import { postFileToChatTarget, streamToBuffer } from "./shared.js";
import type {
  ChatPlatformDescriptor,
  ChatPlatformInstance,
  NoticeChannelContext,
  NoticeChannelScope,
} from "./types.js";

const logger = createLogger("slack-platform");

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


/**
 * A tenant's OAuth-installed workspace bot has no owning agent — routing is by
 * tagged Automations created through `/lobu link`. Until the tenant links a
 * channel, an ordinary message resolves to nothing and earns the notice. A
 * connection with no known workspace cannot produce a usable deep link, so it
 * suppresses the notice instead of posting one that names nothing.
 */
async function resolveSlackNoticeChannelScope(
  connection: PlatformConnection,
  ctx: NoticeChannelContext
): Promise<NoticeChannelScope | null> {
  const storedTeamId = connection.metadata?.teamId;
  if (!storedTeamId) return null;
  // The inbound event may omit team_id; the connection always carries one —
  // that is the gate above — so the deep link stays workspace-scoped either way.
  const teamId = ctx.teamId ?? storedTeamId;

  // Best-effort `#general` for the link label, via this connection's own bot
  // token. Any failure (no token, not in channel, rate limit) falls back to the
  // channel id in the UI and must never block the notice.
  let channelName: string | undefined;
  try {
    const slackWeb = createSlackWebApi();
    const identity = await resolveSlackBotIdentity(
      {
        installStore: ctx.stores.getAppInstallationStore(),
        secretStore: ctx.stores.getSecretStore(),
        slackWeb,
      },
      { organizationId: ctx.organizationId, teamId, connectionId: connection.id }
    );
    if (identity?.token) {
      const info = await slackWeb.conversationInfo(
        identity.token,
        stripPlatformPrefix(connection.platform, ctx.channelId)
      );
      channelName = info.name ?? undefined;
    }
  } catch (err) {
    logger.debug(
      { channelId: ctx.channelId, error: String(err) },
      "unlinked-notice: channel name lookup failed (using id)"
    );
  }
  return { teamId, channelName };
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

  resolveNoticeChannelScope: resolveSlackNoticeChannelScope,

  createFileHandler: createSlackFileHandler,

  getInstructionProvider: (manager) => new SlackInstructionProvider(manager),
};
