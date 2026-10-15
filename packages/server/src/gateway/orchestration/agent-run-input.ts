import {
  generateWorkerToken,
  type MessagePayload,
  verifyWorkerToken,
  type WorkerTokenData,
} from "@lobu/core";
import { getDb, pgTextArray, type DbClient } from "../../db/client.js";

export type DurableRunTokenClaims = Omit<
  WorkerTokenData,
  "timestamp" | "jti"
>;

export interface PendingAgentRunInput {
  payload: MessagePayload;
  tokenClaims: DurableRunTokenClaims;
}

export interface PendingAgentRunInputRef {
  organizationId: string;
  deploymentName: string;
  messageId: string;
  runId: number;
}

function durableClaims(token: WorkerTokenData): DurableRunTokenClaims {
  return {
    userId: token.userId,
    conversationId: token.conversationId,
    channelId: token.channelId,
    teamId: token.teamId,
    agentId: token.agentId,
    organizationId: token.organizationId,
    connectionId: token.connectionId,
    responseThreadId: token.responseThreadId,
    deploymentName: token.deploymentName,
    platform: token.platform,
    source: token.source,
    sessionKey: token.sessionKey,
    traceId: token.traceId,
    runId: token.runId,
    messageId: token.messageId,
    adminTools: token.adminTools,
    actorUserId: token.actorUserId,
    chatAccess: token.chatAccess,
    chatSenderWorkspaces: token.chatSenderWorkspaces,
    runtimeProviderId: token.runtimeProviderId,
    sandboxId: token.sandboxId,
    allowedDomains: token.allowedDomains,
    deniedDomains: token.deniedDomains,
    // Persist the package claim alongside the egress claims: a replayed run
    // that keeps the domain grants but loses the packages provisions nothing,
    // leaving an authenticated CLI that was never installed.
    nixPackages: token.nixPackages,
    // Persist the capture pair too, or it is lost at the DATABASE boundary —
    // before `attachFreshRunJobToken` can preserve it — and a replayed eval
    // comes back live. `executionMode` is the whole safety property; without
    // it the replay performs for real everything it should only record.
    executionMode: token.executionMode,
    automationRunId: token.automationRunId,
  };
}

function assertTokenMatchesInput(
  token: WorkerTokenData,
  payload: MessagePayload,
  deploymentName: string,
): void {
  const matches =
    token.userId === payload.userId &&
    token.conversationId === payload.conversationId &&
    token.channelId === payload.channelId &&
    token.agentId === payload.agentId &&
    token.organizationId === payload.organizationId &&
    token.deploymentName === deploymentName &&
    token.runId === payload.runId &&
    token.messageId === payload.messageId;
  if (!matches) {
    throw new Error("Durable agent input token scope does not match payload");
  }
}

export function attachFreshRunJobToken(
  input: PendingAgentRunInput,
): MessagePayload {
  const token = input.tokenClaims;
  if (
    !token.channelId ||
    !token.runId ||
    !token.messageId ||
    token.runId !== input.payload.runId ||
    token.messageId !== input.payload.messageId
  ) {
    throw new Error("Durable agent input has invalid run token claims");
  }
  return {
    ...input.payload,
    runJobToken: generateWorkerToken(
      token.userId,
      token.conversationId,
      token.deploymentName,
      {
        channelId: token.channelId,
        teamId: token.teamId,
        agentId: token.agentId,
        organizationId: token.organizationId,
        connectionId: token.connectionId,
        responseThreadId: token.responseThreadId,
        platform: token.platform,
        source: token.source,
        sessionKey: token.sessionKey,
        traceId: token.traceId,
        runId: token.runId,
        messageId: token.messageId,
        adminTools: token.adminTools,
        actorUserId: token.actorUserId,
        chatAccess: token.chatAccess,
        chatSenderWorkspaces: token.chatSenderWorkspaces,
        runtimeProviderId: token.runtimeProviderId,
        sandboxId: token.sandboxId,
        allowedDomains: token.allowedDomains,
        deniedDomains: token.deniedDomains,
        nixPackages: token.nixPackages,
        // Same reason as the refresh mint in worker-dispatch/worker-gateway.ts: dropping the
        // capture pair here would hand a re-dispatched eval replay a live
        // token, and the replay would perform for real everything it was
        // supposed to only record.
        executionMode: token.executionMode,
        automationRunId: token.automationRunId,
      },
    ),
  };
}

export async function recordAgentRunInput(
  payload: MessagePayload,
  deploymentName: string,
): Promise<void> {
  if (!payload.organizationId || typeof payload.runId !== "number") {
    throw new Error("Durable agent input requires organizationId and runId");
  }
  if (!payload.runJobToken) {
    throw new Error("Durable agent input requires a per-run token");
  }
  const token = verifyWorkerToken(payload.runJobToken);
  if (!token) {
    throw new Error("Durable agent input requires a valid per-run token");
  }
  assertTokenMatchesInput(token, payload, deploymentName);
  const storedPayload = { ...payload };
  delete storedPayload.runJobToken;
  const tokenClaims = durableClaims(token);
  const sql = getDb();
  await sql`
    INSERT INTO public.agent_run_input (
      organization_id, message_id, agent_id, conversation_id,
      deployment_name, run_id, payload, token_claims
    ) VALUES (
      ${payload.organizationId}, ${payload.messageId}, ${payload.agentId},
      ${payload.conversationId}, ${deploymentName}, ${payload.runId},
      ${sql.json(storedPayload as unknown as Record<string, unknown>)},
      ${sql.json(tokenClaims as unknown as Record<string, unknown>)}
    )
    ON CONFLICT (organization_id, deployment_name, message_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      token_claims = EXCLUDED.token_claims,
      run_id = EXCLUDED.run_id
    WHERE agent_run_input.status = 'pending'
  `;
}

export async function listPendingAgentRunInputs(
  deploymentName: string,
): Promise<PendingAgentRunInput[]> {
  const sql = getDb();
  // The replay exists to restore turns whose QUEUE ROW is gone (expired-pending
  // cleanup deletes jobs a disconnected worker never claimed). A surviving row
  // means the queue still owns the turn: pending/claimed is the original job
  // awaiting delivery or a dispatch-gate deferral retry, completed is a
  // delivered turn the (reconnecting) worker is already running. Re-sending
  // over such a row delivers the same turn twice — the recycle path holds its
  // claimed job across the rebuild, so without this predicate every recycle
  // would double-deliver the very turn that triggered it. A FAILED row is the
  // one exception: delivery marks a row completed (ack-on-delivery), so failed
  // = retry budget exhausted with the turn NEVER delivered — the queue has
  // given the turn up, and suppressing its replay would strand it (still
  // marker-live, never delivered, never terminalized) until the sweep.
  const rows = await sql<{
    payload: MessagePayload;
    token_claims: DurableRunTokenClaims;
  }>`
    SELECT input.payload, input.token_claims
    FROM public.agent_run_input input
    WHERE input.deployment_name = ${deploymentName}
      AND input.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM public.runs marker
        WHERE marker.status = 'pending'
          AND marker.run_type = 'internal'
          AND marker.queue_name = 'internal:turn_timeout'
          AND marker.action_input->>'deploymentName' = input.deployment_name
          AND marker.action_input->>'messageId' = input.message_id
          AND marker.run_at > now()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.runs q
        WHERE q.run_type = 'chat_message'
          AND q.queue_name = 'thread_message_' || input.deployment_name
          AND q.action_input->>'messageId' = input.message_id
          AND q.status != 'failed'
      )
    ORDER BY input.created_at, input.message_id
  `;
  return rows.map((row) => ({
    payload: row.payload,
    tokenClaims: row.token_claims,
  }));
}

/**
 * Resolve one replay input by its durable primary-key scope. Worker queue rows
 * deliberately omit the bearer token; the owner pod re-mints it only after
 * claiming the row, immediately before SSE delivery.
 */
export async function getPendingAgentRunInput(
  ref: PendingAgentRunInputRef,
): Promise<PendingAgentRunInput | null> {
  const sql = getDb();
  const rows = await sql<{
    payload: MessagePayload;
    token_claims: DurableRunTokenClaims;
  }>`
    SELECT payload, token_claims
    FROM public.agent_run_input
    WHERE organization_id = ${ref.organizationId}
      AND deployment_name = ${ref.deploymentName}
      AND message_id = ${ref.messageId}
      AND run_id = ${ref.runId}
      AND status = 'pending'
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? { payload: row.payload, tokenClaims: row.token_claims }
    : null;
}

export async function completeAgentRunInputs(
  tx: DbClient,
  organizationId: string | null,
  deploymentName: string,
  messageIds: readonly string[],
): Promise<void> {
  if (!organizationId || messageIds.length === 0) return;
  await tx`
    UPDATE public.agent_run_input
    SET status = 'completed', completed_at = now()
    WHERE organization_id = ${organizationId}
      AND deployment_name = ${deploymentName}
      AND message_id = ANY(${pgTextArray([...messageIds])}::text[])
      AND status = 'pending'
  `;
}
