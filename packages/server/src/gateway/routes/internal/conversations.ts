import { createHash } from "node:crypto";
import { createLogger, type WorkerTokenData } from "@lobu/core";
import { TURN_INPUT_RUN_HEADER } from "@lobu/core/agent-tooling";
import { Hono, type Context } from "hono";
import { getDb } from "../../../db/client.js";
import { CHAT_SENDER_NOT_LINKED, isConfinedChatTurn } from "../../orchestration/chat-turn-actor.js";
import {
  resolveAddressableTargets,
  resolveAuthorizedTarget,
  resolveAuthorizedThread,
  type AddressableTarget,
} from "../../conversations/authorization.js";
import {
  conversationRefsMatch,
  isReplyInAskingConversation,
  parseConversationRef,
} from "../../conversations/conversation-ref.js";
import {
  ChatTransportUnavailableError,
  outboundChatTextError,
  postToChatTarget,
  threadHandleForPost,
} from "../../../operations/chat-transport-send.js";
import { handleExecute } from "../../../tools/admin/manage_operations/handlers/execute.js";
import {
  agentTurnIdentityFromClaims,
  withTurnIdempotencyKey,
  withTurnInputRun,
} from "../../../tools/turn-write-idempotency.js";
import { ensureConnectorDeclaresOperation } from "../../../utils/ensure-connector-installed.js";
import { parseAutomationRunConversationId } from "../../permissions/automation-run-intent.js";
import { resolveAutomationRunContext } from "../../automation-run-session.js";
import type { Env } from "../../../index.js";
import { stripPlatformPrefix } from "../../channels/bound-channels.js";
import { getChatInstanceManager } from "../../../lobu/gateway.js";
import { presentStoredEventToConversation } from "../../../notifications/service.js";
import { isDeliverableChatPlatform } from "../../../scheduled/scheduled-jobs-service.js";
import { manageSchedules } from "../../../tools/admin/manage_schedules.js";
import type { ToolContext } from "../../../tools/registry.js";
import {
  captureChannelMessage,
  readChannelTranscript,
} from "../../connections/channel-transcript.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { captureSideEffect } from "./capture-mode.js";
import { sendOncePerTurnInput } from "./turn-write-once.js";
import { ToolUserError } from "../../../utils/errors.js";
import { routeFailure } from "../../../diagnostics.js";

const logger = createLogger("conversations-routes");

/** The operation every chat connector declares for an agent's posts elsewhere. */
const SEND_MESSAGE_OPERATION = "send_message";

/** Public (model-facing) shape of an addressable conversation. */
function toPublicTarget(t: AddressableTarget): {
  handle: string;
  kind: string;
  platform: string;
  label: string;
} {
  return {
    handle: t.handle,
    kind: t.kind,
    platform: t.platform,
    label: t.label ?? t.channelId,
  };
}

/** The signed worker as a tool caller: the agent, never a human user. */
function workerToolContext(worker: WorkerTokenData & { organizationId: string; agentId: string }): ToolContext {
  return {
    organizationId: worker.organizationId,
    // Chat platform user ids are not Lobu user-row ids. Keep durable
    // attribution on the signed agent and retain the platform principal only
    // inside the trusted source context.
    userId: null,
    memberRole: null,
    agentId: worker.agentId,
    sourceContext: {
      platform: worker.platform,
      connectionId: worker.connectionId,
      channelId: worker.channelId,
      conversationId: worker.conversationId,
      teamId: worker.teamId,
      userId: worker.userId,
      source: worker.source,
      // Resolve sender evidence from the signed turn, never caller input.
      ...(worker.runId ? { turnRunId: worker.runId } : {}),
    },
    isAuthenticated: true,
    clientId: "lobu-worker",
    scopes: null,
    tokenType: "session",
    scopedToOrg: true,
    allowCrossOrg: false,
    grantedOrganizationIds: null,
    directSearchFederation: false,
  } satisfies ToolContext;
}

const NOT_SENT = "Not sent";

/**
 * Send somewhere other than the asking conversation: the connection's
 * `send_message` operation, admitted by connector policy for the session's
 * Automation (when this turn runs one) or the agent. The run is keyed on the
 * turn input and the resolved arguments, so a repeated call answers with the
 * same run instead of queueing or posting twice.
 */
async function sendAsOperation(
  c: Context<WorkerContext>,
  worker: WorkerTokenData & { organizationId: string; agentId: string },
  target: AddressableTarget,
  threadId: string | undefined,
  text: string
): Promise<Response> {
  const { organizationId, agentId } = worker;
  // A hosted-preview binding reaches another workspace's connection, whose
  // policy and approvers this workspace does not own.
  if (target.crossOrg) {
    return errorResponse(
      c,
      `${NOT_SENT}: this conversation is on another workspace's connection, so the agent may only reply where it was asked.`,
      403
    );
  }
  const ctx = workerToolContext(worker);
  const turn = withTurnInputRun(
    agentTurnIdentityFromClaims(worker),
    c.req.header(TURN_INPUT_RUN_HEADER)
  );
  ctx.agentTurn = turn;
  const automation = parseAutomationRunConversationId(worker.conversationId ?? "");
  if (automation) {
    try {
      // Throws unless the run is this agent's managed Automation's, in this org.
      await resolveAutomationRunContext({
        conversationId: worker.conversationId as string,
        organizationId,
        agentId,
      });
    } catch {
      return errorResponse(c, `${NOT_SENT}: this turn's Automation run could not be verified.`, 403);
    }
    ctx.actingAutomationId = automation.automationId;
    ctx.actingRunId = automation.runId;
  }
  // Policy needs the platform's connector definition to name the operation,
  // so install or re-sync it first. Without it nothing can admit the send, so
  // it is refused, not posted.
  if (!(await ensureConnectorDeclaresOperation({
    organizationId,
    connectorKey: target.platform,
    operationKey: SEND_MESSAGE_OPERATION,
  }))) {
    return errorResponse(
      c,
      `${NOT_SENT}: the ${target.platform} connector is not installed in this workspace.`,
      503
    );
  }
  const threadRoot = parseConversationRef(threadId)?.threadId;
  const sendArgs: {
    action: "execute";
    connection_id: number;
    operation_key: string;
    input: Record<string, unknown>;
    idempotency_key?: string;
  } = {
    action: "execute",
    connection_id: target.connectionDbId,
    operation_key: SEND_MESSAGE_OPERATION,
    input: {
      channel_id: target.channelId,
      ...(threadRoot ? { thread_id: threadRoot } : {}),
      text,
    },
  };
  const args = await withTurnIdempotencyKey(turn, "conversations.send", sendArgs);
  return await sendOncePerTurnInput(c, worker, "conversations.send", args, async () => {
    const result = (await handleExecute(args, ctx, {} as Env, undefined, {
      agent_id: agentId,
    })) as Record<string, unknown>;
    const runId = typeof result.run_id === "number" ? result.run_id : undefined;
    if ("error" in result) {
      const code = (result as { error_code?: string }).error_code;
      const status = code === "PERMISSION" ? 403 : code === "NOT_FOUND" ? 404 : 422;
      return c.json(
        { error: `${NOT_SENT}: ${String(result.error)}`, ...(code ? { code } : {}) },
        status
      );
    }
    switch (result.status) {
      case "completed": {
        const output = (result.output ?? {}) as { message_id?: string | null; thread?: string };
        logger.info(
          `agent ${agentId} sent to ${target.platform}/${target.channelId}${threadRoot ? " (thread)" : ""} via run ${runId}`
        );
        return c.json({
          messageId: output.message_id ?? null,
          thread: output.thread,
          // Not the asking conversation: the turn still answers its sender.
          deliveredInBand: false,
          run_id: runId,
        });
      }
      case "pending_approval":
        return c.json(
          {
            error: `Held for approval (run ${runId}): ${String(result.approval_url ?? "")}. Not sent; do not resend.`,
            code: "PENDING_APPROVAL",
            run_id: runId,
            approval_url: result.approval_url ?? null,
          },
          409
        );
      // The agent judges a Check itself: the message names the rule and how
      // to confirm or cancel the held run.
      case "pending_check":
        return c.json(
          {
            error: `Held by a workspace check (run ${runId}); not sent yet. ${String(result.message ?? "")}`,
            code: "PENDING_CHECK",
            run_id: runId,
            expires_at: result.expires_at ?? null,
          },
          409
        );
      case "in_progress":
        return c.json(
          {
            error: `This message is already being sent (run ${runId}). Do not resend.`,
            code: "IN_PROGRESS",
            run_id: runId,
          },
          409
        );
      default:
        return c.json(
          {
            error: `${NOT_SENT}: ${String(result.error_message ?? result.message ?? `operation ${String(result.status)}`)}`,
            run_id: runId,
          },
          422
        );
    }
  });
}

/**
 * Internal routes backing the native conversation tools (list/read/send).
 *
 * SECURITY: the acting agent + org come ONLY from the verified worker token.
 * The model never supplies a raw channel/user id — it passes opaque `handle`s
 * from `list`, which the authorization layer re-resolves against the agent's
 * CURRENT bindings on every call (revocation-safe; no cross-tenant reach).
 */
export function createConversationsRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  // GET /conversations/list — the conversations this agent may read+post to.
  router.get("/conversations/list", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const targets = await resolveAddressableTargets(
        worker.agentId,
        worker.organizationId
      );
      return c.json({ conversations: targets.map(toPublicTarget) });
    } catch (error) {
      throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
        "list conversations failed");
    }
  });

  // GET /conversations/read?target=<handle>&limit=&before=
  router.get("/conversations/read", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const handle = c.req.query("target");
      if (!handle) return errorResponse(c, "Missing target", 400);

      const target = await resolveAuthorizedTarget(
        worker.agentId,
        worker.organizationId,
        handle
      );
      if (!target) {
        // Forged handle or revoked binding — indistinguishable on purpose.
        return errorResponse(c, "Not authorized for this conversation", 403);
      }

      const limit = Math.min(
        Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
        100
      );

      // Primary: serve the durable transcript from Postgres, scoped to the
      // AUTHORIZED connection (the tenant fence) — no platform history-API call,
      // so Slack's throttle doesn't apply.
      const messages = await readChannelTranscript(
        worker.organizationId,
        target.connectionId,
        target.channelId,
        limit
      );
      if (messages.length > 0) {
        return c.json({ messages, nextCursor: null, hasMore: false });
      }

      // Cold start (nothing captured yet for this channel): best-effort one-shot
      // live fetch to seed the read, subject to the platform's history limit.
      const manager = getChatInstanceManager();
      if (manager?.getLiveConversationHistory) {
        const live = await manager.getLiveConversationHistory(
          target.connectionId,
          target.channelKey,
          limit
        );
        return c.json({ ...live, nextCursor: null, hasMore: false });
      }
      return c.json({ messages: [], nextCursor: null, hasMore: false });
    } catch (error) {
      throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
        "read conversation failed");
    }
  });

  // POST /conversations/send { target, text }
  //
  // A reply in the conversation that asked is the turn answering its sender:
  // it posts directly. Anything else is the agent speaking somewhere new, so it
  // runs as the connection's `send_message` operation under the org's connector
  // policy (Auto/Ask/Block, approval, audit), acting as the session's Automation
  // when there is one, else the agent.
  router.post("/conversations/send", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const agentId = worker.agentId;
      const organizationId = worker.organizationId;
      const body = (await c.req.json().catch(() => null)) as {
        target?: string;
        text?: string;
      } | null;
      const text = body?.text?.trim();
      if (!body?.target || !text) {
        return errorResponse(c, "target and text are required", 400);
      }
      const textError = outboundChatTextError(text);
      if (textError) return errorResponse(c, textError, 400);

      // `target` is either a channel handle (top-level post) or a thread handle
      // from a prior send (reply in that thread). A thread handle re-authorizes
      // its own channel subscription, so try it first; fall back to channel.
      let target: AddressableTarget;
      let threadId: string | undefined;
      const asThread = await resolveAuthorizedThread(agentId, organizationId, body.target);
      if (asThread) {
        target = asThread.target;
        threadId = asThread.threadId;
      } else {
        const resolved = await resolveAuthorizedTarget(agentId, organizationId, body.target);
        if (!resolved) {
          return errorResponse(c, "Not authorized for this conversation", 403);
        }
        target = resolved;
      }

      const captured = await captureSideEffect(c, "conversations.send", {
        platform: target.platform,
        channelId: target.channelId,
        threadId: threadId ?? null,
        text,
      });
      if (captured) return captured;

      const reply = isReplyInAskingConversation(
        {
          connectionId: worker.connectionId,
          conversationId: worker.conversationId,
          responseThreadId: worker.responseThreadId,
        },
        { connectionId: target.connectionId, channelKey: target.channelKey, threadId }
      );
      if (!reply) {
        return await sendAsOperation(c, { ...worker, organizationId, agentId }, target, threadId, text);
      }

      // A turn that repeats this post for the same input message (a re-run,
      // a redelivered message, a repeated call) posts once; the repeat gets
      // the first post's answer.
      return await sendOncePerTurnInput(c, worker, "conversations.send", {
        connectionId: target.connectionId,
        channelId: target.channelId,
        threadId: threadId ?? null,
        text,
      }, async () => {
        let sent: { messageId: string; threadId: string };
        try {
          sent = await postToChatTarget({ organizationId, agentId, target, threadId, text });
        } catch (error) {
          // Refused before anything was posted: release the receipt so the
          // same input can deliver once the gateway is back.
          if (error instanceof ChatTransportUnavailableError) {
            throw new ToolUserError(error.message, 503);
          }
          throw error;
        }
        logger.info(
          `agent ${agentId} replied in ${target.platform}/${target.channelId}${threadId ? " (thread)" : ""} via ${target.connectionId}`
        );
        // A reply landed in the conversation that triggered the run, so the
        // user has ALREADY read the agent's answer, and the terminal
        // `finalText` the worker is about to emit is a report about it —
        // posting that too is the double-message. The worker's conversation
        // comes from its signed token, so the model cannot spoof a match to
        // silence its own reply.
        return c.json({
          messageId: sent.messageId || null,
          thread: threadHandleForPost(target, sent),
          deliveredInBand: true,
        });
      });
    } catch (error) {
      throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
        "send conversation failed");
    }
  });

  // POST /conversations/present-event { eventId }
  //
  // Unlike send_message, this route accepts no destination or authored card.
  // It posts a tenant-owned event summary and canonical Open event link into
  // the signed source conversation. Custom actions run in the event's React
  // view; the worker never authors platform cards or action identities.
  router.post("/conversations/present-event", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (
        !worker.agentId ||
        !worker.organizationId ||
        !worker.connectionId ||
        !worker.platform ||
        !worker.channelId
      ) {
        return errorResponse(
          c,
          "This turn is not attached to an active chat conversation",
          403
        );
      }
      const body = (await c.req.json().catch(() => null)) as {
        eventId?: unknown;
      } | null;
      const eventId = Number(body?.eventId);
      if (!Number.isSafeInteger(eventId) || eventId < 1) {
        return errorResponse(c, "eventId must be a positive integer", 400);
      }

      const captured = await captureSideEffect(c, "conversations.present-event", {
        eventId,
        conversationId: worker.conversationId,
      });
      if (captured) return captured;

      // Presented once per turn input message; a repeat gets the first answer.
      const signed = { organizationId: worker.organizationId, connectionId: worker.connectionId, platform: worker.platform, channelId: worker.channelId, agentId: worker.agentId };
      return await sendOncePerTurnInput(c, worker, "conversations.present-event", {
        eventId,
        conversationId: worker.conversationId,
      }, async () => {
        const presentation = await presentStoredEventToConversation({
          organizationId: signed.organizationId,
          eventId,
          connectionId: signed.connectionId,
          platform: signed.platform,
          channelId: signed.channelId,
          channelKey: `${signed.platform}:${stripPlatformPrefix(
            signed.platform,
            signed.channelId
          )}`,
          conversationId: worker.conversationId,
          threadId:
            worker.responseThreadId ??
            parseConversationRef(worker.conversationId)?.threadId,
        });
        if (!presentation.ok) {
          if (presentation.reason === "not_found") {
            return errorResponse(c, "Event not found or already replaced", 404);
          }
          if (presentation.reason === "not_renderable") {
            return errorResponse(
              c,
              "Event permalink is unavailable",
              422
            );
          }
          // `gateway_unavailable`: no chat manager, so nothing was posted.
          throw new ToolUserError("Chat instance manager unavailable", 503);
        }

        captureChannelMessage({
          organizationId: signed.organizationId,
          connectionId: signed.connectionId,
          platform: signed.platform,
          channelId: signed.channelId,
          threadId: presentation.threadId,
          platformMessageId: presentation.messageId,
          authorId: signed.agentId,
          authorName: signed.agentId,
          teamId: worker.teamId ?? null,
          isBot: true,
          text: presentation.fallbackText,
          occurredAt: new Date(),
        });

        return c.json({
          messageId: presentation.messageId,
          deliveredInBand: true,
        });
      });
    } catch (error) {
      throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
        "present event failed");
    }
  });

  // POST /conversations/schedule-followup { runAt, prompt, idempotencyKey }
  //
  // This is the user-level, conversation-scoped subset of manage_schedules:
  // one shot, same signed agent, same signed conversation. The model cannot
  // choose another destination/agent, create a cron, or fan out a notification.
  router.post("/conversations/schedule-followup", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (
        !worker.agentId ||
        !worker.organizationId ||
        !worker.connectionId ||
        !worker.platform ||
        !worker.channelId ||
        !worker.conversationId
      ) {
        return errorResponse(
          c,
          "This turn is not attached to an active chat conversation",
          403
        );
      }
      if (!isDeliverableChatPlatform(worker.platform)) {
        return errorResponse(
          c,
          "Scheduled follow-ups are not supported on this chat platform",
          422
        );
      }
      const body = (await c.req.json().catch(() => null)) as {
        runAt?: unknown;
        prompt?: unknown;
        idempotencyKey?: unknown;
      } | null;
      const runAt = typeof body?.runAt === "string" ? body.runAt.trim() : "";
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      const idempotencyKey =
        typeof body?.idempotencyKey === "string"
          ? body.idempotencyKey.trim()
          : "";
      const runAtDate = new Date(runAt);
      if (!runAt || Number.isNaN(runAtDate.getTime())) {
        return errorResponse(c, "runAt must be an ISO timestamp", 400);
      }
      if (runAtDate.getTime() <= Date.now()) {
        return errorResponse(c, "runAt must be in the future", 400);
      }
      if (!prompt || prompt.length > 2_000) {
        return errorResponse(c, "prompt must be 1-2000 characters", 400);
      }
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return errorResponse(c, "idempotencyKey must be 1-200 characters", 400);
      }

      const captured = await captureSideEffect(
        c,
        "conversations.schedule-followup",
        { runAt, prompt, idempotencyKey }
      );
      if (captured) return captured;

      // scheduled_jobs idempotency is organization-wide. Scope the caller's
      // stable key to the signed agent and conversation so another chat cannot
      // replay an unrelated schedule that happens to use the same key.
      const scopedIdempotencyKey = `conversation-followup:${createHash("sha256")
        .update(`${worker.agentId}\0${worker.conversationId}\0${idempotencyKey}`)
        .digest("hex")}`;
      const schedule = await manageSchedules(
        {
          action: "create",
          description: `Follow up in ${worker.platform} conversation`,
          run_at: runAt,
          idempotency_key: scopedIdempotencyKey,
          source_thread_id: worker.conversationId,
          payload: {
            type: "wake_agent",
            agent_id: worker.agentId,
            prompt,
          },
        },
        {} as never,
        workerToolContext({ ...worker, organizationId: worker.organizationId, agentId: worker.agentId })
      );
      if (schedule.error) {
        return errorResponse(c, schedule.error, 422);
      }
      return c.json({ scheduled: true, schedule: schedule.schedule });
    } catch (error) {
      throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
        "schedule followup failed");
    }
  });

  // Shared skeleton for the message-mutation routes (react/edit/delete): parse
  // the body, re-authorize the (thread handle → channel, message id) — the
  // thread handle carries the channel subscription, so resolveAuthorizedThread
  // re-checks membership every call (revocation-safe) — then hand the resolved
  // target + body to the route's own handler. `message` is the platform message
  // id WITHIN that authorized channel. Owns the try/catch + error mapping so
  // each route only expresses its specific validation + manager call.
  interface MessageTarget {
    connectionId: string;
    threadId: string;
    messageId: string;
  }
  function messageRoute(
    label: string,
    handler: (
      c: Context<WorkerContext>,
      target: MessageTarget,
      body: Record<string, unknown>
    ) => Promise<Response>,
    // Edit rewrites what the agent said. In the asking conversation that is
    // the turn revising its reply; anywhere else it would publish new text
    // without the policy a send there goes through, so it is refused.
    opts: { askingConversationOnly?: boolean } = {}
  ) {
    return async (c: Context<WorkerContext>): Promise<Response> => {
      try {
        const worker = getVerifiedWorker(c);
        if (!worker.agentId || !worker.organizationId) {
          return errorResponse(c, "Token missing agent/org context", 403);
        }
        const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<
          string,
          unknown
        >;
        const thread = typeof body.thread === "string" ? body.thread : "";
        const message = typeof body.message === "string" ? body.message : "";
        if (!thread || !message) {
          return errorResponse(c, "thread and message are required", 400);
        }
        // `thread` is either a THREAD handle (from a prior send — its
        // `threadId` is `platform:channel:root`) or a CHANNEL handle (from
        // read_conversation / list — for reacting to a message the agent only
        // READ). Try thread first; fall back to channel. For the channel case
        // the adapter target is the 2-part `platform:channel` (channelKey),
        // which its decodeThreadId accepts — reactions/edits key on channel +
        // message id (`ts`), not a thread root. Either handle re-authorizes the
        // channel subscription on every call (revocation-safe).
        const asThread = await resolveAuthorizedThread(
          worker.agentId,
          worker.organizationId,
          thread
        );
        let target: MessageTarget;
        if (asThread) {
          target = {
            connectionId: asThread.target.connectionId,
            threadId: asThread.threadId,
            messageId: message,
          };
        } else {
          const asChannel = await resolveAuthorizedTarget(
            worker.agentId,
            worker.organizationId,
            thread
          );
          if (!asChannel) {
            return errorResponse(
              c,
              "Not authorized for this conversation",
              403
            );
          }
          target = {
            connectionId: asChannel.connectionId,
            threadId: asChannel.channelKey,
            messageId: message,
          };
        }
        const confined = isConfinedChatTurn(worker);
        if (confined || opts.askingConversationOnly) {
          const refusal = confined
            ? CHAT_SENDER_NOT_LINKED
            : `Only messages in the conversation that asked can be ${label}ed; send a new message instead.`;
          const source = parseConversationRef(worker.responseThreadId ?? worker.conversationId);
          if (!source || !isReplyInAskingConversation(
            { connectionId: worker.connectionId, conversationId: worker.conversationId, responseThreadId: worker.responseThreadId },
            { connectionId: target.connectionId, channelKey: target.threadId }
          )) {
            return errorResponse(c, refusal, 403);
          }
          // Handles authorize a channel, and message IDs can name any message
          // in it. Verify the message too, or a forged ID can mutate a sibling
          // thread even when the handle points to the signed source thread.
          if (message !== worker.messageId) {
            const [row] = await getDb()<{ thread_id: string | null }>`
              SELECT thread_id FROM channel_messages
              WHERE organization_id = ${worker.organizationId}
                AND connection_id = ${worker.connectionId}
                AND channel_id = ${stripPlatformPrefix(worker.platform ?? "", worker.channelId)}
                AND platform_message_id = ${message}
              LIMIT 1
            `;
            if (!row || !conversationRefsMatch(
              parseConversationRef(row.thread_id ?? source.channelKey), source
            )) {
              return errorResponse(c, refusal, 403);
            }
          }
        }
        const captured = await captureSideEffect(c, `conversations.${label}`, body);
        if (captured) return captured;
        return await handler(c, target, body);
      } catch (error) {
        throw routeFailure(c, errorResponse(c, "Internal server error", 500), error,
          `${label} failed`);
      }
    };
  }

  // POST /conversations/react { thread, message, emoji, remove? }
  router.post(
    "/conversations/react",
    authenticateWorker,
    messageRoute("react", async (c, target, body) => {
      const emoji =
        typeof body.emoji === "string"
          ? body.emoji.trim().replace(/^:|:$/g, "")
          : "";
      if (!emoji) return errorResponse(c, "emoji is required", 400);
      const manager = getChatInstanceManager();
      if (!manager?.reactToMessage) {
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }
      await manager.reactToMessage(target.connectionId, {
        threadId: target.threadId,
        messageId: target.messageId,
        emoji,
        remove: body.remove === true,
      });
      return c.json({ ok: true });
    })
  );

  // POST /conversations/edit { thread, message, text } — bot's own messages only
  // (Slack enforces this server-side on the bot token).
  router.post(
    "/conversations/edit",
    authenticateWorker,
    messageRoute("edit", async (c, target, body) => {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const textError = outboundChatTextError(text);
      if (textError) return errorResponse(c, textError, 400);
      const manager = getChatInstanceManager();
      if (!manager?.editMessage) {
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }
      await manager.editMessage(target.connectionId, {
        threadId: target.threadId,
        messageId: target.messageId,
        text,
      });
      return c.json({ ok: true });
    }, { askingConversationOnly: true })
  );

  // POST /conversations/delete { thread, message } — bot's own messages only.
  router.post(
    "/conversations/delete",
    authenticateWorker,
    messageRoute("delete", async (c, target) => {
      const manager = getChatInstanceManager();
      if (!manager?.deleteMessage) {
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }
      await manager.deleteMessage(target.connectionId, {
        threadId: target.threadId,
        messageId: target.messageId,
      });
      return c.json({ ok: true });
    })
  );

  return router;
}
