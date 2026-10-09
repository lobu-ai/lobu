/**
 * Executor resolution for Automations.
 *
 * An Automation is an org-level goal with one durable contract (prompt, outputs,
 * reaction script, budget) and exactly ONE executor:
 *
 *  - `execution_config.executor.kind = external` — the external MCP client
 *    claims manual/scheduled windows; the agent remains the optional owner
 *  - `managed_agent_id` — a managed Lobu agent executes runs (server dispatch lane)
 *  - `device_worker_id` — the pinned device worker's local CLI executes them
 *    (device lane); `agent_kind` picks the local runtime, null = device
 *    default
 *
 * Triggers are the "when" and carry no executor of their own.
 *
 * Resolution rules enforced here (create/update):
 *
 *  - Every automated Automation (any event/schedule trigger) MUST have an
 *    executor — an automated activation with no executor is a zombie: there
 *    is no lane that could ever run it (the scheduler/event SELECTs gate on
 *    the row-level columns).
 *  - An Automation with NO triggers is manual-only: executor is optional.
 *    Without an executor, authorized MCP clients may execute and complete its
 *    manually activated windows through write-tier `complete_window`.
 */
import type {
  AutomationEventTrigger,
  AutomationExecutionConfig,
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
  | { kind: "external" }
  | { kind: "agent"; agentId: string }
  | {
      kind: "device";
      deviceWorkerId: string;
      agentKind: string | null;
    };

/** Resolve the Automation's executor.
 * Explicit external mode takes precedence over the owning agent. Otherwise
 * precedence is DEVICE PIN FIRST: legacy dual rows carried both managed_agent_id and
 * device_worker_id and always ran on the device lane (#802) — agent-first
 * fallback would silently flip those runs to server dispatch. */
export function resolveAutomationExecutor(
  defaults: AutomationExecutorDefaults
): ResolvedExecutor | null {
  if ((defaults.executionConfig as AutomationExecutionConfig | null)?.executor?.kind === "external") {
    return { kind: "external" };
  }
  if (defaults.deviceWorkerId) {
    return {
      kind: "device",
      deviceWorkerId: defaults.deviceWorkerId,
      agentKind: defaults.agentKind ?? null,
    };
  }
  if (defaults.agentId) {
    return { kind: "agent", agentId: defaults.agentId };
  }
  return null;
}

/**
 * Structural matrix check. Rules:
 *  - Automated Automations (any event/schedule trigger) MUST have an executor.
 *    Triggers carry no executor of their own, and the scheduler/event SELECTs
 *    gate on the row-level columns — an executor-less automated Automation
 *    would validate but never fire.
 *  - Manual-only Automations (no triggers) pass with or without an executor.
 */
export function assertAutomationExecutorsResolve(
  triggers: AutomationTriggerInput[] | null | undefined,
  defaults: AutomationExecutorDefaults
): void {
  if (resolveAutomationExecutor(defaults)?.kind === "external") {
    const config = defaults.executionConfig as AutomationExecutionConfig;
    if (defaults.deviceWorkerId || defaults.agentKind ||
        (triggers ?? []).some((trigger) => trigger.kind !== "schedule") ||
        Object.keys(config).some((key) => key !== "executor")) {
      throw new ToolUserError(
        "An external executor supports manual or scheduled windows only; device pins, event triggers, and hosted/CLI execution settings do not apply.",
        422
      );
    }
    return;
  }
  const automated = (triggers ?? []).some(
    (trigger) => trigger.kind === "event" || trigger.kind === "schedule"
  );
  if (!automated) return;
  if (!resolveAutomationExecutor(defaults)) {
    throw new ToolUserError(
      "Automated Automations need an executor: set managed_agent_id (managed agent), device_worker_id (device), or execution_config.executor.kind=external (MCP client). Manual-only Automations (no triggers) may omit both."
    );
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
