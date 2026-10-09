import type { AutomationWorkspaceEventTrigger } from '@lobu/core/contracts/tools/manage-automations';
import type { DbClient } from '../db/client';
import { getDb, parsePgNumberArray, pgBigintArray } from '../db/client';
import { createAutomationEventRun } from '../runs/queue-service';
import { resolveAutomationExecutor } from '../tools/admin/manage_automations/executors';
import { readAuditEventType } from '../utils/audit-event-type';
import logger from '../utils/logger';
import { dispatchAutomationRunsBestEffort } from './activation';
import {
  MAX_WORKSPACE_EVENT_DEPTH,
  MAX_WORKSPACE_EVENT_FANOUT,
  MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS,
  MAX_COALESCED_AUTOMATION_EVENT_INPUTS,
  isBoundedPositiveIntegerList,
  type WorkspaceEventActivationTaskPayload,
  type WorkspaceEventTriggerSignal,
} from './workspace-event-contract';

interface WorkspaceEventRecord {
  id: number;
  semanticType: string;
  /**
   * The stamped `<subject>.<op>` type for a platform-written audit row, or
   * null for an Automation output. Kept separate from `semanticType` so the
   * matcher can name an audit row by its stamp only: every audit row shares
   * the `change` semantic type, and naming by that would wake a subscriber on
   * essentially every write in the organization.
   */
  auditEventType: string | null;
  metadata: Record<string, unknown>;
  entityIds: number[];
  entityTypeSlugs: string[];
  occurredAt: string;
  /**
   * The Automation that produced this event, or null for a root — an event the
   * platform itself wrote (a device coming online, a connection deleted) with
   * no Automation upstream of it.
   */
  producerAutomationId: number | null;
}

interface MatchingWorkspaceEventActivation {
  automationId: number;
  organizationId: string;
  agentId: string | null;
  deviceWorkerId: string | null;
  agentKind: string | null;
  trigger: AutomationWorkspaceEventTrigger;
}

interface WorkspaceEventActivationResult {
  matched: number;
  queued: number;
  depthLimited: boolean;
  causalBreadthLimited: boolean;
  fanoutLimited: boolean;
  invalidCausalPath: boolean;
}

const EMPTY_WORKSPACE_EVENT_ACTIVATION_RESULT = {
  matched: 0,
  queued: 0,
  depthLimited: false,
  causalBreadthLimited: false,
  fanoutLimited: false,
  invalidCausalPath: false,
} as const satisfies WorkspaceEventActivationResult;

/**
 * The single name a subscription uses for this event.
 *
 * A platform audit row is named by its stamped `<subject>.<op>` type; anything
 * else by its semantic type. Audit rows are deliberately NOT also matchable by
 * their raw `change` semantic type: every audit row shares it, so a `change`
 * subscription would wake an Automation on essentially every write in the
 * organization, and the depth and fan-out limits bound the resulting cascade,
 * not that ingress. `change` is a storage classification, not something that
 * happened, so the platform catalog never offers it.
 */
function subscribableEventType(
  event: Pick<WorkspaceEventRecord, 'semanticType' | 'auditEventType'>
): string {
  return event.auditEventType ?? event.semanticType;
}

export function matchesWorkspaceEventTrigger(
  trigger: AutomationWorkspaceEventTrigger,
  event: Pick<
    WorkspaceEventRecord,
    'semanticType' | 'auditEventType' | 'metadata' | 'entityTypeSlugs'
  >
): boolean {
  if (!trigger.event_types.includes(subscribableEventType(event))) return false;
  if (
    trigger.entity_type !== undefined &&
    !event.entityTypeSlugs.includes(trigger.entity_type)
  ) {
    return false;
  }
  return Object.entries(trigger.match ?? {}).every(
    ([key, expected]) => event.metadata[key] === expected
  );
}

async function loadWorkspaceEvent(
  organizationId: string,
  eventId: number,
  db: DbClient
): Promise<WorkspaceEventRecord | null> {
  const rows = await db<{
    id: number;
    semantic_type: string;
    metadata: Record<string, unknown> | null;
    entity_ids: unknown;
    occurred_at: string;
    automation_id: number | null;
  }>`
    SELECT id, semantic_type, metadata, entity_ids,
           COALESCE(occurred_at, created_at)::text AS occurred_at,
           automation_id
    FROM public.current_event_records
    WHERE id = ${eventId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    const lineage = await db<{ superseded_by: number | null }>`
      SELECT superseded_by
      FROM public.events
      WHERE id = ${eventId}
        AND organization_id = ${organizationId}
      LIMIT 1
    `;
    if (lineage[0]?.superseded_by != null) return null;
    throw new Error(`Workspace event ${eventId} was not found`);
  }
  const entityIds = parsePgNumberArray(row.entity_ids);
  const entityTypes =
    entityIds.length > 0
      ? await db<{ slug: string }>`
        SELECT DISTINCT et.slug
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${organizationId}
          AND e.id = ANY(${pgBigintArray(entityIds)}::bigint[])
          AND e.deleted_at IS NULL
          AND et.deleted_at IS NULL
        ORDER BY et.slug
      `
      : [];
  const metadata =
    row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: Number(row.id),
    semanticType: String(row.semantic_type),
    auditEventType: readAuditEventType(metadata),
    metadata,
    entityIds,
    entityTypeSlugs: entityTypes.map((item) => String(item.slug)),
    occurredAt: new Date(row.occurred_at).toISOString(),
    producerAutomationId:
      row.automation_id == null ? null : Number(row.automation_id),
  };
}

async function findMatchingWorkspaceEventActivations(
  organizationId: string,
  signal: WorkspaceEventTriggerSignal,
  event: WorkspaceEventRecord,
  db: DbClient = getDb()
): Promise<{
  matches: MatchingWorkspaceEventActivation[];
  fanoutLimited: boolean;
}> {
  // Coarse GIN needle on the event's one subscribable name, narrowed precisely
  // by `matchesWorkspaceEventTrigger` below.
  const needle = [
    {
      kind: 'event',
      source: 'workspace',
      event_types: [subscribableEventType(event)],
    },
  ];
  const rows = await db`
    SELECT w.id, w.organization_id, w.managed_agent_id, w.entity_ids,
           w.device_worker_id::text AS device_worker_id,
           w.agent_kind, w.triggers
    FROM automations w
    WHERE w.organization_id = ${organizationId}
      AND w.status = 'active'
      AND w.current_version_id IS NOT NULL
      AND w.execution_config->'executor'->>'kind' IS DISTINCT FROM 'external'
      AND (w.managed_agent_id IS NOT NULL OR w.device_worker_id IS NOT NULL)
      AND w.triggers @> ${db.json(needle)}::jsonb
    ORDER BY w.id ASC
  `;

  const matches: MatchingWorkspaceEventActivation[] = [];
  let fanoutLimited = false;
  for (const row of rows) {
    const automationId = Number(row.id);
    if (signal.causal_automation_ids.includes(automationId)) continue;
    const boundEntityIds = parsePgNumberArray(row.entity_ids);
    if (
      boundEntityIds.length > 0 &&
      !boundEntityIds.some((entityId) => event.entityIds.includes(entityId))
    ) {
      continue;
    }
    const triggers = Array.isArray(row.triggers)
      ? (row.triggers as AutomationWorkspaceEventTrigger[])
      : [];
    const trigger = triggers.find(
      (candidate) =>
        candidate.kind === 'event' &&
        candidate.source === 'workspace' &&
        matchesWorkspaceEventTrigger(candidate, event)
    );
    if (!trigger) continue;
    const executor = resolveAutomationExecutor({
      agentId: row.managed_agent_id as string | null,
      deviceWorkerId:
        typeof row.device_worker_id === 'string' ? row.device_worker_id : null,
      agentKind: typeof row.agent_kind === 'string' ? row.agent_kind : null,
    });
    if (!executor) continue;
    if (matches.length >= MAX_WORKSPACE_EVENT_FANOUT) {
      fanoutLimited = true;
      logger.warn(
        {
          eventId: signal.event_id,
          maxFanout: MAX_WORKSPACE_EVENT_FANOUT,
        },
        '[workspace-event] fan-out limit reached; remaining matching Automations skipped'
      );
      break;
    }
    matches.push({
      automationId,
      organizationId: String(row.organization_id),
      agentId: executor.kind === 'agent' ? executor.agentId : null,
      deviceWorkerId:
        executor.kind === 'device' ? executor.deviceWorkerId : null,
      agentKind: executor.kind === 'device' ? executor.agentKind : null,
      trigger,
    });
  }
  return { matches, fanoutLimited };
}

export async function activateWorkspaceEventTask(
  payload: WorkspaceEventActivationTaskPayload,
  db: DbClient = getDb()
): Promise<WorkspaceEventActivationResult> {
  if (
    !payload.organizationId ||
    !Number.isSafeInteger(payload.eventId) ||
    payload.eventId <= 0 ||
    !isBoundedPositiveIntegerList(
      payload.rootEventIds,
      MAX_COALESCED_AUTOMATION_EVENT_INPUTS
    ) ||
    payload.rootEventIds.length === 0 ||
    !Number.isSafeInteger(payload.depth) ||
    payload.depth < 1 ||
    !isBoundedPositiveIntegerList(
      payload.causalAutomationIds,
      MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS
    )
  ) {
    throw new Error('Invalid workspace event activation task payload');
  }
  const causalAutomationIds = payload.causalAutomationIds;
  const event = await loadWorkspaceEvent(
    payload.organizationId,
    payload.eventId,
    db
  );
  if (!event) {
    logger.info(
      { eventId: payload.eventId },
      '[workspace-event] output was superseded before activation; no downstream Automations queued'
    );
    return EMPTY_WORKSPACE_EVENT_ACTIVATION_RESULT;
  }
  // A root carries no ancestry by construction: nothing ran before it. Demand
  // that literally rather than skipping the check, because ancestry is what
  // suppresses re-entry — a payload that pairs a producerless event with a
  // non-empty path is either corrupt or an attempt to silence an Automation by
  // naming it as its own ancestor, and neither should activate anything.
  const producerMatchesCausalPath =
    event.producerAutomationId == null
      ? causalAutomationIds.length === 0
      : causalAutomationIds.includes(event.producerAutomationId);
  if (!producerMatchesCausalPath) {
    logger.error(
      {
        eventId: payload.eventId,
        producerAutomationId: event.producerAutomationId,
        causalAutomationIds,
      },
      '[workspace-event] producer does not match its causal path; activation terminated'
    );
    return {
      ...EMPTY_WORKSPACE_EVENT_ACTIVATION_RESULT,
      invalidCausalPath: true,
    };
  }
  if (payload.depth >= MAX_WORKSPACE_EVENT_DEPTH) {
    logger.warn(
      { eventId: payload.eventId, depth: payload.depth },
      '[workspace-event] causal depth limit reached; no downstream Automations queued'
    );
    return {
      ...EMPTY_WORKSPACE_EVENT_ACTIVATION_RESULT,
      depthLimited: true,
    };
  }
  if (causalAutomationIds.length >= MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS) {
    logger.warn(
      { eventId: payload.eventId, causalAutomations: causalAutomationIds.length },
      '[workspace-event] causal breadth limit reached; no downstream Automations queued'
    );
    return {
      ...EMPTY_WORKSPACE_EVENT_ACTIVATION_RESULT,
      causalBreadthLimited: true,
    };
  }

  const signal: WorkspaceEventTriggerSignal = {
    kind: 'event',
    source: 'workspace',
    event_id: event.id,
    event_type: subscribableEventType(event),
    delivery_id: `workspace-event:${event.id}`,
    occurred_at: event.occurredAt,
    root_event_ids: payload.rootEventIds,
    causal_automation_ids: causalAutomationIds,
    depth: payload.depth,
  };
  const { matches, fanoutLimited } =
    await findMatchingWorkspaceEventActivations(
      payload.organizationId,
      signal,
      event,
      db
    );
  const queued = [] as Array<{ runId: number; status: string }>;
  for (const match of matches) {
    const result = await createAutomationEventRun({
      organizationId: match.organizationId,
      automationId: match.automationId,
      agentId: match.agentId,
      trigger: match.trigger,
      signal,
      deviceWorkerId: match.deviceWorkerId,
      agentKind: match.agentKind,
    });
    if (result.disposition !== 'cooldown') queued.push(result);
  }
  await dispatchAutomationRunsBestEffort(queued);
  return {
    matched: matches.length,
    queued: queued.length,
    depthLimited: false,
    causalBreadthLimited: false,
    fanoutLimited,
    invalidCausalPath: false,
  };
}
