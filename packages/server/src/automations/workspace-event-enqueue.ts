/**
 * Subscription lookup and activation queueing for workspace events.
 *
 * Split out of `workspace-event.ts` — which owns the activation RUNTIME — so
 * the audit write path can queue an activation without importing it. That
 * runtime reaches `runs/queue-service`, which imports `utils/insert-event` for
 * `stableJson`, so a writer importing the runtime directly would close an
 * import cycle. Same reason `workspace-event-contract.ts` is kept
 * dependency-light: the queueing end of a seam must not drag in the consuming
 * end.
 */

import type { DbClient } from '../db/client';
import { getDb, pgTextArray } from '../db/client';
import { WORKSPACE_EVENT_ACTIVATION_TASK } from '../scheduled/task-definitions';
import { enqueueTasksInTransaction } from '../scheduled/task-scheduler';
import {
  automationTriggerSignals,
  deriveWorkspaceEventCausality,
  isWorkspaceEventTriggerSignal,
  type WorkspaceEventActivationTaskPayload,
} from './workspace-event-contract';

/**
 * Which of `eventTypes` at least one active Automation subscribes to.
 *
 * Callers pass the single name a subscription would use for the event — the
 * stamped `<subject>.<op>` type for a platform audit row, the semantic type
 * otherwise. Passing the raw semantic type of an audit row matches nothing,
 * which is deliberate: every audit row shares `change`.
 */
export async function findSubscribedWorkspaceEventTypes(
  organizationId: string,
  eventTypes: readonly string[],
  db: DbClient = getDb()
): Promise<Set<string>> {
  const candidates = [...new Set(eventTypes)];
  if (candidates.length === 0) return new Set();
  const rows = await db<{ event_type: string }>`
    SELECT DISTINCT event_type.value AS event_type
    FROM automations w
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(w.triggers, '[]'::jsonb)
    ) AS trigger(value)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(trigger.value->'event_types') = 'array'
          THEN trigger.value->'event_types'
        ELSE '[]'::jsonb
      END
    ) AS event_type(value)
    WHERE w.organization_id = ${organizationId}
      AND w.status = 'active'
      AND w.current_version_id IS NOT NULL
      AND w.execution_config->'executor'->>'kind' IS DISTINCT FROM 'external'
      AND (w.managed_agent_id IS NOT NULL OR w.device_worker_id IS NOT NULL)
      AND trigger.value->>'kind' = 'event'
      AND trigger.value->>'source' = 'workspace'
      AND event_type.value = ANY(${pgTextArray(candidates)}::text[])
  `;
  return new Set(rows.map((row) => String(row.event_type)));
}

export async function enqueueWorkspaceEventActivations(
  tx: DbClient,
  payloads: WorkspaceEventActivationTaskPayload[]
): Promise<void> {
  await enqueueTasksInTransaction(
    tx,
    payloads.map((payload) => ({
      name: WORKSPACE_EVENT_ACTIVATION_TASK,
      payload,
      opts: {
        idempotencyKey: `workspace-event-activation:${payload.eventId}`,
        maxAttempts: 5,
        organizationId: payload.organizationId,
      },
    }))
  );
}

/**
 * The causal ancestry an audit row should inherit from the run that produced it.
 *
 * Without this an audit-mediated chain never accrues depth: every audit row
 * would start a fresh root at depth 1, so `MAX_WORKSPACE_EVENT_DEPTH` could
 * never bite and a mutual A -> B -> A cascade would be bounded only by fan-out
 * and run cooldown. Inheriting the driving run's signals makes each hop a real
 * step in the same chain, which is what the depth and breadth caps measure.
 *
 * Returns null when there is no run to inherit from, or a run that was never
 * activated by a workspace event (a scheduled
 * or connector-triggered run carries signals, but none of them workspace ones).
 * The caller then falls back to a root, which is correct: nothing upstream to
 * accrue.
 *
 * The lookup is scoped to the producing Automation and organization so a
 * caller-declared run cannot import another Automation's causal path.
 */
export async function loadRunEventCausality(
  organizationId: string,
  runId: number,
  producerAutomationId: number,
  db: DbClient = getDb()
): Promise<{
  rootEventIds: number[];
  causalAutomationIds: number[];
  depth: number;
} | null> {
  const rows = await db<{ approved_input: unknown }>`
    SELECT approved_input
    FROM public.runs
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND automation_id = ${producerAutomationId}
    LIMIT 1
  `;
  const approvedInput = rows[0]?.approved_input;
  if (!approvedInput || typeof approvedInput !== 'object') return null;
  // Only workspace signals carry ancestry. A connector- or schedule-woken run
  // has signals too, and passing those through would derive an EMPTY root set
  // — which `activateWorkspaceEventTask` rejects, dropping a legitimate
  // activation. Such a run starts a chain, exactly like no run at all.
  const signals = automationTriggerSignals(
    approvedInput as { trigger_signal?: unknown; trigger_signals?: unknown }
  ).filter(isWorkspaceEventTriggerSignal);
  if (signals.length === 0) return null;
  // Throws past the breadth / root caps. That is the cascade limit doing its
  // job, so let it propagate: the caller treats a failed derivation as "do not
  // queue", which terminates the chain rather than restarting it as a root.
  return deriveWorkspaceEventCausality(signals, producerAutomationId);
}
