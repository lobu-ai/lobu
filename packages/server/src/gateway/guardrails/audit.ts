/**
 * Audit trail for guardrail trips. Every short-circuited stage writes one
 * `semantic_type='guardrail-trip'` row to `events` so operators can review
 * what was blocked, when, and why. `recordGuardrailTrip` never rejects —
 * failures (insert error or missing org id) are logged at warn/error so the
 * gap still shows up in the security log even when the row didn't make it.
 */

import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import { getErrorMessage, type GuardrailStage } from "@lobu/core";

/**
 * Tracks in-flight `recordGuardrailTrip` calls. Production fires-and-forgets
 * the returned promise; tests await `flushPendingGuardrailAudits()` to drain.
 */
const pendingAudits = new Set<Promise<void>>();

/**
 * Await all currently in-flight guardrail-audit inserts. Test-only — trips
 * that fire after the snapshot is taken are not included (call again).
 */
export async function flushPendingGuardrailAudits(): Promise<void> {
  const snapshot = Array.from(pendingAudits);
  if (snapshot.length === 0) return;
  await Promise.allSettled(snapshot);
}

interface RecordGuardrailTripParams {
  organizationId: string | undefined;
  /** The agent whose call tripped; null when a connected app's call did. */
  agentId: string | null;
  /** The verified app key (`ToolContext.appPrincipalId`) whose call tripped. */
  appId?: string | null;
  userId?: string;
  conversationId?: string;
  stage: GuardrailStage;
  guardrail: string;
  /**
   * Internal reason — written to the event row but never surfaced to the
   * blocked party for the pre-tool stage.
   */
  reason?: string;
  metadata?: unknown;
}

/**
 * Insert a `guardrail-trip` row. Returns a promise that resolves whether
 * the insert succeeds, throws, or is skipped (missing org id). Never
 * rejects — guardrail enforcement is the source of truth for the block,
 * the audit is best-effort but tests/operators can still observe failures
 * through the structured log emitted on the failure paths.
 */
export function recordGuardrailTrip(
  params: RecordGuardrailTripParams
): Promise<void> {
  const work = doRecordGuardrailTrip(params);
  pendingAudits.add(work);
  work.finally(() => pendingAudits.delete(work));
  return work;
}

async function doRecordGuardrailTrip(
  params: RecordGuardrailTripParams
): Promise<void> {
  // Without an organization id we can't write to `events` (org-scoped
  // schema). Log loudly — a trip that doesn't audit is a security log gap
  // and downstream callers must surface this on their own resolver paths.
  if (!params.organizationId) {
    logger.error(
      {
        agentId: params.agentId,
        appId: params.appId ?? null,
        guardrail: params.guardrail,
        stage: params.stage,
        reason: params.reason,
      },
      "[guardrail] trip not audited — no organizationId resolved (security log gap)"
    );
    return;
  }

  const originId = `guardrail_trip_${params.stage}_${params.guardrail}_${params.agentId ?? params.appId}_${Date.now()}`;

  try {
    await insertEvent({
      entityIds: [],
      organizationId: params.organizationId,
      originId,
      title: `Guardrail "${params.guardrail}" tripped at ${params.stage}`,
      semanticType: "guardrail-trip",
      originType: `guardrail-${params.stage}`,
      metadata: {
        guardrail: params.guardrail,
        stage: params.stage,
        reason: params.reason ?? null,
        agent_id: params.agentId,
        ...(params.appId ? { app_id: params.appId } : {}),
        user_id: params.userId ?? null,
        conversation_id: params.conversationId ?? null,
        ...(params.metadata !== undefined
          ? { guardrail_metadata: params.metadata }
          : {}),
      },
    });
  } catch (err) {
    logger.warn(
      {
        err: getErrorMessage(err),
        guardrail: params.guardrail,
        stage: params.stage,
      },
      "[guardrail] failed to record trip event"
    );
  }
}
