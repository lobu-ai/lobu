import { createHash } from 'node:crypto';
import type { WorkerTokenData } from '@lobu/core';
import { getDb } from '../db/client';
import { pendingAgentTurnInputs, type NativeTurnRun } from '../runs/agent-turn-inputs';
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
  /**
   * The steered input run this call answers, as the isolate named it
   * (`TURN_INPUT_RUN_HEADER`). Unverified until a write resolves it against
   * the turn's stored inputs; absent means the owner input.
   */
  inputRunId?: number;
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
 * The idempotency key for a write a turn makes: organization, agent,
 * conversation and initiating input message are read off STORED rows — the
 * `agent_turn` run the credential names, and, for a call answering a steered
 * follow-up, that follow-up's own stored input — never off the request; then
 * the write surface and the canonical JSON of its arguments. A re-run of the
 * same input mints a new run and new tool call ids, so neither is part of the
 * key; the stored input message is what both runs share.
 *
 * Hashed like `turnToolEventKey` (worker-api/agent-turn.ts): a structured JSON
 * tuple, so delimiters inside identifiers cannot collide, and a bounded length
 * for every index it lands in. Returns null for a non-turn caller. A turn
 * whose stored run does not match its credential, or that names an input the
 * turn does not own, fails closed: proceeding without the right key could
 * repeat an external effect or swallow a requested one.
 */
async function turnWriteIdempotencyKey(
  turn: AgentTurnIdentity | null | undefined,
  surface: string,
  args: unknown
): Promise<string | null> {
  if (!turn) return null;
  const sql = getDb();
  const [owner] = await sql<NativeTurnRun>`
    SELECT id, organization_id, parent_run_id, status, claimed_by, action_input, run_metadata
    FROM runs
    WHERE id = ${turn.runId} AND run_type = 'agent_turn' AND organization_id = ${turn.organizationId}
  `;
  const stored = owner?.action_input?.turn;
  if (!owner || stored?.agent_id !== turn.agentId || stored?.conversation_id !== turn.conversationId || stored?.message_id !== turn.messageId) {
    throw new ToolUserError(
      'Cannot derive a write idempotency key: the stored agent turn does not match this credential.',
      409
    );
  }
  const messageId = await initiatingInputMessage(owner, turn);
  // JSON round-trip first: an `undefined`-valued key is absent from the
  // stored request, so it must be absent from the key too.
  const canonicalArgs = stableJson(JSON.parse(JSON.stringify(args ?? null)));
  const tuple = JSON.stringify([turn.organizationId, turn.agentId, turn.conversationId, messageId, surface, canonicalArgs]);
  return `turn-write:v1:${createHash('sha256').update(tuple).digest('hex')}`;
}

/**
 * The input message a call answers. The owner's own unless the isolate named a
 * steered input, which must be one this turn owns: offered to it now
 * (`pendingAgentTurnInputs`, the same derivation the heartbeat steer offer and
 * tool-trace routing use) or already consumed by it at completion.
 */
async function initiatingInputMessage(owner: NativeTurnRun, turn: AgentTurnIdentity): Promise<string> {
  if (turn.inputRunId === undefined || turn.inputRunId === turn.runId) return turn.messageId;
  // A plain read, deliberately not `lockAgentTurnRun`: this runs on a tool
  // call, and the offer is a pure function of the stored rows.
  const offered = (await pendingAgentTurnInputs(getDb(), owner)).find((input) => input.run_id === turn.inputRunId);
  if (offered) return offered.message_id;
  const [consumed] = await getDb()<{ message_id: string | null }>`
    SELECT action_input->'turn'->>'message_id' AS message_id
    FROM runs
    WHERE id = ${turn.inputRunId} AND run_type = 'agent_turn' AND organization_id = ${turn.organizationId}
      AND action_input->'turn'->>'agent_id' = ${turn.agentId}
      AND action_input->'turn'->>'conversation_id' = ${turn.conversationId}
      AND (run_metadata->>'consumed_by_run_id')::bigint = ${turn.runId}
  `;
  if (consumed?.message_id) return consumed.message_id;
  throw new ToolUserError(
    'Cannot derive a write idempotency key: this turn does not own the input the call names.',
    409
  );
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
