import { isDeepStrictEqual } from 'node:util';
import { isExplicitCancelMessage, isSteerableHumanMessage, verifyWorkerToken, type MessagePayload } from '@lobu/core';
import { AGENT_TURN_INPUT_MAX, type AgentTurnPollPayload, type HeartbeatResponse } from '@lobu/core/contracts/worker/protocol';
import { CURRENT_SESSION_VERSION } from '@mariozechner/pi-coding-agent';
import { getDb, type DbClient } from '../db/client';
import type { TurnReply } from '../gateway/orchestration/agent-turn-producer';
import { dischargeTurnMarkers, extendTurnDeadlines, insertThreadResponseRow } from '../gateway/orchestration/turn-liveness';
import { generateDeploymentName } from '../gateway/orchestration/deployment-identity';

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
  } | null;
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
  await sql`UPDATE runs SET run_at = now() WHERE id = (
    SELECT id FROM runs WHERE run_type = 'agent_turn' AND status = 'pending'
      AND organization_id = ${run.organization_id}
      AND action_input->'turn'->>'agent_id' = ${run.action_input?.turn?.agent_id ?? null}
      AND action_input->'turn'->>'conversation_id' = ${run.action_input?.turn?.conversation_id ?? null}
    ORDER BY id LIMIT 1
  )`;
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
    || claims.deploymentName !== `agent-turn:${input.turn.message_id}`) return undefined;
  const { runId, messageId, deploymentName, timestamp, jti, traceId, ...scope } = claims;
  const { message_id, message_text, message_images, message_files, session_jsonl, ...turn } = input.turn;
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
    const next = { run_id: Number(row.id), message_id: turn.message_id, text: turn.message_text };
    if (Buffer.byteLength(JSON.stringify([...offered, next]), 'utf8') > 64 * 1024) break;
    offered.push(next);
  }
  return offered;
}

/**
 * Derive the turn-liveness marker's deployment name from a native turn's
 * envelope. Single source for the two sites that need it — the terminal
 * discharge and the heartbeat extension — so neither can drift from the
 * arming site in `MessageConsumer`.
 */
function turnMarkerDeployment(run: NativeTurnRun): string | null {
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
 * a turn running longer than `TURN_DEFAULT_DEADLINE_MS` collects a spurious
 * terminal error while it is still working. Never throws: a heartbeat ACK must
 * not fail on a liveness bookkeeping error.
 */
export async function extendHeartbeatedTurnMarker(
  runId: number,
): Promise<void> {
  try {
    // Its OWN connection, never the caller's transaction handle: the caller
    // fires this without awaiting, and a query issued on a tx that has since
    // committed is a use-after-close that fails the heartbeat response.
    //
    // A plain read, deliberately not `lockAgentTurnRun`: this runs on every
    // heartbeat and only needs the envelope's identity, so taking the
    // conversation lock here would serialize heartbeats behind turn admission.
    const sql = getDb();
    const [run] = await sql<NativeTurnRun>`
      SELECT id, organization_id, action_input
      FROM runs WHERE id = ${runId} AND run_type = 'agent_turn'
    `;
    const deployment = run && turnMarkerDeployment(run);
    if (deployment) await extendTurnDeadlines(deployment);
  } catch {
    // Deliberately silent — see the doc comment.
  }
}

/** Terminal delivery uses the persisted routing and joins the caller's transaction. */
export async function insertAgentTurnResponse(sql: DbClient, run: NativeTurnRun, result: {
  finalText?: string; error?: string; errorCode?: string; repliedInBand?: boolean; processedMessageIds?: string[];
}): Promise<boolean> {
  const envelope = run.action_input;
  const reply = envelope?.reply;
  if (!reply) return false;
  const conversationId = envelope?.turn?.conversation_id ?? '';
  await insertThreadResponseRow(sql, {
    messageId: reply.message_id, channelId: reply.channel_id, conversationId,
    userId: reply.user_id, teamId: reply.team_id ?? 'api', platform: reply.platform,
    organizationId: run.organization_id, platformMetadata: reply.platform_metadata,
    processedMessageIds: [reply.message_id], ...result, timestamp: Date.now(),
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
