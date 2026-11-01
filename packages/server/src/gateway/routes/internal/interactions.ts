#!/usr/bin/env bun

import {
  createLogger,
  getErrorMessage,
  getTracer,
  runInSpanContext,
  traceparentHeader,
  withChildSpan,
  type WorkerTokenData,
} from "@lobu/core";
import {
	isApprovalAttribution,
	isInteractionResourceKind,
} from "@lobu/core/contracts/interaction-envelope";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { agentTurnIdentityFromClaims } from "../../../tools/turn-write-idempotency.js";
import type { InteractionService } from "../../interactions.js";
import { CHAT_SENDER_NOT_LINKED, isConfinedChatTurn } from "../../orchestration/chat-turn-actor.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { captureSideEffect } from "./capture-mode.js";
import { sendOncePerTurnInput } from "./turn-write-once.js";

const logger = createLogger("internal-interaction-routes");

/** Recover the originating trace from the authenticated turn, across worker HTTP. */
async function withInteractionTrace<T>(
  worker: WorkerTokenData,
  post: () => Promise<T>
): Promise<T> {
  const turn = agentTurnIdentityFromClaims(worker);
  if (!getTracer() || !turn) return post();

  let parent: string | null = null;
  try {
    const [stored] = await getDb()<{ traceparent: string | null }>`
      SELECT action_input->'reply'->'platform_metadata'->>'traceparent' AS traceparent
      FROM runs
      WHERE id = ${turn.runId} AND run_type = 'agent_turn'
        AND organization_id = ${turn.organizationId}
        AND action_input->'turn'->>'agent_id' = ${turn.agentId}
        AND action_input->'turn'->>'conversation_id' = ${turn.conversationId}
        AND action_input->'turn'->>'message_id' = ${turn.messageId}
        AND action_input->'reply'->>'user_id' = ${worker.userId}
    `;
    parent = traceparentHeader(stored?.traceparent);
  } catch (error) {
    // Observability must not block an otherwise authorized card. Only the
    // lookup is best-effort; never retry a post whose outcome is uncertain.
    logger.warn("Unable to recover interaction trace", { error: getErrorMessage(error) });
  }
  if (!parent) return post();

  return withChildSpan(
    "interaction_post",
    parent,
    (span) => runInSpanContext(span, post),
    { "lobu.run_id": turn.runId }
  );
}

/**
 * Create internal interaction routes (Hono)
 */
export function createInteractionRoutes(
  interactionService: InteractionService
): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  /**
   * Post a question with button options (non-blocking)
   * POST /internal/interactions/create
   */
  router.post(
    "/internal/interactions/create",
    authenticateWorker,
    async (c) => {
      try {
        const worker = getVerifiedWorker(c);
        const {
          userId,
          conversationId,
          channelId,
          teamId,
          connectionId,
          platform,
          // Headless run origin (automation-run/scheduled-job/connector-repair/
          // internal). Threaded onto the card so the API platform can exempt
          // it from the SSE-owner gate — a headless turn has no browser SSE on
          // any pod, so an owner-gated card would dead-letter.
          source,
          messageId,
        } = worker;
        const body = await c.req.json();
        const interactionType =
          typeof body?.interactionType === "string"
            ? body.interactionType
            : "question";

        // Approval cards address workspace runs and update their events; only
        // ordinary questions/links are confined to the signed source thread.
        if (interactionType === "tool_approval" && isConfinedChatTurn(worker)) {
          return errorResponse(c, CHAT_SENDER_NOT_LINKED, 403);
        }

        logger.info(
          `Posting ${interactionType} for conversation ${conversationId}`
        );

        const captured = await captureSideEffect(c, "interactions.create", {
          interactionType,
          conversationId,
          platform,
        });
        if (captured) return captured;

        // Once per turn input: a re-run or repeated call posts one card.
        return await sendOncePerTurnInput(
          c,
          worker,
          "interactions.create",
          { conversationId, channelId, body },
          () => withInteractionTrace(worker, async () => {
            if (interactionType === "link_button") {
              const posted = await interactionService.postLinkButton(
                userId,
                conversationId,
                channelId,
                teamId,
                connectionId,
                platform || "unknown",
                body.url,
                body.label,
                body.linkType || "oauth",
                typeof body.body === "string" ? body.body : undefined,
                source,
                messageId
              );
              return c.json({ id: posted.id, status: "posted" });
            }

            // Durable approval card (runs/events-backed; an agent's manage_agents
            // write gate). Routed to the API platform's
            // tool:durable-approval-card subscription, which enqueues it onto the
            // SAME owner-gated thread_response queue the other cards use.
            if (interactionType === "tool_approval") {
              const posted = await interactionService.postDurableApprovalCard(
                userId,
                conversationId,
                channelId,
                teamId,
                connectionId,
                platform || "unknown",
                Number(body.runId),
                typeof body.action === "string" ? body.action : "change",
                (body.proposal ?? null) as Record<string, unknown> | null,
                (body.current ?? null) as Record<string, unknown> | null,
                source,
                // entity_field_change (manage_entity) carries a human-owned-field
                // diff + who proposed it; manage_agents leaves these null.
                (body.fields ?? null) as Record<string, unknown> | null,
                // Keep malformed/legacy cards non-fatal without lying to the
                // downstream contract about their discriminator values.
                isApprovalAttribution(body.attribution) ? body.attribution : null,
                isInteractionResourceKind(body.resourceKind)
                  ? body.resourceKind
                  : null,
                messageId
              );
              // The live approval card is a one-shot SSE push, and the transcript
              // doesn't carry interaction parts — so on reload the card is lost.
              // Stamp the conversation onto the durable approval event (manage_agents
              // created it WITHOUT one — the tool ctx has no conversationId; the
              // worker does) so the history endpoint can replay it. Routing-metadata
              // only; `events` is append-only for DELETE, and once the approval is
              // resolved the superseding event drops it from current_event_records.
              await getDb()`
                UPDATE events
                SET metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object('conversationId', ${conversationId}::text)
                WHERE run_id = ${Number(body.runId)}
                  AND interaction_type = 'approval'
                  AND interaction_status = 'pending'
              `;
              return c.json({ id: posted.id, status: "posted" });
            }

            const posted = await interactionService.postQuestion(
              userId,
              conversationId,
              channelId,
              teamId,
              connectionId,
              platform || "unknown",
              body.question,
              body.options || [],
              source,
              messageId
            );

            return c.json({ id: posted.id, status: "posted" });
          })
        );
      } catch (error) {
        // Serialize the message + stack explicitly. The console logger
        // JSON.stringifies a positional Error arg to `{}` (Error's own
        // enumerable props are empty), which is exactly what hid the
        // connectionId 500 in #1274. Use the codebase's `{ error: <message> }`
        // convention so the real cause (e.g. assertRoutableInteraction's
        // "connectionId is required") is visible.
        logger.error("Failed to post question", {
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return errorResponse(c, "Failed to post question", 500);
      }
    }
  );

  logger.debug("Internal interaction routes registered");
  return router;
}
