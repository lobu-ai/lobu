import { createHash } from "node:crypto";
import { createLogger } from "@lobu/core";
import { Hono, type Context } from "hono";
import {
  resolveAddressableTargets,
  resolveAuthorizedTarget,
  resolveAuthorizedThread,
  threadHandleForMessage,
  type AddressableTarget,
} from "../../conversations/authorization.js";
import {
  conversationRefsMatch,
  parseConversationRef,
} from "../../conversations/conversation-ref.js";
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

const logger = createLogger("conversations-routes");

const MAX_CONTENT_LENGTH = 4000;
// Refuse mass-mentions: both the human-written `@channel` form (anywhere, not
// just after whitespace) and Slack's actual broadcast tokens `<!channel>` /
// `<!here>` / `<!everyone>` / `<!subteam^…>`.
const MASS_MENTION =
  /@(channel|here|everyone)\b|<!(channel|here|everyone|subteam)\b/i;

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
      logger.error(`list conversations failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
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
      logger.error(`read conversation failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // POST /conversations/send { target, text }
  router.post("/conversations/send", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      if (!worker.agentId || !worker.organizationId) {
        return errorResponse(c, "Token missing agent/org context", 403);
      }
      const body = (await c.req.json().catch(() => null)) as {
        target?: string;
        text?: string;
      } | null;
      const text = body?.text?.trim();
      if (!body?.target || !text) {
        return errorResponse(c, "target and text are required", 400);
      }
      if (text.length > MAX_CONTENT_LENGTH) {
        return errorResponse(
          c,
          `Message too long (max ${MAX_CONTENT_LENGTH} chars)`,
          400
        );
      }
      if (MASS_MENTION.test(text)) {
        return errorResponse(
          c,
          "Mass mentions (@channel/@here/@everyone) are not allowed",
          400
        );
      }

      // `target` is either a channel handle (top-level post) or a thread handle
      // from a prior send (reply in that thread). A thread handle re-authorizes
      // its own channel subscription, so try it first; fall back to channel.
      let target: AddressableTarget;
      let threadId: string | undefined;
      const asThread = await resolveAuthorizedThread(
        worker.agentId,
        worker.organizationId,
        body.target
      );
      if (asThread) {
        target = asThread.target;
        threadId = asThread.threadId;
      } else {
        const resolved = await resolveAuthorizedTarget(
          worker.agentId,
          worker.organizationId,
          body.target
        );
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

      const manager = getChatInstanceManager();
      if (!manager?.postToConversation) {
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }
      const sent = (await manager.postToConversation(target.connectionId, {
        platform: target.platform,
        channelKey: target.channelKey,
        channelId: target.channelId,
        threadId,
        content: { markdown: text },
        // Follow the thread we just posted into so replies (e.g. lunch orders)
        // come back to us and land in the transcript.
        subscribe: true,
      })) as { messageId: string; threadId: string };

      logger.info(
        `agent ${worker.agentId} sent to ${target.platform}/${target.channelId}${threadId ? " (thread)" : ""} via ${target.connectionId}`
      );

      // Persist the bot's own post into the transcript (with the real platform
      // message id) so read_conversation includes it AND the inbound echo of
      // this message dedups against it.
      if (sent.messageId) {
        captureChannelMessage({
          organizationId: worker.organizationId,
          connectionId: target.connectionId,
          platform: target.platform,
          channelId: target.channelId,
          threadId: threadId ?? null,
          platformMessageId: sent.messageId,
          authorId: worker.agentId,
          authorName: worker.agentId,
          // Bot's own post — no sender attribution; team_id is not in scope here.
          teamId: null,
          isBot: true,
          text,
          occurredAt: new Date(),
        });
      }

      // A thread handle lets a later run reply into this message's thread.
      // Prefer the adapter's returned thread id (root) when it carries one
      // (reply-in-existing-thread); fall back to the new message id (the root
      // of a freshly-opened thread). Telegram's message id is `${chatId}:${n}`,
      // so strip the redundant channel prefix — else the thread handle encodes a
      // 4-segment `platform:channel:chatId:n` that its own 3-part decode rejects
      // (and createThread can't resolve). No-op for ids that aren't prefixed
      // (e.g. a Slack `ts`).
      const rawRoot =
        typeof sent.threadId === "string" && sent.threadId.split(":")[2]
          ? sent.threadId.split(":")[2]
          : sent.messageId;
      const threadRoot = rawRoot.startsWith(`${target.channelId}:`)
        ? rawRoot.slice(target.channelId.length + 1)
        : rawRoot;
      const threadHandle = threadRoot
        ? threadHandleForMessage(target, threadRoot)
        : undefined;
      // Did this post land in the very conversation that triggered the run?
      // If so the user has ALREADY read the agent's answer, and the terminal
      // `finalText` the worker is about to emit is a report about it — posting
      // that too is the double-message. The comparison can only happen here:
      // the model holds an opaque handle, and only this route has resolved it
      // to concrete channel/thread coordinates. The worker's own conversation
      // comes from its signed token, so the model cannot spoof a match to
      // silence its own reply.
      const deliveredInBand = conversationRefsMatch(
        { channelKey: target.channelKey, ...(threadId ? { threadId } : {}) },
        parseConversationRef(worker.conversationId)
      );

      return c.json({
        messageId: sent.messageId || null,
        thread: threadHandle,
        deliveredInBand,
      });
    } catch (error) {
      logger.error(`send conversation failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // POST /conversations/present-event { eventId }
  //
  // Unlike send_message, this route accepts no destination or authored card.
  // It renders a tenant-owned durable event through its declared json_template
  // and posts it back into the signed source conversation. That keeps event
  // actions portable across web/Slack/Google Chat without teaching the model
  // platform card JSON or internal action-id formats.
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

      const presentation = await presentStoredEventToConversation({
        organizationId: worker.organizationId,
        eventId,
        connectionId: worker.connectionId,
        platform: worker.platform,
        channelId: worker.channelId,
        channelKey: `${worker.platform}:${stripPlatformPrefix(
          worker.platform,
          worker.channelId
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
            "Event has no renderable declared json_template",
            422
          );
        }
        return errorResponse(c, "Chat instance manager unavailable", 503);
      }

      captureChannelMessage({
        organizationId: worker.organizationId,
        connectionId: worker.connectionId,
        platform: worker.platform,
        channelId: worker.channelId,
        threadId: presentation.threadId,
        platformMessageId: presentation.messageId,
        authorId: worker.agentId,
        authorName: worker.agentId,
        teamId: worker.teamId ?? null,
        isBot: true,
        text: presentation.fallbackText,
        occurredAt: new Date(),
      });

      return c.json({
        messageId: presentation.messageId,
        deliveredInBand: true,
      });
    } catch (error) {
      logger.error(`present event failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
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
        {
          organizationId: worker.organizationId,
          // Chat platform user ids are not Lobu user-row ids. Keep durable
          // creator attribution on the signed agent and retain the platform
          // principal only inside the trusted delivery context.
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
          },
          isAuthenticated: true,
          clientId: "lobu-worker",
          scopes: null,
          tokenType: "session",
          scopedToOrg: true,
          allowCrossOrg: false,
          grantedOrganizationIds: null,
          directSearchFederation: false,
        } satisfies ToolContext
      );
      if (schedule.error) {
        return errorResponse(c, schedule.error, 422);
      }
      return c.json({ scheduled: true, schedule: schedule.schedule });
    } catch (error) {
      logger.error(`schedule followup failed: ${String(error)}`);
      return errorResponse(c, "Internal server error", 500);
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
    ) => Promise<Response>
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
        const captured = await captureSideEffect(c, `conversations.${label}`, body);
        if (captured) return captured;
        return await handler(c, target, body);
      } catch (error) {
        logger.error(`${label} failed: ${String(error)}`);
        return errorResponse(c, "Internal server error", 500);
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
      if (!text) return errorResponse(c, "text is required", 400);
      if (text.length > MAX_CONTENT_LENGTH) {
        return errorResponse(
          c,
          `Message too long (max ${MAX_CONTENT_LENGTH} chars)`,
          400
        );
      }
      if (MASS_MENTION.test(text)) {
        return errorResponse(
          c,
          "Mass mentions (@channel/@here/@everyone) are not allowed",
          400
        );
      }
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
    })
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
