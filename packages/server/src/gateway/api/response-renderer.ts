#!/usr/bin/env bun

/**
 * API Response Renderer
 * Broadcasts worker responses to SSE connections for direct API clients
 */

import {
  AGENT_ERRORS,
  createLogger,
  type SuggestedPrompt,
  toAgentErrorCode,
} from "@lobu/core";
import { labelProviderErrorBody } from "../../utils/url-builder.js";
import type { ThreadResponsePayload } from "../infrastructure/queue/types.js";
import type { ResponseRenderer } from "../platform/response-renderer.js";
import type { SseManager } from "../services/sse-manager.js";
import { resolveAutomationRunsByMessageIds } from "../../automations/run-completion.js";
import { readCurrentSuggestion } from "../suggestions/persist-suggestion.js";

const logger = createLogger("api-response-renderer");

/**
 * Response renderer for API platform
 * Broadcasts responses to SSE clients instead of external platforms
 */
export class ApiResponseRenderer implements ResponseRenderer {
  constructor(private readonly sseManager: SseManager) {}

  /**
   * The SSE session a payload broadcasts to. Clients subscribe on the
   * conversation id (GET /events keys connections by session.conversationId
   * — see routes/public/agent.ts).
   */
  private sessionIdFor(payload: ThreadResponsePayload): string | undefined {
    return payload.conversationId;
  }

  /**
   * Handle streaming delta content
   * Broadcasts delta to SSE connections
   */
  async handleDelta(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<string | null> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for delta broadcast");
      return null;
    }

    // Broadcast delta to SSE clients
    this.sseManager.broadcast(sessionId, "output", {
      type: "delta",
      content: payload.delta,
      timestamp: payload.timestamp || Date.now(),
      messageId: payload.messageId,
    });

    logger.debug(
      `Broadcast delta to session ${sessionId}: ${payload.delta?.length || 0} chars`
    );

    return payload.messageId;
  }

  /**
   * Handle completion of response processing
   * Sends completion event to SSE clients
   */
  async handleCompletion(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for completion broadcast");
      return;
    }

    // Error rows are terminalized in handleError before delivery. Running the
    // success resolver again after the error was already broadcast creates a
    // redundant DB dependency and can cause duplicate delivery on retry.
    if (!payload.error) {
      // Complete durable Automation bookkeeping before delivering the terminal SSE
      // event. A database failure must reject the thread-response job so it can
      // retry; delivering first could acknowledge a turn whose run is unresolved
      // and whose schedule is still due.
      await this.resolveAutomationRunsFromPayload(payload, { ok: true });
    }

    // Resolve the current suggestion set for this conversation and decide
    // whether to attach it to `complete` (this turn produced it), clear it
    // (this turn produced none — stale chips must not linger), or leave it
    // untouched (turn errored — do not alter durable suggestion state). This
    // runs on the SSE-owning pod (terminal rows are owner-gated),
    // so embedding on `complete` — rather than a separate post-complete card
    // the SPA would miss after it closes the socket — is the only live path.
    const suggestions = await this.resolveTerminalSuggestions(payload);

    // Broadcast completion to SSE clients.
    //
    // Carry the worker's authoritative `finalText` (the full assistant reply,
    // added to the terminal row in gateway-integration.signalCompletion for
    // exactly this cross-replica reason). Streaming `output` deltas stay
    // best-effort under N>1: a delta row claimed on a non-owning pod is lost
    // (the SseManager is per-pod), so the SPA's accumulated text can be
    // truncated. The SPA repairs from `finalText` on this terminal event —
    // without it a cross-pod delta loss would leave a permanently truncated
    // message with no repair. (Empty string when nothing was streamed.)
    this.sseManager.broadcast(sessionId, "complete", {
      type: "complete",
      messageId: payload.messageId,
      processedMessageIds: payload.processedMessageIds,
      finalText: payload.finalText,
      suggestions,
      timestamp: payload.timestamp || Date.now(),
    });

    logger.info(`Broadcast completion to session ${sessionId}`);
  }

  /**
   * READ-ONLY: resolve the chips to embed on this turn's `complete` payload.
   * The durable set is already finalized before this runs — the consumer calls
   * `finalizeTurnSuggestions` at the terminal boundary (BEFORE the SSE
   * owner-gate), which supersedes a stale prior set or keeps this turn's own.
   * So the current row here is the authoritative post-turn state; this method
   * never mutates it, it only decides what the SPA renders:
   *  - errored turn → undefined ("no change").
   *  - a current set exists → return it (embed).
   *  - none current → [] ("clear"): finalize already superseded it.
   */
  private async resolveTerminalSuggestions(
    payload: ThreadResponsePayload
  ): Promise<SuggestedPrompt[] | undefined> {
    // Error delivery does not alter durable suggestion state.
    if (payload.error) return undefined;
    const organizationId =
      payload.organizationId ??
      (typeof payload.platformMetadata?.organizationId === "string"
        ? payload.platformMetadata.organizationId
        : undefined);
    if (!organizationId) return undefined;

    try {
      const current = await readCurrentSuggestion(
        organizationId,
        payload.conversationId
      );
      return current ? current.prompts : [];
    } catch (err) {
      // Never let suggestion resolution break completion delivery.
      logger.warn(
        `Failed to resolve terminal suggestions for ${payload.conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return undefined;
    }
  }

  /**
   * Handle error response
   * Sends error event to SSE clients
   */
  async handleError(
    payload: ThreadResponsePayload,
    _sessionKey: string
  ): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      logger.warn("No session ID found in payload for error broadcast");
      return;
    }

    // This SSE surface forwards the context so the frontend can build the CTA,
    // but it lacks the org/agent ids needed to resolve the URL itself.
    const code = toAgentErrorCode(payload.errorCode);
    const spec = code ? AGENT_ERRORS[code] : undefined;
    if (spec?.silent) {
      // Silent codes (SESSION_TIMEOUT) are retried and must not surface.
      await this.resolveAutomationRunsFromPayload(payload, {
        ok: false,
        error: "agent error",
        errorCode: code,
      });
      return;
    }
    const errorText =
      spec?.message ??
      labelProviderErrorBody(payload.error, payload.errorContext?.provider);

    await this.resolveAutomationRunsFromPayload(payload, {
      ok: false,
      // Persist only the guarded/user-visible text. The raw provider string is
      // used solely to parse a reset boundary and must never reappear through
      // Automation run metadata.
      error: typeof errorText === "string" ? errorText : "agent error",
      errorCode: code,
      quotaResetError: payload.bookkeepingError,
    });

    const errorEvent = {
      type: "error",
      error: errorText,
      errorCode: code,
      errorContext: payload.errorContext,
      processedMessageIds: payload.processedMessageIds,
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    };

    // Keep the legacy `error` event for existing consumers, but also emit a
    // non-reserved event name for browsers: native EventSource treats `error`
    // specially and may not expose server-sent event data to addEventListener.
    this.sseManager.broadcast(sessionId, "error", errorEvent);
    this.sseManager.broadcast(sessionId, "agent-error", errorEvent);

    logger.error(`Broadcast error to session ${sessionId}: ${errorText}`);
  }

  /**
   * Resolve any automation runs whose dispatched messageId matches the terminal
   * event. Checks both the immediate messageId and processedMessageIds since
   * a single turn can batch-process multiple messages. Durable and replica-
   * safe: keyed on runs.dispatched_message_id, idempotent via the active-
   * status guard, so it's correct on whichever replica claims the row.
   */
  private async resolveAutomationRunsFromPayload(
    payload: ThreadResponsePayload,
    result:
      | { ok: true }
      | {
          ok: false;
          error: string;
          errorCode?: string;
          quotaResetError?: string;
        }
  ): Promise<void> {
    const ids = new Set<string>();
    if (payload.messageId) ids.add(payload.messageId);
    for (const id of payload.processedMessageIds ?? []) {
      if (id) ids.add(id);
    }
    await resolveAutomationRunsByMessageIds(ids, result);
  }

  /**
   * Handle status updates (heartbeat with elapsed time)
   * Sends status event to SSE clients
   */
  async handleStatusUpdate(payload: ThreadResponsePayload): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      return;
    }

    // Broadcast status to SSE clients. `statusUpdate` is an object
    // ({ elapsedSeconds, state }); the SPA's SSE consumer expects `status` to be
    // a plain string and renders it verbatim (italicized). Sending the object
    // here makes the client coerce it via String(...) → "[object Object]".
    // Send the human-readable `state` ("is running", "is scheduling", …).
    this.sseManager.broadcast(sessionId, "status", {
      type: "status",
      status: payload.statusUpdate?.state ?? "Working",
      messageId: payload.messageId,
      timestamp: payload.timestamp || Date.now(),
    });
  }

  /**
   * Handle ephemeral messages
   * For API platform, these are just broadcast as regular events
   */
  async handleEphemeral(payload: ThreadResponsePayload): Promise<void> {
    const sessionId = this.sessionIdFor(payload);

    if (!sessionId) {
      return;
    }

    // Broadcast ephemeral content to SSE clients
    this.sseManager.broadcast(sessionId, "ephemeral", {
      type: "ephemeral",
      content: payload.content,
      messageId: payload.messageId,
      processedMessageIds: payload.processedMessageIds,
      timestamp: payload.timestamp || Date.now(),
    });
  }

  /**
   * Stop stream for conversation - no-op for API platform
   * SSE connections handle their own lifecycle
   */
  async stopStreamForConversation(
    _userId: string,
    _conversationId: string
  ): Promise<void> {
    // No-op - SSE connections manage their own lifecycle
  }
}
