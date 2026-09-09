import {
	createChildSpan,
	createLogger,
	ErrorCode,
	extractTraceId,
	generateTraceId,
	generateWorkerToken,
	getErrorMessage,
	type GuardrailRegistry,
	type MessagePayload,
	OrchestratorError,
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
  type AgentTurnDeps,
  enqueueAgentTurn,
  cancelAgentTurn,
} from "./agent-turn-producer.js";
import {
  buildCanonicalConversationKey,
  type DeploymentManager,
  generateDeploymentName,
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
  private isRunning = false;
  private agentSettingsStore?: AgentSettingsStore;
  private agentTurnMcp?: AgentTurnDeps["mcp"];
  private agentTurnArtifacts?: AgentTurnDeps["artifacts"];
  private agentTurnInstructions?: AgentTurnDeps["instructions"];
  private guardrailRegistry?: GuardrailRegistry;
  private recordRunInput: typeof recordAgentRunInput;
  constructor(
    deploymentManager: DeploymentManager,
    // Test seams: production uses the real Postgres-backed queue and durable
    // input journal. Unit tests can capture either boundary without a database.
    queue: IMessageQueue = new RunsQueue(),
    recordRunInput: typeof recordAgentRunInput = recordAgentRunInput,
  ) {
    this.deploymentManager = deploymentManager;
    this.queue = queue;
    this.recordRunInput = recordRunInput;
  }

  /**
   * The gateway's MCP surface for the agent turn: which servers an agent has
   * and what tools they publish. Same post-construction injection as the
   * guardrails, for the same reason. Absent → a turn runs with no tools.
   */
  setAgentTurnMcp(mcp?: AgentTurnDeps["mcp"]): void {
    this.agentTurnMcp = mcp;
  }

  /**
   * The artifact store the agent turn resolves its attachments out of. Same post-construction injection as the MCP surface. Absent → an
   * image attachment travels as its name only.
   */
  setAgentTurnArtifacts(artifacts?: AgentTurnDeps["artifacts"]): void {
    this.agentTurnArtifacts = artifacts;
  }

  /**
   * The platform instruction providers a turn's prompt takes its chat identity
   * block from. Same post-construction injection. Absent → no identity block.
   */
  setAgentTurnInstructions(instructions?: AgentTurnDeps["instructions"]): void {
    this.agentTurnInstructions = instructions;
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

      // Reconcile the agent's declared egress domains and pre-approved MCP
      // tools into the grant store. The MCP proxy answers "allow" for a tool
      // only when `grantStore.hasGrant(agentId, '/mcp/<id>/tools/<name>')`
      // holds, and `http-proxy` gates domains the same way — so without this,
      // every pre-approved tool falls through to an approval prompt and a
      // declared domain is not reachable.
      //
      // Runs on EVERY dispatch, cold or warm. The subprocess lane reached this
      // twice (cold through `createWorkerDeployment`'s env build, warm through
      // an explicit call before scale-up); both of those paths went with the
      // lane, so one unconditional call replaces them. The sync is
      // drift-gated internally — it writes only when the pattern set changed.
      await this.deploymentManager.syncNetworkConfigGrants(data);

      // Persist before queue delivery so a worker reconnect cannot lose the input.
      await this.recordRunInput(data, deploymentName);

      // The agent turn runs in an isolate, and it is the ONLY execution path:
      // nothing spawns a managed worker for this message any more. Because
      // nothing else can answer, the two ways this can fail both have to
      // surface: an unexpected failure THROWS into the queue's retry/fail
      // handling, and a misconfiguration the producer can name is returned so
      // the armed marker is discharged with that reason below.
      // An explicit cancel is a control message: it stops the active turn
      // instead of becoming one. Everything else is admitted as its own
      // pending native run, including while another turn is active.
      const handled = await cancelAgentTurn(data);
      const unrunnable = handled ? undefined : await enqueueAgentTurn(data, {
        agentSettings: this.agentSettingsStore,
        catalog: this.deploymentManager.getProviderCatalogService?.(),
        mcp: this.agentTurnMcp,
        gatewayUrl: getConfiguredPublicGatewayUrl(),
        // Where this message's attachments already live: the gateway published
        // each one as an artifact on the way in. The producer reads their bytes
        // from here rather than from the signed URL it also stamped, so no
        // attachment URL crosses into the isolate.
        artifacts: this.agentTurnArtifacts,
        // The conversation's pinned sandbox, already resolved above.
        runtime: runtimeSelection,
        instructions: this.agentTurnInstructions,
      });

      // The agent cannot run at all — no model, no provider that routes, or no
      // public gateway URL. The marker armed above is the client's only
      // promise of a terminal event, and nothing else will discharge it, so
      // waiting would spend the full deadline and then blame an unresponsive
      // worker. Discharge it now with the reason the producer identified,
      // which carries its own remediation CTA.
      if (unrunnable) {
        await failTurnIfPending(deploymentName, data.messageId, unrunnable);
      }

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


  /**
   * Acquire a per-process lock for deployment creation. Prevents two
   * concurrent message handlers from racing to create the same deployment.
   * In embedded mode the gateway is single-process; an in-memory Map is
   * the right primitive here (TTL is not needed because the lock is held
   * for the duration of the awaited create call and released in finally).
   */
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
