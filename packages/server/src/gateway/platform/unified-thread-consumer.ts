/**
 * Unified thread response consumer.
 * Single consumer that routes responses to platform-specific renderers
 * via the PlatformRegistry, eliminating duplicate queue filtering logic.
 */

import { createChildSpan, createLogger, type GuardrailRegistry } from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { ChatResponseBridge } from "../connections/chat-response-bridge.js";
import { readPlatformMetadata } from "../connections/platform-metadata.js";
import { OutputGuardrailScanner } from "../guardrails/output-scan.js";
import type {
  IMessageQueue,
  QueueJob,
  ThreadResponsePayload,
} from "../infrastructure/queue/index.js";
import { TERMINAL_DELIVERY_SEND_OPTS } from "../infrastructure/queue/index.js";
import type { InteractionService } from "../interactions.js";
import { incrementCounter } from "../metrics/prometheus.js";
import type { PlatformRegistry } from "../platform.js";
import type { SseManager } from "../services/sse-manager.js";
import { AUTOMATION_RUN_SOURCE } from "../automation-run-session.js";
import {
  finalizeTurnSuggestions,
  readCurrentSuggestion,
} from "../suggestions/persist-suggestion.js";
import type { ResponseRenderer } from "./response-renderer.js";

const logger = createLogger("unified-thread-consumer");

/**
 * customEvent.name for a CHAT-PLATFORM interaction card (ask_user question,
 * tool-approval, link-button, status message) that must reach the pod holding
 * the connection's in-process interaction bridge.
 *
 * Unlike API interaction cards — which the browser receives over an SSE socket
 * pinned to one pod and which `routeToRenderer` owner-gates on
 * `SseManager.hasActiveConnection` — a chat card is rendered by the in-process
 * `registerInteractionBridge` listener that only exists on the pod where the
 * connection is warm. The worker posts the card into ITS pod's local
 * `InteractionService`; under N>1 replicas (Slack webhooks don't pin to the
 * connection's pod) that is routinely NOT the bridge pod, so the card was lost.
 *
 * Fan-out mirrors the API path: the producer (`registerChatInteractionFanout`)
 * enqueues every non-api interaction onto the shared `thread_response` queue;
 * the consumer below claims it on some replica, gates delivery on
 * `ChatResponseBridge.ensureDeliverable` (the SAME `warmConnection` owner-gate
 * the chat-response text path uses), and on success re-emits the event onto
 * THIS pod's local `InteractionService` so the existing bridge renders it
 * unchanged. A non-owning pod throws to re-queue until the owning pod claims.
 */
const CHAT_INTERACTION_EVENT = "chat-interaction";

/**
 * Map of InteractionService emit channel → the event payload that travels on
 * it. Carried inside the `chat-interaction` customEvent so the consumer can
 * re-emit on the correct channel without re-deriving it.
 */
interface ChatInteractionEnvelope {
  /** The InteractionService event name (e.g. "question:created"). */
  eventName: string;
  /** The original posted-interaction payload (PostedQuestion, etc.). */
  event: Record<string, unknown> & { id?: string; connectionId?: string };
}

/**
 * `platformMetadata.source` values for turns dispatched server-side with no
 * SSE client on any pod. These bypass the API owner-gate in routeToRenderer.
 * Producers: routes/public/agent.ts (automation-run/direct-api from session
 * intent), services/agent-threads.ts (internal default), connectors/
 * scheduled/jobs.ts.
 *
 * KEEP IN LOCKSTEP with `AUTONOMOUS_SOURCES` in authz/entity-policy.ts: every
 * headless (no-human) source here must also be treated as autonomous by the
 * write-gate resolver, or a server-dispatched turn would skip an agent's
 * autonomous-only restrictions.
 */
const HEADLESS_SOURCES = new Set([
  AUTOMATION_RUN_SOURCE,
  "connector-repair",
  "scheduled-job",
  "internal",
]);

/**
 * Unified consumer for thread_response queue.
 * Routes responses to the appropriate platform adapter based on payload.platform field.
 */
export class UnifiedThreadResponseConsumer {
  private chatResponseBridge?: ChatResponseBridge;
  private interactionService?: InteractionService;
  private chatInteractionFanoutCleanup?: () => void;
  /**
   * Output-stage guardrails for the API/SSE path. The ChatResponseBridge runs
   * output guardrails for chat platforms, but pure API/SSE rows (web SPA +
   * programmatic Agent API) route through ApiResponseRenderer, which has no
   * guardrail hook — so without this, secret-scan/pii-scan configured via
   * `defineAgent` never run on the API surface (the primary web chat surface).
   */
  private readonly outputGuardrail = new OutputGuardrailScanner();

  constructor(
    private queue: IMessageQueue,
    private platformRegistry: PlatformRegistry,
    private sseManager: SseManager,
    private readSuggestion = readCurrentSuggestion
  ) {}

  setChatResponseBridge(bridge: ChatResponseBridge): void {
    this.chatResponseBridge = bridge;
  }

  /**
   * Wire output-stage guardrails for the API/SSE path. Both args must be set
   * for guardrails to run; with neither, the API path behaves as before. Chat
   * rows are unaffected — the ChatResponseBridge owns their output scanning.
   */
  setOutputGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.outputGuardrail.setGuardrails(registry, settingsStore);
  }

  /**
   * Wire the cross-pod fan-out for CHAT-PLATFORM interaction cards. Registers a
   * producer that enqueues a non-api posted interaction onto the
   * `thread_response` queue ONLY when this (producing) pod does not already own
   * the connection's bridge, and stores the service so the consumer can re-emit
   * a claimed card onto this pod's local bridge. Idempotent: re-registering
   * tears down the previous subscriber first.
   *
   * `isConnectionWarmLocally` lets the producer skip the enqueue when the local
   * bridge will render the card in-process (same `emit` cycle) — that prevents a
   * double render in the worker-pod == owner-pod topology, and makes the N=1
   * path a pure no-op (no queue traffic, local render only).
   *
   * Must be called alongside `setChatResponseBridge` — the consumer branch for
   * `chat-interaction` rows gates on `ensureDeliverable`, so without the bridge
   * a fanned-out card can never be delivered.
   */
  setInteractionService(
    interactionService: InteractionService,
    isConnectionWarmLocally: (connectionId: string) => boolean
  ): void {
    this.chatInteractionFanoutCleanup?.();
    this.interactionService = interactionService;
    this.chatInteractionFanoutCleanup = registerChatInteractionFanout(
      interactionService,
      this.queue,
      isConnectionWarmLocally
    );
  }

  /**
   * Start consuming thread_response messages.
   */
  async start(): Promise<void> {
    try {
      await this.queue.start();
      await this.queue.createQueue("thread_response");

      await this.queue.work(
        "thread_response",
        this.handleThreadResponse.bind(this)
      );

      logger.debug("Unified thread response consumer started");
    } catch (error) {
      logger.error("Failed to start unified thread response consumer:", error);
      throw error;
    }
  }

  /**
   * Stop the consumer.
   */
  async stop(): Promise<void> {
    this.chatInteractionFanoutCleanup?.();
    this.chatInteractionFanoutCleanup = undefined;
    await this.queue.stop();
    logger.info("Unified thread response consumer stopped");
  }

  /**
   * Handle a thread response job by routing to the appropriate platform renderer.
   */
  private async handleThreadResponse(
    job: QueueJob<ThreadResponsePayload>
  ): Promise<void> {
    const data = job.data;
    // Last claim before `RunsQueue.runHandler` dead-letters this row (its
    // rule: attempts + 1 >= max_attempts). The owner-gate below uses the
    // exhausted budget as its drop policy, so it needs to know when dropping
    // is the only remaining outcome.
    const isFinalAttempt =
      typeof job.attempt === "number" &&
      typeof job.maxAttempts === "number" &&
      job.attempt + 1 >= job.maxAttempts;

    if (!data?.messageId) {
      logger.error(`Invalid thread response data: ${JSON.stringify(data)}`);
      return;
    }

    // CHAT-PLATFORM interaction card fan-out (ask_user/tool-approval/
    // link-button/status). Handled before the text/terminal routing below
    // because these rows also carry a `connectionId` and would otherwise be
    // mis-routed through the chat-response-bridge text path. See
    // CHAT_INTERACTION_EVENT for the cross-pod rationale.
    if (data.customEvent?.name === CHAT_INTERACTION_EVENT) {
      await this.handleChatInteraction(data);
      return;
    }

    // Create child span for response processing (linked to original trace)
    const traceparent = data.platformMetadata?.traceparent as
      | string
      | undefined;
    const span = createChildSpan("response_delivery", traceparent, {
      "lobu.message_id": data.messageId,
      "lobu.user_id": data.userId,
      "lobu.platform": data.platform || data.teamId || "unknown",
    });

    try {
      // Check if this response belongs to a Chat SDK connection — handle before legacy routing.
      // ensureDeliverable hydrates the connection from its row, so ANY replica that claims this
      // job can deliver (connections are lazy; no pod is "the" warm pod). It returns false only
      // when this replica genuinely can't run the connection (deleted/stopped, or an exclusive
      // polling transport leased to another replica) — then fail the job so the retry lands
      // somewhere that can, instead of silently completing an undelivered reply.
      const chatConnectionId = data.platformMetadata?.connectionId as string | undefined;
      if (chatConnectionId && data.error) {
        await this.chatResponseBridge?.parkQuotaExhaustedAutomation(data);
      }
      if (await this.chatResponseBridge?.ensureDeliverable(data)) {
        const sessionKey = `${data.userId}:${data.originalMessageId || data.messageId}`;
        await this.routeToRenderer(
          this.chatResponseBridge!,
          data,
          sessionKey,
          isFinalAttempt
        );
        return;
      }
      if (chatConnectionId) {
        throw new Error(
          `Chat SDK connection ${chatConnectionId} cannot be served by this gateway instance (deleted, stopped, or leased to another replica)`
        );
      }

      // Use platform field, fall back to teamId
      const platformName = data.platform || data.teamId;
      if (!platformName) {
        logger.warn(
          `Missing platform in thread response for message ${data.messageId}, skipping`
        );
        return;
      }

      // Get platform adapter from registry. Throw (not return) so the row
      // retries and then dead-letters into the failed lane where
      // lobu_runs_failed_total makes the drop visible — a silent warn here
      // loses the whole response. Registration races at boot make a short
      // retry budget genuinely useful.
      const platform = this.platformRegistry.get(platformName);
      if (!platform) {
        throw new Error(
          `No platform adapter registered for: ${platformName} (message ${data.messageId})`
        );
      }

      // Get renderer from platform
      const renderer = platform.getResponseRenderer?.();
      if (!renderer) {
        throw new Error(
          `Platform ${platformName} does not provide a response renderer (message ${data.messageId})`
        );
      }

      // Create session key for tracking
      const sessionKey = `${data.userId}:${data.originalMessageId || data.messageId}`;

      logger.info(
        `Processing thread response for platform=${platformName}, message=${data.messageId}, session=${sessionKey}`
      );

      await this.routeToRenderer(renderer, data, sessionKey, isFinalAttempt);
    } catch (error) {
      logger.error(
        `Error processing thread response for message ${data.messageId}:`,
        error
      );
      throw error;
    } finally {
      span?.end();
    }
  }

  /**
   * Deliver a fanned-out CHAT-PLATFORM interaction card on the pod that owns
   * the connection's bridge.
   *
   * Owner-gate: `ensureDeliverable` warms the connection from its row on this
   * replica and returns false only when this replica genuinely can't run it
   * (deleted/stopped, or an exclusive transport leased to another replica). On
   * false we throw so the row re-queues until the owning pod claims it — exactly
   * the chat-response text path's semantics. On true the connection is warm
   * here, so `registerInteractionBridge` is subscribed to this pod's
   * `InteractionService`; re-emitting the original event renders the card.
   *
   * No-double-render: the re-emitted event keeps its ORIGINAL `id`. The bridge's
   * per-connection `handledEvents` set dedups by id, so if this same pod also
   * produced the card (N=1, or worker-pod == bridge-pod), the local emit already
   * rendered it and the re-emit is a no-op. The has-check + mark happen
   * synchronously at the top of each bridge handler, before any await, so even a
   * concurrent local-emit + re-emit cannot both render.
   */

  private async handleChatInteraction(
    data: ThreadResponsePayload
  ): Promise<void> {
    const envelope = data.customEvent?.data as
      | ChatInteractionEnvelope
      | undefined;
    if (!envelope?.eventName || !envelope.event) {
      logger.error(
        `Invalid chat-interaction envelope for message ${data.messageId}`
      );
      return;
    }

    if (!this.interactionService) {
      // Fail the job so it re-queues until a replica with the fan-out wired
      // claims it, rather than silently dropping the card.
      throw new Error(
        `Chat interaction card ${data.messageId} cannot be delivered: no InteractionService wired on this gateway instance`
      );
    }

    // Defense-in-depth: the row's routing key (platformMetadata.connectionId,
    // what ensureDeliverable warms) MUST match the connectionId tagged on the
    // event we're about to re-emit. A mismatched/corrupted envelope could
    // otherwise render an event tagged for connection A onto connection B's
    // warm pod. Drop on mismatch — never re-emit a misrouted card.
    const rowConnectionId = data.platformMetadata?.connectionId as
      | string
      | undefined;
    const eventConnectionId = envelope.event.connectionId;
    if (
      eventConnectionId &&
      rowConnectionId &&
      eventConnectionId !== rowConnectionId
    ) {
      logger.warn(
        `Dropping chat interaction ${envelope.event.id ?? data.messageId} (${envelope.eventName}): envelope connectionId ${eventConnectionId} does not match row connectionId ${rowConnectionId}`
      );
      return;
    }

    const deliverable = await this.chatResponseBridge?.ensureDeliverable(data);
    if (!deliverable) {
      throw new Error(
        `Chat interaction card for connection ${
          rowConnectionId ?? "unknown"
        } cannot be served by this gateway instance (deleted, stopped, or leased to another replica); re-queueing for owner delivery`
      );
    }

    // Re-emit on this pod's local InteractionService so the in-process bridge
    // (now warm for this connection) renders the card with the original id.
    this.interactionService.emit(envelope.eventName, envelope.event);
    logger.info(
      `Delivered chat interaction ${envelope.event.id ?? data.messageId} (${envelope.eventName}) on owning replica`
    );
  }

  /**
   * Route the payload to the appropriate renderer method.
   */
  private async routeToRenderer(
    renderer: ResponseRenderer,
    data: ThreadResponsePayload,
    sessionKey: string,
    isFinalAttempt = false
  ): Promise<void> {
    // Owner-routing for API/SSE TERMINAL delivery (success completion OR
    // error). The SseManager is per-pod and in-memory, so a terminal event
    // only reaches the client if THIS pod holds the SSE connection. Under N>1
    // replicas the client's SSE (pod S, pinned by ClientIP affinity) and the
    // pod that produced this row can differ — so a row claimed by a non-owning
    // pod must re-queue until pod S claims it. This mirrors the platform
    // canHandle re-queue (handleThreadResponse) and also fixes the pre-existing
    // cross-pod success-completion drop on the API path.
    //
    // Scoped to TERMINAL API rows only: platform replies have their own
    // connectionId owner-routing, and deltas stay best-effort (un-gated) to
    // avoid per-delta re-queue churn. The re-queue relies on the owning pod
    // eventually winning the SKIP-LOCKED claim; terminal sends use a short
    // fixed retryDelay + raised retryLimit (see TERMINAL_DELIVERY_SEND_OPTS) so
    // the window covers both cross-pod hand-off and the client's POST→connect
    // gap. Sufficient at the small replica counts we run; a durable
    // SSE-session→pod registry with targeted delivery is the future hardening
    // for very large N.
    // Detect API rows by platform OR teamId: the worker's HTTP response carries
    // `teamId: "api"` but omits `platform`, while gateway-generated rows (e.g.
    // turn-liveness errors) set `platform: "api"`. Matching only `platform`
    // would leave NORMAL worker success/error rows un-gated → cross-pod drop.
    // Exclude Chat SDK rows: routeToRenderer is also reached via the
    // chatResponseBridge path, which already owner-routes by `connectionId`
    // (canHandle re-queues to the managing instance). Gating those on SSE
    // ownership too could re-queue a reply that was ready to deliver. The SSE
    // owner-gate is only for pure API/SSE rows, which never carry a connectionId.
    const isApiRow =
      (data.platform || data.teamId) === "api" &&
      !data.platformMetadata?.connectionId;

    // Preserve the original terminal error before output guardrails replace the
    // user-visible text. The API renderer consumes this field only for durable
    // Automation scheduling; it is never included in an SSE event.
    if (typeof data.error === "string") {
      data = { ...data, bookkeepingError: data.error };
    }

    // Finalize the conversation's suggestion set at the terminal boundary,
    // BEFORE the SSE owner-gate below. This must run whether or not any pod
    // holds the client's socket (a disconnected client leaves no owner, and the
    // owner-gate would otherwise re-queue → dead-letter, dropping the clear and
    // replaying stale chips on reload forever). It supersedes a prior turn's
    // set when this turn emitted none, and keeps this turn's own for the
    // renderer to embed. Idempotent under the re-queue-to-owner retry. Skipped
    // on error turns so they do not alter durable suggestion state.
    if (isApiRow && !data.error && data.processedMessageIds?.length) {
      const organizationId =
        data.organizationId ??
        (typeof data.platformMetadata?.organizationId === "string"
          ? data.platformMetadata.organizationId
          : undefined);
      if (organizationId) {
        try {
          await finalizeTurnSuggestions({
            organizationId,
            conversationId: data.conversationId,
            turnMessageIds: [
              ...(data.messageId ? [data.messageId] : []),
              ...(data.processedMessageIds ?? []),
            ],
          });
        } catch (err) {
          // Never let suggestion finalization break terminal delivery.
          logger.warn(
            `Failed to finalize suggestions for ${data.conversationId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    if (isApiRow) {
      const isTerminal = !!(
        data.error ||
        (data.processedMessageIds && data.processedMessageIds.length)
      );
      // Interaction cards (ask_user question, tool-approval, link-button) are
      // pushed to the browser's SSE socket, which lives on exactly one pod.
      // Like terminal rows they must be owner-routed: a non-owning pod
      // re-queues so the pod holding the SSE connection (pinned by ClientIP
      // affinity) delivers the card. Without this the card lands in a pod-local
      // SseManager the browser is not connected to and the user never sees it,
      // leaving the ask_user/tool-approval turn hung. The card-bearing rows are
      // enqueued with `customEvent.requireSseOwner` set (see api/platform.ts)
      // and the same raised-retry send opts as terminal rows so the re-queue
      // window covers the cross-pod hand-off and the browser's POST→connect gap.
      //
      // Headless rows are exempt: turns dispatched server-side (automation runs,
      // connector repair, scheduled jobs, internal threads) never open an SSE
      // connection on ANY pod, so gating them re-queues 30x, dead-letters the
      // row, and skips the renderer side-effects (automation run resolution most
      // critically — a failed automation run otherwise surfaces only via the 2h
      // stale sweep). No pod is "the owner"; the first claimer delivers, and
      // the SSE broadcast is a harmless no-op. `source` is stamped at dispatch
      // (routes/public/agent.ts from session intent; agent-threads/repair/
      // scheduled set it explicitly) and echoed back by the worker.
      const source = data.platformMetadata?.source;
      const isHeadless =
        typeof source === "string" && HEADLESS_SOURCES.has(source);
      const requiresSseOwner =
        !isHeadless &&
        (isTerminal || data.customEvent?.requireSseOwner === true);
      // Clients subscribe on the conversation id (GET /events keys
      // connections by session.conversationId — see routes/public/agent.ts).
      const sseKey = data.conversationId;
      if (
        requiresSseOwner &&
        sseKey &&
        !this.sseManager.hasActiveConnection(sseKey)
      ) {
        // Budget exhausted: this claim is the row's last, so re-queueing again
        // would dead-letter it and drop the terminal event entirely. Dropping
        // was the original policy ("the client is genuinely gone"), but it also
        // discards the renderer's DURABLE side effects — most critically
        // `resolveAutomationRunsByMessageIds`, without which an Automation run
        // never reaches a terminal state and hangs until the 2h stale sweep.
        // A completed reply is lost the same way, even though the worker
        // produced it.
        //
        // So on the final attempt we deliver here instead. The broadcast is
        // best-effort: `SseManager.broadcast` still fans out to peer replicas
        // over LISTEN/NOTIFY, so a small event reaches the owning pod anyway;
        // an oversized one (>7000B, see SseFanout) stays local and the client
        // recovers it from the transcript snapshot on reload. Either way the
        // durable side effects run exactly where they otherwise would not.
        if (!isFinalAttempt) {
          throw new Error(
            `API SSE session ${sseKey} not owned by this gateway instance; re-queueing for owner delivery`
          );
        }
        logger.warn(
          `API SSE session ${sseKey} still unowned on the final delivery attempt; rendering locally so terminal side effects are not dropped`
        );
        incrementCounter("lobu_sse_owner_gate_final_attempt_total");
      }
    }

    // Output-stage guardrails for the API/SSE path (see `outputGuardrail`).
    // Scoped to API rows — chat rows route through ChatResponseBridge, which
    // owns their output scanning, so scanning them here would double-enforce.
    // Runs on the owning pod (terminal rows are owner-gated above) — or, on a
    // row's final attempt, on whichever pod renders it locally. Either way the
    // authoritative finalText scan is replica-safe: it scans the WHOLE terminal
    // text in one place, so unlike a delta it cannot be split across pods.
    if (isApiRow && this.outputGuardrail.enabled) {
      const md = readPlatformMetadata(data.platformMetadata);
      const agentId = md.agentId;
      if (agentId) {
        // Withhold streaming deltas for agents that configured output
        // guardrails. Deltas are NOT owner-gated under N>1, so a secret split
        // across deltas claimed on different pods would trip no per-pod scan and
        // could reach a streaming SSE client before the terminal scan. We can't
        // scan a partial cross-pod stream safely, so we don't stream at all:
        // the full, scanned `finalText` is delivered on the terminal `complete`
        // event instead (the SPA renders from it). Agents without output
        // guardrails stream normally — `hasOutputGuardrails` returns false.
        if (data.delta) {
          if (
            await this.outputGuardrail.hasOutputGuardrails(
              agentId,
              md.organizationId
            )
          )
            return;
        } else if (data.error || data.processedMessageIds?.length) {
          // Terminal row: scan whichever authoritative text the renderer will
          // broadcast — the reply (`finalText`, via handleCompletion) OR the
          // error (`data.error`, via handleError; ApiResponseRenderer sends it
          // raw and the SPA persists it). Scan on this (owner-gated) pod and, on
          // a trip, replace whichever was present with the block notice so the
          // secret reaches neither path and never lands in stored history.
          const terminalText =
            data.finalText ||
            (typeof data.error === "string" ? data.error : "");
          if (terminalText) {
            const trip = await this.outputGuardrail.scanFinal(terminalText, {
              agentId,
              organizationId: md.organizationId,
              userId: data.userId,
              conversationId: data.conversationId,
              platform: "api",
              toolsUsed: data.toolsUsed,
            });
            if (trip) {
              const blockMsg = `Message blocked by guardrail: ${
                trip.reason ?? trip.guardrail
              }`;
              data = {
                ...data,
                finalText: data.finalText ? blockMsg : data.finalText,
                error: data.error != null ? blockMsg : data.error,
              };
            }
            // NOTE: `suggest-followups` enrichment deliberately does NOT run on
            // this API path — only on chat platforms (ChatResponseBridge).
            //
            // The SPA opens one EventSource per send and closes it in a
            // `finally` as soon as `complete` arrives, so chips are only live if
            // they are already durable when ApiResponseRenderer embeds them on
            // that event. Enrichment needs an up-to-15s model call, which leaves
            // two bad options: await it (adds that latency to every enrichment
            // turn, putting a decorative feature on the critical path) or
            // fire-and-forget it (the write lands after the socket is gone, so
            // the chips are generated, persisted, and never delivered).
            //
            // Chat has neither problem: a native card is posted out-of-band and
            // the platform itself persists it.
            //
            // If web chips are wanted later, the tractable design is to
            // generate them WORKER-SIDE before `signalCompletion`, so they are
            // already durable when `resolveTerminalSuggestions` embeds them on
            // `complete` — no new channel and no SPA change. Note two dead
            // ends: the SPA hydrates chips from history exactly once
            // (`hydratedRef`, lobu-chat-store.tsx), so invalidating the history
            // query does NOT re-render them; and the org invalidation stream is
            // backed by a per-pod in-process emitter (events/emitter.ts), so it
            // cannot signal a browser pinned to another replica.
          }
        }
      }
    }

    if (data.customEvent) {
      let customEventData = data.customEvent.data;
      if (isApiRow && data.customEvent.name === "suggestion") {
        const organizationId =
          data.organizationId ??
          (typeof data.platformMetadata?.organizationId === "string"
            ? data.platformMetadata.organizationId
            : undefined);
        if (!organizationId) {
          logger.warn(
            `Skipping suggestion card for ${data.conversationId}: missing organization context`
          );
          return;
        }
        try {
          const current = await this.readSuggestion(
            organizationId,
            data.conversationId
          );
          // Rebuild rather than spread: the enqueued row is stale by
          // construction, so nothing on it may survive into the broadcast. The
          // shape matches the terminal `complete` embed and history replay —
          // prompts only. (`readCurrentSuggestion` returns the events row id,
          // not the `s_…` interaction id, so there is no id worth echoing.)
          customEventData = {
            type: "suggestion",
            prompts: current?.prompts ?? [],
            turnMessageId: current?.turnMessageId ?? undefined,
          };
        } catch (err) {
          // The terminal completion remains the authoritative delivery path.
          // Dropping this best-effort mid-turn card is safer than broadcasting
          // a suggestion event that could not be refreshed.
          logger.warn(
            `Failed to refresh suggestion card for ${data.conversationId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return;
        }
      }
      const eventPayload = {
        ...customEventData,
        timestamp: data.timestamp,
        messageId: data.messageId,
      };
      this.sseManager.broadcast(
        data.conversationId,
        data.customEvent.name,
        eventPayload
      );

      if (
        !data.ephemeral &&
        !data.statusUpdate &&
        !data.delta &&
        !data.error &&
        !data.processedMessageIds?.length
      ) {
        return;
      }
    }

    // Handle ephemeral messages (OAuth/auth flows)
    if (data.ephemeral && data.content && renderer.handleEphemeral) {
      await renderer.handleEphemeral(data);
      return;
    }

    // Handle status updates (heartbeat with elapsed time)
    if (data.statusUpdate && renderer.handleStatusUpdate) {
      await renderer.handleStatusUpdate(data);
      return;
    }

    // Handle streaming delta.
    //
    // Deltas (and the typing/status heartbeat above) stay best-effort under N>1
    // replicas: they are NOT owner-gated (the isApiRow gate above scopes to
    // terminal + requireSseOwner rows only), so a delta row claimed on a pod
    // that does not hold the client's SSE socket is silently lost — re-queuing
    // every delta would churn the queue with no benefit. This is accepted: the
    // terminal `complete` event carries the worker's authoritative `finalText`,
    // from which the API renderer/SPA repair any missed deltas (see
    // ApiResponseRenderer.handleCompletion). Per-delta cross-pod fan-out (a
    // durable SSE-session→pod registry) is the future hardening, deferred.
    if (data.delta && renderer.handleDelta) {
      await renderer.handleDelta(data, sessionKey);
      // Early return if no error - delta processing is complete
      if (!data.error) {
        return;
      }
    }

    // Handle error
    if (data.error) {
      await renderer.handleError(data, sessionKey);
      // Also complete session on error
      await renderer.handleCompletion(data, sessionKey);
      return;
    }

    // Handle completion
    if (data.processedMessageIds?.length) {
      await renderer.handleCompletion(data, sessionKey);
    }
  }

}

/**
 * The InteractionService emit channels that carry a CHAT-PLATFORM interaction
 * card, mapped to whether the event's `id` is durable enough to drive the
 * bridge's per-connection `handledEvents` dedup (all of them are — every posted
 * interaction gets a unique `id`).
 */
const CHAT_INTERACTION_CHANNELS = [
  "question:created",
  "suggestion:created",
  "tool:approval-needed",
  "link-button:created",
] as const;

/**
 * Register the producer side of the chat-interaction fan-out.
 *
 * For every NON-api posted interaction, enqueue a `thread_response` row carrying
 * the event so the consumer delivers it on the connection-owning pod. API
 * interactions are skipped — `ApiPlatform` already fans those out to the SSE
 * owner. Returns a cleanup function that detaches every listener.
 *
 * Mirrors `ApiPlatform.enqueueInteractionCard`: same queue, same
 * `TERMINAL_DELIVERY_SEND_OPTS` re-claim budget. The card's `connectionId` is
 * placed on `platformMetadata` so `ensureDeliverable` can warm the connection,
 * and on the row's `platform`/`teamId` so the row is unambiguously a chat row.
 *
 * `isConnectionWarmLocally(connectionId)` short-circuits the enqueue when this
 * pod already owns the connection: the local interaction bridge renders the
 * card from the same `emit`, so a queue round-trip would only risk a duplicate
 * render on whichever pod claims it.
 */
export function registerChatInteractionFanout(
  interactionService: InteractionService,
  queue: IMessageQueue,
  isConnectionWarmLocally: (connectionId: string) => boolean
): () => void {
  const handlers: Array<[string, (event: unknown) => void]> = [];

  for (const eventName of CHAT_INTERACTION_CHANNELS) {
    const handler = (event: unknown) => {
      const ev = event as {
        id?: string;
        platform?: string;
        connectionId?: string;
        conversationId?: string;
        channelId?: string;
        userId?: string;
        teamId?: string;
      };
      // API cards are owner-routed to the SSE socket by ApiPlatform; chat cards
      // need a connectionId to warm the owning pod's bridge.
      if (!ev || ev.platform === "api") return;
      if (!ev.connectionId) return;

      // This pod already owns the connection — the in-process bridge renders
      // the card from this same emit (and its per-connection `handledEvents`
      // dedups any later re-emit). Enqueuing would risk a duplicate render on
      // whichever pod claims the job. Skip the cross-pod hop entirely.
      if (isConnectionWarmLocally(ev.connectionId)) return;

      const envelope: ChatInteractionEnvelope = {
        eventName,
        event: ev as Record<string, unknown>,
      };
      const payload: ThreadResponsePayload = {
        messageId: ev.id ?? `chat-int-${Date.now()}`,
        conversationId: ev.conversationId ?? ev.channelId ?? "",
        channelId: ev.channelId ?? "",
        userId: ev.userId ?? "",
        platform: ev.platform,
        teamId: ev.teamId ?? ev.platform ?? "",
        timestamp: Date.now(),
        // connectionId on platformMetadata is what ensureDeliverable reads to
        // warm the owning replica's connection.
        platformMetadata: { connectionId: ev.connectionId },
        customEvent: {
          name: CHAT_INTERACTION_EVENT,
          data: envelope as unknown as Record<string, unknown>,
        },
      };
      // The enqueue is fire-and-forget (the emitter is synchronous), but for an
      // interaction card a silent enqueue failure means a PERMANENTLY LOST card
      // with no retry — the worker's ask_user/approval turn hangs forever. Log
      // it as an error with full routing context so the drop is observable
      // rather than invisible.
      void queue
        .send("thread_response", payload, TERMINAL_DELIVERY_SEND_OPTS)
        .catch((err) => {
          logger.error(
            `Failed to enqueue chat interaction card ${ev.id ?? "unknown"} (${eventName}) for connection ${ev.connectionId} — card is LOST (no retry):`,
            err
          );
        });
    };
    interactionService.on(eventName, handler);
    handlers.push([eventName, handler]);
  }

  return () => {
    for (const [eventName, handler] of handlers) {
      interactionService.off(eventName, handler);
    }
  };
}
