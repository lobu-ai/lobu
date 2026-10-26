import { isDeepStrictEqual } from 'node:util';
import { decrypt, isExplicitCancelMessage, isSteerableHumanMessage, verifyWorkerToken, type AgentErrorContext, type MessagePayload, type SuggestedPrompt, type WorkerTokenData } from '@lobu/core';
import { AGENT_TURN_INPUT_MAX, type AgentTurnPollPayload, type HeartbeatResponse } from '@lobu/core/contracts/worker/protocol';
import { CURRENT_SESSION_VERSION } from '@mariozechner/pi-coding-agent';
import { getDb, type DbClient } from '../db/client';
import { classifyRunOutcome } from './run-outcome';
import type { TurnReply } from '../gateway/orchestration/agent-turn-producer';
import { dischargeTurnMarkers, extendTurnDeadlines, insertThreadResponseRow, reaperBackstopDeadlineMs, resetTurnAdmissionDeadline } from '../gateway/orchestration/turn-liveness';
import { agentTurnRunIdFromClaims, agentTurnTokenScope, generateDeploymentName } from '../gateway/orchestration/deployment-identity';

export interface NativeTurnRun {
  id: number;
  organization_id: string;
  parent_run_id: number | null;
  status: string;
  claimed_by: string | null;
  action_input: {
    turn?: AgentTurnPollPayload['turn'];
    reply?: TurnReply;
    credential?: string;
  } | null;
  run_metadata: {
    native_session_base?: { version: number; session_id: string; final_stored_entry_id: string | null } | null;
    cancel_requested_at?: string;
    /**
     * Semantic identity of the terminal completion this run durably recorded
     * (`agentTurnCompletionHash`), stamped by the completion route. A retry
     * presenting the same hash is acknowledged without a second write; a
     * conflicting one is rejected without a second terminal. Absent on rows
     * completed before the marker existed, which keep legacy idempotence.
     */
    turn_completion_hash?: string;
    /** Last streamed delta sequence published for the current attempt. */
    turn_delta_sequence?: number;
    /**
     * Whether the current attempt may have caused a side effect. Stamped
     * `false` at claim, and `true` by the gateway BEFORE it executes any
     * side-effecting call made with the turn's credential
     * ({@link markAgentTurnToolStarted}) and with the first stored tool trace.
     * Absent means unknown, which is never re-run.
     */
    turn_tool_started?: boolean;
    /** How many times the reaper put this turn back after its worker died. */
    turn_requeue_count?: number;
    /**
     * Whether the current attempt's worker sent its `turn_credential` on a
     * heartbeat. Stamped `false` at claim. Only a proven attempt is re-run:
     * an older worker binary cannot be fenced from the attempt that replaces it.
     */
    turn_credential_proven?: boolean;
  } | null;
}

/** A turn whose worker died before any tool started is re-run at most this often. */
export const AGENT_TURN_MAX_REQUEUES = 1;

/** The answer when a call arrives from an attempt the reaper already retired. */
export class StaleAgentTurnAttemptError extends Error {
  constructor() {
    super('this agent turn attempt no longer owns the run');
  }
}

/**
 * The attempt a turn credential names: its `jti`. Each claim of a re-run gets a
 * freshly minted credential (the reaper rotates it on requeue) and a refresh
 * keeps the jti, so the jti identifies one attempt for its whole life.
 *
 * Decoded, not verified: the AES-GCM envelope already proves the server minted
 * it, and the TTL is the wrong question here. The run's stored copy keeps its
 * mint timestamp while the worker refreshes its own, so a TTL check would
 * retire a live attempt.
 */
function turnCredentialJti(credential: unknown): string | undefined {
  if (typeof credential !== 'string' || credential.length === 0) return undefined;
  try {
    const payload: unknown = JSON.parse(decrypt(credential));
    if (!payload || typeof payload !== 'object') return undefined;
    const { tokenKind, jti } = payload as { tokenKind?: unknown; jti?: unknown };
    return tokenKind === 'worker' && typeof jti === 'string' && jti.length > 0 ? jti : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE attempt fence: does `attemptJti` name the attempt that currently holds
 * this agent turn (the credential the run was last claimed with)? `claimed_by`
 * cannot say this when the same worker id re-claims a re-run. Every report
 * from an attempt goes through here: gateway tool calls
 * ({@link markAgentTurnToolStarted}), heartbeats (deltas and tool traces ride
 * them) and the completion.
 */
export function isCurrentAgentTurnAttempt(runCredential: unknown, attemptJti: string | undefined): boolean {
  const current = turnCredentialJti(runCredential);
  return current !== undefined && current === attemptJti;
}

/**
 * True when a worker report (heartbeat, delta, tool trace or completion) does
 * not come from the run's current attempt. A report naming another attempt's
 * credential is stale. A report with no `turn_credential` comes from a worker
 * binary older than the attempt fence; it keeps the `claimed_by` fence until
 * the turn has been re-run, after which `claimed_by` cannot tell the attempts
 * apart, so it is stale too. The reaper only re-runs an attempt whose worker
 * proved it sends the credential ({@link recordAgentTurnCredentialProven}).
 */
export function isStaleAgentTurnReport(
  run: Pick<NativeTurnRun, 'action_input' | 'run_metadata'>,
  turnCredential: unknown
): boolean {
  if (turnCredential === undefined) return (run.run_metadata?.turn_requeue_count ?? 0) > 0;
  return !isCurrentAgentTurnAttempt(run.action_input?.credential, turnCredentialJti(turnCredential));
}

/**
 * Mark the current attempt as one whose worker sends `turn_credential`, so the
 * reaper may re-run it if it dies. Called on a heartbeat that passed
 * {@link isStaleAgentTurnReport} with a credential, inside the transaction
 * holding the run lock. Claim resets it to `false` for each attempt.
 */
export async function recordAgentTurnCredentialProven(sql: DbClient, run: NativeTurnRun, turnCredential: unknown): Promise<void> {
  if (turnCredential === undefined || run.run_metadata?.turn_credential_proven === true) return;
  await sql`
    UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || '{"turn_credential_proven": true}'::jsonb
    WHERE id = ${run.id}
  `;
}

/**
 * Record, BEFORE the gateway executes it, that a call made with an agent
 * turn's credential may have a side effect — so the reaper never re-runs that
 * attempt (`sweepStaleAgentTurnRuns`). The worker reports a tool only when it
 * finishes; this closes the window where a tool acted and the worker died
 * before its trace arrived.
 *
 * Every side-effecting route the turn can reach calls this: the MCP tool
 * routes and every non-GET `/internal/*` route (`authenticateWorker`). A token
 * that is not an agent turn's is not this function's business. A capture-mode
 * call performs no effect, so it stamps nothing.
 *
 * Fails closed: a failed write throws, and the caller must not execute the
 * call. A retired attempt throws {@link StaleAgentTurnAttemptError}, including
 * after another worker claims the re-run with its new credential.
 */
export async function markAgentTurnToolStarted(
  claims: Pick<WorkerTokenData, 'deploymentName' | 'messageId' | 'runId' | 'organizationId' | 'executionMode' | 'jti'>,
): Promise<void> {
  const runId = agentTurnRunIdFromClaims(claims);
  if (runId === undefined || claims.executionMode === 'capture') return;
  await getDb().begin(async (tx) => {
    // The same row lock as the reaper: the attempt check and side-effect
    // marker must commit together, before either caller can proceed.
    const [row] = await tx<{ status: string; credential: string | null }>`
      SELECT status, action_input->>'credential' AS credential FROM runs
      WHERE id = ${runId} AND run_type = 'agent_turn' AND organization_id = ${claims.organizationId ?? null}
      FOR UPDATE`;
    if (!row || row.status !== 'running' || !isCurrentAgentTurnAttempt(row.credential, claims.jti)) {
      throw new StaleAgentTurnAttemptError();
    }
    await tx`UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || '{"turn_tool_started": true}'::jsonb
      WHERE id = ${runId}`;
  });
}

/** One namespace for admission, claims and terminal queue handoff across replicas. */
export function agentTurnLockKey(sql: DbClient, organizationId: string | null, agentId: string | null, conversationId: string | null) {
  return sql`hashtextextended(jsonb_build_array('agent_turn_claim', ${organizationId}::text,
    ${agentId}::text, ${conversationId}::text)::text, 0)`;
}

export async function lockAgentTurnConversation(sql: DbClient, organizationId: string, agentId: string | null, conversationId: string | null) {
  await sql`SELECT pg_advisory_xact_lock(${agentTurnLockKey(sql, organizationId, agentId, conversationId)})`;
}

/** Read scope before locking; never wait for the advisory lock while holding a row. */
export async function lockAgentTurnRun(sql: DbClient, runId: number, handoff = false): Promise<NativeTurnRun | undefined> {
  const [scope] = await sql<{ organization_id: string; agent_id: string | null; conversation_id: string | null }>`
    SELECT organization_id, action_input->'turn'->>'agent_id' AS agent_id,
      action_input->'turn'->>'conversation_id' AS conversation_id
    FROM runs WHERE id = ${runId} AND run_type = 'agent_turn'
  `;
  if (!scope) return undefined;
  await lockAgentTurnConversation(sql, scope.organization_id, scope.agent_id, scope.conversation_id);
  // A late admission can have allocated an earlier ID. Terminal writers lock
  // the owner and next pending row in ID order before either transition.
  const rows = await sql<NativeTurnRun>`SELECT id, organization_id, parent_run_id, status, claimed_by,
    action_input, run_metadata FROM runs WHERE run_type = 'agent_turn' AND (id = ${runId}
      OR (${handoff} AND id = (SELECT id FROM runs WHERE run_type = 'agent_turn' AND status = 'pending'
        AND organization_id = ${scope.organization_id}
        AND action_input->'turn'->>'agent_id' = ${scope.agent_id}
        AND action_input->'turn'->>'conversation_id' = ${scope.conversation_id} ORDER BY id LIMIT 1)))
    ORDER BY id FOR UPDATE`;
  return rows.find((row) => Number(row.id) === runId);
}

/**
 * The agent turn a turn-liveness marker speaks for, locked exactly as the
 * reaper locks it (`lockAgentTurnRun` with handoff: the conversation advisory
 * lock, then the owner and next pending rows in id order). The marker fire
 * calls this BEFORE it deletes the marker, so every writer takes the
 * conversation lock first and the marker row after it.
 *
 * Matched on the marker's message id within its organization's active turns
 * (the `idx_runs_agent_turn_conversation_active` partial index), and confirmed
 * by deriving the marker's deployment name from the run with the same function
 * the heartbeat uses. A subprocess-lane turn has no agent_turn run: undefined.
 */
export async function lockAgentTurnForMarker(
  sql: DbClient,
  marker: { organizationId?: string; messageId: string; deploymentName: string },
): Promise<NativeTurnRun | undefined> {
  if (!marker.organizationId) return undefined;
  const candidates = await sql<Pick<NativeTurnRun, 'id' | 'organization_id' | 'action_input'>>`
    SELECT id, organization_id, action_input FROM runs
    WHERE run_type = 'agent_turn' AND status IN ('pending', 'claimed', 'running')
      AND organization_id = ${marker.organizationId}
      AND action_input->'turn'->>'message_id' = ${marker.messageId}`;
  const match = candidates.find((run) => turnMarkerDeployment(run) === marker.deploymentName);
  if (!match) return undefined;
  const run = await lockAgentTurnRun(sql, Number(match.id), true);
  return run && ['pending', 'claimed', 'running'].includes(run.status) ? run : undefined;
}

/**
 * Close an agent turn whose liveness marker just showed the user its error, in
 * the marker's transaction. Once the user has seen an error the turn is over:
 * the reaper must never re-run it (`sweepStaleAgentTurnRuns` only considers
 * active runs), and a late completion meets the terminal handling instead of
 * publishing a second reply. The follower queued behind it is released exactly
 * as the reaper's terminal path does, unless the closed run was itself still
 * blocked behind an active owner.
 */
export async function closeAgentTurnShownError(sql: DbClient, run: NativeTurnRun): Promise<void> {
  const [state] = await sql<{ head: boolean }>`
    SELECT (r.status <> 'pending' OR ${agentTurnClaimEligible(sql)}) AS head FROM runs r WHERE r.id = ${run.id}`;
  await sql`UPDATE runs SET status = 'timeout', completed_at = now(),
      outcome = ${classifyRunOutcome({ status: 'timeout' })}, exit_reason = 'timeout',
      error_message = 'turn_liveness_error_shown'
    WHERE id = ${run.id} AND status IN ('pending', 'claimed', 'running')`;
  if (state?.head) await releaseNextAgentTurn(sql, run);
}

/** Embed with the candidate aliased as r, including the final claim/timeout recheck. */
export function agentTurnClaimEligible(sql: DbClient) {
  return sql`(r.run_at <= now() AND NOT EXISTS (
    SELECT 1 FROM runs sibling
    WHERE sibling.run_type = 'agent_turn' AND sibling.status IN ('pending', 'claimed', 'running')
      AND sibling.organization_id = r.organization_id
      AND sibling.action_input->'turn'->>'agent_id' = r.action_input->'turn'->>'agent_id'
      AND sibling.action_input->'turn'->>'conversation_id' = r.action_input->'turn'->>'conversation_id'
      AND sibling.id <> r.id AND (sibling.status <> 'pending' OR sibling.id < r.id)
  ))`;
}

/** Called only under the conversation lock, after the owning terminal transition. */
export async function releaseNextAgentTurn(sql: DbClient, run: NativeTurnRun) {
  const [next] = await sql<NativeTurnRun>`UPDATE runs SET run_at = now() WHERE id = (
    SELECT id FROM runs WHERE run_type = 'agent_turn' AND status = 'pending'
      AND organization_id = ${run.organization_id}
      AND action_input->'turn'->>'agent_id' = ${run.action_input?.turn?.agent_id ?? null}
      AND action_input->'turn'->>'conversation_id' = ${run.action_input?.turn?.conversation_id ?? null}
    ORDER BY id LIMIT 1
  ) RETURNING id, organization_id, action_input`;
  // The follower becomes claimable from now, so its liveness marker needs its
  // admission window back, in this transaction.
  if (next) await resetAgentTurnAdmission(sql, next);
}

/**
 * Give a turn that just became claimable its liveness marker's admission
 * window back, in the transaction that made it claimable: a follower released
 * by its owner's terminal handoff, or a turn the reaper put back to `pending`
 * after its worker died. Without it the turn waiting for a worker is failed as
 * unresponsive before anyone claims it.
 */
export async function resetAgentTurnAdmission(sql: DbClient, run: Pick<NativeTurnRun, 'organization_id' | 'action_input'>) {
  const deployment = turnMarkerDeployment(run);
  if (deployment && run.action_input?.turn?.message_id) {
    await resetTurnAdmissionDeadline(sql, deployment, run.action_input.turn.message_id);
  }
}

export function nativeSessionBase(snapshot: string): NativeTurnRun['run_metadata'] {
  if (!snapshot) return { native_session_base: null };
  const [header, ...entries] = snapshot.trim().split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return { native_session_base: {
    version: header.version, session_id: header.id, final_stored_entry_id: entries.at(-1)?.id ?? null,
  } };
}

function executionPolicy(run: NativeTurnRun) {
  const input = run.action_input;
  if (!input?.turn || !input.reply || !input.credential) return undefined;
  const claims = verifyWorkerToken(input.credential);
  if (!claims || claims.organizationId !== run.organization_id || claims.agentId !== input.turn.agent_id
    || claims.conversationId !== input.turn.conversation_id || claims.userId !== input.reply.user_id
    || claims.runId !== Number(run.id) || claims.messageId !== input.turn.message_id
    || claims.deploymentName !== agentTurnTokenScope(input.turn.message_id)) return undefined;
  const { runId, messageId, deploymentName, timestamp, jti, traceId, ...scope } = claims;
  // Per-message payload is not policy: the fields below travel WITH the
  // message rather than describing the envelope it must execute in.
  // `ephemeral_context` is among them because the steer offer now carries it
  // (`HeartbeatResponseSchema.steer`), so a follower whose transient block
  // differs from the owner's loses nothing by joining the running turn — the
  // guest shows each message its own. Before that field existed the block was
  // dropped on the way through, and excluding it here meant offering a message
  // whose context could not be delivered.
  const { message_id, message_text, message_images, message_files, session_jsonl, ephemeral_context, ...turn } = input.turn;
  const { message_id: replyMessageId, ...reply } = input.reply;
  return { scope, turn, reply };
}

/** Repeatable offers: the pending rows are retired only by transcript completion. */
export async function pendingAgentTurnInputs(sql: DbClient, owner: NativeTurnRun): Promise<NonNullable<HeartbeatResponse['steer']>> {
  const base = owner.run_metadata?.native_session_base;
  if (base === undefined || (base !== null && base.version !== CURRENT_SESSION_VERSION)) return [];
  const policy = executionPolicy(owner);
  if (!policy) return [];
  const rows = await sql<NativeTurnRun & { source: MessagePayload | null; has_attachments: boolean }>`
    SELECT r.id, r.organization_id, r.parent_run_id, r.status, r.claimed_by, r.run_metadata,
      r.action_input || jsonb_build_object('turn', (r.action_input->'turn') - 'message_images' - 'message_files' - 'session_jsonl') AS action_input,
      (COALESCE(r.action_input->'turn'->'message_images', '[]'::jsonb) <> '[]'::jsonb
        OR COALESCE(r.action_input->'turn'->'message_files', '[]'::jsonb) <> '[]'::jsonb) AS has_attachments,
      source.action_input AS source
    FROM runs r LEFT JOIN runs source ON source.id = r.parent_run_id
      AND source.organization_id = r.organization_id AND source.run_type = 'chat_message' AND source.queue_name = 'messages'
    WHERE r.run_type = 'agent_turn' AND r.status = 'pending' AND r.organization_id = ${owner.organization_id}
      AND r.action_input->'turn'->>'agent_id' = ${owner.action_input?.turn?.agent_id ?? null}
      AND r.action_input->'turn'->>'conversation_id' = ${owner.action_input?.turn?.conversation_id ?? null}
    ORDER BY r.id LIMIT ${AGENT_TURN_INPUT_MAX}
  `;
  const offered: NonNullable<HeartbeatResponse['steer']> = [];
  for (const row of rows) {
    const turn = row.action_input?.turn;
    const source = row.source;
    if (!turn || !source || row.id <= owner.id || !owner.parent_run_id || !row.parent_run_id || row.parent_run_id <= owner.parent_run_id
      || source.organizationId !== row.organization_id || source.agentId !== turn.agent_id
      || source.conversationId !== turn.conversation_id || source.userId !== row.action_input?.reply?.user_id
      || source.messageId !== turn.message_id || typeof source.messageText !== 'string'
      || typeof turn.message_text !== 'string' || !turn.message_text.trim()
      || isExplicitCancelMessage(source) || !isSteerableHumanMessage(source)
      || row.has_attachments
      || !isDeepStrictEqual(policy, executionPolicy(row))) break;
    // The follower's OWN transient context rides with it. Per-message, because
    // that is what it is: the API attaches a live attention digest that differs
    // between two messages sent seconds apart. Delivered on the guest's
    // transient-context channel, never folded into `text`.
    const next = {
      run_id: Number(row.id),
      message_id: turn.message_id,
      text: turn.message_text,
      ...(typeof turn.ephemeral_context === 'string' && turn.ephemeral_context.trim()
        ? { ephemeral_context: turn.ephemeral_context }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify([...offered, next]), 'utf8') > 64 * 1024) break;
    offered.push(next);
  }
  return offered;
}

/**
 * Derive the turn-liveness marker's deployment name from a native turn's
 * envelope. Single source for the sites that need it — the terminal discharge,
 * the heartbeat extension, and the queue handoff that re-arms the next turn's
 * admission window — so none can drift from the arming site in
 * `MessageConsumer`.
 */
function turnMarkerDeployment(run: Pick<NativeTurnRun, 'organization_id' | 'action_input'>): string | null {
  const envelope = run.action_input;
  const reply = envelope?.reply;
  if (!reply) return null;
  return generateDeploymentName({
    organizationId: run.organization_id,
    agentId: envelope?.turn?.agent_id ?? '',
    userId: reply.user_id,
    platform: reply.platform,
    channelId: reply.channel_id,
    conversationId: envelope?.turn?.conversation_id ?? '',
  });
}

/**
 * Push the turn marker's deadline forward for a heartbeating native turn.
 *
 * The isolate lane's heartbeat refreshes `runs.last_heartbeat_at`, which the
 * run reaper reads — but the marker carries its OWN `run_at`, and without this
 * a turn running longer than that marker's deadline collects a spurious
 * terminal error while it is still working. Never throws: a heartbeat ACK must
 * not fail on a liveness bookkeeping error.
 */
export async function extendHeartbeatedTurnMarker(
  runId: number,
  turnCredential?: string,
): Promise<void> {
  try {
    // Its OWN connection, never the caller's transaction handle: the caller
    // fires this without awaiting, and a query issued on a tx that has since
    // committed is a use-after-close that fails the heartbeat response.
    //
    // A plain read, deliberately not `lockAgentTurnRun`: this runs on every
    // heartbeat and only needs the envelope's identity, so taking the
    // conversation lock here would serialize heartbeats behind turn admission.
    // The attempt check is therefore not atomic with the extension; losing that
    // race only extends the replacement attempt's own marker, which its own
    // beats extend anyway.
    const sql = getDb();
    const [run] = await sql<NativeTurnRun>`
      SELECT id, organization_id, action_input, run_metadata
      FROM runs WHERE id = ${runId} AND run_type = 'agent_turn'
    `;
    if (!run || isStaleAgentTurnReport(run, turnCredential)) return;
    const deployment = turnMarkerDeployment(run);
    // The reaper-backstop deadline, not the shorter execution one: a dead
    // worker's turn is the run reaper's call (re-run or WORKER_DIED), so the
    // marker must outlast it.
    if (deployment) await extendTurnDeadlines(deployment, reaperBackstopDeadlineMs());
  } catch {
    // Deliberately silent — see the doc comment.
  }
}

/** Terminal delivery uses the persisted routing and joins the caller's transaction. */
export async function insertAgentTurnResponse(sql: DbClient, run: NativeTurnRun, result: {
  finalText?: string; error?: string; errorCode?: string; errorContext?: AgentErrorContext;
  repliedInBand?: boolean; processedMessageIds?: string[]; toolsUsed?: string[];
  /** The owner answer's follow-up chips, already sanitized. */
  suggestions?: SuggestedPrompt[];
  /**
   * The input's first tool error, quoted exactly as the tool returned it.
   * Stored alongside the reply (not merged into it) so history keeps the
   * actionable message even when the model's prose paraphrases the failure.
   * Retained like the row itself: readable while the response outbox retains
   * it (currently the runs retention window, ~30d default, unverified
   * deployed value), never reconstructed after pruning.
   */
  firstToolError?: string;
}): Promise<boolean> {
  const envelope = run.action_input;
  const reply = envelope?.reply;
  if (!reply) return false;
  const conversationId = envelope?.turn?.conversation_id ?? '';
  await insertThreadResponseRow(sql, {
    messageId: reply.message_id, channelId: reply.channel_id, conversationId,
    userId: reply.user_id, teamId: reply.team_id ?? 'api', platform: reply.platform,
    organizationId: run.organization_id, platformMetadata: reply.platform_metadata,
    processedMessageIds: [reply.message_id], ...result, turnRunId: Number(run.id), timestamp: Date.now(),
  }, run.organization_id);
  // Retire the turn-liveness marker(s) in the SAME transaction as the reply.
  // Both callers set the run terminal before reaching here, so the turn is
  // over and nothing is left to refresh a token. Skipping this leaves a
  // pending marker for an answered turn: heartbeats have stopped, so its
  // deadline lapses and `sweepExpiredTurns` publishes a SECOND, contradictory
  // WORKER_UNRESPONSIVE to a user who already saw the reply.
  const deployment = turnMarkerDeployment(run);
  if (deployment) {
    const messageIds = result.processedMessageIds?.length
      ? result.processedMessageIds
      : [reply.message_id];
    await dischargeTurnMarkers(sql, deployment, messageIds, run.organization_id);
  }
  return true;
}
