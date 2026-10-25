import { createHash } from 'node:crypto';
import type { WorkerTokenData } from '@lobu/core';
import { getDb } from '../db/client';
import { ToolUserError } from '../utils/errors';
import { stableJson } from '../utils/insert-event';

/**
 * The agent turn a tool call came from, as its VERIFIED worker credential
 * signs it. Carried per request (never on a reusable MCP session: one upstream
 * session serves many turns) so a write can derive its turn-scoped
 * idempotency key. Null for every non-turn caller.
 */
export interface AgentTurnIdentity {
  organizationId: string;
  agentId: string;
  conversationId: string;
  runId: number;
  messageId: string;
}

/**
 * Read the turn identity off verified worker-token claims. Only a turn
 * credential qualifies: `mintTurnToken` scopes it to `agent-turn:<messageId>`
 * and signs the turn's run id, the same binding `executionPolicy`
 * (runs/agent-turn-inputs.ts) checks before it trusts a stored credential.
 */
export function agentTurnIdentityFromClaims(
  claims: Pick<WorkerTokenData, 'organizationId' | 'agentId' | 'conversationId' | 'runId' | 'messageId' | 'deploymentName'>
): AgentTurnIdentity | null {
  const { organizationId, agentId, conversationId, runId, messageId, deploymentName } = claims;
  if (!organizationId || !agentId || !conversationId || !messageId || typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) {
    return null;
  }
  if (deploymentName !== `agent-turn:${messageId}`) return null;
  return { organizationId, agentId, conversationId, runId, messageId };
}

/**
 * The idempotency key for a write a turn makes: organization, agent, conversation and
 * initiating input message are read off the STORED `agent_turn` row the
 * credential names — never off the request — then the write surface and the
 * canonical JSON of its arguments. A re-run of the same input mints a new run
 * and new tool call ids, so neither is part of the key; the stored input
 * message is what both runs share.
 *
 * Hashed like `turnToolEventKey` (worker-api/agent-turn.ts): a structured JSON
 * tuple, so delimiters inside identifiers cannot collide, and a bounded length
 * for every index it lands in. Returns null for a non-turn caller. A turn
 * whose stored run does not match its credential must fail closed: proceeding
 * without the key could repeat an external effect.
 */
async function turnWriteIdempotencyKey(
  turn: AgentTurnIdentity | null | undefined,
  surface: string,
  args: unknown
): Promise<string | null> {
  if (!turn) return null;
  const [run] = await getDb()<{ agent_id: string | null; conversation_id: string | null; message_id: string | null }>`
    SELECT action_input->'turn'->>'agent_id' AS agent_id,
      action_input->'turn'->>'conversation_id' AS conversation_id,
      action_input->'turn'->>'message_id' AS message_id
    FROM runs
    WHERE id = ${turn.runId} AND run_type = 'agent_turn' AND organization_id = ${turn.organizationId}
  `;
  if (!run || run.agent_id !== turn.agentId || run.conversation_id !== turn.conversationId || run.message_id !== turn.messageId) {
    throw new ToolUserError(
      'Cannot derive a write idempotency key: the stored agent turn does not match this credential.',
      409
    );
  }
  // JSON round-trip first: an `undefined`-valued key is absent from the
  // stored request, so it must be absent from the key too.
  const canonicalArgs = stableJson(JSON.parse(JSON.stringify(args ?? null)));
  const tuple = JSON.stringify([turn.organizationId, run.agent_id, run.conversation_id, run.message_id, surface, canonicalArgs]);
  return `turn-write:v1:${createHash('sha256').update(tuple).digest('hex')}`;
}

/**
 * `args` with the turn-derived `idempotency_key` filled in when the caller
 * gave none, keyed on those same (validated) arguments. A caller-supplied key
 * always wins; a non-turn caller's args are returned untouched.
 */
export async function withTurnIdempotencyKey<T extends { idempotency_key?: string }>(
  turn: AgentTurnIdentity | null | undefined,
  surface: string,
  args: T
): Promise<T> {
  if (args.idempotency_key != null) return args;
  const key = await turnWriteIdempotencyKey(turn, surface, args);
  return key ? { ...args, idempotency_key: key } : args;
}
