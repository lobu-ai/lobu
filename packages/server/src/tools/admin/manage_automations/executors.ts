/**
 * Executor resolution for Automations.
 *
 * Agent identity and device placement are independent. Without either, an
 * external client claims manual/scheduled windows. Triggers only decide when.
 * Installed external overrides retain their original optional owning agent.
 */
import type {
  AutomationEventTrigger,
  LegacyAutomationExecutionConfig,
  AutomationScheduleTrigger,
  AutomationWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-automations";
import type { DbClient } from "../../../db/client";
import { ToolUserError } from "../../../utils/errors";
import type { ToolContext } from "../../registry";
import { assertDeviceWorkerAccess } from "../automation-device-access";
import { assertAgentExists } from "./shared";

export type AutomationTriggerInput =
  | AutomationEventTrigger
  | AutomationWorkspaceEventTrigger
  | AutomationScheduleTrigger;

/** Automation-level executor (columns on the automations row). */
export interface AutomationExecutorDefaults {
  agentId?: string | null;
  deviceWorkerId?: string | null;
  agentKind?: string | null;
  executionConfig?: unknown;
}

export type ResolvedExecutor =
  | { kind: "external"; agentId: string | null }
  | { kind: "agent"; agentId: string }
  | {
      kind: "device";
      deviceWorkerId: string;
      agentKind: string | null;
      agentId: string | null;
    };

/** Resolve the Automation's executor.
 * Legacy external overrides keep their owning principal. A device places the
 * managed agent there; it never erases that agent's identity. */
export function resolveAutomationExecutor(
  defaults: AutomationExecutorDefaults
): ResolvedExecutor {
  if ((defaults.executionConfig as LegacyAutomationExecutionConfig | null)?.executor?.kind === "external") {
    return { kind: "external", agentId: defaults.agentId ?? null };
  }
  if (defaults.deviceWorkerId) {
    return {
      kind: "device",
      deviceWorkerId: defaults.deviceWorkerId,
      agentKind: defaults.agentKind ?? null,
      agentId: defaults.agentId ?? null,
    };
  }
  if (defaults.agentId) {
    return { kind: "agent", agentId: defaults.agentId };
  }
  return { kind: "external", agentId: null };
}

/** SQL counterpart for config discovery/admission, never for frozen runs.
 * `alias` is a trusted table alias supplied by the caller, not user input. */
export function externalAutomationPredicate(sql: DbClient, alias: string) {
  const row = sql.unsafe(alias);
  return sql`(COALESCE(${row}.execution_config->'executor'->>'kind' = 'external', false)
    OR (${row}.managed_agent_id IS NULL AND ${row}.device_worker_id IS NULL
      AND ${row}.execution_config->'executor'->>'kind' IS DISTINCT FROM 'script'))`;
}

/** External clients own their wakeup; events may capture references, not turns. */
export function assertAutomationExecutorsResolve(
  triggers: AutomationTriggerInput[] | null | undefined,
  defaults: AutomationExecutorDefaults
): void {
  for (const trigger of triggers ?? []) {
    if (trigger.kind !== 'event' || trigger.source === 'workspace' || trigger.capture !== 'references') continue;
    if (Object.keys(trigger.match ?? {}).some(key => key !== 'resource_ref' && key !== 'resource_type')) {
      throw new ToolUserError('Reference capture supports resource_ref/resource_type matching only.', 422);
    }
  }
  if (resolveAutomationExecutor(defaults).kind === "external") {
    const config = defaults.executionConfig as LegacyAutomationExecutionConfig | null;
    if ((config?.executor?.kind === 'external' && (defaults.deviceWorkerId || defaults.agentKind ||
        Object.keys(config).some((key) => key !== "executor"))) ||
        (triggers ?? []).some((trigger) => trigger.kind !== "schedule" &&
          !(trigger.kind === 'event' && trigger.source !== 'workspace' && trigger.capture === 'references'))) {
      throw new ToolUserError(
        "Unassigned Automations support manual, scheduled, or reference-capture connector subscriptions. Assign an agent or device for event execution. Legacy external overrides cannot use device pins or hosted/CLI settings.",
        422
      );
    }
    for (const trigger of triggers ?? []) {
      if (trigger.kind !== 'event' || trigger.source === 'workspace') continue;
      if (trigger.output === 'reply_to_source' || trigger.active_run === 'steer') {
        throw new ToolUserError('External reference subscriptions support silent capture, not replies or steering agent turns.', 422);
      }
    }
    return;
  }
}

/**
 * DB-level authorization for every executor the Automation references: the
 * device pin (ALWAYS, even when an agent shadows it in resolution — storing a
 * pin the caller may not target is itself the exploit) and the agent.
 */
export async function assertAutomationExecutorsAuthorized(
  sql: DbClient,
  organizationId: string,
  defaults: AutomationExecutorDefaults,
  ctx: ToolContext
): Promise<void> {
  if (defaults.deviceWorkerId) {
    await assertDeviceWorkerAccess(sql, defaults.deviceWorkerId, ctx);
  }
  if (defaults.agentId) {
    await assertAgentExists(sql, organizationId, defaults.agentId);
  }
}
