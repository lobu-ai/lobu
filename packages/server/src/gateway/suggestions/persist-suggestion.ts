import {
  createLogger,
  sanitizeSuggestionPrompts,
  type SuggestedPrompt,
} from "@lobu/core";
import { getDb, pgTextArray } from "../../db/client.js";
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
 * The completing turn's run id from `agent_run_input`, keyed by the message ids
 * the turn processed. A row exists for EVERY turn (including one that emitted no
 * suggestion event of its own) and rows are marked 'completed' rather than
 * deleted, so the id is still readable at terminal time. Returns null when no
 * message ids are supplied or none match (older workers, unstamped turns) — the
 * ordering guard that consumes it treats a null run id as "unknown, don't block".
 *
 * Always read on the caller's transaction: `finalizeTurnSuggestions` needs the
 * id inside its advisory lock so the value cannot change under the guard.
 */
async function readTurnRunId(
  organizationId: string,
  conversationId: string,
  turnMessageIds: string[],
  sql: DbClient
): Promise<number | null> {
  const owned = turnMessageIds.filter(Boolean);
  if (owned.length === 0) return null;
  const rows = (await sql`
    SELECT max(run_id) AS run_id
    FROM public.agent_run_input
    WHERE organization_id = ${organizationId}
      AND conversation_id = ${conversationId}
      AND message_id = ANY(${pgTextArray(owned)}::text[])
  `) as Array<{ run_id: number | null }>;
  return rows[0]?.run_id ?? null;
}

/**
 * Set the conversation's suggestion set at a turn's terminal boundary: the
 * chips that turn's model proposed, or none. The ONE writer of suggestion
 * state.
 *
 * Runs on the gateway for EVERY completed API terminal row — before the SSE
 * owner-gate, so it executes regardless of which pod (if any) holds the
 * client's socket and is NOT lost when a disconnected client leaves no SSE
 * owner. The whole read→decide→write is one advisory-locked transaction keyed
 * on the conversation, so it is race-free across replicas and against an
 * out-of-order terminal of an earlier turn:
 *
 *  - A LATER turn already set the conversation's chips (its run id is higher)
 *    → leave them; this terminal is late, and the user is looking at the newer
 *    set. Ordering comes from `agent_run_input.run_id`, which exists for EVERY
 *    turn keyed by the message ids this function receives.
 *  - `prompts` non-empty → they become the current set, superseding the live
 *    row. A re-delivery of the same terminal (the row re-queued to the SSE
 *    owner) finds its own current set and writes nothing.
 *  - `prompts` empty → a visible prior set is cleared, so stale chips never
 *    trail a reply that offered none — including this turn's own set when a
 *    guardrail blocked the reply after it was written.
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
  prompts: SuggestedPrompt[];
}): Promise<void> {
  const { organizationId, conversationId, turnMessageIds } = args;
  const owned = new Set(turnMessageIds.filter(Boolean));
  const prompts = sanitizeSuggestionPrompts(args.prompts);
  return getDb().begin(async (tx: DbClient) => {
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      conversationId
    )})`;

    // Read inside the lock on `tx`, so the value cannot change under the guard.
    const turnRunId = await readTurnRunId(
      organizationId,
      conversationId,
      [...owned],
      tx
    );
    // The latest LIVE row whatever its status — `current_event_records`
    // defines live as "nothing supersedes me" — so every write extends the
    // one chain rather than stranding an earlier clear marker as live forever.
    const rows = (await tx`
      SELECT id, run_id, interaction_status, metadata
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{
      id: number;
      run_id: number | null;
      interaction_status: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    const live = rows[0];
    if (
      live &&
      turnRunId != null &&
      live.run_id != null &&
      Number(live.run_id) > turnRunId
    ) {
      return;
    }
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

    // Nothing visible → nothing to clear, and no row is appended: a clear
    // marker per chip-less turn would grow `events` on most turns. The one
    // case this leaves open — an EARLIER turn's terminal first processed after
    // a later chip-less one — cannot arise in order, since a conversation's
    // turns run one at a time and each terminal commits with its turn.
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
        // Stamped with the CLEARING turn's run id so the ordering guard above
        // sees "a later run already cleared this" — without it a delayed
        // terminal could resurrect chips over the clear.
        runId: turnRunId,
        metadata: { conversationId, cleared: true },
        authorName: "system",
      },
      { sql: tx }
    );
  });
}
