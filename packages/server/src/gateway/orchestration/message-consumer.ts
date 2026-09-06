import {
	AgentErrorCode,
	ConversationOwnedElsewhereError,
	createChildSpan,
	createLogger,
	ErrorCode,
	extractTraceId,
	generateTraceId,
	generateWorkerToken,
	getErrorMessage,
	getTraceparent,
	type GuardrailRegistry,
	type MessagePayload,
	OrchestratorError,
	retryWithBackoff,
	runGuardrailInstances,
	SpanStatusCode,
} from "@lobu/core";
import {
  enabledInlineGuardrails,
  resolveAgentGuardrails,
} from "../guardrails/aggregator.js";
import * as Sentry from "@sentry/node";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { platformMetadataString } from "../connections/platform-metadata.js";
import { recordGuardrailTrip } from "../guardrails/audit.js";
import type {
  IMessageQueue,
  QueueJob as SharedQueueJob,
} from "../infrastructure/queue/index.js";
import {
  RunsQueue,
  TERMINAL_DELIVERY_SEND_OPTS,
} from "../infrastructure/queue/index.js";
import { armTurnTimeout, failTurnIfPending } from "./turn-liveness.js";
import { recordAgentRunInput } from "./agent-run-input.js";
import {
  type AgentTurnShadowDeps,
  enqueueAgentTurnShadow,
} from "./agent-turn-shadow.js";
import {
  buildCanonicalConversationKey,
  type DeploymentManager,
  generateDeploymentName,
  type OrchestratorConfig,
} from "./deployment-manager.js";
import { buildWorkerTokenClaims } from "./worker-token-claims.js";
import { getConfiguredPublicGatewayUrl } from "../../utils/public-origin.js";
import { resolvePinnedSelection } from "../../lobu/stores/sandbox-store.js";
import { threadIdFromApiConversationId } from "../services/api-conversation-id.js";
import {
  classifyConversation,
  isAutomationConversationId,
  resolveConversationLocationLabel,
  upsertConversation,
} from "../services/conversations-store.js";
import { resolveAgentToolingDeclaration } from "../agent-tooling/resolver.js";

const logger = createLogger("orchestrator");

/**
 * Mint the per-run worker JWT the worker uses as its PRIMARY gateway auth
 * (`session-runner`: `runJobToken || WORKER_TOKEN`). Extracted as a pure,
 * exported function so the claim set is exercised by a regression test that
 * pins parity with the consumer requirements — the #1274 P0 (this mint
 * omitted `connectionId`, so every chat `ask_user` 500'd at
 * `assertRoutableInteraction`) shipped precisely because no test drove the
 * mint code. Any claim a downstream consumer reads off the verified worker
 * token (connectionId, source, platform, teamId, agentId, organizationId,
 * runId, …) MUST be set here; the test asserts that so the next omitted
 * claim fails red instead of in prod.
 */
export function buildRunJobToken(args: {
  userId: string;
  conversationId: string;
  deploymentName: string;
  channelId: string;
  teamId?: string;
  agentId: string;
  organizationId: string;
  platform: string;
  platformMetadata: Record<string, unknown>;
  runId: number;
  /**
   * Per-turn binding for token refresh: the turn-timeout marker is armed with
   * this SAME messageId, so the refresh gate requires a live marker for THIS
   * turn (deploymentName:messageId), not merely any live turn on the deployment.
   */
  messageId: string;
  /**
   * Resolved runtime provider + sandbox for this conversation (from its
   * pinned sandbox). Stamped into the token so the generic runtime route
   * picks the provider + vault credential. Undefined → local just-bash.
   */
  runtimeProviderId?: string;
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox (signed claim). */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox (signed claim). */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox (signed claim). */
  nixPackages?: string[];
}): string {
  return generateWorkerToken(
    args.userId,
    args.conversationId,
    args.deploymentName,
    {
      // PRIMARY auth → shared routing claims (channelId, teamId, platform,
      // agentId, organizationId, connectionId, source) are minted via
      // `buildWorkerTokenClaims`, kept in lockstep with the deployment-token
      // mint. connectionId in particular MUST be present or interaction posts
      // hit `assertRoutableInteraction` and every ask_user 500s (#1274).
      ...buildWorkerTokenClaims(args),
      // Per-run-token-specific claims.
      runId: args.runId,
      messageId: args.messageId,
    }
  );
}

export class MessageConsumer {
  private queue: IMessageQueue;
  private deploymentManager: DeploymentManager;
  private config: OrchestratorConfig;
  private isRunning = false;
  /**
   * Per-process deployment-creation lock. The embedded-only server
   * has a single MessageConsumer instance per process, so an in-memory Set
   * is sufficient for the "two consecutive messages for the same thread
   * race to create the deployment" guard. The cross-pod guard is the PG
   * advisory lock in DeploymentManager — this Set is pod-local only.
   */
  private deploymentLocks = new Set<string>();
  private agentSettingsStore?: AgentSettingsStore;
  private agentTurnMcp?: AgentTurnShadowDeps["mcp"];
  private agentTurnArtifacts?: AgentTurnShadowDeps["artifacts"];
  private guardrailRegistry?: GuardrailRegistry;
  private recordRunInput: typeof recordAgentRunInput;
  constructor(
    config: OrchestratorConfig,
    deploymentManager: DeploymentManager,
    // Test seams: production uses the real Postgres-backed queue and durable
    // input journal. Unit tests can capture either boundary without a database.
    queue: IMessageQueue = new RunsQueue(),
    recordRunInput: typeof recordAgentRunInput = recordAgentRunInput,
  ) {
    this.config = config;
    this.deploymentManager = deploymentManager;
    this.queue = queue;
    this.recordRunInput = recordRunInput;
  }

  /**
   * The gateway's MCP surface for the isolate-lane shadow: which servers an
   * agent has and what tools they publish. Same post-construction injection
   * as the guardrails, for the same reason. Absent → shadow turns run with no
   * tools.
   */
  setAgentTurnMcp(mcp?: AgentTurnShadowDeps["mcp"]): void {
    this.agentTurnMcp = mcp;
  }

  /**
   * The artifact store the isolate-lane shadow resolves a turn's attachments
   * out of. Same post-construction injection as the MCP surface. Absent → an
   * image attachment travels as its name only.
   */
  setAgentTurnArtifacts(artifacts?: AgentTurnShadowDeps["artifacts"]): void {
    this.agentTurnArtifacts = artifacts;
  }

  /**
   * Inject guardrail infrastructure post-construction. Called by the
   * Orchestrator after CoreServices has built the registry — the consumer
   * is constructed earlier than CoreServices is wired up, so a setter
   * matches the existing `injectCoreServices` pattern on the orchestrator.
   * Calling with no args is a no-op (guardrails simply don't run).
   */
  setGuardrails(
    registry?: GuardrailRegistry,
    settingsStore?: AgentSettingsStore
  ): void {
    this.guardrailRegistry = registry;
    this.agentSettingsStore = settingsStore;
  }

  async start(): Promise<void> {
    try {
      await this.queue.start();
      this.isRunning = true;

      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      logger.debug("Created/verified messages queue");

      // Subscribe to the single messages queue for all messages
      await this.queue.work(
        "messages",
        async (job: SharedQueueJob<MessagePayload>) => {
          return await Sentry.startSpan(
            {
              name: "orchestrator.process_queue_job",
              op: "orchestrator.queue_processing",
              attributes: {
                "job.id": job?.id || "unknown",
              },
            },
            async () => {
              return this.handleMessage(job);
            }
          );
        }
      );

      logger.debug("Queue consumer started");
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to start queue consumer: ${getErrorMessage(error)}`,
        { error },
        true
      );
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.queue.stop();
  }

  /**
   * Handle all messages - creates deployment for new threads or routes to existing thread queues
   */
  private async handleMessage(
    job: SharedQueueJob<MessagePayload>
  ): Promise<void> {
    const data = job?.data;
    const jobId = job?.id || "unknown";

    // Extract traceparent for distributed tracing (from message ingestion)
    const traceparent = platformMetadataString(
      data?.platformMetadata,
      "traceparent"
    );

    // Extract or generate trace ID for logging (backwards compatible)
    const traceId =
      extractTraceId(data) || generateTraceId(data?.messageId || jobId);

    // Add traceId to Sentry scope for correlation
    Sentry.getCurrentScope().setTag("traceId", traceId);

    // Create child span for queue processing (linked to message_received span)
    const queueSpan = createChildSpan("queue_processing", traceparent, {
      "lobu.trace_id": traceId,
      "lobu.job_id": jobId,
      "lobu.user_id": data?.userId || "unknown",
      "lobu.conversation_id": data?.conversationId || "unknown",
    });

    // Get traceparent to pass to worker (for further context propagation)
    const childTraceparent = getTraceparent(queueSpan) || traceparent;

    logger.info(
      {
        traceparent,
        traceId,
        jobId,
        userId: data?.userId,
        conversationId: data?.conversationId,
      },
      "Processing job with trace context"
    );

    try {
      // The runs-queue claim sets `job.id = String(runId)` when it
      // dispatches into this handler. Stamp the runId onto the payload so
      // it survives the thread_message_{deployment} hop and reaches the
      // worker — the per-run agent_transcript_snapshot POST needs it to
      // attribute snapshots to the right run (codex P1#1 on PR #865).
      const parsedRunId = Number(jobId);
      if (!Number.isSafeInteger(parsedRunId) || parsedRunId <= 0) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "A claimed runs.id is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
      }
      data.runId = parsedRunId;

      if (!data.organizationId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "organizationId is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
      }

      if (!data.agentId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "agentId is required for message routing",
          { jobId, messageId: data.messageId },
          false
        );
      }

      // CRITICAL: For consistent worker naming, conversationId must be the root conversation ID
      // (e.g., Slack thread root ts), not individual message timestamps.
      const effectiveConversationId = data.conversationId;
      if (!effectiveConversationId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          "conversationId is required for message routing",
          { messageId: data.messageId, userId: data.userId },
          true
        );
      }

      // Materialize the `conversations` listing row for this turn (the single
      // sidebar source). Automation runs stay derived from transcript snapshots
      // (one entry per automation, not per run), so they're excluded here. Best-
      // effort: upsertConversation swallows its own errors so a listing hiccup
      // never fails a live turn.
      if (!isAutomationConversationId(effectiveConversationId)) {
        const { kind, storedPlatform } = classifyConversation(data.platform);
        // Undo the API id packing once, here at write time, and store the result —
        // readers route on the stored `thread_id`, never by re-parsing the id.
        const threadId =
          kind === "owned"
            ? threadIdFromApiConversationId({
                conversationId: effectiveConversationId,
                agentId: data.agentId,
                userId: data.userId,
                organizationId: data.organizationId,
              })
            : null;
        // The inbound delivery is the common authoritative source for DM-ness:
        // the message bridge derives `isDirect` from its delivery source and
        // carries it on platformMetadata. Interaction clicks omit the hint
        // because their conversationId/channelId relationship describes
        // threading, not the original surface. Anything absent or non-boolean
        // stores null, which the read gate treats as unknown and keeps
        // fail-closed. Owned (web) rows are not channels at all, so they stay
        // null.
        const isDirectHint = data.platformMetadata?.isDirect;
        const isDirect =
          kind === "platform" && typeof isDirectHint === "boolean"
            ? isDirectHint
            : null;
        let locationLabel: string | null = null;
        if (kind === "platform") {
          try {
            locationLabel = await resolveConversationLocationLabel({
              organizationId: data.organizationId,
              platform: storedPlatform,
              teamId:
                platformMetadataString(data.platformMetadata, "teamId") ??
                data.teamId,
              channelId: data.channelId,
              isDirect,
              senderDisplayName: platformMetadataString(
                data.platformMetadata,
                "senderDisplayName",
              ),
            });
          } catch (err) {
            logger.warn(
              { err },
              "conversation location label could not be resolved",
            );
          }
        }
        await upsertConversation({
          organizationId: data.organizationId,
          agentId: data.agentId,
          platform: storedPlatform,
          conversationId: effectiveConversationId,
          threadId,
          kind,
          userId: data.userId,
          title: data.messageText?.slice(0, 200) || null,
          isDirect,
          locationLabel,
          lastActivityAt: new Date(),
        });
      }

      const canonicalConversationKey = buildCanonicalConversationKey({
        organizationId: data.organizationId,
        agentId: data.agentId,
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });
      const deploymentName = generateDeploymentName({
        organizationId: data.organizationId,
        agentId: data.agentId,
        userId: data.userId,
        platform: data.platform,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
      });

      // Mint a per-run worker JWT bound to this exact `runs.id` and pass
      // it to the worker via the message payload. The snapshot route uses
      // it to enforce `tokenData.runId === body.runId`, so a worker
      // bearing a same-(org, agent, conv) deployment-lifetime token
      // cannot POST under a different run's slot. Codex round 2 finding
      // A on PR #865. Every dispatch is bound to its claimed runs.id.

      // Resolve THIS CONVERSATION's pinned runtime provider from its sandbox.
      // The pin is frozen on the first turn and read thereafter, so an agent
      // repoint never moves an existing conversation's sandbox. Undefined →
      // local just-bash.
      //
      // Resolution errors propagate to the durable queue's retry path. A remote
      // runtime trusts the signed token and does not re-resolve the realm, so an
      // unresolved pin must never be minted or delivered as an unpinned turn.
      const runtimeSelection = await this.resolveRuntimeSelection({
        organizationId: data.organizationId,
        agentId: data.agentId,
        platform: data.platform,
        conversationId: effectiveConversationId,
      });

      // Stamp the pinned provider onto the payload body so the worker selects its
      // bash backend per-turn (a warm deployment is reused across conversations
      // pinned to different realms). The REMOTE runtime route still reads the
      // provider from the signed runJobToken below, never this body field.
      data.runtimeProviderId = runtimeSelection.runtimeProviderId;

      // Stamp the resolved tooling fingerprint onto the payload so the
      // dispatch chokepoint (the owner pod's job router) can compare it
      // against the fingerprint the target deployment was built with, without
      // re-resolving per delivery attempt. Resolution failures propagate: a
      // DB error is not evidence that a worker is fresh, so the outer queue
      // handler retries instead of delivering on unknown durable state.
      data.toolingFingerprint = await this.foldConnectorTooling(data);

      data.runJobToken = buildRunJobToken({
        userId: data.userId,
        conversationId: effectiveConversationId,
        deploymentName,
        channelId: data.channelId,
        teamId: data.teamId,
        agentId: data.agentId,
        organizationId: data.organizationId,
        platform: data.platform,
        platformMetadata: data.platformMetadata,
        runId: data.runId,
        // Per-turn binding for token refresh: the turn-timeout marker is armed
        // below with this SAME messageId, so the refresh gate can require a live
        // marker for THIS turn (deploymentName:messageId) rather than any live
        // turn on the deployment.
        messageId: data.messageId,
        runtimeProviderId: runtimeSelection.runtimeProviderId,
        sandboxId: runtimeSelection.sandboxId,
        // Egress allow/deny lists as signed claims (kept in lockstep with the
        // deployment-token mint) — the runtime route reads them, never the body.
        allowedDomains: data.networkConfig?.allowedDomains,
        deniedDomains: data.networkConfig?.deniedDomains,
        // Same rule for the package set: signed, so the remote runtime never
        // takes a package list off the wire from the worker.
        nixPackages: data.nixConfig?.packages,
      });

      logger.info(
        `Conversation routing - effectiveConversationId: ${effectiveConversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
      );

      // Input-stage guardrails: short-circuit dispatch when an enabled
      // guardrail trips. We surface the trip reason to the user via the
      // `thread_response` queue (same path `trackFailedDeployment` uses)
      // and skip both the worker queue enqueue and the deployment ensure.
      // The trip is captured here but DELIVERED below (outside the fail-open
      // try-catch) so a delivery failure can't be swallowed into dispatch.
      let inputTrip: { reason: string; guardrail: string } | null = null;
      if (
        this.guardrailRegistry &&
        this.agentSettingsStore &&
        data.agentId &&
        data.messageText
      ) {
        try {
          const settings = await this.agentSettingsStore.getSettings(
            data.agentId,
            { organizationId: data.organizationId }
          );
          const resolved = resolveAgentGuardrails(
            settings ?? { guardrails: [] },
            this.guardrailRegistry,
            { inline: enabledInlineGuardrails(settings) }
          );
          const list = resolved.byStage.input;
          if (list.length > 0) {
            const outcome = await runGuardrailInstances("input", list, {
              agentId: data.agentId,
              userId: data.userId,
              message: data.messageText,
              platform: data.platform,
              conversationId: effectiveConversationId,
            });
            if (outcome.tripped) {
              void recordGuardrailTrip({
                organizationId: data.organizationId,
                agentId: data.agentId,
                userId: data.userId,
                conversationId: effectiveConversationId,
                stage: "input",
                guardrail: outcome.tripped.guardrail,
                reason: outcome.tripped.reason,
                metadata: outcome.tripped.metadata,
              });
              // Capture the trip; the rejection is DELIVERED below, outside this
              // fail-open try-catch. Delivering here would let a delivery
              // failure be caught by the catch and fall through to dispatch the
              // blocked input — the opposite of what a trip must do.
              inputTrip = {
                reason: outcome.tripped.reason ?? "blocked by policy",
                guardrail: outcome.tripped.guardrail,
              };
            }
          }
        } catch (err) {
          // Fail open on store/registry-level errors — the runner already
          // fail-opens on per-guardrail throws.
          logger.warn(
            {
              agentId: data.agentId,
              err: getErrorMessage(err),
            },
            "Input guardrail check failed — proceeding without guardrails"
          );
        }
      }

      // Deliver a guardrail rejection OUTSIDE the fail-open try-catch above. A
      // delivery failure here MUST propagate so the `messages` run retries (the
      // trip is deterministic) — it must never be swallowed and fall through to
      // dispatching the blocked input. Routed via `error` (renders end-to-end:
      // SSE error event + CLI exit 1; platforms post `Error: …`). No turn marker
      // is armed for a rejected turn, so the message-queue retry is the backstop.
      if (inputTrip) {
        const responseQueue = "thread_response";
        await this.queue.createQueue(responseQueue);
        await this.queue.send(
          responseQueue,
          {
            messageId: data.messageId,
            userId: data.userId,
            channelId: data.channelId,
            conversationId: data.conversationId,
            platform: data.platform,
            platformMetadata: data.platformMetadata,
            error: `Message rejected: ${inputTrip.reason}`,
            processedMessageIds: [data.messageId],
          },
          TERMINAL_DELIVERY_SEND_OPTS
        );
        logger.info(
          {
            agentId: data.agentId,
            guardrail: inputTrip.guardrail,
            conversationId: effectiveConversationId,
          },
          "Input guardrail tripped — message dropped"
        );
        queueSpan?.setStatus({ code: SpanStatusCode.OK });
        queueSpan?.end();
        return;
      }

      // Arm the turn-liveness marker BEFORE the message is deliverable to the
      // worker. The marker is the durable record that this turn owes the client
      // a terminal event; it is discharged on the worker's reply and otherwise
      // failed (fast path on crash, deadline backstop on hang/pod-death) into a
      // terminal `error`. Arming first closes a race where an already-running
      // worker could reply before the marker exists — the discharge would
      // no-op, then a stale marker would be armed and the sweep would emit a
      // spurious error after a successful turn.
      await armTurnTimeout(this.queue, {
        messageId: data.messageId,
        channelId: data.channelId,
        conversationId: effectiveConversationId,
        userId: data.userId,
        platform: data.platform,
        platformMetadata: data.platformMetadata,
        deploymentName,
        organizationId: data.organizationId,
      });

      // EXACT-MODEL GATE (enqueue chokepoint — covers cold AND warm/resumed):
      // BOTH the cold and warm paths funnel through here before
      // `sendToWorkerQueue` serializes `data.agentOptions.model` into the queue
      // job that the worker reads verbatim. Deployment-time enforcement is too
      // late — warm workers never re-run createWorkerDeployment. So enforce the
      // agent's exact allow-list on the payload model NOW, before it's persisted.
      await this.enforceModelPolicyAtEnqueue(data);

      // Persist before queue delivery so a worker reconnect cannot lose the input.
      await this.recordRunInput(data, deploymentName);

      // 1) Send to thread queue immediately (queue persists; worker will drain on attach)
      await Sentry.startSpan(
        {
          name: "orchestrator.send_to_worker_queue",
          op: "orchestrator.message_routing",
          attributes: {
            "user.id": data.userId,
            "conversation.id": effectiveConversationId || "unknown",
            "deployment.name": deploymentName,
          },
        },
        async () => {
          await this.sendToWorkerQueue(data, deploymentName);
        }
      );

      logger.info(
        { traceId, traceparent: childTraceparent, deploymentName },
        "Enqueued message to thread queue"
      );

      // 2) Ensure worker exists in the background (don't block queue send)
      // Pass traceparent for propagation to worker deployment
      this.ensureWorkerExists(
        deploymentName,
        data,
        effectiveConversationId,
        traceId,
        childTraceparent
      ).catch((bgError) => {
        // Cross-pod handled-elsewhere signal: another replica won the
        // per-conversation lock and is running this turn to completion. This is
        // NOT a failure on this pod — drop silently. No Sentry capture, no
        // Critical log, no `trackFailedDeployment` (which would surface a
        // spurious "Worker startup failed" to the user and, via
        // `failTurnIfPending`, race the winning pod's reply to terminalize the
        // shared turn marker). The winner discharges the marker on its reply.
        if (bgError instanceof ConversationOwnedElsewhereError) {
          logger.info(
            {
              traceId,
              deploymentName,
              userId: data.userId,
              conversationId: effectiveConversationId,
            },
            "Conversation owned by another replica — dropping this pod's spawn (handled elsewhere)"
          );
          return;
        }

        // Capture error for monitoring and alerting
        Sentry.captureException(bgError, {
          tags: {
            component: "deployment-creation",
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          level: "error",
        });

        logger.error(
          {
            traceId,
            error: getErrorMessage(bgError),
            stack: bgError instanceof Error ? bgError.stack : undefined,
            deploymentName,
            userId: data.userId,
            conversationId: effectiveConversationId,
          },
          "Critical: Background worker creation failed. Messages are queued but worker unavailable."
        );

        // Track failed deployments for monitoring and potential retry
        this.trackFailedDeployment(deploymentName, data, bgError).catch(
          (trackError) => {
            logger.error("Failed to track deployment failure:", trackError);
          }
        );
      });

      // 3) Shadow the same turn onto the isolate lane when the operator has
      // selected this agent. It observes the turn queued above and never
      // reaches the conversation, so it goes last: `ensureWorkerExists` is
      // fired-and-forgotten precisely so a cold worker starts booting without
      // waiting on anything, and the shadow's own work (catalog, provider
      // resolution, agent settings, snapshot read, INSERT) is several round
      // trips that must not sit in front of that boot.
      // `enqueueAgentTurnShadow` never throws, and for an agent the operator
      // has not selected it returns on an env-var read before touching the
      // database — the unselected path costs the enqueue nothing.
      await enqueueAgentTurnShadow(data, {
        agentSettings: this.agentSettingsStore,
        catalog: this.deploymentManager.getProviderCatalogService?.(),
        mcp: this.agentTurnMcp,
        gatewayUrl: getConfiguredPublicGatewayUrl(),
        // Where this message's attachments already live: the gateway published
        // each one as an artifact on the way in. The producer reads their bytes
        // from here rather than from the signed URL it also stamped, so no
        // attachment URL crosses into the isolate.
        artifacts: this.agentTurnArtifacts,
      });

      queueSpan?.setStatus({ code: SpanStatusCode.OK });
      queueSpan?.end();

      logger.info({ traceId, jobId }, "Message job queued successfully");
    } catch (error) {
      queueSpan?.setStatus({
        code: SpanStatusCode.ERROR,
        message: getErrorMessage(error),
      });
      queueSpan?.end();
      Sentry.captureException(error);
      logger.error({ traceId, jobId, error }, "Message job failed");

      // Re-throw for queue retry handling
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to process message job: ${getErrorMessage(error)}`,
        { jobId, data, error },
        true
      );
    }
  }

  /**
   * Send message to worker queue for the worker to consume
   */
  /**
   * Enforce the agent's exact-model allow-list on the OUTBOUND payload model,
   * at enqueue time. This is the authoritative gate: every dispatch lane
   * (direct API, Listen bridge, chat-instance, automation HTTP, scheduled-job
   * direct enqueue) — cold, warm, or resumed — funnels through `handleMessage`
   * → here → `sendToWorkerQueue`, which serializes `data.agentOptions.model`
   * into the queue job the worker reads verbatim. Mutating the model here
   * guarantees a disallowed/stale/sentinel model can never reach the worker,
   * regardless of whether a deployment is (re)created.
   *
   * Uses the SHARED `resolveDispatchModel` resolver (same one session-context
   * uses) so both layers agree on the effective model — a disallowed/sentinel
   * request is replaced with the first listed ref that is non-sentinel AND
   * routable, not merely non-sentinel.
   *
   * FAILS CLOSED on a policy-lookup error: a DB/catalog blip must NEVER let a
   * disallowed or sentinel model reach the worker. Since the warm path never
   * re-runs createWorkerDeployment, we cannot rely on the deployment-time gate
   * as a fallback — so when the lookup throws AND a model was requested, we DROP
   * the model (worker resolves the agent/org default or surfaces
   * NO_MODEL_CONFIGURED), never leaving the unvalidated requested model in place.
   */
  private async enforceModelPolicyAtEnqueue(
    data: MessagePayload
  ): Promise<void> {
    const requested = data.agentOptions?.model;
    if (!requested) return;
    // FAIL CLOSED when we cannot scope/run a policy check for a REQUESTED model:
    //  - no agentId → can't identify the agent's policy;
    //  - no catalog → the ProviderCatalogService isn't wired yet (startup, or a
    //    persisted job drained before wiring). The warm worker would otherwise
    //    read the unvalidated model verbatim.
    // In every such case we DROP the model rather than silently pass it.
    if (!data.agentId) {
      logger.warn(
        { requestedModel: requested },
        "Enqueue-time model gate: missing agentId — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    const catalog = this.deploymentManager.getProviderCatalogService?.();
    if (!catalog) {
      logger.warn(
        { agentId: data.agentId, requestedModel: requested },
        "Enqueue-time model gate: ProviderCatalogService not wired — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    // CROSS-TENANT GUARD: a policy-enforcement read MUST be org-scoped. A
    // declared agent id (e.g. `lobu-builder`) exists in EVERY org, so an
    // id-only lookup could enforce another tenant's models list. If the org is
    // somehow missing here, fail closed (drop the model) rather than risk
    // gating against the wrong org's policy.
    if (!data.organizationId) {
      logger.warn(
        { agentId: data.agentId, requestedModel: requested },
        "Enqueue-time model gate: missing organizationId — dropping the requested model (fail-closed, cross-tenant guard)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
      return;
    }
    try {
      const resolved = await catalog.resolveDispatchModel(
        data.agentId,
        data.organizationId,
        requested,
        data.userId
      );
      if (!resolved.replaced) return;
      logger.warn(
        {
          agentId: data.agentId,
          organizationId: data.organizationId,
          requestedModel: requested,
          allowedRefs: resolved.allowedRefs,
          effectiveModel: resolved.model ?? null,
        },
        "Enqueue-time model gate: requested model is not routable under the agent's allowed models list — enforcing (fail-closed)"
      );
      if (data.agentOptions) {
        if (resolved.model) data.agentOptions.model = resolved.model;
        else delete data.agentOptions.model;
      }
    } catch (err) {
      // FAIL CLOSED: never leave an unvalidated requested model on the payload.
      // The warm path won't re-gate at deployment time, so a lookup failure must
      // drop the model rather than let a possibly-disallowed/sentinel model run.
      logger.warn(
        { agentId: data.agentId, err: getErrorMessage(err) },
        "Enqueue-time model gate: policy lookup FAILED — dropping the requested model (fail-closed)"
      );
      if (data.agentOptions) delete data.agentOptions.model;
    }
  }

  private async sendToWorkerQueue(
    data: MessagePayload,
    deploymentName: string
  ): Promise<void> {
    try {
      // Create thread-specific queue name: thread_message_[deploymentid]
      const threadQueueName = `thread_message_${deploymentName}`;

      // Create the thread-specific queue if it doesn't exist
      await this.queue.createQueue(threadQueueName);

      // Send message to thread-specific queue.
      //
      // The retry budget bounds GENUINE failures only. Dispatch-gate deferrals
      // (stale worker mid-turn, FIFO fence, recycle) throw `StaleWorkerError`,
      // which carries the queue's deferral contract (`isDeferralError`) and is
      // rescheduled every `retryDelay` seconds WITHOUT consuming an attempt —
      // so a follow-up can wait out an arbitrarily long prior turn on this
      // small budget, while a genuinely undeliverable job still fails fast
      // instead of surviving long enough to zombie-deliver after its
      // turn-liveness marker has been swept.
      const jobId = await this.queue.send(threadQueueName, data, {
        expireInSeconds: this.config.queues.expireInSeconds,
        retryLimit: this.config.queues.retryLimit,
        retryDelay: 2, // 2 seconds — fast retry for stale connection recovery
        priority: 10, // Thread messages have high priority
      });

      if (!jobId) {
        throw new OrchestratorError(
          ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
          `queue.send() returned null/undefined for queue: ${threadQueueName}`,
          { threadQueueName, deploymentName },
          true
        );
      }

      logger.info(
        `✅ Sent message to thread queue ${threadQueueName} for conversation ${data.conversationId}, jobId: ${jobId}`
      );
    } catch (error) {
      logger.error(`❌ [ERROR] sendToWorkerQueue failed:`, error);
      throw new OrchestratorError(
        ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
        `Failed to send message to thread queue: ${getErrorMessage(error)}`,
        { deploymentName, data, error },
        true
      );
    }
  }

  /**
   * Acquire a per-process lock for deployment creation. Prevents two
   * concurrent message handlers from racing to create the same deployment.
   * In embedded mode the gateway is single-process; an in-memory Map is
   * the right primitive here (TTL is not needed because the lock is held
   * for the duration of the awaited create call and released in finally).
   */
  private acquireDeploymentLock(deploymentName: string): boolean {
    if (this.deploymentLocks.has(deploymentName)) return false;
    this.deploymentLocks.add(deploymentName);
    return true;
  }

  private releaseDeploymentLock(deploymentName: string): void {
    this.deploymentLocks.delete(deploymentName);
  }

  /** Test seam around the durable conversation-pin resolver. */
  protected resolveRuntimeSelection(
    args: Parameters<typeof resolvePinnedSelection>[0]
  ): ReturnType<typeof resolvePinnedSelection> {
    return resolvePinnedSelection(args);
  }

  /**
   * Ensure worker deployment exists for a thread
   * Uses shared retry utility with linear backoff + jitter
   * Uses an advisory lock to prevent concurrent duplicate deployment creation
   */
  /**
   * Fold the org's connector-contributed packages and domains into the queue
   * payload, in place.
   *
   * MUST run before the per-run worker token is minted: a remote runtime trusts
   * only the signed claim, never the payload body. Packages are folded as well
   * as domains because `syncNetworkConfigGrants` reconciles this payload against
   * the grant store on the warm path and derives the nix binary-cache hosts from
   * `nixConfig.packages` — folding domains alone lets that reconcile revoke the
   * substituter hosts the contributed packages depend on.
   *
   * Infrastructure failures propagate so the queue retries the enclosing
   * dispatch. Once the fingerprint participates in the delivery gate, a failed
   * lookup cannot safely mean "no evidence of change."
   */
  protected async foldConnectorTooling(data: MessagePayload): Promise<string> {
    const contribution = await resolveAgentToolingDeclaration({
      organizationId: data.organizationId,
    });
    if (contribution.domains.length > 0) {
      data.networkConfig = {
        ...data.networkConfig,
        allowedDomains: [
          ...new Set([
            ...(data.networkConfig?.allowedDomains ?? []),
            ...contribution.domains,
          ]),
        ],
      };
    }
    if (contribution.packages.length > 0) {
      data.nixConfig = {
        ...data.nixConfig,
        packages: [
          ...new Set([
            ...(data.nixConfig?.packages ?? []),
            ...contribution.packages,
          ]),
        ],
      };
    }
    return contribution.fingerprint;
  }

  private async ensureWorkerExists(
    deploymentName: string,
    data: MessagePayload,
    conversationId: string,
    traceId: string,
    traceparent?: string
  ): Promise<void> {
    return retryWithBackoff(
      async () => {
        // Ensure traceparent is in platformMetadata for worker deployment
        const dataWithTrace: MessagePayload = {
          ...data,
          platformMetadata: {
            ...data.platformMetadata,
            traceparent: traceparent || data.platformMetadata?.traceparent,
          },
        };

        // Check if this is truly a new thread by looking for existing deployment
        const existingDeployments =
          await this.deploymentManager.listDeployments();
        const isNewThread = !existingDeployments.some(
          (d) => d.deploymentName === deploymentName
        );

        if (isNewThread) {
          const acquired = this.acquireDeploymentLock(deploymentName);
          if (!acquired) {
            logger.info(
              { traceId, deploymentName },
              "Another handler is creating this deployment, waiting"
            );
            // Poll for the other handler's create to land: one 3s-spaced
            // recheck, same total wait as the prior hand-rolled sleep (the
            // added up-front check is a cheap read that only lets us scale
            // up sooner when the create has already finished). Exhausting
            // the poll throws to the outer retryWithBackoff, exactly like
            // the old single-recheck throw did.
            await retryWithBackoff(
              async () => {
                const rechecked =
                  await this.deploymentManager.listDeployments();
                if (
                  !rechecked.some((d) => d.deploymentName === deploymentName)
                ) {
                  throw new Error(
                    "Deployment lock held but deployment not created"
                  );
                }
              },
              {
                maxRetries: 1,
                baseDelay: 3000,
                strategy: "linear",
                // Quiet retry — the "waiting" log above already covers it.
                onRetry: () => {},
              }
            );
            await this.deploymentManager.scaleDeployment(deploymentName, 1);
            logger.info(
              { traceId, deploymentName },
              "Deployment created by other handler, scaled up"
            );
            await this.deploymentManager.updateDeploymentActivity(
              deploymentName
            );
            return;
          }

          try {
            // Re-check after acquiring lock — another handler in this process
            // may have completed creation between our initial check and the
            // lock acquisition.
            const recheckAfterLock =
              await this.deploymentManager.listDeployments();
            if (
              recheckAfterLock.some((d) => d.deploymentName === deploymentName)
            ) {
              logger.info(
                { traceId, deploymentName },
                "Deployment already created by another handler after lock acquired"
              );
              await this.deploymentManager.scaleDeployment(deploymentName, 1);
              await this.deploymentManager.updateDeploymentActivity(
                deploymentName
              );
              return;
            }

            logger.info(
              { traceId, traceparent, conversationId, deploymentName },
              "New thread - creating deployment"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace,
              recheckAfterLock
            );
            logger.info({ traceId, deploymentName }, "Created deployment");
          } finally {
            this.releaseDeploymentLock(deploymentName);
          }
        } else {
          logger.info(
            { traceId, conversationId, deploymentName },
            "Existing thread - ensuring worker exists"
          );
          // Sync network config domains to grant store (picks up settings changes)
          await this.deploymentManager.syncNetworkConfigGrants(dataWithTrace);
          try {
            await this.deploymentManager.scaleDeployment(deploymentName, 1);
            logger.info(
              { traceId, deploymentName },
              "Scaled existing worker to 1"
            );
          } catch {
            logger.info(
              { traceId, conversationId, deploymentName },
              "Worker doesn't exist, creating it"
            );
            await this.deploymentManager.createWorkerDeployment(
              data.userId,
              conversationId,
              dataWithTrace
            );
            logger.info({ traceId, deploymentName }, "Created worker");
          }
        }

        // Update deployment activity annotation for simplified tracking
        await this.deploymentManager.updateDeploymentActivity(deploymentName);

        logger.info({ traceId, deploymentName }, "Worker is ready");
      },
      {
        // Two orchestration attempts leave room inside the default 60s
        // turn-liveness budget for stale-worker checks, teardown, and backoff.
        maxRetries: 1,
        baseDelay: 2000,
        strategy: "linear",
        jitter: true,
        // Don't burn the remaining retry on the cross-pod handled-elsewhere signal:
        // the winning replica holds the session-level advisory lock for the
        // whole worker subprocess lifetime, so a retry here can never win.
        // Abort immediately and let the `.catch` above drop silently.
        shouldRetry: (error) =>
          !(error instanceof ConversationOwnedElsewhereError),
        onRetry: (attempt, error) => {
          logger.warn(
            { traceId, deploymentName, attempt, maxAttempts: 2 },
            `Retry attempt failed: ${error.message}`
          );
        },
      }
    );
  }

  /**
   * Track failed deployment creation. Sends the error response to the user
   * via the thread_response queue; structured logs cover ops visibility.
   */
  private async trackFailedDeployment(
    deploymentName: string,
    data: MessagePayload,
    error: unknown
  ): Promise<void> {
    try {
      logger.error(
        {
          deploymentName,
          userId: data.userId,
          conversationId: data.conversationId,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
          queueName: `thread_message_${deploymentName}`,
        },
        "Deployment creation failed"
      );

      // Emit the startup-failure notice through the first-writer-wins election
      // (atomic delete-marker + enqueue-error in one tx). This is gated on the
      // marker still being pending: if a still-attached worker raced a real
      // terminal reply (which discharged the marker), this no-ops instead of
      // double-signalling the client. Carries a code so it renders end-to-end
      // through the AGENT_ERRORS catalog (SSE + CLI + platforms) with one
      // source of prose. If the marker was never armed it also no-ops.
      await failTurnIfPending(
        deploymentName,
        data.messageId,
        AgentErrorCode.WORKER_STARTUP_FAILED
      );
    } catch (trackError) {
      // Don't fail the main flow if tracking fails
      logger.error("Failed to track deployment failure:", trackError);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    messages?: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    };
    isRunning: boolean;
    error?: string;
  }> {
    try {
      const stats = await this.queue.getQueueStats("messages");
      return {
        messages: stats,
        isRunning: this.isRunning,
      };
    } catch (error) {
      logger.error("Failed to get queue stats:", error);
      return {
        isRunning: this.isRunning,
        error: getErrorMessage(error),
      };
    }
  }
}
