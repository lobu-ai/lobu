/**
 * Message handler bridge — connects Chat SDK events to the message queue.
 * Bridges all 9 feature gaps: history, agent auto-creation, provider setup,
 * settings links, allowlist, audio transcription, etc.
 */

import { randomUUID } from "node:crypto";
import type { AutomationExecutionConfig } from "@lobu/core/contracts/tools/manage-automations";

import {
  type DeviceExecutionTarget,
  createLogger,
  createRootSpan,
  generateTraceId,
} from "@lobu/core";
import {
  previewUnlinkedNotice,
  workspaceUnlinkedNotice,
} from "../../preview/slack.js";
import type { CommandDispatcher } from "../commands/command-dispatcher.js";
import { createChatReply } from "../commands/command-reply-adapters.js";
import { normalizeStatefulChatCommand } from "../commands/command-spelling.js";
import type { ArtifactStore } from "../files/artifact-store.js";
import { ingestAttachments, type AttachmentSource } from "../files/attachment-ingestion.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import type { CoreServices } from "../platform.js";
import {
  buildMessagePayload,
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";
import { resolveSlackBotIdentity } from "../../authz/slack-acl-sync.js";
import {
  buildAutomationTurnContext,
  type AutomationActivationPlan,
  type ChatReplyActivation,
  dispatchAutomationRunsBestEffort,
  planAutomationActivationsForRuntimeConnection,
  queueAutomationActivations,
  type RuntimeConnectionAutomationLookup,
} from "../../automations/activation.js";
import {
  claimAutomationCooldownStandalone,
  markZeroCooldownAutomationActivation,
} from "../../automations/cooldown.js";
import {
  buildAgentSettingsUrl,
  buildProviderConnectUrl,
} from "../../utils/url-builder.js";
import { buildCtaCardPayload } from "../platform/link-buttons.js";
import { stripPlatformPrefix } from "../channels/bound-channels.js";
import { buildConversationUrl } from "./conversation-url.js";
import { captureChannelMessage } from "./channel-transcript.js";
import { createSlackWebApi } from "./slack-web.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import type { PlatformConnection } from "./types.js";

const logger = createLogger("chat-message-bridge");

/**
 * Inbound file shape passed to the worker on platformMetadata.files.
 * `downloadUrl` is a signed, time-limited public artifact URL the worker
 * can fetch over the proxy without any platform-specific auth.
 */
export interface IngestedFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  downloadUrl: string;
}

/**
 * Markdown-safe display label for a transcript file reference. The artifact
 * route's `Content-Disposition` still carries the real filename on download —
 * this only needs to be a label that can't break the `[name](url)` link
 * grammar, so the web's strip/lift regex stays reliable for *any* uploaded
 * filename (e.g. one containing `]`, `)`, or newlines).
 */
function sanitizeRefLabel(name: string): string {
  return name.replace(/[[\]()\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "file";
}

/**
 * Workspace id carried on the provider envelope (Slack `team_id`/`team`).
 * Both admission checks and the routing planner must read it the same way, or
 * a team-scoped chat link is admitted by one and rejected by the other.
 */
function teamIdFromRawMessage(raw: unknown): string | undefined {
  const envelope = raw as Record<string, unknown> | undefined;
  const teamId = envelope?.team_id ?? envelope?.team;
  return typeof teamId === "string" ? teamId : undefined;
}

function parseProviderFromModelRef(modelRef: string): string | null {
  const trimmed = modelRef.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

function webOriginFromGateway(publicGatewayUrl: string): string {
  const base = publicGatewayUrl.replace(/\/$/, "");
  return base.endsWith("/lobu") ? base.slice(0, -"/lobu".length) : base;
}

/**
 * Is this provider module usable RIGHT NOW for this agent/org — i.e. it has a
 * credential (system key or org-shared/agent key) AND a routable proxy mapping?
 * Both checks matter: a provider can be "installed" yet have no key, and a keyed
 * provider can still fail to produce a route (misconfigured upstream).
 */
async function providerIsRoutable(
  provider: {
    providerId: string;
    hasSystemKey(): boolean;
    hasCredentials(
      agentId: string,
      ctx: { organizationId: string; userId: string }
    ): Promise<boolean>;
    getProxyBaseUrlMappings(
      proxyBaseUrl: string,
      agentId: string,
      ctx: { organizationId: string; userId: string }
    ): Record<string, string>;
  },
  ctx: {
    services: CoreServices;
    agentId: string;
    organizationId: string;
    userId: string;
  }
): Promise<boolean> {
  const hasCredentials =
    provider.hasSystemKey() ||
    (await provider.hasCredentials(ctx.agentId, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    }));
  if (!hasCredentials) return false;
  const proxyBaseUrl = `${webOriginFromGateway(ctx.services.getPublicGatewayUrl())}/api/proxy`;
  const mappings = provider.getProxyBaseUrlMappings(proxyBaseUrl, ctx.agentId, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  return Object.keys(mappings).length > 0;
}

type ModelProviderResolution =
  | { kind: "ok" }
  | { kind: "fallback"; model: string; from: string; to: string }
  // A pre-enqueue rejection: the specific reason text + a CTA kind. The caller
  // resolves the kind to a URL and renders it through the SAME shared card path
  // as the terminal-error bridge (native button, platform-agnostic) — never a
  // URL inlined into prose.
  | {
      kind: "error";
      text: string;
      cta: "agent-settings" | "provider-connect";
      provider: string;
      model: string;
    };

/**
 * Preflight the model a message will run on. Order of outcomes:
 *  - ok: the configured EXACT ref is allowed and its provider is routable.
 *  - fallback: it isn't routable (or, under a non-empty list, not allowed), but
 *    the agent has a listed ALTERNATE whose exact ref is routable → run that
 *    alternate. Alternates are tried in the agent's models[] order.
 *  - error: nothing usable → surface a setup link.
 *
 * The gate is EXACT: when the agent has a non-empty `models` list, a ref that
 * isn't in that list is rejected even if its PROVIDER prefix is listed — so
 * `models:["openai/gpt-5"]` does not admit `openai/other`. There is NO
 * org-default tail: an unroutable listed model falls back only to another
 * LISTED alternate, never to an unlisted model.
 */
async function validateMessageModelProvider(params: {
  services: CoreServices;
  agentId: string;
  organizationId?: string;
  userId: string;
  modelRef?: unknown;
}): Promise<ModelProviderResolution> {
  if (typeof params.modelRef !== "string") return { kind: "ok" };
  const modelRef = params.modelRef.trim();
  const providerId = parseProviderFromModelRef(modelRef);
  if (!providerId) return { kind: "ok" };

  const catalog = params.services.getProviderCatalogService?.();
  if (!catalog || !params.organizationId) return { kind: "ok" };
  const organizationId = params.organizationId;

  const { modules, allowedRefs } = await catalog.getModelPolicy(
    params.agentId,
    organizationId
  );

  const routableCtx = {
    services: params.services,
    agentId: params.agentId,
    organizationId,
    userId: params.userId,
  };

  // A concrete ref is usable when (a) it clears the exact allow-list — always,
  // when the agent allows all providers — and (b) its provider module is
  // present and routable (keyed + a proxy route builds).
  const refIsAllowed = (ref: string): boolean =>
    allowedRefs === null || allowedRefs.includes(ref);
  const providerForRef = async (
    ref: string
  ): Promise<ModelProviderModule | undefined> =>
    catalog.findProviderForModel(ref, modules);

  // Happy path: the exact ref is allowed AND its provider is routable.
  if (refIsAllowed(modelRef)) {
    const provider = await providerForRef(modelRef);
    if (provider && (await providerIsRoutable(provider, routableCtx))) {
      return { kind: "ok" };
    }
  }

  // The configured ref can't run. Fall back to the agent's listed ALTERNATES,
  // in order — the exact refs the agent declared (not a provider's catalog
  // default), so multiple same-provider entries act as ordered fallbacks. When
  // the agent allows all providers there is no alternate list to walk; the
  // original ref was the only ask, so we go straight to the setup link.
  if (allowedRefs !== null) {
    for (const altRef of allowedRefs) {
      if (altRef === modelRef) continue;
      const altProvider = await providerForRef(altRef);
      if (!altProvider) continue;
      if (!(await providerIsRoutable(altProvider, routableCtx))) continue;
      return {
        kind: "fallback",
        model: altRef,
        from: modelRef,
        to: altProvider.providerId,
      };
    }
  }

  // Genuinely nothing usable. The two reasons take DIFFERENT fixes, so they map
  // to different CTA kinds: a model that isn't in the agent's allow-list is
  // fixed by picking an allowed one (agent-settings); a provider with no
  // credentials/route is fixed by connecting it (provider-connect). The caller
  // renders the text + CTA through the shared card path.
  const modelNotAllowed = !refIsAllowed(modelRef);
  const text = modelNotAllowed
    ? `I can't run this yet: the model \`${modelRef}\` isn't in this agent's allowed model list. Pick an allowed model to continue.`
    : `I can't run this yet: the provider for \`${modelRef}\` isn't connected or has no credentials. Connect it to continue.`;
  return {
    kind: "error",
    text,
    cta: modelNotAllowed ? "agent-settings" : "provider-connect",
    provider: providerId,
    model: modelRef,
  };
}

/**
 * Append a tokenless artifact-route reference (`[name](/api/v1/files/:id)`) for
 * each non-image attachment to the user's message text, so non-image uploads
 * survive in the (text+image-only) pi-ai transcript and the web can lift them
 * back into attachment chips on reload. Images are skipped — they persist as
 * inline transcript blocks, so a ref would render a duplicate chip. The history
 * read path re-signs these tokenless refs with a fresh download token, so the
 * persisted transcript never embeds an expiring credential.
 *
 * Pure + exported for unit testing.
 */
export function buildAttachmentTranscriptText(
  messageContent: string,
  ingestedFiles: IngestedFile[]
): string {
  const refs = ingestedFiles
    .filter((f) => !f.mimetype?.startsWith("image/"))
    .map((f) => `[${sanitizeRefLabel(f.name)}](/api/v1/files/${f.id})`);
  if (refs.length === 0) return messageContent;
  return [messageContent, refs.join("\n")]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

const AUDIO_MIMES_PREFIX = ["audio/"] as const;
const AUDIO_MIMES_EXACT = new Set(["application/ogg"]);

function isAudioAttachment(mime: string | undefined): boolean {
  if (!mime) return false;
  if (AUDIO_MIMES_EXACT.has(mime)) return true;
  return AUDIO_MIMES_PREFIX.some((p) => mime.startsWith(p));
}

/**
 * Detect a preview-link redemption in plain message text. Slack blocks slash
 * commands in an "Agents & AI Apps" DM, so `lobu run`'s `/lobu link <code>`
 * can't be sent as a slash command there — Slack either rejects it ("not
 * supported in threads") or, for a bot that registers `/lobu`, never delivers
 * it as a message. So accept the code as plain text: `link <code>`, the
 * `/lobu link <code>` / `/link <code>` forms when they do arrive as text, and a
 * bare `<slug>-<CODE>` paste. Codes always contain a hyphen (`slug-SUFFIX`), so
 * we require one to avoid matching chatter like "link me". The bare form is
 * gated to DMs to avoid matching stray channel messages. Returns the code, or
 * null. The native channel slash command and `tryHandleSlashText` still handle
 * the `/`-prefixed forms.
 */
export function parsePreviewLinkCode(
  text: string,
  isGroup: boolean
): string | null {
  const t = text.trim();
  const explicit = t.match(/^(?:\/?lobu\s+)?\/?link\s+(\S+)$/i);
  if (explicit?.[1] && explicit[1].includes("-")) return explicit[1];
  if (!isGroup && /^[a-z][a-z0-9-]*-[A-Z0-9]{6}$/.test(t)) return t;
  return null;
}

/**
 * Inbound chat SDK attachment shape (loose subset of `chat.Attachment`).
 * Defined here so that this module — and its tests — don't have to take a
 * runtime dependency on the chat SDK.
 */
export type InboundAttachmentLike = AttachmentSource;

/**
 * Fetch every inbound attachment via the chat SDK's auth-aware
 * `Attachment.fetchData()` and publish each as a gateway artifact. Returns
 * the worker-facing `files` array (signed `downloadUrl` per file) and the
 * raw audio buffers needed by the transcription path. Errors fetching an
 * individual attachment are logged and skipped — they must not abort the
 * whole message.
 */
export async function ingestInboundAttachments(
  attachments: InboundAttachmentLike[] | undefined,
  artifactStore: ArtifactStore,
  publicGatewayUrl: string
): Promise<{
  files: IngestedFile[];
  audioBytes: Array<{ buffer: Buffer; mimeType: string }>;
}> {
  const audioBytes: Array<{ buffer: Buffer; mimeType: string }> = [];
  const artifacts = await ingestAttachments(attachments ?? [], artifactStore, publicGatewayUrl, {
    onBytes: (buffer, mimeType) => {
      if (isAudioAttachment(mimeType)) audioBytes.push({ buffer, mimeType });
    },
    onError: (error, attachment) => {
      logger.error(
        { error: String(error), mimeType: attachment.mimeType, type: attachment.type, name: attachment.name },
        "Failed to ingest inbound attachment"
      );
    },
  });
  const files = artifacts.map((artifact) => ({
    id: artifact.artifactId,
    name: artifact.filename,
    mimetype: artifact.contentType,
    size: artifact.size,
    downloadUrl: artifact.downloadUrl,
  }));

  return { files, audioBytes };
}

export function isSenderAllowed(
  allowFrom: string[] | undefined,
  userId: string
): boolean {
  if (!Array.isArray(allowFrom)) {
    return true;
  }
  return allowFrom.includes(userId);
}

export function isEarlyDispatchableChatCommand(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  const firstToken = tokens[0];
  if (!firstToken?.startsWith("/")) return false;
  const first = firstToken.replace(/^\/+/, "");
  const command = first === "lobu" ? tokens[1] : first;
  return ["help", "status", "try", "agents", "link"].includes(command ?? "");
}

type MessageSource = "mention" | "dm" | "subscribed" | "interaction";

type MessageRouting = {
  channelId: string;
  conversationId: string;
  responseThreadId?: string;
  payloadTeamId?: string;
  spanName?: string;
  logMessage?: string;
  logExtra?: Record<string, unknown>;
};

/**
 * Register Chat SDK event handlers for a connection.
 *
 * Returns the bridge instance so callers (e.g. ChatInstanceManager) can
 * reuse its enqueue pipeline for non-`onNewMention` ingress points —
 * specifically, button clicks from the interaction bridge.
 */
export function registerMessageHandlers(
  chat: any,
  connection: PlatformConnection,
  services: CoreServices,
  manager: ChatInstanceManager,
  commandDispatcher?: CommandDispatcher
): MessageHandlerBridge {
  const handler = new MessageHandlerBridge(
    connection,
    services,
    manager,
    commandDispatcher
  );

  chat.onNewMention(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "mention");
  });

  chat.onDirectMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "dm");
  });

  chat.onSubscribedMessage(async (thread: any, message: any) => {
    await handler.handleMessage(thread, message, "subscribed");
  });

  // Chat SDK subscriptions are thread-scoped. Slack gives every top-level
  // channel message a fresh thread id (`slack:C…:<message-ts>`), so an
  // Automation linked to the CHANNEL can never pre-subscribe the ids of future
  // messages. Those ordinary `message.channels` events therefore fall through
  // the SDK's mention/DM/subscribed branches into its pattern handlers. The
  // SDK routes subscribed → mention → patterns and returns at the first match,
  // so this catch-all only ever sees events the branches above declined; it
  // cannot double-dispatch a mention. Admit only channels that already have a
  // durable message Automation — unlinked channels stay silent.
  if (connection.platform === "slack") {
    chat.onNewMessage(/[\s\S]*/, async (thread: any, message: any) => {
      await handler.handleUnmatchedChannelMessage(thread, message);
    });
  }

  return handler;
}

export class MessageHandlerBridge {
  private artifactStore: ArtifactStore;
  private publicGatewayUrl: string;

  constructor(
    private connection: PlatformConnection,
    private services: CoreServices,
    private manager: ChatInstanceManager,
    private commandDispatcher?: CommandDispatcher,
    private automationPlanner: (
      args: RuntimeConnectionAutomationLookup
    ) => Promise<AutomationActivationPlan> = planAutomationActivationsForRuntimeConnection,
    private automationCooldown = {
      claim: claimAutomationCooldownStandalone,
      markZero: markZeroCooldownAutomationActivation,
    },
  ) {
    this.artifactStore = services.getArtifactStore();
    this.publicGatewayUrl = services.getPublicGatewayUrl();
  }

  /**
   * Locate the per-connection history store. Read lazily since the instance
   * is registered after `registerMessageHandlers` runs.
   */
  private conversationState(): ConversationStateStore | null {
    return (
      this.manager.getInstance(this.connection.id)?.conversationState ?? null
    );
  }

  /**
   * Route an ordinary channel message that Chat SDK could not classify as a
   * DM, mention, or subscribed THREAD. Lobu's chat-link contract is
   * channel-scoped, so the canonical Automation subscription is the admission
   * check. Trigger filters (team, mention_only, and so on) remain authoritative
   * in {@link handleMessage}; this method only decides whether the otherwise
   * unmatched event is worth sending through that planner.
   */
  async handleUnmatchedChannelMessage(
    thread: { id: string; channelId: string },
    message: { author?: { isBot?: boolean | "unknown"; isMe?: boolean }; raw?: unknown },
  ): Promise<void> {
    // The catch-all pattern sees bot-authored channel events too. Chat SDK
    // already suppresses this installation's own posts before dispatch, but
    // rejecting every bot author here also prevents two apps from answering
    // each other forever in a linked channel.
    if (message.author?.isBot === true || message.author?.isMe === true) return;

    const organizationId = this.connection.organizationId;
    const subscriptions = this.services.getAutomationSubscriptionService();
    if (!organizationId || !subscriptions) return;

    // `thread.channelId` is the adapter's `channelIdFromThreadId(thread.id)` —
    // for Slack, `slack:C…`, which the subscription reader normalizes to the
    // native `C…`. Never fall back to `thread.id`: a top-level Slack message's
    // thread id is `slack:C…:<ts>`, and that reader strips only one prefix
    // segment, so the lookup key would become `C…:<ts>` and match nothing.
    const linked = await subscriptions.channelHasMessageSubscription(
      this.connection.id,
      thread.channelId,
      organizationId,
      {
        crossOrganization: this.connection.settings?.previewMode === true,
        teamId: teamIdFromRawMessage(message.raw),
      },
    );
    if (!linked) return;

    await this.handleMessage(thread, message, "subscribed");
  }

  /**
   * Strip the bot's own mention out of inbound text. Slack delivers raw
   * `<@Uxxx>` tokens; the Chat SDK may strip the brackets, so we also catch the
   * bare `@Uxxx` form. Every command-matching call site must run on the
   * stripped text — `@mybot /link ABC123` is the normal way to address a bot in
   * a mention-gated group chat, and the slash regex requires a leading `/`.
   */
  private stripBotMention(text: string): string {
    const botMetadata = this.manager.getInstance(this.connection.id)?.connection
      .metadata;
    const botUsername = botMetadata?.botUsername as string | undefined;
    const botUserId = botMetadata?.botUserId as string | undefined;
    let stripped = text;
    if (botUsername) {
      stripped = stripped.replace(`@${botUsername}`, "").trim();
    }
    if (botUserId) {
      // Provider-sourced metadata, so escape it before it reaches `RegExp`: a
      // stray metacharacter would otherwise throw mid-message or over-strip.
      // Real Slack ids (`U…`) carry none, so their stripping is unchanged.
      const idPattern = botUserId.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      stripped = stripped
        .replace(new RegExp(`<@${idPattern}>`, "g"), "")
        .replace(new RegExp(`@${idPattern}\\b`, "g"), "")
        .replace(/\s+/g, " ")
        .trim();
    }
    return stripped;
  }

  /**
   * Reply at a routing dead end — an inbound message/interaction resolved to
   * no channel Automation and the connection has no owning agent — with a
   * "link this chat" notice instead of dropping silently.
   *
   * Slack keeps its original gate: only a tenant's OAuth-installed workspace
   * bot (`metadata.teamId`) gets the deep-linked notice. Every other platform
   * gets the generic dashboard+CLI notice (#2230). Loop safety needs no extra
   * state: the Chat SDK never re-delivers the bot's own posts (`isMe`), and a
   * channel with an Automation subscription never reaches this dead end (the
   * planner-rejection guard in `handleMessage` drops it silently first).
   *
   * Returns true when a notice was posted (the caller should stop).
   */
  private async postUnlinkedChatNotice(
    thread: { post: (content: unknown) => Promise<unknown> },
    channelId: string,
    teamId: string | undefined
  ): Promise<boolean> {
    const platform = this.connection.platform;
    if (!this.connection.organizationId) return false;

    let noticeChannel: {
      channelId: string;
      teamId?: string;
      channelName?: string;
      connectionId?: string;
    } = { channelId, connectionId: this.connection.id };

    if (platform === "slack") {
      // A tenant's OAuth-installed Slack workspace bot has no owning agent —
      // routing is via tagged Automations created by `/lobu link`. Before the
      // tenant links a channel, a non-command message resolves to nothing.
      // (Slash commands like `/lobu link` take the `onSlashCommand` path and
      // never reach here.)
      if (!this.connection.metadata?.teamId) return false;
      // Fall back to the connection's stored team when the raw event omits
      // team_id, so the deep-link stays team-scoped. The connection always
      // carries it — it's the gate above.
      const linkTeamId = teamId ?? this.connection.metadata?.teamId;
      // Best-effort: resolve the channel's friendly name (#general) for the
      // notice's deep-link label. Uses this connection's own bot token via
      // conversations.info; any failure (no token, not-in-channel, rate limit)
      // just drops to the channel id in the UI — never blocks the notice.
      let channelName: string | undefined;
      if (linkTeamId) {
        try {
          const slackWeb = createSlackWebApi();
          const identity = await resolveSlackBotIdentity(
            {
              installStore: this.services.getAppInstallationStore(),
              secretStore: this.services.getSecretStore(),
              slackWeb,
            },
            {
              organizationId: this.connection.organizationId,
              teamId: linkTeamId,
              connectionId: this.connection.id,
            }
          );
          if (identity?.token) {
            const info = await slackWeb.conversationInfo(
              identity.token,
              stripPlatformPrefix(platform, channelId)
            );
            channelName = info.name ?? undefined;
          }
        } catch (err) {
          logger.debug(
            { channelId, error: String(err) },
            "unlinked-notice: channel name lookup failed (using id)"
          );
        }
      }
      noticeChannel = {
        channelId,
        teamId: linkTeamId,
        channelName,
        connectionId: this.connection.id,
      };
    }

    const notice = await workspaceUnlinkedNotice(
      platform,
      this.connection.organizationId,
      noticeChannel
    );
    logger.info(
      { platform, channelId, teamId, connectionId: this.connection.id },
      "Unlinked chat and connection has no owning agent — replying with link notice"
    );
    await thread.post(notice);
    return true;
  }

  async handleMessage(
    thread: any,
    message: any,
    source: MessageSource,
    routing?: MessageRouting
  ): Promise<void> {
    const { connection } = this;

    if (source === "interaction" && !routing) {
      throw new Error("Interaction messages require explicit routing context");
    }

    // Guard: drop messages if the connection was stopped/removed
    if (!this.manager.has(connection.id)) {
      logger.info(
        { connectionId: connection.id },
        "Connection no longer active, dropping message"
      );
      return;
    }

    const platform = connection.platform;
    const userId = message.author?.userId ?? "unknown";
    const channelId =
      routing?.channelId ?? thread.channelId ?? thread.id ?? "unknown";
    const messageId = message.id ?? String(Date.now());
    const isGroup =
      source === "interaction"
        ? routing?.conversationId !== channelId
        : source === "mention" || source === "subscribed";
    // Collapse to the canonical `thread.id` whenever we're inside an existing
    // thread — group thread reply OR DM thread reply alike. Slack encodes
    // `slack:{channel}:{thread_ts}` (top-level DM has empty thread_ts so the id
    // ends with a trailing `:`); Telegram encodes `telegram:{chatId}` for
    // top-level and `telegram:{chatId}:{topicId}` inside a forum topic. Without
    // this, a `onDirectMessage` event for a reply in a DM thread (e.g. the
    // worker posted a scheduled-fire follow-up message and the user
    // clicked Reply on it) would fall back to the channel id and the bot's
    // response would land in the main DM pane instead of the thread.
    const isThreadReply =
      typeof thread.id === "string" &&
      thread.id !== channelId &&
      thread.id !== `${channelId}:`;
    const conversationId =
      routing?.conversationId ??
      (isGroup || isThreadReply ? (thread.id as string) : channelId);

    logger.info(
      {
        connectionId: connection.id,
        platform,
        userId,
        channelId,
        messageId,
        source,
      },
      "Processing inbound message"
    );

    // Gap 6: Allowlist check
    if (!isSenderAllowed(connection.settings?.allowFrom, userId)) {
      logger.info({ userId }, "Blocked by allowlist");
      return;
    }

    // Gap 6: Group check
    if (isGroup && connection.settings?.allowGroups === false) {
      logger.info({ channelId }, "Groups not allowed");
      return;
    }

    // Subscribe to thread for follow-up messages
    if (source === "mention" || source === "dm") {
      try {
        await thread.subscribe();
      } catch {
        // some platforms may not support subscribe
      }
    }

    // Resolve agent ID: a channel Event Automation wins, otherwise the connection's
    // owning agent. No more shadow agent creation — if neither matches we
    // drop the message.
    const automationSubscriptionService =
      this.services.getAutomationSubscriptionService();
    const teamId = teamIdFromRawMessage(message.raw);

    // Preview connections fan out to Automations in OTHER orgs (a
    // `/lobu link <code>` creates one under the claim's org, not this
    // connection's), so plan org-agnostically and route by the Automation's org.
    const isPreview = this.connection.settings?.previewMode === true;
    const normalizedChannelId = stripPlatformPrefix(platform, channelId);
    const automationSignal = {
      connector_key: platform,
      resource_type: "channel",
      resource_ref: teamId
        ? `${platform}:channel:${teamId}:${normalizedChannelId}`
        : `${platform}:channel:${normalizedChannelId}`,
      event_type: "message.created",
      delivery_id: `chat:${this.connection.id}:${messageId}`,
      label: `${platform} message in ${normalizedChannelId}`,
      input_text: typeof message.text === "string" ? message.text : "",
      occurred_at:
        message.metadata?.dateSent instanceof Date
          ? message.metadata.dateSent.toISOString()
          : new Date().toISOString(),
      attributes: {
        channel_id: normalizedChannelId,
        channel_key: channelId,
        user_id: userId,
        is_mention: source === "mention" || message.isMention === true,
        mention_only: source === "mention" || message.isMention === true,
        ...(teamId ? { team_id: teamId } : {}),
        ...(conversationId !== channelId ? { thread_id: conversationId } : {}),
      },
    };
    const automationPlan = this.connection.organizationId
      ? await this.automationPlanner({
          connectionOrganizationId: this.connection.organizationId,
          runtimeConnectionId: this.connection.id,
          signal: automationSignal,
          crossOrganization: isPreview,
        })
      : {
          signal: automationSignal,
          replyTargets: [],
          backgroundTargets: [],
        };
    const replyAutomations = automationPlan.replyTargets;
    const backgroundAutomations = automationPlan.backgroundTargets;
    const automation = replyAutomations[0] ?? backgroundAutomations[0];
    // The planner above is the only Automation routing decision because it
    // evaluates the complete trigger predicate. A channel-only subscription
    // lookup here would re-select Automations rejected by mention/team filters.
    const fallbackResolved = automation
      ? null
      : await resolveAgentId({
          platform,
          channelId,
          agentId: this.connection.agentId,
          organizationId: this.connection.organizationId,
        });
    const resolved = automation
      ? {
          agentId: automation.agentId,
          source: "automation" as const,
          organizationId: automation.organizationId,
          model: automation.model ?? undefined,
          instructions: automation.instructions,
          automationId: automation.automationId,
        }
      : fallbackResolved;
    if (!resolved) {
      // App-level commands still work when no Automation matches. Keep this
      // early path to commands whose complete implementation lives in the
      // dispatcher: /new and /clear have real state handling later in the
      // resolved path and must not be falsely acknowledged here.
      const unroutedCommandText = this.stripBotMention(
        typeof message.text === "string" ? message.text : ""
      );
      if (
        this.commandDispatcher &&
        isEarlyDispatchableChatCommand(unroutedCommandText)
      ) {
        const handled = await this.commandDispatcher.tryHandleSlashText(
          unroutedCommandText,
          {
            platform,
            userId,
            channelId,
            teamId,
            isGroup,
            conversationId,
            connectionId: this.connection.id,
            organizationId: this.connection.organizationId,
            reply: createChatReply((content) => thread.post(content)),
          }
        );
        if (handled) return;
      }

      // Linked channel but trigger filters rejected this message (e.g.
      // mention_only on a non-mention). The planner is the authority for
      // activation; do not fall through to the "unlinked" notice or the notice
      // would spam every ordinary message in a mention-only linked channel.
      if (
        automationSubscriptionService &&
        this.connection.organizationId &&
        (await automationSubscriptionService.channelHasMessageSubscription(
          this.connection.id,
          channelId,
          this.connection.organizationId,
          { crossOrganization: isPreview, teamId }
        ))
      ) {
        logger.info(
          { platform, channelId, teamId, connectionId: this.connection.id },
          "Channel has Automation subscription(s) but none matched this message — dropping"
        );
        return;
      }

      if (
        !isPreview &&
        (await this.postUnlinkedChatNotice(thread, channelId, teamId))
      ) {
        return;
      }
      logger.warn(
        { platform, channelId, teamId, connectionId: this.connection.id },
        "No channel Automation and connection has no owning agent — dropping message"
      );
      return;
    }

    const agentId = resolved.agentId;
    const routingOrgId =
      resolved.organizationId ?? this.connection.organizationId;
    const routingOrganizationIds = [
      ...new Set([
        ...replyAutomations.map((candidate) => candidate.organizationId),
        ...backgroundAutomations.map((candidate) => candidate.organizationId),
        ...(routingOrgId ? [routingOrgId] : []),
      ]),
    ];

    // Lazy self-heal (Slack Grid): an Automation written before its workspace was
    // known carries no team. Inbound Slack events reliably carry the REAL
    // workspace `T…` (never the enterprise `E…`), so converge the trigger's team
    // to it on the first message. Guarded to fill only an unknown team; best-
    // effort — a heal failure must never block routing.
    if (
      resolved.source === "automation" &&
      automationSubscriptionService &&
      platform === "slack" &&
      /^T[A-Z0-9]+$/i.test(teamId ?? "") &&
      routingOrganizationIds.length > 0
    ) {
      for (const organizationId of routingOrganizationIds) {
        try {
          await automationSubscriptionService.healSubscriptionTeam(
            this.connection.id,
            channelId,
            organizationId,
            teamId as string
          );
        } catch (err) {
          logger.debug(
            { channelId, teamId, organizationId, error: String(err) },
            "Automation team self-heal failed (non-fatal)"
          );
        }
      }
    }

    // A group message routed via the connection-owner fallback has no chat-link
    // Automation, so its channel is absent from Automation-backed visibility
    // (history / ACL graph / search / notifications). Materialize the missing
    // link so routing and visibility share one source of truth; later messages
    // then route via the planner as `source:"subscription"`. Create-only, so it
    // can never overwrite an explicit `/lobu link` that races it (decided under
    // the advisory lock inside createChatAutomation — race-safe across replicas).
    // Group channels only (DMs stay out of the bound set); hosted-preview
    // placeholder agents are excluded. Slack passes only a real workspace `T…`
    // (never enterprise `E…`); an unknown team is filled later by
    // healSubscriptionTeam. Best-effort — a failure must never block the turn.
    if (
      resolved.source === "connection" &&
      isGroup &&
      !isPreview &&
      automationSubscriptionService &&
      this.connection.organizationId
    ) {
      const bindingTeamId =
        platform !== "slack" || /^T[A-Z0-9]+$/i.test(teamId ?? "")
          ? teamId
          : undefined;
      try {
        await automationSubscriptionService.materializeConnectionFallbackLink(
          this.connection.id,
          this.connection.organizationId,
          agentId,
          platform,
          channelId,
          bindingTeamId
        );
      } catch (err) {
        logger.debug(
          { channelId, teamId, agentId, error: String(err) },
          "Connection-fallback chat-link materialization failed (non-fatal)"
        );
      }
    }

    // Durable transcript capture: persist this inbound message so
    // read_conversation can serve channel history from Postgres instead of the
    // throttled platform history API. Fire-and-forget + idempotent. thread_id is
    // the thread the message lives in (null at channel level).
    for (const organizationId of routingOrganizationIds) {
      captureChannelMessage({
        organizationId,
        connectionId: connection.id,
        platform,
        channelId,
        threadId: conversationId !== channelId ? conversationId : null,
        platformMessageId: messageId,
        authorId: userId,
        authorName: message.author?.fullName ?? message.author?.userName,
        teamId: teamId ?? null,
        isBot: message.author?.isMe === true,
        text: typeof message.text === "string" ? message.text : "",
        occurredAt:
          message.metadata?.dateSent instanceof Date
            ? message.metadata.dateSent
            : new Date(),
      });
    }

    // Whole-channel capture mode: a subscribed (non-mention) channel message is
    // now recorded above, but should NOT trigger an agent turn — the bot mirrors
    // the channel without responding to everything. Mentions/DMs still respond.
    // Applies equally to Automation-routed channels (post-migration chat links):
    // the pre-Automation path honored this flag, and exempting Automations silently
    // flipped record-only installs into full responders after the cutover.
    if (
      source === "subscribed" &&
      message.isMention !== true &&
      connection.settings?.recordChannelMessages === true &&
      !isEarlyDispatchableChatCommand(
        this.stripBotMention(
          typeof message.text === "string" ? message.text : ""
        ),
      )
    ) {
      return;
    }

    // Track first-time-seen user → agent association for visibility in the
    // admin API. Idempotent — agent_users has a (agent_id, platform, user_id)
    // unique constraint.
    const userAgentsStore = this.services.getUserAgentsStore();
    if (userAgentsStore && routingOrgId) {
      try {
        await userAgentsStore.addAgent(platform, userId, agentId, routingOrgId);
      } catch (error) {
        logger.warn(
          { agentId, userId, error: String(error) },
          "Failed to record agent_users association"
        );
      }
    }

    // Ingest every inbound attachment as an artifact, regardless of type.
    // Workers consume them via `platformMetadata.files`; we never hand the
    // worker platform-specific file IDs or bot tokens.
    const { files: ingestedFiles, audioBytes } = await ingestInboundAttachments(
      message.attachments,
      this.artifactStore,
      this.publicGatewayUrl
    );

    // Gap 7: Audio transcription — runs over the bytes we already fetched.
    let messageText = message.text ?? "";
    const transcriptionService = this.services.getTranscriptionService();
    if (transcriptionService && audioBytes.length > 0) {
      for (const audio of audioBytes) {
        try {
          const result = await transcriptionService.transcribe(
            audio.buffer,
            agentId,
            audio.mimeType
          );
          if ("text" in result && result.text) {
            messageText = messageText
              ? `${messageText}\n\n[Voice message]: ${result.text}`
              : result.text;
          }
        } catch (error) {
          logger.warn(
            { error: String(error), messageId },
            "Audio transcription failed"
          );
        }
      }
    }

    // Remove bot mention from text — shared with the unrouted dead-end slash
    // dispatch so both match commands addressed via an @-mention.
    messageText = this.stripBotMention(messageText);

    // Intercept bare and `/lobu`-wrapped new/clear commands before slash
    // dispatch.
    let sessionReset = false;
    const statefulCommand = normalizeStatefulChatCommand(messageText);
    if (statefulCommand === "new") {
      messageText = "Starting new session.";
      sessionReset = true;
    } else if (statefulCommand === "clear") {
      await this.conversationState()?.clearHistory(
        this.connection.id,
        channelId,
        conversationId
      );
      await thread.post({ text: "Chat history cleared." });
      return;
    }

    // Preview-link redemption as plain message text — preview connections only.
    // In an AI-app DM Slack won't deliver `/lobu link <code>` as a slash command,
    // so a hosted preview bot accepts the code as a message — `link <code>` or a
    // bare `<slug>-<CODE>` paste — and redeems via the same `link` command. Gated
    // to previewMode so a normal agent bot's DMs (where a code-looking message is
    // just chat for the agent) are never swallowed. Runs before the worker
    // enqueue and the previewMode menu so a pasted code binds.
    if (
      !sessionReset &&
      this.commandDispatcher &&
      this.connection.settings?.previewMode === true
    ) {
      const linkCode = parsePreviewLinkCode(messageText, isGroup);
      if (linkCode) {
        const handled = await this.commandDispatcher.tryHandle(
          "link",
          linkCode,
          {
            platform,
            userId,
            channelId,
            teamId,
            isGroup,
            conversationId,
            connectionId: this.connection.id,
            organizationId: this.connection.organizationId,
            reply: createChatReply((content) => thread.post(content)),
          }
        );
        if (handled) return;
      }
    }

    // Slash command dispatch — intercept before queueing to worker
    if (!sessionReset && this.commandDispatcher) {
      const handled = await this.commandDispatcher.tryHandleSlashText(
        messageText,
        {
          platform,
          userId,
          channelId,
          teamId,
          isGroup,
          conversationId,
          connectionId: this.connection.id,
          organizationId: this.connection.organizationId,
          reply: createChatReply((content) => thread.post(content)),
        }
      );
      if (handled) return;
    }

    // Preview connection (a hosted Lobu workspace bot — Slack, Telegram, …):
    // an unlinked DM/@-mention that ISN'T a command. Don't run the connection's
    // placeholder owning agent — reply with the "pick a demo agent" menu (or the
    // "wire your own agent" instructions) and stop. This MUST come after the
    // slash dispatch above: `/lobu link <code>` / `/lobu try <id>` arrive as
    // slash commands in channels, but as plain message text in an "Agents & AI
    // Apps" DM — they have to bind/pick via the dispatcher before we'd otherwise
    // preempt them with this menu.
    if (
      resolved.source === "connection" &&
      this.connection.settings?.previewMode === true
    ) {
      const notice = await previewUnlinkedNotice(platform, this.connection.id);
      if (notice) {
        logger.info(
          { platform, channelId, teamId, connectionId: this.connection.id },
          "Preview connection: unlinked chat — replying with demo-agent menu"
        );
        await thread.post(notice);
        return;
      }
    }

    // Gap 1: Retrieve + append conversation history via the SDK state adapter.
    const conversationState = this.conversationState();

    // Backfill: when the bot is first activated in a thread (mention or
    // first subscribed event), ask the Chat SDK adapter for the thread's
    // prior messages. Slack maps this to `conversations.replies` (Tier 3,
    // generous limit). Without this, a mid-thread mention has no context
    // for the messages that preceded it. `claimThreadBackfill` is an
    // atomic per-thread one-shot guard — runs at most once per thread per
    // HISTORY_TTL_MS window, regardless of how many events race in.
    if (
      conversationState &&
      isGroup &&
      (await conversationState.claimThreadBackfill(
        this.connection.id,
        thread.id
      ))
    ) {
      let backfillSucceeded = false;
      try {
        const adapter = (thread as any).adapter;
        if (adapter?.fetchMessages) {
          const result = await adapter.fetchMessages(thread.id, {
            limit: 50,
            direction: "forward",
          });
          for (const prior of result.messages ?? []) {
            if (prior.id === messageId) continue;
            const text = (prior.text ?? "").trim();
            if (!text) continue;
            const sentAt =
              prior.metadata?.dateSent instanceof Date
                ? prior.metadata.dateSent.getTime()
                : Date.now();
            await conversationState.appendHistory(
              this.connection.id,
              channelId,
              conversationId,
              {
                role: prior.author?.isMe ? "assistant" : "user",
                content: text,
                authorName: prior.author?.fullName,
                timestamp: sentAt,
              }
            );
            // Seed the durable transcript from the thread's prior messages too.
            if (prior.id) {
              for (const organizationId of routingOrganizationIds) {
                captureChannelMessage({
                  organizationId,
                  connectionId: this.connection.id,
                  platform,
                  channelId,
                  threadId:
                    conversationId !== channelId ? conversationId : null,
                  platformMessageId: prior.id,
                  authorId: prior.author?.userId,
                  authorName: prior.author?.fullName,
                  teamId: teamId ?? null,
                  isBot: prior.author?.isMe === true,
                  text,
                  occurredAt: new Date(sentAt),
                });
              }
            }
          }
          backfillSucceeded = true;
        } else {
          // Adapter doesn't expose fetchMessages — nothing to retry, treat
          // as "successful" so we don't hammer it on every event.
          backfillSucceeded = true;
        }
      } catch (error) {
        logger.warn(
          { connectionId: this.connection.id, channelId, error: String(error) },
          "Thread backfill failed; will retry on next event"
        );
      }
      if (!backfillSucceeded) {
        await conversationState.releaseThreadBackfill(
          this.connection.id,
          thread.id
        );
      }
    }

    const backgroundRuns = await queueAutomationActivations({
      matches: backgroundAutomations,
      signal: {
        ...automationPlan.signal,
        input_text: messageText,
      },
    });
    await dispatchAutomationRunsBestEffort(backgroundRuns);

    // `reply_to_source` Automations answer through the chat transport and never
    // write a `automation` run row, so they are invisible to the cooldown claim
    // `createAutomationEventRun` makes for background targets above. Claiming the
    // same cursor here is what stops `min_cooldown_seconds` being a debounce on
    // one half of the feature and a silent no-op on the other.
    const replyTargetsOffCooldown: ChatReplyActivation[] = [];
    for (const candidate of replyAutomations) {
      // `minCooldownSeconds` is a feature-enabled hint carried on the match, so
      // an ordinary chat Automation (the 0 default) skips the serialized
      // pre-enqueue claim and cannot be dropped by it. Automations that opted in
      // re-read and consume the window under the per-Automation lock; claim
      // failures propagate out of this handler.
      if (
        candidate.minCooldownSeconds > 0 &&
        !(await this.automationCooldown.claim(candidate.automationId))
      ) {
        continue;
      }
      replyTargetsOffCooldown.push(candidate);
    }
    // Every reply Automation being suppressed is not the same as none matching:
    // fall through to the empty-targets return rather than the owner-agent
    // fallback, or a debounced Automation would be answered by a plain chat turn.
    if (replyAutomations.length > 0 && replyTargetsOffCooldown.length === 0) {
      return;
    }

    const directTargets =
      replyTargetsOffCooldown.length > 0
        ? replyTargetsOffCooldown.map((candidate) => ({
            agentId: candidate.agentId,
            organizationId: candidate.organizationId,
            model: candidate.model ?? undefined,
            executionConfig: candidate.executionConfig ?? undefined,
            executionTarget:
              candidate.deviceWorkerId && candidate.agentKind
                ? ({
                    kind: "device",
                    deviceWorkerId: candidate.deviceWorkerId,
                    agentKind: candidate.agentKind,
                  } satisfies DeviceExecutionTarget)
                : undefined,
            automationId: candidate.automationId,
            minCooldownSeconds: candidate.minCooldownSeconds,
            instructions: candidate.instructions,
            activeRun: candidate.trigger.active_run ?? "queue",
          }))
        : resolved.source === "automation"
          ? []
          : [
              {
                agentId,
                organizationId: routingOrgId,
                model: resolved.model,
              },
            ];
    if (directTargets.length === 0) return;

    const sharedHistory =
      (await conversationState?.getHistory(
        this.connection.id,
        channelId,
        conversationId
      )) ?? [];
    await conversationState?.appendHistory(
      this.connection.id,
      channelId,
      conversationId,
      {
        role: "user",
        content: messageText,
        authorName: message.author?.fullName,
        timestamp: Date.now(),
      }
    );

    for (const target of directTargets) {
      await this.enqueueUserTurn({
        agentId: target.agentId,
        organizationId: target.organizationId,
        userId,
        channelId,
        conversationId,
        messageId:
          "automationId" in target
            ? `${messageId}:automation:${target.automationId}`
            : messageId,
        messageText,
        isGroup,
        isDirect: source === "interaction" ? undefined : !isGroup,
        thread,
        teamId,
        payloadTeamId:
          routing?.payloadTeamId ?? (isGroup ? channelId : platform),
        model: target.model,
        executionConfig:
          "executionConfig" in target ? target.executionConfig : undefined,
        executionTarget:
          "executionTarget" in target ? target.executionTarget : undefined,
        conversationHistory: sharedHistory,
        recordHistory: false,
        ephemeralContext:
          "automationId" in target
            ? buildAutomationTurnContext(target)
            : undefined,
        senderUsername: message.author?.userName,
        senderDisplayName: message.author?.fullName,
        responseThreadId: routing?.responseThreadId ?? thread.id,
        extraMetadata: {
          ...("automationId" in target
            ? {
                automationId: target.automationId,
                automationDeliveryId: automationSignal.delivery_id,
                automationActiveRunPolicy: target.activeRun,
              }
            : {}),
          ...(ingestedFiles.length > 0 && { files: ingestedFiles }),
          ...(sessionReset && { sessionReset: true }),
        },
        spanName: routing?.spanName ?? "message_received",
        logMessage:
          routing?.logMessage ?? "Message enqueued via Chat SDK bridge",
        logExtra: routing?.logExtra,
      });
      if ("automationId" in target && target.minCooldownSeconds === 0) {
        // The turn is already durably enqueued, so this cursor is pure
        // observability: a stamp failure must not abort the remaining targets
        // in this loop, which would silently drop a co-matched Automation.
        await this.automationCooldown
          .markZero(target.automationId)
          .catch(() => undefined);
      }
    }
  }

  /**
   * Shared enqueue tail for inbound turns. Owns the history append, payload
   * build, queue enqueue, and typing indicator that `handleMessage` and
   * `ingestClick` both perform identically; each caller supplies its
   * inbound-specific fields (message text, sender hints, span name, …).
   *
   * `senderDisplayName` doubles as the history `authorName` — both callers
   * pass the same value for the two.
   */
  private async enqueueUserTurn(args: {
    agentId: string;
    /** Org the turn runs under. For preview connections this is the linked
     * Automation's org (cross-org), not necessarily the connection's org. */
    organizationId: string | undefined;
    userId: string;
    channelId: string;
    conversationId: string;
    messageId: string;
    messageText: string;
    isGroup: boolean;
    /**
     * Authoritative inbound surface classification. Interaction clicks omit
     * this: their conversationId/channelId relationship identifies threading,
     * not whether the original surface was a DM or group channel.
     */
    isDirect?: boolean;
    thread: any;
    /**
     * Platform-native team/workspace id (Slack: team_id) carried on
     * platformMetadata as a Chat-SDK ephemeral/DM routing hint. Undefined for
     * platforms with no workspace concept (Telegram, etc.).
     */
    teamId: string | undefined;
    /** The `teamId` field passed to `buildMessagePayload` (routing key). */
    payloadTeamId: string;
    /**
     * Per-Automation model override — a `provider/model` ref. When set it wins
     * the layered fallback at enqueue; undefined =
     * fall back to the agent, then org, default.
     */
    model?: string;
    /** Saved local CLI run settings for a device turn. */
    executionConfig?: AutomationExecutionConfig;
    /**
     * Device placement admitted by the shared activation planner, which only
     * promotes a pin that names a local CLI — the device claim filter matches
     * runs on `agentKind`.
     */
    executionTarget?: DeviceExecutionTarget;
    ephemeralContext?: string;
    senderUsername?: string;
    senderDisplayName?: string;
    responseThreadId?: string;
    extraMetadata?: Record<string, unknown>;
    conversationHistory?: Awaited<
      ReturnType<ConversationStateStore["getHistory"]>
    >;
    recordHistory?: boolean;
    spanName: string;
    logMessage: string;
    logExtra?: Record<string, unknown>;
  }): Promise<void> {
    const {
      agentId,
      organizationId,
      userId,
      channelId,
      conversationId,
      messageId,
      messageText,
      isGroup,
      isDirect,
      thread,
      teamId,
      payloadTeamId,
      model,
      executionConfig,
      executionTarget,
      ephemeralContext,
      senderUsername,
      senderDisplayName,
      responseThreadId,
      extraMetadata,
      conversationHistory: suppliedConversationHistory,
      recordHistory = true,
      spanName,
      logMessage,
      logExtra,
    } = args;
    if (!organizationId) {
      throw new Error("organizationId is required for agent message routing");
    }
    const platform = this.connection.platform;

    const conversationState = this.conversationState();
    const conversationHistory =
      suppliedConversationHistory ??
      (await conversationState?.getHistory(
        this.connection.id,
        channelId,
        conversationId
      )) ??
      [];

    if (recordHistory) {
      await conversationState?.appendHistory(
        this.connection.id,
        channelId,
        conversationId,
        {
          role: "user",
          content: messageText,
          authorName: senderDisplayName,
          timestamp: Date.now(),
        }
      );
    }

    // Build payload and enqueue
    const traceId = generateTraceId(messageId);
    const agentSettingsStore = this.services.getAgentSettingsStore();

    // Create root span for distributed tracing
    const { span: rootSpan, traceparent } = createRootSpan(spanName, {
      "lobu.agent_id": agentId,
      "lobu.message_id": messageId,
      "lobu.platform": platform,
      "lobu.connection_id": this.connection.id,
    });

    try {
      // A per-Automation model override arrives on the resolved channel Automation
      // and wins the layered fallback; otherwise the agent/org
      // default resolves inside resolveAgentOptions. organizationId lets the org
      // default tail fire on this path.
      //
      // A device turn opts out of that fallback entirely. Its model names a
      // provider the local CLI registered, so the org's cloud default must
      // never fill in for an absent one, and an unqualified CLI model id
      // (no `<provider>/<model>` slash) would be dropped as malformed and
      // replaced by that same cloud default.
      const agentOptions = await resolveAgentOptions(
        agentId,
        executionTarget ? {} : model ? { model } : {},
        agentSettingsStore,
        organizationId
      );
      // Cloud only. A device turn already carries the whole executionConfig —
      // effort included — inside `deviceExecutionConfig` below, and its CLI
      // reads it from there; a second copy at the top level would be a
      // duplicate the device lane never consults.
      const effort = executionConfig?.effort;
      if (!executionTarget && typeof effort === "string" && effort.trim()) {
        agentOptions.effort = effort.trim();
      }

      if (executionTarget) {
        // No override means the local CLI's own default, never a cloud model.
        if (model) agentOptions.model = model;
        else delete agentOptions.model;
        // Only explicit local settings cross the device boundary. Other chat
        // producers resolve cloud defaults into agentOptions.model.
        agentOptions.deviceExecutionConfig = {
          ...executionConfig,
          ...(model ? { model } : {}),
        };
      }

      // Local CLI authentication belongs to the selected device, so a device
      // turn skips the cloud preflight: it has no provider to test against and
      // must never be swapped onto a connected cloud model.
      const modelResolution = executionTarget
        ? ({ kind: "ok" } as const)
        : await validateMessageModelProvider({
            services: this.services,
            agentId,
            organizationId,
            userId,
            modelRef: agentOptions.model,
          });
      if (modelResolution.kind === "error") {
        logger.warn(
          { traceId, agentId, organizationId, model: agentOptions.model },
          "Rejecting inbound message before enqueue: no connected+routable model provider"
        );
        // Resolve the CTA kind to a URL and render through the SAME shared card
        // path the terminal-error bridge uses — native button, platform-
        // agnostic, no URL inlined in prose.
        const gatewayUrl = this.services.getPublicGatewayUrl();
        const ctaUrl =
          modelResolution.cta === "provider-connect"
            ? await buildProviderConnectUrl(gatewayUrl, organizationId, {
                provider: modelResolution.provider,
                model: modelResolution.model,
                reason: "model_provider_not_connected",
                agentId,
              })
            : await buildAgentSettingsUrl(gatewayUrl, organizationId, agentId);
        const label =
          modelResolution.cta === "provider-connect"
            ? "Connect a provider"
            : "Choose a model";
        await thread.post(
          buildCtaCardPayload({
            text: modelResolution.text,
            url: ctaUrl,
            label,
          })
        );
        return;
      }
      if (modelResolution.kind === "fallback") {
        // The configured model's provider isn't connected, but the org has
        // another one that is. Run on it rather than dead-ending, and record
        // the swap so the divergence is visible in logs/traces.
        logger.warn(
          {
            traceId,
            agentId,
            organizationId,
            configuredModel: modelResolution.from,
            fallbackModel: modelResolution.model,
            fallbackProvider: modelResolution.to,
          },
          "Configured model provider not connected; falling back to a connected provider"
        );
        agentOptions.model = modelResolution.model;
      }

      // Link back to the source message so the agent's per-run context can show
      // it. Undefined for platforms/inputs where no correct URL exists.
      const conversationUrl = buildConversationUrl({
        platform,
        channelId,
        messageId,
      });

      const payload = buildMessagePayload({
        platform,
        userId,
        botId: platform,
        conversationId,
        teamId: payloadTeamId,
        agentId,
        organizationId,
        messageId,
        messageText,
        ephemeralContext,
        channelId,
        platformMetadata: {
          traceId,
          traceparent: traceparent || undefined,
          agentId,
          chatId: channelId,
          senderId: userId,
          senderUsername,
          senderDisplayName,
          // Preserve known absence through queued JSON so token minting does
          // not mistake the worker routing key for a native provider team.
          teamId: teamId ?? null,
          conversationUrl,
          isGroup,
          connectionId: this.connection.id,
          responseChannel: channelId,
          responseId: messageId,
          responseThreadId,
          conversationHistory:
            conversationHistory.length > 0 ? conversationHistory : undefined,
          ...extraMetadata,
          ...(typeof isDirect === "boolean" ? { isDirect } : {}),
        },
        agentOptions,
        executionTarget,
      });

      const queueProducer = this.services.getQueueProducer();
      await queueProducer.enqueueMessage(payload);

      logger.info(
        {
          traceId,
          traceparent,
          messageId,
          agentId,
          connectionId: this.connection.id,
          ...logExtra,
        },
        logMessage
      );

      // Show typing indicator
      try {
        await thread.startTyping?.("Processing...");
      } catch {
        // best effort
      }
    } finally {
      rootSpan?.end();
    }
  }

  /**
   * Feed a button-click into the same enqueue pipeline as a typed inbound
   * message. Chat SDK filters bot self-posts via `isMe`, so posting the
   * clicked value back into the thread does NOT trigger `handleMessage` —
   * this method is what makes a question-click actually become a new
   * worker turn.
   *
   * The caller supplies the original PostedQuestion context (userId,
   * channelId, conversationId, teamId, agentId) so routing stays identical
   * to the original session. The clicked `value` becomes the new
   * `messageText`.
   */
  async ingestClick(params: {
    userId: string;
    channelId: string;
    conversationId: string;
    teamId?: string;
    authorName?: string;
    authorUsername?: string;
    value: string;
    thread: any;
    responseThreadId?: string;
    interactionId?: string;
  }): Promise<void> {
    const {
      userId,
      channelId,
      conversationId,
      teamId,
      authorName,
      authorUsername,
      value,
      thread,
      responseThreadId,
      interactionId,
    } = params;

    await this.handleMessage(
      thread,
      {
        id: interactionId ?? `interaction-${randomUUID()}`,
        text: value,
        author: {
          userId,
          userName: authorUsername,
          fullName: authorName,
          isBot: false,
          isMe: false,
        },
        raw: teamId ? { team_id: teamId } : {},
        metadata: { dateSent: new Date() },
        attachments: [],
        isMention: false,
      },
      "interaction",
      {
        channelId,
        conversationId,
        responseThreadId: responseThreadId ?? conversationId,
        payloadTeamId: teamId || this.connection.platform,
        spanName: "question_click_received",
        logMessage: "Question click enqueued via Chat SDK bridge",
        logExtra: { value },
      }
    );
  }
}
