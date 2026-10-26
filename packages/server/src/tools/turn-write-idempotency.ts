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

/**
 * The steered input a turn's call names (`TURN_INPUT_RUN_HEADER`), attached
 * for verification by the write that keys on it. A malformed value is kept as
 * an id no stored input can have, so the write fails closed instead of
 * silently keying on the owner.
 */
export function withTurnInputRun(
  agentTurn: AgentTurnIdentity | null,
  header: string | null | undefined
): AgentTurnIdentity | null {
  if (!agentTurn || header == null) return agentTurn;
  const parsed = Number(header);
  const canonical = Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === header;
  return { ...agentTurn, inputRunId: canonical ? parsed : 0 };
}

/**
 * A replayable result; an explicit refusal before the effect took place
 * (frees the claim); or a failure after it may have taken place (keeps the
 * claim with no result, so a repeat answers "attempted").
 */
type TurnWriteEffect<R> = { store: R } | { release: true } | { retain: true };

/** Outcome of `runTurnWriteOnce`: the effect ran now, an earlier one is replayed, or one was claimed and never finished. */
type TurnWriteOutcome<R> =
  | { kind: 'ran' }
  | { kind: 'replay'; result: R }
  | { kind: 'attempted' };

/**
 * Run a turn's write at most once per input message while its receipt is
 * retained, for writes whose own
 * storage has no idempotency key (a chat post, an upload, an entity row). The
 * key is `withTurnIdempotencyKey`'s; the receipt lives in
 * `turn_write_receipts`.
 *
 * Claim before the effect: the claim row commits first, so two concurrent
 * repeats cannot both run it. A completed effect stores its result and later
 * repeats replay it. An explicit refusal (a `release` result or a thrown
 * `ToolUserError`) releases the claim so the same input can try again. Any
 * other thrown error retains it: the effect may have succeeded before its
 * response was lost. A claim with no result means an earlier
 * attempt stopped mid-way (a crash after the platform call, say): it may have
 * been delivered, so the
 * answer is "attempted", never a second delivery. A non-turn caller runs the
 * effect directly, as before.
 */
export async function runTurnWriteOnce<R>(
  turn: AgentTurnIdentity | null | undefined,
  surface: string,
  args: unknown,
  effect: () => Promise<TurnWriteEffect<R>>
): Promise<TurnWriteOutcome<R>> {
  const key = await turnWriteIdempotencyKey(turn, surface, args);
  if (!key || !turn) {
    await effect();
    return { kind: 'ran' };
  }
  const sql = getDb();
  const claimed = await sql`
    INSERT INTO turn_write_receipts (organization_id, idempotency_key, surface, state)
    VALUES (${turn.organizationId}, ${key}, ${surface}, 'claimed')
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING 1
  `;
  if (claimed.length === 0) {
    const [prior] = await sql<{ state: string; result: R | null }>`
      SELECT state, result FROM turn_write_receipts
      WHERE organization_id = ${turn.organizationId} AND idempotency_key = ${key}
    `;
    if (prior?.state === 'done') return { kind: 'replay', result: prior.result as R };
    return { kind: 'attempted' };
  }
  const release = () => sql`
    DELETE FROM turn_write_receipts
    WHERE organization_id = ${turn.organizationId} AND idempotency_key = ${key} AND state = 'claimed'
  `;
  let outcome: TurnWriteEffect<R>;
  try {
    outcome = await effect();
  } catch (error) {
    // A ToolUserError is the typed refusal a handler raises before it writes
    // (validation, policy, ownership), so nothing was delivered. Anything
    // else may have struck after the effect landed, so its claim stays.
    if (error instanceof ToolUserError) await release();
    throw error;
  }
  if ('release' in outcome) {
    await release();
    return { kind: 'ran' };
  }
  if ('retain' in outcome) return { kind: 'ran' };
  await sql`
    UPDATE turn_write_receipts
    SET state = 'done', result = ${sql.json(JSON.parse(JSON.stringify(outcome.store ?? null)))}
    WHERE organization_id = ${turn.organizationId} AND idempotency_key = ${key}
  `;
  return { kind: 'ran' };
}

/** Delete receipts past the runs retention window. Called from the runs sweep. */
export async function pruneTurnWriteReceipts(retentionDays: number): Promise<number> {
  const deleted = await getDb()`
    WITH d AS (
      DELETE FROM turn_write_receipts
      WHERE created_at < now() - (${retentionDays}::int * interval '1 day')
      RETURNING 1
    )
    SELECT count(*)::int AS count FROM d
  `;
  return Number((deleted[0] as { count?: number } | undefined)?.count ?? 0);
}
