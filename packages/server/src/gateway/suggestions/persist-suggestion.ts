import {
  createLogger,
  sanitizeSuggestionPrompts,
  type SuggestedPrompt,
} from "@lobu/core";
import { getDb } from "../../db/client.js";
import type { DbClient } from "../../db/client.js";
import { insertEvent } from "../../utils/insert-event.js";

const logger = createLogger("persist-suggestion");

/**
 * Advisory-lock namespace for suggestion supersession. Distinct from the
 * event-dedup namespace so the two lock spaces never collide on a shared key.
 */
const SUGGESTION_LOCK_NAMESPACE = 0x5355 /* "SU" */;

/**
 * FNV-1a hash of the conversation id → int4 advisory-lock key. Same pattern as
 * `eventDedupLockKey`, keyed on conversationId (not connectionId+originId)
 * because suggestions supersede per CONVERSATION and API/Builder sessions have
 * no numeric connectionId.
 */
function suggestionLockKey(conversationId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < conversationId.length; i++) {
    hash ^= conversationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Read the conversation's current suggestion set (for completion embedding and
 * history replay). Returns null if none is current.
 */
export async function readCurrentSuggestion(
  organizationId: string,
  conversationId: string,
  sql: DbClient = getDb()
): Promise<{
  id: number;
  prompts: SuggestedPrompt[];
  turnMessageId: string | null;
} | null> {
  const rows = (await sql`
    SELECT id, interaction_input, metadata
    FROM current_event_records
    WHERE organization_id = ${organizationId}
      AND interaction_type = 'suggestion'
      AND interaction_status = 'current'
      AND origin_id = ${`suggestion:${conversationId}`}
    ORDER BY id DESC
    LIMIT 1
  `) as Array<{
    id: number;
    interaction_input: { prompts?: SuggestedPrompt[] } | null;
    metadata: Record<string, unknown> | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  const prompts = sanitizeSuggestionPrompts(row.interaction_input?.prompts);
  if (prompts.length === 0) return null;
  return {
    id: row.id,
    prompts,
    turnMessageId: (row.metadata?.turnMessageId as string | null) ?? null,
  };
}

/**
 * Set the conversation's suggestion set at a turn's terminal boundary: the
 * chips that turn's model proposed (already output-scanned), or none. The ONE
 * writer of suggestion state.
 *
 * Runs on the gateway pod that renders the API terminal row, after the output
 * scan. The whole read→decide→write is one advisory-locked transaction keyed
 * on the conversation, so it is race-free across replicas:
 *
 *  - A LATER turn of this conversation already completed → write nothing. A
 *    terminal can be rendered late (it waits out SSE-owner re-queues), and the
 *    user has since seen a newer reply. "Later" is a newer transcript
 *    snapshot: the completion route commits one with every completed turn, in
 *    the same transaction as its terminal row, keyed by the turn's agent_turn
 *    run. Agent and conversation come from that run's own envelope — the
 *    values the snapshot writer used — so the probe hits the
 *    `agent_transcript_snapshot_latest` index with the keys it was written by.
 *  - `prompts` non-empty → they become the current set, superseding the live
 *    row. A re-delivery of the same terminal finds its own current set and
 *    writes nothing.
 *  - `prompts` empty → a visible prior set is cleared, so stale chips never
 *    trail a reply that offered none; with nothing visible, nothing is
 *    written.
 *
 * Rows are appended, never updated: each write supersedes the live row, so the
 * conversation's history stays a single chain in `current_event_records`.
 * Supersession is explicit rather than insertEvent's origin-based path, which
 * bails when `connectionId` is falsy — exactly the API/Builder case — and the
 * lock is mandatory: "both replicas see no live row → two current rows" is not
 * caught by a unique index.
 */
export async function finalizeTurnSuggestions(args: {
  organizationId: string;
  conversationId: string;
  /** messageId + processedMessageIds of the completing turn. */
  turnMessageIds: string[];
  /** The agent_turn `runs.id` that produced this terminal. */
  turnRunId: number;
  prompts: SuggestedPrompt[];
}): Promise<void> {
  const { organizationId, conversationId, turnMessageIds, turnRunId } = args;
  const owned = new Set(turnMessageIds.filter(Boolean));
  const prompts = sanitizeSuggestionPrompts(args.prompts);
  return getDb().begin(async (tx: DbClient) => {
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      conversationId
    )})`;

    const newer = await tx`
      SELECT 1
      FROM public.runs r
      JOIN public.agent_transcript_snapshot s
        ON s.organization_id = r.organization_id
       AND s.agent_id = r.action_input->'turn'->>'agent_id'
       AND s.conversation_id = r.action_input->'turn'->>'conversation_id'
       AND s.run_id > r.id
      WHERE r.id = ${turnRunId}
        AND r.organization_id = ${organizationId}
      LIMIT 1
    `;
    if (newer.length > 0) return;

    // The latest LIVE row whatever its status — `current_event_records`
    // defines live as "nothing supersedes me" — so every write extends the
    // one chain rather than stranding an earlier clear marker as live forever.
    const rows = (await tx`
      SELECT id, interaction_status, metadata
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{
      id: number;
      interaction_status: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    const live = rows[0];
    const visible = live?.interaction_status === "current" ? live : undefined;
    const visibleTurn =
      (visible?.metadata?.turnMessageId as string | null | undefined) ?? null;

    if (prompts.length > 0) {
      if (visibleTurn != null && owned.has(visibleTurn)) return;
      await insertEvent(
        {
          entityIds: [],
          organizationId,
          // Stable per-conversation origin — useful for lookups; supersession
          // is driven explicitly by supersedesEventId, not this origin.
          originId: `suggestion:${conversationId}`,
          semanticType: "operation",
          // Keep the search document empty — UI-state suggestions must not
          // pollute memory search / feeds / retrieval.
          title: null,
          content: null,
          runId: turnRunId,
          interactionType: "suggestion",
          interactionStatus: "current",
          interactionInput: { prompts },
          supersedesEventId: live?.id ?? null,
          metadata: {
            conversationId,
            turnMessageId: turnMessageIds.find(Boolean) ?? null,
          },
          authorName: "agent",
        },
        { sql: tx }
      );
      logger.info(
        `Set ${prompts.length} suggestion(s) for conversation ${conversationId}`
      );
      return;
    }

    if (!visible) return;
    await insertEvent(
      {
        entityIds: [],
        organizationId,
        originId: `suggestion:${conversationId}`,
        semanticType: "operation",
        title: null,
        content: null,
        // 'completed' marks a terminal, non-current suggestion row so it drops
        // out of the current-set query (which filters interaction_status).
        interactionType: "suggestion",
        interactionStatus: "completed",
        interactionInput: { prompts: [] },
        supersedesEventId: visible.id,
        runId: turnRunId,
        metadata: { conversationId, cleared: true },
        authorName: "system",
      },
      { sql: tx }
    );
  });
}
