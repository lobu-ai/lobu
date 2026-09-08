import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import {
  resolvedEventExecution,
  type AutomationEventTrigger,
  type AutomationTrigger,
} from "@lobu/core/contracts/tools/manage-automations";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import { crossOrganizationChatLinkScope } from "../gateway/channels/chat-link-authorization";
import { runtimeConnectionIdToSlug } from "../lobu/stores/connections-projection";
import {
  type AutomationEventRunQueued,
  createAutomationEventRun,
} from "../runs/queue-service";
import { resolveAutomationExecutor } from "../tools/admin/manage_automations/executors";
import logger from "../utils/logger";
import { dispatchPendingAutomationRuns } from "../automations/automation";
import { matchingAutomationTriggers } from "./event-trigger";

export interface MatchingAutomationActivation {
  automationId: number;
  organizationId: string;
  /** Resolved executor agent — null when this trigger routes to a device. */
  agentId: string | null;

  deviceWorkerId: string | null;
  agentKind: string | null;
  model: string | null;
  instructions: string;
  /**
   * The Automation's `min_cooldown_seconds`. Carried on the match so a caller can
   * skip the cooldown claim for Automations observed at the 0 default. Positive
   * values are re-read and consumed authoritatively under the per-Automation lock
   * in `claimAutomationCooldown`.
   */
  minCooldownSeconds: number;
  trigger: AutomationEventTrigger;
}

/** A reply target always carries a managed agent — device-routed matches are
 * demoted to the background lane in {@link planAutomationActivations}. */
export interface ChatReplyActivation extends MatchingAutomationActivation {
  agentId: string;
}

export interface AutomationActivationResult extends AutomationEventRunQueued {
  automationId: number;
  trigger: AutomationEventTrigger;
}

export interface AutomationActivationPlan {
  signal: ConnectorTriggerSignal;
  replyTargets: ChatReplyActivation[];
  backgroundTargets: MatchingAutomationActivation[];
}

export interface RuntimeConnectionAutomationLookup {
  connectionOrganizationId: string;
  runtimeConnectionId: string;
  signal: ConnectorTriggerSignal;
  crossOrganization?: boolean;
}

/**
 * Split matching Automations once, at the connector-neutral activation seam.
 * Reply targets stay with the chat transport so they retain thread history,
 * attachments, and live steering; every other target uses the durable run
 * queue. Connectors never implement this policy themselves.
 */
export function planAutomationActivations(
  signal: ConnectorTriggerSignal,
  matches: MatchingAutomationActivation[],
): AutomationActivationPlan {
  const replyTargets: ChatReplyActivation[] = [];
  const backgroundTargets: MatchingAutomationActivation[] = [];
  for (const match of matches) {
    // Chat-turn replies need a managed agent on the server side — a trigger
    // routed to a device (agentId null) cannot host a live turn, so it takes
    // the durable background lane instead.
    if (
      match.agentId != null &&
      resolvedEventExecution(match.trigger) === "turn" &&
      (match.trigger.output ?? "silent") === "reply_to_source"
    ) {
      replyTargets.push({ ...match, agentId: match.agentId });
    } else {
      backgroundTargets.push(match);
    }
  }
  return { signal, replyTargets, backgroundTargets };
}

/** Connector-neutral Automation lookup used by webhooks, pollers, and chat. */
export async function findMatchingAutomationActivations(
  organizationId: string,
  signal: ConnectorTriggerSignal,
  db: DbClient = getDb(),
  options?: { crossOrganization?: boolean; includeAuthorizedChatLinks?: boolean },
): Promise<MatchingAutomationActivation[]> {
  // Coarse GIN needle: kind + connector_key. When the signal carries a
  // connection_id, match that connection's triggers OR connector-wide triggers
  // (no connection_id on the trigger element). Without the connection arm the
  // org-scoped query pulled every Automation for the connector across all
  // connections; the connection arm alone would drop connector-wide drafts.
  const baseNeedle = {
    kind: "event" as const,
    connector_key: signal.connector_key,
  };
  const channelId = signal.attributes?.channel_id;
  // The view normalizes an empty trigger team to NULL, so normalize the signal
  // the same way: the SQL admission below and the per-trigger re-check further
  // down must agree on what "no workspace" means.
  const rawTeamId = signal.attributes?.team_id;
  const teamId = typeof rawTeamId === "string" && rawTeamId !== "" ? rawTeamId : null;
  const chatLinkFilter = options?.includeAuthorizedChatLinks &&
    signal.event_type === "message.created" && signal.connection_id != null &&
    typeof channelId === "string"
    ? db`OR EXISTS (
        SELECT 1 FROM automation_message_subscriptions s
        WHERE s.automation_id = w.id
          AND s.connection_id = ${signal.connection_id}
          AND s.native_channel_id = ${channelId}
          AND ${crossOrganizationChatLinkScope(db, organizationId, teamId)}
      )`
    : db``;
  const organizationFilter = options?.crossOrganization
    ? db``
    : db`AND (w.organization_id = ${organizationId} ${chatLinkFilter})`;
  const connectionId = signal.connection_id;
  const triggerFilter =
    connectionId != null
      ? db`(
          w.triggers @> ${db.json([{ ...baseNeedle, connection_id: connectionId }])}::jsonb
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) t
            WHERE t->>'kind' = 'event'
              AND t->>'connector_key' = ${signal.connector_key}
              AND t->>'connection_id' IS NULL
          )
        )`
      : db`w.triggers @> ${db.json([baseNeedle])}::jsonb`;
  const rows = await db`
		SELECT w.id, w.organization_id, w.managed_agent_id, w.device_worker_id::text AS device_worker_id,
		       w.agent_kind, w.triggers, w.execution_config->>'model' AS model,
		       w.min_cooldown_seconds, v.prompt
		FROM automations w
		JOIN automation_versions v ON v.id = w.current_version_id
		WHERE w.status = 'active'
		  AND (w.managed_agent_id IS NOT NULL OR w.device_worker_id IS NOT NULL)
		  AND ${triggerFilter}
		  ${organizationFilter}
		ORDER BY w.id ASC
	`;

  const matches: MatchingAutomationActivation[] = [];
  for (const row of rows) {
    const triggers = Array.isArray(row.triggers)
      ? (row.triggers as AutomationTrigger[])
      : [];
    // Multi-trigger Automations OR activations: any matching event trigger is
    // enough to run once. When several match the same signal, the first in
    // array order supplies execution/output/active_run (UI documents this).
    const [trigger] = matchingAutomationTriggers(
      triggers.filter(
        (candidate): candidate is AutomationEventTrigger =>
          candidate.kind === "event" && candidate.source !== "workspace" &&
          (options?.crossOrganization || row.organization_id === organizationId || (
            candidate.connection_id === signal.connection_id &&
            candidate.match?.channel_id === channelId &&
            (candidate.match?.team_id || null) === teamId
          )),
      ),
      signal,
    );
    if (!trigger) continue;
    // Executor resolution: an Automation has exactly one executor (agent or
    // device pin). The create/update matrix guarantees automated Automations
    // resolve; skip defensively if a legacy row slips through.
    const executor = resolveAutomationExecutor({
      agentId: row.managed_agent_id as string | null,
      deviceWorkerId:
        typeof row.device_worker_id === "string" ? row.device_worker_id : null,
      agentKind: typeof row.agent_kind === "string" ? row.agent_kind : null,
    });
    if (!executor) continue;
    matches.push({
      automationId: Number(row.id),
      organizationId: String(row.organization_id),
      agentId: executor.kind === "agent" ? executor.agentId : null,
      deviceWorkerId:
        executor.kind === "device" ? executor.deviceWorkerId : null,
      agentKind:
        executor.kind === "device" ? executor.agentKind : null,
      model: typeof row.model === "string" ? row.model : null,
      instructions: typeof row.prompt === "string" ? row.prompt : "",
      minCooldownSeconds: Number(row.min_cooldown_seconds ?? 0),
      trigger,
    });
  }
  return matches;
}

/**
 * Resolve a Chat SDK runtime id to the integer connection id used by Automation
 * triggers, then perform the normal connector-neutral match. Runtime ids are
 * deliberately stable slugs (for example `slackinst-…`), not database ids.
 */
export async function planAutomationActivationsForRuntimeConnection(
  args: RuntimeConnectionAutomationLookup,
  db: DbClient = getDb(),
): Promise<AutomationActivationPlan> {
  const connections = await db<{ id: number }>`
		SELECT id
		FROM connections
		WHERE organization_id = ${args.connectionOrganizationId}
		  AND slug = ${runtimeConnectionIdToSlug(args.runtimeConnectionId)}
		  AND connector_key = ${args.signal.connector_key}
		  AND deleted_at IS NULL
		LIMIT 1
  `;
  const connectionId = connections[0]?.id;
  if (connectionId == null) return planAutomationActivations(args.signal, []);
  const signal = { ...args.signal, connection_id: Number(connectionId) };
  const matches = await findMatchingAutomationActivations(
    args.connectionOrganizationId,
    signal,
    db,
    { crossOrganization: args.crossOrganization, includeAuthorizedChatLinks: true },
  );
  return planAutomationActivations(signal, matches);
}

/**
 * Durably queue a precomputed set of Automation activations. `db` must be an
 * open transaction when provided; when omitted, each run creation opens its
 * own so the per-Automation lock and coalesce reads stay replica-safe.
 */
export async function queueAutomationActivations(args: {
  matches: MatchingAutomationActivation[];
  signal: ConnectorTriggerSignal;
  db?: DbClient;
}): Promise<AutomationActivationResult[]> {
  if (args.matches.length === 0) return [];
  const results: AutomationActivationResult[] = [];
  for (const match of args.matches) {
    const queued = await createAutomationEventRun(
      {
        organizationId: match.organizationId,
        automationId: match.automationId,
        agentId: match.agentId,
        trigger: match.trigger,
        signal: args.signal,
        deviceWorkerId: match.deviceWorkerId,
        agentKind: match.agentKind,
      },
      args.db,
    );
    // A cooldown-suppressed activation produced no run, so it has nothing to
    // dispatch and must not reach `dispatchAutomationRunsBestEffort`. The
    // decision itself is logged inside the claim.
    if (queued.disposition === "cooldown") continue;
    results.push({
      ...queued,
      automationId: match.automationId,
      trigger: match.trigger,
    });
  }

  return results;
}

/** Match a normalized signal and durably queue its Automation runs. */
export async function activateAutomationSignal(args: {
  organizationId: string;
  signal: ConnectorTriggerSignal;
  db?: DbClient;
}): Promise<AutomationActivationResult[]> {
  const sql = args.db ?? getDb();
  const matches = await findMatchingAutomationActivations(
    args.organizationId,
    args.signal,
    sql,
  );
  return queueAutomationActivations({
    matches,
    signal: args.signal,
    db: args.db,
  });
}

/**
 * Start newly durable Automation runs without failing an already-committed
 * connector delivery if the immediate dispatcher itself throws. The periodic
 * Automation scheduler tick recovers any claim stranded by that failure.
 */
export async function dispatchAutomationRunsBestEffort(
  results: Array<{ runId: number; status: string }>,
): Promise<void> {
  const runIds = results
    .filter((result) => result.status === "pending")
    .map((result) => result.runId);
  if (runIds.length === 0) return;
  try {
    await dispatchPendingAutomationRuns({ runIds });
  } catch (error) {
    logger.error(
      { error, runIds },
      "Immediate Automation dispatch threw; automation will recover stranded claims",
    );
  }
}
