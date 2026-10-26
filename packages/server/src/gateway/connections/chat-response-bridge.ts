/**
 * Chat response bridge — handles outbound responses from workers back through Chat SDK.
 *
 * Streaming is delegated to Chat SDK: deltas are pushed into an AsyncIterable which
 * is handed to `target.post()`. The adapter owns throttling, chunking, and
 * platform-specific rendering (Telegram buffers, Slack streams, etc.), so this
 * bridge is platform-agnostic.
 *
 * Platform quirks (e.g. Slack posting a single chunked `markdown_text` at
 * completion) live in `./platform-strategies`; the bridge picks one per
 * payload and delegates delta/completion shape to it.
 */

import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createLogger,
  type GuardrailRegistry,
  type SuggestedPrompt,
} from "@lobu/core";
import { toAgentErrorCode } from "@lobu/core";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { getDb } from "../../db/client.js";
import {
  buildAgentSettingsUrl,
  buildProviderConnectUrl,
  buildProviderManagementUrl,
  type RenderedAgentError,
  renderAgentError,
} from "../../utils/url-builder.js";
import {
  advanceScheduleAfterTerminalFailure,
  providerQuotaResetNotBefore,
} from "../../automations/schedule-cursor.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { InteractionService } from "../interactions.js";
import {
  isRetryableTurnError,
  turnRetryActionId,
} from "../orchestration/agent-turn-retry.js";
import { interactionTeamId } from "../orchestration/worker-token-claims.js";
import {
  OutputGuardrailScanner,
  type OutputGuardrailTrip,
} from "../guardrails/output-scan.js";
import type { ThreadResponsePayload } from "../infrastructure/queue/index.js";
import {
  buildCtaCardPayload,
  extractSettingsLinkButtons,
} from "../platform/link-buttons.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import { captureChannelMessage } from "./channel-transcript.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import {
  type PlatformMetadata,
  platformMetadataString,
  readPlatformMetadata,
} from "./platform-metadata.js";
import {
  getResponseStrategy,
  type PlatformResponseStrategy,
  type StreamState,
} from "./platform-strategies/index.js";
import { resolveChatTarget } from "./platforms/shared.js";

const logger = createLogger("chat-response-bridge");

/**
 * Construct a minimal Chat SDK `Message`-shaped object from the inbound
 * sender carried on `platformMetadata`. We only need enough to keep the SDK's
 * streaming code path happy — it reads `_currentMessage.author.userId` and
 * `_currentMessage.raw.team_id`/`raw.team` for ephemeral/DM fallback hints.
 * Passing `{}` crashes the SDK; passing `undefined` silently disables the
 * recipient hint; a proper Message preserves it.
 */
function buildCurrentMessageFromMetadata(
  threadId: string,
  platformMetadata: PlatformMetadata
): Record<string, unknown> | undefined {
  const senderId = platformMetadata.senderId;
  if (!senderId) return undefined;
  const senderUsername = platformMetadata.senderUsername;
  const senderDisplayName = platformMetadata.senderDisplayName;
  const teamId = platformMetadata.teamId;
  return {
    threadId,
    text: "",
    author: {
      userId: senderId,
      userName: senderUsername,
      fullName: senderDisplayName,
    },
    raw: teamId ? { team_id: teamId, team: teamId } : {},
  };
}

interface ResponseContext {
  connectionId: string;
  instance: any;
  channelId: string;
  platform: string;
  strategy: PlatformResponseStrategy;
}

/**
 * ChatResponseBridge implements ResponseRenderer so it can be plugged into
 * the unified thread consumer alongside legacy platform renderers.
 */
export class ChatResponseBridge implements ResponseRenderer {
  private streams = new Map<string, StreamState>();
  private interactionService?: InteractionService;
  /**
   * Output-stage guardrails. Shared with the API/SSE path
   * (UnifiedThreadResponseConsumer) so both surfaces enforce ONE policy:
   * when an agent has output guardrails, streaming deltas are withheld and
   * only the scanned, authoritative terminal text is delivered. This replaces
   * the bridge's former per-delta rolling-tail scanner + blockedStreams set —
   * that state was pod-local (so it never caught a secret split across deltas
   * on different replicas) and was not cleared on the error path (a trip then
   * an error left the next turn's stream silently blocked).
   */
  private readonly outputGuardrail = new OutputGuardrailScanner();

  constructor(private manager: ChatInstanceManager) {}

  /**
   * Wire output-stage guardrails. Both must be set for guardrails to run;
   * with neither, the bridge behaves as before.
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.outputGuardrail.setGuardrails(registry, settingsStore);
  }

  setInteractionService(interactionService: InteractionService): void {
    this.interactionService = interactionService;
  }

  /**
   * Resolve the agentId for a payload: payload metadata first, then the
   * bound connection's agent. Returns `null` when neither is known so
   * the caller can skip guardrails rather than block.
   */
  private resolveAgentId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | null {
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.agentId) return md.agentId;
    const fromConnection = ctx.instance?.connection?.agentId;
    return typeof fromConnection === "string" && fromConnection
      ? fromConnection
      : null;
  }

  /**
   * Resolve the turn's owning organization for tenant-scoped output. The
   * authenticated worker gateway stamps it directly on the payload; for a
   * hosted-preview turn this is the Automation org and intentionally differs
   * from the shared chat connection's org. Gateway-generated responses may not
   * carry that field, so metadata and connection values remain fallbacks.
   */
  private resolveOrganizationId(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): string | undefined {
    if (payload.organizationId) return payload.organizationId;
    const md = readPlatformMetadata(payload.platformMetadata);
    if (md.organizationId) return md.organizationId;
    const fromConnection = ctx.instance?.connection?.organizationId;
    return typeof fromConnection === "string" && fromConnection
      ? fromConnection
      : undefined;
  }

  /**
   * Park the scheduled side of a reply-to-source Automation when its event turn
   * hits a known provider quota boundary. These turns intentionally have no
   * Automation run row, so the API run terminalizer cannot move their cursor.
   *
   * The gateway-restored Automation id is still scoped to the authenticated
   * organization and agent that own it. Database errors propagate
   * so the durable thread-response job retries instead of delivering an error
   * while leaving the Automation immediately due.
   */
  async parkQuotaExhaustedAutomation(
    payload: ThreadResponsePayload
  ): Promise<void> {
    const notBefore = providerQuotaResetNotBefore(
      payload.error ?? "",
      payload.errorCode
    );
    if (!notBefore) return;

    const metadata = readPlatformMetadata(payload.platformMetadata);
    const automationId = metadata.automationId;
    if (
      typeof automationId !== "number" ||
      !Number.isSafeInteger(automationId) ||
      automationId < 1
    ) {
      return;
    }

    const organizationId = payload.organizationId ?? metadata.organizationId;
    const agentId = metadata.agentId;
    if (!organizationId || !agentId) return;

    const sql = getDb();
    await sql.begin(async (tx) => {
      const owned = await tx<{ id: number }>`
        SELECT id
        FROM automations
        WHERE id = ${automationId}
          AND organization_id = ${organizationId}
          AND managed_agent_id = ${agentId}
          AND status = 'active'
        LIMIT 1
      `;
      if (owned.length === 0) return;
      await advanceScheduleAfterTerminalFailure(
        tx,
        automationId,
        "event",
        notBefore
      );
    });
  }

  /**
   * Whether this payload's agent has output guardrails configured. When true,
   * streaming deltas are withheld and only the scanned terminal text is sent.
   */
  private async hasOutputGuardrails(
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): Promise<boolean> {
    const agentId = this.resolveAgentId(payload, ctx);
    if (!agentId) return false;
    return this.outputGuardrail.hasOutputGuardrails(
      agentId,
      this.resolveOrganizationId(payload, ctx)
    );
  }

  /**
   * Scan the authoritative terminal text (reply or error). Returns the trip
   * (already audited) on block, `null` when safe to send / no guardrails.
   */
  private async scanTerminalOutput(
    text: string,
    payload: ThreadResponsePayload,
    ctx: ResponseContext
  ): Promise<OutputGuardrailTrip | null> {
    const agentId = this.resolveAgentId(payload, ctx);
    if (!agentId || !text) return null;
    return this.outputGuardrail.scanFinal(text, {
      agentId,
      organizationId: this.resolveOrganizationId(payload, ctx),
      userId: payload.userId,
      conversationId: payload.conversationId,
      platform: ctx.platform,
      toolsUsed: payload.toolsUsed,
    });
  }

  private async postSuggestions(
    payload: ThreadResponsePayload,
    ctx: ResponseContext,
    prompts: SuggestedPrompt[]
  ): Promise<void> {
    const organizationId = this.resolveOrganizationId(payload, ctx);
    if (!this.interactionService || !organizationId) return;
    try {
      await this.interactionService.postSuggestion(
        organizationId,
        payload.userId,
        payload.conversationId,
        ctx.channelId,
        interactionTeamId(payload.platformMetadata, payload.teamId),
        ctx.connectionId,
        ctx.platform,
        prompts
      );
    } catch (error) {
      // Chips are optional; the reply is already delivered.
      logger.warn(
        {
          connectionId: ctx.connectionId,
          conversationId: payload.conversationId,
          error: String(error),
        },
        "Follow-up suggestions were not posted"
      );
    }
  }

  private extractResponseContext(
    payload: ThreadResponsePayload
  ): ResponseContext | null {
    const md = readPlatformMetadata(payload.platformMetadata);
    const connectionId = md.connectionId;
    if (!connectionId) return null;

    const instance = this.manager.getInstance(connectionId);
    if (!instance) return null;

    const channelId = md.chatId ?? md.responseChannel ?? payload.channelId;

    const platform = instance.connection.platform;

    return {
      connectionId,
      instance,
      channelId,
      platform,
      strategy: getResponseStrategy(platform),
    };
  }

  /**
   * Check if this payload belongs to a Chat SDK connection AND make this
   * replica able to deliver it. Connections hydrate lazily (no boot
   * warm-start), so whichever replica claims a thread_response hydrates the
   * connection from its row before rendering — gating on a warm instance
   * alone would make the webhook-receiving pod the only possible deliverer,
   * which breaks the moment it restarts. Returns false for non-Chat-SDK
   * payloads and for connections this replica cannot run (deleted, stopped,
   * or an exclusive transport owned by another replica — the consumer's
   * retry re-queues those until the owner claims the job).
   */
  async ensureDeliverable(data: ThreadResponsePayload): Promise<boolean> {
    const connectionId = platformMetadataString(
      data.platformMetadata,
      "connectionId"
    );
    if (!connectionId) return false;
    return this.manager.warmConnection(connectionId);
  }

  async handleDelta(
    payload: ThreadResponsePayload,
    sessionKey: string
  ): Promise<string | null> {
    void sessionKey;
    if (payload.delta === undefined) return null;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return null;

    const { strategy, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // Withhold streaming deltas when the agent has output guardrails: a secret
    // split across deltas (and, under N>1, scattered across replicas) cannot be
    // reliably scanned mid-stream, so we don't stream at all. The full,
    // authoritative text is scanned and delivered at completion instead
    // (handleCompletion). Agents without output guardrails stream unchanged.
    if (await this.hasOutputGuardrails(payload, ctx)) return null;

    // Full-replacement disposes the prior stream so the strategy starts fresh.
    const existingForReplacement = this.streams.get(key);
    if (payload.isFullReplacement && existingForReplacement) {
      await strategy.disposeOnFullReplacement(existingForReplacement);
      this.streams.delete(key);
    }

    // After the (possible) full-replacement dispose, `current` is
    // undefined and the strategy starts a fresh stream.
    const current = this.streams.get(key);

    const next = await strategy.handleDelta({
      ctx,
      payload,
      existing: current,
      resolveTarget: () => this.resolveTargetForPayload(ctx, payload),
    });

    if (next) {
      this.streams.set(key, next);
    } else {
      this.streams.delete(key);
    }
    return null;
  }

  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, strategy, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    const stream = this.streams.get(key);
    if (stream) {
      // Close the iterator and drain the in-flight post regardless of
      // strategy — Slack's iterator is already closed (no-op), default's
      // needs explicit close+await before final delivery steps run.
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch (error) {
        logger.debug(
          { connectionId, error: String(error) },
          "Adapter stream errored during completion"
        );
      }
    }

    // Deliver when this replica has a local stream OR when this is a post-once
    // strategy (Slack) carrying the worker's full text. Under N>1 replicas the
    // delta rows and the terminal row are claimed competitively from the shared
    // `thread_response` queue with no per-conversation affinity, so the
    // completion can land on a pod that buffered no (or only some) deltas — only
    // `payload.finalText` is authoritative there. A live-streaming strategy with
    // no local stream already posted its deltas on the claiming replica, so it
    // is intentionally skipped (re-posting would duplicate).
    const canDeliverFromFinalText =
      strategy.deliversAtCompletion && !!payload.finalText?.trim();

    // When streaming was WITHHELD (guardrail agent), no deltas were sent on any
    // replica, so the authoritative finalText must be delivered here even for a
    // live-streaming strategy — its own handleCompletion returns early without a
    // local stream. (For non-guardrail agents this is false, preserving the
    // existing cross-pod no-double-post semantics.)
    const deliverWithheldFinalText =
      !strategy.deliversAtCompletion &&
      !stream &&
      !!payload.finalText?.trim() &&
      (await this.hasOutputGuardrails(payload, ctx));

    // Output guardrail on the full, authoritative terminal text. This is the
    // SINGLE enforcement point (deltas were withheld upstream for guardrail
    // agents), so it is replica-safe: it scans `payload.finalText` — set by the
    // worker on every completion — not pod-local stream buffers. On a trip:
    // post the block message and suppress both delivery and history.
    let blockedAtCompletion = false;
    {
      const completionText = [
        payload.finalText ?? stream?.buffer ?? "",
        ...(payload.suggestions ?? []).flatMap((prompt) => [prompt.title, prompt.message]),
      ].join("\n");
      if (completionText.trim()) {
        const trip = await this.scanTerminalOutput(completionText, payload, ctx);
        if (trip) {
          blockedAtCompletion = true;
          await this.postGuardrailBlock(
            payload,
            ctx,
            trip,
            "Failed to post guardrail block message at completion"
          );
        }
      }
    }

    // The agent already answered IN this conversation during the turn (it
    // called `send_message` on the conversation it was replying to, and the
    // send route matched that target against the run's own conversation from
    // the signed worker token). The user has read that message; `finalText` is
    // then a report about it, and delivering it too is the double-post.
    //
    // Stamped by the worker on the terminal row, so it is replica-safe for the
    // same reason `finalText` is: the completion is self-contained and any pod
    // can act on it. Absent (older worker, or nothing posted in-band) means
    // deliver — this suppresses only on a positive signal, never on silence.
    const suppressedByInBandReply = payload.repliedInBand === true;
    if (suppressedByInBandReply) {
      logger.info(
        {
          connectionId,
          channelId,
          conversationId: payload.conversationId,
        },
        "Agent replied in-band this turn — skipping terminal reply delivery"
      );
    }

    if (
      !blockedAtCompletion &&
      !suppressedByInBandReply &&
      (stream || canDeliverFromFinalText)
    ) {
      await strategy.handleCompletion({
        ctx,
        payload,
        stream: stream ?? null,
      });
    } else if (
      !blockedAtCompletion &&
      !suppressedByInBandReply &&
      deliverWithheldFinalText
    ) {
      // Post the scanned finalText directly — the live-streaming strategy can't
      // deliver it stream-less, and nothing was streamed (deltas withheld).
      await this.postToPayloadTarget(
        payload,
        ctx,
        payload.finalText as string,
        "Failed to deliver withheld final text"
      );
    }
    if (stream) this.streams.delete(key);

    const conversationState =
      this.manager.getInstance(connectionId)?.conversationState;

    // Gap 1: Store outgoing response in history. Wrap so that a state-store
    // outage doesn't fail the whole response delivery — the user has
    // already seen the message; missing history is recoverable, a 500
    // here is not. Prefer the worker's authoritative finalText: under N>1
    // replicas `stream?.buffer` is null (cross-pod) or only the subset of
    // deltas this pod claimed, so persisting it would store a truncated reply.
    const historyText = payload.finalText ?? stream?.buffer;
    if (!blockedAtCompletion && historyText?.trim() && conversationState) {
      try {
        await conversationState.appendHistory(
          connectionId,
          channelId,
          payload.conversationId,
          {
            role: "assistant",
            content: historyText,
            timestamp: Date.now(),
          }
        );
      } catch (error) {
        logger.warn(
          { connectionId, channelId, error: String(error) },
          "Failed to persist assistant response to history (continuing)"
        );
      }
      // Durable transcript: persist the bot's interactive reply too, so
      // read_conversation shows both sides. No platform message id is surfaced
      // here, so key on the turn's messageId (stable across a redelivered
      // completion). Fire-and-forget + idempotent. Skipped when the terminal
      // reply was suppressed: the transcript mirrors the platform channel, and
      // this text was never posted there — the in-band message was already
      // captured by the send route with its real platform id.
      const replyMd = readPlatformMetadata(payload.platformMetadata);
      if (replyMd.organizationId && !suppressedByInBandReply) {
        captureChannelMessage({
          organizationId: replyMd.organizationId,
          connectionId,
          platform: ctx.platform,
          channelId,
          threadId:
            payload.conversationId && payload.conversationId !== channelId
              ? payload.conversationId
              : null,
          platformMessageId: `bot:${payload.messageId}`,
          authorId: replyMd.agentId,
          authorName: replyMd.agentId,
          teamId: replyMd.teamId ?? null,
          isBot: true,
          text: historyText,
          occurredAt: new Date(),
        });
      }
    }

    // Session reset: clear history and delete session file
    const completionMd = readPlatformMetadata(payload.platformMetadata);
    if (completionMd.sessionReset) {
      const agentId = completionMd.agentId;
      try {
        await conversationState?.clearHistory(
          connectionId,
          channelId,
          payload.conversationId
        );
        logger.info(
          { connectionId, channelId, conversationId: payload.conversationId },
          "Cleared chat history for session reset"
        );
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "Failed to clear chat history on session reset"
        );
      }
      if (agentId) {
        try {
          const sessionPath = resolve(
            "workspaces",
            agentId,
            ".lobu",
            "session.jsonl"
          );
          await unlink(sessionPath);
          logger.info(
            { agentId, sessionPath },
            "Deleted session file for session reset"
          );
        } catch (error) {
          // File may not exist — that's fine
          logger.debug(
            { agentId, error: String(error) },
            "No session file to delete on reset"
          );
        }

        // The next worker boot would rehydrate from Postgres unless we
        // also purge the snapshot rows for this conversation. The
        // worker's reset path does the same purge via the
        // `/worker/transcript/snapshot` DELETE endpoint, but we
        // belt-and-suspenders here in case the worker exited before it
        // got to that step. Resolve the org via `agents.organization_id`
        // — the bridge doesn't carry org on the response payload.
        try {
          const sql = getDb();
          const deleted = await sql<{ id: number }>`
            DELETE FROM public.agent_transcript_snapshot s
            USING public.agents a
            WHERE s.agent_id = ${agentId}
              AND s.conversation_id = ${payload.conversationId}
              AND a.id = s.agent_id
              AND a.organization_id = s.organization_id
            RETURNING s.id
          `;
          if (deleted.length > 0) {
            logger.info(
              { agentId, conversationId: payload.conversationId, count: deleted.length },
              "Purged agent_transcript_snapshot rows for session reset"
            );
          }
        } catch (error) {
          logger.warn(
            { agentId, conversationId: payload.conversationId, error: String(error) },
            "Failed to purge transcript snapshots on session reset (next boot may rehydrate stale history)"
          );
        }
      }
    }

    // The reply's follow-up chips, as their own card AFTER the reply so they
    // read as its next steps. Not for a blocked reply, a suppressed duplicate
    // of an in-band answer, or a session reset.
    if (
      payload.suggestions?.length &&
      !blockedAtCompletion &&
      !suppressedByInBandReply &&
      !completionMd.sessionReset &&
      historyText?.trim()
    ) {
      await this.postSuggestions(payload, ctx, payload.suggestions);
    }

    logger.info(
      {
        connectionId,
        channelId,
        conversationId: payload.conversationId,
      },
      "Response completed via Chat SDK bridge"
    );
  }

  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    if (!payload.error) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId, channelId } = ctx;
    const key = `${channelId}:${payload.conversationId}`;

    // Clean up stream — close iterator so the adapter call resolves.
    // Capture whether the worker already delivered a complete, self-contained
    // user-facing message (via `sendStreamDelta(..., isFullReplacement=true)`).
    // When it did, we must NOT post the fallback raw "Error: …" because the
    // user already saw a formatted failure message like "❌ Session failed: …".
    //
    // For partial streams that errored mid-way (`isFullReplacement` never set),
    // the fallback still fires so the user sees a failure indicator instead of
    // silently-truncated output.
    //
    // A native agent turn's error row (`turnRunId`) is never such a message:
    // its full-replacement span is a re-run restarting a PARTIAL answer
    // (worker-api/agent-turn.ts), so its error must still be posted.
    const stream = this.streams.get(key);
    const alreadyDeliveredCompleteMessage =
      !!stream?.wasFullyReplaced && payload.turnRunId == null;
    if (stream) {
      stream.iterator.close();
      try {
        await stream.streamPromise;
      } catch {
        // swallow — we're already in error path
      }
      this.streams.delete(key);
    }

    if (alreadyDeliveredCompleteMessage) {
      logger.debug(
        { connectionId, channelId },
        "Skipping fallback error text — worker already delivered a complete user-facing message"
      );
      return;
    }

    // Session timeouts are retried automatically by the runs queue. The worker
    // deliberately suppresses its own user-facing crash delta for them, so the
    // platform fallback must stay silent too — otherwise the user sees a raw
    // "Error: SESSION_TIMEOUT" for a turn that is about to be retried.
    if (payload.errorCode === "SESSION_TIMEOUT") {
      logger.debug(
        { connectionId, channelId },
        "Skipping fallback error text — session timed out and will be retried"
      );
      return;
    }

    // Known error code → render user-facing text + a real CTA link from the
    // shared catalog (AGENT_ERRORS). This is the ONE place a coded error
    // becomes Slack/Telegram output; adding a failure mode never touches this
    // branch, only the catalog. Unknown/empty code falls through to the raw
    // fallback below.
    const code = toAgentErrorCode(payload.errorCode);
    let ctaButton: RenderedAgentError | null = null;
    if (code) {
      const gatewayUrl = this.manager.getPublicGatewayUrl();
      const orgId = this.resolveOrganizationId(payload, ctx) ?? undefined;
      const agentId = this.resolveAgentId(payload, ctx) ?? undefined;
      const rendered = await renderAgentError(
        code,
        payload.error,
        {
          // "pick a model" → the agent's settings tab.
          'agent-settings': () =>
            buildAgentSettingsUrl(gatewayUrl, orgId, agentId),
          // "connect a provider" → the provider's connector detail page, with
          // the same provider/model targeting + agent context the pre-enqueue
          // preflight passes (message-handler-bridge parity).
          'provider-connect': () =>
            buildProviderConnectUrl(gatewayUrl, orgId, {
              ...payload.errorContext,
              agentId,
            }),
          // Provider auth/quota/routing → manage the exact existing provider.
          'provider-management': () =>
            buildProviderManagementUrl(gatewayUrl, orgId, payload.errorContext),
        },
        payload.errorContext
      );
      if (rendered.silent) return;
      payload.error = rendered.text;
      if (rendered.ctaUrl) ctaButton = rendered;
    }

    // Scan the error text before surfacing it — a provider/stack-trace error
    // can echo a secret. On a trip, post the generic block message instead of
    // the raw error.
    const errorTrip = await this.scanTerminalOutput(payload.error, payload, ctx);
    if (errorTrip) {
      await this.postGuardrailBlock(
        payload,
        ctx,
        errorTrip,
        "Failed to post guardrail block on error"
      );
      return;
    }

    // Coded error with a resolved CTA → post a Card with a native link button
    // (shared with the pre-enqueue preflight via buildCtaCardPayload) so the
    // user gets a clickable action, not a bare URL in prose. Loopback URLs fall
    // back to text inside the helper.
    if (ctaButton?.ctaUrl) {
      await this.postToPayloadTarget(
        payload,
        ctx,
        buildCtaCardPayload({
          text: ctaButton.text,
          url: ctaButton.ctaUrl,
          label: ctaButton.ctaLabel,
        }),
        "Failed to send error card"
      );
      return;
    }

    // A native turn its worker failed to finish gets a Retry button: pressing
    // it re-admits the same message (`retryInterruptedAgentTurn`, handled by
    // the interaction bridge's `turn-retry:` action).
    if (code && isRetryableTurnError(code) && payload.turnRunId != null) {
      await this.postToPayloadTarget(
        payload,
        ctx,
        {
          card: Card({
            children: [
              CardText(payload.error),
              Actions([
                Button({ id: turnRetryActionId(payload.turnRunId), label: "Retry" }),
              ]),
            ],
          }),
          fallbackText: payload.error,
        },
        "Failed to send retryable error card"
      );
      return;
    }

    // Fallback: plain text error via Chat SDK. For a coded error this is the
    // catalog text (already assigned above); for an unclassified error it's the
    // raw worker message — a signal to add a catalog entry.
    await this.postToPayloadTarget(
      payload,
      ctx,
      `Error: ${payload.error}`,
      "Failed to send error message"
    );
  }

  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    // Show typing indicator
    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) {
        await target.startTyping?.("Processing...");
      }
    } catch {
      // best effort
    }
  }

  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    if (!payload.content) return;

    const ctx = this.extractResponseContext(payload);
    if (!ctx) return;

    const { connectionId } = ctx;

    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) {
        const { processedContent, linkButtons } = extractSettingsLinkButtons(
          payload.content
        );

        if (linkButtons.length > 0) {
          const fallbackText = `${processedContent}\n\n${linkButtons.map((button) => `${button.text}: ${button.url}`).join("\n")}`;
          const card = Card({
            children: [
              CardText(processedContent),
              Actions(
                linkButtons.map((button) =>
                  LinkButton({ url: button.url, label: button.text })
                )
              ),
            ],
          });
          try {
            await this.postContent(ctx, payload, target, { card, fallbackText });
            return;
          } catch (error) {
            // A strategy-owned send may have been delivered before it failed,
            // so a second post of the same notice could duplicate it.
            if (ctx.strategy.post) throw error;
            logger.warn(
              { connectionId, error: String(error) },
              "Failed to render ephemeral settings button"
            );
            await this.postContent(ctx, payload, target, fallbackText.trim());
            return;
          }
        }

        await this.postContent(ctx, payload, target, processedContent);
      }
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Failed to send ephemeral message"
      );
    }
  }

  // --- Private ---

  /**
   * Resolve the Chat-SDK post target for a payload, marshalling the
   * channel/conversation/responseThreadId/sender-hint arguments out of the
   * payload + context the same way at every call site.
   */
  private resolveTargetForPayload(
    ctx: ResponseContext,
    payload: ThreadResponsePayload
  ): Promise<any | null> {
    return this.resolveTarget(
      ctx.instance,
      ctx.channelId,
      payload.conversationId,
      platformMetadataString(payload.platformMetadata, "responseThreadId"),
      readPlatformMetadata(payload.platformMetadata)
    );
  }

  /**
   * Resolve the payload's target and post `content` to it, swallowing and
   * logging any failure. Shared by the guardrail-block and error-fallback
   * paths — a delivery failure here must never throw back into the consumer.
   */
  private async postToPayloadTarget(
    payload: ThreadResponsePayload,
    ctx: ResponseContext,
    content: unknown,
    logMessage: string
  ): Promise<void> {
    try {
      const target = await this.resolveTargetForPayload(ctx, payload);
      if (target) await this.postContent(ctx, payload, target, content);
    } catch (err) {
      logger.error({ connectionId: ctx.connectionId, err: String(err) }, logMessage);
    }
  }

  /** Post through the strategy when it owns delivery, else the SDK target. */
  private postContent(
    ctx: ResponseContext,
    payload: ThreadResponsePayload,
    target: any,
    content: unknown
  ): Promise<unknown> {
    return ctx.strategy.post
      ? ctx.strategy.post({ ctx, threadId: target.id, messageId: payload.messageId, content })
      : target.post(content);
  }

  /**
   * Post the user-facing "blocked by guardrail" notice for a trip. Shared by
   * the per-delta scan in handleDelta and the post-once scan in
   * handleCompletion so the block copy stays identical across both paths.
   */
  private postGuardrailBlock(
    payload: ThreadResponsePayload,
    ctx: ResponseContext,
    trip: { guardrail: string; reason?: string },
    logMessage: string
  ): Promise<void> {
    const blockText = `Message blocked by guardrail: ${trip.reason ?? trip.guardrail}`;
    return this.postToPayloadTarget(payload, ctx, blockText, logMessage);
  }

  private async resolveTarget(
    instance: any,
    channelId: string,
    conversationId?: string,
    responseThreadId?: string,
    platformMetadata: PlatformMetadata = {}
  ): Promise<any | null> {
    // Build the initialMessage from the inbound sender so the Chat SDK can
    // populate `_currentMessage.author` for `handleStream` (it reads
    // `.author.userId` unconditionally — passing `{}` crashes there). The
    // `threadId` field on the message is cosmetic (the SDK derives the thread
    // id from the positional arg), so one message serves both createThread
    // branches.
    const currentMessage = buildCurrentMessageFromMetadata(
      responseThreadId ?? conversationId ?? channelId,
      platformMetadata
    );
    return resolveChatTarget(instance.chat, instance.connection.platform, {
      channelId,
      conversationId,
      responseThreadId,
      currentMessage,
    });
  }
}
